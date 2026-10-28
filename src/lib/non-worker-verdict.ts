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
    (line.verdict === "no_pr" && typeof line.reason === "string" && HARNESS_CHECKPOINT_NO_PR_REASONS.has(line.reason) ? line.reason : undefined) ??
    (inconclusiveProofRefusal(line) ? PROOF_INCONCLUSIVE : undefined) ??
    (collectedNothingRefusal(line) ? PROOF_COLLECTED_NOTHING : undefined);
}

/** W1-T10919: the class of a PR-open refusal whose test runner loaded no file although head files held the proof's
 *  title — the runner's scope, not the worker, decided it, and a rebuild on the same tree is refused identically. */
export const PROOF_COLLECTED_NOTHING = "proof_collected_nothing";

function collectedNothingRefusal(line: Record<string, unknown>): boolean {
  return line.verdict === "failed" && line.stage === "pr_open.refused" && line.refusal_class === "proof-collected-nothing";
}

/** W1-T10742: the class of a PR-open refusal whose proof never reached a verdict (check-proof exit 4). */
export const PROOF_INCONCLUSIVE = "proof_inconclusive";

/** check-proof's own report line for an exec_error: `verdict:    exec_error — <why>`. */
const EXEC_ERROR_VERDICT_LINE = /(?:^|\n)\s*verdict:\s+exec_error\b/;

/** W1-T10742: a `failed` verdict at `pr_open.refused` for a proof that could not even be looked at. The row carries
 *  `proof_exec: "exec_error"` when written after this task; a row written before it (CONSOLE-T127's four) carries
 *  check-proof's own `verdict: exec_error` line in its `reason`. A conclusive miss matches neither. */
function inconclusiveProofRefusal(line: Record<string, unknown>): boolean {
  if (line.verdict !== "failed" || line.stage !== "pr_open.refused") return false;
  return line.proof_exec === "exec_error" || (typeof line.reason === "string" && EXEC_ERROR_VERDICT_LINE.test(line.reason));
}

/** The liveness bound (W1-T179, 30 minutes): a dispatched run with no newer ledger line is no longer trusted as running.
 *  BACKSTOP: it only ages out a run that went silent; the run's own terminal rows remain the primary signal. */
export const DEFAULT_LIVENESS_BOUND_MS = 30 * 60_000;

/** Rows a monitor writes ABOUT a run, so they are not rows the run itself produced. */
const MONITOR_WRITTEN_RUN_STEPS: ReadonlySet<string> = new Set([
  "run.running_long", // the duration sentinel reports about a run that may already be dead
  "cost.anomaly", // the cost sentinel reports about a run after the run has stopped
  "worker.stalled", // the daemon's quiet-episode detector writes about the observed run
]);

/**
 * W1-T8166: THE PROVEN-ORPHAN RULE, shared by the breaker, the lifetime sensor and the cost-of-delay stride.
 * A `run_id` is an orphan when its ONLY own row is its `run.start` (monitor rows excluded, a replayed row
 * counted once) and that start is at least `livenessBoundMs` behind `nowMs`. A run that cannot be named or
 * aged, or a missing `nowMs`, is never an orphan ("unknown stays counted"). `taskId` limits the rows read;
 * omitted, every task's rows are read (run ids are unique per run).
 */
export function provenOrphanRunIds(
  rows: Iterable<Record<string, unknown>>,
  nowMs: number | undefined,
  livenessBoundMs: number,
  taskId?: string,
): ReadonlySet<string> {
  const rowCountByRunId = new Map<string, number>();
  const startTsByRunId = new Map<string, string>();
  const counted = new Set<string>();
  for (const line of rows) {
    if ((taskId !== undefined && line.task_id !== taskId) || typeof line.run_id !== "string") continue;
    if (typeof line.step === "string" && MONITOR_WRITTEN_RUN_STEPS.has(line.step)) continue;
    // A rotation union replays retained rows once per archive; a replayed lone run.start is still an orphan.
    const key = `${line.run_id}|${String(line.step)}|${String(line.ts)}`;
    if (counted.has(key)) continue;
    counted.add(key);
    rowCountByRunId.set(line.run_id, (rowCountByRunId.get(line.run_id) ?? 0) + 1);
    if (line.step === "run.start" && typeof line.ts === "string" && !startTsByRunId.has(line.run_id)) {
      startTsByRunId.set(line.run_id, line.ts);
    }
  }
  const orphans = new Set<string>();
  if (nowMs === undefined) return orphans; // no notion of "now" anywhere in this ledger — unknown stays counted
  for (const [runId, ts] of startTsByRunId) {
    if ((rowCountByRunId.get(runId) ?? 0) > 1) continue; // the run produced another row — not an orphan
    const startMs = Date.parse(ts);
    if (!Number.isFinite(startMs) || nowMs - startMs < livenessBoundMs) continue; // unknown age, or still live
    orphans.add(runId);
  }
  return orphans;
}
