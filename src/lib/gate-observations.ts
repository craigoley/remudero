import { createHash } from "node:crypto";

import { systemClock, type Clock } from "./clock.js";

/**
 * lib/gate-observations.ts (W1-T4685) — a repeated gate observation is one row.
 *
 * MEASURED: this Mac's ledger held 799 identical `daemon.pause` rows against 800 `daemon.tick`
 * rows — one appended EVERY tick, unconditionally, for as long as the same pause condition held.
 * Ledger volume drives the known OOM risk in ledger readers (memory: daemon OOM profile). Nothing
 * here removes a caller's own logging; it gives a caller a place to route an "unchanged since last
 * time" observation through so ONE row tracks it — first seen, last seen and a count — instead of
 * one row per call.
 *
 * The key is `(lane, gate, condition hash)` (design (i)): two calls with the same lane, gate and
 * condition collapse onto the SAME row; a call whose condition differs (a different hash) starts a
 * NEW row and flushes it immediately — a change is never held back. An unchanged row is flushed
 * again only once `heartbeatMs` has elapsed since it last flushed, so a reader watching for
 * liveness (fleet-liveness.ts's `HEARTBEAT_STEPS`) still sees a periodic pulse, never silence.
 *
 * `snapshotGateObservations` is the read side of design (iii): a reader that wants "how many times
 * did this gate observe this condition" reads a row's `count`, never `rows.filter(...).length`.
 */

export type GateObservationLog = (step: string, extra?: Record<string, unknown>) => void;

/** The ledger step a flushed row is logged under, unless a caller names its own. */
export const GATE_OBSERVED_STEP = "gate.observed" as const;

export interface GateObservationRow {
  lane: string;
  gate: string;
  conditionHash: string;
  condition: unknown;
  /** ISO-8601. Set once, on the row's first observation. */
  firstSeenIso: string;
  /** ISO-8601. Updated on every observation, flushed or not. */
  lastSeenIso: string;
  /** Every observation of this (lane, gate, condition) key, flushed or not. */
  count: number;
}

interface TrackedRow extends GateObservationRow {
  lastFlushedMs: number;
}

/** Opaque, per-caller state — one instance per logical "who is observing", never a module-level
 *  singleton (two unrelated daemon runs in the same test process must never share rows). */
export interface GateObservationState {
  readonly rows: Map<string, TrackedRow>;
}

export function createGateObservationState(): GateObservationState {
  return { rows: new Map() };
}

export interface ObserveGateOptions {
  lane: string;
  gate: string;
  /** Any JSON-serializable value; two conditions that serialize the same way hash the same. */
  condition: unknown;
  /** How long an unchanged row may go unflushed before a heartbeat flushes it anyway. */
  heartbeatMs: number;
  clock?: Clock;
  /** Ledger step name a flush is logged under. Defaults to {@link GATE_OBSERVED_STEP}. */
  step?: string;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

/** Deterministic across key order — `{a:1,b:2}` and `{b:2,a:1}` hash the same. */
export function conditionHash(condition: unknown): string {
  return createHash("sha256").update(stableStringify(condition)).digest("hex").slice(0, 16);
}

function flush(step: string, row: TrackedRow, log: GateObservationLog): void {
  log(step, {
    lane: row.lane,
    gate: row.gate,
    condition: row.condition,
    condition_hash: row.conditionHash,
    first_seen: row.firstSeenIso,
    last_seen: row.lastSeenIso,
    count: row.count,
  });
}

/**
 * Observe one gate, at one lane, under one condition. An unchanged (lane, gate, condition) key
 * increments the SAME row's count and only flushes again once `heartbeatMs` has elapsed since its
 * last flush; a changed condition (a different hash) starts a new row and flushes it immediately.
 * Returns whether this call flushed.
 */
export function observeGate(state: GateObservationState, opts: ObserveGateOptions, log: GateObservationLog): boolean {
  const clock = opts.clock ?? systemClock;
  const step = opts.step ?? GATE_OBSERVED_STEP;
  const hash = conditionHash(opts.condition);
  const key = `${opts.lane}\u0000${opts.gate}\u0000${hash}`;
  const nowMs = clock.now();
  const nowIso = clock.iso();

  const existing = state.rows.get(key);
  if (!existing) {
    const row: TrackedRow = {
      lane: opts.lane,
      gate: opts.gate,
      conditionHash: hash,
      condition: opts.condition,
      firstSeenIso: nowIso,
      lastSeenIso: nowIso,
      count: 1,
      lastFlushedMs: nowMs,
    };
    state.rows.set(key, row);
    flush(step, row, log);
    return true;
  }

  existing.count += 1;
  existing.lastSeenIso = nowIso;
  if (nowMs - existing.lastFlushedMs >= opts.heartbeatMs) {
    existing.lastFlushedMs = nowMs;
    flush(step, existing, log);
    return true;
  }
  return false;
}

/** The read side of design (iii): every tracked row, count included, never one entry per
 *  observation. A reader that wants "how many times" reads `.count`, not `.length`. */
export function snapshotGateObservations(state: GateObservationState): GateObservationRow[] {
  return Array.from(state.rows.values(), (row) => ({
    lane: row.lane,
    gate: row.gate,
    conditionHash: row.conditionHash,
    condition: row.condition,
    firstSeenIso: row.firstSeenIso,
    lastSeenIso: row.lastSeenIso,
    count: row.count,
  }));
}
