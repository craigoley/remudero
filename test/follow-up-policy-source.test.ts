import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fixedClock } from "../src/lib/clock.js";
import { buildOperatorAgentFollowUpReadRoute, evaluateOperatorAgentFollowUp } from "../src/lib/operator-agent.js";
import {
  FOLLOW_UP_POLICY_VERSION,
  appendFollowUpCandidate,
  evaluateFollowUpPolicy,
  validateFollowUpCandidate,
  validateFollowUpNotificationPolicy,
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

test("notification policy rejects an invalid timezone and the operator-agent path delegates evaluation", () => {
  assert.equal(
    validateFollowUpNotificationPolicy({ enabled: true, quietHours: { timezone: "Not/AZone", start: "22:00", end: "07:00" } }),
    null,
  );
  assert.equal(evaluateOperatorAgentFollowUp(candidate, Date.parse("2026-09-21T11:00:00.000Z")).state, "eligible");
});

test("the operator-agent follow-up read route returns durable ledger history", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-follow-up-route-"));
  try {
    const ledgerPath = join(root, "state", "ledger.ndjson");
    appendFollowUpCandidate({ ledgerPath, now: fixedClock(Date.parse("2026-09-21T10:00:00.000Z")) }, candidate);
    let body = "";
    const response = {
      writeHead: () => undefined,
      end: (value?: unknown) => {
        body = String(value ?? "");
      },
    } as unknown as import("node:http").ServerResponse;
    const route = buildOperatorAgentFollowUpReadRoute({ ledgerPath, now: () => Date.parse("2026-09-21T11:00:00.000Z") });
    route.handler({} as import("node:http").IncomingMessage, response, { params: {} });
    assert.deepEqual(JSON.parse(body), { followUps: [{ ...candidate, state: "scheduled", attempts: 0, events: [] }], source: "ledger" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
