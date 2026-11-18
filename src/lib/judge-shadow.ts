import { loadConfig, type Config } from "./config.js";
import { askDecisionModel, DECISION_MODEL_SURFACE, DECISION_OUTPUT_MARGIN_TOKENS, resolveDecisionTarget, type DecisionAnsweredRow } from "./decision-model.js";
import type { CashShadowArm, DecisionShadowArm, JudgeMount, JudgeShadowArm, JudgeThreshold, Mounts } from "./mounts.js";
import { JUDGE_SHADOW_TRIAL_ID, type spawnWorker, type SpawnWorkerArgs, type WorkerResult } from "./worker.js";
import { cashCapacityReadiness, learnedCashLimit, OpenWeightAllowanceExhaustedError, OpenWeightRequestTooLargeError, type ModelSurface } from "./worker-provider.js";

/**
 * lib/judge-shadow.ts — a cash model answers the same judgement beside a judge, in shadow.
 *
 * W1-T11075: the ci judge and the fix-progress judge ask the cash deployment their mount row pins
 * ({@link runJudgeShadow}; rows `judge_shadow.paired`, `.refused`, `.unavailable`).
 * W1-T12187: the risk judge and the decision summary ask the first ready model of the cash row of their
 * own tier ({@link shadowJudgeCall}; rows `judge_shadow.compared`, `.skipped`), and
 * {@link judgeShadowSummary} reads both families for the config gardener.
 * W1-T12417: a role's shadow may name a decision model (`shadow: <decision_models row>`); the role's fixed options go
 * to it as one choice question ({@link JUDGE_SHADOW_QUESTIONS}), and every fixed-option judge of
 * {@link FIXED_OPTION_JUDGE_ROLES} calls the same shadow.
 * Every shadow is advisory: the caller acts on the primary's answer only.
 */

/** The judges a cash shadow may sit beside. */
export type JudgeShadowSurface = "ci-judge" | "fix-progress" | JudgeShadowRole;
/** W1-T12187: the roles {@link shadowJudgeCall} shadows; W1-T12417 adds every fixed-option judge. */
export type JudgeShadowRole = "risk-judge" | "decision-summary" | FixedOptionJudgeRole;

/** W1-T12417: the fixed-option judges, in the order they gained the shadow. Each writes its rows under its own name. */
export const FIXED_OPTION_JUDGE_ROLES = [
  "risk-judge", "ci-judge", "fix-progress", "verify-human", "refresh-value", "quiet-worker-watchdog", "head-rehome", "typed-judgment",
] as const;
export type FixedOptionJudgeRole = (typeof FIXED_OPTION_JUDGE_ROLES)[number];

/** W1-T12187's two roles: with no shadow named, each asks the first ready model of the cash row. Every other role
 *  is shadowed only when its row names a candidate. */
const CASH_ROW_SHADOW_ROLES: ReadonlySet<string> = new Set(["risk-judge", "decision-summary"]);

/** W1-T12417: one judge's options as one decision question. */
export interface JudgeShadowQuestion {
  instructions: string;
  options: readonly string[];
}

const ANSWER_THE_INPUT = "The input is a judge's own prompt. Choose the option that answers the question it asks.";

/** W1-T12417: the fixed options of each judge whose options do not come with the call. A typed-judgment spawn, and
 *  head-rehome through it, passes its own question and options. */
export const JUDGE_SHADOW_QUESTIONS: Readonly<Record<Exclude<FixedOptionJudgeRole, "head-rehome" | "typed-judgment">, JudgeShadowQuestion>> = {
  "risk-judge": { options: ["low", "high"],
    instructions: `${ANSWER_THE_INPUT} low lets the candidate change proceed; high escalates it to a person.` },
  "ci-judge": { options: ["escalate_full", "add_suites", "no_change"],
    instructions: `${ANSWER_THE_INPUT} escalate_full runs the full CI; add_suites adds named suites; no_change keeps the planned suites.` },
  "fix-progress": { options: ["continue", "change-approach", "escalate", "harness"],
    instructions: `${ANSWER_THE_INPUT} It decides whether another fix round is justified.` },
  "verify-human": { options: ["needs_operator", "automate", "backlog"],
    instructions: `${ANSWER_THE_INPUT} It decides whether a verify-human task needs a person, can be automated, or waits in the backlog.` },
  "refresh-value": { options: ["overlap", "independent"],
    instructions: `${ANSWER_THE_INPUT} overlap means main's changes could change the pull request's verdict.` },
  "quiet-worker-watchdog": { options: ["nudge", "kill_poll_child", "end_round", "wait"],
    instructions: `${ANSWER_THE_INPUT} It picks one remedy for a worker that has been quiet past its bound.` },
};

/** W1-T12417: the answer a ci-judge verdict gives to {@link JUDGE_SHADOW_QUESTIONS}'s ci-judge question. */
export function ciJudgeDecisionAnswer(verdict: unknown): string | undefined {
  const read = verdict as { add?: unknown; escalateFull?: unknown } | null | undefined;
  const add = read === null || read === undefined ? undefined : read.add;
  if (Array.isArray(add) && typeof read!.escalateFull === "boolean") return read!.escalateFull ? "escalate_full" : add.length > 0 ? "add_suites" : "no_change";
  return undefined;
}

/** W1-T12417: the shadow of a judge with no row of its own: its `judge_shadows` entry, or, for a typed-judgment spawn,
 *  the `typed-judgment` entry. */
export function judgeShadowOnlyArm(mounts: Pick<Mounts, "judge_shadows">, role: "refresh-value" | "quiet-worker-watchdog" | "head-rehome" | "typed-judgment"): JudgeShadowArm | undefined {
  const shadows = mounts.judge_shadows;
  return shadows?.[role] ?? (role === "head-rehome" ? shadows?.["typed-judgment"] : undefined);
}

/** W1-T12417: a tuned threshold applies only to the model id and the model surface it was stored with. */
export function thresholdFor(threshold: JudgeThreshold | undefined, model: string, surface: ModelSurface): number | undefined {
  return threshold !== undefined && threshold.model === model && threshold.surface === surface ? threshold.value : undefined;
}

/** What one shadow call came to. `refused` is a capacity or budget refusal; nothing is acted on in any case. */
export type JudgeShadowOutcome =
  | { kind: "paired"; agreement: boolean }
  | { kind: "refused"; refusal: "capacity" | "budget"; reason: string }
  | { kind: "unavailable"; reason: string }
  | { kind: "skipped" }
  /** W1-T12417: the arm is a decision model; its row is written after the caller goes on. */
  | { kind: "deferred" };

type ShadowLog = (step: string, fields: Record<string, unknown>) => void;

export interface JudgeShadowRequest<T> {
  surface: JudgeShadowSurface;
  /** The judgement's identity (a PR and head), so primary and shadow rows join. */
  key: string;
  mount: JudgeMount;
  /** The primary judge's spawn args; the shadow sends the same prompt to its own deployment. */
  primaryArgs: SpawnWorkerArgs;
  /** The verdict the caller acts on. `undefined` when the primary gave none. */
  primaryVerdict: T | undefined;
  parse: (text: string) => T | undefined;
  /** Two verdicts agree when these keys are equal. */
  agreementKey: (verdict: T) => string;
  spawn: typeof spawnWorker;
  log: ShadowLog;
}

/** W1-T12417: the judged head of a `PR<n>@<head>` key. */
function headOfKey(key: string): { sha?: string } {
  const head = key.includes("@") ? key.slice(key.lastIndexOf("@") + 1) : "";
  return /^[0-9a-f]{7,64}$/i.test(head) ? { sha: head } : {};
}

/** The shadow's spawn args: the primary's prompt, no tools, the cash provider. A declared arm pins its deployment;
 *  with none, the worker takes the first ready model of the cash row of the mount's tier, at low effort. The call
 *  reserves against the NORMAL figure of the daily cash cap: `cashSqueezed` is never set. */
function judgeShadowSpawnArgs(primary: SpawnWorkerArgs, mount: JudgeMount, surface: JudgeShadowSurface, arm: CashShadowArm | undefined): SpawnWorkerArgs {
  return {
    ...primary, tools: [], mountProvider: "cash", effort: arm === undefined ? "low" : arm.effort ?? "default", cashSqueezed: false,
    routingTrial: { id: JUDGE_SHADOW_TRIAL_ID, arm: "cash", reason: `${surface} shadow of ${mount.model}`,
      ...(arm === undefined ? {} : { models: [arm.deployment] }) },
  };
}

function shadowRefusal(error: unknown): { refusal: "capacity" | "budget"; reason: string } | undefined {
  if (error instanceof OpenWeightAllowanceExhaustedError) return { refusal: "budget", reason: error.message };
  if (error instanceof OpenWeightRequestTooLargeError) return { refusal: "capacity", reason: error.message };
  return undefined;
}

type ShadowSpend = { cost_usd: number | null; served_model: string | null };
/** One shadow request before it is ledgered. `unparseable` is a reply that arrived and did not parse. */
type ShadowAsk<T> =
  | { kind: "answered"; verdict: T; agreement: boolean; primaryKey: string | null; shadowKey: string; spend: ShadowSpend }
  | { kind: "refused"; refusal: "capacity" | "budget"; reason: string; spend?: ShadowSpend }
  | { kind: "unavailable"; reason: string; unparseable: boolean; spend?: ShadowSpend };

/** Send the shadow request ONCE. It never throws: a refusal, a failure and an unusable reply are each a result. */
async function askShadow<T>(request: Pick<JudgeShadowRequest<T>, "spawn" | "parse" | "agreementKey" | "primaryVerdict">, args: SpawnWorkerArgs): Promise<ShadowAsk<T>> {
  try {
    const result = await request.spawn(args);
    const spend = { cost_usd: result.costUsd ?? null, served_model: result.routedModel ?? null };
    if (result.budgetRefused === true) {
      return { kind: "refused", refusal: "budget", reason: `cash allowance refused (${result.cashAllowanceLimit ?? "fleet"})`, spend };
    }
    if (result.openWeightCapacityShortfall !== undefined) {
      const shortfall = result.openWeightCapacityShortfall;
      return { kind: "refused", refusal: "capacity", spend,
        reason: `${shortfall.deployment} needs ${shortfall.estimatedTokens} tokens; its limit is ${shortfall.limitTokens}` };
    }
    const failed = result.isError || (result.subtype !== undefined && result.subtype !== "success");
    const verdict = failed ? undefined : request.parse(result.text);
    if (verdict === undefined) {
      return { kind: "unavailable", unparseable: !failed, spend,
        reason: result.isError ? `shadow call failed (${result.subtype ?? "error"})` : "unparseable shadow verdict" };
    }
    const primaryKey = request.primaryVerdict === undefined ? null : request.agreementKey(request.primaryVerdict);
    const shadowKey = request.agreementKey(verdict);
    return { kind: "answered", verdict, agreement: primaryKey === shadowKey, primaryKey, shadowKey, spend };
  } catch (error) {
    const refusal = shadowRefusal(error);
    if (refusal) return { kind: "refused", ...refusal };
    return { kind: "unavailable", unparseable: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/** A ledger write that cannot affect the judgement being shadowed. */
function shadowRecorder(log: ShadowLog, common: Record<string, unknown>): ShadowLog {
  return (step, fields) => {
    try {
      log(step, { ...common, ...fields });
    } catch (error) {
      // A failed observation must never affect the judgement being shadowed.
      process.stderr.write(`judge shadow ledger unavailable: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  };
}

/** ADVISORY ONLY: ask the row's cash shadow arm the same judgement and ledger both verdicts and whether they agree.
 *  It never throws and returns nothing the caller acts on; a refusal for capacity or budget is ledgered and changes
 *  nothing. A row with no shadow arm spends nothing. */
export async function runJudgeShadow<T>(request: JudgeShadowRequest<T>): Promise<JudgeShadowOutcome> {
  const arm = request.mount.shadow;
  if (arm === undefined) return { kind: "skipped" };
  if (arm.provider === "decisions") {
    // W1-T12417: not awaited, so the caller never waits on the decision model.
    void shadowJudgeCall({ role: request.surface as FixedOptionJudgeRole, key: request.key, mount: request.mount, primaryArgs: request.primaryArgs,
      primary: {}, primaryAnswer: request.primaryVerdict, parse: request.parse, agreementKey: request.agreementKey,
      decisionAnswer: request.surface === "ci-judge" ? ciJudgeDecisionAnswer : request.agreementKey,
      head: headOfKey(request.key), spawn: request.spawn, log: request.log });
    return { kind: "deferred" };
  }
  const args = judgeShadowSpawnArgs(request.primaryArgs, request.mount, request.surface, arm);
  const record = shadowRecorder(request.log, {
    surface: request.surface, decision_key: request.key,
    primary_model: request.mount.model, primary_provider: request.mount.provider ?? null,
    primary_verdict: request.primaryVerdict ?? null,
    shadow_deployment: arm.deployment, shadow_effort: args.effort,
  });
  const ask = await askShadow(request, args);
  if (ask.kind === "refused") {
    record("judge_shadow.refused", { ...ask.spend, refusal: ask.refusal, reason: ask.reason });
    return { kind: "refused", refusal: ask.refusal, reason: ask.reason };
  }
  if (ask.kind === "unavailable") {
    record("judge_shadow.unavailable", { ...ask.spend, reason: ask.reason });
    return { kind: "unavailable", reason: ask.reason };
  }
  record("judge_shadow.paired", { ...ask.spend, shadow_verdict: ask.verdict, agreement: ask.agreement });
  return { kind: "paired", agreement: ask.agreement };
}

// ── W1-T12187: the risk judge and the decision summary ──────────────────────────────────────

export interface ShadowJudgeCall<T> {
  role: JudgeShadowRole;
  /** The judgement's identity, so the rows of one judgement join. */
  key: string;
  /** The role's current mount. A role that already runs on cash is not shadowed. */
  mount: JudgeMount;
  /** The primary's spawn args; the shadow sends the same prompt. */
  primaryArgs: SpawnWorkerArgs;
  /** The primary's result: its cost and the model that served it go on the row. */
  primary: Partial<Pick<WorkerResult, "costUsd" | "servedModel" | "routedModel">>;
  /** The answer the caller already holds. `undefined` when the primary gave none. */
  primaryAnswer: T | undefined;
  /** The role's own parser. */
  parse: (text: string) => T | undefined;
  /** Two answers agree when these keys are equal. Absent, the row records whether the reply parses and no agreement. */
  agreementKey?: (answer: T) => string;
  spawn: typeof spawnWorker;
  log: ShadowLog;
  /** W1-T12417, a decision-model shadow: the role's options, when the call brings its own (a typed-judgment spawn). */
  question?: JudgeShadowQuestion;
  /** The decision model's one input; absent, the primary's prompt. */
  input?: string;
  /** The primary's answer as one of the options; absent, {@link ShadowJudgeCall.agreementKey}. */
  decisionAnswer?: (answer: T) => string | undefined;
  /** The judged head and, where there is one, the pull request; both go on the `decision.answered` row. */
  head?: { sha?: string; prUrl?: string };
  /** The decision-model shadow's seams, beside `spawn` and `log`: production reads the host config and asks the
   *  real decision model. */
  decisions?: { config?: () => Config; ask?: typeof askDecisionModel; env?: NodeJS.ProcessEnv; learnedLimit?: typeof learnedCashLimit };
}

/** ADVISORY ONLY: after the role answered, send the same prompt once to the first ready model of the cash row at low
 *  effort, and write one row: `judge_shadow.compared` for a reply, `judge_shadow.skipped` with the reason for a
 *  refusal or a failure. It starts on a later turn of the event loop, so a caller that does not await it holds its
 *  own answer before any shadow request is made. It never throws. */
export async function shadowJudgeCall<T>(call: ShadowJudgeCall<T>): Promise<void> {
  const arm = call.mount.shadow;
  if (arm?.provider === "decisions") return decisionShadow(call, arm);
  if (call.mount.provider === "cash" || (arm === undefined && !CASH_ROW_SHADOW_ROLES.has(call.role))) return;
  await new Promise<void>((resolve) => setImmediate(resolve));
  const args = judgeShadowSpawnArgs(call.primaryArgs, call.mount, call.role, arm);
  const record = shadowRecorder(call.log, {
    role: call.role, decision_key: call.key,
    primary_model: call.primary.servedModel ?? call.primary.routedModel ?? call.mount.model,
    primary_provider: call.mount.provider ?? null, primary_cost_usd: call.primary.costUsd ?? null, shadow_effort: args.effort,
  });
  const keyed = call.agreementKey;
  const ask = await askShadow<T>({ spawn: call.spawn, parse: call.parse, primaryVerdict: call.primaryAnswer, agreementKey: keyed ?? (() => "") }, args);
  const shadow = { shadow_model: ask.spend?.served_model ?? null, shadow_cost_usd: ask.spend?.cost_usd ?? null };
  if (ask.kind === "answered") {
    record("judge_shadow.compared", { ...shadow,
      ...(keyed === undefined ? { parses: true } : { primary_answer: ask.primaryKey, shadow_answer: ask.shadowKey, agreement: ask.agreement }) });
  } else if (ask.kind === "unavailable" && ask.unparseable && keyed === undefined) {
    record("judge_shadow.compared", { ...shadow, parses: false, reason: ask.reason });
  } else {
    record("judge_shadow.skipped", { ...shadow, reason: ask.reason, ...(ask.kind === "refused" ? { refusal: ask.refusal } : {}) });
  }
}

/** A request's input estimate in tokens: a byte is at most one token, plus the reply margin. */
const decisionNeedTokens = (input: string): number => Buffer.byteLength(input, "utf8") + DECISION_OUTPUT_MARGIN_TOKENS;

/** W1-T12417, ADVISORY ONLY: ask the arm's decision model the role's options as one choice question, once, after the
 *  caller holds its answer, and write one judge_shadow row. A decision with a known head records it. An unavailable,
 *  refused, failed, rejected or abstaining candidate writes `judge_shadow.skipped` with its reason. A shadow whose
 *  learned per-minute limit cannot hold the request sends nothing. It never throws. */
async function decisionShadow<T>(call: ShadowJudgeCall<T>, arm: DecisionShadowArm): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  const record = shadowRecorder(call.log, {
    role: call.role, decision_key: call.key,
    primary_model: call.primary.servedModel ?? call.primary.routedModel ?? call.mount.model,
    primary_provider: call.mount.provider ?? null, primary_cost_usd: call.primary.costUsd ?? null,
    shadow_model: arm.candidate.name, shadow_deployment: arm.deployment, model_surface: DECISION_MODEL_SURFACE,
    ...(call.head?.sha ? { head_sha: call.head.sha } : {}),
  });
  const question = call.question ?? (Object.hasOwn(JUDGE_SHADOW_QUESTIONS, call.role) ? JUDGE_SHADOW_QUESTIONS[call.role as keyof typeof JUDGE_SHADOW_QUESTIONS] : undefined);
  if (question === undefined) {
    record("judge_shadow.skipped", { shadow_cost_usd: 0, reason: "the role declares no fixed options" });
    return;
  }
  const answerOf = call.decisionAnswer ?? call.agreementKey;
  const primaryAnswer = call.primaryAnswer === undefined || answerOf === undefined ? null : answerOf(call.primaryAnswer) ?? null;
  try {
    const deps = call.decisions ?? {};
    const config = (deps.config ?? loadConfig)();
    const env = deps.env ?? process.env;
    const input = call.input ?? call.primaryArgs.prompt;
    const target = resolveDecisionTarget(config, arm.candidate, env);
    if (target.ok) {
      const readiness = cashCapacityReadiness((deps.learnedLimit ?? learnedCashLimit)(arm.deployment, target.endpoint), decisionNeedTokens(input));
      if (readiness.state === "shortfall") {
        record("judge_shadow.skipped", { shadow_cost_usd: 0, refusal: "capacity",
          reason: `${arm.deployment} has learned a limit of ${readiness.limitTokens} tokens per minute; the request needs ${readiness.shortfallTokens} more` });
        return;
      }
    }
    const row = await (deps.ask ?? askDecisionModel)(config, {
      role: call.role, candidate: arm.candidate, input, env,
      questions: [{ type: "choice", name: call.role.replace(/-/g, "_"), instructions: question.instructions, options: question.options.map((value) => ({ value })) }],
      ...(call.head?.sha ? { headSha: call.head.sha, ...(call.head.prUrl ? { prUrl: call.head.prUrl } : {}) } : {}),
    });
    record(...decisionShadowRow(row, primaryAnswer, thresholdFor(call.mount.threshold, arm.deployment, DECISION_MODEL_SURFACE)));
  } catch (error) {
    record("judge_shadow.skipped", { shadow_cost_usd: 0, reason: error instanceof Error ? error.message : String(error) });
  }
}

/** One decision request's judge_shadow row: `compared` for a distribution, else `skipped` with its reason. A 429
 *  is the candidate being unavailable; a budget refusal is a refusal. Below a threshold stored for this model id and
 *  surface, the top option is an abstention. */
function decisionShadowRow(row: DecisionAnsweredRow, primaryAnswer: string | null, threshold: number | undefined): [string, Record<string, unknown>] {
  const spend = { shadow_cost_usd: row.settled_usd, latency_ms: row.latency_ms };
  if (row.outcome !== "answered") {
    const detail = row.detail === undefined ? "" : `: ${row.detail}`;
    if (row.reason === "budget-refused") return ["judge_shadow.skipped", { ...spend, refusal: "budget", reason: `budget refused${detail}` }];
    if (row.status === 429) return ["judge_shadow.skipped", { ...spend, reason: `unavailable: rate limited (429)${detail}` }];
    return ["judge_shadow.skipped", { ...spend, reason: `${row.outcome}: ${row.reason ?? "no reason"}${detail}` }];
  }
  const answer = row.answers[0];
  if (answer === undefined) return ["judge_shadow.skipped", { ...spend, reason: "rejected: the reply has no answer" }];
  if (answer.outcome === "abstained") return ["judge_shadow.skipped", { ...spend, abstained: answer.reason, reason: `abstained (${answer.reason})` }];
  if (answer.outcome === "rejected") return ["judge_shadow.skipped", { ...spend, reason: `rejected: ${answer.reason}` }];
  const distribution = answer.distribution.map((entry) => ({ option: String(entry.option), probability: entry.probability }));
  const top = distribution.reduce((best, entry) => (entry.probability > best.probability ? entry : best));
  const tuned = threshold === undefined ? {} : { threshold };
  if (threshold !== undefined && top.probability < threshold) {
    return ["judge_shadow.skipped", { ...spend, ...tuned, distribution, abstained: "below-threshold",
      reason: `abstained (the top option ${top.option} has ${top.probability.toFixed(3)}, below the threshold ${threshold})` }];
  }
  return ["judge_shadow.compared", { ...spend, ...tuned, distribution, primary_answer: primaryAnswer, shadow_answer: top.option,
    agreement: primaryAnswer === top.option, ...(answer.cannotTell === undefined ? {} : { cannot_tell: answer.cannotTell }) }];
}

/** Every step {@link judgeShadowSummary} reads: this task's two and the three of W1-T11075. */
export const JUDGE_SHADOW_STEPS: readonly string[] = [
  "judge_shadow.compared", "judge_shadow.skipped", "judge_shadow.paired", "judge_shadow.refused", "judge_shadow.unavailable",
];

/** One role's shadow record. A share is `null` when nothing was counted under it. */
export interface JudgeShadowRoleSummary {
  role: string;
  /** Shadow calls that gave a usable answer beside the primary's. */
  paired: number;
  /** Of the paired calls that record agreement, the share that agree. `null` for a role that records none. */
  agreeShare: number | null;
  /** Of the shadow requests made, the share that failed or gave no usable answer. A cap refusal made no request. */
  noAnswerShare: number | null;
  /** Shadow calls the cash cap or a capacity limit refused before any request. */
  refused: number;
  primaryMedianCostUsd: number | null;
  shadowMedianCostUsd: number | null;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** The shadow record of each role in `rows`, from `sinceMs` on when it is given. A refused, failed or unusable
 *  shadow call is never counted as paired or as agreement. */
export function judgeShadowSummary(rows: ReadonlyArray<Record<string, unknown>>, sinceMs?: number): JudgeShadowRoleSummary[] {
  const byRole = new Map<string, { paired: number; judged: number; agreed: number; noAnswer: number; refused: number; primary: number[]; shadow: number[] }>();
  for (const row of rows) {
    const role = row.role ?? row.surface;
    if (typeof row.step !== "string" || !JUDGE_SHADOW_STEPS.includes(row.step) || typeof role !== "string") continue;
    if (sinceMs !== undefined && !(Date.parse(String(row.ts)) >= sinceMs)) continue;
    const tally = byRole.get(role) ?? { paired: 0, judged: 0, agreed: 0, noAnswer: 0, refused: 0, primary: [], shadow: [] };
    byRole.set(role, tally);
    const shadowCost = row.shadow_cost_usd ?? row.cost_usd;
    if (typeof shadowCost === "number") tally.shadow.push(shadowCost);
    if (typeof row.primary_cost_usd === "number") tally.primary.push(row.primary_cost_usd);
    if (row.step === "judge_shadow.refused" || row.refusal !== undefined) tally.refused += 1;
    else if (row.step === "judge_shadow.skipped" || row.step === "judge_shadow.unavailable" || row.parses === false) tally.noAnswer += 1;
    else {
      tally.paired += 1;
      if (typeof row.agreement === "boolean") {
        tally.judged += 1;
        if (row.agreement) tally.agreed += 1;
      }
    }
  }
  return [...byRole].sort(([a], [b]) => a.localeCompare(b)).map(([role, t]) => ({
    role, paired: t.paired,
    agreeShare: t.judged === 0 ? null : t.agreed / t.judged,
    noAnswerShare: t.paired + t.noAnswer === 0 ? null : t.noAnswer / (t.paired + t.noAnswer),
    refused: t.refused,
    primaryMedianCostUsd: median(t.primary), shadowMedianCostUsd: median(t.shadow),
  }));
}

