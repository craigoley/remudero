/**
 * test/the-light-pass-admits-the-cheap-review-modes.test.ts — W1-T9558.
 *
 * THE DEFECT. `runSweep` queues three review dispositions in one bounded pool (W1-T3798):
 * `post-review`, `review-reused` and `discriminate-only`. The light pass selected, counted and acted
 * on `post-review` only, so the two cheap modes stood down as "deferred to full sweep (light pass)".
 * The full pass reaches its review pool only after its per-PR walk. Since 2026-10-11 that walk ends
 * after the pass's wall-clock bound has closed review admissions, so the full pass admitted 1-3
 * reviews a day (42 on 2026-10-05). The last cheap-mode admission was on 2026-10-10. On 2026-10-13
 * and 2026-10-14, six of seven `discriminate-only` heads were never reviewed. They waited 25-113
 * minutes until a push replaced them (#11402, #11629, #11710 three times, #11783).
 *
 * THE FIX. The light pass treats all three as one review lane under the same width and the same
 * outcome dedup. `runSweep` already carries each head's mode to `postReview`.
 *
 * The harness wires `actionable` to production's own `lightPassActionable`, with the arguments
 * `buildSweepLightHook` passes, so the composition is proven rather than paraphrased.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { readLedgerLines } from "#src/lib/status.js";
import {
  DEFAULT_SWEEP_POLICY,
  isReviewLaneDisposition,
  runSweepLightPass,
  type OpenPrView,
  type ReviewReuseInputs,
  type SweepDeps,
} from "#test/helpers/sweep-test.js";
import { writeLedger } from "#test/helpers/ledger-fixture.js";
import { lightPassActionable } from "#src/run-task.js";

const NOW = Date.parse("2026-10-14T21:00:00Z");
const RECENT = "2026-10-14T20:50:00Z";
const JUDGED_HEAD = "d00dfeedd00dfeedd00dfeedd00dfeedd00dfeed";
const OWN_DIFF_DIGEST = "sha256:own-diff-abc123";
const MERGE_BASE = "0ldbase00ldbase00ldbase00ldbase00ldbase0";
const NEW_MERGE_BASE = "newbase1newbase1newbase1newbase1newbase1";
const CONTRACT_DIGEST = "contract-v1:unchanged-contract";
const DEFERRED = "deferred to full sweep (light pass)";

/** A green head whose review a push orphaned, carrying both sides of the reuse comparison. */
function orphanedPr(prNumber: number, mergeBase: string, over: Partial<OpenPrView> = {}): OpenPrView {
  const inputs: ReviewReuseInputs = {
    reviewedOwnDiffDigest: OWN_DIFF_DIGEST,
    currentOwnDiffDigest: OWN_DIFF_DIGEST,
    reviewedMergeBaseSha: MERGE_BASE,
    currentMergeBaseSha: mergeBase,
    reviewedHeadSha: JUDGED_HEAD,
    reviewedContractDigest: CONTRACT_DIGEST,
    currentContractDigest: CONTRACT_DIGEST,
  };
  return {
    prNumber,
    prUrl: `https://github.com/craigoley/remudero/pull/${prNumber}`,
    taskId: `W1-T${prNumber}`,
    reviewState: "none",
    checksState: "green",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: RECENT,
    createdAt: "2026-10-14T18:00:00Z",
    headSha: `cafe${prNumber}`.padEnd(40, "0"),
    autoMergeArmed: false,
    isPlanFiling: false,
    reviewOrphanedByPush: true,
    priorReviewAttemptsForInput: 0,
    ...inputs,
    ...over,
  };
}

/** Green with no review yet and no orphaned verdict: disposition `post-review`. */
function freshPr(prNumber: number, createdAt: string): OpenPrView {
  return {
    prNumber,
    prUrl: `https://github.com/craigoley/remudero/pull/${prNumber}`,
    taskId: `W1-T${prNumber}`,
    reviewState: "none",
    checksState: "green",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: RECENT,
    createdAt,
    headSha: `beef${prNumber}`.padEnd(40, "0"),
    autoMergeArmed: false,
    isPlanFiling: false,
  };
}

function harness(over: Partial<SweepDeps> = {}): { deps: SweepDeps; modes: Array<{ pr: number; mode: string }> } {
  const modes: Array<{ pr: number; mode: string }> = [];
  const deps: SweepDeps = {
    log: () => {},
    arm: () => "armed",
    close: () => {},
    dispatchFix: () => {},
    escalate: () => {},
    postReview: async (p, mode) => {
      modes.push({ pr: p.prNumber, mode: mode?.kind ?? "full-review" });
    },
    ledgerPath: writeLedger().path,
    runId: "SWEEP-T9558-1",
    now: () => NOW,
    // `buildSweepLightHook`'s ordinary pass: no fix rung, no requeue-only batch, arm and own-red allowed.
    actionable: (d) => lightPassActionable(d, false, false, true, true),
    ...over,
  };
  return { deps, modes };
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

function rows(deps: SweepDeps, step: string, prNumber: number): Array<Record<string, unknown>> {
  return readLedgerLines(deps.ledgerPath).filter((l) => l.step === step && l.pr_number === prNumber);
}

test("W1-T9558: the review lane is all three review dispositions, and the light pass acts on each", () => {
  for (const d of ["post-review", "review-reused", "discriminate-only"] as const) {
    assert.equal(isReviewLaneDisposition(d), true, d);
    assert.equal(lightPassActionable(d, false), true, `${d} on every light pass shape`);
    assert.equal(lightPassActionable(d, false, false, false), true, `${d} on a review-only pass`);
  }
  for (const d of ["mergeable", "blocked-fixable", "stale", "wait"] as const) {
    assert.equal(isReviewLaneDisposition(d), false, d);
  }
});

test("W1-T9558: a discriminate-only head is admitted by the light pass and reviewed in its cheap mode", async () => {
  const h = harness();
  const pr = orphanedPr(9701, NEW_MERGE_BASE);
  await runSweepLightPass([pr], h.deps, DEFAULT_SWEEP_POLICY);
  await settle();
  assert.deepEqual(h.modes, [{ pr: 9701, mode: "discriminate-only" }]);
  const admitted = rows(h.deps, "sweep.review_admitted", 9701);
  assert.equal(admitted.length, 1);
  assert.equal(admitted[0]!.review_mode, "discriminate-only");
  assert.equal(admitted[0]!.surface, "light");
  for (const row of rows(h.deps, "sweep.disposed", 9701)) {
    assert.notEqual(row.stand_down_reason, DEFERRED, "never left for the full pass");
  }
});

test("W1-T9558: a review-reused head is admitted by the light pass and posts the reused verdict", async () => {
  const h = harness();
  await runSweepLightPass([orphanedPr(9702, MERGE_BASE)], h.deps, DEFAULT_SWEEP_POLICY);
  await settle();
  assert.deepEqual(h.modes, [{ pr: 9702, mode: "reuse" }]);
  assert.equal(rows(h.deps, "sweep.review_admitted", 9702)[0]?.review_mode, "reuse");
});

test("W1-T9558: a cheap-mode head shares the light pass's review width with a full review", async () => {
  const h = harness();
  const policy = { ...DEFAULT_SWEEP_POLICY, reviewLanes: 1, reviewLaneMin: 1, reviewLaneMax: 1 };
  // The full review is the older head, so it wins the one lane; the cheap head loses an admission,
  // which is a bounded wait re-derived next pass, not a deferral to the full sweep.
  const older = freshPr(9703, "2026-10-14T10:00:00Z");
  const cheap = orphanedPr(9704, NEW_MERGE_BASE, { createdAt: "2026-10-14T19:00:00Z" });
  await runSweepLightPass([older, cheap], h.deps, policy);
  await settle();
  assert.deepEqual(h.modes[0], { pr: 9703, mode: "full-review" }, "the older head takes the one lane first");
  const lost = rows(h.deps, "sweep.disposed", 9704)[0];
  assert.equal(lost?.acted, false);
  assert.match(String(lost?.stand_down_reason), /^not admitted this pass: semantic post-review admission bound 1; admitted #9703 ahead$/);
});
