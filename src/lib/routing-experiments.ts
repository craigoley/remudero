import { join } from "node:path";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { loadConfig, type WorkerProviderId } from "./config.js";
import { fixedClock, systemClock } from "./clock.js";
import { readLedgerUnionRecords, readLedgerUnionRecordsSync } from "./ledger-union.js";
import { seededRandom, seedOf } from "./knowledge-value.js";
import { mergeCashRequestEfforts, summarizeCashRequestEfforts, type CashRequestEffortEvidence } from "./cash-request-effort.js";

export interface RoutingDrawKey {
  unit: "spawn" | "task";
  taskId: string;
  attempt: string;
  point: string;
}

export interface RoutingDrawSeed extends RoutingDrawKey {
  order?: readonly WorkerProviderId[];
}

export function routingDrawSeed(key: RoutingDrawKey): number {
  return seedOf(["routing-draw/v1", key.unit, key.taskId, key.attempt, key.point].join("\u0000"));
}

export function routingDrawValue(key: RoutingDrawKey): { value: number; seed: string } {
  const seed = routingDrawSeed(key);
  return { value: seededRandom(seed)(), seed: seed.toString(16).padStart(8, "0") };
}

// The v1 disk contract is read here without importing its command layer, which depends on workers.
interface CodexTrialRegistration {
  version: "codex-balanced-trial-v1";
  trialId: string;
  registeredAt: string;
  lead: string;
  digest: string;
  assignment: { unit: string; method: string; allocation: Record<"control" | "paid", number> };
  stoppingRule: string;
  cash: { windowMs: number };
  aa: { receipt: { version: string; trialId: string; asOf: string; verdict: string;
    stackHash: string; allocationReceiptHash: string; reportHash: string } };
  pilotRequest: { version: string; pilotId: string; design: string; paired: unknown; reviewerReplay?: unknown;
    approval: { reference: string }; assignmentSeed: string; population: { taskId: string }[];
    arms: Record<"control" | "paid", { provider: string; model: string; effort: string }> };
}
const trialHash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
// PRIMARY CONTROL: v1 registration's A/A citation expires after 24 hours, as benchmark-paid-pilot specifies.
const CODEX_AA_MAX_AGE_MS = 24 * 3_600_000;

function codexAaRefusal(stateDir: string, protocol: CodexTrialRegistration, now: number): string | undefined {
  const cited = protocol.aa.receipt;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(cited.trialId)) return "aa-trial-id-invalid";
  const { receipt, ...body } = JSON.parse(readFileSync(join(stateDir, "benchmark-aa-prospective", cited.trialId,
    `calibration-receipt.${cited.trialId}.json`), "utf8"));
  if (body.version !== "benchmark-aa-v1" || receipt?.version !== "benchmark-aa-receipt-v1"
    || receipt.reportHash !== trialHash(body)) return "aa-receipt-invalid";
  if ([cited, receipt].some(row => !(now >= Date.parse(row.asOf) && now - Date.parse(row.asOf) <= CODEX_AA_MAX_AGE_MS)))
    return "aa-receipt-stale";
  if (receipt.state !== "observed" || receipt.verdict !== "no-integrity-concern-detected" || receipt.winnerDeclared !== false
    || cited.verdict !== "no-integrity-concern-detected") return "aa-receipt-not-passing";
  if (["trialId", "stackHash", "allocationReceiptHash"].some(key => receipt[key] !== cited[key as keyof typeof cited]))
    return "aa-citation-mismatch";
  return undefined;
}

function codexControlRefusal(stateDir: string, trialId: string): string | undefined {
  let text: string;
  try { text = readFileSync(join(stateDir, `benchmark-paid-pilot-v1.${trialId}.controls.ndjson`), "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return `controls-unreadable:${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`;
  }
  let paused = false;
  for (const line of text.split("\n").filter(line => line.trim())) {
    const row = JSON.parse(line);
    if (row.version !== "benchmark-paid-pilot-control-v1" || row.pilotId !== trialId
      || (row.action !== "pause" && row.action !== "resume")) return "controls-malformed";
    paused = row.action === "pause";
  }
  return paused ? "operator-paused" : undefined;
}

/**
 * Live routing experiments (operator ruling 2026-09-24, DECISIONS.md). An assignment joins an
 * experiment only when the auction could genuinely have picked EITHER arm: both providers were
 * eligible and the codex arm was serving the experiment's model. Headroom still weighs the served
 * provider; the task alone fixes the assigned arm (W1-T4617), so a retry never re-randomises it.
 */
export interface ProviderRoutingExperiment {
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

export const ROUTING_EXPERIMENTS: readonly ProviderRoutingExperiment[] = [
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

export interface CodexRoutingExperiment extends Omit<ProviderRoutingExperiment, "arms" | "claudeModel" | "codexModel"> {
  kind: "codex-vs-codex";
  modelArms: Record<"control" | "paid", { provider: "codex"; model: RegExp; modelId: string }>;
}

export type RoutingExperiment = ProviderRoutingExperiment | CodexRoutingExperiment;
const isCodexEpoch = (experiment: RoutingExperiment): experiment is CodexRoutingExperiment => "kind" in experiment && experiment.kind === "codex-vs-codex";

export const CODEX_ROUTING_EXPERIMENTS: readonly CodexRoutingExperiment[] = ["low", "medium"].map(effort => ({
  id: `sol61-vs-terra61-balanced-${effort}`, kind: "codex-vs-codex", capability: "balanced", effort,
  modelArms: { control: { provider: "codex", model: /^gpt-6\.1-sol$/, modelId: "gpt-6.1-sol" },
    paid: { provider: "codex", model: /^gpt-6\.1-terra$/, modelId: "gpt-6.1-terra" } },
  startedOn: "2026-10-27", revisitOn: "2026-10-27", reviewCadence: "daily", minTasksPerArm: 20,
}));

export interface CodexExperimentAssignment {
  id: string;
  trialId: string;
  protocolDigest: string;
  unit: "task";
  assignedArm: "control" | "paid";
  assignedProbability: number;
  assignedModel: string;
  seed: string;
  drawKey: RoutingDrawSeed;
}

export type CodexExperimentDecision = { state: "assigned"; assignment: CodexExperimentAssignment }
  | { state: "inactive"; reason: string };

/** Read the immutable registration and current safety evidence anew on every admission. */
export async function codexExperimentArmForTask(input: { stateDir: string; taskId?: string; provider?: string;
  capability?: string; effort?: string; model?: string; nowMs?: number }): Promise<CodexExperimentDecision> {
  const inactive = (reason: string): CodexExperimentDecision => ({ state: "inactive", reason });
  const epoch = CODEX_ROUTING_EXPERIMENTS.find(row => row.capability === input.capability && row.effort === input.effort);
  const taskId = experimentTaskIdentity(input.taskId);
  if (input.provider !== "codex" || !epoch || !taskId || !epoch.modelArms.control.model.test(input.model ?? ""))
    return inactive("outside-trial-population");
  const now = input.nowMs ?? systemClock.now();
  try {
    const names = readdirSync(input.stateDir).filter(name => name.startsWith("codex-balanced-trial-v1.") && name.endsWith(".json"));
    const eligible: CodexTrialRegistration[] = [];
    for (const name of names) {
      const protocol = JSON.parse(readFileSync(join(input.stateDir, name), "utf8")) as CodexTrialRegistration;
      const { digest, ...body } = protocol;
      if (digest !== trialHash(body)
        || protocol.version !== "codex-balanced-trial-v1" || protocol.lead !== epoch.modelArms.control.modelId)
        return inactive("registration-invalid");
      const request = protocol.pilotRequest;
      if (!Array.isArray(request.population) || request.population.length === 0) return inactive("population-missing");
      if (request.arms.control.effort !== input.effort || !request.population.some(task => task.taskId === taskId)) continue;
      if (request.version !== "benchmark-paid-pilot-request-v1" || request.pilotId !== protocol.trialId
        || request.design !== "unpaired" || request.paired !== null || request.reviewerReplay !== undefined
        || !request.assignmentSeed || request.approval.reference !== "#7418"
        || Object.entries(epoch.modelArms).some(([arm, pin]) => {
          const registered = request.arms[arm as "control" | "paid"];
          return registered.provider !== pin.provider || !pin.model.test(registered.model) || registered.effort !== input.effort;
        }) || protocol.assignment.unit !== "task" || protocol.assignment.method !== "sha256(benchmark-aa-allocation-v1, seed, taskId) parity"
        || protocol.assignment.allocation.control !== 0.5 || protocol.assignment.allocation.paid !== 0.5
        || protocol.stoppingRule !== "fixed horizon: one analysis at expiry plus the maturity window; no interim winner") return inactive("registration-pins-invalid");
      if (!(now >= Date.parse(protocol.registeredAt) && now < Date.parse(protocol.registeredAt) + protocol.cash.windowMs))
        return inactive("stopping-rule-fired");
      const aaRefusal = codexAaRefusal(input.stateDir, protocol, now);
      if (aaRefusal) return inactive(aaRefusal);
      const controlRefusal = codexControlRefusal(input.stateDir, protocol.trialId);
      if (controlRefusal) return inactive(controlRefusal);
      eligible.push(protocol);
    }
    if (eligible.length !== 1) return inactive(eligible.length === 0 ? "no-registered-protocol" : "overlapping-protocols");
    const protocol = eligible[0]!;
    const evidence = readLedgerUnionRecordsSync(input.stateDir, { refuseIncomplete: true, since: protocol.registeredAt });
    if (!evidence.ok || evidence.torn > 0) return inactive("guardrail-evidence-unreadable");
    if (evidence.rows.some(row => row.step === "codex_experiment.guardrail" && row.trial_id === protocol.trialId && row.fired === true))
      return inactive("guardrail-fired");
    const assignments = new Set(evidence.rows.filter(row => row.step === "codex_experiment.assignment"
      && (row.experiment as CodexExperimentAssignment | undefined)?.trialId === protocol.trialId).map(row => row.assignment_id));
    const receipts = evidence.rows.filter(row => row.step === "codex_experiment.receipt" && assignments.has(row.assignment_id));
    if (receipts.some(row => typeof row.served_model !== "string" || row.billing_mode !== "subscription"
      || (Object.hasOwn(row, "total_cost_usd") ? row.total_cost_usd : row.cost_usd) !== 0 || row.guardrail_fired === true))
      return inactive("guardrail-fired");
    const assigned = experimentArmForTask(epoch, taskId, protocol);
    const assignedArm = assigned.arm as "control" | "paid";
    return { state: "assigned", assignment: { id: epoch.id, trialId: protocol.trialId, protocolDigest: protocol.digest,
      unit: "task", assignedArm, assignedProbability: assigned.probability, assignedModel: epoch.modelArms[assignedArm].modelId,
      seed: protocol.pilotRequest.assignmentSeed, drawKey: experimentDrawSeed(epoch, taskId) } };
  } catch (error) {
    return inactive(`trial-evidence-unreadable:${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`);
  }
}

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
  experiments: readonly ProviderRoutingExperiment[] = ROUTING_EXPERIMENTS,
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
    order: isCodexEpoch(experiment) ? ["codex"] : Object.keys(experiment.arms) as WorkerProviderId[],
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
export function experimentArmForTask(experiment: RoutingExperiment, taskId: string,
  protocol?: CodexTrialRegistration): { arm: string; probability: number } {
  if (isCodexEpoch(experiment)) {
    if (!protocol) throw new Error("Codex task assignment requires a registered protocol");
    const task = experimentDrawSeed(experiment, taskId).taskId;
    const parity = createHash("sha256").update(`benchmark-aa-allocation-v1\0${protocol.pilotRequest.assignmentSeed}\0${task}`).digest().readUInt32BE(0) % 2;
    const arm = parity === 0 ? "paid" : "control";
    return { arm, probability: protocol.assignment.allocation[arm] };
  }
  const arms = Object.values(experiment.arms) as string[];
  const { value } = routingDrawValue(experimentDrawSeed(experiment, taskId));
  return { arm: arms[Math.min(arms.length - 1, Math.floor(value * arms.length))]!, probability: 1 / arms.length };
}

/** The ITT record for one tagged decision, or undefined when the id names no live experiment. */
export function experimentIntentionToTreat(
  experimentId: string,
  taskId: string,
  served: WorkerProviderId,
  experiments: readonly ProviderRoutingExperiment[] = ROUTING_EXPERIMENTS,
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
  nonStarterAssignments: number;
  requestEffortEvidence: ReturnType<typeof summarizeCashRequestEfforts>;
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
export function evaluateRoutingExperiment(rows: Iterable<Row>, experiment: RoutingExperiment, today: string): ExperimentReport {
  const firstArm = new Map<string, { arm: string; provider: WorkerProviderId; ts: string }>();
  const armsSeen = new Map<string, Set<string>>();
  const crossed = new Set<string>();
  const assignmentTask = new Map<string, string>();
  const receipts = new Map<string, { minutes?: number; tokens?: number; cost?: number; notionalCost?: number | null; billingMode?: "api" | "subscription"; attempted?: true; servedModel?: string; success?: boolean; requestEfforts?: CashRequestEffortEvidence }>();
  const excludedAssignments = { genericUnit: 0, changedTreatment: 0, unverifiedTreatment: 0 };
  const merges: Array<{ task: string; ts: string }> = [];
  const fixes: Array<{ task: string; ts: string }> = [];
  for (const row of rows) {
    const step = str(row.step);
    const task = str(row.task_id);
    const ts = str(row.ts) ?? "";
    if ((step === "worker.assignment" || step === "codex_experiment.assignment") && task) {
      const assignment = (step === "codex_experiment.assignment" ? {
        id: row.assignment_id, selected: { provider: "codex", model: row.requested_model },
        routing: { decision: { ab: (row.experiment as Row)?.id }, experiment: row.experiment },
      } : row.worker_assignment) as Row | undefined;
      const routing = assignment?.routing as Row | undefined;
      const decision = routing?.decision as Row | undefined;
      if (decision?.ab !== experiment.id) continue;
      if (experimentTaskIdentity(task) === undefined) { excludedAssignments.genericUnit += 1; continue; }
      const considered = Array.isArray(decision.considered) ? decision.considered as Row[] : [];
      const claudeCandidate = considered.find((candidate) => candidate.provider === "claude");
      const candidateModel = isCodexEpoch(experiment) ? str((assignment?.selected as Row)?.model) : str(claudeCandidate?.model);
      if (candidateModel === undefined) { excludedAssignments.unverifiedTreatment += 1; continue; }
      if (isCodexEpoch(experiment) ? !Object.values(experiment.modelArms).some(pin => pin.model.test(candidateModel)) : !experiment.claudeModel.test(candidateModel)) {
        excludedAssignments.changedTreatment += 1;
        continue;
      }
      const provider = str((assignment?.selected as Row | undefined)?.provider) as WorkerProviderId | undefined;
      const itt = routing?.experiment as Row | undefined;
      // A row carrying its intention-to-treat record counts under its ASSIGNED arm; an older row, its served one.
      const arm = str(itt?.assignedArm) ?? (provider && !isCodexEpoch(experiment) ? experiment.arms[provider] : undefined);
      if (!provider || !arm) continue;
      if (itt?.crossover === true || (isCodexEpoch(experiment) && row.crossover === true)) crossed.add(task);
      const id = str(assignment?.id);
      if (id) assignmentTask.set(id, task);
      const seen = armsSeen.get(task) ?? new Set<string>();
      seen.add(arm);
      armsSeen.set(task, seen);
      const first = firstArm.get(task);
      if (!first || ts < first.ts) firstArm.set(task, { arm, provider, ts });
    } else if (step === "verdict.merged" && task) {
      merges.push({ task, ts });
    } else if (step === "fix.dispatch" && task) {
      fixes.push({ task, ts });
    }
    const receiptId = str(step === "codex_experiment.receipt" ? row.assignment_id : row.selection_assignment_id);
    if (receiptId && (step === "worker.attempt" || step === "codex_experiment.receipt" || step === "verdict" || step?.endsWith(".done"))) {
      const prior = receipts.get(receiptId) ?? {};
      const duration = num(row.worker_duration_ms);
      receipts.set(receiptId, {
        ...prior,
        ...((step === "worker.attempt" || step === "codex_experiment.receipt") ? { attempted: true as const } : {}),
        ...(duration !== undefined ? { minutes: duration / 60_000 } : {}),
        ...(tokenTotal(row.tokens) !== undefined ? { tokens: tokenTotal(row.tokens) } : {}),
        ...(cost(row.total_cost_usd) !== undefined ? { cost: cost(row.total_cost_usd) }
          : cost(row.cost_usd) !== undefined ? { cost: cost(row.cost_usd) } : {}),
        ...(Object.hasOwn(row, "notional_cost_usd") ? { notionalCost: cost(row.notional_cost_usd) ?? null } : {}),
        ...(row.billing_mode === "api" || row.billing_mode === "subscription" ? { billingMode: row.billing_mode } : {}),
        ...(str(row.served_model)?.trim() ? { servedModel: str(row.served_model) } : {}),
        ...(typeof row.success === "boolean" ? { success: row.success } : {}),
        ...(Object.hasOwn(row, "request_efforts") ? { requestEfforts: mergeCashRequestEfforts(prior.requestEfforts, row.request_efforts) } : {}),
      });
    }
  }
  const armEntries: Array<[WorkerProviderId, string]> = isCodexEpoch(experiment)
    ? Object.keys(experiment.modelArms).map(arm => ["codex", arm])
    : Object.entries(experiment.arms) as Array<[WorkerProviderId, string]>;
  const arms = armEntries.map(([provider, arm]): ExperimentArmReport => {
    const tasks = [...firstArm.entries()].filter(([, first]) => first.arm === arm);
    const since = new Map(tasks.map(([task, first]) => [task, first.ts]));
    const merged = new Set(merges.filter((merge) => since.has(merge.task) && merge.ts >= since.get(merge.task)!).map((merge) => merge.task));
    const fixCounts = tasks.map(([task, first]) => fixes.filter((fix) => fix.task === task && fix.ts >= first.ts).length);
    const armAssignments = [...assignmentTask.entries()]
      .filter(([, task]) => since.has(task))
      .map(([id]) => receipts.get(id));
    const armReceipts = armAssignments
      .filter((receipt): receipt is NonNullable<typeof receipt> => receipt !== undefined);
    const priced = (receipt: NonNullable<typeof armAssignments[number]>) => receipt.billingMode === "subscription"
      ? receipt.notionalCost === null ? undefined : receipt.notionalCost ?? receipt.cost : receipt.cost;
    return {
      arm,
      provider,
      tasks: tasks.length,
      merged: merged.size,
      mergeRate: tasks.length === 0 ? null : merged.size / tasks.length,
      meanFixDispatches: mean(fixCounts),
      medianWorkerMinutes: median(armReceipts.flatMap((receipt) => (receipt.minutes === undefined ? [] : [receipt.minutes]))),
      meanTokens: mean(armReceipts.flatMap((receipt) => (receipt.tokens === undefined ? [] : [receipt.tokens]))),
      meanCashCostUsd: mean(armReceipts.flatMap((receipt) => (receipt.cost === undefined || receipt.billingMode !== "api" ? [] : [receipt.cost]))),
      meanNotionalCostUsd: mean(armReceipts.flatMap((receipt) => (priced(receipt) === undefined || receipt.billingMode !== "subscription" ? [] : [priced(receipt)!]))),
      costMissingAssignments: armAssignments.filter((receipt) => receipt === undefined || priced(receipt) === undefined || receipt.billingMode === undefined).length,
      nonStarterAssignments: armAssignments.filter((receipt) => receipt?.attempted !== true).length,
      requestEffortEvidence: summarizeCashRequestEfforts(armAssignments.map(receipt => receipt?.requestEfforts)),
      receiptCoverage: {
        assignments: armAssignments.length,
        terminalAssignments: armReceipts.length,
        costKnownAssignments: armReceipts.filter((receipt) => priced(receipt) !== undefined && receipt.billingMode !== undefined).length,
        servedModelKnownAssignments: armReceipts.filter((receipt) => receipt.servedModel !== undefined).length,
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
    excludedAssignments,
    mixedTasks: [...armsSeen.values()].filter((seen) => seen.size > 1).length,
    crossoverTasks: crossed.size,
    sufficient: arms.every((arm) => arm.tasks >= experiment.minTasksPerArm),
    arms,
  };
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
  const reports = [...ROUTING_EXPERIMENTS, ...CODEX_ROUTING_EXPERIMENTS].map((experiment) => evaluateRoutingExperiment(rows, experiment, today));
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
