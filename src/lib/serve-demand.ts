import type { IncomingMessage, ServerResponse } from "node:http";
import { systemClock, type Clock } from "./clock.js";
import { appendLedger } from "./ledger.js";

export const SERVE_DEMAND_WINDOW_MS = 300_000;
/** BACKSTOP: route cardinality bounds observation memory; excess families share `other`. */
export const SERVE_DEMAND_FAMILY_CAP = 40;
// Percentiles report bucket upper bounds, capped at the observed maximum.
const LATENCY_BOUNDS_MS = [1, 5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 30_000, 60_000, Infinity];
type Statuses = Record<"1xx" | "2xx" | "3xx" | "4xx" | "5xx", number>;
interface Tally {
  n: number; ok: number; error: number; aborted: number; statuses: Statuses;
  histogram: number[]; max: number;
}

export interface ServeDemandOptions {
  ledgerPath: string;
  routes: readonly { method: string; path: string }[];
  sse?: readonly { path: string }[];
  clock?: Clock;
  every?: (tick: () => void, ms: number) => () => void;
  log?: (step: string, extra: Record<string, unknown>) => void;
}

function declaredFamily(path: string): string {
  return path.replace(/\/i\/[^/]+(?=\/|$)/, "/i/:instance")
    .replace(/\/(tasks|runs|items)\/[^/]+/g, "/$1/:id");
}

function percentile(tally: Tally, fraction: number): number {
  let rank = Math.ceil(tally.n * fraction);
  const bucket = tally.histogram.findIndex(count => (rank -= count) <= 0);
  return Math.min(LATENCY_BOUNDS_MS[bucket]!, tally.max);
}

export function createServeDemand(options: ServeDemandOptions) {
  const clock = options.clock ?? systemClock;
  const now = () => clock.now();
  // Only declared paths enter the lookup. A request's query or unmatched path is never a family.
  const routeFamilies = new Map<string, string>();
  for (const route of options.routes) {
    const key = `${route.method} ${route.path}`;
    if (!routeFamilies.has(key)) routeFamilies.set(key, declaredFamily(route.path));
  }
  for (const route of options.sse ?? []) routeFamilies.set(`GET ${route.path}`, declaredFamily(route.path));
  let windowStart = now();
  let families = new Map<string, Tally>();
  let namedFamilies = 0;
  let stopTimer: (() => void) | undefined;

  function record(family: string, status: number, elapsed: number, aborted: boolean, at = now()): void {
    // Close the previous window before tallying this completion, even if the timer ran late.
    flush(at);
    if (family !== "other" && !families.has(family) && namedFamilies >= SERVE_DEMAND_FAMILY_CAP) family = "other";
    let tally = families.get(family);
    if (!tally) {
      tally = { n: 0, ok: 0, error: 0, aborted: 0, statuses: { "1xx": 0, "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0 },
        histogram: LATENCY_BOUNDS_MS.map(() => 0), max: 0 };
      families.set(family, tally);
      if (family !== "other") namedFamilies++;
    }
    tally.n++;
    if (aborted) tally.aborted++;
    else {
      if (status >= 400) tally.error++;
      else tally.ok++;
      const statusClass = `${Math.floor(status / 100)}xx` as keyof Statuses;
      if (Object.hasOwn(tally.statuses, statusClass)) tally.statuses[statusClass]++;
    }
    const ms = Math.max(0, elapsed);
    tally.histogram[LATENCY_BOUNDS_MS.findIndex(bound => ms <= bound)]!++;
    tally.max = Math.max(tally.max, ms);
  }

  function flush(at = now()): void {
    if (at < windowStart + SERVE_DEMAND_WINDOW_MS) return;
    const windowEnd = windowStart + SERVE_DEMAND_WINDOW_MS;
    if (families.size > 0) {
      const row = {
        run_id: "serve", task_id: "", step: "serve.demand", windowStart, windowEnd,
        families: Object.fromEntries([...families].map(([family, tally]) => {
          const { histogram: _histogram, ...counts } = tally;
          return [family, { ...counts, p50: percentile(tally, 0.5), p95: percentile(tally, 0.95) }];
        })),
      };
      try {
        appendLedger(options.ledgerPath, row);
      } catch (error) {
        // Observation must not take down the gateway when its ledger is unavailable.
        const extra = { reason: String(error), windowStart, windowEnd };
        try {
          (options.log ?? ((step, detail) => console.error(step, detail)))("serve.demand_write_failed", extra);
        } catch (reportError) {
          // The production logger shares the ledger; its failure needs an independent sink.
          console.error("serve.demand_report_failed", { ...extra, reportReason: String(reportError) });
        }
      }
    }
    families = new Map(); namedFamilies = 0;
    windowStart += Math.floor((at - windowStart) / SERVE_DEMAND_WINDOW_MS) * SERVE_DEMAND_WINDOW_MS;
  }

  function start(): () => void {
    if (!stopTimer) {
      windowStart = now();
      stopTimer = options.every ? options.every(flush, SERVE_DEMAND_WINDOW_MS) : (() => {
        const timer = setInterval(flush, SERVE_DEMAND_WINDOW_MS);
        timer.unref();
        return () => clearInterval(timer);
      })();
    }
    return () => { stopTimer?.(); stopTimer = undefined; };
  }

  function familyFor(req: IncomingMessage): string | undefined {
    let path: string;
    try {
      path = new URL(req.url ?? "/", "http://localhost").pathname;
    } catch {
      // Dispatch owns malformed targets and its 400 response; observation must not intercept them.
      return undefined;
    }
    if (path !== "/v1" && !path.startsWith("/v1/")) return undefined;
    return routeFamilies.get(`${(req.method ?? "GET").toUpperCase()} ${path}`) ?? "other";
  }
  return { now, record, flush, start, familyFor };
}

export type ServeDemand = ReturnType<typeof createServeDemand>;

/** Observe transport completion, including auth/404 responses and streams, without wrapping a handler. */
export function recordServeRequest(demand: ServeDemand, req: IncomingMessage, res: ServerResponse): void {
  const family = demand.familyFor(req);
  if (family === undefined) return;
  const started = demand.now();
  let recorded = false;
  const complete = (): void => {
    if (recorded) return;
    recorded = true;
    res.off("finish", complete);
    res.off("close", complete);
    const at = demand.now();
    demand.record(family, res.statusCode, at - started, !res.writableFinished, at);
  };
  res.once("finish", complete);
  res.once("close", complete);
}
