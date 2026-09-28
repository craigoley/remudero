// W1-T3898 acceptance: "an intent plan records outcome, constraints, sources, scope, consequence,
// budget, approval, expiry, and idempotency metadata". A request that is incomplete, unbounded, or
// that CLAIMS an approval is refused by name; the durable row stores the producer's input and the
// fold rebuilds the SAME plan from it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fixedClock } from "../src/lib/clock.js";
import {
  buildIntentPlan,
  foldIntentPlans,
  INTENT_PLAN_AUTHORITY_FIELD_RE,
  INTENT_PLAN_SPEND_MENTION_RE,
  INTENT_PLAN_DEFAULT_TTL_MINUTES,
  INTENT_PLAN_EVENT_LEDGER_STEP,
  INTENT_PLAN_LEDGER_STEP,
  INTENT_PLAN_MAX_EVENTS,
  INTENT_PLAN_MAX_LIST,
  INTENT_PLAN_MAX_STEPS,
  INTENT_PLAN_MAX_SUPPLIED_QUESTIONS,
  INTENT_PLAN_MAX_TTL_MINUTES,
  INTENT_PLAN_REPO_MENTION_RE,
  INTENT_PLAN_SCOPE_ANSWER_RE,
  INTENT_PLAN_USD_ANSWER_RE,
  validateIntentPlanEvent,
} from "../src/lib/intent-plan.js";
import { at, CLOCK, DAY, HOUR, MINUTE, postJson, rowsAt, tempStatePath, withDelegationService } from "./helpers/delegation-profile-fixture.js";
import { builtPlan, planInput, PLANS_PATH, PROPOSER, readPlans, stepInput } from "./helpers/intent-plan-fixture.js";

test("W1-T3898: a built plan records outcome, constraints, sources, scope, consequence, budget, approval, expiry, and idempotency metadata", () => {
  const plan = builtPlan({
    goal: "  Cut canary latency in repo owner/repo without paging anyone.  ",
    constraints: ["Never page the on-call rotation.", " Stay inside business hours. "],
    facts: [{ statement: "p95 latency is 840ms", source: "ledger:queue-latency", observedAt: at(-5 * MINUTE) }],
    questions: [{ id: "window", question: "Which maintenance window applies?" }],
    steps: [
      stepInput(),
      stepInput({ capability: "deploy.promote", risk: "production", estimatedCostUsd: 12.5, rollback: { mode: "irreversible", refusal: "A promotion cannot be recalled; ship a revert instead." } }),
    ],
    scope: { flowId: "flow:canary" },
    budget: { ceilingUsd: 40 },
    freshness: { maxAgeSeconds: 900 },
    expiresInMinutes: 90,
    idempotencyKey: " canary-latency-2026-09 ",
    delegationId: "delegation:owner/repo:flow-runner",
  });
  assert.equal(plan.version, "intent-plan-v1");
  assert.equal(plan.outcome, "Cut canary latency in repo owner/repo without paging anyone.");
  assert.deepEqual(plan.constraints, ["Never page the on-call rotation.", "Stay inside business hours."]);
  assert.deepEqual(plan.facts, [
    { statement: "p95 latency is 840ms", source: "ledger:queue-latency", observedAt: at(-5 * MINUTE), availability: "available" },
    { statement: "the goal names repository owner/repo", source: "goal", observedAt: at(0), availability: "available" },
  ]);
  assert.deepEqual(plan.research, { repositories: ["owner/repo"], ceilingsUsd: [] });
  assert.deepEqual(plan.scope, { flowId: "flow:canary", repo: "owner/repo" }, "research over the goal settled the repository");
  assert.equal(plan.delegationId, "delegation:owner/repo:flow-runner");
  assert.deepEqual(plan.questions, [{ id: "window", question: "Which maintenance window applies?" }]);
  assert.deepEqual(plan.steps.map((step) => [step.stepId, step.approvalPolicy, step.estimatedCostUsd]), [["step-1", "none", 0], ["step-2", "human", 12.5]]);
  assert.deepEqual(plan.consequence, {
    riskTiers: ["low", "production"],
    classes: ["financial", "irreversible"],
    summary: "2 bounded step(s); risk low/production; 1 irreversible; estimated $12.5",
  });
  assert.deepEqual(plan.budget, { estimatedUsd: 12.5, ceilingUsd: 40 });
  assert.deepEqual(plan.approval, { confirmation: "operator", humanGatedSteps: ["step-2"] }, "approval is derived from risk and rollback, never supplied");
  assert.deepEqual(plan.freshness, { maxAgeSeconds: 900 });
  assert.equal(plan.createdAt, CLOCK.iso(), "createdAt is the SERVER clock");
  assert.equal(plan.expiresAt, at(90 * MINUTE));
  assert.equal(plan.idempotencyKey, "canary-latency-2026-09");
  assert.match(plan.planId, /^intent-plan-[0-9a-f]{24}$/);
  assert.equal(plan.proposedBy, PROPOSER);
  assert.deepEqual(plan.preview, { operative: false });
  assert.deepEqual(plan.undo, [
    { stepId: "step-1", mode: "reversible", path: "Route all traffic back to the stable build." },
    { stepId: "step-2", mode: "irreversible", path: "A promotion cannot be recalled; ship a revert instead." },
  ]);
  assert.equal(builtPlan({ idempotencyKey: "canary-latency-2026-09" }).planId, plan.planId, "the plan id derives from the idempotency key alone");
});

test("W1-T3898: defaults — a one-day expiry, an hour's freshness, a derived key, and research over an explicit ceiling", () => {
  const plan = builtPlan({ goal: "Retry flaky jobs for repository owner/repo, spending at most $25 overall.", steps: undefined });
  assert.equal(plan.expiresAt, at(INTENT_PLAN_DEFAULT_TTL_MINUTES * MINUTE));
  assert.equal(INTENT_PLAN_DEFAULT_TTL_MINUTES * MINUTE, DAY);
  assert.deepEqual(plan.freshness, { maxAgeSeconds: HOUR / 1000 });
  assert.match(plan.idempotencyKey, /^intent:[0-9a-f]{24}$/);
  assert.notEqual(builtPlan({ steps: undefined }, fixedClock(CLOCK.now() + 1)).idempotencyKey, plan.idempotencyKey, "a derived key is unique per request instant");
  assert.deepEqual(plan.steps, []);
  assert.deepEqual(plan.consequence, { riskTiers: [], classes: [], summary: "no bounded step proposed yet; nothing can run from this plan" });
  assert.deepEqual(plan.budget, { estimatedUsd: 0, ceilingUsd: 25 });
  assert.deepEqual(plan.facts.map((fact) => fact.statement), ["the goal names repository owner/repo", "the goal caps spend at $25"]);
  const two = builtPlan({ goal: "Compare repo a/one against repo b/two, under $5 or at most $9." });
  assert.deepEqual(two.research, { repositories: ["a/one", "b/two"], ceilingsUsd: [5, 9] });
  assert.deepEqual(two.scope, {}, "two named repositories settle nothing");
  assert.equal(two.budget.ceilingUsd, undefined, "two stated ceilings settle nothing");
  const instance = builtPlan({ scope: { instance: "prod-1" } });
  assert.deepEqual(instance.scope, { instance: "prod-1" }, "a supplied scope wins over research");
});

test("W1-T3898: the goal research patterns match explicit references only", () => {
  assert.equal(INTENT_PLAN_REPO_MENTION_RE.test("fix CI in repo owner/repo today"), true);
  assert.equal(INTENT_PLAN_REPO_MENTION_RE.test("see https://github.com/owner/repo/pulls"), true);
  assert.equal(INTENT_PLAN_REPO_MENTION_RE.test("fix src/lib/serve.ts and/or the docs"), false, "a bare path or and/or is never a repository");
  assert.equal(INTENT_PLAN_SPEND_MENTION_RE.test("spend no more than $30"), true);
  assert.equal(INTENT_PLAN_SPEND_MENTION_RE.test("it costs $30 a day now"), false, "a price is not a ceiling");
  assert.equal(INTENT_PLAN_SCOPE_ANSWER_RE.test("repo owner/repo"), true);
  assert.equal(INTENT_PLAN_SCOPE_ANSWER_RE.test("instance prod-1"), true);
  assert.equal(INTENT_PLAN_SCOPE_ANSWER_RE.test("probably the main one"), false);
  assert.equal(INTENT_PLAN_USD_ANSWER_RE.test("$40 USD"), true);
  assert.equal(INTENT_PLAN_USD_ANSWER_RE.test("whatever it takes"), false);
  assert.equal(INTENT_PLAN_AUTHORITY_FIELD_RE.test("approved"), true);
  assert.equal(INTENT_PLAN_AUTHORITY_FIELD_RE.test("goal"), false);
});

test("W1-T3898: an incomplete, unbounded, or authority-claiming request is refused by name", () => {
  const cases: Array<[string, unknown, string, string?]> = [
    ["not an object", "promote the canary", "not-an-object"],
    ["a raw prompt", planInput({ prompt: "do it" }), "forbidden-field", "prompt"],
    ["a credential value", planInput({ goal: "use password: hunter2 for repo owner/repo" }), "secret-value"],
    ["model confidence", planInput({ confidence: 0.99 }), "non-authoritative-signal", "confidence"],
    ["a claimed approval", planInput({ approved: true }), "authority-claim", "approved"],
    ["a supplied step approval", planInput({ steps: [stepInput({ approval: { policy: "none" } })] }), "authority-claim", "steps.0.approval"],
    ["an unknown field", planInput({ daemonUrl: "http://x" }), "unknown-field", "daemonUrl"],
    ["no goal", planInput({ goal: " " }), "missing-outcome"],
    ["an unbounded goal", planInput({ goal: "g".repeat(4_001) }), "missing-outcome"],
    ["a non-string constraint", planInput({ constraints: [7] }), "invalid-constraints"],
    ["facts not a list", planInput({ facts: "all green" }), "invalid-facts"],
    ["a fact with no source", planInput({ facts: [{ statement: "green", observedAt: at(0) }] }), "invalid-facts"],
    ["a fact from the future", planInput({ facts: [{ statement: "green", source: "ledger:health", observedAt: at(MINUTE) }] }), "invalid-facts"],
    ["an unknown availability", planInput({ facts: [{ statement: "green", source: "ledger:health", observedAt: at(0), availability: "maybe" }] }), "invalid-facts"],
    ["questions not a list", planInput({ questions: {} }), "invalid-questions"],
    ["a question with no text", planInput({ questions: [{ id: "q" }] }), "invalid-questions"],
    ["too many distinct questions", planInput({ questions: Array.from({ length: INTENT_PLAN_MAX_SUPPLIED_QUESTIONS + 1 }, (_, i) => ({ id: `q${i}`, question: `Question number ${i}?` })) }), "invalid-questions"],
    ["an unknown scope key", planInput({ scope: { fleet: "all" } }), "invalid-scope"],
    ["an unbounded scope", planInput({ scope: { repo: "r".repeat(161) } }), "invalid-scope"],
    ["an unbounded delegationId", planInput({ delegationId: "" }), "invalid-scope", "delegationId"],
    ["a budget that is not an object", planInput({ budget: 5 }), "invalid-budget"],
    ["a negative ceiling", planInput({ budget: { ceilingUsd: -1 } }), "invalid-budget"],
    ["an unknown budget key", planInput({ budget: { spend: 1 } }), "invalid-budget"],
    ["freshness not an object", planInput({ freshness: 60 }), "invalid-freshness"],
    ["an unbounded freshness", planInput({ freshness: { maxAgeSeconds: 0 } }), "invalid-freshness"],
    ["an unbounded expiry", planInput({ expiresInMinutes: INTENT_PLAN_MAX_TTL_MINUTES + 1 }), "invalid-expiry"],
    ["an unbounded idempotency key", planInput({ idempotencyKey: "k".repeat(141) }), "invalid-idempotency-key"],
    ["steps not a list", planInput({ steps: {} }), "invalid-steps"],
    ["too many steps", planInput({ steps: Array.from({ length: INTENT_PLAN_MAX_STEPS + 1 }, () => stepInput()) }), "invalid-steps"],
    ["a non-object step", planInput({ steps: ["deploy"] }), "invalid-steps", "steps.0"],
    ["an unknown step field", planInput({ steps: [stepInput({ command: "rm -rf" })] }), "invalid-steps", "steps.0"],
    ["a negative step cost", planInput({ steps: [stepInput({ estimatedCostUsd: -2 })] }), "invalid-steps", "steps.0"],
    ["a step without a rollback path", planInput({ steps: [stepInput({ rollback: undefined })] }), "invalid-steps", "steps.0"],
  ];
  for (const [label, input, code, field] of cases) {
    const built = buildIntentPlan(input, { clock: CLOCK, proposedBy: PROPOSER });
    assert.equal(built.ok, false, `${label} must be refused`);
    if (built.ok) continue;
    assert.equal(built.code, code, `${label}: ${built.reason}`);
    if (field) assert.equal(built.field, field, label);
  }
  const lean = buildIntentPlan(planInput({ constraints: Array.from({ length: INTENT_PLAN_MAX_LIST }, (_, i) => `constraint ${i}`) }), { clock: CLOCK, proposedBy: PROPOSER });
  assert.ok(lean.ok, "the list bound admits exactly its own size");
});

test("W1-T3898: the ledger row stores the request, and the fold rebuilds the identical plan", () => {
  const plan = builtPlan();
  const row = { step: INTENT_PLAN_LEDGER_STEP, input: planInput(), created_at: plan.createdAt, proposed_by: PROPOSER };
  const good = { eventId: "ipe-1", kind: "clarify", at: at(0), issuer: PROPOSER, questionId: "window", answer: "Saturdays" };
  const rows = [
    row,
    { ...row, input: planInput({ goal: " " }) },
    { ...row, created_at: "yesterday" },
    { ...row, proposed_by: 7 },
    row,
    { step: INTENT_PLAN_EVENT_LEDGER_STEP, plan_id: plan.planId, event: good },
    { step: INTENT_PLAN_EVENT_LEDGER_STEP, plan_id: plan.planId, event: good },
    { step: INTENT_PLAN_EVENT_LEDGER_STEP, plan_id: "intent-plan-unknown", event: { ...good, eventId: "ipe-2" } },
    { step: INTENT_PLAN_EVENT_LEDGER_STEP, plan_id: 42, event: { ...good, eventId: "ipe-3" } },
    { step: INTENT_PLAN_EVENT_LEDGER_STEP, plan_id: plan.planId, event: { ...good, eventId: "ipe-4", kind: "approve" } },
    { step: "panel.unrelated" },
  ];
  const states = foldIntentPlans(rows);
  assert.equal(states.length, 1, "the first row per plan id wins; an invalid row never enters");
  assert.deepEqual(states[0]!.plan, plan, "the rebuilt plan equals the one the route answered with");
  assert.deepEqual(states[0]!.events, [good], "events append deduplicated by id; a foreign or malformed event never enters");
  const later = builtPlan({ idempotencyKey: "later" }, fixedClock(CLOCK.now() + HOUR));
  const sorted = foldIntentPlans([row, { ...row, input: planInput({ idempotencyKey: "later" }), created_at: later.createdAt }]);
  assert.deepEqual(sorted.map((state) => state.plan.planId), [later.planId, plan.planId], "newest first");
  const flood = Array.from({ length: INTENT_PLAN_MAX_EVENTS + 5 }, (_, i) => ({ step: INTENT_PLAN_EVENT_LEDGER_STEP, plan_id: plan.planId, event: { ...good, eventId: `ipe-f${i}` } }));
  assert.equal(foldIntentPlans([row, ...flood])[0]!.events.length, INTENT_PLAN_MAX_EVENTS, "the event backstop holds on read-back too");
});

test("W1-T3898: an event read back from the ledger is re-validated field by field", () => {
  const base = { eventId: "ipe-1", at: at(0), issuer: PROPOSER };
  const undoStep = { stepId: "step-1", actionId: "a:1", result: "rollback-requested", detail: "Route traffic back.", code: "c", linkedReceiptId: "aar-1" };
  assert.deepEqual(validateIntentPlanEvent({ ...base, kind: "confirm", actionIds: ["a:1"], note: "go" }), { ...base, kind: "confirm", actionIds: ["a:1"], note: "go" });
  assert.deepEqual(validateIntentPlanEvent({ ...base, kind: "undo", outcome: "requested", steps: [undoStep] }), { ...base, kind: "undo", outcome: "requested", steps: [undoStep] });
  assert.deepEqual(validateIntentPlanEvent({ ...base, kind: "undo", outcome: "withdrawn", steps: [] }), { ...base, kind: "undo", outcome: "withdrawn", steps: [] });
  const invalid: unknown[] = [
    null,
    { ...base, eventId: "", kind: "confirm", actionIds: [] },
    { ...base, kind: "confirm", actionIds: [], token: "x" },
    { ...base, kind: "confirm", actionIds: [], note: "" },
    { ...base, kind: "confirm", actionIds: "a:1" },
    { ...base, kind: "clarify", questionId: "scope" },
    { ...base, kind: "undo", outcome: "done", steps: [] },
    { ...base, kind: "undo", outcome: "requested", steps: {} },
    { ...base, kind: "undo", outcome: "requested", steps: [{ ...undoStep, result: "erased" }] },
    { ...base, kind: "undo", outcome: "requested", steps: [{ ...undoStep, code: "" }] },
    { ...base, kind: "undo", outcome: "requested", steps: [{ ...undoStep, linkedReceiptId: "" }] },
    { ...base, kind: "undo", outcome: "requested", steps: [{ stepId: "step-1" }] },
    { ...base, kind: "undo", outcome: "requested", steps: [7] },
  ];
  for (const value of invalid) assert.equal(validateIntentPlanEvent(value), null, JSON.stringify(value));
});

test("W1-T3898: POST /v1/operator-agent/intent-plans records the request and answers with the console's intent-plan-v1 read shape", async () => {
  const path = tempStatePath();
  await withDelegationService(path, async (base) => {
    const proposed = await postJson(base, PLANS_PATH, planInput({ idempotencyKey: "canary-1", constraints: ["Never page anyone."] }));
    assert.equal(proposed.status, 201, JSON.stringify(proposed.body));
    const body = proposed.body;
    assert.equal(body.ok, true);
    assert.equal(body.existing, false);
    for (const field of ["planId", "goal", "constraints", "unknowns", "scope", "consequence", "freshness", "nextDecision", "observedAt", "receipts", "source"]) {
      assert.ok(field in body, `the console reads ${field} at the top level`);
    }
    assert.equal(body.goal, "Promote the canary in repo owner/repo once health is green.");
    assert.deepEqual(body.scope, { repository: "owner/repo" });
    assert.deepEqual(body.consequence, { classes: [], summary: "1 bounded step(s); risk low; 0 irreversible; estimated $0" });
    assert.equal(body.freshness, "verified");
    assert.equal(body.nextDecision, "confirm");
    assert.equal(body.source, "rmd:core:/v1/operator-agent/intent-plans");
    assert.equal((body.receipts as Array<{ kind: string }>)[0]!.kind, "propose");

    const rows = rowsAt(path).filter((row) => row.step === INTENT_PLAN_LEDGER_STEP);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.plan_id, body.planId);
    assert.deepEqual(rows[0]!.input, planInput({ idempotencyKey: "canary-1", constraints: ["Never page anyone."] }), "the durable row is the request itself");

    const replay = await postJson(base, PLANS_PATH, planInput({ idempotencyKey: "canary-1", constraints: ["Never page anyone."] }));
    assert.equal(replay.status, 200, "an identical request under the same key is the same plan");
    assert.equal(replay.body.existing, true);
    const conflict = await postJson(base, PLANS_PATH, planInput({ idempotencyKey: "canary-1" }));
    assert.equal(conflict.status, 409, "a different request under the same key is refused");
    assert.equal((await postJson(base, PLANS_PATH, planInput({ approved: true }))).status, 400);
    assert.equal((await postJson(base, PLANS_PATH, ["goal"])).status, 400);
    assert.equal(rowsAt(path).filter((row) => row.step === INTENT_PLAN_LEDGER_STEP).length, 1, "nothing but the first proposal was recorded");

    const plans = await readPlans(base);
    assert.equal(plans.length, 1);
    assert.equal(plans[0]!.planId, body.planId);
    assert.equal((plans[0]!.plan as { version: string }).version, "intent-plan-v1");
    assert.equal(plans[0]!.status, "draft");
  });
});
