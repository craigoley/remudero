/**
 * WHICH TERMINAL VERDICTS NO WORKER EARNED — the one exclusion set the dispatch breaker (status.ts), the
 * lifetime sensor and the cost-of-delay stride (dispatch-value.ts) all read. A leaf with no imports, so the
 * pure dispatch calibration can share it without an import ring through status.ts.
 */
/** Infrastructure refusals did not give this task a chance to open a PR. Match the run's terminal
 * verdict, which is already present in historical ledger rows, rather than a newer write-time flag. */
const INFRASTRUCTURE_REFUSAL_VERDICTS: ReadonlySet<string> = new Set([
  "blocked_containment",
  "blocked_isolation",
  "blocked_toolchain",
  "blocked_transient",
  "task_already_merged",
]);

/** These consume no task attempt for lifetime judgment, nor (W1-T7742) for the streak breaker
 *  through {@link streakRefusal}; each EXCLUDES a run and never resets a streak. */
const LIFETIME_ONLY_REFUSAL_VERDICTS: ReadonlySet<string> = new Set([
  "blocked_git_fetch", "blocked_inflight", "handed_off",
]);

/** A THROWN run's `failed` verdict (run-task.ts `endThrownRun`) at one of these stages is a deferral the harness
 *  refused before any worker ran — 10 lock-contention refusals tripped W1-T4684's breaker on 2026-09-29. */
const INFRASTRUCTURE_THROWN_STAGES: ReadonlySet<string> = new Set([
  "managed_checkout.refresh",
  "worktree.node_modules",
  "preflight.containment",
  "preflight.isolation",
]);

export function infrastructureRefusal(line: Record<string, unknown>): string | undefined {
  if (typeof line.verdict !== "string") return undefined;
  if (INFRASTRUCTURE_REFUSAL_VERDICTS.has(line.verdict)) return line.verdict;
  if (line.verdict === "failed" && typeof line.stage === "string" && INFRASTRUCTURE_THROWN_STAGES.has(line.stage)) return line.stage;
  return undefined;
}

export function lifetimeInfrastructureRefusal(line: Record<string, unknown>): string | undefined {
  return infrastructureRefusal(line) ??
    (typeof line.verdict === "string" && LIFETIME_ONLY_REFUSAL_VERDICTS.has(line.verdict) ? line.verdict : undefined);
}

/** The harness's own restart checkpoint failing to save or restore ends a run no worker failed. */
const HARNESS_CHECKPOINT_NO_PR_REASONS: ReadonlySet<string> = new Set(["restart_checkpoint_failed", "restart_checkpoint_restore_failed"]);

/** W1-T7742: the streak breaker spends its budget only on a run whose WORKER tried and failed. A yield to a
 *  restart, a lost claim race, a fetch or infrastructure refusal, or the harness failing its own checkpoint
 *  is excluded by name. MEASURED 2026-10-11: W1-T7742 tripped at 5 with not one of its seven runs a worker
 *  failure (two node_modules refusals, a claim race, a refused checkpoint push, two restart yields). */
export function streakRefusal(line: Record<string, unknown>): string | undefined {
  return lifetimeInfrastructureRefusal(line) ??
    (line.verdict === "no_pr" && typeof line.reason === "string" && HARNESS_CHECKPOINT_NO_PR_REASONS.has(line.reason) ? line.reason : undefined);
}
