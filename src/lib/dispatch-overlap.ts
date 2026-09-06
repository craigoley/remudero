import type { Task } from "./plan.js";

/**
 * Pre-dispatch overlap check (P19 rung 1, W1-T171): a pure predicate that partitions candidate
 * tasks — already confirmed otherwise runnable by the caller (see drain.ts's
 * `runnableCandidates`) — so no two tasks in one pass declare overlapping `files:`. No LLM and
 * no I/O on this path; every decision here is glob comparison and set arithmetic.
 *
 * INVARIANT: this reduces collision probability, it never guarantees disjointness — `files:` is
 * advisory metadata a worker can exceed, and merge-time serialization is the real backstop. An
 * absent or empty `files:` list is scored as overlapping every other candidate (fail-closed): an
 * undeclared scope cannot be proven disjoint.
 *
 * FALSIFIER: test/dispatch-overlap.test.ts.
 * Why: full design (the DAG's unverified independence claim, the banked symbol-touch rung 2)
 * archived at docs/forensics/dispatch-overlap.md#module-header (W1-T171, W1-T172, #103).
 */

/** One task deferred out of this pass because it overlaps an earlier-placed one. */
export interface SerializedDeferral {
  /** The deferred task's id — the later-declared of the overlapping pair. */
  task: string;
  /** The earlier-declared task id it collides with, already placed in `dispatch`. */
  blockedBy: string;
  /** The overlapping paths, restricted to the entries that collided with `task`. */
  paths: string[];
}

export interface OverlapPartition {
  /** Candidates eligible for this dispatch pass — pairwise disjoint `files:`. */
  dispatch: Task[];
  /** Candidates deferred to a later pass, one entry per deferred task. */
  serialized: SerializedDeferral[];
  /**
   * One entry per candidate whose observed scope (see {@link ObservedScopeByTask}) reached a
   * path its declared `files:` never named. Purely reporting, never consulted by this function's
   * own dispatch/serialize decision below.
   * Why: docs/forensics/dispatch-overlap.md#overlappartition.
   */
  overruns: ScopeOverrunReport[];
}

/**
 * One candidate's real changed-file set, as observed by the caller (e.g. an open PR's actual
 * diff). Deliberately not glob-shaped like `Task["files"]`: an observed scope is a flat list of
 * concrete paths, since a diff either touched a path or it didn't.
 */
export interface ObservedScope {
  files: readonly string[];
}

/**
 * Per-task observed scope, keyed by task id — optional input to {@link partitionByFileOverlap}.
 * A task absent from this map is scored on its declaration alone.
 * Why: no production call site has a live producer wired yet — docs/forensics/dispatch-overlap.md#observedscopebytask.
 */
export type ObservedScopeByTask = ReadonlyMap<string, ObservedScope>;

/**
 * The declared-vs-observed comparison for one task. `overrun` is the subset of `observed` not
 * covered by any glob in `declared`; both sides are carried in full so a reader can tell drift
 * (an overrun onto unrelated ground) from creep (an overrun adjacent to the declared scope).
 */
export interface ScopeOverrunReport {
  task: string;
  declared: string[];
  observed: string[];
  overrun: string[];
}

/**
 * The empty union: every candidate scored on its declaration alone.
 * Why: exported so a call site with no wiring passes this explicitly rather than relying on
 * {@link partitionByFileOverlap}'s default parameter — docs/forensics/dispatch-overlap.md#no_observed_scope.
 */
export const NO_OBSERVED_SCOPE: ObservedScopeByTask = new Map();

/**
 * True iff glob `a` and glob `b` can describe the same repo-relative path. Supports this repo's
 * two wildcard forms (`*`, `**`), treated identically as "zero or more of any character" — an
 * over-approximation that can only ever make two globs look more likely to intersect, matching
 * the fail-closed bias above. A literal-only glob reduces to normalized string equality.
 */
export function globsIntersect(a: string, b: string): boolean {
  const na = normalizePath(a);
  const nb = normalizePath(b);
  if (!na.includes("*") && !nb.includes("*")) return na === nb;
  return patternsIntersect(na, nb, 0, 0, new Map());
}

function normalizePath(p: string): string {
  return p.trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

/**
 * Two-pointer memoized search for a string matched by both glob patterns. Whichever side sits on
 * a `*` may consume it against zero characters, or absorb one character from the other side
 * while keeping the star in play. Terminates because each call strictly increases `i + j`.
 */
function patternsIntersect(a: string, b: string, i: number, j: number, memo: Map<string, boolean>): boolean {
  if (i === a.length && j === b.length) return true;
  const key = `${i},${j}`;
  const cached = memo.get(key);
  if (cached !== undefined) return cached;
  let result = false;
  if (i < a.length && a[i] === "*") {
    result = patternsIntersect(a, b, i + 1, j, memo) || (j < b.length && patternsIntersect(a, b, i, j + 1, memo));
  } else if (j < b.length && b[j] === "*") {
    result = patternsIntersect(a, b, i, j + 1, memo) || (i < a.length && patternsIntersect(a, b, i + 1, j, memo));
  } else if (i < a.length && j < b.length && a[i] === b[j]) {
    result = patternsIntersect(a, b, i + 1, j + 1, memo);
  }
  memo.set(key, result);
  return result;
}

/**
 * Shared entries between two `files:` lists via glob-matching, with no fail-closed synthesis —
 * just the pairwise intersection. Factored out of {@link overlappingPaths} so its fail-closed
 * handling and the plain intersection the rarity-weighted advisory further down needs share one
 * glob-comparison loop instead of two hand-written copies that could drift apart.
 */
function intersectingEntries(filesA: readonly string[], filesB: readonly string[]): string[] {
  const hits = new Set<string>();
  for (const fa of filesA) {
    for (const fb of filesB) {
      if (globsIntersect(fa, fb)) {
        hits.add(fa);
        hits.add(fb);
      }
    }
  }
  return [...hits];
}

/**
 * The overlapping glob pairs between two tasks' `files:` lists. An absent or empty list on
 * either side is fail-closed: it cannot be proven disjoint from anything, so it is reported as
 * overlapping every entry of the other side — or, if both sides are absent/empty, a single
 * synthetic `"*"` marker so the pair still overlaps.
 */
function overlappingPaths(a: Pick<Task, "files">, b: Pick<Task, "files">): string[] {
  const filesA = a.files ?? [];
  const filesB = b.files ?? [];
  if (filesA.length === 0 && filesB.length === 0) return ["*"];
  if (filesA.length === 0) return [...filesB];
  if (filesB.length === 0) return [...filesA];
  return intersectingEntries(filesA, filesB);
}

/**
 * `task`'s scope for overlap-comparison purposes: its declared `files:` unioned with whatever
 * `observedByTask` recorded for its id. A task absent from `observedByTask`, or with an empty
 * declared `files`, reduces to its bare declaration — a no-op for every call site that passes no
 * observed scope, so the original fail-closed disposition on an undeclared task is unchanged.
 */
function effectiveScope(task: Pick<Task, "id" | "files">, observedByTask: ObservedScopeByTask): Pick<Task, "files"> {
  const declared = task.files ?? [];
  const observed = observedByTask.get(task.id)?.files ?? [];
  if (observed.length === 0) return { files: declared };
  return { files: [...new Set([...declared, ...observed])] };
}

/**
 * The subset of `observed` not covered by any glob in `declared` — the comparison nothing used
 * to perform between a task's declaration and its actual diff (W1-T2237). Uses the same
 * {@link globsIntersect} semantics as the collision guard above, so the two never drift apart.
 */
function overrunFiles(declared: readonly string[], observed: readonly string[]): string[] {
  return observed.filter((o) => !declared.some((d) => globsIntersect(d, o)));
}

/**
 * Partitions `candidates` — already established by the caller as otherwise concurrently runnable
 * — into one dispatch pass of pairwise-disjoint tasks plus a list of deferrals. Deterministic:
 * candidates are placed in the order given, each checked against every task already placed this
 * pass; the first-declared task in a colliding pair wins the slot and the later one defers, and
 * stays eligible again on the caller's next pass.
 *
 * `observedByTask` (W1-T2237) is optional and defaults to empty; supplying it can only ADD a
 * deferral, never remove one the bare declaration would produce. `overruns` is pure reporting —
 * it never feeds back into `dispatch`/`serialized`.
 *
 * FALSIFIER: test/dispatch-overlap.test.ts, test/observed-scope-wiring.test.ts.
 * Why: docs/forensics/dispatch-overlap.md#partitionbyfileoverlap.
 */
export function partitionByFileOverlap(
  candidates: readonly Task[],
  observedByTask: ObservedScopeByTask = NO_OBSERVED_SCOPE,
): OverlapPartition {
  const dispatch: Task[] = [];
  const serialized: SerializedDeferral[] = [];
  const overruns: ScopeOverrunReport[] = [];
  for (const candidate of candidates) {
    const effectiveCandidate = effectiveScope(candidate, observedByTask);
    const blocker = dispatch.find(
      (placed) => overlappingPaths(effectiveScope(placed, observedByTask), effectiveCandidate).length > 0,
    );
    if (blocker) {
      serialized.push({
        task: candidate.id,
        blockedBy: blocker.id,
        paths: overlappingPaths(effectiveScope(blocker, observedByTask), effectiveCandidate),
      });
    } else {
      dispatch.push(candidate);
    }

    const observed = observedByTask.get(candidate.id)?.files ?? [];
    if (observed.length > 0) {
      const declared = candidate.files ?? [];
      const overrun = overrunFiles(declared, observed);
      if (overrun.length > 0) {
        overruns.push({ task: candidate.id, declared: [...declared], observed: [...observed], overrun });
      }
    }
  }
  return { dispatch, serialized, overruns };
}

/**
 * The `dispatch.serialized` ledger payload for one deferral: both task ids plus the intersecting
 * paths, so the decision is legible rather than an invisible ordering effect (W1-T171). Kept as a
 * pure formatter so every caller shares one ledger shape instead of re-deriving it ad hoc.
 */
export function serializedLedgerPayload(d: SerializedDeferral): Record<string, unknown> {
  return { task: d.task, blocked_by: d.blockedBy, reason: "file-overlap", paths: d.paths };
}

/**
 * The `dispatch.settled_set` ledger payload — the settled counterpart to `dispatch.concurrent_set`,
 * which records only the lane set a pass STARTED. Reports per-task `fulfilled`/`rejected` outcomes
 * plus totals, so "dispatched 2, one rejected" is a ledger line rather than an inference.
 *
 * TRAP: emit this immediately after `allSettled` resolves, before either call site's early-return
 * classification loop runs, or a row is skipped in exactly the failure cases it exists to report.
 * Why: docs/forensics/dispatch-overlap.md#settledsetpayload.
 */
export function settledSetPayload(
  admitted: ReadonlyArray<{ id: string }>,
  settled: ReadonlyArray<PromiseSettledResult<unknown>>,
  laneCount: number,
): Record<string, unknown> {
  const tasks = admitted.map((t, i) => ({ id: t.id, status: settled[i]?.status ?? "missing" }));
  return {
    tasks,
    dispatched: admitted.length,
    fulfilled: tasks.filter((t) => t.status === "fulfilled").length,
    rejected: tasks.filter((t) => t.status === "rejected").length,
    lane_count: laneCount,
  };
}

// ── W1-T533: rarity-weighted overlap warning (advisory only) ──────────────────────────────────
// Raw overlap (`overlappingPaths` above) is too common to be a useful filing-time signal, since a
// few hub paths are named by many shards; weighting by how rare a shared path is filters to just
// the collisions worth a human's attention. Never wired into `partitionByFileOverlap`'s dispatch
// decision — this stays advisory data for a human at the filing surface.
// Why: docs/forensics/dispatch-overlap.md#rarity-weighted-overlap-warning.

/**
 * How many of the plan's shards declare each repo-relative path — the rarity a shared path is
 * scored against. A caller may substitute its own map (a cache, a fixture); this module performs
 * no I/O of its own.
 */
export type PathDeclarationCounts = ReadonlyMap<string, number>;

/**
 * Counts how many distinct tasks declare each `files:` entry. A task listing the same path twice
 * counts once — rarity is about how many shards name a path, not how many times.
 */
export function declarationCountsByPath(tasks: readonly Pick<Task, "files">[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const t of tasks) {
    for (const path of new Set(t.files ?? [])) {
      counts.set(path, (counts.get(path) ?? 0) + 1);
    }
  }
  return counts;
}

/**
 * The threshold the rarity weighting is scored against, as policy data rather than a literal
 * buried in the predicate — a fixture can retune it by constructing its own policy object.
 */
export interface OverlapWarningPolicy {
  /** A shared path counts as rare — worth a warning — when the fraction of shards declaring it
   *  is at or below this ceiling. Why: docs/forensics/dispatch-overlap.md#overlapwarningpolicy. */
  rareDeclarationRatioCeiling: number;
}

export const DEFAULT_OVERLAP_WARNING_POLICY: OverlapWarningPolicy = {
  rareDeclarationRatioCeiling: 0.05,
};

/**
 * The open-PR side of a rarity check — just enough shape to score against, not a full GitHub PR
 * view. `id` is opaque to this function (a PR number, a URL — whatever the filing surface prints).
 */
export interface OpenPrFileScope {
  id: string;
  files?: readonly string[];
}

/** One advisory: `withPr` shares `rarestPath` with `candidate` — the rarest of possibly several
 *  shared paths, named because it is the one that cleared the ceiling. */
export interface RareOverlapWarning {
  withPr: string;
  rarestPath: string;
  declaredByCount: number;
  totalShardCount: number;
}

/**
 * The rarity-weighted companion to `overlappingPaths` above — deliberately NOT fail-closed: an
 * absent or empty `files:` on either side produces no warning, unlike the collision guard's bias.
 * For each `openPrs` entry sharing a path with `candidate`, finds the rarest shared path and
 * reports the pair only when its declaration ratio is at or below
 * `policy.rareDeclarationRatioCeiling` — a pair sharing only a hub path stays silent.
 *
 * PURE, ADVISORY DATA ONLY: never consulted by `partitionByFileOverlap`'s dispatch decision.
 * FALSIFIER: test/dispatch-overlap.test.ts.
 * Why: docs/forensics/dispatch-overlap.md#rareoverlapwarnings.
 */
export function rareOverlapWarnings(
  candidate: Pick<Task, "files">,
  openPrs: readonly OpenPrFileScope[],
  declarationCounts: PathDeclarationCounts,
  totalShardCount: number,
  policy: OverlapWarningPolicy = DEFAULT_OVERLAP_WARNING_POLICY,
): RareOverlapWarning[] {
  const candidateFiles = candidate.files ?? [];
  if (candidateFiles.length === 0 || totalShardCount <= 0) return [];
  const warnings: RareOverlapWarning[] = [];
  for (const pr of openPrs) {
    const prFiles = pr.files ?? [];
    if (prFiles.length === 0) continue;
    const shared = intersectingEntries(candidateFiles, prFiles);
    if (shared.length === 0) continue;
    // TRAP: score only paths `declarationCounts` actually knows — defaulting an unknown shared
    // path to 0 scores it as maximally rare and inverts the whole design. See
    // docs/forensics/dispatch-overlap.md#rareoverlapwarnings-scoring-trap.
    let rarestPath: string | undefined;
    let rarestCount = 0;
    for (const path of shared) {
      const count = declarationCounts.get(path);
      if (count === undefined) continue;
      if (rarestPath === undefined || count < rarestCount) {
        rarestPath = path;
        rarestCount = count;
      }
    }
    if (rarestPath === undefined) continue;
    if (rarestCount / totalShardCount <= policy.rareDeclarationRatioCeiling) {
      warnings.push({ withPr: pr.id, rarestPath, declaredByCount: rarestCount, totalShardCount });
    }
  }
  return warnings;
}
