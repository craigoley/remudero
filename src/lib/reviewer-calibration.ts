/**
 * lib/reviewer-calibration.ts — W1-T12145: the reviewer is scored against known answers.
 *
 * MEASURED 2026-11-10 (the shard's rationale): the two reviewer models disagree widely — gpt-6.1-sol
 * failed 55.6% of reviews, sonnet-5-5 14.6% — and nothing measured which one was RIGHT. History holds
 * the answers: a merged head later reverted or follow-up-fixed (a `verdict_calibration.outcome` row,
 * W1-T12425) is a real escaped defect whose right verdict was FAIL; a head clean through the window is
 * a control whose right verdict was PASS. Every case passed the incumbent reviewer once, so the set is
 * hard by construction, and re-running the incumbent on it measures its own run-to-run noise.
 *
 * THE PASS, one call per measurement cadence fire ({@link scoreReviewersAgainstKnownAnswers}):
 *  1. CASES ({@link buildCalibrationCases}): escaped defects and controls, sampled per risk level with a
 *     seed — every escaped defect of a risk level, and as many of its controls, drawn by the seed. A case
 *     whose pull request is unknown is dropped and named.
 *  2. THE EPOCH ({@link freezeCalibrationEpoch}): the case list is frozen once, with its seed and its
 *     registered protocol, in `<state>/reviewer-calibration/`. A later pass reads it back and never
 *     derives it again; a new epoch starts only when {@link NEW_EPOCH_ESCAPED_DEFECTS} new escaped
 *     defects exist. A frozen epoch file is written with exclusive create and never rewritten, and the pass
 *     that freezes it starts none of its cases, so the protocol is registered strictly before the first.
 *  3. THE RUNNER (injected): the live reviewer in shadow mode (`--reviewer-shadow`, W1-T10269) on the
 *     case's pull request at its recorded head, with the model under test pinned. A shadow review posts
 *     no status, comment or label (INVARIANT calibration-publishes-nothing).
 *  4. THE GATES, before any request: a subscription-backed case runs only while `replayIdleGate` reads
 *     the fleet idle with every measured usage window below {@link IDLE_LIMIT_PCT}%; a cash-backed case
 *     reserves against the {@link EVALUATOR_CASH_CAP_USD} per {@link EVALUATOR_CAP_WINDOW_DAYS}-day
 *     evaluator cap. A refusal writes one {@link REVIEW_CALIBRATION_RESULT_STEP} row, `outcome: "refused"`, with its reason.
 *  5. THE SCORE ({@link scoreCalibrationModel}): per model, the false-FAIL rate on controls and the
 *     detection rate on escaped defects, each with a Wilson interval and its case count, the cost and
 *     duration of its cases, and the incumbent's re-run agreement as the noise floor. One
 *     {@link REVIEW_CALIBRATION_RESULT_STEP} row per model per pass.
 *  6. THE EARLY STOP ({@link calibrationPairDecisions}): after each case, W1-T14147's always-valid
 *     sequential test per metric and model pair; a pair whose comparison reads decided gets no more
 *     cases of that metric this epoch, and the result row records the decision, p-value and cases spent.
 *
 * NOT IN SCOPE (the shard): which model reviews live work (W1-T14043 reads this pass's result), the
 * review prompt, and seeded mutants.
 */
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { fixedClock, type Clock } from "./clock.js";
import { isWorkerProviderId, type Config } from "./config.js";
import { WORKER_PROVIDER_IDS, type WorkerProviderId } from "./config-schema.js";
import { judgeInstanceLiveness, LIVENESS_WINDOW_MS } from "./fleet-liveness.js";
import type { UsageSnapshot } from "./headroom.js";
import { readLedgerUnionRawLinesAsync } from "./ledger-union.js";
import { REVIEWER_SHADOW_FLAG, REVIEWER_SHADOW_STEP_PREFIX, REVIEWER_SHADOW_VERDICT_STEP } from "./reviewer-health.js";
import { buildEvalCard, protocolHash, type EvalCard, type EvalCardTrial } from "./eval-card.js";
import { replayIdleGate, type ReplayIdleSignal } from "./golden-corpus.js";
import { seedOf, seededRandom } from "./knowledge-value.js";
import { wilsonInterval } from "./model-drift.js";
import { MERGE_MIXING_VARIANCE, mergeDifferenceSequence } from "./sequential-test.js";
import { isVerdictOutcomeKind, VERDICT_OUTCOME_STEP, type VerdictOutcomeKind } from "./verdict-calibration.js";

/** One case review's outcome, per model under test. Written by the pass; the cadence reads them back. */
export const REVIEW_CALIBRATION_CASE_STEP = "review.calibration.case" as const;
/** One model's score over its epoch's cases (`outcome: "scored"`, one row per model per pass), or a refusal
 *  before spending (`outcome: "refused"`, with its reason). The next pass reads the scored rows' decided pairs
 *  back, so an epoch never spends again on a pair it already decided. */
export const REVIEW_CALIBRATION_RESULT_STEP = "review.calibration.result" as const;

/** PRIMARY CONTROL: no subscription-backed case starts while any measured usage window is at or above it (operator, 2026-11-21). */
export const IDLE_LIMIT_PCT = 80;
/** PRIMARY CONTROL: no cash-backed case starts unless the window's cash spend plus its reservation fits it (operator, 2026-11-21). */
export const EVALUATOR_CASH_CAP_USD = 25;
/** PRIMARY CONTROL: the days of cash case rows, across epochs, that {@link EVALUATOR_CASH_CAP_USD} sums. */
export const EVALUATOR_CAP_WINDOW_DAYS = 7;
/** PRIMARY CONTROL: no new epoch is frozen until this many escaped defects exist that no earlier epoch holds. */
export const NEW_EPOCH_ESCAPED_DEFECTS = 20;
/** The sequential test's level; its mixing variance is W1-T14147's {@link MERGE_MIXING_VARIANCE}. */
export const CALIBRATION_ALPHA = 0.05;
/** The Wilson interval's z: a 95% interval. */
const WILSON_Z = 1.96;
const DAY_MS = 24 * 60 * 60 * 1000;

export type CalibrationCaseKind = "escaped-defect" | "control";
export type CalibrationMetric = "control-false-fail" | "escaped-detection";
export type ReviewerVerdict = "PASS" | "FAIL";

/** A model under test: the provider and the requested model a `review.posted` row's provenance names. */
export interface CalibrationModel {
  provider: string;
  model: string;
}

export interface CalibrationCase {
  caseId: string;
  taskId: string;
  headSha: string;
  mergeSha: string;
  kind: CalibrationCaseKind;
  /** The verdict a right reviewer gives: FAIL on an escaped defect, PASS on a control. */
  expected: ReviewerVerdict;
  risk: string;
  prNumber: number;
  prUrl: string;
  /** The model that passed this head live, when its review row named one: the incumbent to re-run. */
  incumbent?: CalibrationModel;
}

/** One `verdict_calibration.outcome` row's fields the pass reads. */
export interface CalibrationOutcomeInput {
  task_id: string;
  head_sha: string;
  merge_sha: string;
  outcome: VerdictOutcomeKind;
}

/** What the live review of a head left: its pull request and, when named, the model that reviewed it. */
export interface CalibrationReviewedHead {
  prUrl: string;
  risk?: string;
  incumbent?: CalibrationModel;
}

/** `rmd review` flag: the head a calibration case was merged at. Honoured only with {@link REVIEWER_SHADOW_FLAG}. */
export const CALIBRATION_HEAD_FLAG = "--calibration-head";
/** `rmd review` flag: `<provider>:<model>`, the reviewer model under test. Honoured only with {@link REVIEWER_SHADOW_FLAG}. */
export const REVIEWER_MODEL_PIN_FLAG = "--reviewer-model";

function flagArg(rest: readonly string[], flag: string): string | undefined {
  const at = rest.indexOf(flag);
  return at >= 0 ? rest[at + 1] : undefined;
}

/** Whether `rest` asks to review this CLOSED pull request as a calibration case: a shadow review naming the
 *  40-hex head the pull request merged at. Anything else is declined as a closed pull request always was. */
export function isCalibrationCaseOf(rest: readonly string[], row: { head?: { sha?: string }; merged_at?: string | null }): boolean {
  const head = flagArg(rest, CALIBRATION_HEAD_FLAG);
  return rest.includes(REVIEWER_SHADOW_FLAG) && typeof head === "string" && /^[0-9a-f]{40}$/i.test(head) &&
    typeof row.merged_at === "string" && row.head?.sha === head;
}

/** The reviewer model a shadow review pins, or undefined: no pin outside shadow mode, and none whose provider
 *  is not a worker provider. A pin replaces the reviewer mount's provider and model, never its effort or turns. */
export function reviewerModelPin(rest: readonly string[]): { provider: WorkerProviderId; model: string } | undefined {
  if (!rest.includes(REVIEWER_SHADOW_FLAG)) return undefined;
  const value = flagArg(rest, REVIEWER_MODEL_PIN_FLAG);
  const at = value?.indexOf(":") ?? -1;
  if (value === undefined || at <= 0 || at === value.length - 1) return undefined;
  const provider = value.slice(0, at);
  return isWorkerProviderId(provider) ? { provider, model: value.slice(at + 1) } : undefined;
}

export const modelKey = (m: CalibrationModel): string => `${m.provider}:${m.model}`;
export const billingOf = (m: CalibrationModel): "cash" | "subscription" => (m.provider === "cash" || m.provider === "openweight" ? "cash" : "subscription");
const prNumberOf = (url: string): number | undefined => {
  const m = /\/pull\/([1-9][0-9]*)$/.exec(url);
  return m ? Number(m[1]) : undefined;
};

/** The seeded shuffle every draw in an epoch uses: one stream per seed and stratum. */
function shuffled<T>(items: readonly T[], seed: string): T[] {
  const rng = seededRandom(seedOf(seed));
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/**
 * The cases of one epoch, from `verdict_calibration.outcome` rows. A head with a `reverted` or
 * `followup_fixed` row is an escaped defect (right verdict FAIL); a head whose only row is `clean` is a
 * control (right verdict PASS). Per risk level, every escaped defect enters, and the seed draws as many
 * of that level's controls. A head with no reviewed pull request is dropped and named.
 */
export function buildCalibrationCases(
  outcomes: readonly CalibrationOutcomeInput[],
  reviewed: ReadonlyMap<string, CalibrationReviewedHead>,
  seed: string,
): { cases: CalibrationCase[]; dropped: Array<{ headSha: string; reason: string }> } {
  const byHead = new Map<string, { taskId: string; mergeSha: string; kinds: Set<VerdictOutcomeKind> }>();
  for (const o of outcomes) {
    if (!o.head_sha) continue;
    const entry = byHead.get(o.head_sha) ?? { taskId: o.task_id, mergeSha: o.merge_sha, kinds: new Set<VerdictOutcomeKind>() };
    entry.kinds.add(o.outcome);
    byHead.set(o.head_sha, entry);
  }
  const dropped: Array<{ headSha: string; reason: string }> = [];
  const strata = new Map<string, { escaped: CalibrationCase[]; controls: CalibrationCase[] }>();
  for (const [headSha, { taskId, mergeSha, kinds }] of [...byHead].sort(([a], [b]) => a.localeCompare(b))) {
    const head = reviewed.get(headSha);
    const prNumber = head ? prNumberOf(head.prUrl) : undefined;
    if (!head || prNumber === undefined) {
      dropped.push({ headSha, reason: "no review.posted row names this head's pull request" });
      continue;
    }
    const escaped = kinds.has("reverted") || kinds.has("followup_fixed");
    const risk = head.risk ?? "unknown";
    const c: CalibrationCase = {
      caseId: headSha, taskId, headSha, mergeSha, kind: escaped ? "escaped-defect" : "control",
      expected: escaped ? "FAIL" : "PASS", risk, prNumber, prUrl: head.prUrl,
      ...(head.incumbent ? { incumbent: head.incumbent } : {}),
    };
    const stratum = strata.get(risk) ?? { escaped: [], controls: [] };
    (escaped ? stratum.escaped : stratum.controls).push(c);
    strata.set(risk, stratum);
  }
  const cases: CalibrationCase[] = [];
  for (const [risk, { escaped, controls }] of [...strata].sort(([a], [b]) => a.localeCompare(b))) {
    const drawn = shuffled(controls, `${seed}:${risk}:controls`).slice(0, escaped.length);
    cases.push(...shuffled([...escaped, ...drawn], `${seed}:${risk}:order`));
  }
  return { cases, dropped };
}

/** The days of `review.posted` rows whose models are compared: a model no review named in this window is not under test. */
export const CALIBRATION_MODEL_WINDOW_DAYS = 14;

/** The model a `review.posted` row's provenance names: a worker provider and the model it requested. */
export function reviewedByModel(row: Record<string, unknown>): CalibrationModel | undefined {
  const provenance = row.evaluator_provenance;
  if (provenance === null || typeof provenance !== "object") return undefined;
  const { provider, requestedModel } = provenance as Record<string, unknown>;
  return isWorkerProviderId(provider) && typeof requestedModel === "string" && requestedModel !== "" ? { provider, model: requestedModel } : undefined;
}

/** What the pass reads off the ledger: the outcome rows, the passing review of each head, and the models under test. */
export interface CalibrationInputs {
  outcomes: CalibrationOutcomeInput[];
  reviewed: Map<string, CalibrationReviewedHead>;
  models: CalibrationModel[];
}

/**
 * The pass's inputs from ledger rows. A head's reviewed pull request and incumbent come from its last passing
 * `review.posted` row (a merged head passed review), its risk from that run's `review.semantic_mode` row. The
 * models under test are the ones `review.posted` rows named within {@link CALIBRATION_MODEL_WINDOW_DAYS} of `nowMs`.
 */
export function calibrationInputsFromRows(rows: ReadonlyArray<Record<string, unknown>>, nowMs: number): CalibrationInputs {
  const riskByRun = new Map<string, string>();
  for (const row of rows) {
    if (row.step === "review.semantic_mode" && typeof row.run_id === "string" && typeof row.task_risk === "string") riskByRun.set(row.run_id, row.task_risk);
  }
  const outcomes: CalibrationOutcomeInput[] = [];
  const reviewed = new Map<string, CalibrationReviewedHead>();
  const models = new Map<string, CalibrationModel>();
  const since = nowMs - CALIBRATION_MODEL_WINDOW_DAYS * DAY_MS;
  for (const row of rows) {
    if (row.step === VERDICT_OUTCOME_STEP && typeof row.head_sha === "string" && isVerdictOutcomeKind(row.outcome)) {
      outcomes.push({ task_id: String(row.task_id ?? ""), head_sha: row.head_sha, merge_sha: typeof row.merge_sha === "string" ? row.merge_sha : "", outcome: row.outcome });
      continue;
    }
    if (row.step !== "review.posted") continue;
    const model = reviewedByModel(row);
    if (model !== undefined && typeof row.ts === "string" && Date.parse(row.ts) >= since) models.set(modelKey(model), model);
    if (row.state !== "success" || typeof row.head_sha !== "string" || typeof row.pr_url !== "string") continue;
    const risk = typeof row.run_id === "string" ? riskByRun.get(row.run_id) : undefined;
    reviewed.set(row.head_sha, { prUrl: row.pr_url, ...(risk === undefined ? {} : { risk }), ...(model === undefined ? {} : { incumbent: model }) });
  }
  return { outcomes, reviewed, models: [...models.values()].sort((a, b) => modelKey(a).localeCompare(modelKey(b))) };
}

/** A shadow review's rows carry this prefix (W1-T10269); a case reads its own verdict and reviewer rows by it. */
const SHADOW_VERDICT_STEP = `${REVIEWER_SHADOW_STEP_PREFIX}${REVIEWER_SHADOW_VERDICT_STEP}`;
const SHADOW_REVIEWER_STEP = `${REVIEWER_SHADOW_STEP_PREFIX}review.reviewer`;

/**
 * A case's result from the rows its shadow review wrote under its attempt id. PASS or FAIL only when the review
 * reached its shadow verdict at the case's head, its reviewer ran and finished, and that reviewer was the pinned
 * model; anything else is null with the reason, never a verdict. The cost is the billed cost those rows name.
 */
export function calibrationCaseResult(
  c: Pick<CalibrationCase, "headSha">,
  model: CalibrationModel,
  rows: ReadonlyArray<Record<string, unknown>>,
  exit: { code: number | undefined; failure?: string },
): CalibrationCaseResult {
  const costs = rows.map((r) => r.total_cost_usd).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  const costUsd = costs.length === 0 ? null : costs.reduce((a, b) => a + b, 0);
  const none = (reason: string): CalibrationCaseResult => ({ verdict: null, costUsd, reason });
  const verdictRow = rows.findLast((r) => r.step === SHADOW_VERDICT_STEP);
  if (verdictRow === undefined) {
    const why = exit.failure === undefined ? "" : `: ${exit.failure}`;
    return none(exit.code === undefined ? `the review could not run${why}` : `the review exited ${exit.code} with no shadow verdict${why}`);
  }
  if (verdictRow.head_sha !== c.headSha) return none(`the review judged ${String(verdictRow.head_sha)}, not the case's head`);
  const reviewer = rows.findLast((r) => r.step === SHADOW_REVIEWER_STEP);
  const ran = reviewer === undefined ? "no reviewer" : `${String(reviewer.provider)}:${String(reviewer.model)}`;
  if (ran !== modelKey(model)) return none(`the review ran ${ran}, not the pinned ${modelKey(model)}`);
  if (verdictRow.reviewer_outcome !== "success") return none(`the reviewer's outcome was ${String(verdictRow.reviewer_outcome)}`);
  if (verdictRow.state === "success") return { verdict: "PASS", costUsd };
  if (verdictRow.state === "failure") return { verdict: "FAIL", costUsd };
  return none(`the shadow verdict was ${String(verdictRow.state)}`);
}

// ── The epoch ────────────────────────────────────────────────────────────────────────────────

/** One frozen epoch: its cases, seed and protocol, registered before its first case. Never rewritten. */
export interface CalibrationEpoch {
  epoch: number;
  seed: string;
  frozenAt: string;
  cases: CalibrationCase[];
  dropped: Array<{ headSha: string; reason: string }>;
  trial: EvalCardTrial;
}

export const calibrationEpochDir = (stateDir: string): string => join(stateDir, "reviewer-calibration");
const EPOCH_FILE = /^epoch-([1-9][0-9]*)\.json$/;

/** The newest frozen epoch under `stateDir`, or undefined when none was frozen. A file that does not
 *  parse is never read as an epoch: the pass then refuses rather than derive the set again. */
export function readCalibrationEpoch(stateDir: string): CalibrationEpoch | undefined | { unreadable: string } {
  const dir = calibrationEpochDir(stateDir);
  if (!existsSync(dir)) return undefined;
  const numbers = readdirSync(dir).map((name) => EPOCH_FILE.exec(name)?.[1]).filter((n): n is string => n !== undefined).map(Number);
  if (numbers.length === 0) return undefined;
  const newest = Math.max(...numbers);
  const path = join(dir, `epoch-${newest}.json`);
  try {
    const epoch = JSON.parse(readFileSync(path, "utf8")) as CalibrationEpoch;
    if (epoch.epoch !== newest || !Array.isArray(epoch.cases) || typeof epoch.seed !== "string") return { unreadable: `${path} is not a frozen epoch` };
    return epoch;
  } catch (error) {
    return { unreadable: `${path}: ${String((error as Error)?.message ?? error)}` };
  }
}

/** The protocol each epoch registers before its first case: the case rule, metrics, cap, idle limit,
 *  and the sequential test's mixing variance and α. Its hash is the eval card's pre-registration. */
export function calibrationProtocolText(epoch: number, seed: string): string {
  return [
    `reviewer calibration (W1-T12145) epoch ${epoch}, seed ${seed}`,
    "cases: verdict_calibration.outcome heads; reverted or followup_fixed is an escaped defect (right verdict FAIL),",
    "clean only is a control (right verdict PASS); per risk level every escaped defect and as many seeded controls",
    "metrics: false-FAIL rate on controls, detection rate on escaped defects, each a 95% Wilson interval with its count",
    `subscription cases only while the fleet is idle and every measured usage window is below ${IDLE_LIMIT_PCT}%`,
    `cash cases inside $${EVALUATOR_CASH_CAP_USD} per ${EVALUATOR_CAP_WINDOW_DAYS} days`,
    `early stop: always-valid paired test per metric and model pair, mixing variance ${MERGE_MIXING_VARIANCE}, alpha ${CALIBRATION_ALPHA}`,
  ].join("\n");
}

/** Freeze epoch `epoch` before its first case: exclusive create, so an existing epoch is never
 *  rewritten (a second freezer of the same number throws). The trial's registration time is `clock`'s now. */
export function freezeCalibrationEpoch(
  stateDir: string,
  epoch: number,
  seed: string,
  built: { cases: CalibrationCase[]; dropped: Array<{ headSha: string; reason: string }> },
  models: readonly CalibrationModel[],
  clock: Clock,
): CalibrationEpoch {
  const protocolText = calibrationProtocolText(epoch, seed);
  const frozenAt = clock.iso();
  const trial: EvalCardTrial = {
    trialId: `reviewer-calibration-epoch-${epoch}`,
    kind: "paired",
    protocolText,
    preRegisteredAt: frozenAt,
    registeredProtocolHash: protocolHash(protocolText),
    estimand: "per reviewer model: false-FAIL rate on controls and detection rate on escaped defects",
    randomizationUnit: "one case reviewed by one model; every model under test reviews every case",
    plannedAllocation: Object.fromEntries(models.map((m) => [modelKey(m), 1 / Math.max(1, models.length)])),
  };
  const frozen: CalibrationEpoch = { epoch, seed, frozenAt, cases: built.cases, dropped: built.dropped, trial };
  const dir = calibrationEpochDir(stateDir);
  mkdirSync(dir, { recursive: true });
  const fd = openSync(join(dir, `epoch-${epoch}.json`), "wx", 0o600);
  try {
    writeSync(fd, JSON.stringify(frozen, null, 2) + "\n");
  } finally {
    closeSync(fd);
  }
  return frozen;
}

// ── Runs and scores ──────────────────────────────────────────────────────────────────────────

/** One case reviewed by one model, as its {@link REVIEW_CALIBRATION_CASE_STEP} row carries it. */
export interface CalibrationRun {
  epoch: number;
  caseId: string;
  kind: CalibrationCaseKind;
  provider: string;
  model: string;
  /** null: the review gave no PASS or FAIL (withheld, pending, failed to run) — unmeasured, never correct. */
  verdict: ReviewerVerdict | null;
  costUsd: number | null;
  durationMs: number;
  at: string;
  incumbent: boolean;
  reason?: string;
}

/** The run as its ledger row, and back. The row is the only store of a run across passes. */
export function calibrationCaseRow(run: CalibrationRun): Record<string, unknown> {
  return {
    step: REVIEW_CALIBRATION_CASE_STEP, epoch: run.epoch, case_id: run.caseId, kind: run.kind, provider: run.provider, model: run.model,
    verdict: run.verdict, cost_usd: run.costUsd, duration_ms: run.durationMs, at: run.at, incumbent: run.incumbent,
    ...(run.reason === undefined ? {} : { reason: run.reason }),
  };
}

export function calibrationRunFromRow(row: Record<string, unknown>): CalibrationRun | undefined {
  const verdict = row.verdict === "PASS" || row.verdict === "FAIL" ? row.verdict : row.verdict === null ? null : undefined;
  if (typeof row.epoch !== "number" || typeof row.case_id !== "string" || (row.kind !== "escaped-defect" && row.kind !== "control")
    || typeof row.provider !== "string" || typeof row.model !== "string" || verdict === undefined) return undefined;
  return {
    epoch: row.epoch, caseId: row.case_id, kind: row.kind, provider: row.provider, model: row.model, verdict,
    costUsd: typeof row.cost_usd === "number" ? row.cost_usd : null, durationMs: typeof row.duration_ms === "number" ? row.duration_ms : 0,
    at: typeof row.at === "string" ? row.at : "", incumbent: row.incumbent === true, ...(typeof row.reason === "string" ? { reason: row.reason } : {}),
  };
}

/** A rate over its count, with a 95% Wilson interval; `rate` and the bounds are null on an empty count. */
export interface CalibrationRate {
  cases: number;
  hits: number;
  rate: number | null;
  lower: number | null;
  upper: number | null;
}

function rate(hits: number, cases: number): CalibrationRate {
  if (cases === 0) return { cases, hits, rate: null, lower: null, upper: null };
  const { lower, upper } = wilsonInterval(hits, cases, WILSON_Z);
  return { cases, hits, rate: hits / cases, lower, upper };
}

export interface CalibrationModelScore {
  provider: string;
  model: string;
  /** FAIL verdicts on controls, over the controls it gave a verdict on: a false FAIL is a wrong answer. */
  controlFalseFail: CalibrationRate;
  /** FAIL verdicts on escaped defects, over the escaped defects it gave a verdict on. */
  escapedDetection: CalibrationRate;
  /** Runs that gave no verdict, counted apart and never as right or wrong. */
  unmeasured: number;
  costUsd: { total: number | null; perCase: number | null; unread: number };
  durationMs: { total: number; perCase: number | null };
  /** The incumbent re-run on cases it passed live: how often it passes them again. The noise floor. */
  incumbentRerun: CalibrationRate;
}

/** One model's score over `runs` (its own rows only are read). */
export function scoreCalibrationModel(model: CalibrationModel, runs: readonly CalibrationRun[]): CalibrationModelScore {
  const own = runs.filter((r) => r.provider === model.provider && r.model === model.model);
  const measured = own.filter((r) => r.verdict !== null);
  const controls = measured.filter((r) => r.kind === "control");
  const escaped = measured.filter((r) => r.kind === "escaped-defect");
  const incumbent = measured.filter((r) => r.incumbent);
  const costs = own.map((r) => r.costUsd).filter((c): c is number => c !== null);
  const totalCost = costs.length === 0 ? null : costs.reduce((a, b) => a + b, 0);
  const totalMs = own.reduce((a, r) => a + r.durationMs, 0);
  return {
    provider: model.provider,
    model: model.model,
    controlFalseFail: rate(controls.filter((r) => r.verdict === "FAIL").length, controls.length),
    escapedDetection: rate(escaped.filter((r) => r.verdict === "FAIL").length, escaped.length),
    unmeasured: own.length - measured.length,
    costUsd: { total: totalCost, perCase: totalCost === null ? null : totalCost / costs.length, unread: own.length - costs.length },
    durationMs: { total: totalMs, perCase: own.length === 0 ? null : totalMs / own.length },
    incumbentRerun: rate(incumbent.filter((r) => r.verdict === "PASS").length, incumbent.length),
  };
}

/** The metric a case of `kind` measures. */
export const metricOf = (kind: CalibrationCaseKind): CalibrationMetric => (kind === "control" ? "control-false-fail" : "escaped-detection");

/** One model pair's comparison on one metric: the paired, always-valid sequential test (W1-T14147). */
export interface CalibrationPairDecision {
  pair: [string, string];
  metric: CalibrationMetric;
  casesSpent: number;
  pValue: number;
  decided: boolean;
  /** When decided, the model the test reads as right more often on this metric. */
  better?: string;
}

/**
 * Every model pair's comparison per metric, over the cases both reviewed with a verdict, in the epoch's
 * case order: each case is one paired observation, the first model's correctness minus the second's.
 * A pair reads decided when the always-valid p-value is at most {@link CALIBRATION_ALPHA}.
 */
export function calibrationPairDecisions(
  epoch: Pick<CalibrationEpoch, "cases">,
  models: readonly CalibrationModel[],
  runs: readonly CalibrationRun[],
): CalibrationPairDecision[] {
  const verdictOf = new Map<string, ReviewerVerdict>();
  for (const r of runs) if (r.verdict !== null) verdictOf.set(`${r.caseId}\0${r.provider}:${r.model}`, r.verdict);
  const keys = [...new Set(models.map(modelKey))].sort();
  const out: CalibrationPairDecision[] = [];
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      for (const metric of ["control-false-fail", "escaped-detection"] as const) {
        const observations: Array<{ lower: number; upper: number }> = [];
        for (const c of epoch.cases) {
          if (metricOf(c.kind) !== metric) continue;
          const a = verdictOf.get(`${c.caseId}\0${keys[i]}`);
          const b = verdictOf.get(`${c.caseId}\0${keys[j]}`);
          if (a === undefined || b === undefined) continue;
          const diff = Number(a === c.expected) - Number(b === c.expected);
          observations.push({ lower: diff, upper: diff });
        }
        const seq = mergeDifferenceSequence(observations, CALIBRATION_ALPHA);
        const decided = observations.length > 0 && seq.pValue <= CALIBRATION_ALPHA;
        out.push({
          pair: [keys[i]!, keys[j]!], metric, casesSpent: observations.length, pValue: seq.pValue, decided,
          ...(decided ? { better: seq.lower > 0 ? keys[i]! : keys[j]! } : {}),
        });
      }
    }
  }
  return out;
}

/** The (pair, metric) decisions earlier passes of `epoch` recorded on their scored result rows. */
export function decidedFromResultRows(rows: ReadonlyArray<Record<string, unknown>>, epoch: number): Map<string, { pValue: number; casesSpent: number; better?: string }> {
  const out = new Map<string, { pValue: number; casesSpent: number; better?: string }>();
  for (const row of rows) {
    if (row.outcome !== "scored" || row.epoch !== epoch || !Array.isArray(row.stopped)) continue;
    for (const s of row.stopped as Array<Record<string, unknown>>) {
      if (!Array.isArray(s.pair) || typeof s.metric !== "string") continue;
      const better = typeof s.decision === "string" ? /^decided: (\S+) is right/.exec(s.decision)?.[1] : undefined;
      out.set(`${(s.pair as string[]).join("|")}\0${s.metric}`, {
        pValue: typeof s.p_value === "number" ? s.p_value : 0, casesSpent: typeof s.cases_spent === "number" ? s.cases_spent : 0,
        ...(better === undefined ? {} : { better }),
      });
    }
  }
  return out;
}

/** A pair an earlier pass of the epoch recorded decided stays decided: a sequential test that has stopped is not
 *  read again, and a case row lost from an unreadable archive can never restart spending on it. */
export function withRecordedDecisions(
  decisions: readonly CalibrationPairDecision[],
  recorded: ReadonlyMap<string, { pValue: number; casesSpent: number; better?: string }>,
): CalibrationPairDecision[] {
  return decisions.map((d) => {
    const prior = recorded.get(`${d.pair.join("|")}\0${d.metric}`);
    return prior === undefined || d.decided ? d : { ...d, decided: true, pValue: prior.pValue, casesSpent: prior.casesSpent, ...(prior.better ? { better: prior.better } : {}) };
  });
}

/** Whether `model` still needs cases of `metric`: some pair it belongs to is undecided on it. With one
 *  model under test there is no pair, so it keeps scoring its cases. */
export function modelNeedsMetric(model: CalibrationModel, metric: CalibrationMetric, decisions: readonly CalibrationPairDecision[], models: readonly CalibrationModel[]): boolean {
  const key = modelKey(model);
  const mine = decisions.filter((d) => d.metric === metric && d.pair.includes(key));
  return models.length < 2 || mine.some((d) => !d.decided);
}

/** The eval card of an epoch: its registered trial, and one assignment per case run. The unit is one case reviewed by
 *  one model, because every model reviews every case: a case id alone would read each second model as a crossover. */
export function calibrationEvalCard(epoch: CalibrationEpoch, runs: readonly CalibrationRun[]): EvalCard {
  const own = runs.filter((r) => r.epoch === epoch.epoch);
  return buildEvalCard(epoch.trial, {
    assignments: own.map((r) => ({ unitId: `${r.caseId}:${r.provider}:${r.model}`, arm: `${r.provider}:${r.model}`, assignedAt: r.at })),
    outcomes: own.filter((r) => r.verdict !== null).map((r) => ({
      unitId: `${r.caseId}:${r.provider}:${r.model}`, arm: `${r.provider}:${r.model}`, stratum: r.kind,
      success: r.verdict === (r.kind === "control" ? "PASS" : "FAIL"),
    })),
    reviewRows: [],
    deviations: [],
  });
}

// ── The pass ─────────────────────────────────────────────────────────────────────────────────

/** What a case runner returns: the shadow review's verdict, or null with the reason it gave none. */
export interface CalibrationCaseResult {
  verdict: ReviewerVerdict | null;
  costUsd: number | null;
  reason?: string;
}

/** The pass's ports. Named Ports, not Deps: `scripts/deps-interface-baseline.json`'s census only shrinks. */
export interface ReviewerCalibrationPorts {
  stateDir: string;
  clock: Clock;
  /** The `verdict_calibration.outcome` rows of the ledger union. */
  readOutcomes: () => Promise<CalibrationOutcomeInput[]>;
  /** Per head, the pull request its live review named, and its risk and reviewer when the rows say. */
  readReviewedHeads: () => Promise<Map<string, CalibrationReviewedHead>>;
  /** Earlier passes' rows, split by step by the reader: the case rows and the result rows. */
  readPriorRows: () => Promise<{ cases: Array<Record<string, unknown>>; results: Array<Record<string, unknown>> }>;
  /** The reviewer models under test. */
  models: () => Promise<CalibrationModel[]>;
  /** The fleet's idleness and measured usage, read fresh before each subscription-backed case. */
  idleSignal: () => Promise<ReplayIdleSignal>;
  /** The live reviewer in shadow mode on the case's pull request at its recorded head, the model pinned. */
  runCase: (c: CalibrationCase, model: CalibrationModel) => Promise<CalibrationCaseResult>;
  log: (row: Record<string, unknown>) => void;
  /** The most one cash-backed case may spend, reserved against the evaluator cap before it starts. */
  cashCaseReserveUsd: number;
  /** Pacing: the most cases one pass starts. An epoch completes over passes. */
  casesPerPass: number;
}

export interface ReviewerCalibrationPassResult {
  epoch: number | null;
  ran: number;
  refused: string[];
  scores: CalibrationModelScore[];
  decisions: CalibrationPairDecision[];
}

/** The heads of an epoch's escaped defects, so a later pass can count the new ones. */
const escapedHeads = (cases: readonly CalibrationCase[]): Set<string> => new Set(cases.filter((c) => c.kind === "escaped-defect").map((c) => c.headSha));

/**
 * W1-T12145 — one calibration pass. Reads or freezes the epoch, runs at most `casesPerPass` case reviews
 * behind the idle gate and the evaluator cap, then writes one result row per model under test.
 */
export async function scoreReviewersAgainstKnownAnswers(deps: ReviewerCalibrationPorts): Promise<ReviewerCalibrationPassResult> {
  const refused: string[] = [];
  const refuse = (reason: string, extra: Record<string, unknown> = {}): void => {
    refused.push(reason);
    deps.log({ step: REVIEW_CALIBRATION_RESULT_STEP, outcome: "refused", reason, at: deps.clock.iso(), ...extra });
  };
  let epoch = readCalibrationEpoch(deps.stateDir);
  if (epoch !== undefined && "unreadable" in epoch) {
    refuse(`the frozen epoch cannot be read, so no case set is derived again: ${epoch.unreadable}`);
    return { epoch: null, ran: 0, refused, scores: [], decisions: [] };
  }
  // Every read before any case: a short history would re-run cases already run and count the evaluator cap short.
  let models: CalibrationModel[];
  let outcomes: CalibrationOutcomeInput[];
  let reviewed: Map<string, CalibrationReviewedHead>;
  let prior: Awaited<ReturnType<ReviewerCalibrationPorts["readPriorRows"]>>;
  try {
    models = await deps.models();
    outcomes = await deps.readOutcomes();
    reviewed = await deps.readReviewedHeads();
    prior = await deps.readPriorRows();
  } catch (error) {
    // The refusal row is the record: it names what could not be read, and no case runs on a short history.
    refuse(`the ledger could not be read whole, so no case runs on a short count of earlier cases and spend: ${String((error as Error)?.message ?? error)}`);
    return { epoch: null, ran: 0, refused, scores: [], decisions: [] };
  }
  const known = epoch === undefined ? new Set<string>() : escapedHeads(epoch.cases);
  const fresh = buildCalibrationCases(outcomes, reviewed, "count");
  const newEscaped = fresh.cases.filter((c) => c.kind === "escaped-defect" && !known.has(c.headSha)).length;
  // The pass that freezes an epoch starts none of its cases: the protocol is registered strictly before the first one.
  const frozeThisPass = newEscaped >= NEW_EPOCH_ESCAPED_DEFECTS;
  if (frozeThisPass) {
    const number = (epoch?.epoch ?? 0) + 1;
    const seed = `${number}:${deps.clock.iso()}`;
    epoch = freezeCalibrationEpoch(deps.stateDir, number, seed, buildCalibrationCases(outcomes, reviewed, seed), models, deps.clock);
  }
  if (epoch === undefined) {
    refuse(`no epoch: ${newEscaped} escaped defect(s) have a reviewed pull request, and an epoch needs ${NEW_EPOCH_ESCAPED_DEFECTS}`);
    return { epoch: null, ran: 0, refused, scores: [], decisions: [] };
  }
  const current = epoch;
  const allRuns = prior.cases.map(calibrationRunFromRow).filter((r): r is CalibrationRun => r !== undefined);
  const runs = allRuns.filter((r) => r.epoch === current.epoch);
  const done = new Set(runs.map((r) => `${r.caseId}\0${r.provider}:${r.model}`));
  const nowMs = deps.clock.now();
  // The evaluator cap spans epochs: every cash case of the last 7 days counts, an unread cost at its reservation.
  let cashSpent = allRuns.filter((r) => billingOf(r) === "cash" && Date.parse(r.at) > nowMs - EVALUATOR_CAP_WINDOW_DAYS * DAY_MS)
    .reduce((sum, r) => sum + (r.costUsd ?? deps.cashCaseReserveUsd), 0);
  const recorded = decidedFromResultRows(prior.results, current.epoch);
  const blocked = new Set<"cash" | "subscription">();
  let decisions = withRecordedDecisions(calibrationPairDecisions(current, models, runs), recorded);
  let ran = 0;
  const startable = frozeThisPass ? 0 : deps.casesPerPass;
  for (const c of current.cases) {
    for (const model of models) {
      if (ran >= startable) break;
      const billing = billingOf(model);
      if (blocked.has(billing) || done.has(`${c.caseId}\0${modelKey(model)}`)) continue;
      if (!modelNeedsMetric(model, metricOf(c.kind), decisions, models)) continue;
      if (billing === "subscription") {
        const gate = replayIdleGate(await deps.idleSignal(), IDLE_LIMIT_PCT);
        if (!gate.enabled) {
          blocked.add(billing);
          refuse(gate.reason, { epoch: current.epoch, billing, provider: model.provider, model: model.model });
          continue;
        }
      } else if (cashSpent + deps.cashCaseReserveUsd > EVALUATOR_CASH_CAP_USD) {
        blocked.add(billing);
        refuse(`the evaluator cap would be exceeded: $${cashSpent.toFixed(2)} spent in ${EVALUATOR_CAP_WINDOW_DAYS} days ` +
          `+ $${deps.cashCaseReserveUsd.toFixed(2)} reserved > $${EVALUATOR_CASH_CAP_USD}`, { epoch: current.epoch, billing, provider: model.provider, model: model.model });
        continue;
      }
      if (billing === "cash") cashSpent += deps.cashCaseReserveUsd;
      const startedAt = deps.clock.now();
      const at = deps.clock.iso();
      const result = await deps.runCase(c, model);
      if (billing === "cash") cashSpent += (result.costUsd ?? deps.cashCaseReserveUsd) - deps.cashCaseReserveUsd;
      const run: CalibrationRun = {
        epoch: current.epoch, caseId: c.caseId, kind: c.kind, provider: model.provider, model: model.model, verdict: result.verdict,
        costUsd: result.costUsd, durationMs: deps.clock.now() - startedAt, at,
        incumbent: c.incumbent !== undefined && modelKey(c.incumbent) === modelKey(model),
        ...(result.reason === undefined ? {} : { reason: result.reason }),
      };
      deps.log(calibrationCaseRow(run));
      runs.push(run);
      done.add(`${c.caseId}\0${modelKey(model)}`);
      ran += 1;
      decisions = withRecordedDecisions(calibrationPairDecisions(current, models, runs), recorded);
    }
  }
  const scores = models.map((m) => scoreCalibrationModel(m, runs));
  for (const score of scores) {
    const key = `${score.provider}:${score.model}`;
    deps.log({
      step: REVIEW_CALIBRATION_RESULT_STEP, outcome: "scored", epoch: current.epoch, provider: score.provider, model: score.model,
      control_false_fail: score.controlFalseFail, escaped_detection: score.escapedDetection, unmeasured: score.unmeasured,
      cost_usd: score.costUsd, duration_ms: score.durationMs, incumbent_rerun: score.incumbentRerun, ran_this_pass: ran,
      stopped: decisions.filter((d) => d.decided && d.pair.includes(key)).map((d) => ({
        pair: d.pair, metric: d.metric, decision: `decided: ${d.better} is right more often`, p_value: d.pValue, cases_spent: d.casesSpent,
      })),
    });
  }
  return { epoch: current.epoch, ran, refused, scores, decisions };
}

// ── The production ports ─────────────────────────────────────────────────────────────────────

/** What the measurement cadence hands the pass. Every leaf is asynchronous, because the cadence is reached from the
 *  daemon loop: no case review cuts a tree or runs git on the loop, each is an `rmd review` child of the checkout. */
export interface CalibrationWiring {
  stateDir: string;
  clock: Clock;
  config: Config;
  /** The checkout whose `bin/rmd` reviews each case: the daemon's own. */
  checkoutDir: string;
  /** Starts `rmd review <args>` from `checkoutDir` and resolves to its exit code; a non-zero exit names its failure first. */
  spawnReview: (checkoutDir: string, args: string[], onFailure?: (failure: string) => void) => Promise<number>;
  /** The review command's flag for a child that takes its own start reading. */
  ownStartFlag: string;
  /** The review command's option flags for one attempt (run-task's `reviewOptionFlags`). */
  optionFlags: (opts: { executionMode: "semantic"; reviewAttemptId: string; excludeProviders: WorkerProviderId[] }) => string[];
  /** The account's measured usage windows, or undefined when unread. */
  readUsage: (config: Config) => Promise<UsageSnapshot | undefined>;
  /** Splits earlier passes' rows by step. It lives with the caller, so each step's reader sits outside its writer's file. */
  splitPriorRows: (rows: ReadonlyArray<Record<string, unknown>>) => Awaited<ReturnType<ReviewerCalibrationPorts["readPriorRows"]>>;
  log: (row: Record<string, unknown>) => void;
  cashCaseReserveUsd: number;
  casesPerPass: number;
  /** A fresh review attempt id for a case's pull request; a random UUID by default. */
  attemptId?: (prNumber: number) => string;
}

/** The steps a pass reads off the union, in one read. */
const CALIBRATION_READ_STEPS = [VERDICT_OUTCOME_STEP, "review.posted", "review.semantic_mode", REVIEW_CALIBRATION_CASE_STEP, REVIEW_CALIBRATION_RESULT_STEP];

/** The union's lines as rows. A torn line (only an unfiltered read can return one) is no row, and is not guessed at. */
function parsedRows(lines: readonly string[]): Array<Record<string, unknown>> {
  return lines.flatMap((line) => {
    try {
      const row: unknown = JSON.parse(line);
      return row !== null && typeof row === "object" && !Array.isArray(row) ? [row as Record<string, unknown>] : [];
    } catch {
      // A torn line is no row. A step-filtered read never returns one; the unfiltered liveness read can, and a torn
      // heartbeat must not read as a measurement.
      return [];
    }
  });
}

/** Every calibration row of the WHOLE ledger union, read off the loop. An incomplete union throws and the pass refuses:
 *  a pass over a short history would re-run cases already run and count the evaluator cap short. */
export async function readCalibrationRows(stateDir: string): Promise<Array<Record<string, unknown>>> {
  const read = await readLedgerUnionRawLinesAsync(stateDir, { step: CALIBRATION_READ_STEPS, refuseIncomplete: true });
  if (!read.ok) throw new Error(`the ledger union under ${stateDir} is incomplete; unread: ${read.unread.join(", ")}`);
  return parsedRows(read.rawLines);
}

/** The fleet's idleness and measured usage before a subscription-backed case, read off the loop. A live ledger that was
 *  not read is no measurement: the signal then carries no liveness, and the idle gate refuses for that reason. */
export async function readCalibrationIdle(stateDir: string, clock: Clock, usage: () => Promise<UsageSnapshot | undefined>): Promise<ReplayIdleSignal> {
  const nowMs = clock.now();
  const read = await readLedgerUnionRawLinesAsync(stateDir, { sinceTs: fixedClock(nowMs - LIVENESS_WINDOW_MS).iso() });
  const liveness = read.liveFileRead ? judgeInstanceLiveness({ name: "reviewer-calibration", repo: "self", stateDir }, parsedRows(read.rawLines), nowMs) : undefined;
  const headroom = await usage();
  return { ...(liveness === undefined ? {} : { liveness }), ...(headroom === undefined ? {} : { headroom }) };
}

/** The rows one shadow review wrote under its attempt id, since it started. */
export async function readCalibrationAttemptRows(stateDir: string, attemptId: string, sinceIso: string): Promise<Array<Record<string, unknown>>> {
  const read = await readLedgerUnionRawLinesAsync(stateDir, { sinceTs: sinceIso, keep: (line) => line.includes(attemptId) });
  return parsedRows(read.rawLines).filter((row) => row.review_attempt_id === attemptId);
}

const pullOf = (url: string): { owner: string; repo: string; number: number } | undefined => {
  const m = /^https?:\/\/[^/\s]+\/([^/\s]+)\/([^/\s]+)\/pull\/([1-9][0-9]*)$/.exec(url);
  return m ? { owner: m[1]!, repo: m[2]!, number: Number(m[3]) } : undefined;
};

/** One case through the live reviewer: an `rmd review` child in shadow mode at the case's head, the model under test
 *  pinned and every other provider excluded. Never rejects: a child that could not start reads as a null verdict. */
export async function runCalibrationCase(
  c: CalibrationCase,
  model: CalibrationModel,
  w: Pick<CalibrationWiring, "checkoutDir" | "spawnReview" | "ownStartFlag" | "optionFlags" | "clock"> & {
    attemptId: string;
    readAttemptRows: (attemptId: string, sinceIso: string) => Promise<Array<Record<string, unknown>>>;
  },
): Promise<CalibrationCaseResult> {
  const pull = pullOf(c.prUrl);
  if (pull === undefined) return { verdict: null, costUsd: null, reason: `the case's pull request URL ${c.prUrl} names no repository` };
  const sinceIso = w.clock.iso();
  const excludeProviders = WORKER_PROVIDER_IDS.filter((provider) => provider !== model.provider);
  const args = [
    String(pull.number), "--repo", `${pull.owner}/${pull.repo}`, REVIEWER_SHADOW_FLAG, CALIBRATION_HEAD_FLAG, c.headSha,
    REVIEWER_MODEL_PIN_FLAG, modelKey(model), w.ownStartFlag,
    ...w.optionFlags({ executionMode: "semantic", reviewAttemptId: w.attemptId, excludeProviders }),
  ];
  let failure: string | undefined;
  let code: number | undefined;
  try {
    code = await w.spawnReview(w.checkoutDir, args, (why) => { failure = why; });
  } catch (error) {
    // A child that could not start gave no verdict: the case row carries this reason and is unmeasured, never right or wrong.
    failure = `the review child could not start: ${String((error as Error)?.message ?? error)}`;
  }
  return calibrationCaseResult(c, model, await w.readAttemptRows(w.attemptId, sinceIso), { code, ...(failure === undefined ? {} : { failure }) });
}

/** The pass's ports over the wiring: one union read per pass, shared by every reader. */
export function calibrationPorts(w: CalibrationWiring): ReviewerCalibrationPorts {
  let rows: Promise<Array<Record<string, unknown>>> | undefined;
  const ledgerRows = (): Promise<Array<Record<string, unknown>>> => (rows ??= readCalibrationRows(w.stateDir));
  let inputs: Promise<CalibrationInputs> | undefined;
  const calibrationInputs = (): Promise<CalibrationInputs> => (inputs ??= ledgerRows().then((r) => calibrationInputsFromRows(r, w.clock.now())));
  const attemptId = w.attemptId ?? ((prNumber: number) => `review-PR${prNumber}-${randomUUID()}`);
  return {
    stateDir: w.stateDir,
    clock: w.clock,
    readOutcomes: async () => (await calibrationInputs()).outcomes,
    readReviewedHeads: async () => (await calibrationInputs()).reviewed,
    readPriorRows: async () => w.splitPriorRows(await ledgerRows()),
    models: async () => (await calibrationInputs()).models,
    idleSignal: () => readCalibrationIdle(w.stateDir, w.clock, () => w.readUsage(w.config)),
    runCase: (c, model) => runCalibrationCase(c, model, {
      ...w, attemptId: attemptId(c.prNumber), readAttemptRows: (id, sinceIso) => readCalibrationAttemptRows(w.stateDir, id, sinceIso),
    }),
    log: w.log,
    cashCaseReserveUsd: w.cashCaseReserveUsd,
    casesPerPass: w.casesPerPass,
  };
}
