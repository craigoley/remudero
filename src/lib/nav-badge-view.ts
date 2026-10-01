/**
 * `GET /v1/views/nav-badge` — the console sidebar's counts in one read of a few hundred bytes (arch
 * plan 0.4). The chrome's `useAgentBadgeCount` fetched analytics, proposal history, settings and
 * settings-by-scope (~12 upstream reads, ~370 KB) on every page view, then re-derived operator-agent
 * proposals in the browser's server route only to count them.
 *
 * THE AGENT COUNT IS A PORT, pinned to the console's `src/lib/agent.ts` `generateProposals` and
 * `buildAgentSnapshot` and `src/hooks/use-agent.ts` `visibleProposals` at remudero-console b66762a.
 * It keeps their thresholds, confidence arithmetic, preference adjustment, proposal ids,
 * terminal-history exclusion and settings filter, and nothing else. `agent.proposalIds` travels
 * with the count so the console can compare its own engine's visible ids against this one until
 * Phase 1 makes core the only engine.
 *
 * Inputs are caches this process already keeps: the analytics snapshot (15-minute refresh), the
 * operator-agent memory folded from it, and the inbox classification `GET /v1/inbox` writes. A cold
 * input makes its count absent with a reason, never a zero.
 */
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { ANALYTICS_REFRESH_INTERVAL_MS, ANALYTICS_REFRESH_TIMEOUT_MS, type AnalyticsSnapshot } from "./analytics-route.js";
import { systemClock, type Clock } from "./clock.js";
import { classificationSnapshotPath, readClassificationSnapshot } from "./fleet-lane.js";
import { writeAtomic } from "./fs-race-safe.js";
import { inboxOwner } from "./inbox-owner.js";
import {
  OPERATOR_AGENT_DECISION_STEP,
  OPERATOR_AGENT_OUTCOME_STEP,
  OPERATOR_AGENT_PROPOSAL_STEP,
  OPERATOR_AGENT_SETTINGS_STEP,
  readOperatorAgentHistory,
  readOperatorAgentSettings,
  selectOperatorAgentMemoryRow,
  type OperatorAgentHistory,
  type OperatorAgentMemoryLedgerRow,
  type OperatorAgentMemorySource,
  type OperatorAgentSettings,
} from "./operator-agent.js";
import { READ_MODEL_DIRNAME, type ReadModelDb } from "./read-model-db.js";
import type { ViewDefinition, ViewSource } from "./views.js";

export const NAV_BADGE_VIEW_VERSION = 1;

/** The console engine's thresholds (agent.ts `AGENT_THRESHOLDS`). */
const THRESHOLDS = { minimumRuns: 5, highTokensPerRun: 50_000, queuedTasks: 5, slowP50Ms: 5 * 60 * 1000, highWorkerFailureRate: 0.4 } as const;

/** An analytics snapshot older than two refresh cycles plus a timed-out scan has missed a refresh. */
const ANALYTICS_STALE_AFTER_MS = 2 * ANALYTICS_REFRESH_INTERVAL_MS + ANALYTICS_REFRESH_TIMEOUT_MS;

/** Serve's slow lane rewrites the classification at least every half of this, with or without a reader (inbox-view.ts). */
export const INBOX_STALE_AFTER_MS = 10 * 60_000;

/** How many visible proposal ids ride with the agent count. */
const MAX_PROPOSAL_IDS = 20;

export interface NavBadgeData {
  /** `count` when every instance was counted, `atLeast` when only some were (a floor, never a total). */
  agent: {
    count?: number;
    atLeast?: number;
    proposalIds: string[];
    instances: Array<{ instanceId: string; repository?: string; count?: number; reason?: string }>;
    reason?: string;
  };
  inbox: { ready?: number; needsYou?: number; fleet?: number; reason?: string };
}

type Candidate = { proposalId: string; category: string; signal: string; confidence: number };

type OperatorAgentProjection = AnalyticsSnapshot["consoleV1"]["operatorAgent"];

/** The slice of an analytics snapshot the agent badge reads, and all the read model persists of it. */
export interface NavBadgeAnalytics {
  asOf: string | null;
  consoleV1: {
    metrics: AnalyticsSnapshot["consoleV1"]["metrics"];
    operatorAgent: {
      proof: OperatorAgentProjection["proof"];
      outcomes: Pick<OperatorAgentProjection["outcomes"], "classes">;
      decisions: Pick<OperatorAgentProjection["decisions"], "classes">;
      capacity: Pick<OperatorAgentProjection["capacity"], "measurements">;
    };
  };
  routingTelemetry: Pick<AnalyticsSnapshot["routingTelemetry"], "buckets">;
}

export function navBadgeAnalyticsSlice(snapshot: NavBadgeAnalytics): NavBadgeAnalytics {
  const agent = snapshot.consoleV1.operatorAgent;
  return {
    asOf: snapshot.asOf,
    consoleV1: {
      metrics: snapshot.consoleV1.metrics,
      operatorAgent: { proof: agent.proof, outcomes: { classes: agent.outcomes.classes }, decisions: { classes: agent.decisions.classes }, capacity: { measurements: agent.capacity.measurements } },
    },
    routingTelemetry: { buckets: snapshot.routingTelemetry.buckets },
  };
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "repo";
}

function scopeToken(value: string): string {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `${slug(value).slice(0, 32)}-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function clamp(value: number): number {
  return Math.max(0, Math.min(0.98, value));
}

function confidence(runs: number | undefined, signalCount: number, severity: number): number {
  const sample = runs !== undefined ? Math.min(0.025, Math.log10(Math.max(1, runs)) * 0.025) : 0;
  return clamp(0.86 + sample + Math.min(0.075, Math.max(0, signalCount) * 0.025) + Math.min(0.035, Math.max(0, severity)));
}

function signalOf(proposalId: string): string {
  return proposalId.split(":").at(-1) ?? proposalId;
}

function preferenceAdjustment(history: readonly OperatorAgentHistory[], category: string, signal: string): number {
  let adjustment = 0;
  for (const proposal of history) {
    if (proposal.category !== category || signalOf(proposal.proposalId) !== signal) continue;
    for (const decision of proposal.decisionHistory) {
      if (decision.decision === "accepted") adjustment += 0.01;
      if (decision.decision === "rejected") adjustment -= 0.08;
    }
    if (proposal.outcome?.helped === true) adjustment += 0.015;
    if (proposal.outcome?.helped === false) adjustment -= 0.06;
  }
  return Math.max(-0.12, Math.min(0.06, adjustment));
}

/** Every proposal the console engine would generate for one instance, before visibility filtering. */
export function operatorAgentCandidates(
  snapshot: NavBadgeAnalytics,
  scope: { repository: string; instanceId: string },
  history: readonly OperatorAgentHistory[],
): Candidate[] {
  const metrics = new Map<string, number>();
  for (const m of snapshot.consoleV1.metrics) if (m.value !== null && Number.isFinite(m.value)) metrics.set(m.key, m.value);
  const runs = metrics.get("runs.completed");
  const tokens = metrics.get("tokens.total");
  const duration = metrics.get("duration.p50.ms");
  const queue = metrics.get("queue.pending");
  const repoHistory = history.filter((entry) => entry.repo === scope.repository);
  const out: Candidate[] = [];
  const add = (category: string, signal: string, score: number): void => {
    out.push({
      proposalId: `operator-agent:${slug(scope.repository)}:${scopeToken(scope.instanceId)}:${category}:${signal}`,
      category,
      signal,
      confidence: Number(clamp(score + preferenceAdjustment(repoHistory, category, signal)).toFixed(3)),
    });
  };

  const tokensPerRun = runs !== undefined && tokens !== undefined && runs > 0 ? tokens / runs : undefined;
  if (runs !== undefined && tokensPerRun !== undefined && runs >= THRESHOLDS.minimumRuns && tokensPerRun >= THRESHOLDS.highTokensPerRun) {
    add("optimize", "token-burn", confidence(runs, 2, 0.02));
  }
  if (runs !== undefined && duration !== undefined && runs >= THRESHOLDS.minimumRuns && duration >= THRESHOLDS.slowP50Ms) {
    const scale = queue !== undefined && queue >= THRESHOLDS.queuedTasks;
    add(scale ? "scale" : "fix", scale ? "queue-pressure" : "slow-runs", confidence(runs, scale ? 3 : 2, scale ? 0.035 : 0.02));
  }
  for (const bucket of snapshot.routingTelemetry.buckets) {
    if (bucket.terminalResults < THRESHOLDS.minimumRuns || bucket.failures / bucket.terminalResults < THRESHOLDS.highWorkerFailureRate) continue;
    add("fix", `worker-failure-rate-${bucket.taskType}-${bucket.assignedModel}`, confidence(runs, 3, 0.03));
  }
  const agent = snapshot.consoleV1.operatorAgent;
  const proof = agent.proof;
  if (proof.status === "measured" && proof.denominator !== null && proof.passRate !== null && proof.denominator >= THRESHOLDS.minimumRuns) {
    const failing = 1 - proof.passRate >= 0.2;
    add(failing ? "fix" : "optimize", failing ? "proof-failure-rate" : "proof-pass-rate", confidence(runs, 3, failing ? 0.03 : 0.015));
  }
  for (const outcome of agent.outcomes.classes) {
    if (outcome.total < THRESHOLDS.minimumRuns || outcome.revertRate === null || outcome.revertRate < 0.2) continue;
    add("fix", `revert-rate-${slug(outcome.verdictClass)}`, confidence(runs, 3, 0.035));
  }
  for (const decision of agent.decisions.classes) {
    if (decision.approvalDenominator < THRESHOLDS.minimumRuns || decision.approvalRate === null || decision.approvalRate < 0.95 || decision.rejectedCount > 0) continue;
    add("optimize", `approval-pattern-${slug(decision.taskClass)}`, confidence(runs, 3, 0.025));
  }
  for (const capacity of agent.capacity.measurements) {
    if (capacity.recommendation !== "scale-up" && capacity.recommendation !== "underutilized") continue;
    add(capacity.recommendation === "scale-up" ? "scale" : "optimize", `capacity-${capacity.recommendation}-${slug(capacity.repo)}`, confidence(runs, 4, 0.035));
  }
  return out;
}

/** The proposals the console's badge counts: generated, not terminal in history, and above the scope's threshold. */
export function visibleOperatorAgentProposals(candidates: readonly Candidate[], history: readonly OperatorAgentHistory[], settings: OperatorAgentSettings): string[] {
  const terminal = new Set(history.filter((entry) => entry.status !== "pending").map((entry) => entry.proposalId));
  return candidates
    .filter((c) => !terminal.has(c.proposalId) && settings.enabled && c.confidence >= settings.confidenceThreshold)
    .sort((a, b) => b.confidence - a.confidence || a.proposalId.localeCompare(b.proposalId))
    .map((c) => c.proposalId);
}

function sourceAge(asOf: string | null, nowMs: number, staleAfterMs: number): ViewSource["state"] {
  if (asOf === null) return "unavailable";
  return nowMs - Date.parse(asOf) > staleAfterMs ? "stale" : "fresh";
}

/** One daemon instance the agent badge covers: its analytics, its operator-agent memory, its ledger. */
export interface NavBadgeScope {
  instanceId: string;
  repository?: string;
  analytics: () => AnalyticsSnapshot;
  memory?: OperatorAgentMemorySource;
  ledgerPath: string;
}

type InstanceBadge = NavBadgeData["agent"]["instances"][number];
type CountedInstance = { badge: InstanceBadge; ids: string[] };

/** What one instance's count needs; `memory` is its operator-agent rows, or why they cannot be read. */
interface InstanceInputs {
  instanceId: string;
  repository?: string;
  analytics: NavBadgeAnalytics | null;
  memory: () => { rows: readonly OperatorAgentMemoryLedgerRow[] } | { reason: string };
}

function countInstance(input: InstanceInputs, nowMs: number, sources: ViewSource[]): CountedInstance {
  const analyticsState = sourceAge(input.analytics?.asOf ?? null, nowMs, ANALYTICS_STALE_AFTER_MS);
  sources.push({ name: `analytics:${input.instanceId}`, asOf: input.analytics?.asOf ?? null, state: analyticsState, kind: "analytics", budgetMs: ANALYTICS_STALE_AFTER_MS });
  const base = { instanceId: input.instanceId, ...(input.repository ? { repository: input.repository } : {}) };
  if (input.repository === undefined) return { badge: { ...base, reason: "serve names no repository for this instance" }, ids: [] };
  if (input.analytics === null || analyticsState === "unavailable") return { badge: { ...base, reason: "analytics has not completed its first refresh" }, ids: [] };
  const memory = input.memory();
  if ("reason" in memory) return { badge: { ...base, reason: memory.reason }, ids: [] };
  const opDeps = { ledgerPath: "", now: () => nowMs, memory: { current: () => ({ state: "ready" as const, asOf: null, rows: memory.rows }), record: () => undefined } };
  const history = readOperatorAgentHistory(opDeps);
  const settings = readOperatorAgentSettings(opDeps, { kind: "repository", repository: input.repository }).settings;
  const ids = visibleOperatorAgentProposals(operatorAgentCandidates(input.analytics, { repository: input.repository, instanceId: input.instanceId }, history), history, settings);
  return { badge: { ...base, count: ids.length }, ids };
}

function instanceBadge(scope: NavBadgeScope, nowMs: number, sources: ViewSource[]): CountedInstance {
  const snapshot = scope.analytics();
  return countInstance({
    instanceId: scope.instanceId,
    ...(scope.repository ? { repository: scope.repository } : {}),
    analytics: snapshot,
    memory: () => {
      const current = scope.memory?.current();
      return current?.state === "ready" ? { rows: current.rows } : { reason: "operator-agent memory has not completed its first refresh" };
    },
  }, nowMs, sources);
}

/** The instance counts summed: `count` when every instance was counted, else `atLeast` and a reason. */
function sumAgent(counted: readonly CountedInstance[]): NavBadgeData["agent"] {
  const known = counted.filter((c) => c.badge.count !== undefined);
  const total = known.reduce((sum, c) => sum + (c.badge.count ?? 0), 0);
  return {
    ...(known.length === counted.length ? { count: total } : known.length > 0 ? { atLeast: total } : {}),
    proposalIds: counted.flatMap((c) => c.ids).slice(0, MAX_PROPOSAL_IDS),
    instances: counted.map((c) => c.badge),
    ...(known.length < counted.length ? { reason: `${counted.length - known.length} of ${counted.length} instances not counted` } : {}),
  };
}

type Classification = ReturnType<typeof readClassificationSnapshot>;

function inboxCounts(classified: Classification, nowMs: number, sources: ViewSource[]): NavBadgeData["inbox"] {
  sources.push({
    name: "inbox-classification", asOf: classified?.generatedAt ?? null, state: classified ? sourceAge(classified.generatedAt, nowMs, INBOX_STALE_AFTER_MS) : "unavailable",
    kind: "inbox-store", budgetMs: INBOX_STALE_AFTER_MS,
  });
  if (!classified) return { reason: "no inbox classification has been written yet" };
  let ready = 0;
  let needsYou = 0;
  let fleet = 0;
  for (const [proposalId, state] of Object.entries(classified.states)) {
    if (state !== "ready" && state !== "drafting" && state !== "not_ready") continue;
    if (inboxOwner({ id: proposalId }) === "fleet") fleet += 1;
    else {
      needsYou += 1;
      if (state === "ready") ready += 1;
    }
  }
  return { ready, needsYou, fleet };
}

/** `?instances=a,b` narrows to those instances; a name serve does not have is an error. */
function selectInstances<T extends { instanceId: string }>(all: readonly T[], params: URLSearchParams): T[] | { error: string } {
  const asked = params.get("instances")?.split(",").map((name) => name.trim()).filter(Boolean);
  const unknown = (asked ?? []).filter((name) => !all.some((scope) => scope.instanceId === name));
  if (unknown.length > 0) return { error: `unknown instance: ${unknown.join(",")}; serve has ${all.map((s) => s.instanceId).join(",")}` };
  return asked ? all.filter((scope) => asked.includes(scope.instanceId)) : [...all];
}

/** The nav-badge view over serve's own caches, every instance by default or `?instances=a,b`. */
export function navBadgeView(deps: { scopes: () => readonly NavBadgeScope[]; inboxRoot: string; clock?: Clock }): ViewDefinition<NavBadgeData> {
  return {
    name: "nav-badge",
    version: NAV_BADGE_VIEW_VERSION,
    compute: (params) => {
      const nowMs = (deps.clock ?? systemClock).now();
      const scopes = selectInstances(deps.scopes(), params);
      if ("error" in scopes) return scopes;
      const sources: ViewSource[] = [];
      const agent = sumAgent(scopes.map((scope) => instanceBadge(scope, nowMs, sources)));
      const inbox = inboxCounts(readClassificationSnapshot(join(deps.inboxRoot, "state")), nowMs, sources);
      return { data: { agent, inbox }, sources };
    },
  };
}

// ---- Phase 1 (P1-07): the same view materialized by the read-model worker ----

/** Serve's main thread publishes the badge's non-ledger inputs here; the worker reads them on mtime. */
export const NAV_BADGE_SOURCES_FILE = "nav-badge-sources.json";
/** How often serve checks its analytics caches for a newer slice to publish. */
export const NAV_BADGE_SOURCES_PUBLISH_MS = 5_000;
const OPERATOR_AGENT_MEMORY_STEPS = [OPERATOR_AGENT_PROPOSAL_STEP, OPERATOR_AGENT_DECISION_STEP, OPERATOR_AGENT_OUTCOME_STEP, OPERATOR_AGENT_SETTINGS_STEP];

/** The published inputs: each scope's persisted analytics slice, and where the inbox classification lives. */
export interface NavBadgeSources {
  inboxStateDir: string;
  instances: Array<{ instanceId: string; repository?: string; analytics: NavBadgeAnalytics | null }>;
}

export function navBadgeSourcesPath(stateDir: string): string {
  return join(stateDir, READ_MODEL_DIRNAME, NAV_BADGE_SOURCES_FILE);
}

function readNavBadgeSources(path: string): NavBadgeSources | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as NavBadgeSources;
  } catch {
    // deliberate: an absent or half-written file reads as no published inputs; every instance then reads cold with its reason.
    return undefined;
  }
}

/**
 * Writes the badge's non-ledger inputs for the worker whenever one changes. A scope whose analytics
 * is cold keeps the slice this file already holds, so a restarted serve never unpublishes the last
 * good analytics: the worker counts from it while the new process's first refresh runs.
 */
export function createNavBadgeSourcePublisher(opts: { stateDir: string; inboxStateDir: string; scopes: () => readonly NavBadgeScope[] }): () => boolean {
  const path = navBadgeSourcesPath(opts.stateDir);
  const kept = new Map((readNavBadgeSources(path)?.instances ?? []).map((instance) => [instance.instanceId, instance.analytics]));
  let written: string | undefined;
  return () => {
    const instances = opts.scopes().map((scope) => {
      const snapshot = scope.analytics();
      const analytics = snapshot.asOf === null ? kept.get(scope.instanceId) ?? null : navBadgeAnalyticsSlice(snapshot);
      kept.set(scope.instanceId, analytics);
      return { instanceId: scope.instanceId, ...(scope.repository ? { repository: scope.repository } : {}), analytics };
    });
    const text = JSON.stringify({ inboxStateDir: opts.inboxStateDir, instances } satisfies NavBadgeSources);
    if (text === written) return false;
    writeAtomic(path, text);
    written = text;
    return true;
  };
}

type PublisherTiming = { every?: (run: () => void, ms: number) => () => void; log?: (step: string, extra?: Record<string, unknown>) => void };

/** Runs a read-model source publisher now and then every {@link NAV_BADGE_SOURCES_PUBLISH_MS}, logging a failed
 *  write under `step` and trying again next time; returns the stop. */
export function startSourcePublisher(publish: () => unknown, step: string, opts: PublisherTiming): () => void {
  const run = (): void => {
    try {
      publish();
    } catch (error) {
      opts.log?.(step, { error: (error as Error).message });
    }
  };
  run();
  if (opts.every) return opts.every(run, NAV_BADGE_SOURCES_PUBLISH_MS);
  const timer = setInterval(run, NAV_BADGE_SOURCES_PUBLISH_MS);
  timer.unref();
  return () => clearInterval(timer);
}

export function startNavBadgeSourcePublisher(opts: Parameters<typeof createNavBadgeSourcePublisher>[0] & PublisherTiming): () => void {
  return startSourcePublisher(createNavBadgeSourcePublisher(opts), "read_model.nav_badge_sources_failed", opts);
}

/** A file read again only when its mtime moves. */
export function readOnMtimeChange<T>(read: (path: string) => T): (path: string) => T | undefined {
  let last: { path: string; mtimeMs: number; value: T } | undefined;
  return (path) => {
    let mtimeMs: number;
    try {
      mtimeMs = statSync(path).mtimeMs;
    } catch {
      // deliberate: an absent input is cold, and each reader turns that into its own reason.
      last = undefined;
      return undefined;
    }
    if (last?.path !== path || last.mtimeMs !== mtimeMs) last = { path, mtimeMs, value: read(path) };
    return last.value;
  };
}

/** A fold reads at most this many fact `seq` per step, so a large fact delta spreads over several ticks. */
export const NAV_BADGE_FOLD_CHUNK = 50_000;

interface MemoryFold {
  /** Every fact through this `seq` has been folded. */
  seq: number;
  rows: Array<{ tsMs: number; seq: number; row: OperatorAgentMemoryLedgerRow }>;
}

/** The store's fold and its newest `seq`; a store that shrank under the fold (rebuilt in place) folds again from its first row. */
function memoryFold(folds: WeakMap<ReadModelDb, MemoryFold>, db: ReadModelDb): { fold: MemoryFold; max: number } {
  const max = Number(db.prepare("SELECT coalesce(max(seq), 0) AS m FROM fact").get()?.m);
  let fold = folds.get(db);
  if (!fold || max < fold.seq) folds.set(db, (fold = { seq: 0, rows: [] }));
  return { fold, max };
}

/** Folds the operator-agent facts past the fold's `seq` through `through`. */
function foldThrough(fold: MemoryFold, db: ReadModelDb, through: number): void {
  const fresh = db.prepare(`SELECT seq, ts_ms, body FROM fact WHERE seq > ? AND seq <= ? AND step IN (${OPERATOR_AGENT_MEMORY_STEPS.map(() => "?").join(", ")}) ORDER BY seq`)
    .all(fold.seq, through, ...OPERATOR_AGENT_MEMORY_STEPS);
  for (const fact of fresh) {
    const row = selectOperatorAgentMemoryRow(JSON.parse(String(fact.body)) as Record<string, unknown>);
    if (row) fold.rows.push({ tsMs: Number(fact.ts_ms), seq: Number(fact.seq), row });
  }
  fold.seq = through;
  if (fresh.length > 0) fold.rows.sort((a, b) => a.tsMs - b.tsMs || a.seq - b.seq);
}

/** Operator-agent rows from the fact store, folded incrementally past the last folded `seq`. */
function operatorAgentFacts(folds: WeakMap<ReadModelDb, MemoryFold>, db: ReadModelDb): readonly OperatorAgentMemoryLedgerRow[] {
  const { fold, max } = memoryFold(folds, db);
  if (max > fold.seq) foldThrough(fold, db, max);
  return fold.rows.map((entry) => entry.row);
}

/**
 * `nav-badge` materialized by the read-model worker (P1-07, design §3.3): the same count as
 * {@link navBadgeView}, with each instance's operator-agent history folded from its own read
 * model's `panel.*` facts, and its analytics from the slice serve persisted. One body for every
 * instance, and one per `?instances=<one>`. `ledgerSource` is the worker's own, passed in so this
 * module never imports the worker.
 */
export function createNavBadgeReadModelView<S extends { instance: string; tickedAt?: number }>(ledgerSource: (state: S, now: number) => ViewSource, foldChunk = NAV_BADGE_FOLD_CHUNK): {
  name: string;
  version: number;
  prepare(ctx: { instances: ReadonlyArray<{ state: S; db?: ReadModelDb }> }, more: () => boolean): boolean;
  materialize(ctx: { now: number; instances: ReadonlyArray<{ state: S; db?: ReadModelDb }> }): Array<{ key: string; data: NavBadgeData; sources: ViewSource[] }>;
} {
  const folds = new WeakMap<ReadModelDb, MemoryFold>();
  const sourcesFile = readOnMtimeChange(readNavBadgeSources);
  const classification = readOnMtimeChange((path) => readClassificationSnapshot(dirname(path)));
  return {
    name: "nav-badge",
    version: NAV_BADGE_VIEW_VERSION,
    /** Folds each projected instance's fact delta one chunk per step, so a cold fold is never one unit. */
    prepare: ({ instances }, more) => {
      for (const { state, db } of instances) {
        if (db === undefined || state.tickedAt === undefined) continue;
        const { fold, max } = memoryFold(folds, db);
        while (fold.seq < max) {
          if (!more()) return false;
          foldThrough(fold, db, Math.min(max, fold.seq + foldChunk));
        }
      }
      return true;
    },
    materialize: ({ now, instances }) => {
      const dbPath = instances.find((slot) => slot.db)?.db?.path;
      if (dbPath === undefined) return [];
      const published = sourcesFile(join(dirname(dbPath), NAV_BADGE_SOURCES_FILE));
      const inputs: InstanceInputs[] = (published?.instances ?? []).map((scope) => ({
        ...scope,
        memory: () => {
          const slot = instances.find((candidate) => candidate.state.instance === scope.instanceId);
          if (slot === undefined || slot.db === undefined) return { reason: "the read model does not project this instance" };
          if (slot.state.tickedAt === undefined) return { reason: "the read model has not projected this instance's ledger yet" };
          return { rows: operatorAgentFacts(folds, slot.db) };
        },
      }));
      const classified = published ? classification(classificationSnapshotPath(published.inboxStateDir)) : undefined;
      const body = (selected: readonly InstanceInputs[]): { data: NavBadgeData; sources: ViewSource[] } => {
        const sources: ViewSource[] = [];
        const agent = published
          ? sumAgent(selected.map((input) => countInstance(input, now, sources)))
          : { proposalIds: [], instances: [], reason: "serve has not published the badge's inputs yet" };
        for (const input of selected) {
          const slot = instances.find((candidate) => candidate.state.instance === input.instanceId);
          if (slot) sources.push(ledgerSource(slot.state, now));
        }
        const inbox = published ? inboxCounts(classified, now, sources) : { reason: "serve has not published the badge's inputs yet" };
        return { data: { agent, inbox }, sources };
      };
      return [
        { key: "", ...body(inputs) },
        ...inputs.map((input) => ({ key: `instances=${encodeURIComponent(input.instanceId)}`, ...body([input]) })),
      ];
    },
  };
}
