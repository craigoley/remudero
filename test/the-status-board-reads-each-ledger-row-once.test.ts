import assert from "node:assert/strict";
import { test } from "node:test";
import { isRotationLockHolderStale, LEDGER_ROTATION_SMOOTHING_WINDOW_MS } from "../src/lib/ledger.js";
import { createLedgerRotationMemo } from "../src/lib/ledger-union.js";
import { isHolderStale } from "../src/lib/fs-race-safe.js";
import { readLedgerUnionBounded, readLedgerUnionMemoized } from "../src/lib/status.js";
import { writeLedger } from "./helpers/ledger-fixture.js";

// W1-T4820. MEASURED 2026-09-29 on the fleet corpus: the board's union read returned 1,042,796 rows, of
// which 676,741 were distinct. Re-measured 2026-09-30 on a copy of the fleet host's seven-day window
// (329 archives plus the live file): 1,035,951 rows, 675,504 distinct. Two sources, both below.
//   1. The live file's retained core is a copy of rows its archives already hold, so every read of
//      live plus archives sees each retained row twice.
//   2. Rotators in the daemon and serve containers raced: `isHolderStale`'s host rung calls a lock
//      naming another container id a dead predecessor's, so each reclaimed the other's live lock
//      and both archived one snapshot. Evidence in that window: five same-second twin archives
//      (`ledger.2026-09-28T20-45-49-835Z` and `-837Z`, 44,548 and 44,559 bytes), and archives cut
//      2026-09-26/27 that re-archived the whole retained core (84-93% replayed rows) when one rotator
//      ran between the other's rename and its carried-prefix sidecar write. The 09-30 09:06 archive
//      replays none of an earlier one; its 117 repeats are identical `worker.activity` rows the
//      daemon itself wrote in one millisecond, which is a writer matter, not rotation.

const HOUR = 3_600_000;
const iso = (msAgo: number): string => new Date(Date.now() - msAgo).toISOString();

/** Rows one rotation archived, then re-archived by the next two, then still retained live. */
function replayedCorpus(distinct: number) {
  const rows = Array.from({ length: distinct }, (_, i) => ({ ts: iso(5 * HOUR - i * 1_000), task_id: "W1-T2982", run_id: `r${i}`, step: "run.start" }));
  const fresh = { ts: iso(60_000), task_id: "W1-T2982", run_id: "live", step: "verdict", verdict: "merged" };
  return {
    fixture: writeLedger([...rows, fresh], {
      rotations: [4, 3, 2].map((hoursAgo) => ({ at: iso(hoursAgo * HOUR), rows, gz: hoursAgo === 3 })),
    }),
    distinct: distinct + 1,
  };
}

test("W1-T4820: the board union returns a re-archived row once", () => {
  const { fixture, distinct } = replayedCorpus(32);
  const lines = readLedgerUnionBounded(fixture.path);
  assert.equal(lines.length, distinct, "32 dispatches in three archives and the live file are 32 dispatches");
  assert.equal(lines.filter((l) => l.step === "run.start").length, 32);
  assert.equal(new Set(lines.map((l) => l.run_id)).size, distinct);
});

test("W1-T4820: the dedupe keeps the bounded read inside its bound", () => {
  // The bound is work, not wall time: dedupe must make a replay cheaper than the parse it replaces,
  // or the board's one-second read goes over it (a post-parse key took 665 ms to 958 ms). A replayed
  // archive line is skipped BEFORE its parse, so the read parses each distinct line once.
  const { fixture, distinct } = replayedCorpus(2_000);
  const realParse = JSON.parse;
  let parses = 0;
  JSON.parse = ((text: string, reviver?: (this: unknown, key: string, value: unknown) => unknown) => {
    parses += 1;
    return realParse(text, reviver);
  }) as typeof JSON.parse;
  let lines;
  try {
    lines = readLedgerUnionBounded(fixture.path);
  } finally {
    JSON.parse = realParse;
  }
  assert.equal(lines.length, distinct);
  // The live file is parsed once (distinct lines), and not one of the 6,000 archived replays is parsed.
  assert.equal(parses, distinct, `parsed ${parses} lines for ${distinct} distinct rows`);
});

test("W1-T4820: the memoized union behind action-results and operator-activity returns a replayed row once", async () => {
  const { fixture, distinct } = replayedCorpus(32);
  const memo = createLedgerRotationMemo((rows) => rows);
  const lines = await readLedgerUnionMemoized(fixture.path, memo);
  assert.equal(lines.length, distinct);
  const warm = await readLedgerUnionMemoized(fixture.path, memo);
  assert.equal(warm.length, distinct, "a warm pass reads the memoized rows once too");
});

test("W1-T4820: a rotation lock held by the sibling container is live while it is young", () => {
  const held = { pid: 95, host: "435ba5ef2cd7", startedAt: iso(2_000) };
  const opts = { hostname: () => "6e0b5200b656", inContainer: () => true };
  // The generic rung calls this holder a dead predecessor container; that is the race this fixes.
  assert.equal(isHolderStale(held, { ...opts, isPidAlive: () => false }), true);
  assert.equal(isRotationLockHolderStale(held, opts), false);
});

test("W1-T4820: a rotation lock the sibling container abandoned is reclaimed after one rotation cadence", () => {
  const opts = { hostname: () => "6e0b5200b656", inContainer: () => true };
  const old = { pid: 95, host: "435ba5ef2cd7", startedAt: iso(LEDGER_ROTATION_SMOOTHING_WINDOW_MS + 60_000) };
  assert.equal(isRotationLockHolderStale(old, opts), true);
  assert.equal(isRotationLockHolderStale({ ...old, startedAt: "not a time" }, opts), true, "an unreadable start is no evidence of a live holder");
});

test("W1-T4820: a rotation lock on this host is still judged by pid liveness", () => {
  const held = { pid: 424242, host: "6e0b5200b656", startedAt: iso(1_000) };
  const opts = { hostname: () => "6e0b5200b656" };
  assert.equal(isRotationLockHolderStale(held, { ...opts, isPidAlive: () => false }), true);
  assert.equal(isRotationLockHolderStale(held, { ...opts, isPidAlive: () => true }), false);
});

test("W1-T4820: rows that share a timestamp or carry none are each kept once", () => {
  const at = iso(5 * HOUR);
  const rows = [
    { ts: at, task_id: "W1-T1", step: "sweep.disposed", pr_number: 1 },
    { ts: at, task_id: "W1-T1", step: "sweep.disposed", pr_number: 2 },
    { step: "daemon.tick", note: "no timestamp at all" },
    { step: "daemon.tick", ts: at, note: "timestamp not first" },
    {},
  ];
  const fixture = writeLedger(rows, { rotations: [3, 2].map((hoursAgo) => ({ at: iso(hoursAgo * HOUR), rows })) });
  const lines = readLedgerUnionBounded(fixture.path);
  assert.equal(lines.length, rows.length, "two rows in one millisecond are two events, and a replay of either is none");
  assert.deepEqual(lines.map((l) => l.pr_number ?? l.note).sort(), [1, 2, "no timestamp at all", "timestamp not first", undefined].sort());
});
