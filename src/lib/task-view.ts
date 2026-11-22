/**
 * The `task?instance=&id=` view (arch Phase 4, P4-T09): one task's page, built on demand.
 *
 * The console's task page computed on every GET: `/task` read 4 to 7 core routes, and the per-instance
 * task route resolved each run's PR from GitHub. This view is keyed by `instance` and `id`, so it is
 * built only for a key somebody asked for (view-demand.ts) and kept for ten minutes after the last read.
 * Per-task detail inside `now` would churn the whole `now` ETag; a keyed view keeps it out.
 *
 * Built in the read-model view thread from what is already there:
 * - the task's `task_projection` row (board-projection.ts), the board's own derivation;
 * - its `fact` rows, by `task_id` through the `fact_task` index, folded into per-run cost, verdict and PR;
 * - the newest run's peek tail file (`<state>/runs/<runId>.tail`);
 * - the plan's own record of the task (title, dependencies, acceptance).
 *
 * PR STATE COMES FROM THE WORKER'S GITHUB GATEWAY — the persisted board snapshot (now-view.ts's
 * `snapshotGithub`), which cannot spawn a `gh`: a PR the snapshot does not hold reads `unknown`, never
 * a per-run GitHub read. Sources: `ledger:<i>`, `github:<i>`, `plan:<i>`.
 */
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fixedClock, systemClock, type Clock } from "./clock.js";
import { snapshotGeneration, snapshotGithub, type NowInstance } from "./now-view.js";
import type { AcceptanceCriterion, Plan, Task } from "./plan.js";
import { threadPlan, threadPlanPin } from "./thread-plan.js";
import type { ReadModelDb } from "./read-model-db.js";
import type { GitHub, StatusProjection } from "./status.js";
import { taskCardRuns, type TaskCardRun } from "./task-card.js";
import { TASK_VIEW_NAME, type DemandBook } from "./view-demand.js";
import { describeSource } from "./view-freshness.js";
import { ACTIVITY_RING_ROWS } from "./ledger-projector.js";
import { encodeTaskActivityCursor, readTaskActivityCursor, TASK_ACTIVITY_RUN_SHAPE, type TaskActivityCursor, type ViewSource } from "./views.js";

/**
 * One instance's projector, as the worker last saw it. Posted to the main thread every tick. It is
 * defined HERE, not in read-model-worker.ts, so this file need not import the worker that imports it
 * (a cycle); the worker re-exports it as `ReadModelInstanceState`.
 */
export interface ReadModelInstanceState {
  instance: string;
  /** When the last tick completed; absent before the first. */
  tickedAt?: number;
  generation: number;
  lease: "held" | "elsewhere" | "none";
  heldBy?: string;
  /** Why the last tick did not run or failed; absent after a good tick. */
  reason?: string;
  failures: number;
  /** The `ts` of the newest applied (not quarantined) row. */
  newestTs: string | null;
  /** Present while one of its oracle slices is running. */
  checking?: true;
  /** Present while a backlog is being applied: how far behind, and the ETA measured at `at`. */
  catchUp?: { rowsBehind: number; etaMs: number; at: number };
}

export const TASK_VIEW_VERSION = 1;
/** The newest fact rows read per task; a task with more reports `factsTruncated`. */
export const TASK_VIEW_FACT_ROWS = 400;
/** The newest fact rows listed in the body. */
export const TASK_VIEW_LISTED_FACTS = 50;
/** The newest runs whose PR is looked up in the gateway. */
export const TASK_VIEW_PR_RUNS = 10;
/** Lines of the newest run's peek tail the body carries, each clipped. */
export const TASK_VIEW_TAIL_LINES = 40;
const TAIL_LINE_CHARS = 300;
const ACCEPTANCE_ROWS = 20;
const RUN_ID_SHAPE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,254}$/;
/** PRIMARY CONTROL: events one activity page carries. */
export const TASK_ACTIVITY_PAGE_EVENTS = 50;
/** BACKSTOP: JSON bytes of one activity page's events; a page that reaches it ends early and says it has more. */
export const TASK_ACTIVITY_PAGE_BYTES = 16 * 1024;
/** PRIMARY CONTROL: activity demand keys (one per distinct run or cursor) admitted per task; the most recently read win. */
export const TASK_ACTIVITY_KEYS_PER_TASK = 4;
/** PRIMARY CONTROL: activity demand keys admitted in one materialization pass, across every task: the pass's total ring work. */
export const TASK_ACTIVITY_PASS_KEYS = 16;
const ACTIVITY_STEP_CHARS = 120;

/** A run's PR as the gateway holds it; `unknown` when the snapshot does not. */
export interface TaskViewPr {
  url: string;
  number?: number;
  state: string;
  title?: string;
  reason?: string;
}

export interface TaskViewRun extends TaskCardRun {
  pr?: TaskViewPr;
}

/** One activity ring row of the run, reduced to what an observer needs: never a prompt, tool argument or transcript body. */
export interface TaskActivityEvent {
  /** The ring's apply sequence: the order events are delivered in, which equal timestamps do not disturb. */
  seq: number;
  /** The row's own stable identity, `<ms timestamp>:<line hash>`; a replayed page repeats it exactly. */
  id: string;
  ts: string;
  step: string;
}

/**
 * One page of a task run's activity, read from the projector's `activity_ring`. `unavailable` is the ONLY state
 * that says nothing about history: an empty `available` page with a `cursor` is "caught up at that position",
 * and `retentionGap` or `reset` say the cursor could not be continued (the ring rolled past it, or its corpus
 * is not this one), so the page restarts at the oldest retained event and the observer must not call it complete.
 */
export interface TaskActivity {
  state: "available" | "unavailable";
  runId: string;
  events: TaskActivityEvent[];
  /** More events of this run follow in the ring than this page carries. */
  hasMore: boolean;
  retentionGap: boolean;
  reset: boolean;
  /** Pass it back as `activityCursor`: after the page's last event while `hasMore`, else the validated ring tail. */
  cursor?: string;
  ring?: { rows: number; capacity: number };
  reason?: string;
}

export interface TaskViewData {
  instance: string;
  id: string;
  /** False when no `task_projection` row, plan record or fact names the task. */
  found: boolean;
  /** Why the body is thin: the store, the table or the instance was not there. */
  reason?: string;
  task?: { title: string; type: string; risk: string; priority?: number; status: string; dependsOn: string[]; rationale?: string; acceptance: AcceptanceCriterion[] };
  projection?: Pick<StatusProjection, "status" | "merged" | "source" | "prNumber" | "prUrl" | "prState" | "phase" | "startedAt" | "workerState">;
  runs: TaskViewRun[];
  facts: Array<{ seq: number; ts: string; step: string; runId?: string }>;
  factsTruncated: boolean;
  /** The newest run's peek tail. */
  tail?: { runId: string; lines: string[] };
  trace: { runs: number; merged: boolean; costUsd: number; lastVerdict?: string; firstTs?: string; lastTs?: string };
  /** Present only when the request named `activityRun`; observation only, it never changes `found`, `runs` or `trace`. */
  activity?: TaskActivity;
}

export interface TaskViewOptions {
  instances: readonly NowInstance[];
  /** The worker's `ledger:<i>` source judge. */
  ledgerSource: (state: ReadModelInstanceState, now: number) => ViewSource;
  demand: DemandBook;
  clock?: Clock;
  log?: (step: string, extra: Record<string, unknown>) => void;
  /** An instance's GitHub gateway; defaults to the persisted board snapshot, re-read when it is re-saved. */
  github?: (instance: NowInstance) => { github: GitHub; source: Omit<ViewSource, "name"> };
  /** An instance's plan record of a task; defaults to its plan file, re-read when the file moves. */
  readTask?: (instance: NowInstance, id: string) => { task?: Task; source: Omit<ViewSource, "name"> };
  /** The lines of a run's peek tail; defaults to `<ledgerDir>/runs/<runId>.tail`. */
  readTail?: (instance: NowInstance, runId: string) => string[] | undefined;
}

function mtimeOf(path: string): number | undefined {
  try {
    return statSync(path).mtimeMs;
  } catch (error) {
    // deliberate: an absent file reads as "never written", which the caller reports as an unavailable source.
    void error;
    return undefined;
  }
}

/** The task view's key: `id` and `instance`, sorted by name as views.ts's `viewKey` does. */
export function taskViewKey(instance: string, id: string): string {
  return `id=${encodeURIComponent(id)}&instance=${encodeURIComponent(instance)}`;
}

/** The newest `lines` of a run's tail file, clipped; undefined when the run has none recorded. */
export function readRunTail(instance: NowInstance, runId: string, lines: number = TASK_VIEW_TAIL_LINES): string[] | undefined {
  if (!RUN_ID_SHAPE.test(runId)) return undefined;
  let raw: string;
  try {
    raw = readFileSync(join(instance.ledgerDir, "runs", `${runId}.tail`), "utf8");
  } catch (error) {
    // deliberate: a run with no tail recorded (or an unreadable one) simply has none to show.
    void error;
    return undefined;
  }
  const split = raw.split("\n");
  if (split.at(-1) === "") split.pop();
  return split.slice(-lines).map((line) => (line.length > TAIL_LINE_CHARS ? `${line.slice(0, TAIL_LINE_CHARS)}…` : line));
}

function unavailableActivity(runId: string, reason: string): TaskActivity {
  return { state: "unavailable", runId, events: [], hasMore: false, retentionGap: false, reset: false, reason };
}

/** What a request asked of the activity feed: one exact run and, optionally, the cursor to continue after. */
interface ActivityRequest { run: string; cursor?: string }

/**
 * One page of `run`'s activity for task `id`, from the projector's `activity_ring` (the newest rows of ANY step;
 * `fact` keeps only decision steps and would silently omit events). The task and run are matched exactly on the
 * row's own `task_id` and `run_id`; the page is in ring apply order (`seq`), so equal timestamps neither skip nor
 * repeat. Ring, tail and page are read in one snapshot. A store or ring that cannot be read answers `unavailable`,
 * never an empty page.
 */
function readTaskActivity(
  db: ReadModelDb | undefined, state: ReadModelInstanceState, id: string, request: ActivityRequest,
  log: (step: string, extra: Record<string, unknown>) => void,
): TaskActivity {
  const { run } = request;
  if (!db) return unavailableActivity(run, "the read model store is not open yet");
  const parsed = request.cursor === undefined ? undefined : readTaskActivityCursor(request.cursor, { instance: state.instance, id, run });
  if (parsed && "error" in parsed) return unavailableActivity(run, parsed.error);
  const cursor: TaskActivityCursor | undefined = parsed?.cursor;
  const own = !db.inTransaction();
  try {
    if (own) db.exec("BEGIN");
    try {
      if (db.prepare("SELECT 1 AS ok FROM pragma_table_info('activity_ring') WHERE name = 'seq'").get() === undefined) {
        return unavailableActivity(run, "the activity ring is not built yet");
      }
      const ring = db.prepare("SELECT count(*) AS n, min(ts_ms) AS lo FROM activity_ring").get();
      const rows = Number(ring?.n ?? 0);
      const oldest = ring?.lo === null || ring?.lo === undefined ? undefined : Number(ring.lo);
      let after = 0;
      let retentionGap = false;
      let reset = false;
      if (cursor) {
        const held = cursor.g > state.generation ? undefined : db.prepare("SELECT ts_ms, CAST(h AS TEXT) AS h FROM activity_ring WHERE seq = ?").get(cursor.s);
        if (held && Number(held.ts_ms) === cursor.m && String(held.h) === cursor.h) after = cursor.s;
        else if (cursor.g <= state.generation && oldest !== undefined && cursor.m <= oldest) retentionGap = true;
        else reset = true;
      }
      const found = db.prepare(`SELECT seq, ts_ms, CAST(h AS TEXT) AS h,
          CASE WHEN json_valid(body) THEN json_extract(body, '$.ts') END AS ts, CASE WHEN json_valid(body) THEN json_extract(body, '$.step') END AS step
        FROM activity_ring WHERE seq > ? AND CASE WHEN json_valid(body) THEN json_extract(body, '$.task_id') END = ?
          AND CASE WHEN json_valid(body) THEN json_extract(body, '$.run_id') END = ? ORDER BY seq LIMIT ?`).all(after, id, run, TASK_ACTIVITY_PAGE_EVENTS + 1);
      const events: TaskActivityEvent[] = [];
      const last: Array<{ seq: number; ts_ms: number; h: string }> = [];
      let bytes = 0;
      let hasMore = found.length > TASK_ACTIVITY_PAGE_EVENTS;
      for (const row of found.slice(0, TASK_ACTIVITY_PAGE_EVENTS)) {
        const ts = typeof row.ts === "string" ? row.ts.slice(0, 40) : fixedClock(Number(row.ts_ms)).iso();
        const step = typeof row.step === "string" ? row.step.slice(0, ACTIVITY_STEP_CHARS) : "unknown";
        const event: TaskActivityEvent = { seq: Number(row.seq), id: `${String(row.ts_ms)}:${String(row.h)}`, ts, step };
        bytes += Buffer.byteLength(JSON.stringify(event)) + 1;
        if (bytes > TASK_ACTIVITY_PAGE_BYTES && events.length > 0) {
          hasMore = true;
          break;
        }
        events.push(event);
        last.length = 0;
        last.push({ seq: event.seq, ts_ms: Number(row.ts_ms), h: String(row.h) });
      }
      // While more follow, the cursor stands after the last event delivered; caught up, it is the ring's own tail, the corpus identity the page was validated against.
      const edge = hasMore ? last[0] : db.prepare("SELECT seq, ts_ms, CAST(h AS TEXT) AS h FROM activity_ring ORDER BY seq DESC LIMIT 1").get();
      const next = edge ? encodeTaskActivityCursor({ i: state.instance, t: id, r: run, g: state.generation, s: Number(edge.seq), m: Number(edge.ts_ms), h: String(edge.h) }) : undefined;
      return {
        state: "available", runId: run, events, hasMore, retentionGap, reset,
        ...(next ? { cursor: next } : {}), ring: { rows, capacity: ACTIVITY_RING_ROWS },
        ...(retentionGap ? { reason: "the ring rolled past the cursor; this page restarts at the oldest retained event" } : {}),
        ...(reset ? { reason: "the cursor does not belong to this activity ring; this page restarts at the oldest retained event" } : {}),
      };
    } finally {
      if (own) db.exec("COMMIT");
    }
  } catch (error) {
    // Reported, not erased: an unreadable ring answers unavailable with why, never an empty page that reads as complete history.
    const reason = `the activity ring could not be read: ${(error as Error).message}`;
    log("read_model.task_view_failed", { instance: state.instance, id, run, activity: true, error: (error as Error).message });
    return unavailableActivity(run, reason);
  }
}

export function createTaskView(opts: TaskViewOptions): {
  name: string;
  version: number;
  demand: true;
  materialize(ctx: { now: number; instances: ReadonlyArray<{ state: ReadModelInstanceState; db?: ReadModelDb }> }): Array<{ key: string; data: TaskViewData; sources: ViewSource[] }>;
} {
  const clock = opts.clock ?? systemClock;
  const log = opts.log ?? (() => {});
  const byName = new Map(opts.instances.map((instance) => [instance.name, instance]));
  const gateways = new Map<string, { generation: string; built: ReturnType<typeof snapshotGithub> }>();
  const plans = new Map<string, { stamp: string; plan: Plan }>();

  const githubOf = opts.github ?? ((instance: NowInstance) => {
    const [owner = "", repo = ""] = (instance.repo ?? "/").split("/");
    const root = dirname(instance.ledgerDir);
    const generation = snapshotGeneration(root, owner, repo);
    let held = gateways.get(instance.name);
    if (held?.generation !== generation) gateways.set(instance.name, (held = { generation, built: snapshotGithub(root, owner, repo, clock) }));
    return { github: held.built.github, source: held.built.source };
  });

  const taskOf = opts.readTask ?? ((instance: NowInstance, id: string): { task?: Task; source: Omit<ViewSource, "name"> } => {
    const path = instance.planPath;
    if (!path) return { source: { asOf: null, state: "unavailable" as const, reason: `instance ${instance.name} names no plan file` } };
    const mtime = mtimeOf(path);
    if (mtime === undefined) return { source: { asOf: null, state: "unavailable" as const, reason: `the plan file ${path} is absent` } };
    const stamp = `${mtime}:${mtimeOf(join(dirname(path), "tasks.d")) ?? "-"}:${threadPlanPin(path)}`;
    let held = plans.get(instance.name);
    if (held?.stamp !== stamp) plans.set(instance.name, (held = { stamp, plan: threadPlan(path) }));
    const task = held.plan.byId.get(id);
    return { ...(task ? { task } : {}), source: { asOf: fixedClock(mtime).iso(), state: "fresh" as const } };
  });
  const tailOf = opts.readTail ?? ((instance: NowInstance, runId: string) => readRunTail(instance, runId));

  /** One run's PR from the gateway; a PR it does not hold, or a gateway that cannot answer, reads `unknown` with why. */
  function prOf(github: GitHub | undefined, url: string, why: string | undefined): TaskViewPr {
    if (!github) return { url, state: "unknown", reason: why ?? "no GitHub gateway" };
    try {
      const pr = github.prByRef(url);
      return pr ? { url, number: pr.number, state: pr.state, ...(pr.title ? { title: pr.title } : {}) } : { url, state: "unknown", reason: "the gateway holds no such pull request" };
    } catch (error) {
      return { url, state: "unknown", reason: (error as Error).message };
    }
  }

  function build(instanceName: string, id: string, now: number, slot: { state: ReadModelInstanceState; db?: ReadModelDb } | undefined, activity?: ActivityRequest): { data: TaskViewData; sources: ViewSource[] } {
    const instance = byName.get(instanceName);
    const empty: TaskViewData = { instance: instanceName, id, found: false, runs: [], facts: [], factsTruncated: false, trace: { runs: 0, merged: false, costUsd: 0 } };
    if (!instance || !slot) {
      const reason = `no instance named ${instanceName} is projected`;
      return { data: { ...empty, reason, ...(activity ? { activity: unavailableActivity(activity.run, reason) } : {}) }, sources: [describeSource({ name: `ledger:${instanceName}`, asOf: null, state: "unavailable", reason })] };
    }
    const sources: ViewSource[] = [opts.ledgerSource(slot.state, now)];
    const db = slot.db;
    let reason: string | undefined;
    let projection: StatusProjection | undefined;
    const rows: Array<Record<string, unknown>> = [];
    const facts: TaskViewData["facts"] = [];
    let factsTruncated = false;
    if (!db) {
      reason = "the read model store is not open yet";
      sources.push(describeSource({ name: `read-model:${instance.name}`, asOf: null, state: "unavailable", reason }));
    } else {
      try {
        const stored = db.prepare("SELECT json FROM task_projection WHERE task_id = ?").get(id);
        if (stored) projection = JSON.parse(String(stored.json)) as StatusProjection;
      } catch (error) {
        // Reported, not erased: the reason rides the body and an unavailable read-model source, so the page says why it is thin.
        reason = `no task projection yet: ${(error as Error).message}`;
        sources.push(describeSource({ name: `read-model:${instance.name}`, asOf: null, state: "unavailable", reason }));
      }
      try {
        const newestFirst = db.prepare("SELECT seq, ts, step, run_id, body FROM fact WHERE task_id = ? ORDER BY seq DESC LIMIT ?").all(id, TASK_VIEW_FACT_ROWS);
        factsTruncated = newestFirst.length >= TASK_VIEW_FACT_ROWS;
        for (const row of newestFirst.slice(0, TASK_VIEW_LISTED_FACTS)) {
          facts.push({ seq: Number(row.seq), ts: String(row.ts), step: String(row.step), ...(row.run_id ? { runId: String(row.run_id) } : {}) });
        }
        for (const row of [...newestFirst].reverse()) rows.push(JSON.parse(String(row.body)) as Record<string, unknown>);
      } catch (error) {
        reason ??= `no fact rows: ${(error as Error).message}`;
        log("read_model.task_view_facts_failed", { instance: instance.name, id, error: (error as Error).message });
      }
    }
    const planned = taskOf(instance, id);
    sources.push(describeSource({ name: `plan:${instance.name}`, ...planned.source }));
    const runs: TaskViewRun[] = taskCardRuns(rows, id);
    let gateway: { github: GitHub; source: Omit<ViewSource, "name"> } | undefined;
    let gatewayWhy: string | undefined;
    if (runs.some((run) => run.prUrl !== undefined)) {
      try {
        gateway = githubOf(instance);
        sources.push(describeSource({ name: `github:${instance.name}`, ...gateway.source }));
      } catch (error) {
        gatewayWhy = (error as Error).message;
        sources.push(describeSource({ name: `github:${instance.name}`, asOf: null, state: "unavailable", reason: gatewayWhy }));
      }
    }
    for (const run of runs.slice(-TASK_VIEW_PR_RUNS)) if (run.prUrl) run.pr = prOf(gateway?.github, run.prUrl, gatewayWhy);
    const newest = runs.at(-1);
    const lines = newest ? tailOf(instance, newest.runId) : undefined;
    const costUsd = runs.reduce((sum, run) => sum + (run.costUsd ?? 0), 0);
    const lastVerdict = [...runs].reverse().find((run) => run.verdict !== undefined)?.verdict;
    const tsOf = (row: Record<string, unknown> | undefined): string | undefined => (typeof row?.ts === "string" ? row.ts : undefined);
    const firstTs = tsOf(rows[0]);
    const lastTs = tsOf(rows.at(-1));
    const task = planned.task;
    const data: TaskViewData = {
      instance: instance.name,
      id,
      found: projection !== undefined || task !== undefined || rows.length > 0,
      ...(reason ? { reason } : {}),
      ...(task ? { task: { title: task.title, type: task.type, risk: task.risk, ...(task.priority !== undefined ? { priority: task.priority } : {}), status: task.status, dependsOn: task.depends_on, ...(task.rationale ? { rationale: task.rationale } : {}), acceptance: (task.acceptance ?? []).slice(0, ACCEPTANCE_ROWS) } } : {}),
      ...(projection ? { projection: {
        status: projection.status, merged: projection.merged, source: projection.source,
        ...(projection.prNumber !== undefined ? { prNumber: projection.prNumber } : {}),
        ...(projection.prUrl ? { prUrl: projection.prUrl } : {}),
        ...(projection.prState ? { prState: projection.prState } : {}),
        ...(projection.phase ? { phase: projection.phase } : {}),
        ...(projection.startedAt ? { startedAt: projection.startedAt } : {}),
        ...(projection.workerState ? { workerState: projection.workerState } : {}),
      } } : {}),
      runs,
      facts,
      factsTruncated,
      ...(newest && lines ? { tail: { runId: newest.runId, lines } } : {}),
      trace: { runs: runs.length, merged: projection?.merged ?? false, costUsd: Math.round(costUsd * 1e6) / 1e6, ...(lastVerdict ? { lastVerdict } : {}), ...(firstTs ? { firstTs } : {}), ...(lastTs ? { lastTs } : {}) },
      ...(activity ? { activity: readTaskActivity(db, slot.state, id, activity, log) } : {}),
    };
    return { data, sources };
  }

  return {
    name: TASK_VIEW_NAME,
    version: TASK_VIEW_VERSION,
    demand: true,
    materialize: ({ now, instances }) => {
      const keys = opts.demand.keys(TASK_VIEW_NAME);
      const requested = (key: string): ActivityRequest | undefined => {
        const params = new URLSearchParams(key);
        const run = params.get("activityRun");
        if (run === null || !TASK_ACTIVITY_RUN_SHAPE.test(run)) return undefined;
        const cursor = params.get("activityCursor");
        return { run, ...(cursor === null ? {} : { cursor }) };
      };
      // Admission reuses the demand book's own recency order (least recently read first): the most recently read activity keys
      // of each task, and of the whole pass, are built; the rest answer unavailable without touching the ring or the plan.
      const admitted = new Set<string>();
      const perTask = new Map<string, number>();
      for (const key of [...keys].reverse()) {
        if (!requested(key)) continue;
        const params = new URLSearchParams(key);
        const task = `${params.get("instance") ?? ""}\u0000${params.get("id") ?? ""}`;
        if (admitted.size >= TASK_ACTIVITY_PASS_KEYS || (perTask.get(task) ?? 0) >= TASK_ACTIVITY_KEYS_PER_TASK) continue;
        admitted.add(key);
        perTask.set(task, (perTask.get(task) ?? 0) + 1);
      }
      return keys.map((key) => {
        const params = new URLSearchParams(key);
        const instance = params.get("instance") ?? "";
        const id = params.get("id") ?? "";
        const activity = requested(key);
        if (activity && !admitted.has(key)) {
          const reason = `the task activity demand bound (${TASK_ACTIVITY_KEYS_PER_TASK} per task, ${TASK_ACTIVITY_PASS_KEYS} per pass) holds this key back`;
          return { key, data: { instance, id, found: false, reason, runs: [], facts: [], factsTruncated: false, trace: { runs: 0, merged: false, costUsd: 0 }, activity: unavailableActivity(activity.run, reason) },
            sources: [describeSource({ name: `ledger:${instance}`, asOf: null, state: "unavailable", reason })] };
        }
        try {
          return { key, ...build(instance, id, now, instances.find((slot) => slot.state.instance === instance), activity) };
        } catch (error) {
          // One key that cannot be built answers as unavailable; it never takes the other keys' bodies with it.
          const reason = (error as Error).message;
          log("read_model.task_view_failed", { instance, id, error: reason });
          return { key, data: { instance, id, found: false, reason, runs: [], facts: [], factsTruncated: false, trace: { runs: 0, merged: false, costUsd: 0 }, ...(activity ? { activity: unavailableActivity(activity.run, reason) } : {}) }, sources: [describeSource({ name: `ledger:${instance}`, asOf: null, state: "unavailable", reason })] };
        }
      });
    },
  };
}
