import { randomUUID } from "node:crypto";
import { globalArtifactPath, userOverallLearningsHome, type Config } from "./config.js";
import { DEFAULT_KNOWLEDGE_BUDGET_CHARS, learningMatchKinds, loadLayeredLearningsForTaskFiles, projectLearningsHome, selectLearnings,
  type LearningMatchKind } from "./learnings.js";
import { taskArmWithheld } from "./task-arm.js";

/**
 * W1-T14138: the fix lane MEASURES which learnings a round's failure would match before it injects any.
 * Each round records a `fix.learnings_shadow` row and, once known, a `fix.learnings_outcome` row; the
 * fix lane writes both, and {@link summarizeFixLearningsShadow} reads them back.
 *
 * INVARIANT shadow-injects-nothing: nothing here returns prompt text, in either arm.
 * INVARIANT symbol-or-error-only: selection runs with no task files, so a file glob never admits an entry.
 * FALSIFIER: test/learning/a-fix-round-records-the-learnings-its-failure-would-match.test.ts.
 */

const FIX_LEARNINGS_SHARE = 0.25;
const FIX_LEARNINGS_EPOCH = "fix-learnings-shadow-v1";
/** The newest characters of each failing check's log tail that selection reads. */
export const FIX_LEARNINGS_LOG_TAIL_CHARS = 8_000;

export type FixLearningsArm = "offered" | "withheld";
/** What CI concluded on the head a round pushed, or that it pushed nothing. */
export type FixLearningsConclusion = "green" | "red" | "no_push";

/** One round's open measurement, keyed to its dispatch and completion rows. */
export interface FixLearningsRound {
  /** The `fix.learnings_shadow` row's fields. */
  readonly row: FixLearningsShadowRow;
  /** The ledger as the round's first prompt read it: the earlier rounds `rounds_to_green` counts. */
  readonly priorRows: ReadonlyArray<Record<string, unknown>>;
  /** Set when the round pushed; `head` is absent when the push landed on a head nobody could name. */
  pushed?: { head?: string };
}

type FixLearningsShadowRow = { shadow_id: string; run_id: string; task_id: string; round_id: string; arm: FixLearningsArm } &
  Record<string, unknown>;
type FixLearningsOutcomeFields = { run_id: string; task_id: string } & Record<string, unknown>;

interface FixLearningsEvidence {
  ciFailures?: readonly { name: string; title?: string; logTail: string }[];
  review?: {
    unmetCriteria: readonly { claim: string }[];
    findings?: readonly { mechanism: string; remedy?: string | null }[];
  };
}

function selectionText(evidence: FixLearningsEvidence): string[] {
  return [
    ...(evidence.ciFailures ?? []).flatMap((f) => [f.name, f.title ?? "", f.logTail.slice(-FIX_LEARNINGS_LOG_TAIL_CHARS)]),
    ...(evidence.review?.unmetCriteria ?? []).map((criterion) => criterion.claim),
    ...(evidence.review?.findings ?? []).flatMap((finding) => [finding.mechanism, finding.remedy ?? ""]),
  ];
}

/** Match a round's failure text against the layered corpus the implement lane reads. An unreadable corpus
 *  yields a row naming `selection_error` with `matched: null`, never an empty match list. */
export function recordFixLearningsShadow(input: {
  taskId: string;
  runId: string;
  prNumber: number | undefined;
  attempt: number;
  round: "resume" | "fresh";
  roundId: string;
  repoDir: string;
  config: Config;
  evidence: FixLearningsEvidence;
  /** Checks already known to the dispatch, including when merge-conflict prompt evidence omits CI. */
  knownCiFailures?: FixLearningsEvidence["ciFailures"];
  priorRows: ReadonlyArray<Record<string, unknown>>;
}): FixLearningsRound {
  const { taskId, evidence } = input;
  const ciFailures = input.knownCiFailures ?? evidence.ciFailures ?? [];
  const selectionEvidence = { ...evidence, ciFailures };
  const withheld = taskArmWithheld({ taskId, unit: "fix-learnings", share: FIX_LEARNINGS_SHARE, epoch: FIX_LEARNINGS_EPOCH });
  let selection: Record<string, unknown>;
  try {
    const context = { text: selectionText(selectionEvidence) };
    const { entries } = loadLayeredLearningsForTaskFiles({
      projectDir: projectLearningsHome(input.repoDir),
      userOverallDir: userOverallLearningsHome(input.config),
      globalArtifactPath: globalArtifactPath(input.config),
    }, undefined, context);
    const { selected, dropped } = selectLearnings(entries, undefined, DEFAULT_KNOWLEDGE_BUDGET_CHARS, context);
    selection = {
      matched: selected.map((entry) => ({ id: entry.id, kinds: learningMatchKinds(entry, undefined, context) })),
      dropped_ids: dropped.map((entry) => entry.id),
    };
  } catch (error) {
    // The fix round must run whatever the corpus holds; the row says the match is unknown and why.
    selection = { matched: null, selection_error: String(error).slice(0, 500) };
  }
  return {
    priorRows: input.priorRows,
    row: {
      shadow_id: randomUUID(),
      run_id: input.runId,
      task_id: taskId,
      pr_number: input.prNumber,
      attempt: input.attempt,
      round: input.round,
      round_id: input.roundId,
      arm: withheld ? "withheld" : "offered",
      ...selection,
      budget_chars: DEFAULT_KNOWLEDGE_BUDGET_CHARS,
      failing_checks: [...new Set(ciFailures.map((f) => f.name))],
    },
  };
}

function pushedHeadForShadow(done: Record<string, unknown>): string | undefined {
  const head = done.fix_learnings_pushed_head_sha ?? done.pushed_head_sha;
  return typeof head === "string" ? head : undefined;
}

/** Read the matching `fix.done` row. A push is remembered for CI to judge; no push concludes now. */
export function fixLearningsDoneConclusion(round: FixLearningsRound, done: Record<string, unknown>): "no_push" | undefined {
  if (round.pushed !== undefined || done.round_id !== round.row.round_id) return undefined;
  if (done.fix_learnings_no_push === true) return "no_push";
  const head = pushedHeadForShadow(done);
  if (head === undefined && done.push_outcome !== "landed" && done.push_outcome !== "unverified" &&
    done.push_outcome !== "remote_unreadable") return "no_push";
  round.pushed = { head };
  return undefined;
}

/** CI's conclusion for the open round, only when it is green or red on the head that round pushed. */
export function fixLearningsCiConclusion(round: FixLearningsRound, state: string, sha: string | undefined): "green" | "red" | undefined {
  const head = round.pushed?.head;
  if (head === undefined || sha !== head) return undefined;
  return state === "green" || state === "red" ? state : undefined;
}

/** The `fix.learnings_outcome` row. On green, `rounds_to_green` counts this task's rounds that dispatched a
 *  worker round (`fix.dispatch`) or pushed (`fix.done`), excluding unchanged-head push attempts. */
export function fixLearningsOutcomeRow(
  round: FixLearningsRound,
  conclusion: FixLearningsConclusion,
  rungRows: ReadonlyArray<Record<string, unknown>>,
): FixLearningsOutcomeFields {
  const { shadow_id, run_id, task_id, pr_number, attempt, arm, round_id } = round.row;
  const row = { shadow_id, run_id, task_id, pr_number, attempt, arm, round_id, conclusion,
    pushed_head_sha: round.pushed?.head };
  if (conclusion !== "green") return row;
  const taskRows = [...round.priorRows, ...rungRows].filter((r) => r.task_id === task_id && typeof r.round_id === "string");
  const noOps = new Set(taskRows.filter((r) => r.step === "fix.done" && r.fix_learnings_no_push === true).map((r) => r.round_id));
  const rounds = new Set([round_id, ...taskRows
    .filter((r) => !noOps.has(r.round_id) && (r.step === "fix.dispatch" || (r.step === "fix.done" && pushedHeadForShadow(r) !== undefined)))
    .map((r) => r.round_id)]);
  return { ...row, rounds_to_green: rounds.size };
}

function isShadowRow(row: Record<string, unknown>): row is FixLearningsShadowRow {
  return row.step === "fix.learnings_shadow" && typeof row.shadow_id === "string" &&
    typeof row.run_id === "string" && typeof row.task_id === "string" &&
    typeof row.round_id === "string" && (row.arm === "offered" || row.arm === "withheld");
}

/** Close pushed rounds that ended without a CI wait using the next exact-head sweep observation. */
export function fixLearningsOutcomesFromSnapshot(
  prs: readonly { prNumber: number; headSha: string; checksState: string }[],
  rows: ReadonlyArray<Record<string, unknown>>,
): FixLearningsOutcomeFields[] {
  const terminal = new Map(prs.filter((pr) => pr.checksState === "green" || pr.checksState === "red").map((pr) => [pr.prNumber, pr]));
  if (terminal.size === 0) return [];
  const settled = new Set(rows.filter((row) => row.step === "fix.learnings_outcome").map((row) => row.shadow_id));
  const roundKey = (row: Record<string, unknown>) => JSON.stringify([row.task_id, row.pr_number, row.round_id]);
  const shadows = new Map<string, FixLearningsShadowRow>();
  const outcomes: FixLearningsOutcomeFields[] = [];
  for (const [index, row] of rows.entries()) {
    if (isShadowRow(row) && !settled.has(row.shadow_id)) shadows.set(roundKey(row), row);
    if (row.step !== "fix.done" || typeof row.pr_number !== "number" ||
        (row.mode !== "plan-gate" && row.mode !== "plan-conflict" && row.fix_learnings_pushed_head_sha === undefined)) continue;
    const ci = terminal.get(row.pr_number);
    if (ci === undefined || ci.headSha !== pushedHeadForShadow(row)) continue;
    const shadow = shadows.get(roundKey(row));
    if (shadow === undefined || settled.has(shadow.shadow_id)) continue;
    const round: FixLearningsRound = { row: shadow, priorRows: [] };
    fixLearningsDoneConclusion(round, row);
    const conclusion = fixLearningsCiConclusion(round, ci.checksState, ci.headSha);
    if (conclusion === undefined) continue;
    outcomes.push(fixLearningsOutcomeRow(round, conclusion, conclusion === "green" ? rows.slice(0, index + 1) : []));
    settled.add(shadow.shadow_id);
  }
  return outcomes;
}

export interface FixLearningsArmSummary {
  rounds: number;
  /** Rounds whose corpus could not be read; left out of every match figure. */
  selectionErrors: number;
  roundsWithMatch: number;
  /** Share of readable rounds with at least one match of that kind; null with no readable round. */
  matchRate: Record<Exclude<LearningMatchKind, "file">, number | null>;
  outcomes: Record<FixLearningsConclusion | "unobserved", number>;
  /** Share of observed outcomes; null while none is observed. */
  outcomeRates: Record<FixLearningsConclusion, number | null>;
  /** Per task, the rounds it took to reach its first recorded green. */
  roundsToGreen: Record<string, number>;
}

/** Per arm, what the shadow rows and their outcome rows show. Pure over ledger rows; W1-T14139 reads it. */
export function summarizeFixLearningsShadow(
  rows: ReadonlyArray<Record<string, unknown>>,
): Record<FixLearningsArm, FixLearningsArmSummary> {
  const shadows = new Map<unknown, Record<string, unknown>>();
  const outcomes = new Map<unknown, Record<string, unknown>>();
  for (const row of rows) {
    if (row.step === "fix.learnings_shadow") shadows.set(row.shadow_id, row);
    else if (row.step === "fix.learnings_outcome") outcomes.set(row.shadow_id, row);
  }
  const summarize = (arm: FixLearningsArm): FixLearningsArmSummary => {
    const mine = [...shadows.values()].filter((row) => row.arm === arm);
    const matches = mine.map((row) => row.matched).filter(Array.isArray) as Array<Array<{ kinds: string[] }>>;
    const share = (n: number, of: number): number | null => (of === 0 ? null : n / of);
    const kindRate = (kind: string) => share(matches.filter((m) => m.some((e) => e.kinds.includes(kind))).length, matches.length);
    const counts = { green: 0, red: 0, no_push: 0, unobserved: 0 };
    const roundsToGreen: Record<string, number> = {};
    for (const shadow of mine) {
      const outcome = outcomes.get(shadow.shadow_id);
      counts[(outcome?.conclusion as FixLearningsConclusion | undefined) ?? "unobserved"] += 1;
      if (typeof outcome?.rounds_to_green === "number") roundsToGreen[String(shadow.task_id)] ??= outcome.rounds_to_green;
    }
    const observed = mine.length - counts.unobserved;
    return {
      rounds: mine.length,
      selectionErrors: mine.length - matches.length,
      roundsWithMatch: matches.filter((m) => m.length > 0).length,
      matchRate: { error: kindRate("error"), symbol: kindRate("symbol") },
      outcomes: counts,
      outcomeRates: { green: share(counts.green, observed), red: share(counts.red, observed), no_push: share(counts.no_push, observed) },
      roundsToGreen,
    };
  };
  return { offered: summarize("offered"), withheld: summarize("withheld") };
}
