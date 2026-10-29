import { createIncrementalLedgerUnion } from "./ledger-union.js";

/** W1-T10921: deterministic gate health from durable observations, including rotated history. */
type Row = Record<string, unknown>;
const step = "implement.preopen_gate";
const windowMs = 7 * 24 * 60 * 60_000;
const coldStartMs = 15 * 60_000;
// PRIMARY CONTROL: a non-pass streak must have at most this probability under the last passing window.
const unhealthyProbability = 0.01;

const readHistory = createIncrementalLedgerUnion({ holder: "preopen-gate-health", reducerVersion: "1",
  project: row => Object.fromEntries(["ts", "step", "run_id", "result", "reason", "duration_ms", "backstop_ms", "backstop_basis",
    "failed", "failed_detail", "action", "streak_first_ts", "health_state"].filter(key => row[key] !== undefined).map(key => [key, row[key]])) });

/** Read the same fleet history for gate admission and alert deduplication; never trust a partial corpus. */
export function readPreopenGateRows(stateDir: string): readonly Row[] {
  const read = readHistory(stateDir, { step: [step, `${step}.alert`], refuseIncomplete: true });
  if (!read.ok) throw new Error(`pre-open gate history unreadable: ${read.unread.join(", ")}`);
  return [...read.rows].sort((a, b) => timestamp(a) - timestamp(b));
}

export interface PreopenGateHealth {
  backstopMs: number;
  backstopBasis: "measured-p95-plus-iqr" | "persisted" | "cold-start";
  state: "healthy" | "unhealthy" | "unknown";
  nonPassStreak: number;
  lastPass?: string;
  passRate?: number;
  streakProbability?: number;
  failedSteps: { name: string; count: number; detail?: string }[];
}

function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}
function timestamp(row: Row): number {
  return typeof row.ts === "string" ? Date.parse(row.ts) : NaN;
}
function measured(row: Row): boolean {
  return row.result === "pass" || row.result === "fail";
}
function quantile(sorted: number[], fraction: number): number {
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

/** P95 plus the interquartile spread, floored by every recent pass; rows persist the chosen bound. */
export function preopenGateHealth(rows: readonly Row[], now: number): PreopenGateHealth {
  const gates = rows.filter(row => row.step === step && timestamp(row) <= now);
  const recent = gates.filter(row => measured(row) && timestamp(row) >= now - windowMs && positive(row.duration_ms));
  const durations = recent.map(row => row.duration_ms as number).sort((a, b) => a - b);
  const persisted = gates.findLast(row => positive(row.backstop_ms));
  const backstopMs = durations.length > 0
    ? Math.ceil(Math.max(quantile(durations, 0.95) + quantile(durations, 0.75) - quantile(durations, 0.25),
      ...recent.filter(row => row.result === "pass").map(row => row.duration_ms as number)))
    : persisted ? persisted.backstop_ms as number : coldStartMs;
  const lastPassIndex = gates.findLastIndex(row => row.result === "pass");
  const lastPassRow = gates[lastPassIndex];
  const trailing = gates.slice(lastPassIndex + 1);
  const nonPassStreak = trailing.filter(row => row.result === "fail").length;
  const baseline = lastPassRow ? gates.slice(0, lastPassIndex + 1)
    .filter(row => measured(row) && timestamp(row) >= timestamp(lastPassRow) - windowMs) : [];
  // Laplace smoothing keeps one historical pass from making every subsequent failure impossible.
  const passRate = baseline.length ? (baseline.filter(row => row.result === "pass").length + 1) / (baseline.length + 2) : undefined;
  const streakProbability = passRate === undefined ? undefined : Math.pow(1 - passRate, nonPassStreak);
  const failed = new Map<string, { name: string; count: number; detail?: string }>();
  for (const row of trailing) {
    const names = Array.isArray(row.failed) ? row.failed : [];
    for (const name of names) {
      if (typeof name !== "string") continue;
      const prior = failed.get(name);
      const detail = row.failed_detail && typeof row.failed_detail === "object" ? (row.failed_detail as Row)[name] : undefined;
      failed.set(name, { name, count: (prior?.count ?? 0) + 1,
        ...(typeof detail === "string" ? { detail } : prior?.detail ? { detail: prior.detail } : {}) });
    }
  }
  return {
    backstopMs, backstopBasis: durations.length ? "measured-p95-plus-iqr" : persisted ? "persisted" : "cold-start",
    state: streakProbability === undefined ? "unknown" : streakProbability <= unhealthyProbability ? "unhealthy" : "healthy",
    nonPassStreak, lastPass: lastPassRow?.ts as string | undefined, passRate, streakProbability,
    failedSteps: [...failed.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
  };
}
