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
 * Today's one unit is the inbox classification (inbox-view.ts), which the daemon's fleet lane acts
 * on. The lane makes no GitHub call: it reads the board snapshot whichever keep-warm owns the fetch
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
  | ({ type: "bodies" } & SlowLaneBodies);

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

type Port = { on(event: "message", run: (msg: { type?: string; held?: unknown }) => void): unknown; postMessage(value: unknown): void };

/**
 * The thread's body: run every unit each interval while the lease is held. A lease newly held runs a
 * pass at once. A pass never overlaps the last; a unit that throws is reported and the others still run.
 */
export function runSlowLaneWorker(
  port: Port,
  data: SlowLaneConfig,
  opts: { clock?: Clock; schedule?: (run: () => void, ms: number) => () => void; inbox?: Partial<PanelGraphDeps> } = {},
): { stop(): void } {
  const clock = opts.clock ?? systemClock;
  const schedule = opts.schedule ?? ((run, ms) => {
    const timer = setTimeout(run, ms);
    return () => clearTimeout(timer);
  });
  const intervalMs = data.intervalMs ?? INBOX_CLASSIFY_INTERVAL_MS;
  const log = (step: string, extra: Record<string, unknown> = {}): void => port.postMessage({ type: "log", step, extra } satisfies SlowLaneMessage);
  const units: SlowLaneUnit[] = [...(data.inbox ? coreUnits(data.inbox, clock, log, opts.inbox ?? {}) : []), ...(data.accountUsage ? [creditEdgeUnit(data.accountUsage, log)] : [])];
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
  close(): void;
}

/** The read-model worker's handle on the lane's thread: spawned on the first held lease, respawned after a death. */
export function threadSlowLane(opts: {
  config: SlowLaneConfig;
  workerUrl?: URL;
  log: (step: string, extra: Record<string, unknown>) => void;
  /** Each view a unit built, every key of it. */
  onBodies?: (built: SlowLaneBodies) => void;
}): SlowLane {
  const baseMs = opts.config.intervalMs ?? INBOX_CLASSIFY_INTERVAL_MS;
  let worker: Worker | undefined;
  let held = false;
  let deaths = 0;
  let closed = false;
  let respawn: NodeJS.Timeout | undefined;
  const spawn = (): void => {
    const data: SlowLaneData = { ...opts.config, kind: SLOW_LANE_KIND };
    const spawned = new Worker(opts.workerUrl ?? new URL(import.meta.url), { workerData: data, execArgv: process.execArgv, resourceLimits: { maxOldGenerationSizeMb: SLOW_LANE_HEAP_MB } });
    worker = spawned;
    spawned.unref();
    spawned.on("message", (msg: SlowLaneMessage) => {
      if (msg.type === "log") opts.log(msg.step, msg.extra);
      else if (msg.type === "bodies") opts.onBodies?.({ view: msg.view, version: msg.version, bodies: msg.bodies });
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
    close: () => {
      closed = true;
      clearTimeout(respawn);
      const running = worker;
      worker = undefined;
      void running?.terminate();
    },
  };
}
