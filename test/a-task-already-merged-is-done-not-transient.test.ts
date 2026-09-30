import assert from "node:assert/strict";
import { test } from "node:test";

import { runDaemon } from "../src/lib/daemon.js";
import { loadPlanFromYaml } from "../src/lib/plan.js";
import type { RunResult } from "../src/lib/run-result.js";

const plan = () => loadPlanFromYaml(`
- id: A
  title: already merged elsewhere
  repo: remudero
  type: implement
  depends_on: []
  status: queued
- id: D
  title: unrelated task
  repo: remudero
  type: implement
  depends_on: []
  status: queued
`, "fixture");

test("W1-T4661: an already-merged verdict is terminal, not a transient retry", async () => {
  const attempts: string[] = [];
  const events: Array<{ step: string; fields: Record<string, unknown> }> = [];
  let refreshes = 0;
  const prUrl = "https://github.com/o/r/pull/42";
  const summary = await runDaemon(plan(), {
    // Deliberately stale, even after refresh: this is the observed re-dispatch race.
    refreshMerged: () => { refreshes++; return () => false; },
    runOne: async (taskId): Promise<RunResult> => {
      attempts.push(taskId);
      return taskId === "A"
        ? { taskId, runId: "refusal-run", merged: false, costUsd: 0, verdict: "task_already_merged" }
        : { taskId, runId: "other-run", merged: true, costUsd: 0.2, verdict: "merged" };
    },
    readLedgerLines: () => [
      "{", // a torn live-ledger line must not turn a confirmed merge into a daemon crash
      JSON.stringify({
        ts: "2026-09-28T01:49:00Z", run_id: "refusal-run", task_id: "A",
        step: "dispatch.refused_already_merged", pr_url: prUrl,
      }),
    ],
    sleep: async () => {},
    log: (step, fields = {}) => events.push({ step, fields }),
  }, { max: 2, pollIntervalMs: 1 });

  assert.deepEqual(attempts, ["A", "D"], "stale credit cannot buy a second dispatch of A");
  assert.deepEqual(summary.merged, ["D"], "do not claim A merged from an unreadable daemon projection");
  assert.ok(refreshes >= 2, "the worker refusal forces a same-tick merged-view refresh");
  assert.equal(events.some((event) => event.step === "daemon.block.transient_retry"), false);
  assert.equal(events.some((event) => event.step === "daemon.merge_credit_evidence_invalid"), true);
  assert.deepEqual(events.find((event) => event.step === "daemon.merge_credit_correction")?.fields,
    { task: "A", run_id: "refusal-run", pr_url: prUrl, merge_observation_lag_ms: null, credit_visible: false });
});

test("a refreshed merge credit makes the refused task done and unlocks its dependent", async () => {
  const dependentPlan = loadPlanFromYaml(`
- id: A
  title: already merged elsewhere
  repo: remudero
  type: implement
  depends_on: []
  status: queued
- id: B
  title: depends on A
  repo: remudero
  type: implement
  depends_on: [A]
  status: queued
`, "fixture");
  const attempts: string[] = [];
  let refreshes = 0;
  const events: Array<{ step: string; fields: Record<string, unknown> }> = [];
  const prUrl = "https://github.com/o/r/pull/42";
  const summary = await runDaemon(dependentPlan, {
    refreshMerged: () => {
      refreshes++;
      return (id) => id === "A" && refreshes >= 2;
    },
    runOne: async (taskId): Promise<RunResult> => {
      attempts.push(taskId);
      return taskId === "A"
        ? { taskId, runId: "refusal-run", merged: false, costUsd: 0, verdict: "task_already_merged" }
        : { taskId, runId: "dependent-run", merged: true, costUsd: 0.2, verdict: "merged" };
    },
    readLedgerLines: () => [
      JSON.stringify({ ts: "2026-09-28T01:00:00Z", run_id: "original-run", task_id: "A", step: "pr.opened", pr_url: prUrl }),
      JSON.stringify({ ts: "2026-09-28T01:32:00Z", run_id: "original-run", task_id: "A", step: "pr.merged" }),
      JSON.stringify({ ts: "2026-09-28T01:49:00Z", run_id: "refusal-run", task_id: "A", step: "dispatch.refused_already_merged", pr_url: prUrl }),
    ],
    sleep: async () => {},
    log: (step, fields = {}) => events.push({ step, fields }),
  }, { max: 2, pollIntervalMs: 1 });
  assert.deepEqual(attempts, ["A", "B"]);
  assert.deepEqual(summary.merged, ["A", "B"]);
  assert.deepEqual(events.find((event) => event.step === "daemon.merge_credit_correction")?.fields,
    { task: "A", run_id: "refusal-run", pr_url: prUrl, merge_observation_lag_ms: 17 * 60_000, credit_visible: true });
});
