import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateFollowUpPolicy, FOLLOW_UP_POLICY_VERSION, type FollowUpCandidate, type FollowUpHistory } from "../src/lib/follow-up-policy.js";

const base: FollowUpCandidate = {
  version: FOLLOW_UP_POLICY_VERSION,
  candidateId: "follow-up:stale",
  sourceEvent: "thread.dropped",
  workstream: "repo/workstream",
  reason: "The thread needs an owner decision.",
  freshness: "verified",
  deadline: "2026-09-22T00:00:00.000Z",
  deduplicationKey: "repo/workstream:decision",
  maxAttempts: 2,
  owner: "operator",
  nextAction: "Ask the owner for the next bounded decision.",
  createdAt: "2026-09-21T10:00:00.000Z",
};

function evaluate(candidate: FollowUpCandidate, extra: Parameters<typeof evaluateFollowUpPolicy>[1] = {}) {
  return evaluateFollowUpPolicy(candidate, { now: "2026-09-21T12:00:00.000Z", ...extra });
}

test("stale and unavailable evidence suppresses instead of producing a healthy reminder", () => {
  assert.equal(evaluate({ ...base, freshness: "stale" }).state, "suppressed");
  assert.equal(evaluate({ ...base, freshness: "unavailable" }).state, "suppressed");
  assert.match(evaluate({ ...base, freshness: "stale" }).reason, /stale/);
});

test("terminal source, expired deadline, and unavailable dependency are explicit refusals", () => {
  assert.equal(evaluate(base, { sourceTerminal: true }).state, "suppressed");
  assert.equal(evaluate({ ...base, deadline: "2026-09-21T11:00:00.000Z" }).state, "expired");
  assert.equal(evaluate({ ...base, dependency: "owner response" }, { dependencyAvailable: false }).state, "blocked");
});

test("a terminal ledger history cannot be re-armed", () => {
  const terminal: FollowUpHistory = { ...base, state: "accepted", attempts: 1, events: [] };
  const result = evaluate(base, { existing: [terminal] });
  assert.equal(result.state, "suppressed");
  assert.match(result.reason, /terminal receipt/);
});
