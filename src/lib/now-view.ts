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
 * - `questions`: core only (feedback lives in core); other instances name why they have none.
 *
 * GitHub facts come from the legacy gateway's persisted snapshot (ruling Q3), which now carries the
 * open half too, so the view adds no GitHub read of its own.
 *
 * DARK: the view materializes only while `switches.views.now` reads `shadow` or `serve`, and no route
 * serves it yet (P1-12 declares the route, P1-14 compares it).
 */
import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
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
import { boardOpenSnapshotPath, boardSnapshotPath, createBoardSnapshotCache, OPEN_SNAPSHOT_RESAVE_MS, readOpenBoardSnapshot } from "./board-snapshot-cache.js";
import { fixedClock, systemClock, type Clock } from "./clock.js";
import { deriveLastPoll, readDiskFreeBytes, readGhRateLimitRemaining } from "./daemon-health.js";
import { GENERIC_EXIT_CODE, RmdError } from "./errors.js";
import { listFeedback } from "./feedback.js";
import { LEDGER_FILENAME } from "./ledger-path.js";
import type { BoardPrRest } from "./open-prs-rest.js";
import { loadPlanQuarantiningDuplicates, type Plan } from "./plan.js";
import type { ReadModelDb } from "./read-model-db.js";
import { resolveRepoLayout } from "./repo-layout.js";
import { buildBatchedGithub, readLedgerLines, type BatchedPr, type GitHub } from "./status.js";
import { judgeSource, PLAN_BUDGET_MS } from "./view-freshness.js";
import type { ViewSource } from "./views.js";

export const NOW_VIEW_NAME = "now";
/** 2: every clock stamp left `data` (the envelope and `sources` carry them), so the ETag moves only with content. */
export const NOW_VIEW_VERSION = 2;
/** Re-materialize at least this often with no new row: `elapsedMs`, the liveness bound and the 6 h cooldown move with the clock. */
export const NOW_REFRESH_MS = 30_000;
/** The host probes' cadence (design §3.5), per instance. */
export const NOW_HOST_PROBE_MS = 60_000;
/** Queued rows carried in full; every task id is still in `groups`. */
export const NOW_QUEUED_ROWS = 50;
/** The open snapshot is re-saved at least every minute while its gateway runs; three misses make it stale. */
export const NOW_GITHUB_STALE_MS = 3 * OPEN_SNAPSHOT_RESAVE_MS;
/** A daemon with no `daemon.*` row for this long reads silent: the console's own health-freshness bound. */
export const NOW_DAEMON_SILENT_MS = 5 * 60_000;

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
  questions: { count: number } | { reason: string };
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
  questions: NowViewData["questions"];
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
    questions: input.questions,
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

/** A gateway over the legacy gateway's persisted snapshot (ruling Q3): open PRs, closed PRs and issues, no GitHub read. */
export function snapshotGithub(root: string, owner: string, repo: string, clock: Clock = systemClock): { github: GitHub; generation: string; source: Omit<ViewSource, "name"> } {
  const closedCache = createBoardSnapshotCache(root, owner, repo);
  const closed = [...(closedCache.closedSeed()?.values() ?? [])];
  const issues = [...(closedCache.issueSeed()?.values() ?? [])];
  const open = readOpenBoardSnapshot(root, owner, repo);
  const openRows: BoardPrRest[] = open.ok ? open.snapshot.rows : [];
  const asBatched = (r: BoardPrRest): BatchedPr => ({ number: r.number, url: r.url, state: r.state, headRefName: r.headRefName, headRefOid: r.headRefOid, body: r.body, autoMergeRequest: r.autoMergeRequest, title: r.title });
  const openNumbers = new Set(openRows.map((r) => r.number));
  const all = [...openRows.map(asBatched), ...closed.filter((r) => !openNumbers.has(r.number)).map(asBatched)];
  const github = buildBatchedGithub(owner, repo, {
    ttlMs: Number.MAX_SAFE_INTEGER, pacer: NO_PACER, fetchAll: () => all,
    fetchAllIssues: () => issues.map((i) => ({ number: i.number, url: i.url, state: i.state, ...(i.title ? { title: i.title } : {}) })),
    exec: () => {
      throw new NowViewError("the now view reads GitHub from the persisted snapshot only");
    },
  });
  const ageMs = open.ok ? clock.now() - Date.parse(open.snapshot.savedAt) : undefined;
  const source: Omit<ViewSource, "name"> = !open.ok
    ? { asOf: null, state: "stale", reason: open.reason }
    : ageMs! > NOW_GITHUB_STALE_MS
      ? { asOf: open.snapshot.savedAt, state: "stale", reason: `open pull requests last saved ${Math.round(ageMs! / 1000)} s ago` }
      : { asOf: open.snapshot.savedAt, state: "fresh" };
  return { github, generation: snapshotGeneration(root, owner, repo), source };
}

function snapshotGeneration(root: string, owner: string, repo: string): string {
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
  /** Seams under {@link defaultProbeHost}; production reads statfs, the live ledger and `gh api rate_limit`. */
  hostProbe?: {
    readLive?: (path: string) => ReadonlyArray<Record<string, unknown>>;
    rateLimit?: () => number | undefined;
    diskFree?: (path: string) => number | undefined;
  };
  countQuestions?: (instance: NowInstance) => number;
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
  instances: ReadonlyArray<{ state: NowSlotState; db?: ReadModelDb }>;
  switches?: { views: Record<string, string> };
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
  plan: Plan;
  githubKey: string;
  gateway: ReturnType<typeof snapshotGithub>;
  at: number;
  probe?: NowHostProbe;
  healthAt: number;
  members: Record<string, string[]>;
}

/** The legacy side of one shadow sample (view-shadow.ts): what /now shows today, in the view's shape. */
export interface NowShadowLegacy {
  data: NowViewData;
  asOfMs: number;
  /** The live file's oldest row: GET /v1/status sees nothing older (ruling Q1's legacy horizon). */
  horizonMs?: number;
  members: Record<string, { legacy: string[]; view: string[] }>;
}

/** The `now` view as the read-model worker materializes it: one body per instance, keyed `instance=<name>`. */
export function createNowView(opts: NowViewOptions): {
  name: string;
  version: number;
  materialize(ctx: NowViewContext): Array<{ key: string; data: NowViewData; sources: ViewSource[] }>;
  legacy(key: string, now: number, view: unknown): NowShadowLegacy | undefined;
  perInstance: true;
} {
  const clock = opts.clock ?? systemClock;
  const log = opts.log ?? (() => {});
  const core = opts.coreInstance ?? opts.instances[0]?.name;
  const byName = new Map(opts.instances.map((i) => [i.name, i]));
  const held = new Map<string, Held>();
  const planCache = new Map<string, { key: string; plan: Plan }>();
  const readPlan = opts.readPlan ?? ((instance: NowInstance): Plan => {
    const path = nowPlanPath(instance);
    if (!path) throw new NowViewError(`instance ${instance.name} names no repository, so it has no plan`);
    return loadPlanQuarantiningDuplicates(path).plan;
  });
  const planKey = (instance: NowInstance): string => {
    const path = nowPlanPath(instance);
    return path ? `${mtimeOf(path) ?? "-"}:${mtimeOf(join(dirname(path), "tasks.d")) ?? "-"}` : "none";
  };
  const github = opts.github ?? ((instance: NowInstance) => {
    const [owner, repo] = (instance.repo ?? "/").split("/");
    return snapshotGithub(dirname(instance.ledgerDir), owner!, repo!, clock);
  });
  const githubKey = (instance: NowInstance): string => {
    if (opts.github) return "injected";
    const [owner, repo] = (instance.repo ?? "/").split("/");
    return snapshotGeneration(dirname(instance.ledgerDir), owner!, repo!);
  };
  const probeHost = (instance: NowInstance, isCore: boolean): NowHostProbe => defaultProbeHost(instance, isCore, clock, opts.hostProbe);
  const countQuestions = opts.countQuestions ?? ((instance: NowInstance) => listFeedback(instance.feedbackRoot!, { status: "grilling" }).length);
  const behindMemo = new Map<string, { heads?: string; result?: PlanBehind }>();
  const planBehind = opts.planBehind ?? ((instance: NowInstance): PlanBehind => {
    const path = nowPlanPath(instance);
    if (!path) return { reason: `instance ${instance.name} names no repository, so it has no plan` };
    const memo = behindMemo.get(instance.name) ?? {};
    behindMemo.set(instance.name, memo);
    return gitPlanBehind(path, memo);
  });

  function materializeOne(instance: NowInstance, state: NowSlotState, db: ReadModelDb, now: number): { key: string; data: NowViewData; sources: ViewSource[] } | undefined {
    const pk = planKey(instance);
    const gk = githubKey(instance);
    let h = held.get(instance.name);
    if (h && h.db !== db) h = undefined;
    const due = !h || h.generation !== state.generation || h.planKey !== pk || h.githubKey !== gk || now - h.at >= NOW_REFRESH_MS;
    if (!due) return undefined;
    const cachedPlan = planCache.get(instance.name);
    const plan = cachedPlan?.key === pk ? cachedPlan.plan : readPlan(instance);
    planCache.set(instance.name, { key: pk, plan });
    const gateway = h && h.githubKey === gk ? h.gateway : github(instance);
    const ledgerPath = join(instance.ledgerDir, LEDGER_FILENAME);
    if (!h || h.githubKey !== gk) {
      const board = createBoardProjection({
        db, ledgerPath, readPlan: () => planCache.get(instance.name)!.plan, github: gateway.github, githubGeneration: () => gk, clock, instance: instance.name,
        log: (step, extra) => log(step, { instance: instance.name, ...extra }),
      });
      h = { db, board, recent: createRecentActivityCache(), generation: -1, planKey: pk, plan, githubKey: gk, gateway, at: now, healthAt: Number.NEGATIVE_INFINITY, members: {} };
      held.set(instance.name, h);
    }
    h.board.update({ force: true });
    const rows = h.board.rows();
    const projections = h.board.projections();
    const deps = { plan, ledgerPath, github: gateway.github, readLedger: () => rows as Array<Record<string, unknown>>, now: () => clock.now() };
    const snapshot = computeBoardSnapshot(deps, { reuseProjection: (task) => projections.get(task.id) });
    const isCore = instance.name === core;
    if (!h.probe || now - h.healthAt >= NOW_HOST_PROBE_MS) {
      h.probe = probeHost(instance, isCore);
      h.healthAt = now;
    }
    const questions = isCore && instance.feedbackRoot ? { count: countQuestions(instance) } : { reason: isCore ? "no feedback root is configured" : "feedback questions live in core only" };
    const data = assembleNowView({ instance: instance.name, snapshot, rows, plan, recent: computeRecentActivity(deps, h.recent, 20), health: h.probe.health, questions, nowMs: now });
    Object.assign(h, { generation: state.generation, planKey: pk, plan, at: now, members: nowCountMembers(snapshot.tasks) });
    const sources: ViewSource[] = [
      ...(opts.ledgerSource ? [opts.ledgerSource(state, now)] : []),
      judgeSource({ name: `github:${instance.name}`, ...gateway.source }, now),
      planSource(`plan:${instance.name}`, planBehind(instance), now),
      judgeSource({ name: `host-probe:${instance.name}`, asOf: h.probe.sampledAt, state: "fresh" }, now),
    ];
    return { key: `instance=${encodeURIComponent(instance.name)}`, data, sources };
  }

  return {
    name: NOW_VIEW_NAME,
    version: NOW_VIEW_VERSION,
    perInstance: true,
    /**
     * The shadow comparator's legacy side for one key: GET /v1/status's board and PR queue over the
     * instance's LIVE FILE only, plus a fresh host probe of that instance. The probe's gauges are taken
     * from the view when both probes read them, because two samples moments apart always differ; a gauge
     * one side could not read, or a different reason, still diffs. Actions, recent and questions have
     * no separate legacy computation and are carried from the view.
     */
    legacy(key, now, view) {
      const name = decodeURIComponent(key.replace(/^instance=/, ""));
      const instance = byName.get(name);
      const h = held.get(name);
      if (!instance || !h || !key.startsWith("instance=")) return undefined;
      const mine = view as NowViewData;
      const ledgerPath = join(instance.ledgerDir, LEDGER_FILENAME);
      const rows = readLedgerLines(ledgerPath);
      const deps = { plan: h.plan, ledgerPath, github: h.gateway.github, readLedger: () => rows, now: () => now };
      const snapshot = computeBoardSnapshot(deps);
      const legacy = assembleNowView({ instance: name, snapshot, rows, plan: h.plan, recent: [], health: mine.health, questions: mine.questions, nowMs: now });
      const probe = probeHost(instance, name === core).health;
      const gauge = (field: "diskFreeBytes" | "rateLimitRemaining"): Partial<NowHealth> =>
        probe[field] === undefined ? {} : { [field]: mine.health[field] ?? probe[field] };
      const health: NowHealth = { ...gauge("diskFreeBytes"), ...gauge("rateLimitRemaining"), daemon: probe.daemon, ...(probe.reasons ? { reasons: probe.reasons } : {}) };
      const oldest = rows.map((row) => (typeof row.ts === "string" ? Date.parse(row.ts) : Number.NaN)).filter(Number.isFinite).sort((a, b) => a - b)[0];
      const theirs = nowCountMembers(snapshot.tasks);
      return {
        data: { ...mine, board: legacy.board, prQueue: legacy.prQueue, health },
        asOfMs: now,
        members: Object.fromEntries(Object.entries(theirs).map(([path, ids]) => [path, { legacy: ids, view: h.members[path] ?? [] }])),
        ...(oldest !== undefined ? { horizonMs: oldest } : {}),
      };
    },
    materialize(ctx) {
      const mode = ctx.switches?.views[NOW_VIEW_NAME];
      if (mode !== "shadow" && mode !== "serve") return [];
      const out: Array<{ key: string; data: NowViewData; sources: ViewSource[] }> = [];
      for (const { state, db } of ctx.instances) {
        const instance = byName.get(state.instance);
        if (!instance || !db || state.lease !== "held") continue;
        try {
          const body = materializeOne(instance, state, db, ctx.now);
          if (body) out.push(body);
        } catch (error) {
          log("read_model.now_view_failed", { instance: state.instance, error: (error as Error).message });
        }
      }
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
  const poll = deriveLastPoll((deps.readLive ?? readLedgerLines)(join(instance.ledgerDir, LEDGER_FILENAME)));
  const daemon: NowDaemonPoll = !poll.lastPollTs
    ? { state: "silent", reason: "no daemon.* row in the instance's live ledger" }
    : now - Date.parse(poll.lastPollTs) > NOW_DAEMON_SILENT_MS
      ? { state: "silent", at: poll.lastPollTs, reason: `no daemon.* row for over ${NOW_DAEMON_SILENT_MS / 60_000} min` }
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
  return { sampledAt: fixedClock(now).iso(), health };
}
