import type { CashShadowArm, JudgeMount } from "./mounts.js";
import { JUDGE_SHADOW_TRIAL_ID, type spawnWorker, type SpawnWorkerArgs, type WorkerResult } from "./worker.js";
import { OpenWeightAllowanceExhaustedError, OpenWeightRequestTooLargeError } from "./worker-provider.js";

/**
 * lib/judge-shadow.ts — a cash model answers the same judgement beside a judge, in shadow.
 *
 * W1-T11075: the ci judge and the fix-progress judge ask the cash deployment their mount row pins
 * ({@link runJudgeShadow}; rows `judge_shadow.paired`, `.refused`, `.unavailable`).
 * W1-T12187: the risk judge and the decision summary ask the first ready model of the cash row of their
 * own tier ({@link shadowJudgeCall}; rows `judge_shadow.compared`, `.skipped`), and
 * {@link judgeShadowSummary} reads both families for the config gardener.
 * Every shadow is advisory: the caller acts on the primary's answer only.
 */

/** The judges a cash shadow may sit beside. */
export type JudgeShadowSurface = "ci-judge" | "fix-progress" | JudgeShadowRole;
/** W1-T12187: the roles {@link shadowJudgeCall} shadows. */
export type JudgeShadowRole = "risk-judge" | "decision-summary";

/** What one shadow call came to. `refused` is a capacity or budget refusal; nothing is acted on in any case. */
export type JudgeShadowOutcome =
  | { kind: "paired"; agreement: boolean }
  | { kind: "refused"; refusal: "capacity" | "budget"; reason: string }
  | { kind: "unavailable"; reason: string }
  | { kind: "skipped" };

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
  primary: Pick<WorkerResult, "costUsd" | "servedModel" | "routedModel">;
  /** The answer the caller already holds. */
  primaryAnswer: T;
  /** The role's own parser. */
  parse: (text: string) => T | undefined;
  /** Two answers agree when these keys are equal. Absent, the row records whether the reply parses and no agreement. */
  agreementKey?: (answer: T) => string;
  spawn: typeof spawnWorker;
  log: ShadowLog;
}

/** ADVISORY ONLY: after the role answered, send the same prompt once to the first ready model of the cash row at low
 *  effort, and write one row: `judge_shadow.compared` for a reply, `judge_shadow.skipped` with the reason for a
 *  refusal or a failure. It starts on a later turn of the event loop, so a caller that does not await it holds its
 *  own answer before any shadow request is made. It never throws. */
export async function shadowJudgeCall<T>(call: ShadowJudgeCall<T>): Promise<void> {
  if (call.mount.provider === "cash") return;
  await new Promise<void>((resolve) => setImmediate(resolve));
  const args = judgeShadowSpawnArgs(call.primaryArgs, call.mount, call.role, call.mount.shadow);
  const record = shadowRecorder(call.log, {
    role: call.role, decision_key: call.key,
    primary_model: call.primary.servedModel ?? call.primary.routedModel ?? call.mount.model,
    primary_provider: call.mount.provider ?? null, primary_cost_usd: call.primary.costUsd ?? null, shadow_effort: args.effort,
  });
  const keyed = call.agreementKey;
  const ask = await askShadow({ spawn: call.spawn, parse: call.parse, primaryVerdict: call.primaryAnswer, agreementKey: keyed ?? (() => "") }, args);
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
