import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, type WorkerProviderId } from "./config.js";
import { fixedClock, systemClock } from "./clock.js";
import { readLedgerUnionRecords } from "./ledger-union.js";
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
  decision: { minimumDifference: number; power: number; confidence: number; stopOn: string };
}

function solVsSonnetEpochs(arm: string, codexModel: RegExp, startedOn: string): RoutingExperiment[] {
  return ["claude-sonnet-5-5", "claude-sonnet-5"].map((model) => ({
    id: `${arm}-vs-${model === "claude-sonnet-5-5" ? "sonnet55" : "sonnet5"}`,
    capability: "balanced", effort: "high",
    arms: { claude: "sonnet", codex: arm },
    claudeModel: new RegExp(`^${model}$`), codexModel,
    startedOn, revisitOn: startedOn, reviewCadence: "daily" as const, minTasksPerArm: 20,
    decision: { minimumDifference: 0.1, power: 0.8, confidence: 0.95, stopOn: "2026-12-10" },
  }));
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
    decision: { minimumDifference: 0.1, power: 0.8, confidence: 0.95, stopOn: "2026-12-10" },
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
    decision: { minimumDifference: 0.1, power: 0.8, confidence: 0.95, stopOn: "2026-12-10" },
  },
  // Each concrete Sol starts its own epoch against both Sonnets, read against one standard (W1-T13445).
  ...solVsSonnetEpochs("sol61", /^gpt-6\.1-sol$/, "2026-10-02"),
  ...solVsSonnetEpochs("sol62", /^gpt-6\.2-sol$/, "2026-11-17"),
  ...["low", "medium", "high"].map((effort) => ({
    id: `haiku55-vs-luna6-${effort}`, capability: "economy", effort,
    arms: { claude: "haiku55", codex: "luna6" },
    claudeModel: /^claude-haiku-5-5$/, codexModel: /^gpt-6-luna$/,
    startedOn: "2026-10-07", revisitOn: "2026-10-07", reviewCadence: "daily" as const,
    minTasksPerArm: 20,
    decision: { minimumDifference: 0.1, power: 0.8, confidence: 0.95, stopOn: "2026-12-10" },
  })),
];

type CodexArm = "control" | "paid";

export const CODEX_BALANCED_TRIAL_VERSION = "codex-balanced-trial-v1";
export const CODEX_BALANCED_TREATMENT_MODEL = "gpt-6.1-terra";
export const CODEX_BALANCED_ASSIGNMENT_METHOD = "sha256(benchmark-aa-allocation-v1, seed, taskId) parity";
const TRIAL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** PRIMARY CONTROL: the v1 A/A receipt validity window used by the paid-pilot receipt validator. */
const CODEX_AA_RECEIPT_MAX_AGE_MS = 24 * 3_600_000;
export const hashCodexBalancedTrial = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** The routing fields in the immutable registration written by benchmark-aa balanced. */
interface CodexTrialRegistration {
  version: typeof CODEX_BALANCED_TRIAL_VERSION;
  trialId: string;
  lead: string;
  digest: string;
  registeredAt: string;
  cash: { windowMs: number; subscriptionUsd: number };
  assignment: { unit: "task"; method: typeof CODEX_BALANCED_ASSIGNMENT_METHOD; allocation: Record<CodexArm, number> };
  aa: { receipt: { version: string; trialId: string; asOf: string; verdict: string; reportHash: string;
    stackHash: string; allocationReceiptHash: string } };
  pilotRequest: { pilotId: string; approval: { reference: string }; design: string; paired: unknown; reviewerReplay?: unknown;
    assignmentSeed: string; arms: Record<CodexArm, { provider: string; model: string; effort: string }>;
    population: { taskId: string }[] };
}

function readTrialJson<T extends object = Row>(path: string): T | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value as T : undefined;
  } catch (error) {
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export function readCodexBalancedTrialProtocols(stateDir: string): CodexTrialRegistration[] {
  let entries: string[];
  try { entries = readdirSync(stateDir); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const protocols: CodexTrialRegistration[] = [];
  for (const name of entries) {
    if (!name.startsWith(CODEX_BALANCED_TRIAL_VERSION + ".") || !name.endsWith(".json")) continue;
    const trialId = name.slice(CODEX_BALANCED_TRIAL_VERSION.length + 1, -5);
    if (!TRIAL_ID.test(trialId)) continue;
    const protocol = readTrialJson<CodexTrialRegistration>(join(stateDir, name));
    if (!protocol) continue;
    const { digest, ...body } = protocol;
    const request = protocol.pilotRequest;
    const control = request?.arms?.control;
    const paid = request?.arms?.paid;
    if (digest !== hashCodexBalancedTrial(body) || protocol.version !== CODEX_BALANCED_TRIAL_VERSION || protocol.trialId !== trialId
      || typeof protocol.lead !== "string" || !protocol.lead.endsWith("-sol")
      || typeof protocol.cash?.windowMs !== "number" || !Number.isFinite(protocol.cash.windowMs)
      || protocol.cash.windowMs <= 0 || protocol.cash.subscriptionUsd !== 0
      || protocol.assignment?.unit !== "task" || protocol.assignment.method !== CODEX_BALANCED_ASSIGNMENT_METHOD
      || protocol.assignment.allocation?.control !== 0.5 || protocol.assignment.allocation.paid !== 0.5
      || request?.pilotId !== trialId || request.approval?.reference !== "#7418" || request.design !== "unpaired"
      || request.paired !== null || request.reviewerReplay !== undefined
      || typeof request.assignmentSeed !== "string" || request.assignmentSeed === "" || !Array.isArray(request.population)
      || control?.provider !== "codex" || control.model !== protocol.lead || !["low", "medium"].includes(control.effort)
      || paid?.provider !== "codex" || paid.model !== CODEX_BALANCED_TREATMENT_MODEL || paid.effort !== control.effort) continue;
    protocols.push(protocol);
  }
  return protocols;
}

function guardrailPath(stateDir: string, digest: string): string {
  return join(stateDir, CODEX_BALANCED_TRIAL_VERSION + "." + digest + ".guardrail");
}

function codexBalancedTrialActive(stateDir: string, protocol: CodexTrialRegistration, now: number): boolean {
  const start = Date.parse(protocol.registeredAt);
  if (!(now >= start && now < start + protocol.cash.windowMs)
    || lstatSync(guardrailPath(stateDir, protocol.digest), { throwIfNoEntry: false }) !== undefined) return false;
  const cited = protocol.aa?.receipt;
  if (typeof cited?.trialId !== "string" || !TRIAL_ID.test(cited.trialId)) return false;
  const age = now - Date.parse(cited.asOf);
  if (!(age >= 0 && age <= CODEX_AA_RECEIPT_MAX_AGE_MS)) return false;
  const report = readTrialJson(join(stateDir, "benchmark-aa-prospective", cited.trialId,
    "calibration-receipt." + cited.trialId + ".json"));
  if (!report) return false;
  const { receipt, ...body } = report;
  const observed = receipt as (Partial<typeof cited> & { state?: string; winnerDeclared?: boolean }) | undefined;
  return body.version === "benchmark-aa-v1" && observed?.version === "benchmark-aa-receipt-v1"
    && cited.version === observed.version && observed.trialId === cited.trialId && observed.asOf === cited.asOf
    && observed.state === "observed" && observed.verdict === "no-integrity-concern-detected" && observed.verdict === cited.verdict
    && observed.winnerDeclared === false && observed.reportHash === cited.reportHash && observed.reportHash === hashCodexBalancedTrial(body)
    && observed.stackHash === cited.stackHash && observed.allocationReceiptHash === cited.allocationReceiptHash;
}

export function latchCodexBalancedGuardrail(stateDir: string, digest: string, reason: string): void {
  try { writeFileSync(guardrailPath(stateDir, digest), reason + "\n", { flag: "wx", mode: 0o600 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

export interface CodexRoutingExperiment {
  id: string;
  kind: "codex-vs-codex";
  capability: "balanced";
  effort: string;
  arms: Record<CodexArm, { provider: "codex"; model: RegExp; modelId: string }>;
  seed: string;
  allocation: CodexTrialRegistration["assignment"]["allocation"];
}

export function codexRoutingExperiment(protocol: CodexTrialRegistration): CodexRoutingExperiment {
  const pin = (id: CodexArm) => {
    const { model } = protocol.pilotRequest.arms[id];
    const escaped = model.replace(/[$.*+?^{}()|[\]\\]/g, "\\$&");
    return { provider: "codex" as const, model: new RegExp("^" + escaped + "$"), modelId: model };
  };
  return {
    id: `codex-balanced:${protocol.trialId}:${protocol.digest}`, kind: "codex-vs-codex",
    capability: "balanced", effort: protocol.pilotRequest.arms.control.effort,
    arms: { control: pin("control"), paid: pin("paid") },
    seed: protocol.pilotRequest.assignmentSeed, allocation: protocol.assignment.allocation,
  };
}

export interface CodexExperimentAssignment {
  id: string;
  trialId: string;
  protocolDigest: string;
  unit: "task";
  assignedArm: CodexArm;
  assignedProbability: number;
  assignedModel: string;
  seed: string;
}

export function codexExperimentArmForTask(input: {
  stateDir: string; taskId: string; provider: string; capability?: string; effort?: string;
  model?: string; currentSol?: string; nowMs?: number;
}): CodexExperimentAssignment | undefined {
  const taskId = experimentTaskIdentity(input.taskId);
  if (input.provider !== "codex" || input.capability !== "balanced" || !["low", "medium"].includes(input.effort ?? "")
    || taskId === undefined || input.currentSol === undefined || input.model !== input.currentSol) return undefined;
  let matches: CodexTrialRegistration[];
  try {
    const now = input.nowMs ?? systemClock.now();
    matches = readCodexBalancedTrialProtocols(input.stateDir).filter(protocol =>
      protocol.pilotRequest.arms.control.effort === input.effort
      && protocol.lead === input.currentSol
      && protocol.pilotRequest.population.some(task => task?.taskId === taskId)
      && codexBalancedTrialActive(input.stateDir, protocol, now));
  } catch (error) {
    // Stand down on unreadable registration or guardrail state. The ordinary Codex selection still serves.
    console.error("codex balanced trial state unreadable", (error as NodeJS.ErrnoException).code ?? "unknown");
    return undefined;
  }
  if (matches.length !== 1) return undefined;
  const protocol = matches[0]!;
  const experiment = codexRoutingExperiment(protocol);
  const { arm, probability } = experimentArmForTask(experiment, taskId);
  return { id: experiment.id, trialId: protocol.trialId, protocolDigest: protocol.digest, unit: "task",
    assignedArm: arm, assignedProbability: probability, assignedModel: experiment.arms[arm].modelId, seed: experiment.seed };
}

type CodexAssignmentIdentity = { runId?: string; taskId: string; assignmentId: string; requestedModel?: string };

export function intentionToTreatRow(
  identity: CodexAssignmentIdentity, assignment: CodexExperimentAssignment, receipt?: {
    servedModel: string | null; servedModelReason?: string; servedModelSource?: string;
    costUsd?: number; success: boolean; guardrail?: string;
  },
) {
  return {
    run_id: identity.runId ?? "unattributed", task_id: identity.taskId,
    assignment_id: identity.assignmentId, experiment: assignment, requested_model: identity.requestedModel,
    ...(receipt && {
      served_model: receipt.servedModel, served_model_reason: receipt.servedModelReason, served_model_source: receipt.servedModelSource,
      billing_mode: "subscription", observed_cost_usd: receipt.costUsd ?? null, success: receipt.success,
      crossover: receipt.servedModel === null ? null : receipt.servedModel !== assignment.assignedModel,
      guardrail: receipt.guardrail,
    }),
  };
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
export function experimentDrawSeed(experiment: RoutingExperiment | CodexRoutingExperiment, taskId: string): RoutingDrawSeed {
  return {
    unit: "task",
    taskId,
    attempt: "every-attempt",
    point: `experiment:${experiment.id}`,
    order: "kind" in experiment ? ["codex"] : Object.keys(experiment.arms) as WorkerProviderId[],
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
export function experimentArmForTask(experiment: RoutingExperiment, taskId: string): { arm: string; probability: number };
export function experimentArmForTask(experiment: CodexRoutingExperiment, taskId: string): { arm: CodexArm; probability: number };
export function experimentArmForTask(experiment: RoutingExperiment | CodexRoutingExperiment, taskId: string): { arm: string; probability: number } {
  const seed = experimentDrawSeed(experiment, taskId);
  if ("kind" in experiment) {
    // Use the registration's benchmark A/B parity draw, including its arm order.
    const parity = createHash("sha256").update(["benchmark-aa-allocation-v1", experiment.seed, seed.taskId].join("\0"))
      .digest().readUInt32BE(0) % 2;
    const arm = parity === 0 ? "paid" : "control";
    return { arm, probability: experiment.allocation[arm] };
  }
  const arms = Object.values(experiment.arms) as string[];
  const { value } = routingDrawValue(seed);
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
  infrastructureAttempts: number;
  infrastructureOnlyTasks: number;
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
export function evaluateRoutingExperiment(
  rows: Iterable<Row>, experiment: RoutingExperiment, today: string,
  classifyAttempt: RoutingAbCommandOpts["classifyAttempt"],
): ExperimentReport {
  const firstArm = new Map<string, { arm: string; provider: WorkerProviderId; ts: string }>();
  const armsSeen = new Map<string, Set<string>>();
  const crossed = new Set<string>();
  const assignmentTask = new Map<string, string>();
  const receipts = new Map<string, { attribution?: ReturnType<RoutingAbCommandOpts["classifyAttempt"]>; minutes?: number; tokens?: number; cost?: number; notionalCost?: number | null; billingMode?: "api" | "subscription"; attempted?: true; servedModel?: string; success?: boolean; requestEfforts?: CashRequestEffortEvidence }>();
  const excludedAssignments = { genericUnit: 0, changedTreatment: 0, unverifiedTreatment: 0 };
  const merges: Array<{ task: string; ts: string }> = [];
  const fixes: Array<{ task: string; ts: string }> = [];
  for (const row of rows) {
    const step = str(row.step);
    const task = str(row.task_id);
    const ts = str(row.ts) ?? "";
    if (step === "worker.assignment" && task) {
      const assignment = row.worker_assignment as Row | undefined;
      const routing = assignment?.routing as Row | undefined;
      const decision = routing?.decision as Row | undefined;
      if (decision?.ab !== experiment.id) continue;
      if (experimentTaskIdentity(task) === undefined) { excludedAssignments.genericUnit += 1; continue; }
      const considered = Array.isArray(decision.considered) ? decision.considered as Row[] : [];
      const claudeCandidate = considered.find((candidate) => candidate.provider === "claude");
      const candidateModel = str(claudeCandidate?.model);
      if (candidateModel === undefined) { excludedAssignments.unverifiedTreatment += 1; continue; }
      if (!experiment.claudeModel.test(candidateModel)) {
        excludedAssignments.changedTreatment += 1;
        continue;
      }
      const provider = str((assignment?.selected as Row | undefined)?.provider) as WorkerProviderId | undefined;
      const itt = routing?.experiment as Row | undefined;
      // A row carrying its intention-to-treat record counts under its ASSIGNED arm; an older row, its served one.
      const arm = str(itt?.assignedArm) ?? (provider ? experiment.arms[provider] : undefined);
      if (!provider || !arm) continue;
      if (itt?.crossover === true) crossed.add(task);
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
    const receiptId = str(row.selection_assignment_id);
    if (receiptId && (step === "worker.attempt" || step === "verdict" || step?.endsWith(".done"))) {
      const prior = receipts.get(receiptId) ?? {};
      const duration = num(row.worker_duration_ms);
      receipts.set(receiptId, {
        ...prior,
        ...(step === "worker.attempt" ? { attempted: true as const, attribution: classifyAttempt(row) } : {}),
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
  const taskAssignments = new Map<string, string[]>();
  for (const [id, task] of assignmentTask) {
    const ids = taskAssignments.get(task) ?? [];
    ids.push(id);
    taskAssignments.set(task, ids);
  }
  const infrastructureOnly = new Set([...taskAssignments].filter(([, ids]) =>
    ids.every(id => receipts.get(id)?.attribution?.outcome === "infrastructure")).map(([task]) => task));
  const arms = (Object.entries(experiment.arms) as Array<[WorkerProviderId, string]>).map(([provider, arm]): ExperimentArmReport => {
    const assignedTasks = [...firstArm.entries()].filter(([, first]) => first.arm === arm);
    const tasks = assignedTasks.filter(([task]) => !infrastructureOnly.has(task));
    const since = new Map(tasks.map(([task, first]) => [task, first.ts]));
    const merged = new Set(merges.filter((merge) => since.has(merge.task) && merge.ts >= since.get(merge.task)!).map((merge) => merge.task));
    const fixCounts = tasks.map(([task, first]) => fixes.filter((fix) => fix.task === task && fix.ts >= first.ts).length);
    const armAssignments = [...assignmentTask.entries()]
      .filter(([, task]) => firstArm.get(task)?.arm === arm)
      .map(([id]) => receipts.get(id));
    const allReceipts = armAssignments
      .filter((receipt): receipt is NonNullable<typeof receipt> => receipt !== undefined);
    const armReceipts = allReceipts.filter(receipt => receipt.attribution?.outcome !== "infrastructure");
    const priced = (receipt: NonNullable<typeof armAssignments[number]>) => receipt.billingMode === "subscription"
      ? receipt.notionalCost === null ? undefined : receipt.notionalCost ?? receipt.cost : receipt.cost;
    return {
      arm,
      provider,
      tasks: tasks.length,
      infrastructureAttempts: allReceipts.length - armReceipts.length,
      infrastructureOnlyTasks: assignedTasks.length - tasks.length,
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
        terminalAssignments: allReceipts.length,
        costKnownAssignments: allReceipts.filter((receipt) => priced(receipt) !== undefined && receipt.billingMode !== undefined).length,
        servedModelKnownAssignments: allReceipts.filter((receipt) => receipt.servedModel !== undefined).length,
        outcomeKnownAssignments: allReceipts.filter((receipt) => receipt.success !== undefined).length,
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
  classifyAttempt: (row: Readonly<Row>) => { outcome: string; signal: string };
  stateDir?: string;
  readRows?: (stateDir: string) => Promise<Row[]>;
  today?: string;
  print?: (line: string) => void;
}

function codexExperimentReports(rows: readonly Row[]) {
  const epochs = new Map<string, { assignments: Map<string, Row>; receipts: Map<string, Row> }>();
  for (const row of rows) {
    const isAssignment = row.step === "codex_experiment.assignment";
    if (!isAssignment && row.step !== "codex_experiment.receipt") continue;
    const id = str((row.experiment as Partial<CodexExperimentAssignment> | undefined)?.id);
    const assignmentId = str(row.assignment_id);
    if (!id || !assignmentId) continue;
    const epoch = epochs.get(id) ?? { assignments: new Map<string, Row>(), receipts: new Map<string, Row>() };
    (isAssignment ? epoch.assignments : epoch.receipts).set(assignmentId, row);
    epochs.set(id, epoch);
  }
  return [...epochs.entries()].map(([id, { assignments, receipts }]) => {
    const firstByTask = new Map<string, Row>();
    for (const row of assignments.values()) {
      const task = str(row.task_id);
      if (task && (!firstByTask.has(task) || String(row.ts) < String(firstByTask.get(task)?.ts))) firstByTask.set(task, row);
    }
    const merged = new Set(rows.filter(row => row.step === "verdict.merged" && firstByTask.has(String(row.task_id))
      && String(row.ts) >= String(firstByTask.get(String(row.task_id))?.ts)).map(row => row.task_id));
    const arms = (["control", "paid"] as const).map(arm => {
      const tasks = [...firstByTask.entries()].filter(([, row]) => (row.experiment as CodexExperimentAssignment).assignedArm === arm);
      return { arm, model: (tasks[0]?.[1].experiment as CodexExperimentAssignment | undefined)?.assignedModel ?? null,
        tasks: tasks.length, merged: tasks.filter(([task]) => merged.has(task)).length };
    });
    const matched = [...assignments.keys()].map(id => receipts.get(id));
    return { id, assignments: assignments.size, arms,
      crossovers: matched.filter(receipt => receipt?.crossover === true).length,
      missingServedModel: matched.filter(receipt => str(receipt?.served_model) === undefined).length,
      guardrails: [...new Set(matched.flatMap(receipt => str(receipt?.guardrail) ?? []))],
    };
  });
}

/** `rmd routing-ab [--json]`: every live experiment's arms, read over the whole ledger union. */
export async function routingAbCommand(rest: string[], opts: RoutingAbCommandOpts): Promise<number> {
  const print = opts.print ?? ((line: string) => console.log(line));
  const unknown = rest.filter((arg) => arg !== "--json");
  if (unknown.length > 0) {
    print(`usage: rmd routing-ab [--json] (unknown: ${unknown.join(" ")})`);
    return 2;
  }
  const stateDir = opts.stateDir ?? join(loadConfig().root, "state");
  const rows = await (opts.readRows ?? ((dir: string) => readLedgerUnionRecords(dir)))(stateDir);
  const today = opts.today ?? systemClock.iso().slice(0, 10);
  const reports = ROUTING_EXPERIMENTS.map((experiment) => evaluateRoutingExperiment(rows, experiment, today, opts.classifyAttempt));
  const codexReports = codexExperimentReports(rows);
  if (rest.includes("--json")) {
    print(JSON.stringify({ stateDir, rowsRead: rows.length, reports, ...(codexReports.length > 0 && { codexReports }) }));
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
          `${arm.nonStarterAssignments} without attempt receipt); ` +
          `${arm.infrastructureAttempts} infrastructure attempts, ${arm.infrastructureOnlyTasks} infrastructure-only tasks excluded`,
      );
    }
  }
  for (const report of codexReports) {
    print(`${report.id}: ${report.assignments} assignments, ${report.crossovers} crossovers, ${report.missingServedModel} without served-model evidence`);
    for (const arm of report.arms) print(`  ${arm.arm} (${arm.model ?? "unobserved"}): ${arm.tasks} tasks, ${arm.merged} merged`);
    if (report.guardrails.length > 0) print(`  guardrails fired: ${report.guardrails.join(", ")}`);
  }
  return 0;
}

function fmt(value: number | null, scale = 1, suffix = "", digits = 1): string {
  return value === null ? "n/a" : `${(value * scale).toFixed(digits)}${suffix}`;
}
