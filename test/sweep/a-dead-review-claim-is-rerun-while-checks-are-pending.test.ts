/**
 * W1-T14035 — a review claim whose owner is proven dead is re-run while the head's checks are still pending.
 *
 * OBSERVED 2026-11-20 on #19791: a review run claimed the head's pending status, died about five minutes in, and never
 * posted a verdict. At 15:38:37Z the sweep disposed the head wait, "checks pending 42m (< 60m ceiling)", because the
 * alongside-CI post-review row needed no review status and the dead-owner re-run row needed green checks. No review ran
 * again until an operator took the claim over by hand. Every stamp below is aged against the clock each case injects.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_SWEEP_POLICY, deriveDisposition, type OpenPrView } from "#src/lib/sweep.js";

const NOW = Date.parse("2026-11-20T15:38:37.000Z");
const minutesAgo = (m: number): string => new Date(NOW - m * 60_000).toISOString();

/** #19791's shape at 15:38:37Z: checks pending 42m, the dead run's pending claim posted at 15:15:10Z. */
function deadClaimView(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 19791, prUrl: "https://github.com/o/r/pull/19791", taskId: "W1-T14035",
    headRefName: "run-W1-T14035-1795190000000", headSha: "d".repeat(40),
    mergeState: "blocked", mergeableState: "blocked", autoMergeArmed: false,
    checksState: "pending", checksPendingSince: minutesAgo(42), lastActivityAt: minutesAgo(42),
    createdAt: minutesAgo(60), priorStrikes: 0, unmetCriteria: [],
    reviewState: "pending", reviewPendingSince: minutesAgo(23), reviewPendingOwnerDead: true,
    priorReviewAttemptsForInput: 0,
    ...over,
  } as OpenPrView;
}

test("W1-T14035 criterion 1: a dead pending review claim is disposed post-review alongside CI, not wait", () => {
  const r = deriveDisposition(deadClaimView(), DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(r.disposition, "post-review");
  assert.equal(r.blocker, "awaiting-ci");
  assert.match(r.reason, /alongside CI/);
});

test("W1-T14035 criterion 2: the disposition reason names the dead owner", () => {
  const r = deriveDisposition(deadClaimView(), DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(r.reason, "checks pending 42m, remudero-review owner proven dead — re-running one exact-input " +
    "review alongside CI through the bounded post-review lane");
  const never = deriveDisposition(deadClaimView({ reviewState: "none", reviewPendingOwnerDead: undefined,
    reviewPendingSince: undefined }), DEFAULT_SWEEP_POLICY, NOW);
  assert.match(never.reason, /review never posted/, "a head with no review status keeps its own reason");
});

test("W1-T14035 criterion 3: an alive or merely old pending claim still waits while checks are pending", () => {
  const alive = deriveDisposition(deadClaimView({ reviewPendingOwnerDead: false }), DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(alive.disposition, "wait");
  assert.match(alive.reason, /waiting/);
  const unproven = deriveDisposition(deadClaimView({ reviewPendingOwnerDead: undefined }), DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(unproven.disposition, "wait");
  const old = deriveDisposition(deadClaimView({ reviewPendingOwnerDead: undefined, reviewPendingSince: minutesAgo(59) }),
    DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(old.disposition, "wait", "a stale pending without proof of death is not taken over while CI runs");
});

test("W1-T14035: the bounds of the alongside-CI row still hold for a dead claim", () => {
  const judged = deriveDisposition(deadClaimView({ priorReviewAttemptsForInput: 1 }), DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(judged.disposition, "wait", "an input already judged is not reviewed again alongside CI");
  const refused = deriveDisposition(deadClaimView({ reviewPostRefused: true }), DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(refused.disposition, "wait");
  const unreadable = deriveDisposition(deadClaimView({ requiredContextsUnreadable: true }), DEFAULT_SWEEP_POLICY, NOW);
  assert.notEqual(unreadable.disposition, "post-review");
  const justRegistered = deriveDisposition(deadClaimView({ checksPendingSince: new Date(NOW - 30_000).toISOString() }),
    DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(justRegistered.disposition, "wait");
  const green = deriveDisposition(deadClaimView({ checksState: "green" }), DEFAULT_SWEEP_POLICY, NOW);
  assert.match(green.reason, /checks green, remudero-review owner proven dead/, "green checks keep the green row");
});

test("W1-T14035 criterion 1: a dead pending claim at a looping input escalates through the reviewInputLoop backstop", () => {
  const loop = { admissions: 2, postsSinceLastAdmission: 1, posts: 1, lookedUpKey: "W1-T14035" };
  const looped = { reviewInputDigest: "e".repeat(64), reviewInputLoop: loop };
  const none = deriveDisposition(deadClaimView({ ...looped, reviewState: "none", reviewPendingOwnerDead: undefined,
    reviewPendingSince: undefined }), DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(none.disposition, "blocked-ambiguous", "the no-status path escalates at the backstop");
  const dead = deriveDisposition(deadClaimView(looped), DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(dead.disposition, "blocked-ambiguous", "a dead claim gets no third admission of the same input");
  assert.match(dead.reason, /^post-review-loop: #19791 has been admitted for review 2 time\(s\)/);
  const below = deriveDisposition(deadClaimView({ ...looped, reviewInputLoop: { ...loop, admissions: 1 } }),
    DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(below.disposition, "post-review", "one admission is below the backstop and still re-runs");
});

test("W1-T14035 criterion 2: a derived release cause is not producer proof of death and does not re-run alongside CI", () => {
  for (const gone of ["promise-harvest-incomplete", "refused-after-pending", "inconclusive-load"] as const) {
    const r = deriveDisposition(deadClaimView({ reviewPendingOwnerGone: gone }), DEFAULT_SWEEP_POLICY, NOW);
    assert.equal(r.disposition, "wait", `${gone} waits while checks are pending`);
    assert.doesNotMatch(r.reason, /owner proven dead/);
  }
  const pid = deriveDisposition(deadClaimView({ reviewPendingOwnerGone: "owner-pid-dead" }), DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(pid.disposition, "post-review");
  assert.match(pid.reason, /remudero-review owner proven dead/);
});

test("W1-T14035 criterion 3: a stale-only pending claim past the ceiling still waits while checks are pending", () => {
  const stale = deriveDisposition(deadClaimView({ reviewPendingOwnerDead: undefined, reviewPendingSince: minutesAgo(61) }),
    DEFAULT_SWEEP_POLICY, NOW);
  assert.ok(61 >= DEFAULT_SWEEP_POLICY.pendingCeilingMinutes, "the fixture is past the stale ceiling");
  assert.equal(stale.disposition, "wait", "a stale pending without proof of death is not taken over while CI runs");
  const undated = deriveDisposition(deadClaimView({ reviewPendingOwnerDead: undefined, reviewPendingSince: undefined,
    lastActivityAt: undefined }), DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(undated.disposition, "wait", "an undated pending reads stale and still waits");
});
