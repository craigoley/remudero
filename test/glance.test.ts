// test/glance.test.ts — W1-T159 (GLANCE layer): the pinned summary strip's aggregate reductions
// that are NOT already available client-side off already-fetched arrays. "merged-today" and
// "spend-today"/"spend-this-week" all require a full ledger scan (GET /v1/recent caps at a
// handful of entries — see board.ts's buildRecentRoute `max` default — so a busy day/week can
// blow past what's already loaded in the browser), so these are computed server-side, once, off
// the SAME already-read ledger lines board.ts's computeBoardSnapshot holds.
import assert from "node:assert/strict";
import { test } from "node:test";
import { computeGlanceSpend } from "../src/lib/glance.js";
import { deriveDayCostUsd, deriveWeekCostUsd, utcDayWindowMs, utcWeekWindowMs } from "../src/lib/sweep.js";

const NOW = Date.parse("2026-07-29T18:00:00.000Z"); // a Wednesday

test("W1-T159: deriveWeekCostUsd sums ledgered cost from the start of the current UTC week (Monday 00:00) through now, per-run like deriveDayCostUsd", () => {
  const lines = [
    // Monday of THIS week (2026-07-27), well before "now" (Wednesday) -- inside the window.
    { ts: "2026-07-27T01:00:00.000Z", run_id: "R1", task_id: "W1-T1", step: "verdict", verdict: "merged", cost_usd: 2 },
    // Today, same week.
    { ts: "2026-07-29T10:00:00.000Z", run_id: "R2", task_id: "W1-T2", step: "verdict", verdict: "blocked_review", cost_usd: 3 },
    // LAST week (Sunday 2026-07-26) -- must NOT bleed into this week's total.
    { ts: "2026-07-26T23:59:00.000Z", run_id: "R3", task_id: "W1-T3", step: "verdict", verdict: "merged", cost_usd: 999 },
  ];
  const total = deriveWeekCostUsd(lines, NOW);
  assert.equal(total, 5, "R1 ($2) + R2 ($3) = $5; last week's $999 (R3) is excluded");
});

test("W1-T159: utcWeekWindowMs bounds are [this Monday 00:00 UTC, next Monday 00:00 UTC) — a Sunday one second before Monday is excluded, a Monday millisecond is included", () => {
  const [start, end] = utcWeekWindowMs(NOW);
  assert.equal(new Date(start).toISOString(), "2026-07-27T00:00:00.000Z");
  assert.equal(new Date(end).toISOString(), "2026-08-03T00:00:00.000Z");
});

test("W1-T159: computeGlanceSpend counts mergedToday from verdict lines with verdict:'merged' dated today (UTC) -- a merge yesterday, or a non-merge verdict today, does not count", () => {
  const lines = [
    { ts: "2026-07-29T09:00:00.000Z", run_id: "R1", task_id: "W1-T1", step: "verdict", verdict: "merged", cost_usd: 1 },
    { ts: "2026-07-29T09:05:00.000Z", run_id: "R2", task_id: "W1-T2", step: "verdict", verdict: "merged", cost_usd: 1 },
    { ts: "2026-07-29T09:10:00.000Z", run_id: "R3", task_id: "W1-T3", step: "verdict", verdict: "blocked_review", cost_usd: 1 }, // not a merge
    { ts: "2026-07-28T23:59:00.000Z", run_id: "R4", task_id: "W1-T4", step: "verdict", verdict: "merged", cost_usd: 1 }, // yesterday
  ];
  const glance = computeGlanceSpend(lines, NOW);
  assert.equal(glance.mergedToday, 2, "only R1 and R2 -- merged, AND dated today");
});

test("W1-T159: computeGlanceSpend's spendTodayUsd/spendWeekUsd equal deriveDayCostUsd/deriveWeekCostUsd over the SAME lines -- one reduction, never a second disagreeing derivation", () => {
  const lines = [
    { ts: "2026-07-27T01:00:00.000Z", run_id: "R1", task_id: "W1-T1", step: "verdict", verdict: "merged", cost_usd: 2 },
    { ts: "2026-07-29T10:00:00.000Z", run_id: "R2", task_id: "W1-T2", step: "verdict", verdict: "blocked_review", cost_usd: 3 },
  ];
  const glance = computeGlanceSpend(lines, NOW);
  assert.equal(glance.spendTodayUsd, deriveDayCostUsd(lines, NOW));
  assert.equal(glance.spendWeekUsd, deriveWeekCostUsd(lines, NOW));
  assert.equal(glance.spendTodayUsd, 3);
  assert.equal(glance.spendWeekUsd, 5);
});

test("W1-T159: computeGlanceSpend's mergedToday window agrees with sweep.ts's own utcDayWindowMs -- no second, independently-computed notion of 'today'", () => {
  const [start] = utcDayWindowMs(NOW);
  const lines = [
    { ts: new Date(start).toISOString(), run_id: "R1", task_id: "W1-T1", step: "verdict", verdict: "merged", cost_usd: 1 }, // exactly midnight -- inside
    { ts: new Date(start - 1).toISOString(), run_id: "R2", task_id: "W1-T2", step: "verdict", verdict: "merged", cost_usd: 1 }, // 1ms before midnight -- outside
  ];
  const glance = computeGlanceSpend(lines, NOW);
  assert.equal(glance.mergedToday, 1);
});
