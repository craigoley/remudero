/** `rmd drain` is a bounded, deterministic loop over the proven run-task machinery (WS-1): each pass
 *  resolves the next runnable task from the DAG, runs it through run-task, and repeats. It invents no
 *  orchestration — deps are plan.ts's ({@link unmetDependencies}), status is GitHub-derived
 *  (status.ts), headroom is headroom.ts (W1-T4), and no LLM decides anything.
 *  INVARIANT: the drain stops on any halting verdict, because a blocked task's dependents would build
 *  on missing work. {@link NON_HALTING_VERDICTS} names the four exceptions, {@link haltsDrain} is the
 *  one predicate both loops apply, and skip-and-continue lives in the daemon loop (W1-T46). */
// Why: the stop-on-block rule and the argument behind it (W1-T46) — docs/forensics/drain.md.

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

/** W1-T2675 — which credit path (status.ts's `findMergedByHeadBranch` union) credited an
 *  already-merged task: a trailer, a `run-<taskId>-<epochMs>` head ref, or both. `"head-ref"` alone
 *  must be reportable, because a merge can carry zero trailers and still be credited (#1657). */
export type CreditPath = "trailer" | "head-ref" | "both";

/** The evidence behind an `"already-merged"` refusal: which path matched, and the PR it rode in on,
 *  so an operator sees "already shipped as #N (head-ref)" rather than a bare refusal. */
export interface AlreadyMergedCredit {
  path: CreditPath;
  prNumber: number;
}

/** Names the matched credit path from the SAME status projection that feeds `isMerged`. The
 *  projection's `merged` boolean remains the gate — this only labels a refusal that already fired. */
export function alreadyMergedCreditFromProjection(
  projection: Partial<Pick<StatusProjection, "merged" | "source" | "prNumber">> | undefined,
): AlreadyMergedCredit | undefined {
  if (projection === undefined) return undefined;
  if (projection.merged !== true || typeof projection.prNumber !== "number") return undefined;
  if (projection.source === "trailer") return { path: "trailer", prNumber: projection.prNumber };
  if (projection.source === "head-branch") return { path: "head-ref", prNumber: projection.prNumber };
  return undefined;
}

/** The OPEN PR number for a task's most-recent PR, or undefined when it is merged, closed, or
 *  absent. Backs the in-flight dispatch-dedup guard (W1-T80, the #143/#145 duplicate-build race).
 *  Derived from status.ts's `deriveStatus` projection in the real runner, never a second read path. */
export type OpenPrCheck = (taskId: string) => number | undefined;

/** Task ids with a `run-<id>-<epochMs>` branch on origin, parsed from ONE `git ls-remote --heads
 *  origin 'run-*'` call (W1-T534). INVARIANT: one sweep per pass, never one call per candidate. A
 *  line may be `<sha>\trefs/heads/<branch>`, a bare ref, or a bare branch, and an unparseable one is
 *  skipped so a malformed ref degrades to "not observed". Reuses `taskIdFromRunBranch` (status.ts),
 *  the one tested extractor for this shape. */
// Why: the ref-sweep cost measurement and the anchoring argument (W1-T534) — docs/forensics/drain.md.
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

/** Task ids whose `run-<id>-<epochMs>` branch belongs to a CLOSED AND UNMERGED pull request, parsed
 *  from one batched, paginated `pulls?state=closed` sweep (W1-T1207). INVARIANT: only this one state
 *  is named — GitHub deletes a MERGED PR's head so it never reaches {@link runBranchTaskIds}'s sweep,
 *  and an OPEN or DRAFT PR is work in flight that must keep blocking. Rows are `<head-ref>\t<unmerged>`
 *  with `unmerged` the literal `"true"`; anything else is skipped rather than thrown. */
// Why: why a merged head self-clears and an open one must not (W1-T1207) — docs/forensics/drain.md.
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

  /** W1-T2675 — a FAILED credit read, which is not the same as "not merged". `deriveStatus`
   *  (status.ts) returns `indeterminate: true` when the GitHub read genuinely failed, and a caller
   *  that gates dispatch must treat that as DO NOT ACT. TRAP: every {@link MergedSet} here is spelled
   *  `projection.get(id)?.merged ?? false`, which collapses `indeterminate` into a confident `false`,
   *  so a shipped task is admitted and the rebuild cannot pass review. Optional. */
  // Why: the #3512 rebuild lifecycle this closes (W1-T2675) — docs/forensics/drain.md.
  isCreditIndeterminate?: (taskId: string) => boolean;

  /** W1-T2397 — is an OPEN PR building this task that is NOT its own `run-<taskId>-<digits>` branch?
   *  Read off `StatusProjection.openSiblingBuild` (status.ts), so it costs no extra read. INVARIANT:
   *  this is not `isOpenPr` and must never become it — it is consulted AFTER a task is chosen, feeds
   *  {@link onOpenSiblingBuild} alone, and cannot change what is dispatched. */
  // Why: the naive eligibility widening W1-T2397 declined on measurement — docs/forensics/drain.md.
  openSiblingBuildFor?: (taskId: string) => OpenSiblingBuild | undefined;
  /** W1-T2397: called once, for the task actually being dispatched, when {@link openSiblingBuildFor}
   *  reports an open sibling. Omitted, dispatch is byte-identical to before this existed. */
  onOpenSiblingBuild?: (task: Task, sibling: OpenSiblingBuild) => void;
  /** Task ids this drain already continued past ({@link NON_HALTING_VERDICTS}) — never offered
   *  again in the same pass. Omit ⇒ no exclusion, exactly as before this existed. */
  excludeIds?: ReadonlySet<string>;
  /** Called once per task excluded because of an open PR — for ledger/console legibility. */
  onSkip?: (task: Task, prNumber: number) => void;
  /** W1-T119: true when this task's own GitHub read is INDETERMINATE — a genuine read failure
   *  (rate limit, network, auth), never a clean "no evidence". Dispatching then risks re-running
   *  merged work, the throttle-reads-as-not-merged spend event this guard prevents. Optional. */
  isIndeterminate?: (taskId: string) => boolean;
  /** Called once per task excluded for an indeterminate read, in place of dispatching it —
   *  mirrors `onSkip`/`onCircuitBreak`'s legibility contract. */
  onIndeterminate?: (task: Task) => void;
  /** The per-task dispatch CIRCUIT BREAKER (MASTER-PLAN P29(ii)): true when this task has been
   *  dispatched the policy-capped number of times with no new owned PR since (status.ts's
   *  `isDispatchBreakerTripped`, ledger-derived, so it survives a process restart). Optional. */
  isCircuitTripped?: (taskId: string) => boolean;
  /** Called once per task whose breaker is tripped. The real wiring escalates one deduped
   *  needs-human issue naming the loop; dispatch never proceeds for that task. */
  onCircuitBreak?: (task: Task) => void;
  /** What the breaker SAW, from the same memoised evaluation the predicates answered from
   *  (run-task.ts's `breakerGateFor().detailFor`), never a second call. Spread onto the refusal row
   *  so it records the count, the bound and which outcome was reached. Optional. */
  breakerDetail?: (taskId: string) => Record<string, unknown> | undefined;
  /** THE LIFETIME DISPATCH CAP (W1-T271): true when this task has EVER been dispatched the
   *  policy-capped number of times (status.ts's `isLifetimeDispatchCapExceeded`). A second backstop
   *  beside `isCircuitTripped`, never a replacement — the streak breaker resets on every new owned
   *  PR, so it is blind to a task that re-dispatches forever while merging a no-op. Optional. */
  // Why: the W1-T254 incident this cap exists to catch (W1-T271) — docs/forensics/drain.md.
  isLifetimeCapExceeded?: (taskId: string) => boolean;
  /** Called once per task excluded by the lifetime cap — mirrors `onCircuitBreak`'s contract. */
  onLifetimeCapExceeded?: (task: Task) => void;
  /** Called once per task declined by one of the formerly-silent conditions, with the first-match
   *  reason (see {@link tallyDispatchFilters}). Observation only: it changes no task's eligibility. */
  onFiltered?: (task: Task, reason: DispatchFilterReason) => void;
  /** W1-T988 — the repo this daemon targets (`DaemonTarget.repo`). Optional by design: omitted, the
   *  guard does not fire. {@link normalizeRepoName} reduces a slug to its bare name before comparing. */
  targetRepo?: string;
  /** W1-T951: true when this already-merged task's durable credit (status.ts's
   *  `isSinglePathCredited`) rests on EXACTLY ONE path — a trailer XOR a head ref. Consulted only on
   *  the `"already-merged"` decline, so it can never change eligibility. Optional. */
  isSinglePathCredit?: (taskId: string) => boolean;
  /** Called ALONGSIDE, never instead of, `onFiltered(task, "already-merged")`. A task credited by
   *  one path is indistinguishable from one credited by both until that path disappears (GitHub
   *  deletes the head ref on merge), so this is where a caller can notice the fragile population. */
  // Why: the discoverable-signal design and its rationale (W1-T951) — docs/forensics/drain.md.
  onSinglePathCredit?: (task: Task) => void;
  /** W1-T2675: resolves the {@link AlreadyMergedCredit} for a task {@link MergedSet} already
   *  refused, so it can never change eligibility. Undefined when the caller holds no such detail,
   *  and the refusal still fires, unnamed. INVARIANT: neither this probe nor its callback reads
   *  `t.status` or `t.retirement` — a shard's `status:` is not a completion signal. */
  creditFor?: (taskId: string) => AlreadyMergedCredit | undefined;
  /** Called ALONGSIDE, never instead of, `onFiltered(task, "already-merged")` when {@link creditFor}
   *  resolves a credit, so a caller can name the PR rather than print a bare refusal. */
  onAlreadyMergedCredit?: (task: Task, credit: AlreadyMergedCredit) => void;
  /** W1-T177 — an OPTIONAL fresh re-read of one in-flight PR's live GitHub state, never the cached
   *  snapshot, returning "OPEN"/"MERGED"/"CLOSED" or undefined on a failed read. INVARIANT: an
   *  unreadable state means "treat as in-flight, skip it", never "assume terminal, dispatch" — here
   *  a stale OPEN wrongly BLOCKS rather than wrongly spends, so the failure mode is a skip. */
  readLiveState?: (taskId: string, prNumber: number) => string | undefined;
  /** W1-T2286: each candidate's OBSERVED file scope, consulted only by {@link runnableCandidates}'
   *  packing. INVARIANT: it must be the SAME map handed to `partitionByFileOverlap` downstream, or
   *  the pack picks a candidate the real partition then serializes away. Omitted, each candidate is
   *  scored on its bare declaration. */
  observedByTask?: ObservedScopeByTask;
  /** Called once per task whose CACHED in-flight snapshot this live re-check overturned — one
   *  PR-level observation, fired for every terminal state whatever the task's eligibility resolves
   *  to (W1-T1035's crediting MERGED read still fires it). The real wiring corrects the ledgered
   *  reason from "open-pr" to the observed state. */
  onStoodDown?: (task: Task, prNumber: number, state: string) => void;
  /** W1-T1035 — does this freshly-observed MERGED PR actually credit this task?
   *  `isMerged(t.id)` is the credit projection for the whole pass, built once before the
   *  per-candidate walk, so `readLiveState`'s own fresh read can be ahead of it and a bare MERGED is
   *  ambiguous without this probe. True is the STALE-CREDIT case (this merge credits the task, so
   *  exclude it rather than re-invite `dispatch.refused_already_merged`); false or omitted is the
   *  W1-T177 case (the merge credits someone else, so the task stays admitted). Consulted only after
   *  a `"MERGED"` answer — `"OPEN"` is in flight, `"CLOSED"` credits nobody.
   *  FALSIFIER: test/drain.test.ts's three W1-T177 assertions must keep passing untouched. */
  // Why: the 24-of-32 stood-down-then-refused measurement (W1-T1035) — docs/forensics/drain.md.
  isLiveMergeCredited?: (taskId: string, prNumber: number) => boolean;
  /** Called once per task EXCLUDED because `isLiveMergeCredited` confirmed the stale-credit case,
   *  fired ALONGSIDE `onStoodDown` so "still runnable" and "now excluded" are told apart. */
  onStaleCreditExcluded?: (task: Task, prNumber: number, state: string) => void;
  /** W1-T534: true when a `run-<taskId>-<epochMs>` branch already exists on origin. INVARIANT: this
   *  AUGMENTS `isOpenPr` and never replaces it — `isOpenPr` reads a projection re-derived once per
   *  drain TICK, so a PR opened, or a branch merely pushed ahead of its PR, is invisible to it. The
   *  two cover disjoint windows. Build the closure from ONE {@link runBranchTaskIds} sweep per pass:
   *  `sweep.has(id) && !closedUnmerged.has(id)`, subtracting {@link closedUnmergedRunBranchTaskIds}.
   *  TRAP: this probe has no upper bound of its own and must not gain one (W1-T1207). Read the PR's
   *  state; never guess when a leftover branch stopped mattering. */
  hasPushedRunBranch?: (taskId: string) => boolean;
  /** Called once per task excluded because its run branch is already on origin (W1-T534). The real
   *  wiring rides the existing `dispatch.skipped` row with a distinct reason, and no PR number is
   *  available in this window — that IS the defect this closes. INVARIANT: the refusal is a SKIP,
   *  never a terminal state. W1-T1205: fired ALONGSIDE `opts.onFiltered?.(t,
   *  "run-branch-already-pushed")`, which is what makes it visible to the neutral tally too. */
  onSkipRunBranch?: (task: Task) => void;
}

/** The plan's tasks in DISPATCH ORDER (impl-DQ): `priority` first, then declared scope, then a
 *  workstream-aware id order, so file placement no longer sets priority. INVARIANT: determinism is
 *  absolute — the comparator reads only committed content (`priority` and `id`), never file order,
 *  mtime or enumeration order, and the id tiebreak makes it a TOTAL order. Absent `priority` sorts
 *  last. COST: this discards positional signal; `priority:` (W1-T422) succeeds it. */
// Why: the shard-starvation defect this replaces and what sorting by id costs — docs/forensics/drain.md.
export function dispatchOrder(tasks: readonly Task[]): Task[] {
  return [...tasks].sort(compareDispatch);
}

/** Total order: `priority` ascending first (absent sorts last), then {@link undeclaredScopeLast}
 *  (W1-T476), then {@link idOrdinal}'s workstream-aware order as the deterministic tiebreak. */
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

/** W1-T476: 1 when `t.files` is absent or empty, else 0 — an undeclared-scope task sorts LAST in its
 *  priority tier rather than by the accident of its id. `overlappingPaths`' fail-closed treatment is
 *  unchanged; this only stops one such task starving every lane from the queue head.
 *  FALSIFIER: the name is grepped by this task's own acceptance criterion. */
// Why: the measured 1-lane-of-11 starvation (W1-T476) — docs/forensics/drain.md.
function undeclaredScopeLast(t: Task): number {
  return t.files === undefined || t.files.length === 0 ? 1 : 0;
}

/** Workstream-aware id ordinal: `W<workstream>-T<ordinal>` parses into its two numeric parts,
 *  compared workstream first. An id that does not match sorts after every id that does, then
 *  lexicographically via {@link compareDispatch}'s final tiebreak. */
// Why: the trailing-digit accident where W2-T1 outranked W1-T400 — docs/forensics/drain.md.
function idOrdinal(id: string): { workstream: number; ordinal: number } {
  const m = /^W(\d+)-T(\d+)/.exec(id);
  if (!m) return { workstream: Number.MAX_SAFE_INTEGER, ordinal: Number.MAX_SAFE_INTEGER };
  return { workstream: Number(m[1]), ordinal: Number(m[2]) };
}

/** W1-T2397 — the open-sibling observation, fired for a task the pass has ALREADY chosen.
 *  INVARIANT: one emitter for both selectors, which is what stops the drain's single-lane pick and
 *  the daemon's batch pick drifting. A throw is caught: a wrong warn costs one line, and a warn that
 *  cost a dispatch would invert the argument for having it. */
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
    // W1-T2397: observe, then dispatch anyway. Placed AFTER eligibility said yes and BEFORE the task
    // is returned unchanged, so it is structurally incapable of changing the answer.
    observeOpenSibling(t, opts);
    return t;
  }
  return undefined;
}

/** Why the eligibility filter declined a task, first-match — see {@link tallyDispatchFilters}.
 *  Most arms are conditions that used to return silently; every other filter reports through its own
 *  `onXxx` callback. `"run-branch-already-pushed"` (W1-T1205) is reported both ways on purpose,
 *  because nothing is in flight and nothing clears it. `"retired"` (W1-T2474) is `"blocked"`'s own
 *  split: a `blocked` task carrying a `retirement` ruling is refused identically, only named apart.
 *  TRAP: two census tests pin this arm list by slicing the declaration at its FIRST semicolon, so no
 *  comment between the arms may contain one. The falsifiers are
 *  test/queue-head-names-a-circuit-broken-refusal.test.ts and test/status-board.test.ts. */
export type DispatchFilterReason =
  | "already-merged"
  | "verify-not-auto"
  | "blocked"
  | "retired"
  | "unmet-deps"
  | "continued-this-pass"
  // W1-T988: the task names a repo this daemon does not target. Not multi-repo support and not
  // routing — see `taskTargetsRepo`'s own doc.
  | "foreign-repo"
  // W1-T2675 — distinct from "already-merged", and the distinction is the point. That reason means
  // the credit projection SAW a merge, while this one means it could not look, which is not
  // evidence of absence. TRAP: never write a semicolon inside this union — see the doc above.
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

/** Accumulate the filter's declines so an idle daemon can say WHY it is idle. INVARIANT:
 *  FIRST-MATCH, not exhaustive — a task that is both already-merged and `verify != auto` counts only
 *  under `already-merged`, because that is what stopped it. Evaluating every condition would walk
 *  the graph on the hot path to report a reason that was not the blocking one. */
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
    // W1-T988: present in the SNAPSHOT, never in idle-reasons-panel.ts's `IDLE_REASON_ORDER`.
    // TRAP: that asymmetry is load-bearing. The panel returns `kind: "unknown"` the moment any listed
    // key is missing from a row, so adding a key there makes every historical row unreadable.
    "foreign-repo": [],
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

/** The exact per-task eligibility chain {@link nextRunnable} and {@link runnableCandidates} both
 *  apply, factored out so the two can never drift: a task ineligible for solo dispatch is never
 *  offered as a concurrent candidate. Order matters and is preserved verbatim from `nextRunnable`'s
 *  original walk — see the inline comment on each guard. */
/** W1-T988 — the BARE repo name, which is canonical here. Normalisation reduces a slug to its last
 *  path segment and never the reverse, because a task carries no owner to compare against. TRAP: a
 *  guard comparing raw strings would strand every task the moment an operator passed
 *  `--repo owner/name`, which `resolveDaemonTarget` documents as accepted input. */
export function normalizeRepoName(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  const lastSegment = trimmed.slice(trimmed.lastIndexOf("/") + 1);
  return lastSegment.toLowerCase();
}

/** W1-T988 — does this task belong to the repo this daemon targets? A safety guard on a
 *  single-target daemon: not multi-repo support, not routing, not the second checkout those would
 *  need. The failure it closes is a plausible-looking pull request rather than an error — a foreign
 *  task handed to a worker whose worktree is a `remudero` checkout edits the wrong tree and opens a
 *  PR against the wrong repository, with nothing flagging it. INVARIANT: an absent target means NO
 *  GUARD, never refuse-all, because a guard that defaults to refusing stops the fleet. */
// Why: the measured zero `repo` reads that made this reachable (W1-T988) — docs/forensics/drain.md.
export function taskTargetsRepo(taskRepo: string | undefined, targetRepo: string | undefined): boolean {
  if (targetRepo === undefined || targetRepo.trim() === "") return true; // no target ⇒ no guard
  if (taskRepo === undefined || taskRepo.trim() === "") return true; // nothing to compare ⇒ no guard
  return normalizeRepoName(taskRepo) === normalizeRepoName(targetRepo);
}

function isDispatchEligible(plan: Plan, t: Task, isMerged: MergedSet, opts: NextRunnableOpts): boolean {
  const merged: import("./plan.js").MergedResolver = (task) => isMerged(task.id);
  // THE FORMERLY-SILENT DECLINES. `opts.onFiltered` is observation ONLY — every `return false`
  // below is byte-identical to before, in the same order, so no task's dispatchability changes.
  if (isMerged(t.id)) {
    // W1-T951: fires BEFORE `onFiltered`, like every other paired observation on this chain.
    // It never gates, so omitting `isSinglePathCredit` is byte-identical to before it existed.
    if (opts.isSinglePathCredit?.(t.id)) opts.onSinglePathCredit?.(t);
    // W1-T2675: NAME the credit under the same called-alongside, never-gating discipline. `t.status`
    // is never read here — `isMerged(t.id)`, a GitHub-derived read, already decided this.
    const credit = opts.creditFor?.(t.id);
    if (credit) opts.onAlreadyMergedCredit?.(t, credit);
    opts.onFiltered?.(t, "already-merged");
    return false;
  }
  // W1-T2675: THE CREDIT READ FAILED — refuse rather than guess. Placed immediately after the
  // already-merged arm because it answers the same question that arm just answered false to, and
  // ahead of every other filter because admitting a shipped task costs a full PR lifecycle to undo.
  if (opts.isCreditIndeterminate?.(t.id)) {
    opts.onFiltered?.(t, "credit-indeterminate");
    return false;
  }
  // CONTINUED THIS PASS (NON_HALTING_VERDICTS): a continued task is unmerged with an open PR, so
  // every later selection would offer it again — an unbounded re-dispatch inside one drain.
  // `isOpenPr` usually catches it but is optional; this guard needs no reads and cannot be omitted.
  if (opts.excludeIds?.has(t.id)) {
    opts.onFiltered?.(t, "continued-this-pass");
    return false;
  }
  if (t.verify !== "auto") {
    opts.onFiltered?.(t, "verify-not-auto");
    return false;
  }
  if (t.status === "blocked") {
    // W1-T2474: SPLIT AT THE FILTER, NOT AT THE CENSUS. A `blocked` task carrying a `retirement`
    // ruling (plan.ts's `RETIREMENT_REASONS`, W1-T1287) will never be built, rather than being
    // dependency-stalled. Both refuse identically; only the NAME reported to `onFiltered` differs.
    opts.onFiltered?.(t, t.retirement !== undefined ? "retired" : "blocked");
    return false;
  }
  // W1-T988: BEFORE the dependency walk, so a task that is not this daemon's is refused without
  // resolving deps. Exactly as inert as every other decline: it stays eligible for another daemon.
  if (!taskTargetsRepo(t.repo, opts.targetRepo)) {
    opts.onFiltered?.(t, "foreign-repo");
    return false;
  }
  if (unmetDependencies(plan, t, merged).length > 0) {
    opts.onFiltered?.(t, "unmet-deps");
    return false;
  }
  // INDETERMINATE (W1-T119) — checked BEFORE the breaker and the in-flight guard: an indeterminate
  // read says nothing about either, and dispatching risks re-running merged work.
  if (opts.isIndeterminate?.(t.id)) {
    opts.onIndeterminate?.(t);
    return false;
  }
  // PER-TASK DISPATCH CIRCUIT BREAKER (P29(ii)) — checked BEFORE the in-flight guard below: a
  // tripped task halts whatever its latest PR's state happens to be.
  if (opts.isCircuitTripped?.(t.id)) {
    opts.onCircuitBreak?.(t);
    return false;
  }
  // LIFETIME DISPATCH CAP (W1-T271) — checked alongside the streak breaker, never in its place: a
  // task that merges a genuine no-op each time resets the streak count and trips nothing else.
  if (opts.isLifetimeCapExceeded?.(t.id)) {
    opts.onLifetimeCapExceeded?.(t);
    return false;
  }
  const openPrNumber = opts.isOpenPr?.(t.id);
  if (openPrNumber !== undefined) {
    // W1-T177: CONFIRM the cached in-flight snapshot with a fresh read before skipping — a stale
    // OPEN wrongly blocks a runnable task (the #388 fixture: `dispatch.skipped reason='open-pr'`
    // more than six minutes after that PR had merged).
    const liveState = opts.readLiveState?.(t.id, openPrNumber);
    if (liveState !== undefined && liveState !== "OPEN") {
      opts.onStoodDown?.(t, openPrNumber, liveState);
      // W1-T1035: THE STALE-CREDIT DISCRIMINATION. A MERGED state alone cannot say whether this merge
      // credits `t` (exclude) or not (the W1-T177 case, stay admitted) — only
      // `opts.isLiveMergeCredited` tells them apart. Checked only for MERGED: a CLOSED PR credits nobody.
      if (liveState === "MERGED" && opts.isLiveMergeCredited?.(t.id, openPrNumber)) {
        opts.onStaleCreditExcluded?.(t, openPrNumber, liveState);
        // EXCLUDED, NOT ADMITTED: the live merge already finishes this task. Returning false also
        // keeps it out of `eligible`, so it can never become another candidate's `blocked_by`.
        return false;
      }
    } else {
      opts.onSkip?.(t, openPrNumber);
      return false; // IN-FLIGHT (or unreadable — fail OPEN) — never a duplicate fresh build.
    }
  }
  // W1-T534: the STALE-ABSENT window `isOpenPr` structurally cannot see. Checked LAST, so a task
  // already confirmed in-flight is decided by the richer check first — this only ever adds refusals.
  if (opts.hasPushedRunBranch?.(t.id)) {
    opts.onSkipRunBranch?.(t);
    // W1-T1205: ALSO the named DispatchFilterReason. `onSkipRunBranch` alone left this exclusion
    // reachable only through a ledger row, invisible to any reader that consults the tally.
    opts.onFiltered?.(t, "run-branch-already-pushed");
    return false; // A run branch for this id is already on origin — never a duplicate fresh build.
  }
  return true;
}

/** Up to `limit` runnable tasks, packed disjointness-first ({@link packDisjointFirst}, W1-T476) over
 *  {@link dispatchOrder} — the multi-candidate generalization of {@link nextRunnable} for the
 *  concurrent dispatcher (W1-T171/W1-T172). `limit <= 0` yields an empty array. INVARIANT: it applies
 *  the EXACT chain {@link isDispatchEligible} applies. It does not decide overlap ADMISSION — that
 *  stays dispatch-overlap.ts's — but consults the same predicate to choose WHICH candidates to
 *  offer, so a disjoint set is not truncated away first. */
export function runnableCandidates(plan: Plan, isMerged: MergedSet, limit: number, opts: NextRunnableOpts = {}): Task[] {
  if (limit <= 0) return [];
  const eligible: Task[] = [];
  for (const t of dispatchOrder(plan.tasks)) {
    if (isDispatchEligible(plan, t, isMerged, opts)) eligible.push(t);
  }
  const collected = packDisjointFirst(eligible, limit, opts.observedByTask ?? NO_OBSERVED_SCOPE);
  // W1-T2397: observe, then dispatch anyway — the same placement `nextRunnable` uses, one level over,
  // so it cannot alter the batch. This is the DAEMON's selector: `runDaemon` calls this one.
  for (const t of collected) observeOpenSibling(t, opts);
  return collected;
}

/** W1-T476's greedy disjointness-first pack: fills up to `limit` slots from `eligible` (already in
 *  {@link dispatchOrder}), each slot preferring the earliest remaining candidate that stays
 *  `files:`-disjoint from everything collected — checked via the real `partitionByFileOverlap`, never
 *  a re-derived glob comparison — and otherwise falling back to the next in dispatchOrder.
 *  INVARIANT (determinism): the scan always takes the first match in `remaining`'s current order.
 *  INVARIANT (stability containment): with no two candidates pairwise disjoint, the result is
 *  byte-identical to plain truncation. The pack never reorders what it cannot improve. */
// Why: the measured 1/1/1 admissions plain truncation produced at lanes 2/3/4 — docs/forensics/drain.md.
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
 *  overlaps none of `collected`'s — one pairwise `partitionByFileOverlap` check per collected task,
 *  so an undeclared-scope task never passes once anything is collected. `observedByTask` must be the
 *  SAME map the caller later hands that partition; see {@link runnableCandidates}. */
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
  /** W1-T172: the queue governor's WIP ceiling left ZERO lane headroom this tick. Runnable work may
   *  exist — distinct from `no_runnable`. Only reachable via {@link runDrainLanes}. */
  | "wip_deferred"
  /** W1-T290: `/usage` was unreadable on more than {@link UNREADABLE_DEGRADED_LIMIT} CONSECUTIVE
   *  ticks. Distinct from `headroom_exhausted`, which is a confirmed at/near-limit reading. */
  | "headroom_degraded"
  /** W1-T317: the DAILY COST CEILING (`checkCostGovernor`, sweep.ts) reports the day's spend at/over
   *  `policy.dailyCostCeilingUsd`. Drainage is unaffected; a later pass re-derives and resumes. */
  | "cost_governor_deferred"
  /** W1-T321 (the W1-T121 23-open-PR incident): the open-PR count is at/over `policy.wipLimit`.
   *  Distinct from `laneDispatchBudget`, which only SIZES a still-open pass rather than stopping it. */
  | "queue_governor_deferred";

export interface DrainOpts {
  until?: string;
  max?: number;
  /** ≥ this % on any window ⇒ headroom_exhausted (default HEADROOM_LIMIT_PCT). */
  headroomLimitPct?: number;
  /** A CURATED selection (W1-T140): an explicit ordered list of task ids. When present, dispatch
   *  iterates exactly this list in this order, in place of {@link nextRunnable}'s DAG scan; an id it
   *  omits never dispatches. An INPUT to the existing loop, not a reimplementation — build it with
   *  {@link applyCuratedSelection} so `max` stays consistent with the selection's `depth`. */
  curated?: string[];
  /** W1-T172 PARALLEL DISPATCH — concurrent lanes per pass (`SweepPolicy.dispatchLanes`, one
   *  threshold home). Omitted or <= 1 runs {@link runDrain}'s single-task loop byte-for-byte. */
  laneCount?: number;
  /** W1-T172: the queue governor's WIP ceiling (`SweepPolicy.wipLimit`, W1-T121), consulted alongside
   *  `laneCount` on the multi-lane path. THE GOVERNOR IS THE CEILING, NOT A SUGGESTION: a pass never
   *  dispatches past `min(laneCount, wipLimit - open count)`. Never consulted on the single-lane path. */
  wipLimit?: number;
  /** W1-T290: the headroom governor switch — the same posture `DaemonOpts.headroomEnabled` reads
   *  (config.ts's `resolveHeadroomEnabled`, operator ruling fb-1784894405468-a4153e). INVARIANT: it
   *  gates ONLY the unreadable-degraded ceiling below; the at/near-limit stop is unconditional on
   *  both loops. Defaults to true, so an unconfigured caller is unchanged. */
  headroomEnabled?: boolean;
  /** W1-T290: CONSECUTIVE unreadable `/usage` reads tolerated before `headroom_degraded` (default
   *  {@link UNREADABLE_DEGRADED_LIMIT}, shared with the daemon). One good read resets the count. */
  unreadableDegradedLimit?: number;
}

/** A curated selection from the drain preview panel (W1-T140 limb 2): an ordered subset of the
 *  would-drain queue, plus how many of them to dispatch this drain (the panel's depth control). */
export interface CuratedSelection {
  /** Ordered subset of task ids — EXACTLY this order; ids not listed here never dispatch. */
  taskIds: string[];
  /** How many of `taskIds`, from the front, this drain should actually attempt. */
  depth: number;
}

/** Fold a {@link CuratedSelection} into {@link DrainOpts}: `curated` becomes `taskIds` truncated to
 *  `depth`, and `max` is capped to match so `max_reached` fires exactly at the curated boundary. */
export function applyCuratedSelection(opts: DrainOpts, selection: CuratedSelection): DrainOpts {
  const curated = selection.taskIds.slice(0, Math.max(0, selection.depth));
  const max = opts.max !== undefined ? Math.min(opts.max, curated.length) : curated.length;
  return { ...opts, curated, max };
}

/** Default iteration cap — a sane bound, never infinite. W1-T253: it mirrors `plan/policy.yaml`'s
 *  `drain.max` but stays a LITERAL, because daemon.ts imports this module at the value level and its
 *  own header requires that it never touch the filesystem (Rule 16). The real CLI entries load
 *  `drain.max` and thread it in, so this constant is dead on that path (test/policy-consumers.test.ts). */
export const DEFAULT_MAX = 10;

export interface DrainSummary {
  attempted: string[];
  merged: string[];
  /** Tasks that did NOT merge and did NOT halt the drain — see {@link NON_HALTING_VERDICTS}.
   *  INVARIANT: separate from `merged` on purpose. A continued task's work is pushed but not merged,
   *  so crediting it here would make its dependents dispatchable against work that has not landed.
   *  Optional for diff hygiene only — every reader treats absent and empty the same. */
  continued?: Array<{ taskId: string; verdict: string; prUrl?: string }>;
  stopReason: StopReason;
  /** Human detail: the blocked task + verdict, the reset time, the error, etc. */
  stopDetail?: string;
  /** How many candidates the FINAL selection declined as INDETERMINATE (W1-T119) — a gateway that
   *  could not ANSWER, never a task that is genuinely ineligible. Reset each pass. A `no_runnable`
   *  with this at 0 is a genuinely empty frontier; the same verdict with it non-zero is a fleet that
   *  could not SEE. It is a number for `drainCommand`, and changes nothing about what is dispatched. */
  indeterminateDeclines?: number;
  costUsd: number;
  resumeCommand: string;
}

/** Verdicts that are NOT `merged` and yet must NOT stop the drain. The header justifies
 *  stop-on-block as "a blocked task's DEPENDENTS would build on missing work", and each member is
 *  here because that justification does not apply to it:
 *    - `blocked_ci`          — the work was pushed and the PR left open.
 *    - `no_pr`               — the task did not advance, so dependents face the state they started
 *                              from, and `unmetDependencies` protects them regardless.
 *    - `blocked_illformed`   — the linter refused BEFORE dispatch, at `costUsd: 0`.
 *    - `task_already_merged` — the task is DONE, so its dependents CAN build on it.
 *  INVARIANT: nothing is credited by being here. Membership means "keep going", never "this task is
 *  done" — `continued` is deliberately not `merged`, and the dependency filter is unchanged.
 *  Re-dispatch stays bounded by `isDispatchBreakerTripped` and `isLifetimeDispatchCapExceeded`
 *  (status.ts), and within a pass `excludeIds` never re-offers a continued task.
 *  NOT FIXED HERE: `blocked_ci` fires on healthy PRs because `checkWaitStalled`'s window is a
 *  30-second elapsed bound against a `ci` job that needs minutes. This set makes that misfire cheap
 *  rather than rarer. */
// Why: the four verdicts argued one by one, the reversal on `no_pr`, and the measured surrendered
// budgets (W1-T388, W1-T392, W1-T393, W1-T24) — docs/forensics/drain.md.
export const NON_HALTING_VERDICTS: ReadonlySet<string> = new Set(["blocked_ci", "no_pr", "blocked_illformed", "task_already_merged"]);

/** Should this result stop the drain? `merged` never does; a non-merged verdict does unless it is in
 *  {@link NON_HALTING_VERDICTS}. Extracted rather than inlined at the two loop sites so both decide
 *  with ONE predicate — a halt rule that differed between them would be invisible until a lane count
 *  changed, and those two paths drifting apart is a documented hazard in this file. */
export function haltsDrain(result: { merged: boolean; verdict: string }): boolean {
  if (result.merged) return false;
  return !NON_HALTING_VERDICTS.has(result.verdict);
}

/** The `stopDetail` for a `no_runnable` stop: was the frontier READ AND EMPTY, or merely UNREADABLE?
 *  Both end the drain the same way and, until this existed, printed the same single word. A COUNT,
 *  NOT A SHARE: the drain loops wire no `onFiltered`, so there is no denominator, and {@link
 *  DispatchFilterReason} has no indeterminate bucket to supply one. INVARIANT: it always returns a
 *  sentence, including for zero. There is NO file-overlap arm, deliberately: the lanes loop's third
 *  `no_runnable` is unreachable with non-empty `candidates`, and a sentence for a population nothing
 *  can observe is a bound that fires on a healthy state. */
export function noRunnableDetail(counts: { indeterminate: number }): string {
  if (counts.indeterminate > 0) {
    return `${counts.indeterminate} candidate(s) declined as INDETERMINATE: the frontier could not be READ (the GitHub gateway did not answer), so this is not evidence of an empty queue`;
  }
  return "frontier read cleanly: 0 candidates declined as indeterminate, so the queue is genuinely empty";
}

/** The `headroom_degraded` stop detail — what an operator reads when a drain surrenders its budget.
 *  TRAP: it does not claim the probe was unreadable, because this code cannot see that.
 *  `readUsageSnapshot` fails in two ways it keeps apart (`UsageProbeFailureStage` is
 *  `"spawn" | "parse"`) and both return undefined, so only one bit survives to here, and naming a
 *  stage over that bit would point an operator at a broken API when the fault may be a parser. So it
 *  names the row that DOES know: `usage.probe_failed`, written durably by `ledgerUsageProbeFailure`
 *  (run-task.ts). INVARIANT: one builder, two call sites, because a hand-copied sentence at each is
 *  the drift this repo argues against. FALSIFIER: test/headroom-degraded-message.test.ts. */
export function headroomDegradedDetail(consecutive: number, limit: number): string {
  return (
    `usage probe failed ${consecutive}x consecutively (limit ${limit}) — ` +
    `see the usage.probe_failed ledger rows for the stage (spawn or parse) and the reason`
  );
}

/** The ordered plan of what a drain WOULD run (for `--dry-run`), assuming each task merges: the
 *  merge set is simulated forward so sequencing and deps are honoured. Runs nothing. */
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

/** One task in the drain PREVIEW (W1-T140 limb 1): the would-drain queue as a task card.
 *  `description` reuses {@link Task.note}, because `plan/tasks.yaml`'s per-task `rationale:` is
 *  Architect-only narrative that `loadPlanFromYaml` deliberately never parses onto `Task`. */
export interface DrainPreviewCard {
  id: string;
  title: string;
  description: string;
  /** Incoming edges — this task's own `depends_on`. */
  dependsOn: DependencyEdge[];
  /** Outgoing edges — tasks that DIRECTLY declare this task as a dependency. Direct, not transitive:
   *  a card's dependents are the immediate next hop, matching `dependsOn`'s own direct-edge shape. */
  dependents: DependencyEdge[];
}

/** The would-drain queue as ordered task cards (W1-T140 limb 1): {@link plannedSequence}'s ids, each
 *  resolved to a card the curation panel can render without a second query, in that same order. */
export function buildDrainPreview(plan: Plan, isMerged: MergedSet, opts: DrainOpts = {}): DrainPreviewCard[] {
  const seq = plannedSequence(plan, isMerged, opts);

  // Direct reverse edges (taskId -> the ids that declare it as a dependency), built once over the
  // whole plan. Mirrors plan.ts's `transitiveDependents` reverse map but stays one hop deep.
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

/** The next task to dispatch from a CURATED selection (W1-T140), in the caller's exact order: the
 *  first id not yet attempted, not merged, and not in flight (the same skip semantics as {@link
 *  nextRunnable}). An unknown id is skipped rather than thrown — curation is validated at its edge. */
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
    // Same indeterminate-read semantics as the natural path (W1-T119): a curation-panel selection
    // is still dispatch, and must not re-run work whose own GitHub read failed.
    if (opts.isIndeterminate?.(id)) {
      opts.onIndeterminate?.(t);
      continue;
    }
    // Same circuit-breaker semantics as the natural path (P29(ii)): a curation-panel selection
    // must not spin a tripped task any more than the DAG scan would.
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

/** Build the post-drain rundown (W1-T141): one classified outcome line per `summary.attempted` task,
 *  in attempt order — the pull-view counterpart to digest.ts's push summary. A merged id classifies
 *  `"merged"`; a non-merged one classifies `"escalated"` when the ledger carries an
 *  `escalation.issue_opened` line naming it (escalate.ts), else `"blocked"`. Lookup is task-id-keyed,
 *  latest-wins — the same dedup key ops.ts and digest.ts use. `ledgerLines` defaults to none, so a
 *  caller with no ledger still gets a correct merged/blocked split. */
export function buildRundown(summary: DrainSummary, ledgerLines: ReadonlyArray<Record<string, unknown>> = []): RundownLine[] {
  const merged = new Set(summary.merged);
  const escalationByTask = new Map<string, { issueUrl: string; class: string }>();
  for (const l of ledgerLines) {
    if (l.step === "escalation.issue_opened" && typeof l.task_id === "string" && typeof l.issue_url === "string") {
      escalationByTask.set(l.task_id, { issueUrl: l.issue_url, class: String(l.class ?? "?") });
    }
  }
  // A CONTINUED TASK MUST CARRY ITS OWN DETAIL, NEVER THE DRAIN'S `stopDetail`. Before
  // NON_HALTING_VERDICTS existed only the LAST attempted id could be non-merged. Now an earlier id
  // can be too, and attaching `stopDetail` blindly prints one task's line against another's verdict.
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
  /** The in-flight guard (W1-T80): the OPEN PR number for a task, re-derived from the SAME
   *  projection `refreshMerged` just built, never a second GitHub read path. Optional. */
  isOpenPr?: OpenPrCheck;
  /** W1-T2675 — the credit-read-failed probe, resolved by the CALLER from the projection
   *  `refreshMerged` builds, exactly as `isOpenPr` is: this module never reads GitHub. Optional. */
  isCreditIndeterminate?: (taskId: string) => boolean;
  /** W1-T2397 — the open-sibling OBSERVATION's two halves, forwarded verbatim to {@link
   *  NextRunnableOpts.openSiblingBuildFor} / {@link NextRunnableOpts.onOpenSiblingBuild}. INVARIANT:
   *  these are not `isOpenPr` and must not be folded into it — they are consulted only after a task
   *  has been chosen and cannot change what is dispatched. */
  openSiblingBuildFor?: NextRunnableOpts["openSiblingBuildFor"];
  onOpenSiblingBuild?: NextRunnableOpts["onOpenSiblingBuild"];
  /** W1-T177: an OPTIONAL fresh, live re-read of one candidate in-flight PR's GitHub state — see
   *  {@link NextRunnableOpts.readLiveState} for the full contract. Optional. */
  readLiveState?: (taskId: string, prNumber: number) => string | undefined;
  /** W1-T1035: an OPTIONAL fresh re-check of whether a just-observed MERGED PR credits the task it
   *  was opened for — see {@link NextRunnableOpts.isLiveMergeCredited} for the discrimination. */
  isLiveMergeCredited?: (taskId: string, prNumber: number) => boolean;
  /** W1-T916 — raw `git ls-remote --heads origin 'run-*'` output, read ONCE PER PASS and parsed by
   *  {@link runBranchTaskIds} into the closure {@link NextRunnableOpts.hasPushedRunBranch} consumes.
   *  INVARIANT: injected rather than executed here, because THIS MODULE IS PURE. TRAP: it is a
   *  READER, not a predicate — a predicate would satisfy the type while making the per-candidate
   *  call the design refuses. Optional. */
  readPushedRunBranches?: () => string;
  /** W1-T1207: raw `pulls?state=closed` rows for the same run-branch sweep above — ONE batched,
   *  paginated read per pass, parsed by {@link closedUnmergedRunBranchTaskIds} into the set the
   *  caller subtracts from `readPushedRunBranches`' blocking set. INVARIANT: this FAILS TOWARD STILL
   *  BLOCKING, the opposite of `readPushedRunBranches`' own fail-open — a throw degrades to `""`, an
   *  empty exclusion set, so every pushed branch keeps blocking. A false block delays one task; a
   *  false dispatch races a live run. Optional. */
  // Why: the five operator-closed exclusions that motivated it (W1-T1207) — docs/forensics/drain.md.
  readClosedRunBranchPrs?: () => string;
  /** W1-T2286: the same {@link ObservedScopeByTask} threaded to {@link
   *  NextRunnableOpts.observedByTask} for the pack step AND to `partitionByFileOverlap`'s direct call
   *  in {@link runDrainLanes} — one dependency read twice, so the pack and the partition never
   *  disagree about a task's effective scope. Optional; both fall back to `NO_OBSERVED_SCOPE`. */
  observedByTask?: ObservedScopeByTask;
  /** The per-task dispatch CIRCUIT BREAKER (P29(ii)), re-derived from the ledger each call — the
   *  same freshness contract as `refreshMerged`/`isOpenPr`. Optional. */
  isCircuitTripped?: (taskId: string) => boolean;
  /** Called once per task whose breaker trips this tick — the real wiring escalates one deduped
   *  needs-human issue naming the loop. */
  onCircuitBreak?: (task: Task) => void;
  /** What the breaker SAW, from the same memoised evaluation the predicates answered from
   *  (run-task.ts's `breakerGateFor().detailFor`), spread onto the refusal row. Optional. */
  breakerDetail?: (taskId: string) => Record<string, unknown> | undefined;
  /** W1-T316 (wiring W1-T271's predicate): THE LIFETIME DISPATCH CAP, re-derived from the ledger each
   *  call and, unlike the streak breaker, never reset by a `pr.opened` line. Optional. */
  isLifetimeCapExceeded?: (taskId: string) => boolean;
  /** Called once per task excluded by the lifetime cap — mirrors `onCircuitBreak`'s contract, so
   *  this exclusion is never a silent skip. */
  onLifetimeCapExceeded?: (task: Task) => void;
  /** W1-T317 (wiring `checkCostGovernor`, sweep.ts): THE DAILY COST CEILING, re-derived each call.
   *  One answer per tick rather than per task, so it is consulted directly in the loop beside
   *  `checkStop`/`checkPause`/headroom. INVARIANT: never consulted from `runSweep` or its deps —
   *  stranding in-flight work to save money is a worse failure than the spend. Optional. */
  checkCostGovernor?: () => CostGovernorResult | undefined;
  /** W1-T321 (wiring `checkQueueGovernor`, sweep.ts, the W1-T121 23-open-PR incident): THE WIP
   *  CEILING, re-derived from the open-PR count each call, consulted before `nextRunnable` is called,
   *  and it STOPS the pass outright. Distinct from `openPrCount` below, which only SIZES a pass.
   *  INVARIANT: never consulted from `runSweep` or its deps — drainage must never be gated. Optional. */
  checkQueueGovernor?: () => QueueGovernorResult | undefined;
  /** W1-T119: true when a task's own GitHub read is INDETERMINATE, re-derived from the SAME
   *  projection `refreshMerged` just built — the same freshness contract as `isOpenPr`. Optional. */
  isIndeterminate?: (taskId: string) => boolean;
  /** Called once per task excluded because its own read is indeterminate. */
  onIndeterminate?: (task: Task) => void;
  /** Run ONE task through the existing run-task path (default = runTask). */
  runOne: (taskId: string) => Promise<RunResult>;
  /** Read current /usage; `undefined` ⇒ unavailable (the headroom check is skipped). MAY return a
   *  promise: widened rather than made `async`, so every existing synchronous supplier keeps working
   *  byte-for-byte. The daemon needs it because the SDK reading is a control request on a session. */
  readUsage?: () => UsageSnapshot | undefined | Promise<UsageSnapshot | undefined>;
  /** Fleet control (W1-T11, MASTER-PLAN §4A/§4B): a defined return means a hard STOP, and the string
   *  is the detail. Checked FIRST every tick, so it takes precedence over PAUSE and wins any race. */
  checkStop?: () => string | undefined;
  /** Fleet control (W1-T11): a defined return means a graceful PAUSE. Checked between iterations only,
   *  AFTER `runOne` resolves, so an in-flight task always completes and no new spawn follows. */
  checkPause?: () => string | undefined;
  /** One ledger line per task + terminal reason (reuses run-task's ledger). */
  log?: (step: string, extra?: Record<string, unknown>) => void;
  /** W1-T172: the CURRENT observed open-PR count — the queue governor's other input alongside
   *  `DrainOpts.wipLimit`. Re-derive it fresh each call, counting OPEN entries in the SAME projection
   *  `refreshMerged` just built, never a second GitHub read path. Only used on the multi-lane path. */
  openPrCount?: () => number;
}

/** The drain loop. Deterministic, with no LLM decisions. Each iteration: re-derive status, check
 *  headroom, pick the next runnable, run it, and stop on any halting verdict. `opts.laneCount >= 2`
 *  hands off to {@link runDrainLanes}, entirely separate code so this loop cannot drift under lane
 *  changes; omitted or <= 1 runs the single-task loop below. */
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
  /** How many candidates the CURRENT pass declined as indeterminate — a gateway that could not
   *  ANSWER, never a task that is genuinely ineligible. Counted so the terminal can say why it
   *  stopped: a throttled gateway and an empty frontier both end in `no_runnable`. */
  let indeterminateDeclines = 0;
  // W1-T290: the daemon's bounded-degraded ceiling, ported — CONSECUTIVE unreadable `/usage`
  // reads, not any-unreadable. Reset to 0 on any successful read.
  let consecutiveUnreadable = 0;
  const headroomEnabled = opts.headroomEnabled ?? true;
  const unreadableDegradedLimit = opts.unreadableDegradedLimit ?? UNREADABLE_DEGRADED_LIMIT;
  // BREAKER ESCALATION DEDUP (P29(ii)): the selectors are re-invoked every tick, so a task that stays
  // tripped would be re-escalated on every tick, violating "exactly one escalation". This set bounds
  // the CALLBACK to the first observation; the predicate still excludes the task every tick.
  const circuitEscalated = new Set<string>();
  // LIFETIME CAP ESCALATION DEDUP (W1-T316), mirroring `circuitEscalated` above: bounds the
  // callback to the first observation; the predicate itself still runs every tick.
  const lifetimeCapEscalated = new Set<string>();

  const summary = (stopReason: StopReason, stopDetail?: string): DrainSummary => {
    // `indeterminateDeclines` is emitted ALWAYS, including as 0. Omitting it when zero would put
    // the ambiguity straight back — absent would mean either "nothing was indeterminate" or "this
    // build does not count". An explicit 0 states that the frontier was READ and found empty.
    const s: DrainSummary = { attempted, merged, continued, stopReason, stopDetail, indeterminateDeclines, costUsd, resumeCommand: resumeCommand(opts) };
    log("drain.summary", { ...s });
    return s;
  };

  // W1-T916 — ONE SWEEP PER PASS, NEVER ONE PER CANDIDATE. Resolved before the dispatch loop so
  // every iteration tests set membership rather than making a round trip.
  const pushedRunBranches = deps.readPushedRunBranches
    ? runBranchTaskIds(deps.readPushedRunBranches())
    : undefined;
  // W1-T1207 — the same hoist, for the arm that stops a leftover branch blocking forever: ids whose
  // pushed run branch's PR is CLOSED AND UNMERGED. Subtracted below, so an OPEN/DRAFT PR (or no PR)
  // still blocks exactly as before.
  const closedUnmergedRunBranches = deps.readClosedRunBranchPrs
    ? closedUnmergedRunBranchTaskIds(deps.readClosedRunBranchPrs())
    : undefined;
  while (attempted.length < max) {
    // FLEET CONTROL (W1-T11): checked FIRST every tick, so a hard STOP wins any race against PAUSE.
    // Neither check can interrupt a running task: `runOne` is awaited to completion before the loop
    // returns here, which is the drain-and-hold guarantee.
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

    // HEADROOM: never hammer a nearly-exhausted pool. An at/near-limit reading STOPS the drain with
    // the reset time reported. An unreadable read is BOUNDED best-effort (W1-T290): within
    // `unreadableDegradedLimit` CONSECUTIVE misses the drain still dispatches, beyond it stops rather
    // than dispatching blind, and one successful read resets the count. Gated by `headroomEnabled`.
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
        // GOVERNOR DISABLED (operator ruling fb-1784894405468-a4153e): an unreadable read is ABSENT
        // TELEMETRY, never a hold. Reset the counter so a later enable starts clean.
        consecutiveUnreadable = 0;
      }
    }

    // DAILY COST CEILING (W1-T317): a global gate, checked here in the same position as headroom,
    // before `nextRunnable` is called. STOPS the pass outright; drainage never runs through this loop.
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

    // QUEUE GOVERNOR / WIP CEILING (W1-T321): a global gate, checked in the same position as the cost
    // governor. STOPS the pass outright; drainage never runs through this loop.
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
      // W1-T2286: unused by this single-lane path, carried only so `NextRunnableOpts` is filled the
      // same way at both `skipOpts` sites. See `DrainDeps.observedByTask`.
      observedByTask: deps.observedByTask,
      // W1-T916: `pushedRunBranches` is resolved ONCE above this loop, so this closure is a
      // set-membership test and never a round trip. W1-T1207: `&& !closedUnmergedRunBranches?.has(id)`
      // is the whole fix — a branch keeps blocking unless its PR is CLOSED AND UNMERGED. With no
      // reader injected both are undefined and the predicate is byte-identical to before.
      ...(pushedRunBranches
        ? {
            hasPushedRunBranch: (id: string) => pushedRunBranches.has(id) && !closedUnmergedRunBranches?.has(id),
            // RIDES THE EXISTING ROW (W1-T534): `dispatch.skipped` with its own reason, never a new
            // step. The task is not marked done and burns no strike — it is offered again once the
            // branch is gone, so this is a skip and never a terminal state.
            onSkipRunBranch: (t: Task) =>
              log("dispatch.skipped", { task: t.id, reason: "run-branch-already-pushed" }),
          }
        : {}),
      // IN-FLIGHT (W1-T80): a legible skip on console and ledger, then the drain proceeds — an open
      // PR must not halt the drain the way a block does.
      onSkip: (t, prNumber) => log("dispatch.skipped", { task: t.id, reason: "open-pr", pr_number: prNumber }),
      // W1-T177: wrap the injected reader so a FAILED read is LEDGERED here. It still resolves to
      // undefined, so `nextRunnable`'s fail-open contract is unchanged; the failure is just legible.
      readLiveState: deps.readLiveState
        ? (taskId, prNumber) => {
            const state = deps.readLiveState!(taskId, prNumber);
            if (state === undefined) log("dispatch.live_state_indeterminate", { task: taskId, pr_number: prNumber });
            return state;
          }
        : undefined,
      // W1-T177: the cached in-flight snapshot was stale, so this task is NOT blocked. Ledgered
      // distinctly, naming the observed terminal state rather than the misleading "open-pr" reason
      // a stale read produced (the #388 fixture).
      onStoodDown: (t, prNumber, state) =>
        log("dispatch.stood_down", { task: t.id, pr_number: prNumber, state, reason: "cached in-flight read was stale" }),
      // W1-T1035: the fresh MERGED read ALSO credits this task — the credit projection was simply
      // behind. Ledgered under its own step, alongside `dispatch.stood_down`, so an operator can
      // tell "stood down, still runnable" from "stood down, now excluded".
      isLiveMergeCredited: deps.isLiveMergeCredited,
      onStaleCreditExcluded: (t, prNumber, state) =>
        log("dispatch.stale_credit_excluded", {
          task: t.id,
          pr_number: prNumber,
          state,
          reason: "credit projection was stale — the live merge already credits this task",
        }),
      isIndeterminate: deps.isIndeterminate,
      // INDETERMINATE (W1-T119): a legible ledger line every tick it is consulted, then the drain
      // proceeds — a throttled read on one task must not stall everything else dispatchable.
      onIndeterminate: (t) => {
        log("dispatch.indeterminate", { task: t.id, ...deps.breakerDetail?.(t.id) });
        // COUNTED, not merely logged. This ledger line has always existed; what did not exist was
        // any way for the TERMINAL to say the frontier was unreadable rather than empty.
        indeterminateDeclines++;
        deps.onIndeterminate?.(t);
      },
      isCircuitTripped: deps.isCircuitTripped,
      // CIRCUIT BREAKER (P29(ii)): a legible ledger line every tick it is consulted, but the caller's
      // escalation hook fires AT MOST ONCE per task id per drain run. The drain proceeds, never halts.
      onCircuitBreak: (t) => {
        log("dispatch.circuit_broken", { task: t.id, ...deps.breakerDetail?.(t.id) });
        if (!circuitEscalated.has(t.id)) {
          circuitEscalated.add(t.id);
          deps.onCircuitBreak?.(t);
        }
      },
      isLifetimeCapExceeded: deps.isLifetimeCapExceeded,
      // LIFETIME DISPATCH CAP (W1-T316/W1-T271): a legible ledger line every tick, with the
      // caller's escalation hook fired at most once per task id per drain run.
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
    // CURATION (W1-T140): a curated selection overrides the natural DAG scan entirely. RESET PER
    // SELECTION, NOT ACCUMULATED: the terminal's question is about the pass that actually GAVE UP,
    // not a gateway hiccup three passes ago that has since cleared.
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
      // CONTINUED, NOT CREDITED (see NON_HALTING_VERDICTS): the drain keeps its remaining budget, but
      // the task is NOT added to `merged`, so the dependency filter still refuses its dependents.
      // None of these verdicts advanced the task, so none may credit it.
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
// W1-T172 — PARALLEL DISPATCH. Ratifies P19's dispatch half (DECISIONS.md 2026-07-21): N lanes bounded
// by the governor's WIP limit, with W1-T80's dedup and W1-T149's breaker reused unchanged through
// `runnableCandidates`, and W1-T171's `partitionByFileOverlap` adding the across-candidate check the
// single-task loop never needed. Little's law is the argument one layer up: lanes raise the RATE at
// which the governor's bounded WIP fills, never the bound itself.
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

/** THE GOVERNOR IS THE CEILING, NOT A SUGGESTION: how many tasks a pass may dispatch this tick —
 *  `min(laneCount, wipLimit - openPrCount)`, floored at 0. Omitting either governor input leaves it
 *  bounded by `laneCount` alone, the "an un-wired site behaves as before" contract every optional
 *  guard here carries. Pure, no I/O, never negative. */
export function laneDispatchBudget(input: LaneBudgetInput): number {
  const lanes = Math.max(0, input.laneCount);
  if (input.wipLimit === undefined || input.openPrCount === undefined) return lanes;
  const headroom = Math.max(0, input.wipLimit - input.openPrCount);
  return Math.min(lanes, headroom);
}

/** The concurrent-lane pass loop (W1-T172), entered only via {@link runDrain} when
 *  `opts.laneCount >= 2`. Each pass: the same per-tick checks as the single-lane loop → this pass's
 *  lane BUDGET ({@link laneDispatchBudget}) → up to `budget` candidates from {@link
 *  runnableCandidates}, applying the EXACT per-task guards the single-lane path applies → partitioned
 *  for `files:` overlap across the co-dispatched set → the survivors run concurrently.
 *  INVARIANT: `Promise.allSettled`, never `Promise.all`, whose first rejection would abort every
 *  sibling still in flight. LANE-LOCAL BLOCK SEMANTICS: one lane's block or throw never halts,
 *  cancels or races ahead of its siblings, and every result is recorded before the pass decides. On
 *  any block or lane failure the WHOLE drain stops afterward, at pass granularity. */
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
  /** How many candidates the CURRENT pass declined as indeterminate — a gateway that could not
   *  ANSWER, never a task that is genuinely ineligible. Counted so the terminal can say why it
   *  stopped: a throttled gateway and an empty frontier both end in `no_runnable`. */
  let indeterminateDeclines = 0;
  // Same escalation-dedup contract as the single-lane loop: bounds the CALLBACK to this drain's
  // first observation of each tripped id, across every pass.
  const circuitEscalated = new Set<string>();
  // Same escalation-dedup contract, for the lifetime cap (W1-T316/W1-T271).
  const lifetimeCapEscalated = new Set<string>();
  // W1-T290: the same bounded-degraded ceiling as the single-lane loop. BOTH sites carry it, or the
  // `--lanes` path stays the latent fail-open this task closes.
  let consecutiveUnreadable = 0;
  const headroomEnabled = opts.headroomEnabled ?? true;
  const unreadableDegradedLimit = opts.unreadableDegradedLimit ?? UNREADABLE_DEGRADED_LIMIT;

  const summary = (stopReason: StopReason, stopDetail?: string): DrainSummary => {
    // `indeterminateDeclines` is emitted ALWAYS, including as 0. Omitting it when zero would put
    // the ambiguity straight back — absent would mean either "nothing was indeterminate" or "this
    // build does not count". An explicit 0 states that the frontier was READ and found empty.
    const s: DrainSummary = { attempted, merged, continued, stopReason, stopDetail, indeterminateDeclines, costUsd, resumeCommand: resumeCommand(opts) };
    log("drain.summary", { ...s });
    return s;
  };

  // W1-T916 — ONE SWEEP PER PASS, NEVER ONE PER CANDIDATE. Resolved before the dispatch loop so
  // every iteration tests set membership rather than making a round trip.
  const pushedRunBranches = deps.readPushedRunBranches
    ? runBranchTaskIds(deps.readPushedRunBranches())
    : undefined;
  // W1-T1207 — the same hoist, for the arm that stops a leftover branch blocking forever: ids whose
  // pushed run branch's PR is CLOSED AND UNMERGED. Subtracted below, so an OPEN/DRAFT PR (or no PR)
  // still blocks exactly as before.
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

    // QUEUE GOVERNOR / WIP CEILING (W1-T321) — see the single-lane loop's identical branch. Distinct
    // from `openPrCount`/`laneDispatchBudget` below, which only SIZES this pass; this stops it.
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
      // W1-T2286: the SAME map handed to `partitionByFileOverlap` below — see
      // `DrainDeps.observedByTask` for why the pack step and the real partition must not disagree.
      observedByTask: deps.observedByTask,
      // W1-T916: `pushedRunBranches` is resolved ONCE above this loop, so this closure is a
      // set-membership test and never a round trip. W1-T1207: `&& !closedUnmergedRunBranches?.has(id)`
      // is the whole fix — a branch keeps blocking unless its PR is CLOSED AND UNMERGED. With no
      // reader injected both are undefined and the predicate is byte-identical to before.
      ...(pushedRunBranches
        ? {
            hasPushedRunBranch: (id: string) => pushedRunBranches.has(id) && !closedUnmergedRunBranches?.has(id),
            // RIDES THE EXISTING ROW (W1-T534): `dispatch.skipped` with its own reason, never a new
            // step. The task is not marked done and burns no strike — it is offered again once the
            // branch is gone, so this is a skip and never a terminal state.
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
      // W1-T1035: the fresh MERGED read ALSO credits this task — the credit projection was simply
      // behind. Ledgered under its own step, alongside `dispatch.stood_down`, so an operator can
      // tell "stood down, still runnable" from "stood down, now excluded".
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
      // re-offered on a later pass. Wiring one loop and not the other is exactly the drift hazard.
      excludeIds: continuedIds,
    };

    // RESET PER SELECTION, NOT ACCUMULATED. `onIndeterminate` fires only from the selection call
    // below, and the terminal's question is about the pass that actually GAVE UP, not a gateway
    // hiccup three passes ago that has since cleared.
    indeterminateDeclines = 0;
    const candidates = runnableCandidates(plan, isMerged, passSize, skipOpts);
    if (candidates.length === 0) return summary("no_runnable", noRunnableDetail({ indeterminate: indeterminateDeclines }));

    // PRE-DISPATCH OVERLAP CHECK (W1-T171), across the co-dispatched set: a deferred task is absent
    // from THIS pass and re-considered next tick, by which point the task it collided with is merged
    // or has an open PR the in-flight guard excludes. Self-resolving. W1-T2286: `deps.observedByTask`
    // is passed EXPLICITLY rather than relying on `partitionByFileOverlap`'s default parameter.
    const partition = partitionByFileOverlap(candidates, deps.observedByTask ?? NO_OBSERVED_SCOPE);
    for (const d of partition.serialized) log("dispatch.serialized", serializedLedgerPayload(d));
    const dispatchSet = partition.dispatch;
    // DEFENSIVE, NOT A DISTINCT CAUSE: `partitionByFileOverlap` places its first candidate against an
    // empty `dispatch` unconditionally, so this is empty only when `candidates` was — already returned
    // on above. Given the same detail as the other two, because no overlap story is reachable here.
    if (dispatchSet.length === 0) return summary("no_runnable", noRunnableDetail({ indeterminate: indeterminateDeclines }));

    log("dispatch.concurrent_set", { tasks: dispatchSet.map((t) => t.id), lane_count: laneCount });

    // W1-T342's PER-DISPATCH GOVERNOR GATE, APPLIED PER LANE. The pass-level governor reads far above
    // STOP the whole pass; one reading taken before any lane was admitted stood in for EVERY lane, so
    // a ceiling crossed between lane 1 and lane 2 admitted lane 2 anyway.
    // TRAP: a check inside `dispatchSet.map(...)` would LOOK per-lane and not be — `.map`'s callback
    // runs synchronously for every element, so all N readings land in one tick of the event loop.
    // Admission therefore happens in this SEQUENTIAL loop, each iteration reading afresh. Stated
    // rather than overclaimed: lanes run concurrently, so this does NOT let lane 2 see lane 1's spend;
    // it catches a ceiling crossed by any OTHER writer, and a reading that goes unreadable mid-pass.
    // INVARIANT: a mid-pass refusal must not abort the pass. `break` stops ADMITTING and never
    // touches lanes already admitted — refusing lane 2 is a deferral of lane 2, not a failure of 1.
    const admitted: Task[] = [];
    for (const t of dispatchSet) {
      const verdict = checkDispatchGovernors(deps, undefined);
      if (verdict) {
        // A DISTINCT step from the pass-level `drain.cost_governor`/`drain.queue_governor`: "the pass
        // never started" and "lane 3 of 4 was refused" are different events, and collapsing them hides
        // a partial batch.
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

    // CONCURRENT LANES: `allSettled`, never `all` — see this function's own doc. Every sibling's
    // outcome is recorded below BEFORE the pass decides whether to stop.
    const settled = await Promise.allSettled(admitted.map((t) => deps.runOne(t.id)));
    // THE SETTLED COUNTERPART to `dispatch.concurrent_set`, emitted HERE because the classification
    // loop below ends in early returns and a row written after it would be skipped exactly when it
    // matters. `allSettled` never rejects, so this line is reachable whenever dispatch happened.
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
