import type { Task } from "./plan.js";

/**
 * PRE-DISPATCH OVERLAP CHECK (P19 rung 1, W1-T171). A PURE predicate over a set of
 * candidate tasks the caller has ALREADY determined are otherwise concurrently
 * runnable (deps met, not blocked, not merged, not in-flight — see drain.ts's
 * `runnableCandidates`): partitions them so that no two tasks placed in the SAME
 * dispatch pass declare overlapping `files:`. NO LLM on this path — every decision
 * here is glob comparison and set arithmetic.
 *
 * P19's original argument: DAG independence (`depends_on`) is an ARCHITECT CLAIM,
 * never verified — two tasks the DAG calls independent can still declare
 * overlapping `files:`, producing exactly the integration-surfacing semantic
 * conflicts hierarchical decomposition (#103) warns about. This check is a
 * REDUCTION of collision probability, never a guarantee: `files:` is advisory
 * metadata a worker can exceed, and merge-time serialization (server-side
 * auto-merge lands one PR at a time; a loser goes DIRTY into W1-T106's CONFLICTED
 * disposition) remains the real backstop. Documenting this as elimination rather
 * than reduction is the one honesty violation this module must never commit.
 *
 * FAIL-CLOSED ON UNDECLARED SCOPE: a task with an absent or EMPTY `files:` list is
 * treated as overlapping EVERY other candidate — an undeclared scope cannot be
 * proven disjoint, and guessing it disjoint is the exact error mode this check
 * exists to prevent.
 *
 * Rung 2 (Tree-sitter symbol-touch intersection for tasks whose globs are disjoint
 * but whose criteria name the same exported symbols) is deliberately BANKED —
 * W1-T172's `dispatch.concurrent_set` ledger line is what would make its evidence
 * (an observed rung-1 escape) answerable. Not built here.
 */

/** One task deferred out of this pass because it overlaps an earlier-placed one. */
export interface SerializedDeferral {
  /** The deferred task's id — the LATER-declared of the overlapping pair. */
  task: string;
  /** The earlier-declared task id it collides with (already placed in `dispatch`). */
  blockedBy: string;
  /**
   * The overlapping paths/globs themselves (from `blockedBy`'s `files:`, restricted
   * to the entries that collided with `task`) — carried so the ledger line names
   * both ids AND the intersecting scope, not just an opaque "serialized" verdict.
   */
  paths: string[];
}

export interface OverlapPartition {
  /** Candidates eligible for THIS dispatch pass — pairwise disjoint `files:`. */
  dispatch: Task[];
  /** Candidates deferred to a later pass, one entry per deferred task. */
  serialized: SerializedDeferral[];
  /**
   * One entry per candidate whose OBSERVED scope (see {@link ObservedScopeByTask})
   * reached a path its DECLARED `files:` never named — W1-T2237's finding that a
   * merged diff exceeded its declaration in 138 of 301 comparable cases, 47 of them
   * onto contested `src/` ground. Populated purely from the `observedByTask` input
   * below; a call site that passes none (every production call site today — see
   * that parameter's doc) always gets `overruns: []`. NEVER consulted by this
   * function's own dispatch/serialize decision above and NEVER written anywhere —
   * W1-T2237 §6/§13 scope this shard to REPORTING the drift a caller can act on
   * (a human amending a shard's `files:`, e.g.), not to auto-correcting it or
   * refusing on it.
   */
  overruns: ScopeOverrunReport[];
}

/**
 * ONE candidate's REAL changed-file set, as of whenever the caller observed it —
 * e.g. `openPrFileScopes`'s (`src/run-task.ts`) read of an open PR's actual diff.
 * Deliberately NOT `Task["files"]`-shaped: an observed scope is a flat list of
 * concrete repo-relative paths a diff touched, never a glob, because nothing
 * declares wildcards over a diff — a diff either touched a path or it didn't.
 */
export interface ObservedScope {
  files: readonly string[];
}

/**
 * Per-task observed scope, keyed by task id — OPTIONAL input to
 * {@link partitionByFileOverlap}. A task absent from this map is scored on its
 * DECLARATION alone, exactly as before W1-T2237 added this parameter.
 *
 * W1-T2286 THREADS THIS THROUGH ALL THREE PRODUCTION CALL SITES (drain.ts's
 * `packDisjointFirst`/`isDisjointFromEvery` and its own `runDrainLanes`, plus
 * daemon.ts's `runDaemon`) via each caller's existing `DrainDeps.observedByTask`
 * / `DaemonDeps.observedByTask` optional dependency — but picks NO live
 * PRODUCER for it (see that task's rationale §4: the two candidate producers,
 * a ledger read and a git-derived diff, both need their own throughput
 * measurement first). Every caller that omits its `observedByTask` dependency
 * still gets {@link NO_OBSERVED_SCOPE} at the call site, so production dispatch
 * is UNCHANGED until a later task supplies a real producer — this shard is the
 * plumbing, not the arming.
 */
export type ObservedScopeByTask = ReadonlyMap<string, ObservedScope>;

/**
 * The declared-vs-observed comparison for ONE task, reported rather than
 * discarded (W1-T2237 §12: "nothing compares the declaration to the defect" —
 * this is that comparison). `overrun` is the subset of `observed` not covered by
 * ANY glob in `declared`; `declared` and `observed` are carried in FULL (not just
 * the overrun) so a reader can tell DRIFT (an overrun onto ground unrelated to the
 * declared scope) from CREEP (an overrun immediately adjacent to it) without
 * re-deriving either side.
 */
export interface ScopeOverrunReport {
  task: string;
  declared: string[];
  observed: string[];
  overrun: string[];
}

/**
 * The empty union — every candidate scored on its declaration alone. Exported (W1-T2286) so a
 * call site that has no `observedByTask` dependency wired can pass this EXPLICITLY rather than
 * omitting the argument and relying on {@link partitionByFileOverlap}'s own default parameter —
 * the difference between "this call site was never wired" (before) and "this call site is wired,
 * currently to nothing" (after), which is what makes the wiring itself something a caller can
 * later replace with a real producer without touching this module again.
 */
export const NO_OBSERVED_SCOPE: ObservedScopeByTask = new Map();

/**
 * True iff glob `a` and glob `b` can describe the SAME repo-relative path — i.e.
 * their matched-path sets intersect. Supports the two wildcard forms this repo's
 * `files:` globs use (`*` and `**`); a literal-only glob (the common case — no
 * wildcard is in use anywhere in plan/tasks.yaml today) reduces to normalized
 * string equality. `*` and `**` are treated IDENTICALLY here (both "zero or more
 * of any character, including `/`") rather than distinguishing single-segment vs
 * multi-segment — a deliberate OVER-approximation: it can only ever make two globs
 * look MORE likely to intersect, never less, which is the same fail-closed bias
 * `partitionByFileOverlap` already applies to an undeclared `files:` list. `?` and
 * other glob metacharacters are not special-cased — they are matched as literal
 * characters, since none appear in this repo's `files:` entries.
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
 * Two-pointer memoized search for a string simultaneously matched by both glob
 * patterns (each pattern is a sequence of literal characters and `*` wildcards,
 * `*` matching any run of zero-or-more characters). Standard "do two wildcard
 * patterns intersect" recursion: whichever side sits on a `*` may either consume
 * it against zero characters (advance past the star alone) or absorb one
 * character of the hypothetical common string (advance the OTHER side by one,
 * keep the star in play for the next character). Terminates because each
 * recursive call strictly increases `i + j` or the memo already answered it.
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
 * The literal/glob-matched shared entries between two `files:` lists — no
 * fail-closed synthesis, just the pairwise glob intersection. Factored out of
 * {@link overlappingPaths} so its fail-closed absent/empty handling (RIGHT
 * for the pre-dispatch collision guard below) and the plain intersection
 * (RIGHT for the rarity-weighted advisory further down, where an undeclared
 * scope must produce NO signal rather than a synthetic one) share one glob-
 * comparison loop instead of two hand-written copies that could drift apart.
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
 * The overlapping glob pairs between two tasks' `files:` lists. An absent or
 * EMPTY list on EITHER side is fail-closed: it cannot be proven disjoint from
 * anything, so it is reported as overlapping every entry of the other side (or,
 * if the other side is ALSO absent/empty, a single synthetic `"*"` marker so the
 * pair still overlaps even though neither declared any concrete path).
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
 * `task`'s scope for OVERLAP-COMPARISON purposes: its declared `files:` UNIONED
 * with whatever `observedByTask` recorded for its id (deduped; order irrelevant
 * to `overlappingPaths`, which only asks whether the resulting glob set
 * intersects another). A task absent from `observedByTask`, or present with an
 * empty `files` list, reduces to its bare declaration — so this is a strict
 * no-op for every call site that passes no observed scope at all (every
 * production call site today), preserving the ORIGINAL fail-closed disposition
 * on an undeclared-and-unobserved task exactly: declared `[]` union observed `[]`
 * is still `[]`, which `overlappingPaths` already treats as overlapping
 * everything.
 */
function effectiveScope(task: Pick<Task, "id" | "files">, observedByTask: ObservedScopeByTask): Pick<Task, "files"> {
  const declared = task.files ?? [];
  const observed = observedByTask.get(task.id)?.files ?? [];
  if (observed.length === 0) return { files: declared };
  return { files: [...new Set([...declared, ...observed])] };
}

/**
 * The subset of `observed` not covered by any glob in `declared` — the
 * comparison W1-T2237 §12 found nothing performs ("both advisories compare the
 * declaration to the diff, and nothing compares the declaration to the defect").
 * Coverage is `globsIntersect`, the SAME glob semantics the collision guard above
 * uses, so a declared `src/lib/*.ts` covers an observed `src/lib/drain.ts` here
 * exactly as it would suppress a collision there — one glob engine, not two that
 * could drift apart.
 */
function overrunFiles(declared: readonly string[], observed: readonly string[]): string[] {
  return observed.filter((o) => !declared.some((d) => globsIntersect(d, o)));
}

/**
 * Partitions `candidates` — a set the caller has already established are
 * otherwise concurrently runnable — into one pass of pairwise-`files:`-disjoint
 * tasks plus a list of deferrals. DETERMINISTIC: candidates are placed in the
 * order given (the plan's own declaration order — see drain.ts's
 * `runnableCandidates`), each checked against every task ALREADY placed in
 * `dispatch` this pass; the FIRST-declared task in a colliding pair always wins
 * the slot and every LATER one defers, so the same candidate set yields the same
 * partition on every call — no randomness, no LLM, no I/O. A deferred task is
 * simply absent from `dispatch`; it remains eligible for the NEXT pass (once the
 * task(s) it collided with have left the in-flight set), which this function does
 * not model — the caller re-invokes it with a fresh candidate list next tick.
 *
 * `observedByTask` (W1-T2237) is OPTIONAL and defaults to empty: when supplied,
 * the collision check above compares each pair's {@link effectiveScope} (declared
 * UNION observed) rather than the bare declaration, so a lane whose REAL diff
 * already reaches a path is serialized against another lane declaring or
 * touching that same path even if its OWN `files:` never named it. A candidate
 * missing from `observedByTask` is scored on its declaration alone, unchanged.
 * This can only ever ADD a deferral, never remove one the bare-declaration
 * comparison would have produced (union is a superset of the declared side
 * alone) — so it refuses no dispatch that is eligible today; it can only
 * SERIALIZE a pair one more pass finds independent anyway, which is this
 * module's existing, non-blocking backstop (module doc above), never a refusal.
 * `overruns` is computed from the SAME two inputs per candidate and is pure
 * reporting (see {@link ScopeOverrunReport}) — it does not feed back into
 * `dispatch`/`serialized` above.
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
 * The `dispatch.serialized` ledger payload for one deferral (W1-T171's design:
 * "every deferral ledgers dispatch.serialized carrying BOTH task ids and the
 * intersecting paths, so the decision is legible rather than an invisible
 * ordering effect"). Callers pass this straight to their `log("dispatch.serialized",
 * ...)` site (the same `log(step, extra)` shape every other `dispatch.*` line in
 * drain.ts/daemon.ts already uses) — kept as a pure formatter here so the ledger
 * shape has exactly one definition, never re-derived ad hoc at each call site.
 */
export function serializedLedgerPayload(d: SerializedDeferral): Record<string, unknown> {
  return { task: d.task, blocked_by: d.blockedBy, reason: "file-overlap", paths: d.paths };
}

/**
 * The `dispatch.settled_set` ledger payload — the SETTLED COUNTERPART to
 * `dispatch.concurrent_set`.
 *
 * WHY THIS EXISTS. `dispatch.concurrent_set` records the set of lanes a pass STARTED
 * (`{tasks, lane_count}`). Nothing records the set that CONCLUDED. At N >= 2 a lane that dies
 * mid-pass is therefore detectable only as a set-difference someone must think to compute — the
 * same shape as the blind sweep, where a missing `sweep.summary` took two undetected 22-minute
 * episodes to find by hand. With this row, "dispatched 2, concluded 1 fulfilled and 1 rejected" is
 * a LINE rather than an inference.
 *
 * COUNTS AND OUTCOMES, NOT A BARE PULSE. `Promise.allSettled` yields `fulfilled` or `rejected` per
 * element, and that distinction is the whole signal: a pass that dispatched 2 and had one lane
 * reject is a different event from one that dispatched 1 and it fulfilled, and only the per-task
 * outcome separates them. Task ids are carried in the SAME positional order as `admitted`, which is
 * the order `allSettled` preserves, so each id is paired with its own settlement.
 *
 * A PURE FORMATTER, for the reason {@link serializedLedgerPayload} above already states: the ledger
 * shape gets exactly one definition instead of being re-derived at each call site. That matters more
 * here than usual — there are TWO call sites, `runDrainLanes` (drain.ts) and `runDaemon`'s own lane
 * path (daemon.ts), because W1-T343 MIRRORED the lane machinery rather than reusing it. Two
 * hand-written payloads would drift, which is the duplicated-predicate defect this repo has paid for
 * twice.
 *
 * CALLERS MUST EMIT THIS IMMEDIATELY AFTER `allSettled` RESOLVES, before classifying outcomes.
 * `Promise.allSettled` itself never rejects, so a row written there is guaranteed reachable once
 * dispatch happened; both call sites then run a classification loop with EARLY RETURNS (drain's
 * `if (failure) return summary("error", ...)`, the daemon's fatal-error path), so a row emitted
 * after that loop would be skipped in exactly the failure cases it exists to report.
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

/*
 * ── W1-T533: RARITY-WEIGHTED OVERLAP WARNING (ADVISORY ONLY) ────────────────
 *
 * Four concurrent PRs (#1927/#1930/#1931/#1933) converged on
 * `src/lib/open-prs-rest.ts`, a path only 6 of 277 shards declare (2%). RAW
 * overlap — what `overlappingPaths` above computes — is useless as a
 * filing-time signal for this: `src/run-task.ts` alone is declared by 103 of
 * 277 shards (37%), and 18% of all shard PAIRS share at least one path, so a
 * detector on bare intersection would flag roughly a fifth of the plan.
 * WEIGHTING the overlap by how rare the shared path is, and reporting only
 * the rare end, is precise across the 87% of paths named by three shards or
 * fewer, and silent at the handful of hubs (design (i)/(iv), the task shard's
 * own rationale (3)/(4)).
 *
 * ADVISORY, NEVER BLOCKING (design iii). Everything below is a pure function
 * returning data for a human to read at the filing surface — it has no hook
 * into `partitionByFileOverlap` above, `isDispatchEligible` (drain.ts), or
 * any minting path, and adds none. Wiring this into dispatch would make it a
 * FIFTH fired-and-unread signal alongside `daemon.tree_dirty`,
 * `daemon.stale_code`, `CiFailure.outsidePrRange` and `dh-rate-limit` —
 * design (iv) is explicit that this must not become that.
 */

/**
 * How many of the plan's shards declare each repo-relative path — the rarity
 * a shared path is scored against. {@link declarationCountsByPath} derives
 * this from a task list; a caller may also hand in its own map (e.g. a
 * cached count, or a fixture with a synthetic distribution) since this
 * module performs no I/O of its own and never reads `plan/tasks.d` directly.
 */
export type PathDeclarationCounts = ReadonlyMap<string, number>;

/**
 * Counts how many DISTINCT tasks declare each `files:` entry — the raw input
 * the rarity weighting is scored against. A task listing the same path twice
 * counts it once (rarity is about how many SHARDS name a path, not how many
 * times). Pure, synchronous, no I/O — `tasks` is whatever plan snapshot the
 * caller already holds; `totalShardCount` for {@link rareOverlapWarnings} is
 * simply `tasks.length` of that same snapshot.
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
 * The threshold the rarity weighting is scored against — POLICY DATA, not a
 * literal buried in the predicate, the same discipline {@link
 * DEFAULT_SWEEP_POLICY} (sweep.ts) already follows for its own thresholds. A
 * fixture moves this by constructing its own policy object and passing it to
 * {@link rareOverlapWarnings}; no code change is required to retune it.
 */
export interface OverlapWarningPolicy {
  /**
   * A shared path counts as RARE — worth an advisory warning — when the
   * fraction of the plan's shards declaring it is AT OR BELOW this ceiling.
   * Sized against the measured distribution (task rationale (3)/(4)): the 2%
   * instance (`src/lib/open-prs-rest.ts`, 6/277) must clear it, the 37% hub
   * (`src/run-task.ts`, 103/277) must not, and the 87% of all declared paths
   * named by <=3 shards (well under 1.1%) sit far inside the ceiling with
   * room to spare as the plan grows — the two-tailed sizing design (ii)
   * requires.
   */
  rareDeclarationRatioCeiling: number;
}

export const DEFAULT_OVERLAP_WARNING_POLICY: OverlapWarningPolicy = {
  rareDeclarationRatioCeiling: 0.05,
};

/**
 * The open-PR side of a rarity check — just enough shape to score against,
 * not a full GitHub PR view (this module has no GitHub dependency and never
 * will — see the module doc's "NO LLM on this path" discipline extended to
 * "no network I/O either"). `id` is whatever the filing surface should print
 * (a PR number, `"#1930"`, a URL) — opaque to this function.
 */
export interface OpenPrFileScope {
  id: string;
  files?: readonly string[];
}

/**
 * One advisory: `withPr` already declares `rarestPath`, the RAREST path
 * `candidate` shares with it (there may be other, less-rare shared paths;
 * only the rarest is named, since it is the one that cleared the ceiling).
 */
export interface RareOverlapWarning {
  withPr: string;
  rarestPath: string;
  declaredByCount: number;
  totalShardCount: number;
}

/**
 * The rarity-weighted companion to `overlappingPaths` above. UNLIKE that
 * function, this is deliberately NOT fail-closed: a candidate or open PR
 * with an absent or empty `files:` produces NO warning, rather than the
 * synthetic overlap-everything bias `overlappingPaths` applies for the
 * pre-dispatch guard. That bias is right for a collision GUARD (which this
 * is not — design iii); reused here it would fire this advisory against
 * every open PR whenever a candidate's scope is merely undeclared, exactly
 * the noise design (iv) forbids.
 *
 * For each `openPrs` entry sharing at least one path with `candidate`, finds
 * the RAREST shared path (lowest declaration count) and reports the pair iff
 * that path's declaration ratio is at or below
 * `policy.rareDeclarationRatioCeiling` — i.e. a pair is reported only when
 * their rarest shared ground is itself rare. A pair sharing ONLY a hub path
 * (e.g. `src/run-task.ts`) is silent: the falsifier design (v) requires in
 * both directions, and the one that IS the point of this predicate.
 *
 * PURE, ADVISORY DATA ONLY (design iii): the return value is a list of
 * `{withPr, rarestPath, ...}` rows for a human to print at the filing
 * surface (design iv — where a filer already reads, not a new dashboard).
 * Nothing here inspects or influences `partitionByFileOverlap`'s dispatch
 * decision, mints no task, and refuses no dispatch.
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
    // SCORE ONLY PATHS THE COUNTS MAP ACTUALLY KNOWS, AND THE `?? 0` THIS REPLACES IS WHY.
    // `intersectingEntries` reports the RAW strings from BOTH sides, while `globsIntersect`
    // matched them through normalization/glob semantics — so a shared entry can be a spelling
    // that no shard ever DECLARED, and `declarationCounts` (keyed on declared strings) has no
    // entry for it. Defaulting such a path to 0 scored it as MAXIMALLY RARE, which inverted the
    // one falsifier design (v) calls "the whole design": measured against a hub declared by
    // 103 of 277 shards (37%), a candidate declaring `src/*.ts`, `src/**`, or `./src/run-task.ts`
    // matched it and warned at `count=0`, while the identical literal spelling stayed correctly
    // silent. Globs are not an exotic case here — matching them is the whole reason
    // `globsIntersect` exists.
    //
    // Scoring the KNOWN entries fixes both directions at once, because a bridged pair always
    // carries the concrete declared side too: `{src/*.ts, src/run-task.ts}` scores 103 and stays
    // silent, `{src/lib/open-prs-rest.ts}` scores 6 and warns. When NOTHING shared is known, this
    // reports nothing — the right direction for a purely advisory signal (design iii), since a
    // warning naming a path no shard declares tells a filer nothing they could act on.
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
