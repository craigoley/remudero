import { join } from "node:path";
import { loadConfig, type WorkerProviderId } from "./config.js";
import { systemClock } from "./clock.js";
import { readLedgerUnionRecords } from "./ledger-union.js";

/**
 * Live routing experiments (operator ruling 2026-09-24, DECISIONS.md). An assignment joins an
 * experiment only when the auction could genuinely have picked EITHER arm: both providers were
 * eligible and the codex arm was serving the experiment's model. Headroom, not the task, then
 * decided the arm, so the arms compare like-for-like.
 */
export interface RoutingExperiment {
  id: string;
  capability: string;
  effort: string;
  /** provider -> arm label. */
  arms: Partial<Record<WorkerProviderId, string>>;
  codexModel: RegExp;
  startedOn: string;
  revisitOn: string;
  /** Fewer tasks than this in either arm is reported as an insufficient sample, never a verdict. */
  minTasksPerArm: number;
}

export const ROUTING_EXPERIMENTS: readonly RoutingExperiment[] = [
  {
    id: "sol-vs-sonnet",
    capability: "balanced",
    effort: "high",
    arms: { claude: "sonnet", codex: "sol" },
    codexModel: /^gpt-6-sol$/,
    startedOn: "2026-09-24",
    revisitOn: "2026-10-08",
    // W1-T3570's admission bar for a cash lane, reused so both trials read against one standard.
    minTasksPerArm: 20,
  },
];

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
      return provider !== "codex" || experiment.codexModel.test(entry.model ?? "");
    });
  })?.id;
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
  meanNotionalCostUsd: number | null;
}

export interface ExperimentReport {
  id: string;
  startedOn: string;
  revisitOn: string;
  revisitDue: boolean;
  assignments: number;
  /** Tasks whose tagged assignments landed in BOTH arms; counted under their first arm. */
  mixedTasks: number;
  sufficient: boolean;
  arms: ExperimentArmReport[];
}

type Row = Record<string, unknown>;

const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const num = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
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
  return (num(tokens.input) ?? 0) + (num(tokens.output) ?? 0);
}

/** One pass over ledger rows: tagged assignments, their receipts, fix dispatches and merges per task. */
export function evaluateRoutingExperiment(rows: Iterable<Row>, experiment: RoutingExperiment, today: string): ExperimentReport {
  const firstArm = new Map<string, { arm: string; provider: WorkerProviderId; ts: string }>();
  const armsSeen = new Map<string, Set<string>>();
  const assignmentTask = new Map<string, string>();
  const receipts = new Map<string, { minutes?: number; tokens?: number; cost?: number }>();
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
      const provider = str((assignment?.selected as Row | undefined)?.provider) as WorkerProviderId | undefined;
      const arm = provider ? experiment.arms[provider] : undefined;
      if (!provider || !arm) continue;
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
    if (receiptId && !receipts.has(receiptId)) {
      const duration = num(row.worker_duration_ms);
      receipts.set(receiptId, {
        ...(duration !== undefined ? { minutes: duration / 60_000 } : {}),
        ...(tokenTotal(row.tokens) !== undefined ? { tokens: tokenTotal(row.tokens) } : {}),
        ...(num(row.cost_usd) !== undefined ? { cost: num(row.cost_usd) } : {}),
      });
    }
  }
  const arms = (Object.entries(experiment.arms) as Array<[WorkerProviderId, string]>).map(([provider, arm]): ExperimentArmReport => {
    const tasks = [...firstArm.entries()].filter(([, first]) => first.arm === arm);
    const since = new Map(tasks.map(([task, first]) => [task, first.ts]));
    const merged = new Set(merges.filter((merge) => since.has(merge.task) && merge.ts >= since.get(merge.task)!).map((merge) => merge.task));
    const fixCounts = tasks.map(([task, first]) => fixes.filter((fix) => fix.task === task && fix.ts >= first.ts).length);
    const armReceipts = [...assignmentTask.entries()]
      .filter(([, task]) => since.has(task))
      .map(([id]) => receipts.get(id))
      .filter((receipt): receipt is NonNullable<typeof receipt> => receipt !== undefined);
    return {
      arm,
      provider,
      tasks: tasks.length,
      merged: merged.size,
      mergeRate: tasks.length === 0 ? null : merged.size / tasks.length,
      meanFixDispatches: mean(fixCounts),
      medianWorkerMinutes: median(armReceipts.flatMap((receipt) => (receipt.minutes === undefined ? [] : [receipt.minutes]))),
      meanTokens: mean(armReceipts.flatMap((receipt) => (receipt.tokens === undefined ? [] : [receipt.tokens]))),
      meanNotionalCostUsd: mean(armReceipts.flatMap((receipt) => (receipt.cost === undefined ? [] : [receipt.cost]))),
    };
  });
  return {
    id: experiment.id,
    startedOn: experiment.startedOn,
    revisitOn: experiment.revisitOn,
    revisitDue: today >= experiment.revisitOn,
    assignments: assignmentTask.size,
    mixedTasks: [...armsSeen.values()].filter((seen) => seen.size > 1).length,
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
  const reports = ROUTING_EXPERIMENTS.map((experiment) => evaluateRoutingExperiment(rows, experiment, today));
  if (rest.includes("--json")) {
    print(JSON.stringify({ stateDir, rowsRead: rows.length, reports }));
    return 0;
  }
  print(`state dir: ${stateDir} (${rows.length} ledger rows read)`);
  for (const report of reports) {
    const status = report.sufficient ? "measured" : "insufficient sample";
    print(`${report.id}: ${status}; ${report.assignments} assignments, ${report.mixedTasks} tasks in both arms; revisit ${report.revisitOn}${report.revisitDue ? " (DUE)" : ""}`);
    for (const arm of report.arms) {
      print(
        `  ${arm.arm} (${arm.provider}): ${arm.tasks} tasks, ${arm.merged} merged (${fmt(arm.mergeRate, 100, "%")}), ` +
          `${fmt(arm.meanFixDispatches)} fix dispatches/task, ${fmt(arm.medianWorkerMinutes)} min median, ` +
          `${fmt(arm.meanTokens, 1, "", 0)} tokens, $${fmt(arm.meanNotionalCostUsd, 1, "", 2)} notional`,
      );
    }
  }
  return 0;
}

function fmt(value: number | null, scale = 1, suffix = "", digits = 1): string {
  return value === null ? "n/a" : `${(value * scale).toFixed(digits)}${suffix}`;
}
