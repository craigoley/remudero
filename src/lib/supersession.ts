/**
 * `SupersessionStatus`, `SupersessionDiffFinding`, `SupersessionEvidence`,
 * `SupersessionVerdict` — the supersession types the sweep's disposition rules
 * read and the REST enumeration produces.
 *
 * Lives here, not in `src/lib/sweep.ts`, for the reason `src/lib/merge-state.ts`
 * records verbatim for its own three types: `open-prs-rest.ts` needs them to
 * declare the producer W1-T2384 wires, while `sweep.ts` imports
 * `GhPaceFloorStandDownError` — a real VALUE — back off `open-prs-rest.js`. The
 * runtime graph is already acyclic; only a type edge would close the ring.
 * MEASURED on this tree before moving anything: an `import type { SupersessionVerdict }
 * from "./sweep.js"` in open-prs-rest.ts took dependency-cruiser from 13 warnings
 * to 24 — dependency-cruiser reads a type-only import as a dependency, exactly as
 * merge-state.ts's header says it did. Moving the declarations to a module that
 * imports NOTHING cuts the edge without moving any behaviour.
 *
 * `sweep.ts` re-exports all four, so every existing
 * `import type { … } from "…/sweep.js"` call site keeps working untouched — the
 * same pattern `merge-state.ts` and `run-result.ts` already established.
 */

/** W1-T920/W1-T2779 — the outcomes a supersession read may reach. `"indeterminate"` is a REAL
 *  outcome and never a collapsed failure: a read that could not decide must never read as
 *  `"unique"`, which would SAVE a PR the arithmetic condemned. `"complementary"` is narrower:
 *  both diffs were read and exactly one is wholly plan scope while the other contains non-plan
 *  work, so neither stage may erase the other merely because its PR number is lower. */
export type SupersessionStatus = "superseded" | "unique" | "complementary" | "indeterminate";

/** W1-T920 (design note v) — the diff read, carrying its OWN corpus control. */
export interface SupersessionDiffFinding {
  /** Total diff lines the read observed, BEFORE any hunk matching — the corpus control. */
  rawLineCount: number;
  /** Hunks matched against symbols already present on the superseding PR/task. */
  matchedHunks: number;
}

/**
 * W1-T920 (design note v) — the evidence a `"superseded"` verdict NAMES, never a bare label.
 * This is what made the #1955 diagnosis checkable in one read: the superseding PR number, the
 * shared task id, and the diff finding with its own control, together in one place.
 */
export interface SupersessionEvidence {
  /** The PR (open or merged) whose work already covers this PR's task. */
  supersedingPrNumber: number;
  /** The plan task both PRs share — the trailer this verdict was matched on. */
  taskId: string;
  diff: SupersessionDiffFinding;
}

/** W1-T2779 — positive evidence that two same-task PRs are different pipeline stages. Counts are
 *  the corpus control for the role classification; both are non-zero whenever this is present. */
export interface SupersessionComplementEvidence {
  planPrNumber: number;
  implementationPrNumber: number;
  taskId: string;
  planPathCount: number;
  implementationPathCount: number;
}

/**
 * W1-T920 — one open PR's supersession finding, read (never computed) by the disposition.
 * W1-T2384 wired its producer: `hydrateSupersessionVerdicts` (`src/lib/open-prs-rest.ts`),
 * assigned at `buildOpenPrViews` (`src/run-task.ts`) — the same seam W1-T984 used for
 * `mergeConflict`. Both policy flags that read it stay OFF by default, so populating it moves
 * no disposition.
 */
export interface SupersessionVerdict {
  status: SupersessionStatus;
  /** REQUIRED when `status === "superseded"`; absent otherwise. */
  evidence?: SupersessionEvidence;
  /** REQUIRED when `status === "complementary"`; absent otherwise. */
  complement?: SupersessionComplementEvidence;
  /** Human-legible explanation, always present — e.g. why a read came back indeterminate. */
  detail: string;
  /** The diff read behind this verdict, present whenever one was performed — carried on the
   *  verdict itself (not only inside `evidence`) so an `"indeterminate"` reading can still show
   *  the control that produced it. */
  diff?: SupersessionDiffFinding;
}
