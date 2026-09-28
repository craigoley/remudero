// W1-T3898 acceptance: "confirmation creates a bounded action request but does not claim success
// before a durable receipt". Confirmation re-runs the preview, derives one automation-action-v1 per
// step, and registers them; the plan reads `awaiting-receipt`, then `in-progress`, and `succeeded`
// only once every action's completion receipt names its evidence.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fixedClock } from "../src/lib/clock.js";
import { validateAutomationAction, type AutomationActionState } from "../src/lib/automation-action.js";
import { OPERATOR_AGENT_ACTION_STEP } from "../src/lib/operator-agent.js";
import {
  confirmIntentPlan,
  INTENT_PLAN_EVENT_LEDGER_STEP,
  INTENT_PLAN_MAX_EVENTS,
  intentPlanActions,
  intentPlanExecution,
  type IntentPlanEvent,
  type IntentPlanLinkedAction,
} from "../src/lib/intent-plan.js";
import { CLOCK, DAY, HEALTHY, issueAndAccept, MINUTE, NOW_MS, postJson, rowsAt, stepsAt, tempStatePath, validAction, withDelegationService } from "./helpers/delegation-profile-fixture.js";
import { builtPlan, DECISION_PATH, planInput, PLANS_PATH, PROPOSER, planState, readPlans, stepInput } from "./helpers/intent-plan-fixture.js";

test("W1-T3898: confirmation derives one valid, bounded automation-action-v1 request per step", () => {
  const plan = builtPlan({ idempotencyKey: "canary-7", steps: [stepInput(), stepInput({ capability: "deploy.promote", risk: "production" })] });
  const result = confirmIntentPlan({ state: planState(plan), issuer: PROPOSER, note: "ship it", clock: CLOCK });
  assert.equal(result.disposition, "confirmed");
  if (result.disposition !== "confirmed") return;
  const actions = result.actions ?? [];
  assert.deepEqual(actions.map((action) => [action.actionId, action.idempotencyKey, action.approval.policy]), [
    [`${plan.planId}:step-1`, "canary-7:step-1", "none"],
    [`${plan.planId}:step-2`, "canary-7:step-2", "human"],
  ], "a production step keeps its own human gate after confirmation");
  for (const action of actions) {
    const validated = validateAutomationAction(action);
    assert.ok(validated.ok, JSON.stringify(validated));
    assert.equal(JSON.stringify(validated.action), JSON.stringify(action), "the request is exactly what the action contract would store");
    assert.deepEqual(action.scope, { flowId: plan.planId, repo: "owner/repo" });
    assert.equal(action.expiresAt, plan.expiresAt);
  }
  assert.deepEqual(result.event.kind === "confirm" && [result.event.actionIds, result.event.note], [actions.map((action) => action.actionId), "ship it"]);
  assert.deepEqual(intentPlanActions(plan, { instance: "prod-1", flowId: "flow:canary" })[0]!.scope, { flowId: "flow:canary", instance: "prod-1" });
  const again = confirmIntentPlan({ state: planState(plan, [result.event]), issuer: PROPOSER, clock: CLOCK });
  assert.equal(again.disposition, "reused", "a second confirmation returns the first");
});

test("W1-T3898: confirmation re-runs the preview and refuses anything but ready, a withdrawn plan, or a full history", () => {
  const code = (result: ReturnType<typeof confirmIntentPlan>) => (result.disposition === "refused" ? result.code : result.disposition);
  assert.equal(code(confirmIntentPlan({ state: planState(builtPlan({ goal: "Retry the flaky jobs." })), issuer: PROPOSER, clock: CLOCK })), "preview-needs-clarification");
  assert.equal(code(confirmIntentPlan({ state: planState(builtPlan()), issuer: PROPOSER, clock: fixedClock(NOW_MS + 2 * DAY) })), "preview-expired");
  assert.equal(code(confirmIntentPlan({ state: planState(builtPlan({ steps: [stepInput({ estimatedCostUsd: 9 })], budget: { ceilingUsd: 1 } })), issuer: PROPOSER, clock: CLOCK })), "preview-over-budget");
  const withdrawn: IntentPlanEvent = { eventId: "ipe-w", kind: "undo", at: CLOCK.iso(), issuer: PROPOSER, outcome: "withdrawn", steps: [] };
  assert.equal(code(confirmIntentPlan({ state: planState(builtPlan(), [withdrawn]), issuer: PROPOSER, clock: CLOCK })), "plan-withdrawn");
  const noise = Array.from({ length: INTENT_PLAN_MAX_EVENTS }, (_, i): IntentPlanEvent => ({ ...withdrawn, eventId: `ipe-n${i}`, outcome: "refused" }));
  assert.equal(code(confirmIntentPlan({ state: planState(builtPlan(), noise), issuer: PROPOSER, clock: CLOCK })), "event-history-full");
});

test("W1-T3898: execution reads success only from every linked action's receipts, never from the confirmation", () => {
  const plan = builtPlan();
  const confirm: IntentPlanEvent = { eventId: "ipe-c", kind: "confirm", at: CLOCK.iso(), issuer: PROPOSER, actionIds: ["a:1", "a:2"] };
  const linked = (states: AutomationActionState[]): IntentPlanLinkedAction[] =>
    states.map((state, i) => ({ action: validAction({ actionId: `a:${i + 1}`, idempotencyKey: `k:${i + 1}` }), state, receipts: [] }));
  const execution = (states: AutomationActionState[]) => intentPlanExecution(planState(plan, [confirm]), linked(states)).state;
  assert.equal(intentPlanExecution(planState(plan), []).state, "not-requested");
  assert.equal(intentPlanExecution(planState(plan, [confirm]), linked(["succeeded"])).state, "unknown", "a missing action is never read as success");
  assert.equal(execution(["registered", "approved"]), "awaiting-receipt");
  assert.equal(execution(["in-progress", "succeeded"]), "in-progress");
  assert.equal(execution(["succeeded", "failed"]), "failed");
  assert.equal(execution(["succeeded", "rejected"]), "refused");
  assert.equal(execution(["succeeded", "succeeded"]), "succeeded");
  assert.equal(execution(["rolled_back", "rolled_back"]), "rolled-back");
  assert.equal(execution(["succeeded", "rolled_back"]), "partially-rolled-back");
  assert.equal(execution(["expired", "succeeded"]), "expired");
});

test("W1-T3898: confirming over HTTP requests the actions and reports awaiting-receipt until completion evidence exists", async () => {
  const path = tempStatePath();
  const planId = await withDelegationService(path, async (base) => {
    const proposed = await postJson(base, PLANS_PATH, planInput());
    const id = proposed.body.planId as string;
    const confirmed = await postJson(base, DECISION_PATH, { planId: id, action: "confirm", note: "go" });
    assert.equal(confirmed.status, 202, JSON.stringify(confirmed.body));
    assert.equal(confirmed.body.disposition, "confirmed");
    assert.equal(typeof confirmed.body.at, "string");
    const plan = confirmed.body.plan as { status: string; execution: { state: string }; confirmation: { state: string; actionIds: string[] }; nextDecision: string };
    assert.equal(plan.status, "confirmed");
    assert.equal(plan.execution.state, "awaiting-receipt", "a confirmation is a request, never a success");
    assert.deepEqual(plan.confirmation.actionIds, [`${id}:step-1`]);
    assert.equal(plan.nextDecision, "undo");
    assert.equal(rowsAt(path).filter((row) => row.step === OPERATOR_AGENT_ACTION_STEP).length, 1, "the linked action is registered");
    const replay = await postJson(base, DECISION_PATH, { planId: id, action: "confirm", confirm: true });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.disposition, "reused");
    assert.equal(rowsAt(path).filter((row) => row.step === OPERATOR_AGENT_ACTION_STEP).length, 1, "a second confirmation registers nothing new");
    return id;
  });
  const actionId = `${planId}:step-1`;
  const admission = await withDelegationService(path, async (base) => {
    const execute = await postJson(base, "/v1/operator-agent/actions/execute", { actionId, observations: HEALTHY });
    assert.equal(execute.status, 202, JSON.stringify(execute.body));
    const [plan] = await readPlans(base);
    assert.equal((plan!.execution as { state: string }).state, "in-progress", "admitted, not succeeded");
    return (execute.body.receipt as { receiptId: string }).receiptId;
  }, NOW_MS + MINUTE);
  await withDelegationService(path, async (base) => {
    const complete = await postJson(base, "/v1/operator-agent/actions/complete", { actionId, admissionReceiptId: admission, outcome: "succeeded", evidenceRef: "github:owner/repo/deployments/42" });
    assert.equal(complete.status, 200, JSON.stringify(complete.body));
    const [plan] = await readPlans(base);
    assert.deepEqual(plan!.execution, { state: "succeeded", actions: [{ actionId, state: "succeeded", evidenceRule: "self-reported", evidenceRef: "github:owner/repo/deployments/42" }] });
  }, NOW_MS + 2 * MINUTE);
});

test("W1-T3898: a confirmation refuses to overwrite a different action, and adopts an identical one on retry", async () => {
  const path = tempStatePath();
  await withDelegationService(path, async (base) => {
    const first = await postJson(base, PLANS_PATH, planInput({ idempotencyKey: "retry-1" }));
    const planId = first.body.planId as string;
    const squatter = validAction({ actionId: `${planId}:step-1`, idempotencyKey: "someone-else" });
    assert.equal((await postJson(base, "/v1/operator-agent/actions", { action: squatter })).status, 201);
    const refused = await postJson(base, DECISION_PATH, { planId, action: "confirm" });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.code, "action-conflict");
    assert.equal(stepsAt(path).includes(INTENT_PLAN_EVENT_LEDGER_STEP), false, "a refused confirmation records no event");

    const second = await postJson(base, PLANS_PATH, planInput({ idempotencyKey: "retry-2" }));
    const retryId = second.body.planId as string;
    const [expected] = intentPlanActions(builtPlan({ idempotencyKey: "retry-2" }), { repo: "owner/repo" });
    assert.equal((await postJson(base, "/v1/operator-agent/actions", { action: expected })).status, 201, "a crash left the action registered without its event");
    const adopted = await postJson(base, DECISION_PATH, { planId: retryId, action: "confirm" });
    assert.equal(adopted.status, 202, JSON.stringify(adopted.body));
    assert.equal(rowsAt(path).filter((row) => row.step === OPERATOR_AGENT_ACTION_STEP && row.task_id === `${retryId}:step-1`).length, 1, "the identical action is adopted, not registered twice");
  });
});

test("W1-T3898: a plan acting under an accepted delegation confirms, and one under a missing delegation is refused", async () => {
  const path = tempStatePath();
  await withDelegationService(path, async (base) => {
    const delegationId = await issueAndAccept(base);
    const delegated = await postJson(base, PLANS_PATH, planInput({ delegationId, scope: { flowId: "flow:canary" } }));
    assert.equal((delegated.body.preview as { state: string }).state, "ready");
    const confirmed = await postJson(base, DECISION_PATH, { planId: delegated.body.planId, action: "confirm" });
    assert.equal(confirmed.status, 202, JSON.stringify(confirmed.body));
    const orphan = await postJson(base, PLANS_PATH, planInput({ delegationId: "delegation:nobody", idempotencyKey: "orphan" }));
    const refused = await postJson(base, DECISION_PATH, { planId: orphan.body.planId, action: "confirm" });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.code, "preview-refused");
  });
});
