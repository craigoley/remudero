/**
 * The slow lane: the read-model worker's second thread, for units too heavy for the projector's pass
 * (arch Phase 4, design D2 and P4-T04). The projector's ticks are budgeted to 2.5 s; a unit that
 * shells git for evidence anchors or reads GitHub can take far longer, and one slow unit on the
 * projector's thread froze every view on 2026-09-30 (19.5 min, #8197). Here it delays nothing else.
 *
 * Units run on the lane's own cadence, one after another, and ONLY while this serve holds the home
 * read model's lease, so two serves (a Phase 3 handoff) never both write. The read-model worker
 * relays the lease from each state it posts. A thread that dies is respawned after a doubling delay,
 * and a unit that then succeeds resets it.
 *
 * Its units: the inbox classification (inbox-view.ts), which the daemon's fleet lane acts on, and the
 * analytics refresh (W1-T5055, analytics-view.ts), which runs per instance off serve's event loop and hands
 * each instance's output to the read-model worker to commit as `source_snapshot` rows. The lane makes no GitHub call: it reads the board snapshot whichever keep-warm owns the fetch
 * (switches.json `github`) persists through serve's gateway, the source the board and now view read.
 * THIS FILE IS LOADED TWICE, as read-model-worker.ts is: `workerData.kind` gates the thread's
 * branch, whose body is {@link runSlowLaneWorker}, named so a test can run it in-process.
 */
import { join } from "node:path";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import { systemClock, type Clock } from "./clock.js";
import { GENERIC_EXIT_CODE, RmdError } from "./errors.js";
import { FEEDBACK_VIEW_NAME, FEEDBACK_VIEW_VERSION, materializeFeedbackView } from "./feedback-view.js";
import { INBOX_CLASSIFY_INTERVAL_MS, INBOX_VIEW_NAME, INBOX_VIEW_VERSION, refreshInboxClassification, type InboxRefreshMemo } from "./inbox-view.js";
import { acceptMergedFeedback, ratifyCliGateway, type PanelGraphDeps } from "./panel-graph.js";
import { recordCreditStateEdge } from "./account-usage.js";
import {
  ANALYTICS_REFRESH_INTERVAL_MS,
  ANALYTICS_REFRESH_TIMEOUT_MS,
  deriveAnalyticsSnapshotFromCheckpointedLedger,
  readAnalyticsCheckpoint,
  type AnalyticsCheckpoint,
} from "./analytics-route.js";
import { ANALYTICS_SOURCE_NAMES, ANALYTICS_VIEW_NAME, analyticsSourceBodies } from "./analytics-view.js";
import type { SourceSnapshotWrite } from "./read-model-db.js";
import { snapshotGeneration, snapshotGithub, snapshotSource } from "./now-view.js";
import type { GitHub } from "./status.js";
import type { TraceGithub } from "./trace.js";
import type { ViewSource } from "./views.js";

const SLOW_LANE_KIND = "remudero-read-model-slow-lane" as const;
/** BACKSTOP: the lane's heap; a unit that outgrows it kills this thread, never serve's. */
export const SLOW_LANE_HEAP_MB = 1_024;
/** BACKSTOP: the ceiling of the doubling respawn delay after the thread dies. */
export const SLOW_LANE_MAX_RESPAWN_MS = 30 * 60_000;

/** What the lane needs, all serializable: `workerData` cannot carry a closure. */
export interface SlowLaneConfig {
  /** The inbox unit's inputs; absent, the lane has no inbox unit. */
  inbox?: { root: string; planPath: string; ledgerPath: string; inboxRoot: string; repository: string };
  /** The credit-edge unit's inputs (account-usage.ts); absent, the lane records no credit edge. */
  accountUsage?: { ledgerPath: string; root: string; accountFilePath?: string };
  /** The analytics unit's instances, each by the state dir holding its ledger; it runs only while the analytics view is switched on. */
  analytics?: { instances: Array<{ name: string; stateDir: string }>; intervalMs?: number; timeoutMs?: number };
  intervalMs?: number;
}

type SlowLaneData = SlowLaneConfig & { kind: typeof SLOW_LANE_KIND };

/** One view's every key, as a unit built it: the read-model worker persists and serves them, and drops any key not among them. */
export interface SlowLaneBodies {
  view: string;
  version: number;
  bodies: Array<{ key: string; data: unknown; sources: ViewSource[] }>;
}

export type SlowLaneMessage =
  | { type: "log"; step: string; extra: Record<string, unknown> }
  | { type: "unit"; unit: string; ok: boolean; ms: number }
  | ({ type: "bodies" } & SlowLaneBodies)
  /** One instance's analytics refresh, finished or failed, for the read-model worker to commit. */
  | { type: "source_snapshot"; snapshot: SourceSnapshotWrite };

interface SlowLaneUnit {
  name: string;
  run(): Promise<{ views: SlowLaneBodies[] }>;
}

class SlowLaneGithubRefused extends RmdError {
  constructor() {
    super("read-model", GENERIC_EXIT_CODE, "the slow lane makes no GitHub call; it reads the owner's board snapshot");
  }
}

/** The units never trace a PR; a call that reaches this is refused loudly rather than spawning a fetch. */
export const slowLaneTraceGithub: TraceGithub = {
  prView: () => {
    throw new SlowLaneGithubRefused();
  },
};

/**
 * The owner's persisted board snapshot as a gateway, re-read when serve's gateway re-saves it and judged
 * afresh each pass, so a fetcher that stopped reads stale with its age. An incomplete snapshot reads failed
 * (unavailable, with why) rather than as a board with no merged PRs.
 */
export function ownerSnapshotGithub(root: string, owner: string, repo: string, clock: Clock): () => { github: GitHub; source: ViewSource } {
  let held: { generation: string; built: ReturnType<typeof snapshotGithub> } | undefined;
  return () => {
    const generation = snapshotGeneration(root, owner, repo);
    if (held?.generation !== generation) held = { generation, built: snapshotGithub(root, owner, repo, clock, { refuseIncomplete: true }) };
    const { built } = held;
    const judged = built.unavailable !== undefined ? built.source : snapshotSource(built.source.asOf, built.source.reason, clock.now());
    return { github: built.github, source: { name: `github:${owner}/${repo}`, ...judged } };
  };
}

/** The inbox and feedback units: both read core's checkout, through one board gateway. */
function coreUnits(config: NonNullable<SlowLaneConfig["inbox"]>, clock: Clock, log: (step: string, extra?: Record<string, unknown>) => void, seams: Partial<PanelGraphDeps>): SlowLaneUnit[] {
  const [owner = "", repo = ""] = config.repository.split("/");
  const snapshot = seams.statusGithub ? undefined : ownerSnapshotGithub(config.inboxRoot, owner, repo, clock);
  const deps: PanelGraphDeps = {
    root: config.root,
    planPath: config.planPath,
    ledgerPath: config.ledgerPath,
    inboxRoot: config.inboxRoot,
    github: slowLaneTraceGithub,
    statusGithub: seams.statusGithub ?? snapshot!().github,
    ratify: ratifyCliGateway(config.root, join(config.inboxRoot, "state", "logs")),
    ...seams,
  };
  /** Points the units at the owner's latest snapshot; the deps object stays the same, so the inbox memo keyed by it survives. */
  const githubSource = (): ViewSource[] => {
    if (!snapshot) return [];
    const read = snapshot();
    deps.statusGithub = read.github;
    return [read.source];
  };
  const withSource = (bodies: SlowLaneBodies["bodies"], extra: ViewSource[]): SlowLaneBodies["bodies"] => bodies.map((b) => ({ ...b, sources: [...b.sources, ...extra] }));
  const memo: InboxRefreshMemo = {};
  const inbox: SlowLaneUnit = {
    name: "inbox",
    run: async () => {
      const github = githubSource();
      const refreshed = await refreshInboxClassification(deps, memo, clock);
      if (refreshed.changed) log("inbox.classification_written", { proposals: refreshed.proposals, pruned: refreshed.pruned, at: refreshed.generatedAt });
      return { views: [{ view: INBOX_VIEW_NAME, version: INBOX_VIEW_VERSION, bodies: withSource(refreshed.bodies, github) }] };
    },
  };
  const feedback: SlowLaneUnit = {
    name: "feedback",
    run: async () => {
      // P4-T07: the one writer of a merged proposal's `accepted`, landed as GET /v1/feedback once did per read.
      const github = githubSource();
      const accepted = acceptMergedFeedback(deps.root, deps.statusGithub, deps.feedbackLand ?? {});
      if (accepted.length > 0) log("feedback.accepted_merged", { ids: accepted });
      return { views: [{ view: FEEDBACK_VIEW_NAME, version: FEEDBACK_VIEW_VERSION, bodies: withSource(materializeFeedbackView({ root: deps.root, planPath: deps.planPath }, deps.statusGithub, clock), github) }] };
    },
  };
  return [inbox, feedback];
}

/** The host probe's credit-state edge (P4-T14): appended once per change, with or without a reader. */
function creditEdgeUnit(config: NonNullable<SlowLaneConfig["accountUsage"]>, log: (step: string, extra?: Record<string, unknown>) => void): SlowLaneUnit {
  return {
    name: "credit-edge",
    run: async () => {
      const line = recordCreditStateEdge(config);
      if (line) log("account.credit_edge_recorded", { state: line.state, previous: line.previous ?? null });
      return { views: [] };
    },
  };
}

/** The refresh the analytics unit runs: the one serve's analytics cache runs, unchanged. */
export type AnalyticsRefresh = typeof deriveAnalyticsSnapshotFromCheckpointedLedger;

/**
 * The analytics refresh per instance (W1-T5055), each due once per refresh interval, while `enabled`. A pass only
 * starts the due refreshes and returns, so a scan of a minute or more never holds the inbox unit behind it. Each
 * resumes from the checkpoint it last built, first from the one serve's cache keeps; it never writes that file.
 * A refresh that throws, times out or could not read its ledger posts a failure: the worker keeps the last snapshot.
 */
function analyticsUnit(
  config: NonNullable<SlowLaneConfig["analytics"]>,
  clock: Clock,
  post: (message: SlowLaneMessage) => void,
  log: (step: string, extra?: Record<string, unknown>) => void,
  enabled: () => boolean,
  refresh: AnalyticsRefresh,
): SlowLaneUnit {
  const intervalMs = config.intervalMs ?? ANALYTICS_REFRESH_INTERVAL_MS;
  const timeoutMs = config.timeoutMs ?? ANALYTICS_REFRESH_TIMEOUT_MS;
  const attempted = new Map<string, number>();
  const checkpoints = new Map<string, AnalyticsCheckpoint | undefined>();
  let running = false;
  const refreshOne = async (instance: { name: string; stateDir: string }): Promise<void> => {
    const started = clock.now();
    attempted.set(instance.name, started);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`analytics refresh exceeded ${timeoutMs} ms`)), timeoutMs);
    try {
      const prior = checkpoints.has(instance.name) ? checkpoints.get(instance.name) : readAnalyticsCheckpoint(instance.stateDir);
      const { snapshot, checkpoint } = await refresh(instance.stateDir, clock, controller.signal, prior);
      controller.signal.throwIfAborted();
      if (snapshot.benchmarkEvidence?.reason === "ledger-source-unreadable") throw new Error("the ledger could not be read");
      checkpoints.set(instance.name, checkpoint);
      post({ type: "source_snapshot", snapshot: { instance: instance.name, ok: true, asOf: snapshot.asOf!, bodies: analyticsSourceBodies(snapshot) } });
      log("analytics.source_snapshot_built", { instance: instance.name, ms: clock.now() - started, asOf: snapshot.asOf });
    } catch (error) {
      const message = String((error as Error)?.message ?? error);
      post({ type: "source_snapshot", snapshot: { instance: instance.name, ok: false, names: ANALYTICS_SOURCE_NAMES, error: message, atMs: clock.now() } });
      log("analytics.source_snapshot_failed", { instance: instance.name, ms: clock.now() - started, error: message });
    } finally {
      clearTimeout(timer);
    }
  };
  return {
    name: "analytics",
    run: async () => {
      if (!enabled() || running) return { views: [] };
      const due = config.instances.filter((instance) => clock.now() - (attempted.get(instance.name) ?? Number.NEGATIVE_INFINITY) >= intervalMs);
      if (due.length > 0) {
        running = true;
        void (async () => {
          for (const instance of due) await refreshOne(instance);
          running = false;
        })();
      }
      return { views: [] };
    },
  };
}

/** A view switch mode under which the view is built: the analytics unit runs only then. */
const BUILT_MODES: ReadonlySet<unknown> = new Set(["shadow", "serve", "auto"]);

type Port = { on(event: "message", run: (msg: { type?: string; held?: unknown; modes?: unknown }) => void): unknown; postMessage(value: unknown): void };

/**
 * The thread's body: run every unit each interval while the lease is held. A lease newly held runs a
 * pass at once. A pass never overlaps the last; a unit that throws is reported and the others still run.
 */
export function runSlowLaneWorker(
  port: Port,
  data: SlowLaneConfig,
  opts: { clock?: Clock; schedule?: (run: () => void, ms: number) => () => void; inbox?: Partial<PanelGraphDeps>; analyticsRefresh?: AnalyticsRefresh } = {},
): { stop(): void } {
  const clock = opts.clock ?? systemClock;
  const schedule = opts.schedule ?? ((run, ms) => {
    const timer = setTimeout(run, ms);
    return () => clearTimeout(timer);
  });
  const intervalMs = data.intervalMs ?? INBOX_CLASSIFY_INTERVAL_MS;
  const log = (step: string, extra: Record<string, unknown> = {}): void => port.postMessage({ type: "log", step, extra } satisfies SlowLaneMessage);
  let modes: Record<string, unknown> = {};
  const post = (message: SlowLaneMessage): void => port.postMessage(message);
  const analytics = data.analytics
    ? [analyticsUnit(data.analytics, clock, post, log, () => BUILT_MODES.has(modes[ANALYTICS_VIEW_NAME]), opts.analyticsRefresh ?? deriveAnalyticsSnapshotFromCheckpointedLedger)]
    : [];
  const units: SlowLaneUnit[] = [...(data.inbox ? coreUnits(data.inbox, clock, log, opts.inbox ?? {}) : []), ...(data.accountUsage ? [creditEdgeUnit(data.accountUsage, log)] : []), ...analytics];
  let held = false;
  let running = false;
  let stopped = false;
  let cancel: () => void = () => {};
  const pass = async (): Promise<void> => {
    cancel = () => {};
    if (held && !running) {
      running = true;
      for (const unit of units) {
        const started = clock.now();
        let ok = true;
        try {
          for (const built of (await unit.run()).views) port.postMessage({ type: "bodies", ...built } satisfies SlowLaneMessage);
        } catch (error) {
          ok = false;
          log("read_model.slow_unit_failed", { unit: unit.name, error: String((error as Error)?.message ?? error) });
        }
        port.postMessage({ type: "unit", unit: unit.name, ok, ms: clock.now() - started } satisfies SlowLaneMessage);
      }
      running = false;
    }
    if (!stopped) cancel = schedule(() => void pass(), intervalMs);
  };
  port.on("message", (msg) => {
    if (msg.type === "views") modes = (msg.modes ?? {}) as Record<string, unknown>;
    if (msg.type !== "lease") return;
    const was = held;
    held = msg.held === true;
    if (held && !was && !running) {
      cancel();
      void pass();
    }
  });
  cancel = schedule(() => void pass(), intervalMs);
  return {
    stop: () => {
      stopped = true;
      cancel();
    },
  };
}

if (!isMainThread && (workerData as { kind?: unknown } | undefined)?.kind === SLOW_LANE_KIND && parentPort) {
  runSlowLaneWorker(parentPort, workerData as SlowLaneData);
}

export interface SlowLane {
  /** Whether this serve holds the home lease; the thread is spawned the first time it does. */
  lease(held: boolean): void;
  /** The view switches as the worker last read them: a unit whose view is off does not run. */
  views(modes: Record<string, string>): void;
  close(): void;
}

/** The read-model worker's handle on the lane's thread: spawned on the first held lease, respawned after a death. */
export function threadSlowLane(opts: {
  config: SlowLaneConfig;
  workerUrl?: URL;
  log: (step: string, extra: Record<string, unknown>) => void;
  /** Each view a unit built, every key of it. */
  onBodies?: (built: SlowLaneBodies) => void;
  /** Each instance's analytics refresh, finished or failed. */
  onSnapshot?: (write: SourceSnapshotWrite) => void;
}): SlowLane {
  const baseMs = opts.config.intervalMs ?? INBOX_CLASSIFY_INTERVAL_MS;
  let worker: Worker | undefined;
  let held = false;
  let modes: Record<string, string> = {};
  let deaths = 0;
  let closed = false;
  let respawn: NodeJS.Timeout | undefined;
  const spawn = (): void => {
    const data: SlowLaneData = { ...opts.config, kind: SLOW_LANE_KIND };
    const spawned = new Worker(opts.workerUrl ?? new URL(import.meta.url), { workerData: data, execArgv: process.execArgv, resourceLimits: { maxOldGenerationSizeMb: SLOW_LANE_HEAP_MB } });
    worker = spawned;
    spawned.unref();
    // Ahead of the lease, so a thread's first pass already knows which views are switched on.
    spawned.postMessage({ type: "views", modes });
    spawned.on("message", (msg: SlowLaneMessage) => {
      if (msg.type === "log") opts.log(msg.step, msg.extra);
      else if (msg.type === "bodies") opts.onBodies?.({ view: msg.view, version: msg.version, bodies: msg.bodies });
      else if (msg.type === "source_snapshot") opts.onSnapshot?.(msg.snapshot);
      else if (msg.ok) deaths = 0;
    });
    spawned.on("error", (error) => opts.log("read_model.slow_lane_failed", { error: String(error?.message ?? error) }));
    spawned.on("exit", (code) => {
      if (worker !== spawned || closed) return;
      worker = undefined;
      deaths++;
      const delayMs = Math.min(baseMs * 2 ** deaths, SLOW_LANE_MAX_RESPAWN_MS);
      opts.log("read_model.slow_lane_exited", { code, deaths, respawnInMs: delayMs });
      respawn = setTimeout(() => {
        respawn = undefined;
        if (closed) return;
        spawn();
        worker?.postMessage({ type: "lease", held });
      }, delayMs);
      respawn.unref();
    });
  };
  return {
    lease: (now) => {
      if (closed || now === held) return;
      held = now;
      if (held && !worker && respawn === undefined) spawn();
      worker?.postMessage({ type: "lease", held });
    },
    views: (next) => {
      if (closed || JSON.stringify(next) === JSON.stringify(modes)) return;
      modes = { ...next };
      worker?.postMessage({ type: "views", modes });
    },
    close: () => {
      closed = true;
      clearTimeout(respawn);
      const running = worker;
      worker = undefined;
      void running?.terminate();
    },
  };
}
