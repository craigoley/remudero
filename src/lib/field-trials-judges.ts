/**
 * lib/field-trials-judges.ts — W1-T12423: the judge family of the field-trials snapshot.
 *
 * The snapshot (lib/field-trials-flow.ts) keeps rmd's private model evidence. This module adds the
 * judge figures beside the worker figures and apart from them. It reads these ledger steps:
 * `decision.answered` (a decision model's answer), `shadow_judge.paired` (a shadow judge's answer
 * beside the current judge's), `judge_replay.answered` (one corpus case of a replay) and
 * `judge_replay.finished` (a direct replay's closing row, which names the corpus digest). W1-T13365
 * adds the three `judge_shadow` steps of the ci judge and the fix-progress judge: a paired row is one
 * answer, an unavailable row is one rejected answer, and a refused row is no answer and is counted
 * in the cell's `refused`.
 *
 * ONE READER, ONE SCORER. A row becomes recorded typed answers through `judgeCalibrationRow`
 * (lib/judge-calibration.ts), the reader the judge calibration body uses. Agreement, Brier,
 * log-loss and the abstention and rejection shares come from `scoreTypedAnswers`
 * (lib/typed-answer-scores.ts, W1-T12414). Nothing here computes them again.
 *
 * THE CELL KEY is source, ISO week, basis, role, model id, model surface and corpus digest. Two
 * models, or one model on two surfaces (W1-T12420), never share a cell. A live answer and a replay
 * answer never share a cell. A replay cell names the corpus digest its replay sent.
 *
 * PRIVATE. No input digest, decision key, head or run id enters a cell. The snapshot adds them to
 * its private keys, and no release or field note reads this family.
 * A RECORD, NEVER A DECISION INPUT: no gate, route or gardener reads these cells.
 */
import { DECISION_ANSWERED_STEP } from "./decision-model.js";
import { decisionRequestOf, isJudgeShadowArmRefusal, JUDGE_SHADOW_ARM_STEPS, JUDGE_SHADOW_REFUSED_STEP, JUDGE_SHADOW_ROW_STEPS,
  judgeCalibrationRow, judgeShadowArmIdentity, judgeShadowRowIdentity } from "./judge-calibration.js";
import { JUDGE_REPLAY_ANSWERED_STEP, JUDGE_REPLAY_FINISHED_STEP } from "./judge-replay-batch.js";
import { scoreTypedAnswers, type TypedAnswerRow, type TypedAnswerScoreGroup } from "./typed-answer-scores.js";
import { MODEL_SURFACES, type ModelSurface } from "./worker-provider.js";

export const SHADOW_JUDGE_PAIRED_STEP = "shadow_judge.paired";
/** The ledger steps only the judge family reads. */
export const JUDGE_TRIAL_STEPS = [DECISION_ANSWERED_STEP, SHADOW_JUDGE_PAIRED_STEP, JUDGE_REPLAY_ANSWERED_STEP, JUDGE_REPLAY_FINISHED_STEP,
  ...JUDGE_SHADOW_ROW_STEPS, ...JUDGE_SHADOW_ARM_STEPS] as const;
/** W1-T14853: a decision-model replay whose newest answer is older than this before the snapshot's asOf is stale. A
 *  record only: nothing reads the flag to decide. */
export const JUDGE_REPLAY_STALE_DAYS = 7;
/** W1-T14853: part of every judge unit's digest, so a change to the cell's shape rebuilds the family once. */
export const JUDGE_TRIAL_CELL_VERSION = "judge-trial-cell-v2" as const;
/** A replay answer whose replay wrote no corpus digest (the batch lane, or a replay that has not finished). */
export const JUDGE_CORPUS_DIGEST_UNRECORDED = "unrecorded";

export type JudgeTrialBasis = "live" | "replay";

/** The fields of one judge ledger row the snapshot keeps in memory. None of them enters a cell but the answers' figures. */
export interface JudgeTrialProjection {
  basis: JudgeTrialBasis;
  /** True for a `judge_replay.finished` row: it carries its replay's corpus digest and no answer. */
  finished: boolean;
  /** The corpus digest this row itself names, or null. */
  corpusDigest: string | null;
  latencyMs: number | null;
  settledUsd: number | null;
  /** A shadow row's decision key. Private. */
  decisionKey: string | null;
  answers: TypedAnswerRow[];
  /** W1-T13365: a refused shadow call. It has no answer; these fields name its cell and its private keys. */
  refused?: NonNullable<ReturnType<typeof judgeShadowRowIdentity>>;
  /** W1-T14853: the decision-model request this row belongs to (judge-calibration's decisionRequestOf), private. A
   *  decision-arm judge_shadow row and the live decision.answered row of the same request share it. */
  request?: { key: string; side: "decision" | "shadow" };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);
const amount = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null);
const isModelSurface = (value: unknown): value is ModelSurface => (MODEL_SURFACES as readonly unknown[]).includes(value);

/** A typed answer read back from a ledger row is held to the shape the scorer reads; any other value is dropped. */
function readTypedAnswer(value: unknown): TypedAnswerRow | undefined {
  if (!isRecord(value) || text(value.role) === null || text(value.model) === null || !isRecord(value.answer)) return undefined;
  const row = value as unknown as TypedAnswerRow;
  // A row written before surfaces existed reads its surface from its source, as the scorer reads it.
  return { ...row, modelSurface: isModelSurface(row.modelSurface) ? row.modelSurface : row.source === "decisions" ? "decisions" : "text" };
}

/** The judge fields of one raw ledger row, or `undefined` for a row of another step. */
export function projectJudgeTrialRow(row: Record<string, unknown>): JudgeTrialProjection | undefined {
  if (!(JUDGE_TRIAL_STEPS as readonly unknown[]).includes(row.step)) return undefined;
  const replay = row.step === JUDGE_REPLAY_ANSWERED_STEP || row.step === JUDGE_REPLAY_FINISHED_STEP;
  const finished = row.step === JUDGE_REPLAY_FINISHED_STEP;
  // A direct replay's own decision.answered row reads as no answer here: its answer is in its judge_replay.answered row.
  const typed = finished ? undefined : judgeCalibrationRow(row)?.typed_answers;
  const shadow = (JUDGE_SHADOW_ROW_STEPS as readonly unknown[]).includes(row.step);
  const arm = (JUDGE_SHADOW_ARM_STEPS as readonly unknown[]).includes(row.step);
  const refused = row.step === JUDGE_SHADOW_REFUSED_STEP ? judgeShadowRowIdentity(row)
    : arm && isJudgeShadowArmRefusal(row) ? judgeShadowArmIdentity(row) : undefined;
  const request = decisionRequestOf(row);
  return {
    basis: replay ? "replay" : "live", finished, corpusDigest: replay ? text(row.corpus_digest) : null,
    latencyMs: finished ? null : amount(row.latency_ms),
    // A judge_shadow row names its dollars cost_usd. A refused call made no request, so it has none.
    settledUsd: finished || refused ? null : amount(shadow ? row.cost_usd : arm ? row.shadow_cost_usd : row.settled_usd),
    decisionKey: text(row.decision_key),
    answers: Array.isArray(typed) ? typed.flatMap((answer) => { const read = readTypedAnswer(answer); return read ? [read] : []; }) : [],
    ...(refused ? { refused } : {}),
    ...(request ? { request } : {}),
  };
}

/** One decision (one ledger row) of one role, model and surface, ready for a cell. */
export interface JudgeTrialRow {
  source: string;
  ts: string | null;
  fingerprint: string;
  basis: JudgeTrialBasis;
  /** A replay's corpus digest, or {@link JUDGE_CORPUS_DIGEST_UNRECORDED}; null for a live answer. */
  corpusDigest: string | null;
  role: string;
  model: string;
  modelSurface: ModelSurface;
  latencyMs: number | null;
  settledUsd: number | null;
  answers: TypedAnswerRow[];
  /** W1-T13365: true for a refused shadow call, which has no answer. */
  refused: boolean;
}

/** What {@link judgeTrialRows} reads off a snapshot row. */
export interface JudgeTrialSourceRow {
  fingerprint: string;
  ts: string | null;
  runId: string | null;
  judge?: JudgeTrialProjection;
}

/**
 * The judge rows of one source, each joined to its replay's corpus digest by run id, plus every
 * private key they carry (run ids, decision keys, input digests and heads).
 */
export function judgeTrialRows(source: string, rows: readonly JudgeTrialSourceRow[]): { rows: JudgeTrialRow[]; privateKeys: string[] } {
  const digestOfRun = new Map<string, string>();
  for (const row of rows) if (row.judge?.finished && row.runId !== null && row.judge.corpusDigest !== null) digestOfRun.set(row.runId, row.judge.corpusDigest);
  // W1-T14853: a decision-arm shadow request also wrote its decision.answered row; its judge_shadow row is the one read.
  const shadowRequests = new Set<string>();
  for (const row of rows) if (row.judge?.request?.side === "shadow") shadowRequests.add(row.judge.request.key);
  const out: JudgeTrialRow[] = [];
  const privateKeys = new Set<string>();
  for (const row of rows) {
    const judge = row.judge;
    if (judge === undefined) continue;
    if (judge.request?.side === "decision" && shadowRequests.has(judge.request.key)) continue;
    if (row.runId !== null) privateKeys.add(row.runId);
    if (judge.decisionKey !== null) privateKeys.add(judge.decisionKey);
    const corpusDigest = judge.basis === "live" ? null
      : judge.corpusDigest ?? (row.runId === null ? undefined : digestOfRun.get(row.runId)) ?? JUDGE_CORPUS_DIGEST_UNRECORDED;
    if (judge.refused) {
      const { role, model, modelSurface, head, inputDigest } = judge.refused;
      for (const key of [inputDigest, head]) if (key !== null) privateKeys.add(key);
      out.push({ source, ts: row.ts, fingerprint: row.fingerprint, basis: judge.basis, corpusDigest, role, model, modelSurface,
        latencyMs: null, settledUsd: null, answers: [], refused: true });
    }
    const groups = new Map<string, TypedAnswerRow[]>();
    for (const answer of judge.answers) {
      for (const key of [answer.inputDigest, answer.head]) if (typeof key === "string" && key.length > 0) privateKeys.add(key);
      const key = JSON.stringify([answer.role, answer.model, answer.modelSurface]);
      groups.set(key, [...(groups.get(key) ?? []), answer]);
    }
    // One ledger row is one decision. Its latency and dollars count once, with its first role, model and surface.
    [...groups.values()].forEach((answers, index) => {
      const first = answers[0]!;
      out.push({ source, ts: row.ts, fingerprint: row.fingerprint, basis: judge.basis, corpusDigest, role: first.role, model: first.model,
        modelSurface: first.modelSurface, latencyMs: index === 0 ? judge.latencyMs : null, settledUsd: index === 0 ? judge.settledUsd : null, answers, refused: false });
    });
  }
  return { rows: out, privateKeys: [...privateKeys].sort() };
}

/** The one key of a judge cell: two models, two surfaces or two bases never share one. */
export function judgeTrialCellKey(row: Pick<JudgeTrialRow, "source" | "ts" | "basis" | "role" | "model" | "modelSurface" | "corpusDigest">,
  periodOf: (at: string | null) => string): string {
  return [row.source, periodOf(row.ts), row.basis, row.role, row.model, row.modelSurface, row.corpusDigest ?? "-"].join("|");
}

/** The scorer's figures the family copies, for the whole cell and for each question in it. */
type ScoredFigures = Pick<TypedAnswerScoreGroup, "answers" | "distributions" | "singles" | "abstained" | "rejected" | "abstentionRate" |
  "rejectionRate" | "agreement" | "outcomes" | "brier" | "logLoss">;

export interface JudgeTrialCell extends ScoredFigures {
  source: string;
  /** The Monday that starts the ISO week. */
  period: string;
  basis: JudgeTrialBasis;
  corpusDigest: string | null;
  role: string;
  model: string;
  modelSurface: ModelSurface;
  /** Ledger rows: one per request. A request with several questions gives several answers. */
  decisions: number;
  /** W1-T13365: shadow calls the cash provider refused for capacity or budget. They are no answer and enter no other figure. */
  refused: number;
  latencyMs: { observed: number; median: number | null; p90: number | null };
  settledUsd: { observed: number; median: number | null };
  /** W1-T14853: the newest row time in the cell, or null when no row has one. */
  newestAt: string | null;
  /** The same figures per question, because one cell can hold questions with different options. */
  questions: Array<ScoredFigures & { question: string | null }>;
}

const figuresOf = (group: ScoredFigures): ScoredFigures => ({
  answers: group.answers, distributions: group.distributions, singles: group.singles, abstained: group.abstained, rejected: group.rejected,
  abstentionRate: group.abstentionRate, rejectionRate: group.rejectionRate, agreement: group.agreement, outcomes: group.outcomes,
  brier: group.brier, logLoss: group.logLoss });

/** W1-T13365: the figures of a cell that holds refused calls only. */
const NO_ANSWERS: ScoredFigures = { answers: 0, distributions: 0, singles: 0, abstained: 0, rejected: 0, abstentionRate: 0, rejectionRate: 0,
  agreement: { compared: 0, agreed: 0, rate: null }, outcomes: { scored: 0, unknown: 0, notDeclared: 0 }, brier: null, logLoss: null };

const sortedNumbers = (values: ReadonlyArray<number | null>): number[] =>
  values.filter((value): value is number => value !== null).sort((a, b) => a - b);
const medianOf = (sorted: readonly number[]): number | null => {
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};
/** Nearest rank: the smallest value with at least 90% of the values at or below it. */
const p90Of = (sorted: readonly number[]): number | null => (sorted.length === 0 ? null : sorted[Math.ceil(0.9 * sorted.length) - 1]!);

/**
 * THE JUDGE FAMILY. Groups the rows into cells by {@link judgeTrialCellKey} and gives each cell the
 * scorer's figures over all its answers (pooled over its questions), the same figures per question,
 * and the median and 90th-percentile latency and the median settled dollars over its decisions. A
 * row with no latency or no dollars (a shadow row, a batch result) is left out of that median and
 * `observed` says how many rows it used. Cells are sorted by their key.
 */
export function judgeTrialCells(rows: readonly JudgeTrialRow[], periodOf: (at: string | null) => string,
  score: typeof scoreTypedAnswers = scoreTypedAnswers): JudgeTrialCell[] {
  const groups = new Map<string, JudgeTrialRow[]>();
  for (const row of rows) {
    if (row.answers.length === 0 && !row.refused) continue;
    const key = judgeTrialCellKey(row, periodOf);
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups.keys()].sort().map((key): JudgeTrialCell => {
    const all = groups.get(key)!;
    const first = all[0]!;
    const members = all.filter((member) => !member.refused);
    const answers = members.flatMap((member) => member.answers);
    // The cell's key has no question, so its own figures pool its questions: one scorer group.
    const pooled = score(answers.map((answer) => ({ ...answer, question: null }))).groups[0] ?? NO_ANSWERS;
    const latencies = sortedNumbers(members.map((member) => member.latencyMs));
    const dollars = sortedNumbers(members.map((member) => member.settledUsd));
    return {
      source: first.source, period: periodOf(first.ts), basis: first.basis, corpusDigest: first.corpusDigest,
      role: first.role, model: first.model, modelSurface: first.modelSurface, decisions: members.length, refused: all.length - members.length,
      ...figuresOf(pooled),
      latencyMs: { observed: latencies.length, median: medianOf(latencies), p90: p90Of(latencies) },
      settledUsd: { observed: dollars.length, median: medianOf(dollars) },
      newestAt: all.reduce<string | null>((newest, member) => (member.ts !== null && (newest === null || member.ts > newest) ? member.ts : newest), null),
      questions: score(answers).groups.map((group) => ({ question: group.question, ...figuresOf(group) })),
    };
  });
}

/** W1-T14853: one decision-model candidate's newest replay for one role, or the candidate with none (role null). */
export interface JudgeReplayAge {
  model: string;
  role: string | null;
  newestReplayAt: string | null;
  stale: boolean;
}

/**
 * W1-T14853: for each decision-model candidate the judge family names (any cell on the decisions surface), the newest
 * replay answer of each role its replay cells name, stale when it is more than {@link JUDGE_REPLAY_STALE_DAYS} before
 * `asOf`. A candidate with no replay cell is one entry with role null, which is stale. A record, never a decision input.
 */
export function judgeReplayAges(cells: readonly JudgeTrialCell[], asOf: string): JudgeReplayAge[] {
  const candidates = new Set<string>();
  const newest = new Map<string, { model: string; role: string; at: string | null }>();
  for (const cell of cells) {
    if (cell.modelSurface !== "decisions") continue;
    candidates.add(cell.model);
    if (cell.basis !== "replay") continue;
    const key = JSON.stringify([cell.model, cell.role]);
    const before = newest.get(key);
    const at = before?.at === undefined || before.at === null ? cell.newestAt
      : cell.newestAt !== null && cell.newestAt > before.at ? cell.newestAt : before.at;
    newest.set(key, { model: cell.model, role: cell.role, at });
  }
  const limit = Date.parse(asOf) - JUDGE_REPLAY_STALE_DAYS * 86_400_000;
  const staleAt = (at: string | null): boolean => at === null || !Number.isFinite(Date.parse(at)) || Date.parse(at) < limit;
  const ages: JudgeReplayAge[] = [...newest.values()].map(({ model, role, at }) => ({ model, role, newestReplayAt: at, stale: staleAt(at) }));
  for (const model of candidates) if (!ages.some((age) => age.model === model)) ages.push({ model, role: null, newestReplayAt: null, stale: true });
  return ages.sort((a, b) => a.model.localeCompare(b.model) || (a.role ?? "").localeCompare(b.role ?? ""));
}
