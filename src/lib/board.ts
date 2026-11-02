/**
 * Read-only board wiring: service routes, status projections and ledger tailing; no new
 * business logic (W3-T2, MASTER-PLAN §7 WS-5a). SSE polls every {@link DEFAULT_POLL_MS}, avoiding
 * nonportable `fs.watch`, and emits only changed projections, never mere touches.
 * Falsifiers: test/board.test.ts and test/service.test.ts use real HTTP servers.
 */
// Why: the "Option A" narrow-scope decision — docs/forensics/board.md#file-header

import { recentEntryFromLine, recentRunId, RECENT_ACTIVITY_HISTORY_CAP, RECENT_ACTIVITY_VERBS, type RecentActivityEntry } from "./recent-projection.js";
export { RECENT_ACTIVITY_VERBS } from "./recent-projection.js";
export type { RecentActivityEntry, RecentActivityVerb } from "./recent-projection.js";
import type { ServerResponse } from "node:http";
import type { Plan, Task, TaskRisk } from "./plan.js";
import { DEFAULT_RISK, TASK_STATUSES } from "./plan.js";
import {
  createLedgerTailCache,
  projectPlan,
  readLedgerLines,
  readLedgerTail,
  SERVE_KEEPS_CREDITS_IN_MEMORY,
  type BoardDeps,
  type DeriveDeps,
  type LedgerTailCache,
  type StatusProjection,
  type PrRef,
  taskIdFromRunBranch,
} from "./status.js";
// W1-T2895: keep board.js's public BoardDeps export after moving its definition to status.ts.
export type { BoardDeps };
import type { Route, SseRoute, SseSend } from "./service.js";
import { bearerTokenId } from "./panel-actions.js";
import type { LastSeenStore } from "./last-seen.js";
import { buildRecapEvents, type RecapEvent } from "./recap.js";
import { computeGlanceSpend, type GlanceSpend } from "./glance.js";
import { deriveBlockedPrSections, type BlockedPrBlocker, type MergeHeldRow } from "./status-board.js";
import { liveRunSpendByTask, subscribeStatusStream } from "./status-stream-publisher.js";

// Keep the live consumer's boundary visible to the ledger render-retention census.
const OPERATOR_ACTION_STEPS = new Set(["console.kick_refused", "console.kick_dispatched"]);

/** Ledger poll pace for the SSE stream — comfortably under the 2s acceptance budget. */
export const DEFAULT_POLL_MS = 250;

/**
 * FIND row (W1-T157): projection plus plan title/risk and last ledger activity time.
 * Keep enrichment here: StatusProjection mirrors openapi/daemon.yaml and SSE emits it bare.
 * The shell backfills enrichment across deltas (src/lib/serve.ts).
 */
export interface BoardRow extends StatusProjection {
  title: string;
  risk: TaskRisk;
  /** ISO-8601 `ts` of the last ledger line naming this task; absent when the task has no ledger line at all. */
  lastActivityAt?: string;
  /** Live accumulated spend (W1-T184): `cost_usd` summed over `implement.done`/`fix.done` lines
   *  for this task's current run. Present only alongside `phase`; volatile like `elapsedMs`. */
  liveSpendUsd?: number;
  /** Live accumulated turn count (W1-T184) — the `num_turns` counterpart to {@link liveSpendUsd}. */
  liveTurns?: number;
  /** True when a run is in flight but has logged no spend/turns yet — unknown, not zero. Mutually
   *  exclusive with {@link liveSpendUsd}/{@link liveTurns} (fb-1784902052582-c124f9). */
  liveSpendPending?: boolean;
  /** Worker liveness from StatusProjection (W1-T944), only alongside `phase`.
   *  Absent means no worker.state row yet; render "state unknown". */
  workerState?: StatusProjection["workerState"];
  /** ISO-8601 entry time from StatusProjection.workerStateSince, only while quiet.
   *  The console ages "quiet Nm" on elapsedMs's 1s tick. */
  workerStateSince?: string;
  /** Process-unevidenced from StatusProjection (W1-T1240), only alongside `phase`. */
  processUnevidenced?: StatusProjection["processUnevidenced"];
  /** GitHub.reviewState alongside prUrl (W1-T914): success/failure are posted verdicts;
   *  pending, none (never posted; worst per W1-T225), unreadable (read failed), and
   *  not-applicable (merged/closed, W1-T2235) remain distinct. */
  // Why: the W1-T225 absent-is-worst ruling — docs/forensics/board.md#boardrow-reviewstate
  reviewState?: "success" | "failure" | "pending" | "none" | "unreadable" | "not-applicable";
}

/** GET /v1/status's body — one {@link BoardRow} per plan task, as of `generated_at`. */
export interface CountSummary {
  total: number;
  running: number;
  merged: number;
  queued: number;
  /** Tasks that are stopped (W1-T159): `status === "blocked"` or an open escalation. See {@link isBlockedRow}. */
  blocked: number;
  /** False when merge-state's GitHub read was unreachable — the console renders "unknown", not "0 merged". */
  merged_known: boolean;
}

export interface BoardSnapshot {
  /** The one server clock this snapshot is "as of" — every header freshness chip keys on this. */
  generated_at: string;
  /** True iff the GitHub read backing merge-state was unreachable this snapshot (fb-…c124f9). */
  github_unreachable: boolean;
  /** How old the GitHub facts behind this snapshot were at `generated_at`, in ms (W1-T4771). Serve never fetches
   *  inline, so a fact past its TTL is served stale and this says by how much. Absent when none is held yet. */
  github_facts_age_ms?: number;
  /** W1-T4771: `stale` once a held GitHub fact is past its TTL, whatever this snapshot's own age. Absent with the age. */
  github_facts_status?: "fresh" | "stale";
  /** Header counts, derived from the same `tasks` below — tally and rows can never disagree. */
  counts: CountSummary;
  /** GLANCE strip totals (W1-T159), from the same ledger lines this snapshot already read. */
  spend: GlanceSpend;
  tasks: BoardRow[];
  /** Non-progressing PRs from deriveBlockedPrSections (W1-T1006's sixth NEEDS-ME source).
   *  See {@link deriveBoardStatusSections}; always an array. */
  blockedPrs: BlockedPrBlocker[];
  /** The currently-standing operator merge holds (W1-T2719), from status-board.ts's reader. */
  mergeHeld: MergeHeldRow[];
  /** Every current open PR, projected from the batched gateway's open half. An unreadable/partial
   *  index is an incomplete, empty queue rather than stale rows wearing a current timestamp. */
  prQueue: PrQueueSnapshot;
  /** Set only when live GitHub state could not be checked this render (W1-T1006). When set,
   *  {@link blockedPrs} is empty — withheld, never replayed as current and read as "nothing blocked". */
  blockedPrsUnverifiedReason?: string;
}

export type PrQueueClass = "actionable" | "active" | "ready-held" | "waiting" | "unknown";

export interface PrQueueRow {
  prNumber: number;
  prUrl: string;
  title: string;
  headRefName?: string;
  headSha?: string;
  taskId?: string;
  disposition: string;
  reason: string;
  reviewState: NonNullable<BoardRow["reviewState"]>;
  queueClass: PrQueueClass;
  held: boolean;
  snapshotAt: string;
  observedAt?: string;
}

export interface PrQueueSnapshot {
  complete: boolean;
  rows: PrQueueRow[];
  unavailableReason?: string;
  /** Timestamp of the newest prior complete queue held by this route cache; absent until observed. */
  lastGoodAt?: string;
}

interface BoardComputeOptions {
  lastGoodPrQueueAt?: string;
  /** A cache-key read handed into the projection so one snapshot uses one immutable open index. */
  prQueueIndex?: PrQueueIndexRead;
  /** {@link DeriveDeps.reuseProjection}, threaded through to `projectPlan`. Absent by default. */
  reuseProjection?: DeriveDeps["reuseProjection"];
  /** Capture clean projections for memoization; BoardRow joins (lastActivityAt, liveSpendUsd)
   *  must be re-derived each pass, never carried. */
  captureProjections?: (byId: ReadonlyMap<string, StatusProjection>) => void;
}

interface PrQueueIndexRead {
  open: PrRef[] | null | undefined;
  failed: boolean;
  truncated: boolean;
  failureReason: string;
}

/** Last ledger ts per task for computeBoardSnapshot (W1-T157).
 *  RECENT instead uses append order via RecentActivityState.scannedLines. */
interface LedgerActivity {
  ts?: string;
}
function lastActivityByTask(lines: Array<Record<string, unknown>>): Map<string, LedgerActivity> {
  const out = new Map<string, LedgerActivity>();
  lines.forEach((line) => {
    if (typeof line.task_id === "string") {
      out.set(line.task_id, { ts: typeof line.ts === "string" ? line.ts : undefined });
    }
  });
  return out;
}

/** W1-T6267: share only the blocked-PR and merge-hold readers with the status board. */
function deriveBoardStatusSections(
  deps: BoardDeps,
  lines: Array<Record<string, unknown>>,
): { blockedPrs: BlockedPrBlocker[]; blockedPrsUnverifiedReason?: string; mergeHeld: MergeHeldRow[] } {
  return deriveBlockedPrSections(lines, deps.github);
}

const QUEUE_CLASS_ORDER: Record<PrQueueClass, number> = {
  actionable: 0,
  active: 1,
  "ready-held": 2,
  waiting: 3,
  unknown: 4,
};
const ACTIONABLE_DISPOSITIONS = new Set(["blocked-fixable", "blocked-ambiguous", "conflicted", "stale"]);
const ACTIVE_DISPOSITIONS = new Set(["post-review", "dep-review"]);

function queueClass(disposition: string, reviewState: PrQueueRow["reviewState"], held: boolean): PrQueueClass {
  if (ACTIONABLE_DISPOSITIONS.has(disposition) || reviewState === "failure") return "actionable";
  if (ACTIVE_DISPOSITIONS.has(disposition) || reviewState === "pending") return "active";
  if (held || disposition === "mergeable") return "ready-held";
  if (disposition === "wait") return "waiting";
  return "unknown";
}

function safeQueueFailureReason(github: BoardDeps["github"]): string {
  try {
    return github.readFailureReason?.() ?? "unknown";
  } catch (error) {
    // Preserve the thrown-vs-absent distinction in the returned operator-facing reason.
    return `failure-reason-read-threw: ${String((error as Error)?.message ?? error).slice(0, 240)}`;
  }
}

function safeQueueTruncated(github: BoardDeps["github"]): boolean {
  try {
    return github.readTruncated?.() ?? false;
  } catch (error) {
    void error; // the separate failure-reason read preserves its own classified cause
    return true;
  }
}

/** The gateway's oldest-held-fact age, guarded like {@link safeReadFailed}: an accessor that throws reads as unknown. */
function safeFactsAgeMs(github: BoardDeps["github"]): number | undefined {
  try {
    return github.factsAgeMs?.();
  } catch (error) {
    void error; // an unreadable age is reported as absent; it never fails the snapshot it decorates
    return undefined;
  }
}

function safeFactsStale(github: BoardDeps["github"]): boolean {
  try {
    return github.factsStale?.() ?? false;
  } catch (error) {
    void error; // an unreadable verdict is reported as stale, so an unknown age is never labelled fresh
    return true;
  }
}

/** A memo hit re-reads the facts' age: the snapshot's own copy was true only when it was computed. */
function withLiveGithubFacts(snapshot: BoardSnapshot, github: BoardDeps["github"]): BoardSnapshot {
  const ageMs = safeFactsAgeMs(github);
  return ageMs === undefined ? snapshot : { ...snapshot, github_facts_age_ms: ageMs, github_facts_status: safeFactsStale(github) ? "stale" : "fresh" };
}

/** The page is only as fresh as its stalest source; the console snapshot cache reads this header. */
function staleSourceHeaders(snapshot: BoardSnapshot): Record<string, string> {
  if (snapshot.github_facts_status !== "stale") return {};
  return { [STALE_SOURCE_HEADER]: `github facts ${Math.round((snapshot.github_facts_age_ms ?? 0) / 1000)} s old` };
}

/** Read the live open half once — both a board-cache input and the immutable list every open-PR consumer uses. */
function readPrQueueIndex(github: BoardDeps["github"]): PrQueueIndexRead {
  if (!github.listOpenHeadBranches) {
    return { open: undefined, failed: false, truncated: false, failureReason: "unavailable" };
  }
  let open: PrRef[] | null;
  let threw = false;
  let thrownReason: string | undefined;
  try {
    open = github.listOpenHeadBranches();
  } catch (error) {
    // Preserve this exact failure below; null alone would conflate it with an unavailable read.
    open = null;
    threw = true;
    thrownReason = `open-index-read-threw: ${String((error as Error)?.message ?? error).slice(0, 240)}`;
  }
  return {
    open,
    failed: threw || safeReadFailed(github) || open === null,
    truncated: safeQueueTruncated(github),
    failureReason: thrownReason ?? safeQueueFailureReason(github),
  };
}

/** Stable material fingerprint for GitHub-only queue changes; body is included because anchored task attribution is a queue field. */
function prQueueIndexFingerprint(index: PrQueueIndexRead): string {
  const rows = index.open === undefined
    ? "method-unavailable"
    : index.open === null
      ? "read-unavailable"
      : [...index.open]
          .map((pr) => [pr.number, pr.url, pr.state, pr.title ?? "", pr.headRefName ?? "", pr.headRefOid ?? "", pr.body ?? ""])
          .sort((a, b) => Number(a[0]) - Number(b[0]));
  return JSON.stringify([index.failed, index.truncated, index.failureReason, rows]);
}

function planTaskFromOpenPr(pr: PrRef, plan: Plan): string | undefined {
  const bodyMatch = /^Remudero-Task:\s*(\S+)\s*$/m.exec(pr.body ?? "");
  if (bodyMatch && plan.byId.has(bodyMatch[1])) return bodyMatch[1];
  const branchTask = taskIdFromRunBranch(pr.headRefName);
  return branchTask && plan.byId.has(branchTask) ? branchTask : undefined;
}

/** Project every current open head; the ledger join is exact-head only, so a push reverts a row
 *  to `not-yet-observed` until sweep writes a disposition for the new commit. */
function derivePrQueue(
  deps: BoardDeps,
  lines: Array<Record<string, unknown>>,
  tasks: BoardRow[],
  mergeHeld: MergeHeldRow[],
  snapshotAt: string,
  lastGoodAt?: string,
  index: PrQueueIndexRead = readPrQueueIndex(deps.github),
): PrQueueSnapshot {
  if (index.open === undefined) {
    return {
      complete: false,
      rows: [],
      unavailableReason: "GitHub open-PR index is unavailable on this gateway",
      ...(lastGoodAt ? { lastGoodAt } : {}),
    };
  }

  if (index.failed || index.truncated) {
    const unavailableReason = index.truncated
      ? "GitHub open-PR index was truncated at its configured page ceiling — the whole queue is withheld"
      : `GitHub open-PR index could not be read (${index.failureReason}) — the whole queue is withheld`;
    return {
      complete: false,
      rows: [],
      unavailableReason,
      ...(lastGoodAt ? { lastGoodAt } : {}),
    };
  }

  const taskByPr = new Map<number, BoardRow>();
  for (const task of tasks) if (task.prNumber !== undefined) taskByPr.set(task.prNumber, task);
  const fleetHeld = mergeHeld.some((hold) => hold.prNumber === undefined);
  const unique = new Map<number, PrRef>();
  for (const pr of index.open ?? []) if (pr.state.toUpperCase() === "OPEN" && !unique.has(pr.number)) unique.set(pr.number, pr);

  // Each open head's newest `sweep.disposed` row, from ONE pass: a scan per open PR was P x L on core's fact store.
  const disposedAt = new Map<string, Record<string, unknown>>();
  const wanted = new Set([...unique.values()].flatMap((pr) => (pr.headRefOid ? [`${pr.number}\u0000${pr.headRefOid}`] : [])));
  if (wanted.size > 0) {
    for (const line of lines) {
      if (line.step !== "sweep.disposed" || typeof line.pr_number !== "number" || typeof line.head_sha !== "string") continue;
      const id = `${line.pr_number}\u0000${line.head_sha}`;
      if (wanted.has(id)) disposedAt.set(id, line);
    }
  }

  const rows: PrQueueRow[] = [];
  for (const pr of unique.values()) {
    const transition = pr.headRefOid ? disposedAt.get(`${pr.number}\u0000${pr.headRefOid}`) : undefined;
    const taskRow = taskByPr.get(pr.number);
    const transitionTask = typeof transition?.task_id === "string" && deps.plan.byId.has(transition.task_id) ? transition.task_id : undefined;
    const taskId = taskRow?.taskId ?? planTaskFromOpenPr(pr, deps.plan) ?? transitionTask;
    const reviewState = taskRow?.reviewState ?? deriveReviewState(pr.url, deps.github) ?? "none";
    const disposition = typeof transition?.disposition === "string" ? transition.disposition : "not-yet-observed";
    const reason =
      typeof transition?.reason === "string" && transition.reason.trim().length > 0
        ? transition.reason
        : transition
          ? "reason not named"
          : "the sweep has not yet observed this current head";
    const held = fleetHeld || mergeHeld.some((hold) => hold.prNumber === pr.number);
    rows.push({
      prNumber: pr.number,
      prUrl: pr.url,
      title: pr.title ?? `PR #${pr.number}`,
      ...(pr.headRefName ? { headRefName: pr.headRefName } : {}),
      ...(pr.headRefOid ? { headSha: pr.headRefOid } : {}),
      ...(taskId ? { taskId } : {}),
      disposition,
      reason,
      reviewState,
      queueClass: queueClass(disposition, reviewState, held),
      held,
      snapshotAt,
      ...(typeof transition?.ts === "string" ? { observedAt: transition.ts } : {}),
    });
  }
  rows.sort((a, b) => QUEUE_CLASS_ORDER[a.queueClass] - QUEUE_CLASS_ORDER[b.queueClass] || a.prNumber - b.prNumber);
  return { complete: true, rows };
}

/** Join projectPlan's unchanged merge-state projections with plan title/risk and ledger
 *  lastActivityAt to produce BoardRows (W1-T157; see {@link BoardRow}). */
export function computeBoardSnapshot(deps: BoardDeps, options: BoardComputeOptions = {}): BoardSnapshot {
  // Read the ledger once (W1-T184) and hand projectPlan an overriding readLedger so its own
  // internal amortization, and liveRunSpend below, see this SAME already-parsed array rather
  // than each re-reading a file that cannot have changed mid-call.
  const readLedger = deps.readLedger ?? readLedgerLines;
  const lines = readLedger(deps.ledgerPath);
  const prQueueIndex = options.prQueueIndex ?? readPrQueueIndex(deps.github);
  // Override only listOpenHeadBranches with this snapshot's captured answer, so task rows and
  // queue rows can't observe two different GitHub moments in one response — no second walk.
  const snapshotGithub: BoardDeps["github"] =
    prQueueIndex.open === undefined
      ? deps.github
      : { ...deps.github, listOpenHeadBranches: () => prQueueIndex.open ?? null };
  const effectiveDeps: BoardDeps = {
    ...deps,
    github: snapshotGithub,
    readLedger: () => lines,
    writeCreditStore: SERVE_KEEPS_CREDITS_IN_MEMORY,
    ...(options.reuseProjection ? { reuseProjection: options.reuseProjection } : {}),
  };
  const byId = projectPlan(deps.plan, effectiveDeps);
  options.captureProjections?.(byId);
  const lastActivity = lastActivityByTask(lines);
  const liveSpend = liveRunSpendByTask(lines, [...byId.values()].filter((p) => p.phase).map((p) => p.taskId));
  const tasks: BoardRow[] = [...byId.values()].map((p) => {
    // Task-less escalations have no plan Task: fall back to their title/id and default risk
    // rather than crashing the snapshot with a non-null assertion (W1-T283).
    const task = deps.plan.byId.get(p.taskId);
    const row: BoardRow = {
      ...p,
      title: task ? task.title : (p.escalationTitle ?? p.taskId),
      risk: task ? task.risk : DEFAULT_RISK,
    };
    const ts = lastActivity.get(p.taskId)?.ts;
    if (ts) row.lastActivityAt = ts;
    if (p.phase) {
      const spend = liveSpend.get(p.taskId);
      if (spend?.hasData) {
        row.liveSpendUsd = spend.spendUsd;
        row.liveTurns = spend.turns;
      } else if (spend) {
        // In flight but nothing logged yet ⇒ "no data yet", NOT $0.000 / 0 turns.
        row.liveSpendPending = true;
      }
    }
    const reviewState = deriveReviewState(p.prUrl, effectiveDeps.github);
    if (reviewState) row.reviewState = reviewState;
    return row;
  });
  // Count these same tasks; a GitHub outage means unknown, never "0 merged" (fb-1784902052582-c124f9).
  const github_unreachable = safeReadFailed(effectiveDeps.github);
  const now = deps.now ?? Date.now;
  const generatedAt = new Date(now()).toISOString();
  const { blockedPrs, blockedPrsUnverifiedReason, mergeHeld } = deriveBoardStatusSections(effectiveDeps, lines);
  const prQueue = derivePrQueue(effectiveDeps, lines, tasks, mergeHeld, generatedAt, options.lastGoodPrQueueAt, prQueueIndex);
  const githubFactsAgeMs = safeFactsAgeMs(effectiveDeps.github);
  return {
    generated_at: generatedAt,
    github_unreachable,
    ...(githubFactsAgeMs !== undefined ? { github_facts_age_ms: githubFactsAgeMs, github_facts_status: safeFactsStale(effectiveDeps.github) ? "stale" : "fresh" } : {}),
    counts: summarizeCounts(tasks, github_unreachable),
    spend: computeGlanceSpend(lines, now()),
    tasks,
    blockedPrs,
    blockedPrsUnverifiedReason,
    mergeHeld,
    prQueue,
  };
}

/** One in-flight predicate, shared by the header tally and the NOW rows so they can never
 *  disagree: a task is "running" iff it carries a live run `phase` (fb-1784902052582-c124f9). */
export function isRunningRow(row: Pick<BoardRow, "phase">): boolean {
  return row.phase != null;
}

/**
 * Shared STOPPED predicate for header and GLANCE: blocked status or needsHuman.
 * deriveStatus sets needsHuman independently; queued/running tasks can still need a human.
 * Include plan-blocked tasks even without an issue to click.
 */
// Why: the 2026-08-03 zero-blocked-with-two-stopped incident — docs/forensics/board.md#isblockedrow
export function isBlockedRow(row: Pick<BoardRow, "status" | "needsHuman">): boolean {
  return row.status === "blocked" || row.needsHuman === true;
}

/** The header count summary, computed from the same task set the rows render; `merged_known` is
 *  false on a GitHub outage so the console renders "unknown", never `0` as fact. */
export function summarizeCounts(
  tasks: Array<Pick<BoardRow, "phase" | "status" | "needsHuman">>,
  githubUnreachable: boolean,
): CountSummary {
  return {
    total: tasks.length,
    running: tasks.filter(isRunningRow).length,
    merged: tasks.filter((t) => t.status === "merged" || t.status === "done").length,
    queued: tasks.filter((t) => t.status === "queued").length,
    blocked: tasks.filter(isBlockedRow).length,
    merged_known: !githubUnreachable,
  };
}

// liveRunSpend lives in status-stream-publisher.ts to keep imports acyclic (W1-T4455; see its docstring).

/**
 * Memoized computeBoardSnapshot (W1-T184); synchronous consumers cannot overlap recomputes.
 * Key on decision fingerprint, gateway health and material open-index fingerprint, not TTL.
 * Gateway recovery/failure or PR opens/closes can invalidate without a ledger append.
 */
// Why: the 2026-07-20 uncached GET /v1/status latency outage this memo fixes —
// docs/forensics/board.md#createboardsnapshotcache--boardsnapshotcache
export interface BoardSnapshotCache {
  get(deps: BoardDeps): BoardSnapshot;
}

/** A projection published by an off-thread producer. Absence has a dated reason, never counts. */
export type BoardSnapshotState =
  | { state: "ready"; snapshot: BoardSnapshot }
  | { state: "unavailable"; buildStartedAt: string; checkedAt: string; reason: string };

export interface BoardSnapshotSource {
  current(): BoardSnapshotState;
}

/** Treat a throwing readFailed accessor as an outage, avoiding a /v1/status 500
 *  or a false healthy signal (W1-T184). */
function safeReadFailed(github: BoardDeps["github"]): boolean {
  try {
    return github.readFailed?.() ?? false;
  } catch {
    return true;
  }
}

/**
 * GitHub.reviewState verbatim (W1-T914). No PR means undefined; no accessor means none.
 * Throws/undefined mean unreadable only when safeReadFailed confirms an outage; otherwise none.
 */
export function deriveReviewState(
  prUrl: string | undefined,
  github: BoardDeps["github"],
): BoardRow["reviewState"] {
  if (!prUrl) return undefined;
  if (!github.reviewState) return "none";
  try {
    const state = github.reviewState(prUrl);
    if (state !== undefined) return state;
    return safeReadFailed(github) ? "unreadable" : "none";
  } catch {
    return safeReadFailed(github) ? "unreadable" : "none";
  }
}

/**
 * Ignore only steps measured unread throughout the projection path (W1-T2919).
 * Frequent daemon.alive/board_gateway.fetch_bytes rows once forced unchanged recomputes.
 * Exclude known noise rather than include known inputs: new steps must invalidate by default
 * so an optimization miss cannot silently serve stale projections.
 */
// Why: the once-a-minute cache-thrash incident this exclusion fixes —
// docs/forensics/board.md#board_irrelevant_steps
export const BOARD_IRRELEVANT_STEPS: ReadonlySet<string> = new Set(["daemon.alive", "daemon.pulse", "board_gateway.fetch_bytes", "board_gateway.fetch_ok", "board_snapshot.unchanged", "board_gateway.rollup"]);

/** A parsed row's step, or undefined on torn/unknown data, which stays decision-relevant. */
export function ledgerStepOf(row: Record<string, unknown>): string | undefined {
  return typeof row.step === "string" ? row.step : undefined;
}

/** Can this row change a board row? Everything except {@link BOARD_IRRELEVANT_STEPS}. */
export function isDecisionRelevantRow(row: Record<string, unknown>): boolean {
  const step = ledgerStepOf(row);
  return step === undefined || !BOARD_IRRELEVANT_STEPS.has(step);
}

/** The running fingerprint's state, folded incrementally so a cache hit never re-walks the ledger. */
export interface DecisionFingerprint {
  /** How many rows have been folded in — the read cursor, not the count below. */
  readonly foldedUpTo: number;
  /** First-row identity; shrinkage or a replaced head restarts the fold on rotation. */
  readonly head: string | undefined;
  readonly hash: number;
  /** Decision-relevant row count detects appends without the old raw line count's noise. */
  readonly count: number;
}

/**
 * Split the decision fold by task to avoid re-deriving the whole plan for one task's change.
 * Rows naming no task invalidate every task: globalHash belongs in every key because their
 * affected projections are unknown. Fall back to full recomputation rather than a stale answer.
 * Measurement: docs/forensics/board.md#the-board-re-derived-1792-tasks-to-reflect-a-change-in-one.
 */
export interface TaskFingerprints {
  /** Rows folded so far — the read cursor, same shape as {@link DecisionFingerprint}. */
  readonly foldedUpTo: number;
  /** The first row's identity, so a rotation restarts the fold rather than continuing it. */
  readonly head: string | undefined;
  /** taskId -> that task's own running hash. */
  readonly byTask: ReadonlyMap<string, number>;
  /** The fold of every row naming no task, and how many there were. */
  readonly globalHash: number;
  readonly globalCount: number;
}

export const EMPTY_TASK_FINGERPRINTS: TaskFingerprints = {
  foldedUpTo: 0,
  head: undefined,
  byTask: new Map(),
  globalHash: 0x811c9dc5,
  globalCount: 0,
};

/** The task a row is about, by the two field names the ledger actually uses. */
export function ledgerTaskOf(row: Record<string, unknown>): string | undefined {
  const id = row.task_id ?? row.task;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

/** FNV-1a, the same mixing {@link foldDecisionFingerprint} uses, over one row identity. */
function foldInto(hash: number, id: string): number {
  let h = hash;
  for (let c = 0; c < id.length; c += 1) {
    h ^= id.charCodeAt(c);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Fold `rows` into `prior`, walking only what is new — the same incremental contract, and the
 *  same rotation restart, as {@link foldDecisionFingerprint}. */
export function foldTaskFingerprints(
  rows: ReadonlyArray<Record<string, unknown>>,
  prior: TaskFingerprints,
): TaskFingerprints {
  const head = rows.length > 0 ? rowIdentity(rows[0]!) : undefined;
  const rotated = rows.length < prior.foldedUpTo || (prior.foldedUpTo > 0 && head !== prior.head);
  const from = rotated ? 0 : prior.foldedUpTo;
  const byTask = new Map<string, number>(rotated ? [] : prior.byTask);
  let globalHash = rotated ? EMPTY_TASK_FINGERPRINTS.globalHash : prior.globalHash;
  let globalCount = rotated ? 0 : prior.globalCount;
  for (let i = from; i < rows.length; i += 1) {
    const row = rows[i]!;
    if (!isDecisionRelevantRow(row)) continue;
    const id = rowIdentity(row);
    const taskId = ledgerTaskOf(row);
    if (taskId === undefined) {
      globalHash = foldInto(globalHash, id);
      globalCount += 1;
      continue;
    }
    byTask.set(taskId, foldInto(byTask.get(taskId) ?? EMPTY_TASK_FINGERPRINTS.globalHash, id));
  }
  return { foldedUpTo: rows.length, head, byTask, globalHash, globalCount };
}

/**
 * Stamp unattributable rows plus this task's rows with three integers. Compare the shared
 * gateway fingerprint once per pass (heldGatewayKey); repeating its PR bodies per task cost
 * more than the work saved. Record: docs/forensics/board.md, 2026-09-15 measurement.
 */
export interface TaskProjectionStamp {
  readonly globalCount: number;
  readonly globalHash: number;
  readonly taskHash: number;
}

export function taskProjectionStamp(fp: TaskFingerprints, taskId: string): TaskProjectionStamp {
  return { globalCount: fp.globalCount, globalHash: fp.globalHash, taskHash: fp.byTask.get(taskId) ?? 0 };
}

export function sameTaskProjectionStamp(a: TaskProjectionStamp, b: TaskProjectionStamp): boolean {
  return a.globalCount === b.globalCount && a.globalHash === b.globalHash && a.taskHash === b.taskHash;
}

/**
 * Always re-derive in-flight projections: elapsedMs and DEFAULT_LIVENESS_BOUND_MS depend on
 * now(), even without new rows. Reusing a stamp would freeze elapsed time and pin dead runs
 * as running beyond 30 quiet minutes. See StatusProjection.elapsedMs and the 2026-09-15
 * measurement in docs/forensics/board.md.
 */
export function projectionAgesWithTheClock(projection: StatusProjection): boolean {
  return projection.phase !== undefined || projection.elapsedMs !== undefined;
}

export const EMPTY_DECISION_FINGERPRINT: DecisionFingerprint = { foldedUpTo: 0, head: undefined, hash: 0x811c9dc5, count: 0 };

/** A row's cheap identity for folding: its step and timestamp, not the whole row — re-serialising
 *  every row on every request would reintroduce the per-request cost this cache exists to avoid. */
function rowIdentity(row: Record<string, unknown>): string {
  return String(row.step ?? "") + " " + String(row.ts ?? "");
}

/** Fold `rows` into `prior`, walking only what is new. Restarts from zero when the log shrank or
 *  its head row changed — both mean rotation, and continuing across it would key the cache on a
 *  file that no longer exists. */
export function foldDecisionFingerprint(
  rows: ReadonlyArray<Record<string, unknown>>,
  prior: DecisionFingerprint,
): DecisionFingerprint {
  const head = rows.length > 0 ? rowIdentity(rows[0]!) : undefined;
  const rotated = rows.length < prior.foldedUpTo || (prior.foldedUpTo > 0 && head !== prior.head);
  const from = rotated ? 0 : prior.foldedUpTo;
  let hash = rotated ? EMPTY_DECISION_FINGERPRINT.hash : prior.hash;
  let count = rotated ? 0 : prior.count;
  for (let i = from; i < rows.length; i += 1) {
    const row = rows[i]!;
    if (!isDecisionRelevantRow(row)) continue;
    count += 1;
    const id = rowIdentity(row);
    // FNV-1a, folded into the running value — order-sensitive, so a reordering is a different key.
    for (let c = 0; c < id.length; c += 1) {
      hash ^= id.charCodeAt(c);
      hash = Math.imul(hash, 0x01000193);
    }
  }
  return { foldedUpTo: rows.length, head, hash: hash >>> 0, count };
}

/** The cache key this fingerprint contributes — count and hash together, so either side of a collision still invalidates. */
export function decisionKey(fp: DecisionFingerprint): string {
  return `${fp.count}:${(fp.hash >>> 0).toString(16)}`;
}

export function createBoardSnapshotCache(): BoardSnapshotCache {
  let cached: { plan: Plan; decisionKey: string; ghFailed: boolean; ghTruncated: boolean; prQueueIndexKey: string; snapshot: BoardSnapshot } | undefined;
  let lastGoodPrQueueAt: string | undefined;
  // Fold only appended rows across requests, never the whole ledger (W1-T2919).
  let fingerprint: DecisionFingerprint = EMPTY_DECISION_FINGERPRINT;
  // Per-task fold and held projections; see TaskFingerprints for invalidation rules.
  let taskFingerprints: TaskFingerprints = EMPTY_TASK_FINGERPRINTS;
  // Shared gateway key: compare once per pass; changes invalidate every projection.
  let heldGatewayKey: string | undefined;
  const projectionByTask = new Map<string, { stamp: TaskProjectionStamp; projection: StatusProjection }>();
  // Keep the tail cursor across requests or even cache hits would re-read the whole ledger.
  const tail = createLedgerTailCache();
  return {
    get(deps: BoardDeps): BoardSnapshot {
      const readLedger = deps.readLedger ?? ((path: string) => readLedgerTail(path, tail));
      const lines = readLedger(deps.ledgerPath);
      fingerprint = foldDecisionFingerprint(lines, fingerprint);
      const key = decisionKey(fingerprint);
      // GitHub can change without a ledger append; share one open-index read with recomputation.
      const prQueueIndex = readPrQueueIndex(deps.github);
      const prQueueIndexKey = prQueueIndexFingerprint(prQueueIndex);
      const ghFailed = safeReadFailed(deps.github);
      const ghTruncated = safeQueueTruncated(deps.github);
      if (
        cached &&
        cached.plan === deps.plan &&
        cached.decisionKey === key &&
        cached.ghFailed === ghFailed &&
        cached.ghTruncated === ghTruncated &&
        cached.prQueueIndexKey === prQueueIndexKey
      ) return withLiveGithubFacts(cached.snapshot, deps.github);
      // Index, health or truncation changes re-derive the whole plan.
      const gatewayKey = prQueueIndexKey + "|" + ghFailed + "|" + ghTruncated;
      taskFingerprints = foldTaskFingerprints(lines, taskFingerprints);
      if (heldGatewayKey !== gatewayKey || cached?.plan !== deps.plan) {
        // A new gateway key or plan invalidates every held projection.
        projectionByTask.clear();
        heldGatewayKey = gatewayKey;
      }
      const fp = taskFingerprints;
      // Hand computeBoardSnapshot this same already-resolved reader — one read, not two.
      const snapshot = computeBoardSnapshot(
        { ...deps, readLedger },
        {
          lastGoodPrQueueAt,
          prQueueIndex,
          reuseProjection: (task: Task) => {
            const held = projectionByTask.get(task.id);
            if (!held || projectionAgesWithTheClock(held.projection)) return undefined;
            return sameTaskProjectionStamp(held.stamp, taskProjectionStamp(fp, task.id)) ? held.projection : undefined;
          },
          captureProjections: (byId) => {
            // Rebuild so tasks removed from the plan cannot accumulate in the memo.
            projectionByTask.clear();
            for (const [taskId, projection] of byId) projectionByTask.set(taskId, { stamp: taskProjectionStamp(fp, taskId), projection });
          },
        },
      );
      if (snapshot.prQueue.complete) lastGoodPrQueueAt = snapshot.generated_at;
      cached = { plan: deps.plan, decisionKey: key, ghFailed, ghTruncated, prQueueIndexKey, snapshot };
      return snapshot;
    },
  };
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...headers });
  res.end(JSON.stringify(body));
}

/** GET /v1/status adds this token's recap only when lastSeen is wired (W1-T163).
 *  Otherwise both fields are absent, preserving the earlier response shape. */
export interface StatusResponse extends BoardSnapshot {
  /** Every recap-worthy event after this token's prior marker; `[]` on a first-ever view (no
   *  prior marker to recap from). */
  recap?: RecapEvent[];
  /** This token's marker value before this request advanced it; `undefined` on a first-ever view. */
  sinceCheckpoint?: string;
}

/** Mark human views; automatic polls omit this and must not advance the marker.
 *  A header preserves the request URL existing callers match. */
// Why: the query-param design this header replaced — docs/forensics/board.md#recap_ack_header
export const RECAP_ACK_HEADER = "x-rmd-recap-ack";

/** Names a source a cached page depends on that is stale, so the page's staleness says so too. */
export const STALE_SOURCE_HEADER = "x-rmd-stale-source";

/** Is this `GET /v1/status` an acknowledged view, or an automatic poll? Presence is the signal. */
export function requestAcknowledgesRecap(headerValue: string | string[] | undefined): boolean {
  return headerValue !== undefined;
}

/**
 * Read-scoped, memoized status with optional per-token recap (W1-T163).
 * Advance lastSeen only with RECAP_ACK_HEADER: automatic polls once shrank an open tab's
 * recap window permanently to a few seconds.
 */
// Why: the recap-window incident this ack gate fixes — docs/forensics/board.md#buildstatusroute
export function buildStatusRoute(deps: BoardDeps, lastSeen?: LastSeenStore, source?: BoardSnapshotSource): Route {
  const cache = createBoardSnapshotCache();
  return {
    method: "GET",
    path: "/v1/status",
    scope: "read",
    handler: (req, res) => {
      const state = source?.current();
      if (state?.state === "unavailable") {
        sendJson(res, 503, { error: "board_unavailable", ...state }, { "retry-after": "5" });
        return;
      }
      const snapshot = state?.snapshot ?? cache.get(deps);
      if (!lastSeen) {
        sendJson(res, 200, snapshot, staleSourceHeaders(snapshot));
        return;
      }
      const tokenId = bearerTokenId(req);
      const sinceCheckpoint = lastSeen.get(tokenId);
      const recap =
        sinceCheckpoint === undefined
          ? []
          : buildRecapEvents(deps.readLedger?.(deps.ledgerPath) ?? readLedgerLines(deps.ledgerPath), sinceCheckpoint, deps.plan);
      // Advance after recap to the snapshot's timestamp; a second Date.now() could race ahead.
      if (requestAcknowledgesRecap(req.headers[RECAP_ACK_HEADER])) lastSeen.advance(tokenId, snapshot.generated_at);
      const body: StatusResponse = { ...snapshot, recap, sinceCheckpoint };
      sendJson(res, 200, body, staleSourceHeaders(snapshot));
    },
  };
}

// Ledger-first RECENT feed (W1-T184, W1-T153): bypass GitHub-gated status projections.
// GitHub only decorates linked PRs; failures mark githubUnavailable, never remove entries
// (see decoratePrTitle).

interface RecentActivityState {
  /** Bounded candidate history includes rows whose task was not yet filed in this plan. */
  retainedCandidates?: RecentActivityEntry[];
  /** This identity must not keep an old parsed plan alive between feed reads. */
  plan?: WeakRef<Plan>;
  /** Classified line cursor: never reclassify or refetch GitHub for an already-minted entry. */
  scannedLines: number;
  /** Minted entries, oldest first, capped to {@link RECENT_ACTIVITY_HISTORY_CAP}. */
  entries: RecentActivityEntry[];
  /** `run_id` -> its `pr.opened` PR url — carries a run's own PR forward onto later lines (e.g.
   *  `verdict`/`fix.done`) that name no `pr_url` of their own. */
  prByRun: Map<string, string>;
  /** readLedgerTail's byte cursor below scannedLines: file reads cost O(new bytes), not O(history). */
  ledgerTail: LedgerTailCache;
  /** readLedgerTail extends its array in place; a new identity signals rotation even when
   *  the rewritten file has more lines than scannedLines. */
  lastLines?: ReadonlyArray<Record<string, unknown>>;
}

/** Opaque handle a caller holds across requests, mirroring {@link BoardSnapshotCache} — never reconstructed per render. */
export interface RecentActivityCache {
  /** @internal — read/written only by {@link computeRecentActivity}. */
  state: RecentActivityState;
}

export function createRecentActivityCache(): RecentActivityCache {
  return { state: { scannedLines: 0, entries: [], prByRun: new Map(), ledgerTail: createLedgerTailCache() } };
}

/** Decorate via prByRef, never gate entries (W1-T184). Missing titles stay silent;
 *  readFailed marks githubUnavailable so outages remain visible (W1-T181). */
function decoratePrTitle(entry: RecentActivityEntry, deps: BoardDeps): RecentActivityEntry {
  if (!entry.prUrl) return entry;
  // Guard both GitHub calls: either throw degrades this row, never 500s the HTTP request.
  try {
    const pr = deps.github.prByRef(entry.prUrl);
    if (pr?.title) return { ...entry, prTitle: pr.title };
    if (deps.github.readFailed?.()) return { ...entry, githubUnavailable: true };
    return entry;
  } catch {
    return { ...entry, githubUnavailable: true };
  }
}

/** Classify only new lines, decorate once at mint, and return newest max entries (W1-T184).
 *  A failing gateway preserves entries without prTitle; see {@link decoratePrTitle}. */
export function computeRecentActivity(deps: BoardDeps, cache: RecentActivityCache, max = 20): RecentActivityEntry[] {
  const state = cache.state;
  // Separate byte and line cursors bound file reads and classification/decoration respectively.
  const readLedger = deps.readLedger ?? ((path: string) => readLedgerTail(path, state.ledgerTail));
  const lines = readLedger(deps.ledgerPath);
  // A shorter ledger than last scanned should never happen (append-only); degrade safely by
  // rescanning from scratch rather than slicing with a negative offset.
  const rewritten = deps.readLedger === undefined && state.lastLines !== undefined && lines !== state.lastLines;
  state.lastLines = lines;
  if (rewritten || lines.length < state.scannedLines) {
    state.scannedLines = 0;
    state.entries = [];
    state.prByRun = new Map();
    state.retainedCandidates = [];
    state.plan = undefined;
  }
  const newLines = lines.slice(state.scannedLines);
  state.scannedLines = lines.length;
  feedRecentActivity(deps, cache, newLines);
  return recentActivityEntries(cache, max);
}

/** The feed's newest `max` entries, newest first. */
export function recentActivityEntries(cache: RecentActivityCache, max = 20): RecentActivityEntry[] {
  return cache.state.entries.slice(-max).reverse();
}

/**
 * Classifies `newLines` into the feed, each exactly once: {@link computeRecentActivity}'s body, for a caller that hands
 * it each row as it is read rather than a cursor into one growing array (W1-T9436: the board's rows now drop rows).
 */
function recentCandidateIdentity({ title: _title, prTitle: _prTitle, githubUnavailable: _unavailable, ...entry }: RecentActivityEntry): string {
  return JSON.stringify(entry);
}

function appendRecentCandidate(deps: BoardDeps, cache: RecentActivityCache, entry: RecentActivityEntry, historical = false): void {
  const state = cache.state;
  // Preserve the existing one-merge-one-row rule, including the later canonical timestamp.
  if (entry.verb === "merged") {
    const duplicateIndex = state.entries.findIndex(e => e.verb === "merged" && e.taskId === entry.taskId && e.prUrl === entry.prUrl);
    if (duplicateIndex >= 0) {
      const previous = state.entries[duplicateIndex];
      if (previous && Date.parse(entry.ts) > Date.parse(previous.ts)) state.entries[duplicateIndex] = decoratePrTitle(entry, deps);
      return;
    }
  }
  const next = decoratePrTitle(entry, deps);
  const firstLater = historical ? state.entries.findIndex(candidate => Date.parse(candidate.ts) > Date.parse(entry.ts)) : -1;
  if (firstLater < 0) state.entries.push(next);
  else state.entries.splice(firstLater, 0, next);
  if (state.entries.length > RECENT_ACTIVITY_HISTORY_CAP) state.entries.shift();
}

/** Replay bounded event projections after a plan replacement; never retain raw worker/tool payloads. */
export function feedRecentActivity(deps: BoardDeps, cache: RecentActivityCache, newLines: ReadonlyArray<Record<string, unknown>>): void {
  const state = cache.state;
  const retained = state.retainedCandidates ??= [];
  if (state.plan !== undefined && state.plan.deref() !== deps.plan) {
    state.entries = state.entries.map(entry => ({ ...entry, title: deps.plan.byId.get(entry.taskId)?.title ?? entry.title }));
    const existing = new Set(state.entries.map(recentCandidateIdentity));
    for (const entry of retained) {
      const task = deps.plan.byId.get(entry.taskId);
      if (task && !existing.has(recentCandidateIdentity(entry))) {
        appendRecentCandidate(deps, cache, { ...entry, title: task.title }, true);
        existing.add(recentCandidateIdentity(entry));
      }
    }
  }
  state.plan = new WeakRef(deps.plan);
  for (const line of newLines) {
    const runId = recentRunId(line.run_id);
    if (line.step === "pr.opened" && runId && typeof line.pr_url === "string") state.prByRun.set(runId, line.pr_url);
    const isOperatorAction = typeof line.step === "string" && OPERATOR_ACTION_STEPS.has(line.step);
    const taskId = isOperatorAction && typeof line.task === "string" ? line.task
      : typeof line.task_id === "string" ? line.task_id : undefined;
    if (!taskId) continue;
    const task = deps.plan.byId.get(taskId);
    const ts = typeof line.ts === "string" ? line.ts : new Date().toISOString();
    const prUrl = typeof line.pr_url === "string" ? line.pr_url : runId ? state.prByRun.get(runId) : undefined;
    const projected = recentEntryFromLine(line, taskId, task?.title ?? taskId, ts, prUrl);
    if (!projected) continue;
    const entry = runId ? { ...projected, runId } : projected;
    retained.push(entry);
    if (retained.length > RECENT_ACTIVITY_HISTORY_CAP) retained.shift();
    if (!task && !isOperatorAction) continue;
    appendRecentCandidate(deps, cache, entry);
  }
}

/** The feed's default page, and what `?limit=` may raise it to (the whole retained history). */
const RECENT_DEFAULT_LIMIT = 20;

/** `?verb=merged,review` narrows the feed to those verbs, and `?limit=` sizes it (1..200), so a
 *  merges panel is not starved by a busy hour of run starts. Both are optional: a bare GET is the
 *  newest 20 of every verb, as it always was. */
function recentQuery(rawUrl: string | undefined): { verbs?: ReadonlySet<string>; limit: number } | { error: string } {
  const params = new URL(rawUrl ?? "/", "http://localhost").searchParams;
  const limitRaw = params.get("limit");
  const limit = limitRaw === null ? RECENT_DEFAULT_LIMIT : Number(limitRaw);
  if (!Number.isInteger(limit) || limit < 1 || limit > RECENT_ACTIVITY_HISTORY_CAP) {
    return { error: `limit must be an integer from 1 to ${RECENT_ACTIVITY_HISTORY_CAP}` };
  }
  const verbRaw = params.get("verb");
  if (verbRaw === null) return { limit };
  const verbs = verbRaw.split(",").map((v) => v.trim()).filter(Boolean);
  const unknown = verbs.filter((v) => !(RECENT_ACTIVITY_VERBS as readonly string[]).includes(v));
  if (verbs.length === 0 || unknown.length > 0) return { error: `unknown verb: ${unknown.join(",") || "(empty)"}` };
  return { verbs: new Set(verbs), limit };
}

/** GET /v1/recent — the RECENT section's data, read-scoped, one {@link RecentActivityCache} per route instance. */
export function buildRecentRoute(deps: BoardDeps): Route {
  const cache = createRecentActivityCache();
  return {
    method: "GET",
    path: "/v1/recent",
    scope: "read",
    handler: (req, res) => {
      const query = recentQuery(req.url);
      if ("error" in query) {
        sendJson(res, 400, { error: "invalid_request", detail: query.error });
        return;
      }
      const entries = computeRecentActivity(deps, cache, RECENT_ACTIVITY_HISTORY_CAP);
      const verbs = query.verbs;
      const matching = verbs ? entries.filter((e) => verbs.has(e.verb)) : entries;
      sendJson(res, 200, { entries: matching.slice(0, query.limit) });
    },
  };
}

/** SSE status changes via one shared publisher (W1-T4455, status-stream-publisher.ts):
 *  N viewers share one tail/derive/poll pass. Subscribing never replays history. */
export function buildStatusStream(deps: BoardDeps, pollMs = DEFAULT_POLL_MS): SseRoute {
  return {
    path: "/v1/status/stream",
    scope: "read",
    subscribe: (send: SseSend, req) => subscribeStatusStream(deps, send, {
      pollMs,
      lastEventId: typeof req?.headers["last-event-id"] === "string" ? req.headers["last-event-id"] : undefined,
    }),
  };
}

// FIND sort specification (W1-T157), mirrored by serve.ts's non-importable inline script.
// Explicit direction keeps missing values last both ways; reversing the array would break that.

export type BoardSortKey = "id" | "status" | "recency" | "age";
export type SortDir = "asc" | "desc";

/** `av`/`bv` compared numerically; `undefined` (no value) always sorts AFTER any value, whatever `dir`. */
function compareMissingLast(av: number | undefined, bv: number | undefined, dir: SortDir): number {
  if (av === undefined && bv === undefined) return 0;
  if (av === undefined) return 1; // a has no value -> a after b, regardless of direction
  if (bv === undefined) return -1;
  return dir === "desc" ? bv - av : av - bv;
}

/** Lexicographic by taskId. */
export function compareById(a: BoardRow, b: BoardRow, dir: SortDir): number {
  const base = a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0;
  return dir === "desc" ? -base : base;
}

/** By index within {@link TASK_STATUSES} (queued … done). An unknown status sorts as -1 (before queued). */
export function compareByStatus(a: BoardRow, b: BoardRow, dir: SortDir): number {
  const base = TASK_STATUSES.indexOf(a.status) - TASK_STATUSES.indexOf(b.status);
  return dir === "desc" ? -base : base;
}

/** By `lastActivityAt` (parsed to epoch ms); tasks with no ledger activity sort last, in both directions. */
export function compareByRecency(a: BoardRow, b: BoardRow, dir: SortDir): number {
  const av = a.lastActivityAt ? Date.parse(a.lastActivityAt) : undefined;
  const bv = b.lastActivityAt ? Date.parse(b.lastActivityAt) : undefined;
  return compareMissingLast(av, bv, dir);
}

/** By `elapsedMs` (in-flight runs only). A task not in flight has no meaningful age, so it sorts
 *  after every task that does, in both directions — the same missing-value rule as `recency`. */
export function compareByAge(a: BoardRow, b: BoardRow, dir: SortDir): number {
  return compareMissingLast(a.elapsedMs, b.elapsedMs, dir);
}

const COMPARATORS: Record<BoardSortKey, (a: BoardRow, b: BoardRow, dir: SortDir) => number> = {
  id: compareById,
  status: compareByStatus,
  recency: compareByRecency,
  age: compareByAge,
};

/** Sort a COPY of `rows` by the given column/direction, with a stable id-ascending tiebreak. */
export function sortBoardRows(rows: readonly BoardRow[], sort: BoardSortKey, dir: SortDir): BoardRow[] {
  const cmp = COMPARATORS[sort];
  return [...rows].sort((a, b) => cmp(a, b, dir) || compareById(a, b, "asc"));
}
