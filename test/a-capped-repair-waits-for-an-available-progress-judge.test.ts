import assert from "node:assert/strict";
import { test } from "node:test";
import type { FixProgressInput } from "../src/lib/fix-progress-judge.js";
import {
  DEFAULT_SWEEP_POLICY, PLAN_REPAIR_DISPATCH_STEP, runSweep,
  type OpenPrView, type SweepDeps,
} from "../src/lib/sweep.js";

const NOW = Date.parse("2026-10-10T12:00:00Z");
const PR_URL = "https://github.com/acme/remudero/pull/7243";
const PROOF = "unit test: a repair discriminates";

for (const site of ["capped-body", "plan-repair"] as const) {
  for (const failure of ["absent", "throws"] as const) {
    test(`${site} waits when the progress judge ${failure} and retries its remedy after recovery`, async () => {
      const rows: Record<string, unknown>[] = [{
        task_id: "W1-T7243", step: "review.posted", pr_url: PR_URL, head_sha: "capped-head",
        state: "success", capped: true, plan_only: false,
        decision_verdict: { state: "success", capped: true, planOnly: false, criteria: [{
          claim: "a repair discriminates", proof: PROOF, met: true,
          reason: "keyword floor", proof_exec: "not_executable",
        }] },
      }];
      if (site === "plan-repair") {
        for (let i = 0; i < 2; i++) rows.push({ task_id: "W1-T7243",
          step: PLAN_REPAIR_DISPATCH_STEP, pr_number: 7243, outcome: "dispatched" });
      }
      const pr: OpenPrView = {
        prNumber: 7243, prUrl: PR_URL, taskId: "W1-T7243", headSha: "capped-head",
        headRefName: "run-W1-T7243-123", checksState: "green", reviewState: "success",
        unmetCriteria: [], priorStrikes: DEFAULT_SWEEP_POLICY.strikeCap, autoMergeArmed: false,
        lastActivityAt: new Date(NOW).toISOString(), ciFailures: [],
      };
      const inputs: FixProgressInput[] = [];
      const effects: string[] = [];
      let recovered = false;
      const deps: SweepDeps = {
        ledgerPath: "/unused/capped-judge-ledger", runId: "capped-judge", now: () => NOW,
        readLedger: () => rows, appendLine: (_path, row) => { rows.push(row); },
        fixProgressJudge: async input => {
          inputs.push(input);
          if (recovered) return { verdict: "continue", reason: "a new reproduction supports repair" };
          if (failure === "throws") throw new Error("progress provider offline");
          return undefined;
        },
        dispatchFix: () => { effects.push("body"); },
        dispatchPlanOnlyRepair: () => { effects.push("plan"); return true; },
        arm: () => { effects.push("arm"); return "armed"; },
        escalate: () => { effects.push("escalate"); }, close: () => { effects.push("close"); },
      };
      const expectedReason = failure === "absent"
        ? "absent or unparseable fix progress verdict; re-ask next pass"
        : "fix progress judgment failed: Error: progress provider offline";

      const held = await runSweep([pr], deps);
      assert.equal(inputs.length, 1);
      assert.equal(inputs[0]!.parkedReason, `${site}: 2 prior repairs`);
      assert.equal(inputs[0]!.formerCeiling, 2);
      assert.equal(inputs[0]!.strikesSpent, 2);
      assert.deepEqual(inputs[0]!.currentRed, [`proof:${PROOF}`]);
      assert.equal(held.byDisposition.wait, 1);
      assert.equal(held.actions[0]!.disposition, "wait");
      assert.equal(held.actions[0]!.reason, expectedReason);
      assert.equal(held.actions[0]!.acted, false);
      assert.deepEqual(effects, []);
      const judgment = rows.find(row => row.step === "fix.progress_judged" && row.site === site);
      assert.equal(judgment?.verdict, "unavailable");
      assert.equal(judgment?.reason, expectedReason);
      const receipt = rows.findLast(row => row.step === "sweep.disposed");
      assert.equal(receipt?.disposition, "wait");
      assert.equal(receipt?.reason, expectedReason);

      recovered = true;
      const resumed = await runSweep([pr], deps);
      assert.equal(inputs.length, 2, "an unavailable judgment must be asked again at the same head");
      assert.equal(resumed.actions[0]!.disposition, "blocked-fixable");
      assert.equal(resumed.actions[0]!.acted, true);
      assert.deepEqual(effects, [site === "capped-body" ? "body" : "plan"]);
      assert.equal(rows.findLast(row => row.step === "fix.progress_judged" && row.site === site)?.verdict,
        "continue");
    });
  }
}
