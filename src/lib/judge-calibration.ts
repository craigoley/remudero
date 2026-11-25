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
import { systemClock, type Clock } from "./clock.js";
import { writeAtomic } from "./fs-race-safe.js";
import { JUDGE_REPLAY_DECISION_ROLE_PREFIX } from "./judge-replay-batch.js";
import { JUDGE_SHADOW_COMPARED_KEY } from "./risk-judge.js";
import { appendPanelLedger, bearerTokenId, isRecord, jsonAction, sendJson } from "./panel-actions.js";
import type { Route } from "./service.js";
import { decisionAnsweredTypedAnswers, scoreTypedAnswers, type TypedAnswer, type TypedAnswerRow, type TypedAnswerScores } from "./typed-answer-scores.js";
import { isVerdictOutcomeKind, VERDICT_OUTCOME_KINDS, VERDICT_OUTCOME_STEP, type VerdictOutcomeKind } from "./verdict-calibration.js";

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
  rates:
    "true-positive rate = P(judge pass | human pass), true-negative rate = P(judge fail | human fail), " +
    "each with a Wilson interval at z and unknown below minPairedObservations labels in its own human class",
} as const;

type Row = Record<string, unknown>;

const RETAINED_STEPS = new Set(["worker.assignment", "implement.done", "pr.opened", "review.posted", "risk_judge.decision", VERDICT_OUTCOME_STEP]);
const RETAINED_FIELDS = [
  "ts", "step", "run_id", "head_sha", "head_assignment", "pr_url", "state", "reviewer_outcome",
  "dep_review", "verdict", "availability", "model",
];

const str = (value: unknown): string | undefined => (typeof value === "string" && value.length > 0 ? value : undefined);
const record = (value: unknown): Row | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Row) : undefined;

const answerText = (value: unknown): string => (typeof value === "string" ? value : JSON.stringify(value) ?? "null");

/**
 * W1-T12425: THE ONE TABLE from (role, outcome kind) to a declared option, so a typed answer's
 * outcome is its head's measured post-merge outcome, never the current judge's answer. It starts
 * with the risk role only: the review shadow's answer is a vector of per-criterion verdicts with no
 * single option. A role with no entry keeps a null outcome. Moving the map is a reviewed diff, as
 * `ATTRIBUTION_POLICY` (lib/verdict-calibration.ts) is.
 */
export const TYPED_ANSWER_OUTCOME_MAP: Readonly<Record<string, Readonly<Record<VerdictOutcomeKind, string>>>> = {
  risk: { reverted: "high", followup_fixed: "high", clean: "low" },
};

/** A judged head in a decision key: 7 to 64 hex characters. */
export const HEAD_SHA_RE = /^[0-9a-f]{7,64}$/i;

/**
 * The judged head in a shadow decision key: the risk surface's key is `<task id>:<head>`
 * (cli/commands/run-task-verb.ts) and the review surface's is `<pull request>:<head>:<digest>`
 * (cli/commands/review.ts). Any other role, or a key in neither shape, has no head.
 */
export function headOfDecisionKey(role: string, key: string | undefined): string | null {
  const parts = key?.split(":") ?? [];
  const head = role === "risk" && parts.length === 2 ? parts[1] : role === "review" && parts.length >= 3 ? parts[parts.length - 2] : undefined;
  return head !== undefined && HEAD_SHA_RE.test(head) ? head : null;
}

/** A typed-answer ledger row's head: its own `head_sha`, else its decision key's head. */
const headOfTypedAnswerLine = (line: Row, role: string): string | null =>
  str(line.head_sha) ?? headOfDecisionKey(role, str(line.decision_key));

/** W1-T12414: a paired shadow row as one generative single answer, beside the current judge's.
 *  W1-T12420: a shadow judge generates text, so its answer is on the text surface. */
function shadowTypedAnswer(line: Row): TypedAnswerRow | undefined {
  const role = str(line.surface);
  const model = str(line.shadow_model);
  if (role === undefined || model === undefined || line.shadow_decision === undefined) return undefined;
  const key = str(line.decision_key);
  return {
    role, question: null, model, source: "generative", modelSurface: "text", questionType: null, options: null,
    head: headOfTypedAnswerLine(line, role),
    inputDigest: key === undefined ? null : createHash("sha256").update(key).digest("hex").slice(0, 16),
    answer: { kind: "single", option: answerText(line.shadow_decision) },
    incumbent: line.primary_decision === undefined ? null : answerText(line.primary_decision), outcome: null,
  };
}

export const JUDGE_SHADOW_REFUSED_STEP = "judge_shadow.refused";
/** W1-T13365: the rows runJudgeShadow (lib/risk-judge.ts) writes beside a ci-judge or fix-progress judgement. */
export const JUDGE_SHADOW_ROW_STEPS = ["judge_shadow.paired", JUDGE_SHADOW_REFUSED_STEP, "judge_shadow.unavailable"] as const;
const isJudgeShadowStep = (step: unknown): boolean => (JUDGE_SHADOW_ROW_STEPS as readonly unknown[]).includes(step);
/** W1-T14853: the rows judge-shadow.ts writes for every other shadow arm, cash or decision model, and for a decision
 *  model asked as a judge's primary that gave nothing (`served_as: "primary"`). */
export const JUDGE_SHADOW_ARM_STEPS = ["judge_shadow.compared", "judge_shadow.skipped"] as const;
const isJudgeShadowArmStep = (step: unknown): boolean => (JUDGE_SHADOW_ARM_STEPS as readonly unknown[]).includes(step);
const isTypedAnswerStep = (step: unknown): boolean =>
  step === "shadow_judge.paired" || step === "decision.answered" || step === "judge_replay.answered" || isJudgeShadowStep(step) ||
  isJudgeShadowArmStep(step);

/** W1-T13365: who answered a judge_shadow row and about which input: the surface is the role, the cash deployment
 *  is the model and it answers with text. The head follows the `@` of the decision key (`PR<n>@<head>`). */
export function judgeShadowRowIdentity(line: Row): Pick<TypedAnswerRow, "role" | "model" | "source" | "modelSurface"> & { head: string | null; inputDigest: string | null } | undefined {
  const role = str(line.surface);
  const model = str(line.shadow_deployment);
  if (role === undefined || model === undefined) return undefined;
  const key = str(line.decision_key);
  const head = key?.includes("@") ? key.slice(key.lastIndexOf("@") + 1) : undefined;
  return { role, model, source: "generative", modelSurface: "text", head: head !== undefined && HEAD_SHA_RE.test(head) ? head : null,
    inputDigest: key === undefined ? null : createHash("sha256").update(key).digest("hex").slice(0, 16) };
}

/** W1-T13365: a judge_shadow row as one answer beside the primary verdict, each reduced to its compared key. An
 *  unavailable shadow, or a verdict with no compared key, is a rejected answer; a refused shadow is no answer. */
function judgeShadowTypedAnswer(line: Row): TypedAnswerRow | undefined {
  const who = judgeShadowRowIdentity(line);
  if (who === undefined || line.step === JUDGE_SHADOW_REFUSED_STEP) return undefined;
  const keyOf = Object.hasOwn(JUDGE_SHADOW_COMPARED_KEY, who.role) ? JUDGE_SHADOW_COMPARED_KEY[who.role as keyof typeof JUDGE_SHADOW_COMPARED_KEY] : undefined;
  const option = keyOf?.(line.shadow_verdict);
  const answer: TypedAnswer = line.step === "judge_shadow.unavailable" ? { kind: "rejected", reason: str(line.reason) ?? "unavailable" }
    : option === undefined ? { kind: "rejected", reason: "the shadow verdict has no compared key" } : { kind: "single", option };
  return { ...who, question: null, questionType: null, options: null, answer, incumbent: keyOf?.(line.primary_verdict) ?? null, outcome: null };
}

/** W1-T14853: who answered a judge_shadow.compared or .skipped row: its role, the shadow model (a decision candidate or a
 *  cash deployment), the decisions surface when the row says so and text otherwise, and the head it judged. A row that
 *  names no shadow model (a bake-off deployment that was not ready) has no answerer. */
export function judgeShadowArmIdentity(line: Row): Pick<TypedAnswerRow, "role" | "model" | "source" | "modelSurface"> & { head: string | null; inputDigest: string | null } | undefined {
  const role = str(line.role);
  const model = str(line.shadow_model);
  if (role === undefined || model === undefined) return undefined;
  const decisions = line.model_surface === "decisions";
  const key = str(line.decision_key);
  const keyHead = key?.includes("@") ? key.slice(key.lastIndexOf("@") + 1) : undefined;
  const head = str(line.head_sha) ?? keyHead;
  return { role, model, source: decisions ? "decisions" : "generative", modelSurface: decisions ? "decisions" : "text",
    head: head !== undefined && HEAD_SHA_RE.test(head) ? head : null,
    inputDigest: key === undefined ? null : createHash("sha256").update(key).digest("hex").slice(0, 16) };
}

/** W1-T14853: one decision-model request's key: its role, head, latency and dollars. A decision-arm judge_shadow row
 *  and the live decision.answered row of the same request share it (the shadow row copies both figures from the
 *  request's own row), so every reader can count the request once. Private: it holds the head. */
export const decisionRequestKey = (role: unknown, head: unknown, latency: unknown, dollars: unknown): string =>
  JSON.stringify([role ?? null, head ?? null, latency ?? null, dollars ?? null]);

/** W1-T14853: the request key and side of a row that belongs to a decision-model request, or undefined. A direct
 *  replay's decision.answered row is not live and has none. */
export function decisionRequestOf(line: Row): { key: string; side: "decision" | "shadow" } | undefined {
  if (isJudgeShadowArmStep(line.step) && line.model_surface === "decisions")
    return { key: decisionRequestKey(line.role, line.head_sha, line.latency_ms, line.shadow_cost_usd), side: "shadow" };
  if (line.step === "decision.answered" && typeof line.role === "string" && !line.role.startsWith(JUDGE_REPLAY_DECISION_ROLE_PREFIX))
    return { key: decisionRequestKey(line.role, line.head_sha, line.latency_ms, line.settled_usd), side: "decision" };
  return undefined;
}

/** W1-T14853: drop the decision.answered answers of every request whose judge_shadow row is also present, so a
 *  decision-arm shadow request is one answer in every reader. A request with no judge_shadow row (a decision model
 *  asked as a judge's primary) keeps its decision.answered answers. */
export function withoutShadowedDecisionAnswers(rows: readonly TypedAnswerRow[]): TypedAnswerRow[] {
  const requestOf = (row: TypedAnswerRow) => (row as RequestTaggedAnswer).request;
  const shadowed = new Set(rows.flatMap((row) => (requestOf(row)?.side === "shadow" ? [requestOf(row)!.key] : [])));
  return rows.filter((row) => !(requestOf(row)?.side === "decision" && shadowed.has(requestOf(row)!.key)));
}

/** W1-T14853: a typed answer with the decision-model request it belongs to. The tag is private: no scorer reads it,
 *  and it rides the fold's checkpoint with the answer. */
export type RequestTaggedAnswer = TypedAnswerRow & { request?: { key: string; side: "decision" | "shadow" } };

/** W1-T14853: a budget or capacity refusal made no request, so it is no answer. */
export const isJudgeShadowArmRefusal = (line: Row): boolean =>
  line.step === "judge_shadow.skipped" && (line.refusal === "budget" || line.refusal === "capacity");

/** W1-T14853: a judge_shadow.compared or .skipped row as one answer beside the primary's. A decision model's
 *  distribution is a distribution answer over the declared options exactly as the writer compared them, so the
 *  scorer's agreement is the row's own; a cash shadow's answer is a single one; the primary's answer is the
 *  incumbent. A skipped row is an abstention when it names one, a refusal is no answer, and anything else is a
 *  rejected answer. A compared row that only says whether the reply parsed (`parses`, decision-summary) carries no
 *  option, so it is no answer whether or not it parsed. */
function judgeShadowArmTypedAnswer(line: Row): TypedAnswerRow | undefined {
  const who = judgeShadowArmIdentity(line);
  if (who === undefined || isJudgeShadowArmRefusal(line)) return undefined;
  const decisions = who.modelSurface === "decisions";
  const base = { ...who, question: decisions ? who.role.replace(/-/g, "_") : null, questionType: null, options: null,
    incumbent: str(line.primary_answer) ?? null, outcome: null };
  if (line.step === "judge_shadow.skipped") {
    const reason = str(line.reason) ?? "skipped";
    const abstained = str(line.abstained) ?? (reason.startsWith("abstained") ? reason : undefined);
    if (abstained !== undefined) return { ...base, answer: { kind: "abstained", reason: abstained === "cannot-tell" ? "cannot-tell" : "refusal" } };
    return { ...base, answer: { kind: "rejected", reason } };
  }
  if (Array.isArray(line.distribution)) {
    const entries = line.distribution.filter((entry): entry is Row => record(entry) !== undefined &&
      typeof entry.option === "string" && typeof entry.probability === "number");
    if (entries.length === 0) return { ...base, answer: { kind: "rejected", reason: "the shadow distribution is not readable" } };
    const distribution = entries.map((entry) => ({ option: entry.option as string, probability: entry.probability as number }));
    return { ...base, questionType: "choice", options: distribution.map((entry) => entry.option), answer: { kind: "distribution", distribution } };
  }
  const option = str(line.shadow_answer);
  return option === undefined ? undefined : { ...base, answer: { kind: "single", option } };
}

/** A ledger row's typed answers, or the ones {@link judgeCalibrationRow} already read off it. W1-T14853: each answer of
 *  a decision-model request carries that request's key, so {@link withoutShadowedDecisionAnswers} counts it once. */
function typedAnswersOf(line: Row): TypedAnswerRow[] {
  if (Array.isArray(line.typed_answers)) return line.typed_answers as TypedAnswerRow[];
  const request = decisionRequestOf(line);
  const typed = readTypedAnswersOf(line);
  return request === undefined ? typed : typed.map((row): RequestTaggedAnswer => ({ ...row, request }));
}

function readTypedAnswersOf(line: Row): TypedAnswerRow[] {
  if (Array.isArray(line.typed_answers)) return line.typed_answers as TypedAnswerRow[];
  if (isJudgeShadowStep(line.step)) {
    const answer = judgeShadowTypedAnswer(line);
    return answer ? [answer] : [];
  }
  if (isJudgeShadowArmStep(line.step)) {
    const answer = judgeShadowArmTypedAnswer(line);
    return answer ? [answer] : [];
  }
  // W1-T12421: a direct judge replay's decision request; its answer, with the case's outcome, is in its judge_replay.answered row.
  if (line.step === "decision.answered" && typeof line.role === "string" && line.role.startsWith(JUDGE_REPLAY_DECISION_ROLE_PREFIX)) return [];
  if (line.step !== "shadow_judge.paired") return decisionAnsweredTypedAnswers(line).map((row) => ({ ...row, head: headOfTypedAnswerLine(line, row.role) }));
  const shadow = shadowTypedAnswer(line);
  return shadow ? [shadow] : [];
}

/** The fields this projection reads off one ledger row, or `undefined` for a row it never reads. */
export function judgeCalibrationRow(line: Row): Row | undefined {
  if (isTypedAnswerStep(line.step)) {
    const typed = typedAnswersOf(line);
    return typed.length > 0 ? { step: line.step, typed_answers: typed } : undefined;
  }
  if (typeof line.step !== "string" || !RETAINED_STEPS.has(line.step)) return undefined;
  if (line.step === VERDICT_OUTCOME_STEP) return { step: line.step, head_sha: line.head_sha, outcome: line.outcome };
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

type ReviewHead = { at: number; head: string };

/** One LLM judgment as {@link finishJudgeVerdicts} reads it: a review knows its head; a risk decision
 *  reaches one only when every review of its run has been folded. */
type JudgeCandidate =
  | { kind: "review"; ref: string; judgeModel: string; head?: string; prUrl?: string; pass: boolean }
  | { kind: "risk"; judgeModel: string; pass: boolean; runId?: string; at: number; ts: string; runText: string; prUrl?: string };

/** The joins and judgments {@link finishJudgeVerdicts} reads, kept per assignment, head and judgment rather than per row. */
export interface JudgeVerdictFold {
  models: Map<string, string>;
  headAuthors: Map<string, string>;
  reviewHeadsByRun: Map<string, ReviewHead[]>;
  candidates: JudgeCandidate[];
  excluded: Record<string, number>;
  typedAnswers: TypedAnswerRow[];
  /** W1-T12425: each head's recorded `verdict_calibration.outcome` kinds. */
  outcomes: Map<string, VerdictOutcomeKind[]>;
}

export function emptyJudgeVerdictFold(): JudgeVerdictFold {
  return { models: new Map(), headAuthors: new Map(), reviewHeadsByRun: new Map(), candidates: [], excluded: {}, typedAnswers: [], outcomes: new Map() };
}

export function foldJudgeVerdictRow(fold: JudgeVerdictFold, row: Row): void {
  if (row.step === VERDICT_OUTCOME_STEP) {
    const head = str(row.head_sha);
    if (head === undefined || !isVerdictOutcomeKind(row.outcome)) return;
    const kinds = fold.outcomes.get(head) ?? [];
    if (!kinds.includes(row.outcome)) fold.outcomes.set(head, [...kinds, row.outcome]);
    return;
  }
  if (isTypedAnswerStep(row.step)) {
    fold.typedAnswers.push(...typedAnswersOf(row));
    return;
  }
  const raw = record(row.worker_assignment);
  const id = str(raw?.id);
  const model = str(record(raw?.selected)?.model);
  if (row.step === "worker.assignment" && id && model && !fold.models.has(id)) fold.models.set(id, model);
  const head = str(row.head_sha);
  if ((row.step === "implement.done" || row.step === "pr.opened") && head) {
    const value = str(row.head_assignment) ?? "unrecorded";
    if (!fold.headAuthors.has(head) || (assignmentIdOf(value) && !assignmentIdOf(fold.headAuthors.get(head)))) fold.headAuthors.set(head, value);
  }
  const runId = str(row.run_id);
  if (row.step === "review.posted" && head && runId) fold.reviewHeadsByRun.set(runId, [...(fold.reviewHeadsByRun.get(runId) ?? []), { at: timeOf(row), head }]);
  if (row.step !== "review.posted" && row.step !== "risk_judge.decision") return;
  const kind: JudgeKind = row.step === "review.posted" ? "review" : "risk";
  const judgment = kind === "review" ? reviewJudgment(row) : riskJudgment(row);
  if ("excluded" in judgment) {
    bump(fold.excluded, judgment.excluded);
    return;
  }
  const prUrl = str(row.pr_url);
  fold.candidates.push(kind === "review"
    ? { kind, ref: verdictRef(kind, judgment.model, head, row), judgeModel: judgment.model, ...(head ? { head } : {}), ...(prUrl ? { prUrl } : {}), pass: judgment.pass }
    : { kind, judgeModel: judgment.model, pass: judgment.pass, ...(runId ? { runId } : {}), at: timeOf(row),
      ts: String(row.ts ?? ""), runText: String(row.run_id ?? ""), ...(prUrl ? { prUrl } : {}) });
}

/** -Infinity, an unparseable time, is not JSON: it travels as null. */
const atToJson = (at: number): number | null => (at === -Infinity ? null : at);
const atFromJson = (at: unknown): number => (typeof at === "number" ? at : -Infinity);

/** A fold as JSON: every map as its entries, in insertion order. */
export function judgeVerdictFoldToJson(fold: JudgeVerdictFold): Row {
  return {
    models: [...fold.models],
    headAuthors: [...fold.headAuthors],
    reviewHeadsByRun: [...fold.reviewHeadsByRun].map(([run, heads]) => [run, heads.map((entry) => ({ at: atToJson(entry.at), head: entry.head }))]),
    candidates: fold.candidates.map((candidate) => (candidate.kind === "risk" ? { ...candidate, at: atToJson(candidate.at) } : candidate)),
    excluded: { ...fold.excluded },
    typedAnswers: [...fold.typedAnswers],
    outcomes: [...fold.outcomes],
  };
}

export function judgeVerdictFoldFromJson(json: Row): JudgeVerdictFold {
  const entries = <V>(value: unknown): Array<[string, V]> => (Array.isArray(value) ? value as Array<[string, V]> : []);
  return {
    models: new Map(entries<string>(json.models)),
    headAuthors: new Map(entries<string>(json.headAuthors)),
    reviewHeadsByRun: new Map(entries<Array<{ at: unknown; head: string }>>(json.reviewHeadsByRun)
      .map(([run, heads]) => [run, heads.map((entry) => ({ at: atFromJson(entry.at), head: entry.head }))])),
    candidates: (Array.isArray(json.candidates) ? json.candidates as JudgeCandidate[] : [])
      .map((candidate) => (candidate.kind === "risk" ? { ...candidate, at: atFromJson(candidate.at) } : candidate)),
    excluded: { ...(record(json.excluded) as Record<string, number> | undefined) },
    typedAnswers: Array.isArray(json.typedAnswers) ? json.typedAnswers as TypedAnswerRow[] : [],
    outcomes: new Map(entries<VerdictOutcomeKind[]>(json.outcomes)),
  };
}

/** Every LLM judge verdict in `rows`, joined to its author model. A row that is not an LLM
 *  judgment is counted under `excluded`; a verdict whose author cannot be joined is KEPT under the
 *  `unattributed` author stratum and its reason counted — never dropped. */
export function extractJudgeVerdicts(rows: ReadonlyArray<Row>): {
  verdicts: JudgeVerdict[];
  excluded: Record<string, number>;
  authorUnattributed: Record<string, number>;
} {
  const fold = emptyJudgeVerdictFold();
  for (const row of rows) foldJudgeVerdictRow(fold, row);
  return finishJudgeVerdicts(fold);
}

export function finishJudgeVerdicts(fold: JudgeVerdictFold): {
  verdicts: JudgeVerdict[];
  excluded: Record<string, number>;
  authorUnattributed: Record<string, number>;
} {
  const { models, headAuthors, reviewHeadsByRun } = fold;
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
  const headOfRisk = (runId: string | undefined, at: number): string | undefined => {
    let best: ReviewHead | undefined;
    for (const entry of reviewHeadsByRun.get(runId ?? "") ?? []) if (entry.at <= at && (best === undefined || entry.at >= best.at)) best = entry;
    return best?.head;
  };

  const verdicts: JudgeVerdict[] = [];
  const seen = new Set<string>();
  for (const candidate of fold.candidates) {
    const head = candidate.kind === "review" ? candidate.head : headOfRisk(candidate.runId, candidate.at);
    const ref = candidate.kind === "review" ? candidate.ref : verdictRef("risk", candidate.judgeModel, head, { ts: candidate.ts, run_id: candidate.runText });
    if (seen.has(ref)) continue;
    seen.add(ref);
    verdicts.push({
      ref, kind: candidate.kind, judgeModel: candidate.judgeModel, authorModel: authorOf(head),
      headSha: head ?? null, prUrl: candidate.prUrl ?? null, pass: candidate.pass,
    });
  }
  return { verdicts, excluded: { ...fold.excluded }, authorUnattributed };
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
      const labels: unknown = record(JSON.parse(readFileSync(path, "utf8")))?.labels;
      if (Array.isArray(labels) && labels.every(isJudgeLabel)) return labels;
      throw new Error(`${JUDGE_LABELS_FILENAME}: not a judge label file`);
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

/** Whether a posted label's verdict is in the labelling queue the last analytics refresh drew.
 *  `sample-unavailable` when no refresh has drawn one yet: unknown, never "out". */
export type JudgeLabelSampleMembership = "in-sample" | "out-of-sample" | "sample-unavailable";

export const JUDGE_LABEL_RECORDED_STEP = "panel.judge_label_recorded";

function validateJudgeLabelBody(body: unknown): { error: string } | { verdictRef: string; label: "pass" | "fail"; labeller: string } {
  if (!isRecord(body)) return { error: "body must be a JSON object" };
  if (typeof body.verdictRef !== "string" || !JUDGE_VERDICT_REF_RE.test(body.verdictRef)) return { error: "verdictRef must be a jv- verdict reference" };
  if (body.label !== "pass" && body.label !== "fail") return { error: "label must be pass or fail" };
  if (typeof body.labeller !== "string" || !body.labeller.trim()) return { error: "labeller is required" };
  return { verdictRef: body.verdictRef, label: body.label, labeller: body.labeller.trim() };
}

/**
 * POST /v1/judge-labels (W1-T4634) — the write half of the labelling queue, mirroring
 * operator-notes.ts's `buildAddOperatorNoteRoute`. `labelledAt` comes from `clock`, never the body.
 * The bearer's hashed identity is ledgered as `origin` beside the human `labeller`. A verdict
 * outside `currentSample()` is still stored (the draw moves as verdicts arrive) but flagged.
 * Tier LOW: a label is advisory evidence, superseded by a later label, and gates nothing.
 */
export function buildRecordJudgeLabelRoute(
  store: JudgeLabelStore,
  ledgerPath: string,
  currentSample: () => ReadonlyArray<{ verdictRef: string }> | undefined,
  clock: Clock = systemClock,
): Route {
  return {
    method: "POST",
    path: "/v1/judge-labels",
    scope: "write",
    tier: "low",
    handler: jsonAction(validateJudgeLabelBody, (input, req, res) => {
      let stored: JudgeLabel;
      try {
        stored = recordJudgeLabel(store, input, clock);
      } catch {
        const reason = "write_failed";
        sendJson(res, 500, { error: reason });
        return;
      }
      const sample = currentSample();
      const sampleMembership: JudgeLabelSampleMembership = sample === undefined ? "sample-unavailable"
        : sample.some((item) => item.verdictRef === stored.verdictRef) ? "in-sample" : "out-of-sample";
      appendPanelLedger(ledgerPath, JUDGE_LABEL_RECORDED_STEP, stored.verdictRef, bearerTokenId(req), {
        label: stored.label,
        labeller: stored.labeller,
        sample_membership: sampleMembership,
      });
      sendJson(res, 200, { ok: true, ...stored, sampleMembership });
    }),
  };
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

/** One class-conditional rate against the human label, or `unknown` with the reason. */
export type JudgeRate =
  | { state: "estimated"; rate: number; lower: number; upper: number; count: number }
  | { state: "unknown"; reason: string; count: number };

/** Kappa can read healthy while the rare human-fail class goes unseen, and a review judge's costly
 *  error is passing work a human fails — so each class gets its own rate and its own floor. */
export function judgeTruePositiveTrueNegative(
  pairs: ReadonlyArray<{ judge: boolean; human: boolean }>,
  minPaired: number = MIN_PAIRED_OBSERVATIONS,
): { truePositive: JudgeRate; trueNegative: JudgeRate } {
  const rateFor = (humanPass: boolean): JudgeRate => {
    const members = pairs.filter((p) => p.human === humanPass);
    const count = members.length;
    const name = humanPass ? "human-pass" : "human-fail";
    if (count < minPaired) return { state: "unknown", reason: count === 0 ? `no-${name}-labels` : `too-few-${name}-labels (${count} of ${minPaired})`, count };
    const rate = members.filter((p) => p.judge === humanPass).length / count;
    const z2 = JUDGE_INTERVAL_Z ** 2;
    const centre = (rate + z2 / (2 * count)) / (1 + z2 / count);
    const half = (JUDGE_INTERVAL_Z * Math.sqrt(rate * (1 - rate) / count + z2 / (4 * count ** 2))) / (1 + z2 / count);
    return { state: "estimated", rate, lower: clamp01(centre - half), upper: clamp01(centre + half), count };
  };
  return { truePositive: rateFor(true), trueNegative: rateFor(false) };
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
  humanRates: { truePositive: JudgeRate; trueNegative: JudgeRate };
  corrected: JudgeEstimate;
}

/** One judge across its author strata. */
export interface JudgeSummary {
  judge: { kind: JudgeKind; model: string };
  verdicts: number;
  rawPassRate: number;
  labelled: number;
  humanAgreement: JudgeAgreement;
  humanRates: { truePositive: JudgeRate; trueNegative: JudgeRate };
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
  /** W1-T12414: shadow and decision-model answers, per role and model (lib/typed-answer-scores.ts). */
  typedAnswerScores: TypedAnswerScores;
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
    typedAnswerScores: scoreTypedAnswers([]),
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
    humanRates: labelsUnavailable !== undefined
      ? { truePositive: { state: "unknown" as const, reason: labelsUnavailable, count: 0 }, trueNegative: { state: "unknown" as const, reason: labelsUnavailable, count: 0 } }
      : judgeTruePositiveTrueNegative(pairs, minPaired),
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
  const fold = emptyJudgeVerdictFold();
  for (const row of rows) foldJudgeVerdictRow(fold, row);
  return finishJudgeCalibration(fold, options);
}

/**
 * W1-T12425: each typed answer with its head's outcome through {@link TYPED_ANSWER_OUTCOME_MAP}.
 * The worst recorded kind wins (reverted, then followup_fixed, then clean). An answer with no head,
 * a head with no outcome row, or a role with no map entry keeps a null outcome.
 */
export function typedAnswersWithOutcomes(fold: Pick<JudgeVerdictFold, "typedAnswers" | "outcomes">): TypedAnswerRow[] {
  return withoutShadowedDecisionAnswers(fold.typedAnswers).map((row) => {
    const map = TYPED_ANSWER_OUTCOME_MAP[row.role];
    const kinds = row.head ? fold.outcomes.get(row.head) : undefined;
    const kind = kinds === undefined ? undefined : VERDICT_OUTCOME_KINDS.find((k) => kinds.includes(k));
    if (map === undefined || kind === undefined) return { ...row, outcome: null };
    const option = map[kind];
    // A decision row keys an option by its type and text when two options share their text.
    const options = row.options ?? [];
    const declared = !options.includes(option) && options.includes(`string:${option}`) ? `string:${option}` : option;
    return { ...row, outcome: declared };
  });
}

export function finishJudgeCalibration(fold: JudgeVerdictFold, options: JudgeCalibrationOptions): JudgeCalibration {
  const method = methodOf(options);
  const { verdicts, excluded, authorUnattributed } = finishJudgeVerdicts(fold);
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
  const typedAnswerScores = scoreTypedAnswers(typedAnswersWithOutcomes(fold));
  if (verdicts.length === 0) {
    return { ...unavailableJudgeCalibration("no-judge-verdicts-observed", options.asOf), method, labels, excluded, authorUnattributed, typedAnswerScores };
  }

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
      humanRates: cell.humanRates,
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
    typedAnswerScores,
  };
}
