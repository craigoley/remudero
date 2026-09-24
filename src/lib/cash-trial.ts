import { createHash } from "node:crypto";
import type { Config } from "./config-schema.js";
import { systemClock } from "./clock.js";
import { enabledWorkerProviders } from "./config.js";
import { readLedgerUnionRawLinesSync } from "./ledger-union.js";

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

export interface CashTrialArmEvidence {
  runs: number;
  prs: number;
}

export interface CashTrialEvidence {
  cash: CashTrialArmEvidence;
  control: CashTrialArmEvidence;
  spentTodayUsd: number;
}

type Row = Record<string, unknown>;

/** Fold windowed ledger rows: each tagged run's arm, whether its verdict opened a PR, and today's cash spend. */
export function summarizeCashTrial(rows: Iterable<Row>, today: string): CashTrialEvidence {
  const armByRun = new Map<string, "cash" | "control">();
  const cashAssignments = new Set<string>();
  const verdicts = new Map<string, boolean>();
  const costs: Array<{ id: string; ts: string; usd: number }> = [];
  for (const row of rows) {
    const assignment = row.worker_assignment as Row | undefined;
    const decision = (assignment?.routing as Row | undefined)?.decision as Row | undefined;
    const runId = typeof row.run_id === "string" ? row.run_id : undefined;
    if (row.step === "worker.assignment" && runId && decision?.trial === CASH_TRIAL_ID) {
      if (decision.trialArm === "cash" || decision.trialArm === "control") armByRun.set(runId, decision.trialArm);
      if (decision.trialArm === "cash" && typeof assignment?.id === "string") cashAssignments.add(assignment.id);
    } else if (row.step === "verdict" && runId) {
      verdicts.set(runId, typeof row.pr_url === "string" && row.pr_url.length > 0 && row.verdict !== "failed");
    }
    if (typeof row.selection_assignment_id === "string" && typeof row.cost_usd === "number") {
      costs.push({ id: row.selection_assignment_id, ts: typeof row.ts === "string" ? row.ts : "", usd: row.cost_usd });
    }
  }
  const evidence: CashTrialEvidence = { cash: { runs: 0, prs: 0 }, control: { runs: 0, prs: 0 }, spentTodayUsd: 0 };
  for (const [runId, arm] of armByRun) {
    const opened = verdicts.get(runId);
    if (opened === undefined) continue;
    evidence[arm].runs += 1;
    if (opened) evidence[arm].prs += 1;
  }
  evidence.spentTodayUsd = costs
    .filter((cost) => cashAssignments.has(cost.id) && cost.ts.startsWith(today))
    .reduce((sum, cost) => sum + cost.usd, 0);
  return evidence;
}

/** Why the trial may not take this task right now, or undefined when it is open. */
export function cashTrialStopReason(evidence: CashTrialEvidence, policy: CashTrialPolicy, dailyCapUsd: number): string | undefined {
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

function windowedRows(stateDir: string, windowMs: number): Row[] {
  const read = readLedgerUnionRawLinesSync(stateDir, {
    rotationWindowMs: windowMs,
    pattern: /cash-simple|"step":"verdict"|selection_assignment_id/,
  });
  return read.rawLines.flatMap((line) => {
    try {
      return [JSON.parse(line) as Row];
    } catch {
      return []; // a torn line is not evidence either way
    }
  });
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
  },
): CashTrialDecision | undefined {
  if (!cashTrialEligible(input.task, input.taskClass)) return undefined;
  const policy = cashTrialPolicy(input.config);
  const held = (reason: string): CashTrialDecision => ({ id: CASH_TRIAL_ID, arm: "held", reason });
  if (!policy.enabled) return held("workerProviders.cashTrial.enabled is false");
  if (!enabledWorkerProviders(input.config).includes("cash")) return held("cash is not an enabled worker provider");
  const cap = input.config.dailyCapUsd;
  if (typeof cap !== "number") return held("dailyCapUsd is unset, so trial spend would be unbounded");
  if (!input.harnessCommits) return held("workerProviders.harnessCommitsImplement is off, so a shell-less worker cannot land a commit");
  const windowMs = policy.windowDays * 86_400_000;
  const rows = (input.readRows ?? windowedRows)(input.stateDir, windowMs);
  const today = input.today ?? systemClock.iso().slice(0, 10);
  const stop = cashTrialStopReason(summarizeCashTrial(rows, today), policy, cap);
  if (stop !== undefined) return held(stop);
  const arm = cashTrialArmFor(input.task.id, policy.sharePercent);
  return { id: CASH_TRIAL_ID, arm, reason: `${arm} arm by stable task hash at ${policy.sharePercent}% share` };
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
