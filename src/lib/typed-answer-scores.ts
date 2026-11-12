import { CANNOT_TELL_OPTION, DECISION_ANSWERED_STEP, DECISION_SCORE_LEVELS } from "./decision-model.js";
import { scoreSelfForecasts, type ReliabilityBin } from "./self-forecast.js";
import { TYPED_JUDGMENT_SUM_TOLERANCE } from "./typed-judgment.js";

/**
 * W1-T12414: recorded typed answers are scored per role and per model. A recorded answer comes
 * from a decision model (`decision.answered`, a distribution per question) or from a generative
 * judge (`shadow_judge.paired`, one answer). The scorer gives, for each group, the counts, the
 * agreement with the current judge, the abstention and rejection shares, and, where an outcome is
 * known, a multi-class Brier score, a log-loss and calibration buckets.
 *
 * THE OUTPUT IS STABLE ({@link TYPED_ANSWER_SCORES_VERSION}). Readers: the judge calibration body
 * (lib/judge-calibration.ts) now; the shadow summary and the config gardener later.
 * - A group is one (role, question, model, source). `source` is "decisions" or "generative", so the
 *   same model id answering decision questions never pools with it generating text. Two models in
 *   one role are two groups. A model with no rows has no group.
 * - `agreement` compares the top option of a distribution, or the single answer, with the current
 *   judge's answer. Only answers with a current judge's answer are compared.
 * - `brier`, `logLoss` and `buckets` use only distributions with a known outcome. The current
 *   judge's answer is never used as an outcome. A single answer gets no Brier or log-loss figure.
 * - An abstention (a native refusal, or a declared cannot-tell option as the answer) is its own
 *   outcome. It counts toward `abstained` and is never compared or scored.
 * - A rejection (a malformed answer) counts toward `rejected` and is never compared or scored.
 * A RECORD, NEVER A DECISION INPUT: no gate, route or threshold reads these figures yet.
 */

export const TYPED_ANSWER_SCORES_VERSION = "typed-answer-scores-v1" as const;

/** The floor a log-loss clamps the outcome's probability to, so a confident miss stays finite. */
export const LOG_LOSS_FLOOR = 1e-6;

export const TYPED_ANSWER_SCORES_METHOD = {
  agreement: "share of compared answers whose top option (or single answer) equals the current judge's answer",
  brier: "mean over scored distributions of sum over declared options of (p - 1[option = outcome])^2",
  logLoss: `mean over scored distributions of -ln(max(p_outcome, ${LOG_LOSS_FLOOR}))`,
  buckets: "the bin shape of scoreSelfForecasts on the top option's probability; observed rate is the share whose top option is the outcome",
} as const;

export type TypedAnswerSource = "decisions" | "generative";
export type TypedQuestionType = "yes-no" | "choice" | "score";

export type TypedAnswer =
  | { kind: "distribution"; distribution: Array<{ option: string; probability: number }> }
  | { kind: "single"; option: string }
  | { kind: "abstained"; reason: "refusal" | "cannot-tell" }
  | { kind: "rejected"; reason: string };

/** One recorded answer to one question about one input. */
export interface TypedAnswerRow {
  role: string;
  /** The question name inside a decision request; null for a judge with one question. */
  question: string | null;
  model: string;
  source: TypedAnswerSource;
  questionType: TypedQuestionType | null;
  /** The declared options in order (a score question's levels in order); null when not recorded. */
  options: string[] | null;
  /** A declared option that means the model cannot tell. */
  abstainOption?: string;
  inputDigest: string | null;
  answer: TypedAnswer;
  /** The current judge's answer for the same input, or null. */
  incumbent: string | null;
  /** The known outcome, or null. Never the current judge's answer. */
  outcome: string | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const probability = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
const rejected = (reason: string): TypedAnswer => ({ kind: "rejected", reason });

/**
 * Criterion 1: the four kinds. A distribution must give every declared option one probability and
 * nothing else, and sum to 1 within TYPED_JUDGMENT_SUM_TOLERANCE; otherwise it is a rejection,
 * never coerced. A single answer outside the declared options is a rejection too. A declared
 * cannot-tell option as the answer is an abstention.
 */
export function checkTypedAnswer(row: Pick<TypedAnswerRow, "answer" | "options" | "questionType" | "abstainOption">): TypedAnswer {
  const { answer, options } = row;
  if (row.questionType === "score" && (options === null || options.length < DECISION_SCORE_LEVELS.min || options.length > DECISION_SCORE_LEVELS.max))
    return rejected(`a score question has ${DECISION_SCORE_LEVELS.min} to ${DECISION_SCORE_LEVELS.max} levels`);
  if (options !== null && new Set(options).size !== options.length) return rejected("the declared options repeat");
  if (answer.kind === "abstained" || answer.kind === "rejected") return answer;
  if (answer.kind === "single") {
    if (options !== null && !options.includes(answer.option)) return rejected(`the answer ${answer.option} was not declared`);
    return answer.option === row.abstainOption ? { kind: "abstained", reason: "cannot-tell" } : answer;
  }
  if (options === null) return rejected("a distribution needs its declared options");
  const seen = new Map<string, number>();
  for (const entry of answer.distribution) {
    if (!options.includes(entry.option)) return rejected(`the option ${entry.option} was not declared`);
    if (seen.has(entry.option)) return rejected(`the option ${entry.option} has two probabilities`);
    if (!probability(entry.probability)) return rejected(`the option ${entry.option} has a mass that is not a probability`);
    seen.set(entry.option, entry.probability);
  }
  const missing = options.filter((option) => !seen.has(option));
  if (missing.length > 0) return rejected(`no mass for ${missing.join(", ")}`);
  const sum = [...seen.values()].reduce((a, b) => a + b, 0);
  if (Math.abs(sum - 1) > TYPED_JUDGMENT_SUM_TOLERANCE) return rejected(`the distribution sums to ${sum.toFixed(3)}, not 1`);
  const distribution = options.map((option) => ({ option, probability: seen.get(option)! }));
  return topOf(distribution).option === row.abstainOption ? { kind: "abstained", reason: "cannot-tell" } : { kind: "distribution", distribution };
}

/** The first declared option with the most mass. */
const topOf = (distribution: Array<{ option: string; probability: number }>): { option: string; probability: number } =>
  distribution.reduce((best, entry) => (entry.probability > best.probability ? entry : best));

/** The rows of one `decision.answered` ledger row: one per question, model = the candidate's name. */
export function decisionAnsweredTypedAnswers(line: Record<string, unknown>): TypedAnswerRow[] {
  if (line.step !== DECISION_ANSWERED_STEP || line.outcome !== "answered" || !Array.isArray(line.answers)) return [];
  const role = typeof line.role === "string" && line.role ? line.role : undefined;
  const model = typeof line.candidate === "string" && line.candidate ? line.candidate : undefined;
  if (role === undefined || model === undefined) return [];
  const inputDigest = typeof line.input_digest === "string" ? line.input_digest : null;
  return line.answers.filter(isRecord).map((raw): TypedAnswerRow => {
    const base = { role, question: typeof raw.name === "string" ? raw.name : null, model, source: "decisions" as const,
      inputDigest, incumbent: null, outcome: null };
    if (raw.outcome === "abstained")
      return { ...base, questionType: null, options: null, answer: { kind: "abstained", reason: raw.reason === "cannot-tell" ? "cannot-tell" : "refusal" } };
    if (raw.outcome !== "distribution" || !Array.isArray(raw.distribution))
      return { ...base, questionType: null, options: null, answer: rejected(typeof raw.reason === "string" ? raw.reason : "the answer is not readable") };
    const entries = raw.distribution.filter(isRecord);
    const distribution = entries.map((entry) => ({ option: String(entry.option), probability: entry.probability as number }));
    const cannotTell = typeof raw.cannotTell === "number" ? raw.cannotTell : undefined;
    const questionType: TypedQuestionType = entries.every((entry) => typeof entry.option === "boolean") ? "yes-no"
      : raw.score !== undefined ? "score" : "choice";
    return { ...base, questionType, options: [...distribution.map((entry) => entry.option), ...(cannotTell === undefined ? [] : [CANNOT_TELL_OPTION])],
      ...(cannotTell === undefined ? {} : { abstainOption: CANNOT_TELL_OPTION }),
      answer: { kind: "distribution", distribution: [...distribution, ...(cannotTell === undefined ? [] : [{ option: CANNOT_TELL_OPTION, probability: cannotTell }])] } };
  });
}

export interface TypedAnswerScoreGroup {
  role: string;
  question: string | null;
  model: string;
  source: TypedAnswerSource;
  answers: number;
  distributions: number;
  singles: number;
  abstained: number;
  rejected: number;
  abstentionRate: number;
  rejectionRate: number;
  agreement: { compared: number; agreed: number; rate: number | null };
  outcomes: { scored: number; unknown: number; notDeclared: number };
  brier: number | null;
  logLoss: number | null;
  buckets: ReliabilityBin[];
}

export interface TypedAnswerScores {
  version: typeof TYPED_ANSWER_SCORES_VERSION;
  method: typeof TYPED_ANSWER_SCORES_METHOD & { logLossFloor: number; sumTolerance: number; bins: number };
  groups: TypedAnswerScoreGroup[];
}

const mean = (values: readonly number[]): number | null =>
  values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : null;

/**
 * THE SCORER. Every row is checked again ({@link checkTypedAnswer}), so a row read back from a
 * checkpoint is held to the same rules. Groups are sorted by their key.
 */
export function scoreTypedAnswers(rows: readonly TypedAnswerRow[], opts: { bins?: number } = {}): TypedAnswerScores {
  const bins = opts.bins ?? 10;
  if (!Number.isInteger(bins) || bins < 1) throw new RangeError("scoreTypedAnswers: bins must be a positive integer");
  const byGroup = new Map<string, Array<TypedAnswerRow & { checked: TypedAnswer }>>();
  for (const row of rows) {
    const key = JSON.stringify([row.role, row.question, row.model, row.source]);
    byGroup.set(key, [...(byGroup.get(key) ?? []), { ...row, checked: checkTypedAnswer(row) }]);
  }
  const groups = [...byGroup.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, members]): TypedAnswerScoreGroup => {
    const count = (kind: TypedAnswer["kind"]): number => members.filter((m) => m.checked.kind === kind).length;
    const answered = members.flatMap((m): Array<{ m: typeof m; top: string }> => m.checked.kind === "distribution"
      ? [{ m, top: topOf(m.checked.distribution).option }] : m.checked.kind === "single" ? [{ m, top: m.checked.option }] : []);
    const compared = answered.filter(({ m }) => m.incumbent !== null);
    const agreed = compared.filter(({ m, top }) => top === m.incumbent).length;
    const distributions = members.flatMap((m) => (m.checked.kind === "distribution" ? [{ m, distribution: m.checked.distribution }] : []));
    const notDeclared = distributions.filter(({ m }) => m.outcome !== null && !m.options!.includes(m.outcome)).length;
    const scored = distributions.filter(({ m }) => m.outcome !== null && m.options!.includes(m.outcome));
    const brier = mean(scored.map(({ m, distribution }) =>
      distribution.reduce((sum, { option, probability: p }) => sum + (p - (option === m.outcome ? 1 : 0)) ** 2, 0)));
    const logLoss = mean(scored.map(({ m, distribution }) =>
      -Math.log(Math.max(distribution.find(({ option }) => option === m.outcome)!.probability, LOG_LOSS_FLOOR))));
    const buckets = distributions.length === 0 ? [] : scoreSelfForecasts(distributions.map(({ m, distribution }) => {
      const top = topOf(distribution);
      const known = m.outcome !== null && m.options!.includes(m.outcome);
      return { model: m.model, taskClass: m.role, forecast: { state: "present" as const, p: top.probability },
        verifiedOutcome: known ? (top.option === m.outcome ? 1 as const : 0 as const) : null };
    }), { bins }).groups[0]!.reliability;
    const first = members[0]!;
    return {
      role: first.role, question: first.question, model: first.model, source: first.source,
      answers: members.length, distributions: distributions.length, singles: count("single"),
      abstained: count("abstained"), rejected: count("rejected"),
      abstentionRate: count("abstained") / members.length, rejectionRate: count("rejected") / members.length,
      agreement: { compared: compared.length, agreed, rate: compared.length === 0 ? null : agreed / compared.length },
      outcomes: { scored: scored.length, unknown: distributions.filter(({ m }) => m.outcome === null).length, notDeclared },
      brier, logLoss, buckets,
    };
  });
  return {
    version: TYPED_ANSWER_SCORES_VERSION,
    method: { ...TYPED_ANSWER_SCORES_METHOD, logLossFloor: LOG_LOSS_FLOOR, sumTolerance: TYPED_JUDGMENT_SUM_TOLERANCE, bins },
    groups,
  };
}
