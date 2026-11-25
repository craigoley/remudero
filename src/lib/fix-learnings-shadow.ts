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
  /** The dispatched round's own id: the key its outcome, `fix.dispatch` and `fix.done` rows share. */
  roundId: string;
  evidence: FixLearningsEvidence;
  /** Resolved inside the recorder, so a home that cannot be resolved is recorded rather than thrown. */
  homes: () => LayeredLearningsHomes;
  budgetChars?: number;
  log: (step: string, extra: Record<string, unknown>) => void;
}

export type FixLearningsCiConclusion = "green" | "red" | "no_push" | "other";

/** What the round's CI wait read: the gate's state, and the head it read it on when it names one. */
export interface FixLearningsCi {
  state: string;
  sha?: string;
}

/** The CI gate's state on the pushed head, folded to the answers the experiment reads. A state read on another head says
 *  nothing about the pushed one, so it is `other`. */
export function fixLearningsCiConclusion(pushedHeadSha: string | undefined, ci?: FixLearningsCi): FixLearningsCiConclusion {
  if (pushedHeadSha === undefined) return "no_push";
  if (ci?.sha !== undefined && ci.sha !== pushedHeadSha) return "other";
  return ci?.state === "green" || ci?.state === "red" ? ci.state : "other";
}

/** One dispatched round awaiting its outcome. It writes exactly one `fix.learnings_outcome` row. */
export interface FixLearningsRound {
  /** The round's push settled. A landed head waits for CI; no head is written at once as `no_push`, or as `other` when
   *  the remote head could not be read and whether it pushed is unknown. */
  landed(pushedHeadSha: string | undefined, landing?: { landed: boolean; outcome?: string }): void;
  /** Write the outcome from what is known now; a call after the row is written does nothing. */
  settle(ci?: FixLearningsCi): void;
}

function openRound(input: FixLearningsShadowInput): FixLearningsRound {
  let written = false;
  let pushed: string | undefined;
  const write = (ciConclusion: FixLearningsCiConclusion, extra: Record<string, unknown>): void => {
    if (written) return;
    written = true;
    input.log(FIX_LEARNINGS_OUTCOME_STEP, {
      task_id: input.taskId, round_id: input.roundId, attempt: input.attempt, ci_conclusion: ciConclusion, ...extra,
    });
  };
  const settle = (ci?: FixLearningsCi): void => write(fixLearningsCiConclusion(pushed, ci), {
    ...(pushed === undefined ? {} : { pushed_head_sha: pushed }),
    ...(ci === undefined ? {} : { ci_state: ci.state, ...(ci.sha === undefined ? {} : { ci_head_sha: ci.sha }) }),
  });
  return {
    landed(pushedHeadSha, landing) {
      pushed = pushedHeadSha;
      if (pushedHeadSha !== undefined) return;
      if (landing?.outcome === "remote_unreadable") write("other", { push_unread: true });
      else settle();
    },
    settle,
  };
}

export interface FixLearningsShadow {
  arm: FixLearningsArm;
  matches: FixLearningsMatch[];
  round: FixLearningsRound;
}

/**
 * Write the round's one `fix.learnings_shadow` row, and return what it recorded with the round its outcome is written
 * on. A failure to read the corpus is recorded on the row (`outcome: "unreadable"`), never thrown: the measurement must
 * not stop a fix round. Both arms record the same match; the arm only labels the row.
 */
export function recordFixLearningsShadow(input: FixLearningsShadowInput): FixLearningsShadow {
  const arm = fixLearningsArm(input.taskId);
  const budget = input.budgetChars ?? DEFAULT_KNOWLEDGE_BUDGET_CHARS;
  const checkNames = (input.evidence.ciFailures ?? []).map((failure) => failure.name);
  const base = {
    task_id: input.taskId, pr: input.pr, attempt: input.attempt, round: input.round, round_id: input.roundId,
    arm, arm_unit: FIX_LEARNINGS_UNIT, arm_epoch: FIX_LEARNINGS_EPOCH, share: FIX_LEARNINGS_SHARE,
    budget_chars: budget, check_names: checkNames,
  };
  const matches: FixLearningsMatch[] = [];
  try {
    const context = { text: fixLearningsSelectionText(input.evidence) };
    // taskFiles is undefined on purpose: with no path, only a symbol or an error hit admits an entry.
    const { entries } = loadLayeredLearningsForTaskFiles(input.homes(), undefined, context);
    for (const entry of selectLearnings(entries, undefined, budget, context).selected) {
      const kinds = learningMatchKinds(entry, undefined, context).filter((kind): kind is FixLearningsMatchKind => kind !== "file");
      if (kinds.length > 0) matches.push({ id: entry.id, kinds });
    }
  } catch (error) {
    input.log(FIX_LEARNINGS_SHADOW_STEP, { ...base, outcome: "unreadable", reason: String((error as Error)?.message ?? error).slice(0, 300),
      matched: [] });
    return { arm, matches, round: openRound(input) };
  }
  input.log(FIX_LEARNINGS_SHADOW_STEP, { ...base, outcome: "recorded", matched: matches });
  return { arm, matches, round: openRound(input) };
}

export interface FixLearningsArmSummary {
  rounds: number;
  roundsWithMatch: number;
  /** Rounds with at least one match of each kind, over rounds. */
  matchRateByKind: Record<FixLearningsMatchKind, number>;
  /** Rounds with an outcome row, and each conclusion's share of them. */
  roundsWithOutcome: number;
  outcomeRates: Record<FixLearningsCiConclusion, number>;
  /** Per task: its fix rounds (`fix.dispatch` and `fix.done` rows) up to and including the first green one; absent when
   *  no round went green. */
  roundsToGreen: Record<string, number>;
}

type Row = Record<string, unknown>;

const rate = (n: number, of: number): number => (of === 0 ? 0 : n / of);

/** Pure: what W1-T14139 reads to decide when to inject. Rows are in ledger order; `round_id` joins a shadow row to its
 *  outcome row and to the task's `fix.dispatch` and `fix.done` rows. */
export function summarizeFixLearningsShadow(rows: readonly Row[]): Record<FixLearningsArm, FixLearningsArmSummary> {
  const outcomes = new Map<string, Row>();
  for (const row of rows) if (row.step === FIX_LEARNINGS_OUTCOME_STEP && typeof row.round_id === "string") outcomes.set(row.round_id, row);
  const empty = () => ({
    rounds: 0, roundsWithMatch: 0, roundsWithOutcome: 0, roundsToGreen: {} as Record<string, number>,
    outcomes: { green: 0, red: 0, no_push: 0, other: 0 }, kinds: { error: 0, symbol: 0 },
  });
  const acc = { offered: empty(), withheld: empty() };
  const arms = new Map<string, FixLearningsArm>();
  for (const row of rows) {
    if (row.step !== FIX_LEARNINGS_SHADOW_STEP) continue;
    const arm: FixLearningsArm = row.arm === "withheld" ? "withheld" : "offered";
    if (typeof row.round_id === "string") arms.set(row.round_id, arm);
    if (row.outcome === "unreadable") continue;
    const a = acc[arm];
    a.rounds++;
    const matched = Array.isArray(row.matched) ? (row.matched as FixLearningsMatch[]) : [];
    if (matched.length > 0) a.roundsWithMatch++;
    for (const kind of ["error", "symbol"] as const) if (matched.some((m) => m.kinds?.includes(kind))) a.kinds[kind]++;
    const outcome = typeof row.round_id === "string" ? outcomes.get(row.round_id) : undefined;
    if (!outcome) continue;
    const conclusion = outcome.ci_conclusion as FixLearningsCiConclusion;
    a.roundsWithOutcome++;
    a.outcomes[conclusion in a.outcomes ? conclusion : "other"]++;
  }
  const taskRounds = new Map<string, Set<string>>();
  const settled = new Set<string>();
  for (const { step, task_id: task, round_id: roundId, ci_conclusion: conclusion } of rows) {
    if (typeof task !== "string" || typeof roundId !== "string" || settled.has(task)) continue;
    const seen = taskRounds.get(task) ?? new Set<string>();
    if (step === "fix.dispatch" || step === "fix.done") taskRounds.set(task, seen.add(roundId));
    const arm = arms.get(roundId);
    if (step !== FIX_LEARNINGS_OUTCOME_STEP || conclusion !== "green" || arm === undefined) continue;
    settled.add(task);
    acc[arm].roundsToGreen[task] = seen.add(roundId).size;
  }
  const finish = (a: ReturnType<typeof empty>): FixLearningsArmSummary => ({
    rounds: a.rounds, roundsWithMatch: a.roundsWithMatch,
    matchRateByKind: { error: rate(a.kinds.error, a.rounds), symbol: rate(a.kinds.symbol, a.rounds) },
    roundsWithOutcome: a.roundsWithOutcome,
    outcomeRates: { green: rate(a.outcomes.green, a.roundsWithOutcome), red: rate(a.outcomes.red, a.roundsWithOutcome),
      no_push: rate(a.outcomes.no_push, a.roundsWithOutcome), other: rate(a.outcomes.other, a.roundsWithOutcome) },
    roundsToGreen: a.roundsToGreen,
  });
  return { offered: finish(acc.offered), withheld: finish(acc.withheld) };
}
