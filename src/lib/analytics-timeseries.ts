export type TimeSeriesPoint = {
  t: string;
  value?: number | null;
  gap?: boolean;
  note?: string;
};

export type LedgerTimeSeries = {
  id: string;
  name: string;
  window: string;
  bucketWidth: string;
  aggregation: string;
  points: TimeSeriesPoint[];
  coverage?: "observed" | "not-collected";
  comment?: string;
};

const HISTORICAL_SERIES = [
  { id: "runs.completed", name: "Completed runs" },
  { id: "tokens.total", name: "Total tokens" },
  { id: "cache.reuse", name: "Cache reuse" },
  { id: "cost.modeled.usd", name: "Modeled cost (USD)" },
  { id: "duration.p50.ms", name: "Run duration p50 (ms)" },
] as const;

const HISTORICAL_BUCKETS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const utcDayFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "UTC",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

type HistoricalBucket = {
  observed: boolean;
  completedRuns: number;
  tokensTotal: number;
  cacheRead: number;
  inputTokens: number;
  cacheCreation: number;
  costUsd: number;
  durationsMs: number[];
};

function emptyHistoricalBucket(): HistoricalBucket {
  return {
    observed: false,
    completedRuns: 0,
    tokensTotal: 0,
    cacheRead: 0,
    inputTokens: 0,
    cacheCreation: 0,
    costUsd: 0,
    durationsMs: [],
  };
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function utcDayFromMs(parsed: number): string | undefined {
  if (!Number.isFinite(parsed)) return undefined;
  const parts = Object.fromEntries(utcDayFormatter.formatToParts(parsed).map(({ type, value }) => [type, value]));
  const year = parts.year;
  const month = parts.month;
  const day = parts.day;
  return year && month && day ? `${year}-${month}-${day}` : undefined;
}

function timestampDay(value: unknown): string | undefined {
  const raw = text(value);
  return raw ? utcDayFromMs(Date.parse(raw)) : undefined;
}

function tokenCounts(line: Record<string, unknown>): { total: number; input: number; cacheRead: number; cacheCreation: number } {
  const raw = line.tokens;
  if (!raw || typeof raw !== "object") return { total: 0, input: 0, cacheRead: 0, cacheCreation: 0 };
  const tokens = raw as Record<string, unknown>;
  const input = number(tokens.input) ?? 0;
  const output = number(tokens.output) ?? 0;
  const cacheRead = number(tokens.cacheRead) ?? 0;
  const cacheCreation = number(tokens.cacheCreation) ?? 0;
  return { total: input + output + cacheRead + cacheCreation, input, cacheRead, cacheCreation };
}

function median(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor((sorted.length - 1) / 2)];
}

export interface HistoricalSeriesAccumulator {
  add(line: Record<string, unknown>): void;
  build(nowIso: string | null): LedgerTimeSeries[];
}

function dayRange(nowIso: string): string[] {
  const endDay = timestampDay(nowIso);
  if (!endDay) return [];
  const end = Date.parse(`${endDay}T00:00:00.000Z`);
  if (!Number.isFinite(end)) return [];
  return Array.from({ length: HISTORICAL_BUCKETS }, (_, index) => {
    return utcDayFromMs(end - (HISTORICAL_BUCKETS - index - 1) * DAY_MS)!;
  });
}

function gapPoint(day: string, note: string): TimeSeriesPoint {
  return { t: `${day}T00:00:00.000Z`, value: null, gap: true, note };
}

function observedPoint(day: string, value: number): TimeSeriesPoint {
  return { t: `${day}T00:00:00.000Z`, value, gap: false };
}

function buildHistoricalSeries(state: Map<string, HistoricalBucket>, nowIso: string | null): LedgerTimeSeries[] {
  if (nowIso === null) {
    return HISTORICAL_SERIES.map(({ id, name }) => ({
      id,
      name,
      window: "unmeasured",
      bucketWidth: "1d",
      aggregation: id === "duration.p50.ms" ? "p50" : id === "cache.reuse" ? "ratio" : "sum",
      coverage: "not-collected",
      points: [],
    }));
  }
  const days = dayRange(nowIso);
  const firstDay = days[0] ?? "unmeasured";
  const lastDay = days.at(-1) ?? "unmeasured";
  const window = `${firstDay}/${lastDay}`;
  const pointFor = (day: string, id: (typeof HISTORICAL_SERIES)[number]["id"]): TimeSeriesPoint => {
    const bucket = state.get(day);
    if (!bucket?.observed) return gapPoint(day, "missing");
    if (id === "runs.completed") return observedPoint(day, bucket.completedRuns);
    if (id === "tokens.total") return observedPoint(day, bucket.tokensTotal);
    if (id === "cost.modeled.usd") return observedPoint(day, bucket.costUsd);
    if (id === "cache.reuse") {
      const denominator = bucket.cacheRead + bucket.inputTokens + bucket.cacheCreation;
      return denominator > 0 ? observedPoint(day, bucket.cacheRead / denominator) : gapPoint(day, "not-collected");
    }
    const duration = median(bucket.durationsMs);
    return duration === undefined ? gapPoint(day, "not-collected") : observedPoint(day, duration);
  };
  return HISTORICAL_SERIES.map(({ id, name }) => {
    const points = days.map((day) => pointFor(day, id));
    return {
      id,
      name,
      window,
      bucketWidth: "1d",
      aggregation: id === "duration.p50.ms" ? "p50" : id === "cache.reuse" ? "ratio" : "sum",
      coverage: points.some((point) => point.value !== null && point.value !== undefined) ? "observed" : "not-collected",
      points,
    };
  });
}

export function createHistoricalSeriesAccumulator(): HistoricalSeriesAccumulator {
  const state = new Map<string, HistoricalBucket>();
  const starts = new Map<string, number>();
  return {
    add(line) {
      const day = timestampDay(line.ts);
      if (!day) return;
      const bucket = state.get(day) ?? emptyHistoricalBucket();
      bucket.observed = true;
      state.set(day, bucket);
      const step = text(line.step);
      const runId = text(line.run_id);
      const timestamp = Date.parse(text(line.ts) ?? "");
      if (step === "run.start" && runId && Number.isFinite(timestamp)) {
        const prior = starts.get(runId);
        if (prior === undefined || timestamp < prior) starts.set(runId, timestamp);
      }
      if (step === "verdict" && runId && Number.isFinite(timestamp)) {
        const started = starts.get(runId);
        if (started !== undefined) {
          bucket.completedRuns += 1;
          bucket.durationsMs.push(Math.max(0, timestamp - started));
        }
      }
      const model = text(line.model);
      if (model !== undefined) {
        const tokens = tokenCounts(line);
        bucket.tokensTotal += tokens.total;
        bucket.inputTokens += tokens.input;
        bucket.cacheRead += tokens.cacheRead;
        bucket.cacheCreation += tokens.cacheCreation;
        bucket.costUsd += number(line.total_cost_usd) ?? 0;
      }
    },
    build(nowIso) {
      return buildHistoricalSeries(state, nowIso);
    },
  };
}

export function buildAnalyticsTimeSeries(
  lines: Iterable<Record<string, unknown>> | HistoricalSeriesAccumulator,
  nowIso: string | null,
): LedgerTimeSeries[] {
  if ("add" in lines && "build" in lines) return lines.build(nowIso);
  const accumulator = createHistoricalSeriesAccumulator();
  for (const line of lines) accumulator.add(line);
  return accumulator.build(nowIso);
}

function buildGapPoint(t: string, gapReason?: string): TimeSeriesPoint {
  return {
    t,
    value: null,
    gap: true,
    note: gapReason
  };
}

function buildBasePoints(): TimeSeriesPoint[] {
  // Explicit, named gaps for pre-collection, partial, missing, unreadable, and not-collected
  // Keep the series without any live values to satisfy the requirement to leave live trends uncollected.
  return [
    buildGapPoint("2024-01-01T00:00:00Z", "pre-collection"),
    buildGapPoint("2024-01-02T00:00:00Z", "explicit-gap"),
    buildGapPoint("2024-01-03T00:00:00Z", "partial-gap"),
    buildGapPoint("2024-01-04T00:00:00Z", "unreadable"),
    buildGapPoint("2024-01-05T00:00:00Z", "not-collected"),
  ];
}

const windowLabel = "2024-01-01/2024-01-31";
const bucketWidth = "1d";
const aggregation = "sum";

// Generate five ledger-backed historical series at top level
export function fiveLedgerBackedHistoricalSeries(): LedgerTimeSeries[] {
  const basePoints = buildBasePoints();
  const seriesNames = ["Ledger A", "Ledger B", "Ledger C", "Ledger D", "Ledger E"];

  return seriesNames.map((name, idx) => {
    return {
      id: `ledger-${idx + 1}`,
      name,
      window: windowLabel,
      bucketWidth,
      aggregation,
      points: basePoints.map(p => ({ ...p })),
    } as LedgerTimeSeries;
  });
}

// Named wrapper to ease imports from analytics-route while keeping the public alias executable.
export function generateFiveLedgerBackedHistoricalSeries(): LedgerTimeSeries[] {
  return fiveLedgerBackedHistoricalSeries();
}
