// W1-T13370: the selection walk stopped at the first candidate that overflowed the decompressed ceiling. On the host
// (2026-11-17) the oldest days held 35-65 MB archives that never pair, so every pass chose one source and declined it
// as no-reduction, while ~50 small rotations of a later day sat unmerged. A pass now packs each UTC day within the
// ceiling and merges the day that takes the most sources.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import * as nodeFs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { gunzipSync, gzipSync } from "node:zlib";

import { fixedClock } from "#src/lib/clock.js";
import { ledgerCompactCommand } from "#src/lib/ledger-compact.js";
import { compactedArchiveName } from "#src/lib/ledger.js";

const NOW = Date.parse("2026-11-17T12:00:00.000Z");
const CEILING = 4096;
// Random hex does not compress, so decompressed sizes are close to these and no archive reads as a merged output.
const BIG = 1_200, SMALL = 350, OVERSIZED_ROW = 800;

function archive(dir: string, ts: string, padBytes: number, rowTs: string[] = [ts]): string {
  const lines = rowTs.map((at, i) => JSON.stringify({ ts: at, step: "run.start", run_id: `${ts}-${i}`, pad: randomBytes(padBytes).toString("hex") }));
  const name = compactedArchiveName(ts);
  nodeFs.writeFileSync(join(dir, name), gzipSync(Buffer.from(`${lines.join("\n")}\n`)));
  return name;
}

function stateDir(t: TestContext): string {
  const dir = nodeFs.mkdtempSync(join(tmpdir(), "rmd-unpairable-"));
  t.after(() => nodeFs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const archives = (dir: string) => nodeFs.readdirSync(dir).filter(n => /^ledger\..+\.ndjson\.gz$/.test(n)).sort();
const decompressed = (dir: string, name: string) => gunzipSync(nodeFs.readFileSync(join(dir, name))).length;
const rows = (dir: string) => archives(dir).flatMap(n => gunzipSync(nodeFs.readFileSync(join(dir, n))).toString("utf8").split("\n").filter(Boolean)).sort();
const snapshot = (dir: string) => archives(dir).map(n => [n, nodeFs.readFileSync(join(dir, n)).toString("base64")]);

function pass(dir: string, apply = false) {
  const errors: string[] = [], out: string[] = [];
  const code = ledgerCompactCommand([...(apply ? [] : ["--dry-run"]), "--older-than", "1"], {
    stateDir: dir, clock: fixedClock(NOW), maxArchiveBytes: CEILING, out: l => out.push(l), error: l => errors.push(l),
  });
  assert.equal(code, 0, errors.join("\n"));
  return JSON.parse(out.at(-1)!) as { sourceCount: number; archiveNames: string[]; reason?: string; sizeSkippedCount?: number };
}

test("W1-T13370 criterion 1: past a day whose archives cannot pair, the pass merges the same-day run that takes the most sources", t => {
  const dir = stateDir(t);
  // The oldest day holds two archives too large to share the ceiling; the old walk stopped at the second one.
  const head = ["2026-11-01T01:00:00.000Z", "2026-11-01T02:00:00.000Z"].map(ts => archive(dir, ts, BIG));
  assert.ok(head.reduce((sum, n) => sum + decompressed(dir, n), 0) > CEILING, "the head day cannot pair");
  const two = ["2026-11-05T01:00:00.000Z", "2026-11-05T02:00:00.000Z"].map(ts => archive(dir, ts, SMALL));
  const three = ["2026-11-09T01:00:00.000Z", "2026-11-09T02:00:00.000Z", "2026-11-09T03:00:00.000Z"].map(ts => archive(dir, ts, SMALL));
  const before = rows(dir);

  const preview = pass(dir);
  assert.equal(preview.sourceCount, 3, JSON.stringify(preview));
  assert.equal(preview.reason, undefined);

  const applied = pass(dir, true);
  assert.equal(applied.sourceCount, 3);
  const after = archives(dir);
  assert.ok(three.every(n => !after.includes(n) || applied.archiveNames.includes(n)), "the 11-09 rotations were merged");
  assert.ok([...head, ...two].every(n => after.includes(n)), "nothing outside the chosen day moved");
  assert.equal(after.length, head.length + two.length + 1);
  assert.deepEqual(rows(dir), before, "every row survives the merge");
});

test("W1-T13370 criterion 2: a day's packing skips an overflowing archive and stays within the ceiling, and a corpus with no pair writes nothing", t => {
  const dir = stateDir(t);
  const big = ["2026-11-01T01:00:00.000Z", "2026-11-01T02:00:00.000Z"].map(ts => archive(dir, ts, BIG));
  const small = archive(dir, "2026-11-01T03:00:00.000Z", SMALL);
  const lone = archive(dir, "2026-11-02T01:00:00.000Z", BIG);
  const applied = pass(dir, true);
  assert.equal(applied.sourceCount, 2, JSON.stringify(applied));
  const after = archives(dir);
  assert.ok(after.includes(big[1]!), "the archive that would overflow was skipped, not merged");
  assert.ok(after.includes(lone));
  assert.ok(!after.includes(small) || applied.archiveNames.includes(small));
  for (const name of applied.archiveNames) assert.ok(decompressed(dir, name) <= CEILING, `${name} is within the ceiling`);

  const none = stateDir(t);
  for (const ts of ["2026-11-01T01:00:00.000Z", "2026-11-01T02:00:00.000Z", "2026-11-02T01:00:00.000Z"]) archive(none, ts, BIG);
  const unchanged = snapshot(none);
  const declined = pass(none, true);
  assert.equal(declined.sourceCount, 0, JSON.stringify(declined));
  assert.deepEqual(snapshot(none), unchanged, "no pair fits, so nothing is written");
});

test("W1-T13370 criterion 3: invariant ceiling-and-reduction-hold, the oversized repair and the no-reduction refusal behave as before", t => {
  // Two same-day rotations whose rows fall on two UTC days still produce two outputs, so the pass declines them.
  const split = stateDir(t);
  archive(split, "2026-11-01T01:00:00.000Z", SMALL, ["2026-11-01T01:00:00.000Z"]);
  archive(split, "2026-11-01T02:00:00.000Z", SMALL, ["2026-11-02T02:00:00.000Z"]);
  const unchanged = snapshot(split);
  const declined = pass(split, true);
  assert.equal(declined.sourceCount, 0);
  assert.match(declined.reason ?? "", /^no-reduction/);
  assert.deepEqual(snapshot(split), unchanged);

  // A merged archive over the ceiling is still taken alone for repair, ahead of any day that could merge.
  const repair = stateDir(t);
  const oversized = archive(repair, "2026-10-30T23:59:59.000Z", OVERSIZED_ROW,
    Array.from({ length: 3 }, (_, i) => `2026-10-30T0${i}:00:00.000Z`));
  for (const ts of ["2026-11-09T01:00:00.000Z", "2026-11-09T02:00:00.000Z", "2026-11-09T03:00:00.000Z", "2026-11-09T04:00:00.000Z", "2026-11-09T05:00:00.000Z"]) {
    archive(repair, ts, 60);
  }
  assert.ok(decompressed(repair, oversized) > CEILING);
  const report = pass(repair);
  assert.equal(report.sizeSkippedCount, archives(repair).length - 1, JSON.stringify(report));
  assert.match(report.reason ?? "", /^no-reduction/, "the repair split cannot reduce, so it is declined as before");
});
