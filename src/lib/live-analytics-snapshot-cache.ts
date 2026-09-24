/**
 * Process-owned cache for the live portion of `/v1/analytics`.
 *
 * Refreshes are deliberately file-only and occur before a request reaches the analytics route.
 * The route receives `current` alone, so it cannot trigger a provider probe, credential read,
 * queue refresh, or routing write.
 */
import { closeSync, fstatSync, openSync, readFileSync, readSync } from "node:fs";
import { join } from "node:path";
import {
  adaptLiveAnalyticsMetrics,
  emptyLiveAnalyticsMetrics,
  type LiveAnalyticsMetrics,
  type LiveProviderSnapshot,
  type LiveStatusSnapshot,
} from "./analytics-live-metrics.js";
import { readProviderRoutingStatus } from "./provider-routing-status.js";
import { HEADROOM_SAMPLE_MAX_AGE_MS } from "./daemon.js";
import { LEDGER_FILENAME } from "./ledger-path.js";
import { systemClock, type Clock } from "./clock.js";

const STATUS_PATH = ["state", "status.json"] as const;
const MAX_STATUS_BYTES = 1024 * 1024;
const MAX_STATUS_TASKS = 10_000;
export const LIVE_ANALYTICS_REFRESH_INTERVAL_MS = 15_000;
/** How much of the live ledger's tail a refresh scans for the newest headroom row: bounded, never the union. */
const HEADROOM_TAIL_BYTES = 2 * 1024 * 1024;
/** A headroom row older than this many of the daemon's own sampling intervals is stale. */
const HEADROOM_STALE_INTERVALS = 3;
export const HEADROOM_FALLBACK_REASON = "source: the daemon's own daemon.headroom ledger reading; no routing probe was available";

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : undefined;
}

function iso(value: unknown): string | undefined {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : undefined;
}

/** Read the daemon-written, machine-owned projection without resolving GitHub or credentials. */
export function readLiveStatusSnapshot(root: string): LiveStatusSnapshot | undefined {
  let text: string;
  try {
    text = readFileSync(join(root, ...STATUS_PATH), "utf8");
  } catch {
    // An unreadable daemon projection is an unavailable snapshot, not a queued-task count.
    return undefined;
  }
  if (Buffer.byteLength(text, "utf8") > MAX_STATUS_BYTES) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Malformed daemon output is unavailable evidence; do not treat it as an empty projection.
    return undefined;
  }
  const projection = record(parsed);
  const tasks = record(projection?.tasks);
  if (!projection || !tasks) return undefined;
  const rows = Object.values(tasks);
  if (rows.length > MAX_STATUS_TASKS) return undefined;
  let queued = 0;
  for (const row of rows) {
    if (record(row)?.status === "queued") queued += 1;
  }
  const generatedAt = iso(projection.generated_at);
  return { ...(generatedAt ? { generated_at: generatedAt } : {}), counts: { queued } };
}

/**
 * W1-T4445 — the newest `daemon.headroom` row in the live ledger's tail, as a claude provider snapshot.
 * Its freshness is its age against the daemon's own sampling cadence, never the routing file's 60 s bound.
 */
export function readDaemonHeadroomSnapshot(root: string, nowMs: number): LiveProviderSnapshot | undefined {
  let text: string;
  try {
    const fd = openSync(join(root, "state", LEDGER_FILENAME), "r");
    try {
      const size = fstatSync(fd).size;
      const length = Math.min(size, HEADROOM_TAIL_BYTES);
      const buffer = Buffer.alloc(length);
      readSync(fd, buffer, 0, length, size - length);
      text = buffer.toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    // No readable ledger is no fallback reading; the provider metric stays explicitly not-probed.
    return undefined;
  }
  const lines = text.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (!lines[index]!.includes('"daemon.headroom"')) continue;
    let row: JsonRecord | undefined;
    try {
      row = record(JSON.parse(lines[index]!));
    } catch {
      // The first line of a byte-bounded tail is usually torn; an older row may still parse.
      continue;
    }
    const observedAt = iso(row?.ts);
    const usedPercent = row?.percent_used;
    if (row?.step !== "daemon.headroom" || !observedAt || typeof row.window !== "string" || typeof usedPercent !== "number") continue;
    const pollMs = typeof row.poll_interval_ms === "number" && row.poll_interval_ms > 0 ? row.poll_interval_ms : 0;
    const staleAfterMs = HEADROOM_STALE_INTERVALS * Math.max(pollMs, HEADROOM_SAMPLE_MAX_AGE_MS);
    const resetsAt = iso(row.resets_at);
    return {
      state: "selected",
      freshness: nowMs - Date.parse(observedAt) > staleAfterMs ? "stale" : "fresh",
      observedAt,
      providers: [{ provider: "claude", readable: true, windows: [{ name: row.window, usedPercent, ...(resetsAt ? { resetsAt } : {}) }] }],
    };
  }
  return undefined;
}

export interface LiveAnalyticsSnapshotCacheOptions {
  root: string;
  /** The W1-T4445 fallback reader, used only when the routing snapshot is absent or not-probed. */
  readHeadroom?: (root: string, nowMs: number) => LiveProviderSnapshot | undefined;
  clock?: Clock;
  readStatus?: (root: string) => LiveStatusSnapshot | undefined;
  readProvider?: (root: string) => LiveProviderSnapshot | undefined;
  refreshIntervalMs?: number;
  schedule?: (callback: () => void, delayMs: number) => { cancel(): void };
}

export interface LiveAnalyticsSnapshotCache {
  current(): LiveAnalyticsMetrics;
  refresh(): Promise<void>;
  start(): void;
  stop(): void;
}

function systemSchedule(callback: () => void, delayMs: number): { cancel(): void } {
  const timer = setTimeout(callback, delayMs);
  timer.unref();
  return { cancel: () => clearTimeout(timer) };
}

/**
 * Keep the two already-published daemon snapshots in memory for the analytics route.
 * A refresh failure replaces neither prior metric with an invented value; the cache retains the
 * previous projection, or its explicit cold state before the first successful read.
 */
export function createLiveAnalyticsSnapshotCache(deps: LiveAnalyticsSnapshotCacheOptions): LiveAnalyticsSnapshotCache {
  const readStatus = deps.readStatus ?? readLiveStatusSnapshot;
  const readProvider = deps.readProvider ?? readProviderRoutingStatus;
  const readHeadroom = deps.readHeadroom ?? readDaemonHeadroomSnapshot;
  const clock = deps.clock ?? systemClock;
  const refreshIntervalMs = deps.refreshIntervalMs ?? LIVE_ANALYTICS_REFRESH_INTERVAL_MS;
  const schedule = deps.schedule ?? systemSchedule;
  let current = emptyLiveAnalyticsMetrics();
  let status: LiveStatusSnapshot | undefined;
  let provider: LiveProviderSnapshot | undefined;
  let active = false;
  let timer: { cancel(): void } | undefined;

  const scheduleNext = () => {
    if (!active || timer) return;
    timer = schedule(() => {
      timer = undefined;
      void refresh();
    }, refreshIntervalMs);
  };

  const refresh = async (): Promise<void> => {
    try {
      status = readStatus(deps.root);
    } catch {
      // Preserve the previous value: an unreadable file must not erase known evidence.
    }
    try {
      provider = readProvider(deps.root);
    } catch {
      // The adapter represents the absent provider snapshot explicitly.
    }
    let fallback: LiveProviderSnapshot | undefined;
    if (!provider || provider.state === "not-probed" || (provider.state === "unknown" && provider.reason === "absent")) {
      try {
        fallback = readHeadroom(deps.root, clock.now());
      } catch {
        // A failed fallback read leaves the routing snapshot's own explicit state in place.
      }
    }
    current = adaptLiveAnalyticsMetrics({ status, provider: fallback ?? provider });
    if (fallback) {
      const prior = current.provider.accounts.reason;
      current.provider.accounts = { ...current.provider.accounts, reason: prior ? `${prior}; ${HEADROOM_FALLBACK_REASON}` : HEADROOM_FALLBACK_REASON };
    }
    scheduleNext();
  };

  return {
    current: () => current,
    refresh,
    start: () => {
      if (active) return;
      active = true;
      void refresh();
    },
    stop: () => {
      active = false;
      timer?.cancel();
      timer = undefined;
    },
  };
}
