// OBSERVED 2026-10-09 on the fleet host: every ci-friction pass (a fresh child process every 60 s) gunzipped
// all 423 archived ledger rotations (178 MB gzipped, ~3.8 GB decompressed) to read the same history again, and
// the flake-incident pass did the same over its seven-day window. A rotation is written once, so its reduced
// rows are digested on disk and a later process decompresses only a rotation it has not seen.
import assert from "node:assert/strict";
import { existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fixedClock } from "../src/lib/clock.js";
import {
  CI_FRICTION_LEDGER_STEPS, ciFrictionRotationDigests, readCiFrictionLedgerRecords,
} from "../src/lib/ci-friction-gardener.js";
import { FLAKE_INCIDENT_GARDEN_NAME, runFlakeIncidentGardener } from "../src/lib/flake-incident-gardener.js";
import { ledgerRotationDigests, readLedgerUnionRecordsSync, realLedgerFs, type LedgerGrepFsDeps } from "../src/lib/ledger-union.js";
import { writeLedger } from "./helpers/ledger-fixture.js";

function countingFs() {
  const counts = { gunzips: 0, archiveReads: 0 };
  const fs: LedgerGrepFsDeps = {
    ...realLedgerFs,
    readFileSync: (path) => {
      if (/ledger\.[^/]*\.ndjson(\.gz)?$/.test(path) && !path.includes("rotation-digests")) counts.archiveReads += 1;
      return realLedgerFs.readFileSync(path);
    },
    gunzipSync: (buf) => (counts.gunzips += 1, realLedgerFs.gunzipSync(buf)),
  };
  return { counts, fs };
}

const history = [
  { ts: "2026-09-20T12:00:00Z", step: "pr.opened", run_id: "run-a", pr_url: "https://github.com/a/b/pull/1" },
  { ts: "2026-09-20T12:25:00Z", step: "fix.dispatch", run_id: "run-a", mode: "merge-conflict", round: 1 },
  { ts: "2026-09-20T12:30:00Z", step: "fix.dispatch", run_id: "DAEMON-b", head_sha: "head-b", mode: "ci-log", elapsed_ms: 120000 },
  { ts: "2026-09-20T12:31:00Z", step: "review.posted", head_sha: "head-b", pr_url: "https://github.com/a/b/pull/42" },
  { ts: "2026-09-20T12:32:00Z", step: "review.posted", head_sha: "head-b", pr_number: 999 },
  { ts: "2026-09-20T12:33:00Z", step: "heartbeat.tick", note: "head-b" },
];

test("a second ci-friction history read decompresses no archive and returns the same rows", (t) => {
  const fixture = writeLedger([{ ts: "2026-09-21T00:00:00Z", step: "sweep.disposed", head_sha: "head-c", pr_number: 3 }], {
    rotations: [
      { at: "2026-09-20T12:26:00.000Z", gz: true, rows: history.slice(0, 2) },
      { at: "2026-09-20T12:40:00.000Z", gz: true, rows: history.slice(2) },
    ],
  });
  t.after(() => rmSync(fixture.dir, { recursive: true, force: true }));
  // The reference: the same reader with no digests, i.e. every archive parsed in full as before.
  const undigested = readCiFrictionLedgerRecords(fixture.dir, (dir, options, fs) =>
    readLedgerUnionRecordsSync(dir, { ...options, rotationRecords: undefined }, fs));
  assert.ok(undigested.some((row) => row.step === "review.posted" && row.pr_number === 42), "the positive control recovers a head");

  const first = countingFs();
  const firstRows = readCiFrictionLedgerRecords(fixture.dir, readLedgerUnionRecordsSync, ciFrictionRotationDigests(fixture.dir, first.fs));
  assert.ok(first.counts.gunzips >= 2, "a first read decompresses each archive");
  assert.deepEqual(firstRows, undigested, "digested rows are the full union's rows");

  // A fresh process: new hooks, nothing in memory, only the digests on disk.
  const second = countingFs();
  const secondRows = readCiFrictionLedgerRecords(fixture.dir, readLedgerUnionRecordsSync, ciFrictionRotationDigests(fixture.dir, second.fs));
  assert.equal(second.counts.gunzips, 0, "no archive is decompressed again");
  assert.equal(second.counts.archiveReads, 0, "no archive is even read again");
  assert.deepEqual(secondRows, undigested);

  // A new rotation is the only one decompressed, and a removed one's digest is pruned.
  writeLedger([], { dir: fixture.dir, rotations: [{ at: "2026-09-21T06:00:00.000Z", gz: true, rows: [
    { ts: "2026-09-21T05:00:00Z", step: "fix.dispatch", run_id: "DAEMON-c", head_sha: "head-c", mode: "ci-log", elapsed_ms: 60000 },
  ] }] });
  const third = countingFs();
  const thirdRows = readCiFrictionLedgerRecords(fixture.dir, readLedgerUnionRecordsSync, ciFrictionRotationDigests(fixture.dir, third.fs));
  assert.equal(third.counts.gunzips, 2, "only the new rotation is decompressed, once for each of the two digests");
  assert.ok(thirdRows.some((row) => row.run_id === "DAEMON-c"));
  assert.deepEqual(thirdRows.filter((row) => CI_FRICTION_LEDGER_STEPS.includes(row.step as string)).length,
    readLedgerUnionRecordsSync(fixture.dir, { step: CI_FRICTION_LEDGER_STEPS }).rows.length);
});

test("a stale, damaged or foreign rotation digest is re-parsed, never trusted", (t) => {
  const fixture = writeLedger([], { rotations: [{ at: "2026-09-20T12:26:00.000Z", gz: true, rows: history }] });
  t.after(() => rmSync(fixture.dir, { recursive: true, force: true }));
  const keep = (rows: Array<Record<string, unknown>>) => rows.filter((row) => row.step === "review.posted");
  const read = (version: string) => {
    const probe = countingFs();
    const digests = ledgerRotationDigests(fixture.dir, keep, { holder: "probe", reducerVersion: version }, probe.fs);
    const rows = readLedgerUnionRecordsSync(fixture.dir, { step: "review.posted", rotationRecords: digests.rotationRecords }, probe.fs).rows;
    return { rows, gunzips: probe.counts.gunzips, counts: digests.counts() };
  };
  const fresh = read("1");
  assert.equal(fresh.rows.length, 2);
  assert.deepEqual(read("1").counts, { hits: 1, parsed: 0, writeFailed: 0, pruned: 0 });
  assert.equal(read("2").gunzips, 1, "a new reducer version re-reads the rotation");
  const dir = join(fixture.dir, "cache", "rotation-digests", "probe");
  const [digest] = readdirSync(dir);
  writeFileSync(join(dir, digest!), "{ damaged");
  const damaged = read("2");
  assert.equal(damaged.gunzips, 1, "a damaged digest is a miss");
  assert.deepEqual(damaged.rows, fresh.rows);
  writeFileSync(join(dir, "ledger.2026-01-01T00-00-00-000Z.ndjson.gz.json"), "{}");
  assert.equal(read("2").counts.pruned, 1, "the digest of a rotation that is gone is removed");
  assert.throws(() => ledgerRotationDigests(fixture.dir, keep, { holder: "", reducerVersion: "1" }), /holder and reducer version/);
});

test("an unwritable digest store still returns the rotation's rows", (t) => {
  const fixture = writeLedger([], { rotations: [{ at: "2026-09-20T12:26:00.000Z", gz: true, rows: history }] });
  t.after(() => rmSync(fixture.dir, { recursive: true, force: true }));
  writeFileSync(join(fixture.dir, "cache"), "a file where the digest directory would go");
  const digests = ledgerRotationDigests(fixture.dir, (rows) => rows, { holder: "probe", reducerVersion: "1" });
  const rows = readLedgerUnionRecordsSync(fixture.dir, { rotationRecords: digests.rotationRecords }).rows;
  assert.equal(rows.length, history.length);
  assert.equal(digests.counts().writeFailed, 1);
});

test("the flake-incident pass digests the rotations in its window", async (t) => {
  const now = Date.parse("2026-10-08T14:00:00Z");
  const fixture = writeLedger([], { rotations: [{ at: "2026-10-08T10:00:00.000Z", gz: true, rows: [
    { ts: "2026-10-08T09:00:00Z", step: "test.flake_retry", file: "test/x.test.ts", pr_numbers: [1], head_sha: "h", base_sha: "b" },
  ] }] });
  t.after(() => rmSync(fixture.dir, { recursive: true, force: true }));
  await runFlakeIncidentGardener({ stateDir: fixture.dir, repoRoot: fixture.dir, clock: fixedClock(now), openWorkspace: () => { throw new Error("nothing to file"); }, log: () => {} },
    { mintTaskId: () => "W1-T1", readChangedPaths: () => [] });
  assert.ok(existsSync(join(fixture.dir, "cache", "rotation-digests", FLAKE_INCIDENT_GARDEN_NAME, "ledger.2026-10-08T10-00-00-000Z.ndjson.gz.json")),
    "the next pass answers this rotation without decompressing it");
});
