/**
 * lib/usage-telemetry.ts — the `usage-v1` projection of `GET /v1/analytics`: subscription burn per
 * provider window, cash-lane dollars per interval, and why the router chose each worker's model.
 *
 * SOURCES. Every figure comes from rows the fleet already writes; nothing here probes a provider.
 *  - `daemon.headroom`: the daemon's own Claude reading (window, percent_used, limit_pct, resets_at).
 *  - `worker.assignment`: every candidate's windows at decision time (Claude AND Codex), plus
 *    `routing.decision` (rule, capability, considered, headroomPercent) on rows written after #6991.
 *  - `implement.done` with `provider: "cash"`: cash-lane dollars (the same selector W1-T4024 uses).
 *
 * The accumulator is fed from the analytics union pass and checkpointed with it, so it holds only
 * bounded, JSON-plain state: hourly buckets for the last RETAIN_HOURS and one newest decision per run.
 */

import type { LiveProviderAccounts } from "./analytics-live-metrics.js";
import { fixedClock } from "./clock.js";

export const USAGE_PROJECTION_VERSION = "usage-v1";

const HOUR_MS = 3_600_000;
const RETAIN_HOURS = 8 * 24;
const SERIES_HOURS = 48;
const BURN_RATE_HOURS = 6;
const RECENT_RUNS_MAX = 40;
const CONSIDERED_MAX = 16;
const MARKED_RUNS_MAX = 600;
const SUBSCRIPTION_PROVIDERS = new Set(["claude", "codex"]);
const DECISION_FIELDS = new Set(["rule", "capability", "considered", "headroomPercent"]);
const SUCCESS_VERDICTS = new Set(["merged", "already_satisfied"]);
const CASH_COVERAGE =
  "implement workers only: fix-rung workers record no provider, so their cash spend cannot be attributed";

/** One provider window's readings inside one UTC hour. */
interface HourSample {
  hour: number;
  first: number;
  firstTs: number;
  last: number;
  max: number;
  lastTs: number;
  samples: number;
  resetsAt?: string;
  limitPercent?: number;
}

interface CashHour {
  hour: number;
  usd: number;
  rows: number;
}

interface RoutingHour {
  hour: number;
  counts: Record<string, number>;
  cashWhileRoom: number;
}

export interface UsageConsidered {
  provider: string;
  model?: string;
  eligible: boolean;
  selected: boolean;
  reason?: string;
}

export interface UsageRoutingAssignment {
  id: string;
  ts: string;
  runId: string | null;
  taskId: string | null;
  lane: string | null;
  requested: { model: string; effort: string };
  selected: { provider: string; model: string; effort: string };
  /** `decision.rule` when the row carries one; `legacy:<mode>` for rows written before it existed. */
  rule: string;
  ruleSource: "decision" | "legacy-mode";
  capability: string | null;
  considered: UsageConsidered[];
  headroomPercent: Record<string, number | null>;
  reservePercent: number | null;
  /** Cash chosen while a subscription was eligible or above the reserve: the case the policy should make rare. */
  cashWhileSubscriptionHadRoom: boolean;
  assignmentsInRun: number;
  /** Any further scalar field on `routing.decision` (an A/B arm, a trial tag), passed through by name. */
  markers: Record<string, string>;
}

/** One run whose first assignment carried a marker, joined to its terminal verdict. */
interface MarkedRun {
  runId: string;
  hour: number;
  firstTs: number;
  markers: Record<string, string>;
  provider: string;
  model: string;
  assignments: number;
  outcome?: { success: boolean; costUsd: number; durationMs: number };
}

export interface UsageExperimentArm {
  marker: string;
  value: string;
  provider: string;
  model: string;
  runs: number;
  assignments: number;
  terminals: number;
  successes: number;
  successRatePercent: number | null;
  meanAssignmentsPerRun: number;
  meanDurationMs: number | null;
  costUsd: number;
  meanCostPerTerminalUsd: number | null;
}

/** Plain-JSON accumulator state; it is the checkpoint shape too. */
export interface UsageTelemetryState {
  newestHour: number;
  series: Array<{ provider: string; window: string; hours: HourSample[] }>;
  cash: CashHour[];
  /** Individual cash rows of the last day as [ts, usd, model], so the 1h, 24h and today windows are exact. */
  cashEvents?: Array<[number, number, string]>;
  routing: RoutingHour[];
  recent: UsageRoutingAssignment[];
  markedRuns?: MarkedRun[];
  assignmentsObserved: number;
  decisionsObserved: number;
}

export interface UsageWindowPoint {
  hour: string;
  usedPercent: number;
  maxUsedPercent: number;
  samples: number;
}

export interface UsageWindow {
  name: string;
  kind: "5h" | "weekly" | "other";
  durationMs: number | null;
  usedPercent: number;
  remainingPercent: number;
  /** The daemon governor's ceiling for this window, when it reported one. */
  limitPercent: number | null;
  resetsAt: string | null;
  asOf: string;
  source: "ledger" | "live-status";
  /** `stale` when the newest reading predates this window's own reset: it describes a window that has ended. */
  state: "observed" | "stale";
  burn: { lastHourPercent: number | null; last24hPercent: number | null; ratePercentPerHour: number | null };
  /** When used reaches 100% at the current burn rate; null with no burn or when the reset comes first. */
  projectedExhaustionAt: string | null;
  exhaustsBeforeReset: boolean | null;
  series: UsageWindowPoint[];
}

export interface UsageSubscription {
  provider: string;
  state: "observed" | "stale" | "not-collected";
  windows: UsageWindow[];
}

export interface UsageCashWindow {
  name: "1h" | "24h" | "today-utc" | "7d" | "30d";
  usd: number;
  rows: number;
  complete: boolean;
  reason?: string;
}

export interface UsageCashLane {
  unit: "usd";
  state: "observed" | "not-collected";
  coverage: string;
  windows: UsageCashWindow[];
  byModel24h: Array<{ model: string; usd: number }>;
  series: Array<{ hour: string; usd: number; rows: number }>;
}

export interface UsageRoutingAggregate {
  windowHours: number;
  total: number;
  cashWhileSubscriptionHadRoom: number;
  byModel: Array<{ provider: string; model: string; count: number; sharePercent: number }>;
  byTier: Array<{ tier: string; count: number; sharePercent: number }>;
  byRule: Array<{ rule: string; count: number; sharePercent: number }>;
  byProvider: Array<{ provider: string; count: number; sharePercent: number }>;
  /** The full cross-tab, so a reader can ask e.g. which rules sent work to one model. */
  rows: Array<{ provider: string; model: string; tier: string; rule: string; count: number }>;
}

export interface UsageRoutingProjection {
  state: "observed" | "not-collected";
  assignmentsObserved: number;
  decisionsObserved: number;
  /** Newest assignment per run, newest first: the Fleet page's "why this model" source. */
  recent: UsageRoutingAssignment[];
  aggregates: { last24h: UsageRoutingAggregate; last7d: UsageRoutingAggregate };
  /** Marked runs over the last 7 days, one row per (marker, value, arm model), joined to their verdicts. */
  experiments: UsageExperimentArm[];
}

export interface UsageProjection {
  version: typeof USAGE_PROJECTION_VERSION;
  asOf: string | null;
  coverage: { from: string | null; to: string | null; note: string };
  subscriptions: UsageSubscription[];
  cash: UsageCashLane;
  routing: UsageRoutingProjection;
}

export function usageTelemetryState(): UsageTelemetryState {
  return { newestHour: 0, series: [], cash: [], cashEvents: [], routing: [], recent: [], markedRuns: [], assignmentsObserved: 0, decisionsObserved: 0 };
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function percent(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function isoInstant(value: unknown): string | undefined {
  // Codex capacity rows carry epoch SECONDS (1790417710); an epoch past 1e11 can only be milliseconds.
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return isoAt(value < 1e11 ? value * 1000 : value);
  const raw = text(value);
  const parsed = raw === undefined ? NaN : Date.parse(raw);
  return Number.isFinite(parsed) ? isoAt(parsed) : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** An instant as ISO text, through the Clock port rather than a bare Date. */
function isoAt(ms: number): string {
  return fixedClock(ms).iso();
}

function hourIso(hour: number): string {
  return isoAt(hour * HOUR_MS);
}

function noteHour(state: UsageTelemetryState, hour: number): void {
  if (hour <= state.newestHour) return;
  state.newestHour = hour;
  const floor = hour - RETAIN_HOURS;
  for (const series of state.series) series.hours = series.hours.filter((sample) => sample.hour > floor);
  state.cash = state.cash.filter((entry) => entry.hour > floor);
  state.cashEvents = (state.cashEvents ?? []).filter(([ts]) => ts >= (hour - 25) * HOUR_MS);
  state.routing = state.routing.filter((entry) => entry.hour > floor);
  state.markedRuns = (state.markedRuns ?? []).filter((entry) => entry.hour > floor);
}

function addReading(
  state: UsageTelemetryState,
  input: { provider: string; window: string; usedPercent: number; ts: number; resetsAt?: string; limitPercent?: number },
): void {
  const hour = Math.floor(input.ts / HOUR_MS);
  if (hour <= state.newestHour - RETAIN_HOURS) return;
  let series = state.series.find((entry) => entry.provider === input.provider && entry.window === input.window);
  if (!series) {
    series = { provider: input.provider, window: input.window, hours: [] };
    state.series.push(series);
  }
  let sample = series.hours.find((entry) => entry.hour === hour);
  if (!sample) {
    sample = { hour, first: input.usedPercent, firstTs: input.ts, last: input.usedPercent, max: input.usedPercent, lastTs: input.ts, samples: 0 };
    series.hours.push(sample);
    series.hours.sort((left, right) => left.hour - right.hour);
  }
  sample.samples += 1;
  sample.max = Math.max(sample.max, input.usedPercent);
  if (input.ts < sample.firstTs) {
    sample.first = input.usedPercent;
    sample.firstTs = input.ts;
  }
  if (input.ts >= sample.lastTs) {
    sample.last = input.usedPercent;
    sample.lastTs = input.ts;
    if (input.resetsAt) sample.resetsAt = input.resetsAt;
    if (input.limitPercent !== undefined) sample.limitPercent = input.limitPercent;
  }
  noteHour(state, hour);
}

function consideredFrom(value: unknown): UsageConsidered[] {
  if (!Array.isArray(value)) return [];
  const out: UsageConsidered[] = [];
  for (const raw of value.slice(0, CONSIDERED_MAX)) {
    const entry = record(raw);
    const provider = text(entry?.provider);
    if (!entry || !provider) continue;
    out.push({
      provider,
      ...(text(entry.model) ? { model: text(entry.model) } : {}),
      eligible: entry.eligible === true,
      selected: entry.selected === true,
      ...(text(entry.reason) ? { reason: text(entry.reason) } : {}),
    });
  }
  return out;
}

function headroomFrom(value: unknown): Record<string, number | null> {
  const raw = record(value);
  const out: Record<string, number | null> = {};
  for (const [provider, reading] of Object.entries(raw ?? {})) {
    if (reading === null) out[provider] = null;
    else if (percent(reading) !== undefined) out[provider] = reading as number;
  }
  return out;
}

function capabilityFrom(decision: Record<string, unknown> | undefined, candidates: unknown): string | null {
  const declared = text(decision?.capability);
  if (declared) return declared;
  for (const raw of Array.isArray(candidates) ? candidates : []) {
    const requested = text(record(record(raw)?.modelDecision)?.requestedCapability);
    if (requested) return requested;
  }
  return null;
}

function markersFrom(decision: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(decision ?? {})) {
    if (DECISION_FIELDS.has(key) || Object.keys(out).length >= 8) continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") out[key.slice(0, 64)] = String(value).slice(0, 64);
  }
  return out;
}

function noteMarkedRun(state: UsageTelemetryState, runId: string | null, ts: number, markers: Record<string, string>, provider: string, model: string): void {
  if (!runId) return;
  const runs = (state.markedRuns ??= []);
  const existing = runs.find((entry) => entry.runId === runId);
  if (existing) {
    existing.assignments += 1;
    return;
  }
  if (Object.keys(markers).length === 0) return;
  runs.push({ runId, hour: Math.floor(ts / HOUR_MS), firstTs: ts, markers, provider, model, assignments: 1 });
  if (runs.length > MARKED_RUNS_MAX) runs.splice(0, runs.length - MARKED_RUNS_MAX);
}

function addVerdict(state: UsageTelemetryState, line: Record<string, unknown>, ts: number): void {
  const runId = text(line.run_id);
  const run = runId ? state.markedRuns?.find((entry) => entry.runId === runId) : undefined;
  if (!run || run.outcome) return;
  const cost = line.total_cost_usd;
  run.outcome = {
    success: line.success === true || SUCCESS_VERDICTS.has(text(line.verdict) ?? ""),
    costUsd: typeof cost === "number" && Number.isFinite(cost) ? cost : 0,
    durationMs: Math.max(0, ts - run.firstTs),
  };
}

function cashHadRoom(provider: string, considered: UsageConsidered[], headroom: Record<string, number | null>, reserve: number | null): boolean {
  if (provider !== "cash") return false;
  if (considered.some((entry) => SUBSCRIPTION_PROVIDERS.has(entry.provider) && entry.eligible)) return true;
  return Object.entries(headroom).some(
    ([name, value]) => SUBSCRIPTION_PROVIDERS.has(name) && value !== null && value > (reserve ?? 0),
  );
}

function addAssignment(state: UsageTelemetryState, line: Record<string, unknown>, ts: number): void {
  const raw = record(line.worker_assignment);
  const selected = record(raw?.selected);
  const id = text(raw?.id);
  const provider = text(selected?.provider);
  const model = text(selected?.model);
  if (!raw || !id || !provider || !model) return;
  for (const candidate of Array.isArray(raw.candidates) ? raw.candidates : []) {
    const entry = record(candidate);
    const candidateProvider = text(entry?.provider);
    if (!entry || !candidateProvider || entry.readable !== true || !Array.isArray(entry.windows)) continue;
    for (const window of entry.windows) {
      const reading = record(window);
      const name = text(reading?.name);
      const used = percent(reading?.usedPercent);
      if (!name || used === undefined || name === "reached") continue;
      addReading(state, { provider: candidateProvider, window: name, usedPercent: used, ts, resetsAt: isoInstant(reading?.resetsAt) });
    }
  }
  const routing = record(raw.routing);
  const decision = record(routing?.decision);
  const rule = text(decision?.rule);
  const considered = consideredFrom(decision?.considered);
  const headroomPercent = headroomFrom(decision?.headroomPercent);
  const reservePercent = percent(record(routing?.policy)?.reservePercent) ?? null;
  const capability = capabilityFrom(decision, raw.candidates);
  const hadRoom = cashHadRoom(provider, considered, headroomPercent, reservePercent);
  const markers = markersFrom(decision);
  state.assignmentsObserved += 1;
  if (rule) state.decisionsObserved += 1;
  const ruleName = rule ?? `legacy:${text(routing?.mode) ?? "unreported"}`;

  const hour = Math.floor(ts / HOUR_MS);
  if (hour > state.newestHour - RETAIN_HOURS) {
    let bucket = state.routing.find((entry) => entry.hour === hour);
    if (!bucket) {
      bucket = { hour, counts: {}, cashWhileRoom: 0 };
      state.routing.push(bucket);
    }
    const key = [provider, model, capability ?? "unreported", ruleName].join("\u0000");
    bucket.counts[key] = (bucket.counts[key] ?? 0) + 1;
    if (hadRoom) bucket.cashWhileRoom += 1;
    noteHour(state, hour);
  }

  const runId = text(line.run_id) ?? null;
  noteMarkedRun(state, runId, ts, markers, provider, model);
  const prior = runId ? state.recent.find((entry) => entry.runId === runId) : undefined;
  if (prior && Date.parse(prior.ts) > ts) {
    prior.assignmentsInRun += 1;
    return;
  }
  const requested = record(raw.requested);
  const next: UsageRoutingAssignment = {
    id,
    ts: isoAt(ts),
    runId,
    taskId: text(line.task_id) ?? null,
    lane: text(line.lane) ?? null,
    requested: { model: text(requested?.model) ?? "unreported", effort: text(requested?.effort) ?? "unreported" },
    selected: { provider, model, effort: text(selected?.effort) ?? "unreported" },
    rule: ruleName,
    ruleSource: rule ? "decision" : "legacy-mode",
    capability,
    considered,
    headroomPercent,
    reservePercent,
    cashWhileSubscriptionHadRoom: hadRoom,
    assignmentsInRun: (prior?.assignmentsInRun ?? 0) + 1,
    markers,
  };
  state.recent = [...state.recent.filter((entry) => entry !== prior), next]
    .sort((left, right) => Date.parse(right.ts) - Date.parse(left.ts))
    .slice(0, RECENT_RUNS_MAX);
}

function addCash(state: UsageTelemetryState, line: Record<string, unknown>, ts: number): void {
  const usd = typeof line.total_cost_usd === "number" && Number.isFinite(line.total_cost_usd) ? line.total_cost_usd : 0;
  const hour = Math.floor(ts / HOUR_MS);
  if (hour <= state.newestHour - RETAIN_HOURS) return;
  let bucket = state.cash.find((entry) => entry.hour === hour);
  if (!bucket) {
    bucket = { hour, usd: 0, rows: 0 };
    state.cash.push(bucket);
  }
  bucket.usd += usd;
  bucket.rows += 1;
  (state.cashEvents ??= []).push([ts, usd, text(line.model) ?? "unreported"]);
  noteHour(state, hour);
}

/** Fold one ledger row. Rows of any other step are ignored in O(1). */
export function accumulateUsageLine(state: UsageTelemetryState, line: Record<string, unknown>): void {
  const step = line.step;
  if (step !== "daemon.headroom" && step !== "worker.assignment" && step !== "implement.done" && step !== "verdict") return;
  const ts = Date.parse(text(line.ts) ?? "");
  if (!Number.isFinite(ts)) return;
  if (step === "worker.assignment") addAssignment(state, line, ts);
  else if (step === "verdict") addVerdict(state, line, ts);
  else if (step === "implement.done") {
    if (line.provider === "cash") addCash(state, line, ts);
  } else {
    const window = text(line.window);
    const used = percent(line.percent_used);
    if (!window || used === undefined) return;
    const limitPercent = percent(line.limit_pct);
    addReading(state, {
      provider: "claude",
      window,
      usedPercent: used,
      ts,
      resetsAt: isoInstant(line.resets_at),
      ...(limitPercent !== undefined ? { limitPercent } : {}),
    });
  }
}

export function windowKind(name: string): { kind: UsageWindow["kind"]; durationMs: number | null } {
  const minutes = /(\d+)m$/.exec(name);
  if (minutes) {
    const ms = Number(minutes[1]) * 60_000;
    return { kind: ms === 5 * HOUR_MS ? "5h" : ms === 7 * 24 * HOUR_MS ? "weekly" : "other", durationMs: ms };
  }
  if (/\b5h\b/.test(name)) return { kind: "5h", durationMs: 5 * HOUR_MS };
  if (/^weekly\b/.test(name)) return { kind: "weekly", durationMs: 7 * 24 * HOUR_MS };
  return { kind: "other", durationMs: null };
}

/** Percentage points burned between two ordered readings; a drop means the window reset in between. */
function burnBetween(values: readonly number[]): number {
  let burned = 0;
  for (let index = 1; index < values.length; index += 1) {
    const delta = values[index]! - values[index - 1]!;
    burned += delta >= 0 ? delta : values[index]!;
  }
  return burned;
}

function round(value: number, places = 2): number {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
}

function projectWindow(hours: readonly HourSample[], name: string, asOfMs: number): UsageWindow | undefined {
  const newest = hours[hours.length - 1];
  if (!newest) return undefined;
  const { kind, durationMs } = windowKind(name);
  const readings = (samples: readonly HourSample[]): number[] => samples.flatMap((sample) => [sample.first, sample.last]);
  const since = (span: number): number | null => {
    const floor = newest.hour - span;
    const anchor = [...hours].reverse().find((sample) => sample.hour <= floor);
    const values = [...(anchor ? [anchor.last] : []), ...readings(hours.filter((sample) => sample.hour > floor))];
    return values.length < 2 ? null : round(burnBetween(values));
  };
  const rateWindow = hours.filter((sample) => sample.hour > newest.hour - BURN_RATE_HOURS);
  const rateSpanHours = (newest.lastTs - rateWindow[0]!.firstTs) / HOUR_MS;
  const ratePercentPerHour = rateSpanHours > 0 ? round(burnBetween(readings(rateWindow)) / rateSpanHours) : null;
  const resetsAtMs = newest.resetsAt ? Date.parse(newest.resetsAt) : NaN;
  let projectedExhaustionAt: string | null = null;
  let exhaustsBeforeReset: boolean | null = null;
  if (ratePercentPerHour !== null && ratePercentPerHour > 0) {
    const exhaustMs = newest.lastTs + ((100 - newest.last) / ratePercentPerHour) * HOUR_MS;
    exhaustsBeforeReset = Number.isFinite(resetsAtMs) ? exhaustMs < resetsAtMs : null;
    if (exhaustsBeforeReset !== false) projectedExhaustionAt = isoAt(exhaustMs);
  }
  return {
    name,
    kind,
    durationMs,
    usedPercent: newest.last,
    remainingPercent: Math.max(0, 100 - newest.last),
    limitPercent: newest.limitPercent ?? null,
    resetsAt: newest.resetsAt ?? null,
    asOf: isoAt(newest.lastTs),
    source: "ledger",
    state: Number.isFinite(resetsAtMs) && resetsAtMs <= asOfMs ? "stale" : "observed",
    burn: { lastHourPercent: since(1), last24hPercent: since(24), ratePercentPerHour },
    projectedExhaustionAt,
    exhaustsBeforeReset,
    series: hours
      .filter((sample) => sample.hour > newest.hour - SERIES_HOURS)
      .map((sample) => ({ hour: hourIso(sample.hour), usedPercent: sample.last, maxUsedPercent: sample.max, samples: sample.samples })),
  };
}

function share<T extends { count: number }>(rows: T[], total: number): Array<T & { sharePercent: number }> {
  return rows
    .map((row) => ({ ...row, sharePercent: total > 0 ? round((row.count / total) * 100, 1) : 0 }))
    .sort((left, right) => right.count - left.count);
}

function aggregate(state: UsageTelemetryState, hours: number, asOfHour: number): UsageRoutingAggregate {
  const byKey = new Map<string, number>();
  let cashWhileSubscriptionHadRoom = 0;
  for (const bucket of state.routing) {
    if (bucket.hour <= asOfHour - hours) continue;
    cashWhileSubscriptionHadRoom += bucket.cashWhileRoom;
    for (const [key, count] of Object.entries(bucket.counts)) byKey.set(key, (byKey.get(key) ?? 0) + count);
  }
  const rows = [...byKey.entries()].map(([key, count]) => {
    const [provider, model, tier, rule] = key.split("\u0000") as [string, string, string, string];
    return { provider, model, tier, rule, count };
  });
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  const group = <K extends "provider" | "tier" | "rule">(field: K) => {
    const counts = new Map<string, number>();
    for (const row of rows) counts.set(row[field], (counts.get(row[field]) ?? 0) + row.count);
    return [...counts.entries()].map(([value, count]) => ({ [field]: value, count }) as { [P in K]: string } & { count: number });
  };
  const models = new Map<string, { provider: string; model: string; count: number }>();
  for (const row of rows) {
    const key = `${row.provider}\u0000${row.model}`;
    const entry = models.get(key) ?? { provider: row.provider, model: row.model, count: 0 };
    entry.count += row.count;
    models.set(key, entry);
  }
  return {
    windowHours: hours,
    total,
    cashWhileSubscriptionHadRoom,
    byModel: share([...models.values()], total),
    byTier: share(group("tier"), total),
    byRule: share(group("rule"), total),
    byProvider: share(group("provider"), total),
    rows: rows.sort((left, right) => right.count - left.count),
  };
}

function experiments(state: UsageTelemetryState, asOfHour: number): UsageExperimentArm[] {
  const arms = new Map<string, UsageExperimentArm & { durationTotal: number }>();
  for (const run of state.markedRuns ?? []) {
    if (run.hour <= asOfHour - 7 * 24) continue;
    for (const [marker, value] of Object.entries(run.markers)) {
      const key = [marker, value, run.provider, run.model].join("\u0000");
      const arm = arms.get(key) ?? {
        marker, value, provider: run.provider, model: run.model, runs: 0, assignments: 0, terminals: 0, successes: 0,
        successRatePercent: null, meanAssignmentsPerRun: 0, meanDurationMs: null, costUsd: 0, meanCostPerTerminalUsd: null, durationTotal: 0,
      };
      arm.runs += 1;
      arm.assignments += run.assignments;
      if (run.outcome) {
        arm.terminals += 1;
        if (run.outcome.success) arm.successes += 1;
        arm.costUsd += run.outcome.costUsd;
        arm.durationTotal += run.outcome.durationMs;
      }
      arms.set(key, arm);
    }
  }
  return [...arms.values()]
    .map(({ durationTotal, ...arm }) => ({
      ...arm,
      costUsd: round(arm.costUsd, 6),
      successRatePercent: arm.terminals > 0 ? round((arm.successes / arm.terminals) * 100, 1) : null,
      meanAssignmentsPerRun: round(arm.assignments / arm.runs),
      meanDurationMs: arm.terminals > 0 ? Math.round(durationTotal / arm.terminals) : null,
      meanCostPerTerminalUsd: arm.terminals > 0 ? round(arm.costUsd / arm.terminals, 6) : null,
    }))
    .sort((left, right) => left.marker.localeCompare(right.marker) || left.value.localeCompare(right.value) || right.runs - left.runs);
}

function cashWindow(state: UsageTelemetryState, name: UsageCashWindow["name"], fromMs: number, toMs: number, oldestHour: number | undefined): UsageCashWindow {
  let usd = 0;
  let rows = 0;
  for (const [ts, amount] of state.cashEvents ?? []) {
    if (ts < fromMs || ts > toMs) continue;
    usd += amount;
    rows += 1;
  }
  const complete = oldestHour !== undefined && fromMs >= oldestHour * HOUR_MS;
  return {
    name,
    usd: round(usd, 6),
    rows,
    complete,
    ...(complete ? {} : { reason: oldestHour === undefined ? "no ledger history is retained" : `window starts before the oldest retained hour ${hourIso(oldestHour)}` }),
  };
}

/** Project the accumulator at `asOf` (the refresh instant). PURE. */
export function buildUsageProjection(
  state: UsageTelemetryState,
  asOf: string | null,
  longCash?: { state: "observed" | "not-collected"; windows: ReadonlyArray<{ name: string; usd: number; rows: number; complete: boolean; reason?: string }> },
): UsageProjection {
  const asOfMs = asOf === null ? NaN : Date.parse(asOf);
  const asOfHour = Number.isFinite(asOfMs) ? Math.floor(asOfMs / HOUR_MS) : state.newestHour;
  const byProvider = new Map<string, UsageWindow[]>();
  for (const series of state.series) {
    const window = projectWindow(series.hours, series.window, Number.isFinite(asOfMs) ? asOfMs : Infinity);
    if (!window) continue;
    byProvider.set(series.provider, [...(byProvider.get(series.provider) ?? []), window]);
  }
  const subscriptions: UsageSubscription[] = [...new Set(["claude", "codex", ...byProvider.keys()])].filter((provider) => provider !== "cash").map((provider) => {
    const windows = (byProvider.get(provider) ?? []).sort((left, right) => (left.durationMs ?? Infinity) - (right.durationMs ?? Infinity) || left.name.localeCompare(right.name));
    const state = windows.length === 0 ? "not-collected" : windows.every((window) => window.state === "stale") ? "stale" : "observed";
    return { provider, state, windows };
  });
  const retainedHours = [
    ...state.series.flatMap((series) => series.hours.map((sample) => sample.hour)),
    ...state.cash.map((bucket) => bucket.hour),
    ...state.routing.map((bucket) => bucket.hour),
  ];
  const oldestHour = retainedHours.length > 0 ? Math.min(...retainedHours) : undefined;
  const endMs = Number.isFinite(asOfMs) ? asOfMs : (state.newestHour + 1) * HOUR_MS;
  const cashModels = new Map<string, number>();
  for (const [ts, usd, model] of state.cashEvents ?? []) {
    if (ts >= endMs - 24 * HOUR_MS && ts <= endMs) cashModels.set(model, (cashModels.get(model) ?? 0) + usd);
  }
  const cash: UsageCashLane = {
    unit: "usd",
    state: state.cash.length > 0 || longCash?.state === "observed" ? "observed" : "not-collected",
    coverage: CASH_COVERAGE,
    windows: [
      cashWindow(state, "1h", endMs - HOUR_MS, endMs, oldestHour),
      cashWindow(state, "24h", endMs - 24 * HOUR_MS, endMs, oldestHour),
      cashWindow(state, "today-utc", Math.floor(endMs / (24 * HOUR_MS)) * 24 * HOUR_MS, endMs, oldestHour),
      ...(longCash?.windows ?? [])
        .filter((window): window is typeof window & { name: "7d" | "30d" } => window.name === "7d" || window.name === "30d")
        .map((window) => ({ name: window.name, usd: window.usd, rows: window.rows, complete: window.complete, ...(window.reason ? { reason: window.reason } : {}) })),
    ],
    byModel24h: [...cashModels.entries()].map(([model, usd]) => ({ model, usd: round(usd, 6) })).sort((left, right) => right.usd - left.usd),
    series: state.cash
      .filter((bucket) => bucket.hour > asOfHour - SERIES_HOURS)
      .sort((left, right) => left.hour - right.hour)
      .map((bucket) => ({ hour: hourIso(bucket.hour), usd: round(bucket.usd, 6), rows: bucket.rows })),
  };
  return {
    version: USAGE_PROJECTION_VERSION,
    asOf,
    coverage: {
      from: oldestHour === undefined ? null : hourIso(oldestHour),
      to: state.newestHour > 0 ? hourIso(state.newestHour) : null,
      note: "hourly buckets from daemon.headroom, worker.assignment candidate windows and cash implement.done rows",
    },
    subscriptions,
    cash,
    routing: {
      state: state.assignmentsObserved > 0 ? "observed" : "not-collected",
      assignmentsObserved: state.assignmentsObserved,
      decisionsObserved: state.decisionsObserved,
      recent: state.recent.map((entry) => ({ ...entry })),
      aggregates: { last24h: aggregate(state, 24, asOfHour), last7d: aggregate(state, 7 * 24, asOfHour) },
      experiments: experiments(state, asOfHour),
    },
  };
}

/**
 * Overlay the live provider snapshot (the routing status file, fresh for a minute after a probe) on
 * the ledger projection at request time: a newer live reading replaces a window's current figure.
 */
export function withLiveProviderWindows(projection: UsageProjection, live: LiveProviderAccounts | undefined): UsageProjection {
  const liveAsOf = live?.state === "observed" && live.asOf ? Date.parse(live.asOf) : NaN;
  if (!Number.isFinite(liveAsOf)) return projection;
  const subscriptions = projection.subscriptions.map((subscription) => {
    const account = live!.accounts.find((entry) => entry.provider === subscription.provider && entry.readable);
    if (!account) return subscription;
    const windows = subscription.windows.map((window) => {
      const reading = account.windows.find((entry) => entry.name === window.name);
      if (!reading || reading.usedPercent === undefined || liveAsOf <= Date.parse(window.asOf)) return window;
      return {
        ...window,
        usedPercent: reading.usedPercent,
        remainingPercent: Math.max(0, 100 - reading.usedPercent),
        resetsAt: reading.resetsAt ?? window.resetsAt,
        asOf: isoAt(liveAsOf),
        source: "live-status" as const,
        state: "observed" as const,
      };
    });
    return { ...subscription, windows, state: windows.length > 0 ? ("observed" as const) : subscription.state };
  });
  return { ...projection, subscriptions };
}
