import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  DEFAULT_SWEEP_POLICY,
  checksStateFromRollup,
  deriveDisposition,
  isBlockedCi,
  type OpenPrView,
  type RollupCheckEntry,
} from "../src/lib/sweep.js";
import type { CriterionVerdict } from "../src/lib/review.js";

/**
 * PR #1441, 2026-08-07: dispositioned `blocked-fixable` with reason `required checks red —
 * ci-log fix, strike 1/2` while ALL 21 check runs were green — the sole red on the head was the
 * `remudero-review` COMMIT STATUS (a body-claim contradiction). The ci-log fix rung had no
 * failing job to read and burned a strike for nothing.
 *
 * ROOT CAUSE: `checksStateFromRollup` read `statusCheckRollup` — which mixes CHECK RUNS with
 * COMMIT STATUSES — and folded `remudero-review` (a commit status carrying the REVIEW verdict,
 * already tracked separately as `reviewState`) into `checksState` right alongside genuine CI
 * check runs. `isBlockedCi` is exactly `checksState === "red"`, so a review failure alone made it
 * true, claiming DISPOSITION_RULES' checks-red row (ordered first) before the review-shaped row
 * — `reviewState === "failure" && unmetCriteria.length > 0` — ever got a chance to match. That
 * row's own comment ("Reached only when checks are NOT red") named the case it could never reach.
 *
 * THE FIX (W1-T394): `checksStateFromRollup` now excludes the `remudero-review` context from the
 * gate unconditionally, so a red review can never manufacture `checksState: "red"`. These tests
 * drive the REAL rollup -> checksState -> disposition path (never a hand-set `checksState`) so a
 * regression in either function fails here.
 */

const NOW = Date.parse("2026-08-07T18:00:00Z");
const RECENT = "2026-08-07T17:55:00Z";
const REQUIRED = ["ci-gate", "commitlint", "remudero-review"];

function rollupCheck(over: Partial<RollupCheckEntry> = {}): RollupCheckEntry {
  return { name: "check", conclusion: "SUCCESS", ...over };
}

function criterion(over: Partial<CriterionVerdict> = {}): CriterionVerdict {
  return {
    claim: "PR body substantiates the acceptance criteria",
    proof: "unit test: it works",
    met: false,
    reason: "body-claim contradiction",
    proof_exec: "executed_fail",
    ...over,
  };
}

function basePr(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 1441,
    prUrl: "https://github.com/craigoley/remudero/pull/1441",
    taskId: "W1-TX",
    reviewState: "pending",
    checksState: "pending",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: RECENT,
    headSha: "cafef00d",
    autoMergeArmed: false,
    ...over,
  };
}

test("W1-T394 acceptance 1 (regression lock, the #1441 fixture) — all check runs green, remudero-review COMMIT STATUS red: checksState stays green, isBlockedCi is false, and the disposition reason never names ci-log", () => {
  // The #1441 shape: every real check run green, the sole red is the review commit status.
  const rollup: RollupCheckEntry[] = [
    rollupCheck({ name: "ci-gate", conclusion: "SUCCESS" }),
    rollupCheck({ name: "commitlint", conclusion: "SUCCESS" }),
    rollupCheck({ context: "remudero-review", state: "FAILURE" }),
  ];
  const checksState = checksStateFromRollup(rollup, REQUIRED);
  assert.equal(checksState, "green", "a red remudero-review commit status must never veto checksState");

  const pr = basePr({
    reviewState: "failure",
    checksState,
    unmetCriteria: [criterion({ claim: "48 files changed" })],
  });
  assert.equal(isBlockedCi(pr), false, "isBlockedCi must not go true off a review failure alone");

  const r = deriveDisposition(pr, DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(r.disposition, "blocked-fixable");
  assert.match(r.reason, /1 unmet criteri/, "reaches the review-shaped row's own reason text");
  assert.doesNotMatch(r.reason, /ci-log fix/, "must never be routed to a rung with nothing to read");
  assert.doesNotMatch(r.reason, /required checks red/);
});

test("W1-T394 acceptance 2 — the review-shaped row IS reachable for a review failure (not just theoretically ordered second): unmet criteria alone reaches it, no checks-red row intercepts", () => {
  const rollup: RollupCheckEntry[] = [
    rollupCheck({ name: "ci-gate", conclusion: "SUCCESS" }),
    rollupCheck({ name: "commitlint", conclusion: "SUCCESS" }),
    rollupCheck({ context: "remudero-review", state: "FAILURE" }),
  ];
  const checksState = checksStateFromRollup(rollup, REQUIRED);
  const pr = basePr({
    reviewState: "failure",
    checksState,
    priorStrikes: 1,
    unmetCriteria: [criterion({ claim: "one" }), criterion({ claim: "two" })],
  });
  const r = deriveDisposition(pr, DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(r.disposition, "blocked-fixable");
  assert.equal(r.reason, `2 unmet criteria — strike ${pr.priorStrikes + 1}/${DEFAULT_SWEEP_POLICY.strikeCap}`);
});

test("W1-T394 acceptance 3 (mirror fixture) — a genuinely red required CHECK RUN still routes to the ci-log rung, with remudero-review green/success beside it", () => {
  const rollup: RollupCheckEntry[] = [
    rollupCheck({ name: "ci-gate", conclusion: "FAILURE" }),
    rollupCheck({ name: "commitlint", conclusion: "SUCCESS" }),
    rollupCheck({ context: "remudero-review", state: "SUCCESS" }),
  ];
  const checksState = checksStateFromRollup(rollup, REQUIRED);
  assert.equal(checksState, "red", "a real check-run failure must still veto checksState");

  const pr = basePr({ reviewState: "success", checksState, priorStrikes: 0, unmetCriteria: [] });
  assert.equal(isBlockedCi(pr), true, "splitting the signal must not blind isBlockedCi to a real check failure");

  const r = deriveDisposition(pr, DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(r.disposition, "blocked-fixable");
  assert.equal(r.reason, `required checks red — ci-log fix, strike ${pr.priorStrikes + 1}/${DEFAULT_SWEEP_POLICY.strikeCap}`);
});

test("W1-T394 acceptance 3 (both-red case) — a red required check run WITH a red remudero-review still routes to ci-log (checks-red keeps precedence), never re-litigated as reviewer-unmet", () => {
  const rollup: RollupCheckEntry[] = [
    rollupCheck({ name: "ci-gate", conclusion: "FAILURE" }),
    rollupCheck({ name: "commitlint", conclusion: "SUCCESS" }),
    rollupCheck({ context: "remudero-review", state: "FAILURE" }),
  ];
  const checksState = checksStateFromRollup(rollup, REQUIRED);
  assert.equal(checksState, "red");

  const pr = basePr({
    reviewState: "failure",
    checksState,
    priorStrikes: 0,
    unmetCriteria: [criterion({ claim: "some criterion" })],
  });
  const r = deriveDisposition(pr, DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(r.disposition, "blocked-fixable");
  assert.match(r.reason, /required checks red — ci-log fix/, "checks-red wins — GitHub will not merge past it regardless of the review");
  assert.doesNotMatch(r.reason, /unmet criteri/);
});

test("W1-T394 — checksStateFromRollup excludes remudero-review even in the unreadable-protection (requiredContexts undefined) fallback", () => {
  const rollup: RollupCheckEntry[] = [
    rollupCheck({ name: "ci-gate", conclusion: "SUCCESS" }),
    rollupCheck({ context: "remudero-review", state: "FAILURE" }),
  ];
  assert.equal(
    checksStateFromRollup(rollup, undefined),
    "green",
    "even the fail-closed fallback must not fold the review commit status into checksState",
  );
});
