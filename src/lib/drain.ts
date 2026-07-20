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
  /**
   * W1-T119: true when this task's own GitHub read is INDETERMINATE — a genuine
   * read failure (rate-limited, network error, auth failure), not a clean "no
   * evidence" — so its `merged` reading cannot be trusted as an ordinary
   * `queued`/not-merged. Dispatching now risks re-running work that may
   * already be merged, the exact throttle-reads-as-not-merged spend event this
   * task exists to prevent. Optional — omitted, dispatch behaves exactly as
   * before this guard existed.
   */
  isIndeterminate?: (taskId: string) => boolean;
  /**
   * Called once per task excluded because its own read is indeterminate, in
   * place of dispatching it — mirrors `onSkip`/`onCircuitBreak`'s legibility
   * contract.
   */
  onIndeterminate?: (task: Task) => void;
  /**
   * The per-task dispatch CIRCUIT BREAKER (MASTER-PLAN P29(ii)): true when this
   * task has been dispatched the policy-capped number of times with no new
   * owned PR since (status.ts's `isDispatchBreakerTripped`, ledger-derived —
   * persists across process restarts, unlike an in-memory block flag).
   * Optional — omitted, dispatch behaves exactly as before this breaker existed.
   */
  isCircuitTripped?: (taskId: string) => boolean;
  /**
   * Called once per task whose circuit breaker is tripped, in place of
   * dispatching it — the real wiring logs it and escalates ONE (deduped)
   * needs-human issue naming the loop; dispatch never proceeds for that task.
   */
  onCircuitBreak?: (task: Task) => void;
  /**
   * W1-T177 (TERMINAL-STATE CHECK AT EVERY SPENDING SITE): an OPTIONAL fresh
   * re-read of ONE candidate in-flight PR's live GitHub state, consulted
   * ONLY when `isOpenPr` reports a task in-flight — CONFIRMS, with a read
   * that is never the cached `isOpenPr` snapshot (`lastProj`, re-derived
   * once per drain TICK, not once per candidate), whether that PR is
   * genuinely still open right now. Returns the freshly observed state
   * string (e.g. "OPEN"/"MERGED"/"CLOSED"), or `undefined` on a
   * failed/indeterminate read. This site differs in KIND from a spending
   * site: a stale OPEN here wrongly BLOCKS a runnable task rather than
   * wrongly spending on one, so the FAIL-OPEN direction is the same shape
   * but the failure mode is a skip, not a spend — an unreadable state still
   * means "treat as in-flight, skip it" (never "assume terminal, dispatch").
   * Omitted ⇒ behaves EXACTLY as before this check existed.
   */
  readLiveState?: (taskId: string, prNumber: number) => string | undefined;
  /**
   * Called once per task whose CACHED in-flight snapshot this live re-check
   * overturned — the task proceeds as runnable instead of being skipped.
   * Mirrors `onSkip`'s legibility contract; the real wiring corrects the
   * ledgered reason from "open-pr" to the freshly observed terminal state.
   */
  onStoodDown?: (task: Task, prNumber: number, state: string) => void;
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
    // INDETERMINATE (W1-T119) — checked BEFORE the circuit breaker and the
    // in-flight guard: an indeterminate read says nothing about either of
    // those, and dispatching now risks re-running work that may already be
    // merged (the throttle-reads-as-not-merged spend event this task exists
    // to prevent). NEVER treated as an ordinary queued task.
    if (opts.isIndeterminate?.(t.id)) {
      opts.onIndeterminate?.(t);
      continue;
    }
    // PER-TASK DISPATCH CIRCUIT BREAKER (P29(ii)) — checked BEFORE the in-flight
    // guard below: a tripped task halts regardless of whatever its latest PR's
    // state happens to be; it is the backstop that bounds (i)'s sibling-credit
    // fix even if that fix is somehow wrong.
    if (opts.isCircuitTripped?.(t.id)) {
      opts.onCircuitBreak?.(t);
      continue;
    }
    const openPrNumber = opts.isOpenPr?.(t.id);
    if (openPrNumber !== undefined) {
      // W1-T177: CONFIRM the cached in-flight snapshot with a fresh read
      // before skipping — a stale OPEN wrongly blocks a task that is
      // actually runnable (the #388 fixture: `dispatch.skipped reason=
      // 'open-pr'` more than six minutes after that PR had merged).
      const liveState = opts.readLiveState?.(t.id, openPrNumber);
      if (liveState !== undefined && liveState !== "OPEN") {
        opts.onStoodDown?.(t, openPrNumber, liveState);
      } else {
        opts.onSkip?.(t, openPrNumber);
        continue; // IN-FLIGHT (or unreadable — fail OPEN) — never a duplicate fresh build.
      }
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
  /**
   * A CURATED selection (W1-T140, the drain preview + curation panel): an explicit
   * ordered list of task ids. When present, dispatch iterates EXACTLY this list, in
   * this order, in place of the natural DAG scan ({@link nextRunnable}'s plan-file-
   * order walk) — the operator's curation-panel choice (reorder / unselect / set
   * depth) drives exactly which tasks run and in what sequence. An id already merged
   * or currently in-flight (an open PR, the same W1-T80 guard the natural path uses)
   * is skipped, never re-dispatched; an id this list OMITS is never dispatched at
   * all, regardless of what the natural DAG scan would otherwise pick next. This is
   * an INPUT to the existing loop, not a reimplementation of it — every other
   * `runDrain` mechanic (stop/pause/headroom/max) is unchanged. Build this field with
   * {@link applyCuratedSelection} rather than setting it directly, so `max` stays
   * consistent with the selection's `depth`.
   */
  curated?: string[];
}

/**
 * A curated selection from the drain preview panel (W1-T140 limb 2): an ordered
 * subset of the would-drain queue, plus how many of them to actually dispatch this
 * drain (the panel's "depth" control).
 */
export interface CuratedSelection {
  /** Ordered subset of task ids — EXACTLY this order; ids not listed here never dispatch. */
  taskIds: string[];
  /** How many of `taskIds`, from the front, this drain should actually attempt. */
  depth: number;
}

/**
 * Fold a {@link CuratedSelection} into {@link DrainOpts}: `curated` becomes the
 * selection's `taskIds` truncated to `depth`, and `max` is capped to the same bound
 * so the natural `max_reached` stop fires exactly at the curated boundary rather
 * than a stale caller-supplied `max` letting the loop run past — or short of — the
 * operator's chosen depth. Any other `opts` field (`until`, `headroomLimitPct`)
 * passes through untouched.
 */
export function applyCuratedSelection(opts: DrainOpts, selection: CuratedSelection): DrainOpts {
  const curated = selection.taskIds.slice(0, Math.max(0, selection.depth));
  const max = opts.max !== undefined ? Math.min(opts.max, curated.length) : curated.length;
  return { ...opts, curated, max };
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

/** One dependency edge in a task card's graph, rendered for the curation panel. */
export interface DependencyEdge {
  id: string;
  title: string;
}

/**
 * One task in the drain PREVIEW (W1-T140 limb 1): the would-drain queue rendered as
 * a task card. `description` reuses {@link Task.note} — plan/tasks.yaml's per-task
 * `rationale:` prose is Architect-only narrative that `loadPlanFromYaml` (plan.ts)
 * deliberately never parses onto `Task` (VERIFIED against plan.ts before wiring, per
 * this task's own "distrust this note" instruction — `note` is the one free-text
 * field a `Task` actually carries through to runtime, so it stands in for the
 * design doc's "description/rationale").
 */
export interface DrainPreviewCard {
  id: string;
  title: string;
  description: string;
  /** Incoming edges — this task's own `depends_on`. */
  dependsOn: DependencyEdge[];
  /**
   * Outgoing edges — tasks that DIRECTLY declare this task as a dependency.
   * Direct, not transitive: {@link transitiveDependents} answers a different
   * question ("does anything in the whole plan need this at all"); a card's
   * dependents are the immediate next hop only, matching `dependsOn`'s own
   * direct-edge shape.
   */
  dependents: DependencyEdge[];
}

/**
 * The would-drain queue as ordered task cards (W1-T140 limb 1): {@link
 * plannedSequence}'s ordered id list, each resolved to a card carrying its title,
 * description, and direct dependency edges both ways — everything the curation
 * panel needs to render without a second query. Card order equals
 * `plannedSequence`'s order exactly.
 */
export function buildDrainPreview(plan: Plan, isMerged: MergedSet, opts: DrainOpts = {}): DrainPreviewCard[] {
  const seq = plannedSequence(plan, isMerged, opts);

  // Direct reverse edges (taskId -> the task ids that declare it as a dependency),
  // built once over the WHOLE plan — mirrors plan.ts's transitiveDependents reverse
  // map, but this one stays one hop deep on purpose (see DrainPreviewCard.dependents).
  const reverse = new Map<string, string[]>();
  for (const t of plan.tasks) {
    for (const dep of t.depends_on) {
      const list = reverse.get(dep);
      if (list) list.push(t.id);
      else reverse.set(dep, [t.id]);
    }
  }
  const edge = (id: string): DependencyEdge => ({ id, title: plan.byId.get(id)?.title ?? id });

  return seq.map((id) => {
    const t = plan.byId.get(id) as Task; // plannedSequence only ever emits ids nextRunnable found in plan.byId
    return {
      id: t.id,
      title: t.title,
      description: t.note ?? "",
      dependsOn: t.depends_on.map(edge),
      dependents: (reverse.get(t.id) ?? []).map(edge),
    };
  });
}

/**
 * The next task to dispatch from a CURATED selection (W1-T140), in the caller's
 * exact order: the first id in `curated` not yet attempted this drain, not already
 * merged, and not in-flight under an open PR (same skip semantics as {@link
 * nextRunnable}, including the `onSkip` legibility callback). An id the plan
 * doesn't know is skipped rather than thrown — the curation input is validated at
 * its own edge (the panel/CLI layer that built it), not re-validated here.
 */
function nextCurated(
  plan: Plan,
  curated: readonly string[],
  attempted: readonly string[],
  isMerged: MergedSet,
  opts: NextRunnableOpts,
): Task | undefined {
  const done = new Set(attempted);
  for (const id of curated) {
    if (done.has(id)) continue;
    if (isMerged(id)) continue;
    const t = plan.byId.get(id);
    if (!t) continue;
    // Same indeterminate-read semantics as the natural path (W1-T119) — a
    // curation-panel selection is still dispatch, and must not re-run work
    // whose own GitHub read failed any more than the DAG scan would.
    if (opts.isIndeterminate?.(id)) {
      opts.onIndeterminate?.(t);
      continue;
    }
    // Same circuit-breaker semantics as the natural path (P29(ii)) — a
    // curation-panel selection is still dispatch, and must not spin a tripped
    // task any more than the DAG scan would.
    if (opts.isCircuitTripped?.(id)) {
      opts.onCircuitBreak?.(t);
      continue;
    }
    const openPrNumber = opts.isOpenPr?.(id);
    if (openPrNumber !== undefined) {
      opts.onSkip?.(t, openPrNumber);
      continue; // IN-FLIGHT — never a duplicate fresh build, same as the natural path.
    }
    return t;
  }
  return undefined;
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

/** One classified outcome line in the post-drain rundown (W1-T141). */
export interface RundownLine {
  taskId: string;
  outcome: "merged" | "blocked" | "escalated";
  /** {@link DrainSummary.stopDetail} — set only when `outcome` is `"blocked"`. */
  detail?: string;
  /** The needs-human issue this task's block opened (escalate.ts) — set only when `outcome` is `"escalated"`. */
  escalation?: { issueUrl: string; class: string };
}

/**
 * Build the post-drain rundown (W1-T141): one classified outcome line per `summary.attempted`
 * task, in attempt order — the pull-view counterpart to `digest.ts`'s push summary, read right
 * after a drain finishes rather than batched into the next daily send.
 *
 * `runDrain` STOPS ON THE FIRST non-merged verdict (this module's own header), so every
 * `attempted` id except possibly the LAST is necessarily in `summary.merged` — classified
 * `"merged"`. The last id, when not merged, classifies `"escalated"` when the ledger already
 * carries an `escalation.issue_opened` line naming it (escalate.ts — e.g. the BLOCKED class
 * opened after two-strikes-exhausted, during the SAME `runOne` call that produced the
 * non-merged verdict), carrying that issue's URL + class as its ref; otherwise it classifies
 * `"blocked"`, carrying `summary.stopDetail` as its detail. Escalation lookup is task-id-keyed,
 * latest-wins — the SAME dedup key `ops.ts`'s alert-escalation guard and `digest.ts`'s
 * summarizer already use, never a second convention. `ledgerLines` defaults to none, so a
 * caller with no ledger handy still gets a correct merged/blocked split, just never
 * `"escalated"` (degrades to the coarser truth, same as `digest.ts`'s own escalations list
 * when nothing is passed).
 */
export function buildRundown(summary: DrainSummary, ledgerLines: ReadonlyArray<Record<string, unknown>> = []): RundownLine[] {
  const merged = new Set(summary.merged);
  const escalationByTask = new Map<string, { issueUrl: string; class: string }>();
  for (const l of ledgerLines) {
    if (l.step === "escalation.issue_opened" && typeof l.task_id === "string" && typeof l.issue_url === "string") {
      escalationByTask.set(l.task_id, { issueUrl: l.issue_url, class: String(l.class ?? "?") });
    }
  }
  return summary.attempted.map((taskId): RundownLine => {
    if (merged.has(taskId)) return { taskId, outcome: "merged" };
    const escalation = escalationByTask.get(taskId);
    if (escalation) return { taskId, outcome: "escalated", escalation };
    return { taskId, outcome: "blocked", detail: summary.stopDetail };
  });
}

/** Render a {@link RundownLine} array — "what happened, per task", one line each. */
export function renderRundown(lines: RundownLine[]): string {
  const body =
    lines.length === 0
      ? ["(no tasks attempted)"]
      : lines.map((l) => {
          if (l.outcome === "merged") return `merged     : ${l.taskId}`;
          if (l.outcome === "escalated") return `escalated  : ${l.taskId} — [${l.escalation!.class}] ${l.escalation!.issueUrl}`;
          return `blocked    : ${l.taskId}${l.detail ? ` — ${l.detail}` : ""}`;
        });
  return ["── post-drain rundown ────────────────────────────────────", ...body, "──────────────────────────────────────────────────────────"].join("\n");
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
  /**
   * W1-T177: an OPTIONAL fresh, live re-read of ONE candidate in-flight PR's
   * GitHub state — see {@link NextRunnableOpts.readLiveState}'s doc for the
   * full contract. Optional — omitted, dispatch behaves exactly as before
   * this check existed.
   */
  readLiveState?: (taskId: string, prNumber: number) => string | undefined;
  /**
   * The per-task dispatch CIRCUIT BREAKER (P29(ii)), re-derived from the
   * ledger each call — same freshness contract as `refreshMerged`/`isOpenPr`.
   * Optional — omitted, dispatch behaves exactly as before this breaker
   * existed.
   */
  isCircuitTripped?: (taskId: string) => boolean;
  /**
   * Called once per task whose circuit breaker trips this tick — the real
   * wiring escalates ONE (deduped) needs-human issue naming the loop.
   */
  onCircuitBreak?: (task: Task) => void;
  /**
   * W1-T119: true when a task's own GitHub read is INDETERMINATE (a genuine
   * read failure), re-derived from the SAME projection `refreshMerged` just
   * built — same freshness contract as `isOpenPr`/`isCircuitTripped`. Optional
   * — omitted, dispatch behaves exactly as before this guard existed.
   */
  isIndeterminate?: (taskId: string) => boolean;
  /** Called once per task excluded because its own read is indeterminate. */
  onIndeterminate?: (task: Task) => void;
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
  // CIRCUIT BREAKER ESCALATION DEDUP (P29(ii)): `nextRunnable`/`nextCurated` are
  // re-invoked every tick, so a task that stays tripped (never dispatched, never
  // resolved) would otherwise be re-observed — and re-escalated — on EVERY
  // subsequent tick for as long as the drain keeps running (e.g. an unrelated
  // independent task still dispatches successfully first, so the drain does not
  // stop at "no_runnable" the very first time the breaker is consulted). That
  // violates "exactly one escalation" — this Set bounds the CALLBACK to the
  // drain's own first observation of each task id; `isCircuitTripped` itself is
  // still consulted (and still excludes the task from dispatch) every tick.
  const circuitEscalated = new Set<string>();

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

    const skipOpts: NextRunnableOpts = {
      isOpenPr: deps.isOpenPr,
      // IN-FLIGHT (W1-T80): a legible skip on console + ledger, then the drain
      // proceeds to the next runnable task — an open PR must not halt the drain
      // the way a block does.
      onSkip: (t, prNumber) => log("dispatch.skipped", { task: t.id, reason: "open-pr", pr_number: prNumber }),
      // W1-T177: wrap the injected reader so a FAILED/INDETERMINATE live read
      // (returns `undefined`) is LEDGERED here — distinct from an ordinary
      // un-wired site, which never calls this at all. Still resolves to
      // `undefined` either way, so nextRunnable's own fail-OPEN contract
      // (treat as still in-flight, skip it) is completely unchanged — an
      // unreadable state never overturns the skip, it is just made legible.
      readLiveState: deps.readLiveState
        ? (taskId, prNumber) => {
            const state = deps.readLiveState!(taskId, prNumber);
            if (state === undefined) log("dispatch.live_state_indeterminate", { task: taskId, pr_number: prNumber });
            return state;
          }
        : undefined,
      // W1-T177: the cached in-flight snapshot was stale — this task is NOT
      // actually blocked. Ledgered distinctly from `dispatch.skipped`, naming
      // the freshly observed terminal state rather than the misleading
      // "open-pr" reason a stale read produced (the #388 fixture).
      onStoodDown: (t, prNumber, state) =>
        log("dispatch.stood_down", { task: t.id, pr_number: prNumber, state, reason: "cached in-flight read was stale" }),
      isIndeterminate: deps.isIndeterminate,
      // INDETERMINATE (W1-T119): a legible ledger line every tick it is
      // consulted, then the drain proceeds to the next runnable task rather
      // than halting — a throttled/errored read on one task must not stall
      // everything else still dispatchable.
      onIndeterminate: (t) => {
        log("dispatch.indeterminate", { task: t.id });
        deps.onIndeterminate?.(t);
      },
      isCircuitTripped: deps.isCircuitTripped,
      // CIRCUIT BREAKER (P29(ii)): a legible ledger line every tick it is
      // consulted (mirrors dispatch.skipped) — but the caller's own escalation
      // hook fires AT MOST ONCE per task id per drain run (`circuitEscalated`,
      // above) — the drain proceeds to the next runnable task rather than
      // halting, and never re-escalates a task it already escalated this run.
      onCircuitBreak: (t) => {
        log("dispatch.circuit_broken", { task: t.id });
        if (!circuitEscalated.has(t.id)) {
          circuitEscalated.add(t.id);
          deps.onCircuitBreak?.(t);
        }
      },
    };
    // CURATION (W1-T140): a curated selection overrides the natural DAG scan
    // entirely — dispatch honors EXACTLY the operator's list and order, never
    // falling back to nextRunnable's plan-file-order walk.
    const next = opts.curated
      ? nextCurated(plan, opts.curated, attempted, isMerged, skipOpts)
      : nextRunnable(plan, isMerged, skipOpts);
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
