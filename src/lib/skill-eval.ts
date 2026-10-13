/**
 * lib/skill-eval.ts — the held-out skill eval for a skill-workshop draft: the task SELECTOR (phase 2 of 5)
 * and the RUNNER with its verdict (phase 3 of 5).
 *
 * A self-generated skill averages about zero benefit unless it is tested on tasks it never saw
 * (SkillsBench, SkillLearnBench). Operator ruling 2026-10-13: every draft is attempted with and
 * without the skill on K = 3 held-out tasks × R = 2 trials per arm before it reaches the inbox.
 * A sealed, never-pushed attempt of an unapproved draft is not a release.
 *
 * The selector is pure. The draft is frozen first, because its sha256 seeds the draw. The runner
 * spends, so it refuses unless the operator passed --confirm-spend and the fleet is idle, and it
 * dispatches only through an injected sealed dispatcher. Every refusal is a value the caller sees,
 * never an empty success. The drafter (skill-workshop.ts, workflow-mining.ts) must never import this
 * module or golden-corpus.ts; the dependency-cruiser rule `drafter-never-sees-held-out-set` refuses that edge.
 */
import { createHash } from "node:crypto";
import { heldOutLeaks, replayIdleGate, type CorpusProofOutcome, type GoldenCorpusItem, type ReplayIdleSignal } from "./golden-corpus.js";
import { gradeHeadWithReviewerExecutor, PAIRED_ATTEMPT_MAX_BUDGET_USD, type PairedAttemptDispatch, type PairedAttemptRequest,
  type PairedAttemptResult, type PairedGrade, type PairedGrader } from "./paired-trial.js";
import { replayOptIn } from "./replay-harness.js";

/** K: held-out tasks per draft, per the operator's 2026-10-13 ruling. */
export const SKILL_EVAL_HELD_OUT_TASKS = 3;

/** Task types a held-out attempt can run: the sealed attempt path renders `renderImplementPrompt`. */
export const SKILL_EVAL_ATTEMPTABLE_TASK_TYPES: readonly string[] = ["implement"];

/** Picks `k` of `eligible`, deterministically from `seed`. A seam so a test can reach the overlap refusal. */
export type HeldOutDraw = (eligible: readonly GoldenCorpusItem[], seed: string, k: number) => GoldenCorpusItem[];

export interface HeldOutSelectionInput {
  corpus: readonly GoldenCorpusItem[];
  draft: { markdown: string; taskType: string };
  /** The draft's supporting tasks, the mined workflow's tasks, and every task merged in the mining window. */
  excludedTaskIds: Iterable<string>;
  k?: number;
  draw?: HeldOutDraw;
}

export type HeldOutRefusalReason =
  | "invalid-k"
  | "type-not-attemptable"
  | "proof-text-leak"
  | "task-id-leak"
  | "too-few-eligible"
  | "excluded-task-selected";

export interface HeldOutSelected {
  ok: true;
  items: GoldenCorpusItem[];
  draftSha256: string;
  heldOutSetHash: string;
  eligibleCount: number;
}

/** `taskIds` names the tasks behind the refusal: the leaked or overlapping ids, or the eligible ones. */
export interface HeldOutRefused {
  ok: false;
  reason: HeldOutRefusalReason;
  detail: string;
  taskIds: string[];
  draftSha256: string;
  eligibleCount: number;
}

export type HeldOutSelection = HeldOutSelected | HeldOutRefused;

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/** The default draw: rank every eligible task by sha256(seed, taskId) and take the lowest `k`. */
export function seededHeldOutDraw(eligible: readonly GoldenCorpusItem[], seed: string, k: number): GoldenCorpusItem[] {
  return eligible
    .map((item) => ({ item, rank: sha256(`${seed}\n${item.taskId}`) }))
    .sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0))
    .slice(0, k)
    .map((r) => r.item);
}

/** A sha256 over the sorted task ids, so the same set hashes the same whatever order it was drawn in. */
export function heldOutSetHash(taskIds: readonly string[]): string {
  return sha256([...taskIds].sort().join("\n"));
}

/** Does `text` name `taskId` as a whole token? `W1-T12` inside `W1-T123` is a different task. */
function namesTaskId(text: string, taskId: string): boolean {
  const escaped = taskId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`).test(text);
}

/**
 * Select the held-out tasks a draft is attempted on. Keeps corpus items of the draft's own task type
 * that the caller did not exclude, then refuses a draft that leaks any eligible task's proof text or
 * id, refuses fewer than `k` eligible tasks, and draws `k` seeded by the draft's sha256.
 */
export function selectHeldOutTasks(opts: HeldOutSelectionInput): HeldOutSelection {
  const k = opts.k ?? SKILL_EVAL_HELD_OUT_TASKS;
  const draftSha256 = sha256(opts.draft.markdown);
  const excluded = new Set(opts.excludedTaskIds);
  const eligible = opts.corpus.filter((item) => item.spec?.type === opts.draft.taskType && !excluded.has(item.taskId));
  const refuse = (reason: HeldOutRefusalReason, detail: string, taskIds: string[]): HeldOutRefused => ({
    ok: false, reason, detail, taskIds, draftSha256, eligibleCount: eligible.length,
  });
  if (!Number.isInteger(k) || k < 1) return refuse("invalid-k", `k must be a positive integer, got ${k}`, []);
  if (!SKILL_EVAL_ATTEMPTABLE_TASK_TYPES.includes(opts.draft.taskType)) {
    return refuse("type-not-attemptable", `a sealed attempt cannot run a ${opts.draft.taskType} task`, []);
  }
  const proofLeaks = heldOutLeaks(opts.draft.markdown, eligible);
  if (proofLeaks.length > 0) return refuse("proof-text-leak", "the draft quotes an eligible task's held-out proof", proofLeaks);
  const idLeaks = eligible.filter((item) => namesTaskId(opts.draft.markdown, item.taskId)).map((item) => item.taskId);
  if (idLeaks.length > 0) return refuse("task-id-leak", "the draft names an eligible task id", idLeaks);
  if (eligible.length < k) {
    return refuse("too-few-eligible", `${eligible.length} eligible ${opts.draft.taskType} task(s), need ${k}`, eligible.map((i) => i.taskId));
  }
  const items = (opts.draw ?? seededHeldOutDraw)(eligible, draftSha256, k);
  const overlap = items.filter((item) => excluded.has(item.taskId)).map((item) => item.taskId);
  if (overlap.length > 0) return refuse("excluded-task-selected", "the draw returned a task the caller excluded", overlap);
  return { ok: true, items, draftSha256, heldOutSetHash: heldOutSetHash(items.map((i) => i.taskId)), eligibleCount: eligible.length };
}

/** R: trials per arm per held-out task, per the operator's 2026-10-13 ruling. */
export const SKILL_EVAL_TRIALS_PER_ARM = 2;

/** The two arms. They share one pinned stack; the draft in the prompt's skills part is the only difference. */
export const SKILL_EVAL_ARMS = ["with-skill", "without-skill"] as const;
export type SkillEvalArm = (typeof SKILL_EVAL_ARMS)[number];

/** PRIMARY CONTROL on one draft's eval spend: K tasks × R trials × 2 arms × the per-attempt BACKSTOP
 *  `PAIRED_ATTEMPT_MAX_BUDGET_USD` (12 × $15 = $180). A run that could exceed it refuses before any dispatch. */
export const SKILL_EVAL_MAX_SPEND_USD = SKILL_EVAL_HELD_OUT_TASKS * SKILL_EVAL_TRIALS_PER_ARM * SKILL_EVAL_ARMS.length
  * PAIRED_ATTEMPT_MAX_BUDGET_USD;

export const SKILL_EVAL_STEPS = { attempt: "skill_eval.attempt", result: "skill_eval.result", refused: "skill_eval.refused" } as const;

/** One attempt's place in a task's run order: `trial` is its block, `position` its slot within the block. */
export interface SkillEvalSlot {
  arm: SkillEvalArm;
  trial: number;
  position: 0 | 1;
}

/**
 * A task's attempt order: R blocks of one attempt per arm. The seed (the draft's sha256) picks the arm that opens the
 * first block and the blocks alternate (A B, B A), so neither arm always runs first and, with R even, both arms sit
 * at the same mean position in time.
 */
export function skillEvalTrialOrder(seed: string, taskId: string): SkillEvalSlot[] {
  const first: SkillEvalArm = Number.parseInt(sha256(`${seed}\n${taskId}`).slice(0, 8), 16) % 2 === 0 ? "with-skill" : "without-skill";
  const second: SkillEvalArm = first === "with-skill" ? "without-skill" : "with-skill";
  return Array.from({ length: SKILL_EVAL_TRIALS_PER_ARM }, (_, trial) => (trial % 2 === 0 ? [first, second] : [second, first])
    .map((arm, position) => ({ arm, trial, position: position as 0 | 1 }))).flat();
}

/** One graded attempt. `verdict` is unmeasurable for a breach, a missing head, a failure or an unmeasurable grade. */
export interface SkillEvalAttempt {
  taskId: string;
  arm: SkillEvalArm;
  trial: number;
  position: 0 | 1;
  verdict: CorpusProofOutcome;
  /** Null when the dispatcher reported no cost; 0 for an attempt the spend ceiling kept from dispatching. */
  costUsd: number | null;
  servedModel: string | null;
  breach: string | null;
  headSha: string | null;
  reasons: string[];
}

export interface SkillEvalTaskRate {
  taskId: string;
  /** False when any of the task's attempts was unmeasurable, or an arm has none. Its rates are then null. */
  measurable: boolean;
  passRateWith: number | null;
  passRateWithout: number | null;
}

export type SkillEvalVerdictReason = "held-out-benefit" | "too-few-measurable-tasks" | "no-benefit" | "per-task-regression";

export interface SkillEvalVerdict {
  verdict: "pass" | "refuse";
  reason: SkillEvalVerdictReason;
  detail: string;
  perTask: SkillEvalTaskRate[];
  /** Mean over measurable tasks of (with-skill pass rate − without-skill pass rate); null when none is measurable. */
  delta: number | null;
  measurableTasks: number;
  totalCostUsd: number;
}

/**
 * The draft's verdict over its attempts. It refuses when fewer than K tasks are measurable (a task with any
 * unmeasurable attempt is unmeasurable, never a win), when the mean delta is ≤ 0, or when any task's with-skill
 * pass rate is below its without-skill rate, whatever the mean.
 */
export function skillEvalVerdict(attempts: readonly Pick<SkillEvalAttempt, "taskId" | "arm" | "verdict" | "costUsd">[]): SkillEvalVerdict {
  const scored = [...new Set(attempts.map((a) => a.taskId))].map((taskId) => {
    const own = attempts.filter((a) => a.taskId === taskId);
    const rate = (arm: SkillEvalArm): number | null => {
      const runs = own.filter((a) => a.arm === arm);
      return runs.length === 0 ? null : runs.filter((a) => a.verdict === "pass").length / runs.length;
    };
    const [withSkill, withoutSkill] = [rate("with-skill"), rate("without-skill")];
    const diff = own.every((a) => a.verdict !== "unmeasurable") && withSkill !== null && withoutSkill !== null ? withSkill - withoutSkill : null;
    const measured = diff !== null;
    const row: SkillEvalTaskRate = { taskId, measurable: measured, passRateWith: measured ? withSkill : null,
      passRateWithout: measured ? withoutSkill : null };
    return { row, diff };
  });
  const perTask = scored.map((s) => s.row);
  const diffs = scored.flatMap((s) => (s.diff === null ? [] : [{ taskId: s.row.taskId, diff: s.diff }]));
  const delta = diffs.length === 0 ? null : diffs.reduce((sum, d) => sum + d.diff, 0) / diffs.length;
  const base = { perTask, delta, measurableTasks: diffs.length, totalCostUsd: attempts.reduce((sum, a) => sum + (a.costUsd ?? 0), 0) };
  const refuse = (reason: SkillEvalVerdictReason, detail: string): SkillEvalVerdict => ({ verdict: "refuse", reason, detail, ...base });
  if (delta === null || diffs.length < SKILL_EVAL_HELD_OUT_TASKS) {
    return refuse("too-few-measurable-tasks", `${diffs.length} of ${SKILL_EVAL_HELD_OUT_TASKS} held-out tasks were measurable`);
  }
  if (delta <= 0) return refuse("no-benefit", `the mean with-skill minus without-skill pass rate is ${delta}`);
  const regressed = diffs.filter((d) => d.diff < 0).map((d) => d.taskId);
  if (regressed.length > 0) return refuse("per-task-regression", `the draft lowers the pass rate on ${regressed.join(", ")}`);
  return { verdict: "pass", reason: "held-out-benefit", detail: `mean pass-rate gain ${delta} with no task regressed`, ...base };
}

export interface SkillEvalRunInput {
  selection: HeldOutSelected;
  draftMarkdown: string;
  /** One dispatcher per held-out task, since the sealed dispatcher caches its base per instance. Production builds
   *  `sealedPairedAttemptDispatcher` at `baseRef: item.baseSha` with the draft as the with-skill arm's skills part. */
  dispatcherFor: (item: GoldenCorpusItem) => PairedAttemptDispatch<SkillEvalArm>;
  /** The one stack both arms run on. */
  stack: Pick<PairedAttemptRequest<SkillEvalArm>, "pin" | "revisions" | "stackEvidence">;
  /** Absent: the item's proofs through the reviewer's own executor. */
  grade?: PairedGrader;
  /** The invocation's argv: the run spends only with `--confirm-spend` (`replayOptIn`). */
  argv: readonly string[];
  idle: ReplayIdleSignal;
  log: (step: string, row: Record<string, unknown>) => void;
}

export type SkillEvalRunRefusal = "spend-not-confirmed" | "fleet-not-idle" | "draft-not-selected" | "too-few-held-out-tasks"
  | "over-spend-ceiling";

export type SkillEvalRun =
  | { state: "refused"; reason: SkillEvalRunRefusal; detail: string; dispatched: 0 }
  | { state: "evaluated"; verdict: SkillEvalVerdict; attempts: SkillEvalAttempt[] };

async function runSkillEvalAttempt(input: SkillEvalRunInput, item: GoldenCorpusItem, slot: SkillEvalSlot,
  dispatch: PairedAttemptDispatch<SkillEvalArm>): Promise<SkillEvalAttempt> {
  const draftSha256 = input.selection.draftSha256;
  const reasons: string[] = [];
  let attempt: PairedAttemptResult | null = null;
  try {
    attempt = await dispatch({ pilotId: `skill-eval-${draftSha256.slice(0, 16)}`, taskId: item.taskId, arm: slot.arm,
      pairId: `skill-eval-${sha256(`${draftSha256}\0${item.taskId}\0${slot.trial}`).slice(0, 16)}`, position: slot.position,
      ...input.stack, isolation: { worktree: "fresh-detached", push: false, openPr: false, merge: false } });
  } catch {
    const reason = "attempt-failed";
    reasons.push(reason);
  }
  const breach = attempt?.pushedRef || attempt?.prUrl || attempt?.breach || null;
  const headDir = breach === null ? attempt?.headDir ?? null : null;
  let grade: PairedGrade | null = null;
  if (breach !== null) reasons.push("isolation-breach");
  else if (attempt !== null && headDir === null) reasons.push("no-head");
  else if (headDir !== null) {
    try {
      grade = await (input.grade ?? ((req) => gradeHeadWithReviewerExecutor(req.criteria, req.headDir)))({ taskId: item.taskId,
        headDir, criteria: item.proofs });
    } catch {
      const reason = "grading-failed";
      reasons.push(reason);
    }
  }
  if (grade?.verdict === "unmeasurable") reasons.push(`ungradeable:${grade.reasons.join("+")}`);
  const verdict: CorpusProofOutcome = grade !== null && reasons.length === 0 ? grade.verdict : "unmeasurable";
  try { attempt?.cleanup?.(); }
  catch {
    const reason = "cleanup-failed";
    reasons.push(reason);
  }
  return { taskId: item.taskId, ...slot, verdict, costUsd: attempt?.costUsd ?? null, servedModel: attempt?.servedModel ?? null,
    breach, headSha: attempt?.headSha ?? null, reasons };
}

/**
 * Attempt the draft on each held-out task, R trials per arm in {@link skillEvalTrialOrder}, grade every head and
 * clean it up, log one `skill_eval.attempt` row per attempt and one `skill_eval.result` row, and return the verdict.
 * Refuses, having dispatched nothing, without `--confirm-spend`, when the fleet is not idle, when the draft is not
 * the one the selection was drawn for, or when the attempts could exceed {@link SKILL_EVAL_MAX_SPEND_USD}.
 */
export async function runSkillEval(input: SkillEvalRunInput): Promise<SkillEvalRun> {
  const { selection } = input;
  const tag = { draft_sha256: selection.draftSha256, held_out_set_hash: selection.heldOutSetHash };
  const refuse = (reason: SkillEvalRunRefusal, detail: string): SkillEvalRun => {
    input.log(SKILL_EVAL_STEPS.refused, { ...tag, reason, detail });
    return { state: "refused", reason, detail, dispatched: 0 };
  };
  const optIn = replayOptIn(input.argv);
  if (!optIn.enabled) return refuse("spend-not-confirmed", optIn.reason);
  const idle = replayIdleGate(input.idle);
  if (!idle.enabled) return refuse("fleet-not-idle", idle.reason);
  if (sha256(input.draftMarkdown) !== selection.draftSha256) {
    return refuse("draft-not-selected", "the draft's sha256 is not the one that drew this held-out set");
  }
  const tasks = selection.items.length;
  if (tasks < SKILL_EVAL_HELD_OUT_TASKS) return refuse("too-few-held-out-tasks", `${tasks} held-out task(s), a pass needs ${SKILL_EVAL_HELD_OUT_TASKS}`);
  const planned = tasks * SKILL_EVAL_TRIALS_PER_ARM * SKILL_EVAL_ARMS.length;
  if (planned * PAIRED_ATTEMPT_MAX_BUDGET_USD > SKILL_EVAL_MAX_SPEND_USD) {
    return refuse("over-spend-ceiling", `${planned} attempts at up to $${PAIRED_ATTEMPT_MAX_BUDGET_USD} each could exceed $${SKILL_EVAL_MAX_SPEND_USD}`);
  }
  const attempts: SkillEvalAttempt[] = [];
  let committedUsd = 0;
  for (const item of selection.items) {
    const dispatch = input.dispatcherFor(item);
    for (const slot of skillEvalTrialOrder(selection.draftSha256, item.taskId)) {
      // An unreported cost counts at the cap. An attempt that overshot its budget can leave too little room for one more.
      const attempt = committedUsd + PAIRED_ATTEMPT_MAX_BUDGET_USD > SKILL_EVAL_MAX_SPEND_USD
        ? { taskId: item.taskId, ...slot, verdict: "unmeasurable" as const, costUsd: 0, servedModel: null, breach: null, headSha: null,
          reasons: ["spend-ceiling-reached"] }
        : await runSkillEvalAttempt(input, item, slot, dispatch);
      committedUsd += attempt.costUsd ?? PAIRED_ATTEMPT_MAX_BUDGET_USD;
      attempts.push(attempt);
      input.log(SKILL_EVAL_STEPS.attempt, { ...tag, task_id: attempt.taskId, arm: attempt.arm, trial: attempt.trial,
        position: attempt.position, verdict: attempt.verdict, cost_usd: attempt.costUsd, served_model: attempt.servedModel,
        breach: attempt.breach, head_sha: attempt.headSha, reasons: attempt.reasons });
    }
  }
  const verdict = skillEvalVerdict(attempts);
  input.log(SKILL_EVAL_STEPS.result, { ...tag, verdict: verdict.verdict, reason: verdict.reason, detail: verdict.detail,
    per_task: verdict.perTask, delta: verdict.delta, measurable_tasks: verdict.measurableTasks, total_cost_usd: verdict.totalCostUsd,
    attempts: attempts.length });
  return { state: "evaluated", verdict, attempts };
}
