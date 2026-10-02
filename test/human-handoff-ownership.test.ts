import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FOLLOW_UP_POLICY_VERSION, type FollowUpCandidate } from "../src/lib/follow-up-policy.js";
import {
  HUMAN_HANDOFF_VERSION,
  appendHumanHandoff,
  assessHumanHandoff,
  createHumanHandoff,
  readHumanHandoffs,
  type HumanHandoff,
  type HumanHandoffInput,
} from "../src/lib/human-handoff.js";
import { handOffOperatorAgentFollowUp } from "../src/lib/operator-agent.js";

// W1-T3897 criterion 1: a handoff records why a human is needed, its source receipt, scope, owner
// state, priority, deadline, and freshness — and none of them may be omitted.

const NOW = Date.parse("2026-10-01T12:00:00.000Z");
const input: HumanHandoffInput = {
  handoffId: "handoff:deploy-1",
  reason: "production deploy needs a human approval",
  sourceReceipt: "receipt:action-77",
  requiredDecision: "approve or refuse the deploy",
  scope: { principal: "craig", repository: "remudero" },
  priority: "high",
  responseDeadline: "2026-10-01T20:00:00.000Z",
  escalationPolicy: { afterMs: 60 * 60 * 1000, chain: ["lead@example.test"] },
  freshness: "verified",
  actionProfile: { level: "approve", capabilities: ["deploy.approve"] },
  createdBy: "operator-agent",
};

function created(): HumanHandoff {
  const result = createHumanHandoff(input, NOW);
  assert.ok(result.ok, JSON.stringify(result));
  return result.handoff;
}

test("a created handoff carries reason, source receipt, scope, unclaimed owner state, priority, deadline, and freshness", () => {
  const result = createHumanHandoff(input, NOW);
  assert.ok(result.ok);
  const handoff = result.handoff;
  assert.equal(handoff.version, HUMAN_HANDOFF_VERSION);
  assert.equal(handoff.reason, input.reason);
  assert.equal(handoff.sourceReceipt, "receipt:action-77");
  assert.equal(handoff.requiredDecision, input.requiredDecision);
  assert.deepEqual(handoff.scope, { principal: "craig", repository: "remudero" });
  assert.equal(handoff.claim, null);
  assert.equal(handoff.priority, "high");
  assert.equal(handoff.responseDeadline, "2026-10-01T20:00:00.000Z");
  assert.equal(handoff.freshness, "verified");
  assert.equal(handoff.freshAt, "2026-10-01T12:00:00.000Z");
  assert.equal(handoff.closure, null);
  assert.deepEqual(handoff.grantedAuthority, input.actionProfile);
  assert.equal(result.receipt.kind, "created");
  assert.equal(result.receipt.linkedReceipt, "receipt:action-77");
  const assessment = assessHumanHandoff(handoff, NOW + 60_000);
  assert.equal(assessment.state, "unclaimed");
  assert.equal(assessment.ownerState, "unclaimed");
  assert.equal(assessment.freshness, "verified");
  assert.equal(assessment.ageMs, 60_000);
  assert.equal(assessment.msToDeadline, 8 * 60 * 60 * 1000 - 60_000);
});

test("a handoff without a reason, source receipt, scope, priority, future deadline, or freshness is refused by name", () => {
  const refusals: Array<[Partial<Record<keyof HumanHandoffInput, unknown>>, RegExp]> = [
    [{ reason: "" }, /reason is required/],
    [{ sourceReceipt: undefined }, /sourceReceipt is required/],
    [{ requiredDecision: " " }, /requiredDecision is required/],
    [{ scope: { principal: "craig" } }, /scope\.principal and scope\.repository/],
    [{ priority: "whenever" }, /priority must be/],
    [{ responseDeadline: "2026-10-01T11:00:00.000Z" }, /responseDeadline must be a future/],
    [{ freshness: "fresh-ish" }, /freshness must be/],
    [{ escalationPolicy: { afterMs: 0, chain: [] } }, /escalationPolicy/],
    [{ actionProfile: { level: "root", capabilities: [] } }, /actionProfile/],
    [{ quietHours: { timezone: "Not/AZone", start: "22:00", end: "06:00" } }, /quietHours/],
  ];
  for (const [patch, detail] of refusals) {
    const result = createHumanHandoff({ ...input, ...patch }, NOW);
    assert.equal(result.ok, false, JSON.stringify(patch));
    if (!result.ok) {
      assert.equal(result.error, "invalid");
      assert.match(result.detail, detail);
    }
  }
  assert.equal(createHumanHandoff(null, NOW).ok, false);
});

test("the ledgered snapshot survives a restart with every ownership field intact", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-handoff-ownership-"));
  try {
    const ledgerPath = join(root, "state", "ledger.ndjson");
    const handoff = created();
    appendHumanHandoff({ ledgerPath, origin: "token-1" }, handoff, handoff.receipts[0]);
    const read = readHumanHandoffs(ledgerPath);
    assert.equal(read.complete, true);
    assert.equal(read.handoffs.length, 1);
    const [back] = read.handoffs;
    for (const field of ["reason", "sourceReceipt", "scope", "claim", "priority", "responseDeadline", "freshness", "freshAt"] as const) {
      assert.deepEqual(back[field], handoff[field], field);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const followUp: FollowUpCandidate = {
  version: FOLLOW_UP_POLICY_VERSION,
  candidateId: "follow-up:outcome-1",
  sourceEvent: "operator_agent.outcome_observed",
  workstream: "remudero/experiment",
  reason: "The accepted experiment has no observed outcome yet.",
  freshness: "verified",
  dependency: "owner response",
  deduplicationKey: "remudero/experiment:outcome",
  maxAttempts: 2,
  owner: "operator@example.test",
  nextQuestion: "Record the observed outcome?",
  createdAt: "2026-10-01T10:00:00.000Z",
};
const handoffContext = {
  now: NOW,
  scope: { principal: "craig", repository: "remudero" },
  escalationPolicy: { afterMs: 60 * 60 * 1000, chain: ["lead@example.test"] },
};

test("the follow-up path creates a durable handoff for a follow-up that must ask a human", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-handoff-follow-up-"));
  try {
    const ledgerPath = join(root, "state", "ledger.ndjson");
    const result = handOffOperatorAgentFollowUp(followUp, { ...handoffContext, ledgerPath });
    assert.equal(result.evaluation.state, "eligible");
    assert.ok(result.handoff);
    assert.equal(result.handoff.handoffId, "handoff:follow-up:outcome-1");
    assert.equal(result.handoff.sourceReceipt, "operator_agent.outcome_observed");
    assert.equal(result.handoff.requiredDecision, "Record the observed outcome?");
    assert.equal(result.handoff.priority, "normal");
    assert.equal(result.handoff.responseDeadline, "2026-10-02T12:00:00.000Z");
    assert.deepEqual(result.handoff.actionProfile, { level: "advise", capabilities: [] });
    assert.deepEqual(readHumanHandoffs(ledgerPath).handoffs.map((item) => item.handoffId), ["handoff:follow-up:outcome-1"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a blocked follow-up becomes a high-priority handoff; an autonomous one creates none; a core refusal is named", () => {
  const actionOnly = { ...followUp, nextQuestion: undefined, nextAction: "re-run the probe" };
  const autonomous = handOffOperatorAgentFollowUp(actionOnly, handoffContext);
  assert.equal(autonomous.evaluation.state, "eligible");
  assert.equal(autonomous.handoff, null);
  const blocked = handOffOperatorAgentFollowUp({ ...actionOnly, deadline: "2026-10-01T18:00:00.000Z" }, { ...handoffContext, dependencyAvailable: false });
  assert.equal(blocked.evaluation.state, "blocked");
  assert.equal(blocked.handoff?.priority, "high");
  assert.match(blocked.handoff?.reason ?? "", /dependency is unavailable: owner response/);
  assert.equal(blocked.handoff?.requiredDecision, "decide whether to proceed: re-run the probe");
  assert.equal(blocked.handoff?.responseDeadline, "2026-10-01T18:00:00.000Z");
  const suppressed = handOffOperatorAgentFollowUp({ ...followUp, freshness: "stale" }, handoffContext);
  assert.equal(suppressed.evaluation.state, "suppressed");
  assert.equal(suppressed.handoff, null);
  const refused = handOffOperatorAgentFollowUp(followUp, { ...handoffContext, escalationPolicy: { afterMs: 0, chain: [] } });
  assert.equal(refused.handoff, null);
  assert.match(refused.refusal ?? "", /^invalid: escalationPolicy/);
});
