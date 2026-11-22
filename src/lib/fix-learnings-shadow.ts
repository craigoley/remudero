import {
  DEFAULT_KNOWLEDGE_BUDGET_CHARS,
  learningMatchCounts,
  loadLayeredLearningsForTaskFiles,
  selectLearnings,
  type LayeredLearningsHomes,
} from "./learnings.js";
import { TASK_ARM_UNIT, taskArmWithheld } from "./task-arm.js";

/**
 * W1-T14138: a fix round MEASURES which learnings its failure would match before any is injected.
 * Irrelevant context lowers model accuracy (Shi et al., ICML 2023; Chroma, "Context Rot", 2025), and only
 * a few learnings carry `symbols:` or `error_signatures:`, so a file-only match is generic. The fix lane
 * therefore records, per round, what the SAME loader and selector the implement lane uses would pick from
 * the failure text, under a task-keyed withheld arm, and injects nothing in either arm.
 *
 * INVARIANT shadow-injects-nothing: this module returns a ledger row and never a prompt part; the fix
 * prompt is byte-identical in both arms.
 * INVARIANT symbol-or-error-only: the selection runs with `taskFiles` undefined, so no learning is admitted
 * by file path alone.
 */

/** What is withheld: the unit of the task-keyed draw. */
export const FIX_LEARNINGS_UNIT = "fix-learnings";
/** A new epoch redraws every task, so a redesigned experiment never inherits this assignment. */
export const FIX_LEARNINGS_EPOCH = "fix-learnings-shadow-v1";
/** Predeclared share of tasks drawn into the withheld arm. */
export const FIX_LEARNINGS_SHARE = 0.25;
/** The most log text one failing check contributes to the selection text: its tail, where the error is. */
export const FIX_LEARNINGS_LOG_TAIL_CHARS = 4000;
/** The most failing checks one round reads, so a pathological rollup cannot grow the selection text. */
export const FIX_LEARNINGS_MAX_CHECKS = 20;

export type FixLearningsArm = "offered" | "withheld";
export type FixLearningsMatchKind = "symbol" | "error" | "both";
/** `green`/`red`: the CI conclusion on the head the round pushed. `no_push`: nothing landed. `unknown`: the read failed. */
export type FixLearningsConclusion = "green" | "red" | "no_push" | "unknown";

export interface FixLearningsFailingCheck {
  name: string;
  title?: string;
  logTail?: string;
}

export interface FixLearningsShadowInput {
  runId: string;
  taskId: string;
  pr: number | undefined;
  attempt: number;
  round: string;
  failingChecks: readonly FixLearningsFailingCheck[];
  /** The review's unmet criteria claims, when the round carries a review. */
  unmetClaims?: readonly string[];
  /** The review's finding texts, when the round carries a review. */
  findings?: readonly string[];
  homes: LayeredLearningsHomes;
  budgetChars?: number;
}

export interface FixLearningsShadowDeps {
  load: typeof loadLayeredLearningsForTaskFiles;
  select: typeof selectLearnings;
}

const REAL_DEPS: FixLearningsShadowDeps = { load: loadLayeredLearningsForTaskFiles, select: selectLearnings };

type Log = (step: string, extra?: Record<string, unknown>) => void;

/** True when `taskId` is drawn into the withheld arm. Every round of one task, from any lane, draws the same arm. */
export function fixLearningsArm(taskId: string): FixLearningsArm {
  return taskArmWithheld({ taskId, unit: FIX_LEARNINGS_UNIT, share: FIX_LEARNINGS_SHARE, epoch: FIX_LEARNINGS_EPOCH })
    ? "withheld" : "offered";
}

/** The failure text a round is matched on: check names, titles and bounded log tails, then the review's claims and findings. */
export function fixFailureSelectionText(input: Pick<FixLearningsShadowInput, "failingChecks" | "unmetClaims" | "findings">): string[] {
  const parts: string[] = [];
  for (const check of input.failingChecks.slice(0, FIX_LEARNINGS_MAX_CHECKS)) {
    parts.push(check.name, check.title ?? "", (check.logTail ?? "").slice(-FIX_LEARNINGS_LOG_TAIL_CHARS));
  }
  parts.push(...(input.unmetClaims ?? []), ...(input.findings ?? []));
  return parts;
}

/**
 * Select what the round's failure text would match and write ONE `fix.learnings_shadow` row. Returns the row
 * so a caller can read it; it injects nothing. A loader that throws writes the row with `state: "unreadable"`
 * and its reason, so a read failure is never counted as "nothing matched".
 */
export function recordFixLearningsShadow(
  input: FixLearningsShadowInput,
  log: Log,
  deps: FixLearningsShadowDeps = REAL_DEPS,
): Record<string, unknown> {
  const budgetChars = input.budgetChars ?? DEFAULT_KNOWLEDGE_BUDGET_CHARS;
  const base = {
    run_id: input.runId, task_id: input.taskId, pr: input.pr, attempt: input.attempt, round: input.round,
    arm: fixLearningsArm(input.taskId), arm_unit: TASK_ARM_UNIT, arm_epoch: FIX_LEARNINGS_EPOCH,
    arm_share: FIX_LEARNINGS_SHARE, budget_chars: budgetChars,
    failing_checks: input.failingChecks.slice(0, FIX_LEARNINGS_MAX_CHECKS).map((check) => check.name),
  };
  const context = { text: fixFailureSelectionText(input) };
  let row: Record<string, unknown>;
  try {
    const { entries } = deps.load(input.homes, undefined, context);
    const { selected } = deps.select(entries, undefined, budgetChars, context);
    const matched = selected.map((entry) => {
      const counts = learningMatchCounts(entry, undefined, context);
      const kind: FixLearningsMatchKind = counts.error > 0 ? (counts.symbol > 0 ? "both" : "error") : "symbol";
      return { id: entry.id, kind, symbol: counts.symbol, error: counts.error };
    });
    row = { ...base, state: "ok", matched_ids: matched.map((m) => m.id), matched };
  } catch (error) {
    row = { ...base, state: "unreadable", reason: String((error as Error)?.message ?? error).slice(0, 300), matched_ids: [], matched: [] };
  }
  log("fix.learnings_shadow", row);
  return row;
}

export interface FixLearningsOutcomeInput {
  runId: string;
  taskId: string;
  pr: number | undefined;
  attempt: number;
  roundId: string;
  /** The head the round pushed; undefined when it pushed nothing. */
  pushedHeadSha: string | undefined;
  /** What CI said about that head, when something was pushed. */
  ci: "green" | "red" | "unknown";
}

/** Write the round's `fix.learnings_outcome` row: the CI conclusion on the head it pushed, or that it pushed nothing. */
export function recordFixLearningsOutcome(input: FixLearningsOutcomeInput, log: Log): Record<string, unknown> {
  const conclusion: FixLearningsConclusion = input.pushedHeadSha === undefined ? "no_push" : input.ci;
  const row = {
    run_id: input.runId, task_id: input.taskId, pr: input.pr, attempt: input.attempt, round_id: input.roundId,
    conclusion, ...(input.pushedHeadSha === undefined ? {} : { pushed_head_sha: input.pushedHeadSha }),
  };
  log("fix.learnings_outcome", row);
  return row;
}

export interface FixLearningsArmSummary {
  /** Rounds with a readable shadow row. */
  rounds: number;
  roundsWithMatch: number;
  /** Rounds whose selection held at least one match of the kind, over `rounds`. */
  matchRateByKind: Record<FixLearningsMatchKind, number>;
  /** Rounds with an outcome row, by conclusion. */
  outcomes: Record<FixLearningsConclusion, number>;
  /** Rounds with an outcome row. */
  settled: number;
  /** Per conclusion, its share of `settled`; 0 when nothing settled. */
  outcomeRates: Record<FixLearningsConclusion, number>;
  tasks: number;
  tasksGreen: number;
  /** Mean of the tasks' rounds to green, over the tasks that reached green; undefined when none did. */
  meanRoundsToGreen: number | undefined;
}

export interface FixLearningsShadowSummary {
  offered: FixLearningsArmSummary;
  withheld: FixLearningsArmSummary;
  /** Per task, in first-seen order: its arm and the fix.done rounds up to its first green outcome. */
  tasks: { taskId: string; arm: FixLearningsArm; roundsToGreen: number | undefined }[];
}

const KINDS: readonly FixLearningsMatchKind[] = ["symbol", "error", "both"];
const CONCLUSIONS: readonly FixLearningsConclusion[] = ["green", "red", "no_push", "unknown"];
const rate = (n: number, d: number): number => (d === 0 ? 0 : n / d);

/**
 * Pure summary over ledger rows, per arm: the rounds with at least one match, the match rate by kind and the
 * outcome rates, joined with each task's rounds to green from its `fix.done` rows. What W1-T14139 reads to
 * decide when to inject.
 */
export function summarizeFixLearningsShadow(rows: readonly Record<string, unknown>[]): FixLearningsShadowSummary {
  const key = (row: Record<string, unknown>) => `${String(row.run_id)}\0${String(row.task_id)}\0${String(row.attempt)}`;
  const shadows = rows.filter((row) => row.step === "fix.learnings_shadow" && row.state === "ok");
  const outcomeByRound = new Map<string, { conclusion: FixLearningsConclusion; index: number }>();
  rows.forEach((row, index) => {
    if (row.step !== "fix.learnings_outcome" || !CONCLUSIONS.includes(row.conclusion as FixLearningsConclusion)) return;
    outcomeByRound.set(key(row), { conclusion: row.conclusion as FixLearningsConclusion, index });
  });

  const tasks = new Map<string, { arm: FixLearningsArm; firstGreenIndex: number | undefined }>();
  for (const shadow of shadows) {
    const taskId = String(shadow.task_id);
    const outcome = outcomeByRound.get(key(shadow));
    const seen = tasks.get(taskId) ?? { arm: shadow.arm as FixLearningsArm, firstGreenIndex: undefined };
    if (outcome?.conclusion === "green" && (seen.firstGreenIndex === undefined || outcome.index < seen.firstGreenIndex)) {
      seen.firstGreenIndex = outcome.index;
    }
    tasks.set(taskId, seen);
  }
  const roundsToGreen = (taskId: string, greenIndex: number | undefined): number | undefined => {
    if (greenIndex === undefined) return undefined;
    const done = new Set<string>();
    rows.slice(0, greenIndex + 1).forEach((row) => {
      if (row.step === "fix.done" && row.task_id === taskId) done.add(String(row.round_id));
    });
    return Math.max(done.size, 1);
  };
  const taskRows = [...tasks].map(([taskId, t]) => ({ taskId, arm: t.arm, roundsToGreen: roundsToGreen(taskId, t.firstGreenIndex) }));

  const summarize = (arm: FixLearningsArm): FixLearningsArmSummary => {
    const armShadows = shadows.filter((row) => row.arm === arm);
    const matchedKinds = armShadows.map((row) => new Set(((row.matched as { kind: string }[] | undefined) ?? []).map((m) => m.kind)));
    const outcomes = { green: 0, red: 0, no_push: 0, unknown: 0 } as Record<FixLearningsConclusion, number>;
    for (const shadow of armShadows) {
      const outcome = outcomeByRound.get(key(shadow));
      if (outcome) outcomes[outcome.conclusion]++;
    }
    const settled = CONCLUSIONS.reduce((n, c) => n + outcomes[c], 0);
    const armTasks = taskRows.filter((t) => t.arm === arm);
    const greens = armTasks.flatMap((t) => (t.roundsToGreen === undefined ? [] : [t.roundsToGreen]));
    return {
      rounds: armShadows.length,
      roundsWithMatch: matchedKinds.filter((kinds) => kinds.size > 0).length,
      matchRateByKind: Object.fromEntries(
        KINDS.map((kind) => [kind, rate(matchedKinds.filter((kinds) => kinds.has(kind)).length, armShadows.length)]),
      ) as Record<FixLearningsMatchKind, number>,
      outcomes,
      settled,
      outcomeRates: Object.fromEntries(CONCLUSIONS.map((c) => [c, rate(outcomes[c], settled)])) as Record<FixLearningsConclusion, number>,
      tasks: armTasks.length,
      tasksGreen: greens.length,
      meanRoundsToGreen: greens.length === 0 ? undefined : greens.reduce((a, b) => a + b, 0) / greens.length,
    };
  };
  return { offered: summarize("offered"), withheld: summarize("withheld"), tasks: taskRows };
}
