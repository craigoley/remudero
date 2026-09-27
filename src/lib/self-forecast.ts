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
