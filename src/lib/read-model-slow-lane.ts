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
 * each instance's output to the read-model worker to commit as `source_snapshot` rows. The inbox units make no GitHub call: they read the board snapshot whichever keep-warm owns the fetch
 * (switches.json `github`) persists through serve's gateway, the source the board and now view read.
 * THIS FILE IS LOADED TWICE, as read-model-worker.ts is: `workerData.kind` gates the thread's
 * branch, whose body is {@link runSlowLaneWorker}, named so a test can run it in-process.
 */
import { join } from "node:path";
import { collectCodeHealth } from "./code-health-collector.js";
import { CODE_HEALTH_INTERVAL_MS, CODE_HEALTH_VIEW_NAME, readCodeHealthInventory } from "./code-health-view.js";
import { codeHealthRepositoryStateDir, readCodeHealthCollectionFailure, readCodeHealthSnapshot } from "./code-health-store.js";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import { systemClock, type Clock } from "./clock.js";
import { GENERIC_EXIT_CODE, RmdError } from "./errors.js";
import { FEEDBACK_VIEW_NAME, FEEDBACK_VIEW_VERSION, materializeFeedbackView } from "./feedback-view.js";
import { INBOX_CLASSIFY_INTERVAL_MS, INBOX_VIEW_NAME, INBOX_VIEW_VERSION, refreshInboxClassification, type InboxRefreshMemo } from "./inbox-view.js";
import { acceptMergedFeedback, proposeHandRouteFeedback, ratifyCliGateway, type PanelGraphDeps } from "./panel-graph.js";
import { recordCreditStateEdge } from "./account-usage.js";
import {
  ANALYTICS_REFRESH_INTERVAL_MS,
  ANALYTICS_REFRESH_TIMEOUT_MS,
  readAnalyticsCheckpoint,
  scanAnalyticsLedger,
  type AnalyticsCheckpoint,
  type AnalyticsResumePoint,
  type AnalyticsScanReport,
} from "./analytics-route.js";
import { ANALYTICS_SOURCE_NAMES, ANALYTICS_VIEW_NAME, GARDENER_SPEND_SOURCE_NAME, analyticsSourceBodies } from "./analytics-view.js";
import { captureGardenerSpendSource } from "./gardener-spend.js";
import type { SourceSnapshotWrite } from "./read-model-db.js";
import { snapshotGeneration, snapshotGithub, snapshotSource } from "./now-view.js";
import type { GitHub } from "./status.js";
import type { TraceGithub } from "./trace.js";
import type { ViewSource } from "./views.js";
import { startWorker } from "./child-entry-argv.js";
import { NO_INSTANCE_RATIFY } from "./instance-gateway.js";
import { collectDailyProgress, type DailyProgressCollectionConfig } from "./daily-progress-collector.js";
import type { DailyProgressPublication } from "./daily-progress-store.js";

const SLOW_LANE_KIND = "remudero-read-model-slow-lane" as const;
/** BACKSTOP: the lane's heap; a unit that outgrows it kills this thread, never serve's. */
export const SLOW_LANE_HEAP_MB = 1_024;
/** BACKSTOP: the ceiling of the doubling respawn delay after the thread dies. */
export const SLOW_LANE_MAX_RESPAWN_MS = 30 * 60_000;

/** What the lane needs, all serializable: `workerData` cannot carry a closure. */
export interface SlowLaneConfig {
  /** Daily collection is independent of view switches and reader demand. */
  dailyProgress?: DailyProgressCollectionConfig;
  /** The inbox unit's inputs; absent, the lane has no inbox unit. */
  inbox?: { root: string; planPath: string; ledgerPath: string; inboxRoot: string; repository: string };
  instanceInboxes?: Array<NonNullable<SlowLaneConfig["inbox"]> & { instance: string }>;
  /** The credit-edge unit's inputs (account-usage.ts); absent, the lane records no credit edge. */
  accountUsage?: { ledgerPath: string; root: string; accountFilePath?: string };
  /** The analytics unit's instances, each by the state dir holding its ledger; it runs only while the analytics view is switched on. */
  analytics?: { instances: Array<{ name: string; stateDir: string; repository?: string }>; intervalMs?: number; timeoutMs?: number };
  codeHealth?: { stateDir: string; instances: Array<{ name: string; stateDir: string; repository?: string }> };
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
  | { type: "daily_progress"; publication: DailyProgressPublication; ownershipEpoch: number }
  | { type: "log"; step: string; extra: Record<string, unknown> }
  /** Posted BEFORE a unit's work starts, so a thread that dies inside it is attributed by its parent. */
  | { type: "begin"; work: SlowLaneWork }
  | { type: "end"; work: SlowLaneWork }
  | { type: "unit"; unit: string; ok: boolean; ms: number }
  | ({ type: "bodies" } & SlowLaneBodies)
  /** One instance's analytics refresh, finished or failed, for the read-model worker to commit. */
  | { type: "source_snapshot"; snapshot: SourceSnapshotWrite };

/** One piece of work in flight on the lane's thread: the unit, the instance it reads, and how far it got. */
export interface SlowLaneWork {
  unit: string;
  instance?: string;
  phase: string;
}

interface SlowLaneUnit {
  name: string;
  instance?: string;
  run(): Promise<{ views: SlowLaneBodies[] }>;
  cancel?(): void;
}

function instanceInboxUnit(config: NonNullable<SlowLaneConfig["instanceInboxes"]>[number], clock: Clock,
  captureOwnership: () => () => boolean, log: (step: string, extra?: Record<string, unknown>) => void): SlowLaneUnit {
  const [owner, repo] = config.repository.split("/");
  const snapshot = ownerSnapshotGithub(config.inboxRoot, owner, repo, clock);
  const deps: PanelGraphDeps = { ...config, github: slowLaneTraceGithub, statusGithub: snapshot().github, ratify: NO_INSTANCE_RATIFY,
    inboxSourceIdentity: config };
  const memo: InboxRefreshMemo = {};
  return { name: `inbox:${config.instance}`, instance: config.instance, run: async () => {
    deps.inboxMayPersist = captureOwnership();
    deps.statusGithub = snapshot().github;
    const refreshed = await refreshInboxClassification(deps, memo, clock);
    if (refreshed.written) log("inbox.classification_written", { instance: config.instance, repository: config.repository,
      proposals: refreshed.proposals, pruned: refreshed.pruned, at: refreshed.generatedAt });
    return { views: [] };
  } };
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
    inboxAuditScope: { instance: "core", repository: config.repository },
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
      if (github.some(source => source.state !== "fresh")) {
        log("feedback.hand_route_deferred", { reason: "snapshot_not_fresh" });
      } else {
        const outcomes = proposeHandRouteFeedback(deps.root, deps.statusGithub, config.repository, { ...deps.feedbackLand, stateRoot: deps.feedbackLand?.stateRoot ?? config.inboxRoot });
        const proposed = outcomes.filter(outcome => outcome.outcome === "proposed");
        const unknown = outcomes.filter(outcome => outcome.outcome === "unknown");
        const refused = outcomes.filter(outcome => outcome.outcome === "refused");
        if (proposed.length || unknown.length || refused.length) log("feedback.hand_route_reconciled", { proposed, unknown: unknown.length, refused: refused.length, reasons: [...new Set([...unknown, ...refused].map(outcome => outcome.reason))] });
      }
      return { views: [{ view: FEEDBACK_VIEW_NAME, version: FEEDBACK_VIEW_VERSION, bodies: withSource(materializeFeedbackView({ root: deps.root, planPath: deps.planPath, stateRoot: deps.inboxRoot }, deps.statusGithub, clock), github) }] };
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
export type AnalyticsRefresh = typeof scanAnalyticsLedger;

/**
 * The analytics refresh per instance (W1-T5055), each due once per refresh interval, while `enabled`. A pass only
 * starts the due refreshes and returns, so a scan of a minute or more never holds the inbox unit behind it. Each
 * resumes a bounded partial fold, else its last complete checkpoint, first from serve's checkpoint file.
 * Progress is private to this lane's lifetime, never a source snapshot or a write to serve's checkpoint file.
 * A refresh that throws, times out or could not read its ledger posts a failure: the worker keeps the last snapshot.
 */
function analyticsUnit(
  config: NonNullable<SlowLaneConfig["analytics"]>,
  clock: Clock,
  post: (message: SlowLaneMessage) => void,
  log: (step: string, extra?: Record<string, unknown>) => void,
  enabled: () => boolean,
  captureOwnership: () => () => boolean,
  refresh: AnalyticsRefresh,
  ownsInstance: (name: string) => boolean,
): SlowLaneUnit {
  const intervalMs = config.intervalMs ?? ANALYTICS_REFRESH_INTERVAL_MS;
  const timeoutMs = config.timeoutMs ?? ANALYTICS_REFRESH_TIMEOUT_MS;
  const nextDue = new Map<string, number>();
  const gardenerDue = new Map<string, number>();
  let active: AbortController | undefined;
  const checkpoints = new Map<string, AnalyticsCheckpoint | undefined>();
  const progress = new Map<string, AnalyticsResumePoint>();
  const scanFields = (scan?: AnalyticsScanReport): Record<string, unknown> => scan ? {
    scan_mode: scan.mode, scan_reason: scan.reason, progress_refused: scan.progressRefused,
    rotations_read: scan.rotationsRead, rotations_remaining: scan.rotationsRemaining,
  } : {};
  let running = false;
  const refreshOne = async (instance: { name: string; stateDir: string; repository?: string }, mayPublish: () => boolean): Promise<void> => {
    const started = clock.now();
    nextDue.set(instance.name, started + intervalMs);
    const controller = new AbortController();
    active = controller;
    const timer = setTimeout(() => controller.abort(new Error(`analytics refresh exceeded ${timeoutMs} ms`)), timeoutMs);
    let work: SlowLaneWork = { unit: "analytics", instance: instance.name, phase: "read-checkpoint" };
    try {
      const held = checkpoints.has(instance.name);
      if (!held) post({ type: "begin", work });
      const prior = held ? checkpoints.get(instance.name) : readAnalyticsCheckpoint(instance.stateDir);
      work = { ...work, phase: held ? "scan" : "scan-from-disk-checkpoint" };
      post({ type: "begin", work });
      const result = await refresh(instance.stateDir, clock, controller.signal, prior, {
        progress: progress.get(instance.name), yieldAtMs: started + timeoutMs / 2,
      });
      controller.signal.throwIfAborted();
      if (!mayPublish()) {
        log("analytics.source_snapshot_withheld", { instance: instance.name, reason: "ownership-changed" });
        return;
      }
      if ("progress" in result) {
        progress.set(instance.name, result.progress);
        const finished = clock.now();
        nextDue.set(instance.name, finished + Math.max(1, finished - started));
        log("analytics.source_snapshot_progress", { instance: instance.name, ms: finished - started,
          retained_as_of: prior?.snapshot.asOf ?? null, ...scanFields(result.scan) });
        return;
      }
      const { snapshot, checkpoint } = result;
      progress.delete(instance.name);
      const unavailable = snapshot.benchmarkEvidence?.reason;
      if (unavailable === "ledger-source-unreadable") throw new Error("the ledger could not be read");
      if (unavailable?.startsWith("ledger-source-") || unavailable?.startsWith("ledger-live-")) {
        throw new Error(`analytics ledger evidence unavailable: ${unavailable}`);
      }
      checkpoints.set(instance.name, checkpoint);
      post({ type: "source_snapshot", snapshot: { instance: instance.name, ok: true, asOf: snapshot.asOf!, bodies: analyticsSourceBodies(snapshot, instance.repository) } });
      log("analytics.source_snapshot_built", { instance: instance.name, ms: clock.now() - started, asOf: snapshot.asOf, ...scanFields(result.scan) });
    } catch (error) {
      if (!mayPublish()) {
        log("analytics.source_snapshot_withheld", { instance: instance.name, reason: "ownership-changed" });
        return;
      }
      const message = String((error as Error)?.message ?? error);
      post({ type: "source_snapshot", snapshot: { instance: instance.name, ok: false, names: ANALYTICS_SOURCE_NAMES, error: message, atMs: clock.now() } });
      log("analytics.source_snapshot_failed", { instance: instance.name, ms: clock.now() - started, error: message });
    } finally {
      active = undefined;
      clearTimeout(timer);
      post({ type: "end", work });
    }
  };
  const refreshGardener = async (instance: typeof config.instances[number], mayPublish: () => boolean): Promise<void> => {
    const controller = new AbortController();
    active = controller;
    const started = clock.now();
    gardenerDue.set(instance.name, started + intervalMs);
    const timer = setTimeout(() => controller.abort(new Error(`gardener capture exceeded ${timeoutMs} ms`)), timeoutMs);
    const work = { unit: "gardener-spend", instance: instance.name, phase: "capture" };
    post({ type: "begin", work });
    try {
      const source = await captureGardenerSpendSource(instance.stateDir, clock, { signal: controller.signal, repository: instance.repository });
      controller.signal.throwIfAborted();
      if (!mayPublish() || !ownsInstance(instance.name)) return;
      if (source.reason || !source.corpusComplete || !source.observedAt) throw new Error(`gardener evidence unavailable: ${source.reason ?? "incomplete current window"}`);
      post({ type: "source_snapshot", snapshot: { instance: instance.name, ok: true, asOf: source.observedAt,
        bodies: [{ name: GARDENER_SPEND_SOURCE_NAME, body: { repository: instance.repository, source } }] } });
      log("gardener.source_snapshot_built", { instance: instance.name, asOf: source.observedAt, ms: clock.now() - started });
    } catch (error) {
      if (!mayPublish() || !ownsInstance(instance.name)) return;
      post({ type: "source_snapshot", snapshot: { instance: instance.name, ok: false, names: [GARDENER_SPEND_SOURCE_NAME],
        error: String((error as Error)?.message ?? error), atMs: clock.now() } });
      log("gardener.source_snapshot_failed", { instance: instance.name, ms: clock.now() - started });
    } finally {
      active = undefined;
      clearTimeout(timer);
      post({ type: "end", work });
    }
  };
  return {
    name: "analytics",
    cancel: () => active?.abort(new Error("analytics ownership changed")),
    run: async () => {
      if (!enabled() || running) return { views: [] };
      const mayPublish = captureOwnership();
      if (!mayPublish()) return { views: [] };
      const due = config.instances.filter((instance) => ownsInstance(instance.name) &&
        (clock.now() >= (nextDue.get(instance.name) ?? Number.NEGATIVE_INFINITY) ||
          instance.repository !== undefined && clock.now() >= (gardenerDue.get(instance.name) ?? Number.NEGATIVE_INFINITY)));
      if (due.length > 0) {
        running = true;
        void (async () => {
          try {
            for (const instance of due) {
              if (!mayPublish()) break;
              if (instance.repository !== undefined && clock.now() >= (gardenerDue.get(instance.name) ?? Number.NEGATIVE_INFINITY)) {
                await refreshGardener(instance, mayPublish);
              }
              if (mayPublish() && ownsInstance(instance.name) && clock.now() >= (nextDue.get(instance.name) ?? Number.NEGATIVE_INFINITY)) {
                await refreshOne(instance, mayPublish);
              }
            }
          } finally { running = false; }
        })();
      }
      return { views: [] };
    },
  };
}

/** A view switch mode under which the view is built: the analytics unit runs only then. */
const BUILT_MODES: ReadonlySet<unknown> = new Set(["shadow", "serve", "auto"]);

type Port = { on(event: "message", run: (msg: { type?: string; held?: unknown; modes?: unknown; instances?: unknown; ownershipEpoch?: unknown }) => void): unknown; postMessage(value: unknown): void };

function dailyProgressUnit(config: DailyProgressCollectionConfig, clock: Clock, post: (message: SlowLaneMessage) => void,
  epoch: () => number, mayRun: () => boolean, ownsInstance: (name: string) => boolean,
  log: (step: string, extra?: Record<string, unknown>) => void): SlowLaneUnit {
  let active: AbortController | undefined;
  return { name: "daily-progress", cancel: () => active?.abort(), run: async () => {
    if (active || !mayRun()) return { views: [] };
    const controller = new AbortController(), startedEpoch = epoch();
    active = controller;
    const work = { unit: "daily-progress-collection", phase: "cached-sources" };
    post({ type: "begin", work });
    // BACKSTOP: use the existing slow-source deadline; no second unbounded worker class.
    const deadline = setTimeout(() => controller.abort(), ANALYTICS_REFRESH_TIMEOUT_MS);
    deadline.unref();
    void (async () => {
      try {
        const built = await collectDailyProgress({ ...config, ownedInstanceNames: config.instances.filter(i => ownsInstance(i.name)).map(i => i.name) }, clock, controller.signal);
        if (built && !controller.signal.aborted && mayRun() && epoch() === startedEpoch) {
          post({ type: "daily_progress", publication: built.publication, ownershipEpoch: startedEpoch });
          log("read_model.daily_staged", { generation: built.manifest.generation });
        }
      } catch (error) {
        log(controller.signal.aborted ? "read_model.daily_cancelled" : "read_model.daily_failed", {
          reason: controller.signal.aborted ? "ownership changed or collection deadline elapsed" : String((error as Error).message).slice(0, 2048),
        });
      } finally { clearTimeout(deadline); active = undefined; post({ type: "end", work }); }
    })();
    return { views: [] };
  } };
}

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
  let held = false;
  let running = false;
  let stopped = false;
  let ownedInstances = new Set<string>();
  let leaseEpoch = 0;
  let analyticsEpoch = 0;
  let codeHealthEpoch = 0;
  const post = (message: SlowLaneMessage): void => port.postMessage(message);
  const analytics = data.analytics
    ? [analyticsUnit(data.analytics, clock, post, log, () => BUILT_MODES.has(modes[ANALYTICS_VIEW_NAME]), () => {
      const leaseAtStart = leaseEpoch, viewAtStart = analyticsEpoch;
      return () => !stopped && held && leaseEpoch === leaseAtStart && analyticsEpoch === viewAtStart && BUILT_MODES.has(modes[ANALYTICS_VIEW_NAME]);
    }, opts.analyticsRefresh ?? scanAnalyticsLedger, name => ownedInstances.has(name))]
    : [];
  const daily = data.dailyProgress ? [dailyProgressUnit(data.dailyProgress, clock, post, () => leaseEpoch,
    () => !stopped && held, name => ownedInstances.has(name), log)] : [];
  const codeHealth = data.codeHealth ? createCodeHealthCollectionUnit(data.codeHealth, { clock, log, ownsInstance: name => ownedInstances.has(name), captureOwnership: () => {
    const epoch = leaseEpoch, viewEpoch = codeHealthEpoch;
    return () => !stopped && held && leaseEpoch === epoch && codeHealthEpoch === viewEpoch && BUILT_MODES.has(modes[CODE_HEALTH_VIEW_NAME]);
  } }) : undefined;
  const units: SlowLaneUnit[] = [...(data.inbox ? coreUnits(data.inbox, clock, log, opts.inbox ?? {}) : []),
    ...(data.instanceInboxes ?? []).map(config => instanceInboxUnit(config, clock, () => {
      const startedEpoch = leaseEpoch;
      return () => !stopped && held && ownedInstances.has(config.instance) && leaseEpoch === startedEpoch;
    }, log)),
    ...(data.accountUsage ? [creditEdgeUnit(data.accountUsage, log)] : []), ...analytics, ...daily, ...(codeHealth ? [codeHealth] : [])];
  let cancel: () => void = () => {};
  const pass = async (): Promise<void> => {
    cancel = () => {};
    if (held && !running) {
      running = true;
      for (const unit of units) {
        if (unit.instance && (!held || !ownedInstances.has(unit.instance))) continue;
        const started = clock.now();
        const work: SlowLaneWork = { unit: unit.name, ...(unit.instance ? { instance: unit.instance } : {}), phase: "run" };
        port.postMessage({ type: "begin", work } satisfies SlowLaneMessage);
        let ok = true;
        try {
          for (const built of (await unit.run()).views) port.postMessage({ type: "bodies", ...built } satisfies SlowLaneMessage);
        } catch (error) {
          ok = false;
          log("read_model.slow_unit_failed", { unit: unit.name, error: String((error as Error)?.message ?? error) });
        }
        port.postMessage({ type: "end", work } satisfies SlowLaneMessage);
        port.postMessage({ type: "unit", unit: unit.name, ok, ms: clock.now() - started } satisfies SlowLaneMessage);
      }
      running = false;
    }
    if (!stopped) cancel = schedule(() => void pass(), intervalMs);
  };
  port.on("message", (msg) => {
    if (msg.type === "views") {
      const next = (msg.modes ?? {}) as Record<string, unknown>;
      if (next[ANALYTICS_VIEW_NAME] !== modes[ANALYTICS_VIEW_NAME]) {
        analyticsEpoch += 1;
        for (const unit of analytics) unit.cancel?.();
      }
      if (next[CODE_HEALTH_VIEW_NAME] !== modes[CODE_HEALTH_VIEW_NAME]) codeHealthEpoch += 1;
      modes = next;
    }
    if (msg.type !== "lease") return;
    const was = held;
    const previous = [...ownedInstances].join("|");
    ownedInstances = new Set(Array.isArray(msg.instances) ? msg.instances.filter((id): id is string => typeof id === "string") : []);
    held = msg.held === true;
    const suppliedEpoch = typeof msg.ownershipEpoch === "number" && Number.isSafeInteger(msg.ownershipEpoch) && msg.ownershipEpoch >= 0 ? msg.ownershipEpoch : undefined;
    const epochChanged = suppliedEpoch !== undefined && suppliedEpoch !== leaseEpoch;
    if (was !== held || previous !== [...ownedInstances].join("|") || epochChanged) {
      leaseEpoch = suppliedEpoch ?? leaseEpoch + 1;
      for (const unit of [...analytics, ...daily]) unit.cancel?.();
    }
    if (held && (!was || previous !== [...ownedInstances].join("|")) && !running) {
      cancel();
      void pass();
    }
  });
  cancel = schedule(() => void pass(), intervalMs);
  return {
    stop: () => {
      stopped = true;
      for (const unit of [...analytics, ...daily]) unit.cancel?.();
      cancel();
    },
  };
}

if (!isMainThread && (workerData as { kind?: unknown } | undefined)?.kind === SLOW_LANE_KIND && parentPort) {
  runSlowLaneWorker(parentPort, workerData as SlowLaneData);
}

export interface SlowLane {
  /** Whether this serve holds the home lease; the thread is spawned the first time it does. */
  lease(held: boolean, instances?: readonly string[], ownershipEpoch?: number): void;
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
  onDailyProgress?: (publication: DailyProgressPublication, ownershipEpoch: number) => void;
  /** Times the work in flight when the thread dies. */
  clock?: Clock;
}): SlowLane {
  const clock = opts.clock ?? systemClock;
  const baseMs = opts.config.intervalMs ?? INBOX_CLASSIFY_INTERVAL_MS;
  let worker: Worker | undefined;
  let held = false;
  let ownedInstances: readonly string[] = [];
  let ownershipEpoch: number | undefined;
  let modes: Record<string, string> = {};
  let deaths = 0;
  let closed = false;
  let respawn: NodeJS.Timeout | undefined;
  const spawn = (): void => {
    const data: SlowLaneData = { ...opts.config, kind: SLOW_LANE_KIND };
    const spawned = startWorker(import.meta.url, { workerData: data, resourceLimits: { maxOldGenerationSizeMb: SLOW_LANE_HEAP_MB } }, { override: opts.workerUrl });
    worker = spawned;
    spawned.unref();
    // What the thread said it was doing, held HERE, so a thread that dies mid-unit still names it.
    const inFlight = new Map<string, SlowLaneWork & { sinceMs: number }>();
    const inFlightNow = (): Array<SlowLaneWork & { runningMs: number }> =>
      [...inFlight.values()].map(({ sinceMs, ...work }) => ({ ...work, runningMs: clock.now() - sinceMs }));
    let termination: string | undefined;
    // Ahead of the lease, so a thread's first pass already knows which views are switched on.
    spawned.postMessage({ type: "views", modes });
    spawned.on("message", (msg: SlowLaneMessage) => {
      if (msg.type === "begin") inFlight.set(`${msg.work.unit}|${msg.work.instance ?? ""}`, { ...msg.work, sinceMs: clock.now() });
      else if (msg.type === "end") inFlight.delete(`${msg.work.unit}|${msg.work.instance ?? ""}`);
      else if (msg.type === "log") opts.log(msg.step, msg.extra);
      else if (msg.type === "bodies") opts.onBodies?.({ view: msg.view, version: msg.version, bodies: msg.bodies });
      else if (msg.type === "source_snapshot") opts.onSnapshot?.(msg.snapshot);
      else if (msg.type === "daily_progress") {
        if (worker === spawned && held && msg.ownershipEpoch === ownershipEpoch) opts.onDailyProgress?.(msg.publication, msg.ownershipEpoch);
      }
      else if (msg.ok) deaths = 0;
    });
    spawned.on("error", (error: Error & { code?: unknown }) => {
      // Node's own code (ERR_WORKER_OUT_OF_MEMORY on a heap death), else the thrown error's name: not every death is an OOM.
      termination = typeof error?.code === "string" ? error.code : String(error?.name ?? "error");
      opts.log("read_model.slow_lane_failed", { error: String(error?.message ?? error), termination, inFlight: inFlightNow() });
    });
    spawned.on("exit", (code) => {
      if (worker !== spawned || closed) return;
      worker = undefined;
      deaths++;
      const delayMs = Math.min(baseMs * 2 ** deaths, SLOW_LANE_MAX_RESPAWN_MS);
      opts.log("read_model.slow_lane_exited", { code, termination: termination ?? "exit", inFlight: inFlightNow(), deaths, respawnInMs: delayMs });
      respawn = setTimeout(() => {
        respawn = undefined;
        if (closed) return;
        spawn();
        worker?.postMessage({ type: "lease", held, instances: ownedInstances, ...(ownershipEpoch === undefined ? {} : { ownershipEpoch }) });
      }, delayMs);
      respawn.unref();
    });
  };
  return {
    lease: (now, instances = [], nextEpoch) => {
      const sameOwners = now === held && JSON.stringify(instances) === JSON.stringify(ownedInstances);
      const incomingEpoch = nextEpoch ?? (opts.config.dailyProgress ? sameOwners ? ownershipEpoch : (ownershipEpoch ?? 0) + 1 : undefined);
      if (closed || sameOwners && incomingEpoch === ownershipEpoch) return;
      held = now;
      ownedInstances = [...instances];
      ownershipEpoch = incomingEpoch;
      if (held && !worker && respawn === undefined) spawn();
      worker?.postMessage({ type: "lease", held, instances: ownedInstances, ...(ownershipEpoch === undefined ? {} : { ownershipEpoch }) });
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


/** Daily cached assessments share the leased slow lane, independently of Analytics. */
export function createCodeHealthCollectionUnit(config: NonNullable<SlowLaneConfig["codeHealth"]>, opts: {
  clock: Clock; captureOwnership: () => () => boolean; ownsInstance: (name: string) => boolean;
  log: (step: string, extra?: Record<string, unknown>) => void;
  collect?: typeof collectCodeHealth;
}): SlowLaneUnit {
  const nextDue = new Map<string, number>(); let cursor = 0;
  return { name: "code-health", run: async () => {
    const mayPublish = opts.captureOwnership();
    if (!mayPublish()) return { views: [] };
    const inventory = readCodeHealthInventory(config.stateDir), repositories = inventory.repositories;
    for (let visited = 0; visited < repositories.length; visited++) {
      const member = repositories[cursor % repositories.length]!; cursor = (cursor + 1) % repositories.length;
      const instance = config.instances.filter(instance => instance.repository?.toLowerCase() === member.repository && member.instanceIds.includes(instance.name) && opts.ownsInstance(instance.name)).sort((a, b) => a.name.localeCompare(b.name))[0];
      if (!instance) continue;
      const repository = member.repository, stateDir = codeHealthRepositoryStateDir(config.stateDir, repository), now = opts.clock.now();
      const saved = readCodeHealthSnapshot(stateDir, repository), failure = readCodeHealthCollectionFailure(stateDir, repository);
      const attempt = Math.max(saved.state === "observed" && saved.latestAttemptAt ? Date.parse(saved.latestAttemptAt) : Number.NEGATIVE_INFINITY,
        failure.state === "failed" ? Date.parse(failure.startedAt) : Number.NEGATIVE_INFINITY);
      if (now < Math.max(nextDue.get(repository) ?? Number.NEGATIVE_INFINITY, attempt + CODE_HEALTH_INTERVAL_MS)) continue;
      const owns = () => mayPublish() && opts.ownsInstance(instance.name);
      if (!owns()) break;
      // One repository per existing lane pass bounds the burst and leaves its other units first.
      nextDue.set(repository, now + CODE_HEALTH_INTERVAL_MS);
      const result = await (opts.collect ?? collectCodeHealth)({ stateDir, repository, coverageStateDir: instance.stateDir, clock: opts.clock, mayPublish: owns });
      if (result.state === "busy" || result.state === "superseded") nextDue.set(repository, now + INBOX_CLASSIFY_INTERVAL_MS);
      opts.log("code_health.collection", { repository, state: result.state, ...(owns() ? {} : { reason: "ownership_changed" }) });
      break;
    }
    return { views: [] };
  } };
}
