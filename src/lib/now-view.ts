/**
 * The `now?instance=<id>` view (Phase 1 design §3.5; P1-11): everything the console's /now renders,
 * for ONE instance, in one body.
 *
 * - `board`: the board's own `computeBoardSnapshot`, fed the read model's board projection
 *   (P1-10) as its reuse, so every row is the legacy derivation over the fact store's full history
 *   (operator ruling Q1). `groups` precomputes the console's `groupBoard`.
 * - `actions`: blocked PRs and merge holds with a structured `strike`, replacing the console's regex.
 * - `recent` and an exact `mergedToday`.
 * - `health`: the SELECTED instance's own host probes. Today's /now shows core's for every repository.
 * - `decisions`: every open thing the operator answers, each with the route that steers it (now-decisions.ts).
 *
 * GitHub facts come from the legacy gateway's persisted snapshot (ruling Q3), which now carries the
 * open half too, so the view adds no GitHub read of its own.
 *
 * DARK: the view materializes only while `switches.views.now` reads `shadow`, `serve` or `auto`, and no route
 * serves it yet (P1-12 declares the route, P1-14 compares it).
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import {
  computeBoardSnapshot,
  computeRecentActivity,
  createRecentActivityCache,
  type BoardRow,
  isBlockedRow,
  isRunningRow,
  type BoardSnapshot,
  type RecentActivityCache,
} from "./board.js";
import { createBoardProjection, rowsNamingTasksBefore, type BoardProjection, type Row } from "./board-projection.js";
import { boardOpenSnapshotPath, boardSnapshotPath, createBoardSnapshotReader, OPEN_SNAPSHOT_RESAVE_MS, readOpenBoardSnapshot, type SharedBoardSnapshotRows } from "./board-snapshot-cache.js";
import { fixedClock, systemClock, type Clock } from "./clock.js";
import { deriveLastPoll, readDiskFreeBytes, readGhRateLimitRemaining } from "./daemon-health.js";
import { GENERIC_EXIT_CODE, RmdError } from "./errors.js";
import { feedbackDir, listFeedback, type FeedbackEntry } from "./feedback.js";
import { projectHumanGates, type HumanGateObservation, type HumanGateProjection, type HumanGateSource } from "./human-gate.js";
import { LEDGER_FILENAME } from "./ledger-path.js";
import { readTaskActivity } from "./ledger-projector.js";
import { createLedgerRotationMemo, readLedgerUnionRecordsSync, rotationStampIso, type LedgerRotationMemo, type LedgerRotationMemoPass } from "./ledger-union.js";
import {
  capDecisions,
  escalationClasses,
  escalationDecisions,
  grillDecisions,
  questionStorePath,
  readQuestionStore,
  taskQuestionDecisions,
  type NowDecision,
  type QuestionStoreLine,
} from "./now-decisions.js";
import type { BoardIssueRest, BoardPrRest } from "./open-prs-rest.js";
import type { Plan } from "./plan.js";
import type { ReadModelDb, ReadModelLease } from "./read-model-db.js";
import { resolveRepoLayout } from "./repo-layout.js";
import { buildBatchedGithub, readLedgerLines, type BatchedPr, type GitHub } from "./status.js";
import { deriveDayCostUsd, windowCostRows } from "./sweep.js";
import { threadPlan } from "./thread-plan.js";
import { utcDayWindowMs } from "./time-window.js";
import { judgeSource, PLAN_BUDGET_MS } from "./view-freshness.js";
import { legacyRowIndex, type LegacyRows, type ShadowLatest, type ShadowSum } from "./view-shadow.js";
import { effectiveViewMode, type ViewSource, type ViewSwitchMode } from "./views.js";

export const NOW_VIEW_NAME = "now";
export const NOW_VIEW_VERSION = 3;
/** Re-materialize at least this often with no new row: `elapsedMs`, the liveness bound and the 6 h cooldown move with the clock. */
export const NOW_REFRESH_MS = 30_000;
/** The host probes' cadence (design §3.5), per instance. */
export const NOW_HOST_PROBE_MS = 60_000;
/** Queued rows carried in full; every task id is still in `groups`. */
export const NOW_QUEUED_ROWS = 50;
/** The open snapshot is re-saved at least every minute while its gateway runs; three misses make it stale. */
export const NOW_GITHUB_STALE_MS = 3 * OPEN_SNAPSHOT_RESAVE_MS;
/** One build stage slower than the read model's 2.5 s pass is named in `read_model.now_slow_stage`. */
export const NOW_SLOW_STAGE_MS = 2_500;
/** A daemon with no `daemon.*` row for this long reads silent: the console's own health-freshness bound. */
export const NOW_DAEMON_SILENT_MS = 5 * 60_000;
/** A row emitter's declared cadence widens that bound: one late pulse is jitter, two missed ones are silence. */
export const NOW_DAEMON_SILENT_CADENCES = 2;

/** One instance as the worker knows it; `repo`, `planPath` and `feedbackRoot` come from serve's registry resolution. */
export interface NowInstance {
  name: string;
  /** The instance's state dir, holding its live ledger. */
  ledgerDir: string;
  /** `owner/name`: locates the persisted board snapshot and the instance checkout's plan. */
  repo?: string;
  /** Core's plan (serve's own checkout); another instance's is its checkout under `<root>/repos/<name>`. */
  planPath?: string;
  /** Core only: where `plan/feedback/` lives. */
  feedbackRoot?: string;
}

export interface NowTask {
  taskId: string;
  title: string;
  status: string;
  risk: string;
  lastActivityAt?: string;
  prUrl?: string;
  prNumber?: number;
  phase?: string;
  startedAt?: string;
  needsHuman?: true;
  verifyHumanPending?: true;
  escalation?: { title?: string; issueUrl?: string; unverified?: true; openedAt?: string };
  worker?: { servedModel?: string; requestedModel?: string };
}

export interface NowGroups {
  running: string[];
  needsYou: string[];
  blocked: string[];
  queued: string[];
}

export type NowActionTone = "exhausted" | "held" | "blocked" | "unknown" | "repairing";

export interface NowAction {
  kind: "blocked_pr" | "merge_held";
  taskId?: string;
  prNumber?: number;
  prUrl?: string;
  disposition: string;
  reason: string;
  tone: NowActionTone;
  strike?: { n: number; of: number };
  sortAt?: string;
}

/** The daemon's poll liveness: `at` appears only once it went silent, and then stays put until it polls again. */
export type NowDaemonPoll = { state: "polling" } | { state: "silent"; at?: string; reason: string };

export interface NowHealth {
  diskFreeBytes?: number;
  rateLimitRemaining?: number;
  daemon: NowDaemonPoll;
  /** Why a field is absent, per field. */
  reasons?: Record<string, string>;
}

/** One host probe: the gauges `data` carries, plus the sample time the `host-probe:<i>` source carries. */
export interface NowHostProbe {
  sampledAt: string;
  health: NowHealth;
  /** How many rows the probe's live-ledger read returned: until a rotation cuts it the file only grows, so that prefix is what it saw. */
  liveRows?: number;
}

export interface NowViewData {
  instance: string;
  board: {
    counts: { running: number; queued: number; blocked: number };
    spendTodayUsd: number;
    taskProjection: { complete: boolean; returned: number; limit: number; total: number };
    tasks: NowTask[];
    groups: NowGroups;
  };
  prQueue: { complete: boolean; unavailableReason?: string; rows: Array<{ prNumber: number; prUrl: string; title: string; taskId?: string; disposition: string; queueClass: string; held: boolean }> };
  actions: NowAction[];
  recent: { entries: Array<{ ts: string; verb: string; taskId: string; title: string; detail?: string; costUsd?: number; prUrl?: string }>; mergedToday: { count: number; day: string } };
  health: NowHealth;
  decisions: NowDecision[];
  /** How many open decisions past the cap `decisions` leaves out. */
  decisionsMore?: number;
  /** Why a decision source was not read for this instance, by kind; its decisions are then absent, never zero. */
  decisionsReasons?: Partial<Record<"grill" | "task_question", string>>;
  /** Additive decision projection; its counts precede the legacy decisions display cap. */
  humanGates?: HumanGateProjection;
}

/** The `decisions` half of one instance's body. */
export type NowDecisionsData = Pick<NowViewData, "decisions" | "decisionsMore" | "decisionsReasons" | "humanGates">;

function decisionGate(decision: NowDecision): HumanGateObservation {
  const kind = decision.kind === "grill" ? "feedback_grill" : decision.kind;
  const subject = decision.kind === "task_question" ? decision.id : decision.taskId ?? decision.answer.fields.replyTo ?? decision.id;
  return {
    kind, subject, ownerSurface: "inbox", openedAt: decision.askedAt ?? null,
    url: decision.answer.fields.issueUrl ?? null,
    reason: decision.prompt.split("\n").find((line) => line.trim() !== "")?.trim() ?? decision.title,
    resolutionVerb: decision.kind === "manual_approval" ? "approve" : decision.kind === "escalation" ? "mark_handled" : "answer",
  };
}

const RUNNING_STATUSES = new Set(["running", "fixing", "review", "diagnosing"]);

/**
 * Whether the sweep is re-emitting the disposition it already recorded for this PR: each pass writes
 * `sweep.disposed` again, and taking that row's time moved `lastActivityAt`, `sortAt` and so the
 * ETag on every pass with nothing changed (replayed: about 22% of `now`'s changes).
 */
function sweepRepeat(): (row: Row) => boolean {
  const last = new Map<number, unknown>();
  return (row) => {
    if (row.step !== "sweep.disposed" || typeof row.pr_number !== "number") return false;
    const same = last.has(row.pr_number) && last.get(row.pr_number) === row.disposition;
    last.set(row.pr_number, row.disposition);
    return same;
  };
}

/** The time of each task's newest ledger row that changed something: the board's join, less sweep repeats. */
export function changedActivityByTask(rows: ReadonlyArray<Row>): Map<string, string> {
  const repeat = sweepRepeat();
  const out = new Map<string, string>();
  for (const row of rows) {
    if (repeat(row) || typeof row.task_id !== "string" || typeof row.ts !== "string") continue;
    out.set(row.task_id, row.ts);
  }
  return out;
}

function byRecency(tasks: readonly BoardRow[]): BoardRow[] {
  const at = (t: BoardRow): number => {
    const ms = t.lastActivityAt ? Date.parse(t.lastActivityAt) : Number.NaN;
    return Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY;
  };
  return [...tasks].sort((a, b) => at(b) - at(a));
}

/** Which tasks each header count counted, by the same predicates as `summarizeCounts`: a count diff's members. */
export function nowCountMembers(tasks: readonly BoardRow[]): Record<string, string[]> {
  const ids = (predicate: (t: BoardRow) => boolean): string[] => tasks.filter(predicate).map((t) => t.taskId);
  return {
    "board.counts.running": ids(isRunningRow),
    "board.counts.queued": ids((t) => t.status === "queued"),
    "board.counts.blocked": ids(isBlockedRow),
    "board.taskProjection.total": ids(() => true),
  };
}

/** The console's `groupBoard` (app/board.tsx), precomputed: each task lands in exactly one group, in priority order. */
export function groupNowBoard(tasks: readonly BoardRow[]): NowGroups {
  const claimed = new Set<string>();
  const take = (predicate: (t: BoardRow) => boolean): BoardRow[] => {
    const picked = tasks.filter((t) => !claimed.has(t.taskId) && predicate(t));
    for (const t of picked) claimed.add(t.taskId);
    return byRecency(picked);
  };
  const ids = (rows: BoardRow[]): string[] => rows.map((t) => t.taskId);
  const running = ids(take((t) => t.phase != null || RUNNING_STATUSES.has(t.status)));
  const needsYou = ids(take((t) => t.needsHuman === true));
  const blocked = ids(take((t) => t.status === "blocked"));
  const queuedExact = take((t) => t.status === "queued");
  const leftover = byRecency(tasks.filter((t) => !claimed.has(t.taskId)));
  return { running, needsYou, blocked, queued: ids(byRecency([...queuedExact, ...leftover])) };
}

/** A strike count from a sweep reason, in every form sweep writes it (`strike 1/2`, `fix strikes exhausted (3/2)`,
 *  `exhausted: fix strikes 2/2`, `fix budget is exhausted (2/2)`). Parsed once here, so the wire carries numbers. */
export function parseStrike(reason: string): { n: number; of: number } | undefined {
  const match = /strikes?\b[^0-9\n]{0,24}?(\d+)\s*\/\s*(\d+)/i.exec(reason) ?? /exhausted\s*\((\d+)\s*\/\s*(\d+)\)/i.exec(reason);
  return match ? { n: Number(match[1]), of: Number(match[2]) } : undefined;
}

function toneOf(disposition: string, strike: { n: number; of: number } | undefined): NowActionTone {
  const d = disposition.toLowerCase();
  if (d.includes("exhaust") || (strike && strike.n >= strike.of)) return "exhausted";
  if (d.includes("fixable") || (strike && strike.n < strike.of)) return "repairing";
  return "unknown";
}

const ACTION_RANK: Record<NowActionTone, number> = { exhausted: 0, held: 1, blocked: 2, unknown: 3, repairing: 4 };

/** The console's `actionQueueFromStatus`, with the strike and the row's own time as fields. */
export function nowActions(snapshot: Pick<BoardSnapshot, "blockedPrs" | "mergeHeld">, rows: ReadonlyArray<Row>): NowAction[] {
  const disposedAt = new Map<number, string>();
  const heldAt = new Map<number, string>();
  const repeat = sweepRepeat();
  for (const row of rows) {
    if (repeat(row) || typeof row.pr_number !== "number" || typeof row.ts !== "string") continue;
    if (row.step === "sweep.disposed") disposedAt.set(row.pr_number, row.ts);
    else if (row.step === "automerge.hold_engaged") heldAt.set(row.pr_number, row.ts);
  }
  const blocked = snapshot.blockedPrs.map((b): NowAction => {
    const strike = parseStrike(b.reason);
    const sortAt = disposedAt.get(b.prNumber);
    return {
      kind: "blocked_pr", prNumber: b.prNumber, disposition: b.disposition, reason: b.reason, tone: toneOf(b.disposition, strike),
      ...(b.taskId ? { taskId: b.taskId } : {}), ...(b.prUrl ? { prUrl: b.prUrl } : {}), ...(strike ? { strike } : {}), ...(sortAt ? { sortAt } : {}),
    };
  });
  const held = snapshot.mergeHeld.map((h): NowAction => {
    const sortAt = h.prNumber === undefined ? undefined : heldAt.get(h.prNumber);
    return {
      kind: "merge_held", disposition: "merge-held", reason: h.reason, tone: "held",
      ...(h.prNumber !== undefined ? { prNumber: h.prNumber } : {}), ...(h.taskId ? { taskId: h.taskId } : {}), ...(sortAt ? { sortAt } : {}),
    };
  });
  return [...blocked, ...held].sort((a, b) => ACTION_RANK[a.tone] - ACTION_RANK[b.tone]);
}

/** Merges today (UTC), one per task and PR however many rows record it: the recent feed's own rule, over full history. */
export function mergedTodayCount(rows: ReadonlyArray<Row>, plan: Plan, nowMs: number): { count: number; day: string } {
  const day = fixedClock(nowMs).iso().slice(0, 10);
  const prByRun = new Map<string, string>();
  const merges = new Set<string>();
  for (const row of rows) {
    if (row.step === "pr.opened" && typeof row.run_id === "string" && typeof row.pr_url === "string") prByRun.set(row.run_id, row.pr_url);
    const merged = (row.step === "verdict" && row.verdict === "merged") || row.step === "verdict.merged";
    if (!merged || typeof row.ts !== "string" || !row.ts.startsWith(day) || typeof row.task_id !== "string" || !plan.byId.has(row.task_id)) continue;
    const prUrl = typeof row.pr_url === "string" ? row.pr_url : typeof row.run_id === "string" ? prByRun.get(row.run_id) : undefined;
    merges.add(`${row.task_id}|${prUrl ?? ""}`);
  }
  return { count: merges.size, day };
}

function nowTask(row: BoardRow): NowTask {
  const escalation = row.escalationIssueUrl || row.escalationTitle
    ? { ...(row.escalationTitle ? { title: row.escalationTitle } : {}), ...(row.escalationIssueUrl ? { issueUrl: row.escalationIssueUrl } : {}),
        ...(row.escalationUnverified ? { unverified: row.escalationUnverified } : {}), ...(row.escalationOpenedAt ? { openedAt: row.escalationOpenedAt } : {}) }
    : undefined;
  const t = row.workerTelemetry;
  return {
    taskId: row.taskId, title: row.title, status: row.status, risk: row.risk,
    ...(row.lastActivityAt ? { lastActivityAt: row.lastActivityAt } : {}), ...(row.prUrl ? { prUrl: row.prUrl } : {}),
    ...(row.prNumber !== undefined ? { prNumber: row.prNumber } : {}), ...(row.phase ? { phase: row.phase } : {}),
    ...(row.startedAt ? { startedAt: row.startedAt } : {}),
    ...(row.needsHuman ? { needsHuman: row.needsHuman } : {}), ...(row.verifyHumanPending ? { verifyHumanPending: row.verifyHumanPending } : {}),
    ...(escalation ? { escalation } : {}),
    ...(t?.servedModel || t?.requestedModel ? { worker: { ...(t.servedModel ? { servedModel: t.servedModel } : {}), ...(t.requestedModel ? { requestedModel: t.requestedModel } : {}) } } : {}),
  };
}

/** Assembles one instance's body from the board snapshot and its side inputs. Pure. */
export function assembleNowView(input: {
  instance: string;
  snapshot: BoardSnapshot;
  rows: ReadonlyArray<Row>;
  plan: Plan;
  recent: ReturnType<typeof computeRecentActivity>;
  health: NowHealth;
  decisions: NowDecisionsData;
  nowMs: number;
}): NowViewData {
  const { snapshot } = input;
  const groups = groupNowBoard(snapshot.tasks);
  const shown = new Set([...groups.running, ...groups.needsYou, ...groups.blocked, ...groups.queued.slice(0, NOW_QUEUED_ROWS)]);
  const activity = changedActivityByTask(input.rows);
  const tasks = byRecency(snapshot.tasks.filter((t) => shown.has(t.taskId)).map((t) => {
    const row: BoardRow = { ...t };
    const at = activity.get(t.taskId);
    if (at) row.lastActivityAt = at;
    else delete row.lastActivityAt;
    return row;
  })).map(nowTask);
  return {
    instance: input.instance,
    board: {
      counts: { running: snapshot.counts.running, queued: snapshot.counts.queued, blocked: snapshot.counts.blocked },
      spendTodayUsd: snapshot.spend.spendTodayUsd,
      taskProjection: { complete: tasks.length === snapshot.tasks.length, returned: tasks.length, limit: NOW_QUEUED_ROWS, total: snapshot.tasks.length },
      tasks,
      groups,
    },
    prQueue: {
      complete: snapshot.prQueue.complete,
      ...(snapshot.prQueue.unavailableReason ? { unavailableReason: snapshot.prQueue.unavailableReason } : {}),
      rows: snapshot.prQueue.rows.map((r) => ({ prNumber: r.prNumber, prUrl: r.prUrl, title: r.title, ...(r.taskId ? { taskId: r.taskId } : {}), disposition: r.disposition, queueClass: r.queueClass, held: r.held })),
    },
    actions: nowActions(snapshot, input.rows),
    recent: {
      entries: input.recent.map((e) => ({ ts: e.ts, verb: e.verb, taskId: e.taskId, title: e.title, ...(e.detail ? { detail: e.detail } : {}), ...(e.costUsd !== undefined ? { costUsd: e.costUsd } : {}), ...(e.prUrl ? { prUrl: e.prUrl } : {}) })),
      mergedToday: mergedTodayCount(input.rows, input.plan, input.nowMs),
    },
    health: input.health,
    ...input.decisions,
  };
}

export type NowShadowClassification = "legacy_horizon" | "bug";

/**
 * Where the view's board groups differ from the legacy /v1/status board's (the live file only). A task named
 * by a row older than the legacy horizon is `legacy_horizon` (operator ruling Q1); any other difference is a `bug`.
 */
export function nowBoardShadowDiff(
  view: Pick<NowViewData, "board">,
  legacy: Pick<BoardSnapshot, "tasks">,
  rows: ReadonlyArray<Row>,
  legacyHorizonTsMs: number,
): Array<{ taskId: string; view: string; legacy: string; classification: NowShadowClassification }> {
  const groupOf = (groups: NowGroups): Map<string, string> => {
    const out = new Map<string, string>();
    for (const [name, ids] of Object.entries(groups)) for (const id of ids) out.set(id, name);
    return out;
  };
  const mine = groupOf(view.board.groups);
  const theirs = groupOf(groupNowBoard(legacy.tasks));
  const older = rowsNamingTasksBefore(rows, legacyHorizonTsMs);
  const out: Array<{ taskId: string; view: string; legacy: string; classification: NowShadowClassification }> = [];
  for (const id of [...new Set([...mine.keys(), ...theirs.keys()])].sort()) {
    const a = mine.get(id) ?? "absent";
    const b = theirs.get(id) ?? "absent";
    if (a !== b) out.push({ taskId: id, view: a, legacy: b, classification: older.has(id) ? "legacy_horizon" : "bug" });
  }
  return out;
}

class NowViewError extends RmdError {
  constructor(message: string) {
    super("read-model", GENERIC_EXIT_CODE, message);
  }
}

function mtimeOf(path: string): number | undefined {
  try {
    return statSync(path).mtimeMs;
  } catch (error) {
    // deliberate: an absent file reads as "never written", which the caller reports as a stale source.
    void error;
    return undefined;
  }
}

const NO_PACER = { wait(): void {}, recordResult(): void {} };

/** A task's newest `panel.question_answered` fact time, by its task index: the route ledgers one even when its store write failed. */
function answeredByFact(db: ReadModelDb): (taskId: string) => string | undefined {
  const query = db.prepare("SELECT max(ts) AS ts FROM fact WHERE task_id = ? AND step = 'panel.question_answered'");
  return (taskId) => {
    const ts = query.get(taskId)?.ts;
    return typeof ts === "string" ? ts : undefined;
  };
}

const asBatched = (r: BoardPrRest): BatchedPr => ({ number: r.number, url: r.url, state: r.state, headRefName: r.headRefName, headRefOid: r.headRefOid, body: r.body, autoMergeRequest: r.autoMergeRequest, title: r.title });

/** What one parse of the closed/issues snapshot yields for a gateway, and the newest gateway built over it. */
interface ClosedHalf {
  closed: BatchedPr[];
  issues: BoardIssueRest[];
  present: boolean;
  digest: string;
  gateway?: { key: string; github: GitHub };
}

const sharedBoardSnapshots = createBoardSnapshotReader();
const closedHalves = new WeakMap<SharedBoardSnapshotRows, ClosedHalf>();

function closedHalfOf(rows: SharedBoardSnapshotRows): ClosedHalf {
  const hit = closedHalves.get(rows);
  if (hit) return hit;
  const closed = [...(rows.closed?.values() ?? [])].map(asBatched);
  const issues = [...(rows.issues?.values() ?? [])];
  const hash = createHash("sha1");
  for (const row of closed) hash.update(`${JSON.stringify(row)}\n`);
  hash.update("issues\n");
  for (const row of issues) hash.update(`${JSON.stringify(row)}\n`);
  const half: ClosedHalf = { closed, issues, present: rows.closed !== undefined, digest: hash.digest("hex") };
  closedHalves.set(rows, half);
  return half;
}

/**
 * A gateway over the legacy gateway's persisted snapshot (ruling Q3): open PRs, closed PRs and issues, no GitHub read.
 * `generation` is the files' mtimes, which move on every re-save; `content` moves only when what they hold does.
 * The closed/issues file is parsed once per change and shared ({@link createBoardSnapshotReader}), and so is the
 * gateway while `content` holds: the open half's 60 s re-save rebuilt both on every build (E33).
 */
export function snapshotGithub(
  root: string, owner: string, repo: string, clock: Clock = systemClock,
  opts: { refuseIncomplete?: boolean; read?: (root: string, owner: string, repo: string) => SharedBoardSnapshotRows } = {},
): { github: GitHub; generation: string; content?: string; source: Omit<ViewSource, "name">; unavailable?: string } {
  const half = closedHalfOf((opts.read ?? sharedBoardSnapshots)(root, owner, repo));
  const open = readOpenBoardSnapshot(root, owner, repo);
  const openRows = open.ok ? open.snapshot.rows.map(asBatched) : [];
  // An incomplete snapshot read as complete would say no PR ever merged; refused, the gateway reads failed instead.
  const unavailable = !opts.refuseIncomplete ? undefined : !open.ok ? open.reason : half.present ? undefined : "the board snapshot holds no closed pull requests";
  const content = createHash("sha1").update(`${JSON.stringify(openRows)}\n${half.digest}`).digest("hex").slice(0, 16);
  const key = `${owner}/${repo}\n${content}\n${unavailable ?? ""}`;
  if (half.gateway?.key !== key) {
    const openNumbers = new Set(openRows.map((r) => r.number));
    const all = [...openRows, ...half.closed.filter((r) => !openNumbers.has(r.number))];
    const github = buildBatchedGithub(owner, repo, {
      ttlMs: Number.MAX_SAFE_INTEGER, pacer: NO_PACER,
      fetchAll: () => {
        if (unavailable !== undefined) throw new NowViewError(`github snapshot unavailable: ${unavailable}`);
        return all;
      },
      fetchAllIssues: () => half.issues.map((i) => ({ number: i.number, url: i.url, state: i.state, ...(i.title ? { title: i.title } : {}) })),
      exec: () => {
        throw new NowViewError("a snapshot gateway reads GitHub from the persisted snapshot only");
      },
    });
    half.gateway = { key, github };
  }
  const source = unavailable !== undefined ? { asOf: null, state: "unavailable" as const, reason: unavailable } : snapshotSource(open.ok ? open.snapshot.savedAt : null, open.ok ? undefined : open.reason, clock.now());
  return { github: half.gateway.github, generation: snapshotGeneration(root, owner, repo), content, source, ...(unavailable !== undefined ? { unavailable } : {}) };
}

/** A plan file's identity: its own mtime and its `tasks.d`'s. */
export function planStamp(path: string): string {
  return `${mtimeOf(path) ?? "-"}:${mtimeOf(join(dirname(path), "tasks.d")) ?? "-"}`;
}

/** The persisted snapshot's source, judged at `nowMs` from when its open half was last saved, or why it is unreadable. */
export function snapshotSource(savedAt: string | null, reason: string | undefined, nowMs: number): Omit<ViewSource, "name"> {
  if (savedAt === null) return { asOf: null, state: "stale", reason };
  const ageMs = nowMs - Date.parse(savedAt);
  return ageMs > NOW_GITHUB_STALE_MS ? { asOf: savedAt, state: "stale", reason: `open pull requests last saved ${Math.round(ageMs / 1000)} s ago` } : { asOf: savedAt, state: "fresh" };
}

export function snapshotGeneration(root: string, owner: string, repo: string): string {
  return `${mtimeOf(boardSnapshotPath(root, owner, repo)) ?? "-"}:${mtimeOf(boardOpenSnapshotPath(root, owner, repo)) ?? "-"}`;
}

export interface NowViewOptions {
  instances: readonly NowInstance[];
  /** Defaults to the first instance (serve's own). */
  coreInstance?: string;
  /** The worker's `ledger:<i>` source judge; omitted, the body carries no ledger source. */
  ledgerSource?: (state: NowSlotState, now: number) => ViewSource;
  clock?: Clock;
  log?: (step: string, extra: Record<string, unknown>) => void;
  readPlan?: (instance: NowInstance) => Plan;
  github?: (instance: NowInstance) => ReturnType<typeof snapshotGithub>;
  /** Under the default `github`: the thread's shared, parse-once-per-change reader of the closed/issues snapshot. */
  readBoardSnapshot?: (root: string, owner: string, repo: string) => SharedBoardSnapshotRows;
  /** Seams under {@link defaultProbeHost}; production reads statfs, the live ledger and `gh api rate_limit`. */
  hostProbe?: {
    readLive?: (path: string) => ReadonlyArray<Record<string, unknown>>;
    rateLimit?: () => number | undefined;
    diskFree?: (path: string) => number | undefined;
  };
  /** Core's feedback entries parked `grilling`; `listFeedback` over its `feedbackRoot` by default. */
  listGrilling?: (instance: NowInstance) => FeedbackEntry[];
  /** How far each instance's checkout is behind origin/main's plan; production reads git ({@link gitPlanBehind}). */
  planBehind?: (instance: NowInstance) => PlanBehind;
}

/** How many plan-touching commits on origin/main a checkout lacks, and the oldest one's time; or why that is unknowable. */
export type PlanBehind = { commits: number; sinceMs?: number } | { reason: string };

/**
 * Compares a plan's checkout with its origin/main. The commit log is read only when the pair of
 * heads moved since `memo` last saw them, so a materialize costs one `git rev-parse` per instance.
 */
export function gitPlanBehind(
  planPath: string,
  memo: { heads?: string; result?: PlanBehind } = {},
  git: (args: string[]) => string = (args) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }),
): PlanBehind {
  const dir = dirname(dirname(planPath));
  try {
    const heads = git(["-C", dir, "rev-parse", "HEAD", "origin/main"]).trim();
    if (memo.heads === heads && memo.result) return memo.result;
    const [head, main] = heads.split("\n");
    const paths = [relative(dir, planPath), relative(dir, join(dirname(planPath), "tasks.d"))];
    const times = head === main ? [] : git(["-C", dir, "log", "--format=%ct", `${head}..${main}`, "--", ...paths]).split("\n").filter(Boolean).map(Number);
    const result: PlanBehind = times.length === 0 ? { commits: 0 } : { commits: times.length, sinceMs: Math.min(...times) * 1000 };
    Object.assign(memo, { heads, result });
    return result;
  } catch (error) {
    return { reason: `cannot compare the plan's checkout with origin/main: ${String((error as Error).message).split("\n")[0]}` };
  }
}

/**
 * The `plan:<i>` source. A checkout as new as origin/main's plan is fresh as of now; one behind it is
 * as old as the oldest plan commit it lacks, which the budget table judges, so a checkout behind for
 * longer than {@link PLAN_BUDGET_MS} reads stale, phase `behind`.
 */
export function planSource(name: string, behind: PlanBehind, now: number): ViewSource {
  if ("reason" in behind) return judgeSource({ name, asOf: null, state: "unavailable", reason: behind.reason }, now);
  if (behind.sinceMs === undefined) return judgeSource({ name, asOf: fixedClock(now).iso(), state: "fresh" }, now);
  const reason = `plan ${behind.commits} merge${behind.commits === 1 ? "" : "s"} behind origin/main`;
  const judged = judgeSource({ name, asOf: fixedClock(behind.sinceMs).iso(), state: "fresh" }, now);
  return judged.state === "fresh" ? judged : { ...judged, reason };
}

/** The slice of the worker's per-instance state this view reads (structurally the worker's `ReadModelInstanceState`). */
export interface NowSlotState {
  instance: string;
  generation: number;
  lease: "held" | "elsewhere" | "none";
  failures: number;
  tickedAt?: number;
  newestTs: string | null;
  reason?: string;
}

export interface NowViewContext {
  now: number;
  /** `lease`: the writer lease the board projection persists behind; absent, it lives in memory only. */
  instances: ReadonlyArray<{ state: NowSlotState; db?: ReadModelDb; lease?: ReadModelLease }>;
  switches?: { views: Record<string, ViewSwitchMode> };
}

/** The instance checkout's plan: core's is serve's own; another's is its managed clone under `<root>/repos/<name>`. */
export function nowPlanPath(instance: NowInstance): string | undefined {
  if (instance.planPath) return instance.planPath;
  const name = instance.repo?.split("/")[1];
  return name ? resolveRepoLayout(join(dirname(instance.ledgerDir), "repos", name)).planMonolith : undefined;
}

interface Held {
  db: ReadModelDb;
  board: BoardProjection;
  recent: RecentActivityCache;
  generation: number;
  planKey: string;
  githubKey: string;
  gateway: ReturnType<typeof snapshotGithub>;
  at: number;
  probe?: NowHostProbe;
  healthAt: number;
  decisionsKey: string;
}

/** What one assembled body was built from, so the shadow's legacy side reads that body's inputs and not a later build's. */
interface Shown {
  plan: Plan;
  planKey: string;
  gateway: ReturnType<typeof snapshotGithub>;
  probe: NowHostProbe;
  /** When the build began: a rotation cut after it moved rows the live file then held. */
  builtMs: number;
  members: Record<string, string[]>;
  /** The rows the body's `spendTodayUsd` added. */
  spend: Array<[string, number]>;
  /** Each task's time the body's groups sorted it by. */
  sortedBy: Map<string, string | undefined>;
  /** Each queued pull request's `sweep.disposed` row the body's disposition came from. */
  disposedAt: Map<number, string | undefined>;
  /** The credit store and overrides the board projection read: files, so legacy replays them rather than reading later ones. */
  credit: ReturnType<BoardProjection["creditRead"]>;
}

/** The day's cost rows `computeGlanceSpend` adds into `spendTodayUsd`. */
const dayCostRows = (rows: ReadonlyArray<Record<string, unknown>>, nowMs: number): Array<[string, number]> => windowCostRows(rows, ...utcDayWindowMs(nowMs));

/** The legacy side of one shadow sample (view-shadow.ts): what /now shows today, in the view's shape. */
export interface NowShadowLegacy {
  data: NowViewData;
  asOfMs: number;
  /** The live file's oldest row: GET /v1/status sees nothing older (ruling Q1's legacy horizon). */
  horizonMs?: number;
  members: Record<string, { legacy: string[]; view: string[] }>;
  sums: Record<string, ShadowSum>;
  /** The task window's paths, computed only from the board groups. */
  derived: Record<string, string[]>;
  rows: LegacyRows;
  sortKeys: Record<string, Record<string, ShadowLatest>>;
  from: Record<string, ShadowLatest>;
  inputs: { plan: string; probeAt: string; builtAt: string; windows: Record<"board" | "probe" | "spend", LegacyWindowRead> };
}

/**
 * How far before its build legacy's board and PR queue read rotations. A disposition is decided by each
 * pull request's newest `sweep.disposed`, and rotation archives every unacted one while keeping an older
 * acted one live (PR #8495, 23:36Z). MEASURED on core 2026-10-02: the gap between one PR's rows is p50
 * 7.8 min and p90 47 min; an hour is 9 rotations, 2.7 MB, 3,055 rows. An older row is legacy_horizon.
 */
export const NOW_LEGACY_ROW_WINDOW_MS = 60 * 60_000;

/** What one window of legacy's read covered: from when, the rotations it opened, and any it could not read. */
export interface LegacyWindowRead {
  from: string;
  rotations: string[];
  unread: string[];
}

const UNOPENED = { rows: [], torn: 0, tornLines: [] };

/**
 * Every row the live file held at some instant in `[fromMs, toMs]`, stamped no later than `toMs`, each once
 * and in time order. A rotation holds only rows the live file held until its cut, so the live file and the
 * rotations cut after `fromMs` are that set; an earlier one is not opened. Rows are deduped by their exact
 * line, as the projector keys them, so a row in both rotation forms counts once.
 */
function ledgerRowsOver(ledgerDir: string, window: { fromMs: number; toMs: number }, live: ReadonlyArray<Row>, memo: LedgerRotationMemoPass): { rows: Row[]; read: LegacyWindowRead } {
  const rotations: string[] = [];
  const union = readLedgerUnionRecordsSync(ledgerDir, {
    readLiveRecords: () => live,
    rotationRecords: (entry, parse) => {
      if (Date.parse(rotationStampIso(basename(entry.path)) ?? "") <= window.fromMs) return UNOPENED;
      rotations.push(basename(entry.path));
      return memo.rotationRecords(entry, parse);
    },
  });
  const at = (row: Row): string => (typeof row.ts === "string" ? row.ts : "");
  const rows = (union.rows as Row[]).filter((row) => !(Date.parse(at(row)) > window.toMs)).sort((a, b) => (at(a) < at(b) ? -1 : at(a) > at(b) ? 1 : 0));
  return { rows, read: { from: fixedClock(window.fromMs).iso(), rotations, unread: union.unread.map((path) => basename(path)) } };
}

/** The `now` view as the read-model worker materializes it: one body per instance, keyed `instance=<name>`. */
export function createNowView(opts: NowViewOptions): {
  name: string;
  version: number;
  materialize(ctx: NowViewContext): Array<{ key: string; data: NowViewData; sources: ViewSource[] }>;
  prepare(ctx: NowViewContext, more: () => boolean): boolean;
  legacy(key: string, now: number, view: unknown): NowShadowLegacy | undefined;
  perInstance: true;
} {
  const clock = opts.clock ?? systemClock;
  const log = opts.log ?? (() => {});
  const core = opts.coreInstance ?? opts.instances[0]?.name;
  const byName = new Map(opts.instances.map((i) => [i.name, i]));
  const held = new Map<string, Held>();
  /** Keyed by the very `data` object a body published: a build in flight advances `held`, never a published body's inputs. */
  const shown = new WeakMap<NowViewData, Shown>();
  /** Per instance, the rotations legacy's windows read, each parsed once: a sample reads only the live file and any new cut. */
  const legacyMemos = new Map<string, { rows: LedgerRotationMemo; costs: LedgerRotationMemo }>();
  const planCache = new Map<string, { key: string; plan: Plan }>();
  const readPlan = opts.readPlan ?? ((instance: NowInstance): Plan => {
    const path = nowPlanPath(instance);
    if (!path) throw new NowViewError(`instance ${instance.name} names no repository, so it has no plan`);
    return threadPlan(path);
  });
  const planKey = (instance: NowInstance): string => {
    const path = nowPlanPath(instance);
    return path ? planStamp(path) : "none";
  };
  const github = opts.github ?? ((instance: NowInstance) => {
    const [owner, repo] = (instance.repo ?? "/").split("/");
    return snapshotGithub(dirname(instance.ledgerDir), owner!, repo!, clock, opts.readBoardSnapshot ? { read: opts.readBoardSnapshot } : {});
  });
  const githubKey = (instance: NowInstance): string => {
    if (opts.github) return "injected";
    const [owner, repo] = (instance.repo ?? "/").split("/");
    return snapshotGeneration(dirname(instance.ledgerDir), owner!, repo!);
  };
  const probeHost = (instance: NowInstance, isCore: boolean): NowHostProbe => defaultProbeHost(instance, isCore, clock, opts.hostProbe);
  const listGrilling = opts.listGrilling ?? ((instance: NowInstance) => listFeedback(instance.feedbackRoot!, { status: "grilling" }));
  /** Core's feedback dir and question store, so an answer landing in either re-materializes at once. */
  const decisionsKey = (instance: NowInstance): string =>
    instance.name === core && instance.feedbackRoot ? `${mtimeOf(feedbackDir(instance.feedbackRoot)) ?? "-"}:${mtimeOf(questionStorePath(instance.feedbackRoot)) ?? "-"}` : "none";
  /** One instance's open decisions: grill and task questions from core's stores, escalations from its own board. */
  const decisionsOf = (instance: NowInstance, db: ReadModelDb, snapshot: BoardSnapshot, rows: ReadonlyArray<Row>): NowDecisionsData => {
    const reasons: NonNullable<NowViewData["decisionsReasons"]> = {};
    const all = escalationDecisions(instance.name, snapshot.tasks, escalationClasses(rows), instance.name === core);
    if (instance.name !== core) {
      reasons.grill = "feedback questions live in core only";
      reasons.task_question = "the question store core answers is core's own";
    } else if (!instance.feedbackRoot) {
      reasons.grill = reasons.task_question = "no feedback root is configured";
    } else {
      all.push(...grillDecisions(instance.name, listGrilling(instance)));
      const store = readQuestionStore(instance.feedbackRoot);
      if ("reason" in store) reasons.task_question = store.reason;
      else all.push(...taskQuestionDecisions(instance.name, store.lines as QuestionStoreLine[], answeredByFact(db), snapshot.tasks));
    }
    const escalationUnknown = snapshot.github_unreachable || !snapshot.prQueue.complete || snapshot.tasks.some((task) => task.escalationUnverified);
    const sources: HumanGateSource[] = [{
      name: "escalations", instance: instance.name, state: escalationUnknown ? "partial" : "complete",
      ...(escalationUnknown ? { reason: "GitHub escalation state could not be completely verified" } : {}),
      gates: all.filter((decision) => decision.kind === "escalation" || decision.kind === "manual_approval").map(decisionGate),
    }];
    if (instance.name === core) {
      sources.push({ name: "feedback-grills", instance: instance.name,
        state: reasons.grill ? "unavailable" : "complete", ...(reasons.grill ? { reason: reasons.grill } : {}),
        gates: all.filter((decision) => decision.kind === "grill").map(decisionGate) });
      // The legacy question reader skips malformed lines without attesting complete coverage.
      sources.push({ name: "task-questions", instance: instance.name, state: reasons.task_question ? "unavailable" : "partial",
        reason: reasons.task_question ?? "the question reader does not report malformed-line completeness",
        gates: all.filter((decision) => decision.kind === "task_question").map(decisionGate) });
    }
    const humanGates = projectHumanGates(sources);
    return { ...capDecisions(all), humanGates, ...(Object.keys(reasons).length > 0 ? { decisionsReasons: reasons } : {}) };
  };
  const behindMemo = new Map<string, { heads?: string; result?: PlanBehind }>();
  const planBehind = opts.planBehind ?? ((instance: NowInstance): PlanBehind => {
    const path = nowPlanPath(instance);
    if (!path) return { reason: `instance ${instance.name} names no repository, so it has no plan` };
    const memo = behindMemo.get(instance.name) ?? {};
    behindMemo.set(instance.name, memo);
    return gitPlanBehind(path, memo);
  });

  /** One instance's build in flight: each stage is one prepare step, and its partial state waits here across ticks. */
  interface NowBuild {
    db: ReadModelDb;
    lease?: ReadModelLease;
    state: NowSlotState;
    now: number;
    stage: number;
    keys: { plan: string; github: string; decisions: string };
    plan?: Plan;
    gateway?: ReturnType<typeof snapshotGithub>;
    h?: Held;
    rows?: ReadonlyArray<Row>;
    snapshot?: BoardSnapshot;
    decisions?: NowDecisionsData;
    body?: { key: string; data: NowViewData; sources: ViewSource[] };
  }
  const builds = new Map<string, NowBuild>();
  const ledgerPathOf = (instance: NowInstance): string => join(instance.ledgerDir, LEDGER_FILENAME);
  const depsOf = (instance: NowInstance, b: NowBuild) => ({
    plan: b.plan!, ledgerPath: ledgerPathOf(instance), github: b.gateway!.github, readLedger: () => b.rows as Array<Record<string, unknown>>, now: () => clock.now(),
  });
  /** The stages of one build, in order; the plan parse (about 1 s on core) is a stage of its own. */
  const STAGES: ReadonlyArray<[string, (instance: NowInstance, b: NowBuild) => void]> = [
    ["plan", (instance, b) => {
      const cachedPlan = planCache.get(instance.name);
      b.plan = cachedPlan?.key === b.keys.plan ? cachedPlan.plan : readPlan(instance);
      planCache.set(instance.name, { key: b.keys.plan, plan: b.plan });
    }],
    ["github", (instance, b) => {
      const h = held.get(instance.name);
      b.gateway = h && h.db === b.db && h.githubKey === b.keys.github ? h.gateway : github(instance);
    }],
    ["board", (instance, b) => {
      const name = instance.name;
      let h = held.get(name);
      // One projection per store, kept across snapshot re-saves: the gateway is swapped in and only a
      // change in what the snapshot holds restamps every task. Behind the lease it persists, so a restart reuses it.
      if (!h || h.db !== b.db) {
        const board = createBoardProjection({
          db: b.db, ...(b.lease ? { lease: b.lease } : {}), ledgerPath: ledgerPathOf(instance), readPlan: () => planCache.get(name)!.plan, clock, instance: name,
          // The held gateway, read per derive: a value here pinned the store's first gateway and its snapshot for the store's life (E33).
          get github() { return held.get(name)!.gateway.github; },
          githubGeneration: () => { const g = held.get(name)!; return g.gateway.content ?? g.githubKey; },
          log: (step, extra) => log(step, { instance: name, ...extra }),
        });
        h = { db: b.db, board, recent: createRecentActivityCache(), generation: -1, planKey: b.keys.plan, githubKey: b.keys.github, gateway: b.gateway!, at: b.now, healthAt: Number.NEGATIVE_INFINITY, decisionsKey: b.keys.decisions };
        held.set(name, h);
      }
      Object.assign(h, { githubKey: b.keys.github, gateway: b.gateway });
      h.board.update({ force: true });
      b.h = h;
      b.rows = h.board.rows();
    }],
    ["snapshot", (instance, b) => {
      const projections = b.h!.board.projections();
      b.snapshot = computeBoardSnapshot(depsOf(instance, b), { reuseProjection: (task) => projections.get(task.id) });
      // The fact store keeps only the steps a reader decides on; a task's newest row of any step is legacy's sort time.
      const activity = readTaskActivity(b.db);
      for (const t of b.snapshot.tasks) {
        const at = activity.get(t.taskId);
        if (at) t.lastActivityAt = at;
      }
    }],
    ["probe", (instance, b) => {
      const h = b.h!;
      if (h.probe && b.now - h.healthAt < NOW_HOST_PROBE_MS) return;
      h.probe = probeHost(instance, instance.name === core);
      h.healthAt = b.now;
    }],
    ["decisions", (instance, b) => void (b.decisions = decisionsOf(instance, b.db, b.snapshot!, b.rows!))],
    ["assemble", (instance, b) => {
      const { h, snapshot, rows, now, state } = b as Required<NowBuild>;
      const data = assembleNowView({ instance: instance.name, snapshot, rows, plan: b.plan!, recent: computeRecentActivity(depsOf(instance, b), h.recent, 20), health: h.probe!.health, decisions: b.decisions!, nowMs: now });
      Object.assign(h, { generation: state.generation, planKey: b.keys.plan, at: now, decisionsKey: b.keys.decisions });
      shown.set(data, { plan: b.plan!, planKey: b.keys.plan, gateway: b.gateway!, probe: h.probe!, builtMs: now, members: nowCountMembers(snapshot.tasks), spend: dayCostRows(rows, now),
        sortedBy: new Map(snapshot.tasks.map((t) => [t.taskId, t.lastActivityAt])), disposedAt: new Map(snapshot.prQueue.rows.map((r) => [r.prNumber, r.observedAt])), credit: h.board.creditRead() });
      const sources: ViewSource[] = [
        ...(opts.ledgerSource ? [opts.ledgerSource(state, now)] : []),
        judgeSource({ name: `github:${instance.name}`, ...b.gateway!.source }, now),
        planSource(`plan:${instance.name}`, planBehind(instance), now),
        judgeSource({ name: `host-probe:${instance.name}`, asOf: h.probe!.sampledAt, state: "fresh" }, now),
      ];
      b.body = { key: `instance=${encodeURIComponent(instance.name)}`, data, sources };
    }],
  ];

  /**
   * Advances one instance's build while `more()` allows, starting one only when it is due. True once
   * there is nothing left to do for it: its body is ready, or no build was due.
   */
  function step(instance: NowInstance, entry: { state: NowSlotState; db: ReadModelDb; lease?: ReadModelLease }, now: number, more: () => boolean): boolean {
    let b = builds.get(instance.name);
    if (b && b.db !== entry.db) b = undefined;
    if (!b) {
      const keys = { plan: planKey(instance), github: githubKey(instance), decisions: decisionsKey(instance) };
      const h = held.get(instance.name);
      const due = !h || h.db !== entry.db || h.generation !== entry.state.generation || h.planKey !== keys.plan || h.githubKey !== keys.github
        || h.decisionsKey !== keys.decisions || now - h.at >= NOW_REFRESH_MS;
      if (!due) return true;
      b = { db: entry.db, ...(entry.lease ? { lease: entry.lease } : {}), state: entry.state, now, stage: 0, keys };
      builds.set(instance.name, b);
    }
    while (b.stage < STAGES.length) {
      if (!more()) return false;
      const [stage, run] = STAGES[b.stage]!;
      const started = clock.now();
      run(instance, b);
      const ms = clock.now() - started;
      if (ms > NOW_SLOW_STAGE_MS) log("read_model.now_slow_stage", { instance: instance.name, stage, ms });
      b.stage++;
    }
    return true;
  }

  /** Each held instance this view builds for, with its store; a step that throws drops that build and is logged. */
  function eachInstance(ctx: NowViewContext, run: (instance: NowInstance, entry: { state: NowSlotState; db: ReadModelDb; lease?: ReadModelLease }) => void): void {
    const mode = effectiveViewMode(ctx.switches?.views[NOW_VIEW_NAME], undefined);
    if (mode !== "shadow" && mode !== "serve") return;
    for (const { state, db, lease } of ctx.instances) {
      const instance = byName.get(state.instance);
      if (!instance || !db || state.lease !== "held") continue;
      try {
        run(instance, { state, db, ...(lease ? { lease } : {}) });
      } catch (error) {
        builds.delete(instance.name);
        log("read_model.now_view_failed", { instance: state.instance, error: (error as Error).message });
      }
    }
  }

  return {
    name: NOW_VIEW_NAME,
    version: NOW_VIEW_VERSION,
    perInstance: true,
    /**
     * The shadow comparator's legacy side for one key, over the plan, GitHub snapshot and probe the compared
     * body was built from: GET /v1/status's board and PR queue over the rows the instance's live file held in
     * the hour before the build, its day's spend over the day's, and a host probe AT THE VIEW'S PROBE TIME over
     * the rows the live file held then ({@link ledgerRowsOver}). The gauges are the ones that probe captured: a
     * comparison makes no `gh` or statfs call of its own. Actions, recent and decisions have
     * no separate legacy computation and are carried from the view. The task window is derived from the
     * groups, the day's spend is paired row by row, and the rows read go along as evidence.
     */
    legacy(key, now, view) {
      const name = decodeURIComponent(key.replace(/^instance=/, ""));
      const instance = byName.get(name);
      const mine = view as NowViewData;
      const built = shown.get(mine);
      if (!instance || !built || !key.startsWith("instance=")) return undefined;
      const ledgerPath = join(instance.ledgerDir, LEDGER_FILENAME);
      const probeMs = Date.parse(built.probe.sampledAt);
      const memo = legacyMemos.get(name) ?? legacyMemos.set(name, { rows: createLedgerRotationMemo((r) => r), costs: createLedgerRotationMemo((r) => r.filter((row) => typeof row.cost_usd === "number")) }).get(name)!;
      const [rowsPass, costsPass] = [memo.rows.pass({ parseMissing: true }), memo.costs.pass({ parseMissing: true })];
      const live = readLedgerLines(ledgerPath);
      // Each computation reads the rows the live file held over the window it evaluates, up to the body's build.
      const board = ledgerRowsOver(instance.ledgerDir, { fromMs: built.builtMs - NOW_LEGACY_ROW_WINDOW_MS, toMs: built.builtMs }, live, rowsPass);
      const probeLive = opts.hostProbe?.readLive?.(ledgerPath) ?? live;
      const probed = ledgerRowsOver(instance.ledgerDir, { fromMs: probeMs, toMs: probeMs }, probeLive, rowsPass);
      // A row appended after the probe's read can carry an earlier stamp (a pulse stamped to the second, 2026-10-02 05:32Z site),
      // so with no cut since, legacy reads the very prefix the probe read rather than the rows stamped by its instant.
      const probeRows = probed.read.rotations.length === 0 && built.probe.liveRows !== undefined ? probeLive.slice(0, built.probe.liveRows) : probed.rows;
      const spent = ledgerRowsOver(instance.ledgerDir, { fromMs: utcDayWindowMs(built.builtMs)[0], toMs: built.builtMs }, live, costsPass);
      rowsPass.complete();
      costsPass.complete();
      const rows = board.rows;
      const deps = { plan: built.plan, ledgerPath, github: built.gateway.github, readLedger: () => rows, now: () => now,
        readCreditStore: () => built.credit.credit, readCreditOverrideFile: () => built.credit.overrides };
      const snapshot = computeBoardSnapshot(deps);
      const decisions: NowDecisionsData = { decisions: mine.decisions, ...(mine.decisionsMore ? { decisionsMore: mine.decisionsMore } : {}), ...(mine.decisionsReasons ? { decisionsReasons: mine.decisionsReasons } : {}), ...(mine.humanGates ? { humanGates: mine.humanGates } : {}) };
      const legacy = assembleNowView({ instance: name, snapshot, rows, plan: built.plan, recent: [], health: mine.health, decisions, nowMs: now });
      legacy.board.spendTodayUsd = deriveDayCostUsd(spent.rows, built.builtMs);
      const captured = built.probe.health;
      const atProbe = { readLive: () => probeRows, rateLimit: () => captured.rateLimitRemaining, diskFree: () => captured.diskFreeBytes };
      const health = defaultProbeHost(instance, name === core, fixedClock(probeMs), atProbe).health;
      const oldest = rows.map((row) => (typeof row.ts === "string" ? Date.parse(row.ts) : Number.NaN)).filter(Number.isFinite).sort((a, b) => a - b)[0];
      const theirs = nowCountMembers(snapshot.tasks);
      const groups = Object.keys(legacy.board.groups).map((group) => `board.groups.${group}`);
      const [shownMine, shownTheirs] = [new Set(mine.board.tasks.map((t) => t.taskId)), new Set(legacy.board.tasks.map((t) => t.taskId))];
      const windowed = [...new Set([...shownMine, ...shownTheirs])].filter((id) => shownMine.has(id) !== shownTheirs.has(id));
      const row = (id: string, at: string | undefined): string | null => (at ? `${id}#${at}` : null);
      const keys = Object.fromEntries(snapshot.tasks.map((t) => [t.taskId, { legacy: row(t.taskId, t.lastActivityAt), view: row(t.taskId, built.sortedBy.get(t.taskId)) }]));
      // Rotation keeps a pull request's one acted disposition per head and archives the newer unacted ones,
      // so the live file can decide a disposition from a row the view's newer one superseded (#8495, 23:36Z).
      const disposedAt = new Map(snapshot.prQueue.rows.map((r) => [r.prNumber, r.observedAt]));
      const prs = [...new Set([...disposedAt.keys(), ...built.disposedAt.keys()])].map((pr) => [pr, `prQueue.rows[prNumber=${pr}]`] as const);
      const from = Object.fromEntries(prs.map(([pr, path]) => [`${path}.disposition`, { legacy: row(String(pr), disposedAt.get(pr)), view: row(String(pr), built.disposedAt.get(pr)) }]));
      return {
        data: { ...mine, board: legacy.board, prQueue: legacy.prQueue, health },
        asOfMs: now,
        members: Object.fromEntries(Object.entries(theirs).map(([path, ids]) => [path, { legacy: ids, view: built.members[path] ?? [] }])),
        sums: { "board.spendTodayUsd": { legacy: dayCostRows(spent.rows, built.builtMs), view: built.spend } },
        derived: {
          "board.taskProjection.returned": groups,
          "board.taskProjection.complete": [...groups, "board.taskProjection.total"],
          ...Object.fromEntries(windowed.map((id) => [`board.tasks[taskId=${id}]`, groups])),
          ...Object.fromEntries(prs.map(([, path]) => [`${path}.queueClass`, [`${path}.disposition`]])),
        },
        rows: legacyRowIndex([...new Set([...rows, ...spent.rows])]),
        sortKeys: Object.fromEntries(groups.map((path) => [path, keys])),
        from,
        inputs: {
          plan: built.planKey, probeAt: built.probe.sampledAt, builtAt: fixedClock(built.builtMs).iso(), probeRows: probeRows.length,
          windows: { board: board.read, probe: probed.read, spend: spent.read },
        },
        ...(oldest !== undefined ? { horizonMs: oldest } : {}),
      };
    },
    /** W1-T5066: one bounded step per stage per instance; the worker builds no body until every stage is done. */
    prepare(ctx, more) {
      let done = true;
      eachInstance(ctx, (instance, entry) => void (done = step(instance, entry, ctx.now, more) && done));
      return done;
    },
    /** Takes each finished build's body; an instance with none in flight is built here in one go, as a caller with no `prepare` expects. */
    materialize(ctx) {
      const out: Array<{ key: string; data: NowViewData; sources: ViewSource[] }> = [];
      eachInstance(ctx, (instance, entry) => {
        step(instance, entry, ctx.now, () => true);
        const body = builds.get(instance.name)?.body;
        builds.delete(instance.name);
        if (body) out.push(body);
      });
      return out;
    },
  };
}

/**
 * A gauge rounded down to two significant figures: exact below 100, and coarser the more there is to
 * spare (4,321 reads 4,300; 87 reads 87). An exact reading moved the ETag on every 60 s probe.
 */
export function twoSignificantFigures(n: number): number {
  if (n < 100) return n;
  const step = 10 ** (Math.floor(Math.log10(n)) - 1);
  return Math.floor(n / step) * step;
}

/**
 * Disk and daemon heartbeat from the instance's own state dir; the rate limit only for core, whose token serve holds.
 * The daemon's last poll is NOT a gauge: it moves on every poll, so `data` says only whether the daemon is polling,
 * and names the absolute time of its last poll once it went silent (a time that then stops moving).
 */
export function defaultProbeHost(instance: NowInstance, isCore: boolean, clock: Clock = systemClock, deps: NonNullable<NowViewOptions["hostProbe"]> = {}): NowHostProbe {
  const now = clock.now();
  const reasons: Record<string, string> = {};
  const diskFreeBytes = (deps.diskFree ?? readDiskFreeBytes)(instance.ledgerDir);
  if (diskFreeBytes === undefined) reasons.diskFreeBytes = `statfs of ${instance.ledgerDir} failed`;
  const live = (deps.readLive ?? readLedgerLines)(join(instance.ledgerDir, LEDGER_FILENAME));
  const poll = deriveLastPoll(live);
  const silentAfterMs = Math.max(NOW_DAEMON_SILENT_MS, NOW_DAEMON_SILENT_CADENCES * poll.pollIntervalMs);
  const daemon: NowDaemonPoll = !poll.lastPollTs
    ? { state: "silent", reason: "no daemon.* row in the instance's live ledger" }
    : now - Date.parse(poll.lastPollTs) > silentAfterMs
      ? { state: "silent", at: poll.lastPollTs, reason: `no daemon.* row for over ${silentAfterMs / 60_000} min` }
      : { state: "polling" };
  const rateLimitRemaining = isCore ? (deps.rateLimit ?? readGhRateLimitRemaining)() : undefined;
  if (!isCore) reasons.rateLimitRemaining = "serve holds core's GitHub token only; this instance's daemon spends its own";
  else if (rateLimitRemaining === undefined) reasons.rateLimitRemaining = "gh api rate_limit did not answer";
  const health: NowHealth = {
    ...(diskFreeBytes !== undefined ? { diskFreeBytes: twoSignificantFigures(diskFreeBytes) } : {}),
    ...(rateLimitRemaining !== undefined ? { rateLimitRemaining: twoSignificantFigures(rateLimitRemaining) } : {}),
    daemon,
    ...(Object.keys(reasons).length > 0 ? { reasons } : {}),
  };
  return { sampledAt: fixedClock(now).iso(), health, liveRows: live.length };
}
