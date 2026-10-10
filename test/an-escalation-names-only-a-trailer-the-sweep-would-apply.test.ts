import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  DEFAULT_SWEEP_POLICY,
  deriveDisposition,
  missingTaskTrailerRepairDecision,
  type OpenPrView,
} from "../src/lib/sweep.js";

/**
 * #10597 — an operator plan filing on `run-unfiled-<epoch>` whose body carried a judged
 * `## Acceptance` block (every criterion executed_pass) failed review on a reservation collision.
 * The escalation said "derived repair: add `Remudero-Task: unfiled` to the PR body", diagnosed
 * against an EMPTY body, while the action's `missingTaskTrailerRepairDecision` correctly ignored
 * that body. The reason advertised a repair nothing applies and that would not change the verdict.
 */

const ACCEPTANCE_BODY =
  "## Plan: file W1-T7620\n\n## Acceptance\n- claim: W1-T7620 is filed\n" +
  "  proof: grep: id: W1-T7620 in plan/tasks.d/W1-T7620-x.yaml\n";

function filingPr(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 10597, prUrl: "https://github.com/craigoley/remudero/pull/10597", reviewState: "failure",
    checksState: "green", unmetCriteria: [], priorStrikes: 0, strikeHistory: [], lastActivityAt: new Date().toISOString(),
    headSha: "ec7f20e", autoMergeArmed: false, isDependabot: false, criteriaRecoverable: false,
    headRefName: "run-unfiled-1791614769905", body: ACCEPTANCE_BODY, introducedTaskIds: ["W1-T7620"],
    changedFiles: ["plan/tasks.d/W1-T7620-x.yaml"],
    ...over,
  } as unknown as OpenPrView;
}

test("an escalation on a body that carries a judged Acceptance block names no trailer repair", () => {
  const pr = filingPr();
  const d = deriveDisposition(pr, DEFAULT_SWEEP_POLICY, Date.now());
  assert.equal(d.disposition, "blocked-ambiguous");
  assert.match(d.reason, /criteria unrecoverable/, "the unrecoverable cause is still named");
  assert.doesNotMatch(d.reason, /derived repair/, "a trailer is no cure for a body the review already judged");
  assert.match(d.reason, /no body repair derived: the review judged the body's own Acceptance block/);
  // The reason and the action agree: the sweep's own repair decision leaves this body alone.
  assert.equal(missingTaskTrailerRepairDecision(pr).action, "ignore");
});

test("an escalation on a body with neither trailer nor Acceptance names the trailer the sweep applies", () => {
  const pr = filingPr({ body: "## Summary\n\nNo gate input at all.\n", introducedTaskIds: [] });
  const d = deriveDisposition(pr, DEFAULT_SWEEP_POLICY, Date.now());
  assert.match(d.reason, /derived repair: add `Remudero-Task: unfiled` to the PR body/);
  const decision = missingTaskTrailerRepairDecision(pr);
  assert.equal(decision.action, "repair");
  assert.equal(decision.action === "repair" ? decision.repair.trailer : undefined, "Remudero-Task: unfiled");
});
