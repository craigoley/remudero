// W1-T3898 acceptance: "clarification asks only unresolved questions, deduplicates them, and stops at
// a bounded round limit". W1-T2499's discipline off onboarding: research first, ask only what it
// left open (each question stating what it established), never ask one question twice, and report
// `exhausted` rather than asking forever.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fixedClock } from "../src/lib/clock.js";
import {
  clarifyIntentPlan,
  INTENT_PLAN_EVENT_LEDGER_STEP,
  INTENT_PLAN_MAX_EVENTS,
  INTENT_PLAN_MAX_ROUNDS,
  intentPlanClarification,
  resolveIntentPlan,
  type IntentPlanEvent,
} from "../src/lib/intent-plan.js";
import { DEFAULT_MAX_ROUNDS } from "../src/lib/reply-interpreter.js";
import { CLOCK, DAY, NOW_MS, postJson, rowsAt, tempStatePath, withDelegationService } from "./helpers/delegation-profile-fixture.js";
import { answerEvent, builtPlan, DECISION_PATH, planInput, PLANS_PATH, PROPOSER, readPlans, planState, stepInput } from "./helpers/intent-plan-fixture.js";

const COSTLY = [stepInput({ estimatedCostUsd: 8 })];

test("W1-T3898: research runs first — a question it settled is never asked", () => {
  const settled = builtPlan({ goal: "Retry flaky jobs in repo owner/repo, spending at most $20.", steps: COSTLY });
  assert.deepEqual(intentPlanClarification(settled, []), { state: "understood", open: [], unresolved: [], roundsUsed: 0, maxRounds: INTENT_PLAN_MAX_ROUNDS });
  assert.equal(INTENT_PLAN_MAX_ROUNDS, DEFAULT_MAX_ROUNDS, "the round budget is W1-T2499's own, reused");
  const free = builtPlan({ goal: "Retry flaky jobs in repo owner/repo." });
  assert.equal(intentPlanClarification(free, []).state, "understood", "a plan estimating no spend never asks for a ceiling");
});

test("W1-T3898: clarification asks only unresolved questions, each stating what research established", () => {
  const plan = builtPlan({ goal: "Retry the flaky jobs.", steps: COSTLY, questions: [{ id: "window", question: "Which maintenance window applies?" }] });
  const clarification = intentPlanClarification(plan, []);
  assert.equal(clarification.state, "clarifying");
  assert.deepEqual(clarification.open.map((question) => question.id), ["scope", "budget-ceiling", "window"]);
  assert.deepEqual(clarification.open.map((question) => question.established), [
    "the goal names no repository and no scope was supplied",
    "the proposed steps estimate $8 and no single spend ceiling was stated",
    "the proposer could not settle this from its own sources",
  ]);
  const ambiguous = builtPlan({ goal: "Retry jobs in repo a/one and repo b/two." });
  assert.equal(intentPlanClarification(ambiguous, []).open[0]!.established, "the goal names 2 repositories: a/one, b/two");
});

test("W1-T3898: supplied questions are deduplicated by id and by text, and never shadow a built-in", () => {
  const plan = builtPlan({
    questions: [
      { id: "window", question: "Which maintenance window applies?" },
      { id: "window", question: "A different question under the same id?" },
      { id: "window-2", question: "  which MAINTENANCE   window applies? " },
      { id: "scope", question: "Shadowing the built-in scope question?" },
      { id: "owner", question: "Who owns the rollback?" },
    ],
  });
  assert.deepEqual(plan.questions, [
    { id: "window", question: "Which maintenance window applies?" },
    { id: "owner", question: "Who owns the rollback?" },
  ]);
});

test("W1-T3898: answers resolve the plan, and a question already answered is never asked again", () => {
  const plan = builtPlan({ goal: "Retry the flaky jobs.", steps: COSTLY });
  const repo = [answerEvent("scope", "repo owner/repo", 1), answerEvent("budget-ceiling", "$30", 2)];
  assert.deepEqual(resolveIntentPlan(plan, repo).scope, { repo: "owner/repo" });
  assert.equal(resolveIntentPlan(plan, repo).ceilingUsd, 30);
  assert.equal(intentPlanClarification(plan, repo).state, "understood");
  assert.deepEqual(resolveIntentPlan(plan, [answerEvent("scope", "instance prod-1", 1)]).scope, { instance: "prod-1" });

  const vague = [answerEvent("scope", "the usual one", 1)];
  const after = intentPlanClarification(plan, vague);
  assert.equal(after.state, "clarifying");
  assert.deepEqual(after.open.map((question) => question.id), ["budget-ceiling"], "the answered question leaves the open set even though it stays unresolved");
  assert.deepEqual(after.unresolved.map((question) => question.id), ["scope", "budget-ceiling"]);
  const again = clarifyIntentPlan({ state: planState(plan, vague), questionId: "scope", answer: "repo owner/repo", issuer: PROPOSER, clock: CLOCK });
  assert.equal(again.disposition, "refused");
  assert.equal(again.disposition === "refused" && again.code, "already-asked");

  const spent = [...vague, answerEvent("budget-ceiling", "enough", 2)];
  const exhausted = intentPlanClarification(plan, spent);
  assert.equal(exhausted.state, "exhausted", "nothing unresolved is askable any more: stop, do not ask again");
  assert.deepEqual(exhausted.open, []);
  assert.deepEqual(exhausted.unresolved.map((question) => question.id), ["scope", "budget-ceiling"]);
});

test("W1-T3898: clarification stops at the bounded round limit even with a question still open", () => {
  const plan = builtPlan({ goal: "Retry the flaky jobs.", steps: COSTLY });
  const rounds: IntentPlanEvent[] = Array.from({ length: INTENT_PLAN_MAX_ROUNDS }, (_, i) => answerEvent(`stray-${i}`, "noise", i));
  const clarification = intentPlanClarification(plan, rounds);
  assert.equal(clarification.state, "exhausted");
  assert.equal(clarification.roundsUsed, INTENT_PLAN_MAX_ROUNDS);
  assert.deepEqual(clarification.open, []);
  const refused = clarifyIntentPlan({ state: planState(plan, rounds), questionId: "scope", answer: "repo owner/repo", issuer: PROPOSER, clock: CLOCK });
  assert.equal(refused.disposition === "refused" && refused.code, "clarification-exhausted");
  const oneShort = rounds.slice(1);
  assert.equal(intentPlanClarification(plan, oneShort).state, "clarifying", "one round under the bound still asks");
});

test("W1-T3898: an answer is refused for a closed, expired, or unknown question, an unsafe answer, or a full history", () => {
  const plan = builtPlan({ goal: "Retry the flaky jobs.", steps: COSTLY });
  const ask = (events: IntentPlanEvent[], questionId = "scope", answer = "repo owner/repo", clock = CLOCK) =>
    clarifyIntentPlan({ state: planState(plan, events), questionId, answer, issuer: PROPOSER, clock });
  const code = (result: ReturnType<typeof ask>) => (result.disposition === "refused" ? result.code : result.disposition);
  const confirm: IntentPlanEvent = { eventId: "ipe-c", kind: "confirm", at: CLOCK.iso(), issuer: PROPOSER, actionIds: [] };
  const withdraw: IntentPlanEvent = { eventId: "ipe-w", kind: "undo", at: CLOCK.iso(), issuer: PROPOSER, outcome: "withdrawn", steps: [] };
  assert.equal(code(ask([confirm])), "plan-closed");
  assert.equal(code(ask([withdraw])), "plan-closed");
  assert.equal(code(ask([], "scope", "repo owner/repo", fixedClock(NOW_MS + 2 * DAY))), "plan-expired");
  assert.equal(code(ask([], "scope", "use password: hunter2")), "invalid-answer");
  assert.equal(code(ask([], "scope", " ")), "invalid-answer");
  assert.equal(code(ask([], "nonexistent")), "not-open");
  const noise = Array.from({ length: INTENT_PLAN_MAX_EVENTS }, (_, i) => ({ ...withdraw, eventId: `ipe-n${i}`, outcome: "refused" as const }));
  assert.equal(code(ask(noise)), "event-history-full");
  const recorded = ask([]);
  assert.equal(recorded.disposition, "recorded");
  assert.ok(recorded.disposition === "recorded" && recorded.event.kind === "clarify" && recorded.event.answer === "repo owner/repo");
});

test("W1-T3898: POST /intent-plans/decision records one answer as a linked event and refuses asking twice", async () => {
  const path = tempStatePath();
  await withDelegationService(path, async (base) => {
    const proposed = await postJson(base, PLANS_PATH, planInput({ goal: "Retry the flaky jobs.", steps: COSTLY }));
    assert.equal(proposed.status, 201);
    const planId = proposed.body.planId as string;
    assert.equal(proposed.body.nextDecision, "answer_clarification");
    assert.equal(proposed.body.freshness, "verified");
    const unknowns = proposed.body.unknowns as Array<{ id: string; question: string }>;
    assert.deepEqual(unknowns.map((unknown) => unknown.id), ["scope", "budget-ceiling"]);
    assert.match(unknowns[0]!.question, /\(already established: the goal names no repository and no scope was supplied\)$/);
    assert.deepEqual(proposed.body.scope, { repository: "(unresolved)" });
    assert.deepEqual(proposed.body.consequence, { classes: ["financial"], summary: "1 bounded step(s); risk low; 0 irreversible; estimated $8", budgetUsd: 8 });

    const answered = await postJson(base, DECISION_PATH, { planId, action: "clarify", questionId: "scope", answer: "repo owner/repo" });
    assert.equal(answered.status, 200, JSON.stringify(answered.body));
    assert.equal(answered.body.disposition, "recorded");
    assert.equal(typeof answered.body.at, "string", "the console reads `at` as the receipt time");
    const events = rowsAt(path).filter((row) => row.step === INTENT_PLAN_EVENT_LEDGER_STEP);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.plan_id, planId);

    const twice = await postJson(base, DECISION_PATH, { planId, action: "clarify", questionId: "scope", answer: "repo owner/other" });
    assert.equal(twice.status, 409);
    assert.equal(twice.body.code, "already-asked");
    assert.equal(rowsAt(path).filter((row) => row.step === INTENT_PLAN_EVENT_LEDGER_STEP).length, 1, "a refused answer records nothing");

    const [plan] = await readPlans(base);
    assert.deepEqual(plan!.scope, { repository: "owner/repo" });
    assert.deepEqual((plan!.unknowns as Array<{ id: string }>).map((unknown) => unknown.id), ["budget-ceiling"]);
    const receipts = plan!.receipts as Array<{ kind: string; note?: string }>;
    assert.deepEqual(receipts.map((receipt) => [receipt.kind, receipt.note]), [["propose", undefined], ["clarify", "answered scope"]]);

    const malformed: Array<[unknown, number]> = [
      [{ planId, action: "clarify", questionId: "budget-ceiling" }, 400],
      [{ planId, action: "clarify", questionId: "budget-ceiling", answer: "$5", note: "x" }, 400],
      [{ planId, action: "approve" }, 400],
      [{ action: "undo" }, 400],
      [{ planId, action: "undo", note: "" }, 400],
      [{ planId, action: "confirm", confirm: false }, 400],
      [{ planId, action: "confirm", confidence: 0.99 }, 400],
      [{ planId, action: "confirm", transcript: "yes" }, 400],
      [{ planId: "intent-plan-missing", action: "undo" }, 404],
    ];
    for (const [body, status] of malformed) assert.equal((await postJson(base, DECISION_PATH, body)).status, status, JSON.stringify(body));
  });
});
