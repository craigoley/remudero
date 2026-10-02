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
import { threadPlan } from "./thread-plan.js";
import type { ReadModelDb } from "./read-model-db.js";
import type { GitHub, StatusProjection } from "./status.js";
import { taskCardRuns, type TaskCardRun } from "./task-card.js";
import { TASK_VIEW_NAME, type DemandBook } from "./view-demand.js";
import { describeSource } from "./view-freshness.js";
import type { ViewSource } from "./views.js";

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
    const stamp = `${mtime}:${mtimeOf(join(dirname(path), "tasks.d")) ?? "-"}`;
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

  function build(instanceName: string, id: string, now: number, slot: { state: ReadModelInstanceState; db?: ReadModelDb } | undefined): { data: TaskViewData; sources: ViewSource[] } {
    const instance = byName.get(instanceName);
    const empty: TaskViewData = { instance: instanceName, id, found: false, runs: [], facts: [], factsTruncated: false, trace: { runs: 0, merged: false, costUsd: 0 } };
    if (!instance || !slot) {
      const reason = `no instance named ${instanceName} is projected`;
      return { data: { ...empty, reason }, sources: [describeSource({ name: `ledger:${instanceName}`, asOf: null, state: "unavailable", reason })] };
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
    };
    return { data, sources };
  }

  return {
    name: TASK_VIEW_NAME,
    version: TASK_VIEW_VERSION,
    demand: true,
    materialize: ({ now, instances }) => opts.demand.keys(TASK_VIEW_NAME).map((key) => {
      const params = new URLSearchParams(key);
      const instance = params.get("instance") ?? "";
      const id = params.get("id") ?? "";
      try {
        return { key, ...build(instance, id, now, instances.find((slot) => slot.state.instance === instance)) };
      } catch (error) {
        // One key that cannot be built answers as unavailable; it never takes the other keys' bodies with it.
        const reason = (error as Error).message;
        log("read_model.task_view_failed", { instance, id, error: reason });
        return { key, data: { instance, id, found: false, reason, runs: [], facts: [], factsTruncated: false, trace: { runs: 0, merged: false, costUsd: 0 } }, sources: [describeSource({ name: `ledger:${instance}`, asOf: null, state: "unavailable", reason })] };
      }
    }),
  };
}
