/**
 * test/helpers/intent-plan-fixture.ts — W1-T3898: the shared intent-plan-v1 fixture for the five
 * test/intent-plan-*.test.ts suites. It builds on the delegation-profile fixture's fixed clock,
 * temp ledger, and in-process service; every instant is an OFFSET from NOW_MS, never a literal.
 */
import assert from "node:assert/strict";
import { fixedClock, type Clock } from "../../src/lib/clock.js";
import { buildIntentPlan, type IntentPlan, type IntentPlanEvent, type IntentPlanState } from "../../src/lib/intent-plan.js";
import { CLOCK, NOW_MS, READ_TOKEN } from "./delegation-profile-fixture.js";

export const PROPOSER = "operator:owner";
export const PLANS_PATH = "/v1/operator-agent/intent-plans";
export const DECISION_PATH = "/v1/operator-agent/intent-plans/decision";

/** One bounded step — an automation-action-v1 draft without ids, times, scope, or approval. */
export function stepInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    capability: "deploy.canary",
    summary: "Promote the canary build to ten percent of traffic.",
    risk: "low",
    preconditions: [{ id: "health", source: "ledger:health", description: "The fleet health read is healthy." }],
    freshness: { maxAgeSeconds: 600 },
    dryRun: true,
    rollback: { mode: "reversible", plan: "Route all traffic back to the stable build." },
    receiptRef: "ledger:panel.operator_agent_action_receipt",
    ...overrides,
  };
}

/** A plan request whose research settles every built-in question: one named repo, no spend. */
export function planInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { goal: "Promote the canary in repo owner/repo once health is green.", steps: [stepInput()], ...overrides };
}

export function builtPlan(overrides: Record<string, unknown> = {}, clock: Clock = CLOCK): IntentPlan {
  const built = buildIntentPlan(planInput(overrides), { clock, proposedBy: PROPOSER });
  assert.ok(built.ok, JSON.stringify(built));
  return built.plan;
}

export function planState(plan: IntentPlan, events: IntentPlanEvent[] = []): IntentPlanState {
  return { plan, events };
}

/** A clarify event at `offsetMs` from the fixed now, as the fold would read it back. */
export function answerEvent(questionId: string, answer: string, index: number, offsetMs = 0): IntentPlanEvent {
  return { eventId: `ipe-answer-${index}`, kind: "clarify", at: fixedClock(NOW_MS + offsetMs).iso(), issuer: PROPOSER, questionId, answer };
}

export async function readPlans(base: string): Promise<Array<Record<string, unknown>>> {
  const res = await fetch(`${base}${PLANS_PATH}`, { headers: { authorization: `Bearer ${READ_TOKEN}` } });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { version: string; state: string; source: string; intentPlans: Array<Record<string, unknown>> };
  assert.equal(body.version, "intent-plan-v1");
  assert.equal(body.state, "verified");
  assert.equal(body.source, "ledger");
  return body.intentPlans;
}
