import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { openLedgerUnion } from "./ledger-union.js";
import { writeAtomic } from "./fs-race-safe.js";
import { systemClock, type Clock } from "./clock.js";
import type { Task } from "./plan.js";
import { RETRO_LEDGER_MAX_BYTES, RETRO_LEDGER_MAX_ROWS, type LedgerRecord } from "./retro.js";
import { spendRoleOf, spendAmountUsd, SPEND_STEP_ROLES } from "./spend-rows.js";

export interface GoalRecord {
  id: string;
  symptom: string;
  measurement: "pr-flow-minutes" | "ci-friction-minutes" | "terminal-missing-percent";
  baseline: { value: number; observedAt: string; source: string };
  direction: "increase" | "decrease";
  tasks: string[];
}
export interface GoalObservation {
  goal_id: string;
  key: string;
  step: "goal.moved" | "goal.unmoved" | "goal.unmeasured";
  ts: string;
  baseline: number;
  value: number | null;
  reason?: string;
  tasks: string[];
  pricedUsd: number;
  unpricedRows: number;
  priorityAction: "governed-proposal";
  measurement: GoalRecord["measurement"];
  windowDays: 7;
  costBasis: "produced-ledger-receipts";
  costComplete: boolean;
}

export function loadGoals(repoRoot: string): GoalRecord[] {
  const dir = join(repoRoot, "plan", "goals.d");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => /^G-[\w-]+\.yaml$/.test(name)).sort().map((name) => {
    const goal = parse(readFileSync(join(dir, name), "utf8")) as GoalRecord;
    if (!goal || !/^G-[\w-]+$/.test(goal.id) || goal.id + ".yaml" !== name || !goal.symptom ||
      !["pr-flow-minutes", "ci-friction-minutes", "terminal-missing-percent"].includes(goal.measurement) ||
      !["increase", "decrease"].includes(goal.direction) || !goal.baseline || !Number.isFinite(goal.baseline.value) ||
      !Number.isFinite(Date.parse(goal.baseline.observedAt)) || !goal.baseline.source || !Array.isArray(goal.tasks) ||
      !goal.tasks.every((id) => typeof id === "string" && id.length > 0)) throw new Error(`invalid goal record: ${name}`);
    return goal;
  });
}

/** Measurements are named, read-only ledger queries; a plan cannot inject a shell command. */
export function measureGoal(metric: GoalRecord["measurement"], rows: readonly LedgerRecord[]): number | null {
  if (metric === "ci-friction-minutes") {
    const report = [...rows].reverse().find((row) => row.step === "ci-friction.scorecard" && Array.isArray(row.priced));
    const prices = report?.priced as Array<{ minutes?: unknown }> | undefined;
    if (!prices || !prices.length || !prices.every((p) => typeof p.minutes === "number" && Number.isFinite(p.minutes) && p.minutes >= 0)) return null;
    return prices.reduce((sum, p) => sum + (p.minutes as number), 0);
  }
  if (metric === "terminal-missing-percent") {
    const assignments = new Set(rows.filter((r) => r.step === "worker.assignment").map((r) => (r.worker_assignment as { id?: string })?.id).filter((id): id is string => typeof id === "string"));
    const terminals = new Set(rows.filter((r) => r.step === "verdict" || r.step === "worker.attempt" || SPEND_STEP_ROLES[r.step ?? ""] === "produced").map((r) => r.selection_assignment_id).filter((id) => typeof id === "string"));
    return assignments.size ? 100 * [...assignments].filter((id) => !terminals.has(id)).length / assignments.size : null;
  }
  const opened = new Map<string, number>(), merged = new Map<string, number>();
  for (const row of rows) {
    const time = Date.parse(row.ts ?? "");
    if (!Number.isFinite(time) || typeof row.pr_url !== "string") continue;
    const map = row.step === "pr.opened" ? opened : row.step === "verdict.merged" ? merged : undefined;
    if (map) map.set(row.pr_url, Math.min(map.get(row.pr_url) ?? time, time));
  }
  const minutes = [...merged].flatMap(([pr, time]) => opened.has(pr) && time >= opened.get(pr)! ? [(time - opened.get(pr)!) / 60_000] : []);
  if (!minutes.length) return null;
  minutes.sort((a, b) => a - b);
  const mid = Math.floor(minutes.length / 2);
  return minutes.length % 2 ? minutes[mid]! : (minutes[mid - 1]! + minutes[mid]!) / 2;
}

export async function remeasureSettledGoals(input: {
  repoRoot: string; stateDir: string; tasks: readonly Task[];
  settled: (id: string) => boolean | undefined;
  log: (step: string, fields: Record<string, unknown>) => void;
  clock?: Clock; goals?: readonly GoalRecord[]; rows?: readonly LedgerRecord[];
  maxRows?: number;
}): Promise<GoalObservation[]> {
  const clock = input.clock ?? systemClock;
  const maxRows = input.maxRows ?? RETRO_LEDGER_MAX_ROWS;
  if (!Number.isSafeInteger(maxRows) || maxRows <= 0 || maxRows > RETRO_LEDGER_MAX_ROWS) throw new Error("invalid goal retention bound");
  const goals = input.goals ?? loadGoals(input.repoRoot);
  if (!goals.length) return [];
  const path = join(input.stateDir, "goal-remeasurements.json");
  const prior = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as Record<string, GoalObservation> : {};
  const taskById = new Map(input.tasks.map((task) => [task.id, task]));
  const due = goals.map((goal) => {
    const ids = [...new Set([...goal.tasks, ...input.tasks.filter((t) => t.goal === goal.id).map((t) => t.id)])].sort();
    const key = createHash("sha256").update(JSON.stringify([goal, ids])).digest("hex");
    return { goal, ids, key };
  }).filter(({ goal, ids, key }) => ids.length > 0 && ids.every((id) => taskById.has(id) && input.settled(id) === true) &&
    (prior[goal.id]?.key !== key || (prior[goal.id]?.step === "goal.unmeasured" && clock.now() - Date.parse(prior[goal.id]!.ts) >= 86_400_000)));
  if (!due.length) return [];
  let rows = input.rows;
  const sourceProblems = new Set<string>();
  if (!rows) {
    const loaded: LedgerRecord[] = [];
    const from = clock.now() - 7 * 86_400_000;
    let bytes = 0;
    for await (const row of openLedgerUnion(input.stateDir, { since: new Date(from).toISOString(),
      step: ["pr.opened", "verdict.merged", "worker.assignment", "worker.attempt", "verdict", "ci-friction.scorecard", ...Object.keys(SPEND_STEP_ROLES)],
      dedupeWindowPerStep: 32_768,
      onUnreadArchive: () => { sourceProblems.add("unreadable-archive"); }, onUnreadLive: () => { sourceProblems.add("unreadable-live"); }, onMalformedRow: () => { sourceProblems.add("malformed-row"); } })) {
      const timestamp = Date.parse(row.ts as string);
      if (!Number.isFinite(timestamp)) { sourceProblems.add("invalid-timestamp"); continue; }
      if (timestamp > clock.now() + 5 * 60_000) { sourceProblems.add("future-timestamp"); continue; }
      if (timestamp < from || timestamp > clock.now()) continue;
      bytes += Buffer.byteLength(JSON.stringify(row));
      if (loaded.length >= maxRows || bytes > RETRO_LEDGER_MAX_BYTES) { sourceProblems.add("retention-budget"); break; }
      loaded.push(row);
    }
    rows = loaded;
  }
  const output: GoalObservation[] = [];
  for (const { goal, ids, key } of due) {
    const value = sourceProblems.size ? null : measureGoal(goal.measurement, rows);
    let pricedUsd = 0, unpricedRows = 0;
    for (const row of rows) if (ids.includes(row.task_id ?? "") && spendRoleOf(row) === "produced") {
      const amount = spendAmountUsd(row);
      if (amount === undefined || amount < 0) unpricedRows++; else pricedUsd += amount;
    }
    const moved = value !== null && (goal.direction === "increase" ? value > goal.baseline.value : value < goal.baseline.value);
    const observation: GoalObservation = { goal_id: goal.id, key, ts: clock.iso(), baseline: goal.baseline.value, value,
      step: value === null ? "goal.unmeasured" : moved ? "goal.moved" : "goal.unmoved", tasks: ids, pricedUsd, unpricedRows,
      ...(value === null ? { reason: sourceProblems.size ? [...sourceProblems].sort().join(",") : "no-valid-measurement-sample" } : {}), priorityAction: "governed-proposal", measurement: goal.measurement, windowDays: 7,
      costBasis: "produced-ledger-receipts", costComplete: sourceProblems.size === 0 && unpricedRows === 0 };
    input.log(observation.step, { ...observation });
    prior[goal.id] = observation;
    output.push(observation);
  }
  writeAtomic(path, JSON.stringify(prior) + "\n");
  return output;
}

export function withGoalRemeasurement<T extends unknown[], R>(sweep: (...args: T) => Promise<R>, measure: () => Promise<unknown>, log: (step: string, fields: Record<string, unknown>) => void): (...args: T) => Promise<R> {
  return async (...args) => {
    const result = await sweep(...args);
    try { await measure(); }
    catch (error) { log("goal.remeasurement_failed", { reason: String((error as Error)?.message ?? error) }); }
    return result;
  };
}

export function goalObservationFromRow(row: Record<string, unknown>): GoalObservation | undefined {
  if (typeof row.goal_id !== "string" || !/^G-[\w-]{1,80}$/.test(row.goal_id) ||
    !["goal.moved", "goal.unmoved", "goal.unmeasured"].includes(String(row.step)) ||
    typeof row.ts !== "string" || !Number.isFinite(Date.parse(row.ts)) || typeof row.key !== "string" || !/^[a-f0-9]{64}$/.test(row.key) ||
    typeof row.baseline !== "number" || !Number.isFinite(row.baseline) ||
    !(row.value === null || typeof row.value === "number" && Number.isFinite(row.value)) ||
    !Array.isArray(row.tasks) || row.tasks.length > 1000 || !row.tasks.every((id) => typeof id === "string" && /^[A-Za-z0-9]+-T[0-9]+[a-z]?$/.test(id)) ||
    typeof row.pricedUsd !== "number" || !Number.isFinite(row.pricedUsd) || row.pricedUsd < 0 ||
    !Number.isSafeInteger(row.unpricedRows) || (row.unpricedRows as number) < 0 ||
    row.priorityAction !== "governed-proposal" || row.windowDays !== 7 || row.costBasis !== "produced-ledger-receipts" ||
    typeof row.costComplete !== "boolean" || !["pr-flow-minutes", "ci-friction-minutes", "terminal-missing-percent"].includes(String(row.measurement))) return undefined;
  if (row.step === "goal.unmeasured" ? row.value !== null : row.value === null) return undefined;
  return Object.fromEntries(["goal_id", "key", "step", "ts", "baseline", "value", "tasks", "pricedUsd", "unpricedRows", "priorityAction", "measurement", "windowDays", "costBasis", "costComplete", ...(typeof row.reason === "string" ? ["reason"] : [])]
    .map((key) => [key, key === "reason" ? (row.reason as string).slice(0, 256) : row[key]])) as unknown as GoalObservation;
}
