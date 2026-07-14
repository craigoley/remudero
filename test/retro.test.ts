import assert from "node:assert/strict";
import { test } from "node:test";
import {
  aggregateByType,
  assertArchitectAboveWorker,
  buildGather,
  calibrationTable,
  codeFilesInDiff,
  gatherRuns,
  mergedSince,
  parseLedger,
  tierOf,
  verdictDistribution,
} from "../src/lib/retro.js";

// A recorded ledger fixture: two implement runs (one merged, one budget-blocked)
// and a recon run, exactly as run-task.ts writes them.
const LEDGER = [
  `{"ts":"2026-01-01T00:00:00.000Z","run_id":"A","task_id":"TA","step":"run.start","type":"implement","budget_usd":100}`,
  `{"ts":"2026-01-01T00:01:00.000Z","run_id":"A","task_id":"TA","step":"recon.done","num_turns":2,"cost_usd":0.2}`,
  `{"ts":"2026-01-01T00:02:00.000Z","run_id":"A","task_id":"TA","step":"implement.done","num_turns":10,"cost_usd":1.5}`,
  `{"ts":"2026-01-01T00:03:00.000Z","run_id":"A","task_id":"TA","step":"pr.opened","pr_url":"https://github.com/o/r/pull/1"}`,
  `{"ts":"2026-01-01T00:04:00.000Z","run_id":"A","task_id":"TA","step":"verdict","verdict":"merged","cost_usd":2.0,"pr_url":"https://github.com/o/r/pull/1"}`,
  `torn line that is not json {{{`,
  `{"ts":"2026-01-02T00:00:00.000Z","run_id":"B","task_id":"TB","step":"run.start","type":"implement","budget_usd":100}`,
  `{"ts":"2026-01-02T00:01:00.000Z","run_id":"B","task_id":"TB","step":"recon.done","num_turns":2}`,
  `{"ts":"2026-01-02T00:02:00.000Z","run_id":"B","task_id":"TB","step":"implement.done","num_turns":30}`,
  `{"ts":"2026-01-02T00:03:00.000Z","run_id":"B","task_id":"TB","step":"verdict","verdict":"blocked_budget","cost_usd":5.0}`,
  `{"ts":"2026-01-03T00:00:00.000Z","run_id":"C","task_id":"TC","step":"run.start","type":"diagnose"}`,
  `{"ts":"2026-01-03T00:01:00.000Z","run_id":"C","task_id":"TC","step":"verdict","verdict":"merged","cost_usd":0.3}`,
].join("\n");

test("parseLedger skips torn lines and keeps the valid ones", () => {
  const recs = parseLedger(LEDGER);
  assert.equal(recs.filter((r) => r.step === "run.start").length, 3);
});

test("gatherRuns reduces per-run: type, verdict, cost, summed turns, prUrl", () => {
  const runs = gatherRuns(parseLedger(LEDGER));
  const a = runs.find((r) => r.runId === "A")!;
  assert.equal(a.type, "implement");
  assert.equal(a.verdict, "merged");
  assert.equal(a.costUsd, 2.0); // the verdict line's total, not the per-step costs
  assert.equal(a.numTurns, 12); // recon 2 + implement 10
  assert.equal(a.prUrl, "https://github.com/o/r/pull/1");
  const b = runs.find((r) => r.runId === "B")!;
  assert.equal(b.verdict, "blocked_budget");
  assert.equal(b.numTurns, 32);
});

test("aggregateByType is the calibration data mounts.yaml needs (avg cost + turns by type)", () => {
  const agg = aggregateByType(gatherRuns(parseLedger(LEDGER)));
  const impl = agg.find((t) => t.type === "implement")!;
  assert.equal(impl.runs, 2);
  assert.equal(impl.totalCostUsd, 7.0);
  assert.equal(impl.avgCostUsd, 3.5);
  assert.equal(impl.avgTurns, 22); // (12 + 32) / 2
  assert.equal(impl.merged, 1);
});

test("verdictDistribution counts each terminal verdict", () => {
  const dist = verdictDistribution(gatherRuns(parseLedger(LEDGER)));
  assert.deepEqual(dist, { blocked_budget: 1, merged: 2 });
});

test("mergedSince returns merged runs strictly after the marker ts, keyed by task", () => {
  const runs = gatherRuns(parseLedger(LEDGER));
  assert.deepEqual(mergedSince(runs, undefined).map((r) => r.taskId), ["TA", "TC"]);
  // A marker after run A excludes it; C (2026-01-03) still counts.
  assert.deepEqual(mergedSince(runs, "2026-01-02T00:00:00.000Z").map((r) => r.taskId), ["TC"]);
});

test("Tier Invariant (G-17): the Architect must OUTRANK the worker (fail-closed)", () => {
  assert.equal(tierOf("opus"), 3);
  assert.equal(tierOf("sonnet"), 2);
  assert.doesNotThrow(() => assertArchitectAboveWorker("opus", "sonnet"));
  assert.doesNotThrow(() => assertArchitectAboveWorker("claude-opus-4-8", "claude-sonnet-5"));
  assert.throws(() => assertArchitectAboveWorker("sonnet", "sonnet"), /Tier Invariant/);
  assert.throws(() => assertArchitectAboveWorker("sonnet", "opus"), /Tier Invariant/);
});

test("calibrationTable renders a markdown table with a row per type", () => {
  const table = calibrationTable(aggregateByType(gatherRuns(parseLedger(LEDGER))));
  assert.match(table, /task_type \| runs \| merged \| avg \$/);
  assert.match(table, /\| implement \| 2 \| 1 \|/);
  assert.match(table, /\| diagnose \| 1 \| 1 \|/);
});

test("codeFilesInDiff: a plan-only diff touches no src/test; a code diff is caught (fail-closed guard)", () => {
  const planOnly = [
    "diff --git a/MASTER-PLAN.md b/MASTER-PLAN.md",
    "+++ b/MASTER-PLAN.md",
    "+a plan edit",
    "+++ b/LEARNINGS.md",
    "+a learning",
  ].join("\n");
  assert.deepEqual(codeFilesInDiff(planOnly), []);
  const withCode = planOnly + "\n+++ b/src/run-task.ts\n+code\n+++ b/test/x.test.ts\n+t";
  assert.deepEqual(codeFilesInDiff(withCode), ["src/run-task.ts", "test/x.test.ts"]);
});

test("buildGather scopes runs by the marker and computes the learnings delta", () => {
  const g = buildGather({
    ledgerNdjson: LEDGER,
    learningsMd: "# L\n- a\n- b\n- c\n",
    sinceTs: "2026-01-02T00:00:00.000Z",
    learningsAtMarker: 1,
  });
  // Only runs started after the marker: B (2026-01-02 is NOT strictly after) and C.
  assert.equal(g.totalRuns, 1); // only C started strictly after 2026-01-02T00:00:00
  assert.equal(g.learningsNow, 3);
  assert.equal(g.learningsNow - g.learningsAtMarker, 2);
});
