import assert from "node:assert/strict";
import { test } from "node:test";

import { cancelledRunCheckOutcome } from "../src/lib/sweep.js";

// ── W1-T3652 — A CHECK KILLED BY ITS OWN SUCCESSOR REPORTS `failure`, INDISTINGUISHABLE FROM A
//    REAL ONE ─────────────────────────────────────────────────────────────────────────────────
//
// MEASURED 2026-09-16: FOUR CI failures surfaced during one board sweep were not failures at all.
// ci.yml groups by PR with `cancel-in-progress: true`, so every push cancels its predecessor
// mid-flight -- and the jobs killed that way publish `conclusion: failure`, not `cancelled`. The
// PARENT run says `cancelled`; the individual check runs do not.
//
//   #5737  head-identity-gate   failure on a sha the next commit had already replaced
//   #5739  head-identity-gate   failure, same shape
//   #5739  coverage-ratchet     "expected coverage-shard-1 artifact metadata; refusing a missing
//                                or partial artifact" -- the shards never uploaded because the run
//                                was cancelled under them
//   #5737  coverage-ratchet     reported failure ONE SECOND after its run was cancelled
//
// Replaying #5739's coverage-ratchet shape below: a check run that reports `failure` on its own,
// but whose PARENT workflow run concluded `cancelled`, must not classify as a real CI failure.

test("W1-T3652 (acceptance 1 / falsifier): a check run whose parent workflow run concluded cancelled is NOT classified as a CI failure — replaying #5739's coverage-ratchet shape", () => {
  const outcome = cancelledRunCheckOutcome("failure", "cancelled");
  assert.equal(outcome.isFailure, false, "a check killed by its own successor must not read as a real red");
  assert.match(outcome.reason, /parent/i, "the reason must name the parent as the discriminator");
});

test("W1-T3652 (acceptance 1): case-insensitive and works for every REQUIRED_CHECK_FAIL conclusion, not just 'failure'", () => {
  for (const own of ["FAILURE", "ERROR", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE", "STALE"]) {
    const outcome = cancelledRunCheckOutcome(own, "CANCELLED");
    assert.equal(outcome.isFailure, false, `${own} under a cancelled parent must not read as a failure`);
    const lowered = cancelledRunCheckOutcome(own.toLowerCase(), "Cancelled");
    assert.equal(lowered.isFailure, false, `${own} lower-cased, parent mixed-case, must still not read as a failure`);
  }
});

test("W1-T3652 (acceptance 2 / falsifier's flip): a check run whose parent completed normally is classified exactly as it is today — a real red still repairs", () => {
  // Flip #5739's parent from cancelled to concluded, same failing payload: the SAME conclusion
  // must now classify as a real failure, because nothing killed it out from under itself.
  const outcome = cancelledRunCheckOutcome("failure", "failure");
  assert.equal(outcome.isFailure, true, "a genuinely failing check under a normally-concluded run is still a failure");
  assert.match(outcome.reason, /real/i);
});

test("W1-T3652 (acceptance 2): a check that never failed in the first place is never flagged, regardless of the parent", () => {
  for (const parent of [undefined, "cancelled", "success", "failure"]) {
    assert.equal(cancelledRunCheckOutcome("success", parent).isFailure, false);
    assert.equal(cancelledRunCheckOutcome(undefined, parent).isFailure, false);
  }
});

test("W1-T3652 (acceptance 3 / falsifier's third arm): a parent whose conclusion cannot be read leaves the check counted as a failure — an unreadable parent never hides a real red", () => {
  const outcome = cancelledRunCheckOutcome("failure", undefined);
  assert.equal(outcome.isFailure, true, "unreadable is not evidence of cancellation — fails toward treating it as real");
  assert.match(outcome.reason, /unreadable/i);

  // Empty string reads the same as undefined -- an empty field is not a positive "cancelled".
  const emptyParent = cancelledRunCheckOutcome("failure", "");
  assert.equal(emptyParent.isFailure, true, "an empty parent conclusion must not manufacture a suppression");
});

test("W1-T3652 (acceptance 4): cancelledRunCheckOutcome is the ONE named predicate — its own module export, not a condition re-typed per call site", () => {
  assert.equal(typeof cancelledRunCheckOutcome, "function");
});

// ── The two fail-closed directions ───────────────────────────────────────────────────────────
//
// W1-T3652's criteria 2 and 3 named these and no test carried the titles, so `remudero-review`
// reported them unmet — correctly. They are the half that matters most: the downgrade is only
// safe if it is NARROW, and a rule that discarded a real red would be far worse than the wasted
// log read it exists to save.

test("a failure under a completed run is still a failure", () => {
  // The ordinary case, unchanged by this task. If this ever flips, every real red stops repairing.
  for (const parent of ["success", "SUCCESS", "failure", "timed_out", "action_required"]) {
    const outcome = cancelledRunCheckOutcome("failure", parent);
    assert.equal(outcome.isFailure, true, `a failing check under parent ${parent} must stay a failure`);
    assert.match(outcome.reason, /parent run concluded normally/);
  }
});

test("an unreadable parent conclusion still counts as a failure", () => {
  // FAILS TOWARD TREATING IT AS REAL. An absent parent is not evidence of cancellation, and the
  // cost of wrongly discarding a real red is a PR that merges broken.
  for (const parent of [undefined, "", "   ", "unknown", "neutral"]) {
    const outcome = cancelledRunCheckOutcome("failure", parent);
    assert.equal(outcome.isFailure, true, `an unreadable parent (${JSON.stringify(parent)}) must not hide a red`);
  }
  // The reason distinguishes "could not read" from "read, and it was normal" — a caller that
  // cannot tell them apart cannot report which one it saw.
  assert.match(cancelledRunCheckOutcome("failure", undefined).reason, /unreadable/);
  assert.match(cancelledRunCheckOutcome("failure", "success").reason, /concluded normally/);
});

test("only the literal CANCELLED downgrades, so the narrowing cannot widen by accident", () => {
  // A guard on the guard: a substring or prefix match would let "cancelled_by_user" or any future
  // conclusion containing the word silently start discarding reds.
  for (const near of ["cancel", "cancelling", "cancelled_by_user", "auto-cancelled"]) {
    assert.equal(cancelledRunCheckOutcome("failure", near).isFailure, true, `${near} must not downgrade`);
  }
  assert.equal(cancelledRunCheckOutcome("failure", "cancelled").isFailure, false);
  assert.equal(cancelledRunCheckOutcome("failure", "CANCELLED").isFailure, false);
});
