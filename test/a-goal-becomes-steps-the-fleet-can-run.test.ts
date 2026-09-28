// W1-T4658 acceptance: "a goal a recogniser matches yields catalogue-only steps with cited evidence
// that preview ready, and a goal none matches yields zero steps and a clarification question rather
// than a guessed step". The planner's vocabulary is exactly W1-T4657's executor catalogue; its
// evidence is the board projection and the fleet-control flags; its output goes through
// buildIntentPlan and the W1-T3898 preview unchanged.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ACTION_CATALOGUE, executeCatalogueAction, resolveCatalogueCapability } from "../src/lib/action-executor.js";
import type { AutomationAction, AutomationActionReceipt } from "../src/lib/automation-action.js";
import { fixedClock } from "../src/lib/clock.js";
import { isPaused, pauseFilePath, stopFilePath } from "../src/lib/fleet-control.js";
import { buildIntentPlan, INTENT_PLAN_LEDGER_STEP, intentPlanActions, previewIntentPlan, type IntentPlan } from "../src/lib/intent-plan.js";
import {
  boardPrReading,
  boardTaskReading,
  fleetReading,
  goalEvidenceReader,
  GOAL_UNRESOLVED_QUESTION_ID,
  planStepsForGoal,
  withPlannedSteps,
  type GoalBoardView,
  type GoalEvidenceReader,
  type GoalStepPlan,
} from "../src/lib/intent-planner.js";
import { buildOperatorAgentRoutes } from "../src/lib/operator-agent.js";
import type { Plan, Task } from "../src/lib/plan.js";
import { createService } from "../src/lib/service.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { at, CLOCK, HOUR, MINUTE, NOW_MS, READ_TOKEN, rowsAt, tempStatePath, WRITE_TOKEN } from "./helpers/delegation-profile-fixture.js";
import { stepInput } from "./helpers/intent-plan-fixture.js";

const PROPOSER = "operator:owner";
const PLANS_PATH = "/v1/operator-agent/intent-plans";
const PR_URL = "https://github.com/owner/repo/pull/42";

const RED = { prNumber: 42, repo: "owner/repo", headSha: "abc1234def", disposition: "blocked-fixable", reason: "required checks red", reviewState: "none", observedAt: at(-5 * MINUTE), source: "/v1/status#prQueue" };
const GREEN_UNREVIEWED = { ...RED, disposition: "post-review", reason: "checks green, remudero-review never posted on this head" };
const ELIGIBLE = { taskId: "W1-T1", eligible: true, reason: "every dependency merged; no run in flight; no open PR", budgetUsd: 0, observedAt: at(-MINUTE), source: "/v1/status#tasks" };
const RUNNING_FLEET = { paused: false, stopped: false, observedAt: at(0), source: "fleet-control:state/PAUSE+STOP" };

/** A reader answering each question with exactly the reading a test names; anything unnamed is unavailable. */
function reader(readings: { pr?: object; task?: object; fleet?: object } = {}): GoalEvidenceReader {
  const missing = { unavailable: "no reading supplied by this test" };
  return {
    pr: () => (readings.pr ?? missing) as ReturnType<GoalEvidenceReader["pr"]>,
    task: () => (readings.task ?? missing) as ReturnType<GoalEvidenceReader["task"]>,
    fleet: () => (readings.fleet ?? missing) as ReturnType<GoalEvidenceReader["fleet"]>,
  };
}

/** The full propose path in-process: raw build, planner, augmented build, preview. */
function propose(body: Record<string, unknown>, evidence: GoalEvidenceReader): { planned: GoalStepPlan; plan: IntentPlan; state: string } {
  const raw = buildIntentPlan(body, { clock: CLOCK, proposedBy: PROPOSER });
  assert.ok(raw.ok, JSON.stringify(raw));
  const planned = planStepsForGoal(raw.plan, evidence, CLOCK);
  const built = buildIntentPlan(withPlannedSteps(body, raw.plan, planned), { clock: CLOCK, proposedBy: PROPOSER });
  assert.ok(built.ok, JSON.stringify(built));
  assert.equal(built.plan.planId, raw.plan.planId, "planning never changes which plan the idempotency key names");
  return { planned, plan: built.plan, state: previewIntentPlan({ plan: built.plan, events: [], clock: CLOCK }).state };
}

function assertCatalogueOnly(plan: IntentPlan): void {
  for (const step of plan.steps) {
    const resolved = resolveCatalogueCapability(step.capability);
    assert.ok(resolved.ok, `${step.capability} must resolve to a catalogue entry`);
    assert.equal(step.risk, resolved.entry.risk, `${step.capability} carries the catalogue's risk`);
    if (resolved.entry.approval === "human") assert.equal(step.approvalPolicy, "human", `${step.capability} is never weaker than the catalogue`);
    assert.equal(step.rollback.mode, resolved.entry.rollback.mode, `${step.capability} carries the catalogue's rollback mode`);
  }
}

function assertClarifiesOnly(result: { planned: GoalStepPlan; plan: IntentPlan; state: string }, names: RegExp): void {
  assert.equal(result.plan.steps.length, 0, "no guessed step");
  assert.equal(result.planned.steps.length, 0);
  assert.equal(result.state, "unavailable");
  const question = result.plan.questions.find((item) => item.id === GOAL_UNRESOLVED_QUESTION_ID);
  assert.ok(question, "a clarification question is asked");
  assert.match(question.question, names);
}

test("W1-T4658: 'unstick PR #42' with red required checks yields a catalogue-only rmd.pr.repair:42 step with cited evidence that previews ready", () => {
  const result = propose({ goal: "unstick PR #42" }, reader({ pr: RED }));
  assert.deepEqual(result.plan.steps.map((step) => step.capability), ["rmd.pr.repair:42"]);
  assertCatalogueOnly(result.plan);
  const [step] = result.plan.steps;
  assert.equal(step!.approvalPolicy, "human", "the catalogue asks no approval, but the plan gates every irreversible step: stricter, never weaker");
  assert.equal(step!.rollback.mode, "irreversible");
  assert.deepEqual(step!.preconditions.map((item) => item.source), ["/v1/status#prQueue"], "the step names the source its evidence came from");
  const fact = result.plan.facts.find((item) => item.source === "/v1/status#prQueue");
  assert.ok(fact, "the evidence is cited as a fact");
  assert.equal(fact.observedAt, RED.observedAt);
  assert.match(fact.statement, /PR #42/);
  assert.match(fact.statement, /blocked-fixable/);
  assert.match(fact.statement, /required checks red/);
  assert.equal(result.plan.scope.repo, "owner/repo", "the scope is the PR's own repository, never wider");
  assert.equal(result.state, "ready");
});

test("W1-T4658: green checks with no review yields rmd.pr.review:42, and the verb bounds which step may answer", () => {
  const review = propose({ goal: "please unstick PR #42" }, reader({ pr: GREEN_UNREVIEWED }));
  assert.deepEqual(review.plan.steps.map((step) => step.capability), ["rmd.pr.review:42"]);
  assertCatalogueOnly(review.plan);
  assert.equal(review.state, "ready");
  assert.deepEqual(propose({ goal: "review PR #42" }, reader({ pr: GREEN_UNREVIEWED })).plan.steps.map((step) => step.capability), ["rmd.pr.review:42"]);
  assert.deepEqual(propose({ goal: "fix pull request 42" }, reader({ pr: RED })).plan.steps.map((step) => step.capability), ["rmd.pr.repair:42"]);
  assertClarifiesOnly(propose({ goal: "review PR #42" }, reader({ pr: RED })), /blocked-fixable/);
  assertClarifiesOnly(propose({ goal: "unstick PR #42" }, reader({ pr: { ...RED, disposition: "mergeable", reason: "green and reviewed" } })), /mergeable/);
});

test("W1-T4658: 'run W1-T1' for a dispatch-eligible task yields rmd.task.kick:W1-T1 with the catalogue's HIGH risk and human approval", () => {
  const result = propose({ goal: "run W1-T1" }, reader({ task: ELIGIBLE }));
  assert.deepEqual(result.plan.steps.map((step) => step.capability), ["rmd.task.kick:W1-T1"]);
  assertCatalogueOnly(result.plan);
  const [step] = result.plan.steps;
  assert.equal(step!.risk, "high");
  assert.equal(step!.approvalPolicy, "human");
  assert.deepEqual(result.plan.approval.humanGatedSteps, ["step-1"]);
  assert.equal(step!.rollback.mode, "irreversible");
  const kick = ACTION_CATALOGUE.find((entry) => entry.capability === "rmd.task.kick")!;
  assert.equal(step!.rollback.mode === "irreversible" ? step!.rollback.refusal : "", kick.rollback.mode === "irreversible" ? kick.rollback.reason : "");
  assert.ok(result.plan.facts.some((fact) => fact.source === "/v1/status#tasks" && /W1-T1/.test(fact.statement)), "eligibility is cited");
  assertClarifiesOnly(propose({ goal: "run W1-T1" }, reader({ task: { ...ELIGIBLE, eligible: false, reason: "task W1-T1 has unmerged dependencies: W1-T0" } })), /unmerged dependencies/);
});

test("W1-T4658: 'pause the fleet' yields rmd.fleet.pause with resume as its rollback; 'resume the fleet' yields rmd.fleet.resume", () => {
  const pause = propose({ goal: "pause the fleet", scope: { instance: "fleet-1" } }, reader({ fleet: RUNNING_FLEET }));
  assert.deepEqual(pause.plan.steps.map((step) => step.capability), ["rmd.fleet.pause"]);
  assertCatalogueOnly(pause.plan);
  const [step] = pause.plan.steps;
  assert.equal(step!.risk, "medium");
  assert.equal(step!.approvalPolicy, "human", "MEDIUM is not a gated tier, but the catalogue entry demands human approval");
  assert.equal(step!.rollback.mode, "reversible");
  assert.match(step!.rollback.mode === "reversible" ? step!.rollback.plan : "", /rmd\.fleet\.resume/);
  assert.equal(pause.state, "ready");

  const resume = propose({ goal: "resume the fleet" }, reader({ fleet: { ...RUNNING_FLEET, paused: true } }));
  assert.deepEqual(resume.plan.steps.map((step) => step.capability), ["rmd.fleet.resume"]);
  assertCatalogueOnly(resume.plan);
  assertClarifiesOnly(propose({ goal: "pause the fleet" }, reader({ fleet: { ...RUNNING_FLEET, paused: true } })), /already paused/);
  assertClarifiesOnly(propose({ goal: "resume the fleet" }, reader({ fleet: { ...RUNNING_FLEET, paused: true, stopped: true } })), /STOP/);
  assertClarifiesOnly(propose({ goal: "pause the fleet and resume the fleet" }, reader({ fleet: RUNNING_FLEET })), /both pause and resume/);
});

test("W1-T4658: an unmatched goal, or one naming a capability outside the catalogue, yields zero steps and a clarification", () => {
  assertClarifiesOnly(propose({ goal: "tidy up the backlog" }, reader({ pr: RED, task: ELIGIBLE, fleet: RUNNING_FLEET })), /no catalogued step matches/);
  assertClarifiesOnly(propose({ goal: "delete the repo" }, reader({ pr: RED, task: ELIGIBLE, fleet: RUNNING_FLEET })), /delete the repo/);
  assertClarifiesOnly(propose({ goal: "delete the repo and pause the fleet" }, reader({ fleet: RUNNING_FLEET })), /delete/);
  const five = "review PR #1, review PR #2, review PR #3, review PR #4, review PR #5";
  assertClarifiesOnly(propose({ goal: five }, reader({ pr: GREEN_UNREVIEWED })), /at most 4/);
});

test("W1-T4658: stale, future-dated, or unavailable evidence yields zero steps and names what could not be resolved", () => {
  assertClarifiesOnly(propose({ goal: "unstick PR #42" }, reader({ pr: { ...RED, observedAt: at(-2 * HOUR) } })), /older than 3600s/);
  assertClarifiesOnly(propose({ goal: "unstick PR #42", freshness: { maxAgeSeconds: 60 } }, reader({ pr: RED })), /older than 60s/);
  assertClarifiesOnly(propose({ goal: "unstick PR #42" }, reader({ pr: { ...RED, observedAt: at(MINUTE) } })), /future/);
  assertClarifiesOnly(propose({ goal: "unstick PR #42" }, reader({ pr: { unavailable: "GitHub open-PR index is unavailable" } })), /open-PR index is unavailable/);
  assertClarifiesOnly(propose({ goal: "run W1-T1" }, reader()), /W1-T1.*no reading supplied/);
  assertClarifiesOnly(propose({ goal: "pause the fleet" }, reader()), /fleet.*no reading supplied/);
  assertClarifiesOnly(propose({ goal: "unstick PR #42", scope: { repo: "owner/other" } }, reader({ pr: RED })), /outside this plan's scope/);
});

// ── The readers: the board projection and the fleet-control flags ────────────────────────

function task(id: string, overrides: Partial<Task> = {}): Task {
  return { id, title: id, repo: "remudero", depends_on: [], type: "implement", verify: "auto", risk: "low", status: "queued", attempts: 0, ...overrides } as Task;
}

function planOf(...tasks: Task[]): Plan {
  return { tasks, byId: new Map(tasks.map((item) => [item.id, item])) };
}

function boardView(overrides: { tasks?: GoalBoardView["snapshot"]["tasks"]; prQueue?: GoalBoardView["snapshot"]["prQueue"]; unreachable?: boolean; plan?: Plan } = {}): GoalBoardView {
  return {
    plan: overrides.plan ?? planOf(task("W1-T0", { status: "merged" }), task("W1-T1", { depends_on: ["W1-T0"], budget_usd: 12 }), task("W1-T2", { depends_on: ["W1-T9"] }), task("W1-T3", { verify: "human" })),
    snapshot: {
      generated_at: at(-MINUTE),
      github_unreachable: overrides.unreachable ?? false,
      tasks: overrides.tasks ?? [
        { taskId: "W1-T0", merged: true },
        { taskId: "W1-T1", merged: false },
        { taskId: "W1-T2", merged: false },
        { taskId: "W1-T3", merged: false },
        { taskId: "W1-T4", merged: false, phase: "implement" },
      ],
      prQueue: overrides.prQueue ?? {
        complete: true,
        rows: [
          { prNumber: 42, prUrl: PR_URL, headSha: "abc1234def", disposition: "blocked-fixable", reason: "required checks red", reviewState: "none", observedAt: at(-5 * MINUTE) },
          { prNumber: 43, prUrl: "https://github.com/owner/repo/pull/43", disposition: "not-yet-observed", reason: "the sweep has not yet observed this current head", reviewState: "none" },
        ],
      },
    },
  };
}

test("W1-T4658: the board reader cites the sweep's disposition of the PR's CURRENT head, and refuses what it cannot see", () => {
  const view = boardView();
  assert.deepEqual(boardPrReading(view, 42), RED);
  assert.match(String((boardPrReading(view, 43) as { unavailable: string }).unavailable), /not yet observed/);
  assert.match(String((boardPrReading(view, 44) as { unavailable: string }).unavailable), /not in the open-PR index/);
  assert.match(String((boardPrReading(boardView({ prQueue: { complete: false, rows: [], unavailableReason: "index truncated" } }), 42) as { unavailable: string }).unavailable), /index truncated/);
  assert.match(String((boardPrReading(undefined, 42) as { unavailable: string }).unavailable), /not wired/);
});

test("W1-T4658: the board reader decides dispatch-eligibility with the daemon's own admission gate over GitHub-derived credit", () => {
  const view = boardView();
  assert.deepEqual(boardTaskReading(view, "W1-T1"), { taskId: "W1-T1", eligible: true, reason: "every dependency is merged, no run is in flight, and no open PR carries it", budgetUsd: 12, observedAt: at(-MINUTE), source: "/v1/status#tasks" });
  assert.match(String((boardTaskReading(view, "W1-T2") as { reason: string }).reason), /unmerged dependencies: W1-T9/);
  assert.match(String((boardTaskReading(view, "W1-T3") as { reason: string }).reason), /verify:human/);
  assert.match(String((boardTaskReading(view, "W1-T0") as { reason: string }).reason), /already merged/);
  assert.match(String((boardTaskReading(view, "W1-T9") as { reason: string }).reason), /not a task in the plan/);
  assert.match(String((boardTaskReading(boardView({ plan: planOf(task("W1-T4")) }), "W1-T4") as { reason: string }).reason), /in flight/);
  assert.match(String((boardTaskReading(boardView({ unreachable: true }), "W1-T1") as { unavailable: string }).unavailable), /unreachable/);
});

test("W1-T4658: the fleet reader reads the PAUSE and STOP flags, and the evidence reader asks the board only when a goal needs it", () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}intent-planner-`));
  mkdirSync(join(root, "state"), { recursive: true });
  assert.deepEqual(fleetReading(root, CLOCK), { paused: false, stopped: false, observedAt: CLOCK.iso(), source: "fleet-control:state/PAUSE+STOP" });
  writeFileSync(pauseFilePath(root), "{}");
  writeFileSync(stopFilePath(root), "{}");
  assert.deepEqual(fleetReading(root, CLOCK), { paused: true, stopped: true, observedAt: CLOCK.iso(), source: "fleet-control:state/PAUSE+STOP" });
  assert.match(String((fleetReading(undefined, CLOCK) as { unavailable: string }).unavailable), /no fleet-control root/);

  let boardReads = 0;
  const lazy = goalEvidenceReader({ board: () => { boardReads += 1; return boardView(); }, root, clock: CLOCK });
  lazy.fleet();
  assert.equal(boardReads, 0, "a fleet goal never computes the board");
  lazy.pr(42);
  lazy.task("W1-T1");
  assert.equal(boardReads, 1, "the board is read at most once per proposal");
  const broken = goalEvidenceReader({ board: () => { throw new Error("gh read failed"); }, clock: CLOCK });
  assert.match(String((broken.pr(42) as { unavailable: string }).unavailable), /gh read failed/);
});

// ── The route: a goal-only proposal is planned; a producer's steps are untouched ──────────

async function withPlannerService<T>(path: string, fn: (base: string) => Promise<T>): Promise<T> {
  const server = createService({
    tokens: { read: READ_TOKEN, write: WRITE_TOKEN },
    routes: buildOperatorAgentRoutes({ ledgerPath: path, now: fixedClock(NOW_MS).now, goalBoard: () => boardView() }),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    return await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.close();
  }
}

async function post(base: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${base}${PLANS_PATH}`, { method: "POST", headers: { authorization: `Bearer ${WRITE_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

test("W1-T4658: the propose route calls the planner for a goal-only proposal and leaves a producer's steps untouched", async () => {
  const path = tempStatePath();
  await withPlannerService(path, async (base) => {
    const goalOnly = { goal: "unstick PR #42", idempotencyKey: "unstick-42" };
    const proposed = await post(base, goalOnly);
    assert.equal(proposed.status, 201, JSON.stringify(proposed.body));
    const plan = proposed.body.plan as IntentPlan;
    assert.deepEqual(plan.steps.map((step) => step.capability), ["rmd.pr.repair:42"]);
    assert.equal((proposed.body.preview as { state: string }).state, "ready");
    assert.equal(proposed.body.nextDecision, "confirm");

    const replay = await post(base, goalOnly);
    assert.equal(replay.status, 200, "the same request under the same key is the same plan, even though the planner augmented it");
    assert.equal(replay.body.existing, true);
    assert.equal((await post(base, { goal: "unstick PR #43", idempotencyKey: "unstick-42" })).status, 409);

    const producer = { goal: "Promote the canary in repo owner/repo.", steps: [stepInput()], idempotencyKey: "producer" };
    assert.equal((await post(base, producer)).status, 201);

    const unmatched = await post(base, { goal: "delete the repo" });
    assert.equal(unmatched.status, 201);
    assert.equal(((unmatched.body.plan as IntentPlan).steps).length, 0);
    assert.ok((unmatched.body.unknowns as Array<{ id: string }>).some((item) => item.id === GOAL_UNRESOLVED_QUESTION_ID));
  });
  const rows = rowsAt(path).filter((row) => row.step === INTENT_PLAN_LEDGER_STEP);
  assert.equal(rows.length, 3);
  const [planned, producerRow] = rows;
  assert.equal(typeof planned!.request_digest, "string", "a planned row names the digest of the request it answered");
  assert.deepEqual(((planned!.input as { steps: Array<{ capability: string }> }).steps).map((step) => step.capability), ["rmd.pr.repair:42"]);
  assert.deepEqual(producerRow!.input, { goal: "Promote the canary in repo owner/repo.", steps: [stepInput()], idempotencyKey: "producer" }, "a producer-supplied proposal is stored exactly as sent");
  assert.equal(producerRow!.request_digest, undefined);
});

test("W1-T4658: every catalogue entry the planner can draft keeps the catalogue's risk, approval, and rollback through buildIntentPlan", () => {
  for (const entry of ACTION_CATALOGUE) {
    const capability = entry.target === "task" ? `${entry.capability}:W1-T1` : entry.target === "pr" ? `${entry.capability}:42` : entry.capability;
    const built = buildIntentPlan(
      { goal: "catalogue probe", scope: { repo: "owner/repo" }, steps: [stepInput({ capability, risk: entry.risk, rollback: entry.rollback.mode === "reversible" ? { mode: "reversible", plan: entry.rollback.capability } : { mode: "irreversible", refusal: entry.rollback.reason } })] },
      { clock: CLOCK, proposedBy: PROPOSER },
    );
    assert.ok(built.ok, JSON.stringify(built));
    assertCatalogueOnly(built.plan);
  }
});

test("W1-T4658: a planner-produced rmd.fleet.pause action carries approval human and the executor runs it, never refusing approval-too-weak", () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}intent-planner-exec-`));
  mkdirSync(join(root, "state"), { recursive: true });
  const { plan, state } = propose({ goal: "pause the fleet", scope: { instance: "fleet-1" } }, goalEvidenceReader({ root, clock: CLOCK }));
  assert.equal(state, "ready");
  const [action] = intentPlanActions(plan, plan.scope);
  assert.equal(action!.capability, "rmd.fleet.pause");
  assert.deepEqual(action!.approval, { policy: "human" }, "the stricter of the tier-derived policy and the catalogue's");
  const run = (candidate: AutomationAction) => {
    const receipts: AutomationActionReceipt[] = [];
    const result = executeCatalogueAction({
      action: candidate,
      receipts: [],
      approval: { decision: "approved", decidedBy: PROPOSER, decidedAt: CLOCK.iso() },
      observations: candidate.preconditions.map((item) => ({ preconditionId: item.id, state: "satisfied" as const, source: item.source, observedAt: CLOCK.iso() })),
      clock: CLOCK,
      callerTier: "middle",
      origin: PROPOSER,
      executor: { root, ledgerPath: tempStatePath() },
      appendReceipt: (receipt) => receipts.push(receipt),
    });
    return { result, codes: (result.preflight?.findings ?? []).map((finding) => finding.code) };
  };
  const weakened = run({ ...action!, approval: { policy: "none" } });
  assert.equal(weakened.result.disposition, "refused", "the control: a none-approval pause is what the executor refuses");
  assert.ok(weakened.codes.includes("approval-too-weak"));
  assert.equal(isPaused(root), false);
  const planned = run(action!);
  assert.ok(!planned.codes.includes("approval-too-weak"), JSON.stringify(planned.codes));
  assert.equal(planned.result.disposition, "completed", JSON.stringify(planned.result.receipt));
  assert.equal(isPaused(root), true, "the executor's own handler paused the fleet");
});
