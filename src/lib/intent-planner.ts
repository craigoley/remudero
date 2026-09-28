/**
 * src/lib/intent-planner.ts — W1-T4658: A GOAL BECOMES STEPS THE FLEET CAN RUN.
 *
 * The console sends an intent plan as a goal alone, and W1-T3898 previews that `unavailable`
 * (`no-bounded-step`). {@link planStepsForGoal} proposes 0-4 automation-action-v1 step drafts for
 * such a goal. It is DETERMINISTIC and EVIDENCE-LED: a fixed set of recognisers, no model call.
 *
 * ITS VOCABULARY IS W1-T4657's EXECUTOR CATALOGUE AND NOTHING ELSE. Every draft names a catalogue
 * capability ref and copies that entry's risk, rollback, and proof step; approval is never set
 * here (buildIntentPlan derives it, and never weaker than the catalogue).
 *
 * A STEP NEEDS EVIDENCE. Each recogniser reads one observation — the board projection's sweep
 * disposition for a PR's CURRENT head, its GitHub-credited dispatch eligibility for a task, the
 * fleet-control flags — and cites it as a fact with its source and observedAt, the way the ask
 * route cites. Missing, stale, future-dated or contrary evidence, an unmatched goal, or any
 * clause left over after the recognisers ran yields ZERO steps and one clarification question
 * naming what could not be resolved. A plan is all-or-nothing: never a partial guess.
 *
 * The output enters buildIntentPlan and the existing preview, so every W1-T3898 refusal still
 * applies; the daemon still re-gates each action when it runs (a kick re-runs assertRunnable).
 * planStepsForGoal is pure; the readers below it adapt the sources the daemon already serves.
 */

import { resolveCatalogueCapability, type CatalogueEntry } from "./action-executor.js";
import type { BoardRow, PrQueueRow } from "./board.js";
import type { Clock } from "./clock.js";
import { DELEGATION_PROFILE_MAX_COST_USD } from "./delegation-profile.js";
import { isPaused, isSafeTaskId, isStopped } from "./fleet-control.js";
import { AUTOMATION_ACTION_MAX_ID_CHARS, AUTOMATION_ACTION_MAX_TEXT_CHARS } from "./automation-action.js";
import { INTENT_PLAN_MAX_STEPS, type IntentPlan, type IntentPlanFact, type IntentPlanQuestionSpec, type IntentPlanScope } from "./intent-plan.js";
import { assertRunnable, TaskAdmissionError, type Plan } from "./plan.js";

export const GOAL_UNRESOLVED_QUESTION_ID = "goal-unresolved";
export const GOAL_PR_SOURCE = "/v1/status#prQueue";
export const GOAL_TASK_SOURCE = "/v1/status#tasks";
export const GOAL_FLEET_SOURCE = "fleet-control:state/PAUSE+STOP";

export interface GoalUnavailable {
  readonly unavailable: string;
}

export interface GoalPrReading {
  readonly prNumber: number;
  readonly repo: string;
  readonly headSha?: string;
  readonly disposition: string;
  readonly reason: string;
  readonly reviewState: string;
  readonly observedAt: string;
  readonly source: string;
}

export interface GoalTaskReading {
  readonly taskId: string;
  readonly eligible: boolean;
  readonly reason: string;
  readonly budgetUsd?: number;
  readonly observedAt: string;
  readonly source: string;
}

export interface GoalFleetReading {
  readonly paused: boolean;
  readonly stopped: boolean;
  readonly observedAt: string;
  readonly source: string;
}

export interface GoalEvidenceReader {
  pr(prNumber: number): GoalPrReading | GoalUnavailable;
  task(taskId: string): GoalTaskReading | GoalUnavailable;
  fleet(): GoalFleetReading | GoalUnavailable;
}

/** What {@link planStepsForGoal} adds to a goal-only request. Steps are empty whenever questions are not. */
export interface GoalStepPlan {
  readonly steps: readonly Record<string, unknown>[];
  readonly facts: readonly IntentPlanFact[];
  readonly questions: readonly IntentPlanQuestionSpec[];
  readonly scope?: { readonly repo: string };
}

type PrVerb = "unstick" | "repair" | "review";
type Intent = { kind: "pr"; verb: PrVerb; prNumber: number } | { kind: "task"; taskId: string } | { kind: "pause" } | { kind: "resume" };

const PR_RE = /\b(unstick|unblock|rescue|fix|repair|re-?review|review)\b[^.;\n#]{0,40}?\b(?:pr|pull request)\s*#?\s*([1-9]\d{0,8})\b/gi;
const TASK_RE = /\b(?:run|kick(?:\s+off)?|dispatch|start|build)\s+(?:task\s+)?([A-Za-z][A-Za-z0-9]*-T\d{1,6})\b/gi;
const FLEET_NOUN = String.raw`(?:the\s+)?(?:whole\s+|entire\s+)?(?:fleet|daemon|dispatch(?:ing)?|workers?)\b`;
const PAUSE_RE = new RegExp(String.raw`\bpause\s+${FLEET_NOUN}`, "gi");
const RESUME_RE = new RegExp(String.raw`\b(?:resume|unpause)\s+${FLEET_NOUN}`, "gi");
/** Words a goal may carry around its recognised clauses. Anything else is a clause no step covers. */
const FILLER: ReadonlySet<string> = new Set(
  "a also and an asap away can could for go hey i it just kindly let lets me now ok okay please pls right so thanks the then to us want we would you".split(" "),
);
const PR_URL_REPO_RE = /github\.com\/([A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100})\/pull\/\d+/i;
const VOCABULARY = "unstick, fix or review PR #<n>; run <task id>; pause or resume the fleet";

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function unavailable(value: object): value is GoalUnavailable {
  return typeof (value as GoalUnavailable).unavailable === "string";
}

function prVerb(word: string): PrVerb {
  const verb = word.toLowerCase().replace("-", "");
  return verb === "fix" || verb === "repair" ? "repair" : verb === "review" || verb === "rereview" ? "review" : "unstick";
}

/** Every recognised clause in the goal, plus whatever words none of them consumed. */
function recognise(goal: string): { intents: Intent[]; remainder: string[] } {
  const intents: Intent[] = [];
  let rest = goal;
  const take = (re: RegExp, make: (match: RegExpExecArray) => Intent): void => {
    rest = rest.replace(re, (...args) => {
      intents.push(make(args as unknown as RegExpExecArray));
      return " ";
    });
  };
  take(PR_RE, (match) => ({ kind: "pr", verb: prVerb(match[1]!), prNumber: Number(match[2]) }));
  take(TASK_RE, (match) => ({ kind: "task", taskId: match[1]! }));
  take(PAUSE_RE, () => ({ kind: "pause" }));
  take(RESUME_RE, () => ({ kind: "resume" }));
  const remainder = (rest.toLowerCase().match(/[a-z0-9']+/g) ?? []).map((word) => word.replace(/'/g, "")).filter((word) => !FILLER.has(word));
  return { intents, remainder };
}

function intentKey(intent: Intent): string {
  return intent.kind === "pr" ? `pr:${intent.prNumber}` : intent.kind === "task" ? `task:${intent.taskId}` : intent.kind;
}

type Resolved = { capability: string; summary: string; fact: IntentPlanFact; costUsd: number; repo?: string } | { unresolved: string };

/** The evidence's own age check: missing, future-dated, or older than the plan's freshness window. */
function ageProblem(observedAt: string, maxAgeSeconds: number, clock: Clock): string | undefined {
  const observed = Date.parse(observedAt);
  if (!Number.isFinite(observed)) return "carries no observation time";
  if (observed > clock.now()) return `is dated in the future (${observedAt})`;
  return clock.now() - observed > maxAgeSeconds * 1000 ? `was observed at ${observedAt}, older than ${maxAgeSeconds}s` : undefined;
}

function fact(statement: string, source: string, observedAt: string): IntentPlanFact {
  return { statement: clip(statement, AUTOMATION_ACTION_MAX_TEXT_CHARS), source: clip(source, AUTOMATION_ACTION_MAX_ID_CHARS), observedAt, availability: "available" };
}

const PR_STEP_FOR: Readonly<Record<PrVerb, Readonly<Record<string, "rmd.pr.repair" | "rmd.pr.review">>>> = {
  unstick: { "blocked-fixable": "rmd.pr.repair", "post-review": "rmd.pr.review" },
  repair: { "blocked-fixable": "rmd.pr.repair" },
  review: { "post-review": "rmd.pr.review" },
};

function resolvePr(intent: Extract<Intent, { kind: "pr" }>, evidence: GoalEvidenceReader, maxAgeSeconds: number, clock: Clock): Resolved {
  const label = `PR #${intent.prNumber}`;
  const reading = evidence.pr(intent.prNumber);
  if (unavailable(reading)) return { unresolved: `${label}: ${reading.unavailable}` };
  const age = ageProblem(reading.observedAt, maxAgeSeconds, clock);
  if (age) return { unresolved: `${label}'s sweep reading ${age}` };
  const head = reading.headSha ? ` head ${reading.headSha.slice(0, 7)}` : "";
  const observed = `${label}${head} is disposed ${reading.disposition} by the daemon's sweep: ${reading.reason}`;
  const ref = PR_STEP_FOR[intent.verb][reading.disposition];
  if (!ref) return { unresolved: `${observed}; no catalogued step answers "${intent.verb}" for that` };
  const action = ref === "rmd.pr.repair" ? "fix rung" : "review lane";
  return {
    capability: `${ref}:${intent.prNumber}`,
    summary: `Request the daemon's ${action} for ${label} (${reading.disposition}: ${reading.reason})`,
    fact: fact(observed, reading.source, reading.observedAt),
    costUsd: 0,
    repo: reading.repo,
  };
}

function resolveTask(intent: Extract<Intent, { kind: "task" }>, evidence: GoalEvidenceReader, maxAgeSeconds: number, clock: Clock): Resolved {
  const label = `task ${intent.taskId}`;
  if (!isSafeTaskId(intent.taskId)) return { unresolved: `${label} is not a task id` };
  const reading = evidence.task(intent.taskId);
  if (unavailable(reading)) return { unresolved: `${label}: ${reading.unavailable}` };
  const age = ageProblem(reading.observedAt, maxAgeSeconds, clock);
  if (age) return { unresolved: `${label}'s eligibility reading ${age}` };
  if (!reading.eligible) return { unresolved: `${label} is not dispatch-eligible: ${reading.reason}` };
  const costUsd = reading.budgetUsd ?? 0;
  if (!(costUsd >= 0 && costUsd <= DELEGATION_PROFILE_MAX_COST_USD)) return { unresolved: `${label} budgets $${costUsd}, outside 0..${DELEGATION_PROFILE_MAX_COST_USD}` };
  return {
    capability: `rmd.task.kick:${intent.taskId}`,
    summary: `Kick ${label}: the daemon dispatches it through its own admission gate`,
    fact: fact(`${label} is dispatch-eligible: ${reading.reason}`, reading.source, reading.observedAt),
    costUsd,
  };
}

function resolveFleet(kind: "pause" | "resume", evidence: GoalEvidenceReader, maxAgeSeconds: number, clock: Clock): Resolved {
  const reading = evidence.fleet();
  if (unavailable(reading)) return { unresolved: `the fleet: ${reading.unavailable}` };
  const age = ageProblem(reading.observedAt, maxAgeSeconds, clock);
  if (age) return { unresolved: `the fleet's control reading ${age}` };
  if (reading.stopped) return { unresolved: `a fleet STOP is active; an automation step neither stacks a pause on it nor lifts it — clear STOP by hand` };
  if (kind === "pause" && reading.paused) return { unresolved: "the fleet is already paused" };
  if (kind === "resume" && !reading.paused) return { unresolved: "the fleet is not paused, so there is nothing to resume" };
  const state = reading.paused ? "paused (a PAUSE flag, no STOP)" : "running (no PAUSE or STOP flag)";
  return {
    capability: `rmd.fleet.${kind}`,
    summary: kind === "pause" ? "Pause the fleet: drain in-flight work and hold new dispatch" : "Resume the paused fleet",
    fact: fact(`the fleet is ${state}`, reading.source, reading.observedAt),
    costUsd: 0,
  };
}

/** The automation-action-v1 draft a catalogue entry dictates. Approval is deliberately absent. */
function draft(entry: CatalogueEntry, resolved: Extract<Resolved, { capability: string }>, maxAgeSeconds: number): Record<string, unknown> {
  const rollback = entry.rollback.mode === "reversible"
    ? { mode: "reversible", plan: `request ${entry.rollback.capability}, the catalogue's rollback for ${entry.capability}` }
    : { mode: "irreversible", refusal: entry.rollback.reason };
  return {
    capability: resolved.capability,
    summary: clip(resolved.summary, AUTOMATION_ACTION_MAX_TEXT_CHARS),
    risk: entry.risk,
    preconditions: [{ id: "evidence", source: resolved.fact.source, description: resolved.fact.statement }],
    freshness: { maxAgeSeconds },
    dryRun: true,
    rollback,
    receiptRef: `ledger:${entry.proofStep}`,
    estimatedCostUsd: resolved.costUsd,
  };
}

/** A repository the plan already names — its scope, or the goal's research — is a bound, never widened. */
function scopeProblem(scope: IntentPlanScope, named: readonly string[], repo: string): string | undefined {
  const same = (other: string): boolean => other.toLowerCase() === repo.toLowerCase();
  if (scope.repo && !same(scope.repo)) return `it is in ${repo}, outside this plan's scope ${scope.repo}`;
  if (scope.instance && !scope.repo) return `it is in ${repo}, outside this plan's scope instance ${scope.instance}`;
  if (named.length > 0 && !named.some(same)) return `it is in ${repo}, which the goal does not name (${named.join(", ")})`;
  return undefined;
}

function clarify(reasons: readonly string[]): GoalStepPlan {
  const question = `Restate the goal: ${reasons.join("; ")}. Recognised: ${VOCABULARY}.`;
  return { steps: [], facts: [], questions: [{ id: GOAL_UNRESOLVED_QUESTION_ID, question: clip(question, AUTOMATION_ACTION_MAX_TEXT_CHARS) }] };
}

/**
 * Proposes steps for a goal-only plan (the plan as buildIntentPlan built it from the raw request,
 * so its goal, researched scope, and freshness window are the ones the preview will judge).
 */
export function planStepsForGoal(plan: IntentPlan, evidence: GoalEvidenceReader, clock: Clock): GoalStepPlan {
  const goal = plan.outcome;
  const { intents, remainder } = recognise(goal);
  if (intents.length === 0) return clarify([`no catalogued step matches "${clip(goal, 60)}"`]);
  if (remainder.length > 0) return clarify([`no catalogued step covers "${clip(remainder.join(" "), 60)}"`]);
  const unique = [...new Map(intents.map((intent) => [intentKey(intent), intent])).values()];
  if (unique.some((intent) => intent.kind === "pause") && unique.some((intent) => intent.kind === "resume")) return clarify(["the goal asks to both pause and resume the fleet"]);
  if (unique.length > INTENT_PLAN_MAX_STEPS) return clarify([`the goal names ${unique.length} actions; one plan proposes at most ${INTENT_PLAN_MAX_STEPS}`]);
  const maxAgeSeconds = plan.freshness.maxAgeSeconds;
  const resolved = unique.map((intent) =>
    intent.kind === "pr" ? resolvePr(intent, evidence, maxAgeSeconds, clock)
      : intent.kind === "task" ? resolveTask(intent, evidence, maxAgeSeconds, clock)
        : resolveFleet(intent.kind, evidence, maxAgeSeconds, clock),
  );
  const problems = resolved.flatMap((item) => ("unresolved" in item ? [item.unresolved] : []));
  const found = resolved.flatMap((item) => ("unresolved" in item ? [] : [item]));
  const repos = [...new Set(found.flatMap((item) => (item.repo ? [item.repo] : [])))];
  if (repos.length > 1) problems.push(`the PRs span ${repos.length} repositories (${repos.join(", ")})`);
  for (const repo of repos.slice(0, 1)) {
    const problem = scopeProblem(plan.scope, plan.research.repositories, repo);
    if (problem) problems.push(`the PR cannot be acted on here: ${problem}`);
  }
  const entries = found.map((item) => resolveCatalogueCapability(item.capability));
  if (problems.length > 0) return clarify(problems);
  const steps = found.map((item, index) => {
    const entry = entries[index]!;
    return entry.ok ? draft(entry.entry, item, maxAgeSeconds) : undefined;
  });
  if (steps.some((step) => step === undefined)) return clarify(["a recogniser named a capability outside the executor catalogue"]);
  const scoped = repos.length === 1 && !plan.scope.repo ? { scope: { repo: repos[0]! } } : {};
  return { steps: steps as Record<string, unknown>[], facts: found.map((item) => item.fact), questions: [], ...scoped };
}

/** The request the planner answered, with its steps, facts, question, and narrowed scope merged in.
 *  The key is pinned to the raw request's, so the plan id — and any retry of it — is unchanged. */
export function withPlannedSteps(body: Record<string, unknown>, raw: IntentPlan, planned: GoalStepPlan): Record<string, unknown> {
  const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
  const scope = typeof body.scope === "object" && body.scope !== null ? body.scope : {};
  return {
    ...body,
    steps: planned.steps,
    ...(planned.facts.length > 0 ? { facts: [...list(body.facts), ...planned.facts] } : {}),
    ...(planned.questions.length > 0 ? { questions: [...list(body.questions), ...planned.questions] } : {}),
    ...(planned.scope ? { scope: { ...scope, ...planned.scope } } : {}),
    idempotencyKey: raw.idempotencyKey,
  };
}

// ── Readers: the observations the daemon already serves ─────────────────────────────────

/** The slice of GET /v1/status's snapshot the readers use, with the plan it was projected from. */
export interface GoalBoardView {
  readonly plan: Plan;
  readonly snapshot: {
    readonly generated_at: string;
    readonly github_unreachable: boolean;
    readonly tasks: ReadonlyArray<Pick<BoardRow, "taskId" | "merged"> & Partial<Pick<BoardRow, "phase" | "prNumber" | "prState" | "needsHuman" | "independentFailureBlocked" | "indeterminate">>>;
    readonly prQueue: { readonly complete: boolean; readonly unavailableReason?: string; readonly rows: ReadonlyArray<Pick<PrQueueRow, "prNumber" | "prUrl" | "disposition" | "reason" | "reviewState"> & Partial<Pick<PrQueueRow, "headSha" | "observedAt">>> };
  };
}

/** The sweep's disposition of the PR's CURRENT head (the board joins the two by head sha). */
export function boardPrReading(view: GoalBoardView | undefined, prNumber: number): GoalPrReading | GoalUnavailable {
  if (!view) return { unavailable: "the board projection is not wired into this server" };
  const queue = view.snapshot.prQueue;
  if (!queue.complete) return { unavailable: queue.unavailableReason ?? "the open-PR index is incomplete" };
  const row = queue.rows.find((item) => item.prNumber === prNumber);
  if (!row) return { unavailable: "it is not in the open-PR index (merged, closed, or never opened)" };
  if (!row.observedAt || row.disposition === "not-yet-observed") return { unavailable: "the sweep has not yet observed its current head" };
  const repo = PR_URL_REPO_RE.exec(row.prUrl)?.[1];
  if (!repo) return { unavailable: `its url ${clip(row.prUrl, 80)} names no repository` };
  return { prNumber, repo, ...(row.headSha ? { headSha: row.headSha } : {}), disposition: row.disposition, reason: row.reason, reviewState: row.reviewState, observedAt: row.observedAt, source: GOAL_PR_SOURCE };
}

/** Dispatch eligibility from the plan and the GitHub-credited projection, through the daemon's
 *  own admission gate ({@link assertRunnable}); verify:human counts as unreleased (conservative). */
export function boardTaskReading(view: GoalBoardView | undefined, taskId: string): GoalTaskReading | GoalUnavailable {
  if (!view) return { unavailable: "the board projection is not wired into this server" };
  const { snapshot, plan } = view;
  if (snapshot.github_unreachable) return { unavailable: "GitHub was unreachable, so merge credit cannot be read" };
  const at = { taskId, observedAt: snapshot.generated_at, source: GOAL_TASK_SOURCE };
  const refuse = (reason: string): GoalTaskReading => ({ ...at, eligible: false, reason });
  const task = plan.byId.get(taskId);
  if (!task) return refuse("it is not a task in the plan");
  const rows = new Map(snapshot.tasks.map((row) => [row.taskId, row]));
  const row = rows.get(taskId);
  if (!row || row.indeterminate) return { unavailable: "its merge credit is indeterminate" };
  if (row.merged) return refuse("it is already merged");
  if (row.phase) return refuse(`a run is in flight (${row.phase})`);
  if (row.prNumber !== undefined && row.prState?.toUpperCase() === "OPEN") return refuse(`open PR #${row.prNumber} already carries it`);
  if (row.needsHuman || row.independentFailureBlocked) return refuse("it is blocked awaiting a human");
  try {
    assertRunnable(plan, task, (dep) => rows.get(dep.id)?.merged === true);
  } catch (err) {
    if (err instanceof TaskAdmissionError) return refuse(err.message);
    throw err;
  }
  return { ...at, eligible: true, reason: "every dependency is merged, no run is in flight, and no open PR carries it", ...(task.budget_usd !== undefined ? { budgetUsd: task.budget_usd } : {}) };
}

/** The PAUSE and STOP flags, read now — existence alone, as the daemon's own gates read them. */
export function fleetReading(root: string | undefined, clock: Clock): GoalFleetReading | GoalUnavailable {
  if (!root) return { unavailable: "no fleet-control root is wired into this server" };
  return { paused: isPaused(root), stopped: isStopped(root), observedAt: clock.iso(), source: GOAL_FLEET_SOURCE };
}

/** One proposal's reader. The board is computed at most once, and only if a goal needs it; a
 *  failed computation is an unavailable reading, never an empty one. */
export function goalEvidenceReader(input: { board?: () => GoalBoardView | undefined; root?: string; clock: Clock }): GoalEvidenceReader {
  let view: { value?: GoalBoardView; error?: string } | undefined;
  const board = (): { value?: GoalBoardView; error?: string } => {
    if (view) return view;
    try {
      view = { value: input.board?.() };
    } catch (err) {
      view = { error: `the board projection failed: ${err instanceof Error ? err.message : String(err)}` };
    }
    return view;
  };
  return {
    pr: (prNumber) => (board().error ? { unavailable: board().error! } : boardPrReading(board().value, prNumber)),
    task: (taskId) => (board().error ? { unavailable: board().error! } : boardTaskReading(board().value, taskId)),
    fleet: () => fleetReading(input.root, input.clock),
  };
}

