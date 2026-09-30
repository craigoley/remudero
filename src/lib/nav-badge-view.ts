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
import { join } from "node:path";
import { ANALYTICS_REFRESH_INTERVAL_MS, ANALYTICS_REFRESH_TIMEOUT_MS, type AnalyticsSnapshot } from "./analytics-route.js";
import { systemClock, type Clock } from "./clock.js";
import { readClassificationSnapshot } from "./fleet-lane.js";
import { inboxOwner } from "./inbox-owner.js";
import {
  readOperatorAgentHistory,
  readOperatorAgentSettings,
  type OperatorAgentHistory,
  type OperatorAgentMemorySource,
  type OperatorAgentSettings,
} from "./operator-agent.js";
import type { ViewDefinition, ViewSource } from "./views.js";

export const NAV_BADGE_VIEW_VERSION = 1;

/** The console engine's thresholds (agent.ts `AGENT_THRESHOLDS`). */
const THRESHOLDS = { minimumRuns: 5, highTokensPerRun: 50_000, queuedTasks: 5, slowP50Ms: 5 * 60 * 1000, highWorkerFailureRate: 0.4 } as const;

/** An analytics snapshot older than two refresh cycles plus a timed-out scan has missed a refresh. */
const ANALYTICS_STALE_AFTER_MS = 2 * ANALYTICS_REFRESH_INTERVAL_MS + ANALYTICS_REFRESH_TIMEOUT_MS;

/** `GET /v1/inbox` rewrites the classification on every read, and the console reads it every few seconds while open. */
const INBOX_STALE_AFTER_MS = 10 * 60_000;

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
  snapshot: Pick<AnalyticsSnapshot, "consoleV1" | "routingTelemetry">,
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

function instanceBadge(scope: NavBadgeScope, nowMs: number, sources: ViewSource[]): { badge: InstanceBadge; ids: string[] } {
  const snapshot = scope.analytics();
  const analyticsState = sourceAge(snapshot.asOf, nowMs, ANALYTICS_STALE_AFTER_MS);
  sources.push({ name: `analytics:${scope.instanceId}`, asOf: snapshot.asOf, state: analyticsState });
  const base = { instanceId: scope.instanceId, ...(scope.repository ? { repository: scope.repository } : {}) };
  if (scope.repository === undefined) return { badge: { ...base, reason: "serve names no repository for this instance" }, ids: [] };
  if (analyticsState === "unavailable") return { badge: { ...base, reason: "analytics has not completed its first refresh" }, ids: [] };
  if (scope.memory?.current().state !== "ready") return { badge: { ...base, reason: "operator-agent memory has not completed its first refresh" }, ids: [] };
  const opDeps = { ledgerPath: scope.ledgerPath, memory: scope.memory };
  const history = readOperatorAgentHistory(opDeps);
  const settings = readOperatorAgentSettings(opDeps, { kind: "repository", repository: scope.repository }).settings;
  const ids = visibleOperatorAgentProposals(operatorAgentCandidates(snapshot, { repository: scope.repository, instanceId: scope.instanceId }, history), history, settings);
  return { badge: { ...base, count: ids.length }, ids };
}

/** The nav-badge view over serve's own caches, every instance by default or `?instances=a,b`. */
export function navBadgeView(deps: { scopes: () => readonly NavBadgeScope[]; inboxRoot: string; clock?: Clock }): ViewDefinition<NavBadgeData> {
  return {
    name: "nav-badge",
    version: NAV_BADGE_VIEW_VERSION,
    compute: (params) => {
      const nowMs = (deps.clock ?? systemClock).now();
      const all = deps.scopes();
      const asked = params.get("instances")?.split(",").map((name) => name.trim()).filter(Boolean);
      const unknown = (asked ?? []).filter((name) => !all.some((scope) => scope.instanceId === name));
      if (unknown.length > 0) return { error: `unknown instance: ${unknown.join(",")}; serve has ${all.map((s) => s.instanceId).join(",")}` };
      const scopes = asked ? all.filter((scope) => asked.includes(scope.instanceId)) : all;
      const sources: ViewSource[] = [];
      const counted = scopes.map((scope) => instanceBadge(scope, nowMs, sources));
      const known = counted.filter((c) => c.badge.count !== undefined);
      const total = known.reduce((sum, c) => sum + (c.badge.count ?? 0), 0);
      const agent: NavBadgeData["agent"] = {
        ...(known.length === counted.length ? { count: total } : known.length > 0 ? { atLeast: total } : {}),
        proposalIds: counted.flatMap((c) => c.ids).slice(0, MAX_PROPOSAL_IDS),
        instances: counted.map((c) => c.badge),
        ...(known.length < counted.length ? { reason: `${counted.length - known.length} of ${counted.length} instances not counted` } : {}),
      };

      const classified = readClassificationSnapshot(join(deps.inboxRoot, "state"));
      sources.push({ name: "inbox-classification", asOf: classified?.generatedAt ?? null, state: classified ? sourceAge(classified.generatedAt, nowMs, INBOX_STALE_AFTER_MS) : "unavailable" });
      let inbox: NavBadgeData["inbox"];
      if (!classified) inbox = { reason: "no inbox classification has been written yet" };
      else {
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
        inbox = { ready, needsYou, fleet };
      }
      return { data: { agent, inbox }, sources };
    },
  };
}
