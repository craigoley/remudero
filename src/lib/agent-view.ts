/**
 * `agent?part=&instance=`: the agent pages' reads as materialized bodies, one per (instance, part) (arch Phase 4
 * design §1.1 and §7.1, P4-T12, W1-T5051). Each agent page read about 4N operator-agent routes across N
 * instances, every one a per-request fold, and the console ran a second proposal engine beside core's.
 *
 * AGREEMENT BY CONSTRUCTION: each part is computed by the readers its GET /v1/operator-agent/* route calls,
 * over the instance's `panel.*` facts standing in for the ledger ({@link withOperatorAgentRows}). `proposals`
 * is core's one engine (nav-badge-view.ts `operatorAgentCandidates`) over the instance's committed analytics
 * `source_snapshot` and its history; with no snapshot it carries a reason, never a confident empty list.
 *
 * THE FOLD is persisted per instance (`agent_fold`, read-model-db.ts `createAgentFolds`): only facts past its
 * `seq` are read, one bounded chunk per `prepare` step, and the state commits with the `seq` it consumed. A
 * restart resumes from the committed pair; a refused commit keeps the in-memory fold and the last whole pair,
 * so no fact is discarded. The nav badge counts from the same fold ({@link AGENT_FOLDS}).
 */
import { join } from "node:path";
import { analyticsSource, ANALYTICS_SOURCE_CONSOLE_V1, ANALYTICS_SOURCE_SIGNALS, type AnalyticsConsoleSource, type AnalyticsInstanceInput } from "./analytics-view.js";
import type { AnalyticsSnapshot } from "./analytics-route.js";
import { AUTOMATION_ACTION_VERSION } from "./automation-action.js";
import { clockFromMillisFn } from "./clock.js";
import { DELEGATION_PROFILE_VERSION, projectDelegationProfile } from "./delegation-profile.js";
import { followUpHistoryFromRows } from "./follow-up-policy.js";
import { LEDGER_FILENAME } from "./ledger-path.js";
import { createLedgerRotationMemo, readLedgerUnionRecordsSync, type LedgerRotationMemo } from "./ledger-union.js";
import { operatorAgentCandidates, visibleOperatorAgentProposals, type NavBadgeAnalytics } from "./nav-badge-view.js";
import type { NowInstance } from "./now-view.js";
import {
  readDelegationProfiles,
  readOperatorAgentActions,
  readOperatorAgentExperiments,
  readOperatorAgentHistory,
  readOperatorAgentIntentPlans,
  readOperatorAgentPromotions,
  readOperatorAgentSettings,
  readPendingConsequences,
  withOperatorAgentRows,
} from "./operator-agent.js";
import { AGENT_FOLDS, readSourceSnapshotBody, sourceSnapshotStates, type AgentFolds, type AgentFoldSlot, type ReadModelDb, type ReadModelLease } from "./read-model-db.js";
import type { ShadowLegacy } from "./view-shadow.js";
import { viewKey, type ViewSource } from "./views.js";

export const AGENT_VIEW_NAME = "agent";
export const AGENT_VIEW_VERSION = 1;
/** A part's time-dependent states (expiry, staleness) are recomputed at least this often with no new fact. */
export const AGENT_CLOCK_MS = 60_000;

/** Every part, and the route whose body it is (`proposals` is the engine the nav badge counts). */
export const AGENT_VIEW_PARTS = {
  proposals: "/v1/views/nav-badge",
  history: "/v1/operator-agent/proposals",
  settings: "/v1/operator-agent/settings",
  experiments: "/v1/operator-agent/experiments",
  delegations: "/v1/operator-agent/delegations",
  "follow-ups": "/v1/operator-agent/follow-ups",
  promotions: "/v1/operator-agent/promotions",
  actions: "/v1/operator-agent/actions",
  consequences: "/v1/operator-agent/consequences",
  "intent-plans": "/v1/operator-agent/intent-plans",
} as const;
export type AgentViewPart = keyof typeof AGENT_VIEW_PARTS;

type Row = Record<string, unknown>;
type Candidate = ReturnType<typeof operatorAgentCandidates>[number];

/** One body: what the part's route answers for this instance; `settings` adds its repository-scoped read. */
export interface AgentViewData {
  instance: string;
  part: AgentViewPart;
  repository?: string;
  body: unknown;
  scoped?: unknown;
}

/** The `proposals` part: the visible proposals, or why none can be generated. */
export interface AgentProposalsBody {
  proposals?: Candidate[];
  reason?: string;
}

/** One instance's committed analytics, as the proposal engine reads it; undefined before a first refresh. */
type AgentAnalytics = { asOf: string; analytics: NavBadgeAnalytics; console: AnalyticsConsoleSource };

/** Every part's body for one instance over `rows`, computed by the readers its route calls. */
export function agentPartBodies(input: { ledgerDir: string; instance: string; repository?: string; now: number; rows: readonly Row[]; analytics?: AgentAnalytics }): Record<AgentViewPart, Omit<AgentViewData, "instance" | "part">> {
  const deps = { ledgerPath: join(input.ledgerDir, LEDGER_FILENAME), now: () => input.now };
  const repository = input.repository;
  return withOperatorAgentRows(deps.ledgerPath, input.rows, () => {
    const history = readOperatorAgentHistory(deps);
    const scoped = repository === undefined ? undefined : readOperatorAgentSettings(deps, { kind: "repository", repository });
    const clock = clockFromMillisFn(deps.now);
    const at = (body: unknown) => ({ ...(repository ? { repository } : {}), body });
    return {
      proposals: at(proposalsBody(input, history, scoped?.settings)),
      history: at({ proposals: history, source: "ledger" }),
      settings: { ...at(readOperatorAgentSettings(deps)), ...(scoped ? { scoped } : {}) },
      experiments: at({ experiments: readOperatorAgentExperiments(deps), source: "ledger" }),
      delegations: at({ version: DELEGATION_PROFILE_VERSION, profiles: readDelegationProfiles(deps).map((state) => projectDelegationProfile(state, clock)), source: "ledger" }),
      "follow-ups": at({ followUps: followUpHistoryFromRows(input.rows, input.now), source: "ledger" }),
      promotions: at({ promotions: readOperatorAgentPromotions(deps), source: "ledger" }),
      actions: at({ version: AUTOMATION_ACTION_VERSION, actions: readOperatorAgentActions(deps), source: "ledger" }),
      consequences: at(readPendingConsequences(deps)),
      "intent-plans": at(readOperatorAgentIntentPlans(deps)),
    };
  });
}

function proposalsBody(input: { instance: string; repository?: string; analytics?: AgentAnalytics }, history: ReturnType<typeof readOperatorAgentHistory>, settings: ReturnType<typeof readOperatorAgentSettings>["settings"] | undefined): AgentProposalsBody {
  if (input.repository === undefined || settings === undefined) return { reason: "serve names no repository for this instance" };
  if (input.analytics === undefined) return { reason: "no analytics refresh has completed yet, so no proposal is generated" };
  const candidates = operatorAgentCandidates(input.analytics.analytics, { repository: input.repository, instanceId: input.instance }, history);
  const byId = new Map(candidates.map((candidate) => [candidate.proposalId, candidate]));
  return { proposals: visibleOperatorAgentProposals(candidates, history, settings).map((id) => byId.get(id)!) };
}

/**
 * The proposal engine's input from the home store's committed `console-v1` and `signals` rows (one refresh
 * commits both), parsed again only when their as-of moved, and the `analytics:<i>` source judged from them.
 */
function committedAnalytics(home: ReadModelDb, instance: string, held: Map<string, AgentAnalytics>, now: number): { analytics?: AgentAnalytics; source: ViewSource } {
  const row = sourceSnapshotStates(home, ANALYTICS_SOURCE_CONSOLE_V1).find((state) => state.instance === instance);
  if (row?.asOf && held.get(instance)?.asOf !== row.asOf) {
    const consoleV1 = readSourceSnapshotBody(home, instance, ANALYTICS_SOURCE_CONSOLE_V1) as AnalyticsConsoleSource;
    const signals = readSourceSnapshotBody(home, instance, ANALYTICS_SOURCE_SIGNALS) as { routingTelemetry: AnalyticsSnapshot["routingTelemetry"] };
    held.set(instance, { asOf: row.asOf, console: consoleV1, analytics: { asOf: row.asOf, consoleV1: consoleV1.projection, routingTelemetry: signals.routingTelemetry } });
  }
  const analytics = row?.asOf ? held.get(instance) : undefined;
  const input: AnalyticsInstanceInput = {
    instanceId: instance,
    ...(analytics ? { snapshot: { asOf: analytics.asOf, console: analytics.console } } : {}),
    ...(row?.error ? { failure: { error: row.error, atMs: Number(row.errorMs) } } : {}),
  };
  return { ...(analytics ? { analytics } : {}), source: analyticsSource(input, now) };
}

export function agentViewKey(instance: string, part: AgentViewPart): string {
  return viewKey(new URLSearchParams({ instance, part }));
}

export interface AgentViewOptions<S extends { instance: string; tickedAt?: number }> {
  instances: readonly NowInstance[];
  ledgerSource: (state: S, now: number) => ViewSource;
  folds?: AgentFolds;
  log?: (step: string, extra: Record<string, unknown>) => void;
}

/** What one instance's bodies were built from, so the shadow's legacy side reads that build's inputs. */
interface Built {
  instance: NowInstance;
  builtMs: number;
  newestTsMs: number;
  analytics?: AgentAnalytics;
}

const PANEL_ROW = /"step":"panel\./;

/** The `agent` view as the read-model worker materializes it: one body per (instance, part). */
export function createAgentView<S extends { instance: string; tickedAt?: number }>(opts: AgentViewOptions<S>): {
  name: string;
  version: number;
  snapshotSourced: true;
  prepare(ctx: { instances: ReadonlyArray<{ state: S; db?: ReadModelDb; lease?: ReadModelLease }> }, more: () => boolean): boolean;
  materialize(ctx: { now: number; instances: ReadonlyArray<{ state: S; db?: ReadModelDb; lease?: ReadModelLease }> }): Array<{ key: string; data: AgentViewData; sources: ViewSource[] }>;
  legacy(key: string, now: number, data: unknown): ShadowLegacy | undefined;
} {
  const folds = opts.folds ?? AGENT_FOLDS;
  const byName = new Map(opts.instances.map((instance) => [instance.name, instance]));
  const built = new Map<string, { memo: string; bodies: ReturnType<typeof agentPartBodies>; info: Built }>();
  const shown = new WeakMap<AgentViewData, Built>();
  const legacyMemos = new Map<string, LedgerRotationMemo>();
  const held = new WeakMap<ReadModelDb, Map<string, AgentAnalytics>>();
  const slotsOf = <T extends { state: S; db?: ReadModelDb; lease?: ReadModelLease }>(instances: readonly T[]) => instances.flatMap((slot) => {
    const instance = byName.get(slot.state.instance);
    return instance && slot.db && slot.state.tickedAt !== undefined ? [{ ...slot, db: slot.db, instance }] : [];
  });
  const foldSlot = (slot: { instance: NowInstance; db: ReadModelDb; lease?: ReadModelLease }): AgentFoldSlot => ({ instance: slot.instance.name, db: slot.db, ...(slot.lease ? { lease: slot.lease } : {}), ...(opts.log ? { log: opts.log } : {}) });
  return {
    name: AGENT_VIEW_NAME,
    version: AGENT_VIEW_VERSION,
    // A committed analytics snapshot makes the proposals part due at once.
    snapshotSourced: true,
    prepare: ({ instances }, more) => slotsOf(instances).every((slot) => folds.advance(foldSlot(slot), more)),
    materialize: ({ now, instances }) => {
      // The analytics snapshots live in the home store, as the analytics view reads them.
      const home = instances[0]?.db;
      if (home === undefined) return [];
      const parsed = held.get(home) ?? new Map<string, AgentAnalytics>();
      held.set(home, parsed);
      return slotsOf(instances).flatMap((slot) => {
        const { instance } = slot;
        const fold = folds.current(foldSlot(slot));
        const committed = committedAnalytics(home, instance.name, parsed, now);
        const memo = `${fold.seq}|${committed.analytics?.asOf ?? "-"}|${Math.floor(now / AGENT_CLOCK_MS)}`;
        let entry = built.get(instance.name);
        if (entry?.memo !== memo) {
          const input = { ledgerDir: instance.ledgerDir, instance: instance.name, ...(instance.repo ? { repository: instance.repo } : {}), now, rows: fold.rows, ...(committed.analytics ? { analytics: committed.analytics } : {}) };
          entry = { memo, bodies: agentPartBodies(input), info: { instance, builtMs: now, newestTsMs: fold.newestTsMs, ...(committed.analytics ? { analytics: committed.analytics } : {}) } };
          built.set(instance.name, entry);
          opts.log?.("agent.built", { instance: instance.name, seq: fold.seq, rows: fold.rows.length });
        }
        const ledger = opts.ledgerSource(slot.state, now);
        const { bodies, info } = entry;
        return (Object.keys(AGENT_VIEW_PARTS) as AgentViewPart[]).map((part) => {
          const data: AgentViewData = { instance: instance.name, part, ...bodies[part] };
          shown.set(data, info);
          return { key: agentViewKey(instance.name, part), data, sources: part === "proposals" ? [ledger, committed.source] : [ledger] };
        });
      });
    },
    /** The shadow side: the routes' computation over the ledger union read the routes' way, up to the fold's newest row. */
    legacy: (_key, _now, data) => {
      const view = data as AgentViewData;
      const info = shown.get(view);
      if (!info) return undefined;
      const memo = legacyMemos.get(info.instance.name) ?? createLedgerRotationMemo((rows) => rows.filter((row) => String(row.step).startsWith("panel.")), { pattern: PANEL_ROW });
      legacyMemos.set(info.instance.name, memo);
      const pass = memo.pass({ parseMissing: true });
      const union = readLedgerUnionRecordsSync(info.instance.ledgerDir, { pattern: PANEL_ROW, rotationRecords: pass.rotationRecords }).rows;
      pass.complete();
      const rows = union.filter((row) => String(row.step).startsWith("panel.") && !(Date.parse(String(row.ts)) > info.newestTsMs));
      const bodies = agentPartBodies({ ledgerDir: info.instance.ledgerDir, instance: info.instance.name, ...(info.instance.repo ? { repository: info.instance.repo } : {}), now: info.builtMs, rows, ...(info.analytics ? { analytics: info.analytics } : {}) });
      return { data: { instance: view.instance, part: view.part, ...bodies[view.part] }, asOfMs: info.builtMs };
    },
  };
}
