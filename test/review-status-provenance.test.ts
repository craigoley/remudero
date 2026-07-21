import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decideAutoMergeArmAtSha,
  resolveReviewProvenance,
  type ReviewStatusEntry,
} from "../src/lib/review.js";

const TRUSTED = "remudero-reviewer[bot]";

// ── Acceptance criterion 1: an untrusted SUCCESS is ABSENT, not a pass ──────

test("resolveReviewProvenance: a success posted by an identity other than the trusted reviewer resolves to ABSENT", () => {
  const forged: ReviewStatusEntry = { state: "success", posterLogin: "some-worker-identity" };
  assert.equal(resolveReviewProvenance(forged, TRUSTED), "absent");
});

test("decideAutoMergeArmAtSha: a remudero-review=success posted by an untrusted identity does NOT arm auto-merge", () => {
  const forged: ReviewStatusEntry = { state: "success", posterLogin: "some-worker-identity" };
  const decision = decideAutoMergeArmAtSha(forged, TRUSTED);
  assert.equal(decision.arm, false);
  // The refusal must NAME the mismatch, not just say "no" — a silent refuse is
  // indistinguishable from a bug in the caller.
  assert.match(decision.reason, /some-worker-identity/);
});

// ── Acceptance criterion 2: untrusted ⇒ ABSENT, never FAIL (no DoS vector) ──

test("resolveReviewProvenance: an untrusted poster's FAILURE also resolves to ABSENT, not FAILURE — a hostile/buggy poster cannot manufacture a real failure", () => {
  const hostile: ReviewStatusEntry = { state: "failure", posterLogin: "some-worker-identity" };
  assert.equal(resolveReviewProvenance(hostile, TRUSTED), "absent");
});

test("decideAutoMergeArmAtSha: an untrusted poster's refusal reason NEVER says 'failure' — it must read as ABSENT so it is never confused with a genuine failed review", () => {
  const hostileFail = decideAutoMergeArmAtSha({ state: "failure", posterLogin: "hostile" }, TRUSTED);
  const hostileSuccess = decideAutoMergeArmAtSha({ state: "success", posterLogin: "hostile" }, TRUSTED);
  const noStatusAtAll = decideAutoMergeArmAtSha(undefined, TRUSTED);

  for (const decision of [hostileFail, hostileSuccess, noStatusAtAll]) {
    assert.equal(decision.arm, false);
    assert.doesNotMatch(decision.reason, /remudero-review is not success/);
  }
  // A hostile FAILURE post must be exactly as inert as no status at all — an
  // attacker who cannot forge a PASS must not be able to forge a BLOCK either.
  assert.equal(resolveReviewProvenance({ state: "failure", posterLogin: "hostile" }, TRUSTED), "absent");
  assert.equal(resolveReviewProvenance(undefined, TRUSTED), "absent");
});

// ── Acceptance criterion 3: the trusted identity is honoured exactly as today ──

test("resolveReviewProvenance: a status posted by the trusted reviewer identity passes through its own state, unchanged", () => {
  const genuinePass: ReviewStatusEntry = { state: "success", posterLogin: TRUSTED };
  const genuineFail: ReviewStatusEntry = { state: "failure", posterLogin: TRUSTED };
  assert.equal(resolveReviewProvenance(genuinePass, TRUSTED), "success");
  assert.equal(resolveReviewProvenance(genuineFail, TRUSTED), "failure");
});

test("decideAutoMergeArmAtSha: a genuine success from the trusted reviewer identity arms exactly as it would have pre-W1-T203", () => {
  const genuine: ReviewStatusEntry = { state: "success", posterLogin: TRUSTED };
  const decision = decideAutoMergeArmAtSha(genuine, TRUSTED);
  assert.equal(decision.arm, true);
});

test("decideAutoMergeArmAtSha: a genuine failure from the trusted reviewer identity still refuses to arm — this task changes NOTHING about a real failing review", () => {
  const genuineFail: ReviewStatusEntry = { state: "failure", posterLogin: TRUSTED };
  const decision = decideAutoMergeArmAtSha(genuineFail, TRUSTED);
  assert.equal(decision.arm, false);
  assert.match(decision.reason, /remudero-review is not success/);
});

test("resolveReviewProvenance: the login compare is case-insensitive (GitHub logins are case-insensitive for uniqueness)", () => {
  const differentCase: ReviewStatusEntry = { state: "success", posterLogin: TRUSTED.toUpperCase() };
  assert.equal(resolveReviewProvenance(differentCase, TRUSTED), "success");
});

test("resolveReviewProvenance: a status with no posterLogin at all (malformed GitHub response) is treated as untrusted, never assumed trusted", () => {
  const noLogin: ReviewStatusEntry = { state: "success" };
  assert.equal(resolveReviewProvenance(noLogin, TRUSTED), "absent");
});
