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
import {
  NO_OBSERVED_SCOPE,
  partitionByFileOverlap,
  serializedLedgerPayload,
  settledSetPayload,
  type ObservedScopeByTask,
} from "./dispatch-overlap.js";
import { taskIdFromRunBranch } from "./status.js";
import type { OpenSiblingBuild, StatusProjection } from "./status.js";

/** A merged predicate — DERIVED FROM GITHUB in the real runner (status.ts). */
export type MergedSet = (taskId: string) => boolean;

/**
 * W1-T2675 — WHICH of the two credit paths (status.ts's `findMergedByHeadBranch` union: a
 * `Remudero-Task:` trailer, a `run-<taskId>-<epochMs>` head ref, or both) actually credited an
 * already-merged task. `"head-ref"` is named explicitly — and must be, on its own, sufficient to
 * report — because a merge can carry ZERO trailers and still be credited purely by branch name
 * (#1657, cited in this task's own filing); collapsing that case into a generic "credited" would
 * hide the exact evidence an operator most needs when the trailer is the thing missing.
 */
export type CreditPath = "trailer" | "head-ref" | "both";

/** The evidence behind an `"already-merged"` refusal: which path matched, and the PR it rode in
 *  on — the two facts {@link NextRunnableOpts.creditFor} reports so an operator sees "already
 *  shipped as #N (head-ref)" rather than a bare refusal with no PR to go look at. */
export interface AlreadyMergedCredit {
  path: CreditPath;
  prNumber: number;
}

/**
 * Converts the SAME status projection that feeds `isMerged` into the operator-facing detail
 * carried by {@link NextRunnableOpts.creditFor}. The projection's `merged` boolean remains the
 * gate; this helper only names the matched path once that gate has already refused dispatch.
 */
export function alreadyMergedCreditFromProjection(
  projection: Partial<Pick<StatusProjection, "merged" | "source" | "prNumber">> | undefined,
): AlreadyMergedCredit | undefined {
  if (projection === undefined) return undefined;
  if (projection.merged !== true || typeof projection.prNumber !== "number") return undefined;
  if (projection.source === "trailer") return { path: "trailer", prNumber: projection.prNumber };
  if (projection.source === "head-branch") return { path: "head-ref", prNumber: projection.prNumber };
  return undefined;
}

/**
 * Resolves the OPEN PR number for a task's most-recently-derived PR — undefined
 * when that PR is merged, closed, or there is none. Backs the in-flight
 * dispatch-dedup guard (W1-T80, the #143/#145 duplicate-build race): DERIVED
 * FROM GITHUB (status.ts's `deriveStatus` projection) in the real runner, never
 * a second read path.
 */
export type OpenPrCheck = (taskId: string) => number | undefined;

/**
 * W1-T534 (design (i) — ONE SWEEP PER PASS, NEVER ONE CALL PER CANDIDATE): the set of task ids
 * with a `run-<id>-<epochMs>` branch currently pushed to origin, parsed from the raw multi-line
 * output of a SINGLE `git ls-remote --heads origin 'run-*'` call — measured at 199 ms for 46 refs
 * and IDENTICAL `core` remaining before/after, so `ls-remote` speaks the git protocol and spends
 * neither the REST nor the GraphQL budget, against one round trip per candidate if probed
 * individually. Each line is `<sha>\trefs/heads/<branch>`; a bare `refs/heads/<branch>` or
 * `<branch>` line is also accepted, so a caller can feed either raw `ls-remote` output or a plain
 * ref-name list. Reuses `taskIdFromRunBranch` (status.ts) — the ONE named extractor this repo
 * already tests for the `run-<taskId>-<epochMs>` shape — rather than a second regex, so the
 * anchoring (design (iii): a shorter id can never satisfy a longer branch's ordinal, because the
 * extractor's own greedy match always consumes every digit of the ordinal before the trailing
 * `-<epochMs>`) is proven once and shared, never re-derived here. A line that doesn't parse is
 * skipped, never thrown — a malformed ref degrades to "not observed", never a crashed pass.
 */
export function runBranchTaskIds(lsRemoteOutput: string): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const rawLine of lsRemoteOutput.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const ref = line.includes("\t") ? line.split("\t")[1] : line;
    const branch = ref.replace(/^refs\/heads\//, "");
    const id = taskIdFromRunBranch(branch);
    if (id !== undefined) ids.add(id);
  }
  return ids;
}

/**
 * W1-T1207 (design (i)+(iii)): task ids whose `run-<id>-<epochMs>` branch belongs to a pull
 * request that is CLOSED AND UNMERGED — parsed from a batched, paginated `pulls?state=closed`
 * sweep (the SAME shape `rmd reap-branches` already reads; see run-task.ts's
 * `readRunBranchClosedPrsOutput`), never one lookup per branch — matching `runBranchTaskIds`'s
 * own ls-remote cost argument ("a single sweep, never one round trip per candidate").
 *
 * WHY ONLY THIS ONE STATE. A MERGED pull request's head branch is deleted by GitHub, so it can
 * never appear on the `ls-remote` sweep {@link runBranchTaskIds} parses in the first place — the
 * predicate self-clears and needs no rule here (design (i)). An OPEN or DRAFT pull request still
 * means the work is in flight, so its branch must keep blocking — this function names only the
 * ids whose PR closed WITHOUT merging, the one state that must stop blocking.
 *
 * Rows are `<head-ref>\t<unmerged>`, `unmerged` being the literal string `"true"` when
 * `merged_at` was `null` on that row (i.e. the PR closed without merging) and `"false"` when it
 * was set (a merged row — included because a `state=closed` page mixes both, but skipped here
 * since a merged head can never be a still-pushed branch anyway). A line that doesn't parse, or
 * whose second column isn't exactly `"true"`, is skipped rather than thrown — the same
 * degrade-not-crash discipline {@link runBranchTaskIds} already applies to a malformed ref.
 */
export function closedUnmergedRunBranchTaskIds(closedPrRows: string): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const rawLine of closedPrRows.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const [ref, unmerged] = line.split("\t");
    if (!ref || unmerged !== "true") continue;
    const id = taskIdFromRunBranch(ref);
    if (id !== undefined) ids.add(id);
  }
  return ids;
}

/** Optional in-flight-skip controls for {@link nextRunnable} (W1-T80). */
export interface NextRunnableOpts {
  /** Returns the open PR number for a task whose latest PR is currently OPEN. */
  isOpenPr?: OpenPrCheck;

  /**
   * W1-T2675 — CREDIT READ FAILED, WHICH IS NOT THE SAME AS "NOT MERGED". `deriveStatus`
   * (lib/status.ts) returns `{ merged: false, source: "throttled", indeterminate: true }` when the
   * GitHub credit read genuinely FAILED rather than resolving to a clean "no evidence", and
   * {@link StatusProjection.indeterminate}'s own doc states the obligation this probe discharges:
   * "a caller that gates dispatch or a ledger write off this projection MUST treat `indeterminate`
   * as DO NOT ACT, never as an ordinary queued task, because the evidence a 'not merged' conclusion
   * would rest on was never actually consulted."
   *
   * WITHOUT IT THE ADAPTER FAILS OPEN. Every {@link MergedSet} in the repo is spelled
   * `projection.get(id)?.merged ?? false`, which collapses `indeterminate` into a confident
   * `false` — so a task that really shipped is admitted, a worker spawns, and the rebuild cannot
   * pass review because the shard's criteria describe a diff already on main. That is the #3512
   * lifecycle W1-T2675 measured; the pre-existing `isMerged(t.id)` refusal at the top of
   * {@link isDispatchEligible} was never the missing piece and is unchanged.
   *
   * OMITTED ⇒ TODAY'S BEHAVIOUR, EXACTLY — the same convention every other probe on this interface
   * follows. A caller that cannot supply it holds no indeterminate evidence to act on, so there is
   * nothing to fail closed on; it is never a silently widened refusal.
   */
  isCreditIndeterminate?: (taskId: string) => boolean;

  /**
   * W1-T2397 — THE OPEN-SIBLING OBSERVATION, READ OFF THE PROJECTION THIS PASS ALREADY BUILT.
   *
   * Answers, for the task about to be dispatched: is there an OPEN PR building it that is NOT its
   * own `run-<taskId>-<digits>` branch? `StatusProjection.openSiblingBuild` (status.ts) is where
   * it comes from, so this costs no read of its own.
   *
   * IT IS NOT `isOpenPr` AND MUST NEVER BECOME IT. `isOpenPr` decides eligibility; widening THAT
   * is the refusal W1-T2397 declined on measurement — the naive predicate fired four times in 72
   * hours and three of those merged. This one is consulted AFTER a task has already been chosen,
   * feeds {@link onOpenSiblingBuild} alone, and cannot change what is dispatched.
   */
  openSiblingBuildFor?: (taskId: string) => OpenSiblingBuild | undefined;
  /**
   * W1-T2397: called ONCE, for the task actually being dispatched, when {@link
   * openSiblingBuildFor} reports an open sibling build. The real wiring writes one ledger row and
   * prints one console line naming BOTH PRs; this module never decides anything on it. Omitted ⇒
   * the observation is not made and dispatch is byte-identical to before this existed.
   */
  onOpenSiblingBuild?: (task: Task, sibling: OpenSiblingBuild) => void;
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
   * WHAT THE BREAKER SAW for a task, supplied by the SAME memoised evaluation the
   * `isCircuitTripped`/`isIndeterminate` predicates answered from (run-task.ts's
   * `breakerGateFor().detailFor`) — never a second call to the predicate. Spread onto the
   * `dispatch.circuit_broken` / `dispatch.indeterminate` rows so a refusal records the count,
   * the bound and WHICH of the three outcomes was reached, instead of only that it fired.
   * Optional: a caller that omits it logs exactly the bare rows it logged before.
   */
  breakerDetail?: (taskId: string) => Record<string, unknown> | undefined;
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
   * W1-T951 DELIVERABLE B: true when this ALREADY-MERGED task's durable credit
   * (status.ts's `isSinglePathCredited`, over its `CreditStore`) rests on
   * EXACTLY ONE of the two credit paths — a `Remudero-Task:` trailer XOR a
   * `run-<taskId>-*` head branch, never both. Consulted ONLY on the
   * `"already-merged"` decline (a task {@link MergedSet} already refused to offer for
   * dispatch), so it can never itself change eligibility — this is observation, the
   * same discipline every other optional probe on this interface follows. Optional:
   * omitted, nothing is observed and dispatch behaves exactly as before this existed.
   */
  isSinglePathCredit?: (taskId: string) => boolean;
  /**
   * Called ALONGSIDE (never instead of) `onFiltered(task, "already-merged")` when
   * `isSinglePathCredit` says so — the DISCOVERABLE SIGNAL design (iii) requires:
   * a task credited by exactly one path is indistinguishable from one credited by
   * both until the single path disappears (rationale (2)/(4) — GitHub deletes the
   * head ref on merge), so a caller watching the dispatch loop (a daemon log line,
   * an idle-reason tally) gets a chance to notice the fragile population BEFORE it
   * silently re-exposes a shipped task as dispatchable `verify: auto` work.
   */
  onSinglePathCredit?: (task: Task) => void;
  /**
   * W1-T2675 (criteria 2 and 3 of this task's own filing): resolves the {@link AlreadyMergedCredit}
   * — WHICH credit path matched and the PR that carried it — for a task {@link MergedSet} already
   * refused. Consulted ONLY on the `"already-merged"` decline, exactly where `isSinglePathCredit`
   * above is consulted, and for the identical reason: this can never itself change eligibility,
   * `isMerged(t.id)` alone already decided that. Returns `undefined` when the caller holds no such
   * detail (a bare boolean `MergedSet` carries none) — the refusal still fires, unnamed, byte-
   * identical to before this probe existed. NEITHER THIS PROBE NOR ITS CALLBACK EVER READS
   * `t.status` OR `t.retirement` — the credit union this reports comes entirely from the caller's
   * own GitHub-derived projection (status.ts), never from the hand-authored plan shard; see
   * {@link isDispatchEligible}'s `already-merged` arm, which checks `isMerged(t.id)` before this is
   * even reached and never touches the task's `status` field on this branch, matching CLAUDE.md's
   * rule that a shard's `status:` is not a completion signal and nothing here treats it as one.
   */
  creditFor?: (taskId: string) => AlreadyMergedCredit | undefined;
  /**
   * Called ALONGSIDE (never instead of) `onFiltered(task, "already-merged")` when {@link
   * creditFor} resolves a credit — mirrors `onSinglePathCredit`'s "called alongside" discipline —
   * so a caller watching the dispatch loop can print "already shipped as #N (head-ref)" instead of
   * a bare refusal with no PR to go look at (this task's own rationale: the operator should see
   * WHICH credit path matched and WHICH PR carried it, not just that a refusal fired).
   */
  onAlreadyMergedCredit?: (task: Task, credit: AlreadyMergedCredit) => void;
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
   * W1-T2286: each candidate's OBSERVED file scope (W1-T2237's `ObservedScopeByTask`), consulted
   * ONLY by {@link runnableCandidates}' packing (`packDisjointFirst`/`isDisjointFromEvery`) — the
   * SAME map handed to `partitionByFileOverlap`'s own downstream call in `runDrainLanes`/
   * `runDaemon`, so the pack's disjointness pre-check and the real partition agree on one
   * effective scope rather than picking a candidate the partition then serializes away. Omitted
   * ⇒ every candidate is scored on its bare declaration, byte-identical to before this field
   * existed — see {@link ObservedScopeByTask}'s own doc for why no production caller supplies one
   * yet.
   */
  observedByTask?: ObservedScopeByTask;
  /**
   * Called once per task whose CACHED in-flight snapshot this live re-check
   * overturned — one PR-level observation, fired for EVERY freshly-observed
   * terminal state regardless of what the task's eligibility ultimately
   * resolves to (W1-T1035: a MERGED read that also credits the task, via
   * `isLiveMergeCredited` below, still fires this — see that field's own doc
   * for why the two callbacks are BOTH needed rather than one replacing the
   * other). Mirrors `onSkip`'s legibility contract; the real wiring corrects
   * the ledgered reason from "open-pr" to the freshly observed terminal state.
   */
  onStoodDown?: (task: Task, prNumber: number, state: string) => void;
  /**
   * W1-T1035 (STOOD-DOWN-MERGED-TASK-STILL-ADMITTED). `isMerged(t.id)`, consulted at the TOP of
   * `isDispatchEligible`, is the CREDIT PROJECTION for this whole pass — built ONCE by
   * `refreshMerged()` before the per-candidate walk below it even starts, so by the time this
   * in-flight guard takes its OWN fresh read (`readLiveState`, per candidate) that projection can
   * already be behind it. A fresh MERGED here is therefore ambiguous on its own, and this is the
   * ONE PLACE the chain has fresher information than `isMerged(t.id)` and, before this task, did
   * nothing with it (measured: 24 of 32 `dispatch.stood_down MERGED` rows in the corpus later
   * produced `dispatch.refused_already_merged` for the SAME task — the daemon admitted it, spawned
   * a worker, and the worker refused because the credit projection had simply caught up).
   *
   * TWO SUB-CASES, TOLD APART HERE ONLY WHEN THIS IS SUPPLIED:
   *   - THE STALE-CREDIT CASE — `true`: this exact merge (`prNumber`) DOES credit `taskId` per the
   *     SAME credit rule `isMerged` applies, re-checked fresh rather than read from the pass-start
   *     snapshot. Admitting now would just re-invite `dispatch.refused_already_merged`; the guard
   *     excludes the task instead (see the call site).
   *   - THE W1-T177 CASE — `false` (or this probe omitted entirely): the merge does NOT credit
   *     `taskId` — a PR can merge without crediting the task that opened it, and that task
   *     genuinely still needs a run (`test/drain.test.ts`'s three W1-T177 assertions, which must
   *     keep passing untouched). The task stays admitted, exactly as before this field existed.
   *
   * Consulted ONLY when `readLiveState` has just answered `"MERGED"` for this candidate's open PR
   * — never for `"OPEN"` (still in-flight, already handled) or `"CLOSED"` (abandoned, never
   * credits anyone, always stays admitted). Omitted ⇒ `isDispatchEligible` behaves EXACTLY as
   * before this discrimination existed — the unconditional W1-T177 fall-through.
   */
  isLiveMergeCredited?: (taskId: string, prNumber: number) => boolean;
  /**
   * Called once per task EXCLUDED because `isLiveMergeCredited` confirmed the fresh MERGED read
   * credits it (the stale-credit case above) — fired ALONGSIDE `onStoodDown` (never instead of
   * it), mirroring `onSinglePathCredit`'s "called alongside" contract: the same PR-level
   * observation, plus the ADDITIONAL fact that it just changed this candidate's eligibility. The
   * real wiring ledgers this under its own step so an operator can tell "stood down, still
   * runnable" apart from "stood down, now excluded" instead of reading both off one row.
   */
  onStaleCreditExcluded?: (task: Task, prNumber: number, state: string) => void;
  /**
   * W1-T534: true when a `run-<taskId>-<epochMs>` branch already exists on origin — AUGMENTS
   * `isOpenPr`, never replaces it (design (ii)): `isOpenPr` reads a CACHED projection
   * (`run-task.ts`'s `lastProj`, re-derived once per drain TICK), so a PR opened — or a branch
   * merely PUSHED, ahead of its PR — after that snapshot was taken is invisible to it, and
   * `isOpenPr` returns `undefined` even though the same id is already in flight. This probe
   * closes exactly that blind spot: it is consulted regardless of what `isOpenPr` answered,
   * because the two checks cover disjoint windows rather than one superseding the other. Build
   * the closure from ONE {@link runBranchTaskIds} sweep per PASS — never one `ls-remote` per
   * candidate, which is the whole cost argument — e.g. `(id) => sweep.has(id)`. Omitted ⇒
   * behaves EXACTLY as before this check existed.
   *
   * W1-T1207: THIS PROBE HAS NO UPPER BOUND OF ITS OWN, AND MUST NOT GAIN ONE HERE — the fix is
   * to read the pull request's state, never to guess when a branch stopped mattering (design
   * (v)). A branch's PR being OPEN or DRAFT, or there being no PR at all, both keep this true,
   * exactly as before; a branch is a leftover, not a signal, ONLY once its PR is CLOSED AND
   * UNMERGED (design (i)) — GitHub does not delete the head on close, only on merge, so a
   * closed-unmerged PR would otherwise leave this predicate answering `true` forever for a task
   * nothing is working on. The caller is expected to build this closure as `sweep.has(id) &&
   * !closedUnmerged.has(id)`, subtracting {@link closedUnmergedRunBranchTaskIds}'s own once-
   * per-pass sweep — never a second predicate threaded separately through this chain, so the
   * "one sweep, never one call per candidate" cost argument above holds for the subtraction too.
   */
  hasPushedRunBranch?: (taskId: string) => boolean;
  /**
   * Called once per task excluded because its run branch already exists on origin (W1-T534) —
   * the SAME kind of event `onSkip` already logs (design (v): "REUSE THE ROW THAT ALREADY
   * EXISTS"), just for the window `isOpenPr` cannot see, so the real wiring rides the same
   * `dispatch.skipped` row with a distinct reason string rather than minting a new one. No PR
   * number is available in this window — that IS the defect this closes: the branch predates or
   * outpaces the cached PR snapshot — so this callback is PR-number-free where `onSkip` is not.
   * The refusal is a SKIP, never a terminal state (design (iv)): the task is not marked done,
   * burns no strike, and is offered again on a later pass once the branch is gone.
   *
   * W1-T1205: fired ALONGSIDE (never instead of) `opts.onFiltered?.(t, "run-branch-already-
   * pushed")` — this callback feeds the ledger row, `onFiltered` feeds any reader of the neutral
   * {@link DispatchFilterReason} tally (status-board.ts's `deriveQueueHead`, W1-T1205's own
   * caller). Before W1-T1205 this exclusion reached ONLY this ledger row, invisible to every
   * other surface; the tally entry is what makes it nameable there too.
   */
  onSkipRunBranch?: (task: Task) => void;
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
 * it is a real loss, and an explicit `priority:` field is now the honest successor (W1-T422): the
 * comparator below reads it FIRST, before id, so the operator has a real instrument to front a task
 * again — one that, unlike file placement, exists on every task and needs no migration.
 *
 * DETERMINISM IS ABSOLUTE. The comparator reads only `priority` and `id`, both committed content. It
 * never consults file order, mtime, or enumeration order. Absent `priority` sorts after every task
 * that carries one (`?? +Infinity`), so a plan with no priorities set is byte-identical in order to
 * before this field existed. The numeric-then-lexicographic id tiebreak makes it a TOTAL order, so
 * two runs over the same plan always select the same task.
 */
export function dispatchOrder(tasks: readonly Task[]): Task[] {
  return [...tasks].sort(compareDispatch);
}

/**
 * Total order: `priority` ascending FIRST (absent ⇒ `+Infinity`, so it sorts last); then
 * `undeclaredScopeLast` (W1-T476) — a task whose `files:` is empty or absent sorts AFTER every
 * task that declares one; then the workstream-aware id order (see {@link idOrdinal}) as the
 * deterministic tiebreak — among prioritized tasks, among declared-scope tasks, and among
 * un-prioritized/undeclared ones alike.
 */
export function compareDispatch(a: Task, b: Task): number {
  const pa = a.priority ?? Number.POSITIVE_INFINITY;
  const pb = b.priority ?? Number.POSITIVE_INFINITY;
  if (pa !== pb) return pa - pb;
  const ua = undeclaredScopeLast(a);
  const ub = undeclaredScopeLast(b);
  if (ua !== ub) return ua - ub;
  const na = idOrdinal(a.id);
  const nb = idOrdinal(b.id);
  if (na.workstream !== nb.workstream) return na.workstream - nb.workstream;
  if (na.ordinal !== nb.ordinal) return na.ordinal - nb.ordinal;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * W1-T476: 1 when `t.files` is absent or empty, 0 otherwise — an UNDECLARED-SCOPE task sorts
 * LAST among its priority tier instead of by the accident of its id. This does NOT change
 * `overlappingPaths`' fail-closed treatment of that same task (it still serializes against
 * every co-dispatched candidate once it IS offered — see dispatch-overlap.ts); what changes is
 * only that it can no longer do so from the QUEUE HEAD, where a single such task starved every
 * lane behind it (MEASURED: 1 lane admitted where 11 disjoint tasks were eligible). The name is
 * load-bearing — grepped by this task's own acceptance criterion.
 */
function undeclaredScopeLast(t: Task): number {
  return t.files === undefined || t.files.length === 0 ? 1 : 0;
}

/**
 * Workstream-aware id ordinal: `W<workstream>-T<ordinal>` parses into its two numeric parts,
 * compared workstream-first then task-ordinal — so `W2-T1` no longer outranks `W1-T400` by the
 * accident of a regex over the id's trailing digits (the PRIOR implementation here took the
 * LAST integer run in the id — despite a doc comment that, wrongly, called it "the first integer
 * run" — which is exactly the accident: `W2-T1`'s only integer run is `1`, so it ranked ordinal 1,
 * ahead of the entire W1 backlog). Ids that don't match `W<n>-T<m>` (no workstream prefix) sort
 * after every id that does, then lexicographically via `compareDispatch`'s own final tiebreak.
 */
function idOrdinal(id: string): { workstream: number; ordinal: number } {
  const m = /^W(\d+)-T(\d+)/.exec(id);
  if (!m) return { workstream: Number.MAX_SAFE_INTEGER, ordinal: Number.MAX_SAFE_INTEGER };
  return { workstream: Number(m[1]), ordinal: Number(m[2]) };
}

/**
 * W1-T2397 — the observation, fired for a task THIS PASS HAS ALREADY CHOSEN.
 *
 * ONE EMITTER FOR BOTH SELECTORS. `nextRunnable` (the drain's single-lane pick) and
 * {@link runnableCandidates} (the DAEMON's batch pick) are different loops, and the daemon uses
 * ONLY the second — so an observation living in `nextRunnable` alone never reaches the lane that
 * carries the dispatches (`daemon.boot` 347 / `run.start` 558 against `drain.start` 16, measured
 * over the container's ledger union). Sharing this one function is what stops them drifting.
 *
 * A THROW IS STILL ONLY AN OBSERVATION: W1-T2397's whole argument is that a wrong warn costs one
 * line, and a warn that cost a dispatch would invert it.
 */
function observeOpenSibling(t: Task, opts: NextRunnableOpts): void {
  const sibling = opts.openSiblingBuildFor?.(t.id);
  if (!sibling || !opts.onOpenSiblingBuild) return;
  try {
    opts.onOpenSiblingBuild(t, sibling);
  } catch {
    /* an observation that throws is still only an observation */
  }
}

export function nextRunnable(plan: Plan, isMerged: MergedSet, opts: NextRunnableOpts = {}): Task | undefined {
  for (const t of dispatchOrder(plan.tasks)) {
    if (!isDispatchEligible(plan, t, isMerged, opts)) continue;
    // W1-T2397: OBSERVE, THEN DISPATCH ANYWAY. Deliberately placed AFTER eligibility has already
    // said yes and BEFORE the task is returned unchanged — so it runs once per dispatch (not once
    // per candidate, which is what keeps it quiet: 101 of 105 dispatches in 72 hours had no open
    // sibling at all), and so it is structurally incapable of changing the answer. A throw here
    // must not cost a dispatch either: the observation is worth one line, never a stalled task.
    observeOpenSibling(t, opts);
    return t;
  }
  return undefined;
}

/**
 * Why the eligibility filter declined a task. FIVE of these are the conditions that used to
 * return silently — every OTHER filter (indeterminate, circuit, lifetime cap, open PR) already
 * ledgers itself through its own dedicated `onXxx` callback. `"run-branch-already-pushed"`
 * (W1-T1205) is the exception that proves that split deliberate rather than accidental: it is
 * ALSO ledgered through its own callback (`onSkipRunBranch`, mirroring `onSkip`'s in-flight
 * legibility), but design (iii) of W1-T1205 puts it here too — unlike an open PR or a tripped
 * breaker, nothing is IN FLIGHT and nothing clears it on its own, so a caller reading only this
 * tally (queue-head's own consumer, `deriveQueueHead`) must still be able to name it, never see
 * a task vanish with no reason recorded anywhere this union is consulted. Order matters and is
 * the filter's own: see {@link tallyDispatchFilters} on first-match.
 *
 * `"retired"` (W1-T2474) is `"blocked"`'s own split, not a new gate: `status: "blocked"` still
 * refuses every task it always refused, byte-identical, but a `blocked` task ALSO carrying a
 * `retirement` ruling (plan.ts's `RETIREMENT_REASONS`, W1-T1287) is a deliberate record that will
 * never be built rather than a dependency-stalled one waiting to clear — the two populations a
 * human should read apart, per this task's own rationale. A `blocked` task with no `retirement`
 * files under `"blocked"`, unchanged.
 */
export type DispatchFilterReason =
  | "already-merged"
  | "verify-not-auto"
  | "blocked"
  | "retired"
  | "unmet-deps"
  | "continued-this-pass"
  // W1-T2675 — DISTINCT FROM "already-merged", AND THE DISTINCTION IS THE POINT. That reason means
  // the credit projection SAW a merge. This one means it could not look, a failed GitHub read
  // carrying indeterminate true, which is not evidence of absence. Folding the two would tell an
  // operator a task shipped when what actually happened is that the fleet went briefly blind.
  // NO SEMICOLON ABOVE, DELIBERATELY: two census tests read this union by slicing the declaration
  // at its FIRST semicolon, so one inside a comment here silently truncates the arm list they pin.
  | "credit-indeterminate"
  | "run-branch-already-pushed";

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
    retired: [],
    "unmet-deps": [],
    "continued-this-pass": [],
    "credit-indeterminate": [],
    "run-branch-already-pushed": [],
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
    // W1-T951 DELIVERABLE B: fires BEFORE `onFiltered`, same as every other paired
    // observation callback on this chain — never gates, only observes, so a caller
    // that omits `isSinglePathCredit` sees byte-identical behaviour to before this
    // existed.
    if (opts.isSinglePathCredit?.(t.id)) opts.onSinglePathCredit?.(t);
    // W1-T2675: NAME the credit — which path matched and the PR it rode in on — the SAME
    // "called alongside, never gating" discipline as the single-path observation just above.
    // `t.status` is never read here or by `opts.creditFor`: the decision was already made by
    // `isMerged(t.id)`, a GitHub-derived read, before this line runs.
    const credit = opts.creditFor?.(t.id);
    if (credit) opts.onAlreadyMergedCredit?.(t, credit);
    opts.onFiltered?.(t, "already-merged");
    return false;
  }
  // W1-T2675: THE CREDIT READ FAILED — refuse rather than guess. Placed immediately after the
  // `already-merged` arm because it answers the SAME question that arm just answered `false` to,
  // and the two must stay distinguishable: `already-merged` means the projection SAW a credit,
  // this means it could not look. Ahead of every other filter for the same reason `excludeIds` is
  // ahead of the probes below — a task that may already have shipped must not be spawned while a
  // cheaper filter is still deciding, and admitting it costs a full PR lifecycle to undo.
  if (opts.isCreditIndeterminate?.(t.id)) {
    opts.onFiltered?.(t, "credit-indeterminate");
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
    // W1-T2474: SPLIT AT THE FILTER, NOT AT THE CENSUS — a `blocked` task carrying a
    // `retirement` ruling (plan.ts's `RETIREMENT_REASONS`, W1-T1287) is a deliberate record
    // that will never be built, never a dependency-stalled task waiting to clear on its own.
    // Both still refuse the task identically (this `return false` is unchanged either way);
    // only the NAME reported to `onFiltered` differs, so a caller reading the tally can tell
    // the two populations apart instead of conflating them under one "blocked" bucket.
    opts.onFiltered?.(t, t.retirement !== undefined ? "retired" : "blocked");
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
      // W1-T1035: THE STALE-CREDIT DISCRIMINATION (design (iii)). `isMerged(t.id)` above is the
      // credit projection consulted at the TOP of this chain, already stale relative to this
      // fresh per-candidate read. A MERGED state alone cannot say whether this merge credits `t`
      // (the stale-credit case, which must be excluded) or not (the W1-T177 case, which must stay
      // admitted) — only `opts.isLiveMergeCredited` can tell them apart; see its own doc. Checked
      // ONLY for MERGED (a CLOSED PR credits nothing and always falls through, unchanged).
      if (liveState === "MERGED" && opts.isLiveMergeCredited?.(t.id, openPrNumber)) {
        opts.onStaleCreditExcluded?.(t, openPrNumber, liveState);
        // EXCLUDED, NOT ADMITTED: the live read's own merge already finishes this task, so
        // admitting it here would only re-invite `dispatch.refused_already_merged` downstream —
        // and, because this `return false` keeps it OUT of `eligible` entirely (never reaching
        // `packDisjointFirst`/`partitionByFileOverlap`), it also can never be handed out as
        // another candidate's `blocked_by` in this same pass (design (iv)).
        return false;
      }
    } else {
      opts.onSkip?.(t, openPrNumber);
      return false; // IN-FLIGHT (or unreadable — fail OPEN) — never a duplicate fresh build.
    }
  }
  // W1-T534: the STALE-ABSENT window `isOpenPr` structurally cannot see — a PR opened, or a
  // branch merely pushed ahead of its PR, after the cached projection was taken. Checked LAST,
  // after every probe above (including `isOpenPr`/`readLiveState`) has had its say: this is an
  // ADDITIONAL refusal input, never a replacement, so a task `isOpenPr` already confirmed
  // in-flight (or stood down) is decided by that richer check first.
  if (opts.hasPushedRunBranch?.(t.id)) {
    opts.onSkipRunBranch?.(t);
    // W1-T1205: ALSO the named DispatchFilterReason — `onSkipRunBranch` alone left this
    // exclusion reachable only through a `dispatch.skipped` ledger row, invisible to any reader
    // that consults `onFiltered`/the tally instead of grepping the ledger (status-board.ts's
    // `deriveQueueHead`, this task's own caller). Fired ALONGSIDE, never instead of,
    // `onSkipRunBranch` — same "called alongside" discipline `onSinglePathCredit`/
    // `onStaleCreditExcluded` already use elsewhere on this chain.
    opts.onFiltered?.(t, "run-branch-already-pushed");
    return false; // A run branch for this id is already on origin — never a duplicate fresh build.
  }
  return true;
}

/**
 * Up to `limit` runnable tasks, packed disjointness-first (W1-T476; see {@link
 * packDisjointFirst}) over dispatchOrder — the multi-candidate generalization of
 * {@link nextRunnable} for a concurrent dispatcher (P19 rung 1, W1-T171; wired by
 * the lane scheduler in W1-T172) to hand to `dispatch-overlap.ts`'s
 * `partitionByFileOverlap`. Applies the EXACT SAME eligibility chain as
 * `nextRunnable` (see {@link isDispatchEligible}) — a task ineligible for solo
 * dispatch is never offered as a concurrent candidate either. `limit <= 0` yields
 * an empty array. This function does not decide `files:` overlap ADMISSION —
 * that partition remains `dispatch-overlap.ts`'s job, kept separate so the
 * DAG/status eligibility logic here never duplicates the pure glob predicate
 * there — but it DOES now consult that same predicate to choose WHICH `limit`
 * candidates to offer, so a disjoint set doesn't get truncated away before
 * `partitionByFileOverlap` ever sees it.
 */
export function runnableCandidates(plan: Plan, isMerged: MergedSet, limit: number, opts: NextRunnableOpts = {}): Task[] {
  if (limit <= 0) return [];
  const eligible: Task[] = [];
  for (const t of dispatchOrder(plan.tasks)) {
    if (isDispatchEligible(plan, t, isMerged, opts)) eligible.push(t);
  }
  const collected = packDisjointFirst(eligible, limit, opts.observedByTask ?? NO_OBSERVED_SCOPE);
  // W1-T2397: OBSERVE, THEN DISPATCH ANYWAY — the SAME placement `nextRunnable` uses, one level
  // over. AFTER eligibility has said yes AND after the pack has chosen, so it fires once per task
  // actually dispatched rather than once per eligible candidate (which is what keeps it quiet: 101
  // of 105 dispatches in 72 hours had no open sibling at all), and BEFORE `collected` is returned
  // UNCHANGED — structurally incapable of altering which tasks this batch dispatches.
  //
  // THIS IS THE DAEMON'S SELECTOR. `runDaemon` calls `runnableCandidates`, never `nextRunnable`, so
  // the observation wired into the latter alone could not reach the lane that carries 97% of
  // dispatches — measured, and the reason this branch exists at all.
  for (const t of collected) observeOpenSibling(t, opts);
  return collected;
}

/**
 * W1-T476's greedy disjointness-first pack: fills up to `limit` slots from `eligible` (already in
 * dispatchOrder), on each slot preferring the EARLIEST remaining candidate that stays `files:`
 * -disjoint from every candidate already collected — checked via the real `partitionByFileOverlap`
 * (dispatch-overlap.ts), never a re-derived glob comparison — falling back to the next candidate
 * in dispatchOrder when none remain disjoint. This REPLACES the previous plain truncation (take
 * the first `limit` eligible tasks in dispatchOrder), which handed `partitionByFileOverlap`
 * downstream a head that could contain far fewer than `limit` pairwise-disjoint tasks even when a
 * disjoint set of size `limit` existed further back in the eligible list — MEASURED: at lanes
 * 2/3/4 the plain-truncation order admitted 1/1/1 where a disjoint set of that size existed.
 *
 * DETERMINISM: the scan for the next disjoint candidate always walks `remaining` in its current
 * (dispatchOrder-derived) order and takes the first match, so equal inputs yield equal outputs.
 *
 * STABILITY CONTAINMENT (the falsifier's second direction): when NO two candidates in `eligible`
 * are pairwise disjoint, every slot after the first falls back to "next in dispatchOrder" — so
 * the result is byte-identical to the old plain-truncation order. The pack never reorders what it
 * cannot improve.
 */
function packDisjointFirst(eligible: readonly Task[], limit: number, observedByTask: ObservedScopeByTask): Task[] {
  const collected: Task[] = [];
  const remaining = [...eligible];
  while (collected.length < limit && remaining.length > 0) {
    let pickIndex = remaining.findIndex((candidate) => isDisjointFromEvery(collected, candidate, observedByTask));
    if (pickIndex === -1) pickIndex = 0; // no disjoint candidate remains — fall back to dispatchOrder position
    collected.push(remaining[pickIndex]);
    remaining.splice(pickIndex, 1);
  }
  return collected;
}

/** True iff `candidate`'s EFFECTIVE scope (declared `files:` unioned with `observedByTask`, W1-T2286)
 *  overlaps NONE of `collected`'s — one pairwise `partitionByFileOverlap` check per already-collected
 *  task, so an undeclared-scope task (which `overlappingPaths` fail-closes as overlapping everything)
 *  never passes once anything is collected, exactly mirroring the real downstream partition's own
 *  verdict. `observedByTask` is passed straight through to that same check — see its own call site
 *  in `runnableCandidates` for why this must be the SAME map the caller later hands the real
 *  `partitionByFileOverlap` pass, not a second, possibly-different one. */
function isDisjointFromEvery(collected: readonly Task[], candidate: Task, observedByTask: ObservedScopeByTask): boolean {
  return collected.every((c) => partitionByFileOverlap([c, candidate], observedByTask).dispatch.length === 2);
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
  /**
   * How many candidates the FINAL selection declined as INDETERMINATE (W1-T119) — a gateway that
   * could not ANSWER, never a task that is genuinely ineligible. Reset each pass, deliberately:
   * see the reset's own comment in `runDrain` for why a lifetime total would mislead.
   *
   * WHY A NUMBER AND NOT PROSE. `stopDetail` is for the operator; this is for `drainCommand`,
   * which decides whether to look at the rate-limit buckets. A caller forced to regex a sentence
   * to learn what happened is how a reporting field becomes load-bearing by accident.
   *
   * `zero is overloaded`, MEASURED five times in this repo. A `no_runnable` with this at 0 is a
   * genuinely empty frontier; the same verdict with it non-zero is a fleet that could not SEE.
   * The two were byte-identical before this field existed, and an operator had to run
   * `gh api rate_limit` BY HAND to tell them apart. The dispatch PREDICATE was already correct —
   * rung 6 declines on unknown distinctly from rung 1's not-merged — so nothing here changes what
   * is dispatched, only what the terminal is able to say about it.
   */
  indeterminateDeclines?: number;
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
 * `blocked_illformed` JOINS THEM, AND THE ARGUMENT IS STRONGER HERE THAN FOR EITHER PREDECESSOR.
 * The header justifies stop-on-block as "a blocked task's DEPENDENTS would build on missing work,
 * so continuing risks compounding a gap". For `blocked_ci` the work was pushed and a PR is open;
 * for `no_pr` a worker ran and produced nothing. FOR THIS ONE THE LINTER REFUSED BEFORE DISPATCH.
 * `runTask` (run-task.ts) returns it from a `catch (TaskLintError)` whose own comment reads
 * "linter-failing task BEFORE the inflight lock is even taken — no lock, no worktree, no worker
 * ever spawns", and the returned result carries `costUsd: 0`. No process started, no branch was
 * cut, no state changed. There is nothing to compound, and nothing was spent discovering it.
 *
 * THE HEADER'S OTHER JUSTIFICATION IS FALSE WHERE THIS BITES. It says `rmd drain` "keeps its blunt
 * stop-on-block on purpose: a human kicked it off by hand and is watching it." In a container the
 * drain IS the unattended path — nobody is watching, and a surrendered budget is simply lost.
 *
 * MEASURED: one `--max 6` drain dispatched W1-T393 (merged), W1-T399 (`no_pr`, correctly continued),
 * then W1-T24 — refused pre-dispatch with three `proof-dialect` violations — and HALTED, giving up
 * three remaining dispatches to protect nothing. The population is not marginal: `lint-plan` reports
 * 472 `proof-dialect` violations plan-wide. The frontier is clean, so a drain only meets one once it
 * works past the recent shards — which is exactly what a drain does. (How often this has already
 * happened is UNMEASURED: the mini is down and the ledger is unreachable.)
 *
 * THE REFUSAL IS NOT SWALLOWED, which is the precondition for skipping it. `runTask` `say`s
 * "REFUSED: task <id> failed the pre-dispatch linter" with every violation enumerated, and ledgers
 * `lint.blocked` carrying them; the drain then ledgers `drain.continued`, and `buildRundown` (this
 * file) gives the task its OWN line — `blocked : <id> — blocked_illformed — drain continued` —
 * rather than the drain's `stopDetail`. A skipped ill-formed task is louder after this change than
 * a halted one was, because the drain no longer stops at the first.
 *
 * WHY NO OTHER VERDICT JOINS THIS SET, verdict by verdict. `blocked`, `blocked_review`,
 * `blocked_containment`, `blocked_isolation`, `failed` and
 * `pr_attribution_failed` all leave the work unfinished or unattributable, so the header's
 * argument applies unchanged. `blocked_budget`, `blocked_transient` and `blocked_git_fetch` are
 * environmental and say nothing about this task alone: the next dispatch would meet the same
 * condition, so continuing burns runs rather than making progress. `blocked_inflight` means
 * another holder owns the task right now.
 * `already_satisfied` never reaches this predicate: it returns `merged: true` and behaves as
 * forward progress.
 *
 * `task_already_merged` NOW JOINS THE SET, AND ITS ARGUMENT IS THE STRONGEST OF THE FOUR. The
 * sentence that used to sit in the paragraph above left it alone as "a separate concern"; that
 * concern is now MEASURED, so the deferral is spent and the sentence is replaced rather than
 * quietly dropped.
 *
 * Put the four side by side against the header's own justification — "a blocked task's DEPENDENTS
 * would build on missing work, so continuing risks compounding a gap":
 *
 *   - `blocked_ci`          — the work was pushed and the PR left open.
 *   - `no_pr`               — the task did not advance.
 *   - `blocked_illformed`   — the linter refused BEFORE dispatch.
 *   - `task_already_merged` — THE TASK IS DONE.
 *
 * The first three each argue that nothing was LOST. This one argues something stronger: its
 * dependents CAN build on it, because that is what merged MEANS. There is no gap to compound —
 * the gap is filled, by a merged PR the projection can name. Halting to protect dependents from
 * work that is already finished inverts the rule it is applying.
 *
 * AND IT COSTS NOTHING TO DISCOVER. `runTask`'s refusal (run-task.ts, the W1-T319 guard) fires
 * before `assertRunnable`, before the §5C linter, before the inflight lock, before worktree
 * materialization and before any spawn — its own comment says "zero cost beyond the map lookup" —
 * and the result it returns carries `costUsd: 0`.
 *
 * MEASURED: a `--max 6` drain attempted ONE task and stopped at $0.00 —
 * `REFUSED: W1-T24 is already merged (…/pull/75) — pass --rerun to dispatch anyway`, then
 * `stopped : blocked — W1-T24 → task_already_merged`. Five live tasks sat behind it (W1-T395,
 * W1-T399, W1-T400, W1-T401, W1-T402): five budgeted dispatches surrendered to protect work that
 * was already merged.
 *
 * WHY THE TASK WAS OFFERED AT ALL IS A SEPARATE DEFECT, NOT FIXED HERE — AND THIS CHANGE IS NOT
 * MERELY ITS SYMPTOM. Rung 1 of `isDispatchEligible` DID run, and returned false: `drainCommand`
 * builds its projection from `ghGateway` while `runTask` builds its own from
 * `buildBatchedGithub` (changed the same day, #1529) — two gateways answering one question at two
 * points of a single dispatch, which is the "never a second read path" rule `drainCommand`'s own
 * comments repeat. Aligning them would make this verdict RARE. It cannot make it impossible: a
 * task can merge in the window BETWEEN the drain's selection and the runner's refusal, and that
 * window survives any gateway alignment. The halt would still be wrong whenever it fired.
 *
 * THE REFUSAL IS NOT SWALLOWED, the same precondition the three predecessors needed. `runTask`
 * `say`s `REFUSED: <id> is already merged (<pr_url>) — pass --rerun to dispatch anyway` and
 * ledgers `dispatch.refused_already_merged` carrying that PR url; the drain then ledgers
 * `drain.continued`, and `buildRundown` (this file) gives the task its OWN line rather than the
 * drain's `stopDetail`. A drain that silently skipped merged tasks would hide a stale plan; this
 * one names every one it skipped.
 *
 * NOT FIXED HERE, AND NOT LOST: the reason `blocked_ci` fires on healthy PRs at all is that
 * `checkWaitStalled`'s window is a 30-second elapsed bound (five identical polls at six seconds)
 * measured against a `ci` job that needs minutes, so a long healthy job reads as a stall. Teaching
 * that predicate to count a still-running check as forward motion is the right second fix and a
 * different concern; this change makes the misfire cheap rather than making it rarer.
 */
export const NON_HALTING_VERDICTS: ReadonlySet<string> = new Set(["blocked_ci", "no_pr", "blocked_illformed", "task_already_merged"]);

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
 * The `stopDetail` for a `no_runnable` stop: whether the frontier was READ AND EMPTY, or merely
 * UNREADABLE.
 *
 * Both end the drain with the same `stopReason`, and until this existed they printed the same
 * single word. The operator's recourse was to run `gh api rate_limit` BY HAND and infer which of
 * the two had happened — from outside the process that already knew.
 *
 * A COUNT, NOT A SHARE, and the reason is worth stating rather than leaving as an omission: the
 * drain loops do not wire `onFiltered`, so there is no denominator here — and wiring one would not
 * help, because `DispatchFilterReason` has no indeterminate bucket. `tallyDispatchFilters` counts
 * the four ORDINARY declines; rung 6 has always reported through `onIndeterminate` instead. So
 * "N declined as indeterminate" is the strongest true statement available without changing the
 * dispatch predicate, and it is the one that distinguishes the two cases.
 *
 * ALWAYS RETURNS A SENTENCE, INCLUDING FOR ZERO. Returning `undefined` on the healthy path would
 * leave the terminal printing the pre-existing bare `no_runnable`, and an operator could not tell
 * a build that counts from a frontier that was clean. The zero case is a positive claim — the
 * frontier was read — not the absence of one.
 *
 * NO FILE-OVERLAP ARM, AND THAT IS A CORRECTION RATHER THAN AN OMISSION. The lanes loop's third
 * `no_runnable` sits AFTER `partitionByFileOverlap`, so the obvious reading is that a stop there
 * means candidates were found and then serialized away — and an earlier draft of this function
 * said so. It cannot happen: that partition's first candidate meets an EMPTY `dispatch` array, so
 * `dispatch.find(...)` returns undefined and it is placed unconditionally. `dispatch` is therefore
 * empty only when `candidates` was, which the guard one branch earlier already returned on. A
 * sentence for a population that cannot be observed is the same defect as a bound that fires on a
 * healthy condition, so it is not written.
 */
export function noRunnableDetail(counts: { indeterminate: number }): string {
  if (counts.indeterminate > 0) {
    return `${counts.indeterminate} candidate(s) declined as INDETERMINATE: the frontier could not be READ (the GitHub gateway did not answer), so this is not evidence of an empty queue`;
  }
  return "frontier read cleanly: 0 candidates declined as indeterminate, so the queue is genuinely empty";
}

/**
 * The `headroom_degraded` stop detail — the sentence an operator reads when a drain surrenders the
 * rest of its budget.
 *
 * IT NO LONGER SAYS "unreadable", BECAUSE THIS CODE CANNOT SEE THAT. `readUsage` is
 * `() => readUsageSnapshot(config)` at both drain call sites (src/run-task.ts), and that function
 * fails in TWO ways it deliberately keeps apart: `UsageProbeFailureStage` is `"spawn" | "parse"`,
 * and its own comment records that conflating them "cost this fleet its headroom read for hours on
 * 2026-07-31" — the probe had returned a perfect 1015-byte reading and only the PARSER threw.
 * Both branches then return `undefined`, so by the time the value reaches here the stage is gone
 * and only one bit survives. Asserting "unreadable" over that bit is a claim this function cannot
 * substantiate, and it points an operator at a broken API when the real fault may be a parser.
 *
 * SO IT NAMES THE ROW THAT DOES KNOW. `ledgerUsageProbeFailure` (src/run-task.ts) already writes
 * `usage.probe_failed` DURABLY with the stage and the reason, on every failed probe, precisely so
 * the next surprise names itself on the first tick. The detail below is a pointer to evidence that
 * already exists rather than a second, weaker guess at it. The RETURN POLARITY and the BOUND are
 * untouched: the read genuinely failed, and the bound behaved correctly on a true input.
 *
 * ONE BUILDER, TWO CALL SITES. `runDrain`'s single-lane loop and `runDrainLanes`' multi-lane pass
 * both stop this way, and W1-T290 shipped the ceiling to both precisely so the `--lanes` path did
 * not stay a latent fail-open. A hand-copied sentence at each site is the drift this repo argues
 * against everywhere else (`INSTRUMENT_SURFACE`'s own one-path-set note), so the wording lives here
 * once and both sites call it.
 */
export function headroomDegradedDetail(consecutive: number, limit: number): string {
  return (
    `usage probe failed ${consecutive}x consecutively (limit ${limit}) — ` +
    `see the usage.probe_failed ledger rows for the stage (spawn or parse) and the reason`
  );
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
   * W1-T2675 — the credit-read-failed probe, resolved by the CALLER from the same projection
   * `refreshMerged` builds, exactly as `isOpenPr` is: this module never reads GitHub. See
   * {@link NextRunnableOpts.isCreditIndeterminate} for why a `merged: false` carrying
   * `indeterminate: true` must refuse rather than dispatch. Optional, and omitting it leaves
   * selection byte-identical to before it existed.
   */
  isCreditIndeterminate?: (taskId: string) => boolean;
  /**
   * W1-T2397 — the open-sibling OBSERVATION's two halves, forwarded verbatim to
   * {@link NextRunnableOpts.openSiblingBuildFor} / {@link NextRunnableOpts.onOpenSiblingBuild};
   * see those fields' own docs for the contract. Carried on `DrainDeps` for the same reason
   * `isOpenPr` is: the caller resolves the projection, this module never reads GitHub.
   *
   * THEY ARE NOT `isOpenPr` AND MUST NOT BE FOLDED INTO IT. `isOpenPr` decides eligibility;
   * widening THAT is the refusal W1-T2397 declined on measurement (the naive predicate fired four
   * times in 72 hours and three of those merged). These two are consulted only after a task has
   * been chosen and cannot change what is dispatched. Omitted ⇒ no observation, and dispatch is
   * byte-identical to before they existed.
   */
  openSiblingBuildFor?: NextRunnableOpts["openSiblingBuildFor"];
  onOpenSiblingBuild?: NextRunnableOpts["onOpenSiblingBuild"];
  /**
   * W1-T177: an OPTIONAL fresh, live re-read of ONE candidate in-flight PR's
   * GitHub state — see {@link NextRunnableOpts.readLiveState}'s doc for the
   * full contract. Optional — omitted, dispatch behaves exactly as before
   * this check existed.
   */
  readLiveState?: (taskId: string, prNumber: number) => string | undefined;
  /**
   * W1-T1035: an OPTIONAL fresh re-check of whether a just-observed MERGED PR (`readLiveState`
   * above) actually credits the task it was opened for — see {@link
   * NextRunnableOpts.isLiveMergeCredited}'s doc for the full contract (the stale-credit vs.
   * W1-T177 discrimination). Optional — omitted, dispatch behaves EXACTLY as before this
   * discrimination existed.
   */
  isLiveMergeCredited?: (taskId: string, prNumber: number) => boolean;
  /**
   * W1-T916 — THE SUPPLIER W1-T534 DECLARED AND NOBODY PASSED. Raw `git ls-remote --heads origin
   * 'run-*'` output, read ONCE PER PASS and parsed by {@link runBranchTaskIds} into the closure
   * {@link NextRunnableOpts.hasPushedRunBranch} consumes. Injected rather than executed here
   * because THIS MODULE IS PURE — it carries no `child_process` import and no `execFileSync`, the
   * same discipline `refreshMerged`/`isOpenPr`/`runOne` already follow.
   *
   * WHY A READER AND NOT A PREDICATE: the cost argument is ONE REF SWEEP PER PASS (46 refs in
   * 199 ms, `core` remaining identical before and after, because `ls-remote` speaks the git
   * protocol and spends neither budget) against one round trip per candidate. Handing this module
   * a per-task predicate would let a caller satisfy the type while making exactly the
   * per-candidate call the design refuses; handing it the RAW OUTPUT makes one-sweep-per-pass the
   * only shape that type-checks, and the parse is hoisted ABOVE the dispatch loop for the same
   * reason.
   *
   * Optional — omitted, dispatch behaves EXACTLY as before this existed.
   */
  readPushedRunBranches?: () => string;
  /**
   * W1-T1207 (design (iii)): raw `pulls?state=closed` rows for the SAME run-branch sweep above —
   * ONE BATCHED, PAGINATED read per pass, never one lookup per branch, parsed by {@link
   * closedUnmergedRunBranchTaskIds} into the set the caller subtracts from `readPushedRunBranches`'
   * blocking set immediately above the dispatch loop. Exists ONLY to answer "did an OPERATOR close
   * this run branch's pull request without merging it" — a sweep-INITIATED close is already free
   * from the ledger row it writes (design (iii)'s "two things are already free"), so this read is
   * needed only for the operator-initiated half, which is exactly how the five measured exclusions
   * (W1-T1098, W1-T1101, W1-T1104, W1-T1109, W1-T1000002) arose.
   *
   * FAILS TOWARD STILL BLOCKING — the OPPOSITE direction from `readPushedRunBranches`'s own fail
   * OPEN: a throw (network blip, auth) is expected to degrade to `""`, which parses to an EMPTY
   * exclusion set, so every pushed run branch keeps blocking exactly as it did before this
   * dependency existed. That asymmetry is deliberate (design (ii)): "a false block delays one
   * task, a false dispatch races a live run" — an unreadable closed-PR sweep must never become the
   * reason a task dispatches.
   *
   * Optional — omitted, `hasPushedRunBranch` behaves EXACTLY as before this existed: it blocks on
   * ANY pushed run branch regardless of its pull request's state.
   */
  readClosedRunBranchPrs?: () => string;
  /**
   * W1-T2286: the same {@link ObservedScopeByTask} threaded to {@link NextRunnableOpts.observedByTask}
   * for the pack step AND to `partitionByFileOverlap`'s own direct call in `runDrainLanes` below —
   * ONE dependency, read twice, so the candidates the pack step admits and the partition that
   * decides `dispatch`/`serialized` for them never disagree about what each task's effective
   * scope is. Optional — omitted, both call sites fall back to `NO_OBSERVED_SCOPE` and dispatch
   * is byte-identical to before this dependency existed; no production caller supplies one yet
   * (see {@link ObservedScopeByTask}'s own doc).
   */
  observedByTask?: ObservedScopeByTask;
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
   * WHAT THE BREAKER SAW for a task, supplied by the SAME memoised evaluation the
   * `isCircuitTripped`/`isIndeterminate` predicates answered from (run-task.ts's
   * `breakerGateFor().detailFor`) — never a second call to the predicate. Spread onto the
   * `dispatch.circuit_broken` / `dispatch.indeterminate` rows so a refusal records the count,
   * the bound and WHICH of the three outcomes was reached, instead of only that it fired.
   * Optional: a caller that omits it logs exactly the bare rows it logged before.
   */
  breakerDetail?: (taskId: string) => Record<string, unknown> | undefined;
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
  /**
   * W1-T417-adjacent (SDK usage source): MAY return a promise. Widened rather than made
   * `async`, so every existing SYNCHRONOUS supplier — the CLI probe and all 60 test fakes —
   * keeps working byte-for-byte; `await` on a non-promise is a no-op. The daemon needs this
   * because the contract-supported SDK reading is a control request on a streaming session,
   * which is inherently async.
   */
  readUsage?: () => UsageSnapshot | undefined | Promise<UsageSnapshot | undefined>;
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
  /**
   * How many candidates the CURRENT pass declined as indeterminate — a gateway that could not
   * ANSWER (W1-T119 sets `indeterminate` on `readFailed()`), never a task that is genuinely
   * ineligible. Counted so the terminal can say WHY it stopped: a throttled gateway and an empty
   * frontier both end in `no_runnable`, and without this they are the same sentence.
   */
  let indeterminateDeclines = 0;
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
    // `indeterminateDeclines` is emitted ALWAYS, including as 0 — omitting it when zero would put
    // the ambiguity straight back: an absent field would mean either "nothing was indeterminate" or
    // "this build does not count". An explicit 0 is the statement that the frontier was READ and
    // found empty.
    const s: DrainSummary = { attempted, merged, continued, stopReason, stopDetail, indeterminateDeclines, costUsd, resumeCommand: resumeCommand(opts) };
    log("drain.summary", { ...s });
    return s;
  };

  // W1-T916 — ONE SWEEP PER PASS, NEVER ONE PER CANDIDATE. Resolved BEFORE the dispatch loop so
  // every iteration below tests set membership rather than making a round trip; hoisting is the
  // whole cost argument, not a micro-optimisation.
  const pushedRunBranches = deps.readPushedRunBranches
    ? runBranchTaskIds(deps.readPushedRunBranches())
    : undefined;
  // W1-T1207 — SAME one-sweep-per-pass hoist, for the arm that stops a leftover branch from
  // blocking forever: task ids whose pushed run branch's pull request is CLOSED AND UNMERGED.
  // Subtracted from `pushedRunBranches` below so an OPEN/DRAFT PR (or no PR at all) still blocks
  // exactly as before, and only a closed-unmerged one — the "not evidence of work in flight"
  // case design (i) names — stops blocking.
  const closedUnmergedRunBranches = deps.readClosedRunBranchPrs
    ? closedUnmergedRunBranchTaskIds(deps.readClosedRunBranchPrs())
    : undefined;
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
      const snap = await deps.readUsage();
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
            note: "usage probe failed beyond the bounded allowance — stopping, not dispatching; see usage.probe_failed for the stage",
          });
          return summary(
            "headroom_degraded",
            headroomDegradedDetail(consecutiveUnreadable, unreadableDegradedLimit),
          );
        }
        log("drain.headroom.unavailable", {
          consecutive_unreadable: consecutiveUnreadable,
          degraded_limit: unreadableDegradedLimit,
          note: "usage probe failed — bounded degraded-mode allowance, still dispatching; see usage.probe_failed for the stage",
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
      isCreditIndeterminate: deps.isCreditIndeterminate,
      // W1-T2397: forwarded at BOTH `skipOpts` sites, so the single-lane and multi-lane passes
      // observe identically — the same reason `observedByTask` is carried at both.
      openSiblingBuildFor: deps.openSiblingBuildFor,
      onOpenSiblingBuild: deps.onOpenSiblingBuild,
      // W1-T2286: unused by this single-lane path (`nextRunnable`/`nextCurated` never pack or
      // partition) — carried here only so `NextRunnableOpts` is filled the same way at both
      // `skipOpts` construction sites. See `DrainDeps.observedByTask`'s own doc.
      observedByTask: deps.observedByTask,
      // W1-T916: the argument W1-T534 declared and nothing supplied. `pushedRunBranches` is
      // resolved ONCE above this loop, so this closure is a set-membership test and never a round
      // trip. Undefined when no reader was injected ⇒ `hasPushedRunBranch` stays undefined ⇒
      // `nextRunnable` behaves exactly as before, which is what keeps this additive.
      //
      // W1-T1207: `&& !closedUnmergedRunBranches?.has(id)` is the whole fix — a branch stays
      // blocking (unchanged) unless its PR is CLOSED AND UNMERGED, in which case it is excluded
      // from the AND and this predicate answers `false`. `closedUnmergedRunBranches` is `undefined`
      // when no reader was injected, so `?.has(id)` is `undefined`, `!undefined` is `true`, and the
      // predicate is byte-identical to before this existed — additive on this axis too.
      ...(pushedRunBranches
        ? {
            hasPushedRunBranch: (id: string) => pushedRunBranches.has(id) && !closedUnmergedRunBranches?.has(id),
            // RIDES THE EXISTING ROW (W1-T534 design (v)): `dispatch.skipped` with its own reason,
            // never a new step and never `dispatch.stood_down`, which has no reader at all. The
            // task is NOT marked done and burns NO strike — it is offered again once the branch is
            // gone, so this is a skip and never a terminal state.
            onSkipRunBranch: (t: Task) =>
              log("dispatch.skipped", { task: t.id, reason: "run-branch-already-pushed" }),
          }
        : {}),
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
      // W1-T1035: the fresh MERGED read above ALSO credits this task — the credit
      // projection (`isMerged`, captured once for this whole pass) was simply behind. Ledgered
      // under its own step, alongside (never instead of) `dispatch.stood_down`, so an operator can
      // tell "stood down, still runnable" (W1-T177) apart from "stood down, now excluded".
      isLiveMergeCredited: deps.isLiveMergeCredited,
      onStaleCreditExcluded: (t, prNumber, state) =>
        log("dispatch.stale_credit_excluded", {
          task: t.id,
          pr_number: prNumber,
          state,
          reason: "credit projection was stale — the live merge already credits this task",
        }),
      isIndeterminate: deps.isIndeterminate,
      // INDETERMINATE (W1-T119): a legible ledger line every tick it is
      // consulted, then the drain proceeds to the next runnable task rather
      // than halting — a throttled/errored read on one task must not stall
      // everything else still dispatchable.
      onIndeterminate: (t) => {
        log("dispatch.indeterminate", { task: t.id, ...deps.breakerDetail?.(t.id) });
        // COUNTED, not merely logged. This ledger line has always existed; what did not exist was
        // any way for the TERMINAL to say the frontier was unreadable rather than empty.
        indeterminateDeclines++;
        deps.onIndeterminate?.(t);
      },
      isCircuitTripped: deps.isCircuitTripped,
      // CIRCUIT BREAKER (P29(ii)): a legible ledger line every tick it is
      // consulted (mirrors dispatch.skipped) — but the caller's own escalation
      // hook fires AT MOST ONCE per task id per drain run (`circuitEscalated`,
      // above) — the drain proceeds to the next runnable task rather than
      // halting, and never re-escalates a task it already escalated this run.
      onCircuitBreak: (t) => {
        log("dispatch.circuit_broken", { task: t.id, ...deps.breakerDetail?.(t.id) });
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
    // RESET PER SELECTION, NOT ACCUMULATED OVER THE DRAIN. `onIndeterminate` fires only from the
    // selection call below, and the question the terminal has to answer is about the pass that
    // actually GAVE UP — not about a gateway hiccup three passes ago that has since cleared.
    // A lifetime counter would report an unreadable frontier on a stop whose final pass read
    // perfectly, which is the always-blames-the-quota failure this change exists to avoid.
    indeterminateDeclines = 0;
    const next = opts.curated
      ? nextCurated(plan, opts.curated, attempted, isMerged, skipOpts)
      : nextRunnable(plan, isMerged, skipOpts);
    if (!next) return summary("no_runnable", noRunnableDetail({ indeterminate: indeterminateDeclines }));

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
      // CONTINUED, NOT CREDITED (see NON_HALTING_VERDICTS): the drain keeps its remaining budget,
      // but the task is NOT added to `merged`, so the dependency filter still refuses its
      // dependents. HOW FAR THE TASK GOT VARIES BY VERDICT and this comment used to name only the
      // `blocked_ci` shape ("the work is pushed and its PR is open"), which is untrue for the other
      // two: `no_pr` ran a worker that produced nothing, and `blocked_illformed` never dispatched at
      // all. What they share is the only thing this branch needs — none of them advanced the task,
      // so none of them may credit it.
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
  /**
   * How many candidates the CURRENT pass declined as indeterminate — a gateway that could not
   * ANSWER (W1-T119 sets `indeterminate` on `readFailed()`), never a task that is genuinely
   * ineligible. Counted so the terminal can say WHY it stopped: a throttled gateway and an empty
   * frontier both end in `no_runnable`, and without this they are the same sentence.
   */
  let indeterminateDeclines = 0;
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
    // `indeterminateDeclines` is emitted ALWAYS, including as 0 — omitting it when zero would put
    // the ambiguity straight back: an absent field would mean either "nothing was indeterminate" or
    // "this build does not count". An explicit 0 is the statement that the frontier was READ and
    // found empty.
    const s: DrainSummary = { attempted, merged, continued, stopReason, stopDetail, indeterminateDeclines, costUsd, resumeCommand: resumeCommand(opts) };
    log("drain.summary", { ...s });
    return s;
  };

  // W1-T916 — ONE SWEEP PER PASS, NEVER ONE PER CANDIDATE. Resolved BEFORE the dispatch loop so
  // every iteration below tests set membership rather than making a round trip; hoisting is the
  // whole cost argument, not a micro-optimisation.
  const pushedRunBranches = deps.readPushedRunBranches
    ? runBranchTaskIds(deps.readPushedRunBranches())
    : undefined;
  // W1-T1207 — SAME one-sweep-per-pass hoist, for the arm that stops a leftover branch from
  // blocking forever: task ids whose pushed run branch's pull request is CLOSED AND UNMERGED.
  // Subtracted from `pushedRunBranches` below so an OPEN/DRAFT PR (or no PR at all) still blocks
  // exactly as before, and only a closed-unmerged one — the "not evidence of work in flight"
  // case design (i) names — stops blocking.
  const closedUnmergedRunBranches = deps.readClosedRunBranchPrs
    ? closedUnmergedRunBranchTaskIds(deps.readClosedRunBranchPrs())
    : undefined;
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
      const snap = await deps.readUsage();
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
            note: "usage probe failed beyond the bounded allowance — stopping, not dispatching; see usage.probe_failed for the stage",
          });
          return summary(
            "headroom_degraded",
            headroomDegradedDetail(consecutiveUnreadable, unreadableDegradedLimit),
          );
        }
        log("drain.headroom.unavailable", {
          consecutive_unreadable: consecutiveUnreadable,
          degraded_limit: unreadableDegradedLimit,
          note: "usage probe failed — bounded degraded-mode allowance, still dispatching; see usage.probe_failed for the stage",
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
      isCreditIndeterminate: deps.isCreditIndeterminate,
      // W1-T2397: forwarded at BOTH `skipOpts` sites, so the single-lane and multi-lane passes
      // observe identically — the same reason `observedByTask` is carried at both.
      openSiblingBuildFor: deps.openSiblingBuildFor,
      onOpenSiblingBuild: deps.onOpenSiblingBuild,
      // W1-T2286: the SAME map handed to `partitionByFileOverlap` below (where this pass calls
      // it directly) — see `DrainDeps.observedByTask`'s own doc for why the pack step and the
      // real partition must never disagree.
      observedByTask: deps.observedByTask,
      // W1-T916: the argument W1-T534 declared and nothing supplied. `pushedRunBranches` is
      // resolved ONCE above this loop, so this closure is a set-membership test and never a round
      // trip. Undefined when no reader was injected ⇒ `hasPushedRunBranch` stays undefined ⇒
      // `nextRunnable` behaves exactly as before, which is what keeps this additive.
      //
      // W1-T1207: `&& !closedUnmergedRunBranches?.has(id)` is the whole fix — a branch stays
      // blocking (unchanged) unless its PR is CLOSED AND UNMERGED, in which case it is excluded
      // from the AND and this predicate answers `false`. `closedUnmergedRunBranches` is `undefined`
      // when no reader was injected, so `?.has(id)` is `undefined`, `!undefined` is `true`, and the
      // predicate is byte-identical to before this existed — additive on this axis too.
      ...(pushedRunBranches
        ? {
            hasPushedRunBranch: (id: string) => pushedRunBranches.has(id) && !closedUnmergedRunBranches?.has(id),
            // RIDES THE EXISTING ROW (W1-T534 design (v)): `dispatch.skipped` with its own reason,
            // never a new step and never `dispatch.stood_down`, which has no reader at all. The
            // task is NOT marked done and burns NO strike — it is offered again once the branch is
            // gone, so this is a skip and never a terminal state.
            onSkipRunBranch: (t: Task) =>
              log("dispatch.skipped", { task: t.id, reason: "run-branch-already-pushed" }),
          }
        : {}),
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
      // W1-T1035: the fresh MERGED read above ALSO credits this task — the credit
      // projection (`isMerged`, captured once for this whole pass) was simply behind. Ledgered
      // under its own step, alongside (never instead of) `dispatch.stood_down`, so an operator can
      // tell "stood down, still runnable" (W1-T177) apart from "stood down, now excluded".
      isLiveMergeCredited: deps.isLiveMergeCredited,
      onStaleCreditExcluded: (t, prNumber, state) =>
        log("dispatch.stale_credit_excluded", {
          task: t.id,
          pr_number: prNumber,
          state,
          reason: "credit projection was stale — the live merge already credits this task",
        }),
      isIndeterminate: deps.isIndeterminate,
      onIndeterminate: (t) => {
        log("dispatch.indeterminate", { task: t.id, ...deps.breakerDetail?.(t.id) });
        // COUNTED, not merely logged. This ledger line has always existed; what did not exist was
        // any way for the TERMINAL to say the frontier was unreadable rather than empty.
        indeterminateDeclines++;
        deps.onIndeterminate?.(t);
      },
      isCircuitTripped: deps.isCircuitTripped,
      onCircuitBreak: (t) => {
        log("dispatch.circuit_broken", { task: t.id, ...deps.breakerDetail?.(t.id) });
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

    // RESET PER SELECTION, NOT ACCUMULATED OVER THE DRAIN. `onIndeterminate` fires only from the
    // selection call below, and the question the terminal has to answer is about the pass that
    // actually GAVE UP — not about a gateway hiccup three passes ago that has since cleared.
    // A lifetime counter would report an unreadable frontier on a stop whose final pass read
    // perfectly, which is the always-blames-the-quota failure this change exists to avoid.
    indeterminateDeclines = 0;
    const candidates = runnableCandidates(plan, isMerged, passSize, skipOpts);
    if (candidates.length === 0) return summary("no_runnable", noRunnableDetail({ indeterminate: indeterminateDeclines }));

    // PRE-DISPATCH OVERLAP CHECK (W1-T171), ACROSS the co-dispatched set: a
    // deferred task is simply absent from THIS pass — it is re-considered
    // next tick, by which point the task it collided with is either merged
    // or (far more commonly) has an OPEN PR of its own, so the in-flight
    // guard above excludes it from candidates entirely and the collision
    // never recurs. Self-resolving; no bookkeeping needed here.
    //
    // W1-T2286: `deps.observedByTask` — the SAME map `skipOpts.observedByTask` fed the pack step
    // above — is passed EXPLICITLY rather than omitted, so this call site no longer relies on
    // `partitionByFileOverlap`'s own default parameter. `?? NO_OBSERVED_SCOPE` keeps today's
    // behaviour byte-identical when no observer is wired (no production caller supplies one yet).
    const partition = partitionByFileOverlap(candidates, deps.observedByTask ?? NO_OBSERVED_SCOPE);
    for (const d of partition.serialized) log("dispatch.serialized", serializedLedgerPayload(d));
    const dispatchSet = partition.dispatch;
    // DEFENSIVE, NOT A DISTINCT CAUSE: `partitionByFileOverlap` places its first candidate against
    // an empty `dispatch` unconditionally, so this is empty only when `candidates` was — already
    // returned on above. Kept (it predates this change) and given the SAME detail as the other two
    // rather than an overlap-flavoured one, because the overlap story is unreachable here.
    if (dispatchSet.length === 0) return summary("no_runnable", noRunnableDetail({ indeterminate: indeterminateDeclines }));

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
