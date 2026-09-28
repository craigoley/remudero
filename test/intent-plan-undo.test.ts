// W1-T3898 acceptance: "undo is a linked bounded action or refusal and never rewrites the original
// plan or receipt". An unconfirmed plan is withdrawn; a never-run action is withdrawn and its
// admission refused from then on; a completed reversible action gets a rollback REQUEST linked to its
// completion receipt; an irreversible or running one is refused by name — and every ledger row
// written before the undo is still there, byte for byte, afterwards.
import assert from "node:assert/strict";
import { test } from "node:test";
import { type AutomationActionReceipt, type AutomationActionState } from "../src/lib/automation-action.js";
import {
  INTENT_PLAN_MAX_EVENTS,
  intentPlanActionEligibility,
  undoIntentPlan,
  type IntentPlanEvent,
  type IntentPlanLinkedAction,
  type IntentPlanUndoStep,
} from "../src/lib/intent-plan.js";
import { CLOCK, HEALTHY, MINUTE, NOW_MS, postJson, rowsAt, tempStatePath, validAction, withDelegationService } from "./helpers/delegation-profile-fixture.js";
import { builtPlan, DECISION_PATH, planInput, PLANS_PATH, PROPOSER, planState, readPlans, stepInput } from "./helpers/intent-plan-fixture.js";

const COMPLETION: AutomationActionReceipt = {
  version: "automation-action-v1",
  receiptId: "aar-completion",
  actionId: "a:1",
  idempotencyKey: "k:1",
  kind: "completion",
  outcome: "succeeded",
  at: CLOCK.iso(),
  receiptRef: "ledger:panel.operator_agent_action_receipt",
  linkedReceiptId: "aar-admission",
  reason: "execution succeeded",
  evidenceRef: "github:owner/repo/deployments/1",
};

function linkedAs(state: AutomationActionState, overrides: Record<string, unknown> = {}): IntentPlanLinkedAction {
  return { action: validAction({ actionId: "a:1", idempotencyKey: "k:1", ...overrides }), state, receipts: state === "succeeded" ? [COMPLETION] : [] };
}

const CONFIRM: IntentPlanEvent = { eventId: "ipe-c", kind: "confirm", at: CLOCK.iso(), issuer: PROPOSER, actionIds: ["a:1"] };

function undo(events: IntentPlanEvent[], linked: IntentPlanLinkedAction[]) {
  return undoIntentPlan({ state: planState(builtPlan(), events), linked, issuer: PROPOSER, note: "changed my mind", clock: CLOCK });
}

function stepOf(result: ReturnType<typeof undo>): IntentPlanUndoStep | undefined {
  return result.event && result.event.kind === "undo" ? result.event.steps[0] : undefined;
}

test("W1-T3898: undoing an unconfirmed plan withdraws it once, as a new event", () => {
  const first = undo([], []);
  assert.equal(first.disposition, "withdrawn");
  assert.ok(first.append);
  assert.deepEqual(first.event && first.event.kind === "undo" && [first.event.outcome, first.event.steps, first.event.note], ["withdrawn", [], "changed my mind"]);
  const again = undo([first.event!], []);
  assert.equal(again.disposition, "reused", "a second undo changes nothing and records nothing");
  const noise = Array.from({ length: INTENT_PLAN_MAX_EVENTS }, (_, i): IntentPlanEvent => ({ ...CONFIRM, eventId: `ipe-n${i}`, kind: "clarify", questionId: `q${i}`, answer: "x" }) as IntentPlanEvent);
  assert.equal(undo(noise, []).disposition, "refused", "the event backstop holds for undo too");
});

test("W1-T3898: undo answers each linked action by its own state — withdrawal, rollback request, or a named refusal", () => {
  const cases: Array<[AutomationActionState, Record<string, unknown>, string, string, string | undefined]> = [
    ["registered", {}, "requested", "withdrawn", undefined],
    ["approved", {}, "requested", "withdrawn", undefined],
    ["succeeded", {}, "requested", "rollback-requested", undefined],
    ["succeeded", { risk: "high", approval: { policy: "human" }, rollback: { mode: "irreversible", refusal: "Deleted data cannot come back." } }, "refused", "refused", "irreversible"],
    ["in-progress", {}, "refused", "refused", "in-progress"],
    ["failed", {}, "refused", "nothing-to-undo", "nothing-to-undo"],
    ["rolled_back", {}, "refused", "already-undone", "nothing-to-undo"],
  ];
  for (const [state, overrides, disposition, result, code] of cases) {
    const answer = undo([CONFIRM], [linkedAs(state, overrides)]);
    assert.equal(answer.disposition, disposition, state);
    assert.equal(stepOf(answer)?.result, result, state);
    if (code) assert.equal(answer.disposition === "refused" && answer.code, code, state);
    assert.ok(answer.append, `${state}: a refusal is recorded too`);
  }
  const rollback = stepOf(undo([CONFIRM], [linkedAs("succeeded")]))!;
  assert.equal(rollback.linkedReceiptId, "aar-completion", "a rollback request is linked to the completion it would undo");
  assert.equal(rollback.detail, "Route all traffic back to the stable build.");
  const missing = undo([CONFIRM], []);
  assert.equal(missing.disposition === "refused" && missing.code, "action-missing");
});

test("W1-T3898: a repeated undo that changes nothing reuses the last one; a newly completed action gets its own request", () => {
  const first = undo([CONFIRM], [linkedAs("registered")]);
  const withdrawn = first.event!;
  assert.equal(undo([CONFIRM, withdrawn], [linkedAs("registered")]).disposition, "reused");
  const requested = undo([CONFIRM], [linkedAs("succeeded")]).event!;
  assert.equal(undo([CONFIRM, requested], [linkedAs("rolled_back")]).disposition, "reused", "a rolled-back action is already undone");
  assert.equal(undo([CONFIRM, withdrawn], [linkedAs("succeeded")]).disposition, "requested", "the result changed, so a new request is recorded");
  const noise = Array.from({ length: INTENT_PLAN_MAX_EVENTS - 1 }, (_, i): IntentPlanEvent => ({ ...CONFIRM, eventId: `ipe-n${i}` }));
  assert.equal(undo([CONFIRM, ...noise], [linkedAs("registered")]).disposition, "refused");
});

test("W1-T3898: a withdrawn action's admission is refused through its own preflight", () => {
  const plan = builtPlan();
  const withdrawal: IntentPlanEvent = { eventId: "ipe-u", kind: "undo", at: CLOCK.iso(), issuer: PROPOSER, outcome: "requested", steps: [{ stepId: "step-1", actionId: "a:1", result: "withdrawn", detail: "never ran" }] };
  assert.deepEqual(intentPlanActionEligibility([planState(plan, [CONFIRM, withdrawal])], "a:1").map((finding) => finding.code), ["intent-plan-withdrawn"]);
  assert.deepEqual(intentPlanActionEligibility([planState(plan, [CONFIRM])], "a:1"), []);
  assert.deepEqual(intentPlanActionEligibility([planState(plan, [CONFIRM, withdrawal])], "a:2"), [], "an action no plan requested is not affected");
});

test("W1-T3898: undo over HTTP never rewrites the plan or a receipt, and rollback completes only on a rollback receipt", async () => {
  const path = tempStatePath();
  const planIds = await withDelegationService(path, async (base) => {
    const draft = await postJson(base, PLANS_PATH, planInput({ idempotencyKey: "draft" }));
    const withdrawn = await postJson(base, DECISION_PATH, { planId: draft.body.planId, action: "undo" });
    assert.equal(withdrawn.status, 200, JSON.stringify(withdrawn.body));
    assert.equal(withdrawn.body.disposition, "withdrawn");
    assert.equal((withdrawn.body.plan as { status: string; nextDecision: string }).status, "withdrawn");
    const late = await postJson(base, DECISION_PATH, { planId: draft.body.planId, action: "confirm" });
    assert.equal(late.status, 409);
    assert.equal(late.body.code, "plan-withdrawn");

    const idle = await postJson(base, PLANS_PATH, planInput({ idempotencyKey: "idle" }));
    const reversible = await postJson(base, PLANS_PATH, planInput({ idempotencyKey: "reversible" }));
    const oneWay = await postJson(base, PLANS_PATH, planInput({ idempotencyKey: "one-way", steps: [stepInput({ rollback: { mode: "irreversible", refusal: "A sent notice cannot be unsent." } })] }));
    for (const plan of [idle, reversible, oneWay]) assert.equal((await postJson(base, DECISION_PATH, { planId: plan.body.planId, action: "confirm" })).status, 202);
    return { idle: idle.body.planId as string, reversible: reversible.body.planId as string, oneWay: oneWay.body.planId as string };
  });

  await withDelegationService(path, async (base) => {
    const gated = await postJson(base, "/v1/operator-agent/actions/decision", { actionId: `${planIds.oneWay}:step-1`, decision: "approved" });
    assert.equal(gated.status, 200, "an irreversible step keeps its own human gate after the plan is confirmed");
    for (const planId of [planIds.reversible, planIds.oneWay]) {
      const execute = await postJson(base, "/v1/operator-agent/actions/execute", { actionId: `${planId}:step-1`, observations: HEALTHY });
      const admissionReceiptId = (execute.body.receipt as { receiptId: string }).receiptId;
      assert.equal((await postJson(base, "/v1/operator-agent/actions/complete", { actionId: `${planId}:step-1`, admissionReceiptId, outcome: "succeeded", evidenceRef: "github:owner/repo/deployments/9" })).status, 200);
    }
  }, NOW_MS + MINUTE);

  await withDelegationService(path, async (base) => {
    const before = rowsAt(path);
    const idle = await postJson(base, DECISION_PATH, { planId: planIds.idle, action: "undo", note: "not needed" });
    assert.equal(idle.status, 200);
    assert.equal(((idle.body.event as { steps: IntentPlanUndoStep[] }).steps[0]!).result, "withdrawn");
    const blocked = await postJson(base, "/v1/operator-agent/actions/execute", { actionId: `${planIds.idle}:step-1`, observations: HEALTHY });
    assert.equal(blocked.status, 409, "a withdrawn action can no longer be admitted");
    assert.equal((blocked.body.receipt as { code: string }).code, "intent-plan-withdrawn");

    const requested = await postJson(base, DECISION_PATH, { planId: planIds.reversible, action: "undo" });
    assert.equal(requested.status, 200);
    const [step] = (requested.body.event as { steps: IntentPlanUndoStep[] }).steps;
    assert.equal(step!.result, "rollback-requested");
    const pending = (requested.body.plan as { execution: { state: string; actions: Array<{ undo?: string }> } }).execution;
    assert.deepEqual([pending.state, pending.actions[0]!.undo], ["succeeded", "rollback-requested"], "undo is requested, not claimed, until a rollback receipt exists");

    const refused = await postJson(base, DECISION_PATH, { planId: planIds.oneWay, action: "undo" });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.code, "irreversible");
    assert.equal(refused.body.detail, "A sent notice cannot be unsent.");
    assert.equal(typeof refused.body.at, "string", "the recorded refusal carries its own time");

    const after = rowsAt(path);
    assert.deepEqual(after.slice(0, before.length), before, "every row written before the undo is unchanged; undo only appends");
  }, NOW_MS + 2 * MINUTE);

  await withDelegationService(path, async (base) => {
    const actionId = `${planIds.reversible}:step-1`;
    assert.equal((await postJson(base, "/v1/operator-agent/actions/rollback", { actionId, reason: "operator undo", evidenceRef: "github:owner/repo/deployments/10" })).status, 200);
    const plans = await readPlans(base);
    const plan = plans.find((item) => item.planId === planIds.reversible)!;
    assert.deepEqual((plan.execution as { state: string; actions: Array<{ undo?: string }> }).state, "rolled-back");
    assert.equal((plan.execution as { actions: Array<{ undo?: string }> }).actions[0]!.undo, "rolled-back");
    assert.equal(plan.nextDecision, "none");
    const reused = await postJson(base, DECISION_PATH, { planId: planIds.reversible, action: "undo" });
    assert.equal(reused.status, 200);
    assert.equal(reused.body.disposition, "reused");
  }, NOW_MS + 3 * MINUTE);
});
