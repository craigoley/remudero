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
import { headroomExhausted, UNREADABLE_DEGRADED_LIMIT } from "./headroom.js";
import type { UsageSnapshot } from "./headroom.js";
import type { CostGovernorResult, QueueGovernorResult } from "./sweep.js";
import { checkDispatchGovernors, governorDeferPayload } from "./dispatch-governor.js";
import { unmetDependencies, type Plan, type Task } from "./plan.js";
import { partitionByFileOverlap, serializedLedgerPayload, settledSetPayload } from "./dispatch-overlap.js";

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
  /** Task ids this drain already continued past ({@link NON_HALTING_VERDICTS}) — never offered
   *  again in the same pass. Omit ⇒ no exclusion, exactly as before this existed. */
  excludeIds?: ReadonlySet<string>;
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
   * THE LIFETIME DISPATCH CAP (W1-T271): true when this task has been dispatched
   * (status.ts's `isLifetimeDispatchCapExceeded`, ledger-derived, `run.start`
   * lines counted across the task's WHOLE history) the policy-capped number of
   * times, EVER — a SECOND, independent backstop alongside `isCircuitTripped`,
   * never a replacement for it. `isCircuitTripped`'s own count resets to 0 on
   * every new owned PR, which is correct for the failure it guards but makes it
   * blind to a task that re-dispatches forever while merging a genuine no-op PR
   * each time (the W1-T254 incident this cap exists to catch); this count is
   * never reset by anything. Optional — omitted, dispatch behaves exactly as
   * before this cap existed.
   */
  isLifetimeCapExceeded?: (taskId: string) => boolean;
  /**
   * Called once per task excluded because its lifetime dispatch cap is
   * exceeded, in place of dispatching it — mirrors `onCircuitBreak`'s
   * legibility contract for the streak breaker.
   */
  onLifetimeCapExceeded?: (task: Task) => void;
  /**
   * Called once per task declined by one of the FOUR formerly-silent conditions, with the reason
   * that actually stopped it (first-match — see {@link tallyDispatchFilters}). Observation only:
   * omitting it leaves behaviour byte-identical, and supplying it changes no task's eligibility.
   */
  onFiltered?: (task: Task, reason: DispatchFilterReason) => void;
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
/**
 * DISPATCH ORDER (impl-DQ). Sort the plan's tasks into a stable, meaningful order before selection.
 *
 * THE DEFECT THIS REPLACES. `loadPlan` (lib/plan.ts) parses `plan/tasks.yaml` and then APPENDS every
 * `plan/tasks.d/*.yaml` shard's tasks with `tasks.push(t)`. Measured on today's plan: the monolith
 * occupies indices 0–268 and the shards 269–312, contiguously after. Both selectors below iterated
 * that array with no sort, so EVERY shard task ranked behind EVERY monolith task, permanently.
 * Dispatch priority was file placement.
 *
 * That became load-bearing on 2026-08-01, when PR #1060 redirected `rmd triage` to propose into
 * shards: from that point everything newly filed sorted last, behind 269 older entries.
 *
 * WHY TASK ID, AND WHAT IT COSTS. Ids are minted monotonically at filing time (the minter maxes over
 * every source and adds one), so ascending id IS filing order — a real, committed, deterministic
 * signal that exists on every task and needs no migration. It makes file placement irrelevant, which
 * is the whole point.
 *
 * THE COST, NAMED RATHER THAN GLOSSED: this DISCARDS the monolith's positional signal. Position in
 * `plan/tasks.yaml` was a soft priority an operator could express by moving a block, and after this
 * change moving a block does nothing. That trade is deliberate — an implicit signal that only half
 * the plan can express, and that silently starves the other half, is worse than a uniform one — but
 * it is a real loss and an explicit `priority:` field would be the honest successor.
 *
 * DETERMINISM IS ABSOLUTE. The comparator reads only `id`, which is committed content. It never
 * consults file order, mtime, or enumeration order. The numeric-then-lexicographic tiebreak makes it
 * a TOTAL order, so two runs over the same plan always select the same task.
 */
export function dispatchOrder(tasks: readonly Task[]): Task[] {
  return [...tasks].sort(compareDispatch);
}

/** Total order over task ids: leading integer ascending, then the raw id as a stable tiebreak. */
export function compareDispatch(a: Task, b: Task): number {
  const na = idOrdinal(a.id);
  const nb = idOrdinal(b.id);
  if (na !== nb) return na - nb;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** The first integer run in an id (`W1-T281` -> 281). Ids with none sort last, then lexicographically. */
function idOrdinal(id: string): number {
  const m = /(\d+)(?!.*\d)/.exec(id);
  return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
}

export function nextRunnable(plan: Plan, isMerged: MergedSet, opts: NextRunnableOpts = {}): Task | undefined {
  for (const t of dispatchOrder(plan.tasks)) {
    if (isDispatchEligible(plan, t, isMerged, opts)) return t;
  }
  return undefined;
}

/**
 * Why the eligibility filter declined a task. These are the FOUR conditions that used to return
 * silently — every later filter (indeterminate, circuit, lifetime cap, open PR) already ledgers
 * itself. Order matters and is the filter's own: see {@link tallyDispatchFilters} on first-match.
 */
export type DispatchFilterReason = "already-merged" | "verify-not-auto" | "blocked" | "unmet-deps" | "continued-this-pass";

/** How many ids each bucket names before truncating — a count tells the operator something is
 *  wrong, ids tell him WHICH, and 8 keeps the line readable against today's largest bucket (18). */
export const IDLE_REASON_ID_CAP = 8;

/** One bucket: how many were declined for this reason, and (bounded) which. */
export interface IdleReasonBucket {
  count: number;
  ids: string[];
  truncated: number;
}

export type IdleReasonTally = Record<DispatchFilterReason, IdleReasonBucket>;

/**
 * Accumulate the filter's declines so an idle daemon can say WHY it is idle.
 *
 * FIRST-MATCH, NOT EXHAUSTIVE — and this is deliberate. `isDispatchEligible` short-circuits: a task
 * that is BOTH already-merged AND `verify != auto` is counted only under `already-merged`, because
 * that is the condition that actually stopped it. Evaluating all four to give a "fuller" picture
 * would mean running `unmetDependencies` (a graph walk) on tasks the filter never needed to test,
 * on the hot path, to report a reason that was not the blocking one. The buckets therefore sum to
 * the number of tasks declined by these conditions, never to something larger.
 */
export function tallyDispatchFilters(): {
  onFiltered: (task: Task, reason: DispatchFilterReason) => void;
  snapshot: () => IdleReasonTally;
  signature: () => string;
} {
  const seen: Record<DispatchFilterReason, string[]> = {
    "already-merged": [],
    "verify-not-auto": [],
    blocked: [],
    "unmet-deps": [],
    "continued-this-pass": [],
  };
  const snapshot = (): IdleReasonTally =>
    (Object.keys(seen) as DispatchFilterReason[]).reduce((acc, r) => {
      const all = seen[r];
      acc[r] = { count: all.length, ids: all.slice(0, IDLE_REASON_ID_CAP), truncated: Math.max(0, all.length - IDLE_REASON_ID_CAP) };
      return acc;
    }, {} as IdleReasonTally);
  return {
    onFiltered: (task, reason) => seen[reason].push(task.id),
    snapshot,
    // The CHANGE key: the daemon re-emits only when this differs, so an unchanged picture does not
    // repeat 390 times. Ids are included so a swap of equal-sized buckets still counts as a change.
    signature: () => JSON.stringify(seen),
  };
}

/**
 * The exact per-task eligibility chain {@link nextRunnable} and {@link
 * runnableCandidates} both apply, factored out so the two can never drift: a task
 * ineligible for SOLO dispatch must never be offered as a concurrent candidate
 * either. Order matters (see the inline comments on each guard) and is preserved
 * verbatim from nextRunnable's original single-task walk.
 */
function isDispatchEligible(plan: Plan, t: Task, isMerged: MergedSet, opts: NextRunnableOpts): boolean {
  const merged: import("./plan.js").MergedResolver = (task) => isMerged(task.id);
  // THE FOUR FORMERLY-SILENT DECLINES. `opts.onFiltered` is observation ONLY — every `return
  // false` below is byte-identical to before, in the same order, so nothing's dispatchability
  // changes. Mirrors the `onIndeterminate`/`onCircuitBreak`/`onLifetimeCapExceeded` idiom already
  // used by the filters further down, which have always been legible.
  if (isMerged(t.id)) {
    opts.onFiltered?.(t, "already-merged");
    return false;
  }
  // CONTINUED THIS PASS (NON_HALTING_VERDICTS): a task the drain already ran and continued past
  // is unmerged with an OPEN PR, so every later selection would offer it again — an unbounded
  // re-dispatch of one task inside a single drain, which is strictly worse than the halt this
  // change removes. `isOpenPr` would usually catch it, but that dep is OPTIONAL and a caller that
  // omits it would get the loop; this guard needs no reads and cannot be omitted. Checked FIRST,
  // ahead of every probe, because it is free and it is unconditional.
  if (opts.excludeIds?.has(t.id)) {
    opts.onFiltered?.(t, "continued-this-pass");
    return false;
  }
  if (t.verify !== "auto") {
    opts.onFiltered?.(t, "verify-not-auto");
    return false;
  }
  if (t.status === "blocked") {
    opts.onFiltered?.(t, "blocked");
    return false;
  }
  if (unmetDependencies(plan, t, merged).length > 0) {
    opts.onFiltered?.(t, "unmet-deps");
    return false;
  }
  // INDETERMINATE (W1-T119) — checked BEFORE the circuit breaker and the
  // in-flight guard: an indeterminate read says nothing about either of
  // those, and dispatching now risks re-running work that may already be
  // merged (the throttle-reads-as-not-merged spend event this task exists
  // to prevent). NEVER treated as an ordinary queued task.
  if (opts.isIndeterminate?.(t.id)) {
    opts.onIndeterminate?.(t);
    return false;
  }
  // PER-TASK DISPATCH CIRCUIT BREAKER (P29(ii)) — checked BEFORE the in-flight
  // guard below: a tripped task halts regardless of whatever its latest PR's
  // state happens to be; it is the backstop that bounds (i)'s sibling-credit
  // fix even if that fix is somehow wrong.
  if (opts.isCircuitTripped?.(t.id)) {
    opts.onCircuitBreak?.(t);
    return false;
  }
  // LIFETIME DISPATCH CAP (W1-T271) — checked right alongside the streak breaker
  // above, never in its place: a task that keeps re-dispatching while merging a
  // genuine no-op PR each time resets the streak breaker's count on every merge
  // and would otherwise never trip anything.
  if (opts.isLifetimeCapExceeded?.(t.id)) {
    opts.onLifetimeCapExceeded?.(t);
    return false;
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
      return false; // IN-FLIGHT (or unreadable — fail OPEN) — never a duplicate fresh build.
    }
  }
  return true;
}

/**
 * Up to `limit` runnable tasks, in FILE ORDER — the multi-candidate generalization
 * of {@link nextRunnable} for a concurrent dispatcher (P19 rung 1, W1-T171; wired
 * by the lane scheduler in W1-T172) to hand to `dispatch-overlap.ts`'s
 * `partitionByFileOverlap`. Applies the EXACT SAME eligibility chain as
 * `nextRunnable` (see {@link isDispatchEligible}) — a task ineligible for solo
 * dispatch is never offered as a concurrent candidate either. `limit <= 0` yields
 * an empty array. This function does NOT itself check `files:` overlap between the
 * candidates it returns — that partition is `dispatch-overlap.ts`'s job, kept
 * separate so the DAG/status eligibility logic here never duplicates the pure glob
 * predicate there (and vice versa).
 */
export function runnableCandidates(plan: Plan, isMerged: MergedSet, limit: number, opts: NextRunnableOpts = {}): Task[] {
  const out: Task[] = [];
  for (const t of dispatchOrder(plan.tasks)) {
    if (out.length >= limit) break;
    if (isDispatchEligible(plan, t, isMerged, opts)) out.push(t);
  }
  return out;
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
  | "error"
  /**
   * W1-T172: the queue governor's WIP ceiling leaves ZERO lane headroom this
   * tick (`laneDispatchBudget` returned 0) — runnable work may well exist,
   * held back by the governor rather than absent (distinct from
   * `no_runnable`, which means nothing is eligible at all). Only reachable
   * via the multi-lane path ({@link runDrainLanes}); the single-lane path
   * never consults the governor and can never produce it.
   */
  | "wip_deferred"
  /**
   * W1-T290: `/usage` came back unreadable on more than {@link
   * UNREADABLE_DEGRADED_LIMIT} (or `DrainOpts.unreadableDegradedLimit`)
   * CONSECUTIVE ticks — the daemon's bounded-degraded ceiling, ported to the
   * drain. Distinct from `headroom_exhausted` (a confirmed at/near-limit
   * reading): this is "the reader itself has gone dark for too long to keep
   * dispatching blind." Only reachable when `DrainOpts.headroomEnabled` is
   * not explicitly `false` — the 2026-07-28 governor ruling makes an
   * unreadable read ABSENT TELEMETRY, never a hold, on a host that opted out.
   */
  | "headroom_degraded"
  /**
   * W1-T317: the DAILY COST CEILING (`checkCostGovernor`, sweep.ts) reports the day's ledgered
   * spend at/over `policy.dailyCostCeilingUsd` — new dispatch is held back this pass, distinct
   * from `headroom_exhausted` (an API-usage window) and from `blocked` (a real task failure):
   * drainage is unaffected, only NEW dispatch stops. A future pass (the next `rmd drain`
   * invocation, or the daemon's own idle heartbeat) re-derives the day's spend fresh and resumes
   * once it drops back under the ceiling.
   */
  | "cost_governor_deferred"
  /**
   * W1-T321 (wiring `checkQueueGovernor`, sweep.ts, the W1-T121 23-open-PR incident): the open-PR
   * WIP count is at/over `policy.wipLimit` — new dispatch is held back this pass, distinct from
   * `cost_governor_deferred` above (a spend ceiling) and from the lanes path's own PRE-EXISTING
   * `laneDispatchBudget` throttle (W1-T172, `dispatch.wip_deferred`, which only SIZES a still-open
   * lanes pass and never stops one outright). Drainage (sweep/heal/arm/merge, at any depth) is
   * unaffected, only NEW dispatch stops — see `checkQueueGovernor`'s own asymmetry note. A future
   * pass (the next `rmd drain` invocation, or the daemon's own idle heartbeat) re-derives the open
   * count fresh and resumes once it drops back under the limit.
   */
  | "queue_governor_deferred";

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
  /**
   * W1-T172 PARALLEL DISPATCH — the number of concurrent dispatch lanes this
   * drain fills per pass (`SweepPolicy.dispatchLanes` — ONE threshold home,
   * never a second; see sweep.ts). Omitted or <= 1 ⇒ {@link runDrain}'s
   * original single-task loop, UNCHANGED byte-for-byte — both the
   * regression lock and the off switch. >= 2 hands off to the concurrent
   * pass loop ({@link runDrainLanes}).
   */
  laneCount?: number;
  /**
   * W1-T172: the queue governor's WIP ceiling (`SweepPolicy.wipLimit`,
   * W1-T121) consulted ALONGSIDE `laneCount` on the multi-lane path — THE
   * GOVERNOR IS THE CEILING, NOT A SUGGESTION: a pass never dispatches past
   * `min(laneCount, wipLimit - observed open count)`. Omitted ⇒ unbounded by
   * the governor (bounded by `laneCount` alone). Never consulted on the
   * single-lane path (unchanged from before this task).
   */
  wipLimit?: number;
  /**
   * W1-T290: the headroom governor switch — the SAME resolved posture
   * `daemon.ts`'s identically-named `DaemonOpts.headroomEnabled` reads
   * (operator ruling fb-1784894405468-a4153e; config.ts's
   * `resolveHeadroomEnabled`). Gates ONLY the new unreadable-degraded ceiling
   * below (`headroom_degraded`) — the existing at/near-limit
   * `headroom_exhausted` stop is unconditional, unchanged by this option, on
   * both loops. When `false`, an unreadable `/usage` read is ABSENT
   * TELEMETRY, never a hold: no `drain.headroom.unavailable`/`.degraded`
   * line, no consecutive-count escalation, dispatch proceeds regardless.
   * Defaults to `true` so an unconfigured caller's behavior — and every
   * existing test — is unchanged; the real `rmd drain` CLI entry resolves
   * this from config/env and passes it explicitly, mirroring the daemon's
   * own wiring.
   */
  headroomEnabled?: boolean;
  /**
   * W1-T290: CONSECUTIVE unreadable `/usage` reads this drain tolerates
   * before stopping with `headroom_degraded` (default {@link
   * UNREADABLE_DEGRADED_LIMIT}, the SAME shared constant `daemon.ts`'s
   * `DEFAULT_UNREADABLE_DEGRADED_LIMIT` resolves to — one policy number, two
   * consumers, never a second drift-prone literal). A single successful read
   * resets the count to zero, exactly as the daemon's does.
   */
  unreadableDegradedLimit?: number;
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

/**
 * Default iteration cap — a sane bound, never infinite (an unattended loop).
 *
 * W1-T253 (P37 CONSUMERS): mirrors `plan/policy.yaml`'s `drain.max` (lifted FROM this
 * literal by the W1-T252 substrate) but stays a literal HERE rather than self-loading via
 * `policy.ts`'s `loadDefaultPolicy` (a `readFileSync`, see review.ts/worker.ts/sweep.ts's
 * siblings in this same task) — `daemon.ts` imports THIS module at the VALUE level
 * (`nextRunnable`), and daemon.ts's own file header is explicit: "this pure module never
 * touches the filesystem" (Rule 16 — `runDaemon` must stay callable thousands of times
 * against an injected clock in a unit test with zero real I/O). An eager fs read here would
 * leak into every daemon.ts import transitively. So this stays the fs-free fallback for a
 * direct/test caller, and `drainCommand`/`daemonCommand` (run-task.ts) — the real `rmd
 * drain`/`rmd daemon` CLI entries — load `plan/policy.yaml`'s `drain.max` and thread it in
 * explicitly on every real invocation, so a policy edit moves the LIVE bound with zero code
 * change even though this constant is provably dead on that path
 * (test/policy-consumers.test.ts).
 */
export const DEFAULT_MAX = 10;

export interface DrainSummary {
  attempted: string[];
  merged: string[];
  /**
   * Tasks that did NOT merge and did NOT halt the drain — see {@link NON_HALTING_VERDICTS}.
   *
   * SEPARATE FROM `merged` ON PURPOSE. A continued task's work is pushed but NOT merged, so
   * crediting it here would make its dependents dispatchable against work that has not landed —
   * the exact hazard stop-on-block exists to prevent. This list records what happened; it grants
   * nothing.
   *
   * OPTIONAL, and the reason is diff hygiene rather than semantics: both production `summary()`
   * helpers always populate it, but making it required forced a `continued: []` into ten existing
   * fixtures across five test files that have nothing to do with the halt rule. Every reader
   * defaults it to empty, and "absent" and "empty" mean the same thing to all of them.
   */
  continued?: Array<{ taskId: string; verdict: string; prUrl?: string }>;
  stopReason: StopReason;
  /** Human detail: the blocked task + verdict, the reset time, the error, etc. */
  stopDetail?: string;
  costUsd: number;
  resumeCommand: string;
}

/**
 * Verdicts that are NOT `merged` and yet must NOT stop the drain.
 *
 * THE ARGUMENT IS THIS MODULE'S OWN HEADER, WHICH JUSTIFIES STOP-ON-BLOCK AS: "a blocked task's
 * DEPENDENTS would build on missing work, so continuing risks compounding a gap." That is exactly
 * right for a real block — and it is FALSE for `blocked_ci`. A `blocked_ci` run has pushed its
 * branch, opened its PR and done the work; the only thing outstanding is CI's own verdict. Its
 * dependents would build on work that exists and is about to land. MEASURED: #1492 and #1495 both
 * returned `blocked_ci` and both merged afterwards, unchanged.
 *
 * SO THE HALT WAS A CORRECT RULE APPLIED TO A CASE IT WAS NEVER ARGUED FOR, and the cost is real:
 * the drain stops at the first non-merged verdict, so one CI stall ends a `--max 6` budget after
 * one task with five dispatches unspent.
 *
 * NOTHING IS CREDITED BY BEING HERE. Membership means "keep going", never "this task is done" —
 * `continued` is deliberately not `merged`, and the dependency filter is unchanged.
 *
 * `no_pr` JOINS THE SET TOO, and this REVERSES what the paragraph below used to say — recorded
 * rather than quietly edited, because the earlier reasoning was explicit and deserves an explicit
 * answer. It ran: "nothing was produced at all, which is strictly worse than a block, and its own
 * doc argues the halt explicitly (`a blind auto-retry carries NO new information`)."
 *
 * THAT IS TRUE ABOUT THE RUN AND IRRELEVANT TO THE HALT. "Strictly worse" ranks how much VALUE a
 * run delivered; the halt exists for a different question — whether continuing would COMPOUND a
 * gap. The header's own justification is that "a blocked task's DEPENDENTS would build on missing
 * work". A `no_pr` run produced nothing and advanced nothing, so its dependents face exactly the
 * state they started from. And they cannot be selected regardless: `isDispatchEligible` (this
 * file) filters any task with `unmetDependencies(...).length > 0` as `unmet-deps`, and it is the
 * SINGLE predicate behind both `nextRunnable` and `runnableCandidates`. Dependents are protected
 * by the dependency machinery, not by the halt.
 *
 * THE HALT ALSO DOES NOT DO THE THING THE RETRY ARGUMENT WANTS. It never prevents the `no_pr` task
 * being dispatched again — a later pass re-offers it either way. All it prevents is OTHER,
 * UNRELATED tasks running now. And within a pass there is no blind retry to fear: `excludeIds`
 * means a continued-past task is never offered again in the same pass.
 *
 * RE-DISPATCH REMAINS BOUNDED, and by the instrument built for exactly this shape.
 * `isDispatchBreakerTripped` (status.ts) counts `dispatchesWithoutNewOwnedPr`, which resets ONLY
 * on a `pr.opened` line — and a `no_pr` run never writes one, so for this verdict the counter is
 * monotonic and trips at the streak cap. `isLifetimeDispatchCapExceeded` is the second backstop
 * and never resets at all. Both read the running config's ledger, so they are PER-HOST and a fresh
 * container starts from zero; the task's own yaml `attempts:` field bounds nothing, since
 * `parseTasksFromYaml` defaults it to 0 and nothing in `src/` ever writes it back.
 *
 * THE COST WAS MEASURED, on the container path where the header's OTHER justification — "a human
 * kicked it off by hand and is watching it" — is simply false, because the drain IS the unattended
 * path there. Four dispatches ended `no_pr` in one day (W1-T388, W1-T392 twice, W1-T393), each
 * confirmed by `git rev-list --count origin/main..<run-branch>` = 0, and one drain reported
 * `stopped: blocked — W1-T393 → no_pr` after two dispatches of a `--max 6` budget. That is four
 * budgeted runs surrendered to protect nothing.
 *
 * BOTH SHAPES INSIDE `no_pr` ARE TREATED THE SAME, deliberately: a worker that produced nothing,
 * and a worker whose `ALREADY_SATISFIED` claim failed to verify and fell through (run-task.ts's
 * `resolveAlreadySatisfied`). Neither opened a PR, neither committed, neither advanced the task —
 * the halt decision cannot tell them apart and has no reason to.
 *
 * WHY NO OTHER VERDICT JOINS THIS SET, verdict by verdict. `blocked`, `blocked_review`,
 * `blocked_containment`, `blocked_isolation`, `blocked_illformed`, `failed` and
 * `pr_attribution_failed` all leave the work unfinished or unattributable, so the header's
 * argument applies unchanged. `blocked_budget`, `blocked_transient` and `blocked_git_fetch` are
 * environmental and say nothing about this task alone: the next dispatch would meet the same
 * condition, so continuing burns runs rather than making progress. `blocked_inflight` means
 * another holder owns the task right now. `task_already_merged` is non-merged but arguably
 * mis-halting for a different reason (nothing ran, nothing was spent) — deliberately left alone
 * here, because it is a separate concern and this change is scoped to one verdict.
 * `already_satisfied` never reaches this predicate: it returns `merged: true` and behaves as
 * forward progress.
 *
 * NOT FIXED HERE, AND NOT LOST: the reason `blocked_ci` fires on healthy PRs at all is that
 * `checkWaitStalled`'s window is a 30-second elapsed bound (five identical polls at six seconds)
 * measured against a `ci` job that needs minutes, so a long healthy job reads as a stall. Teaching
 * that predicate to count a still-running check as forward motion is the right second fix and a
 * different concern; this change makes the misfire cheap rather than making it rarer.
 */
export const NON_HALTING_VERDICTS: ReadonlySet<string> = new Set(["blocked_ci", "no_pr"]);

/**
 * Should this result stop the drain? `merged` never does; a non-merged verdict does UNLESS it is
 * in {@link NON_HALTING_VERDICTS}.
 *
 * Extracted rather than inlined at the two loop sites (single-lane and parallel-lane) so both
 * decide with ONE predicate — the single-lane and multi-lane paths having drifted apart is a
 * documented hazard in this file, and a halt rule that differed between them would be invisible
 * until a lane count changed.
 */
export function haltsDrain(result: { merged: boolean; verdict: string }): boolean {
  if (result.merged) return false;
  return !NON_HALTING_VERDICTS.has(result.verdict);
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
  // A CONTINUED TASK MUST CARRY ITS OWN DETAIL, NEVER THE DRAIN'S `stopDetail`. Before
  // NON_HALTING_VERDICTS existed this could not go wrong: only the LAST attempted id could be
  // non-merged, so `stopDetail` always described that id. Now an earlier id can be non-merged too,
  // and blindly attaching `stopDetail` would print one task's line against a DIFFERENT task's
  // verdict — a self-contradicting record, which is worse than a terse one.
  const continuedByTask = new Map((summary.continued ?? []).map((c) => [c.taskId, c] as const));
  return summary.attempted.map((taskId): RundownLine => {
    if (merged.has(taskId)) return { taskId, outcome: "merged" };
    const escalation = escalationByTask.get(taskId);
    if (escalation) return { taskId, outcome: "escalated", escalation };
    const cont = continuedByTask.get(taskId);
    if (cont) {
      return { taskId, outcome: "blocked", detail: `${cont.verdict}${cont.prUrl ? ` (${cont.prUrl})` : ""} — drain continued` };
    }
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
   * W1-T316 (wiring W1-T271's own predicate): THE LIFETIME DISPATCH CAP, re-derived from the
   * ledger each call — same freshness contract as `isCircuitTripped`. Unlike the streak
   * breaker, never reset by a `pr.opened` line — see {@link NextRunnableOpts.isLifetimeCapExceeded}'s
   * doc for the full W1-T254 rationale. Optional — omitted, dispatch behaves exactly as before
   * this cap existed.
   */
  isLifetimeCapExceeded?: (taskId: string) => boolean;
  /**
   * Called once per task excluded because its lifetime dispatch cap is exceeded — mirrors
   * `onCircuitBreak`'s legibility contract, so this exclusion is never a silent skip.
   */
  onLifetimeCapExceeded?: (task: Task) => void;
  /**
   * W1-T317 (wiring `checkCostGovernor`, sweep.ts): THE DAILY COST CEILING, re-derived from the
   * ledger each call — same freshness contract as `isCircuitTripped`/`isLifetimeCapExceeded`
   * above. UNLIKE those, this is NOT task-specific — one answer per tick, never keyed by taskId
   * — so it is consulted directly in the loop below, alongside `checkStop`/`checkPause`/headroom,
   * rather than threaded through `NextRunnableOpts`'s per-task chain. A defined return means
   * "defer — do not open a new run this pass", carrying the observed day-cost/ceiling that
   * produced it; `undefined` means proceed normally. The real wiring (run-task.ts) also LEDGERS
   * the deferral itself (`logCostGovernorDeferral`) before returning, so this loop never needs
   * `ledgerPath`/`runId` to report it. Optional — omitted, dispatch behaves exactly as before
   * this governor existed. Never consulted from `runSweep` or any of its deps (arm/dispatchFix/
   * close/escalate) — drainage of already-open PRs is a separate code path this predicate is
   * never wired into (see `checkCostGovernor`'s own doc: "stranding in-flight work to save money
   * is a worse failure than the spend itself").
   */
  checkCostGovernor?: () => CostGovernorResult | undefined;
  /**
   * W1-T321 (wiring `checkQueueGovernor`, sweep.ts, the W1-T121 23-open-PR incident): THE WIP
   * CEILING, re-derived from the current open-PR count each call — same freshness contract as
   * `checkCostGovernor` immediately above. Like the cost governor and UNLIKE
   * `isCircuitTripped`/`isLifetimeCapExceeded` below, this is NOT task-specific — one answer per
   * pass — so it is consulted directly in the loop below, in the SAME position as
   * `checkCostGovernor`, before `nextRunnable` is ever called. A defined return means "defer — do
   * not open a new run this pass", carrying the observed open count/limit that produced it;
   * `undefined` means proceed normally. STOPS the pass outright (this is a bounded, one-shot
   * command, the same shape `cost_governor_deferred` already uses) — drainage of already-open PRs
   * never runs through this loop at all. Distinct from `openPrCount` below: that field feeds the
   * lanes path's own PRE-EXISTING `laneDispatchBudget` throttle (W1-T172), which only SIZES a
   * still-open lanes pass; this field is the hard governor gate, consulted on BOTH the single-lane
   * and lanes loops. The real wiring (run-task.ts) also LEDGERS the deferral itself
   * (`logQueueGovernorDeferral`) before returning, so this loop never needs `ledgerPath`/`runId` to
   * report it. Optional — omitted, dispatch behaves exactly as before this governor existed. Never
   * consulted from `runSweep` or any of its deps (arm/dispatchFix/close/escalate) — see
   * `checkQueueGovernor`'s own asymmetry note for why drainage must never be gated by it.
   */
  checkQueueGovernor?: () => QueueGovernorResult | undefined;
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
  /**
   * W1-T172: the CURRENT observed open-PR count — the queue governor's other
   * input alongside `DrainOpts.wipLimit` (re-derive fresh each call, the same
   * freshness contract as `isOpenPr`/`isCircuitTripped` above; the real
   * wiring counts OPEN entries in the SAME projection `refreshMerged` just
   * built, never a second GitHub read path). Only consulted on the multi-lane
   * path; omitted there, lane count is bounded by `laneCount` alone.
   */
  openPrCount?: () => number;
}

/**
 * The drain loop. Deterministic; no LLM decisions. Each iteration: re-derive
 * status → check headroom → pick the next runnable → run it → STOP on any
 * non-merged verdict. Returns a {@link DrainSummary}.
 *
 * W1-T172 PARALLEL DISPATCH: `opts.laneCount >= 2` hands off to {@link
 * runDrainLanes}, the concurrent multi-task pass loop, entirely separate code
 * so THIS loop can never drift under lane changes. Omitted or `<= 1` runs the
 * single-task loop below, unchanged from before this task except for the
 * bounded-degraded headroom ceiling (W1-T290, see the loop body).
 */
export async function runDrain(plan: Plan, deps: DrainDeps, opts: DrainOpts = {}): Promise<DrainSummary> {
  if ((opts.laneCount ?? 1) >= 2) return runDrainLanes(plan, deps, opts);

  const max = opts.max ?? DEFAULT_MAX;
  const log = deps.log ?? (() => {});
  const attempted: string[] = [];
  const merged: string[] = [];
  /** Non-merged, non-halting outcomes (NON_HALTING_VERDICTS) — recorded, never credited. */
  const continued: NonNullable<DrainSummary["continued"]> = [];
  /** The same ids as a set — the selection guard's input, so a continued task is never re-offered. */
  const continuedIds = new Set<string>();
  let costUsd = 0;
  // W1-T290: the daemon's bounded-degraded ceiling, ported — CONSECUTIVE
  // unreadable `/usage` reads, not any-unreadable. Reset to 0 on any
  // successful read; escalates past `unreadableDegradedLimit` (see the
  // headroom block below).
  let consecutiveUnreadable = 0;
  const headroomEnabled = opts.headroomEnabled ?? true;
  const unreadableDegradedLimit = opts.unreadableDegradedLimit ?? UNREADABLE_DEGRADED_LIMIT;
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
  // LIFETIME CAP ESCALATION DEDUP (W1-T316, mirroring `circuitEscalated` immediately above):
  // bounds the CALLBACK to the drain's own first observation of each task id — the predicate
  // itself is still consulted (and still excludes the task) every tick.
  const lifetimeCapEscalated = new Set<string>();

  const summary = (stopReason: StopReason, stopDetail?: string): DrainSummary => {
    const s: DrainSummary = { attempted, merged, continued, stopReason, stopDetail, costUsd, resumeCommand: resumeCommand(opts) };
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

    // HEADROOM: never hammer a nearly-exhausted pool. An at/near-limit reading
    // STOPS the drain outright, with the reset time reported (unchanged by
    // this task). An unreadable read is BOUNDED best-effort (W1-T290, ported
    // from daemon.ts's identical mechanism): within `unreadableDegradedLimit`
    // CONSECUTIVE misses the drain still dispatches — max + the budget
    // tripwire still bound it — but beyond the allowance it stops rather than
    // dispatching blind against a pool that may already be exhausted; a
    // single successful read resets the count to zero. Gated by
    // `headroomEnabled` (2026-07-28 ruling): disabled, an unreadable read is
    // absent telemetry, never a hold.
    if (deps.readUsage) {
      const snap = deps.readUsage();
      const over = snap ? headroomExhausted(snap, opts.headroomLimitPct) : null;
      if (over) {
        log("drain.headroom", { window: over.window, percent_used: over.percentUsed, resets_at: over.resetsAt });
        return summary("headroom_exhausted", `${over.window} at ${over.percentUsed}% — resets ${over.resetsAt}`);
      }
      if (snap) {
        consecutiveUnreadable = 0;
      } else if (headroomEnabled) {
        consecutiveUnreadable++;
        if (consecutiveUnreadable > unreadableDegradedLimit) {
          log("drain.headroom.degraded", {
            consecutive_unreadable: consecutiveUnreadable,
            degraded_limit: unreadableDegradedLimit,
            note: "usage unreadable beyond the bounded allowance — stopping, not dispatching",
          });
          return summary(
            "headroom_degraded",
            `usage unreadable ${consecutiveUnreadable}x consecutively (limit ${unreadableDegradedLimit})`,
          );
        }
        log("drain.headroom.unavailable", {
          consecutive_unreadable: consecutiveUnreadable,
          degraded_limit: unreadableDegradedLimit,
          note: "usage unreadable — bounded degraded-mode allowance, still dispatching",
        });
      } else {
        // GOVERNOR DISABLED (operator ruling fb-1784894405468-a4153e): an
        // unreadable read is ABSENT TELEMETRY, never a hold — no degraded
        // stop, no escalation counter, no headroom line. Dispatch proceeds;
        // reset the counter so a later enable starts from a clean slate.
        consecutiveUnreadable = 0;
      }
    }

    // DAILY COST CEILING (W1-T317, wiring `checkCostGovernor`/sweep.ts): a global gate, not a
    // per-task one, so — unlike `isCircuitTripped`/`isLifetimeCapExceeded` below — it is checked
    // directly here, in the SAME position as headroom just above, before `nextRunnable` is ever
    // called: at/over the day's ceiling, NO task this tick would change the outcome. STOPS the
    // pass outright (this is a bounded, one-shot command, the same shape `headroom_exhausted`
    // already uses) — drainage of already-open PRs never runs through this loop at all.
    const costGoverned = deps.checkCostGovernor?.();
    if (costGoverned) {
      log("drain.cost_governor", {
        observed_day_cost_usd: costGoverned.observedDayCostUsd,
        daily_cost_ceiling_usd: costGoverned.ceilingUsd,
      });
      return summary(
        "cost_governor_deferred",
        `$${costGoverned.observedDayCostUsd.toFixed(2)} spent today at/over the $${costGoverned.ceilingUsd.toFixed(2)} daily ceiling — new dispatch deferred`,
      );
    }

    // QUEUE GOVERNOR / WIP CEILING (W1-T321, wiring `checkQueueGovernor`/sweep.ts, the W1-T121
    // 23-open-PR incident): a global gate, not a per-task one, so it is checked directly here, in
    // the SAME position as the cost governor just above, before `nextRunnable` is ever called:
    // at/over the WIP limit, NO task this tick would change the outcome. STOPS the pass outright
    // (the same bounded, one-shot shape `cost_governor_deferred` already uses) — drainage of
    // already-open PRs never runs through this loop at all.
    const queueGoverned = deps.checkQueueGovernor?.();
    if (queueGoverned) {
      log("drain.queue_governor", {
        observed_open_count: queueGoverned.observedOpenCount,
        wip_limit: queueGoverned.wipLimit,
      });
      return summary(
        "queue_governor_deferred",
        `${queueGoverned.observedOpenCount} open PRs at/over the ${queueGoverned.wipLimit} WIP limit — new dispatch deferred`,
      );
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
      isLifetimeCapExceeded: deps.isLifetimeCapExceeded,
      // LIFETIME DISPATCH CAP (W1-T316/W1-T271): a legible ledger line every tick it is
      // consulted (mirrors dispatch.circuit_broken) — but the caller's own escalation hook
      // fires AT MOST ONCE per task id per drain run (`lifetimeCapEscalated`, above) — the
      // drain proceeds to the next runnable task rather than halting.
      onLifetimeCapExceeded: (t) => {
        log("dispatch.lifetime_capped", { task: t.id });
        if (!lifetimeCapEscalated.has(t.id)) {
          lifetimeCapEscalated.add(t.id);
          deps.onLifetimeCapExceeded?.(t);
        }
      },
      // Never re-offer a task this pass already continued past — see the guard in
      // isDispatchEligible for why this cannot rely on `isOpenPr` alone.
      excludeIds: continuedIds,
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

    if (haltsDrain(result)) {
      // STOP-ON-BLOCK: a blocked task's dependents would build on missing work.
      log("drain.blocked", { task: next.id, verdict: result.verdict, pr_url: result.prUrl });
      return summary("blocked", `${next.id} → ${result.verdict}${result.prUrl ? ` (${result.prUrl})` : ""}`);
    }
    if (!result.merged) {
      // CONTINUED, NOT CREDITED (see NON_HALTING_VERDICTS): the work is pushed and its PR is open,
      // so the drain keeps its remaining budget — but the task is NOT added to `merged`, so the
      // dependency filter still refuses its dependents until the PR actually lands.
      continued.push({ taskId: next.id, verdict: result.verdict, prUrl: result.prUrl });
      continuedIds.add(next.id);
      log("drain.continued", { task: next.id, verdict: result.verdict, pr_url: result.prUrl });
      continue;
    }
    merged.push(next.id);
    if (opts.until && next.id === opts.until) return summary("until_reached", opts.until);
  }
  return summary("max_reached", `${max} task(s)`);
}

// ────────────────────────────────────────────────────────────────────────────
// W1-T172 — PARALLEL DISPATCH. Ratifies P19's dispatch half (DECISIONS.md
// 2026-07-21): "N parallel dispatch lanes bounded by the governor's WIP limit
// (start N=2), with W1-T80 dedup + W1-T149's circuit breaker as the per-task
// guards." Both are reused UNCHANGED via `runnableCandidates` (they are the
// exact same `isDispatchEligible` chain the single-lane loop above applies —
// see that function's own doc). W1-T171's `partitionByFileOverlap` adds the
// ACROSS-candidate check the single-task loop never needed. Little's law is
// still the argument, one layer up: lanes raise the RATE at which the
// governor's bounded WIP fills; they never raise the bound itself.
// ────────────────────────────────────────────────────────────────────────────

/** {@link laneDispatchBudget}'s input — one pass's governor consultation. */
export interface LaneBudgetInput {
  /** `SweepPolicy.dispatchLanes` (W1-T172) — the row this drain was configured with. */
  laneCount: number;
  /** `SweepPolicy.wipLimit` (W1-T121), when the governor is wired at this call site. */
  wipLimit?: number;
  /** The current observed open-PR count — the governor's other input. */
  openPrCount?: number;
}

/**
 * THE GOVERNOR IS THE CEILING, NOT A SUGGESTION: how many tasks a pass may
 * dispatch this tick — `min(laneCount, headroom)`, where headroom is
 * `wipLimit - openPrCount`, floored at 0. `wipLimit`/`openPrCount` omitted ⇒
 * unbounded by the governor (bounded by `laneCount` alone) — the same
 * "an un-wired site behaves exactly as before this guard existed" contract
 * every other optional dispatch guard in this module already carries. Pure;
 * no I/O; never negative.
 */
export function laneDispatchBudget(input: LaneBudgetInput): number {
  const lanes = Math.max(0, input.laneCount);
  if (input.wipLimit === undefined || input.openPrCount === undefined) return lanes;
  const headroom = Math.max(0, input.wipLimit - input.openPrCount);
  return Math.min(lanes, headroom);
}

/**
 * The concurrent-lane pass loop (W1-T172), entered only via {@link runDrain}
 * when `opts.laneCount >= 2`. Each pass: the SAME per-tick checks as the
 * single-lane loop (fleet control, `--until`, headroom) → this pass's lane
 * BUDGET ({@link laneDispatchBudget}, the governor ceiling) → up to `budget`
 * runnable candidates ({@link runnableCandidates} — the EXACT SAME per-task
 * guards the single-lane path applies, W1-T80's open-PR dedup and W1-T149's
 * circuit breaker, reused, never reimplemented) → partitioned for `files:`
 * overlap ACROSS the co-dispatched set (W1-T171's `partitionByFileOverlap`)
 * → the surviving dispatch set run CONCURRENTLY via `Promise.allSettled` —
 * never `Promise.all`, whose first rejection would abort every sibling
 * promise still in flight; every lane's result is awaited and recorded
 * before this pass decides anything (LANE-LOCAL BLOCK SEMANTICS: one lane's
 * block or throw never halts, cancels, or races ahead of its siblings) →
 * `dispatch.concurrent_set` ledgers the co-dispatched ids (the evidence
 * trail P19's banked rung 2 needs) → on any block or lane failure THIS pass,
 * the WHOLE drain stops afterward — same STOP-ON-BLOCK doctrine as the
 * single-lane loop's header, just evaluated at pass granularity instead of
 * per task; W1-T46's smarter successor block reasoner is what would change
 * WHAT happens to a blocked lane, not whether its siblings survive the pass.
 */
async function runDrainLanes(plan: Plan, deps: DrainDeps, opts: DrainOpts): Promise<DrainSummary> {
  const laneCount = Math.max(1, opts.laneCount ?? 1);
  const max = opts.max ?? DEFAULT_MAX;
  const log = deps.log ?? (() => {});
  const attempted: string[] = [];
  const merged: string[] = [];
  /** Non-merged, non-halting outcomes (NON_HALTING_VERDICTS) — recorded, never credited. */
  const continued: NonNullable<DrainSummary["continued"]> = [];
  /** The same ids as a set — the selection guard's input, so a continued task is never re-offered. */
  const continuedIds = new Set<string>();
  let costUsd = 0;
  // Same escalation-dedup contract as the single-lane loop (see its own
  // comment): bounds the CALLBACK to this drain's first observation of each
  // tripped task id, across every pass — `isCircuitTripped` itself is still
  // consulted (and still excludes the task) every pass.
  const circuitEscalated = new Set<string>();
  // Same escalation-dedup contract, for the lifetime cap (W1-T316/W1-T271).
  const lifetimeCapEscalated = new Set<string>();
  // W1-T290: same bounded-degraded ceiling as the single-lane loop above —
  // see that loop's comment. BOTH sites carry it, or the multi-lane path
  // (`--lanes`) would stay the latent fail-open bug this task closes.
  let consecutiveUnreadable = 0;
  const headroomEnabled = opts.headroomEnabled ?? true;
  const unreadableDegradedLimit = opts.unreadableDegradedLimit ?? UNREADABLE_DEGRADED_LIMIT;

  const summary = (stopReason: StopReason, stopDetail?: string): DrainSummary => {
    const s: DrainSummary = { attempted, merged, continued, stopReason, stopDetail, costUsd, resumeCommand: resumeCommand(opts) };
    log("drain.summary", { ...s });
    return s;
  };

  while (attempted.length < max) {
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
    if (opts.until && isMerged(opts.until)) return summary("until_reached", opts.until);

    if (deps.readUsage) {
      const snap = deps.readUsage();
      const over = snap ? headroomExhausted(snap, opts.headroomLimitPct) : null;
      if (over) {
        log("drain.headroom", { window: over.window, percent_used: over.percentUsed, resets_at: over.resetsAt });
        return summary("headroom_exhausted", `${over.window} at ${over.percentUsed}% — resets ${over.resetsAt}`);
      }
      if (snap) {
        consecutiveUnreadable = 0;
      } else if (headroomEnabled) {
        consecutiveUnreadable++;
        if (consecutiveUnreadable > unreadableDegradedLimit) {
          log("drain.headroom.degraded", {
            consecutive_unreadable: consecutiveUnreadable,
            degraded_limit: unreadableDegradedLimit,
            note: "usage unreadable beyond the bounded allowance — stopping, not dispatching",
          });
          return summary(
            "headroom_degraded",
            `usage unreadable ${consecutiveUnreadable}x consecutively (limit ${unreadableDegradedLimit})`,
          );
        }
        log("drain.headroom.unavailable", {
          consecutive_unreadable: consecutiveUnreadable,
          degraded_limit: unreadableDegradedLimit,
          note: "usage unreadable — bounded degraded-mode allowance, still dispatching",
        });
      } else {
        // GOVERNOR DISABLED — see the single-lane loop's identical branch.
        consecutiveUnreadable = 0;
      }
    }

    // DAILY COST CEILING (W1-T317) — see the single-lane loop's identical branch above.
    const costGoverned = deps.checkCostGovernor?.();
    if (costGoverned) {
      log("drain.cost_governor", {
        observed_day_cost_usd: costGoverned.observedDayCostUsd,
        daily_cost_ceiling_usd: costGoverned.ceilingUsd,
      });
      return summary(
        "cost_governor_deferred",
        `$${costGoverned.observedDayCostUsd.toFixed(2)} spent today at/over the $${costGoverned.ceilingUsd.toFixed(2)} daily ceiling — new dispatch deferred`,
      );
    }

    // QUEUE GOVERNOR / WIP CEILING (W1-T321) — see the single-lane loop's identical branch above.
    // Distinct from `openPrCount`/`laneDispatchBudget` just below, which only SIZES this still-open
    // lanes pass — this governor STOPS the pass outright.
    const queueGoverned = deps.checkQueueGovernor?.();
    if (queueGoverned) {
      log("drain.queue_governor", {
        observed_open_count: queueGoverned.observedOpenCount,
        wip_limit: queueGoverned.wipLimit,
      });
      return summary(
        "queue_governor_deferred",
        `${queueGoverned.observedOpenCount} open PRs at/over the ${queueGoverned.wipLimit} WIP limit — new dispatch deferred`,
      );
    }

    const openCount = deps.openPrCount?.();
    const budget = laneDispatchBudget({ laneCount, wipLimit: opts.wipLimit, openPrCount: openCount });
    const passSize = Math.min(budget, max - attempted.length);
    if (passSize <= 0) {
      log("dispatch.wip_deferred", {
        lane_count: laneCount,
        wip_limit: opts.wipLimit ?? null,
        observed_open_count: openCount ?? null,
      });
      return summary(
        "wip_deferred",
        `governor at ${openCount ?? "?"}/${opts.wipLimit ?? "?"} open PRs — no lane headroom this pass`,
      );
    }

    const skipOpts: NextRunnableOpts = {
      isOpenPr: deps.isOpenPr,
      onSkip: (t, prNumber) => log("dispatch.skipped", { task: t.id, reason: "open-pr", pr_number: prNumber }),
      readLiveState: deps.readLiveState
        ? (taskId, prNumber) => {
            const state = deps.readLiveState!(taskId, prNumber);
            if (state === undefined) log("dispatch.live_state_indeterminate", { task: taskId, pr_number: prNumber });
            return state;
          }
        : undefined,
      onStoodDown: (t, prNumber, state) =>
        log("dispatch.stood_down", { task: t.id, pr_number: prNumber, state, reason: "cached in-flight read was stale" }),
      isIndeterminate: deps.isIndeterminate,
      onIndeterminate: (t) => {
        log("dispatch.indeterminate", { task: t.id });
        deps.onIndeterminate?.(t);
      },
      isCircuitTripped: deps.isCircuitTripped,
      onCircuitBreak: (t) => {
        log("dispatch.circuit_broken", { task: t.id });
        if (!circuitEscalated.has(t.id)) {
          circuitEscalated.add(t.id);
          deps.onCircuitBreak?.(t);
        }
      },
      isLifetimeCapExceeded: deps.isLifetimeCapExceeded,
      onLifetimeCapExceeded: (t) => {
        log("dispatch.lifetime_capped", { task: t.id });
        if (!lifetimeCapEscalated.has(t.id)) {
          lifetimeCapEscalated.add(t.id);
          deps.onLifetimeCapExceeded?.(t);
        }
      },
      // PARITY WITH THE SINGLE-LANE LOOP: a task this drain already continued past is never
      // re-offered on a later pass. Wiring this into one loop and not the other is exactly the
      // single-lane/multi-lane drift this module warns about.
      excludeIds: continuedIds,
    };

    const candidates = runnableCandidates(plan, isMerged, passSize, skipOpts);
    if (candidates.length === 0) return summary("no_runnable");

    // PRE-DISPATCH OVERLAP CHECK (W1-T171), ACROSS the co-dispatched set: a
    // deferred task is simply absent from THIS pass — it is re-considered
    // next tick, by which point the task it collided with is either merged
    // or (far more commonly) has an OPEN PR of its own, so the in-flight
    // guard above excludes it from candidates entirely and the collision
    // never recurs. Self-resolving; no bookkeeping needed here.
    const partition = partitionByFileOverlap(candidates);
    for (const d of partition.serialized) log("dispatch.serialized", serializedLedgerPayload(d));
    const dispatchSet = partition.dispatch;
    if (dispatchSet.length === 0) return summary("no_runnable");

    log("dispatch.concurrent_set", { tasks: dispatchSet.map((t) => t.id), lane_count: laneCount });

    // W1-T342's PER-DISPATCH GOVERNOR GATE, APPLIED PER LANE (the half that fix did not reach).
    //
    // The pass-level `checkCostGovernor`/`checkQueueGovernor` reads far above STOP the whole pass.
    // They are not the same thing as this: one reading taken before any lane was admitted stood in
    // for EVERY lane in the batch, so a ceiling that trips between lane 1 and lane 2 admitted lane 2
    // anyway. `checkDispatchGovernors`' own doc names this exact call site: "W1-T343's loop must call
    // THIS function again per lane it admits, never hoist a single call above the loop."
    //
    // WHERE THE CHECK SITS, AND WHY IT IS HERE RATHER THAN INSIDE THE `.map`. A check inside
    // `dispatchSet.map(...)` would LOOK per-lane and not be: `.map`'s callback runs SYNCHRONOUSLY
    // for every element, so all N readings would be taken in the same tick of the event loop, before
    // any lane has done any work — one reading wearing N hats. Admission therefore happens in this
    // SEQUENTIAL loop, each iteration taking its own fresh reading, and only the admitted subset is
    // handed to `allSettled`.
    //
    // WHAT THAT DOES AND DOES NOT BUY, stated rather than overclaimed: because lanes run
    // concurrently, lane 1's own spend is still un-ledgered when lane 2 is admitted, so this does
    // NOT let lane 2 see lane 1's cost. What it does catch is a ceiling crossed by ANY OTHER writer
    // between readings (a previous batch's late-ledgered cost, the sweep, a second process) and an
    // observation that becomes UNREADABLE for a later lane — both of which the single reading
    // silently admitted through. That is the same value W1-T342 bought in runDaemon.
    //
    // A MID-PASS REFUSAL MUST NOT ABORT THE PASS. `break` stops ADMITTING; it never touches lanes
    // already admitted, and the pass proceeds to dispatch them and record every outcome exactly as
    // before. Refusing lane 2 is a deferral of lane 2, not a failure of lane 1.
    const admitted: Task[] = [];
    for (const t of dispatchSet) {
      const verdict = checkDispatchGovernors(deps, undefined);
      if (verdict) {
        // A DISTINCT step from the pass-level `drain.cost_governor`/`drain.queue_governor` above,
        // deliberately: "the pass never started" and "lane 3 of 4 was refused after 2 were admitted"
        // are different events, and collapsing them would make a partial batch unreadable.
        log("dispatch.lane_governed", {
          task: t.id,
          admitted: admitted.length,
          of: dispatchSet.length,
          lane_count: laneCount,
          ...governorDeferPayload(verdict),
        });
        break;
      }
      admitted.push(t);
    }
    // Every lane refused ⇒ nothing dispatches, and the pass says so rather than reporting
    // "no_runnable" (there WERE runnable tasks; a governor deferred them).
    if (admitted.length === 0) return summary("cost_governor_deferred", "every lane deferred by a governor re-checked at dispatch");

    for (const t of admitted) {
      attempted.push(t.id);
      log("drain.iteration", { task: t.id, attempted: attempted.length, max, lane: true });
    }

    // CONCURRENT LANES: `allSettled`, never `all` — see this function's own
    // doc. Every sibling's outcome is recorded below BEFORE the pass decides
    // whether to stop.
    const settled = await Promise.allSettled(admitted.map((t) => deps.runOne(t.id)));
    // THE SETTLED COUNTERPART to `dispatch.concurrent_set` above, emitted HERE and not after the
    // classification loop below: that loop ends in `if (failure) return` / `if (blocked) return`, so
    // a row written after it would be skipped in exactly the cases it exists to report. `allSettled`
    // never rejects, so this line is reachable whenever dispatch happened. See `settledSetPayload`.
    log("dispatch.settled_set", settledSetPayload(admitted, settled, laneCount));

    let blocked: { taskId: string; result: RunResult } | undefined;
    let failure: { taskId: string; message: string } | undefined;
    for (let i = 0; i < admitted.length; i++) {
      const t = admitted[i];
      const outcome = settled[i];
      if (outcome.status === "rejected") {
        const message = String((outcome.reason as Error)?.message ?? outcome.reason);
        log("drain.lane_error", { task: t.id, message });
        if (!failure) failure = { taskId: t.id, message }; // first-observed wins the summary detail
        continue;
      }
      const result = outcome.value;
      costUsd += result.costUsd;
      if (haltsDrain(result)) {
        // STOP-ON-BLOCK, at pass granularity — LANE-LOCAL: this task took its
        // normal blocked path; it never touched a sibling still in flight.
        log("drain.blocked", { task: t.id, verdict: result.verdict, pr_url: result.prUrl });
        if (!blocked) blocked = { taskId: t.id, result };
        continue;
      }
      if (!result.merged) {
        // CONTINUED, NOT CREDITED — the same rule the single-lane loop applies, through the SAME
        // predicate, so the two paths can never disagree about what halts.
        continued.push({ taskId: t.id, verdict: result.verdict, prUrl: result.prUrl });
        continuedIds.add(t.id);
        log("drain.continued", { task: t.id, verdict: result.verdict, pr_url: result.prUrl });
        continue;
      }
      merged.push(t.id);
    }

    if (failure) return summary("error", `${failure.taskId}: ${failure.message}`);
    if (blocked) {
      const r = blocked.result;
      return summary("blocked", `${blocked.taskId} → ${r.verdict}${r.prUrl ? ` (${r.prUrl})` : ""}`);
    }
    if (opts.until && merged.includes(opts.until)) return summary("until_reached", opts.until);
  }
  return summary("max_reached", `${max} task(s)`);
}
