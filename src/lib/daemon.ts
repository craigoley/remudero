/**
 * lib/daemon.ts — the daemon's scheduler-loop CORE (W1-T12a).
 *
 * W1-T12 (Daemonize) was split along the machine/human boundary (DIAGNOSIS.md,
 * Rule 16): this is the headless, unit-testable LOGIC half. Launchd unit
 * generation is W1-T12b (lib/launchd.ts); crash-recovery reconstruction is
 * W1-T12c (`reconstructState`, below); actually loading the plist on a real
 * session, an overnight drain, and a live kill-and-recover are the
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
import { assertCleanBoot, type BootAssertion } from "./env.js";
import { nextRunnable, type MergedSet, type OpenPrCheck } from "./drain.js";
import { headroomExhausted } from "./headroom.js";
import type { UsageSnapshot } from "./headroom.js";
import type { Plan } from "./plan.js";
import type { StatusProjection } from "./status.js";

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
  /**
   * The in-flight guard (W1-T80, the #143/#145 duplicate-build race): the OPEN
   * PR number for a task, re-derived from the SAME projection `refreshMerged`
   * just built (never a second GitHub read path). Optional — omitted,
   * dispatch behaves exactly as before this guard existed.
   */
  isOpenPr?: OpenPrCheck;
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
  /**
   * The level-triggered PR-pipeline reconciler (W1-T77, ratifies P22 core): the
   * SAME `runSweep` entry point `rmd sweep` invokes, wired here so it runs once
   * per poll iteration — every open PR is re-derived to a disposition and its
   * gated action taken, deduped for idempotence. Optional: omitted ⇒ the loop
   * behaves exactly as before the reconciler existed. Best-effort by contract
   * (the real wiring swallows its own errors) so a sweep hiccup never halts the
   * scheduler. Called alongside dispatch, NOT a replacement for it.
   */
  sweep?: () => Promise<void> | void;
}

/**
 * The daemon's startup routine (W1-T12b): the ANTHROPIC-clean-env boot
 * assertion, run ONCE before the scheduler loop starts. Takes the log sink and
 * the env to check as explicit, injectable inputs — same shape as the rest of
 * this module — so it is provable in-process from a unit test with a fake env,
 * with NO real launchd load involved (that live commissioning step is
 * W1-T12d). The launchd unit that execs `rmd daemon` is generated by
 * lib/launchd.ts; this is the belt-and-suspenders check the daemon process
 * itself runs at boot, regardless of how it was launched.
 */
export function daemonBoot(
  log: (step: string, extra?: Record<string, unknown>) => void,
  env: NodeJS.ProcessEnv = process.env,
): BootAssertion {
  const assertion = assertCleanBoot(env);
  log("daemon.boot", { env_clean: assertion.env_clean, billing_mode: assertion.billing_mode });
  return assertion;
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

    // LEVEL-TRIGGERED PR-PIPELINE RECONCILER (W1-T77, ratifies P22 core): once
    // per iteration, re-derive every open PR's disposition and take its gated
    // action. Runs alongside dispatch (not instead of it): dispatch opens NEW
    // work, the sweep reconciles the OPEN PRs already in flight so none strands
    // open-and-orphaned (the #111/#113/#123 class). Best-effort by contract.
    if (deps.sweep) await deps.sweep();

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

    const next = nextRunnable(plan, isMerged, {
      isOpenPr: deps.isOpenPr,
      // IN-FLIGHT (W1-T80): a legible skip on console + ledger; the daemon
      // keeps polling rather than treating an open PR as a block.
      onSkip: (t, prNumber) => log("dispatch.skipped", { task: t.id, reason: "open-pr", pr_number: prNumber }),
    });
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

// ── crash recovery (W1-T12c) ────────────────────────────────────────────────
//
// A daemon killed mid-task (power loss, `kill -9`, a host reboot — the live
// chaos drill is W1-T12d) can leave an ORPHANED local run behind: a
// `git worktree` + its `run-<taskId>-<epochMs>` branch (worker.ts's
// `runId = ${taskId}-${Date.now()}`, `branch = run-${runId}`) that no live
// process owns anymore (its inflight-lock.ts pid is dead). Discovering that
// debris is a real filesystem/`git worktree list` walk — the CLI wiring's job
// (same boundary as worker.ts's `pruneStaleRuns`), and OUT of scope here; this
// pure module only reasons about the parsed result.
//
// The one question crash recovery must answer per orphan is: does GitHub know
// about work this task already did? A dead local process is NOT authoritative
// — an open PR may already exist (pushed right before the crash), and
// blindly re-running the task from `nextRunnable` would spawn a SECOND worker
// on top of it UNLESS the caller wires the `isOpenPr` in-flight guard (W1-T80,
// the #143/#145 duplicate-build race) — belt-and-suspenders here: crash
// recovery reasons about the orphan directly rather than depending on that
// guard alone. So state is reconstructed from git (which task/run the orphan belonged to)
// + GitHub + the ledger (status.ts's `deriveStatus`, reused wholesale, never
// reimplemented — same three-source precedence `rmd drain`/`rmd run-task`
// already trust) — never from the dead process's local state.

/** A local run a crashed process left behind, as found by `git worktree list`
 * (the CLI wiring's job) and parsed by {@link parseOrphanedBranch}. */
export interface OrphanedRun {
  taskId: string;
  runId: string;
  branch: string;
  worktreePath: string;
}

/** `resume`: GitHub already has a live PR for this task — do not respawn.
 *  `clean`: no surviving GitHub artifact (or the task is already merged) —
 *  the local worktree/branch is stale debris, safe to discard. */
export type RecoveryAction = "resume" | "clean";

export interface RecoveredTask extends OrphanedRun {
  action: RecoveryAction;
  detail: string;
  prUrl?: string;
}

/**
 * Parse a `run-<taskId>-<epochMs>` branch name back into its task + run id.
 * Splits at the LAST `-` (task ids may themselves contain hyphens, e.g.
 * `W1-T12c`), only accepting the split when the trailing segment is all
 * digits (an epoch-ms timestamp) — anything else (a retro/review run's
 * branch, e.g. `run-RETRO-<epochMs>` or `run-review-PR9-<epochMs>`, which is
 * not task-scoped) is not an orphaned TASK run and returns null.
 */
export function parseOrphanedBranch(branch: string, worktreePath: string): OrphanedRun | null {
  if (!branch.startsWith("run-")) return null;
  const rest = branch.slice("run-".length);
  const i = rest.lastIndexOf("-");
  if (i <= 0 || i === rest.length - 1) return null;
  const taskId = rest.slice(0, i);
  const epochMs = rest.slice(i + 1);
  if (!/^\d+$/.test(epochMs)) return null;
  if (taskId === "RETRO" || /^review-PR\d+$/.test(taskId)) return null; // not task-scoped
  return { taskId, runId: `${taskId}-${epochMs}`, branch, worktreePath };
}

/**
 * Reconstruct ONE orphan's fate from its task's GitHub-derived projection.
 * `deriveTaskStatus` is the caller's `status.ts` `deriveStatus`, scoped to
 * this task id — this function adds NO new GitHub/ledger logic, it only maps
 * the EXISTING precedence-derived projection onto a recovery verb:
 *
 *   - status `running` (an OPEN PR) ⇒ "resume": GitHub, not the dead local
 *     process, is the task's true state. The orphaned worktree/branch is left
 *     untouched (not cleaned) — it is the original working tree behind that
 *     PR, in case anything downstream needs it.
 *   - `merged`, `blocked` (PR closed without merging), or no evidence at all
 *     ⇒ "clean": the task is either already done, or never produced a
 *     surviving GitHub artifact — either way the local worktree/branch is
 *     pure debris. When not merged, the task is left for `nextRunnable` to
 *     pick up fresh (a normal, from-scratch run) on the daemon's next tick.
 */
export function reconstructOrphan(
  orphan: OrphanedRun,
  deriveTaskStatus: (taskId: string) => StatusProjection,
): RecoveredTask {
  const projection = deriveTaskStatus(orphan.taskId);
  if (projection.status === "running") {
    return {
      ...orphan,
      action: "resume",
      prUrl: projection.prUrl,
      detail: `${orphan.taskId}: an open PR already exists (${projection.prUrl}) — resuming from GitHub state, not respawning`,
    };
  }
  const why = projection.merged
    ? `already merged (${projection.prUrl})`
    : projection.status === "blocked"
      ? `its PR was closed without merging (${projection.prUrl})`
      : "no surviving GitHub artifact — the crash happened before a PR existed";
  return {
    ...orphan,
    action: "clean",
    prUrl: projection.prUrl,
    detail: `${orphan.taskId}: ${why} — orphaned worktree/branch is stale debris, safe to discard`,
  };
}

/**
 * The daemon's boot-time recovery pass (W1-T12c): reconstruct every orphaned
 * local run's fate, in order, logging one `daemon.recover` ledger line each.
 * Pure over its injected `deriveTaskStatus` — no filesystem, no git, no
 * GitHub call lives in this module (same discipline as the rest of daemon.ts);
 * the CLI wiring supplies the orphan list (a `git worktree list` walk) and a
 * `status.ts`-backed `deriveTaskStatus`, and owns the actual worktree/branch
 * cleanup that `action: "clean"` recommends.
 */
export function reconstructState(
  orphans: OrphanedRun[],
  deriveTaskStatus: (taskId: string) => StatusProjection,
  log?: (step: string, extra?: Record<string, unknown>) => void,
): RecoveredTask[] {
  return orphans.map((orphan) => {
    const recovered = reconstructOrphan(orphan, deriveTaskStatus);
    log?.("daemon.recover", {
      task: recovered.taskId,
      run_id: recovered.runId,
      action: recovered.action,
      detail: recovered.detail,
    });
    return recovered;
  });
}
