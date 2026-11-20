/**
 * W1-T11026 — THE FOCUS GARDENER HOLDS NEW DISPATCH WHILE THE STUCK STACK IS DEEP (operator, 2026-10-30: "There should
 * be a gardener that smartly turns it on based on the PR queue and dispatches more fix workers. And then switches it
 * off when the queue clears.").
 *
 * The queue governor subtracts stuck owned PRs from its count (adaptive-wip.ts, ruling 2026-10-09), so a deep stuck
 * stack never defers a new build: on 2026-10-29/30 the fleet opened 39 task PRs in a day while 15-16 owned PRs sat
 * stuck. This rung judges the SAME consultation the governor just made and holds NEW task dispatch while the stuck
 * owned PRs alone reach the base WIP limit, releasing it once they have halved. The sweep never consults the queue
 * gate, so fix rounds, reviews and merges keep running, and the host worker slots new builds would have taken become
 * fix capacity (`hostWorkerBudget - activeWorkers`, sweep.ts).
 *
 * HYSTERESIS, NOT A CEILING: enter at stuck >= base, leave at stuck <= floor(base / 2), each only after the condition
 * has held for {@link FOCUS_DWELL_MS}, so one noisy reading never flips it. MEASURED 2026-10-23..10-30: the stuck owned
 * count read 0-8 on the healthy 10-23..10-27 and 11, 16 and 15 on 10-28..10-30 (base 10).
 *
 * The state is `state/FOCUS`, which this gardener alone writes and clears; its presence at boot restores the hold, and
 * its removal by hand releases it. It never reads or writes `state/QUIET_HOURS`, the operator's own flag.
 */
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import type { FixRoundReader } from "./adaptive-wip.js";
import { systemClock, type Clock } from "./clock.js";
import { writeAtomic } from "./fs-race-safe.js";
import type { QueueGovernorResult } from "./sweep.js";

export const FOCUS_FILE = "FOCUS";
export const FOCUS_OWNER = "focus-gardener";
/** PRIMARY CONTROL: how long a reading must keep asking for the other state before it flips. */
export const FOCUS_DWELL_MS = 30 * 60_000;
export const FOCUS_ENTERED_STEP = "focus.entered";
export const FOCUS_EXITED_STEP = "focus.exited";
export const FOCUS_RELEASED_STEP = "focus.released";
export const FOCUS_FLAG_FAILED_STEP = "focus.flag_failed";

export interface FocusReading {
  stuckOwnedCount: number;
  /** W1-T13990: the stuck PRs a fix lane can move. Focus enters and leaves on it; absent, on the full count. */
  movableStuckOwnedCount?: number;
  observedOpenCount: number;
  baseWipLimit: number;
}

export interface FocusState {
  on: boolean;
  /** When the current readings first asked for the other state; absent while they agree with it. */
  pendingSinceMs?: number;
}

export interface FocusDecision extends FocusState {
  changed: boolean;
  reason: string;
}

export interface FocusFlag {
  owner: typeof FOCUS_OWNER;
  since: string;
  reason: string;
  stuck_owned_count: number;
  movable_stuck_owned_count?: number;
  observed_open_count: number;
  base_wip_limit: number;
}

/** Enter at the base limit, leave at half of it: the band between keeps whichever state holds. */
export function focusBounds(baseWipLimit: number): { enterAt: number; exitAt: number } {
  const base = Math.max(1, Math.floor(baseWipLimit));
  return { enterAt: base, exitAt: Math.floor(base / 2) };
}

/** PURE: the next focus state for one reading. */
export function decideFocus(state: FocusState, reading: FocusReading, nowMs: number, dwellMs = FOCUS_DWELL_MS): FocusDecision {
  const { enterAt, exitAt } = focusBounds(reading.baseWipLimit);
  const all = Math.max(0, reading.stuckOwnedCount);
  // W1-T13990: parked PRs wait on a person, so the capacity focus frees cannot move them.
  const stuck = reading.movableStuckOwnedCount === undefined ? all : Math.min(all, Math.max(0, reading.movableStuckOwnedCount));
  const counted = reading.movableStuckOwnedCount === undefined ? `${stuck} stuck` : `${stuck} movable stuck, ${all - stuck} parked,`;
  const counts = `${counted} of ${reading.observedOpenCount} owned open PRs (enter at ${enterAt}, leave at ${exitAt})`;
  const wantsFlip = state.on ? stuck <= exitAt : stuck >= enterAt;
  if (!wantsFlip) return { on: state.on, changed: false, reason: counts };
  const since = state.pendingSinceMs ?? nowMs;
  if (nowMs - since < dwellMs) {
    return { on: state.on, pendingSinceMs: since, changed: false,
      reason: `${counts}; ${state.on ? "leaving" : "entering"} once it holds ${dwellMs / 60_000} minutes` };
  }
  return { on: !state.on, changed: true, reason: counts };
}

export function focusFilePath(stateDir: string): string {
  return join(stateDir, FOCUS_FILE);
}

/** The gardener's own flag, or undefined when the file is absent, unreadable or not this gardener's. */
export function readFocusFlag(stateDir: string): FocusFlag | undefined {
  try {
    const flag = JSON.parse(readFileSync(focusFilePath(stateDir), "utf8")) as Partial<FocusFlag> | null;
    return flag?.owner === FOCUS_OWNER ? (flag as FocusFlag) : undefined;
  } catch {
    return undefined; // absent or garbage: no hold of this gardener's stands
  }
}

type QueueGate = (() => QueueGovernorResult | undefined) & { readAdmission: () => QueueGovernorResult | undefined };

export interface FocusGateOptions {
  stateDir: string;
  log: (step: string, fields: Record<string, unknown>) => void;
  clock?: Clock;
  dwellMs?: number;
  /** W1-T13990: the fix lane's admitted and refused rounds since a time, from the gate's own ledger read. Absent or
   *  unread, a hold is never released for an unused fix lane. */
  readFixRounds?: FixRoundReader;
}

/**
 * Wrap the new-task queue gate. Every consultation is judged from the reading the gate just made (its deferral, or
 * the admission behind an undefined answer). While focus is on, an admitting reading is answered with a deferral of
 * tier `focus` and no admission is offered for lane sizing; a deferring reading passes through unchanged.
 *
 * W1-T13990: a hold exists to turn build slots into fix capacity. When a whole dwell of it passes with no fix round
 * admitted (every dispatch refused for memory or capacity, or none attempted), those slots went unused: the hold is
 * released with one `focus.released` row, and re-entry waits a full dwell again.
 */
export function focusGateFor(gate: QueueGate, opts: FocusGateOptions): QueueGate {
  const clock = opts.clock ?? systemClock;
  const dwellMs = opts.dwellMs ?? FOCUS_DWELL_MS;
  let state: FocusState = { on: readFocusFlag(opts.stateDir) !== undefined };
  // A hold restored at boot is judged on this process's own dwell, never on the flag's older `since`.
  let onSinceMs = state.on ? clock.now() : undefined;
  let held = false;
  const setFlag = (on: boolean, counts: Record<string, number>, reason: string): void => {
    const path = focusFilePath(opts.stateDir);
    try {
      if (on) {
        const flag = { owner: FOCUS_OWNER, since: clock.iso(), reason, ...counts } as FocusFlag;
        writeAtomic(path, JSON.stringify(flag, null, 2));
      } else {
        rmSync(path, { force: true });
      }
    } catch (error) {
      opts.log(FOCUS_FLAG_FAILED_STEP, { ...counts, on, error: String((error as Error)?.message ?? error) });
    }
  };
  const focused = (): QueueGovernorResult | undefined => {
    const deferred = gate();
    held = false;
    const reading = deferred ?? gate.readAdmission();
    if (reading === undefined) return deferred;
    const counts: Record<string, number> = {
      stuck_owned_count: reading.stuckOwnedCount ?? 0,
      ...(reading.movableStuckOwnedCount === undefined ? {} : { movable_stuck_owned_count: reading.movableStuckOwnedCount }),
      observed_open_count: reading.observedOpenCount,
      base_wip_limit: reading.baseWipLimit ?? reading.wipLimit,
    };
    if (state.on && readFocusFlag(opts.stateDir) === undefined) {
      // The file is the hold: removed by hand, it is released, and re-entry waits a full dwell again.
      state = { on: false };
      onSinceMs = undefined;
      opts.log(FOCUS_RELEASED_STEP, { ...counts, reason: `${FOCUS_FILE} was removed while focus held` });
    }
    const nowMs = clock.now();
    const decision = decideFocus(state, {
      stuckOwnedCount: counts.stuck_owned_count, movableStuckOwnedCount: reading.movableStuckOwnedCount,
      observedOpenCount: counts.observed_open_count, baseWipLimit: counts.base_wip_limit,
    }, nowMs, dwellMs);
    if (decision.changed) {
      setFlag(decision.on, counts, decision.reason);
      onSinceMs = decision.on ? nowMs : undefined;
      opts.log(decision.on ? FOCUS_ENTERED_STEP : FOCUS_EXITED_STEP, { ...counts, reason: decision.reason });
    }
    state = { on: decision.on, ...(decision.pendingSinceMs === undefined ? {} : { pendingSinceMs: decision.pendingSinceMs }) };
    const rounds = state.on && onSinceMs !== undefined && nowMs - onSinceMs >= dwellMs
      ? opts.readFixRounds?.(nowMs - dwellMs) : undefined;
    if (rounds !== undefined && rounds.admitted === 0) {
      const reason = `no fix round was admitted in ${dwellMs / 60_000} minutes of focus (${rounds.refused} refused): ` +
        "the build slots it held went unused";
      setFlag(false, counts, reason);
      state = { on: false };
      onSinceMs = undefined;
      opts.log(FOCUS_RELEASED_STEP, {
        ...counts, cause: rounds.refused > 0 ? "fix_lane_refused" : "fix_lane_idle", refused_count: rounds.refused, reason,
      });
    }
    if (deferred !== undefined || !state.on) return deferred;
    held = true;
    return { ...reading, deferred: true, tier: "focus" };
  };
  return Object.assign(focused, { readAdmission: () => (held ? undefined : gate.readAdmission()) });
}
