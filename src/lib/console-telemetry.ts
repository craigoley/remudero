/**
 * `POST /v1/console/telemetry`: console-side latency lands in core's own ledger (arch plan Phase 2,
 * design D9 and §5, P2-06).
 *
 * The console's hops (the stream relay, the view refetch, the render) are measured nowhere today:
 * Vercel observability answers 404 and its runtime logs keep a short window. The browser batches one
 * record per applied view update and beacons it to a console route, which forwards the batch here. Each
 * record becomes one `console.latency` row, so `rmd ledger-grep`, the projector and the 24 h check read
 * it with the same tooling as every other measurement.
 *
 * - Reachable with the write token or the ingest-only token, which serve.ts scopes to this one method
 *   and path (the same grantor as the incident route, `ingestTokenProvider`).
 * - A body over 16 KiB answers 413, an invalid one 400; nothing is ledgered from either.
 * - BACKSTOP: rows are paced to about one a second sustained (a bucket of {@link TELEMETRY_BURST_ROWS}
 *   refilled at one row a second). Records past it are counted in the answer, and at most one
 *   `console.latency_dropped` row a minute says how many were dropped.
 */
import { appendLedger } from "./ledger.js";
import { sendJson, type PanelActionDeps } from "./panel-actions.js";
import { systemClock, type Clock } from "./clock.js";
import { RawBodyTooLargeError, readBoundedRawBody, type Route } from "./service.js";

export const CONSOLE_TELEMETRY_ROUTE_PATH = "/v1/console/telemetry";
export const CONSOLE_TELEMETRY_ROUTE_METHOD = "POST" as const;
/** PRIMARY CONTROL: the console flushes at most 50 records a batch (design §5), so a larger one is malformed. */
export const TELEMETRY_MAX_RECORDS = 50;
/** BACKSTOP: the most rows one burst may write before the one-a-second pace applies. */
export const TELEMETRY_BURST_ROWS = 60;
const MAX_BODY_BYTES = 16 * 1024;
const REFILL_MS_PER_ROW = 1_000;
const DROPPED_ROW_EVERY_MS = 60_000;
/** A duration past an hour is a clock or a bug, not a latency. */
const MAX_DURATION_MS = 3_600_000;

const CAUSES: ReadonlySet<string> = new Set(["body", "judge", "hello", "poll"]);
/** The per-hop durations a record may carry, all milliseconds (design §4.1's hops 5-7). */
const DURATIONS = ["transportMs", "fetchMs", "coreMs", "applyMs", "paintMs", "totalMs"] as const;

/** One applied view update as the console measured it. */
export interface ConsoleLatencyRecord {
  view: string;
  key: string;
  cause: "body" | "judge" | "hello" | "poll";
  /** The serve-clock time the view event was emitted, when the update came from one. */
  emittedAt?: string;
  transportMs?: number;
  fetchMs?: number;
  coreMs?: number;
  applyMs?: number;
  paintMs?: number;
  totalMs?: number;
  /** The browser's estimate of its clock minus serve's, from the stream's `hello.serverNow`. */
  clockOffsetMs?: number;
}

const text = (value: unknown, max: number): value is string => typeof value === "string" && value.length > 0 && value.length <= max;

/** The batch's records, or why it is unusable. Unknown fields are dropped, never ledgered. */
export function validateTelemetryBatch(body: unknown): { ok: true; records: ConsoleLatencyRecord[] } | { ok: false; reason: string } {
  const records = (body as { records?: unknown } | null)?.records;
  if (!Array.isArray(records) || records.length === 0) return { ok: false, reason: "records must be a non-empty array" };
  if (records.length > TELEMETRY_MAX_RECORDS) return { ok: false, reason: `at most ${TELEMETRY_MAX_RECORDS} records a batch` };
  const out: ConsoleLatencyRecord[] = [];
  for (const [i, raw] of records.entries()) {
    const r = (raw ?? {}) as Record<string, unknown>;
    if (!text(r.view, 64) || (!text(r.key, 256) && r.key !== "")) return { ok: false, reason: `records[${i}] needs a view and a key` };
    if (typeof r.cause !== "string" || !CAUSES.has(r.cause)) return { ok: false, reason: `records[${i}].cause must be body, judge, hello or poll` };
    const record: ConsoleLatencyRecord = { view: r.view, key: r.key as string, cause: r.cause as ConsoleLatencyRecord["cause"] };
    if (r.emittedAt !== undefined) {
      if (!text(r.emittedAt, 40) || Number.isNaN(Date.parse(r.emittedAt))) return { ok: false, reason: `records[${i}].emittedAt is not a time` };
      record.emittedAt = r.emittedAt;
    }
    for (const field of DURATIONS) {
      const value = r[field];
      if (value === undefined) continue;
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > MAX_DURATION_MS) return { ok: false, reason: `records[${i}].${field} must be 0..${MAX_DURATION_MS} ms` };
      record[field] = Math.round(value);
    }
    if (r.clockOffsetMs !== undefined) {
      if (typeof r.clockOffsetMs !== "number" || !Number.isFinite(r.clockOffsetMs)) return { ok: false, reason: `records[${i}].clockOffsetMs must be a number` };
      record.clockOffsetMs = Math.round(r.clockOffsetMs);
    }
    out.push(record);
  }
  return { ok: true, records: out };
}

/** `POST /v1/console/telemetry` (write, tier low): validate, pace, and ledger one row per record. */
export function buildConsoleTelemetryRoute(deps: Pick<PanelActionDeps, "ledgerPath">, clock: Clock = systemClock): Route {
  let tokens = TELEMETRY_BURST_ROWS;
  let refilledAt = Number.NaN;
  let droppedSince = 0;
  let droppedRowAt = Number.NEGATIVE_INFINITY;
  return {
    method: CONSOLE_TELEMETRY_ROUTE_METHOD,
    path: CONSOLE_TELEMETRY_ROUTE_PATH,
    scope: "write",
    tier: "low",
    handler: async (req, res) => {
      let raw: string;
      try {
        raw = await readBoundedRawBody(req, MAX_BODY_BYTES);
      } catch (e) {
        if (e instanceof RawBodyTooLargeError) {
          sendJson(res, 413, { error: "body_too_large" });
          return;
        }
        throw e;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        sendJson(res, 400, { error: "invalid_request", detail: "body is not valid JSON" });
        return;
      }
      const batch = validateTelemetryBatch(parsed);
      if (!batch.ok) {
        sendJson(res, 400, { error: "invalid_request", detail: batch.reason });
        return;
      }
      const now = clock.now();
      tokens = Number.isNaN(refilledAt) ? tokens : Math.min(TELEMETRY_BURST_ROWS, tokens + (now - refilledAt) / REFILL_MS_PER_ROW);
      refilledAt = now;
      const accepted = batch.records.slice(0, Math.max(0, Math.floor(tokens)));
      tokens -= accepted.length;
      for (const record of accepted) appendLedger(deps.ledgerPath, { run_id: `CONSOLE-${now}`, task_id: "CONSOLE", step: "console.latency", ...record });
      const dropped = batch.records.length - accepted.length;
      droppedSince += dropped;
      if (droppedSince > 0 && now - droppedRowAt >= DROPPED_ROW_EVERY_MS) {
        appendLedger(deps.ledgerPath, { run_id: `CONSOLE-${now}`, task_id: "CONSOLE", step: "console.latency_dropped", dropped: droppedSince });
        droppedSince = 0;
        droppedRowAt = now;
      }
      sendJson(res, 200, { accepted: accepted.length, dropped });
    },
  };
}
