import { describe, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { DRAIN_MEMO_FILENAME, PROGRESS_WATCHDOG_DRAIN_STEPS, readProgressWatchdogDrainRows } from "#src/lib/progress-watchdog-drain-memo.js";
import { readLedgerUnionRecordsSync, realLedgerFs, type LedgerGrepFsDeps } from "#src/lib/ledger-union.js";

const OLD = "ledger.2026-01-01T00-00-00-000Z.ndjson.gz";
const NEW = "ledger.2026-01-02T00-00-00-000Z.ndjson.gz";
const replayed = { ts: "2026-01-01T12:00:00.000Z", step: "implement.done", run_id: "replayed", worker_duration_ms: 600_000 };

function fixture(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-w1-t14920-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const lines = (rows: Record<string, unknown>[]) => rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
  writeFileSync(join(dir, OLD), gzipSync(lines([
    { ts: "2026-01-01T01:00:00.000Z", step: "implement.done", run_id: "a", worker_duration_ms: 7_200_000 },
    { ts: "2026-01-01T02:00:00.000Z", step: "sweep.pass", enumerated: 3 },
    replayed,
  ])));
  writeFileSync(join(dir, NEW), gzipSync(lines([
    replayed,
    { ts: "2026-01-02T01:00:00.000Z", step: "verdict", run_id: "b" },
    { ts: "2026-01-02T02:00:00.000Z", step: "worker.recycle_yield", run_id: "c", decision: "acted" },
  ])));
  writeFileSync(join(dir, "ledger.ndjson"), lines([
    replayed,
    { ts: "2026-01-03T01:00:00.000Z", step: "run.freshness_handoff", run_id: "d" },
    { ts: "2026-01-03T02:00:00.000Z", step: "daemon.pulse" },
  ]));
  return dir;
}

/** Real file reads, counting each read of a rotation (a gz file) by name. */
function counting(): { fs: LedgerGrepFsDeps; reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    fs: { ...realLedgerFs, readFileSync: (path) => { if (path.endsWith(".gz")) reads.push(path.split("/").pop()!); return realLedgerFs.readFileSync(path); } },
  };
}

function wholeRead(dir: string): Array<Record<string, unknown>> {
  return readLedgerUnionRecordsSync(dir, { step: [...PROGRESS_WATCHDOG_DRAIN_STEPS] }).rows;
}

describe("test/deploy/the-watchdog-drain-read-parses-each-rotation-once.test.ts", () => {
  test("W1-T14920 an unchanged rotation is not read again", (t) => {
    const dir = fixture(t);
    const first = counting();
    readProgressWatchdogDrainRows(dir, first.fs);
    assert.deepEqual(first.reads.sort(), [OLD, NEW]);
    assert.ok(existsSync(join(dir, DRAIN_MEMO_FILENAME)), "the first read remembers its rotations");
    const second = counting();
    readProgressWatchdogDrainRows(dir, second.fs);
    assert.deepEqual(second.reads, [], "a second read with unchanged rotations reads no rotation file");
  });

  test("W1-T14920 remembered rows equal a whole read", (t) => {
    const dir = fixture(t);
    const expected = wholeRead(dir);
    assert.equal(expected.filter((row) => row.run_id === "replayed").length, 1, "the union dedupes the replayed line");
    assert.deepEqual(readProgressWatchdogDrainRows(dir), expected, "a cold read equals a whole read");
    assert.deepEqual(readProgressWatchdogDrainRows(dir), expected, "a remembered read equals a whole read");
    assert.deepEqual(expected.map((row) => row.run_id).sort(), ["a", "b", "c", "d", "replayed"]);
  });

  test("W1-T14920 a changed or removed rotation refreshes its entry", (t) => {
    const dir = fixture(t);
    readProgressWatchdogDrainRows(dir);
    const extra = { ts: "2026-01-02T03:00:00.000Z", step: "implement.done", run_id: "e", worker_duration_ms: 60_000 };
    writeFileSync(join(dir, NEW), gzipSync([replayed, extra].map((row) => JSON.stringify(row)).join("\n") + "\n"));
    utimesSync(join(dir, NEW), new Date("2026-01-04T00:00:00Z"), new Date("2026-01-04T00:00:00Z"));
    const changed = counting();
    const rows = readProgressWatchdogDrainRows(dir, changed.fs);
    assert.deepEqual(changed.reads, [NEW], "only the changed rotation is parsed again");
    assert.deepEqual(rows, wholeRead(dir));
    assert.ok(rows.some((row) => row.run_id === "e"));
    unlinkSync(join(dir, OLD));
    readProgressWatchdogDrainRows(dir);
    const memo = JSON.parse(readFileSync(join(dir, DRAIN_MEMO_FILENAME), "utf8")) as { entries: Record<string, unknown> };
    assert.deepEqual(Object.keys(memo.entries).map((path) => path.split("/").pop()), [NEW], "a removed rotation's entry is dropped");
  });

  test("W1-T14920 an unstattable rotation is read whole and not remembered", (t) => {
    const dir = fixture(t);
    const expected = wholeRead(dir);
    const blind = (): { fs: LedgerGrepFsDeps; reads: string[] } => {
      const inner = counting();
      return { reads: inner.reads, fs: { ...inner.fs, statSync: (path) => {
        if (path.endsWith(OLD)) throw Object.assign(new Error("stat refused"), { code: "EACCES" });
        return realLedgerFs.statSync(path);
      } } };
    };
    const first = blind();
    assert.deepEqual(readProgressWatchdogDrainRows(dir, first.fs), expected, "an unstattable rotation still yields its rows");
    const memo = JSON.parse(readFileSync(join(dir, DRAIN_MEMO_FILENAME), "utf8")) as { entries: Record<string, unknown> };
    assert.deepEqual(Object.keys(memo.entries).map((path) => path.split("/").pop()), [NEW], "the unstattable rotation is not remembered");
    const second = blind();
    assert.deepEqual(readProgressWatchdogDrainRows(dir, second.fs), expected);
    assert.deepEqual(second.reads, [OLD], "it is read whole again on the next read");
  });

  test("W1-T14920 a replayed line survives the retirement of the rotation that first held it", (t) => {
    const dir = mkdtempSync(join(tmpdir(), "rmd-w1-t14920-retire-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const lines = (rows: Record<string, unknown>[]) => rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
    const a1 = { ts: "2026-01-01T01:00:00.000Z", step: "implement.done", run_id: "a1", worker_duration_ms: 60_000 };
    const a2 = { ts: "2026-01-01T02:00:00.000Z", step: "verdict", run_id: "a2" };
    const b1 = { ts: "2026-01-02T01:00:00.000Z", step: "verdict", run_id: "b1" };
    writeFileSync(join(dir, OLD), gzipSync(lines([a1, a2])));
    writeFileSync(join(dir, NEW), gzipSync(lines([a1, a2, b1]) + "{torn\n[1]\n")); // a compaction's replacement, published before its sources retire
    writeFileSync(join(dir, "ledger.ndjson"), lines([{ ts: "2026-01-03T01:00:00.000Z", step: "daemon.pulse" }]));
    assert.deepEqual(readProgressWatchdogDrainRows(dir), wholeRead(dir));
    unlinkSync(join(dir, OLD));
    const after = readProgressWatchdogDrainRows(dir);
    assert.deepEqual(after, wholeRead(dir), "after the source retires, the remembered replacement still holds its rows");
    assert.deepEqual(after.map((row) => row.run_id).sort(), ["a1", "a2", "b1"]);
  });
});
