// W1-T13371: the oversized-repair probe gunzipped every merged archive on every compaction pass. On the host
// (2026-11-17) that was 79 archives of 45-65 MB, and the daemon ran a pass synchronously 42-48 times a day at 9-183 s.
// A pass now reuses a measurement whose archive is unchanged, and still finds and repairs an oversized archive.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import * as nodeFs from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test, type TestContext } from "node:test";
import { gunzipSync, gzipSync } from "node:zlib";

import { fixedClock } from "#src/lib/clock.js";
import { writeAtomic } from "#src/lib/fs-race-safe.js";
import { ledgerCompactCommand, type LedgerCompactFs } from "#src/lib/ledger-compact.js";
import { compactedArchiveName } from "#src/lib/ledger.js";

const NOW = Date.parse("2026-11-17T12:00:00.000Z");
const CEILING = 512 * 1024;

/** Rows padded with random hex, so gzip cannot shrink a big archive below the merged-size threshold. */
function archive(dir: string, ts: string, rows: number, padBytes: number): string {
  const lines = Array.from({ length: rows }, (_, i) => JSON.stringify({ ts, step: "run.start", run_id: `${ts}-${i}`, pad: randomBytes(padBytes).toString("hex") }));
  const name = compactedArchiveName(ts);
  nodeFs.writeFileSync(join(dir, name), gzipSync(Buffer.from(`${lines.join("\n")}\n`)));
  nodeFs.utimesSync(join(dir, name), 1_000, 1_000);
  return name;
}

/** Four small rotations on one day and three merged archives (each well over four times the median) on others. */
function corpus(t: TestContext) {
  const dir = nodeFs.mkdtempSync(join(tmpdir(), "rmd-measured-once-"));
  t.after(() => nodeFs.rmSync(dir, { recursive: true, force: true }));
  const small = ["2026-11-10T01:00:00.000Z", "2026-11-10T02:00:00.000Z", "2026-11-10T03:00:00.000Z", "2026-11-10T04:00:00.000Z"]
    .map(ts => archive(dir, ts, 4, 200));
  const merged = ["2026-11-01T23:59:59.000Z", "2026-11-02T23:59:59.000Z", "2026-11-03T23:59:59.000Z"].map(ts => archive(dir, ts, 60, 2_000));
  return { dir, small, merged };
}

/** The real filesystem, counting which archives a pass decompresses. */
function countingFs(reads: string[]): LedgerCompactFs {
  return {
    readdirSync: dir => nodeFs.readdirSync(dir),
    readFileSync: path => { reads.push(basename(path)); return nodeFs.readFileSync(path); },
    existsSync: path => nodeFs.existsSync(path),
    writeAtomic: (path, content) => writeAtomic(path, content, { tmpTag: "ledger-compact-tmp" }),
    rmSync: path => nodeFs.rmSync(path),
    gzipSync: content => gzipSync(content),
    gunzipSync: (content, options) => gunzipSync(content, options),
    sizeOf: path => nodeFs.statSync(path).size,
    mkdirSync: dir => { nodeFs.mkdirSync(dir, { recursive: true }); },
    renameSync: (from, to) => nodeFs.renameSync(from, to),
    touch: (path, atMs) => nodeFs.utimesSync(path, atMs / 1000, atMs / 1000),
    mtimeMs: path => nodeFs.statSync(path).mtimeMs,
  };
}

function pass(dir: string, maxArchiveBytes = CEILING, fs?: (reads: string[]) => LedgerCompactFs, mode = "--dry-run") {
  const reads: string[] = [], errors: string[] = [], out: string[] = [];
  const code = ledgerCompactCommand([...(mode ? [mode] : []), "--older-than", "1"], {
    stateDir: dir, clock: fixedClock(NOW), fs: (fs ?? countingFs)(reads), maxArchiveBytes, out: l => out.push(l), error: l => errors.push(l),
  });
  assert.equal(code, 0, errors.join("\n"));
  return { reads, report: JSON.parse(out.at(-1)!) as { sourceCount: number; archiveNames: string[] } };
}
const mergedReads = (reads: string[], merged: string[]) => reads.filter(r => merged.includes(r)).sort();

test("W1-T13371 criterion 1: a second pass over an unchanged corpus decompresses no merged archive the first pass measured", t => {
  const { dir, merged } = corpus(t);
  const first = pass(dir);
  assert.deepEqual(mergedReads(first.reads, merged), [...merged].sort(), "the first pass probes every merged archive");
  const listing = nodeFs.readdirSync(dir).sort();
  const second = pass(dir);
  assert.deepEqual(nodeFs.readdirSync(dir).sort(), listing, "the measurements live in the process; nothing is written to the state dir");
  assert.deepEqual(mergedReads(second.reads, merged), [], "nothing measured before is decompressed again");
  assert.deepEqual(second.report, first.report, "the reused measurements select exactly what fresh ones did");
});

test("W1-T13371 criterion 2: an archive whose compressed size or mtime changed is measured again", t => {
  const { dir, merged } = corpus(t);
  pass(dir);
  nodeFs.utimesSync(join(dir, merged[0]!), 2_000, 2_000);
  const body = nodeFs.readFileSync(join(dir, merged[1]!));
  nodeFs.writeFileSync(join(dir, merged[1]!), Buffer.concat([body, gzipSync(Buffer.from(`${JSON.stringify({ ts: "2026-11-02T23:59:59.500Z", step: "run.start", run_id: "extra" })}\n`))]));
  nodeFs.utimesSync(join(dir, merged[1]!), 1_000, 1_000);
  assert.deepEqual(mergedReads(pass(dir).reads, merged), [merged[0]!, merged[1]!].sort());
  // A record kept at a higher limit answers a lower one, never the reverse.
  assert.deepEqual(mergedReads(pass(dir, CEILING / 2).reads, merged), [], "an exact measurement answers any lower limit");
});

test("W1-T13371 criterion 3: invariant oversized-still-repaired, an oversized archive is still repaired and an unreadable identity is never trusted", t => {
  const { dir, small, merged } = corpus(t);
  pass(dir);
  // Lower the ceiling under every merged archive. The remembered sizes now say oversized, so the repair path admits the
  // oldest merged archive alone (every other eligible archive is deferred), and only that source is read, to plan it.
  for (const repair of [pass(dir, 64 * 1024), pass(dir, 64 * 1024)]) {
    const report = repair.report as unknown as { eligibleCount: number; sizeSkippedCount?: number };
    assert.equal(report.sizeSkippedCount, report.eligibleCount - 1, "the oversized archive is taken alone for repair");
    assert.deepEqual(mergedReads(repair.reads, merged), [merged[0]!], "no merged archive is measured again; only the repaired source is read");
  }
  // Without a readable size and mtime there is no identity to match, so every pass measures again.
  const throwing = (reads: string[]): LedgerCompactFs => ({ ...countingFs(reads), mtimeMs: () => { throw new Error("EACCES"); } });
  const blind = (reads: string[]): LedgerCompactFs => ({ ...countingFs(reads), mtimeMs: undefined });
  for (const fs of [throwing, blind, throwing]) assert.deepEqual(mergedReads(pass(dir, CEILING, fs).reads, merged), [...merged].sort());
  // An apply pass forgets each output path before it writes it, then writes the merged small rotations.
  const applied = pass(dir, CEILING, undefined, "");
  assert.ok(applied.report.sourceCount >= 2, JSON.stringify(applied.report));
  assert.ok(applied.report.archiveNames.length > 0 && applied.report.archiveNames.every(name => nodeFs.existsSync(join(dir, name))));
  assert.ok(small.every(name => !nodeFs.existsSync(join(dir, name)) || applied.report.archiveNames.includes(name)));
});
