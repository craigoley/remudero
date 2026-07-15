/**
 * lib/daemon.ts — the daemon's scheduler-loop CORE (W1-T12a).
 *
 * W1-T12 (Daemonize) was split along the machine/human boundary (DIAGNOSIS.md,
 * Rule 16): this is the headless, unit-testable LOGIC half. Launchd unit
 * generation is W1-T12b; crash-recovery is W1-T12c; actually loading the plist
 * on a real session, an overnight drain, and a live kill-and-recover are the
 * verify:human commissioning steps of W1-T12d — none of that is here.
 *
 * `rmd drain` (drain.ts) is a bounded, one-shot pass a human kicks off by hand:
 * DAG-select → dispatch → repeat, until `--max`/`--until`/a block/no more work.
 * This is that SAME machinery — `nextRunnable`, the fleet-control gates (W1-T11
 * STOP/PAUSE), the HeadroomTracker (W1-T4), stop-on-block v1 (block-REASONING
 * is W1-T46, built ON this core, not this task) — reused wholesale, never
 * reimplemented, wired into a PERSISTENT loop instead of a bounded one: where
 * drain.ts's `no_runnable` is a terminal stop, this loop PACES itself with an
 * injected clock and keeps polling — new work can land later (a plan edit
 * merges, a dependency's PR lands out of band), and being there when it does is
 * the entire point of a daemon.
 *
 * Single-instance + per-task locking (drain-lock.ts / inflight-lock.ts) are
 * real side effects the CLI wiring (run-task.ts) owns, exactly as `rmd drain`
 * already does — this pure module never touches the filesystem.
 */

import type { RunResult } from "../run-task.js";
import { nextRunnable, type MergedSet } from "./drain.js";
import { headroomExhausted } from "./headroom.js";
import type { UsageSnapshot } from "./headroom.js";
import type { Plan } from "./plan.js";

/** Reason the scheduler loop returned — every terminal state is one of these. */
export type DaemonStopReason =
  | "stopped"
  | "paused"
  | "headroom_exhausted"
  | "blocked"
  | "max_reached"
  | "error";

/** Default idle-poll pace: check back once a minute while nothing is runnable. */
export const DEFAULT_POLL_INTERVAL_MS = 60_000;

export interface DaemonOpts {
  /**
   * Optional iteration cap (a bounded supervised run, or a test). Absent ⇒
   * unbounded — the real daemon runs until STOP, a block, or headroom.
   */
  max?: number;
  /** Idle-poll pace in ms when nothing is currently runnable (default {@link DEFAULT_POLL_INTERVAL_MS}). */
  pollIntervalMs?: number;
  /** ≥ this % on any window ⇒ headroom_exhausted (default HEADROOM_LIMIT_PCT). */
  headroomLimitPct?: number;
}

export interface DaemonSummary {
  attempted: string[];
  merged: string[];
  stopReason: DaemonStopReason;
  /** Human detail: the blocked task + verdict, the reset time, the error, etc. */
  stopDetail?: string;
  costUsd: number;
  /** Count of idle polls (no runnable task, so the loop slept and re-checked). */
  ticks: number;
}

/** Injectable dependencies — the real command wires GitHub/run-task/usage/locks. */
export interface DaemonDeps {
  /** Fresh merged predicate each call (re-derived from GitHub between iterations). */
  refreshMerged: () => MergedSet;
  /** Run ONE task through the existing run-task path (default = runTask). */
  runOne: (taskId: string) => Promise<RunResult>;
  /** Read current /usage; `undefined` ⇒ unavailable (headroom check is skipped). */
  readUsage?: () => UsageSnapshot | undefined;
  /**
   * Fleet control (W1-T11, MASTER-PLAN §4A/§4B): a defined return ⇒ a hard STOP
   * is in effect, and the string is the ledger/summary detail. Checked FIRST,
   * every tick — before PAUSE, headroom, or picking the next task — so it takes
   * precedence over PAUSE and wins the race if both flags are set.
   */
  checkStop?: () => string | undefined;
  /**
   * Fleet control (W1-T11): a defined return ⇒ a graceful PAUSE (drain-and-hold)
   * is in effect. Checked between iterations only — AFTER the current `runOne`
   * has resolved — so an in-flight task always runs to full completion (verdict
   * + merge) before a pause is honoured; no new spawn follows.
   */
  checkPause?: () => string | undefined;
  /**
   * The INJECTED CLOCK: paces idle polling when nothing is runnable yet. The
   * real command wires a real `setTimeout`-backed sleep; tests inject a fake
   * that resolves immediately (or counts calls) so the loop is provable without
   * a real wall-clock wait and without an actual overnight run.
   */
  sleep: (ms: number) => Promise<void>;
  /** One ledger line per tick/task/terminal reason (reuses run-task's ledger). */
  log?: (step: string, extra?: Record<string, unknown>) => void;
}

/**
 * The daemon's scheduler loop. Deterministic; no LLM decisions. Each tick:
 * check STOP → check PAUSE → check headroom → pick the next runnable (DAG
 * order, reusing drain.ts's `nextRunnable` — never reimplemented) → run it →
 * STOP on any non-merged verdict (v1 stop-on-block, same as `rmd drain`).
 * When nothing is runnable, sleep via the injected clock and poll again — the
 * loop is PERSISTENT by default (no `max`), unlike a bounded drain.
 */
export async function runDaemon(
  plan: Plan,
  deps: DaemonDeps,
  opts: DaemonOpts = {},
): Promise<DaemonSummary> {
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const log = deps.log ?? (() => {});
  const attempted: string[] = [];
  const merged: string[] = [];
  let costUsd = 0;
  let ticks = 0;

  const summary = (stopReason: DaemonStopReason, stopDetail?: string): DaemonSummary => {
    const s: DaemonSummary = { attempted, merged, stopReason, stopDetail, costUsd, ticks };
    log("daemon.summary", { ...s });
    return s;
  };

  for (;;) {
    if (opts.max !== undefined && attempted.length >= opts.max) {
      return summary("max_reached", `${opts.max} task(s)`);
    }

    // FLEET CONTROL (W1-T11): checked FIRST, every tick — a hard STOP wins any
    // race against PAUSE and against picking up the next task. Neither check
    // can ever interrupt a task that is already running: `runOne` below is
    // awaited to completion before the loop returns here, so an in-flight
    // task always reaches its verdict + merge (the drain-and-hold guarantee).
    const stopped = deps.checkStop?.();
    if (stopped) {
      log("daemon.stop", { detail: stopped });
      return summary("stopped", stopped);
    }
    const paused = deps.checkPause?.();
    if (paused) {
      log("daemon.pause", { detail: paused });
      return summary("paused", paused);
    }

    const isMerged = deps.refreshMerged();

    // HEADROOM: never hammer a nearly-exhausted pool. Best-effort — an unreadable
    // /usage does not halt the daemon; an at/near-limit reading DOES, with the
    // reset time reported, before any new task is spawned.
    if (deps.readUsage) {
      const snap = deps.readUsage();
      const over = snap ? headroomExhausted(snap, opts.headroomLimitPct) : null;
      if (over) {
        log("daemon.headroom", { window: over.window, percent_used: over.percentUsed, resets_at: over.resetsAt });
        return summary("headroom_exhausted", `${over.window} at ${over.percentUsed}% — resets ${over.resetsAt}`);
      }
      if (!snap) log("daemon.headroom.unavailable", { note: "usage unreadable — continuing (best-effort)" });
    }

    const next = nextRunnable(plan, isMerged);
    if (!next) {
      // UNLIKE drain.ts (where `no_runnable` is a terminal stop): the daemon is
      // PERSISTENT — new work can land later, so it paces itself with the
      // injected clock and keeps polling rather than exiting.
      ticks++;
      log("daemon.idle", { tick: ticks, poll_interval_ms: pollIntervalMs });
      await deps.sleep(pollIntervalMs);
      continue;
    }

    log("daemon.iteration", { task: next.id, attempted: attempted.length + 1, max: opts.max ?? null });
    attempted.push(next.id);
    let result: RunResult;
    try {
      result = await deps.runOne(next.id);
    } catch (e) {
      return summary("error", `${next.id}: ${String((e as Error)?.message ?? e)}`);
    }
    costUsd += result.costUsd;

    if (!result.merged) {
      // STOP-ON-BLOCK v1 (same semantics as drain.ts): a blocked task's
      // dependents would build on missing work. Block-REASONING (retry a
      // transient, skip an independent-failure's subtree, escalate a genuine
      // blocker) is W1-T46, a successor built ON this daemon core.
      log("daemon.blocked", { task: next.id, verdict: result.verdict, pr_url: result.prUrl });
      return summary("blocked", `${next.id} → ${result.verdict}${result.prUrl ? ` (${result.prUrl})` : ""}`);
    }
    merged.push(next.id);
  }
}
