import { DEFAULT_KNOWLEDGE_BUDGET_CHARS, learningMatchKinds, loadLayeredLearningsForTaskFiles, selectLearnings,
  type LayeredLearningsHomes, type LearningMatchKind } from "./learnings.js";
import { taskArmWithheld } from "./task-arm.js";

/**
 * W1-T14138: a fix round MEASURES which learnings its failing checks would match before anything is injected.
 * Only a symbol or an error-signature match counts: 7 of 128 learnings carry either, a file-only match is generic
 * and irrelevant context lowers accuracy (Shi et al., ICML 2023), so the recorder passes no task files.
 *
 * INVARIANT shadow-injects-nothing: nothing here reaches the fix prompt. The arm only labels the row, so W1-T14139
 * can compare outcomes across a task-keyed randomized split before it decides to inject.
 */

/** The unit of the withholding draw; independent of every skill's draw. */
export const FIX_LEARNINGS_UNIT = "fix-learnings";
/** Predeclared share of tasks drawn into the withheld arm. */
export const FIX_LEARNINGS_SHARE = 0.25;
/** A redesigned experiment takes a new epoch, which redraws every task. */
export const FIX_LEARNINGS_EPOCH = "fix-learnings-shadow-v1";

export const FIX_LEARNINGS_SHADOW_STEP = "fix.learnings_shadow";
export const FIX_LEARNINGS_OUTCOME_STEP = "fix.learnings_outcome";

/** The most of one failing check's log tail read into the selection text. */
const LOG_TAIL_CHARS = 4000;
const MAX_CHECKS = 20;

export type FixLearningsArm = "offered" | "withheld";

/** The kinds a round records: never `file`. */
export type FixLearningsMatchKind = Exclude<LearningMatchKind, "file">;

export interface FixLearningsMatch {
  id: string;
  kinds: FixLearningsMatchKind[];
}

/** The slice of a round's evidence the selection text is built from; structural so the fix lane's own types satisfy it. */
export interface FixLearningsEvidence {
  ciFailures?: readonly { name: string; title?: string; statusDescription?: string; logTail: string }[];
  review?: {
    summary?: string;
    unmetCriteria: readonly { claim: string; reason?: string }[];
    findings?: readonly { path: string; mechanism: string; remedy: string | null }[];
  };
}

/** This task's arm in the fix-learnings split: drawn on the TASK, so every round of every run agrees. */
export function fixLearningsArm(taskId: string): FixLearningsArm {
  return taskArmWithheld({ taskId, unit: FIX_LEARNINGS_UNIT, share: FIX_LEARNINGS_SHARE, epoch: FIX_LEARNINGS_EPOCH })
    ? "withheld" : "offered";
}

/** The round's failure text: failing check names, titles and bounded log tails, then the review's unmet claims and findings. */
export function fixLearningsSelectionText(evidence: FixLearningsEvidence): string[] {
  const parts: string[] = [];
  for (const failure of (evidence.ciFailures ?? []).slice(0, MAX_CHECKS)) {
    parts.push(failure.name, failure.title ?? "", failure.statusDescription ?? "", failure.logTail.slice(-LOG_TAIL_CHARS));
  }
  const review = evidence.review;
  if (review) {
    parts.push(review.summary ?? "");
    for (const claim of review.unmetCriteria) parts.push(claim.claim, claim.reason ?? "");
    for (const finding of review.findings ?? []) parts.push(finding.mechanism, finding.remedy ?? "");
  }
  return parts.filter((part) => part.length > 0);
}

export interface FixLearningsShadowInput {
  taskId: string;
  pr?: number;
  attempt: number;
  round: string;
  /** The key `fix.learnings_outcome` joins on. */
  roundKey: string;
  evidence: FixLearningsEvidence;
  homes: LayeredLearningsHomes;
  budgetChars?: number;
  log: (step: string, extra: Record<string, unknown>) => void;
}

/**
 * Write the round's one `fix.learnings_shadow` row and return what it recorded. A failure to read the corpus is
 * recorded on the row (`outcome: "unreadable"`), never thrown: the measurement must not stop a fix round.
 * Both arms record the same match; the arm only labels the row.
 */
export function recordFixLearningsShadow(input: FixLearningsShadowInput): { arm: FixLearningsArm; matches: FixLearningsMatch[] } {
  const arm = fixLearningsArm(input.taskId);
  const budget = input.budgetChars ?? DEFAULT_KNOWLEDGE_BUDGET_CHARS;
  const checkNames = (input.evidence.ciFailures ?? []).map((failure) => failure.name);
  const base = {
    task_id: input.taskId, pr: input.pr, strike: input.attempt, round: input.round, round_key: input.roundKey,
    arm, arm_unit: FIX_LEARNINGS_UNIT, arm_epoch: FIX_LEARNINGS_EPOCH, share: FIX_LEARNINGS_SHARE,
    budget_chars: budget, check_names: checkNames,
  };
  const context = { text: fixLearningsSelectionText(input.evidence) };
  const matches: FixLearningsMatch[] = [];
  try {
    // taskFiles is undefined on purpose: with no path, only a symbol or an error hit admits an entry.
    const { entries } = loadLayeredLearningsForTaskFiles(input.homes, undefined, context);
    for (const entry of selectLearnings(entries, undefined, budget, context).selected) {
      const kinds = learningMatchKinds(entry, undefined, context).filter((kind): kind is FixLearningsMatchKind => kind !== "file");
      if (kinds.length > 0) matches.push({ id: entry.id, kinds });
    }
  } catch (error) {
    input.log(FIX_LEARNINGS_SHADOW_STEP, { ...base, outcome: "unreadable", reason: String((error as Error)?.message ?? error).slice(0, 300),
      matched: [] });
    return { arm, matches };
  }
  input.log(FIX_LEARNINGS_SHADOW_STEP, { ...base, outcome: "recorded", matched: matches });
  return { arm, matches };
}

export type FixLearningsCiConclusion = "green" | "red" | "no_push" | "other";

/** The CI gate's state on the pushed head, folded to the three answers the experiment reads. */
export function fixLearningsCiConclusion(pushedHeadSha: string | undefined, ciState: string | undefined): FixLearningsCiConclusion {
  if (pushedHeadSha === undefined) return "no_push";
  if (ciState === "green" || ciState === "red") return ciState;
  return "other";
}

export interface FixLearningsOutcomeInput {
  taskId: string;
  roundKey: string;
  attempt: number;
  pushedHeadSha?: string;
  ciState?: string;
  log: (step: string, extra: Record<string, unknown>) => void;
}

/** Write the round's one `fix.learnings_outcome` row: the CI conclusion on the head the round pushed, or that it pushed nothing. */
export function recordFixLearningsOutcome(input: FixLearningsOutcomeInput): FixLearningsCiConclusion {
  const ciConclusion = fixLearningsCiConclusion(input.pushedHeadSha, input.ciState);
  input.log(FIX_LEARNINGS_OUTCOME_STEP, {
    task_id: input.taskId, round_key: input.roundKey, strike: input.attempt, ci_conclusion: ciConclusion,
    ...(input.pushedHeadSha === undefined ? {} : { pushed_head_sha: input.pushedHeadSha }),
    ...(input.ciState === undefined ? {} : { ci_state: input.ciState }),
  });
  return ciConclusion;
}

export interface FixLearningsArmSummary {
  rounds: number;
  roundsWithMatch: number;
  /** Rounds with at least one match of each kind, over rounds. */
  matchRateByKind: Record<FixLearningsMatchKind, number>;
  /** Rounds with an outcome row, and each conclusion's share of them. */
  roundsWithOutcome: number;
  outcomeRates: Record<FixLearningsCiConclusion, number>;
  /** Per task: rounds up to and including the first green one; absent when no round went green. */
  roundsToGreen: Record<string, number>;
}

type Row = Record<string, unknown>;

const rate = (n: number, of: number): number => (of === 0 ? 0 : n / of);

/** Pure: what W1-T14139 reads to decide when to inject. Joins each shadow row to its outcome row by `round_key`. */
export function summarizeFixLearningsShadow(rows: readonly Row[]): Record<FixLearningsArm, FixLearningsArmSummary> {
  const outcomes = new Map<string, Row>();
  for (const row of rows) if (row.step === FIX_LEARNINGS_OUTCOME_STEP && typeof row.round_key === "string") outcomes.set(row.round_key, row);
  const empty = (): FixLearningsArmSummary & { _outcomes: Record<FixLearningsCiConclusion, number>; _kinds: Record<FixLearningsMatchKind, number> } => ({
    rounds: 0, roundsWithMatch: 0, matchRateByKind: { error: 0, symbol: 0 }, roundsWithOutcome: 0,
    outcomeRates: { green: 0, red: 0, no_push: 0, other: 0 }, roundsToGreen: {},
    _outcomes: { green: 0, red: 0, no_push: 0, other: 0 }, _kinds: { error: 0, symbol: 0 },
  });
  const acc = { offered: empty(), withheld: empty() };
  const perTask = new Map<string, number>();
  const settled = new Set<string>();
  for (const row of rows) {
    if (row.step !== FIX_LEARNINGS_SHADOW_STEP || row.outcome === "unreadable") continue;
    const arm: FixLearningsArm = row.arm === "withheld" ? "withheld" : "offered";
    const a = acc[arm];
    a.rounds++;
    const matched = Array.isArray(row.matched) ? (row.matched as FixLearningsMatch[]) : [];
    if (matched.length > 0) a.roundsWithMatch++;
    for (const kind of ["error", "symbol"] as const) if (matched.some((m) => m.kinds?.includes(kind))) a._kinds[kind]++;
    const outcome = typeof row.round_key === "string" ? outcomes.get(row.round_key) : undefined;
    if (!outcome) continue;
    const conclusion = outcome.ci_conclusion as FixLearningsCiConclusion;
    a.roundsWithOutcome++;
    a._outcomes[conclusion in a._outcomes ? conclusion : "other"]++;
    const task = typeof row.task_id === "string" ? row.task_id : undefined;
    if (task === undefined || settled.has(task)) continue;
    perTask.set(task, (perTask.get(task) ?? 0) + 1);
    if (conclusion === "green") { settled.add(task); a.roundsToGreen[task] = perTask.get(task)!; }
  }
  const finish = (a: ReturnType<typeof empty>): FixLearningsArmSummary => ({
    rounds: a.rounds, roundsWithMatch: a.roundsWithMatch,
    matchRateByKind: { error: rate(a._kinds.error, a.rounds), symbol: rate(a._kinds.symbol, a.rounds) },
    roundsWithOutcome: a.roundsWithOutcome,
    outcomeRates: { green: rate(a._outcomes.green, a.roundsWithOutcome), red: rate(a._outcomes.red, a.roundsWithOutcome),
      no_push: rate(a._outcomes.no_push, a.roundsWithOutcome), other: rate(a._outcomes.other, a.roundsWithOutcome) },
    roundsToGreen: a.roundsToGreen,
  });
  return { offered: finish(acc.offered), withheld: finish(acc.withheld) };
}
