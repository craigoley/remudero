/**
 * W1-T4629: A WORKER FORECASTS ITS OWN SUCCESS. Every implement worker ends its REPORT with an
 * anchored `SELF_FORECAST: p=<0..1>` line — its own probability that this head passes review and
 * merges without rework. The harness parses it here, ledgers it on the terminal `implement.done`
 * row beside the assignment, and {@link scoreSelfForecasts} scores it against the verified outcome
 * (W1-T4608, lib/benchmark-verified-outcome.ts) so calibration and the gap between a model's
 * confidence and its result become per-model measurements.
 *
 * A RECORD, NEVER A DECISION INPUT: nothing gates, routes or retries on a forecast. And a missing
 * or malformed forecast is ABSENT with a named reason — never coerced to 0.5, which would be a
 * fabricated, perfectly-hedged forecast the worker never made.
 */

/** The one-line prompt instruction. It deliberately does not START with the anchor, so an echo of
 *  the instruction into a transcript never reads as a forecast. */
export const SELF_FORECAST_REPORT_CONTRACT =
  "- End your REPORT with one line `SELF_FORECAST: p=<0..1>`: your probability that this head passes review and merges without rework.";

/** A line that claims to be a forecast: the anchor at its own line start (leading blanks allowed). */
export const SELF_FORECAST_LINE_RE = /^[ \t]*SELF_FORECAST:/;
/** A well-formed forecast line: `p=` and a non-negative decimal, nothing after it. */
export const SELF_FORECAST_VALUE_RE = /^[ \t]*SELF_FORECAST:[ \t]*p=(\d+(?:\.\d+)?|\.\d+)[ \t]*$/;

export type SelfForecast =
  | { state: "present"; p: number }
  | { state: "absent"; reason: "missing" }
  | { state: "invalid"; reason: "malformed" | "out-of-range" | "duplicate" };

/** Strict: exactly one anchored line, well-formed, inside the closed interval [0,1]. */
export function parseSelfForecast(reportText: string): SelfForecast {
  const lines = reportText.split(/\r?\n/).filter((line) => SELF_FORECAST_LINE_RE.test(line));
  if (lines.length === 0) return { state: "absent", reason: "missing" };
  if (lines.length > 1) return { state: "invalid", reason: "duplicate" };
  const match = SELF_FORECAST_VALUE_RE.exec(lines[0]);
  if (!match) return { state: "invalid", reason: "malformed" };
  const p = Number(match[1]);
  if (p > 1) return { state: "invalid", reason: "out-of-range" };
  return { state: "present", p };
}

const INVALID_REASONS: ReadonlySet<unknown> = new Set(["malformed", "out-of-range", "duplicate"]);

/** W1-T4636: read a LEDGERED forecast back. Only the exact shape {@link parseSelfForecast} writes is
 *  a forecast; anything else is null — a damaged record, never re-read as a worker's absent answer. */
export function readSelfForecastRecord(value: unknown): SelfForecast | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (record.state === "present") {
    return typeof record.p === "number" && record.p >= 0 && record.p <= 1 ? { state: "present", p: record.p } : null;
  }
  if (record.state === "absent") return record.reason === "missing" ? { state: "absent", reason: "missing" } : null;
  if (record.state === "invalid" && INVALID_REASONS.has(record.reason)) {
    return { state: "invalid", reason: record.reason as "malformed" | "out-of-range" | "duplicate" };
  }
  return null;
}

/** One forecast joined to its verified outcome: 1 = completed per the W1-T4608 join, 0 = verified
 *  not completed, null = no verified outcome (censored, unavailable, or not yet joined). */
export interface SelfForecastPair {
  model: string | null;
  taskClass: string | null;
  forecast: SelfForecast;
  verifiedOutcome: 0 | 1 | null;
}

export interface ReliabilityBin {
  lo: number;
  hi: number;
  count: number;
  meanForecast: number | null;
  observedRate: number | null;
}

export interface SelfForecastScoreGroup {
  model: string | null;
  taskClass: string | null;
  pairs: number;
  scored: number;
  forecastAbsent: number;
  outcomeUnverified: number;
  brier: { state: "observed"; value: number }
    | { state: "unavailable"; reason: "no-forecast" | "no-verified-outcome" | "no-scored-pair" };
  meanForecast: number | null;
  observedRate: number | null;
  /** meanForecast − observedRate: positive is over-confidence, negative under-confidence. */
  perceptionGap: number | null;
  reliability: ReliabilityBin[];
}

export interface SelfForecastScore {
  state: "observed" | "unavailable";
  groups: SelfForecastScoreGroup[];
}

const mean = (values: readonly number[]): number | null =>
  values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : null;

/** Brier score and a binned reliability curve per (model, task class). Only a pair with BOTH a
 *  present forecast and a verified outcome is scored; the rest are counted, never imputed. */
export function scoreSelfForecasts(pairs: readonly SelfForecastPair[], opts: { bins?: number } = {}): SelfForecastScore {
  const bins = opts.bins ?? 10;
  if (!Number.isInteger(bins) || bins < 1) throw new RangeError("scoreSelfForecasts: bins must be a positive integer");
  const byGroup = new Map<string, SelfForecastPair[]>();
  for (const pair of pairs) {
    const key = JSON.stringify([pair.model, pair.taskClass]);
    byGroup.set(key, [...(byGroup.get(key) ?? []), pair]);
  }
  const groups = [...byGroup.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, members]) => {
    const forecastAbsent = members.filter((m) => m.forecast.state !== "present").length;
    const outcomeUnverified = members.filter((m) => m.verifiedOutcome === null).length;
    const scored = members.flatMap((m) =>
      m.forecast.state === "present" && m.verifiedOutcome !== null ? [{ p: m.forecast.p, o: m.verifiedOutcome }] : []);
    const reliability: ReliabilityBin[] = Array.from({ length: bins }, (_, i) => {
      const inBin = scored.filter(({ p }) => Math.min(Math.floor(p * bins), bins - 1) === i);
      return { lo: i / bins, hi: (i + 1) / bins, count: inBin.length,
        meanForecast: mean(inBin.map(({ p }) => p)), observedRate: mean(inBin.map(({ o }) => o)) };
    });
    const meanForecast = mean(scored.map(({ p }) => p));
    const observedRate = mean(scored.map(({ o }) => o));
    const brier: SelfForecastScoreGroup["brier"] = scored.length
      ? { state: "observed", value: mean(scored.map(({ p, o }) => (p - o) ** 2))! }
      : { state: "unavailable",
        reason: forecastAbsent === members.length ? "no-forecast"
          : outcomeUnverified === members.length ? "no-verified-outcome" : "no-scored-pair" };
    return { model: members[0].model, taskClass: members[0].taskClass, pairs: members.length, scored: scored.length,
      forecastAbsent, outcomeUnverified, brier, meanForecast, observedRate,
      perceptionGap: meanForecast === null || observedRate === null ? null : meanForecast - observedRate, reliability };
  });
  return { state: groups.some((g) => g.scored > 0) ? "observed" : "unavailable", groups };
}

export const SELF_FORECAST_CALIBRATION_VERSION = "self-forecast-calibration-v1" as const;

/** W1-T4636: the cohort snapshot's calibration record. Descriptive only — never a routing input, a
 *  gate or a public claim — and it names no task, run or assignment: groups key on model x class. */
export interface SelfForecastCalibration {
  version: typeof SELF_FORECAST_CALIBRATION_VERSION;
  state: "observed" | "unavailable";
  reason: string | null;
  asOf: string | null;
  claim: "descriptive-not-causal";
  routingInput: "never";
  /** null only when no verified-outcome join was supplied: then nothing below was measured. */
  coverage: {
    /** `implement.done` rows paired to a cohort assignment and carrying a readable forecast record. */
    paired: number;
    forecasts: { present: number; absent: number; invalid: number };
    /** Completed = 1, closed-unmerged-unadjudicated = 0; `excluded` is left unscored, by reason. */
    outcomes: { completed: number; notCompleted: number; excluded: Record<string, number> };
    /** `implement.done` rows that never became a pair, by reason. */
    unpaired: Record<string, number>;
  } | null;
  score: SelfForecastScore | null;
}

/** The explicit unavailable value: no join, so no pair was built and nothing is imputed. */
export function unavailableSelfForecastCalibration(reason: string, asOf: string | null): SelfForecastCalibration {
  return { version: SELF_FORECAST_CALIBRATION_VERSION, state: "unavailable", reason, asOf,
    claim: "descriptive-not-causal", routingInput: "never", coverage: null, score: null };
}
