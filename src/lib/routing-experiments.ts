import { join } from "node:path";
import { loadConfig, type WorkerProviderId } from "./config.js";
import { fixedClock, systemClock } from "./clock.js";
import { readLedgerUnionRecords } from "./ledger-union.js";
import { routingDrawValue, type RoutingDrawSeed } from "./worker-provider.js";
import { mergeCashRequestEfforts, summarizeCashRequestEfforts, type CashRequestEffortEvidence } from "./cash-request-effort.js";
import { mergeCashAccounting, summarizeCashAccounting, type CashAccountingObservation } from "./cash-accounting.js";
import { mergeServedModel, mergeWorkerIdentity, readWorkerRequestedEffort, type IdentityObservation, type WorkerExecutionTransport, type WorkerRequestedEffort } from "./worker-execution-evidence.js";

/**
 * Live routing experiments (operator ruling 2026-09-24, DECISIONS.md). An assignment joins an
 * experiment only when the auction could genuinely have picked EITHER arm: both providers were
 * eligible and the codex arm was serving the experiment's model. Headroom still weighs the served
 * provider; the task alone fixes the assigned arm (W1-T4617), so a retry never re-randomises it.
 */
export interface RoutingExperiment {
  id: string;
  capability: string;
  effort: string;
  /** provider -> arm label. */
  arms: Partial<Record<WorkerProviderId, string>>;
  /** Concrete Claude treatment. An alias changing models starts another experiment epoch. */
  claudeModel: RegExp;
  codexModel: RegExp;
  startedOn: string;
  revisitOn: string;
  /** Daily review starts at revisitOn; sample sufficiency remains a separate condition. */
  reviewCadence?: "daily";
  /** Fewer tasks than this in either arm is reported as an insufficient sample, never a verdict. */
  minTasksPerArm: number;
}

export const ROUTING_EXPERIMENTS: readonly RoutingExperiment[] = [
  {
    id: "sol-vs-sonnet",
    capability: "balanced",
    effort: "high",
    arms: { claude: "sonnet", codex: "sol" },
    claudeModel: /^claude-sonnet-5$/,
    codexModel: /^gpt-6-sol$/,
    startedOn: "2026-09-24",
    revisitOn: "2026-10-08",
    // W1-T3570's admission bar for a cash lane, reused so both trials read against one standard.
    minTasksPerArm: 20,
  },
  {
    id: "sol-vs-sonnet55",
    capability: "balanced",
    effort: "high",
    arms: { claude: "sonnet", codex: "sol" },
    claudeModel: /^claude-sonnet-5-5$/,
    codexModel: /^gpt-6-sol$/,
    startedOn: "2026-09-29",
    revisitOn: "2026-10-13",
    minTasksPerArm: 20,
  },
  ...["claude-sonnet-5-5", "claude-sonnet-5"].map((model) => ({
    id: model === "claude-sonnet-5-5" ? "sol61-vs-sonnet55" : "sol61-vs-sonnet5",
    capability: "balanced", effort: "high",
    arms: { claude: "sonnet", codex: "sol61" },
    claudeModel: new RegExp(`^${model}$`), codexModel: /^gpt-6\.1-sol$/,
    startedOn: "2026-10-02", revisitOn: "2026-10-02", reviewCadence: "daily" as const, minTasksPerArm: 20,
  })),
  ...["low", "medium", "high"].map((effort) => ({
    id: `haiku55-vs-luna6-${effort}`, capability: "economy", effort,
    arms: { claude: "haiku55", codex: "luna6" },
    claudeModel: /^claude-haiku-5-5$/, codexModel: /^gpt-6-luna$/,
    startedOn: "2026-10-07", revisitOn: "2026-10-07", reviewCadence: "daily" as const,
    minTasksPerArm: 20,
  })),
];

/** A generic lane label cannot be the randomization unit for independent work. */
export function experimentTaskIdentity(taskId: string | undefined): string | undefined {
  return taskId && /^(?:W\d+-T\d+|PR-\d+|RETRO-\d+|T\d+)$/.test(taskId) ? taskId : undefined;
}

export interface ExperimentCandidate {
  provider: WorkerProviderId;
  model?: string;
  eligible: boolean;
}

export function routingExperimentFor(
  input: { capability?: string; effort?: string; considered: readonly ExperimentCandidate[] },
  experiments: readonly RoutingExperiment[] = ROUTING_EXPERIMENTS,
): string | undefined {
  return experiments.find((experiment) => {
    if (experiment.capability !== input.capability || experiment.effort !== input.effort) return false;
    return (Object.keys(experiment.arms) as WorkerProviderId[]).every((provider) => {
      const entry = input.considered.find((candidate) => candidate.provider === provider);
      if (entry === undefined || !entry.eligible) return false;
      return provider === "claude" ? experiment.claudeModel.test(entry.model ?? "")
        : provider !== "codex" || experiment.codexModel.test(entry.model ?? "");
    });
  })?.id;
}

/**
 * W1-T4617: THE EXPERIMENT'S UNIT IS THE TASK. Keying the arm on the spawn let every retry and fix
 * rung re-randomise it, and 26 of 56 tagged tasks (46%) landed in both arms. The auction draw an
 * experiment joins is keyed on `(task, experiment)` alone and walks the arms in declared order, so
 * every attempt of a task reads the same value: the SAME weights still decide the served provider
 * (no share moves), while the assigned arm below is a pure function of the task.
 */
export function experimentDrawSeed(experiment: RoutingExperiment, taskId: string): RoutingDrawSeed {
  return {
    unit: "task",
    taskId,
    attempt: "every-attempt",
    point: `experiment:${experiment.id}`,
    order: Object.keys(experiment.arms) as WorkerProviderId[],
  };
}

/** Intention to treat: the arm the task was assigned, the arm this decision served, and whether they differ. */
export interface ExperimentIntentionToTreat {
  id: string;
  unit: "task";
  assignedArm: string;
  /** Each arm's assignment probability: the arms split the task-keyed value equally. */
  assignedProbability: number;
  servedArm: string;
  crossover: boolean;
}

/** The arm a task is assigned: its task-keyed draw split equally across the declared arms. */
export function experimentArmForTask(experiment: RoutingExperiment, taskId: string): { arm: string; probability: number } {
  const arms = Object.values(experiment.arms) as string[];
  const { value } = routingDrawValue(experimentDrawSeed(experiment, taskId));
  return { arm: arms[Math.min(arms.length - 1, Math.floor(value * arms.length))]!, probability: 1 / arms.length };
}

/** The ITT record for one tagged decision, or undefined when the id names no live experiment. */
export function experimentIntentionToTreat(
  experimentId: string,
  taskId: string,
  served: WorkerProviderId,
  experiments: readonly RoutingExperiment[] = ROUTING_EXPERIMENTS,
): ExperimentIntentionToTreat | undefined {
  const experiment = experiments.find((candidate) => candidate.id === experimentId);
  if (!experiment) return undefined;
  const assigned = experimentArmForTask(experiment, taskId);
  const servedArm = experiment.arms[served] ?? served;
  return {
    id: experiment.id,
    unit: "task",
    assignedArm: assigned.arm,
    assignedProbability: assigned.probability,
    servedArm,
    crossover: servedArm !== assigned.arm,
  };
}

export interface ExperimentArmReport {
  arm: string;
  provider: WorkerProviderId;
  tasks: number;
  merged: number;
  mergeRate: number | null;
  meanFixDispatches: number | null;
  medianWorkerMinutes: number | null;
  meanTokens: number | null;
  meanCashCostUsd: number | null;
  meanNotionalCostUsd: number | null;
  costMissingAssignments: number;
  nonStarterAssignments: number | null;
  requestEffortEvidence: ReturnType<typeof summarizeCashRequestEfforts>;
  cashAccountingEvidence: ReturnType<typeof summarizeCashAccounting>;
  executionEffortScope: ReturnType<typeof executionEffortScope>;
  receiptCoverage: {
    assignments: number;
    terminalAssignments: number;
    costKnownAssignments: number;
    servedModelKnownAssignments: number;
    outcomeKnownAssignments: number;
  };
}

export interface ExperimentReport {
  id: string;
  startedOn: string;
  revisitOn: string;
  revisitDue: boolean;
  reviewCadence: "daily" | "scheduled";
  nextReviewOn: string;
  assignments: number;
  evidence?: RoutingObservationEvidence;
  excludedAssignments: { genericUnit: number; changedTreatment: number; unverifiedTreatment: number };
  /** Tasks whose tagged assignments landed in BOTH arms; counted under their first arm. */
  mixedTasks: number;
  /** W1-T4617: tasks served an arm other than the one they were assigned at least once. */
  crossoverTasks: number;
  sufficient: boolean;
  arms: ExperimentArmReport[];
}

type Row = Record<string, unknown>;

const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const num = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
const cost = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
const mean = (values: number[]): number | null => (values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length);

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function tokenTotal(value: unknown): number | undefined {
  if (!value || typeof value !== "object") return undefined;
  const tokens = value as Row;
  if (num(tokens.input) === undefined && num(tokens.output) === undefined) return undefined;
  return (num(tokens.input) ?? 0) + (num(tokens.output) ?? 0);
}

/** One pass over ledger rows: tagged assignments, their receipts, fix dispatches and merges per task. */
interface ExperimentReceipt {
  minutes?: number; tokens?: number; cost?: number; notionalCost?: number | null;
  billing?: IdentityObservation<"api" | "subscription">;
  billingMode?: "api" | "subscription" | "conflict";
  missingBilling?: number;
  invalidBilling?: number;
  transport?: IdentityObservation<WorkerExecutionTransport>;
  cashAccounting?: CashAccountingObservation;
  requestedEffort?: WorkerRequestedEffort | "invalid" | "conflicting";
  attempted?: true; servedModel?: IdentityObservation<string>; success?: boolean; requestEfforts?: CashRequestEffortEvidence;
}

function executionEffortScope(receipts: (ExperimentReceipt | undefined)[]) {
  const apiWire: ExperimentReceipt[] = [], subscription: ExperimentReceipt[] = [], apiNative: ExperimentReceipt[] = [];
  let missing = 0, invalid = 0, conflicting = 0;
  for (const receipt of receipts) {
    const billing = receipt?.billing, transport = receipt?.transport;
    if (billing?.state === "unavailable" && billing.reason === "invalid" || transport?.state === "unavailable" && transport.reason === "invalid") { invalid++; continue; }
    if (billing?.state === "unavailable" && billing.reason === "conflicting" || transport?.state === "unavailable" && transport.reason === "conflicting") { conflicting++; continue; }
    if (billing?.state !== "observed" || transport?.state !== "observed") { missing++; continue; }
    const wire = ["chat-completions", "responses", "foundry-messages"].includes(transport.value);
    if (billing.value === "subscription" && wire
      || wire && receipt?.requestEfforts?.state === "observed" && receipt.requestEfforts.entries.some(entry => entry.transport !== transport.value)
      || !wire && typeof receipt?.requestedEffort === "object" && receipt.requestedEffort.provenance !== (transport.value === "claude-sdk" ? "sdk-options" : "cli-argv")) { conflicting++; continue; }
    if (wire) apiWire.push(receipt!);
    else if (billing.value === "subscription") subscription.push(receipt!);
    else apiNative.push(receipt!);
  }
  const native = (rows: ExperimentReceipt[]) => ({ assignments: rows.length,
    reportedAssignments: rows.filter(row => row.requestedEffort !== undefined && typeof row.requestedEffort === "object").length,
    missingAssignments: rows.filter(row => row.requestedEffort === undefined).length,
    invalidAssignments: rows.filter(row => row.requestedEffort === "invalid").length,
    conflictingAssignments: rows.filter(row => row.requestedEffort === "conflicting").length,
    parameterPresentAssignments: rows.filter(row => typeof row.requestedEffort === "object" && row.requestedEffort.state === "parameter-present").length,
    parameterOmittedAssignments: rows.filter(row => typeof row.requestedEffort === "object" && row.requestedEffort.state === "parameter-omitted").length,
    parameterUnreadableAssignments: rows.filter(row => typeof row.requestedEffort === "object" && row.requestedEffort.state === "parameter-unreadable").length,
    providerEffectiveEffort: null });
  return { assignments: receipts.length, apiWireAssignments: apiWire.length, subscriptionNativeAssignments: subscription.length,
    apiNativeAssignments: apiNative.length, missingIdentityAssignments: missing, invalidIdentityAssignments: invalid,
    conflictingIdentityAssignments: conflicting, apiWireEvidence: summarizeCashRequestEfforts(apiWire.map(row => row.requestEfforts)),
    subscriptionRequestedEvidence: native(subscription), apiNativeRequestedEvidence: native(apiNative), providerEffectiveEffort: null };
}

export interface RoutingObservationEvidence {
  state: "observed" | "observed-partial";
  keys: { tasks: number; assignments: number; receipts: number; merges: number; fixTimes: number };
  omitted: { tasks: number; assignments: number; receipts: number; merges: number; fixTimes: number; oversized: number };
  assignmentConflicts: number;
  billing: { conflicts: number; missingObservations: number; invalidObservations: number };
  receiptCorpusBilling: { conflicts: number; missingObservations: number; invalidObservations: number };
}

/** A compact, bounded observer shared by the iterable API and the sole daily scan.
 * Omissions count rejected observations, not an invented distinct unseen-key count. */
export function routingExperimentObserver(experiment: RoutingExperiment, today: string,
  maxKeys = 100_000) {
  if (!Number.isSafeInteger(maxKeys) || maxKeys < 1 || maxKeys > 100_000) throw new Error("routing-observer-bound-invalid");
  const omitted = { tasks: 0, assignments: 0, receipts: 0, merges: 0, fixTimes: 0, oversized: 0 };
  const billing = { conflicts: 0, missingObservations: 0, invalidObservations: 0 };
  let assignmentConflicts = 0, fixTimes = 0;
  const room = (map: Map<string, unknown>, key: string, scope: "tasks" | "assignments" | "receipts" | "merges") => {
    if (map.has(key) || map.size < maxKeys) return true;
    omitted[scope]++; return false;
  };
  const firstArm = new Map<string, { arm: string; provider: WorkerProviderId; ts: string }>();
  const armsSeen = new Map<string, Set<string>>();
  const crossed = new Set<string>();
  const assignmentTask = new Map<string, string | null>();
  const receipts = new Map<string, ExperimentReceipt>();
  const excludedAssignments = { genericUnit: 0, changedTreatment: 0, unverifiedTreatment: 0 };
  const merges = new Map<string, string>();
  const fixes = new Map<string, Map<string, number>>();
  function observe(row: Row) {
    const step = str(row.step);
    const task = str(row.task_id);
    const ts = str(row.ts) ?? "";
    if ((task && task.length > 512) || ts.length > 80 || (typeof row.selection_assignment_id === "string" && row.selection_assignment_id.length > 512)) {
      omitted.oversized++; return;
    }
    if (step === "worker.assignment" && task) {
      const assignment = row.worker_assignment as Row | undefined;
      const routing = assignment?.routing as Row | undefined;
      const decision = routing?.decision as Row | undefined;
      if (decision?.ab !== experiment.id) return;
      if (experimentTaskIdentity(task) === undefined) { excludedAssignments.genericUnit += 1; return; }
      const considered = Array.isArray(decision.considered) ? decision.considered as Row[] : [];
      const claudeCandidate = considered.find((candidate) => candidate.provider === "claude");
      const candidateModel = str(claudeCandidate?.model);
      if (candidateModel === undefined) { excludedAssignments.unverifiedTreatment += 1; return; }
      if (!experiment.claudeModel.test(candidateModel)) {
        excludedAssignments.changedTreatment += 1;
        return;
      }
      const provider = str((assignment?.selected as Row | undefined)?.provider) as WorkerProviderId | undefined;
      const itt = routing?.experiment as Row | undefined;
      // A row carrying its intention-to-treat record counts under its ASSIGNED arm; an older row, its served one.
      const arm = str(itt?.assignedArm) ?? (provider ? experiment.arms[provider] : undefined);
      if (!provider || !arm) return;
      if (arm.length > 80 || !Object.values(experiment.arms).includes(arm)) { omitted.oversized++; return; }
      if (!room(firstArm, task, "tasks")) return;
      const id = str(assignment?.id);
      if (id && id.length > 512) { omitted.oversized++; return; }
      if (itt?.crossover === true) crossed.add(task);
      if (id && room(assignmentTask, id, "assignments")) {
        const priorTask = assignmentTask.get(id);
        if (priorTask !== undefined && priorTask !== task) {
          if (priorTask !== null) assignmentConflicts++;
          assignmentTask.set(id, null);
        } else assignmentTask.set(id, task);
      }
      const seen = armsSeen.get(task) ?? new Set<string>();
      seen.add(arm);
      armsSeen.set(task, seen);
      const first = firstArm.get(task);
      if (!first || ts < first.ts) firstArm.set(task, { arm, provider, ts });
    } else if (step === "verdict.merged" && task) {
      if (room(merges, task, "merges") && (!merges.has(task) || ts > merges.get(task)!)) merges.set(task, ts);
    } else if (step === "fix.dispatch" && task) {
      const times = fixes.get(task);
      if (times?.has(ts)) times.set(ts, times.get(ts)! + 1);
      else if (fixTimes < maxKeys) { const histogram = times ?? new Map<string, number>(); histogram.set(ts, 1); fixes.set(task, histogram); fixTimes++; }
      else omitted.fixTimes++;
    }
    const receiptId = str(row.selection_assignment_id);
    if (receiptId && (step === "worker.attempt" || step === "verdict" || step?.endsWith(".done"))) {
      if (!room(receipts, receiptId, "receipts")) return;
      const prior = receipts.get(receiptId) ?? {};
      const knownMode = row.billing_mode === "api" || row.billing_mode === "subscription" ? row.billing_mode : undefined;
      if (!Object.hasOwn(row, "billing_mode")) billing.missingObservations++;
      else if (!knownMode) billing.invalidObservations++;
      const billingMode = prior.billingMode === "conflict" ? "conflict"
        : knownMode && prior.billingMode && knownMode !== prior.billingMode ? "conflict" : knownMode ?? prior.billingMode;
      if (billingMode === "conflict" && prior.billingMode !== "conflict") billing.conflicts++;
      const duration = num(row.worker_duration_ms);
      receipts.set(receiptId, {
        ...prior,
        ...(step === "worker.attempt" ? { attempted: true as const } : {}),
        ...(duration !== undefined ? { minutes: duration / 60_000 } : {}),
        ...(row.token_usage_state === "partial" || row.token_usage_state === "unavailable" ? { tokens: undefined }
          : tokenTotal(row.tokens) !== undefined ? { tokens: tokenTotal(row.tokens) } : {}),
        ...(cost(row.total_cost_usd) !== undefined ? { cost: cost(row.total_cost_usd) }
          : cost(row.cost_usd) !== undefined ? { cost: cost(row.cost_usd) } : {}),
        ...(Object.hasOwn(row, "notional_cost_usd") ? { notionalCost: cost(row.notional_cost_usd) ?? null } : {}),
        billing: mergeWorkerIdentity(prior.billing, row.billing_mode, ["api", "subscription"]),
        transport: mergeWorkerIdentity(prior.transport, row.execution_transport, ["chat-completions", "responses", "foundry-messages", "claude-sdk", "codex-cli"]),
        ...(Object.hasOwn(row, "cash_accounting") ? { cashAccounting: mergeCashAccounting(prior.cashAccounting, row.cash_accounting) } : {}),
        ...(Object.hasOwn(row, "requested_effort") ? { requestedEffort: (() => {
          const next = readWorkerRequestedEffort(row.requested_effort);
          if (!next || prior.requestedEffort === "invalid") return "invalid" as const;
          if (prior.requestedEffort === "conflicting") return "conflicting" as const;
          return prior.requestedEffort === undefined || JSON.stringify(prior.requestedEffort) === JSON.stringify(next) ? next : "conflicting" as const;
        })() } : {}),
        ...(Object.hasOwn(row, "served_model") ? { servedModel: mergeServedModel(prior.servedModel, row.served_model) } : {}),
        ...(billingMode ? { billingMode } : {}),
        missingBilling: (prior.missingBilling ?? 0) + (Object.hasOwn(row, "billing_mode") ? 0 : 1),
        invalidBilling: (prior.invalidBilling ?? 0) + (Object.hasOwn(row, "billing_mode") && !knownMode ? 1 : 0),
        ...(typeof row.success === "boolean" ? { success: row.success } : {}),
        ...(Object.hasOwn(row, "request_efforts") ? { requestEfforts: mergeCashRequestEfforts(prior.requestEfforts, row.request_efforts) } : {}),
      });
    }
  }
  function report(): ExperimentReport {
  const joinedReceipts = [...assignmentTask].flatMap(([id, task]) => task === null || !receipts.has(id) ? [] : [receipts.get(id)!]);
  const joinedBilling = { conflicts: joinedReceipts.filter(receipt => receipt.billingMode === "conflict").length,
    missingObservations: joinedReceipts.reduce((sum, receipt) => sum + (receipt.missingBilling ?? 0), 0),
    invalidObservations: joinedReceipts.reduce((sum, receipt) => sum + (receipt.invalidBilling ?? 0), 0) };
  const arms = (Object.entries(experiment.arms) as Array<[WorkerProviderId, string]>).map(([provider, arm]): ExperimentArmReport => {
    const tasks = [...firstArm.entries()].filter(([, first]) => first.arm === arm);
    const since = new Map(tasks.map(([task, first]) => [task, first.ts]));
    const merged = new Set([...merges].filter(([task, ts]) => since.has(task) && ts >= since.get(task)!).map(([task]) => task));
    const fixCounts = tasks.map(([task, first]) => [...(fixes.get(task) ?? [])].reduce((n, [ts, count]) => n + (ts >= first.ts ? count : 0), 0));
    const armAssignments = [...assignmentTask.entries()]
      .filter(([, task]) => task !== null && since.has(task))
      .map(([id]) => receipts.get(id));
    const armReceipts = armAssignments
      .filter((receipt): receipt is NonNullable<typeof receipt> => receipt !== undefined);
    const mode = (receipt: ExperimentReceipt) => receipt.billing?.state === "observed" ? receipt.billing.value : undefined;
    const priced = (receipt: ExperimentReceipt) => {
      if (receipt.billingMode === "conflict") return undefined;
      if (mode(receipt) === "subscription") return receipt.notionalCost === null ? undefined : receipt.notionalCost ?? receipt.cost;
      if (mode(receipt) !== "api") return undefined;
      if (receipt.cashAccounting !== undefined) return receipt.cashAccounting.state === "observed" && receipt.cashAccounting.evidence.state === "complete"
        ? receipt.cashAccounting.evidence.usagePricedUsd : undefined;
      return receipt.cost; // Legacy reported cost remains historical, without invoice provenance.
    };
    return {
      arm,
      provider,
      tasks: tasks.length,
      merged: merged.size,
      mergeRate: tasks.length === 0 || omitted.merges ? null : merged.size / tasks.length,
      meanFixDispatches: omitted.fixTimes ? null : mean(fixCounts),
      medianWorkerMinutes: median(armReceipts.flatMap((receipt) => (receipt.minutes === undefined ? [] : [receipt.minutes]))),
      meanTokens: mean(armReceipts.flatMap((receipt) => (receipt.tokens === undefined ? [] : [receipt.tokens]))),
      meanCashCostUsd: mean(armReceipts.flatMap((receipt) => (priced(receipt) === undefined || mode(receipt) !== "api" ? [] : [priced(receipt)!]))),
      meanNotionalCostUsd: mean(armReceipts.flatMap((receipt) => (priced(receipt) === undefined || mode(receipt) !== "subscription" ? [] : [priced(receipt)!]))),
      costMissingAssignments: armAssignments.filter((receipt) => receipt === undefined || priced(receipt) === undefined || mode(receipt) === undefined).length,
      nonStarterAssignments: omitted.receipts ? null : armAssignments.filter((receipt) => receipt?.attempted !== true).length,
      requestEffortEvidence: summarizeCashRequestEfforts(armAssignments.map(receipt => receipt?.requestEfforts)),
      cashAccountingEvidence: summarizeCashAccounting(armAssignments.map(receipt => receipt?.cashAccounting)),
      executionEffortScope: executionEffortScope(armAssignments),
      receiptCoverage: {
        assignments: armAssignments.length,
        terminalAssignments: armReceipts.length,
        costKnownAssignments: armReceipts.filter((receipt) => priced(receipt) !== undefined && mode(receipt) !== undefined).length,
        servedModelKnownAssignments: armReceipts.filter((receipt) => receipt.servedModel?.state === "observed").length,
        outcomeKnownAssignments: armReceipts.filter((receipt) => receipt.success !== undefined).length,
      },
    };
  });
  return {
    id: experiment.id,
    startedOn: experiment.startedOn,
    revisitOn: experiment.revisitOn,
    revisitDue: today >= experiment.revisitOn,
    reviewCadence: experiment.reviewCadence ?? "scheduled",
    nextReviewOn: experiment.reviewCadence === "daily" && today >= experiment.revisitOn
      ? fixedClock(Date.parse(`${today}T00:00:00Z`) + 86_400_000).iso().slice(0, 10)
      : experiment.revisitOn,
    assignments: assignmentTask.size,
    evidence: { state: Object.values(omitted).some(Boolean) || assignmentConflicts || joinedBilling.conflicts ? "observed-partial" : "observed",
      keys: { tasks: firstArm.size, assignments: assignmentTask.size, receipts: receipts.size, merges: merges.size, fixTimes },
      omitted: { ...omitted }, assignmentConflicts, billing: joinedBilling, receiptCorpusBilling: { ...billing } },
    excludedAssignments,
    mixedTasks: [...armsSeen.values()].filter((seen) => seen.size > 1).length,
    crossoverTasks: crossed.size,
    sufficient: !Object.values(omitted).some(Boolean) && !assignmentConflicts && arms.every((arm) => arm.tasks >= experiment.minTasksPerArm),
    arms,
  };
  }
  return { observe, report };
}

/** The public batch API delegates to the canonical observer; it retains no raw history. */
export function evaluateRoutingExperiment(rows: Iterable<Row>, experiment: RoutingExperiment, today: string): ExperimentReport {
  const observer = routingExperimentObserver(experiment, today);
  for (const row of rows) observer.observe(row);
  return observer.report();
}

export interface RoutingAbCommandOpts {
  stateDir?: string;
  readRows?: (stateDir: string) => Promise<Row[]>;
  today?: string;
  print?: (line: string) => void;
}

/** `rmd routing-ab [--json]`: every live experiment's arms, read over the whole ledger union. */
export async function routingAbCommand(rest: string[], opts: RoutingAbCommandOpts = {}): Promise<number> {
  const print = opts.print ?? ((line: string) => console.log(line));
  const unknown = rest.filter((arg) => arg !== "--json");
  if (unknown.length > 0) {
    print(`usage: rmd routing-ab [--json] (unknown: ${unknown.join(" ")})`);
    return 2;
  }
  const stateDir = opts.stateDir ?? join(loadConfig().root, "state");
  const rows = await (opts.readRows ?? ((dir: string) => readLedgerUnionRecords(dir)))(stateDir);
  const today = opts.today ?? systemClock.iso().slice(0, 10);
  const reports = ROUTING_EXPERIMENTS.map((experiment) => evaluateRoutingExperiment(rows, experiment, today));
  if (rest.includes("--json")) {
    print(JSON.stringify({ stateDir, rowsRead: rows.length, reports }));
    return 0;
  }
  print(`state dir: ${stateDir} (${rows.length} ledger rows read)`);
  for (const report of reports) {
    const status = report.sufficient ? "measured" : "insufficient sample";
    print(`${report.id}: ${status}; ${report.assignments} assignments, ${report.mixedTasks} tasks in both arms, ${report.crossoverTasks} crossover tasks; ${report.excludedAssignments.genericUnit} generic units, ${report.excludedAssignments.changedTreatment} changed treatments and ${report.excludedAssignments.unverifiedTreatment} unverified treatments excluded; revisit ${report.revisitOn}${report.revisitDue ? " (DUE)" : ""}`);
    if (report.reviewCadence === "daily") print(`  daily provisional review; next ${report.nextReviewOn}; minimum sample and matched-cohort review required before a routing conclusion`);
    for (const arm of report.arms) {
      print(
        `  ${arm.arm} (${arm.provider}): ${arm.tasks} tasks, ${arm.merged} merged (${fmt(arm.mergeRate, 100, "%")}), ` +
          `${fmt(arm.meanFixDispatches)} fix dispatches/task, ${fmt(arm.medianWorkerMinutes)} min median, ` +
          `${fmt(arm.meanTokens, 1, "", 0)} tokens, $${fmt(arm.meanCashCostUsd, 1, "", 2)} cash, ` +
          `$${fmt(arm.meanNotionalCostUsd, 1, "", 2)} notional (${arm.costMissingAssignments} cost missing, ` +
          `${arm.nonStarterAssignments} without attempt receipt)`,
      );
    }
  }
  return 0;
}

function fmt(value: number | null, scale = 1, suffix = "", digits = 1): string {
  return value === null ? "n/a" : `${(value * scale).toFixed(digits)}${suffix}`;
}
