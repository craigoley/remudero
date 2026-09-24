import assert from "node:assert/strict";
import { rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { createLedgerRotationMemo, LEDGER_ROTATION_LOAD_LINES_PER_TURN } from "../src/lib/ledger-union.js";
import { readLedgerUnionBounded, readLedgerUnionMemoized } from "../src/lib/status.js";
import { writeLedger } from "./helpers/ledger-fixture.js";

const identity = (rows: Array<Record<string, unknown>>) => rows;

function rows(prefix: string, count: number): Array<Record<string, unknown>> {
  return Array.from({ length: count }, (_, i) => ({ step: "run.start", task_id: `${prefix}-${i}`, ts: new Date(Date.UTC(2026, 8, 20, 0, 0, i)).toISOString() }));
}

function countingReads() {
  const reads: string[] = [];
  return { reads, readFile: (path: string) => { reads.push(path); return readFile(path); } };
}

test("unit test: a rotation memo serves a repeated union read without reading any rotation again", async () => {
  const fx = writeLedger(rows("live", 3), {
    rotations: [
      { at: "2026-09-20T01:00:00.000Z", rows: rows("older", 5), gz: true },
      { at: "2026-09-20T02:00:00.000Z", rows: rows("newer", 4) },
    ],
  });
  try {
    const counter = countingReads();
    const memo = createLedgerRotationMemo(identity, { readFile: counter.readFile });
    const whole = readLedgerUnionBounded(fx.path);
    assert.equal(whole.length, 12);
    assert.deepEqual([...(await readLedgerUnionMemoized(fx.path, memo))], [...whole]);
    assert.equal(counter.reads.length, 2, "the cold read loads each rotation once");
    fx.append(rows("appended", 2));
    const warm = await readLedgerUnionMemoized(fx.path, memo);
    assert.deepEqual([...warm], [...readLedgerUnionBounded(fx.path)]);
    assert.equal(warm.present, true);
    assert.equal(counter.reads.length, 2, "a warm read re-reads the live file only");
    assert.equal(memo.size(), 2);
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test("unit test: a rotation memo reloads a rotation whose size changed and prunes one that left the corpus", async () => {
  const fx = writeLedger(rows("live", 1), {
    rotations: [
      { at: "2026-09-20T01:00:00.000Z", rows: rows("gone", 2) },
      { at: "2026-09-20T02:00:00.000Z", rows: rows("kept", 2) },
    ],
  });
  try {
    const counter = countingReads();
    const memo = createLedgerRotationMemo(identity, { readFile: counter.readFile });
    await readLedgerUnionMemoized(fx.path, memo);
    assert.equal(memo.size(), 2);
    rmSync(join(fx.dir, "ledger.2026-09-20T01-00-00-000Z.ndjson"));
    const kept = join(fx.dir, "ledger.2026-09-20T02-00-00-000Z.ndjson");
    writeFileSync(kept, rows("rewritten", 3).map((r) => JSON.stringify(r)).join("\n") + "\n");
    const after = await readLedgerUnionMemoized(fx.path, memo);
    assert.deepEqual([...after], [...readLedgerUnionBounded(fx.path)]);
    assert.equal(after.filter((r) => String(r.task_id).startsWith("rewritten")).length, 3);
    assert.equal(memo.size(), 1, "the removed rotation is pruned");
    assert.equal(counter.reads.length, 3);
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test("unit test: a rotation memo loads a large rotation in slices that yield the event loop", async () => {
  const lines = LEDGER_ROTATION_LOAD_LINES_PER_TURN * 2 + 7;
  const fx = writeLedger([], { rotations: [{ at: "2026-09-20T01:00:00.000Z", rows: rows("big", lines), gz: true }] });
  try {
    let yields = 0;
    const memo = createLedgerRotationMemo(identity, { yieldTurn: async () => { yields += 1; } });
    const read = await readLedgerUnionMemoized(fx.path, memo);
    assert.equal(read.length, lines);
    assert.deepEqual([...read], [...readLedgerUnionBounded(fx.path)]);
    assert.equal(yields, 3, "one yield per bounded slice");
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test("unit test: a rotation memo parses a failed load inline and a corrupt rotation stays unread", async () => {
  const fx = writeLedger(rows("live", 1), { rotations: [{ at: "2026-09-20T01:00:00.000Z", rows: rows("ok", 2) }] });
  const corrupt = join(fx.dir, "ledger.2026-09-20T02-00-00-000Z.ndjson.gz");
  writeFileSync(corrupt, "not gzip at all\n{\"torn\"\n");
  try {
    let failures = 0;
    const memo = createLedgerRotationMemo(identity, {
      readFile: (path) => (path.endsWith("01-00-00-000Z.ndjson") && failures++ === 0 ? Promise.reject(new Error("EMFILE")) : readFile(path)),
    });
    const read = await readLedgerUnionMemoized(fx.path, memo);
    assert.deepEqual([...read], [...readLedgerUnionBounded(fx.path)]);
    assert.equal(read.length, 3, "the transiently failed rotation is parsed inline; the corrupt one contributes nothing");
    assert.equal(memo.size(), 1, "only the rotation that parsed is memoized");
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test("unit test: a rotation memo reads an unstattable rotation uncached", () => {
  const memo = createLedgerRotationMemo(identity);
  const parsed = { rows: [{ step: "run.start" }], torn: 1, tornLines: ["{\"ts\":"] };
  assert.equal(memo.pass().rotationRecords({ path: "/nonexistent/ledger.2026-09-20T01-00-00-000Z.ndjson", form: "plain" }, () => parsed), parsed);
  assert.equal(memo.size(), 0);
});

test("unit test: concurrent loads of one rotation read it once", async () => {
  const fx = writeLedger([], { rotations: [{ at: "2026-09-20T01:00:00.000Z", rows: rows("one", 2), gz: true }] });
  try {
    const counter = countingReads();
    const memo = createLedgerRotationMemo(identity, { readFile: counter.readFile });
    const entry = { path: join(fx.dir, "ledger.2026-09-20T01-00-00-000Z.ndjson.gz"), form: "gzip" as const };
    await Promise.all([memo.load([entry]), memo.load([entry])]);
    assert.equal(counter.reads.length, 1);
    const stamp = statSync(entry.path).mtime;
    utimesSync(entry.path, stamp, new Date(stamp.getTime() + 5_000));
    await readLedgerUnionMemoized(fx.path, memo);
    assert.equal(counter.reads.length, 2, "a changed mtime is a different rotation");
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});
