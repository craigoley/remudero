/**
 * lib/board.ts — the read-only live board's daemon-side wiring (W3-T2, MASTER-PLAN §7 WS-5a).
 *
 * One route pair: GET /v1/status (a REST snapshot) and GET /v1/status/stream (SSE, one `status`
 * event per task whose derived StatusProjection changes), built entirely on lib/service.ts's
 * Route/SseRoute and lib/status.ts's projectPlan/deriveStatus. Zero new business logic: this
 * module only wires those two together and tails state/ledger.ndjson to know when to recompute.
 *
 * INVARIANT: the stream polls the ledger every {@link DEFAULT_POLL_MS} rather than using
 * `fs.watch` (not portable across CI runners), and only sends an event when a task's projection
 * actually changed — a state flip, not a mere touch. Proven against a real HTTP server,
 * test/board.test.ts, the way test/service.test.ts proves the generic mechanism.
 */
// Why: the "Option A" narrow-scope decision — docs/forensics/board.md#file-header

import type { ServerResponse } from "node:http";
import type { Plan, Task, TaskRisk } from "./plan.js";
import { DEFAULT_RISK, TASK_STATUSES } from "./plan.js";
import {
  createLedgerTailCache,
  deriveStatus,
  projectPlan,
  readLedgerLines,
  readLedgerTail,
  type BoardDeps,
  type LedgerTailCache,
  type StatusProjection,
  type PrRef,
  taskIdFromRunBranch,
} from "./status.js";
// W1-T2895: `BoardDeps` re-exported unchanged for every existing consumer of `board.js`'s own
// `BoardDeps` — moving the DEFINITION to `status.ts`, never the public surface.
export type { BoardDeps };
import type { Route, SseRoute, SseSend } from "./service.js";
import { bearerTokenId } from "./panel-actions.js";
import type { LastSeenStore } from "./last-seen.js";
import { buildRecapEvents, type RecapEvent } from "./recap.js";
import { computeGlanceSpend, type GlanceSpend } from "./glance.js";
import { buildStatusBoard, type BlockedPrBlocker, type MergeHeldRow } from "./status-board.js";

/** Ledger poll pace for the SSE stream — comfortably under the 2s acceptance budget. */
export const DEFAULT_POLL_MS = 250;

/**
 * One board row: a {@link StatusProjection} enriched with the plan-`Task` fields the FIND layer
 * (W1-T157) needs but {@link StatusProjection} does not carry — `title` and `risk` — plus
 * `lastActivityAt`, the ISO timestamp of the last ledger line naming this task. The join lives
 * here, not on {@link StatusProjection}, because that interface is mirrored by openapi/daemon.yaml
 * and consumed elsewhere; the SSE `status` stream keeps emitting the bare projection, and the
 * shell backfills the enrichment across deltas (src/lib/serve.ts).
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
  /** Worker liveness (W1-T944), carried through from {@link StatusProjection.workerState} — the
   *  same scan that derives `phase`/`elapsedMs`. Present only alongside `phase`; absent there
   *  means no `worker.state` row has arrived, rendered as "state unknown". */
  workerState?: StatusProjection["workerState"];
  /** ISO-8601 `ts` the run entered its current `workerState`, carried through from
   *  {@link StatusProjection.workerStateSince}. Present only while `workerState === "quiet"`; the
   *  console ages a "quiet Nm" duration off it on the same 1s tick `elapsedMs` uses. */
  workerStateSince?: string;
  /** Process-unevidenced (W1-T1240), carried through from
   *  {@link StatusProjection.processUnevidenced}. Present only alongside `phase`, same sparse
   *  convention as `workerState`. */
  processUnevidenced?: StatusProjection["processUnevidenced"];
  /** The row's own `remudero-review` three-state (W1-T914), present only alongside `prUrl`. One
   *  of `success`/`failure` (last posted verdict), `pending`, `none` (never posted — per W1-T225
   *  the worst state, never softened), `unreadable` (the read itself failed), or `not-applicable`
   *  (W1-T2235: PR merged/closed). Bound to {@link GitHub.reviewState}. */
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
  /** Header counts, derived from the same `tasks` below — tally and rows can never disagree. */
  counts: CountSummary;
  /** GLANCE strip totals (W1-T159), from the same ledger lines this snapshot already read. */
  spend: GlanceSpend;
  tasks: BoardRow[];
  /** A PR the sweep reconciler already disposed into a non-progressing class (W1-T1006's sixth
   *  NEEDS-ME row source), sourced verbatim from status-board.ts's `buildStatusBoard` — see
   *  {@link deriveBoardStatusSections}. Always an array, never `undefined`. */
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
}

interface PrQueueIndexRead {
  open: PrRef[] | null | undefined;
  failed: boolean;
  truncated: boolean;
  failureReason: string;
}

/** The `ts` of the last ledger line naming each task id (the board's `lastActivityAt`, W1-T157),
 *  factored out so {@link computeBoardSnapshot} doesn't duplicate this scan inline. RECENT no
 *  longer shares this map for its own ordering; {@link computeRecentActivity} orders by ledger
 *  append order via its own {@link RecentActivityState.scannedLines} tail cursor instead. */
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

/** The sixth NEEDS-ME row source (W1-T1006): reuses status-board.ts's `buildStatusBoard`
 *  verbatim for the blocked-PR derivation, never a second derivation over the ledger. `plan` is
 *  deliberately omitted so `buildStatusBoard`'s own QUEUE HEAD/INBOX pass never runs a second,
 *  duplicate batch of `github` calls this board doesn't need. `root`/`repoDir` are a deliberately
 *  bogus sentinel, not `""`, so a test run from a real `state/`/`plan/` tree can't accidentally
 *  pick up files for a section this board discards anyway. */
// Why: the measured double-`prByRef`-call incident this plan-omission fixes —
// docs/forensics/board.md#deriveboardstatussections
const BLOCKED_PR_ROOT_SENTINEL = "/nonexistent-rmd-board-root";

function deriveBoardStatusSections(
  deps: BoardDeps,
  lines: Array<Record<string, unknown>>,
): { blockedPrs: BlockedPrBlocker[]; blockedPrsUnverifiedReason?: string; mergeHeld: MergeHeldRow[] } {
  const model = buildStatusBoard(BLOCKED_PR_ROOT_SENTINEL, deps.ledgerPath, {
    queryService: () => ({ running: false, pid: null }),
    repoDir: BLOCKED_PR_ROOT_SENTINEL,
    readLedger: () => lines,
    resolveOriginMainSha: () => undefined,
    github: deps.github,
    now: deps.now,
    grepAnchorTrue: () => false,
    readProposalRegistry: () => [],
    readDraftCache: () => ({}),
  });
  const blockedPrs = model.blockers.rows.filter((r): r is BlockedPrBlocker => r.kind === "blocked_pr");
  return {
    blockedPrs,
    blockedPrsUnverifiedReason: model.blockers.blockedPrsUnverifiedReason,
    mergeHeld: model.needsMe.mergeHeld,
  };
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

  const rows: PrQueueRow[] = [];
  for (const pr of unique.values()) {
    let transition: Record<string, unknown> | undefined;
    if (pr.headRefOid) {
      for (const line of lines) {
        if (line.step !== "sweep.disposed" || line.pr_number !== pr.number || line.head_sha !== pr.headRefOid) continue;
        transition = line;
      }
    }
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

/** The board snapshot, reusing {@link projectPlan} verbatim for the merge-state — no new
 *  derivation logic. Joins each projection with its plan `Task`'s `title`/`risk` and the
 *  ledger's `lastActivityAt` to produce a {@link BoardRow} (W1-T157; see that interface's note
 *  for why the join lives here). */
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
  const effectiveDeps: BoardDeps = { ...deps, github: snapshotGithub, readLedger: () => lines };
  const byId = projectPlan(deps.plan, effectiveDeps);
  const lastActivity = lastActivityByTask(lines);
  const tasks: BoardRow[] = [...byId.values()].map((p) => {
    // A task-less escalation's own row (W1-T283) owns no plan Task to join title/risk from.
    // Fall back to its own title (or the bare id) and the default risk band rather than a
    // non-null assertion that would crash the whole snapshot.
    const task = deps.plan.byId.get(p.taskId);
    const row: BoardRow = {
      ...p,
      title: task ? task.title : (p.escalationTitle ?? p.taskId),
      risk: task ? task.risk : DEFAULT_RISK,
    };
    const ts = lastActivity.get(p.taskId)?.ts;
    if (ts) row.lastActivityAt = ts;
    if (p.phase) {
      const spend = liveRunSpend(lines, p.taskId);
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
  // The header counts derive from these SAME tasks (never a second predicate that could
  // disagree), and the merge tally is flagged unknown on a GitHub outage rather than reporting
  // "0 merged" as fact (fb-1784902052582-c124f9).
  const github_unreachable = safeReadFailed(effectiveDeps.github);
  const now = deps.now ?? Date.now;
  const generatedAt = new Date().toISOString();
  const { blockedPrs, blockedPrsUnverifiedReason, mergeHeld } = deriveBoardStatusSections(effectiveDeps, lines);
  const prQueue = derivePrQueue(effectiveDeps, lines, tasks, mergeHeld, generatedAt, options.lastGoodPrQueueAt, prQueueIndex);
  return {
    generated_at: generatedAt,
    github_unreachable,
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
 * One STOPPED predicate, shared by the header tally and the GLANCE strip's client-side recompute.
 *
 * INVARIANT: `status === "blocked"` alone undercounts stopped work, because `needsHuman` is a
 * separate field `deriveStatus` sets beside `status`, never by overwriting it — a task can be
 * `queued`/`running` and still need a human. Every `needs me` row is a `blocked` row; `blocked`
 * additionally holds plan-declared `status: "blocked"` tasks with no issue to click.
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

/**
 * Live accumulated spend/turns (W1-T184): sums `cost_usd`/`num_turns` over `implement.done`/
 * `fix.done` lines for `taskId` since its latest `run.start` — the same reset rule
 * {@link deriveRunState} uses (task_id + `run.start`/`verdict`, never `run_id`; a cold fix-rung
 * dispatch stamps its own pseudo `run_id`, so keying on that instead silently freezes live
 * spend). Narrow to these two step names: `budget.warning`/`verdict` log a running total, not an
 * increment, so summing those too would double-count.
 */
// Why: the frozen-live-spend incident this reset rule fixes — docs/forensics/board.md#liverunspend
function liveRunSpend(lines: Array<Record<string, unknown>>, taskId: string): { spendUsd: number; turns: number; hasData: boolean } | undefined {
  let inFlight = false;
  let spendUsd = 0;
  let turns = 0;
  // Distinguishes "no data yet" from a real zero (fb-1784902052582-c124f9).
  let hasData = false;
  for (const line of lines) {
    if (line.task_id !== taskId) continue;
    if (line.step === "run.start") {
      inFlight = true;
      spendUsd = 0;
      turns = 0;
      hasData = false;
      continue;
    }
    if (line.step === "verdict") {
      inFlight = false;
      continue;
    }
    if (!inFlight) continue;
    if (line.step !== "implement.done" && line.step !== "fix.done") continue;
    if (typeof line.cost_usd === "number") spendUsd += line.cost_usd;
    if (typeof line.num_turns === "number") turns += line.num_turns;
    hasData = true;
  }
  return inFlight ? { spendUsd, turns, hasData } : undefined;
}

/**
 * Memoized {@link computeBoardSnapshot} (W1-T184): a recompute only happens when something the
 * projection actually depends on has changed; an unchanged input returns the same cached
 * snapshot instantly. Every consumer here is synchronous, so no two recomputes can ever overlap —
 * this same memo also collapses a burst of concurrent requests into exactly one recompute.
 *
 * Deliberately not time/TTL-based: the cache key is `(ledger line count, gateway health,
 * material open-index fingerprint)`. Any of the three can change with no new ledger line — the
 * gateway can recover or fail, or a PR can open/close before sweep records it — so a TTL would
 * either recompute needlessly often or miss a GitHub-only change for a whole window.
 */
// Why: the 2026-07-20 uncached GET /v1/status latency outage this memo fixes —
// docs/forensics/board.md#createboardsnapshotcache--boardsnapshotcache
export interface BoardSnapshotCache {
  get(deps: BoardDeps): BoardSnapshot;
}

/** `github.readFailed?.()` guarded (W1-T184): a gateway that THROWS from `readFailed()` itself
 *  (not merely fails soft) would otherwise blow up the cache-key computation and 500 the whole
 *  /v1/status request. Fails closed — an unreadable health signal reads as an outage, never a
 *  silent "GitHub is fine". */
function safeReadFailed(github: BoardDeps["github"]): boolean {
  try {
    return github.readFailed?.() ?? false;
  } catch {
    return true;
  }
}

/**
 * The row's `reviewState` (W1-T914), bound to {@link GitHub.reviewState} — never a second
 * derivation. `undefined` for a row with no PR at all. Three fail-soft cases stay distinct: no
 * `reviewState` method on the gateway -> `"none"` (honestly unresolved); the method returns a
 * real value, including its own `"none"`/`"not-applicable"` -> that value verbatim; the method
 * throws or returns `undefined` -> `"unreadable"` when {@link safeReadFailed} confirms an
 * outage, `"none"` otherwise (a `prUrl` this gateway simply can't resolve).
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
 * Ledger steps that never change a board row (W1-T2919), so the cache key can ignore them.
 * `daemon.alive` and `board_gateway.fetch_bytes` append on every poll/fetch and previously
 * invalidated the cache key every time, forcing a synchronous recompute roughly once a minute
 * with nothing on the board actually changed.
 *
 * INVARIANT: defined by exclusion, not inclusion. An inclusion list defaults a step nobody has
 * added yet to "irrelevant", so a new board-affecting step would silently serve a stale board.
 * This exclusion defaults a new step to relevant instead — the cache invalidates, and the only
 * cost is a missed optimisation, never a correctness bug. A step may join this set only once
 * measured to be unread anywhere in the projection path.
 */
// Why: the once-a-minute cache-thrash incident this exclusion fixes —
// docs/forensics/board.md#board_irrelevant_steps
export const BOARD_IRRELEVANT_STEPS: ReadonlySet<string> = new Set(["daemon.alive", "board_gateway.fetch_bytes"]);

/** The `step` of one already-parsed ledger row, or `undefined` when it carries none (a torn
 *  write). A row whose step cannot be read is treated as decision-relevant — unknown stays
 *  visible, the same fail-open posture the rest of this module takes. */
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
  /** The first row's identity as folded, so a rotation (the live file shrinking, or its head
   *  being replaced) is detected and the fold restarted rather than continued against a stale file. */
  readonly head: string | undefined;
  readonly hash: number;
  /** How many decision-relevant rows have been folded in — sufficient alone to detect an append
   *  on this append-only log, the same signal the old raw line count gave without the noise. */
  readonly count: number;
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
  let cached: { decisionKey: string; ghFailed: boolean; ghTruncated: boolean; prQueueIndexKey: string; snapshot: BoardSnapshot } | undefined;
  let lastGoodPrQueueAt: string | undefined;
  // Folded across requests (W1-T2919), so a cache hit costs one pass over the lines appended
  // since the last one, never a re-walk of the whole ledger.
  let fingerprint: DecisionFingerprint = EMPTY_DECISION_FINGERPRINT;
  // One persistent tail cursor for this route's whole lifetime, never reconstructed per request —
  // otherwise a cache hit would still pay a full ledger re-read just to compute the line count.
  const tail = createLedgerTailCache();
  return {
    get(deps: BoardDeps): BoardSnapshot {
      const readLedger = deps.readLedger ?? ((path: string) => readLedgerTail(path, tail));
      fingerprint = foldDecisionFingerprint(readLedger(deps.ledgerPath), fingerprint);
      const key = decisionKey(fingerprint);
      // The queue's live identity can change before sweep appends anything. Read the batched
      // open half once for the cache key, then hand this same capture to the recompute below.
      const prQueueIndex = readPrQueueIndex(deps.github);
      const prQueueIndexKey = prQueueIndexFingerprint(prQueueIndex);
      const ghFailed = safeReadFailed(deps.github);
      const ghTruncated = safeQueueTruncated(deps.github);
      if (
        cached &&
        cached.decisionKey === key &&
        cached.ghFailed === ghFailed &&
        cached.ghTruncated === ghTruncated &&
        cached.prQueueIndexKey === prQueueIndexKey
      ) return cached.snapshot;
      // Hand computeBoardSnapshot this same already-resolved reader — one read, not two.
      const snapshot = computeBoardSnapshot({ ...deps, readLedger }, { lastGoodPrQueueAt, prQueueIndex });
      if (snapshot.prQueue.complete) lastGoodPrQueueAt = snapshot.generated_at;
      cached = { decisionKey: key, ghFailed, ghTruncated, prQueueIndexKey, snapshot };
      return snapshot;
    },
  };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

/** `GET /v1/status`'s body — the memoized {@link BoardSnapshot} plus, when `lastSeen` is wired
 *  (W1-T163), the caller token's own "since you last checked" recap. Both fields are absent when
 *  no `lastSeen` store is wired, so a caller that predates W1-T163 sees an unchanged shape. */
export interface StatusResponse extends BoardSnapshot {
  /** Every recap-worthy event after this token's prior marker; `[]` on a first-ever view (no
   *  prior marker to recap from). */
  recap?: RecapEvent[];
  /** This token's marker value before this request advanced it; `undefined` on a first-ever view. */
  sinceCheckpoint?: string;
}

/** The request header a caller sets to say "a human is looking at this response, mark it seen".
 *  Absent means an automatic poll, which must not advance the marker. A header, not a query
 *  param, so the request URL stays byte-identical to what every existing caller matches. */
// Why: the query-param design this header replaced — docs/forensics/board.md#recap_ack_header
export const RECAP_ACK_HEADER = "x-rmd-recap-ack";

/** Is this `GET /v1/status` an acknowledged view, or an automatic poll? Presence is the signal. */
export function requestAcknowledgesRecap(headerValue: string | string[] | undefined): boolean {
  return headerValue !== undefined;
}

/**
 * GET /v1/status — the board snapshot, read-scoped, memoized per {@link createBoardSnapshotCache}.
 * When `lastSeen` (W1-T163) is supplied, a view also folds the calling token's own recap in.
 *
 * INVARIANT: the marker advances only on an acknowledged view ({@link RECAP_ACK_HEADER} set),
 * never on every automatic poll — an unconditional advance once shrank a tab left open all
 * evening to an effectively permanent few-second recap window.
 */
// Why: the recap-window incident this ack gate fixes — docs/forensics/board.md#buildstatusroute
export function buildStatusRoute(deps: BoardDeps, lastSeen?: LastSeenStore): Route {
  const cache = createBoardSnapshotCache();
  return {
    method: "GET",
    path: "/v1/status",
    scope: "read",
    handler: (req, res) => {
      const snapshot = cache.get(deps);
      if (!lastSeen) {
        sendJson(res, 200, snapshot);
        return;
      }
      const tokenId = bearerTokenId(req);
      const sinceCheckpoint = lastSeen.get(tokenId);
      const recap =
        sinceCheckpoint === undefined
          ? []
          : buildRecapEvents(deps.readLedger?.(deps.ledgerPath) ?? readLedgerLines(deps.ledgerPath), sinceCheckpoint, deps.plan);
      // Advance AFTER computing the recap, off the SAME timestamp the snapshot itself claims to
      // be current as of -- never `Date.now()` a second time, which could race a hair ahead of
      // what this response actually reflects. Gated on the ack flag: see this function's doc.
      if (requestAcknowledgesRecap(req.headers[RECAP_ACK_HEADER])) lastSeen.advance(tokenId, snapshot.generated_at);
      const body: StatusResponse = { ...snapshot, recap, sinceCheckpoint };
      sendJson(res, 200, body);
    },
  };
}

// ── GET /v1/recent — the ledger-first activity feed (W1-T184, W1-T153's RECENT section) ───────
//
// An activity feed over the ledger's own event classes — merges/verdicts, fix-rung outcomes,
// escalations, spend checkpoints — never routed through deriveStatus/projectPlan's GitHub-gated
// rungs. GitHub only decorates a row that already carries a PR link; a failed decoration marks
// it `githubUnavailable` and never removes it (see {@link decoratePrTitle}).

export type RecentActivityVerb = "merged" | "verdict" | "fix" | "escalated" | "spend" | "run-refused" | "run-started";

/** The steps that record the daemon's resolution of an operator-initiated console action
 *  (W1-T266) — an allowlist, not a removal of the `!task` guard every other pseudo-id line
 *  ({@link computeRecentActivity}) still gets, since that housekeeping traffic would bury the
 *  feed. These two lines carry the real task id in `line.task`, not `line.task_id`. */
// Why: the 2026-07-31 silent-refusal incident this allowlist fixes —
// docs/forensics/board.md#operator_action_steps
const OPERATOR_ACTION_STEPS = new Set(["console.kick_refused", "console.kick_dispatched"]);

/** One RECENT row: a single ledger event, not a task's final state — see this section's header. */
export interface RecentActivityEntry {
  taskId: string;
  /** The plan task's own title, so RECENT names what a row is, not just its id. */
  title: string;
  verb: RecentActivityVerb;
  /** ISO-8601 `ts` of the originating ledger line — the feed's relative-timestamp source. */
  ts: string;
  /** The originating step's own outcome label (e.g. a `verdict` string, an escalation `class`). */
  detail?: string;
  /** Present wherever the originating ledger line carries `cost_usd`. */
  costUsd?: number;
  numTurns?: number;
  prNumber?: number;
  prUrl?: string;
  /** GitHub decoration, never a gate — the PR's title, present only when a read resolved it. */
  prTitle?: string;
  /** GitHub decoration attempted and failed for this row's `prUrl` — the row still renders, ledger-only. */
  githubUnavailable?: true;
}

/** Bounded rolling history a {@link RecentActivityCache} holds — large enough that `max` (the
 *  feed's visible window) is always a small tail slice of it, never the whole thing. */
const RECENT_ACTIVITY_HISTORY_CAP = 200;

interface RecentActivityState {
  /** How many ledger lines have already been scanned/classified, so a render never
   *  re-classifies (or re-fetches GitHub for) a line it already minted an entry from. */
  scannedLines: number;
  /** Minted entries, oldest first, capped to {@link RECENT_ACTIVITY_HISTORY_CAP}. */
  entries: RecentActivityEntry[];
  /** `run_id` -> its `pr.opened` PR url — carries a run's own PR forward onto later lines (e.g.
   *  `verdict`/`fix.done`) that name no `pr_url` of their own. */
  prByRun: Map<string, string>;
  /** The file-level tail cursor {@link readLedgerTail} reads/writes, one layer below
   *  `scannedLines`' line-level cursor — this is what makes even a full re-scan O(new bytes),
   *  not O(history). */
  ledgerTail: LedgerTailCache;
}

/** Opaque handle a caller holds across requests, mirroring {@link BoardSnapshotCache} — never reconstructed per render. */
export interface RecentActivityCache {
  /** @internal — read/written only by {@link computeRecentActivity}. */
  state: RecentActivityState;
}

export function createRecentActivityCache(): RecentActivityCache {
  return { state: { scannedLines: 0, entries: [], prByRun: new Map(), ledgerTail: createLedgerTailCache() } };
}

function prNumberFromUrl(url: string): number | undefined {
  const n = Number(url.match(/\/pull\/(\d+)/)?.[1]);
  return Number.isFinite(n) ? n : undefined;
}

/** GitHub decoration, never a gate (W1-T184): resolves `prUrl`'s title via the same `prByRef`
 *  every other precedence rung calls. A missing title is silent (the row already renders fine
 *  ledger-only); a gateway reporting `readFailed()` marks the row `githubUnavailable` instead
 *  (W1-T181), so an outage reads as "GitHub unreachable" rather than a merely sparser row. */
function decoratePrTitle(entry: RecentActivityEntry, deps: BoardDeps): RecentActivityEntry {
  if (!entry.prUrl) return entry;
  // Both github calls live inside this one try: this is the one place a GitHub read feeds
  // straight into an HTTP response with no caller-side layer to absorb a surprise throw, so a
  // throw from either call degrades this one row instead of 500ing the whole request.
  try {
    const pr = deps.github.prByRef(entry.prUrl);
    if (pr?.title) return { ...entry, prTitle: pr.title };
    if (deps.github.readFailed?.()) return { ...entry, githubUnavailable: true };
    return entry;
  } catch {
    return { ...entry, githubUnavailable: true };
  }
}

/** Longest refusal reason a RECENT row will carry. See {@link boundedReason}. */
const MAX_REFUSAL_REASON_CHARS = 120;

/** A refusal `reason`, bounded so one row cannot swallow the feed (W1-T266). Truncation is
 *  visible (a trailing ellipsis), never silent — a cut reason must not read as one that was short. */
// Why: the real console.kick_refused reason this bound was sized against — docs/forensics/board.md#boundedreason
function boundedReason(reason: unknown): string {
  if (typeof reason !== "string" || reason === "") return "no reason recorded";
  return reason.length <= MAX_REFUSAL_REASON_CHARS ? reason : `${reason.slice(0, MAX_REFUSAL_REASON_CHARS)}…`;
}

/** The activity feed's own event classification: one ledger line in, at most one
 *  {@link RecentActivityEntry} out. Pure and separate from the stateful scan below, so the
 *  mapping is easy to audit. */
function classifyLine(
  line: Record<string, unknown>,
  taskId: string,
  title: string,
  ts: string,
  prUrl: string | undefined,
): RecentActivityEntry | undefined {
  const prNumber = prUrl ? prNumberFromUrl(prUrl) : undefined;
  const costUsd = typeof line.cost_usd === "number" ? line.cost_usd : undefined;
  const numTurns = typeof line.num_turns === "number" ? line.num_turns : undefined;
  switch (line.step) {
    case "verdict": {
      const verdict = typeof line.verdict === "string" ? line.verdict : "unknown";
      return { taskId, title, ts, verb: verdict === "merged" ? "merged" : "verdict", detail: verdict, costUsd, prUrl, prNumber };
    }
    case "fix.dispatch":
      return { taskId, title, ts, verb: "fix", detail: `dispatched (strike ${String(line.strike ?? "?")})`, prUrl, prNumber };
    case "fix.done":
      return { taskId, title, ts, verb: "fix", detail: `done (strike ${String(line.strike ?? "?")})`, costUsd, numTurns, prUrl, prNumber };
    case "fix.exhausted":
      return { taskId, title, ts, verb: "fix", detail: `exhausted (${String(line.strikes ?? "?")} strikes)`, prUrl, prNumber };
    case "escalation.issue_opened":
      return { taskId, title, ts, verb: "escalated", detail: typeof line.class === "string" ? line.class : undefined, prUrl, prNumber };
    case "implement.done":
      return { taskId, title, ts, verb: "spend", costUsd, numTurns, prUrl, prNumber };
    // W1-T266 — the daemon's resolution of an operator's Run click. See OPERATOR_ACTION_STEPS.
    // The `reason` is carried VERBATIM (bar the length bound below) rather than mapped to
    // friendlier prose: a translation table here would be a second place for the truth to live,
    // and this codebase has had three false comments cause live operator-visible defects in one
    // week. The verb label supplies the plain-English framing ("Run refused"); the reason
    // supplies the fact.
    case "console.kick_refused":
      return { taskId, title, ts, verb: "run-refused", detail: boundedReason(line.reason) };
    case "console.kick_dispatched":
      return { taskId, title, ts, verb: "run-started", detail: "dispatched from the console" };
    default:
      return undefined;
  }
}

/** The RECENT activity feed (W1-T184): classifies only the lines new since
 *  {@link RecentActivityState.scannedLines}, decorates each fresh entry with GitHub once at mint
 *  time, and returns the most recent `max`, newest first. A fully-failing `deps.github` still
 *  returns identical entries, just without `prTitle` (see {@link decoratePrTitle}). */
export function computeRecentActivity(deps: BoardDeps, cache: RecentActivityCache, max = 20): RecentActivityEntry[] {
  const state = cache.state;
  // Two independent tail cursors: readLedgerTail (file I/O layer) reads only new bytes, and
  // state.scannedLines (classification layer) further limits which of those lines get
  // re-classified/re-decorated.
  const readLedger = deps.readLedger ?? ((path: string) => readLedgerTail(path, state.ledgerTail));
  const lines = readLedger(deps.ledgerPath);
  // A shorter ledger than last scanned should never happen (append-only); degrade safely by
  // rescanning from scratch rather than slicing with a negative offset.
  if (lines.length < state.scannedLines) {
    state.scannedLines = 0;
    state.entries = [];
    state.prByRun = new Map();
  }
  const newLines = lines.slice(state.scannedLines);
  state.scannedLines = lines.length;

  for (const line of newLines) {
    const runId = typeof line.run_id === "string" ? line.run_id : undefined;
    if (line.step === "pr.opened" && runId && typeof line.pr_url === "string") {
      state.prByRun.set(runId, line.pr_url);
    }
    // For OPERATOR_ACTION_STEPS the daemon stamps its own pseudo-id ("DAEMON") on `task_id`; the
    // task the human actually clicked is in `line.task` instead (W1-T266).
    const isOperatorAction = typeof line.step === "string" && OPERATOR_ACTION_STEPS.has(line.step);
    const taskId = isOperatorAction && typeof line.task === "string"
      ? line.task
      : typeof line.task_id === "string"
        ? line.task_id
        : undefined;
    if (!taskId) continue;
    const task = deps.plan.byId.get(taskId);
    // A pseudo-id (DAEMON/SWEEP/…) is never a real plan task and its housekeeping volume would
    // bury the feed, so it is dropped — except for the rare operator-action steps above, where a
    // refusal must still render even if the id it names isn't in the plan.
    if (!task && !isOperatorAction) continue;
    const ts = typeof line.ts === "string" ? line.ts : new Date().toISOString();
    const prUrl = typeof line.pr_url === "string" ? line.pr_url : runId ? state.prByRun.get(runId) : undefined;
    const entry = classifyLine(line, taskId, task?.title ?? taskId, ts, prUrl);
    if (!entry) continue;
    state.entries.push(decoratePrTitle(entry, deps));
    if (state.entries.length > RECENT_ACTIVITY_HISTORY_CAP) state.entries.shift();
  }

  return state.entries.slice(-max).reverse();
}

/** GET /v1/recent — the RECENT section's data, read-scoped, one {@link RecentActivityCache} per route instance. */
export function buildRecentRoute(deps: BoardDeps): Route {
  const cache = createRecentActivityCache();
  return {
    method: "GET",
    path: "/v1/recent",
    scope: "read",
    handler: (_req, res) => {
      sendJson(res, 200, { entries: computeRecentActivity(deps, cache) });
    },
  };
}

/** Every distinct `task_id` named on a ledger line, in first-seen order. */
function taskIdsOf(lines: Array<Record<string, unknown>>): string[] {
  const seen = new Set<string>();
  for (const line of lines) {
    if (typeof line.task_id === "string") seen.add(line.task_id);
  }
  return [...seen];
}

/** GET /v1/status/stream — one `status` SSE event per task whose projection changes. Subscribing
 *  primes the line count to the current ledger length, so a client is never replayed history. */
export function buildStatusStream(deps: BoardDeps, pollMs = DEFAULT_POLL_MS): SseRoute {
  return {
    path: "/v1/status/stream",
    scope: "read",
    subscribe: (send: SseSend) => {
      // One persistent tail cursor for this connection's lifetime: an unchanged ledger between
      // ticks costs one statSync, not a full re-read of the file.
      const tail = createLedgerTailCache();
      const readLedger = deps.readLedger ?? ((path: string) => readLedgerTail(path, tail));
      const effectiveDeps: BoardDeps = { ...deps, readLedger };

      // Enrich with live spend/turns (W1-T184), the same way computeBoardSnapshot does, off the
      // same already-read lines: the client's ingestProjection overwrites the previously-known
      // row on every SSE flip, so a payload with no spend fields would silently wipe whatever
      // the last REST poll had shown.
      // Why: the "tonight's burn was invisible" fixture this enrichment fixes —
      // docs/forensics/board.md#buildstatusstream--live-spend-over-sse
      const deriveForStream = (
        task: Task,
        lines: Array<Record<string, unknown>>,
      ): StatusProjection & { liveSpendUsd?: number; liveTurns?: number } => {
        const projection = deriveStatus(task, effectiveDeps);
        if (!projection.phase) return projection;
        const spend = liveRunSpend(lines, task.id);
        return spend ? { ...projection, liveSpendUsd: spend.spendUsd, liveTurns: spend.turns } : projection;
      };

      // Prime lastSent with every task's current projection, not an empty map — otherwise the
      // first ledger line touching a task would always look like a flip, even when it lands on
      // the state the client already has.
      const primingLines = readLedger(deps.ledgerPath);
      let lastLineCount = primingLines.length;
      const lastSent = new Map<string, string>(deps.plan.tasks.map((t) => [t.id, JSON.stringify(deriveForStream(t, primingLines))]));

      const tick = () => {
        const lines = readLedger(deps.ledgerPath);
        if (lines.length <= lastLineCount) return;
        const newLines = lines.slice(lastLineCount);
        lastLineCount = lines.length;

        for (const taskId of taskIdsOf(newLines)) {
          const task = deps.plan.byId.get(taskId);
          if (!task) continue; // a ledger line for a task not (or no longer) in the plan.
          // Re-derive off the FULL `lines` (not just `newLines`) — liveRunSpend needs the
          // task's whole current run, and deriveStatus itself always re-reads the ledger too.
          const projection = deriveForStream(task, lines);
          const serialized = JSON.stringify(projection);
          if (lastSent.get(taskId) === serialized) continue; // no actual flip (incl. spend) — don't spam.
          lastSent.set(taskId, serialized);
          send("status", projection);
        }
      };

      const timer = setInterval(tick, pollMs);
      return () => clearInterval(timer);
    },
  };
}

// ── FIND-layer sort comparators (W1-T157) ──────────────────────────────────────────────────
//
// Pure comparators over BoardRow, one per sortable column. serve.ts's inline console script
// mirrors these for its own client-side sort (it's a template literal and cannot import this
// module), so these exported, unit-tested functions are the canonical spec of the ordering. Each
// takes an explicit direction so "a missing value always sorts last, in both directions" is
// expressed once, here, rather than by a caller reversing the sorted array (which would flip it).

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
