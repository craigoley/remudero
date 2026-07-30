/**
 * Block-REASONING (W1-T46) — the daemon's successor to `rmd drain`/daemon v1's
 * blunt STOP-ON-BLOCK (drain.ts / daemon.ts's `runDaemon`). v1 halts the WHOLE
 * loop on ANY non-merged verdict because it cannot tell a transient blip from
 * a real blocker, or a self-contained failure from one real downstream work
 * needs. This module is the pure, DETERMINISTIC decision daemon.ts wires in:
 * given a block's verdict and the plan's DAG, what happens next?
 *
 *   TRANSIENT (`blocked_transient` — run-task.ts's own worker-level retry
 *   loop already ran the raw evidence through W1-T7's `classifyFailure`
 *   before giving up and returning this verdict, so this module never
 *   re-derives the classification, only reuses W1-T7's `RetryState`/
 *   `planRetry` machinery to BOUND how many times the daemon retries the
 *   whole task) -> retry, no strike, bounded by MAX_TRANSIENT_RETRIES.
 *
 *   Anything else is a real failure (a "strike"). The plan's DAG then decides
 *   between the remaining two buckets, via `transitiveDependents` (plan.ts) —
 *   never a criticality/importance heuristic invented here:
 *
 *   INDEPENDENT-FAILURE (zero transitive dependents — nothing in the plan
 *   needs this task) -> skip ONLY this task, continue everything else, flag
 *   it (the caller both logs it and flips the task's in-memory `status` to
 *   `blocked` so `nextRunnable` never reconsiders it this run).
 *
 *   GENUINE BLOCKER (one or more transitive dependents — real downstream work
 *   needs this task merged) with NO fixable signal (see `verdictIsFixable`,
 *   below) -> halt and escalate for a human. This is the ONE invariant that
 *   never bends: a task with a real dependent NEVER gets silently skipped
 *   ("never continue into the gap", MASTER-PLAN §4).
 *
 *   FIXABLE BLOCKER (W1-T174, drain/sweep PARITY: one or more transitive
 *   dependents, but the verdict names actionable evidence — the SAME
 *   `blocked_ci`/`blocked_review` classes the W1-T77 sweep's `isBlockedCi` /
 *   unmet-criteria rows already route to its W1-T76 fix rung, see sweep.ts's
 *   `DISPOSITION_RULES`) -> a bounded fix attempt BEFORE halting, strike-
 *   capped via the SAME classify.ts `planRetry` primitive every strike here
 *   already uses (never a separate, unbounded loop — the W1-T168 anti-
 *   regression guard: a strike-exhausted false-block falls through to
 *   GENUINE BLOCKER and escalates for re-judgment, it does not fix-loop
 *   forever). Halt+escalate NARROWS to the truly-stuck here; it is never
 *   removed.
 *
 * DECISION RECORD (W1-T46 PR): the independent/genuine split is a strict
 * "does anything transitively depend on it at all" binary — deliberately NOT
 * a criticality/importance weighing (e.g. is the task on the `--until`
 * critical path). The plan schema carries no such signal, and inventing one
 * risks silently skipping a real downstream need — this codebase's consistent
 * fail-closed bias (see classify.ts: "maybe transient is never good enough").
 */

import { INITIAL_RETRY_STATE, planRetry, type FailureClass, type RetryState } from "./classify.js";
import { transitiveDependents, type Plan } from "./plan.js";
import type { RunResult } from "./run-result.js";

export { INITIAL_RETRY_STATE, type RetryState };

/**
 * The verdict -> W1-T7 {@link FailureClass} mapping. `blocked_transient` is
 * the ONLY verdict run-task.ts's worker-level retry loop ever produces for a
 * transient cause (its `isTransientWorkerError` already gates on
 * `classifyFailure`) — every other non-merged verdict is a real, deterministic
 * failure (a strike), fail-closed exactly as W1-T7's own classifier is.
 */
export function verdictFailureClass(verdict: RunResult["verdict"]): FailureClass {
  return verdict === "blocked_transient" ? "transient" : "strike";
}

/**
 * W1-T174 (drain/sweep parity): does this verdict name evidence the W1-T76
 * fix rung can act on? Structurally mirrors the W1-T77 sweep's own
 * blocked-fixable signal (sweep.ts's `isBlockedCi` — a required check red —
 * and its `reviewState === "failure" && unmetCriteria.length > 0` row) at
 * the coarser grain `RunResult["verdict"]` carries: `blocked_ci` IS a
 * required check red (run-task.ts's review gate sets it from exactly that
 * evidence, before review even runs); `blocked_review` IS a failing review
 * naming unmet criteria (the SAME gate's review-failure branch). Every
 * OTHER non-transient verdict (`blocked_budget`/`blocked_containment`/
 * `blocked_isolation`/`blocked_inflight`/`blocked_git_fetch`/
 * `blocked_illformed`/`no_pr`/`pr_attribution_failed`/`failed`/bare
 * `blocked`) names an environmental or ambiguous failure with no nameable
 * criterion the rung could act on — never fixable, matching the sweep's own
 * `blocked-ambiguous` default-escalate row for the identical reason.
 */
export function verdictIsFixable(verdict: RunResult["verdict"]): boolean {
  return verdict === "blocked_ci" || verdict === "blocked_review";
}

export type BlockDisposition =
  | { kind: "retry_transient"; state: RetryState }
  | { kind: "independent_failure"; dependents: string[] }
  | { kind: "fixable_blocker"; dependents: string[]; state: RetryState }
  | { kind: "genuine_blocker"; dependents: string[] };

/**
 * Reason about one block. `state` is the CALLER's per-task {@link RetryState},
 * threaded across daemon ticks for the SAME task id (a fresh
 * {@link INITIAL_RETRY_STATE} the first time a task blocks; the caller drops
 * it once the disposition is no longer `retry_transient`). Pure — no I/O, no
 * mutation of `plan` — the caller applies the disposition (retry / flag+skip
 * / halt+escalate).
 */
export function reasonAboutBlock(
  plan: Plan,
  taskId: string,
  verdict: RunResult["verdict"],
  state: RetryState = INITIAL_RETRY_STATE,
): BlockDisposition {
  const cls = verdictFailureClass(verdict);
  if (cls === "transient") {
    const action = planRetry(state, "transient");
    if (action.kind === "retry_transient") return { kind: "retry_transient", state: action.state };
    // MAX_TRANSIENT_RETRIES exhausted ("give_up") — no longer safe to assume
    // transience; fall through to the SAME DAG-based classification below as
    // any other real failure.
  }
  const dependents = [...transitiveDependents(plan, taskId)].sort();
  if (dependents.length === 0) return { kind: "independent_failure", dependents };

  // W1-T174: the GENUINE-BLOCKER branch gets the sweep's disposition
  // vocabulary — a block whose verdict names fixable evidence gets a
  // bounded fix attempt (the SAME strike/give_up bound `planRetry` already
  // enforces above for transience) BEFORE halting. Reuses `state`'s
  // `strikes` counter, independent of `transientRetries` above, so a
  // verdict that was transient before exhausting ITS OWN bound still starts
  // this count at zero.
  if (verdictIsFixable(verdict)) {
    const action = planRetry(state, "strike");
    if (action.kind !== "give_up") {
      return { kind: "fixable_blocker", dependents, state: action.state };
    }
    // Strikes exhausted — the SAME class as the W1-T76 rung's OWN
    // exhaustion (W1-T168): stop attempting fixes, escalate for
    // re-judgment rather than fix-looping forever.
  }
  return { kind: "genuine_blocker", dependents };
}
