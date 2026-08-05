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
}

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
 * The overlapping glob pairs between two tasks' `files:` lists. An absent or
 * EMPTY list on EITHER side is fail-closed: it cannot be proven disjoint from
 * anything, so it is reported as overlapping every entry of the other side (or,
 * if the other side is ALSO absent/empty, a single synthetic `"*"` marker so the
 * pair still overlaps even though neither declared any concrete path).
 */
function overlappingPaths(a: Task, b: Task): string[] {
  const filesA = a.files ?? [];
  const filesB = b.files ?? [];
  if (filesA.length === 0 && filesB.length === 0) return ["*"];
  if (filesA.length === 0) return [...filesB];
  if (filesB.length === 0) return [...filesA];
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
 */
export function partitionByFileOverlap(candidates: readonly Task[]): OverlapPartition {
  const dispatch: Task[] = [];
  const serialized: SerializedDeferral[] = [];
  for (const candidate of candidates) {
    const blocker = dispatch.find((placed) => overlappingPaths(placed, candidate).length > 0);
    if (blocker) {
      serialized.push({ task: candidate.id, blockedBy: blocker.id, paths: overlappingPaths(blocker, candidate) });
    } else {
      dispatch.push(candidate);
    }
  }
  return { dispatch, serialized };
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
