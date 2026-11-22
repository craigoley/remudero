import { createHash } from "node:crypto";
import { join } from "node:path";
import { loadConfig, type Config } from "./config.js";
import { askDecisionModel, DECISION_MODEL_SURFACE, DECISION_OUTPUT_MARGIN_TOKENS, resolveDecisionTarget, type DecisionAnsweredRow } from "./decision-model.js";
import { readFileIfExists, writeAtomic } from "./fs-race-safe.js";
import {
  loadMounts, mountsPath, type CashShadowArm, type DecisionCandidate, type DecisionShadowArm, type JudgeMount, type JudgePrimary, type JudgeShadowArm,
  type JudgeShadowOnlyRole, type JudgeThreshold, type Mounts,
} from "./mounts.js";
import { resolveOwnerRepoAtAsync } from "./owner-repo.js";
import { promotionCeiling } from "./promotion-bars.js";
import { JUDGE_SHADOW_TRIAL_ID, type spawnWorker, type SpawnWorkerArgs, type WorkerResult } from "./worker.js";
import {
  cashCapacityReadiness, isFoundryClaudeDeployment, learnedCashLimit, OPENWEIGHT_PRICES, openWeightDeploymentReady, OpenWeightAllowanceExhaustedError,
  OpenWeightRequestTooLargeError, type ModelSurface,
} from "./worker-provider.js";

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
 * W1-T12422: `shadow: auto` draws one member of the role's pool per call ({@link shadowPoolMember}); a member is a
 * decision model or a ready cash deployment whose direct judge replay for the role cleared {@link JUDGE_SHADOW_POOL_BAR}.
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
  /** W1-T12417: the decision-model seams a test replaces; production reads the host config. */
  decisions?: ShadowJudgeCall<T>["decisions"];
}

/** W1-T12417: the judged head: its sha and, where the judgement is of a pull request, the pull request, as a URL or as
 *  a number the shadow turns into the URL of this checkout's origin. */
export interface JudgedHead {
  sha?: string;
  prUrl?: string;
  prNumber?: number;
}

/** W1-T12417: the judged head, and the pull request, of a `PR<n>@<head>` key. */
function headOfKey(key: string): JudgedHead {
  const head = key.includes("@") ? key.slice(key.lastIndexOf("@") + 1) : "";
  if (!/^[0-9a-f]{7,64}$/i.test(head)) return {};
  const pr = /^PR(\d+)@/.exec(key);
  return { sha: head, ...(pr === null ? {} : { prNumber: Number(pr[1]) }) };
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
  if (arm.provider === "decisions" || arm.provider === "auto") {
    // W1-T12417: not awaited, so the caller never waits on the decision model. W1-T12422: nor on its pool's member.
    void shadowJudgeCall({ role: request.surface as FixedOptionJudgeRole, key: request.key, mount: request.mount, primaryArgs: request.primaryArgs,
      primary: {}, primaryAnswer: request.primaryVerdict, parse: request.parse, agreementKey: request.agreementKey,
      decisionAnswer: request.surface === "ci-judge" ? ciJudgeDecisionAnswer : request.agreementKey,
      head: headOfKey(request.key), spawn: request.spawn, log: request.log, ...(request.decisions === undefined ? {} : { decisions: request.decisions }) });
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
  /** The judged head and, where there is one, the pull request; both go on the `decision.answered` row. A pull
   *  request given by number becomes the URL of the origin of the primary's checkout. */
  head?: JudgedHead;
  /** The decision-model shadow's seams, beside `spawn` and `log`: production reads the host config and asks the real
   *  decision model. Every other caller names this field's type rather than declaring a seam shape of its own. */
  decisions?: {
    config?: () => Config;
    ask?: typeof askDecisionModel;
    env?: NodeJS.ProcessEnv;
    learnedLimit?: typeof learnedCashLimit;
    /** The owner and repo of the checkout at a root, for the URL of a judged pull request. */
    ownerRepo?: (root: string) => Promise<{ owner: string; repo: string }>;
    /** W1-T12422: the role's pool; production builds it from the mounts table, the ready cash rows and the replay record. */
    pool?: (role: string) => JudgeShadowPoolMember[];
  };
}

type DecisionShadowHost = NonNullable<ShadowJudgeCall<unknown>["decisions"]>;

/** W1-T12417: the URL of pull request `number` in the checkout at `root`'s origin. A checkout whose origin cannot be
 *  read gives none: the row then records the head without the pull request. */
async function pullRequestUrl(root: string | undefined, number: number, ownerRepo: DecisionShadowHost["ownerRepo"]): Promise<string | undefined> {
  if (root === undefined) return undefined;
  try {
    const { owner, repo } = await (ownerRepo ?? resolveOwnerRepoAtAsync)(root);
    return `https://github.com/${owner}/${repo}/pull/${number}`;
  } catch (error) {
    process.stderr.write(`judge shadow pull request url unavailable: ${error instanceof Error ? error.message : String(error)}\n`);
    return undefined;
  }
}

/** ADVISORY ONLY: after the role answered, send the same prompt once to the first ready model of the cash row at low
 *  effort, and write one row: `judge_shadow.compared` for a reply, `judge_shadow.skipped` with the reason for a
 *  refusal or a failure. It starts on a later turn of the event loop, so a caller that does not await it holds its
 *  own answer before any shadow request is made. It never throws. */
export async function shadowJudgeCall<T>(call: ShadowJudgeCall<T>): Promise<void> {
  const arm = call.mount.shadow;
  if (arm?.provider === "auto") return poolShadow(call);
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
  record(...await askDecisionArm({ role: call.role, arm, question, input: call.input ?? call.primaryArgs.prompt, head: call.head,
    cwd: call.primaryArgs.cwd, decisions: call.decisions, threshold: call.mount.threshold, primaryAnswer }));
}

/** One request to a decision model for `role`'s question, as the judge_shadow row it comes to. A config that cannot be
 *  read, a capacity shortfall and a failed request are each a `judge_shadow.skipped` row with its reason. Never throws. */
async function askDecisionArm(request: { role: string; arm: DecisionShadowArm; question: JudgeShadowQuestion; input: string; head: JudgedHead | undefined;
  cwd: string | undefined; decisions: DecisionShadowHost | undefined; threshold: JudgeThreshold | undefined; primaryAnswer: string | null }): Promise<[string, Record<string, unknown>]> {
  const { arm, head } = request;
  try {
    const deps = request.decisions ?? {};
    const config = (deps.config ?? loadConfig)();
    const env = deps.env ?? process.env;
    const target = resolveDecisionTarget(config, arm.candidate, env);
    if (target.ok) {
      const readiness = cashCapacityReadiness((deps.learnedLimit ?? learnedCashLimit)(arm.deployment, target.endpoint), decisionNeedTokens(request.input));
      if (readiness.state === "shortfall") {
        return ["judge_shadow.skipped", { shadow_cost_usd: 0, refusal: "capacity",
          reason: `${arm.deployment} has learned a limit of ${readiness.limitTokens} tokens per minute; the request needs ${readiness.shortfallTokens} more` }];
      }
    }
    const prUrl = head?.sha === undefined || head.sha === "" ? undefined
      : head.prUrl ?? (head.prNumber === undefined ? undefined : await pullRequestUrl(request.cwd, head.prNumber, deps.ownerRepo));
    const row = await (deps.ask ?? askDecisionModel)(config, {
      role: request.role, candidate: arm.candidate, input: request.input, env,
      questions: [{ type: "choice", name: request.role.replace(/-/g, "_"), instructions: request.question.instructions,
        options: request.question.options.map((value) => ({ value })) }],
      ...(head?.sha ? { headSha: head.sha, ...(prUrl ? { prUrl } : {}) } : {}),
    });
    return decisionShadowRow(row, request.primaryAnswer, thresholdFor(request.threshold, arm.deployment, DECISION_MODEL_SURFACE));
  } catch (error) {
    return ["judge_shadow.skipped", { shadow_cost_usd: 0, reason: error instanceof Error ? error.message : String(error) }];
  }
}

/** W1-T12417: what a decision model answered as a judge's primary: the top option and the whole distribution. */
export interface PrimaryAnswer {
  option: string;
  distribution: Array<{ option: string; probability: number }>;
}

/** W1-T12417: a `judge_shadows` entry's primary, for a judge with no row of its own; a head-rehome spawn with no entry
 *  of its own uses `typed-judgment`'s. */
export function judgeShadowOnlyPrimary(mounts: Pick<Mounts, "judge_primaries">, role: JudgeShadowOnlyRole): JudgePrimary | undefined {
  const primaries = mounts.judge_primaries;
  return primaries?.[role] ?? (role === "head-rehome" ? primaries?.["typed-judgment"] : undefined);
}

/** W1-T12417: ask a judge's primary decision model its options as one choice question. It answers when the top option
 *  clears the entry's threshold; a candidate that is unavailable, refused, rejected, abstaining or below the threshold
 *  gives nothing, one `judge_shadow.skipped` row says why, and the caller's own judge answers instead. A head and its
 *  pull request go on the `decision.answered` row as for a shadow. Never throws. */
export async function askPrimaryCandidate(request: { role: FixedOptionJudgeRole; key: string; primary: JudgePrimary; question: JudgeShadowQuestion;
  input: string; head?: JudgedHead; cwd?: string; log: ShadowLog; decisions?: DecisionShadowHost }): Promise<PrimaryAnswer | undefined> {
  const { arm } = request.primary;
  const [step, fields] = await askDecisionArm({ role: request.role, arm, question: request.question, input: request.input, head: request.head,
    cwd: request.cwd, decisions: request.decisions, threshold: request.primary.threshold, primaryAnswer: null });
  const distribution = step === "judge_shadow.compared" && Array.isArray(fields.distribution) ? fields.distribution as PrimaryAnswer["distribution"] : undefined;
  const top = distribution === undefined ? undefined : distribution.reduce((best, entry) => (entry.probability > best.probability ? entry : best));
  if (top !== undefined && request.question.options.every((option) => distribution!.some((entry) => entry.option === option))) {
    return { option: top.option, distribution: distribution! };
  }
  shadowRecorder(request.log, { role: request.role, decision_key: request.key, shadow_model: arm.candidate.name, shadow_deployment: arm.deployment,
    model_surface: DECISION_MODEL_SURFACE, served_as: "primary", ...(request.head?.sha ? { head_sha: request.head.sha } : {}) })(
    "judge_shadow.skipped", step === "judge_shadow.skipped" ? fields : { reason: "the reply does not carry every option" });
  return undefined;
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


// ── W1-T12422: the pool of `shadow: auto` ───────────────────────────────────────────────────

/** PRIMARY CONTROL: what a member's newest judge replay for a role must show. Both numbers are the design's:
 *  10% rejected cases, and W1-T12187's measured median judge call of $0.003 on gpt-6-luna as the cost ceiling. They are
 *  promotion bars in scripts/promotion-ceilings-baseline.json, read through getters on first use (src/lib/promotion-bars.ts). */
export const JUDGE_SHADOW_POOL_BAR: Readonly<{ maxRejectedShare: number; maxMedianCaseUsd: number }> = {
  get maxRejectedShare() { return promotionCeiling("poolMaxRejectedShare"); },
  get maxMedianCaseUsd() { return promotionCeiling("poolMaxMedianCaseUsd"); },
};
/** The replay record under the state directory: role → member key → that member's newest replay figures. */
export const JUDGE_SHADOW_POOL_FILE = "judge-shadow-pool.json";

/** One member's newest direct judge replay for one role (W1-T12421's `judge_replay.finished` row). */
export interface JudgeReplayFigures {
  corpus: string;
  sent: number;
  rejected: number;
  medianCaseUsd: number | null;
  finishedAt: string;
}

export interface JudgeShadowPoolRecord {
  replays: Record<string, Record<string, JudgeReplayFigures>>;
}

/** A pool member: its key (`decisions:<candidate>` or `cash:<deployment>`, the bake-off's key), its name and its arm. */
export interface JudgeShadowPoolMember {
  key: string;
  name: string;
  arm: CashShadowArm | DecisionShadowArm;
}

const isObjectRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The replay record; an absent file is an empty record. A record that does not parse throws: no pool is guessed. */
export function readJudgeShadowPoolRecord(stateDir: string): JudgeShadowPoolRecord {
  const raw = readFileIfExists(join(stateDir, JUDGE_SHADOW_POOL_FILE));
  if (raw === undefined) return { replays: {} };
  const parsed = JSON.parse(raw) as unknown;
  if (!isObjectRecord(parsed) || !isObjectRecord(parsed.replays)) throw new Error(`${JUDGE_SHADOW_POOL_FILE} is unreadable`);
  return parsed as unknown as JudgeShadowPoolRecord;
}

/** Store one member's newest replay figures for one role. */
export function recordJudgeReplayFigures(stateDir: string, role: string, key: string, figures: JudgeReplayFigures): void {
  const record = readJudgeShadowPoolRecord(stateDir);
  record.replays[role] = { ...record.replays[role], [key]: figures };
  writeAtomic(join(stateDir, JUDGE_SHADOW_POOL_FILE), `${JSON.stringify(record, null, 2)}\n`);
}

/** Why replay figures keep a member out of the pool, or `undefined` when they clear {@link JUDGE_SHADOW_POOL_BAR}. */
export function judgeReplayPoolRefusal(figures: JudgeReplayFigures | undefined): string | undefined {
  if (figures === undefined) return "no judge replay for this role";
  if (figures.sent === 0) return "its replay sent no case";
  const share = figures.rejected / figures.sent;
  if (share > JUDGE_SHADOW_POOL_BAR.maxRejectedShare)
    return `its replay rejected ${(share * 100).toFixed(1)}% of ${figures.sent} cases, above ${JUDGE_SHADOW_POOL_BAR.maxRejectedShare * 100}%`;
  if (figures.medianCaseUsd === null) return "its replay has no settled cost per case";
  if (figures.medianCaseUsd > JUDGE_SHADOW_POOL_BAR.maxMedianCaseUsd)
    return `its median settled cost per case is $${figures.medianCaseUsd.toFixed(4)}, above $${JUDGE_SHADOW_POOL_BAR.maxMedianCaseUsd}`;
  return undefined;
}

/** The ready cash deployments a pool may hold: each priced, shaped and bounded deployment, except a Foundry Claude one. */
export function readyCashShadowDeployments(): string[] {
  return Object.keys(OPENWEIGHT_PRICES).filter((deployment) => openWeightDeploymentReady(deployment) && !isFoundryClaudeDeployment(deployment));
}

/** W1-T12422: a role's pool: every decision model and every ready cash deployment (not Foundry Claude) whose replay
 *  for this role clears the bar, in name order. `excluded` names each other candidate with its reason. */
export function judgeShadowPool(role: string, input: {
  decisionModels: Readonly<Record<string, DecisionCandidate>>; cashDeployments: readonly string[]; record: JudgeShadowPoolRecord;
}): { members: JudgeShadowPoolMember[]; excluded: Array<{ key: string; reason: string }> } {
  const candidates: JudgeShadowPoolMember[] = [
    ...Object.values(input.decisionModels).map((candidate): JudgeShadowPoolMember => ({ key: `decisions:${candidate.name}`, name: candidate.name,
      arm: { provider: "decisions", deployment: candidate.deployment, candidate } })),
    ...input.cashDeployments.filter((deployment) => !isFoundryClaudeDeployment(deployment)).map((deployment): JudgeShadowPoolMember => ({
      key: `cash:${deployment}`, name: deployment, arm: { provider: "cash", deployment } })),
  ];
  const members: JudgeShadowPoolMember[] = [];
  const excluded: Array<{ key: string; reason: string }> = [];
  for (const candidate of candidates) {
    const refusal = judgeReplayPoolRefusal(input.record.replays[role]?.[candidate.key]);
    if (refusal === undefined) members.push(candidate);
    else excluded.push({ key: candidate.key, reason: refusal });
  }
  const order = (m: JudgeShadowPoolMember) => `${m.name}\u0000${m.key}`;
  return { members: members.sort((a, b) => order(a).localeCompare(order(b))), excluded };
}

/** W1-T12422: the pool member one call asks: a draw seeded on the role and the input digest over the members in name
 *  order. The same input always draws the same member; over many inputs each member gets about the same share. */
export function shadowPoolMember(role: string, inputDigest: string, pool: readonly JudgeShadowPoolMember[]): JudgeShadowPoolMember | undefined {
  if (pool.length === 0) return undefined;
  const order = (m: JudgeShadowPoolMember) => `${m.name}\u0000${m.key}`;
  const sorted = [...pool].sort((a, b) => order(a).localeCompare(order(b)));
  return sorted[createHash("sha256").update(JSON.stringify([role, inputDigest])).digest().readUInt32BE(0) % sorted.length];
}

/** The production pool: the decision models of the mounts table the judge runs from, the ready cash rows and the
 *  replay record under the host's state directory. */
function productionPool<T>(call: ShadowJudgeCall<T>, config: () => Config): (role: string) => JudgeShadowPoolMember[] {
  return (role) => judgeShadowPool(role, {
    decisionModels: loadMounts(mountsPath(call.primaryArgs.cwd)).decision_models ?? {},
    cashDeployments: readyCashShadowDeployments(),
    record: readJudgeShadowPoolRecord(join(config().root, "state")),
  }).members;
}

/** W1-T12422, ADVISORY ONLY: draw one member of the role's pool and ask it as a named candidate is asked. An empty pool
 *  asks nothing and writes nothing; a pool that cannot be read writes one skipped row. It never throws. */
async function poolShadow<T>(call: ShadowJudgeCall<T>): Promise<void> {
  let pool: JudgeShadowPoolMember[];
  try {
    pool = (call.decisions?.pool ?? productionPool(call, call.decisions?.config ?? loadConfig))(call.role);
  } catch (error) {
    shadowRecorder(call.log, { role: call.role, decision_key: call.key, shadow_model: "auto" })("judge_shadow.skipped",
      { shadow_cost_usd: 0, reason: `the shadow pool is unreadable: ${error instanceof Error ? error.message : String(error)}` });
    return;
  }
  const input = call.input ?? call.primaryArgs.prompt;
  const member = shadowPoolMember(call.role, createHash("sha256").update(input).digest("hex"), pool);
  if (member === undefined) return;
  return shadowJudgeCall({ ...call, mount: { ...call.mount, shadow: member.arm } });
}

/** W1-T12422: the roles whose shadow is `auto` in this mounts table, by their shadow role name. */
export function judgeShadowAutoRoles(mounts: Mounts): string[] {
  const rows: Array<[string, JudgeMount | undefined]> = [["risk-judge", mounts.risk_judge], ["ci-judge", mounts.ci_judge],
    ["fix-progress", mounts.fix_progress_judge], ["verify-human", mounts.verify_human_judge]];
  return [...rows.filter(([, row]) => row?.shadow?.provider === "auto").map(([role]) => role),
    ...Object.entries(mounts.judge_shadows ?? {}).filter(([, arm]) => arm?.provider === "auto").map(([role]) => role)];
}

/** W1-T12422: the corpus a role's direct judge replay reads (W1-T12421's corpora). The risk judge has its own; every
 *  other role is screened on all of them, since no corpus of its own exists yet. */
export function judgeShadowReplayCorpus(role: string): "risk-judge-dispositions" | "all" {
  return role === "risk-judge" ? "risk-judge-dispositions" : "all";
}
