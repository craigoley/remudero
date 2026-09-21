import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FOLLOW_UP_POLICY_VERSION,
  followUpReceipt,
  type FollowUpCandidate,
  type FollowUpHistory,
} from "../src/lib/follow-up-policy.js";

const candidate: FollowUpCandidate = {
  version: FOLLOW_UP_POLICY_VERSION,
  candidateId: "follow-up:delivery",
  sourceEvent: "experiment.accepted",
  workstream: "repo/experiment",
  reason: "An accepted change still needs an observed outcome.",
  freshness: "verified",
  dependency: "outcome observation",
  deduplicationKey: "repo/experiment:outcome",
  maxAttempts: 2,
  owner: "operator",
  nextQuestion: "What outcome was observed?",
  createdAt: "2026-09-21T10:00:00.000Z",
};

test("delivery is an asked receipt, not completed work or permission to act", () => {
  const history: FollowUpHistory = { ...candidate, state: "eligible", attempts: 0, events: [] };
  const receipt = followUpReceipt(history, { at: "2026-09-21T11:00:00.000Z" });
  assert.ok(!("error" in receipt));
  assert.equal(receipt.delivered, true);
  assert.equal(receipt.completed, false);
  assert.equal(receipt.systemActed, false);
  assert.equal(receipt.permissionToAct, false);
});

test("a system action needs an explicit authority and remains a separate receipt fact", () => {
  const history: FollowUpHistory = { ...candidate, state: "eligible", attempts: 0, events: [] };
  assert.deepEqual(followUpReceipt(history, { systemActed: true, at: "2026-09-21T11:00:00.000Z" }), { error: "systemActed requires an authority" });
  const receipt = followUpReceipt(history, { systemActed: true, authority: "delegation-profile-v1:owner", answered: true, at: "2026-09-21T11:00:00.000Z" });
  assert.ok(!("error" in receipt));
  assert.equal(receipt.permissionToAct, true);
  assert.equal(receipt.completed, false);
});
