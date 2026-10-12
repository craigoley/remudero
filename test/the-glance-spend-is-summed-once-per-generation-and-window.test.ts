import assert from "node:assert/strict";
import { test } from "node:test";
import * as glance from "../src/lib/glance.js";
import { noteLedgerGeneration } from "../src/lib/status.js";

const NOW = Date.parse("2026-10-07T12:00:00.000Z");
type Rows = Array<Record<string, unknown>>;

function rows(): Rows {
  return [
    { ts: "2026-10-04T23:59:59.999Z", step: "verdict", verdict: "merged", run_id: "old", cost_usd: 100 },
    { ts: "2026-10-05T00:00:00.000Z", step: "verdict", verdict: "merged", run_id: "monday", cost_usd: 2 },
    { ts: "2026-10-07T09:00:00.000Z", step: "worker.cost", run_id: "today", usd: 9 },
    { ts: "2026-10-07T10:00:00.000Z", step: "verdict", verdict: "merged", run_id: "today", cost_usd: 3 },
    { ts: "2026-10-07T11:00:00.000Z", step: "verdict", verdict: "blocked_review", run_id: "blocked", cost_usd: 4 },
    { ts: "2026-10-08T00:00:00.000Z", step: "verdict", verdict: "merged", run_id: "tomorrow", cost_usd: 5 },
    { ts: "2026-10-12T00:00:00.000Z", step: "verdict", verdict: "merged", run_id: "next-week", cost_usd: 6 },
    { ts: "invalid", step: "verdict", verdict: "merged", run_id: "invalid", cost_usd: 200 },
    { step: "verdict", verdict: "merged", run_id: "undated", cost_usd: 300 },
  ];
}

function scanCount(): number {
  assert.equal(typeof glance.glanceSpendScanCount, "function", "the scan counting seam must exist");
  return glance.glanceSpendScanCount();
}

function check(lines: Rows, now: number, scans: number): glance.GlanceSpend {
  scanCount();
  // A fresh, unregistered array runs the original reductions on every reference call.
  const expected = glance.computeGlanceSpend(lines.map((row) => ({ ...row })), now);
  const before = scanCount();
  const actual = glance.computeGlanceSpend(lines, now);
  assert.equal(scanCount() - before, scans, "only a cache miss runs the reductions");
  assert.deepEqual(actual, expected, "every result equals an unmemoized call");
  return actual;
}

test("test/the-glance-spend-is-summed-once-per-generation-and-window.test.ts: unchanged generation scans once", () => {
  const lines = rows();
  noteLedgerGeneration(lines, 0);
  const first = check(lines, NOW, 1);
  assert.equal(first.mergedToday, 1);
  assert.equal(first.spendTodayUsd, 7);
  assert.equal(first.spendWeekUsd, 14);
  for (const now of [NOW, NOW + 60_000, Date.parse("2026-10-07T23:59:59.999Z")]) {
    assert.deepEqual(check(lines, now, 0), first);
  }
});

test("W1-T6272: a new generation rescans an array mutated in place", () => {
  const lines = rows();
  noteLedgerGeneration(lines, 0);
  check(lines, NOW, 1);
  lines.push({ ts: "2026-10-07T12:00:00.000Z", step: "verdict", verdict: "merged", run_id: "new", cost_usd: 8 });
  noteLedgerGeneration(lines, 1);
  const updated = check(lines, NOW, 1);
  assert.equal(updated.mergedToday, 2);
  assert.equal(updated.spendTodayUsd, 15);
  assert.equal(updated.spendWeekUsd, 22);
  check(lines, NOW + 1, 0);
});

test("W1-T6272: UTC midnight rescans within the same ISO week", () => {
  const lines = rows();
  noteLedgerGeneration(lines, 7);
  check(lines, Date.parse("2026-10-07T23:59:59.999Z"), 1);
  const nextDay = check(lines, Date.parse("2026-10-08T00:00:00.000Z"), 1);
  assert.equal(nextDay.mergedToday, 1);
  assert.equal(nextDay.spendTodayUsd, 5);
  assert.equal(nextDay.spendWeekUsd, 14);
  check(lines, Date.parse("2026-10-08T12:00:00.000Z"), 0);
});

test("W1-T6272: Monday midnight rescans for the new UTC ISO week", () => {
  const lines = rows();
  noteLedgerGeneration(lines, 7);
  const sunday = check(lines, Date.parse("2026-10-11T23:59:59.999Z"), 1);
  assert.equal(sunday.spendWeekUsd, 14);
  const monday = check(lines, Date.parse("2026-10-12T00:00:00.000Z"), 1);
  assert.equal(monday.mergedToday, 1);
  assert.equal(monday.spendTodayUsd, 6);
  assert.equal(monday.spendWeekUsd, 6);
  check(lines, Date.parse("2026-10-12T12:00:00.000Z"), 0);
});

test("W1-T6272: unregistered arrays rescan every call, including after mutation", () => {
  const lines = rows();
  check(lines, NOW, 1);
  check(lines, NOW, 1);
  lines.push({ ts: "2026-10-07T12:00:00.000Z", step: "verdict", verdict: "merged", run_id: "new", cost_usd: 8 });
  assert.equal(check(lines, NOW, 1).spendTodayUsd, 15);
  lines[3].cost_usd = 10;
  assert.equal(check(lines, NOW, 1).spendTodayUsd, 22);
});

test("W1-T6272: the memo belongs to the array, including empty registered arrays", () => {
  const first = rows();
  const second: Rows = [];
  noteLedgerGeneration(first, 7);
  noteLedgerGeneration(second, 7);
  check(first, NOW, 1);
  const empty = check(second, NOW, 1);
  assert.deepEqual(empty, { mergedToday: 0, channel: "fleet", spendTodayUsd: 0, spendWeekUsd: 0, sessionSpendUsd: null });
  check(first, NOW, 0);
  check(second, NOW, 0);
});

test("W1-T6272: both cache misses and hits return copies of the held result", () => {
  const lines = rows();
  noteLedgerGeneration(lines, 7);
  const first = check(lines, NOW, 1);
  const expected = { ...first };
  first.mergedToday = -1;
  first.spendTodayUsd = -1;
  first.spendWeekUsd = -1;
  const second = check(lines, NOW, 0);
  assert.notStrictEqual(second, first);
  assert.deepEqual(second, expected);
  second.mergedToday = -2;
  second.spendTodayUsd = -2;
  second.spendWeekUsd = -2;
  const third = check(lines, NOW, 0);
  assert.notStrictEqual(third, second);
  assert.deepEqual(third, expected);
});
