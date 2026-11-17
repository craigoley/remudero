import { spendAmountUsd } from "./spend-rows.js";
import { createHash } from "node:crypto";
import type { Config } from "./config-schema.js";
import { fixedClock, systemClock } from "./clock.js";
import { enabledWorkerProviders } from "./config.js";
import { effectiveCashCapUsd, isFoundryClaudeDeployment, openWeightDeploymentReady } from "./worker-provider.js";
import { ledgerLivePath, readLedgerUnionRawLinesSync, readLedgerUnionRecords, realLedgerFs } from "./ledger-union.js";
import { readNewestInvoiceVerdictsAsync, type InvoiceVerdictRead } from "./cash-invoice-reconcile.js";

/**
 * The cash-simple trial (operator ruling 2026-09-24, DECISIONS.md): a capped share of the simplest
 * implement work runs on a cheap cash model, beside a same-class subscription control, until the
 * ledger says whether it repays itself. Every default below is a config field
 * (`workerProviders.cashTrial`) and carries its reason here.
 */
export interface CashTrialPolicy {
  enabled: boolean;
  /** Share of eligible tasks put on cash. Even, because the eligible population is tiny (54 of 2,037
   *  implement shards) and equal arms reach the minimum sample soonest; the budget, not the share, caps spend. */
  sharePercent: number;
  /** Fraction of `dailyCapUsd` the trial may spend per UTC day, leaving the rest to the lanes already on cash. */
  budgetShareOfDailyCap: number;
  /** Runs per arm before a relative verdict: W1-T3570's admission bar for a cash lane. */
  minSample: number;
  /** The trial stops when its PR rate falls below this fraction of the control's. A starting bar,
   *  not a measured one; the rolling window makes a wrong bar self-correcting. */
  minRelativeSuccess: number;
  /** Evidence window. A stop expires as its failures age out, which is the self-healing re-enable. */
  windowDays: number;
  /** gpt-oss-120b only: gpt-5-nano ran 158 implement assignments, 54 openweight errors, 1 PR in 45 verdicts. */
  models: string[];
}

export const DEFAULT_CASH_TRIAL_POLICY: CashTrialPolicy = {
  enabled: true,
  sharePercent: 50,
  budgetShareOfDailyCap: 0.1,
  minSample: 20,
  minRelativeSuccess: 0.8,
  windowDays: 7,
  models: ["gpt-oss-120b"],
};

export const CASH_TRIAL_ID = "cash-simple";

export type CashTrialArm = "cash" | "control" | "held";

export interface CashTrialDecision {
  id: typeof CASH_TRIAL_ID;
  arm: CashTrialArm;
  reason: string;
  /** Cash arm only: the models left in the draw, in name order. */
  models?: string[];
  /** Each model the stop rule took out of the draw, with its reason. */
  stopped?: Record<string, string>;
  summary?: CashTrialModelSummary;
}

export function cashTrialPolicy(config: Pick<Config, "workerProviders">): CashTrialPolicy {
  return { ...DEFAULT_CASH_TRIAL_POLICY, ...(config.workerProviders?.cashTrial ?? {}) };
}

/** The simplest work there is: one declared docs or plan file, at low risk, on the implement lane. */
export function cashTrialEligible(task: { type: string; risk: string; files?: string[] }, taskClass: string): boolean {
  return task.type === "implement" && task.risk === "low" && (taskClass === "docs" || taskClass === "plan-lint") && task.files?.length === 1;
}

/** Stable per task, so a retried task never changes arm. */
export function cashTrialArmFor(taskId: string, sharePercent: number): "cash" | "control" {
  const bucket = createHash("sha256").update(taskId).digest().readUInt32BE(0) % 100;
  return bucket < sharePercent ? "cash" : "control";
}

/** W1-T12424: what decides the cash arm's open-weight models, read once per eligible run. */
export interface CashTrialReadiness {
  verdicts: InvoiceVerdictRead;
  /** The `inbox.bakeoff` rows; `undefined` when the history could not be read whole. */
  bakeoffRows: readonly Row[] | undefined;
  /** Defaults to {@link openWeightDeploymentReady}. */
  ready?: (deployment: string) => boolean;
}

/** True when the deployment's newest bake-off row ran, and ran with tools. Deployment arms (`cash:<id>:<effort>`)
 *  always carry tools; a `-notools` arm does not; a capacity shortfall did not run. */
function bakeoffRanWithTools(rows: readonly Row[], deployment: string): boolean {
  let newest: Row | undefined;
  for (const row of rows) {
    const candidate = String(row.candidate ?? "");
    if (!candidate.startsWith(`cash:${deployment}:`) && candidate !== `cash-${deployment}` && !candidate.startsWith(`cash-${deployment}-`)) continue;
    if (newest === undefined || String(row.ts ?? "") >= String(newest.ts ?? "")) newest = row;
  }
  return newest !== undefined && newest.status !== "capacity_shortfall" && !String(newest.candidate).endsWith("-notools");
}

/**
 * W1-T12424: the cash arm's models. The policy's models, then each ready open-weight deployment whose newest
 * invoice verdict (W1-T10858) is `reconciled` and whose newest bake-off row ran with tools. An unreadable history
 * admits none. A Foundry Claude deployment is not open-weight and is never added.
 */
export function cashTrialModels(policy: CashTrialPolicy, readiness: CashTrialReadiness): string[] {
  const models = [...policy.models];
  if (!readiness.verdicts.ok || readiness.bakeoffRows === undefined) return models;
  const ready = readiness.ready ?? ((deployment: string) => openWeightDeploymentReady(deployment));
  for (const deployment of [...readiness.verdicts.newest.keys()].sort()) {
    if (models.includes(deployment) || isFoundryClaudeDeployment(deployment) || !ready(deployment)) continue;
    const verdict = readiness.verdicts.newest.get(deployment)!.verdict as { verdict?: unknown } | undefined;
    if (verdict?.verdict === "reconciled" && bakeoffRanWithTools(readiness.bakeoffRows, deployment)) models.push(deployment);
  }
  return models;
}

/** The ledger evidence {@link cashTrialModels} reads, through the async union reader. */
export async function readCashTrialReadiness(stateDir: string): Promise<CashTrialReadiness> {
  const verdicts = await readNewestInvoiceVerdictsAsync(stateDir);
  // With no verdict there is no open-weight arm, so the bake-off history is not read.
  if (!verdicts.ok || verdicts.newest.size === 0) return { verdicts, bakeoffRows: [] };
  const unread: string[] = [];
  const bakeoffRows = await readLedgerUnionRecords(stateDir, { step: "inbox.bakeoff",
    onUnreadArchive: (path) => unread.push(path), onUnreadLive: (path) => unread.push(path),
    onUnreadDirectory: (path) => unread.push(path) });
  return { verdicts, bakeoffRows: unread.length > 0 ? undefined : bakeoffRows };
}

/**
 * W1-T12424: one cash model per task. Each model gets a weight from a hash of the task id and its own name, and the
 * largest weight wins (the earlier name on a tie). The draw has its own salt, so it does not follow the cash or
 * control draw, and a model that leaves or joins moves only its own tasks.
 */
export function cashTrialModelFor(taskId: string, models: readonly string[]): string | undefined {
  const weight = (model: string): number => createHash("sha256").update(`cash-trial-model\0${taskId}\0${model}`).digest().readUInt32BE(0);
  return [...models].sort().reduce<string | undefined>((best, model) => best === undefined || weight(model) > weight(best) ? model : best, undefined);
}

/** The deployment a cash-arm spawn is pinned to: the one drawn model, when it is outside the policy's list. An
 *  open-weight arm is in no capability row, so the row filter alone would leave it no candidate. */
export function cashTrialPinnedDeployment(
  trial: { id: string; arm: string; models?: readonly string[] } | undefined,
  config: Pick<Config, "workerProviders">,
): string | undefined {
  if (trial?.id !== CASH_TRIAL_ID || trial.arm !== "cash" || trial.models?.length !== 1) return undefined;
  return cashTrialPolicy(config).models.includes(trial.models[0]!) ? undefined : trial.models[0];
}

export interface CashTrialArmEvidence {
  runs: number;
  prs: number;
}

export interface CashTrialEvidence {
  cash: CashTrialArmEvidence;
  control: CashTrialArmEvidence;
  spentTodayUsd: number;
  spendUnavailableReason?: string;
}

export interface CashTrialModelEvidence extends CashTrialArmEvidence {
  /** Worker assignments (attempts) of the runs counted here. */
  assignments: number;
  /** Assignments that another model than the drawn one served. */
  crossovers: number;
  merges: number;
  /** Cash dollars of the attempts' worker-call receipts. */
  settledUsd: number;
}

/** W1-T12424: the trial per drawn cash model, in name order, beside the control arm. */
export interface CashTrialModelSummary {
  models: Record<string, CashTrialModelEvidence>;
  control: CashTrialModelEvidence;
}

type Row = Record<string, unknown>;

/**
 * Fold windowed ledger rows by drawn model. A run's drawn model is the `model` of its `cash_trial.decided` row; a
 * cash run from before the draw existed counts for `legacyModel`. Runs and PRs follow the drawn model, whichever
 * model served the attempt.
 */
export function summarizeCashTrialModels(rows: Iterable<Row>, legacyModel: string): CashTrialModelSummary {
  const drawn = new Map<string, string>();
  const attempts = new Map<string, { run: string; arm: "cash" | "control"; served: unknown }>();
  const opened = new Map<string, boolean>();
  const merged = new Set<string>();
  const usd = new Map<string, number>();
  for (const row of rows) {
    const runId = typeof row.run_id === "string" ? row.run_id : undefined;
    const assignment = row.worker_assignment as Row | undefined;
    const decision = (assignment?.routing as Row | undefined)?.decision as Row | undefined;
    if (row.step === "cash_trial.decided" && runId && typeof row.model === "string") drawn.set(runId, row.model);
    else if (row.step === "worker.assignment" && runId && decision?.trial === CASH_TRIAL_ID &&
      (decision.trialArm === "cash" || decision.trialArm === "control")) {
      const id = typeof assignment?.id === "string" ? assignment.id : `${runId}#${attempts.size}`;
      attempts.set(id, { run: runId, arm: decision.trialArm, served: (assignment?.selected as Row | undefined)?.model });
    } else if (row.step === "verdict" && runId) {
      opened.set(runId, typeof row.pr_url === "string" && row.pr_url.length > 0 && row.verdict !== "failed");
    } else if (row.step === "pr.merged" && runId) merged.add(runId);
    const cost = spendAmountUsd(row);
    if ((row.step === "implement.done" || row.step === "implement.resumed") && typeof row.selection_assignment_id === "string" &&
      row.provider === "cash" && row.billing_mode === "api" && cost !== undefined && Number.isFinite(cost) && cost >= 0 &&
      !usd.has(row.selection_assignment_id)) usd.set(row.selection_assignment_id, cost);
  }
  const blank = (): CashTrialModelEvidence => ({ runs: 0, prs: 0, assignments: 0, crossovers: 0, merges: 0, settledUsd: 0 });
  const models: Record<string, CashTrialModelEvidence> = {};
  const control = blank();
  const counted = new Set<string>();
  for (const [id, attempt] of attempts) {
    const model = attempt.arm === "cash" ? drawn.get(attempt.run) ?? legacyModel : undefined;
    const cell = model === undefined ? control : (models[model] ??= blank());
    cell.assignments += 1;
    if (model !== undefined && typeof attempt.served === "string" && attempt.served !== model) cell.crossovers += 1;
    cell.settledUsd = Math.round((cell.settledUsd + (usd.get(id) ?? 0)) * 1e6) / 1e6;
    if (counted.has(attempt.run)) continue;
    counted.add(attempt.run);
    const pr = opened.get(attempt.run);
    if (pr !== undefined) cell.runs += 1;
    if (pr) cell.prs += 1;
    if (merged.has(attempt.run)) cell.merges += 1;
  }
  return { models: Object.fromEntries(Object.keys(models).sort().map((model) => [model, models[model]!])), control };
}

/** Fold windowed ledger rows: each tagged run's arm, whether its verdict opened a PR, and today's cash spend. */
export function summarizeCashTrial(rows: Iterable<Row>, today: string): CashTrialEvidence {
  const armByRun = new Map<string, "cash" | "control">();
  const cashAssignments = new Map<string, string>();
  const verdicts = new Map<string, boolean>();
  const calls = new Map<string, { ts: string; usd: number | undefined; provider: unknown; billingMode: unknown; conflicting: boolean }>();
  for (const row of rows) {
    const assignment = row.worker_assignment as Row | undefined;
    const decision = (assignment?.routing as Row | undefined)?.decision as Row | undefined;
    const runId = typeof row.run_id === "string" ? row.run_id : undefined;
    if (row.step === "worker.assignment" && runId && decision?.trial === CASH_TRIAL_ID) {
      if (decision.trialArm === "cash" || decision.trialArm === "control") armByRun.set(runId, decision.trialArm);
      if (decision.trialArm === "cash" && typeof assignment?.id === "string") {
        cashAssignments.set(assignment.id, typeof row.ts === "string" ? row.ts : "");
      }
    } else if (row.step === "verdict" && runId) {
      verdicts.set(runId, typeof row.pr_url === "string" && row.pr_url.length > 0 && row.verdict !== "failed");
    }
    if ((row.step === "implement.done" || row.step === "implement.resumed") && typeof row.selection_assignment_id === "string") {
      const id = row.selection_assignment_id;
      const current = {
        ts: typeof row.ts === "string" ? row.ts : "",
        usd: spendAmountUsd(row),
        provider: row.provider,
        billingMode: row.billing_mode,
        conflicting: false,
      };
      const prior = calls.get(id);
      if (prior) {
        if (prior.ts !== current.ts || prior.usd !== current.usd || prior.provider !== current.provider || prior.billingMode !== current.billingMode) {
          prior.conflicting = true;
        }
      } else {
        calls.set(id, current);
      }
    }
  }
  const evidence: CashTrialEvidence = { cash: { runs: 0, prs: 0 }, control: { runs: 0, prs: 0 }, spentTodayUsd: 0 };
  for (const [runId, arm] of armByRun) {
    const opened = verdicts.get(runId);
    if (opened === undefined) continue;
    evidence[arm].runs += 1;
    if (opened) evidence[arm].prs += 1;
  }
  for (const [id, assignmentTs] of cashAssignments) {
    const call = calls.get(id);
    if (!call) {
      if (assignmentTs.startsWith(today)) evidence.spendUnavailableReason = "cash assignment has no worker-call cost receipt";
      continue;
    }
    if (!call.ts.startsWith(today)) continue;
    if (call.conflicting || call.provider !== "cash" || call.billingMode !== "api" ||
      call.usd === undefined || !Number.isFinite(call.usd) || call.usd < 0) {
      evidence.spendUnavailableReason = "cash worker-call cost receipt is missing or inconsistent";
      continue;
    }
    evidence.spentTodayUsd = Math.round((evidence.spentTodayUsd + call.usd) * 1e6) / 1e6;
  }
  return evidence;
}

/** Why the trial may not take this task right now, or undefined when it is open. */
export function cashTrialStopReason(evidence: CashTrialEvidence, policy: CashTrialPolicy, dailyCapUsd: number): string | undefined {
  if (evidence.spendUnavailableReason) return `trial spend evidence unavailable: ${evidence.spendUnavailableReason}`;
  const budget = dailyCapUsd * policy.budgetShareOfDailyCap;
  if (evidence.spentTodayUsd >= budget) {
    return `trial budget spent today ($${evidence.spentTodayUsd.toFixed(2)} of $${budget.toFixed(2)})`;
  }
  if (evidence.cash.runs < policy.minSample) {
    // Before the sample is complete: stop once no outcome of the remaining runs could clear the
    // bar even against a perfect control.
    const failures = evidence.cash.runs - evidence.cash.prs;
    const tolerated = policy.minSample - Math.ceil(policy.minSample * policy.minRelativeSuccess);
    return failures > tolerated
      ? `${failures} failed cash runs in ${policy.windowDays}d exceed the ${tolerated} the bar tolerates at n=${policy.minSample}`
      : undefined;
  }
  const cashRate = evidence.cash.prs / evidence.cash.runs;
  // An unmeasured control is treated as perfect, the cautious direction for spend.
  const measured = evidence.control.runs >= policy.minSample;
  const controlRate = measured ? evidence.control.prs / evidence.control.runs : 1;
  if (cashRate >= policy.minRelativeSuccess * controlRate) return undefined;
  return `cash PR rate ${(cashRate * 100).toFixed(0)}% is below ${policy.minRelativeSuccess} x ` +
    `${measured ? `control ${(controlRate * 100).toFixed(0)}%` : "an unmeasured control taken as 100%"}`;
}

function windowedRows(stateDir: string, windowMs: number, today: string): { rows: Row[]; unavailableReason?: string } {
  let liveReadFailed = false;
  const livePath = ledgerLivePath(stateDir);
  const dayStartMs = Date.parse(`${today}T00:00:00.000Z`);
  const startMs = dayStartMs - windowMs + 86_400_000;
  if (!Number.isFinite(dayStartMs) || !Number.isFinite(startMs) || Math.abs(startMs) > 8.64e15) {
    return { rows: [], unavailableReason: "trial evidence window is invalid" };
  }
  const read = readLedgerUnionRawLinesSync(stateDir, {
    sinceTs: fixedClock(startMs).iso(),
    pattern: /cash-simple|"step":"verdict"|"step":"pr\.merged"|selection_assignment_id/,
    refuseIncomplete: true,
  }, {
    ...realLedgerFs,
    readFileSync: (path) => {
      try { return realLedgerFs.readFileSync(path); }
      catch (error) {
        if (path === livePath) liveReadFailed = true;
        throw error;
      }
    },
  });
  if (read.unread.length > 0 || liveReadFailed || !read.liveFileRead || read.unclassified.length > 0) {
    return { rows: [], unavailableReason: "ledger source unreadable or incomplete for paid-trial spend" };
  }
  const rows: Row[] = [];
  let invalidRows = 0;
  for (const line of read.rawLines) {
    try {
      const row = JSON.parse(line) as Row;
      const tsMs = typeof row.ts === "string" ? Date.parse(row.ts) : Number.NaN;
      if (!Number.isFinite(tsMs)) invalidRows += 1;
      else if (tsMs >= startMs && tsMs < dayStartMs + 86_400_000) rows.push(row);
    } catch (error) {
      const reason = `ledger row unreadable for paid-trial spend (${error instanceof SyntaxError ? "invalid-json" : "parse-error"})`;
      return { rows: [], unavailableReason: reason };
    }
  }
  return invalidRows > 0
    ? { rows: [], unavailableReason: "ledger row unreadable for paid-trial spend" }
    : { rows };
}

/** Decide one implement run's trial arm, or undefined when the task is not trial work at all. */
export function decideCashTrial(
  input: {
    task: { id: string; type: string; risk: string; files?: string[] };
    taskClass: string;
    config: Config;
    harnessCommits: boolean;
    stateDir: string;
    readRows?: (stateDir: string, windowMs: number) => Row[];
    today?: string;
    /** The cash arm's models ({@link cashTrialModels}); the policy's models when absent. */
    models?: readonly string[];
  },
): CashTrialDecision | undefined {
  if (!cashTrialEligible(input.task, input.taskClass)) return undefined;
  const policy = cashTrialPolicy(input.config);
  const held = (reason: string): CashTrialDecision => ({ id: CASH_TRIAL_ID, arm: "held", reason });
  if (!policy.enabled) return held("workerProviders.cashTrial.enabled is false");
  if (!enabledWorkerProviders(input.config).includes("cash")) return held("cash is not an enabled worker provider");
  // The trial budgets from the figure of a normal day. A squeeze day does not raise it (W1-T12186).
  let cap: number | undefined;
  try {
    cap = effectiveCashCapUsd(input.config.dailyCapUsd);
  } catch (err) {
    // The provider refuses this cap. The trial is held with the provider's own reason.
    return held(`dailyCapUsd is invalid for a paid trial: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (cap === undefined) return held("dailyCapUsd is unset, so trial spend would be unbounded");
  if (!Number.isFinite(cap) || cap <= 0) return held("dailyCapUsd is invalid for a paid trial");
  if (!Number.isFinite(policy.budgetShareOfDailyCap) || policy.budgetShareOfDailyCap <= 0 || policy.budgetShareOfDailyCap > 1 ||
    !Number.isInteger(policy.windowDays) || policy.windowDays <= 0 ||
    !Number.isInteger(policy.sharePercent) || policy.sharePercent < 0 || policy.sharePercent > 100) {
    return held("cash trial policy has an invalid budget, window, or allocation share");
  }
  if (!input.harnessCommits) return held("workerProviders.harnessCommitsImplement is off, so a shell-less worker cannot land a commit");
  const windowMs = policy.windowDays * 86_400_000;
  const arm = cashTrialArmFor(input.task.id, policy.sharePercent);
  if (arm === "control") return { id: CASH_TRIAL_ID, arm, reason: `control arm by stable task hash at ${policy.sharePercent}% share` };
  const today = input.today ?? systemClock.iso().slice(0, 10);
  const read = input.readRows
    ? { rows: input.readRows(input.stateDir, windowMs) }
    : windowedRows(input.stateDir, windowMs, today);
  const evidence = summarizeCashTrial(read.rows, today);
  if (read.unavailableReason) evidence.spendUnavailableReason = read.unavailableReason;
  // W1-T12424: the stop rule runs on each cash model alone. The budget and the spend evidence are the trial's own,
  // so they stop every model together.
  const models = [...new Set(input.models ?? policy.models)].sort();
  const summary = summarizeCashTrialModels(read.rows, policy.models[0] ?? "unknown");
  const stopped: Record<string, string> = {};
  for (const model of models) {
    const stop = cashTrialStopReason({ ...evidence, cash: summary.models[model] ?? { runs: 0, prs: 0 } }, policy, cap);
    if (stop !== undefined) stopped[model] = stop;
  }
  const open = models.filter((model) => stopped[model] === undefined);
  const first = cashTrialModelFor(input.task.id, models);
  if (open.length === 0) return { ...held(first === undefined ? "the cash trial has no model" : stopped[first]!), stopped, summary };
  return { id: CASH_TRIAL_ID, arm, reason: `${arm} arm by stable task hash at ${policy.sharePercent}% share`, models: open, stopped, summary };
}

/** The spawn fields a trial decision adds to an implement spawn: the cash arm moves the run onto the trial's models. */
export function cashTrialSpawnFields(
  decision: CashTrialDecision | undefined,
  cashTools: readonly string[] | undefined,
  models: readonly string[],
): { mountProvider?: "cash"; tools?: string[]; routingTrial?: { id: string; arm: string; reason: string; models?: readonly string[] } } {
  if (decision === undefined) return {};
  const routingTrial = { id: decision.id, arm: decision.arm, reason: decision.reason };
  if (decision.arm !== "cash" || cashTools === undefined) return { routingTrial };
  return { mountProvider: "cash", tools: [...cashTools], routingTrial: { ...routingTrial, models } };
}
