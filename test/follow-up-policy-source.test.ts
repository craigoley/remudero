import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FOLLOW_UP_POLICY_VERSION,
  evaluateFollowUpPolicy,
  validateFollowUpCandidate,
  type FollowUpCandidate,
} from "../src/lib/follow-up-policy.js";

const candidate: FollowUpCandidate = {
  version: FOLLOW_UP_POLICY_VERSION,
  candidateId: "follow-up:thread-1",
  sourceEvent: "operator_agent.outcome_observed",
  workstream: "repo/experiment",
  reason: "The accepted experiment has no observed outcome yet.",
  freshness: "verified",
  dependency: "owner response",
  deduplicationKey: "repo/experiment:outcome",
  maxAttempts: 2,
  owner: "operator@example.test",
  nextQuestion: "Would you like to record the observed outcome?",
  createdAt: "2026-09-21T10:00:00.000Z",
};

test("a follow-up carries its source, reason, freshness, dependency, dedup key, and next decision", () => {
  const parsed = validateFollowUpCandidate(candidate);
  assert.deepEqual(parsed, candidate);
  const evaluation = evaluateFollowUpPolicy(candidate, { now: "2026-09-21T11:00:00.000Z" });
  assert.equal(evaluation.state, "eligible");
  assert.equal(evaluation.nextQuestion, candidate.nextQuestion);
  assert.equal(evaluation.deduplicationKey, candidate.deduplicationKey);
});

test("a candidate cannot omit the deadline-or-dependency and action-or-question decisions", () => {
  assert.equal(validateFollowUpCandidate({ ...candidate, dependency: undefined, deadline: undefined }), null);
  assert.equal(validateFollowUpCandidate({ ...candidate, nextAction: "act", nextQuestion: "ask" }), null);
});
