/**
 * Process-owned cache for the live portion of `/v1/analytics`.
 *
 * Refreshes are deliberately file-only and occur before a request reaches the analytics route.
 * The route receives `current` alone, so it cannot trigger a provider probe, credential read,
 * queue refresh, or routing write.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  adaptLiveAnalyticsMetrics,
  emptyLiveAnalyticsMetrics,
  type LiveAnalyticsMetrics,
  type LiveProviderSnapshot,
  type LiveStatusSnapshot,
} from "./analytics-live-metrics.js";
import { readProviderRoutingStatus } from "./provider-routing-status.js";

const STATUS_PATH = ["state", "status.json"] as const;
const MAX_STATUS_BYTES = 1024 * 1024;
const MAX_STATUS_TASKS = 10_000;
export const LIVE_ANALYTICS_REFRESH_INTERVAL_MS = 15_000;

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
    return undefined;
  }
  if (Buffer.byteLength(text, "utf8") > MAX_STATUS_BYTES) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
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

export interface LiveAnalyticsSnapshotCacheDeps {
  root: string;
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
export function createLiveAnalyticsSnapshotCache(deps: LiveAnalyticsSnapshotCacheDeps): LiveAnalyticsSnapshotCache {
  const readStatus = deps.readStatus ?? readLiveStatusSnapshot;
  const readProvider = deps.readProvider ?? readProviderRoutingStatus;
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
    current = adaptLiveAnalyticsMetrics({ status, provider });
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
