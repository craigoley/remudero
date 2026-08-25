/**
 * `MergeState`, `ConflictFileDiff`, `MergeConflictEvidence` — the merge-conflict
 * types the sweep's disposition rules read and the REST enumeration produces.
 *
 * Lives here, not in `src/lib/sweep.ts`, to break a two-module CYCLE that was
 * type-only in one direction: `open-prs-rest.ts` imported these three off
 * `sweep.js` with `import type` (erased at runtime), while `sweep.ts` imports
 * `GhPaceFloorStandDownError` — a real VALUE — back off `open-prs-rest.js`.
 * The runtime graph was already acyclic; only the type edge closed the ring, so
 * dependency-cruiser saw a cycle no import ever traversed at run time. Moving
 * the declarations to a module that imports NOTHING cuts the edge without
 * moving any behaviour: `mergeStateFromRest`/`hydrateMergeStates`
 * (open-prs-rest.ts) and `isPureConcurrentAddition`/`deriveDisposition`
 * (sweep.ts) all stay exactly where they were.
 *
 * `sweep.ts` re-exports all three, so every existing
 * `import type { … } from "…/sweep.js"` call site keeps working untouched —
 * the same pattern `src/lib/run-result.ts` established when it broke the
 * `run-task.ts` back-edge.
 */

/**
 * GitHub's own `mergeStateStatus`, simplified to what the sweep needs (W1-T106,
 * the #170 DIRTY strand): a stuck PR sat review-PASS, all-checks-SUCCESS, and
 * unmergeable for hours at `mergeStateStatus` DIRTY — invisible to every
 * disposition rule because conflict state was not an {@link OpenPrView} input at
 * all. `"dirty"` is a real merge conflict; `"behind"` is deliberately OUT OF
 * SCOPE (design note iv) — auto-merge already handles a behind-but-clean PR on
 * its own. `"unknown"` is the fail-closed default for anything else (BLOCKED,
 * DRAFT, HAS_HOOKS, UNSTABLE, an unrecognized value, or an unreadable read) —
 * never manufactured into a false "clean".
 */
export type MergeState = "clean" | "dirty" | "behind" | "unknown";

/**
 * One conflicting file's line-delta on EACH side since the merge-base — the
 * deterministic signal {@link isPureConcurrentAddition} classifies on. Counting
 * only DELETIONS (never additions) is deliberate: two sides that both only
 * ADD content can conflict textually (e.g. both appended an entry to the same
 * list) yet resolve safely to their union; a side that DELETED something is
 * the case the rung must never silently clobber (rationale: "union is
 * resolution, not clobber").
 */
export interface ConflictFileDiff {
  path: string;
  /** Lines this PR's OWN branch removed in this file since the merge-base. */
  oursDeleted: number;
  /** Lines the target branch (origin/main) removed in this file since the merge-base. */
  theirsDeleted: number;
}

/**
 * The merge-conflict fix mode's ONLY input (W1-T94's mode table gains
 * merge-conflict, design note iii): the conflicting file list plus BOTH
 * sides' log since the merge-base, so the dispatched fix worker can perform
 * the SAME hand-resolution procedure the #170 incident demonstrated — merge
 * (never rebase-force), union ONLY where the diffs below show pure
 * concurrent addition, refuse into escalate otherwise.
 */
export interface MergeConflictEvidence {
  files: ConflictFileDiff[];
  /** `git log <merge-base>..<branch>` on this PR's own head, one line per commit. */
  oursLog: string;
  /** `git log <merge-base>..origin/main`, the same shape for the target side. */
  theirsLog: string;
}
