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

test("compressed rotation memo preserves all rows and malformed evidence across passes", () => {
  const memo = createLedgerRotationMemo(identity, { statKey: () => "fixed", storage: "compressed" });
  const entry = { path: "synthetic", form: "gzip" as const };
  const original = { rows: Array.from({ length: 3000 }, (_, i) => ({ ts: "2000-01-01T00:00:00Z", id: i, body: { text: "Unicode \u2028 \u2029 🚀".repeat(30), nullable: null } })), torn: 2, tornLines: ["bad-a", "bad-b"] };
  let parses = 0;
  const cold = memo.pass({ parseMissing: true });
  const a = cold.rotationRecords(entry, () => { parses++; return original; });
  assert.deepEqual(a, original);
  assert.equal(cold.complete(), true);
  assert.ok(memo.retention().compressedBytes! > 0);
  assert.ok(memo.retention().compressedBytes! < Buffer.byteLength(JSON.stringify(original)) / 4);
  const warm = memo.pass();
  const b = warm.rotationRecords(entry, () => { parses++; throw new Error("must not reparse"); });
  assert.deepEqual(b, original);
  assert.equal(warm.rotationRecords(entry, () => { throw new Error("must not reparse"); }), b);
  assert.equal(warm.complete(), true);
  assert.equal(parses, 1);
  assert.equal(memo.retention().rows, 3000);
});

test("compressed rotation memo invalidates changed archives and preserves empty malformed archives", () => {
  let stamp = "one";
  const memo = createLedgerRotationMemo(identity, { statKey: () => stamp, storage: "compressed" });
  const entry = { path: "fixture", form: "plain" as const };
  let pass = memo.pass({ parseMissing: true });
  pass.rotationRecords(entry, () => ({ rows: [{ id: "old" }], torn: 0, tornLines: [] }));
  pass.complete();
  stamp = "two";
  pass = memo.pass();
  assert.deepEqual(pass.rotationRecords(entry, () => { throw new Error("must report missing"); }).rows, []);
  assert.equal(pass.complete(), false);
  assert.equal(pass.missing().length, 1);
  pass = memo.pass({ parseMissing: true });
  const expected = { rows: [], torn: 1, tornLines: ["malformed-source-marker"] };
  assert.deepEqual(pass.rotationRecords(entry, () => expected), expected);
  pass.complete();
  pass = memo.pass();
  assert.deepEqual(pass.rotationRecords(entry, () => { throw new Error("must use packed empty read"); }), expected);
  pass.complete();
});

test("compressed rotation memo falls back losslessly for an unserializable injected value", () => {
  const fn = () => "fixture";
  const read = { rows: [{ injected: fn }], torn: 0, tornLines: [] };
  const memo = createLedgerRotationMemo(identity, { statKey: () => "fixed", storage: "compressed" });
  const entry = { path: "fixture", form: "plain" as const };
  let pass = memo.pass({ parseMissing: true });
  assert.equal(pass.rotationRecords(entry, () => read).rows[0]?.injected, fn);
  pass.complete();
  pass = memo.pass();
  assert.equal(pass.rotationRecords(entry, () => { throw new Error("must keep ordinary read"); }).rows[0]?.injected, fn);
  assert.equal(memo.retention().compressedBytes, undefined);
});

test("compressed async rotation load reads the real archive once and reports unreadable input", async () => {
  const fx = writeLedger(rows("live", 2), { rotations: [{ at: "2026-09-20T01:00:00.000Z", rows: rows("old", 4), gz: true }] });
  try {
    const counter = countingReads();
    const memo = createLedgerRotationMemo(identity, { readFile: counter.readFile, storage: "compressed" });
    const expected = readLedgerUnionBounded(fx.path);
    assert.deepEqual([...(await readLedgerUnionMemoized(fx.path, memo))], [...expected]);
    assert.ok(memo.retention().compressedBytes! > 0);
    assert.deepEqual([...(await readLedgerUnionMemoized(fx.path, memo))], [...expected]);
    assert.equal(counter.reads.length, 1);
    const failed = createLedgerRotationMemo(identity, { statKey: () => "fixed", readFile: async () => { throw new Error("unreadable"); }, storage: "compressed" });
    await failed.load([{ path: "missing", form: "plain" }]);
    assert.equal(failed.retention().failedArchives, 1);
    assert.throws(() => failed.pass().rotationRecords({ path: "missing", form: "plain" }, () => { throw new Error("still unreadable"); }), /still unreadable/);
  } finally { rmSync(fx.dir, { recursive: true, force: true }); }
});

test("rotation memo retention counts reduced rows and pruning without rereading or exposing bodies", () => {
  const memo = createLedgerRotationMemo((r) => r.filter((row) => row.keep), { statKey: () => "fixed" });
  const a = { path: "synthetic-a", form: "plain" as const };
  const b = { path: "synthetic-b", form: "gzip" as const };
  let pass = memo.pass({ parseMissing: true });
  pass.rotationRecords(a, () => ({ rows: [{ keep: true, payload: "private" }, { keep: false }], torn: 1, tornLines: ["private broken row"] }));
  pass.rotationRecords(b, () => ({ rows: [{ keep: true }, { keep: true }], torn: 0, tornLines: [] }));
  assert.equal(pass.complete(), true);
  assert.deepEqual(memo.retention(), { archives: 2, rows: 3, tornRows: 1, failedArchives: 0 });
  pass = memo.pass();
  pass.rotationRecords(b, () => { throw new Error("must not reparse"); });
  assert.equal(pass.complete(), true);
  assert.deepEqual(memo.retention(), { archives: 1, rows: 2, tornRows: 0, failedArchives: 0 });
});

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
