// OBSERVED 2026-10-10 on the fleet host: the core daemon's main thread touched 1.5-3.5 GB of fresh pages every
// 30 s, with heap_used sawing to ~4 GB on a ~0.7 GB live set. Dispatch selection read the whole ledger corpus
// (446 rotations, 3.97 M lines, 1.78 GB decompressed) and parsed every line on every tick and lane refill to keep
// 61,803 rows, then sorted them with a comparator that serialised both rows on every comparison. These tests pin
// that a repeated selection reads only what changed and that its answer is the whole-corpus read's answer.
import assert from "node:assert/strict";
import { renameSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { buildDispatchValueContext, sortRowsByJson } from "../src/lib/dispatch-value.js";
import {
  createIncrementalLedgerUnion, readLedgerUnionRecordsSync, realLedgerFs, type LedgerGrepFsDeps,
} from "../src/lib/ledger-union.js";
import type { Plan, Task } from "../src/lib/plan.js";
import { dispatchValueContextForSelection } from "../src/run-task.js";
import { writeLedger } from "./helpers/ledger-fixture.js";

const DAY = 86_400_000;
// Stamped off the real clock: no row here ages out of a trailing window.
const T0 = Date.now() - 2 * DAY;
const at = (offsetMs: number): string => new Date(T0 + offsetMs).toISOString();
const STEPS = ["run.start", "verdict", "verdict.merged", "dispatch.cost_of_delay.fallback", "dispatch.cost_of_delay.ready", "dispatch.refused_already_merged"];

function countingFs() {
  const counts = { archiveReads: 0, digestReads: 0, gunzips: 0, liveReads: 0, rangeReads: 0, rangeBytes: 0 };
  const fs: LedgerGrepFsDeps = {
    ...realLedgerFs,
    readFileSync: (path) => {
      if (path.includes("rotation-digests")) counts.digestReads += 1;
      else if (path.endsWith("ledger.ndjson")) counts.liveReads += 1;
      else if (/ledger\.[^/]*\.ndjson(\.gz)?$/.test(path)) counts.archiveReads += 1;
      return realLedgerFs.readFileSync(path);
    },
    gunzipSync: (buf) => (counts.gunzips += 1, realLedgerFs.gunzipSync(buf)),
    readRangeSync: (path, start, end) => {
      const buf = realLedgerFs.readRangeSync(path, start, end);
      counts.rangeReads += 1;
      counts.rangeBytes += buf.length;
      return buf;
    },
  };
  const reset = () => { for (const key of Object.keys(counts) as Array<keyof typeof counts>) counts[key] = 0; };
  return { counts, fs, reset };
}

function rowsFor(prefix: string, n: number, offsetMs: number): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  for (let i = 0; i < n; i++) {
    const id = `W1-T${9000 + i}`;
    rows.push({ ts: at(offsetMs + i * 1000), step: "run.start", task_id: id, run_id: `${prefix}-${i}`, task_class: i % 2 ? "src" : "test" });
    rows.push({ ts: at(offsetMs + i * 1000 + 1), step: "heartbeat.tick", note: `${prefix}-${i}` });
    rows.push({ ts: at(offsetMs + i * 1000 + 2), step: "verdict", task_id: id, run_id: `${prefix}-${i}`, verdict: i % 3 ? "merged" : "no_pr", cost_usd: 1 + (i % 4) });
  }
  return rows;
}

function corpus() {
  const first = rowsFor("first", 6, 0);
  const second = rowsFor("second", 6, DAY / 4);
  // The rotation carries a replay of rows the earlier rotation already holds, as retention does.
  const fixture = writeLedger(rowsFor("live", 4, DAY / 2), {
    rotations: [
      { at: at(DAY / 8), gz: true, rows: first },
      { at: at(DAY / 3), gz: true, rows: [...first.slice(0, 3), ...second] },
    ],
  });
  return fixture;
}

const whole = (dir: string) => readLedgerUnionRecordsSync(dir, { step: STEPS, refuseIncomplete: true });
const pick = (read: { ok: boolean; unread: string[]; rows: Array<Record<string, unknown>>; torn: number; archiveCount: number; liveFileRead: boolean }) =>
  ({ ok: read.ok, unread: read.unread, rows: read.rows, torn: read.torn, archiveCount: read.archiveCount, liveFileRead: read.liveFileRead });

test("a second dispatch selection over an unchanged ledger reads no rotation and no live byte", (t) => {
  const fixture = corpus();
  t.after(() => rmSync(fixture.dir, { recursive: true, force: true }));
  const { counts, fs, reset } = countingFs();
  const read = createIncrementalLedgerUnion({ holder: "dispatch-test", reducerVersion: "1" }, fs);
  const first = read(fixture.dir, { step: STEPS, refuseIncomplete: true });
  assert.ok(first.rows.length >= 20, `the fixture yields evidence rows (${first.rows.length})`);
  assert.deepEqual(pick(first), pick(whole(fixture.dir)), "the first read is the whole-corpus read");
  assert.equal(counts.gunzips, 2, "the first read decompresses each rotation once");
  reset();
  const second = read(fixture.dir, { step: STEPS, refuseIncomplete: true });
  assert.deepEqual(counts, { archiveReads: 0, digestReads: 0, gunzips: 0, liveReads: 0, rangeReads: 0, rangeBytes: 0 }, "nothing is read again");
  assert.equal(second, first, "an unchanged ledger returns the previous answer");
  assert.ok(Object.isFrozen(second.rows), "the shared rows cannot be changed by a caller");
});

test("a selection after the live ledger grew reads only the new tail and no rotation", (t) => {
  const fixture = corpus();
  t.after(() => rmSync(fixture.dir, { recursive: true, force: true }));
  const { counts, fs, reset } = countingFs();
  const read = createIncrementalLedgerUnion({ holder: "dispatch-test", reducerVersion: "1" }, fs);
  read(fixture.dir, { step: STEPS, refuseIncomplete: true });
  reset();
  const more = rowsFor("tail", 2, DAY);
  const appended = Buffer.byteLength(more.map((row) => JSON.stringify(row)).join("\n") + "\n");
  fixture.append(more);
  const grown = read(fixture.dir, { step: STEPS, refuseIncomplete: true });
  assert.equal(counts.archiveReads + counts.digestReads + counts.gunzips + counts.liveReads, 0, "no rotation, digest or whole live file is read");
  assert.equal(counts.rangeReads, 1);
  assert.ok(counts.rangeBytes <= appended + 64, `only the appended bytes and a small anchor are read (${counts.rangeBytes} of ${appended})`);
  assert.deepEqual(pick(grown), pick(whole(fixture.dir)));
  assert.ok(grown.rows.some((row) => row.run_id === "tail-1"));
});

test("a rewritten, rotated or half-written live ledger still reads exactly what a whole-corpus read does", (t) => {
  const fixture = corpus();
  t.after(() => rmSync(fixture.dir, { recursive: true, force: true }));
  const { counts, fs, reset } = countingFs();
  const read = createIncrementalLedgerUnion({ holder: "dispatch-test", reducerVersion: "1" }, fs);
  const same = () => assert.deepEqual(pick(read(fixture.dir, { step: STEPS, refuseIncomplete: true })), pick(whole(fixture.dir)));
  same();
  // A line still being written: read as a whole-file read reads it, then completed.
  const partial = JSON.stringify({ ts: at(DAY + 5), step: "verdict", task_id: "W1-T9100", run_id: "partial", verdict: "merged", cost_usd: 3 });
  appendFileSync(fixture.path, partial.slice(0, 40));
  same();
  appendFileSync(fixture.path, partial.slice(40));
  same();
  appendFileSync(fixture.path, "\n");
  same();
  // The same file rewritten in place, longer, with different bytes before the old watermark.
  writeFileSync(fixture.path, rowsFor("rewritten", 9, DAY).map((row) => JSON.stringify(row)).join("\n") + "\n");
  same();
  // A rotation: the live file is archived and a new one started. Only the new archive is decompressed.
  reset();
  renameSync(fixture.path, join(fixture.dir, `ledger.${at(DAY + 60_000).replace(/[:.]/g, "-")}.ndjson`));
  writeFileSync(fixture.path, rowsFor("after", 2, DAY + 120_000).map((row) => JSON.stringify(row)).join("\n") + "\n");
  same();
  assert.equal(counts.gunzips, 0, "the two older archives are never decompressed again");
  assert.equal(counts.archiveReads, 1, "only the new archive is read");
});

test("a restarted reader reads digests, not archives, and an unreadable archive is never cached", (t) => {
  const fixture = corpus();
  t.after(() => rmSync(fixture.dir, { recursive: true, force: true }));
  createIncrementalLedgerUnion({ holder: "dispatch-test", reducerVersion: "1" }, countingFs().fs)(fixture.dir, { step: STEPS, refuseIncomplete: true });
  const restarted = countingFs();
  const read = createIncrementalLedgerUnion({ holder: "dispatch-test", reducerVersion: "1" }, restarted.fs);
  assert.deepEqual(pick(read(fixture.dir, { step: STEPS, refuseIncomplete: true })), pick(whole(fixture.dir)));
  assert.equal(restarted.counts.gunzips, 0, "a new process decompresses no archive its predecessor digested");

  writeFileSync(join(fixture.dir, `ledger.${at(DAY / 2 + 1).replace(/[:.]/g, "-")}.ndjson.gz`), Buffer.from("not gzip"));
  const broken = read(fixture.dir, { step: STEPS, refuseIncomplete: true });
  assert.deepEqual(pick(broken), pick(whole(fixture.dir)));
  assert.equal(broken.ok, false);
  restarted.reset();
  read(fixture.dir, { step: STEPS, refuseIncomplete: true });
  assert.equal(restarted.counts.gunzips, 1, "an unread archive is tried again, never answered from a cached failure");
  writeFileSync(join(fixture.dir, `ledger.${at(DAY / 2 + 1).replace(/[:.]/g, "-")}.ndjson.gz`), gzipSync(Buffer.from("")));
  assert.equal(read(fixture.dir, { step: STEPS, refuseIncomplete: true }).ok, true);
});

const task = (id: string): Task => ({
  id, title: id, repo: "remudero", depends_on: [], files: ["src/a.ts"], type: "implement", verify: "auto", risk: "high", status: "queued", attempts: 0,
});
const plan = (tasks: Task[]): Plan => ({ tasks, byId: new Map(tasks.map((t) => [t.id, t])) });

test("dispatch selection through the incremental union equals selection through the whole-corpus read", (t) => {
  const fixture = corpus();
  t.after(() => rmSync(fixture.dir, { recursive: true, force: true }));
  const tasks = [task("W1-T9001"), task("W1-T9004"), task("W1-T9300")];
  const filing = { kind: "ready" as const, snapshot: { planTreeSha: "tree", filedAtByTaskId: new Map(tasks.map((x, i) => [x.id, T0 - (i + 1) * DAY])) } };
  const select = (readLedger: NonNullable<Parameters<typeof dispatchValueContextForSelection>[5]>) => {
    const logs: Array<[string, unknown]> = [];
    const context = dispatchValueContextForSelection(plan(tasks), () => false, fixture.dir, (step, extra) => logs.push([step, extra]),
      "/fixture/tasks.yaml", readLedger, () => filing);
    // The ready row is written once per ledger directory, by whichever selection runs first.
    return { context, logs: logs.filter(([step]) => step !== "dispatch.cost_of_delay.ready") };
  };
  const { counts, fs, reset } = countingFs();
  const incremental = createIncrementalLedgerUnion({ holder: "dispatch-test", reducerVersion: "1" }, fs);
  const expected = select(readLedgerUnionRecordsSync);
  assert.ok(expected.context?.stridePassByTaskId, "the positive control schedules every open task");
  assert.deepEqual(select(incremental), expected);
  reset();
  assert.deepEqual(select(incremental), expected, "a repeat selection gives the same context and the same log rows");
  assert.equal(counts.gunzips + counts.archiveReads + counts.digestReads + counts.rangeReads, 0, "a repeat selection over an unchanged ledger reads nothing");
  fixture.append(rowsFor("more", 3, DAY));
  assert.deepEqual(select(incremental), select(readLedgerUnionRecordsSync));
});

test("evidence is sorted in the old order with each row serialised once, and not sorted again", () => {
  const rows: Array<Record<string, unknown>> = [
    { ts: at(5), step: "verdict", run_id: "b", note: "Zeta" },
    { ts: at(5), step: "verdict", run_id: "b", note: "alpha" },
    { ts: at(5), step: "verdict", run_id: "B", note: "alpha" },
    { ts: at(1), step: "run.start", run_id: "é", task_class: "src" },
    { ts: at(1), step: "run.start", run_id: "e", task_class: "src" },
    { step: "verdict.merged", task_id: "W1-T1" },
    { ts: at(3), step: "verdict", run_id: "a-1", cost_usd: 10 },
    { ts: at(3), step: "verdict", run_id: "a-10", cost_usd: 2 },
    { ts: at(3), step: "verdict", run_id: "a_2", cost_usd: 2 },
  ];
  for (let i = 0; i < 200; i++) rows.push({ ts: at((i * 7919) % 500), step: i % 2 ? "verdict" : "run.start", run_id: `r${(i * 31) % 97}`, n: i });
  const old = [...rows].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const stringify = JSON.stringify;
  let calls = 0;
  JSON.stringify = ((...args: Parameters<typeof JSON.stringify>) => (calls += 1, stringify(...args))) as typeof JSON.stringify;
  let sorted: ReadonlyArray<Record<string, unknown>>;
  try {
    sorted = sortRowsByJson(rows);
    assert.equal(calls, rows.length, "one serialisation per row, not two per comparison");
    calls = 0;
    buildDispatchValueContext([], sorted, new Set(), Date.parse(at(DAY)), true, "seed", { planTreeSha: "tree", filedAtByTaskId: new Map() });
    assert.equal(calls, 0, "calibration does not re-sort evidence that is already sorted");
  } finally {
    JSON.stringify = stringify;
  }
  assert.deepEqual(sorted, old);
  assert.ok(Object.isFrozen(sorted));
});

test("the incremental union reads uncached for an option it does not cache, and fails closed when it cannot stat", (t) => {
  const fixture = corpus();
  t.after(() => rmSync(fixture.dir, { recursive: true, force: true }));
  const since = at(DAY / 4);
  const plain = createIncrementalLedgerUnion({ holder: "dispatch-test", reducerVersion: "1" });
  assert.deepEqual(pick(plain(fixture.dir, { step: STEPS, since })), pick(readLedgerUnionRecordsSync(fixture.dir, { step: STEPS, since })));
  assert.deepEqual(pick(plain(fixture.dir)), pick(readLedgerUnionRecordsSync(fixture.dir)), "an unfiltered read is never cached");

  const rotationStatFails: LedgerGrepFsDeps = {
    ...realLedgerFs,
    statSync: (path) => {
      if (path.endsWith(".ndjson.gz")) throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      return realLedgerFs.statSync(path);
    },
  };
  const unstattable = createIncrementalLedgerUnion({ holder: "dispatch-test", reducerVersion: "1" }, rotationStatFails);
  assert.deepEqual(pick(unstattable(fixture.dir, { step: STEPS, refuseIncomplete: true })), pick(whole(fixture.dir)),
    "a rotation it cannot stat is read in full, never memoized");

  const liveStatFails: LedgerGrepFsDeps = {
    ...realLedgerFs,
    statSync: (path) => {
      if (path === fixture.path) throw Object.assign(new Error("EIO"), { code: "EIO" });
      return realLedgerFs.statSync(path);
    },
  };
  const failed = createIncrementalLedgerUnion({ holder: "dispatch-test", reducerVersion: "1" }, liveStatFails)(fixture.dir, { step: STEPS, refuseIncomplete: true });
  assert.equal(failed.ok, false, "a live file it cannot stat is an unread live file, never an empty one");
  assert.deepEqual(failed.unread, [fixture.path]);
});

test("a ranged read past the end of a file returns the bytes that exist", (t) => {
  const fixture = writeLedger([{ ts: at(0), step: "run.start", run_id: "only" }]);
  t.after(() => rmSync(fixture.dir, { recursive: true, force: true }));
  const size = realLedgerFs.statSync(fixture.path).size;
  assert.equal(realLedgerFs.readRangeSync(fixture.path, 0, size + 100).length, size);
  assert.equal(realLedgerFs.readRangeSync(fixture.path, 5, 5).length, 0);
});
