import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { systemClock } from "#src/lib/clock.js";
import { attemptArm, logArmAttribution, type ArmDeps } from "#src/lib/arm-auto-merge.js";

const PR = "https://github.com/craigoley/remudero/pull/9138";
const HEAD = "head9520";
const NOW = Date.parse("2026-10-06T12:00:00Z");

function deps(ledger: Array<Record<string, unknown>>, calls: string[]): ArmDeps {
  return {
    headSha: () => HEAD, ledgerLines: () => ledger, readPlanTouch: () => "touched",
    readMergeFacts: () => ({ mergeable: "UNKNOWN", mergeableState: "unknown", behindBy: 0 }),
    sleepSync: () => {}, armAuto: () => { calls.push("arm"); }, disableAuto: () => {},
    mergeDirect: () => { calls.push("merge"); }, isMerged: () => false,
    updateBranch: () => { calls.push("update"); return { ok: true }; }, say: () => {},
  };
}

describe("test/scout-automerge-plan-pr-mergeability-unknown-escalated.test.ts", () => {
  test("W1-T9520: automerge.plan_pr_mergeability_unknown_escalated no longer recurs", (t) => {
    t.mock.method(systemClock, "now", () => NOW);
    const held = { ts: new Date(NOW - 600_000).toISOString(), step: "automerge.plan_pr_held", pr_url: PR,
      prior_head_sha: HEAD, remedy: "mergeability-unknown" };
    const calls: string[] = [];
    const result = attemptArm(PR, deps([held], calls), HEAD);
    assert.equal(result.outcome, "direct-merge-preflight-refused");
    assert.deepEqual(calls, [], "an escalated hold never arms, merges or refreshes");
    const rows: Array<Record<string, unknown>> = [];
    logArmAttribution((step, extra) => { rows.push({ step, ...extra }); },
      result.outcome, PR, "W1-T9520", "review", {}, undefined, result.directMergePreflight);
    const escalated = rows.filter((r) => r.step === "automerge.plan_pr_mergeability_unknown_escalated");
    assert.equal(escalated.length, 1, "exactly one escalation row per attempt");
    assert.equal(escalated[0]?.prior_head_sha, HEAD);
  });
});
