import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_CLAIM_LEASE_MS,
  assessHumanHandoff,
  authorizeHumanHandoffWork,
  claimHumanHandoff,
  closeHumanHandoff,
  createHumanHandoff,
  refreshHumanHandoffFreshness,
  releaseExpiredHandoffClaim,
  type HandoffResult,
  type HumanHandoff,
} from "../src/lib/human-handoff.js";

// W1-T3897 criterion 4: an expired claim cannot silently authorize work, and the item returns to a
// bounded handoff state rather than staying owned forever.

const NOW = Date.parse("2026-10-01T12:00:00.000Z");
const MINUTE = 60_000;
const scope = { principals: ["craig"], repositories: ["remudero"] };

function open(): HumanHandoff {
  const result = createHumanHandoff(
    {
      handoffId: "handoff:expiry-1",
      reason: "a schema migration needs a human",
      sourceReceipt: "receipt:migration-2",
      requiredDecision: "approve the migration",
      scope: { principal: "craig", repository: "remudero" },
      priority: "high",
      responseDeadline: "2026-10-01T20:00:00.000Z",
      escalationPolicy: { afterMs: 60 * MINUTE, chain: ["lead@example.test"] },
      freshness: "verified",
      actionProfile: { level: "approve", capabilities: ["migration.approve"] },
      createdBy: "operator-agent",
    },
    NOW,
  );
  assert.ok(result.ok);
  return result.handoff;
}

function ok(result: HandoffResult): Extract<HandoffResult, { ok: true }> {
  assert.ok(result.ok, JSON.stringify(result));
  return result;
}

const claimed = (): HumanHandoff =>
  ok(claimHumanHandoff(open(), { claimant: "alice", claimantScope: scope, idempotencyKey: "k-1", leaseMs: 30 * MINUTE }, NOW)).handoff;

test("a live claim authorizes only its owner, and only within the original action profile", () => {
  const handoff = claimed();
  const live = authorizeHumanHandoffWork(handoff, "alice", NOW + 10 * MINUTE);
  assert.equal(live.authorized, true);
  if (live.authorized) {
    assert.deepEqual(live.authority, { level: "approve", capabilities: ["migration.approve"] });
    assert.equal(live.claimId, handoff.claim?.claimId);
  }
  const other = authorizeHumanHandoffWork(handoff, "bob", NOW + 10 * MINUTE);
  assert.equal(other.authorized, false);
  if (!other.authorized) assert.match(other.reason, /claimed by alice/);
  const unclaimed = authorizeHumanHandoffWork(open(), "alice", NOW);
  assert.equal(unclaimed.authorized, false);
  if (!unclaimed.authorized) assert.equal(unclaimed.reason, "handoff is unclaimed");
});

test("a lapsed claim lease refuses work by name and cannot close the item with a human decision", () => {
  const handoff = claimed();
  const after = NOW + 31 * MINUTE;
  const lapsed = authorizeHumanHandoffWork(handoff, "alice", after);
  assert.equal(lapsed.authorized, false);
  if (!lapsed.authorized) assert.match(lapsed.reason, /claim lease expired at 2026-10-01T12:30:00.000Z/);
  const assessment = assessHumanHandoff(handoff, after);
  assert.equal(assessment.ownerState, "claim_expired");
  assert.equal(assessment.owner, undefined);
  assert.notEqual(assessment.state, "claimed");
  const close = closeHumanHandoff(handoff, { outcome: "action_accepted", actor: "alice", decision: "approve", authoritativeOutcome: "receipt:migration-run-1" }, after);
  assert.equal(close.ok, false);
  if (!close.ok) {
    assert.equal(close.error, "claim_required");
    assert.match(close.detail, /claim lease expired/);
  }
});

test("a lapsed claim is released to the bounded unclaimed state with a linked receipt, and anyone in scope may claim it", () => {
  const handoff = claimed();
  const noop = ok(releaseExpiredHandoffClaim(handoff, NOW + 10 * MINUTE));
  assert.equal(noop.changed, false);
  const released = ok(releaseExpiredHandoffClaim(handoff, NOW + 31 * MINUTE));
  assert.equal(released.changed, true);
  assert.equal(released.receipt.kind, "claim_released");
  assert.equal(released.receipt.linkedReceipt, handoff.claim?.claimId);
  assert.equal(released.handoff.claim, null);
  assert.equal(released.handoff.closure, null);
  const assessment = assessHumanHandoff(released.handoff, NOW + 31 * MINUTE);
  assert.equal(assessment.ownerState, "unclaimed");
  assert.equal(assessment.state, "unclaimed");
  assert.equal(assessHumanHandoff(released.handoff, NOW + 61 * MINUTE).state, "aging");
  const bob = ok(claimHumanHandoff(released.handoff, { claimant: "bob", claimantScope: scope, idempotencyKey: "k-2", leaseMs: 30 * MINUTE }, NOW + 32 * MINUTE));
  assert.equal(bob.handoff.claim?.owner, "bob");
});

test("a claim lease never outlives the response deadline, and a stale or expired item authorizes nothing", () => {
  const capped = ok(claimHumanHandoff(open(), { claimant: "alice", claimantScope: scope, idempotencyKey: "k-1", leaseMs: MAX_CLAIM_LEASE_MS }, NOW));
  assert.equal(capped.handoff.claim?.leaseExpiresAt, "2026-10-01T20:00:00.000Z");
  const tooLong = claimHumanHandoff(open(), { claimant: "alice", claimantScope: scope, idempotencyKey: "k-1", leaseMs: MAX_CLAIM_LEASE_MS + 1 }, NOW);
  assert.equal(tooLong.ok, false);
  const pastDeadline = authorizeHumanHandoffWork(capped.handoff, "alice", Date.parse("2026-10-01T20:00:00.000Z"));
  assert.equal(pastDeadline.authorized, false);
  if (!pastDeadline.authorized) {
    assert.equal(pastDeadline.reason, "response deadline has passed");
    assert.equal(pastDeadline.state, "expired");
  }
  const stale = ok(refreshHumanHandoffFreshness(capped.handoff, { freshness: "stale", actor: "probe", linkedReceipt: "receipt:probe-1" }, NOW + MINUTE)).handoff;
  const staleAuth = authorizeHumanHandoffWork(stale, "alice", NOW + 2 * MINUTE);
  assert.equal(staleAuth.authorized, false);
  if (!staleAuth.authorized) assert.equal(staleAuth.reason, "source evidence is stale");
  assert.equal(refreshHumanHandoffFreshness(capped.handoff, { freshness: "verified", actor: "probe", linkedReceipt: "" }, NOW).ok, false);
});

test("an item past its deadline closes only as expired, and only once the deadline has passed", () => {
  const handoff = claimed();
  const early = closeHumanHandoff(handoff, { outcome: "expired", actor: "sweeper" }, NOW + MINUTE);
  assert.equal(early.ok, false);
  if (!early.ok) assert.equal(early.error, "not_expired");
  const expired = ok(closeHumanHandoff(handoff, { outcome: "expired", actor: "sweeper" }, Date.parse("2026-10-01T20:00:01.000Z")));
  assert.equal(expired.handoff.closure?.outcome, "expired");
  assert.equal(expired.handoff.claim, null);
  const after = authorizeHumanHandoffWork(expired.handoff, "alice", Date.parse("2026-10-01T20:00:02.000Z"));
  assert.equal(after.authorized, false);
  if (!after.authorized) assert.equal(after.reason, "handoff is closed as expired");
});
