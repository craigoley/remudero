import assert from "node:assert/strict";
import { appendFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import {
  approximateMemoBytes, createIncrementalLedgerUnion, readLedgerUnionRecordsSync, realLedgerFs,
  type LedgerGrepFsDeps,
} from "../src/lib/ledger-union.js";
import { writeLedger } from "./helpers/ledger-fixture.js";

// Synthetic chronology only: no timestamp here is compared with the wall clock or a trailing window.
const row = (n: number, payload = "measured") => ({
  ts: new Date(Date.UTC(2026, 9, 1, 0, 0, 0, n)).toISOString(),
  step: "verdict", run_id: `size-fixture-${n}`, task_id: "W1-TSYNTHETIC", payload,
});
const options = { step: "verdict", refuseIncomplete: true };

test("W1-T9764: a union state is sized without serializing its rows", (t) => {
  const fixture = writeLedger(Array.from({ length: 20_000 }, (_, i) => row(i)));
  t.after(() => rmSync(fixture.dir, { recursive: true, force: true }));
  const read = createIncrementalLedgerUnion({ holder: "9764-no-reserialize", reducerVersion: "1" });
  assert.equal(read(fixture.dir, options).rows.length, 20_000, "positive corpus control");
  const stringify = JSON.stringify;
  let wholeRowArrays = 0;
  JSON.stringify = ((value: unknown, ...args: unknown[]) => {
    if (Array.isArray(value) && value.some(item => Array.isArray(item) && item.length >= 20_000 && item[0]?.step === "verdict")) wholeRowArrays += 1;
    return Reflect.apply(stringify, JSON, [value, ...args]);
  }) as typeof JSON.stringify;
  try {
    assert.equal(read(fixture.dir, options).rows.length, 20_000, "unchanged cache control");
    fixture.append([row(20_000)]);
    assert.equal(read(fixture.dir, options).rows.length, 20_001);
    assert.equal(read.size().entries, 20_001, "shared last-result rows are not counted twice");
    assert.equal(wholeRowArrays, 0, "one appended row must not serialize the retained 20,000-row array");
  } finally { JSON.stringify = stringify; }
});

test("W1-T9764: the incremental size stays within twice the old figure", (t) => {
  const older = Array.from({ length: 3000 }, (_, i) => row(i, "λ🙂".repeat(80)));
  const replayed = [...older.slice(0, 100), ...Array.from({ length: 2000 }, (_, i) => row(3000 + i, "quoted\\\"\n界".repeat(40)))];
  const live = Array.from({ length: 300 }, (_, i) => row(5000 + i, "live".repeat(100)));
  const fixture = writeLedger(live, { rotations: [
    { at: "2026-10-02T00:00:00.000Z", rows: older, gz: true },
    { at: "2026-10-03T00:00:00.000Z", rows: replayed },
  ] });
  t.after(() => rmSync(fixture.dir, { recursive: true, force: true }));
  const read = createIncrementalLedgerUnion({ holder: "9764-realistic", reducerVersion: "1" });
  assert.deepEqual(read(fixture.dir, options), readLedgerUnionRecordsSync(fixture.dir, options));
  const physicalRows = [...older, ...replayed, ...live];
  // The former Set held every parsed object, including physical replay copies, but not last-result aliases.
  // Path/signature syntax is tiny beside this corpus; this reproduces its row-payload + existing64-byte basis.
  const oldRowFigure = approximateMemoBytes(physicalRows) + physicalRows.length * 64;
  const size = read.size();
  assert.equal(size.entries, physicalRows.length);
  assert(size.approx_bytes > oldRowFigure / 2 && size.approx_bytes < oldRowFigure * 2,
    `carried bytes ${size.approx_bytes} must keep the old ${oldRowFigure} scale, not just count rows`);
});

test("incremental size follows append, rewrite, rotation and incomplete recovery without changing answers", (t) => {
  const fixture = writeLedger([row(0)], { rotations: [{ at: "2026-10-02T00:00:00.000Z", rows: [row(1)], gz: true }] });
  t.after(() => rmSync(fixture.dir, { recursive: true, force: true }));
  const read = createIncrementalLedgerUnion({ holder: "9764-lifecycle", reducerVersion: "1" });
  const same = () => {
    const { filesRead: memoIo, ...actual } = read(fixture.dir, options);
    const { filesRead: wholeIo, ...expected } = readLedgerUnionRecordsSync(fixture.dir, options);
    // Existing distinction: a failing memo hook counts only completed parses, the uncached path
    // counts its attempted read before decompression. Compare every answer/coverage field, not I/O cost.
    assert.deepEqual(actual, expected); assert(memoIo <= wholeIo);
  };
  same(); assert.equal(read.size().entries, 2);
  fixture.append([row(2)]); same(); assert.equal(read.size().entries, 3);
  writeFileSync(fixture.path, JSON.stringify(row(3)) + "\n"); same(); assert.equal(read.size().entries, 2);
  renameSync(fixture.path, join(fixture.dir, "ledger.2026-10-04T00-00-00-000Z.ndjson"));
  writeFileSync(fixture.path, JSON.stringify(row(4)) + "\n"); same(); assert.equal(read.size().entries, 3);
  const archive = join(fixture.dir, readdirSync(fixture.dir).find(name => name.endsWith(".gz"))!);
  writeFileSync(archive, "not gzip");
  same(); assert.equal(read.size().entries, 2, "an unread part and rejected last result retain no rows");
  writeFileSync(archive, gzipSync(Buffer.from(JSON.stringify(row(1)) + "\n")));
  same(); assert.equal(read.size().entries, 3);
});

test("an unfinished row is counted once, then moves from the last result into the committed live part", (t) => {
  const fixture = writeLedger();
  t.after(() => rmSync(fixture.dir, { recursive: true, force: true }));
  const text = JSON.stringify(row(0)); writeFileSync(fixture.path, text);
  const read = createIncrementalLedgerUnion({ holder: "9764-fragment", reducerVersion: "1" });
  assert.equal(read(fixture.dir, options).rows.length, 1);
  assert.equal(read.size().entries, 1);
  appendFileSync(fixture.path, "\n");
  assert.equal(read(fixture.dir, options).rows.length, 1);
  assert.equal(read.size().entries, 1);
  writeFileSync(fixture.path, ""); read(fixture.dir, options); assert.equal(read.size().entries, 0);
});

test("only projected bytes are charged and ignored appends do not accumulate phantom payload", (t) => {
  const fixture = writeLedger([row(0, "discarded".repeat(2000))]);
  t.after(() => rmSync(fixture.dir, { recursive: true, force: true }));
  const read = createIncrementalLedgerUnion({ holder: "9764-projection", reducerVersion: "1", project: ({ ts, step, run_id }) => ({ ts, step, run_id }) });
  assert.equal(read(fixture.dir, options).rows.length, 1);
  const initial = read.size(); assert(initial.approx_bytes < 4000, "raw discarded bytes are not retained");
  for (let i = 1; i <= 30; i++) {
    fixture.append([{ ...row(i), step: "health.tick", payload: "discarded".repeat(100) }]);
    assert.equal(read(fixture.dir, options).rows.length, 1);
  }
  assert.equal(read.size().entries, 1);
  assert(read.size().approx_bytes < initial.approx_bytes + 256, "empty parsed tails add no retained payload");
});

test("a nonmemoizable archive is still charged when the last result retains its rows", (t) => {
  const fixture = writeLedger([row(0)], { rotations: [{ at: "2026-10-02T00:00:00.000Z", rows: [row(1)], gz: true }] });
  t.after(() => rmSync(fixture.dir, { recursive: true, force: true }));
  const fs: LedgerGrepFsDeps = { ...realLedgerFs, statSync: path => {
    if (path.endsWith(".gz")) throw new Error("private fixture stat refusal");
    return realLedgerFs.statSync(path);
  } };
  const read = createIncrementalLedgerUnion({ holder: "9764-uncached-part", reducerVersion: "1" }, fs);
  assert.deepEqual(read(fixture.dir, options), readLedgerUnionRecordsSync(fixture.dir, options));
  assert.equal(read.size().entries, 2);
});

test("size errors stay outside the read catch and an unretained fragment is never sized", (t) => {
  const complete = writeLedger([row(0)]), partial = writeLedger();
  t.after(() => { rmSync(complete.dir, { recursive: true, force: true }); rmSync(partial.dir, { recursive: true, force: true }); });
  const make = () => createIncrementalLedgerUnion({ holder: "9764-size-refusal", reducerVersion: "1", project: r => ({ ...r, unsupported: 1n }) });
  assert.throws(() => make()(complete.dir, options), /BigInt/, "retained unserializable output still refuses instead of becoming an unread archive");
  writeFileSync(join(partial.dir, "ledger.2026-10-02T00-00-00-000Z.ndjson.gz"), "not gzip");
  writeFileSync(partial.path, JSON.stringify(row(1)));
  const read = make(), result = read(partial.dir, options);
  assert.equal(result.ok, false); assert.equal(result.unread.length, 1);
  assert.equal(read.size().entries, 0, "the incomplete result and its fragment are not retained");
});
