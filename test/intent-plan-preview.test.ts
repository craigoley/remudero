// W1-T3898 acceptance: "a plan preview is non-operative and preserves stale, unavailable, ambiguous,
// and over-budget states". A preview registers, approves, and executes nothing; every blocking state
// keeps its own name instead of collapsing into a healthy-looking plan.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fixedClock } from "../src/lib/clock.js";
import { OPERATOR_AGENT_ACTION_STEP } from "../src/lib/operator-agent.js";
import { previewIntentPlan, projectIntentPlan, type IntentPlan, type IntentPlanEvent } from "../src/lib/intent-plan.js";
import { at, builtProfile, CLOCK, DAY, HOUR, MINUTE, NOW_MS, postJson, stateOf, stepsAt, tempStatePath, withDelegationService } from "./helpers/delegation-profile-fixture.js";
import { answerEvent, builtPlan, planInput, PLANS_PATH, planState, readPlans, stepInput } from "./helpers/intent-plan-fixture.js";

const preview = (plan: IntentPlan, events: IntentPlanEvent[] = [], clock = CLOCK) => previewIntentPlan({ plan, events, clock });
const codes = (plan: IntentPlan, events: IntentPlanEvent[] = [], clock = CLOCK) => preview(plan, events, clock).findings.map((finding) => finding.code);

test("W1-T3898: a complete plan previews ready, and a preview is structurally non-operative", () => {
  const result = preview(builtPlan());
  assert.equal(result.operative, false);
  assert.equal(result.state, "ready");
  assert.deepEqual(result.findings, []);
  assert.equal(result.evaluatedAt, CLOCK.iso());
  assert.deepEqual(result.scope, { repo: "owner/repo" });
});

test("W1-T3898: the preview preserves stale, unavailable, ambiguous, and over-budget states by name", () => {
  const stale = builtPlan({ facts: [{ statement: "health is green", source: "ledger:health", observedAt: at(-10 * MINUTE) }], freshness: { maxAgeSeconds: 300 } });
  assert.equal(preview(stale).state, "stale");
  assert.deepEqual(codes(stale), ["fact-stale"]);
  assert.equal(preview(builtPlan({ facts: [{ statement: "health is green", source: "ledger:health", observedAt: at(-MINUTE) }], freshness: { maxAgeSeconds: 300 } })).state, "ready", "a fresh fact is fine");

  const unavailable = builtPlan({ facts: [{ statement: "fleet health", source: "ledger:health", observedAt: at(-MINUTE), availability: "unavailable" }] });
  assert.equal(preview(unavailable).state, "unavailable");
  assert.deepEqual(codes(unavailable), ["source-unavailable"]);
  const stepless = builtPlan({ steps: undefined });
  assert.equal(preview(stepless).state, "unavailable", "a sentence alone never becomes an action");
  assert.deepEqual(codes(stepless), ["no-bounded-step"]);

  const ambiguous = builtPlan({ goal: "Retry jobs in repo a/one and repo b/two." });
  assert.equal(preview(ambiguous).state, "ambiguous");
  assert.deepEqual(codes(ambiguous), ["ambiguous-scope", "open-questions"]);
  assert.equal(preview(ambiguous, [answerEvent("scope", "a/one", 1)]).state, "ready", "an answer resolves the ambiguity");

  const overBudget = builtPlan({ steps: [stepInput({ estimatedCostUsd: 30 })], budget: { ceilingUsd: 20 } });
  assert.equal(preview(overBudget).state, "over-budget");
  assert.deepEqual(codes(overBudget), ["over-budget"]);
  const answeredOver = builtPlan({ steps: [stepInput({ estimatedCostUsd: 30 })] });
  assert.equal(preview(answeredOver, [answerEvent("budget-ceiling", "$10", 1)]).state, "over-budget", "an answered ceiling is enforced too");

  const expired = builtPlan();
  assert.equal(preview(expired, [], fixedClock(NOW_MS + 2 * DAY)).state, "expired");
  assert.deepEqual(codes(stale, [], fixedClock(NOW_MS + 2 * DAY)), ["plan-expired", "fact-stale"], "every finding is kept; the state is the first by precedence");

  const needs = builtPlan({ goal: "Retry the flaky jobs." });
  assert.equal(preview(needs).state, "needs-clarification");
  assert.equal(preview(needs, [answerEvent("scope", "not sure", 1)]).state, "clarification-exhausted");
});

test("W1-T3898: a plan acting under a delegation previews the profile's refusals, never its human gate", () => {
  const delegated = builtPlan({ delegationId: "delegation:owner/repo:flow-runner", scope: { flowId: "flow:canary" }, steps: [stepInput({ risk: "production" })] });
  const profile = builtProfile();
  const ready = previewIntentPlan({ plan: delegated, events: [], clock: CLOCK, delegation: stateOf(profile) });
  assert.equal(ready.state, "ready", "a production step's own human gate is decided after confirmation, not here");
  const missing = previewIntentPlan({ plan: delegated, events: [], clock: CLOCK });
  assert.equal(missing.state, "refused");
  assert.deepEqual(missing.findings.map((finding) => [finding.code, finding.stepId]), [["delegation-profile-missing", "step-1"]]);
  const pending = previewIntentPlan({ plan: delegated, events: [], clock: CLOCK, delegation: stateOf(profile, { approval: "pending", acceptedAt: undefined }) });
  assert.deepEqual(pending.findings.map((finding) => finding.code), ["delegation-profile-not-approved"]);
  const outside = builtPlan({ delegationId: "delegation:owner/repo:flow-runner", scope: { flowId: "flow:canary", repo: "owner/other" } });
  assert.deepEqual(previewIntentPlan({ plan: outside, events: [], clock: CLOCK, delegation: stateOf(profile) }).findings.map((finding) => finding.code), ["delegation-scope-mismatch"]);
  const unscoped = builtPlan({ delegationId: "delegation:owner/repo:flow-runner", goal: "Promote the canary." });
  assert.deepEqual(codes(unscoped), ["open-questions"], "eligibility waits for a resolved scope");
});

test("W1-T3898: the projection maps preview states onto the console's freshness and next decision", () => {
  const project = (plan: IntentPlan, events: IntentPlanEvent[] = [], clock = CLOCK) => projectIntentPlan(planState(plan, events), [], clock);
  const stale = builtPlan({ facts: [{ statement: "green", source: "ledger:health", observedAt: at(-2 * HOUR) }] });
  assert.deepEqual([project(stale).freshness, project(stale).nextDecision], ["stale", "none"]);
  assert.deepEqual([project(builtPlan(), [], fixedClock(NOW_MS + 2 * DAY)).freshness, project(builtPlan(), [], fixedClock(NOW_MS + 2 * DAY)).nextDecision], ["stale", "none"]);
  assert.deepEqual([project(builtPlan({ steps: undefined })).freshness, project(builtPlan({ steps: undefined })).nextDecision], ["unavailable", "none"]);
  const ambiguous = project(builtPlan({ goal: "Retry jobs in repo a/one and repo b/two." }));
  assert.deepEqual([ambiguous.freshness, ambiguous.nextDecision], ["verified", "answer_clarification"]);
  const over = project(builtPlan({ steps: [stepInput({ estimatedCostUsd: 30 })], budget: { ceilingUsd: 20 } }));
  assert.deepEqual([over.freshness, over.nextDecision], ["verified", "none"]);
  assert.deepEqual(over.consequence, { classes: ["financial"], summary: "1 bounded step(s); risk low; 0 irreversible; estimated $30", budgetUsd: 30, ceilingUsd: 20 });
  const ready = project(builtPlan());
  assert.deepEqual([ready.freshness, ready.nextDecision, ready.status], ["verified", "confirm", "draft"]);
  assert.deepEqual(project(builtPlan({ scope: { instance: "prod-1" } })).scope, { repository: "(instance scope)", instanceId: "prod-1" });
  assert.equal(ready.preview.operative, false);
});

test("W1-T3898: proposing and previewing over HTTP registers, approves, and executes nothing", async () => {
  const path = tempStatePath();
  await withDelegationService(path, async (base) => {
    const proposed = await postJson(base, PLANS_PATH, planInput({ steps: [stepInput({ risk: "production" })] }));
    assert.equal(proposed.status, 201);
    const planId = proposed.body.planId as string;
    const [plan] = await readPlans(base);
    assert.equal((plan!.preview as { operative: boolean; state: string }).operative, false);
    assert.equal((plan!.preview as { state: string }).state, "ready");
    assert.deepEqual(plan!.confirmation, { state: "none" });
    assert.deepEqual(plan!.execution, { state: "not-requested", actions: [] });
    assert.equal(stepsAt(path).includes(OPERATOR_AGENT_ACTION_STEP), false, "no automation action was registered by a proposal or a read");
    const execute = await postJson(base, "/v1/operator-agent/actions/execute", { actionId: `${planId}:step-1`, observations: [] });
    assert.equal(execute.status, 404, "a previewed step does not exist as an action until a confirmation requests it");
  });
});
