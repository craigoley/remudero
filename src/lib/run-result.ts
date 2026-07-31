/**
 * `RunResult` — the terminal outcome of running one task through `rmd run-task`
 * (verdict + PR/cost bookkeeping).
 *
 * Lives in `src/lib`, not `src/run-task.ts`: `rmd drain` (`src/lib/drain.ts`)
 * and the daemon loop (`src/lib/daemon.ts`) both type their injected `runOne`
 * with this shape, and `src/lib` must never import the CLI entrypoint
 * (MASTER-PLAN §5 TIER 3 — enforced by the `lib-no-spike-or-cli`
 * dependency-cruiser rule in `.dependency-cruiser.cjs`). Before this module
 * existed, `daemon.ts`/`drain.ts` imported the type straight off
 * `src/run-task.ts`, which was itself the fitness rule's first violation —
 * moving the type here breaks that backward (and circular) edge.
 * `run-task.ts` re-exports it so existing
 * `import type { RunResult } from "../run-task.js"` call sites keep working.
 */
export interface RunResult {
  taskId: string;
  runId: string;
  prUrl?: string;
  merged: boolean;
  costUsd: number;
  verdict:
    | "merged"
    | "blocked"
    | "blocked_ci"
    | "blocked_review"
    | "blocked_budget"
    | "blocked_containment"
    | "blocked_isolation"
    | "blocked_inflight"
    | "blocked_git_fetch"
    | "blocked_illformed"
    | "no_pr"
    // W1-T272: the sanctioned ALREADY-SATISFIED exit — a worker found the task's acceptance
    // already true on origin/main and named the merged, trailer-anchored PR that did it
    // (verified, never trusted bare — see run-task.ts's `resolveAlreadySatisfied`). Distinct
    // from BOTH `merged` (this run's own PR) and `no_pr` (the drain-halting anomaly): it
    // CREDITS the task and behaves like forward progress, never a block.
    | "already_satisfied"
    | "blocked_transient"
    | "pr_attribution_failed"
    | "failed";
}
