import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_SWEEP_POLICY, runSweep, type OpenPrView, type SweepDeps,
} from "#src/lib/sweep.js";

const NOW = Date.parse("2026-10-10T12:00:00Z");
const PR_URL = "https://github.com/acme/remudero/pull/7243";
const PROOF = "unit test: a repair discriminates";

test("W1-T10776: check:test:test/a-capped-repair-waits-for-an-available-progress-judge.test.ts is prevented, not retried", async () => {
  const rows: Record<string, unknown>[] = [{
    task_id: "W1-T7243", step: "review.posted", pr_url: PR_URL, head_sha: "capped-head",
    state: "success", capped: true, plan_only: false,
    decision_verdict: { state: "success", capped: true, planOnly: false, criteria: [{
      claim: "a repair discriminates", proof: PROOF, met: true,
      reason: "keyword floor", proof_exec: "not_executable",
    }] },
  }];
  const pr: OpenPrView = {
    prNumber: 7243, prUrl: PR_URL, taskId: "W1-T7243", headSha: "capped-head",
    headRefName: "run-W1-T7243-123", checksState: "green", reviewState: "success",
    unmetCriteria: [], priorStrikes: DEFAULT_SWEEP_POLICY.strikeCap, autoMergeArmed: false,
    lastActivityAt: new Date(NOW).toISOString(), ciFailures: [],
  };
  const effects: string[] = [];
  let recovered = false;
  const deps: SweepDeps = {
    ledgerPath: "/unused/w1-t10776-ledger", runId: "w1-t10776", now: () => NOW,
    readLedger: () => rows, appendLine: (_path, row) => { rows.push(row); },
    fixProgressJudge: async () => {
      if (recovered) return { verdict: "continue", reason: "a new reproduction supports repair" };
      return undefined;
    },
    dispatchFix: () => { effects.push("body"); },
    dispatchPlanOnlyRepair: () => { effects.push("plan"); return true; },
    arm: () => { effects.push("arm"); return "armed"; },
    escalate: () => { effects.push("escalate"); }, close: () => { effects.push("close"); },
  };
  const held = await runSweep([pr], deps);
  assert.equal(held.actions[0]!.disposition, "wait");
  assert.equal(held.actions[0]!.acted, false);
  assert.deepEqual(effects, [], "an unavailable judge spends no fix round and no escalation");
  recovered = true;
  const resumed = await runSweep([pr], deps);
  assert.equal(resumed.actions[0]!.disposition, "blocked-fixable");
  assert.deepEqual(effects, ["body"]);
});
