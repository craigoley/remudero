// W1-T4694 acceptance: "a catalogue step reads succeeded only on an executor completion receipt, a
// self-reported completion for it leaves the step awaiting a receipt with a named reason, and a
// non-catalogue step keeps today's rule". W1-T4657 made the executor write catalogue completions
// itself (`code: "executor"`) and labelled a caller's claim `self-reported`; the intent plan's
// execution derivation now tells the two apart instead of counting any evidenceRef as done.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  automationActionState,
  completeAutomationAction,
  evaluateAutomationAction,
  type AutomationAction,
  type AutomationActionReceipt,
  type AutomationApprovalDecision,
} from "../src/lib/automation-action.js";
import { EXECUTOR_EVIDENCE_CODE, SELF_REPORTED_CODE, executeCatalogueAction, executorEvidenceRef } from "../src/lib/action-executor.js";
import { OPERATOR_AGENT_ACTION_RECEIPT_STEP, OPERATOR_AGENT_ACTION_STEP } from "../src/lib/operator-agent.js";
import { appendPanelLedger } from "../src/lib/panel-actions.js";
import {
  intentPlanActions,
  intentPlanExecution,
  SELF_REPORTED_COMPLETION_IGNORED,
  type IntentPlan,
  type IntentPlanEvent,
  type IntentPlanLinkedAction,
} from "../src/lib/intent-plan.js";
import { CLOCK, HEALTHY, MINUTE, NOW_MS, postJson, rowsAt, tempStatePath, withDelegationService } from "./helpers/delegation-profile-fixture.js";
import { builtPlan, DECISION_PATH, planInput, PROPOSER, planState, readPlans, stepInput } from "./helpers/intent-plan-fixture.js";

/** A catalogued kick: the catalogue entry's own declared risk, approval and rollback. */
const KICK_STEP = stepInput({
  capability: "rmd.task.kick:W1-T1",
  summary: "Kick W1-T1 so the fleet dispatches it next.",
  risk: "high",
  rollback: { mode: "irreversible", refusal: "a dispatched task spends before any undo could land" },
});
const REVIEW_STEP = stepInput({
  capability: "rmd.pr.review:42",
  summary: "Request a review of PR 42.",
  risk: "low",
  rollback: { mode: "irreversible", refusal: "a recorded review request cannot be un-sent" },
});
const CANARY_STEP = stepInput();
const APPROVED: AutomationApprovalDecision = { decision: "approved", decidedBy: PROPOSER, decidedAt: CLOCK.iso() };

function executorRoot(): { root: string; ledgerPath: string } {
  const root = mkdtempSync(join(tmpdir(), "rmd-plan-executor-"));
  mkdirSync(join(root, "state"), { recursive: true });
  return { root, ledgerPath: join(root, "state", "ledger.ndjson") };
}

/** The receipts the EXECUTOR writes for a catalogue action — admission plus its own completion. */
function executorReceipts(action: AutomationAction): AutomationActionReceipt[] {
  const appended: AutomationActionReceipt[] = [];
  const run = executeCatalogueAction({
    action,
    receipts: [],
    approval: APPROVED,
    observations: HEALTHY,
    clock: CLOCK,
    callerTier: "high",
    origin: "test",
    executor: executorRoot(),
    appendReceipt: (receipt) => appended.push(receipt),
  });
  assert.equal(run.disposition, "completed", JSON.stringify(run));
  assert.equal(run.receipt.code, EXECUTOR_EVIDENCE_CODE);
  assert.equal(run.receipt.evidenceRef, executorEvidenceRef(run.executor!));
  return appended;
}

/** The receipts a CALLER produces: an admission, then a completion claim carrying its own
 *  evidenceRef, labelled exactly as POST /v1/operator-agent/actions/complete labels it. */
function callerReceipts(action: AutomationAction, code: string | undefined = SELF_REPORTED_CODE): AutomationActionReceipt[] {
  const admitted = evaluateAutomationAction({ action, observations: HEALTHY, receipts: [], approval: APPROVED, clock: CLOCK, eligibility: [] });
  assert.equal(admitted.disposition, "admitted", JSON.stringify(admitted));
  const completed = completeAutomationAction({
    action,
    receipts: [admitted.receipt],
    admissionReceiptId: admitted.receipt.receiptId,
    outcome: "succeeded",
    evidenceRef: "github:owner/repo/actions/runs/7",
    clock: CLOCK,
  });
  assert.equal(completed.disposition, "completed", JSON.stringify(completed));
  return [admitted.receipt, code === undefined ? completed.receipt : { ...completed.receipt, code }];
}

type Completion = "executor" | "caller" | "legacy";

/** Confirms the plan and links each action to receipts from the named path; the linked state is
 *  the automation-action fold's own reading, so a caller's claim really does read `succeeded`
 *  there — the plan is the only thing that may refuse to count it. */
function execute(plan: IntentPlan, completions: readonly Completion[]) {
  const actions = intentPlanActions(plan, { repo: "owner/repo" });
  const confirm: IntentPlanEvent = { eventId: "ipe-confirm", kind: "confirm", at: CLOCK.iso(), issuer: PROPOSER, actionIds: actions.map((action) => action.actionId) };
  const linked: IntentPlanLinkedAction[] = actions.map((action, index) => {
    const how = completions[index]!;
    const receipts = how === "executor" ? executorReceipts(action) : callerReceipts(action, how === "legacy" ? undefined : SELF_REPORTED_CODE);
    return { action, state: automationActionState(action, receipts, APPROVED, CLOCK), receipts };
  });
  assert.ok(linked.every((item) => item.state === "succeeded"), "every linked action's own fold reads succeeded");
  return intentPlanExecution(planState(plan, [confirm]), linked);
}

test("W1-T4694: a catalogue step with the executor's completion receipt reads succeeded and cites the executor's row", () => {
  const execution = execute(builtPlan({ steps: [KICK_STEP] }), ["executor"]);
  assert.equal(execution.state, "succeeded");
  const [action] = execution.actions;
  assert.equal(action!.state, "succeeded");
  assert.equal(action!.evidenceRule, EXECUTOR_EVIDENCE_CODE);
  assert.match(action!.evidenceRef ?? "", /^ledger:console\.kick_requested@/, "the evidence is the executor's own ledger row");
  assert.equal(action!.reason, undefined);
});

test("W1-T4694: the SAME rmd.task.kick step with only a caller's completion carrying an evidenceRef stays awaiting-receipt, named", () => {
  for (const how of ["caller", "legacy"] as const) {
    const execution = execute(builtPlan({ steps: [KICK_STEP] }), [how]);
    assert.equal(execution.state, "awaiting-receipt", `${how}: a caller's word never finishes a catalogue step`);
    const [action] = execution.actions;
    assert.equal(action!.state, "awaiting-receipt");
    assert.equal(action!.reason, SELF_REPORTED_COMPLETION_IGNORED);
    assert.equal(action!.reason, "self-reported-completion-ignored");
    assert.equal(action!.evidenceRule, EXECUTOR_EVIDENCE_CODE);
    assert.equal(action!.evidenceRef, undefined, "the ignored claim's evidenceRef is never shown as the step's evidence");
  }
});

test("W1-T4694: a step outside the catalogue keeps today's rule and is labelled self-reported", () => {
  const execution = execute(builtPlan({ steps: [CANARY_STEP] }), ["caller"]);
  assert.equal(execution.state, "succeeded");
  assert.deepEqual(execution.actions.map((action) => [action.state, action.evidenceRule, action.evidenceRef, action.reason]), [
    ["succeeded", SELF_REPORTED_CODE, "github:owner/repo/actions/runs/7", undefined],
  ]);
  assert.equal(SELF_REPORTED_CODE, "self-reported");
  const unknownNamespace = execute(builtPlan({ steps: [stepInput({ capability: "deploy.rmd.task.kick" })] }), ["legacy"]);
  assert.equal(unknownNamespace.state, "succeeded", "only the catalogue's own resolver decides; a look-alike name is not catalogued");
  assert.equal(unknownNamespace.actions[0]!.evidenceRule, SELF_REPORTED_CODE);
});

test("W1-T4694: a plan mixing both reads succeeded only when every catalogue step has executor evidence", () => {
  const steps = [KICK_STEP, CANARY_STEP, REVIEW_STEP];
  const mixed = (completions: Completion[]) => execute(builtPlan({ steps }), completions);
  const done = mixed(["executor", "caller", "executor"]);
  assert.equal(done.state, "succeeded");
  assert.deepEqual(done.actions.map((action) => action.evidenceRule), [EXECUTOR_EVIDENCE_CODE, SELF_REPORTED_CODE, EXECUTOR_EVIDENCE_CODE]);
  const onePending = mixed(["executor", "caller", "caller"]);
  assert.equal(onePending.state, "awaiting-receipt", "one catalogue step on a caller's word holds the whole plan");
  assert.deepEqual(onePending.actions.map((action) => [action.state, action.reason ?? null]), [
    ["succeeded", null],
    ["succeeded", null],
    ["awaiting-receipt", SELF_REPORTED_COMPLETION_IGNORED],
  ]);
  assert.equal(mixed(["caller", "caller", "executor"]).state, "awaiting-receipt");
});

test("W1-T4694: receipts read back from the ledger keep the rule — a self-reported completion row for a confirmed kick step does not finish the plan", async () => {
  const path = tempStatePath();
  const planId = await withDelegationService(path, async (base) => {
    const proposed = await postJson(base, "/v1/operator-agent/intent-plans", planInput({ steps: [KICK_STEP] }));
    assert.equal(proposed.status, 201, JSON.stringify(proposed.body));
    const id = proposed.body.planId as string;
    const confirmed = await postJson(base, DECISION_PATH, { planId: id, action: "confirm" });
    assert.equal(confirmed.status, 202, JSON.stringify(confirmed.body));
    return id;
  });
  const registered = rowsAt(path).find((row) => row.step === OPERATOR_AGENT_ACTION_STEP)!.action as AutomationAction;
  assert.equal(registered.actionId, `${planId}:step-1`);
  for (const receipt of callerReceipts(registered)) {
    appendPanelLedger(path, OPERATOR_AGENT_ACTION_RECEIPT_STEP, receipt.actionId, "test", { action_id: receipt.actionId, receipt, ...(receipt.code === SELF_REPORTED_CODE ? { evidence_source: SELF_REPORTED_CODE } : {}) });
  }
  await withDelegationService(path, async (base) => {
    const [plan] = await readPlans(base);
    assert.deepEqual(plan!.execution, {
      state: "awaiting-receipt",
      actions: [{ actionId: registered.actionId, state: "awaiting-receipt", evidenceRule: EXECUTOR_EVIDENCE_CODE, reason: SELF_REPORTED_COMPLETION_IGNORED }],
    });
    assert.equal(plan!.nextDecision, "undo", "the plan stays open to undo while it awaits the executor's receipt");
  }, NOW_MS + MINUTE);
});
