import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import type { Clock } from "./clock.js";
import { loadConfig, type Config } from "./config.js";
import { DEFAULT_CASH_KEY_ENV } from "./config-schema.js";
import { unknownArgError } from "./cli-args.js";
import { appendProducerLedger } from "./ledger.js";
import { ledgerPathFor } from "./ledger-path.js";
import { loadMounts, mountsPath, type DecisionCandidate, type DecisionModelShape } from "./mounts.js";
import { TYPED_JUDGMENT_SUM_TOLERANCE } from "./typed-judgment.js";
import { sendCashRequest, type OpenWeightPrice } from "./worker-provider.js";

/**
 * W1-T12416: a decision model answers many fixed-option questions about ONE input in one paid
 * cash request. The question set is provider-neutral; each request shape maps it to its own body
 * and reads the reply back into the same answer form. Shadow only: `rmd decisions probe` is the one
 * caller, and no gate, route or judge reads the answers.
 *
 * An answer is a distribution over the declared options, an abstention, or a rejection with a
 * reason. An out-of-set or badly summed answer is rejected, never coerced, as in typed-judgment.ts.
 */

export const DECISION_ANSWERED_STEP = "decision.answered";
/** The pseudo sender that writes {@link DECISION_ANSWERED_STEP} (src/lib/producer-identity.ts). */
export const DECISION_SENDER = "DECISIONS";
/** PRIMARY CONTROL: the OpenAI-shape limit, checked before any reservation; the Microsoft shape states none. */
export const DECISION_MAX_QUESTIONS = 400;
export const DECISION_CHOICE_OPTIONS = { min: 2, max: 255 } as const;
export const DECISION_SCORE_LEVELS = { min: 2, max: 10 } as const;
/** A decision reply carries no text. The observed output counts were 0 and 3 tokens. */
export const DECISION_OUTPUT_MARGIN_TOKENS = 64;
/** The option the Microsoft shape adds to each choice, because that shape has no refusal type. */
export const CANNOT_TELL_OPTION = "cannot_tell";

const QUESTION_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const SHAPE_PATHS: Record<DecisionModelShape, string> = {
  "openai-decisions": "openai/v1/decisions",
  "microsoft-systemone": "providers/microsoft/v1/systemone",
};

export type DecisionOptionValue = string | boolean;
export type DecisionQuestion =
  | { type: "yes-no"; name: string; instructions: string }
  | { type: "choice"; name: string; instructions: string; options: Array<{ value: DecisionOptionValue; description?: string }> }
  | { type: "score"; name: string; instructions: string; levels: Array<{ label: string; description?: string }> };

export type DecisionAnswer =
  | { name: string; outcome: "distribution"; distribution: Array<{ option: DecisionOptionValue; probability: number }>;
    confidence: number | null; cannotTell?: number; score?: number }
  | { name: string; outcome: "abstained"; reason: "refusal" | "cannot-tell" }
  | { name: string; outcome: "rejected"; reason: string };

/** The one `decision.answered` row a request writes, whatever happened to it. */
export interface DecisionAnsweredRow {
  role: string;
  input_digest: string;
  candidate: string;
  deployment: string;
  shape: DecisionModelShape;
  outcome: "answered" | "refused" | "unavailable" | "failed";
  reason?: string;
  detail?: string;
  status?: number;
  served_model: string | null;
  latency_ms: number | null;
  reserved_usd: number;
  settled_usd: number;
  held_usd: number;
  usage: { input_tokens: number; output_tokens: number; cached_tokens?: number } | null;
  question_count: number;
  answers: DecisionAnswer[];
}

type Checked<T> = { ok: true; value: T } | { ok: false; reason: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";
const optionKey = (value: DecisionOptionValue): string => `${typeof value}:${String(value)}`;

/** Criterion 1: the question set is checked before any reservation; a bad set sends nothing. */
export function checkDecisionQuestions(raw: unknown, shape: DecisionModelShape): Checked<DecisionQuestion[]> {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > DECISION_MAX_QUESTIONS)
    return { ok: false, reason: `a question set has 1 to ${DECISION_MAX_QUESTIONS} questions` };
  const names = new Set<string>();
  const questions: DecisionQuestion[] = [];
  for (const [index, item] of raw.entries()) {
    const at = `question ${index + 1}`;
    if (!isRecord(item)) return { ok: false, reason: `${at} is not an object` };
    const { type, name, instructions } = item;
    if (typeof name !== "string" || !QUESTION_NAME.test(name)) return { ok: false, reason: `${at} needs a lower-case name` };
    if (names.has(name)) return { ok: false, reason: `the name ${name} is used twice` };
    names.add(name);
    if (!nonEmpty(instructions)) return { ok: false, reason: `${name} has no instructions` };
    if (type === "yes-no") questions.push({ type, name, instructions });
    else if (type === "choice") {
      const options = item.options;
      if (!Array.isArray(options) || options.length < DECISION_CHOICE_OPTIONS.min || options.length > DECISION_CHOICE_OPTIONS.max)
        return { ok: false, reason: `${name} needs ${DECISION_CHOICE_OPTIONS.min} to ${DECISION_CHOICE_OPTIONS.max} options` };
      const seen = new Set<string>();
      const text = new Set<string>();
      const parsed: Array<{ value: DecisionOptionValue; description?: string }> = [];
      for (const option of options) {
        if (!isRecord(option) || !(nonEmpty(option.value) || typeof option.value === "boolean"))
          return { ok: false, reason: `${name} has an option that is not a string or a boolean` };
        if (option.description !== undefined && typeof option.description !== "string")
          return { ok: false, reason: `${name} has an option whose description is not text` };
        if (seen.has(optionKey(option.value))) return { ok: false, reason: `${name} has the option ${String(option.value)} twice` };
        seen.add(optionKey(option.value));
        // The Microsoft shape keys its options by text and adds its own cannot-tell option.
        if (shape === "microsoft-systemone" && (text.has(String(option.value)) || String(option.value) === CANNOT_TELL_OPTION))
          return { ok: false, reason: `${name} has options that are the same as text, or ${CANNOT_TELL_OPTION}` };
        text.add(String(option.value));
        parsed.push({ value: option.value, ...(option.description === undefined ? {} : { description: option.description }) });
      }
      questions.push({ type, name, instructions, options: parsed });
    } else if (type === "score") {
      const levels = item.levels;
      if (!Array.isArray(levels) || levels.length < DECISION_SCORE_LEVELS.min || levels.length > DECISION_SCORE_LEVELS.max)
        return { ok: false, reason: `${name} needs ${DECISION_SCORE_LEVELS.min} to ${DECISION_SCORE_LEVELS.max} levels` };
      const seen = new Set<string>();
      const parsed: Array<{ label: string; description?: string }> = [];
      for (const level of levels) {
        if (!isRecord(level) || !nonEmpty(level.label)) return { ok: false, reason: `${name} has a level with no label` };
        if (level.description !== undefined && typeof level.description !== "string")
          return { ok: false, reason: `${name} has a level whose description is not text` };
        if (seen.has(level.label)) return { ok: false, reason: `${name} has the level ${level.label} twice` };
        seen.add(level.label);
        parsed.push({ label: level.label, ...(level.description === undefined ? {} : { description: level.description }) });
      }
      questions.push({ type, name, instructions, levels: parsed });
    } else return { ok: false, reason: `${name} has the type ${String(type)}, not yes-no, choice or score` };
  }
  return { ok: true, value: questions };
}

/** The request body for one input and one checked question set, in the candidate's shape. */
export function decisionRequestBody(shape: DecisionModelShape, deployment: string, input: string, questions: DecisionQuestion[]): unknown {
  const described = <T extends { description?: string }>(item: T) => (item.description === undefined ? {} : { description: item.description });
  if (shape === "openai-decisions") {
    return { model: deployment, input, questions: questions.map((q) =>
      q.type === "yes-no" ? { type: "predicate", name: q.name, instructions: q.instructions }
      : q.type === "choice" ? { type: "choice", name: q.name, instructions: q.instructions,
        choices: q.options.map((o) => ({ value: o.value, ...described(o) })) }
      : { type: "score", name: q.name, instructions: q.instructions, levels: q.levels.map((l) => ({ label: l.label, ...described(l) })) }) };
  }
  return { model: deployment, state: input, questions: Object.fromEntries(questions.map((q) => [q.name,
    q.type === "yes-no" ? { type: "noul", instructions: q.instructions }
    : q.type === "choice" ? { type: "choice", instructions: q.instructions, criteria: {
      ...Object.fromEntries(q.options.map((o) => [String(o.value), o.description ?? String(o.value)])),
      [CANNOT_TELL_OPTION]: "The input does not say enough to choose any other option." } }
    : { type: "score", instructions: q.instructions, criteria: q.levels.map((l) => l.label) }])) };
}

const probability = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
const summed = (values: number[]): boolean => Math.abs(values.reduce((a, b) => a + b, 0) - 1) <= TYPED_JUDGMENT_SUM_TOLERANCE;

type Mass = Array<{ option: DecisionOptionValue; probability: number }>;

/** Read each declared option's mass exactly once; anything out of set, missing or twice is a reason. */
function declaredMass(name: string, declared: DecisionOptionValue[], entries: Array<[unknown, unknown]>, match: (raw: unknown) => DecisionOptionValue | undefined): Checked<Mass> {
  const found = new Map<string, number>();
  for (const [raw, mass] of entries) {
    const option = match(raw);
    if (option === undefined) return { ok: false, reason: `${name} answered the option ${JSON.stringify(raw)}, which was not declared` };
    if (found.has(optionKey(option))) return { ok: false, reason: `${name} answered the option ${String(option)} twice` };
    if (!probability(mass)) return { ok: false, reason: `${name} gave ${String(option)} a mass that is not a probability` };
    found.set(optionKey(option), mass);
  }
  const missing = declared.filter((option) => !found.has(optionKey(option)));
  if (missing.length > 0) return { ok: false, reason: `${name} gave no mass to ${missing.map(String).join(", ")}` };
  return { ok: true, value: declared.map((option) => ({ option, probability: found.get(optionKey(option))! })) };
}

function confidenceOf(name: string, raw: Record<string, unknown>): Checked<number | null> {
  if (raw.confidence === undefined) return { ok: true, value: null };
  return probability(raw.confidence) ? { ok: true, value: raw.confidence } : { ok: false, reason: `${name} has a confidence that is not a probability` };
}

function finished(question: DecisionQuestion, mass: Checked<Mass>, raw: Record<string, unknown>, extra: { cannotTell?: number } = {}): DecisionAnswer {
  if (!mass.ok) return { name: question.name, outcome: "rejected", reason: mass.reason };
  const all = mass.value.map((m) => m.probability);
  if (!summed(all)) return { name: question.name, outcome: "rejected", reason: `${question.name} summed to ${all.reduce((a, b) => a + b, 0).toFixed(3)}, not 1` };
  const confidence = confidenceOf(question.name, raw);
  if (!confidence.ok) return { name: question.name, outcome: "rejected", reason: confidence.reason };
  if (raw.score !== undefined && (typeof raw.score !== "number" || !Number.isFinite(raw.score)))
    return { name: question.name, outcome: "rejected", reason: `${question.name} has a score that is not a number` };
  return { name: question.name, outcome: "distribution", distribution: mass.value, confidence: confidence.value, ...extra,
    ...(typeof raw.score === "number" ? { score: raw.score } : {}) };
}

const yesNo = (p: number): Mass => [{ option: true, probability: p }, { option: false, probability: 1 - p }];
const rejected = (name: string, reason: string): DecisionAnswer => ({ name, outcome: "rejected", reason });

/** Criterion 2: answers come back as an array in question order. */
function readOpenAiAnswer(question: DecisionQuestion, raw: unknown): DecisionAnswer {
  if (!isRecord(raw)) return rejected(question.name, `${question.name} has no answer object`);
  if (raw.name !== undefined && raw.name !== null && raw.name !== question.name)
    return rejected(question.name, `the answer for ${question.name} is named ${String(raw.name)}`);
  if (raw.type === "refusal") return { name: question.name, outcome: "abstained", reason: "refusal" };
  if (question.type === "yes-no") {
    if (raw.type !== "predicate") return rejected(question.name, `${question.name} was answered as ${String(raw.type)}`);
    return probability(raw.probability) ? finished(question, { ok: true, value: yesNo(raw.probability) }, raw)
      : rejected(question.name, `${question.name} has a probability out of range`);
  }
  if (raw.type !== question.type || !Array.isArray(raw.probabilities)) return rejected(question.name, `${question.name} was answered as ${String(raw.type)}`);
  const rows = raw.probabilities.map((row) => (isRecord(row) ? row : {}));
  if (question.type === "choice") {
    const declared = question.options.map((o) => o.value);
    const pick = declared.find((value) => value === raw.choice);
    if (pick === undefined) return rejected(question.name, `${question.name} chose ${JSON.stringify(raw.choice)}, which was not declared`);
    return finished(question, declaredMass(question.name, declared, rows.map((row) => [row.value, row.probability]),
      (value) => declared.find((option) => option === value)), raw);
  }
  const labels = question.levels.map((l) => l.label);
  if (rows.some((row) => !Number.isInteger(row.value))) return rejected(question.name, `${question.name} has a level with no whole-number value`);
  return finished(question, declaredMass(question.name, labels, rows.map((row) => [row.label, row.probability]),
    (label) => labels.find((l) => l === label)), raw);
}

/** Criterion 3: answers come back keyed by name; a cannot-tell choice is an abstention. */
function readMicrosoftAnswer(question: DecisionQuestion, raw: unknown): DecisionAnswer {
  if (!isRecord(raw)) return rejected(question.name, `the reply has no answer named ${question.name}`);
  const expected = question.type === "yes-no" ? "noul" : question.type;
  if (raw.type !== expected) return rejected(question.name, `${question.name} was answered as ${String(raw.type)}`);
  if (question.type === "yes-no") {
    return probability(raw.noul) ? finished(question, { ok: true, value: yesNo(raw.noul) }, raw)
      : rejected(question.name, `${question.name} has a noul value out of range`);
  }
  if (!isRecord(raw.probabilities)) return rejected(question.name, `${question.name} has no probability map`);
  if (question.type === "choice") {
    if (raw.choice === CANNOT_TELL_OPTION) return { name: question.name, outcome: "abstained", reason: "cannot-tell" };
    const declared = question.options.map((o) => o.value);
    const byText = (text: unknown) => declared.find((option) => String(option) === text);
    if (byText(raw.choice) === undefined) return rejected(question.name, `${question.name} chose ${JSON.stringify(raw.choice)}, which was not declared`);
    const { [CANNOT_TELL_OPTION]: cannotTell, ...rest } = raw.probabilities;
    if (!probability(cannotTell)) return rejected(question.name, `${question.name} gave no mass to ${CANNOT_TELL_OPTION}`);
    return finished(question, declaredMass(question.name, declared, Object.entries(rest), byText), raw, { cannotTell });
  }
  const labels = question.levels.map((l) => l.label);
  const legend = isRecord(raw.legend) ? raw.legend : {};
  if (Object.keys(legend).length !== labels.length || labels.some((label, index) => legend[String(index)] !== label))
    return rejected(question.name, `${question.name} has a legend that does not match its levels`);
  return finished(question, declaredMass(question.name, labels, Object.entries(raw.probabilities),
    (index) => (typeof index === "string" && Object.hasOwn(legend, index) ? labels.find((l) => l === legend[index]) : undefined)), raw);
}

/** Read every question's answer from one reply; a reply with no answers rejects every question. */
export function readDecisionAnswers(shape: DecisionModelShape, questions: DecisionQuestion[], envelope: unknown): DecisionAnswer[] {
  const answers = isRecord(envelope) ? envelope.answers : undefined;
  if (shape === "openai-decisions") {
    if (!Array.isArray(answers) || answers.length !== questions.length)
      return questions.map((q) => rejected(q.name, `the reply has ${Array.isArray(answers) ? answers.length : "no"} answers for ${questions.length} questions`));
    return questions.map((q, index) => readOpenAiAnswer(q, answers[index]));
  }
  if (!isRecord(answers)) return questions.map((q) => rejected(q.name, "the reply has no answers object"));
  return questions.map((q) => readMicrosoftAnswer(q, answers[q.name]));
}

const tokenCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function replyUsage(envelope: unknown): DecisionAnsweredRow["usage"] {
  const usage = isRecord(envelope) && isRecord(envelope.usage) ? envelope.usage : undefined;
  if (!usage || !tokenCount(usage.input_tokens) || !tokenCount(usage.output_tokens)) return null;
  const cached = isRecord(usage.input_tokens_details) ? usage.input_tokens_details.cached_tokens : undefined;
  return { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens, ...(tokenCount(cached) ? { cached_tokens: cached } : {}) };
}

/** Dollars from the reply's usage at the candidate's own row. Cached input is charged at the full
 *  input rate, an upper bound, because the row names no cache rate. */
export function decisionUsageUsd(envelope: unknown, price: DecisionCandidate["price"]): number | undefined {
  const usage = replyUsage(envelope);
  return usage ? (usage.input_tokens * price.inputUsdPerMillion + usage.output_tokens * price.outputUsdPerMillion) / 1_000_000 : undefined;
}

export type DecisionTarget = { ok: true; endpoint: string; key: string } | { ok: false; reason: "no-entry" | "no-endpoint" | "no-key"; detail: string };

/** Criteria 5 and 9: only today's config keys, and never the worker's entry for the same deployment. */
export function resolveDecisionTarget(config: Pick<Config, "workerProviders">, candidate: DecisionCandidate, env: NodeJS.ProcessEnv): DecisionTarget {
  let endpoint: string | undefined;
  let keyEnv: string;
  if (candidate.endpoint.source === "cash-default") {
    endpoint = config.workerProviders?.cashEndpoint ?? config.workerProviders?.openweightEndpoint;
    keyEnv = DEFAULT_CASH_KEY_ENV;
  } else {
    const entry = config.workerProviders?.cashDeploymentEndpoints?.[candidate.endpoint.entry];
    if (!entry) return { ok: false, reason: "no-entry", detail: `no cashDeploymentEndpoints entry named ${candidate.endpoint.entry}` };
    endpoint = entry.endpoint;
    keyEnv = entry.keyEnv;
  }
  if (!nonEmpty(endpoint)) return { ok: false, reason: "no-endpoint", detail: "no cash endpoint is configured" };
  const key = env[keyEnv];
  if (!key) return { ok: false, reason: "no-key", detail: `${keyEnv} is not set` };
  return { ok: true, endpoint, key };
}

/**
 * Ask one candidate one question set about one input, in one budgeted request, and write one
 * `decision.answered` row. A refusal, an unavailable candidate or a failed request is a row with
 * its reason, never a throw.
 */
export async function askDecisionModel(config: Config, request: {
  role: string; candidate: DecisionCandidate; input: unknown; questions: unknown; env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch; clock?: Pick<Clock, "now" | "iso">; requestTimeoutMs?: number; signal?: AbortSignal;
}): Promise<DecisionAnsweredRow> {
  const { candidate } = request;
  const input = typeof request.input === "string" ? request.input : "";
  const row: DecisionAnsweredRow = {
    role: request.role, input_digest: createHash("sha256").update(input).digest("hex"), candidate: candidate.name,
    deployment: candidate.deployment, shape: candidate.shape, outcome: "refused", served_model: null, latency_ms: null,
    reserved_usd: 0, settled_usd: 0, held_usd: 0, usage: null,
    question_count: Array.isArray(request.questions) ? request.questions.length : 0, answers: [],
  };
  const finish = (patch: Partial<DecisionAnsweredRow>): DecisionAnsweredRow => {
    Object.assign(row, patch);
    appendProducerLedger(ledgerPathFor(config), DECISION_SENDER, { run_id: `decision-${randomUUID()}`, step: DECISION_ANSWERED_STEP, ...row });
    return row;
  };
  if (!nonEmpty(request.input)) return finish({ reason: "invalid-input", detail: "the input is empty or not text" });
  const checked = checkDecisionQuestions(request.questions, candidate.shape);
  if (!checked.ok) return finish({ reason: "invalid-questions", detail: checked.reason });
  const target = resolveDecisionTarget(config, candidate, request.env ?? process.env);
  if (!target.ok) return finish({ outcome: "unavailable", reason: target.reason, detail: target.detail });
  const price: OpenWeightPrice = { inputUsdPerMillion: candidate.price.inputUsdPerMillion,
    outputUsdPerMillion: candidate.price.outputUsdPerMillion, readAt: candidate.price.readAt };
  const sent = await sendCashRequest(config, {
    deployment: candidate.deployment, path: SHAPE_PATHS[candidate.shape], source: "decision-model",
    body: JSON.stringify(decisionRequestBody(candidate.shape, candidate.deployment, input, checked.value)),
    outputTokenCeiling: DECISION_OUTPUT_MARGIN_TOKENS, target: { endpoint: target.endpoint, key: target.key }, price,
    usageUsd: (envelope) => decisionUsageUsd(envelope, candidate.price),
    ...(request.fetchImpl ? { fetchImpl: request.fetchImpl } : {}), ...(request.clock ? { clock: request.clock } : {}),
    ...(request.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: request.requestTimeoutMs }),
    ...(request.signal ? { signal: request.signal } : {}),
  });
  Object.assign(row, { latency_ms: sent.latencyMs, reserved_usd: sent.reservedUsd, settled_usd: sent.settledUsd, held_usd: sent.heldUsd });
  if (!sent.ok) return finish({ outcome: "failed", reason: sent.reason, detail: sent.detail,
    ...(sent.status === undefined ? {} : { status: sent.status }) });
  return finish({ outcome: "answered", served_model: sent.servedModel ?? null, usage: replyUsage(sent.envelope),
    answers: readDecisionAnswers(candidate.shape, checked.value, sent.envelope) });
}

const PROBE_USAGE = "usage: rmd decisions probe --candidate <name> --input-file <file> --questions-file <file> [--role <role>]";

/**
 * Criterion 8: `rmd decisions probe` sends one question set about one input to one named candidate
 * and prints the row it wrote. Exit 0 answered, 1 refused, unavailable or failed, 2 bad usage.
 */
export async function decisionsCommand(
  rest: string[],
  ask: (config: Config, request: Parameters<typeof askDecisionModel>[1]) => Promise<DecisionAnsweredRow>,
  host: { repoRoot: string; config?: () => Config; out?: (line: string) => void; err?: (line: string) => void },
): Promise<number> {
  const out = host.out ?? ((line: string) => process.stdout.write(`${line}\n`));
  const log = host.err ?? ((line: string) => process.stderr.write(`${line}\n`));
  const flags = rest.slice(1);
  const bad = rest[0] === "probe" ? unknownArgError("decisions probe", flags, ["--candidate", "--input-file", "--questions-file", "--role"]) : `rmd decisions: unknown subcommand ${JSON.stringify(rest[0] ?? "")}`;
  const flag = (name: string): string | undefined => {
    const at = flags.indexOf(name);
    return at >= 0 && nonEmpty(flags[at + 1]) && !flags[at + 1]!.startsWith("--") ? flags[at + 1] : undefined;
  };
  const [name, inputFile, questionsFile] = [flag("--candidate"), flag("--input-file"), flag("--questions-file")];
  if (bad || !name || !inputFile || !questionsFile) {
    log(`${bad ?? "rmd decisions probe: --candidate, --input-file and --questions-file are required"}\n${PROBE_USAGE}`);
    return 2;
  }
  const candidate = loadMounts(mountsPath(host.repoRoot)).decision_models?.[name];
  if (!candidate) {
    log(`rmd decisions probe: the mounts table has no decision_models row named ${name}`);
    return 2;
  }
  let input: string;
  let questions: unknown;
  try {
    input = readFileSync(inputFile, "utf8");
    questions = JSON.parse(readFileSync(questionsFile, "utf8"));
  } catch (error) {
    log(`rmd decisions probe: could not read the input or the questions (${error instanceof Error ? error.message : String(error)})`);
    return 2;
  }
  const row = await ask((host.config ?? loadConfig)(), { role: flag("--role") ?? "probe", candidate, input, questions });
  out(JSON.stringify(row));
  return row.outcome === "answered" ? 0 : 1;
}
