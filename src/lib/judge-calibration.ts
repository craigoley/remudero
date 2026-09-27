/**
 * lib/judge-calibration.ts — the judges that grade field-trial outcomes are themselves graded by a
 * small operator-labelled random sample (W1-T4628).
 *
 * The review judge (`review.posted`, an LLM reviewer that ran to `reviewer_outcome: "success"`)
 * and the risk judge (`risk_judge.decision`) produce the pass/fail verdicts a field trial would
 * publish, and their bias is unmeasured. This projection:
 *
 *   1. extracts every LLM judge verdict from ledger rows and joins it to the model that AUTHORED
 *      the judged head — a review names its head; a risk decision reaches the head of the run's
 *      latest prior review; a head reaches its author through the `head_assignment` W1-T4614
 *      stamps on `implement.done`/`pr.opened`, then that assignment's `worker.assignment` model
 *      (the same join lib/work-integrity.ts makes);
 *   2. draws a deterministic, seeded, stratified random sample (judge model x author model) as the
 *      operator's labelling queue — the queue never shows the judge's own verdict;
 *   3. reads human labels, each with its provenance, from an injectable store;
 *   4. reports judge-vs-human Cohen's kappa, between-judge kappa on shared heads, a judge x author
 *      matrix, and prediction-powered (PPI, Angelopoulos et al. 2023) corrected pass rates beside
 *      the raw ones, with CLT intervals.
 *
 * Invariants: an estimate over too few labels is `unknown` with a reason, never 0 and never the raw
 * rate; no task or run id reaches the output; nothing here gates a PR.
 * Falsifier: test/judge-verdicts-are-corrected-by-a-human-sample.test.ts.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Clock } from "./clock.js";
import { writeAtomic } from "./fs-race-safe.js";

export const JUDGE_CALIBRATION_VERSION = "judge-calibration-v1" as const;

/** PRIMARY CONTROL: how many verdicts the labelling queue draws from each judge x author stratum.
 *  Adjustable per call through `samplePerStratum`; a bigger sample narrows every interval. */
export const JUDGE_SAMPLE_PER_STRATUM = 20;

/** PRIMARY CONTROL: the fewest paired observations (human label vs judge, or judge vs judge on a
 *  shared head) any agreement or corrected rate is computed over. Below it the cell is `unknown`. */
export const MIN_PAIRED_OBSERVATIONS = 10;

/** The default sampling seed. Fixed, so the queue a labeller works through is stable across
 *  refreshes and labels accumulate on the same draw. */
export const JUDGE_SAMPLE_SEED = "judge-calibration-v1";

/** Two-sided 95% normal quantile. */
export const JUDGE_INTERVAL_Z = 1.959963984540054;

export const JUDGE_LABELS_FILENAME = "judge-labels.json";

/** A verdict reference: an opaque digest of the judgment, carrying no task or run id. */
export const JUDGE_VERDICT_REF_RE = /^jv-[0-9a-f]{16}$/;

export const JUDGE_CALIBRATION_METHOD = {
  estimator:
    "prediction-powered inference, mean estimation (Angelopoulos et al. 2023): " +
    "theta = mean(judge pass over the unlabelled verdicts) + mean(human pass - judge pass over the labelled verdicts); " +
    "when every verdict in a stratum is labelled, theta = mean(human pass)",
  interval:
    "CLT: theta +/- z * sqrt(var(judge over unlabelled) / N + var(human - judge over labelled) / n), " +
    "sample variances with n - 1 denominators, z = 1.96 (95%); estimate and bounds clamped to [0, 1]",
  judgeRate:
    "a judge's corrected rate is the verdict-count-weighted sum of its strata's estimates, variance sum(w^2 * var); " +
    "unknown when any stratum is unknown",
  agreement: "Cohen's kappa on binary pass/fail; unknown when chance agreement is 1",
} as const;

type Row = Record<string, unknown>;

const RETAINED_STEPS = new Set(["worker.assignment", "implement.done", "pr.opened", "review.posted", "risk_judge.decision"]);
const RETAINED_FIELDS = [
  "ts", "step", "run_id", "head_sha", "head_assignment", "pr_url", "state", "reviewer_outcome",
  "dep_review", "verdict", "availability", "model",
];

const str = (value: unknown): string | undefined => (typeof value === "string" && value.length > 0 ? value : undefined);
const record = (value: unknown): Row | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Row) : undefined;

/** The fields this projection reads off one ledger row, or `undefined` for a row it never reads. */
export function judgeCalibrationRow(line: Row): Row | undefined {
  if (typeof line.step !== "string" || !RETAINED_STEPS.has(line.step)) return undefined;
  const out: Row = {};
  for (const field of RETAINED_FIELDS) if (line[field] !== undefined) out[field] = line[field];
  const assignment = record(line.worker_assignment);
  if (assignment) out.worker_assignment = { id: assignment.id, selected: { model: record(assignment.selected)?.model } };
  const provenance = record(line.evaluator_provenance);
  if (provenance) {
    out.evaluator_provenance = { servedModel: provenance.servedModel, routedModel: provenance.routedModel, requestedModel: provenance.requestedModel };
  }
  return out;
}

export type JudgeKind = "review" | "risk";

/** One LLM judge verdict, joined to the model that authored what it judged. */
export interface JudgeVerdict {
  ref: string;
  kind: JudgeKind;
  judgeModel: string;
  authorModel: string;
  headSha: string | null;
  prUrl: string | null;
  pass: boolean;
}

const timeOf = (row: Row): number => {
  const parsed = typeof row.ts === "string" ? Date.parse(row.ts) : NaN;
  return Number.isFinite(parsed) ? parsed : -Infinity;
};

/** A `head_assignment` value is an id unless it is one of W1-T4614's two named non-answers, or
 *  this module's own `unrecorded` for a head row that carried no `head_assignment` at all. */
const assignmentIdOf = (value: unknown): string | undefined =>
  value === "unattributed" || value === "unreadable" || value === "unrecorded" ? undefined : str(value);

function verdictRef(kind: JudgeKind, model: string, head: string | undefined, row: Row): string {
  const digest = createHash("sha256").update([kind, model, head ?? "", String(row.ts ?? ""), String(row.run_id ?? "")].join("\0")).digest("hex");
  return `jv-${digest.slice(0, 16)}`;
}

function bump(counts: Record<string, number>, reason: string): void {
  counts[reason] = (counts[reason] ?? 0) + 1;
}

/** Why a review row is not an LLM judgment, or its judge model and pass bit. */
function reviewJudgment(row: Row): { model: string; pass: boolean } | { excluded: string } {
  if (row.dep_review === true) return { excluded: "dep-review-not-llm-judged" };
  if (row.reviewer_outcome !== "success") return { excluded: "reviewer-did-not-complete" };
  if (row.state !== "success" && row.state !== "failure") return { excluded: "no-verdict" };
  const provenance = record(row.evaluator_provenance);
  const model = str(provenance?.servedModel) ?? str(provenance?.routedModel) ?? str(provenance?.requestedModel);
  return model === undefined ? { excluded: "judge-model-unrecorded" } : { model, pass: row.state === "success" };
}

/** Why a risk row is not an LLM judgment, or its judge model and pass bit (low risk passes). */
function riskJudgment(row: Row): { model: string; pass: boolean } | { excluded: string } {
  if (row.availability === "unavailable") return { excluded: "judge-unavailable" };
  if (row.verdict !== "low" && row.verdict !== "high") return { excluded: "no-verdict" };
  const model = str(row.model);
  return model === undefined ? { excluded: "judge-model-unrecorded" } : { model, pass: row.verdict === "low" };
}

/** Every LLM judge verdict in `rows`, joined to its author model. A row that is not an LLM
 *  judgment is counted under `excluded`; a verdict whose author cannot be joined is KEPT under the
 *  `unattributed` author stratum and its reason counted — never dropped. */
export function extractJudgeVerdicts(rows: ReadonlyArray<Row>): {
  verdicts: JudgeVerdict[];
  excluded: Record<string, number>;
  authorUnattributed: Record<string, number>;
} {
  const models = new Map<string, string>();
  const headAuthors = new Map<string, string>();
  const reviewHeadsByRun = new Map<string, Array<{ at: number; head: string }>>();
  for (const row of rows) {
    const raw = record(row.worker_assignment);
    const id = str(raw?.id);
    const model = str(record(raw?.selected)?.model);
    if (row.step === "worker.assignment" && id && model && !models.has(id)) models.set(id, model);
    const head = str(row.head_sha);
    if ((row.step === "implement.done" || row.step === "pr.opened") && head) {
      const value = str(row.head_assignment) ?? "unrecorded";
      if (!headAuthors.has(head) || (assignmentIdOf(value) && !assignmentIdOf(headAuthors.get(head)))) headAuthors.set(head, value);
    }
    const runId = str(row.run_id);
    if (row.step === "review.posted" && head && runId) reviewHeadsByRun.set(runId, [...(reviewHeadsByRun.get(runId) ?? []), { at: timeOf(row), head }]);
  }

  const excluded: Record<string, number> = {};
  const authorUnattributed: Record<string, number> = {};
  const authorOf = (head: string | undefined): string => {
    const value = head === undefined ? undefined : headAuthors.get(head);
    const id = assignmentIdOf(value);
    const model = id === undefined ? undefined : models.get(id);
    if (model !== undefined) return model;
    const reason = head === undefined ? "no-head" : value === undefined ? "head-not-observed"
      : id === undefined ? "head-unattributed" : "assignment-not-observed";
    bump(authorUnattributed, reason);
    return "unattributed";
  };
  const headOfRisk = (row: Row): string | undefined => {
    const at = timeOf(row);
    let best: { at: number; head: string } | undefined;
    for (const entry of reviewHeadsByRun.get(str(row.run_id) ?? "") ?? []) if (entry.at <= at && (best === undefined || entry.at >= best.at)) best = entry;
    return best?.head;
  };

  const verdicts: JudgeVerdict[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (row.step !== "review.posted" && row.step !== "risk_judge.decision") continue;
    const kind: JudgeKind = row.step === "review.posted" ? "review" : "risk";
    const judgment = kind === "review" ? reviewJudgment(row) : riskJudgment(row);
    if ("excluded" in judgment) {
      bump(excluded, judgment.excluded);
      continue;
    }
    const head = kind === "review" ? str(row.head_sha) : headOfRisk(row);
    const ref = verdictRef(kind, judgment.model, head, row);
    if (seen.has(ref)) continue;
    seen.add(ref);
    verdicts.push({
      ref, kind, judgeModel: judgment.model, authorModel: authorOf(head),
      headSha: head ?? null, prUrl: str(row.pr_url) ?? null, pass: judgment.pass,
    });
  }
  return { verdicts, excluded, authorUnattributed };
}

const judgeIdOf = (verdict: Pick<JudgeVerdict, "kind" | "judgeModel">): string => `${verdict.kind}:${verdict.judgeModel}`;
const stratumKeyOf = (verdict: JudgeVerdict): string => JSON.stringify([judgeIdOf(verdict), verdict.authorModel]);

function sampleOrder(seed: string, ref: string): string {
  return createHash("sha256").update(`${seed}\0${ref}`).digest("hex");
}

/** One queued verdict for a labeller. The judge's own verdict is deliberately absent: a label
 *  given while looking at the answer measures anchoring, not the judge. */
export interface JudgeSampleItem {
  verdictRef: string;
  judge: { kind: JudgeKind; model: string };
  authorModel: string;
  headSha: string | null;
  prUrl: string | null;
}

/**
 * THE DRAW. Within each judge x author stratum, the `perStratum` verdicts whose seeded digest
 * sorts first — a uniform random sample without replacement that is a pure function of
 * (seed, verdict set), so the same ledger always yields the same queue.
 */
export function drawJudgeSample(
  verdicts: readonly JudgeVerdict[],
  options: { seed?: string; perStratum?: number } = {},
): JudgeSampleItem[] {
  const seed = options.seed ?? JUDGE_SAMPLE_SEED;
  const perStratum = Math.max(0, Math.floor(options.perStratum ?? JUDGE_SAMPLE_PER_STRATUM));
  const strata = new Map<string, JudgeVerdict[]>();
  for (const verdict of verdicts) strata.set(stratumKeyOf(verdict), [...(strata.get(stratumKeyOf(verdict)) ?? []), verdict]);
  return [...strata.keys()].sort().flatMap((key) =>
    strata.get(key)!
      .map((verdict) => ({ verdict, order: sampleOrder(seed, verdict.ref) }))
      .sort((a, b) => (a.order < b.order ? -1 : 1))
      .slice(0, perStratum)
      .map(({ verdict }) => ({
        verdictRef: verdict.ref,
        judge: { kind: verdict.kind, model: verdict.judgeModel },
        authorModel: verdict.authorModel,
        headSha: verdict.headSha,
        prUrl: verdict.prUrl,
      })));
}

/** One human label and its provenance. The store keeps every label; the latest per verdict wins. */
export interface JudgeLabel {
  verdictRef: string;
  label: "pass" | "fail";
  labeller: string;
  labelledAt: string;
}

/** Where labels live. Injectable so tests never touch a state dir. */
export interface JudgeLabelStore {
  read(): JudgeLabel[];
  write(labels: readonly JudgeLabel[]): void;
}

function isJudgeLabel(value: unknown): value is JudgeLabel {
  const row = record(value);
  return row !== undefined && typeof row.verdictRef === "string" && JUDGE_VERDICT_REF_RE.test(row.verdictRef) &&
    (row.label === "pass" || row.label === "fail") && str(row.labeller) !== undefined && str(row.labelledAt) !== undefined;
}

/** A JSON file under the state dir, written atomically. A missing file is no labels yet; a file
 *  that does not parse THROWS, so the caller can say the store is unreadable rather than zero. */
export function fileJudgeLabelStore(stateDir: string): JudgeLabelStore {
  const path = join(stateDir, JUDGE_LABELS_FILENAME);
  return {
    read: () => {
      if (!existsSync(path)) return [];
      const parsed = record(JSON.parse(readFileSync(path, "utf8")));
      if (!Array.isArray(parsed?.labels) || !parsed.labels.every(isJudgeLabel)) throw new Error(`${JUDGE_LABELS_FILENAME}: not a judge label file`);
      return parsed.labels;
    },
    write: (labels) => {
      writeAtomic(path, `${JSON.stringify({ version: 1, labels }, null, 2)}\n`);
    },
  };
}

/** Record one operator label, stamped by the injected clock. Refuses a malformed label outright. */
export function recordJudgeLabel(
  store: JudgeLabelStore,
  input: { verdictRef: string; label: string; labeller: string },
  clock: Clock,
): JudgeLabel {
  const label = { verdictRef: input.verdictRef, label: input.label, labeller: input.labeller.trim(), labelledAt: clock.iso() };
  if (!isJudgeLabel(label)) throw new Error("judge label refused: needs a jv- verdict reference, a pass/fail label and a labeller");
  store.write([...store.read(), label]);
  return label;
}

/** Labels as the projection consumes them: read, or unavailable with a reason. */
export type JudgeLabelsInput = { labels: readonly JudgeLabel[] } | { unavailable: string };

/** Read a store without letting an unreadable file pass for an empty one. */
export function loadJudgeLabels(store: JudgeLabelStore): JudgeLabelsInput {
  try {
    return { labels: store.read() };
  } catch {
    const reason = "label-store-unreadable";
    return { unavailable: reason };
  }
}

const mean = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
const sampleVariance = (xs: readonly number[]): number => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1);
};
const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));
const bit = (pass: boolean): number => (pass ? 1 : 0);

/** A corrected rate, or `unknown` with the reason — never a number standing in for no evidence. */
export type JudgeEstimate =
  | { state: "estimated"; estimate: number; lower: number; upper: number; standardError: number; labelled: number; unlabelled: number }
  | { state: "unknown"; reason: string; labelled: number };

/** An agreement statistic over `count` paired observations, or `unknown` with the reason. */
export type JudgeAgreement =
  | { state: "estimated"; kappa: number; observedAgreement: number; count: number }
  | { state: "unknown"; reason: string; count: number };

function interval(estimate: number, variance: number, labelled: number, unlabelled: number): JudgeEstimate {
  const standardError = Math.sqrt(variance);
  return {
    state: "estimated",
    estimate: clamp01(estimate),
    lower: clamp01(estimate - JUDGE_INTERVAL_Z * standardError),
    upper: clamp01(estimate + JUDGE_INTERVAL_Z * standardError),
    standardError,
    labelled,
    unlabelled,
  };
}

/** Too few labels read as unknown, with a reason naming which. */
const labelShortfall = (labelled: number, minPaired: number): string | undefined =>
  labelled === 0 ? "unlabelled" : labelled < minPaired ? `too-few-labels (${labelled} of ${minPaired})` : undefined;

/**
 * PPI mean estimation for one stratum. `pairs` are the labelled verdicts (judge bit, human bit);
 * `unlabelled` the judge bits with no label.
 */
export function ppiEstimate(
  pairs: ReadonlyArray<{ judge: boolean; human: boolean }>,
  unlabelled: readonly boolean[],
  minPaired: number = MIN_PAIRED_OBSERVATIONS,
): JudgeEstimate {
  const shortfall = labelShortfall(pairs.length, minPaired);
  if (shortfall !== undefined) return { state: "unknown", reason: shortfall, labelled: pairs.length };
  const human = pairs.map((p) => bit(p.human));
  if (unlabelled.length === 0) return interval(mean(human), sampleVariance(human) / pairs.length, pairs.length, 0);
  const f = unlabelled.map(bit);
  const rectifier = pairs.map((p) => bit(p.human) - bit(p.judge));
  return interval(
    mean(f) + mean(rectifier),
    sampleVariance(f) / f.length + sampleVariance(rectifier) / rectifier.length,
    pairs.length,
    f.length,
  );
}

/** Cohen's kappa between two binary raters over paired observations. */
export function cohensKappa(
  pairs: ReadonlyArray<readonly [boolean, boolean]>,
  minPaired: number = MIN_PAIRED_OBSERVATIONS,
): JudgeAgreement {
  const count = pairs.length;
  if (count < minPaired) return { state: "unknown", reason: count === 0 ? "no-paired-observations" : `too-few-paired-observations (${count} of ${minPaired})`, count };
  const observedAgreement = pairs.filter(([a, b]) => a === b).length / count;
  const a1 = pairs.filter(([a]) => a).length / count;
  const b1 = pairs.filter(([, b]) => b).length / count;
  const chance = a1 * b1 + (1 - a1) * (1 - b1);
  if (chance === 1) return { state: "unknown", reason: "kappa-undefined (both raters constant and identical)", count };
  return { state: "estimated", kappa: (observedAgreement - chance) / (1 - chance), observedAgreement, count };
}

/** One judge x author-model cell of the matrix. */
export interface JudgeStratum {
  judge: { kind: JudgeKind; model: string };
  authorModel: string;
  verdicts: number;
  rawPassRate: number;
  sampled: number;
  labelled: number;
  humanAgreement: JudgeAgreement;
  corrected: JudgeEstimate;
}

/** One judge across its author strata. */
export interface JudgeSummary {
  judge: { kind: JudgeKind; model: string };
  verdicts: number;
  rawPassRate: number;
  labelled: number;
  humanAgreement: JudgeAgreement;
  corrected: JudgeEstimate;
}

/** Two judges that scored the same heads (latest verdict per judge per head). */
export interface JudgePairAgreement {
  judges: [{ kind: JudgeKind; model: string }, { kind: JudgeKind; model: string }];
  agreement: JudgeAgreement;
}

export interface JudgeCalibration {
  version: typeof JUDGE_CALIBRATION_VERSION;
  state: "observed" | "unavailable";
  reason?: string;
  asOf: string | null;
  evidence: "observational";
  method: typeof JUDGE_CALIBRATION_METHOD & { z: number; minPairedObservations: number; samplePerStratum: number; seed: string };
  labels: { state: "read" | "unavailable"; reason?: string; count: number; matched: number; unmatched: number };
  excluded: Record<string, number>;
  authorUnattributed: Record<string, number>;
  judges: JudgeSummary[];
  strata: JudgeStratum[];
  betweenJudges: JudgePairAgreement[];
  /** The labelling queue: every sampled verdict, and whether a label already covers it. */
  sample: Array<JudgeSampleItem & { labelled: boolean }>;
}

export interface JudgeCalibrationOptions {
  asOf: string | null;
  labels: JudgeLabelsInput;
  seed?: string;
  samplePerStratum?: number;
  minPairedObservations?: number;
}

function methodOf(options: JudgeCalibrationOptions): JudgeCalibration["method"] {
  return {
    ...JUDGE_CALIBRATION_METHOD,
    z: JUDGE_INTERVAL_Z,
    minPairedObservations: options.minPairedObservations ?? MIN_PAIRED_OBSERVATIONS,
    samplePerStratum: options.samplePerStratum ?? JUDGE_SAMPLE_PER_STRATUM,
    seed: options.seed ?? JUDGE_SAMPLE_SEED,
  };
}

export function unavailableJudgeCalibration(reason: string, asOf: string | null = null): JudgeCalibration {
  return {
    version: JUDGE_CALIBRATION_VERSION,
    state: "unavailable",
    reason,
    asOf,
    evidence: "observational",
    method: methodOf({ asOf, labels: { unavailable: reason } }),
    labels: { state: "unavailable", reason, count: 0, matched: 0, unmatched: 0 },
    excluded: {},
    authorUnattributed: {},
    judges: [],
    strata: [],
    betweenJudges: [],
    sample: [],
  };
}

/** A cell's labelled pairs, unlabelled judge bits, raw rate and both statistics. */
function cellStatistics(verdicts: readonly JudgeVerdict[], human: ReadonlyMap<string, boolean>, minPaired: number, labelsUnavailable: string | undefined) {
  const pairs = verdicts.filter((v) => human.has(v.ref)).map((v) => ({ judge: v.pass, human: human.get(v.ref)! }));
  const unlabelled = verdicts.filter((v) => !human.has(v.ref)).map((v) => v.pass);
  return {
    verdicts: verdicts.length,
    rawPassRate: mean(verdicts.map((v) => bit(v.pass))),
    labelled: pairs.length,
    humanAgreement: labelsUnavailable !== undefined
      ? { state: "unknown" as const, reason: labelsUnavailable, count: 0 }
      : cohensKappa(pairs.map((p) => [p.judge, p.human] as const), minPaired),
    corrected: labelsUnavailable !== undefined
      ? { state: "unknown" as const, reason: labelsUnavailable, labelled: 0 }
      : ppiEstimate(pairs, unlabelled, minPaired),
  };
}

/** Verdict-count-weighted combination of a judge's strata; unknown when any stratum is. */
function stratifiedEstimate(strata: readonly JudgeStratum[]): JudgeEstimate {
  const total = strata.reduce((sum, s) => sum + s.verdicts, 0);
  const labelled = strata.reduce((sum, s) => sum + s.labelled, 0);
  const unknown = strata.filter((s) => s.corrected.state === "unknown").length;
  if (unknown > 0) return { state: "unknown", reason: `${unknown} of ${strata.length} author strata have no corrected rate`, labelled };
  let estimate = 0;
  let variance = 0;
  let unlabelled = 0;
  for (const stratum of strata) {
    const cell = stratum.corrected as Extract<JudgeEstimate, { state: "estimated" }>;
    const weight = stratum.verdicts / total;
    estimate += weight * cell.estimate;
    variance += weight ** 2 * cell.standardError ** 2;
    unlabelled += cell.unlabelled;
  }
  return interval(estimate, variance, labelled, unlabelled);
}

/** Pairwise judge agreement on heads both judges scored, latest verdict per judge per head. */
function betweenJudgeAgreement(verdicts: readonly JudgeVerdict[], minPaired: number): JudgePairAgreement[] {
  const byHead = new Map<string, Map<string, JudgeVerdict>>();
  for (const verdict of verdicts) {
    if (verdict.headSha === null) continue;
    const judges = byHead.get(verdict.headSha) ?? new Map<string, JudgeVerdict>();
    judges.set(judgeIdOf(verdict), verdict);
    byHead.set(verdict.headSha, judges);
  }
  const descriptors = new Map(verdicts.map((v) => [judgeIdOf(v), { kind: v.kind, model: v.judgeModel }]));
  const ids = [...descriptors.keys()].sort();
  const out: JudgePairAgreement[] = [];
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      const pairs: Array<readonly [boolean, boolean]> = [];
      for (const judges of byHead.values()) {
        const a = judges.get(ids[i]!);
        const b = judges.get(ids[j]!);
        if (a && b) pairs.push([a.pass, b.pass]);
      }
      out.push({ judges: [descriptors.get(ids[i]!)!, descriptors.get(ids[j]!)!], agreement: cohensKappa(pairs, minPaired) });
    }
  }
  return out;
}

/**
 * THE PROJECTION. Pure over ledger rows and labels: extract, sample, join the latest label per
 * verdict, then score every judge x author stratum, every judge, and every judge pair.
 */
export function deriveJudgeCalibration(rows: ReadonlyArray<Row>, options: JudgeCalibrationOptions): JudgeCalibration {
  const method = methodOf(options);
  const { verdicts, excluded, authorUnattributed } = extractJudgeVerdicts(rows);
  const labelsUnavailable = "unavailable" in options.labels ? options.labels.unavailable : undefined;
  const labelRows = "labels" in options.labels ? options.labels.labels : [];
  const latest = new Map<string, JudgeLabel>();
  for (const label of labelRows) {
    const prior = latest.get(label.verdictRef);
    if (prior === undefined || label.labelledAt >= prior.labelledAt) latest.set(label.verdictRef, label);
  }
  const refs = new Set(verdicts.map((v) => v.ref));
  const human = new Map([...latest.values()].filter((l) => refs.has(l.verdictRef)).map((l) => [l.verdictRef, l.label === "pass"]));
  const labels: JudgeCalibration["labels"] = {
    state: labelsUnavailable === undefined ? "read" : "unavailable",
    ...(labelsUnavailable === undefined ? {} : { reason: labelsUnavailable }),
    count: labelRows.length,
    matched: human.size,
    unmatched: latest.size - human.size,
  };
  if (verdicts.length === 0) return { ...unavailableJudgeCalibration("no-judge-verdicts-observed", options.asOf), method, labels, excluded, authorUnattributed };

  const sample = drawJudgeSample(verdicts, { seed: method.seed, perStratum: method.samplePerStratum });
  const sampledByStratum = new Map<string, number>();
  for (const item of sample) {
    const key = JSON.stringify([`${item.judge.kind}:${item.judge.model}`, item.authorModel]);
    sampledByStratum.set(key, (sampledByStratum.get(key) ?? 0) + 1);
  }
  const cells = new Map<string, JudgeVerdict[]>();
  for (const verdict of verdicts) cells.set(stratumKeyOf(verdict), [...(cells.get(stratumKeyOf(verdict)) ?? []), verdict]);
  const strata: JudgeStratum[] = [...cells.keys()].sort().map((key) => {
    const members = cells.get(key)!;
    return {
      judge: { kind: members[0]!.kind, model: members[0]!.judgeModel },
      authorModel: members[0]!.authorModel,
      sampled: sampledByStratum.get(key) ?? 0,
      ...cellStatistics(members, human, method.minPairedObservations, labelsUnavailable),
    };
  });

  const byJudge = new Map<string, JudgeVerdict[]>();
  for (const verdict of verdicts) byJudge.set(judgeIdOf(verdict), [...(byJudge.get(judgeIdOf(verdict)) ?? []), verdict]);
  const judges: JudgeSummary[] = [...byJudge.keys()].sort().map((id) => {
    const members = byJudge.get(id)!;
    const cell = cellStatistics(members, human, method.minPairedObservations, labelsUnavailable);
    return {
      judge: { kind: members[0]!.kind, model: members[0]!.judgeModel },
      verdicts: cell.verdicts,
      rawPassRate: cell.rawPassRate,
      labelled: cell.labelled,
      humanAgreement: cell.humanAgreement,
      corrected: labelsUnavailable !== undefined ? cell.corrected : stratifiedEstimate(strata.filter((s) => `${s.judge.kind}:${s.judge.model}` === id)),
    };
  });

  return {
    version: JUDGE_CALIBRATION_VERSION,
    state: "observed",
    asOf: options.asOf,
    evidence: "observational",
    method,
    labels,
    excluded,
    authorUnattributed,
    judges,
    strata,
    betweenJudges: betweenJudgeAgreement(verdicts, method.minPairedObservations),
    sample: sample.map((item) => ({ ...item, labelled: human.has(item.verdictRef) })),
  };
}
