import { createHash } from "node:crypto";
import { join } from "node:path";
import { fixedClock, systemClock } from "./clock.js";
import { twoProportionSampleSize } from "./eval-card.js";
import { appendLedger } from "./ledger.js";
import { LEDGER_FILENAME } from "./ledger-path.js";
import { readLedgerUnionRecordsSync } from "./ledger-union.js";
import { experimentArmForTask, experimentTaskIdentity, ROUTING_EXPERIMENTS, type RoutingExperiment } from "./routing-experiments.js";

type Row = Record<string, unknown>;
type Pipeline = "build" | "fix" | "review";
type Metrics = { rate: number | null; medianCostUsd: number | null; medianDurationMs: number | null };
type Cluster = { task: string; outcomes: number[]; costs: number[]; durations: number[] };
export interface RoutingInterval {
  difference: number;
  lower: number;
  upper: number;
  confidence: number;
  method: "task-bootstrap";
}
/** Rates weight tasks equally; resource medians use each task's complete pipeline total. */
export interface RoutingPipelineResult extends Metrics {
  tasks: number;
  assignments: number;
  positive: number;
}
export interface RoutingExperimentResult {
  id: string;
  day: string;
  decision: RoutingExperiment["decision"];
  requiredTasksPerArm: number;
  status: "running" | "concluded" | "underpowered";
  conclusion: "winner" | "no-difference" | null;
  winner: string | null;
  assignments: number;
  assignmentsWithoutOutcome: number;
  crossoverShare: number | null;
  arms: Array<{ arm: string; tasks: number; pipelines: Record<Pipeline, RoutingPipelineResult> }>;
  /** Second arm minus first arm; a positive review rate difference means more failed reviews. */
  differences: Record<Pipeline, Record<keyof Metrics, RoutingInterval | null>>;
}
const pipelines: Pipeline[] = ["build", "fix", "review"];
const metrics: Array<keyof Metrics> = ["rate", "medianCostUsd", "medianDurationMs"];
const object = (value: unknown): Row => value !== null && typeof value === "object" ? value as Row : {};
const text = (value: unknown): string => typeof value === "string" ? value : "";
const number = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
const sum = (values: number[]): number => values.reduce((a, b) => a + b, 0);
const median = (values: number[]): number | null => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};
const dayValid = (day: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(day)
  && Number.isFinite(Date.parse(day)) && fixedClock(Date.parse(day)).iso().slice(0, 10) === day;

export function requiredRoutingTasksPerArm(experiment: RoutingExperiment): number {
  const d = experiment.decision;
  if (!d || !(d.minimumDifference > 0 && d.minimumDifference < 1) || !(d.power > 0.5 && d.power < 1)
    || !(d.confidence > 0.5 && d.confidence < 1) || !dayValid(d.stopOn) || d.stopOn < experiment.startedOn
    || !Number.isInteger(experiment.minTasksPerArm) || experiment.minTasksPerArm < 1) {
    throw new Error(`invalid routing experiment decision: ${experiment.id}`);
  }
  // Symmetric rates about 0.5 give the largest variance for the declared absolute difference.
  return Math.max(experiment.minTasksPerArm, Math.ceil(twoProportionSampleSize(
    (1 - d.minimumDifference) / 2, (1 + d.minimumDifference) / 2, 1 - d.confidence, d.power,
  )));
}

function summarize(clusters: Cluster[]): Metrics {
  return {
    rate: clusters.length ? sum(clusters.map(c => sum(c.outcomes) / c.outcomes.length)) / clusters.length : null,
    medianCostUsd: median(clusters.flatMap(c => c.costs.length === c.outcomes.length ? [sum(c.costs)] : [])),
    medianDurationMs: median(clusters.flatMap(c => c.durations.length === c.outcomes.length ? [sum(c.durations)] : [])),
  };
}

function differences(a: Cluster[], b: Cluster[], seed: string, confidence: number): Record<keyof Metrics, RoutingInterval | null> {
  const result: Record<keyof Metrics, RoutingInterval | null> = { rate: null, medianCostUsd: null, medianDurationMs: null };
  if (!a.length || !b.length) return result;
  let state = createHash("sha256").update(seed).digest().readUInt32LE(0);
  const draw = (n: number): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return Math.floor(state / 0x100000000 * n);
  };
  const sample = (clusters: Cluster[]) => summarize(clusters.map(() => clusters[draw(clusters.length)]!));
  const points = [summarize(a), summarize(b)];
  const samples: Record<keyof Metrics, number[]> = { rate: [], medianCostUsd: [], medianDurationMs: [] };
  for (let n = 0; n < 2000; n++) {
    const left = sample(a), right = sample(b);
    for (const metric of metrics) {
      if (left[metric] !== null && right[metric] !== null) samples[metric].push(right[metric]! - left[metric]!);
    }
  }
  for (const metric of metrics) {
    const values = samples[metric].sort((x, y) => x - y);
    const left = points[0]![metric], right = points[1]![metric];
    if (left === null || right === null || !values.length) continue;
    const tail = (1 - confidence) / 2;
    result[metric] = { difference: right - left,
      lower: values[Math.floor(tail * (values.length - 1))]!, upper: values[Math.ceil((1 - tail) * (values.length - 1))]!,
      confidence, method: "task-bootstrap" };
  }
  return result;
}

function terminal(row: Row): { pipeline: Pipeline; positive: number } | undefined {
  if (row.step === "verdict.merged") return { pipeline: "build", positive: 1 };
  if (row.step === "verdict" && ["failed", "refused", "abandoned"].includes(text(row.verdict))) return { pipeline: "build", positive: 0 };
  if (row.step === "fix.done") return { pipeline: "fix", positive: row.subtype === "success" ? 1 : 0 };
  if (row.step === "review.posted" && ["success", "failure"].includes(text(row.state))) {
    return { pipeline: "review", positive: row.state === "failure" ? 1 : 0 };
  }
  return undefined;
}

function terminalAssignmentId(row: Row): string {
  return text(row.selection_assignment_id) || text(object(row.evaluator_provenance).selectionAssignmentId);
}

/** ITT estimates: each task has equal weight; retries remain inside its bootstrap cluster. */
export function evaluateRoutingExperimentResult(input: Iterable<Row>, experiment: RoutingExperiment, today: string): RoutingExperimentResult {
  const requiredTasksPerArm = requiredRoutingTasksPerArm(experiment);
  if (!dayValid(today)) throw new Error(`invalid routing result day: ${today}`);
  const labels = Object.values(experiment.arms) as string[];
  if (labels.length !== 2 || labels[0] === labels[1]) throw new Error("routing result requires two distinct arms");
  const until = today < experiment.decision.stopOn ? today : experiment.decision.stopOn;
  const rows = [...input].filter(row => {
    const at = Date.parse(text(row.ts));
    return Number.isFinite(at) && at >= Date.parse(experiment.startedOn) && at < Date.parse(until) + 86400000;
  }).sort((a, b) => text(a.ts).localeCompare(text(b.ts)) || JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const assignments = new Map<string, { task: string; arm: string; served: string; ts: string }>();
  for (const row of rows) {
    const assignment = object(row.worker_assignment), routing = object(assignment.routing);
    const task = text(row.task_id), id = text(assignment.id);
    if (row.step !== "worker.assignment" || object(routing.decision).ab !== experiment.id || !id || !experimentTaskIdentity(task)) continue;
    const provider = text(object(assignment.selected).provider) as keyof RoutingExperiment["arms"];
    assignments.set(id, { task, arm: experimentArmForTask(experiment, task).arm,
      served: experiment.arms[provider] ?? provider, ts: text(row.ts) });
  }
  const prAssignments = new Map<string, string>();
  for (const row of rows) {
    if (row.step !== "pr.opened") continue;
    const prUrl = text(row.pr_url), assignmentId = text(row.head_assignment);
    if (prUrl && assignmentId) prAssignments.set(prUrl, assignmentId);
  }
  const outcomes = new Map<string, { pipeline: Pipeline; positive: number; row: Row }>();
  const receipts = new Map<string, Row>();
  for (const row of rows) {
    let id = terminalAssignmentId(row);
    let assignment = assignments.get(id);
    // Sweep merge credit is task-level by design. Resolve its exact producer from the PR head
    // provenance recorded when that PR opened; an explicit but unmatched assignment stays refused.
    if (!id && row.step === "verdict.merged") {
      id = prAssignments.get(text(row.pr_url)) ?? "";
      assignment = assignments.get(id);
    }
    if (!assignment || row.task_id !== assignment.task || text(row.ts) < assignment.ts) continue;
    if (["worker.attempt", "worker.done", "verdict", "fix.done", "review.posted", "verdict.merged"].includes(text(row.step))) {
      const prior = receipts.get(id) ?? {};
      receipts.set(id, { ...prior, ...Object.fromEntries(Object.entries(row).filter(([, value]) => value !== undefined)) });
    }
    const end = terminal(row);
    if (end) outcomes.set(id, { ...end, row });
  }
  const clusters = labels.map(() => Object.fromEntries(pipelines.map(p => [p, new Map<string, Cluster>()])) as Record<Pipeline, Map<string, Cluster>>);
  for (const [id, end] of outcomes) {
    const assignment = assignments.get(id)!;
    const group = clusters[labels.indexOf(assignment.arm)]![end.pipeline];
    const cluster = group.get(assignment.task) ?? { task: assignment.task, outcomes: [], costs: [], durations: [] };
    cluster.outcomes.push(end.positive);
    const receipt = receipts.get(id)!;
    const cost = receipt.billing_mode === "subscription" ? number(receipt.notional_cost_usd)
      : number(receipt.total_cost_usd) ?? number(receipt.cost_usd);
    const duration = number(receipt.worker_duration_ms) ?? number(receipt.duration_ms);
    if (cost !== undefined) cluster.costs.push(cost);
    if (duration !== undefined) cluster.durations.push(duration);
    group.set(assignment.task, cluster);
  }
  const arms = labels.map((arm, index) => ({ arm,
    tasks: new Set([...assignments.values()].filter(a => a.arm === arm).map(a => a.task)).size,
    pipelines: Object.fromEntries(pipelines.map(p => {
      const group = [...clusters[index]![p].values()].sort((a, b) => a.task.localeCompare(b.task));
      return [p, { ...summarize(group),
        tasks: group.length, assignments: sum(group.map(c => c.outcomes.length)), positive: sum(group.map(c => sum(c.outcomes))) }];
    })) as Record<Pipeline, RoutingPipelineResult>,
  }));
  const diffs = Object.fromEntries(pipelines.map(p => [p, differences(
    [...clusters[0]![p].values()].sort((a, b) => a.task.localeCompare(b.task)),
    [...clusters[1]![p].values()].sort((a, b) => a.task.localeCompare(b.task)), `${experiment.id}:${p}`, experiment.decision.confidence,
  )])) as RoutingExperimentResult["differences"];
  const active = pipelines.filter(p => arms.some(arm => arm.pipelines[p].tasks > 0));
  const sufficient = active.length > 0 && active.every(p => arms.every(arm => arm.pipelines[p].tasks >= requiredTasksPerArm));
  const winners = active.map(p => {
    const interval = diffs[p].rate;
    if (!interval) return null;
    const direction = p === "review" ? -1 : 1;
    if (interval.lower > 0 && interval.difference >= experiment.decision.minimumDifference) return direction === 1 ? labels[1]! : labels[0]!;
    if (interval.upper < 0 && interval.difference <= -experiment.decision.minimumDifference) return direction === 1 ? labels[0]! : labels[1]!;
    return null;
  });
  const winner = sufficient && winners.every(w => w !== null && w === winners[0]) ? winners[0]! : null;
  return { id: experiment.id, day: today, decision: { ...experiment.decision }, requiredTasksPerArm,
    status: sufficient ? "concluded" : today >= experiment.decision.stopOn ? "underpowered" : "running",
    conclusion: sufficient ? winner ? "winner" : "no-difference" : null, winner,
    assignments: assignments.size, assignmentsWithoutOutcome: assignments.size - outcomes.size,
    crossoverShare: assignments.size ? [...assignments.values()].filter(a => a.arm !== a.served).length / assignments.size : null,
    arms, differences: diffs };
}

/** One UTC-day snapshot per experiment, including a terminal result unchanged on later days. */
export async function recordRoutingExperimentResults(opts: {
  stateDir: string; today?: string; experiments?: readonly RoutingExperiment[];
}): Promise<RoutingExperimentResult[]> {
  const today = opts.today ?? systemClock.iso().slice(0, 10);
  if (!dayValid(today)) throw new Error(`invalid routing result day: ${today}`);
  const read = readLedgerUnionRecordsSync(opts.stateDir, { refuseIncomplete: true,
    step: ["worker.assignment", "worker.attempt", "worker.done", "verdict", "verdict.merged", "fix.done", "review.posted", "pr.opened", "routing.experiment.result"] });
  if (!read.ok) throw new Error(`routing result ledger unreadable: ${read.unread.join(", ")}`);
  const recorded: RoutingExperimentResult[] = [];
  for (const experiment of opts.experiments ?? ROUTING_EXPERIMENTS) {
    if (today < experiment.startedOn) continue;
    const prior = read.rows.filter(row => row.step === "routing.experiment.result" && row.experiment_id === experiment.id
      && text(row.day) <= today).sort((a, b) => text(a.day).localeCompare(text(b.day)));
    if (prior.some(row => row.day === today)) continue;
    const terminal = prior.map(row => row.result as RoutingExperimentResult).find(result => result.status !== "running");
    const result = terminal ? { ...terminal, day: today } : evaluateRoutingExperimentResult(read.rows, experiment, today);
    appendLedger(join(opts.stateDir, LEDGER_FILENAME), { run_id: `ROUTING-RESULT-${experiment.id}-${today}`,
      task_id: experiment.id, step: "routing.experiment.result", experiment_id: experiment.id, day: today, result });
    recorded.push(result);
  }
  return recorded;
}
