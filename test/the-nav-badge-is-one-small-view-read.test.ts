import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { coldAnalyticsSnapshot, type AnalyticsSnapshot } from "../src/lib/analytics-route.js";
import { fixedClock } from "../src/lib/clock.js";
import { navBadgeView, operatorAgentCandidates, visibleOperatorAgentProposals } from "../src/lib/nav-badge-view.js";
import type { OperatorAgentHistory, OperatorAgentMemorySource } from "../src/lib/operator-agent.js";
import { createService } from "../src/lib/service.js";
import { makeTempDir } from "../src/lib/tmp.js";
import { buildViewRoutes, renderView, type ViewBody, type ViewDefinition } from "../src/lib/views.js";

// The console sidebar's agent badge cost ~12 upstream reads (~370 KB) per page view and re-derived
// operator-agent proposals in the console. GET /v1/views/nav-badge answers the counts from serve's caches.

const NOW = Date.parse("2026-09-30T12:00:00.000Z");
const REPO = "craigoley/remudero";

function busySnapshot(over: { runs?: number; tokens?: number; asOf?: string | null } = {}): AnalyticsSnapshot {
  const base = coldAnalyticsSnapshot();
  const snapshot = {
    ...base,
    asOf: over.asOf === undefined ? new Date(NOW - 60_000).toISOString() : over.asOf,
    consoleV1: {
      ...base.consoleV1,
      metrics: [
        { key: "runs.completed", class: "observed", value: over.runs ?? 10 },
        { key: "tokens.total", class: "provider_reported", value: over.tokens ?? 1_000_000 },
        { key: "duration.p50.ms", class: "observed", value: null, notCollectedReason: "none" },
      ],
    },
    routingTelemetry: {
      ...base.routingTelemetry,
      buckets: [{ provider: "claude", assignedModel: "sonnet", taskType: "implement", routingRule: "r", assignments: 8, terminalResults: 8, successes: 2, failures: 6, totalTokens: 0, totalDurationMs: 0, totalCostUsd: 0, fallbackReasons: [] }],
    },
  } as AnalyticsSnapshot;
  Object.defineProperty(snapshot, "operatorAgentMemory", { value: base.operatorAgentMemory, enumerable: false });
  return snapshot;
}

function history(proposalId: string, over: Partial<OperatorAgentHistory> = {}): OperatorAgentHistory {
  return { proposalId, repo: REPO, proposalText: "t", confidence: 0.9, reasoning: "r", category: "optimize", status: "pending", createdAt: "2026-09-29T00:00:00.000Z", evidence: [], decisionHistory: [], ...over };
}

const readyMemory: OperatorAgentMemorySource = { current: () => ({ state: "ready", asOf: new Date(NOW).toISOString(), rows: [] }), record: () => undefined };

test("the agent badge counts the proposals the console engine would show", () => {
  const candidates = operatorAgentCandidates(busySnapshot(), { repository: REPO, instanceId: "core" }, []);
  const tokenBurn = candidates.find((c) => c.signal === "token-burn");
  assert.ok(tokenBurn, "100,000 tokens per run over 10 runs is a token-burn proposal");
  // 0.86 + sample min(0.025, log10(10) * 0.025) + corroboration 2 * 0.025 + severity 0.02
  assert.equal(tokenBurn.confidence, 0.955);
  assert.match(tokenBurn.proposalId, /^operator-agent:craigoley-remudero:core-[0-9a-f]{8}:optimize:token-burn$/);
  assert.ok(candidates.some((c) => c.signal === "worker-failure-rate-implement-sonnet"), "6 failures of 8 terminal results");
  assert.equal(candidates.some((c) => c.signal === "slow-runs"), false, "an uncollected metric is not a measurement");
  const visible = visibleOperatorAgentProposals(candidates, [], { enabled: true, confidenceThreshold: 0.9 });
  assert.deepEqual(visible.length, 2);
});

test("a decided or rejected proposal leaves the agent badge", () => {
  const candidates = operatorAgentCandidates(busySnapshot(), { repository: REPO, instanceId: "core" }, []);
  const tokenBurn = candidates.find((c) => c.signal === "token-burn")!;
  const settings = { enabled: true, confidenceThreshold: 0.9 };
  assert.equal(visibleOperatorAgentProposals(candidates, [history(tokenBurn.proposalId, { status: "accepted" })], settings).includes(tokenBurn.proposalId), false);
  // A rejection of the same signal elsewhere lowers its confidence by 0.08, below the threshold.
  const rejected = [history("operator-agent:other:x:optimize:token-burn", { decisionHistory: [{ decision: "rejected", at: "2026-09-29T01:00:00.000Z" }] })];
  const adjusted = operatorAgentCandidates(busySnapshot(), { repository: REPO, instanceId: "core" }, rejected);
  assert.equal(adjusted.find((c) => c.signal === "token-burn")?.confidence, 0.875);
  assert.equal(visibleOperatorAgentProposals(adjusted, rejected, settings).includes(tokenBurn.proposalId), false);
  assert.deepEqual(visibleOperatorAgentProposals(candidates, [], { enabled: false, confidenceThreshold: 0.9 }), []);
});

test("every evidence family the console engine reads becomes a candidate here too", () => {
  const snapshot = busySnapshot();
  snapshot.consoleV1 = {
    ...snapshot.consoleV1,
    metrics: [
      { key: "runs.completed", class: "observed", value: 10 },
      { key: "duration.p50.ms", class: "observed", value: 10 * 60_000 },
      { key: "queue.pending", class: "observed", value: 7 },
    ],
    operatorAgent: {
      ...snapshot.consoleV1.operatorAgent,
      proof: { ...snapshot.consoleV1.operatorAgent.proof, status: "measured", denominator: 10, passRate: 0.5 },
      outcomes: { ...snapshot.consoleV1.operatorAgent.outcomes, classes: [{ verdictClass: "Merged Clean", total: 10, revertedCount: 3, followupFixedCount: 0, revertRate: 0.3, followupFixRate: 0, lanes: "run-task", taskIds: [] }] },
      decisions: { ...snapshot.consoleV1.operatorAgent.decisions, classes: [{ taskClass: "docs", approvedCount: 6, acceptedCount: 0, rejectedCount: 0, heldCount: 0, releasedCount: 0, approvalDenominator: 6, approvalRate: 1, taskIds: [], actorIds: [] }] },
      capacity: { ...snapshot.consoleV1.operatorAgent.capacity, measurements: [{ repo: REPO, configuredCapacity: 2, admittedLanes: 2, activeWorkers: 2, queuedWork: 9, utilizationRatio: 1, windowStart: "2026-09-30T00:00:00.000Z", windowEnd: "2026-09-30T01:00:00.000Z", recommendation: "scale-up" }] },
    },
  } as unknown as AnalyticsSnapshot["consoleV1"];
  const signals = operatorAgentCandidates(snapshot, { repository: REPO, instanceId: "core" }, [
    history("operator-agent:x:y:fix:proof-failure-rate", { category: "fix", outcome: { summary: "s", helped: true, observedAt: "2026-09-29T02:00:00.000Z" } }),
    history("operator-agent:x:y:scale:queue-pressure", { category: "scale", outcome: { summary: "s", helped: false, observedAt: "2026-09-29T02:00:00.000Z" } }),
  ]).map((c) => `${c.category}:${c.signal}:${c.confidence}`);
  assert.deepEqual(signals.sort(), [
    "fix:proof-failure-rate:0.98",
    "fix:revert-rate-merged-clean:0.98",
    "optimize:approval-pattern-docs:0.98",
    "scale:capacity-scale-up-craigoley-remudero:0.98",
    "scale:queue-pressure:0.92",
    "fix:worker-failure-rate-implement-sonnet:0.98",
  ].sort());
});

function badgeView(snapshot: AnalyticsSnapshot, inboxRoot: string, memory: OperatorAgentMemorySource = readyMemory) {
  return navBadgeView({ analytics: () => snapshot, memory, ledgerPath: join(inboxRoot, "state", "ledger.ndjson"), inboxRoot, repository: REPO, instanceId: "core", clock: fixedClock(NOW) });
}

test("the nav badge view counts inbox items by who must act from the last classification", () => {
  const root = makeTempDir("nav-badge");
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(
    join(root, "state", "inbox-classified.json"),
    JSON.stringify({ generatedAt: new Date(NOW - 30_000).toISOString(), states: { "ruling:a": "ready", "ruling:b": "not_ready", "ruling:c": "declined", "adoption:x": "ready", "adoption:y": "drafting" } }),
  );
  const { body } = renderView(badgeView(busySnapshot(), root), fixedClock(NOW));
  assert.deepEqual(body.data.inbox, { ready: 1, needsYou: 2, fleet: 2 });
  assert.equal(body.data.agent.count, 2);
  assert.equal(body.stale, false);
  assert.ok(JSON.stringify(body).length < 1_000, "a few hundred bytes, not ~370 KB");
});

test("a cold input makes its count absent with a reason and the view stale", () => {
  const root = makeTempDir("nav-badge-cold");
  const cold = renderView(badgeView(busySnapshot({ asOf: null }), root), fixedClock(NOW)).body;
  assert.equal(cold.data.agent.count, undefined, "unknown is never a zero");
  assert.match(cold.data.agent.reason ?? "", /analytics/);
  assert.equal(cold.data.inbox.ready, undefined);
  assert.equal(cold.stale, true);
  const warming: OperatorAgentMemorySource = { current: () => ({ state: "cold", asOf: null, rows: [] }), record: () => undefined };
  assert.match(renderView(badgeView(busySnapshot(), root, warming), fixedClock(NOW)).body.data.agent.reason ?? "", /memory/);
  const noRepository = navBadgeView({ analytics: () => busySnapshot(), memory: readyMemory, ledgerPath: join(root, "ledger.ndjson"), inboxRoot: root, instanceId: "core", clock: fixedClock(NOW) });
  assert.match(renderView(noRepository, fixedClock(NOW)).body.data.agent.reason ?? "", /repository/);
  const old = renderView(badgeView(busySnapshot({ asOf: new Date(NOW - 3 * 3_600_000).toISOString() }), root), fixedClock(NOW)).body;
  assert.equal(old.sources.find((s) => s.name === "analytics")?.state, "stale");
});

test("a view answers a matching If-None-Match with 304 even after a recompute", async () => {
  let count = 1;
  const view: ViewDefinition<{ count: number }> = { name: "probe", version: 3, compute: () => ({ data: { count }, sources: [{ name: "s", asOf: null, state: "fresh" }] }) };
  const server = createService({ tokens: { read: "r", write: "w" }, routes: buildViewRoutes([view]) });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/views/probe`;
  try {
    const first = await fetch(url, { headers: { authorization: "Bearer r" } });
    const body = (await first.json()) as ViewBody<{ count: number }>;
    assert.equal(body.view, "probe");
    assert.equal(body.version, 3);
    const etag = first.headers.get("etag") ?? "";
    assert.match(etag, /^W\/"probe\.3\./);
    const again = await fetch(url, { headers: { authorization: "Bearer r", "if-none-match": etag } });
    assert.equal(again.status, 304, "generatedAt moved but the data did not");
    count = 2;
    const changed = await fetch(url, { headers: { authorization: "Bearer r", "if-none-match": etag } });
    assert.equal(changed.status, 200);
    assert.notEqual(changed.headers.get("etag"), etag);
  } finally {
    server.close();
  }
});

