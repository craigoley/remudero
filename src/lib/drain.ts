/**
 * `rmd drain` — a THIN, SAFE loop over the PROVEN run-task machinery (WS-1). It
 * resolves the next runnable task from the DAG, runs it via the existing run-task
 * path, and repeats — preserving plan sequencing. It invents NO orchestration:
 * dependency logic is `plan.ts`'s ({@link unmetDependencies}), status is
 * GitHub-derived (`status.ts`), the merge gate is unchanged, and headroom is the
 * `headroom.ts` tracker (W1-T4).
 *
 * v1 is deterministic with ZERO LLM decisions and STOPS ON ANY BLOCK — a blocked
 * task's DEPENDENTS would build on missing work, so continuing risks compounding a
 * gap. Skip-and-continue (per-block reasoning) is deliberately NOT built here — it
 * needed the diagnose loop + daemon (W1-T7 + W1-T12a) first, and now lives in the
 * PERSISTENT daemon loop (block-reason.ts, wired into `daemon.ts`'s `runDaemon`,
 * W1-T46), not in this bounded one-shot command. `rmd drain` keeps its blunt
 * stop-on-block on purpose: a human kicked it off by hand and is watching it.
 */

import type { RunResult } from "./run-result.js";
import { headroomExhausted } from "./headroom.js";
import type { UsageSnapshot } from "./headroom.js";
import { unmetDependencies, type Plan, type Task } from "./plan.js";

/** A merged predicate — DERIVED FROM GITHUB in the real runner (status.ts). */
export type MergedSet = (taskId: string) => boolean;

/**
 * Resolves the OPEN PR number for a task's most-recently-derived PR — undefined
 * when that PR is merged, closed, or there is none. Backs the in-flight
 * dispatch-dedup guard (W1-T80, the #143/#145 duplicate-build race): DERIVED
 * FROM GITHUB (status.ts's `deriveStatus` projection) in the real runner, never
 * a second read path.
 */
export type OpenPrCheck = (taskId: string) => number | undefined;

/** Optional in-flight-skip controls for {@link nextRunnable} (W1-T80). */
export interface NextRunnableOpts {
  /** Returns the open PR number for a task whose latest PR is currently OPEN. */
  isOpenPr?: OpenPrCheck;
  /** Called once per task excluded because of an open PR — for ledger/console legibility. */
  onSkip?: (task: Task, prNumber: number) => void;
}

/**
 * The next runnable task in FILE ORDER (ties broken by declaration order, so plan
 * sequencing is preserved): not itself merged, `verify: auto`, not `blocked`, all
 * `depends_on` merged, and — per `opts.isOpenPr` (W1-T80) — not IN-FLIGHT under an
 * OPEN PR. An OPEN PR means the task's next action belongs to the merge queue, the
 * fix rung (W1-T76), or a human — never a duplicate fresh build (the #143/#145
 * race: a reviewed-green #143 was still un-merged, async, when the drain started
 * again and rebuilt the same task end-to-end as #145). A CLOSED (unmerged) PR does
 * NOT block — an abandoned/superseded attempt leaves the task runnable. Reuses
 * `unmetDependencies` — the DAG logic is never reimplemented here. Returns
 * `undefined` when nothing is runnable.
 */
export function nextRunnable(plan: Plan, isMerged: MergedSet, opts: NextRunnableOpts = {}): Task | undefined {
  const merged: import("./plan.js").MergedResolver = (t) => isMerged(t.id);
  for (const t of plan.tasks) {
    if (isMerged(t.id)) continue;
    if (t.verify !== "auto") continue;
    if (t.status === "blocked") continue;
    if (unmetDependencies(plan, t, merged).length > 0) continue;
    const openPrNumber = opts.isOpenPr?.(t.id);
    if (openPrNumber !== undefined) {
      opts.onSkip?.(t, openPrNumber);
      continue; // IN-FLIGHT — never a duplicate fresh build.
    }
    return t;
  }
  return undefined;
}

/** Reason a drain stopped — every terminal state is one of these. */
export type StopReason =
  | "until_reached"
  | "max_reached"
  | "no_runnable"
  | "blocked"
  | "headroom_exhausted"
  | "stopped"
  | "paused"
  | "error";

export interface DrainOpts {
  until?: string;
  max?: number;
  /** ≥ this % on any window ⇒ headroom_exhausted (default HEADROOM_LIMIT_PCT). */
  headroomLimitPct?: number;
}

/** Default iteration cap — a sane bound, never infinite (an unattended loop). */
export const DEFAULT_MAX = 10;

export interface DrainSummary {
  attempted: string[];
  merged: string[];
  stopReason: StopReason;
  /** Human detail: the blocked task + verdict, the reset time, the error, etc. */
  stopDetail?: string;
  costUsd: number;
  resumeCommand: string;
}

/**
 * The ordered plan of what a drain WOULD run (for `--dry-run`), assuming each task
 * merges. Simulates the merge set forward so sequencing/deps are honoured, bounded
 * by `max` and `until`. Runs nothing.
 */
export function plannedSequence(plan: Plan, isMerged: MergedSet, opts: DrainOpts = {}): string[] {
  const max = opts.max ?? DEFAULT_MAX;
  const done = new Set<string>();
  const sim: MergedSet = (id) => done.has(id) || isMerged(id);
  const seq: string[] = [];
  while (seq.length < max) {
    if (opts.until && sim(opts.until)) break; // --until target already satisfied
    const next = nextRunnable(plan, sim);
    if (!next) break;
    seq.push(next.id);
    done.add(next.id); // assume it merges, to expose the NEXT runnable
    if (opts.until && next.id === opts.until) break;
  }
  return seq;
}

/** Build the exact command to resume a drain from where it stopped. */
export function resumeCommand(opts: DrainOpts): string {
  const parts = ["rmd drain"];
  if (opts.until) parts.push(`--until ${opts.until}`);
  if (opts.max !== undefined) parts.push(`--max ${opts.max}`);
  return parts.join(" ");
}

/** Render the SUMMARY — "what happened while I was away", reconstructable at a glance. */
export function renderSummary(s: DrainSummary): string {
  return [
    "── drain summary ─────────────────────────────────────────",
    `attempted : ${s.attempted.length ? s.attempted.join(", ") : "(none)"}`,
    `merged    : ${s.merged.length ? s.merged.join(", ") : "(none)"}`,
    `stopped   : ${s.stopReason}${s.stopDetail ? ` — ${s.stopDetail}` : ""}`,
    `cost      : notional $${s.costUsd.toFixed(4)}`,
    `resume    : ${s.resumeCommand}`,
    "──────────────────────────────────────────────────────────",
  ].join("\n");
}

/** Injectable dependencies — the real command wires GitHub/run-task/usage defaults. */
export interface DrainDeps {
  /** Fresh merged predicate each call (re-derived from GitHub between iterations). */
  refreshMerged: () => MergedSet;
  /**
   * The in-flight guard (W1-T80): the OPEN PR number for a task, re-derived
   * from the SAME projection `refreshMerged` just built (never a second
   * GitHub read path). Optional — omitted, dispatch behaves exactly as before
   * this guard existed.
   */
  isOpenPr?: OpenPrCheck;
  /** Run ONE task through the existing run-task path (default = runTask). */
  runOne: (taskId: string) => Promise<RunResult>;
  /** Read current /usage; `undefined` ⇒ unavailable (headroom check is skipped). */
  readUsage?: () => UsageSnapshot | undefined;
  /**
   * Fleet control (W1-T11, MASTER-PLAN §4A/§4B): a defined return ⇒ a hard STOP is
   * in effect, and the string is the ledger/summary detail. Checked FIRST, every
   * tick — before `--until`, headroom, or picking the next task — so it takes
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
  /** One ledger line per task + terminal reason (reuses run-task's ledger). */
  log?: (step: string, extra?: Record<string, unknown>) => void;
}

/**
 * The drain loop. Deterministic; no LLM decisions. Each iteration: re-derive
 * status → check headroom → pick the next runnable → run it → STOP on any
 * non-merged verdict. Returns a {@link DrainSummary}.
 */
export async function runDrain(plan: Plan, deps: DrainDeps, opts: DrainOpts = {}): Promise<DrainSummary> {
  const max = opts.max ?? DEFAULT_MAX;
  const log = deps.log ?? (() => {});
  const attempted: string[] = [];
  const merged: string[] = [];
  let costUsd = 0;

  const summary = (stopReason: StopReason, stopDetail?: string): DrainSummary => {
    const s: DrainSummary = { attempted, merged, stopReason, stopDetail, costUsd, resumeCommand: resumeCommand(opts) };
    log("drain.summary", { ...s });
    return s;
  };

  while (attempted.length < max) {
    // FLEET CONTROL (W1-T11): checked FIRST, every tick — a hard STOP wins any
    // race against PAUSE and against picking up the next task. Neither check
    // can ever interrupt a task that is already running: `runOne` below is
    // awaited to completion before the loop returns here, so an in-flight
    // task always reaches its verdict + merge (the drain-and-hold guarantee).
    const stopped = deps.checkStop?.();
    if (stopped) {
      log("drain.stop", { detail: stopped });
      return summary("stopped", stopped);
    }
    const paused = deps.checkPause?.();
    if (paused) {
      log("drain.pause", { detail: paused });
      return summary("paused", paused);
    }

    const isMerged = deps.refreshMerged();

    // --until satisfied ⇒ done (target task has merged).
    if (opts.until && isMerged(opts.until)) return summary("until_reached", opts.until);

    // HEADROOM: never hammer a nearly-exhausted pool. Best-effort — an unreadable
    // /usage does not halt the whole drain (max + the budget tripwire still bound
    // it); an at/near-limit reading DOES, with the reset time reported.
    if (deps.readUsage) {
      const snap = deps.readUsage();
      const over = snap ? headroomExhausted(snap, opts.headroomLimitPct) : null;
      if (over) {
        log("drain.headroom", { window: over.window, percent_used: over.percentUsed, resets_at: over.resetsAt });
        return summary("headroom_exhausted", `${over.window} at ${over.percentUsed}% — resets ${over.resetsAt}`);
      }
      if (!snap) log("drain.headroom.unavailable", { note: "usage unreadable — continuing (best-effort)" });
    }

    const next = nextRunnable(plan, isMerged, {
      isOpenPr: deps.isOpenPr,
      // IN-FLIGHT (W1-T80): a legible skip on console + ledger, then the drain
      // proceeds to the next runnable task — an open PR must not halt the drain
      // the way a block does.
      onSkip: (t, prNumber) => log("dispatch.skipped", { task: t.id, reason: "open-pr", pr_number: prNumber }),
    });
    if (!next) return summary("no_runnable");

    log("drain.iteration", { task: next.id, attempted: attempted.length + 1, max });
    attempted.push(next.id);
    let result: RunResult;
    try {
      result = await deps.runOne(next.id);
    } catch (e) {
      return summary("error", `${next.id}: ${String((e as Error)?.message ?? e)}`);
    }
    costUsd += result.costUsd;

    if (!result.merged) {
      // STOP-ON-BLOCK: a blocked task's dependents would build on missing work.
      log("drain.blocked", { task: next.id, verdict: result.verdict, pr_url: result.prUrl });
      return summary("blocked", `${next.id} → ${result.verdict}${result.prUrl ? ` (${result.prUrl})` : ""}`);
    }
    merged.push(next.id);
    if (opts.until && next.id === opts.until) return summary("until_reached", opts.until);
  }
  return summary("max_reached", `${max} task(s)`);
}
