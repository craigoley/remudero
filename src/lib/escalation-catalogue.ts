import { DISK_FAIL_BYTES, DISK_WARN_BYTES, humanBytes } from "./doctor.js";
import {
  classifyEndedDaemonProcesses, crashLoopRunOf, DAEMON_ABNORMAL_EXIT_STEP, DAEMON_CLEAN_EXIT_OBSERVED_STEP, learnedCleanLifetime,
  type CrashLoopVerdict, type DaemonLifetimeRecord, type DaemonProcessEnd, type LearnedCleanLifetime, type LearnedCrashLoopSummary,
  type ClaimStallClearedInfo, type ClaimStallInfo, type NoTaskStartedClearedInfo, type NoTaskStartedInfo, type StarvationCensus,
  type StarvationClearedInfo, type TargetJobStallInfo,
} from "./daemon.js";
import { ghRateLimitWindow, type GhRateLimitProvenance } from "./daemon-health.js";
import { quantileOf } from "./daemon-memory-policy.js";
import { readLedgerUnionRecords } from "./ledger-union.js";
import { ghIssueGateway, ghIssueGatewayAsync, ghIssueGatewayGraphql, tryEscalate, tryEscalateAsync, type AsyncIssueGateway, type Escalation, type IssueGateway } from "./escalate.js";
import { appendLedger, matchesRepoScopedTask, queueDispatchRunStarts } from "./ledger.js";
import type { ReplayStranded } from "./inbox-replay.js";
import type { Task } from "./plan.js";
import { DEFAULT_MAX_TASK_LIFETIME_DISPATCHES, readLedgerLines } from "./status.js";
import type { EscalationTriageSlice, PostReviewStallVerdict } from "./sweep.js";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { readFile } from "node:fs/promises";
import { hostname } from "node:os";
import { systemClock, type Clock } from "./clock.js";
import { deliveredEscalationUrl, spoolIssueAction, withdrawSpooledEscalation } from "./host-escalation-spool.js";

/**
 * P29(ii)'s escalation side — called once `nextRunnable`'s `isCircuitTripped` (status.ts's
 * `evaluateDispatchBreaker`, via `breakerGateFor`) reports a task dispatched the policy-capped
 * number of times with no new owned PR since — never merely on "indeterminate" (an absent/rotated
 * ledger read is a skip-and-retry via `isIndeterminate`). DEDUPED: a task escalates AT MOST ONCE,
 * checked via this module's OWN `dispatch.circuit_broken.escalated` line (never
 * `escalation.issue_opened` alone, which a genuine_blocker escalation could also have written);
 * mirrors ops.ts's ledger-line dedup, never a second store.
 */

/**
 * THE DEDUP KEY IS WRITTEN WHETHER OR NOT DELIVERY SUCCEEDS. The marker was once recorded only
 * AFTER `escalate()` returned, so a THROWING `gh` wrote nothing and every boot retried — a
 * transport failure became an unbounded relaunch loop (1 marker against 460 boots).
 *
 * The trade-off is deliberate: a failed escalation is not retried automatically. For a BACKSTOP
 * NOTIFICATION an undelivered notice shows as an `escalation.failed` line and costs one operator
 * read, whereas retry-until-success costs the fleet.
 */
export function escalateCircuitBreak(
  task: Task,
  ctx: { owner: string; repo: string; ledgerPath: string; runId: string; issues?: IssueGateway },
): void {
  // W1-T429: repo-scoped dedup — a same-id task in ANOTHER repo must never dedup off (or be
  // dedup'd off by) this task's own escalation marker. `matchesRepoScopedTask` also honors a
  // marker ledgered before this task existed (no `repo` field at all) as still matching.
  const already = readLedgerLines(ctx.ledgerPath).some(
    (l) => l.step === "dispatch.circuit_broken.escalated" && matchesRepoScopedTask(l, ctx.repo, task.id),
  );
  if (already) return;
  const issueUrl = tryEscalate(
    {
      class: "BLOCKED",
      taskId: task.id,
      runId: ctx.runId,
      summary: `${task.id}: dispatch circuit breaker tripped — repeated dispatch with no new owned PR`,
      detail:
        `MASTER-PLAN P29(ii): ${task.id} has been dispatched with no new owned PR appearing since — the ` +
        `W1-T1/W1-T29 redispatch-storm shape (~130 dispatches / ~$130 / ~10h on one task, five hours of it ` +
        `AFTER the task's own PR had already merged under a sibling run). Dispatch is now HALTED for this ` +
        `task until a human resolves the underlying block; this is the backstop, not a diagnosis of WHY.`,
      options: [
        {
          label: "fix and resume",
          detail: `Resolve ${task.id}'s underlying block (a manual patch or \`rmd fix\`), then \`rmd drain\`/\`rmd daemon\` to continue.`,
        },
        {
          label: "correct the credit",
          detail: `If ${task.id} actually landed under a PR the ownership-assert rejected, \`rmd correct\` it (P9/W1-T75).`,
        },
      ],
      recommendation: "fix and resume",
    },
    {
      issues: ctx.issues ?? ghIssueGateway(ctx.owner, ctx.repo),
      ledgerPath: ctx.ledgerPath,
      runId: ctx.runId,
    },
  );
  appendLedger(ctx.ledgerPath, {
    run_id: ctx.runId,
    task_id: task.id,
    // W1-T429: the repo dimension the dedup read above (and any future one) matches against —
    // see repoScopedTaskKey's doc for why this rides alongside `task_id` rather than folding
    // into it.
    repo: ctx.repo,
    step: "dispatch.circuit_broken.escalated",
    issue_url: issueUrl,
    delivered: issueUrl !== null,
  });
}

/**
 * W1-T316's escalation side — `escalateCircuitBreak`'s twin for the LIFETIME dispatch cap
 * (W1-T271): fires once `nextRunnable`'s `isLifetimeCapExceeded` reports a task dispatched
 * (`run.start`) at least `DEFAULT_MAX_TASK_LIFETIME_DISPATCHES` times across its WHOLE history — a
 * count `pr.opened` never resets, so it catches what the streak breaker misses (W1-T254: five
 * dispatches in eighty minutes, each merging its own no-op PR).
 *
 * DEDUP + ORDERING mirror `escalateCircuitBreak` on the sibling step
 * `dispatch.lifetime_capped.escalated` (DECISION_RELEVANT, so rotation never re-arms it); the marker
 * is written whether or not delivery succeeds.
 */
export function escalateLifetimeCapExceeded(
  task: Task,
  ctx: { owner: string; repo: string; ledgerPath: string; runId: string; issues?: IssueGateway },
): void {
  // W1-T429: repo-scoped dedup — see escalateCircuitBreak's identical comment above.
  const already = readLedgerLines(ctx.ledgerPath).some(
    (l) => l.step === "dispatch.lifetime_capped.escalated" && matchesRepoScopedTask(l, ctx.repo, task.id),
  );
  if (already) return;
  const issueUrl = tryEscalate(
    {
      class: "BLOCKED",
      taskId: task.id,
      runId: ctx.runId,
      summary: `${task.id}: lifetime dispatch cap exceeded — dispatched ${DEFAULT_MAX_TASK_LIFETIME_DISPATCHES}+ times, ever`,
      detail:
        `W1-T271: ${task.id} has been dispatched (\`run.start\`) at least ${DEFAULT_MAX_TASK_LIFETIME_DISPATCHES} ` +
        `times across its whole recorded ledger history. UNLIKE the per-task circuit breaker above, this count is ` +
        `NEVER reset by a \`pr.opened\` line — so a task that merges a genuine no-op PR every cycle (the W1-T254 ` +
        `shape: five dispatches in eighty minutes, each one opening and merging its own PR) still trips this ` +
        `backstop even though the streak breaker alone never would. Dispatch is now HALTED for this task until a ` +
        `human resolves the underlying loop; this is the backstop, not a diagnosis of WHY.`,
      options: [
        {
          label: "fix and resume",
          detail: `Resolve ${task.id}'s underlying loop (a manual patch, a task re-scope, or \`rmd fix\`), then \`rmd drain\`/\`rmd daemon\` to continue.`,
        },
        {
          label: "correct the credit",
          detail: `If ${task.id} actually landed under a PR the ownership-assert rejected, \`rmd correct\` it (P9/W1-T75).`,
        },
      ],
      recommendation: "fix and resume",
    },
    {
      issues: ctx.issues ?? ghIssueGateway(ctx.owner, ctx.repo),
      ledgerPath: ctx.ledgerPath,
      runId: ctx.runId,
    },
  );
  appendLedger(ctx.ledgerPath, {
    run_id: ctx.runId,
    task_id: task.id,
    // W1-T429: see escalateCircuitBreak's identical field for why this rides alongside `task_id`.
    repo: ctx.repo,
    step: "dispatch.lifetime_capped.escalated",
    issue_url: issueUrl,
    delivered: issueUrl !== null,
  });
}

/** The two choices every crash-loop incident offers, in the container's terms (W1-T11421 design 5). */
const CRASHLOOP_OPTIONS = [
  {
    label: "read the last boot's failure and fix the cause",
    detail:
      "The crash is whatever kills the process between `daemon.boot` and its next clean-exit row. On the host, " +
      "`docker events --filter container=<name> --filter event=die` gives each exit code (134 is a V8 heap abort) " +
      "and `docker logs` the heap-limit line; compare the last `daemon.memory` sample with the heap ceiling in " +
      "force. The entrypoint records that same wait status and heap-limit line before its crash throttle and exit. " +
      "Freshness (75), blocked (76) and environmental (77) exits instead take its in-container sync/restart path. " +
      "Disk-full, a thrown ledger write, a whole-ledger reader and a bad deploy are the observed causes.",
  },
  {
    label: "pause the fleet while diagnosing",
    detail: "Run `rmd pause --instance <name> --reason crash-loop` in the container: the daemon idles in-process, so the " +
      "restart loop stops costing in-flight work, until `rmd resume --instance <name>`.",
  },
];

/** W1-T11421's incident rows. `escalated` is the existing crash-loop marker, carrying `basis: "learned"`. */
export const DAEMON_CRASHLOOP_ESCALATED_STEP = "daemon.crashloop.escalated";
export const DAEMON_CRASHLOOP_UPDATED_STEP = "daemon.crashloop.updated";
export const DAEMON_CRASHLOOP_CLEARED_STEP = "daemon.crashloop.cleared";
/** The incident's title. It names no count, so every later exit in the run reads as the same incident. */
export const LEARNED_CRASHLOOP_SUMMARY = "daemon crash-loop: abnormal exits shorter than its learned clean lifetime";
const EXIT_CODE_SOURCE = "no supervisor exit row in this ledger tail";

/** PRIMARY CONTROL (GitHub's, not ours): GitHub refuses an issue title longer than 256 characters. */
export const GITHUB_ISSUE_TITLE_LIMIT = 256;
/** W1-T14733: the hidden line that keys an incident's one status comment to its run, so each boot edits it in place. */
export const CRASHLOOP_STATUS_MARKER = (runFirst: string): string => `<!-- rmd-crashloop-status:${runFirst} -->`;

/**
 * W1-T14733: a learned incident's summary names what its exits stopped on, so the title says what is failing and a new
 * cause is a new incident. An exit with no summary keeps the causeless summary. The cause is cut only where the whole
 * title would pass GitHub's own title limit.
 */
export function learnedCrashLoopSummary(cause: string | null): string {
  if (cause === null) return LEARNED_CRASHLOOP_SUMMARY;
  const room = GITHUB_ISSUE_TITLE_LIMIT - "[BLOCKED] DAEMON: ".length - `${LEARNED_CRASHLOOP_SUMMARY} — `.length;
  const oneLine = cause.replace(/\s+/g, " ").trim();
  return `${LEARNED_CRASHLOOP_SUMMARY} — ${oneLine.length > room ? `${oneLine.slice(0, room - 1)}…` : oneLine}`;
}

/** An open learned crash-loop incident, keyed by the first process of its run. */
export interface CrashLoopIncident {
  runFirst: string;
  issueUrl: string | null;
  p90Ms?: number;
  /** W1-T14733: the stopDetail it was raised for; null for exits that said none, undefined for an incident raised before. */
  cause?: string | null;
  /** W1-T14733: its escalation summary, which is its identity in the spool. */
  summary?: string;
  /** W1-T14733: when it was raised, the earliest its status comment can be. */
  escalatedTs?: string;
}

export interface CrashSentinelCtx {
  owner: string;
  repo: string;
  ledgerPath: string;
  runId: string;
  issues?: IssueGateway;
}

const minutes = (ms: number): number => Math.round(ms / 60_000);
const mib = (bytes: number): number => Math.round(bytes / (1024 * 1024));

function lifetimeRowOf(end: DaemonProcessEnd, runId: string): Record<string, unknown> & { step: string; run_id: string; task_id: string } {
  const base = {
    run_id: runId, task_id: "DAEMON", prior_run_id: end.runId, boot_ts: end.bootTs, ended_ts: end.endedTs,
    ended_basis: end.endedBasis, lifetime_ms: end.lifetimeMs,
  };
  if (end.cleanStep) return { ...base, step: DAEMON_CLEAN_EXIT_OBSERVED_STEP, clean_step: end.cleanStep };
  const memory = end.lastMemory;
  return {
    ...base,
    step: DAEMON_ABNORMAL_EXIT_STEP,
    stop_detail: end.stopDetail ?? null,
    exit_code: end.exitCode ?? null,
    exit_code_source: end.exitCode === undefined ? EXIT_CODE_SOURCE : "entrypoint wait (container die status)",
    heap_limit_bytes: memory?.heapLimitBytes ?? end.heapLimitBytes ?? null,
    last_memory: memory === undefined ? null : {
      ts: memory.ts,
      heap_used_bytes: memory.heapUsedBytes ?? null,
      heap_limit_bytes: memory.heapLimitBytes ?? null,
      rss_bytes: memory.rssBytes ?? null,
    },
    heap_limit_line: end.heapLimitLine ?? null,
  };
}

function lifetimeRecordOf(row: Record<string, unknown>): DaemonLifetimeRecord | undefined {
  if (row.step !== DAEMON_ABNORMAL_EXIT_STEP && row.step !== DAEMON_CLEAN_EXIT_OBSERVED_STEP) return undefined;
  const lifetimeMs = row.lifetime_ms;
  if (typeof row.prior_run_id !== "string" || typeof row.ended_ts !== "string" || typeof lifetimeMs !== "number") return undefined;
  return { runId: row.prior_run_id, endedTs: row.ended_ts, lifetimeMs, clean: row.step === DAEMON_CLEAN_EXIT_OBSERVED_STEP,
    ...(row.step === DAEMON_ABNORMAL_EXIT_STEP ? { stopDetail: typeof row.stop_detail === "string" ? row.stop_detail : null } : {}) };
}

/** One exit's evidence line: lifetime, exit code, last memory sample and heap-limit line, as far as the ledger knows. */
function exitEvidence(row: Record<string, unknown>): string {
  const memory = row.last_memory as { ts?: string; heap_used_bytes?: number | null; heap_limit_bytes?: number | null; rss_bytes?: number | null } | null | undefined;
  const used = memory?.heap_used_bytes ?? undefined;
  const limit = memory?.heap_limit_bytes ?? (typeof row.heap_limit_bytes === "number" ? row.heap_limit_bytes : undefined);
  const heap = used === undefined ? "no heap reading"
    : limit === undefined ? `heap ${mib(used)} MiB`
    : `heap ${mib(used)} of ${mib(limit)} MiB in force (${Math.round((100 * used) / limit)}%)`;
  const rss = memory?.rss_bytes == null ? "" : `, rss ${mib(memory.rss_bytes)} MiB`;
  const sample = memory ? `last daemon.memory sample ${memory.ts}: ${heap}${rss}`
    : `no daemon.memory sample${limit === undefined ? "" : `; heap ceiling ${mib(limit)} MiB in force`}`;
  return `- ${String(row.prior_run_id)}: booted ${String(row.boot_ts)}, lived ${minutes(Number(row.lifetime_ms))} min (to its last row); ` +
    `exit code ${typeof row.exit_code === "number" ? row.exit_code : `unknown (${EXIT_CODE_SOURCE})`}; ${sample}; ` +
    `heap-limit line: ${typeof row.heap_limit_line === "string" ? row.heap_limit_line : "none in the ledger"}`;
}

function learnedLine(learned: LearnedCleanLifetime): string {
  return `median ${minutes(learned.medianMs)} min, p90 ${minutes(learned.p90Ms)} min, from ${learned.samples} cleanly-ended processes`;
}

function learnedCrashLoopEscalation(run: DaemonLifetimeRecord[], allRows: Record<string, unknown>[], learned: LearnedCleanLifetime, runId: string, cause: string | null) {
  const runIds = new Set(run.map((r) => r.runId));
  const evidence = allRows.filter((row) => row.step === DAEMON_ABNORMAL_EXIT_STEP && runIds.has(String(row.prior_run_id))).map(exitEvidence);
  return {
    class: "BLOCKED" as const,
    taskId: "DAEMON",
    runId,
    summary: learnedCrashLoopSummary(cause),
    detail:
      `${cause === null ? "" : `Stopped on: ${cause}\n\n`}W1-T11421: ${run.length} consecutive daemon processes ended with no clean-exit row before the next boot, ` +
      `each living less than this instance's learned clean lifetime (${learnedLine(learned)}). In the container an ` +
      `abnormal exit is a heap abort (exit 134), a kill or a crash: the entrypoint records its wait status and ` +
      `heap-limit stderr line, then exits the container with that status and ` +
      `docker's restart policy starts the daemon again, so the loop runs until its cause is fixed. No ten-minute ` +
      `window needs to hold six boots for this to fire. This issue is updated with each further exit and closes ` +
      `itself once a process outlives the p90. Exits, oldest first:\n${evidence.join("\n")}`,
    options: CRASHLOOP_OPTIONS,
    recommendation: "read the last boot's failure and fix the cause",
  };
}

/** The newest learned incident with no cleared row after it, and every run already escalated. */
function incidentState(lines: ReadonlyArray<Record<string, unknown>>): { open?: CrashLoopIncident; escalatedRuns: Set<string> } {
  const escalatedRuns = new Set<string>();
  const cleared = new Set<string>();
  let open: CrashLoopIncident | undefined;
  for (const line of lines) {
    if (typeof line.run_first !== "string") continue;
    if (line.step === DAEMON_CRASHLOOP_ESCALATED_STEP && line.basis === "learned") {
      escalatedRuns.add(line.run_first);
      open = { runFirst: line.run_first, issueUrl: typeof line.issue_url === "string" ? line.issue_url : null,
        ...(typeof line.clean_lifetime_p90_ms === "number" ? { p90Ms: line.clean_lifetime_p90_ms } : {}),
        ...(line.cause === null || typeof line.cause === "string" ? { cause: line.cause } : {}),
        ...(typeof line.summary === "string" ? { summary: line.summary } : {}),
        ...(typeof line.ts === "string" ? { escalatedTs: line.ts } : {}) };
    } else if (line.step === DAEMON_CRASHLOOP_CLEARED_STEP) {
      cleared.add(line.run_first);
    }
  }
  return { open: open && !cleared.has(open.runFirst) ? open : undefined, escalatedRuns };
}

/** Hand recovery to the launcher's durable withdraw-or-close path before clearing the incident. */
export function clearDaemonCrashLoopIncident(incident: CrashLoopIncident, reason: string, ctx: CrashSentinelCtx, ended?: string): void {
  const stateDir = dirname(ctx.ledgerPath);
  const identity = { taskId: "DAEMON", summary: incident.summary ?? LEARNED_CRASHLOOP_SUMMARY };
  const meta = { source: "daemon-crashloop", host: hostname(), clock: systemClock };
  const comment = `W1-T11421: ${reason}, so ${ended ?? "the crash loop has ended"} — closing.`;
  const deliveredUrl = deliveredEscalationUrl(stateDir, identity);
  withdrawSpooledEscalation(stateDir, identity, comment, meta);
  // Older incidents were posted directly rather than through the spool; retain their known URL.
  if (incident.issueUrl && incident.issueUrl !== deliveredUrl) {
    spoolIssueAction(stateDir, { kind: "close", url: incident.issueUrl, body: comment }, meta);
  }
  appendLedger(ctx.ledgerPath, {
    run_id: ctx.runId, task_id: "DAEMON", step: DAEMON_CRASHLOOP_CLEARED_STEP,
    run_first: incident.runFirst, issue_url: incident.issueUrl, reason, close_queued: Boolean(incident.issueUrl || deliveredUrl),
  });
}

/**
 * W1-T14733: write an incident's one status comment. A gateway that can list and edit comments edits the comment its
 * marker names; one that cannot, or a list or edit that fails, posts it as a new comment; a refused post is spooled
 * for the daemon's host-spool drain. The outcome names which, and the error that forced a fallback.
 */
export function writeCrashLoopStatus(issues: IssueGateway, open: CrashLoopIncident, body: string, ctx: CrashSentinelCtx):
  { delivered: boolean; queued: boolean; outcome: "edited" | "posted" | "spooled" | "unwritten"; error?: string } {
  const url = open.issueUrl!;
  let error: string | undefined;
  if (issues.listCommentsSince && issues.editComment) {
    try {
      const prior = issues.listCommentsSince(url, open.escalatedTs ?? new Date(0).toISOString())
        .filter((comment) => comment.body.includes(CRASHLOOP_STATUS_MARKER(open.runFirst))).at(-1);
      if (prior) {
        issues.editComment(prior.id, body);
        return { delivered: true, queued: false, outcome: "edited" };
      }
    } catch (failure) {
      error = `status edit: ${String((failure as Error)?.message ?? failure)}`.slice(0, 240);
    }
  }
  try {
    if (issues.comment) {
      issues.comment(url, body);
      return { delivered: true, queued: false, outcome: "posted", ...(error ? { error } : {}) };
    }
  } catch (failure) {
    error = `status post: ${String((failure as Error)?.message ?? failure)}`.slice(0, 240);
  }
  try {
    spoolIssueAction(dirname(ctx.ledgerPath), { kind: "comment", url, body }, { source: "daemon-crashloop", host: hostname(), clock: systemClock });
    return { delivered: false, queued: true, outcome: "spooled", ...(error ? { error } : {}) };
  } catch (failure) {
    return { delivered: false, queued: false, outcome: "unwritten", error: `status spool: ${String((failure as Error)?.message ?? failure)}`.slice(0, 240) };
  }
}

/**
 * W1-T11421 — the slow crash-loop sentinel, run once per boot over the boot-ledger tail. 2026-11-05: core aborted 29
 * times in 9 h at its heap limit, 15-28 minutes apart. No ten-minute window held six boots, so nothing alerted.
 *
 * TIERS. Every ended prior process gets one lifetime row: `daemon.crash.abnormal_exit`, with its evidence, or
 * `daemon.clean_exit.observed`. The clean lifetimes teach the instance's median and p90. A trailing run of abnormal
 * exits, each shorter than the median, raises ONE incident with a summary that names no count. Each further abnormal
 * exit is appended to that incident, never a second issue. The incident closes when a process outlives the p90: at
 * the next boot if it already has, else by the timer the caller arms. A lone abnormal exit after a long life only
 * ledgers its row. With fewer than two clean lifetimes it returns no summary, and the ten-minute window decides.
 */
export function runDaemonCrashSentinel(
  lines: ReadonlyArray<Record<string, unknown>>,
  nowIso: string,
  ctx: CrashSentinelCtx,
): { summary?: LearnedCrashLoopSummary; incident?: CrashLoopIncident } {
  const ended = classifyEndedDaemonProcesses(lines, nowIso);
  const newRows = ended.map((end) => lifetimeRowOf(end, ctx.runId));
  for (const row of newRows) appendLedger(ctx.ledgerPath, row);
  const allRows = [...lines.filter((l) => lifetimeRecordOf(l) !== undefined), ...newRows];
  const history = allRows.map(lifetimeRecordOf).filter((r): r is DaemonLifetimeRecord => r !== undefined);
  const learned = learnedCleanLifetime(history.filter((r) => r.clean).map((r) => r.lifetimeMs));
  if (!learned) return {};
  const abnormalRows = newRows.filter((row) => row.step === DAEMON_ABNORMAL_EXIT_STEP);
  const state = incidentState(lines);
  let open = state.open;
  let incident: LearnedCrashLoopSummary["incident"] = open ? "open" : "none";
  const newestEnd = ended.at(-1);
  const recoveryP90 = open?.p90Ms ?? learned.p90Ms;
  const outlived = newestEnd?.cleanStep && newestEnd.lifetimeMs > recoveryP90 ? newestEnd : undefined;
  if (open && outlived) {
    clearDaemonCrashLoopIncident(open, `${outlived.runId} lived ${minutes(outlived.lifetimeMs)} min, past the learned p90 (${learnedLine(learned)})`, ctx);
    open = undefined;
    incident = "cleared";
  }
  const run = crashLoopRunOf(history, learned);
  /** Raise one incident for `causeRun`, the trailing exits that share `cause`, and ledger it. */
  const escalateRun = (causeRun: DaemonLifetimeRecord[], cause: string | null): CrashLoopIncident => {
    const summary = learnedCrashLoopSummary(cause);
    const issueUrl = tryEscalate(learnedCrashLoopEscalation(causeRun, allRows, learned, ctx.runId, cause),
      { issues: ctx.issues ?? ghIssueGateway(ctx.owner, ctx.repo), ledgerPath: ctx.ledgerPath, runId: ctx.runId });
    appendLedger(ctx.ledgerPath, {
      run_id: ctx.runId, task_id: "DAEMON", step: DAEMON_CRASHLOOP_ESCALATED_STEP, basis: "learned",
      run_first: causeRun[0].runId, run_newest: causeRun[causeRun.length - 1].runId, run_length: run.length,
      clean_lifetime_median_ms: learned.medianMs, clean_lifetime_p90_ms: learned.p90Ms,
      issue_url: issueUrl, delivered: issueUrl !== null, cause, summary,
    });
    return { runFirst: causeRun[0].runId, issueUrl, p90Ms: learned.p90Ms, cause, summary, escalatedTs: nowIso };
  };
  // W1-T14733: the newest exit in the run names what the loop stops on now. An open incident raised for another cause
  // is closed naming the new one, and the new cause is raised as its own incident, so its title tells the operator.
  const newest = run.at(-1);
  const newestCause = newest?.stopDetail ?? null;
  if (open && newest && abnormalRows.some((row) => row.prior_run_id === newest.runId) && newestCause !== (open.cause ?? null)) {
    let first = run.length - 1;
    while (first > 0 && (run[first - 1].stopDetail ?? null) === newestCause) first--;
    clearDaemonCrashLoopIncident(open, `the stop cause changed to ${newestCause === null ? "an exit that named none" : JSON.stringify(newestCause)}`, ctx,
      "this incident's cause has ended and the new one is raised as its own incident");
    open = escalateRun(run.slice(first), newestCause);
    incident = "reescalated";
  } else if (open) {
    if (!open.issueUrl && run.length >= 2) {
      const issueUrl = tryEscalate(learnedCrashLoopEscalation(run, allRows, learned, ctx.runId, open.cause ?? null),
        { issues: ctx.issues ?? ghIssueGateway(ctx.owner, ctx.repo), ledgerPath: ctx.ledgerPath, runId: ctx.runId });
      appendLedger(ctx.ledgerPath, {
        run_id: ctx.runId, task_id: "DAEMON", step: DAEMON_CRASHLOOP_ESCALATED_STEP, basis: "learned",
        run_first: open.runFirst, run_newest: run[run.length - 1].runId, run_length: run.length,
        clean_lifetime_median_ms: learned.medianMs, clean_lifetime_p90_ms: open.p90Ms ?? learned.p90Ms,
        issue_url: issueUrl, delivered: issueUrl !== null, cause: open.cause ?? null, summary: open.summary ?? learnedCrashLoopSummary(open.cause ?? null),
      });
      if (issueUrl) open = { ...open, issueUrl };
    }
    const updates = lines.filter((line) => line.step === DAEMON_CRASHLOOP_UPDATED_STEP && line.run_first === open?.runFirst);
    const latestByRun = new Map<string, Record<string, unknown>>();
    for (const update of updates) if (typeof update.prior_run_id === "string") latestByRun.set(update.prior_run_id, update);
    const pendingIds = new Set([...latestByRun]
      .filter(([, update]) => update.delivered === false && update.queued !== true).map(([id]) => id));
    const rowsToUpdate = new Map<string, Record<string, unknown>>();
    for (const row of abnormalRows) rowsToUpdate.set(String(row.prior_run_id), row);
    for (const id of pendingIds) {
      const row = allRows.find((candidate) => candidate.step === DAEMON_ABNORMAL_EXIT_STEP && candidate.prior_run_id === id);
      if (row) rowsToUpdate.set(id, row);
    }
    // W1-T14733: every pending exit is folded into ONE status comment, edited in place each boot, never a comment per
    // exit: the newest exit's evidence and the run's length say what the incident needs to.
    const statusRow = [...rowsToUpdate.values()].at(-1);
    if (statusRow && open.issueUrl) {
      const body = `${CRASHLOOP_STATUS_MARKER(open.runFirst)}\nCrash-loop status, edited in place at each boot (W1-T14733): ` +
        `${run.length} short exits in the trailing run, first ${run[0]?.runId ?? open.runFirst}, newest ${String(statusRow.prior_run_id)}; ` +
        `stopped on: ${open.cause ?? "no stop detail"}; ${learnedLine(learned)}.\nNewest exit:\n${exitEvidence(statusRow)}`;
      const status = writeCrashLoopStatus(ctx.issues ?? ghIssueGateway(ctx.owner, ctx.repo), open, body, ctx);
      for (const row of rowsToUpdate.values()) {
        appendLedger(ctx.ledgerPath, {
          run_id: ctx.runId, task_id: "DAEMON", step: DAEMON_CRASHLOOP_UPDATED_STEP,
          run_first: open.runFirst, prior_run_id: row.prior_run_id, run_length: run.length, issue_url: open.issueUrl,
          delivered: status.delivered, queued: status.queued, status_comment: status.outcome, ...(status.error ? { error: status.error } : {}),
        });
      }
      incident = "updated";
    }
  } else if (run.length >= 2 && !state.escalatedRuns.has(run[0].runId)) {
    open = escalateRun(run, newestCause);
    incident = "opened";
  }
  return {
    summary: { basis: "learned", learned, runLength: run.length, abnormalExits: abnormalRows.length, incident },
    ...(open ? { incident: open } : {}),
  };
}

/** Node fires a longer timer at once, so a longer wait re-arms in pieces this size. */
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

/** The boot's sentinel as `daemonBoot`'s `crashLoopCheck.sentinel`: it runs {@link runDaemonCrashSentinel} and, while an
 *  incident is open, arms the clear for when this process outlives the p90. A throw is ledgered and the window decides. */
export function daemonCrashSentinel(
  lines: ReadonlyArray<Record<string, unknown>>,
  ctx: CrashSentinelCtx,
  timers: {
    setTimer?: (fn: () => void, ms: number) => { unref?: () => unknown };
    clearTimer?: (handle: unknown) => void;
    onArmed?: (cancel: () => void) => void;
  } = {},
): (nowIso: string) => LearnedCrashLoopSummary | undefined {
  const setTimer = timers.setTimer ?? setTimeout;
  const clearTimer = timers.clearTimer ?? ((handle: unknown) => clearTimeout(handle as NodeJS.Timeout));
  return (nowIso) => {
    try {
      const { summary, incident } = runDaemonCrashSentinel(lines, nowIso, ctx);
      if (summary && incident) {
        let remaining = summary.learned.p90Ms + 1;
        const knownExits = new Set(readLedgerLines(ctx.ledgerPath)
          .filter((r) => r.step === DAEMON_ABNORMAL_EXIT_STEP).map((r) => r.prior_run_id));
        let handle: unknown;
        const arm = (): void => {
          const wait = Math.min(remaining, MAX_TIMER_DELAY_MS);
          remaining -= wait;
          const timer = setTimer(() => {
            if (remaining > 0) return arm();
            if (readLedgerLines(ctx.ledgerPath).some((r) => r.step === DAEMON_ABNORMAL_EXIT_STEP && !knownExits.has(r.prior_run_id))) return;
            try {
              clearDaemonCrashLoopIncident(incident, `${ctx.runId} outlived the learned p90 (${learnedLine(summary.learned)})`, ctx);
            } catch (error) {
              appendLedger(ctx.ledgerPath, {
                run_id: ctx.runId, task_id: "DAEMON", step: "daemon.crashloop_sentinel_failed",
                error: `queue recovery close: ${String((error as Error)?.message ?? error)}`.slice(0, 240),
              });
              remaining = summary.learned.p90Ms + 1;
              arm();
            }
          }, wait);
          timer.unref?.();
          handle = timer;
        };
        arm();
        timers.onArmed?.(() => clearTimer(handle));
      }
      return summary;
    } catch (error) {
      appendLedger(ctx.ledgerPath, {
        run_id: ctx.runId, task_id: "DAEMON", step: "daemon.crashloop_sentinel_failed",
        error: String((error as Error)?.message ?? error).slice(0, 240),
      });
      return undefined;
    }
  };
}

/**
 * W1-T215's escalation side — `escalateCircuitBreak`'s sibling for the daemon BOOT-RATE invariant:
 * called by `daemonBoot`'s `crashLoopCheck.onBreach` (lib/daemon.ts) when `detectDaemonCrashLoop`
 * finds MORE than `maxBoots` boots inside one rolling `windowMs`. The 2026-08-03 ENOSPC storm
 * relaunched the daemon ten times with ZERO escalation; this opens a needs-human issue carrying the
 * densest window's boot timestamps.
 *
 * CROSS-BOOT DEDUP keyed on the STORM (no task, and a process flag would open one issue per boot):
 * skip iff a prior `daemon.crashloop.escalated` marker's `window_newest` falls within `windowMs` of
 * THIS verdict's newest boot; a new storm after a quiet gap escalates again. The marker is written
 * whether or not delivery succeeds (`escalateCircuitBreak`'s reason). The step is in
 * DECISION_RELEVANT_LEDGER_STEPS (ledger.ts) — a rotation archiving it would re-open a duplicate
 * issue per boot (the #977 class).
 *
 * DELIBERATELY NOT A BOOT BLOCKER: `daemon.crashloop_check` is logged either way and boot continues;
 * `state/PAUSE` remains the stop. Since W1-T11421 it decides only while the instance has no learned
 * clean lifetime; {@link runDaemonCrashSentinel} decides after that.
 */
export function escalateCrashLoop(
  verdict: CrashLoopVerdict,
  ctx: { owner: string; repo: string; ledgerPath: string; runId: string; issues?: IssueGateway },
): void {
  const newest = verdict.windowBoots[verdict.windowBoots.length - 1];
  const newestMs = Date.parse(newest ?? "");
  if (!verdict.breached || !Number.isFinite(newestMs)) return;
  const tail = readLedgerLines(ctx.ledgerPath);
  const already = tail.some((l) => {
    if (l.step !== "daemon.crashloop.escalated") return false;
    const priorMs = Date.parse(String(l.window_newest ?? ""));
    return Number.isFinite(priorMs) && newestMs - priorMs <= verdict.windowMs;
  });
  if (already) return;
  const issueUrl = tryEscalate(
    {
      class: "BLOCKED",
      taskId: "DAEMON",
      runId: ctx.runId,
      summary: `daemon crash-loop: ${verdict.windowBoots.length} boots inside ${Math.round(verdict.windowMs / 60_000)} minutes`,
      detail:
        `W1-T215: detectDaemonCrashLoop found ${verdict.windowBoots.length} daemon boots inside one rolling ` +
        `${Math.round(verdict.windowMs / 60_000)}-minute window (threshold: more than ${verdict.maxBoots}). ` +
        `This instance has no learned clean lifetime yet, so the ten-minute window decides (W1-T11421). In the ` +
        `container a daemon that exits outside the entrypoint's freshness, blocked and environmental arms ends the ` +
        `container, and docker's restart policy starts it again, so a boot rate like this means the daemon is ` +
        `DYING during or shortly after boot, being restarted, and dying again — the 2026-08-03 shape, where an ` +
        `ENOSPC write in the boot path crash-looped ten boots with no signal. The densest window's boots, oldest ` +
        `first: ${verdict.windowBoots.join(", ")}. Boot itself is NOT blocked by this notice; the loop is still ` +
        `running until acted on. Exit evidence:\n` +
        tail.filter((r) => r.step === DAEMON_ABNORMAL_EXIT_STEP).map(exitEvidence).join("\n"),
      options: CRASHLOOP_OPTIONS,
      recommendation: "read the last boot's failure and fix the cause",
    },
    {
      issues: ctx.issues ?? ghIssueGateway(ctx.owner, ctx.repo),
      ledgerPath: ctx.ledgerPath,
      runId: ctx.runId,
    },
  );
  appendLedger(ctx.ledgerPath, {
    run_id: ctx.runId,
    task_id: "DAEMON",
    step: "daemon.crashloop.escalated",
    window_newest: newest,
    window_boots: verdict.windowBoots.length,
    window_ms: verdict.windowMs,
    max_boots: verdict.maxBoots,
    issue_url: issueUrl,
    delivered: issueUrl !== null,
  });
}

/**
 * The post-review STALL notice: the sweep's `postReview` path has failed {@link
 * POST_REVIEW_STALL_THRESHOLD} times in a row with no success between.
 *
 * THE DEFECT, MEASURED. `sweep.post_review.failed` fired 91 times in a week (each a GraphQL
 * rate-limit) with NO operator-visible signal while green PRs sat unreviewed. A transport fix
 * removes this CAUSE; only a signal removes the CLASS.
 */

/**
 * WHY A NEW CLASS. A decision-authority audit found the escalation funnel INVERTED (of 369
 * needs-human issues ~80% were machine-resolved, never retracted), so noise is the failure mode.
 * This qualifies because the machine CANNOT resolve it: it is fleet-wide, blocks EVERY green PR,
 * and its observed cause, an exhausted API quota, is outside the fleet's power. Reusing
 * `daemon.crashloop` would misname it; a per-task class would file one issue per stuck PR.
 */

/**
 * DEDUP IS THE WHOLE DESIGN. `escalate()` gates its dedup block on `if (prRef && deps.issues.listOpen)`,
 * so an escalation naming no PR opens a FRESH issue every call (the eight-identical-"dispatch queue
 * starved" shape). This one is fleet-wide, so it dedups on an EPISODE key in the ledger: skip iff a
 * prior `sweep.post_review.stalled.escalated` marker's `episode_newest` is within `episodeMs` of
 * THIS verdict's newest failure. The marker is written whether or not delivery succeeded
 * (`escalateCircuitBreak`'s reason); the step is in DECISION_RELEVANT_LEDGER_STEPS (ledger.ts)
 * because THIS function reads it back.
 */
export const POST_REVIEW_STALL_EPISODE_MS = 60 * 60 * 1000;

export function escalatePostReviewStall(
  verdict: PostReviewStallVerdict,
  ctx: { owner: string; repo: string; ledgerPath: string; runId: string; issues?: IssueGateway; episodeMs?: number },
): void {
  const newestMs = Date.parse(verdict.newestFailureTs ?? "");
  if (!verdict.stalled || !Number.isFinite(newestMs)) return;
  const episodeMs = ctx.episodeMs ?? POST_REVIEW_STALL_EPISODE_MS;
  const already = readLedgerLines(ctx.ledgerPath).some((l) => {
    if (l.step !== "sweep.post_review.stalled.escalated") return false;
    const priorMs = Date.parse(String(l.episode_newest ?? ""));
    return Number.isFinite(priorMs) && newestMs - priorMs <= episodeMs;
  });
  if (already) return;
  const quota = verdict.rateLimited
    ? " Every failure in the run is an API quota exhaustion, which is fleet-stopping but self-clearing at the " +
      "bucket's reset — check `gh api rate_limit` before assuming a code fault."
    : "";
  const issueUrl = tryEscalate(
    {
      class: "BLOCKED",
      taskId: "DAEMON",
      runId: ctx.runId,
      summary: `post-review stalled: ${verdict.consecutiveFailures} consecutive failures, no review posted`,
      detail:
        `The sweep's post-review path has failed ${verdict.consecutiveFailures} times in a row with no success ` +
        `between (first ${verdict.oldestFailureTs}, newest ${verdict.newestFailureTs}). While this holds, a PR ` +
        `whose checks are green never receives its remudero-review status, so it cannot merge and the sweep ` +
        `re-attempts it every tick — silently, which is why this notice exists.${quota} The failing call, with ` +
        `digits normalised so one stall does not read as many: ${verdict.normalisedError}`,
      options: [
        {
          label: "clear the cause, then let the next sweep tick post the reviews",
          detail:
            "No manual re-drive is needed — the sweep re-attempts every tick, so the backlog clears itself once " +
            "the cause is gone." +
            // Only offered when it actually applies: naming a quota remedy on a stall that is not a
            // quota problem sends the operator to the wrong instrument, which is the failure mode
            // this whole notice exists to avoid.
            (verdict.rateLimited ? " `gh api rate_limit` shows the reset." : ""),
        },
        {
          label: "post the blocked reviews by hand",
          detail: "`rmd review <pr>` per stuck PR — the same deterministic verb the sweep calls.",
        },
      ],
      recommendation: "clear the cause, then let the next sweep tick post the reviews",
    },
    { issues: ctx.issues ?? ghIssueGateway(ctx.owner, ctx.repo), ledgerPath: ctx.ledgerPath, runId: ctx.runId },
  );
  appendLedger(ctx.ledgerPath, {
    run_id: ctx.runId,
    task_id: "DAEMON",
    step: "sweep.post_review.stalled.escalated",
    episode_newest: verdict.newestFailureTs,
    consecutive_failures: verdict.consecutiveFailures,
    rate_limited: verdict.rateLimited,
    issue_url: issueUrl,
    delivered: issueUrl !== null,
  });
}

/**
 * P34 clause (c), W1-T249: the daemon's `onHeadroomBreach` hook, called when a weekly (or session)
 * window first crosses the operator reserve. Dispatch is ALREADY paused (`runDaemon`'s in-process
 * idle) — a pure notification.
 *
 * CROSS-BOOT DEDUP keyed on `resetsAt`, not task id (the breach belongs to the account) and not a
 * per-process flag (a restart forgets it). `resets_at` is unchanged while the breach persists and
 * new once the window resets, so a later breach escalates again. The marker is written whether or
 * not delivery succeeded (`escalateCircuitBreak`'s discipline).
 */
export function escalateHeadroomReserve(
  info: { window: string; percentUsed: number; limitPct: number; resetsAt: string },
  ctx: { owner: string; repo: string; ledgerPath: string; runId: string; issues?: IssueGateway },
): void {
  const already = readLedgerLines(ctx.ledgerPath).some(
    (l) => l.step === "daemon.headroom_reserve.escalated" && l.resets_at === info.resetsAt,
  );
  if (already) return;
  const issueUrl = tryEscalate(
    {
      class: "HARD_STOP",
      taskId: "daemon",
      runId: ctx.runId,
      // THE WINDOW IS DATA, NEVER A LITERAL. This summary hardcoded "weekly" while the detail
      // below has always interpolated `info.window` correctly, so every session exhaustion opened
      // an issue TITLED weekly with a BODY reading `session (5h)`. MEASURED on #3483: the title
      // said "weekly headroom reserve reached — dispatch paused until 2026-09-01T12:00:00.000Z"
      // while its own body said "session (5h) is at 100% used", and the daemon telemetry for that
      // episode named `session (5h)` throughout. The daemon could always tell the two apart
      // (`resolveHeadroomWindows` labels them separately); only this line could not.
      summary: `${info.window} headroom reserve reached — dispatch paused until ${info.resetsAt}`,
      detail:
        `P34 clause (c): ${info.window} is at ${info.percentUsed}% used (>= the ${info.limitPct}% operator ` +
        `reserve ceiling). Dispatch is paused — drain-and-hold, in-flight work finishes, no new spawn — until ` +
        `the window resets at ${info.resetsAt}; imputed ledger dollar figures never gate this decision, only ` +
        `the subscription window itself does.`,
      options: [
        {
          label: "wait for reset",
          detail: `Dispatch resumes on its own once the window resets at ${info.resetsAt} — no action needed.`,
        },
        {
          label: "raise the reserve",
          detail: "If 5% is too conservative for this account, retune the HEADROOM_LIMIT_PCT policy curve.",
        },
      ],
      recommendation: "wait for reset",
    },
    {
      issues: ctx.issues ?? ghIssueGateway(ctx.owner, ctx.repo),
      ledgerPath: ctx.ledgerPath,
      runId: ctx.runId,
    },
  );
  appendLedger(ctx.ledgerPath, {
    run_id: ctx.runId,
    task_id: "daemon",
    step: "daemon.headroom_reserve.escalated",
    // W1-T2603: the window this escalation was raised FOR, so a later recovery reading can be
    // matched against the SAME window rather than merely the same class. Absent on every row this
    // repo wrote before this task — `buildHeadroomRecoveryCandidates` below treats that as
    // unmatchable (never a false match), so the pre-existing #3334/#3384/#3483-shaped issues stay
    // exactly what they already are: manually closed, not silently retired on a guess.
    window: info.window,
    resets_at: info.resetsAt,
    issue_url: issueUrl,
    delivered: issueUrl !== null,
  });
}

/**
 * W1-T1082 (THE DAEMON NEVER READS ITS OWN FREE SPACE): the daemon's `onDiskHeadroomBreach` hook —
 * free space read off `startInFlightTicker`'s cadence (`daemon.ts`) crossed below WARN
 * (`DISK_WARN_BYTES`, 2 GiB) or FAIL (`DISK_FAIL_BYTES`, 512 MiB), judged by the SAME
 * `judgeDiskHeadroom` `rmd doctor` uses (doctor.ts), imported never re-derived.
 *
 * ESCALATES AT WARN, NOT ONLY FAIL (design (iv)): by FAIL, the issue body and this function's
 * own dedup marker may lose to the same ENOSPC. This fires while writes still succeed.
 *
 * DEDUP IS TWO LAYERS. `runDaemon`'s in-process `diskHeadroomLatch` calls this at most once per
 * continuous breach; this function's ledger read covers a mid-episode daemon RESTART (the
 * 2026-08-03 shape), which resets that latch. Skip iff a prior `daemon.disk_headroom.escalated`
 * marker's own `ts` is within `episodeMs` of THIS reading's `ts` (the `escalatePostReviewStall`
 * shape, for a condition with no natural reset boundary). The marker is written whether or not
 * delivery succeeds (`escalateCircuitBreak`'s reason). The step is in
 * `DECISION_RELEVANT_LEDGER_STEPS` (ledger.ts) because THIS function reads it back.
 */
export const DISK_HEADROOM_EPISODE_MS = 60 * 60 * 1000;

export function escalateDiskHeadroomBreach(
  info: { freeBytes: number; verdict: "WARN" | "FAIL"; ts: string },
  ctx: { owner: string; repo: string; ledgerPath: string; runId: string; issues?: IssueGateway; episodeMs?: number },
): void {
  const newestMs = Date.parse(info.ts);
  if (!Number.isFinite(newestMs)) return;
  const episodeMs = ctx.episodeMs ?? DISK_HEADROOM_EPISODE_MS;
  const already = readLedgerLines(ctx.ledgerPath).some((l) => {
    if (l.step !== "daemon.disk_headroom.escalated") return false;
    const priorMs = Date.parse(String(l.ts ?? ""));
    return Number.isFinite(priorMs) && newestMs - priorMs <= episodeMs;
  });
  if (already) return;
  const issueUrl = tryEscalate(
    {
      class: "BLOCKED",
      taskId: "DAEMON",
      runId: ctx.runId,
      summary: `disk headroom ${info.verdict}: ${humanBytes(info.freeBytes)} free`,
      detail:
        `W1-T1082: the daemon's own poll path read ${humanBytes(info.freeBytes)} free on its own filesystem, ` +
        `below the ${humanBytes(DISK_WARN_BYTES)} WARN threshold ` +
        `\`rmd doctor\` also judges against (\`doctor.ts\`'s \`judgeDiskHeadroom\`, one shared definition — the ` +
        `two surfaces cannot disagree). This escalates at WARN rather than waiting for FAIL ` +
        `(${humanBytes(DISK_FAIL_BYTES)}) because by FAIL the ledger this very notice writes to may itself fail ` +
        `to append — the 2026-08-03 ENOSPC storm's own shape, where the first signal anyone had was ` +
        `\`appendLedger\` throwing.`,
      options: [
        {
          label: "reclaim disk space",
          detail:
            "`rmd doctor` names every other measured source on this host; scratch reaping, worker-home reaping " +
            "and the tmp backstop are the usual owners (each has its own task — this notice only surfaces).",
        },
        {
          label: "grow the volume",
          detail: "If this host is routinely this close to full, the ceiling itself may be too small for its workload.",
        },
      ],
      recommendation: "reclaim disk space",
    },
    { issues: ctx.issues ?? ghIssueGateway(ctx.owner, ctx.repo), ledgerPath: ctx.ledgerPath, runId: ctx.runId },
  );
  appendLedger(ctx.ledgerPath, {
    run_id: ctx.runId,
    task_id: "DAEMON",
    step: "daemon.disk_headroom.escalated",
    free_bytes: info.freeBytes,
    verdict: info.verdict,
    issue_url: issueUrl,
    delivered: issueUrl !== null,
  });
}

/**
 * The daemon's `onHeadroomParkCeiling` hook: the headroom park outlived its ceiling, so the fleet
 * dispatched BLIND for one tick rather than idling forever.
 *
 * DEDUPED ACROSS BOOTS on "has the governor SEEN anything since we last paged?": skip when an
 * `.escalated` row is NEWER than the newest `daemon.headroom` row (written by a READABLE probe).
 * One page per blind stretch; a restart-looping blind daemon stays quiet, and a recovered probe
 * re-arms the next stretch. Both rows are in {@link DECISION_RELEVANT_LEDGER_STEPS}; if the
 * readable row vanished first, the comparison fails QUIET, the right direction for a notification.
 */
export function escalateHeadroomParkCeiling(
  info: { consecutiveUnreadable: number; parkedMs: number; ceilingMs: number },
  ctx: { owner: string; repo: string; ledgerPath: string; runId: string; issues?: IssueGateway },
): void {
  // BOTH READS COMPARE AGAINST A STRING LITERAL INLINE, DELIBERATELY, rather than through a
  // helper taking the step name as a parameter. `test/ledger-rotation.test.ts` discovers
  // decision-relevant steps by scanning consumer source for that exact comparison form, so a
  // parameterised helper is INVISIBLE to it — and the rotation-set membership this dedup depends
  // on stops being self-enforcing. Measured: with the loop factored into a generic helper,
  // deleting either entry from DECISION_RELEVANT_LEDGER_STEPS left that test green.
  const lines = readLedgerLines(ctx.ledgerPath);
  let lastReadable: string | undefined;
  let lastEscalated: string | undefined;
  for (const l of lines) {
    const ts = typeof l.ts === "string" ? l.ts : undefined;
    if (!ts) continue;
    if (l.step === "daemon.headroom" && (lastReadable === undefined || ts > lastReadable)) lastReadable = ts;
    if (l.step === "daemon.headroom.park_ceiling.escalated" && (lastEscalated === undefined || ts > lastEscalated)) {
      lastEscalated = ts;
    }
  }
  // Already paged for THIS blind stretch: no readable row at all since, or none newer.
  if (lastEscalated !== undefined && (lastReadable === undefined || lastEscalated > lastReadable)) return;

  const minutes = Math.round(info.ceilingMs / 60_000);
  const issueUrl = tryEscalate(
    {
      // MANUAL, not HARD_STOP: dispatch is NOT paused here — it is proceeding riskily, which is
      // the opposite posture from `escalateHeadroomReserve`'s breach and needs saying.
      class: "MANUAL",
      taskId: "daemon",
      runId: ctx.runId,
      summary: `headroom unreadable for ${minutes}m — dispatching BLIND past the park ceiling`,
      detail:
        `The usage probe has failed ${info.consecutiveUnreadable} consecutive times and the park ` +
        `outlived its ${minutes}-minute ceiling, so the daemon dispatched with NO headroom reading ` +
        `rather than idling forever. The spend bound this bypasses is deliberately accepted, not ` +
        `satisfied: the fleet may now be spending against an exhausted account. The ceiling re-arms, ` +
        `so exposure is one blind dispatch per ${minutes} minutes until a probe succeeds — but the ` +
        `probe itself is the thing to fix. Check the usage.probe_failed rows for the stage and ` +
        `reason, and the worker-home grant rows for a lost .claude slot.`,
      options: [
        {
          label: "fix the probe",
          detail: "Read the usage.probe_failed stage: spawn, parse or grant each point somewhere different.",
        },
        {
          label: "disable the governor",
          detail: "Setting headroom.enabled false skips the park entirely — dispatch stops being gated on a read that cannot succeed.",
        },
      ],
      recommendation: "fix the probe",
    },
    { issues: ctx.issues ?? ghIssueGateway(ctx.owner, ctx.repo), ledgerPath: ctx.ledgerPath, runId: ctx.runId },
  );
  appendLedger(ctx.ledgerPath, {
    run_id: ctx.runId,
    task_id: "daemon",
    step: "daemon.headroom.park_ceiling.escalated",
    consecutive_unreadable: info.consecutiveUnreadable,
    parked_ms: info.parkedMs,
    ceiling_ms: info.ceilingMs,
    // Forensics: the moment the governor last saw anything, which is also this dedup's key.
    blind_since: lastReadable ?? "never",
    issue_url: issueUrl,
    delivered: issueUrl !== null,
  });
}

/**
/**
 * W1-T372: the daemon's `onQuotaExhausted` hook, called when a `gh api rate_limit` bucket (REST/core
 * or GraphQL, read independently) first crosses from having budget to having none. UNLIKE
 * `escalateHeadroomReserve`, dispatch is NOT paused: observe-and-surface only, so an operator is
 * not the one who discovers exhaustion when `gh pr create` dies at a push boundary (W1-T333 lost
 * ~40 minutes of completed work that way, per recon a2b904d).
 */

/**
 * CROSS-BOOT DEDUP keyed on (bucket, resetsAt), the window's own reset instant, kept PER BUCKET so
 * a core and a GraphQL exhaustion each get a notice and a later exhaustion escalates again.
 *
 * SELF-CLEARING, STATED IN THE BODY (design (v)): the notice names its own expiry (`resetsAt`)
 * rather than asking for a human close; W1-T345 is the filed retraction mechanism it does not
 * depend on.
 */

/**
/**
 * W1-T2305 — `deps.provenanceBracket` is THE BRACKET RULE (design (ii)): when a caller HAS two
 * provenanced readings (same actor, same resource), this checks via {@link ghRateLimitWindow}
 * (lib/daemon-health.ts) that they agree on actor AND reset epoch before escalating; a mismatched
 * bracket is DISCARDED (ledgered, never escalated). Optional and omitted by every call site today
 * — an omitted bracket escalates as before, and "dispatch is NOT paused by this hook" still holds.
 */
export function escalateQuotaExhaustion(
  info: { bucket: "core" | "graphql"; remaining: number; resetsAt: string },
  ctx: { owner: string; repo: string; ledgerPath: string; runId: string; issues?: IssueGateway },
  deps: { provenanceBracket?: { start: GhRateLimitProvenance; end: GhRateLimitProvenance } } = {},
): void | Promise<void> {
  if (deps.provenanceBracket && !ghRateLimitWindow(deps.provenanceBracket.start, deps.provenanceBracket.end)) {
    appendLedger(ctx.ledgerPath, {
      run_id: ctx.runId,
      task_id: "daemon",
      step: "daemon.quota_exhausted.provenance_discarded",
      bucket: info.bucket,
      resets_at: info.resetsAt,
    });
    return;
  }
  const already = readLedgerLines(ctx.ledgerPath).some(
    (l) => l.step === "daemon.quota_exhausted.escalated" && l.bucket === info.bucket && l.resets_at === info.resetsAt,
  );
  if (already) return;
  const escalated = (issueUrl: string | null): void => appendLedger(ctx.ledgerPath, {
    run_id: ctx.runId,
    task_id: "daemon",
    step: "daemon.quota_exhausted.escalated",
    bucket: info.bucket,
    resets_at: info.resetsAt,
    issue_url: issueUrl,
    delivered: issueUrl !== null,
  });
  const notice = quotaExhaustionNotice(info, ctx.runId);
  // W1-T13690: a core exhaustion reads and opens its issue through GraphQL, which spends none of core.
  if (info.bucket === "core" && ctx.issues === undefined) {
    return tryEscalateAsync(notice, { issues: ghIssueGatewayGraphql(ctx.owner, ctx.repo), ledgerPath: ctx.ledgerPath, runId: ctx.runId })
      .then(escalated);
  }
  escalated(tryEscalate(notice, { issues: ctx.issues ?? ghIssueGateway(ctx.owner, ctx.repo), ledgerPath: ctx.ledgerPath, runId: ctx.runId }));
}

/** The quota notice. `late`, when set, is the window a notice sent after the reset names (W1-T13690). */
function quotaExhaustionNotice(
  info: { bucket: "core" | "graphql"; remaining: number; resetsAt: string },
  runId: string,
  late?: { firstSeenAt: string },
): Escalation {
  const spent =
    info.bucket === "graphql"
      ? "`gh pr create`, `gh pr view --json`, and therefore `rmd review` — a run that finishes its work and " +
        "then cannot open or update its own PR at this bucket's exhaustion loses that work silently, exactly " +
        "as W1-T333 did"
      : "the board's own `gh pr view`/`pr list`/`issue view` reads (status.ts's `ghGateway`/`buildBatchedGithub`)";
  return {
    class: "HARD_STOP",
    taskId: "daemon",
    runId,
    summary: late
      ? `gh api rate_limit ${info.bucket} bucket was exhausted from ${late.firstSeenAt} to ${info.resetsAt} — sent after the reset`
      : `gh api rate_limit ${info.bucket} bucket exhausted — resets ${info.resetsAt}`,
    detail:
      `W1-T372: the daemon's tick observed the ${info.bucket} bucket cross from having budget to ${info.remaining} ` +
      `remaining. This bucket backs ${spent}. This is a NOTICE, not a hold: dispatch is not paused and no ` +
      `existing consumer's behavior changed — the bucket refills on its own at ${info.resetsAt}, and this notice ` +
      `is self-clearing at that instant with no action required; a human reading this after that time can close ` +
      `it on sight.`,
    options: [
      {
        label: "wait for reset",
        detail: `The bucket refills on its own at ${info.resetsAt} — no action needed.`,
      },
      {
        label: "check what spent it",
        detail: "`gh api rate_limit` shows the live figure; a runaway caller against this bucket is the thing worth finding, not this notice.",
      },
    ],
    recommendation: "wait for reset",
  };
}

/** The live ledger's quota notice rows. Both steps are kept across a rotation, so the live file holds them. */
async function quotaNoticeRows(ledgerPath: string): Promise<Record<string, unknown>[]> {
  let text: string;
  try {
    text = await readFile(ledgerPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const rows: Record<string, unknown>[] = [];
  for (const line of text.split("\n")) {
    if (!line.includes("daemon.quota_exhausted.")) continue;
    try {
      rows.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      // deliberate: a torn line is no row, as readLedgerLines reads it.
    }
  }
  return rows;
}

/**
 * W1-T13690: the daemon's `onQuotaRecovered` hook, called on the tick a bucket reads positive after it read 0
 * in this process. When the newest `daemon.quota_exhausted.escalated` row for the bucket says the notice was
 * not delivered, and no `daemon.quota_exhausted.delivered_late` row has the same bucket and reset, it sends
 * the notice once, naming the window, through the same gateway choice as {@link escalateQuotaExhaustion}.
 * It writes the `delivered_late` row whatever the outcome, so a later tick or a restart sends nothing.
 */
export async function deliverQuotaExhaustionLate(
  info: { bucket: "core" | "graphql" },
  ctx: { owner: string; repo: string; ledgerPath: string; runId: string; issues?: IssueGateway },
): Promise<void> {
  const rows = await quotaNoticeRows(ctx.ledgerPath);
  const newest = rows.filter((l) => l.step === "daemon.quota_exhausted.escalated" && l.bucket === info.bucket).at(-1);
  if (newest === undefined || newest.delivered !== false || typeof newest.resets_at !== "string") return;
  const resetsAt = newest.resets_at;
  if (rows.some((l) => l.step === "daemon.quota_exhausted.delivered_late" && l.bucket === info.bucket && l.resets_at === resetsAt)) return;
  const firstSeenAt = typeof newest.ts === "string" ? newest.ts : "an unrecorded time";
  const notice = quotaExhaustionNotice({ bucket: info.bucket, remaining: 0, resetsAt }, ctx.runId, { firstSeenAt });
  const issues = ctx.issues ?? (info.bucket === "core" ? ghIssueGatewayGraphql(ctx.owner, ctx.repo) : ghIssueGateway(ctx.owner, ctx.repo));
  const issueUrl = await tryEscalateAsync(notice, { issues, ledgerPath: ctx.ledgerPath, runId: ctx.runId });
  appendLedger(ctx.ledgerPath, {
    run_id: ctx.runId,
    task_id: "daemon",
    step: "daemon.quota_exhausted.delivered_late",
    bucket: info.bucket,
    resets_at: resetsAt,
    issue_url: issueUrl,
    delivered: issueUrl !== null,
  });
}

/**
/**
 * Recon oper#queue-starvation-2026-08-03: the daemon's `onStarvation` hook, called on an idle tick
 * whose dispatch-filter census names a RECOVERABLE-class blocker (circuit-broken, blocked, unmet
 * deps). A failing run already escalates, but a queue out of dispatchable work was
 * indistinguishable from a quietly healthy one — both logged only `daemon.idle`. Dispatch is
 * already idle when this fires: a pure notification.
 */

/**
 * CROSS-BOOT DEDUP keyed on "has anything dispatched since this last escalated" — never the census
 * contents, which churn within one episode. If the newest `dispatch.starvation.escalated` row
 * postdates the newest `run.start`, the episode was already reported: no-op. Otherwise escalate and
 * write the marker whether or not delivery succeeded (`escalateCircuitBreak`'s discipline).
 */
export function escalateStarvation(
  census: StarvationCensus,
  ctx: { owner: string; repo: string; ledgerPath: string; runId: string; issues?: IssueGateway },
): void {
  const lines = readLedgerLines(ctx.ledgerPath);
  let lastEscalatedIdx = -1;
  let lastDispatchIdx = -1;
  lines.forEach((l, i) => {
    if (l.step === "dispatch.starvation.escalated") lastEscalatedIdx = i;
    if (l.step === "run.start") lastDispatchIdx = i;
  });
  if (lastEscalatedIdx !== -1 && lastEscalatedIdx > lastDispatchIdx) return;

  const name = (label: string, bucket: { count: number; ids: readonly string[]; truncated: number }): string | null =>
    bucket.count === 0
      ? null
      : `${label}: ${bucket.count} (${bucket.ids.join(", ")}${bucket.truncated > 0 ? `, +${bucket.truncated} more` : ""})`;
  const parts = [
    name("circuit-broken", census.circuitBroken),
    name("blocked", census.blocked),
    name("unmet-deps", census.unmetDeps),
  ].filter((p): p is string => p !== null);

  const issueUrl = tryEscalate(
    {
      class: "BLOCKED",
      taskId: "daemon",
      runId: ctx.runId,
      summary: `dispatch queue starved — zero dispatchable, ${parts.length} recoverable class(es) blocking`,
      detail:
        `oper#queue-starvation-2026-08-03: the queue has nothing dispatchable, but this is NOT ` +
        `every task being done or needing a human — at least one RECOVERABLE-class blocker is ` +
        `holding it back: ${parts.join("; ")}. The fleet has headroom to spend and is sitting idle ` +
        `instead; the only prior symptom was a bare \`daemon.idle\` line every poll.`,
      options: [
        {
          label: "resolve the blockers",
          detail:
            "Fix the named ids: a circuit-broken task needs a manual patch or `rmd fix` (then a " +
            "fresh owned PR clears the breaker); a `blocked:` task needs the plan mark lifted; an " +
            "unmet-deps task clears itself once its dependency merges.",
        },
        {
          label: "acknowledge and wait",
          detail: "If the blockers are already being worked, no action is needed — the daemon keeps polling and re-arms this notice once it next dispatches.",
        },
      ],
      recommendation: "resolve the blockers",
    },
    {
      issues: ctx.issues ?? ghIssueGateway(ctx.owner, ctx.repo),
      ledgerPath: ctx.ledgerPath,
      runId: ctx.runId,
    },
  );
  appendLedger(ctx.ledgerPath, {
    run_id: ctx.runId,
    task_id: "daemon",
    step: "dispatch.starvation.escalated",
    circuit_broken: census.circuitBroken.count,
    blocked: census.blocked.count,
    unmet_deps: census.unmetDeps.count,
    circuit_broken_ids: census.circuitBroken.ids,
    blocked_ids: census.blocked.ids,
    unmet_deps_ids: census.unmetDeps.ids,
    issue_url: issueUrl,
    delivered: issueUrl !== null,
  });
}

/**
 * THE CLEARED HALF — `escalateStarvation` opens an issue and this closes it, fired from
 * `runDaemon`'s `onStarvationCleared` hook on the same edge that resets `starvationEscalated`.
 * `info.reason` and `info.taskId` say why, so the closing comment is never a bare "resolved".
 *
 * THE REFERENT IS THE LEDGER, NEVER A LOOKUP: the issue closed is the one the newest
 * `dispatch.starvation.escalated` row named (unless a later `dispatch.starvation.cleared` row
 * already closed it), so no other class's issue is touched. Absent ⇒ silent no-op.
 *
 * CANNOT-OBSERVE MEANS WAIT (W1-T130): a gateway without `closeWithComment`, or whose close
 * throws, leaves the issue OPEN and costs one `delivered: false` row — never a throw into the
 * daemon loop. The marker is written on every call that found an issue to close.
 */
export function escalateStarvationCleared(
  info: StarvationClearedInfo,
  ctx: { owner: string; repo: string; ledgerPath: string; runId: string; issues?: IssueGateway },
): void {
  const lines = readLedgerLines(ctx.ledgerPath);
  let issueUrl: string | null = null;
  for (const l of lines) {
    if (l.step === "dispatch.starvation.escalated") {
      issueUrl = typeof l.issue_url === "string" ? l.issue_url : null;
    } else if (l.step === "dispatch.starvation.cleared") {
      // A prior clear already closed (or gave up on) whatever the last escalation opened —
      // never re-derive a referent from an OLDER escalated row past this point.
      issueUrl = null;
    }
  }
  if (!issueUrl) return;

  const reasonText =
    info.reason === "no-recoverable-blockers"
      ? "nothing recoverable is blocking the queue anymore"
      : `a dispatchable task appeared${info.taskId ? ` (${info.taskId})` : ""} and ended the episode`;
  const comment =
    `oper#queue-starvation-2026-08-03: this starvation episode has ended — ${reasonText}. ` +
    `Closing automatically; a fresh episode opens its own issue if the queue starves again.`;

  const issues = ctx.issues ?? ghIssueGateway(ctx.owner, ctx.repo);
  let delivered = false;
  let failure: string | undefined;
  if (!issues.closeWithComment) {
    failure = "issue gateway cannot close issues";
  } else {
    try {
      issues.closeWithComment(issueUrl, comment);
      delivered = true;
    } catch (e) {
      // CANNOT-OBSERVE MEANS WAIT (W1-T130): never rethrown into the daemon loop -- the
      // ledger row appended below carries this as its own `failure` field instead.
      failure = String((e as Error)?.message ?? e);
    }
  }

  appendLedger(ctx.ledgerPath, {
    run_id: ctx.runId,
    task_id: info.taskId ?? "daemon",
    step: "dispatch.starvation.cleared",
    reason: info.reason,
    issue_url: issueUrl,
    delivered,
    ...(failure ? { failure } : {}),
  });
}

/** W1-T13248: the ledger markers of the claim-stall page — one per open, one per clear. */
export const CLAIM_STALL_ESCALATED_STEP = "dispatch.claim_stall.escalated";
export const CLAIM_STALL_CLEARED_STEP = "dispatch.claim_stall.cleared";

type ClaimStallCtx = { owner: string; repo: string; ledgerPath: string; runId: string; issues?: IssueGateway };

/** The stall's own rows, read off the event loop from the ledger union (live file and rotations). */
async function claimStallRows(ctx: ClaimStallCtx, steps: readonly string[]): Promise<Array<Record<string, unknown>>> {
  return readLedgerUnionRecords(dirname(ctx.ledgerPath), { step: steps });
}

/**
 * W1-T13248: the page for a fleet whose free slots went only to runs refused before spend (2026-11-16: 14:42Z to
 * 20:30Z, nothing alerted). DEDUP IS ON THE NEWEST CLAIM-PASSING RUN, never `run.start`: a refused run writes a
 * fresh `run.start` every tick, so keying on it re-armed the page each tick. If the newest
 * `dispatch.claim_stall.escalated` row postdates the newest `dispatch.claim` `created` row, the stall was already
 * reported. The marker is written whether or not delivery succeeded (`escalateStarvation`'s discipline).
 */
export async function escalateClaimStall(
  info: ClaimStallInfo,
  ctx: ClaimStallCtx,
): Promise<void> {
  const lines = await claimStallRows(ctx, [CLAIM_STALL_ESCALATED_STEP, "dispatch.claim"]);
  let lastEscalatedIdx = -1;
  let lastPassedIdx = -1;
  lines.forEach((l, i) => {
    if (l.step === CLAIM_STALL_ESCALATED_STEP) lastEscalatedIdx = i;
    if (l.step === "dispatch.claim" && l.outcome === "created") lastPassedIdx = i;
  });
  if (lastEscalatedIdx !== -1 && lastEscalatedIdx > lastPassedIdx) return;

  const minutes = (ms: number): string => `${Math.round(ms / 60_000)} min`;
  const bound = info.boundSource === "claim-silence-window"
    ? `the fleet's claim-silence window (p90 of ${info.samples} measured claim-to-verdict builds, floored at two renewal intervals)`
    : `the p90 of ${info.samples} gaps between runs that passed their claim (no claim-to-verdict sample yet)`;
  const release = `rmd claim ${info.taskId} --drop`;
  const where = info.holderHost !== undefined ? ` on ${info.holderHost}` : " on the holder's host";
  const issueUrl = tryEscalate(
    {
      class: "BLOCKED",
      taskId: info.taskId,
      runId: ctx.runId,
      summary: `fleet is starting no work — ${info.taskId}'s dispatch claim (held by ${info.holder}) refuses every run`,
      detail:
        `W1-T13248: for ${info.refusedTicks} consecutive ticks every admitted run was refused before spend and none passed ` +
        `its dispatch claim, so the free slots are going to refused runs and no work is starting. ${info.taskId}'s claim ` +
        `${info.ref} is held by ${info.holder}; its newest sign of life is ${minutes(info.claimAgeMs)} old` +
        `${info.lastSignOfLife !== undefined ? ` (${info.lastSignOfLife})` : ""}, past ${minutes(info.boundMs)} — ` +
        `bound: ${bound}. The daemon is live; it will close this issue when a run next passes its claim.`,
      options: [
        {
          label: "release the claim",
          detail: `If the holder is gone, drop the claim from its host: \`${release}\`${where}.`,
        },
        {
          label: "acknowledge and wait",
          detail: "If the holder is working, no action is needed — the issue closes itself when a run next passes its claim.",
        },
      ],
      recommendation: "release the claim",
    },
    {
      issues: ctx.issues ?? ghIssueGateway(ctx.owner, ctx.repo),
      ledgerPath: ctx.ledgerPath,
      runId: ctx.runId,
    },
  );
  appendLedger(ctx.ledgerPath, {
    run_id: ctx.runId,
    task_id: info.taskId,
    step: CLAIM_STALL_ESCALATED_STEP,
    ref: info.ref,
    holder: info.holder,
    claim_age_ms: info.claimAgeMs,
    bound_ms: info.boundMs,
    bound_source: info.boundSource,
    samples: info.samples,
    refused_ticks: info.refusedTicks,
    release_command: release,
    issue_url: issueUrl,
    delivered: issueUrl !== null,
  });
}

/** W1-T14600: the ledger marker of the page for a managed-target job the core daemon deferred past its bound. */
export const TARGET_JOB_STALL_ESCALATED_STEP = "target_job.stall_escalated";

/**
 * W1-T14600: the page for a managed-target job the core daemon kept deferring for capacity (2026-11-23: WRECK-T1 waited
 * past three hours, and nothing alerted). DEDUP IS PER ORIGIN, on the job's own progress: if the newest
 * `target_job.stall_escalated` row for this origin postdates its newest `console.kick_dispatched` or `target_job.ended`
 * row, the stall was already reported, by this process or an earlier one. The marker is written whether or not delivery
 * succeeded (`escalateStarvation`'s discipline). The issue is closed by hand once the job ran.
 */
export async function escalateTargetJobStalled(
  info: TargetJobStallInfo,
  ctx: ClaimStallCtx,
): Promise<void> {
  const rows = await readLedgerUnionRecords(dirname(ctx.ledgerPath),
    { step: [TARGET_JOB_STALL_ESCALATED_STEP, "console.kick_dispatched", "target_job.ended"] });
  let lastEscalatedIdx = -1;
  let lastProgressIdx = -1;
  rows.forEach((row, i) => {
    if (row.origin !== info.origin) return;
    if (row.step === TARGET_JOB_STALL_ESCALATED_STEP) lastEscalatedIdx = i;
    else lastProgressIdx = i;
  });
  if (lastEscalatedIdx !== -1 && lastEscalatedIdx > lastProgressIdx) return;

  const waited = `${Math.round(info.deferredForMs / 60_000)} min`;
  const numbers = `${info.inFlight} core run(s) in flight, lane target ${info.laneTarget ?? "unbounded"}, WIP budget ${info.wipBudget}`;
  const options = [
    {
      label: "acknowledge and wait",
      detail: "The core daemon holds the next free lane for this job and runs it when one frees. Close this issue by hand once it ran.",
    },
    ...(info.reason === "wip budget" ? [{
      label: "free WIP room",
      detail: "The shared WIP budget is full: merging or closing an open pull request gives the job room to start.",
    }] : []),
  ];
  const issueUrl = tryEscalate(
    {
      class: "BLOCKED",
      taskId: info.taskId,
      runId: ctx.runId,
      summary: `${info.taskId} for ${info.repo} has waited ${waited} for a core daemon lane`,
      detail:
        `W1-T14600: the core daemon has deferred the managed-target job ${info.taskId} (repository ${info.repo}, request ` +
        `${info.origin}) for capacity for ${waited}. Reason: ${info.reason}; ${numbers}. A job waiting for a free lane has ` +
        "one reserved for it; one held by the lane target or the WIP budget waits until that reading has room.",
      options,
      recommendation: info.reason === "wip budget" ? "free WIP room" : "acknowledge and wait",
    },
    {
      issues: ctx.issues ?? ghIssueGateway(ctx.owner, ctx.repo),
      ledgerPath: ctx.ledgerPath,
      runId: ctx.runId,
    },
  );
  appendLedger(ctx.ledgerPath, {
    run_id: ctx.runId,
    task_id: info.taskId,
    step: TARGET_JOB_STALL_ESCALATED_STEP,
    origin: info.origin,
    repo: info.repo,
    deferred_for_ms: info.deferredForMs,
    reason: info.reason,
    issue_url: issueUrl,
    delivered: issueUrl !== null,
  });
}

/**
 * W1-T13248: the cleared half — closes the issue the newest `dispatch.claim_stall.escalated` row named, unless a later
 * cleared row already did. The referent is the ledger, never a lookup; absent means a silent no-op. CANNOT-OBSERVE
 * MEANS WAIT (W1-T130): a gateway that cannot close, or whose close throws, leaves the issue open and costs one
 * `delivered: false` row.
 */
export async function escalateClaimStallCleared(
  info: ClaimStallClearedInfo,
  ctx: ClaimStallCtx,
): Promise<void> {
  let issueUrl: string | null = null;
  for (const l of await claimStallRows(ctx, [CLAIM_STALL_ESCALATED_STEP, CLAIM_STALL_CLEARED_STEP])) {
    if (l.step === CLAIM_STALL_ESCALATED_STEP) issueUrl = typeof l.issue_url === "string" ? l.issue_url : null;
    else if (l.step === CLAIM_STALL_CLEARED_STEP) issueUrl = null;
  }
  if (!issueUrl) return;
  const comment =
    `W1-T13248: a run${info.runId !== undefined ? ` (${info.runId})` : ""} passed its dispatch claim` +
    `${info.taskId !== undefined ? ` for ${info.taskId}` : ""}, so the fleet is starting work again. Closing automatically; ` +
    `a fresh stall opens its own issue.`;
  const issues = ctx.issues ?? ghIssueGateway(ctx.owner, ctx.repo);
  let delivered = false;
  let failure: string | undefined;
  if (!issues.closeWithComment) {
    failure = "issue gateway cannot close issues";
  } else {
    try {
      issues.closeWithComment(issueUrl, comment);
      delivered = true;
    } catch (e) {
      // CANNOT-OBSERVE MEANS WAIT (W1-T130): never rethrown into the daemon loop; the row below carries it as `failure`.
      failure = String((e as Error)?.message ?? e);
    }
  }
  appendLedger(ctx.ledgerPath, {
    run_id: ctx.runId,
    task_id: info.taskId ?? "daemon",
    step: CLAIM_STALL_CLEARED_STEP,
    issue_url: issueUrl,
    delivered,
    ...(failure ? { failure } : {}),
  });
}

/** W1-T14608: the ledger markers of the no-start page — one per open, one per clear. */
const NO_START_ESCALATED_STEP = "dispatch.no_start.escalated";
const NO_START_CLEARED_STEP = "dispatch.no_start.cleared";

/**
 * W1-T14608: the page for a fleet that started no task past its measured pick gap while a lane was free and a task was
 * dispatchable. DEDUP IS ON THE NEWEST STARTED RUN (W1-T13249's rule), never on the `run.start` of a refused run: if the
 * newest escalated row postdates it, the episode was already reported. The marker is written whether or not delivery
 * succeeded.
 */
export async function escalateNoTaskStarted(info: NoTaskStartedInfo, ctx: ClaimStallCtx): Promise<void> {
  const rows = await claimStallRows(ctx, [NO_START_ESCALATED_STEP, "run.start", "dispatch.claim"]);
  const starts = new Set(queueDispatchRunStarts(rows));
  let lastEscalatedIdx = -1;
  let lastStartIdx = -1;
  rows.forEach((row, i) => {
    if (row.step === NO_START_ESCALATED_STEP) lastEscalatedIdx = i;
    else if (starts.has(row)) lastStartIdx = i;
  });
  if (lastEscalatedIdx !== -1 && lastEscalatedIdx > lastStartIdx) return;

  const minutes = (ms: number): string => `${Math.round(ms / 60_000)} min`;
  const bound = info.source === "pick-gap-p90"
    ? `the p90 of the fleet's newest ${info.samples} gaps between started tasks`
    : `the fleet's claim-silence window (${info.samples} measured claim-to-verdict builds; fewer than 8 gaps between started tasks)`;
  const ended = info.endStep ?? "no recorded step";
  const issueUrl = tryEscalate(
    {
      class: "BLOCKED",
      taskId: "daemon",
      runId: ctx.runId,
      summary: `fleet has started no task for ${minutes(info.sinceLastStartMs)} with ${info.freeLanes} free lane(s) and ` +
        `${info.dispatchable} dispatchable task(s); the newest tick ended on ${ended}`,
      detail:
        `W1-T14608: the newest task started at ${info.lastStartAt}, ${minutes(info.sinceLastStartMs)} ago, past the bound of ` +
        `${minutes(info.boundMs)} (${info.source}: ${bound}). For ${info.ticksWithoutStart} ticks in a row past that bound, ` +
        `${info.freeLanes} lane(s) were free and ${info.dispatchable} task(s) were dispatchable, and no task started. The newest ` +
        `tick ended on \`${ended}\`. The daemon is live; it closes this issue when a task next starts.`,
      options: [
        {
          label: "inspect the stalled path",
          detail: `Read the core daemon's rows for \`${ended}\` and the branch that writes them: each tick ended there before a task started.`,
        },
        {
          label: "acknowledge and wait",
          detail: "If the stall is expected, no action is needed: the issue closes itself when a task next starts.",
        },
      ],
      recommendation: "inspect the stalled path",
    },
    {
      issues: ctx.issues ?? ghIssueGateway(ctx.owner, ctx.repo),
      ledgerPath: ctx.ledgerPath,
      runId: ctx.runId,
    },
  );
  appendLedger(ctx.ledgerPath, {
    run_id: ctx.runId,
    task_id: "daemon",
    step: NO_START_ESCALATED_STEP,
    ticks_without_start: info.ticksWithoutStart,
    since_last_start_ms: info.sinceLastStartMs,
    last_start_at: info.lastStartAt,
    bound_ms: info.boundMs,
    bound_source: info.source,
    samples: info.samples,
    free_lanes: info.freeLanes,
    dispatchable: info.dispatchable,
    end_step: info.endStep,
    issue_url: issueUrl,
    delivered: issueUrl !== null,
  });
}

/**
 * W1-T14608: the cleared half. It closes the issue the newest `dispatch.no_start.escalated` row named, unless a later
 * cleared row already did; with none open it does nothing. A close that fails leaves the issue open and costs one
 * `delivered: false` row.
 */
export async function escalateNoTaskStartedCleared(info: NoTaskStartedClearedInfo, ctx: ClaimStallCtx): Promise<void> {
  let issueUrl: string | null = null;
  for (const l of await claimStallRows(ctx, [NO_START_ESCALATED_STEP, NO_START_CLEARED_STEP])) {
    if (l.step === NO_START_ESCALATED_STEP) issueUrl = typeof l.issue_url === "string" ? l.issue_url : null;
    else if (l.step === NO_START_CLEARED_STEP) issueUrl = null;
  }
  if (!issueUrl) return;
  const comment = `W1-T14608: ${info.taskId} started, so the fleet is starting tasks again. Closing automatically; ` +
    "a fresh stall opens its own issue.";
  const issues = ctx.issues ?? ghIssueGateway(ctx.owner, ctx.repo);
  let delivered = false;
  let failure: string | undefined;
  if (!issues.closeWithComment) {
    failure = "issue gateway cannot close issues";
  } else {
    try {
      issues.closeWithComment(issueUrl, comment);
      delivered = true;
    } catch (e) {
      // Never rethrown into the daemon loop; the row below carries it as `failure`.
      failure = String((e as Error)?.message ?? e);
    }
  }
  appendLedger(ctx.ledgerPath, {
    run_id: ctx.runId,
    task_id: info.taskId,
    step: NO_START_CLEARED_STEP,
    since_last_start_ms: info.sinceLastStartMs,
    issue_url: issueUrl,
    delivered,
    ...(failure ? { failure } : {}),
  });
}

/**
 * W1-T13255's rows, each carrying its `stage`. `failed` is one failing pass. `recovered` ends a streak that has no
 * issue to close, and its `passes` is a sample for the bound. `escalated` and `cleared` are the issue's open and close.
 */
export const SWEEP_STAGE_FAILED_STEP = "sweep.stage.failed";
export const SWEEP_STAGE_RECOVERED_STEP = "sweep.stage.recovered";
export const SWEEP_STAGE_ESCALATED_STEP = "sweep.stage_failing.escalated";
export const SWEEP_STAGE_CLEARED_STEP = "sweep.stage_failing.cleared";
/** Those four steps as one ledger slice: every rotation and the live file, so a streak outlives a restart. */
export const SWEEP_STAGE_STREAK_SLICE: EscalationTriageSlice = {
  holder: "sweep.stage-failure-streaks",
  steps: [SWEEP_STAGE_FAILED_STEP, SWEEP_STAGE_RECOVERED_STEP, SWEEP_STAGE_ESCALATED_STEP, SWEEP_STAGE_CLEARED_STEP],
};
/** How long a recovered streak goes on teaching the bound. */
export const SWEEP_STAGE_STREAK_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
/** With fewer recovered streaks than this inside the window, the fallback is the bound. */
export const SWEEP_STAGE_STREAK_MIN_SAMPLES = 5;
/** The bound before a stage has taught one, in consecutive failing passes. A full pass starts about every quarter
 *  of an hour, so the fifth failure in a row comes about an hour after the first. */
export const SWEEP_STAGE_STREAK_FALLBACK_PASSES = 4;

/** One stage's failure streak, as its own rows tell it. */
export interface SweepStageStreakState {
  /** Failing passes since the stage last recovered; 0 when it is not failing. */
  passes: number;
  firstFailureTs?: string;
  lastError?: string;
  /** The issue an `escalated` row opened and no `cleared` row has closed. */
  issueUrl?: string;
  /** Lengths of the streaks that recovered inside the window without a page being tried. */
  recovered: number[];
}

/** Pure: fold one stage's rows, oldest first (the order the ledger union returns them in). */
export function sweepStageStreakState(rows: ReadonlyArray<Record<string, unknown>>, stage: string, nowMs: number): SweepStageStreakState {
  let state: SweepStageStreakState = { passes: 0, recovered: [] };
  let pageTried = false;
  const endStreak = (issueUrl: string | undefined): void => {
    state = { passes: 0, recovered: state.recovered, ...(issueUrl === undefined ? {} : { issueUrl }) };
    pageTried = false;
  };
  for (const row of rows) {
    if (row.stage !== stage) continue;
    if (row.step === SWEEP_STAGE_FAILED_STEP) {
      if (state.passes === 0) state.firstFailureTs = String(row.ts);
      state.passes++;
      state.lastError = String(row.error);
    } else if (row.step === SWEEP_STAGE_ESCALATED_STEP) {
      pageTried = true;
      if (typeof row.issue_url === "string") state.issueUrl = row.issue_url;
    } else if (row.step === SWEEP_STAGE_RECOVERED_STEP) {
      const inWindow = nowMs - Date.parse(String(row.ts)) <= SWEEP_STAGE_STREAK_WINDOW_MS;
      if (!pageTried && inWindow && typeof row.passes === "number") state.recovered.push(row.passes);
      endStreak(state.issueUrl);
    } else if (row.step === SWEEP_STAGE_CLEARED_STEP) {
      endStreak(undefined);
    }
  }
  return state;
}

/** Pure: the streak length a stage must outlast before it pages, and where that length came from. */
export function sweepStageStreakBound(recovered: readonly number[]): { passes: number; basis: "p90" | "fallback"; samples: number } {
  if (recovered.length < SWEEP_STAGE_STREAK_MIN_SAMPLES) {
    return { passes: SWEEP_STAGE_STREAK_FALLBACK_PASSES, basis: "fallback", samples: recovered.length };
  }
  return { passes: quantileOf(recovered, 0.9) as number, basis: "p90", samples: recovered.length };
}

function sweepStageEscalation(
  stage: string, state: SweepStageStreakState, bound: ReturnType<typeof sweepStageStreakBound>, historyRead: boolean, runId: string,
): Escalation {
  const days = SWEEP_STAGE_STREAK_WINDOW_MS / (24 * 60 * 60 * 1000);
  const fallbackWhy = historyRead
    ? `this stage recovered on its own from ${bound.samples} failure streak(s) in the last ${days} days and a learned bound needs ${SWEEP_STAGE_STREAK_MIN_SAMPLES}`
    : "the stage's streak history could not be read, so the count is only the passes this daemon process saw";
  const boundText = bound.basis === "p90"
    ? `the p90 length (${bound.passes} passes) of the ${bound.samples} failure streaks this stage recovered from on its own in the last ${days} days`
    : `the fallback of ${bound.passes} passes (SWEEP_STAGE_STREAK_FALLBACK_PASSES), which applies because ${fallbackWhy}`;
  return {
    // HARD_STOP, not BLOCKED: the triage may move a BLOCKED issue to the fleet-notice digest or answer it by default.
    class: "HARD_STOP",
    taskId: "daemon",
    runId,
    // No count and no error in the title, so a later pass of the same streak never reads as a second incident.
    summary: `sweep stage ${stage} fails on every pass`,
    detail:
      `W1-T13255: the full sweep's ${stage} stage has failed on ${state.passes} passes since ${state.firstFailureTs}, and no ` +
      `pass in that time completed cleanly. Its last error: ${state.lastError}. That outlasts ` +
      `${boundText}. The sweep carries on past a failing stage, so until now the only sign was one ledger row per pass, ` +
      `and the stage's own work is not being done (for escalation_answers: no operator reply on an escalation is applied). ` +
      `This issue closes itself on the stage's next clean pass.`,
    options: [
      {
        label: "read the failures and fix the cause",
        detail:
          `Run \`rmd ledger-grep ${SWEEP_STAGE_FAILED_STEP}\` for the error on each pass, then build or file the fix. ` +
          `Nothing retries differently in the meantime: the stage runs again, and fails again, on every full pass.`,
      },
      {
        label: "acknowledge and wait",
        detail: "If the fix is already merging, no action is needed: the issue closes itself on the stage's next clean pass.",
      },
    ],
    recommendation: "read the failures and fix the cause",
    consequence: `The ${stage} stage keeps failing on every full sweep pass and its work stays undone.`,
  };
}

/** What one full pass saw of a stage: it threw, it completed (`clean`), or it did not run or could not read everything. */
export type SweepStageOutcome = { error: string } | { clean: boolean };

/**
 * W1-T13255 — a sweep stage that fails on every pass. 2026-11-10 to 11-16: the escalation-answers stage threw on every
 * full pass, no operator answer was applied for six days, and the sweep's `catch` wrote one row per pass that nobody
 * read. Built once per daemon start; called once per stage per full pass.
 *
 * THE STREAK IS ITS ROWS. A failing pass appends `failed`; the streak is the `failed` rows since the stage's last
 * `recovered` or `cleared` row, read back through the ledger slice, so a restart loses nothing. Once it is longer than
 * {@link sweepStageStreakBound} it opens ONE issue: a later failing pass finds the open issue on the ledger and stops.
 * An undelivered page writes its row and is tried again on the next failing pass, since a page that never arrives is
 * the defect this exists to end.
 *
 * ONLY A CLEAN PASS ENDS A STREAK. It closes the open issue (`cleared`), or records the streak's length as a sample
 * (`recovered`). A pass that returned without reading everything (`clean: false`) proves neither a failure nor a
 * recovery, and changes nothing. A clean pass after a settled one reads nothing at all.
 *
 * AN UNREADABLE HISTORY NEVER SILENCES IT. The rows this process wrote since the stage's streak last ended stand in
 * for a history that cannot be read, so a stage still pages once this process alone has seen it outlast the fallback,
 * and the issue this process opened is still closed. What an earlier process left waits for a clean pass that can
 * read it. A close that fails costs one `delivered: false` row and is not tried again (W1-T130).
 */
export function createSweepStageWatch(ctx: {
  owner: string;
  repo: string;
  ledgerPath: string;
  runId: string;
  history: (stateDir: string) => Promise<{ ok: boolean; rows: ReadonlyArray<Record<string, unknown>> }>;
  issues?: AsyncIssueGateway;
  clock?: Clock;
}): (stage: string, outcome: SweepStageOutcome) => Promise<void> {
  const clock = ctx.clock ?? systemClock;
  const settled = new Set<string>();
  const ownRows = new Map<string, Array<Record<string, unknown>>>();
  return async (stage, outcome) => {
    const failed = "error" in outcome;
    const own = ownRows.get(stage) ?? [];
    ownRows.set(stage, own);
    // One id per pass: the ledger union drops a byte-identical row as a replay, and two passes can share a millisecond.
    const passId = randomUUID();
    const write = (step: string, extra: Record<string, unknown>): void => {
      const row = { ts: clock.iso(), run_id: ctx.runId, task_id: "daemon", step, stage, pass_id: passId, ...extra };
      appendLedger(ctx.ledgerPath, row);
      own.push(row);
    };
    if (failed) {
      settled.delete(stage);
      write(SWEEP_STAGE_FAILED_STEP, { error: outcome.error });
    } else if (!outcome.clean || settled.has(stage)) {
      return;
    }
    const read = await ctx.history(dirname(ctx.ledgerPath));
    const state = sweepStageStreakState(read.ok ? read.rows : own, stage, clock.now());
    const issues = ctx.issues ?? ghIssueGatewayAsync(ctx.owner, ctx.repo);
    const streak = { first_failure_ts: state.firstFailureTs, passes: state.passes };
    if (failed) {
      const bound = sweepStageStreakBound(state.recovered);
      if (state.issueUrl !== undefined || state.passes <= bound.passes) return;
      const issueUrl = await tryEscalateAsync(sweepStageEscalation(stage, state, bound, read.ok, ctx.runId),
        { issues, ledgerPath: ctx.ledgerPath, runId: ctx.runId });
      write(SWEEP_STAGE_ESCALATED_STEP, {
        ...streak, error: state.lastError, bound_passes: bound.passes, bound_basis: bound.basis, bound_samples: bound.samples,
        history_read: read.ok, issue_url: issueUrl, delivered: issueUrl !== null,
      });
      return;
    }
    if (state.issueUrl !== undefined) {
      let failure: string | undefined;
      if (!issues.closeWithComment) {
        failure = "issue gateway cannot close issues";
      } else {
        try {
          await issues.closeWithComment(state.issueUrl,
            `W1-T13255: the ${stage} stage completed a clean pass, so its failure streak has ended. Closing automatically; ` +
            `a later streak that outlasts its bound opens its own issue.`);
        } catch (e) {
          // CANNOT-OBSERVE MEANS WAIT (W1-T130): never rethrown into the sweep; the row below carries the failure.
          failure = String((e as Error)?.message ?? e);
        }
      }
      write(SWEEP_STAGE_CLEARED_STEP, { ...streak, issue_url: state.issueUrl, delivered: failure === undefined, ...(failure ? { failure } : {}) });
    } else if (state.passes > 0) {
      write(SWEEP_STAGE_RECOVERED_STEP, streak);
    }
    own.length = 0;
    if (read.ok) settled.add(stage);
  };
}

/** The step `inbox-replay.ts` exports as `REPLAY_ESCALATED_STEP`, spelled here so this module does not load the inbox. */
const REPLAY_ESCALATED_STEP = "inbox.replay_escalated";

/**
 * W1-T9041 — a band-replay proposal no re-draft could clear. The replay (inbox-replay.ts) re-drafts a not-ready
 * proposal once per change in its lint or guidance; a re-draft under today's lint and guidance that still fails is
 * one nothing automatic will move, so it is named here with its violations grouped by check.
 *
 * DEDUP mirrors `escalateCircuitBreak`: this module's own `inbox.replay_escalated` row, keyed by proposal and
 * violation set, is written whether or not delivery succeeds, so a failing transport never re-delivers. The replay's
 * store records the set before calling, so a rotated-away row cannot re-arm it either.
 */
export function escalateReplayStranded(
  stranded: ReplayStranded,
  ctx: { owner: string; repo: string; ledgerPath: string; runId: string; issues?: IssueGateway },
): void {
  const already = readLedgerLines(ctx.ledgerPath).some(
    (l) => l.step === REPLAY_ESCALATED_STEP && l.proposal_id === stranded.proposalId && l.violation_key === stranded.violationKey,
  );
  if (already) return;
  const checks = Object.entries(stranded.violations).map(([check, messages]) => `[${check}] ${messages.join("; ")}`);
  const issueUrl = tryEscalate(
    {
      class: "BLOCKED",
      taskId: stranded.proposalId,
      runId: ctx.runId,
      summary: `${stranded.proposalId}: the band replay's re-draft still fails ${stranded.violationKey}`,
      detail:
        `W1-T9041: the W1-T8714 band replay re-drafted ${stranded.proposalId} (${stranded.family}) under today's draft ` +
        `lint and guidance, and the draft still fails ${stranded.sameAsOffered ? "the same checks it was re-offered on" : "the lint"}. ` +
        `The replay re-drafts again only when the lint or its guidance changes, so until then this proposal ` +
        `stays unfiled. Unresolved, by check: ${checks.join(" | ")}`,
      options: [
        {
          label: "reframe it",
          detail: `Give the drafter what it is missing with \`rmd reframe ${stranded.proposalId} --feedback "<text>"\`, which re-drafts it with your feedback.`,
        },
        {
          label: "decline it",
          detail: `If the finding is not worth a task, \`rmd decline ${stranded.proposalId} --reason "<text>"\` closes it and the replay records it superseded.`,
        },
      ],
      recommendation: "reframe it",
    },
    {
      issues: ctx.issues ?? ghIssueGateway(ctx.owner, ctx.repo),
      ledgerPath: ctx.ledgerPath,
      runId: ctx.runId,
    },
  );
  appendLedger(ctx.ledgerPath, {
    run_id: ctx.runId,
    task_id: stranded.proposalId,
    step: REPLAY_ESCALATED_STEP,
    proposal_id: stranded.proposalId,
    family: stranded.family,
    violations: stranded.violations,
    violation_key: stranded.violationKey,
    same_as_offered: stranded.sameAsOffered,
    issue_url: issueUrl,
    delivered: issueUrl !== null,
  });
}

/** W1-T14611: the ledger markers of the unresolved-instance SRE lane page — one per open, one per clear. */
export const SRE_LANE_UNRESOLVED_ESCALATED_STEP = "sre_lane.unresolved_escalated";
export const SRE_LANE_UNRESOLVED_CLEARED_STEP = "sre_lane.unresolved_cleared";

export interface SreLaneUnresolvedInfo {
  primary: string;
  stateRoot: string;
  registry: string;
  reason: string;
}

/** The issue URL a delivered page for this state root (and primary, when given) left open, or null. */
async function openSreLaneUnresolvedIssue(ctx: ClaimStallCtx, stateRoot: string, primary?: string): Promise<string | null> {
  let issueUrl: string | null = null;
  for (const l of await claimStallRows(ctx, [SRE_LANE_UNRESOLVED_ESCALATED_STEP, SRE_LANE_UNRESOLVED_CLEARED_STEP])) {
    if (l.state_root !== stateRoot) continue;
    if (l.step === SRE_LANE_UNRESOLVED_CLEARED_STEP) issueUrl = null;
    else if (primary === undefined || l.primary === primary) issueUrl = typeof l.issue_url === "string" ? l.issue_url : null;
  }
  return issueUrl;
}

/**
 * W1-T14611: the page for a primary daemon whose SRE lane is off because it could not find its instance. Dedup is on
 * the primary instance name and the state root: a delivered page that no later clear closed is not opened again.
 * The marker is written whether or not delivery succeeded (`escalateStarvation`'s discipline).
 */
export async function escalateSreLaneUnresolved(info: SreLaneUnresolvedInfo, ctx: ClaimStallCtx): Promise<void> {
  if (await openSreLaneUnresolvedIssue(ctx, info.stateRoot, info.primary) !== null) return;
  const issueUrl = tryEscalate(
    {
      class: "BLOCKED",
      taskId: "daemon",
      runId: ctx.runId,
      summary: `The SRE lane is off on the primary daemon: it could not find its instance (${info.reason}). ` +
        `Recycle it with --instance ${info.primary} or set RMD_INSTANCE_NAME.`,
      detail:
        `W1-T14611: the daemon on state root ${info.stateRoot} started with its SRE lane off. It read the registry ` +
        `${info.registry}, whose live primary instance is '${info.primary}', but could not find its own instance: ` +
        `${info.reason}. The daemon is live; it will close this issue when the SRE lane next starts on this state root.`,
      options: [
        {
          label: "name the instance",
          detail: `Recycle the daemon with \`deploy/recycle-container.sh --instance ${info.primary}\`, or launch it with RMD_INSTANCE_NAME=${info.primary}.`,
        },
        {
          label: "acknowledge and wait",
          detail: "If this daemon is not the primary instance, no action is needed; the issue closes when the lane next starts here.",
        },
      ],
      recommendation: "name the instance",
      consequence: "While the lane is off, the SRE governor cannot page a fleet stall.",
    },
    {
      issues: ctx.issues ?? ghIssueGateway(ctx.owner, ctx.repo),
      ledgerPath: ctx.ledgerPath,
      runId: ctx.runId,
    },
  );
  appendLedger(ctx.ledgerPath, {
    run_id: ctx.runId,
    task_id: "daemon",
    step: SRE_LANE_UNRESOLVED_ESCALATED_STEP,
    primary: info.primary,
    state_root: info.stateRoot,
    registry: info.registry,
    reason: info.reason,
    issue_url: issueUrl,
    delivered: issueUrl !== null,
  });
}

/**
 * W1-T14611: the cleared half — closes the issue the newest delivered page for this state root opened, unless a later
 * cleared row already did. Absent means a silent no-op. CANNOT-OBSERVE MEANS WAIT (W1-T130), as the other clears.
 */
export async function escalateSreLaneUnresolvedCleared(info: { stateRoot: string; instance: string | null }, ctx: ClaimStallCtx): Promise<void> {
  const issueUrl = await openSreLaneUnresolvedIssue(ctx, info.stateRoot);
  if (issueUrl === null) return;
  const comment = `W1-T14611: the SRE lane started on state root ${info.stateRoot}` +
    `${info.instance !== null ? ` as instance '${info.instance}'` : ""}. Closing automatically.`;
  const issues = ctx.issues ?? ghIssueGateway(ctx.owner, ctx.repo);
  let delivered = false;
  let failure: string | undefined;
  if (!issues.closeWithComment) {
    failure = "issue gateway cannot close issues";
  } else {
    try {
      issues.closeWithComment(issueUrl, comment);
      delivered = true;
    } catch (e) {
      // CANNOT-OBSERVE MEANS WAIT (W1-T130): never rethrown into the daemon loop; the row below carries it as `failure`.
      failure = String((e as Error)?.message ?? e);
    }
  }
  appendLedger(ctx.ledgerPath, {
    run_id: ctx.runId,
    task_id: "daemon",
    step: SRE_LANE_UNRESOLVED_CLEARED_STEP,
    state_root: info.stateRoot,
    instance: info.instance,
    issue_url: issueUrl,
    delivered,
    ...(failure ? { failure } : {}),
  });
}
