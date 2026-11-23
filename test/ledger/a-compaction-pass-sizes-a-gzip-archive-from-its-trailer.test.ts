import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import zlib, { gunzipSync, gzipSync } from "node:zlib";

import { fixedClock } from "#src/lib/clock.js";
import { LEDGER_COMPACT_MAX_ARCHIVE_BYTES, ledgerCompactCommand } from "#src/lib/ledger-compact.js";
import { compactLedgerInWorker } from "#src/lib/ledger-compact-worker.js";
import { compactedArchiveName, rotateLedger } from "#src/lib/ledger.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const NOW = Date.parse("2026-11-17T12:00:00Z");
const AGE = ["--older-than", "0"];
type Report = { sourceCount: number; eligibleCount: number; sizeSkippedCount?: number; archiveNames: string[] };

function row(ts: string, id: string, pad = ""): string {
  return `${JSON.stringify({ ts, step: "run.start", run_id: id, pad })}\n`;
}

function gzipArchive(dir: string, ts: string, body: string): string {
  const name = compactedArchiveName(ts);
  writeFileSync(join(dir, name), gzipSync(body));
  return name;
}

function pass(dir: string, maxArchiveBytes: number, dryRun = false) {
  const errors: string[] = [], out: string[] = [];
  const code = ledgerCompactCommand([...AGE, ...(dryRun ? ["--dry-run"] : [])], {
    stateDir: dir, maxArchiveBytes, clock: fixedClock(NOW), error: line => errors.push(line), out: line => out.push(line),
  });
  return { code, errors, report: out.length ? JSON.parse(out[0]!) as Report : undefined };
}

type Trace = { event: "inflate"; name: string } | { event: "read"; name: string; length: number; position: number };

function tracedWorker(t: TestContext) {
  const { dir } = ownedFixtureDir(t, "ledger-trailer-worker");
  const entry = join(dir, "entry.mjs");
  const trace = join(dir, "trace.ndjson");
  const worker = pathToFileURL(join(REPO_ROOT, "src/lib/ledger-compact-worker.ts"));
  writeFileSync(entry, `
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { basename } from "node:path";
import zlib from "node:zlib";
const trace = ${JSON.stringify(trace)};
const record = (event) => fs.appendFileSync(trace, JSON.stringify(event) + "\\n");
const archive = (path) => typeof path === "string" && path.endsWith(".ndjson.gz");
const namesByFd = new Map(), namesByBody = new WeakMap();
const { closeSync, openSync, readFileSync, readSync } = fs;
const { gunzipSync } = zlib;
fs.openSync = (path, ...args) => {
  const fd = openSync(path, ...args);
  if (archive(path)) namesByFd.set(fd, basename(path));
  return fd;
};
fs.closeSync = (fd) => {
  namesByFd.delete(fd);
  return closeSync(fd);
};
fs.readSync = (fd, buffer, offset, length, position) => {
  const name = namesByFd.get(fd);
  if (name !== undefined) record({ event: "read", name, length, position });
  return readSync(fd, buffer, offset, length, position);
};
fs.readFileSync = (path, ...args) => {
  const body = readFileSync(path, ...args);
  if (archive(path)) namesByBody.set(body, basename(path));
  return body;
};
zlib.gunzipSync = (body, ...args) => {
  record({ event: "inflate", name: namesByBody.get(body) });
  return gunzipSync(body, ...args);
};
syncBuiltinESMExports();
await import(${JSON.stringify(worker.href)});
`);
  return async (stateDir: string) => {
    writeFileSync(trace, "");
    const result = await compactLedgerInWorker([...AGE, "--dry-run"], stateDir, { workerUrl: pathToFileURL(entry) });
    assert.equal(result.code, 0, result.errors.join("\n"));
    const events = readFileSync(trace, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as Trace);
    return { events, report: JSON.parse(result.report!) as Report };
  };
}

test("W1-T13414 criterion 1: two fresh workers read four bytes per probe and inflate only selected sources", async t => {
  const { dir } = ownedFixtureDir(t, "ledger-trailer-corpus");
  const ordinary = [1, 2, 3].map(hour => {
    const ts = `2026-11-10T0${hour}:00:00Z`;
    return gzipArchive(dir, ts, row(ts, `ordinary-${hour}`));
  });
  const merged = [1, 2].map(day => {
    const ts = `2026-11-0${day}T23:00:00Z`;
    const body = row(ts, `merged-${day}`, randomBytes(2048).toString("hex"));
    assert.ok(Buffer.byteLength(body) < LEDGER_COMPACT_MAX_ARCHIVE_BYTES);
    return gzipArchive(dir, ts, body);
  });
  const largestOrdinary = Math.max(...ordinary.map(name => statSync(join(dir, name)).size));
  assert.ok(merged.every(name => statSync(join(dir, name)).size > 4 * largestOrdinary));
  const inFreshWorker = tracedWorker(t);
  const first = await inFreshWorker(dir);
  const second = await inFreshWorker(dir);
  for (const { events, report } of [first, second]) {
    assert.equal(report.sourceCount, ordinary.length);
    assert.deepEqual(events.filter(event => event.event === "inflate").map(event => event.name).sort(), ordinary,
      "only the selected archives should be inflated by a fresh worker");
    assert.deepEqual(events.filter(event => event.event === "read" && merged.includes(event.name)), merged.map(name => ({
      event: "read", name, length: 4, position: statSync(join(dir, name)).size - 4,
    })));
  }
});

test("W1-T13414 criterion 2: both writers record the inflated length and an oversized trailer still triggers repair", t => {
  const { dir } = ownedFixtureDir(t, "ledger-trailer-writers");
  const live = join(dir, "ledger.ndjson");
  const ts = "2026-11-10T01:00:00Z";
  writeFileSync(live, row(ts, "rotated", "é".repeat(30)));
  const rotated = rotateLedger(live, { ceilingBytes: 1, smoothingWindowMs: 0, now: () => new Date(ts) });
  assert.ok(rotated.archivePath);
  const rotationBytes = readFileSync(rotated.archivePath);
  assert.equal(rotationBytes.readUInt32LE(rotationBytes.length - 4), gunzipSync(rotationBytes).length);

  const next = "2026-11-10T02:00:00Z";
  gzipArchive(dir, next, row(next, "ordinary"));
  const applied = pass(dir, 1024);
  assert.equal(applied.code, 0, applied.errors.join("\n"));
  assert.equal(applied.report?.sourceCount, 2);
  assert.equal(applied.report.archiveNames.length, 1);
  const compacted = readFileSync(join(dir, applied.report.archiveNames[0]!));
  assert.equal(compacted.readUInt32LE(compacted.length - 4), gunzipSync(compacted).length);
  assert.ok(gunzipSync(compacted).includes(Buffer.from("rotated")));

  const old = "2026-11-01T01:00:00Z";
  const oversized = gzipArchive(dir, old, [1, 2, 3].map(i => row(old, `legacy-${i}`, randomBytes(170).toString("hex"))).join(""));
  for (const hour of [3, 4, 5]) {
    const at = `2026-11-10T0${hour}:00:00Z`;
    gzipArchive(dir, at, row(at, `ordinary-${hour}`));
  }
  assert.ok(statSync(join(dir, oversized)).size > 4 * statSync(join(dir, compactedArchiveName("2026-11-10T03:00:00Z"))).size);
  const oversizedBytes = readFileSync(join(dir, oversized));
  const inflate = gunzipSync;
  let oversizedInflations = 0;
  const spy = t.mock.method(zlib, "gunzipSync", (body: Buffer, options?: Parameters<typeof gunzipSync>[1]) => {
    if (body.equals(oversizedBytes)) oversizedInflations += 1;
    return inflate(body, options);
  });
  syncBuiltinESMExports();
  let repair: ReturnType<typeof pass>;
  try {
    repair = pass(dir, 512, true);
  } finally {
    spy.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(repair.code, 0, repair.errors.join("\n"));
  assert.equal(repair.report?.eligibleCount, 5);
  assert.equal(repair.report.sizeSkippedCount, 4, "the oversized merged archive is selected alone");
  assert.equal(oversizedInflations, 1, "the repair inflates the archive only to read its rows");
});

test("W1-T13414 criterion 3: a wrong trailer is reported and the pass writes only bounded archives with all the rows", t => {
  const { dir } = ownedFixtureDir(t, "ledger-trailer-mismatch");
  const first = "2026-11-10T01:00:00Z", second = "2026-11-10T02:00:00Z", third = "2026-11-10T03:00:00Z";
  const rows = [row(first, "first", "x".repeat(50)), row(first, "second", "x".repeat(50)),
    row(second, "plain", "x".repeat(50)), row(third, "gzip", "x".repeat(50))];
  const multi = compactedArchiveName(first);
  writeFileSync(join(dir, multi), Buffer.concat([gzipSync(rows[0]!), gzipSync(rows[1]!)]));
  writeFileSync(join(dir, compactedArchiveName(second).replace(/\.gz$/, "")), rows[2]!);
  gzipArchive(dir, third, rows[3]!);
  const ceiling = Buffer.byteLength(rows.slice(1).join(""));
  const { code, errors, report } = pass(dir, ceiling);
  assert.equal(code, 0, errors.join("\n"));
  const mismatch = errors.find(line => line.includes(multi) && line.includes("trailer"));
  assert.ok(mismatch, errors.join("\n"));
  assert.ok(mismatch.includes(`${Buffer.byteLength(rows[1]!)} bytes`));
  assert.ok(mismatch.includes(`${Buffer.byteLength(rows[0]! + rows[1]!)} bytes`));
  assert.equal(report?.sourceCount, 3);
  assert.equal(report.archiveNames.length, 2);
  const outputs = report.archiveNames.map(name => gunzipSync(readFileSync(join(dir, name))));
  assert.ok(outputs.every(body => body.length <= ceiling));
  assert.deepEqual(outputs.flatMap(body => body.toString("utf8").trimEnd().split("\n")).sort(), rows.map(line => line.trimEnd()).sort());
});

test("W1-T13414 criterion 3: a selected cut gzip is named and compaction leaves the files intact", t => {
  const { dir } = ownedFixtureDir(t, "ledger-trailer-cut");
  const at = "2026-11-10T01:00:00Z";
  const name = compactedArchiveName(at);
  const cut = gzipSync(row(at, "cut")).subarray(0, -2);
  writeFileSync(join(dir, name), cut);
  const { code, errors } = pass(dir, 1024);
  assert.equal(code, 1);
  assert.ok(errors.some(line => line.includes(name) && line.includes("inflated size unavailable")
    && line.includes(`trailer ${cut.readUInt32LE(cut.length - 4)} bytes`)), errors.join("\n"));
  assert.deepEqual(readdirSync(dir), [name]);
  assert.deepEqual(readFileSync(join(dir, name)), cut);
});

test("W1-T13414 criterion 3: plain archive bytes count toward the same ceiling", t => {
  const { dir } = ownedFixtureDir(t, "ledger-trailer-plain");
  const first = "2026-11-10T01:00:00Z", second = "2026-11-10T02:00:00Z";
  const plain = row(first, "plain", "é".repeat(25));
  const gzip = row(second, "gzip");
  writeFileSync(join(dir, compactedArchiveName(first).replace(/\.gz$/, "")), plain);
  gzipArchive(dir, second, gzip);
  const total = Buffer.byteLength(plain + gzip);
  assert.equal(pass(dir, total, true).report?.sourceCount, 2);
  const deferred = pass(dir, total - 1, true);
  assert.equal(deferred.code, 0, deferred.errors.join("\n"));
  assert.equal(deferred.report?.sizeSkippedCount, 1);
});

test("a gzip shorter than a minimum member falls back to the inflation error", t => {
  const { dir } = ownedFixtureDir(t, "ledger-trailer-short");
  const name = compactedArchiveName("2026-11-10T01:00:00Z");
  writeFileSync(join(dir, name), Buffer.from([0x1f, 0x8b, 0x08]));
  const { code, errors } = pass(dir, 1024);
  assert.equal(code, 1);
  assert.ok(errors.some(line => line.includes(name) && line.includes("cannot list or size eligible archives")
    && line.includes("unexpected end of file")), errors.join("\n"));
  assert.deepEqual(readdirSync(dir), [name]);
});
