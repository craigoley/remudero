import { systemClock } from "./clock.js";
import { ghJsonAsync, type GhAsyncExecutor } from "./github-transport.js";
import { appendLedger, matchesRepoScopedTask } from "./ledger.js";
import {
  dispatchesWithoutNewOwnedPr,
  isDispatchStreakReset,
  orphanedRunIds,
  readLedgerLines,
  seedCountFromCircuitBreak,
} from "./status.js";
import { nonWorkerVerdictClass } from "./stranded-task-detector.js";

/**
 * W1-T8241 — ONE WRITER FOR A BREAKER RELEASE. `rmd release` (W1-T4691) was the only writer of
 * `dispatch.breaker_released`; its body lives here so the CLI and the `release-non-worker-breaker`
 * runbook (sre-runbooks.ts) write the same row and close the same escalation issue.
 *
 * MEASURED 2026-10-11: W1-T7742's breaker held 7.5 h on two restart yields, a claim race, a refused
 * checkpoint push and two node_modules refusals, until a person ran `rmd release` at 16:07Z. The
 * ledger already held every fact the release needed at 08:35Z: were any of the strikes since its last reset the
 * worker's? {@link judgeNonWorkerRelease} answers that with W1-T8240's `nonWorkerVerdictClass`.
 *
 * FALSIFIER: test/a-breaker-tripped-only-by-the-harness-is-released-by-a-runbook.test.ts.
 */

/** The runbook's id, and the `released_by` it writes on its release row. */
export const NON_WORKER_BREAKER_RUNBOOK_ID = "release-non-worker-breaker";
export const NON_WORKER_BREAKER_ACTOR = `sre-runbook:${NON_WORKER_BREAKER_RUNBOOK_ID}`;

export interface ReleaseBreakerRequest {
  ledgerPath: string;
  taskId: string;
  repo: string;
  reason: string;
  /** Who released. appendLedger stamps the process's own actor over `actor`, so a caller that must
   *  stay attributable past that also passes `released_by` in {@link extra}. */
  actor: string;
  /** The escalation comment's "Released by <releasedBy>: <reason>" clause. */
  releasedBy: string;
  /** Extra fields for the release row (the runbook's `released_by` and `strike_run_ids`). */
  extra?: Record<string, unknown>;
  /** Closes the breaker's escalation issue; absent means no close is attempted. */
  closeIssue?: (url: string, comment: string) => void | Promise<void>;
  nowMs?: () => number;
}

export type BreakerIssueOutcome =
  | { kind: "none" }
  | { kind: "closed"; url: string }
  | { kind: "close_failed"; url: string; error: string };

export interface ReleaseBreakerResult {
  runId: string;
  /** The count this release reset — read BEFORE the row is appended. */
  releasedCount: number;
  issue: BreakerIssueOutcome;
}

/** The newest escalation issue for this task that no later release has already retired. */
function openEscalationIssue(lines: ReadonlyArray<Record<string, unknown>>, repo: string, taskId: string): string | undefined {
  let issueUrl: string | undefined;
  let retired = false;
  let seen = false;
  for (const l of lines) {
    if (l.step === "dispatch.circuit_broken.escalated" && matchesRepoScopedTask(l, repo, taskId)) {
      seen = true;
      issueUrl = typeof l.issue_url === "string" ? l.issue_url : undefined;
      retired = false;
    } else if (seen && l.step === "dispatch.breaker_released" && matchesRepoScopedTask(l, repo, taskId)) {
      retired = true;
    }
  }
  return retired ? undefined : issueUrl;
}

/**
 * Append the `dispatch.breaker_released` row that `seedCountFromCircuitBreak`/`dispatchStreakTally`
 * (status.ts) read like a `pr.opened` reset, then best-effort close the breaker's escalation issue.
 * A close failure is returned, never thrown: the ledger row is what dispatch reads.
 */
export async function releaseBreaker(request: ReleaseBreakerRequest): Promise<ReleaseBreakerResult> {
  const { ledgerPath, taskId, repo, reason } = request;
  const lines = readLedgerLines(ledgerPath);
  const releasedCount = dispatchesWithoutNewOwnedPr(lines, taskId);
  const runId = `RELEASE-${taskId}-${(request.nowMs ?? systemClock.now)()}`;
  appendLedger(ledgerPath, {
    run_id: runId,
    task_id: taskId,
    task: taskId,
    repo,
    step: "dispatch.breaker_released",
    reason,
    released_count: releasedCount,
    ...request.extra,
    actor: request.actor,
  });

  const url = openEscalationIssue(lines, repo, taskId);
  if (url === undefined || request.closeIssue === undefined) return { runId, releasedCount, issue: { kind: "none" } };
  try {
    await request.closeIssue(
      url,
      `Released by ${request.releasedBy}: ${reason}\n\n` +
        `Recorded as \`dispatch.breaker_released\` (run ${runId}) — the task is dispatchable on the next ` +
        `tick. This did not diagnose or fix the underlying block; it authorizes another attempt.`,
    );
    return { runId, releasedCount, issue: { kind: "closed", url } };
  } catch (e) {
    return { runId, releasedCount, issue: { kind: "close_failed", url, error: String((e as Error)?.message ?? e) } };
  }
}

// ── which strikes stand against the breaker, and whose they were ────────────────────────────

export interface BreakerStrike {
  runId: string;
  /** W1-T8240's non-worker class (or `orphaned`), or `undefined` for a worker-attributable or unfinished run. */
  cause: string | undefined;
}

export interface BreakerStrikeReading {
  /** A `dispatch.circuit_broken` row stands since the task's last streak reset. */
  tripped: boolean;
  /** The breaker's own live count (`dispatchesWithoutNewOwnedPr`), for the receipt. */
  counted: number;
  /** Every `run.start` since the last reset, oldest first, with its terminal verdict's class. */
  strikes: BreakerStrike[];
}

/**
 * Every run since the task's last streak reset, classified by its terminal verdict. Deliberately EVERY run, not
 * only the ones today's exclusion set still counts: a trip recorded before an exclusion landed keeps its
 * `dispatch.circuit_broken` seed while the live count drops, so the W1-T2425 guard holds it as indeterminate —
 * and the runs that tripped it are exactly the ones to judge. A run with no verdict is a worker's unless the
 * breaker's own orphan reading says the harness killed it.
 */
export function readBreakerStrikes(lines: ReadonlyArray<Record<string, unknown>>, taskId: string): BreakerStrikeReading {
  const own = lines.map((line, i) => ({ line, i })).filter(({ line }) => line.task_id === taskId);
  const tsOf = (l: Record<string, unknown>) => (typeof l.ts === "string" ? l.ts : "");
  own.sort((a, b) => (tsOf(a.line) < tsOf(b.line) ? -1 : tsOf(a.line) > tsOf(b.line) ? 1 : a.i - b.i));
  const verdicts = new Map<string, Record<string, unknown>>();
  for (const { line } of own) if (line.step === "verdict" && typeof line.run_id === "string") verdicts.set(line.run_id, line);
  const orphans = orphanedRunIds(lines, taskId);
  let strikes: BreakerStrike[] = [];
  for (const { line } of own) {
    if (isDispatchStreakReset(line)) strikes = [];
    else if (line.step === "run.start") {
      const runId = typeof line.run_id === "string" ? line.run_id : "";
      const verdict = verdicts.get(runId);
      const cause = verdict ? nonWorkerVerdictClass(verdict) : orphans.has(runId) ? "orphaned" : undefined;
      strikes.push({ runId, cause });
    }
  }
  return { tripped: seedCountFromCircuitBreak(lines, taskId) !== undefined, counted: dispatchesWithoutNewOwnedPr(lines, taskId), strikes };
}

/** The evidence fingerprint: one task's strike run ids. A release keyed on it never repeats. */
export function strikeEvidenceKey(taskId: string, strikes: readonly BreakerStrike[]): string {
  return `${taskId}@${strikes.map((s) => s.runId).sort().join(",")}`;
}

export interface NonWorkerReleaseJudgment {
  ok: boolean;
  observed: string;
  /** The evidence fingerprint, when the strikes could be read. */
  subject?: string;
  repo: string;
  strikes: BreakerStrike[];
}

/** The repo this task's own rows name, newest first; `fallback` when none does. */
function taskRepo(lines: ReadonlyArray<Record<string, unknown>>, taskId: string, fallback: string): string {
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]!;
    if (l.task_id === taskId && typeof l.repo === "string" && l.repo !== "") return l.repo;
  }
  return fallback;
}

/**
 * Release only a tripped breaker whose EVERY strike since its last reset is non-worker. The subject it returns is
 * the evidence fingerprint the runbook keys its once-only receipt on; a task with one attributable worker failure
 * stays with the breaker and the lifetime judge.
 * Pure over the ledger rows it is handed; the open-PR read and the runbook receipts are the caller's.
 */
export function judgeNonWorkerRelease(
  lines: ReadonlyArray<Record<string, unknown>>,
  taskId: string,
  fallbackRepo: string,
): NonWorkerReleaseJudgment {
  const repo = taskRepo(lines, taskId, fallbackRepo);
  const reading = readBreakerStrikes(lines, taskId);
  const base = { repo, strikes: reading.strikes };
  if (!reading.tripped) return { ...base, ok: false, observed: `${taskId}: breaker not tripped since its last reset` };
  const subject = strikeEvidenceKey(taskId, reading.strikes);
  const listed = reading.strikes.map((s) => `${s.runId}=${s.cause ?? "worker"}`).join(", ");
  const worker = reading.strikes.filter((s) => s.cause === undefined);
  if (reading.strikes.length === 0 || worker.length > 0) {
    return { ...base, ok: false, subject, observed: `${taskId}: ${worker.length} worker-attributable strike(s): ${listed || "none counted"}` };
  }
  return { ...base, ok: true, subject, observed: `${taskId}: every strike since the last reset is non-worker: ${listed}` };
}

// ── the runbook's host ───────────────────────────────────────────────────────────────────────

export interface BreakerReleaseInput {
  taskId: string;
  repo: string;
  reason: string;
  strikeEvidence: string;
  strikeRunIds: string[];
}

/** What `release-non-worker-breaker` reads and writes — injected so a test drives it offline. */
export interface BreakerRunbookHost {
  /** The fleet's own repo, for a task whose rows name none. */
  defaultRepo: string;
  ledger(): ReadonlyArray<Record<string, unknown>>;
  openPr(taskId: string, repo: string): Promise<{ open: boolean; observed: string }>;
  release(input: BreakerReleaseInput): Promise<ReleaseBreakerResult>;
}

interface OpenPrRow {
  number?: number;
  headRefName?: string;
  body?: string;
}

/** An open PR that builds this task: its `run-<task>-*` head, or its `Remudero-Task:` trailer. */
export function openPrForTask(rows: readonly OpenPrRow[], taskId: string): OpenPrRow | undefined {
  const trailer = new RegExp(`^Remudero-Task: ${taskId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m");
  return rows.find((r) => (r.headRefName ?? "").startsWith(`run-${taskId}-`) || trailer.test(r.body ?? ""));
}

/** The daemon's host: the live ledger, `gh` for open PRs (awaited, off the loop), and the async
 *  issue gateway for the escalation close. */
export function daemonBreakerRunbookHost(opts: {
  ledgerPath: string;
  owner: string;
  repo: string;
  closeIssue?: (repo: string) => ((url: string, comment: string) => void | Promise<void>) | undefined;
  /** The `gh` child runner — injected only by a test; the daemon uses ghJsonAsync's own. */
  execAsync?: GhAsyncExecutor;
}): BreakerRunbookHost {
  const list = (repoArg: string) =>
    ghJsonAsync(["pr", "list", "--repo", repoArg, "--state", "open", "--limit", "1000", "--json", "number,headRefName,body"], opts.execAsync);
  return {
    defaultRepo: opts.repo,
    ledger: () => readLedgerLines(opts.ledgerPath), // ledger-read-intent: live — the breaker reads this ledger.
    async openPr(taskId, repo) {
      const rows = await list(`${opts.owner}/${repo}`);
      if (!Array.isArray(rows)) throw new Error(`open PR list for ${opts.owner}/${repo} was not an array`);
      const hit = openPrForTask(rows as OpenPrRow[], taskId);
      return hit ? { open: true, observed: `${taskId} has open PR #${hit.number ?? "?"}` } : { open: false, observed: `${taskId} has no open PR` };
    },
    release: (input) => releaseBreaker({
      ledgerPath: opts.ledgerPath,
      taskId: input.taskId,
      repo: input.repo,
      reason: input.reason,
      actor: NON_WORKER_BREAKER_ACTOR,
      releasedBy: `the \`${NON_WORKER_BREAKER_RUNBOOK_ID}\` runbook`,
      extra: { released_by: NON_WORKER_BREAKER_ACTOR, strike_evidence: input.strikeEvidence, strike_run_ids: input.strikeRunIds },
      closeIssue: opts.closeIssue?.(input.repo),
    }),
  };
}
