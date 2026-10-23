// W1-T5051 (arch Phase 4 P4-T12): the `agent` view family. Each part must equal its GET /v1/operator-agent/*
// route over the same ledger (archive included), `proposals` must equal the nav badge's engine over the same
// analytics, and the per-instance fold must spread a large panel fact delta over passes, resuming from its
// committed position after a restart.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { AGENT_CLOCK_MS, AGENT_VIEW_PARTS, agentPartBodies, agentViewKey, createAgentView, type AgentProposalsBody, type AgentViewData, type AgentViewPart } from "../src/lib/agent-view.js";
import { coldAnalyticsSnapshot, type AnalyticsSnapshot } from "../src/lib/analytics-route.js";
import { analyticsSourceBodies } from "../src/lib/analytics-view.js";
import { fixedClock, type Clock } from "../src/lib/clock.js";
import { openProjectorReadModel } from "../src/lib/ledger-projector.js";
import { readLedgerUnionRecordsSync } from "../src/lib/ledger-union.js";
import { createNavBadgeReadModelView, navBadgeView, type NavBadgeData } from "../src/lib/nav-badge-view.js";
import { buildOperatorAgentRoutes, OPERATOR_AGENT_PROPOSAL_STEP, OPERATOR_AGENT_DECISION_STEP } from "../src/lib/operator-agent.js";
import {
  acquireLease,
  AGENT_FOLD_CHUNK,
  AGENT_FOLD_COMMIT_CHUNKS,
  AGENT_FOLD_DDL,
  createAgentFolds,
  readAgentFold,
  writeAgentFold,
  writeSourceSnapshot,
  type ReadModelDb,
  type ReadModelLease,
} from "../src/lib/read-model-db.js";
import { createReadModelTicker, ledgerSource, readModelLaneViews, type ReadModelInstanceState, type ReadModelWorkerMessage } from "../src/lib/read-model-worker.js";
import { makeTempDir } from "../src/lib/tmp.js";
import { createDemandBook } from "../src/lib/view-demand.js";
import { renderView } from "../src/lib/views.js";
import { corpus, get, listen, NOW } from "./helpers/operator-agent-corpus.js";
import { SPEC, violations } from "./helpers/openapi-strict.js";
import { switchViewsOn } from "./helpers/read-model-switches.js";

const REPO = "owner/repo";
const ANALYTICS_AS_OF = new Date(NOW - 60_000).toISOString();
const state = (instance = "core"): ReadModelInstanceState => ({ instance, generation: 1, lease: "held", failures: 0, newestTs: null, tickedAt: NOW });

function recommendationBody(snapshot = busySnapshot(), rows: Record<string, unknown>[] = [], now = NOW, repository = REPO, sourceRepository = repository): any {
  const source = analyticsSourceBodies(snapshot, sourceRepository)[0]!.body as any;
  return agentPartBodies({ ledgerDir: "/unused", instance: "core", repository, now, rows,
    analytics: { asOf: snapshot.asOf!, console: source, analytics: { ...snapshot, asOf: snapshot.asOf! } } }).proposals.body;
}

test("W1-T9244: new ranked proposals carry complete evidenced records from the sole core engine", () => {
  const body = recommendationBody();
  assert.ok(body.proposals.length > 0, "positive real candidate generation with empty durable history");
  assert.equal(body.records?.length, body.proposals.length);
  assert.equal(body.coverage.complete, body.proposals.length);
  for (const [i, record] of body.records.entries()) {
    assert.equal(record.proposalId, body.proposals[i].proposalId);
    assert.equal(record.detail.state, "reported");
    assert.equal(record.detail.kind, "generated-recommendation");
    assert.equal(record.detail.repository, REPO);
    assert.equal(record.detail.instanceId, "core");
    assert.equal(record.detail.observedAt, ANALYTICS_AS_OF);
    assert.equal(record.detail.scoreKind, "native-heuristic");
    assert.ok(record.detail.proposalText.length > 10);
    assert.ok(record.detail.reasoning.length > 10);
    assert.ok(record.detail.evidence.length > 0);
    assert.ok(record.detail.evidence.every((e: any) => e.source && e.unit && e.freshness === "fresh" && e.observedAt === ANALYTICS_AS_OF));
    assert.ok(record.detail.unavailable.includes("source-window"));
    assert.deepEqual(record.durable, { state: "unregistered" });
  }
  assert.deepEqual(recommendationBody(), body, "unchanged observation has deterministic content and identity");
  assert.deepEqual(recommendationBody(busySnapshot(), [], NOW + 1000), body, "request time is not evidence time");
  const all = supportedSignalsSnapshot();
  const complete = recommendationBody(all);
  assert.deepEqual(violations(complete, SPEC.components.schemas.AgentProposals!), [], "reported records match the actual strict OpenAPI contract");
  assert.deepEqual(complete.proposals.map((p: any) => p.signal).sort(), ["token-burn", "queue-pressure", "worker-failure-rate-implement-sonnet", "proof-failure-rate", "revert-rate-full-pass", "approval-pattern-docs", "capacity-scale-up-owner-repo"].sort());
  assert.equal(complete.coverage.complete, 7);
  assert.match(complete.records.find((r: any) => r.proposalId.includes("proof-failure")).detail.reasoning, /Keep proof validation/);
  assert.match(complete.records.find((r: any) => r.proposalId.includes("approval-pattern")).detail.reasoning, /grants no auto-merge/);
  all.consoleV1.operatorAgent.proof.passRate = 1;
  all.consoleV1.operatorAgent.proof.executedPass = 10;
  all.consoleV1.operatorAgent.proof.executedFail = 0;
  all.consoleV1.metrics.find((m) => m.key === "queue.pending")!.value = 0;
  all.consoleV1.operatorAgent.capacity.measurements[0] = { ...all.consoleV1.operatorAgent.capacity.measurements[0]!, recommendation: "underutilized", activeWorkers: 0, admittedLanes: 0, queuedWork: 0, utilizationRatio: 0 };
  const alternatives = recommendationBody(all);
  assert.deepEqual(violations(alternatives, SPEC.components.schemas.AgentProposals!), []);
  assert.equal(alternatives.coverage.complete, 7);
  assert.ok(alternatives.proposals.some((p: any) => p.signal === "slow-runs"));
  assert.ok(alternatives.proposals.some((p: any) => p.signal === "proof-pass-rate"));
  assert.ok(alternatives.proposals.some((p: any) => p.signal === "capacity-underutilized-owner-repo"));
});

test("W1-T9244: proposal detail publication preserves bounds identity and honest coverage", () => {
  const positive = recommendationBody();
  for (const [name, snapshot, now, repo, sourceRepo] of [
    ["foreign", busySnapshot(), NOW, REPO, "owner/foreign"],
    ["unknown repository", busySnapshot(), NOW, REPO, ""],
    ["stale", busySnapshot(), NOW + 3_600_000, REPO, REPO],
    ["future", { ...busySnapshot(), asOf: new Date(NOW + 60_000).toISOString() }, NOW, REPO, REPO],
  ] as const) {
    const body = recommendationBody(snapshot as AnalyticsSnapshot, [], now, repo, sourceRepo);
    assert.deepEqual(body.proposals, positive.proposals, name + " preserves ranks");
    assert.equal(body.coverage.complete, 0, name);
    assert.ok(body.records.every((r: any) => r.detail.state === "unavailable"), name);
  }
  const malformed = structuredClone(busySnapshot());
  (malformed.consoleV1.operatorAgent as any).proof = null;
  assert.match(recommendationBody(malformed).reason, /malformed/);
  const unknownMetric = busySnapshot();
  (unknownMetric.consoleV1.metrics[0] as unknown as { class: string }).class = "unknown";
  assert.match(recommendationBody(unknownMetric).reason, /malformed/);
  const invalidValue = busySnapshot();
  invalidValue.consoleV1.metrics[0]!.value = Number.NaN;
  assert.match(recommendationBody(invalidValue).reason, /malformed/);
  const badCounts = busySnapshot();
  badCounts.routingTelemetry.buckets[0]!.failures = 99;
  assert.equal(recommendationBody(badCounts).records.find((r: any) => r.proposalId.includes("worker-failure")).detail.state, "unavailable");
  const long = busySnapshot();
  long.routingTelemetry.buckets[0]!.assignedModel = "untrusted".repeat(500);
  assert.match(recommendationBody(long).reason, /budget/);
  const huge = busySnapshot();
  huge.routingTelemetry.buckets = Array.from({ length: 101 }, (_, i) => ({ ...huge.routingTelemetry.buckets[0]!, assignedModel: "model" + i, terminalResults: 0, successes: 0, failures: 0 }));
  assert.match(recommendationBody(huge).reason, /budget/);
  const manyRanks = supportedSignalsSnapshot();
  manyRanks.routingTelemetry.buckets = Array.from({ length: 99 }, (_, i) => ({ ...manyRanks.routingTelemetry.buckets[0]!, assignedModel: "model" + i }));
  assert.match(recommendationBody(manyRanks).reason, /ranks exceed/);
  const capped = busySnapshot();
  capped.routingTelemetry.buckets = Array.from({ length: 90 }, (_, i) => ({ ...capped.routingTelemetry.buckets[0]!, assignedModel: "model" + i }));
  const bounded = recommendationBody(capped);
  assert.equal(bounded.proposals.length, 91);
  assert.equal(bounded.records.length, 91, "a capped detail does not silently drop its rank");
  assert.ok(bounded.coverage.capped > 0);
  assert.ok(bounded.coverage.complete > 0 && bounded.coverage.complete < 91);
  assert.equal(bounded.coverage.complete + bounded.coverage.unavailable, 91);
  assert.ok(Buffer.byteLength(JSON.stringify(bounded)) <= 65_536);
  assert.ok(Buffer.byteLength(JSON.stringify(positive)) <= 65_536);
  const foreignWindow = supportedSignalsSnapshot();
  foreignWindow.consoleV1.operatorAgent.capacity.measurements[0]!.repo = "owner/foreign";
  assert.equal(recommendationBody(foreignWindow).records.find((r: any) => r.proposalId.includes("capacity")).detail.state, "unavailable");
  const unknownWindow = supportedSignalsSnapshot();
  unknownWindow.consoleV1.operatorAgent.capacity.measurements[0]!.windowEnd = "unknown";
  assert.equal(recommendationBody(unknownWindow).records.find((r: any) => r.proposalId.includes("capacity")).detail.state, "unavailable");
  const invalidMetric = busySnapshot();
  invalidMetric.consoleV1.metrics.find((m) => m.key === "runs.completed")!.value = 5.5;
  assert.equal(recommendationBody(invalidMetric).coverage.complete, 1, "fractional run denominator cannot qualify token-burn detail");
});

test("malformed nonnull signal rows are refused before agent publication and preserve valid cohorts", (t) => {
  const ledgerDir = makeTempDir("agent-malformed-rows");
  t.after(() => rmSync(ledgerDir, { recursive: true, force: true }));
  const publish = (snapshot: AnalyticsSnapshot): AgentProposalsBody => agentPartBodies({ ledgerDir, instance: "core", repository: REPO, now: NOW, rows: [],
    analytics: { asOf: snapshot.asOf!, sourceState: "fresh", sourceInstance: "core", console: analyticsSourceBodies(snapshot, REPO)[0]!.body as any, analytics: snapshot } }).proposals.body as AgentProposalsBody;
  const good = supportedSignalsSnapshot();
  const positive = publish(good);
  assert.equal(positive.coverage!.complete, 7, "all real source families are positively observed before mutation");
  const cases: Array<[string, (s: any) => void]> = [
    ["outcomes", (s) => { s.consoleV1.operatorAgent.outcomes.classes = [{}]; }],
    ["outcomes", (s) => { delete s.consoleV1.operatorAgent.outcomes.classes[0].verdictClass; }],
    ["outcomes", (s) => { s.consoleV1.operatorAgent.outcomes.classes[0].verdictClass = 42; }],
    ["outcomes", (s) => { delete s.consoleV1.operatorAgent.outcomes.classes[0].total; }],
    ["outcomes", (s) => { delete s.consoleV1.operatorAgent.outcomes.classes[0].revertRate; }],
    ["outcomes", (s) => { delete s.consoleV1.operatorAgent.outcomes.classes[0].revertedCount; }],
    ["decisions", (s) => { s.consoleV1.operatorAgent.decisions.classes = [{}]; }],
    ["decisions", (s) => { delete s.consoleV1.operatorAgent.decisions.classes[0].taskClass; }],
    ["decisions", (s) => { delete s.consoleV1.operatorAgent.decisions.classes[0].approvalDenominator; }],
    ["decisions", (s) => { delete s.consoleV1.operatorAgent.decisions.classes[0].approvalRate; }],
    ["decisions", (s) => { delete s.consoleV1.operatorAgent.decisions.classes[0].approvedCount; }],
    ["decisions", (s) => { delete s.consoleV1.operatorAgent.decisions.classes[0].acceptedCount; }],
    ["decisions", (s) => { delete s.consoleV1.operatorAgent.decisions.classes[0].rejectedCount; }],
    ["capacity", (s) => { s.consoleV1.operatorAgent.capacity.measurements = [{}]; }],
    ["capacity", (s) => { delete s.consoleV1.operatorAgent.capacity.measurements[0].repo; }],
    ["capacity", (s) => { s.consoleV1.operatorAgent.capacity.measurements[0].repo = {}; }],
    ["capacity", (s) => { delete s.consoleV1.operatorAgent.capacity.measurements[0].recommendation; }],
    ["capacity", (s) => { delete s.consoleV1.operatorAgent.capacity.measurements[0].configuredCapacity; }],
    ["capacity", (s) => { delete s.consoleV1.operatorAgent.capacity.measurements[0].admittedLanes; }],
    ["capacity", (s) => { delete s.consoleV1.operatorAgent.capacity.measurements[0].activeWorkers; }],
    ["capacity", (s) => { delete s.consoleV1.operatorAgent.capacity.measurements[0].queuedWork; }],
    ["capacity", (s) => { delete s.consoleV1.operatorAgent.capacity.measurements[0].utilizationRatio; }],
    ["capacity", (s) => { delete s.consoleV1.operatorAgent.capacity.measurements[0].windowStart; }],
    ["capacity", (s) => { delete s.consoleV1.operatorAgent.capacity.measurements[0].windowEnd; }],
    ["routing", (s) => { s.routingTelemetry.buckets = [{}]; }],
    ["routing", (s) => { delete s.routingTelemetry.buckets[0].taskType; }],
    ["routing", (s) => { delete s.routingTelemetry.buckets[0].assignedModel; }],
    ["routing", (s) => { delete s.routingTelemetry.buckets[0].terminalResults; }],
    ["routing", (s) => { delete s.routingTelemetry.buckets[0].failures; }],
    ["proof", (s) => { delete s.consoleV1.operatorAgent.proof.denominator; }],
    ["proof", (s) => { delete s.consoleV1.operatorAgent.proof.passRate; }],
    ["proof", (s) => { delete s.consoleV1.operatorAgent.proof.executedPass; }],
    ["proof", (s) => { delete s.consoleV1.operatorAgent.proof.executedFail; }],
  ];
  for (const [family, mutate] of cases) {
    const snapshot = structuredClone(good);
    mutate(snapshot);
    const original = JSON.stringify(snapshot);
    let body: AgentProposalsBody | undefined;
    assert.doesNotThrow(() => { body = publish(snapshot); }, family);
    assert.match(body!.reason!, new RegExp("malformed.*" + family), family);
    assert.equal(body!.proposals, undefined, "an invalid family never fabricates empty ranks");
    assert.equal(body!.records, undefined, "an invalid family never publishes complete detail");
    assert.equal(JSON.stringify(snapshot), original, "validation is read-only");
  }
  assert.deepEqual(publish(good), positive, "restored full source retains exact rank policy and observations");
});

test("committed source clock mismatch and failed refresh refuse complete records without touching the fold", async (t) => {
  const { stateDir } = await corpus(t);
  const { db, lease } = projected(t, stateDir);
  const view = createAgentView({ instances: [{ name: "core", ledgerDir: stateDir, repo: REPO }], ledgerSource });
  const materialize = (): AgentProposalsBody => bodies(view, db, lease).get(agentViewKey("core", "proposals"))!.body as AgentProposalsBody;
  writeSourceSnapshot(db, lease, { instance: "core", ok: true, asOf: ANALYTICS_AS_OF, bodies: analyticsSourceBodies(busySnapshot(), REPO) });
  assert.ok(materialize().coverage!.complete > 0);
  const fold = readAgentFold(db, "core");
  writeSourceSnapshot(db, lease, { instance: "core", ok: true, asOf: new Date(NOW - 30_000).toISOString(), bodies: [analyticsSourceBodies(busySnapshot(), REPO)[1]!] });
  assert.match(materialize().reason!, /different observation clocks/);
  writeSourceSnapshot(db, lease, { instance: "core", ok: true, asOf: ANALYTICS_AS_OF, bodies: analyticsSourceBodies(busySnapshot(), REPO) });
  writeSourceSnapshot(db, lease, { instance: "core", ok: false, names: ["signals"], error: "refresh failed", atMs: NOW });
  const failed = materialize();
  assert.ok(failed.proposals!.length > 0);
  assert.equal(failed.coverage!.complete, 0);
  assert.deepEqual(readAgentFold(db, "core"), fold);
  writeSourceSnapshot(db, lease, { instance: "core", ok: true, asOf: new Date(NOW - 10_000).toISOString(), bodies: [{ name: "console-v1", body: null }, analyticsSourceBodies(busySnapshot(), REPO)[1]!] });
  assert.match(materialize().reason!, /malformed/);
});

test("W1-T9244: complete proposal records preserve ranking and durable history ownership", () => {
  const positive = recommendationBody();
  const id = positive.proposals.find((p: any) => p.signal === "token-burn").proposalId;
  const proposal = { proposalId: id, repo: REPO, proposalText: "Original durable text", reasoning: "Original durable reasoning", category: "optimize", confidence: 0.91, status: "pending", createdAt: new Date(NOW - 3600_000).toISOString(), evidence: [] };
  const rows = [{ ts: proposal.createdAt, step: OPERATOR_AGENT_PROPOSAL_STEP, proposal }];
  const copy = JSON.stringify(rows);
  const body = recommendationBody(busySnapshot(), rows);
  const record = body.records.find((r: any) => r.proposalId === id);
  assert.deepEqual(record.durable, { state: "registered", source: "ledger", createdAt: proposal.createdAt, status: "pending" });
  assert.notEqual(record.detail.proposalText, proposal.proposalText);
  assert.equal(JSON.stringify(rows), copy, "read never mutates registered payload or lifecycle");
  assert.deepEqual(body.proposals, positive.proposals);
  const accepted = [...rows, { ts: ANALYTICS_AS_OF, step: OPERATOR_AGENT_DECISION_STEP, proposal_id: id, decision: "accepted", at: ANALYTICS_AS_OF }];
  assert.ok(!recommendationBody(busySnapshot(), accepted).proposals.some((p: any) => p.proposalId === id));
  assert.equal(proposal.status, "pending");
  const rejected = [...rows, { ts: ANALYTICS_AS_OF, step: OPERATOR_AGENT_DECISION_STEP, proposal_id: id, decision: "rejected", at: ANALYTICS_AS_OF }];
  assert.ok(!recommendationBody(busySnapshot(), rejected).proposals.some((p: any) => p.proposalId === id));
  const expired = [{ ...rows[0], proposal: { ...proposal, expiresAt: new Date(NOW - 10_000).toISOString() } }];
  assert.ok(!recommendationBody(busySnapshot(), expired).proposals.some((p: any) => p.proposalId === id));
});

function supportedSignalsSnapshot(): AnalyticsSnapshot {
  const snapshot = structuredClone(busySnapshot());
  snapshot.consoleV1.metrics.push({ key: "duration.p50.ms", class: "observed", value: 600_000 }, { key: "queue.pending", class: "observed", value: 7 });
  const agent = snapshot.consoleV1.operatorAgent;
  agent.proof = { ...agent.proof, status: "measured", denominator: 10, passRate: 0.5, executedPass: 5, executedFail: 5 };
  agent.outcomes.classes = [{ verdictClass: "full-pass", total: 10, revertedCount: 3, followupFixedCount: 0, revertRate: 0.3, followupFixRate: 0, lanes: "run-task", taskIds: [] }];
  agent.decisions.classes = [{ taskClass: "docs", approvedCount: 6, acceptedCount: 0, rejectedCount: 0, heldCount: 0, releasedCount: 0, approvalDenominator: 6, approvalRate: 1, taskIds: [], actorIds: [] }];
  agent.capacity.measurements = [{ repo: REPO, configuredCapacity: 2, admittedLanes: 2, activeWorkers: 2, queuedWork: 9, utilizationRatio: 1, windowStart: new Date(NOW - 120_000).toISOString(), windowEnd: ANALYTICS_AS_OF, recommendation: "scale-up" }];
  return snapshot;
}

/** An analytics refresh whose metrics and routing buckets make the engine propose token-burn and a worker-failure fix. */
function busySnapshot(): AnalyticsSnapshot {
  const base = coldAnalyticsSnapshot();
  return {
    ...base,
    asOf: ANALYTICS_AS_OF,
    consoleV1: { ...base.consoleV1, metrics: [{ key: "runs.completed", class: "observed", value: 10 }, { key: "tokens.total", class: "provider_reported", value: 1_000_000 }] },
    routingTelemetry: {
      ...base.routingTelemetry,
      buckets: [{ provider: "claude", assignedModel: "sonnet", taskType: "implement", routingRule: "r", assignments: 8, terminalResults: 8, successes: 2, failures: 6, totalTokens: 0, totalDurationMs: 0, totalCostUsd: 0, fallbackReasons: [] }],
    },
  } as AnalyticsSnapshot;
}

/** The corpus projected into core's store (on the real clock: its rows carry real stamps), reopened under this test's own lease. */
function projected(t: { after: (fn: () => void) => void }, stateDir: string): { db: ReadModelDb; lease: ReadModelLease } {
  const ticker = createReadModelTicker({ stateDir, instances: [{ name: "core", ledgerDir: stateDir }], views: [], holder: "agent-view-test", post: () => {} });
  for (let i = 0; i < 5; i++) ticker.tick();
  ticker.release();
  const db = openProjectorReadModel(stateDir, "core");
  t.after(() => db.close());
  const got = acquireLease(db, { holder: "agent-view-test" });
  assert.ok(got.ok, "the test holds the store's lease");
  return { db, lease: got.lease };
}

function bodies(view: ReturnType<typeof createAgentView>, db: ReadModelDb, lease?: ReadModelLease, now = NOW): Map<string, AgentViewData> {
  const instances = [{ state: state(), db, ...(lease ? { lease } : {}) }];
  assert.equal(view.prepare({ instances }, () => true), true);
  return new Map(view.materialize({ now, instances }).map((entry) => [entry.key, entry.data]));
}

/** An id each part's body carries only because the corpus's archived rows were folded. */
const ARCHIVED: Record<Exclude<AgentViewPart, "proposals">, string> = {
  history: "operator-agent:repo:scale:queue-pressure",
  settings: "0.97",
  experiments: "experiment:repo:worker-pool",
  delegations: "delegation:owner/repo:flow-runner",
  "follow-ups": "follow-up:thread-1",
  promotions: "promotion:repo:worker-pool",
  actions: "action:deploy:canary",
  consequences: "cq-archived",
  "intent-plans": "Promote the canary in repo owner/repo",
};

test("W1-T5051: each agent view part equals its operator agent route over the same ledger", async (t) => {
  const { stateDir, ledgerPath } = await corpus(t);
  const routes = await listen(t, buildOperatorAgentRoutes({ ledgerPath, now: () => NOW }));
  const { db, lease } = projected(t, stateDir);
  writeSourceSnapshot(db, lease, { instance: "core", ok: true, asOf: ANALYTICS_AS_OF, bodies: analyticsSourceBodies(busySnapshot()) });
  const view = createAgentView({ instances: [{ name: "core", ledgerDir: stateDir, repo: REPO }], ledgerSource });
  const built = bodies(view, db, lease);
  assert.deepEqual([...built.keys()].sort(), Object.keys(AGENT_VIEW_PARTS).map((part) => agentViewKey("core", part as AgentViewPart)).sort(), "one body per part");

  for (const [part, marker] of Object.entries(ARCHIVED) as Array<[Exclude<AgentViewPart, "proposals">, string]>) {
    const data = built.get(agentViewKey("core", part))!;
    const route = await get(routes, AGENT_VIEW_PARTS[part]);
    assert.equal(route.status, 200, part);
    assert.deepEqual(data.body, route.body, part);
    assert.ok(JSON.stringify(data.body).includes(marker), `${part} folded its archived row`);
    assert.deepEqual([data.instance, data.part, data.repository], ["core", part, REPO]);
  }
  const scoped = await get(routes, `${AGENT_VIEW_PARTS.settings}?repository=${encodeURIComponent(REPO)}`);
  assert.deepEqual(built.get(agentViewKey("core", "settings"))!.scoped, scoped.body, "settings carries its repository-scoped read");

  // `proposals` is the engine the nav badge counts, over the same analytics and history.
  const rows = readLedgerUnionRecordsSync(stateDir, {}).rows.filter((row) => String(row.step).startsWith("panel."));
  const badge = renderView(navBadgeView({
    inboxRoot: stateDir, clock: fixedClock(NOW),
    scopes: () => [{ instanceId: "core", repository: REPO, analytics: busySnapshot, ledgerPath, memory: { current: () => ({ state: "ready", asOf: null, rows }), record: () => {} } }],
  }), fixedClock(NOW), new URLSearchParams());
  assert.ok(!("error" in badge));
  const proposals = built.get(agentViewKey("core", "proposals"))!.body as AgentProposalsBody;
  assert.ok((proposals.proposals ?? []).length > 0, `the busy snapshot proposes something: ${JSON.stringify(proposals)}`);
  assert.deepEqual(proposals.proposals!.map((p) => p.proposalId), (badge.body.data as NavBadgeData).agent.proposalIds);

  // The shadow's legacy side reads the ledger the routes' way and agrees with every part.
  const entries = view.materialize({ now: NOW, instances: [{ state: state(), db, lease }] });
  for (const entry of entries) assert.deepEqual(view.legacy(entry.key, NOW, entry.data)?.data, entry.data, entry.key);
  assert.equal(view.legacy("instance=core&part=history", NOW, { ...entries[0]!.data }), undefined, "a body this view did not build has no legacy side");
  assert.deepEqual(entries.find((e) => e.data.part === "proposals")!.sources.map((s) => [s.name, s.state]), [["ledger:core", "fresh"], ["analytics:core", "fresh"]]);
});

test("an agent proposals part with no committed analytics or no repository names why and proposes nothing", async (t) => {
  const { stateDir } = await corpus(t);
  const { db, lease } = projected(t, stateDir);
  const proposals = (repo?: string): AgentProposalsBody => {
    const view = createAgentView({ instances: [{ name: "core", ledgerDir: stateDir, ...(repo ? { repo } : {}) }], ledgerSource });
    return bodies(view, db, lease).get(agentViewKey("core", "proposals"))!.body as AgentProposalsBody;
  };
  assert.deepEqual(proposals(REPO), { reason: "no analytics refresh has completed yet, so no proposal is generated" });
  assert.deepEqual(proposals(), { reason: "serve names no repository for this instance" });
  const view = createAgentView({ instances: [{ name: "core", ledgerDir: stateDir }], ledgerSource });
  const settings = bodies(view, db, lease).get(agentViewKey("core", "settings"))!;
  assert.equal(settings.repository, undefined);
  assert.equal(settings.scoped, undefined);
  writeSourceSnapshot(db, lease, { instance: "core", ok: false, names: ["console-v1", "signals"], error: "scan timed out", atMs: NOW });
  const failed = createAgentView({ instances: [{ name: "core", ledgerDir: stateDir, repo: REPO }], ledgerSource }).materialize({ now: NOW, instances: [{ state: state(), db, lease }] });
  assert.deepEqual(failed.find((e) => e.data.part === "proposals")!.sources[1]!.phase, "failed");
});

test("the agent view builds nothing without a home store or for an instance it does not project", async (t) => {
  const { stateDir } = await corpus(t);
  const { db } = projected(t, stateDir);
  const view = createAgentView({ instances: [{ name: "core", ledgerDir: stateDir, repo: REPO }], ledgerSource });
  assert.deepEqual(view.materialize({ now: NOW, instances: [] }), []);
  assert.deepEqual(view.materialize({ now: NOW, instances: [{ state: state("elsewhere"), db }] }), [], "an unconfigured instance");
  assert.deepEqual(view.materialize({ now: NOW, instances: [{ state: { ...state(), tickedAt: undefined }, db }] }), [], "an unprojected store");
  assert.equal(view.prepare({ instances: [{ state: state(), db }] }, () => true), true, "with no lease the fold still advances");
});

test("an agent view part recomputes its time-dependent states on the clock with no new fact", async (t) => {
  const { stateDir } = await corpus(t);
  const { db, lease } = projected(t, stateDir);
  const logged: string[] = [];
  const view = createAgentView({ instances: [{ name: "core", ledgerDir: stateDir, repo: REPO }], ledgerSource, log: (step) => void logged.push(step) });
  const expiry = (now: number): string => {
    const history = bodies(view, db, lease, now).get(agentViewKey("core", "history"))!.body as { proposals: Array<{ proposalId: string; status: string }> };
    return history.proposals.find((p) => p.proposalId === "operator-agent:repo:scale:queue-pressure")!.status;
  };
  assert.equal(expiry(NOW), "pending");
  bodies(view, db, lease, NOW + 1_000);
  assert.equal(logged.length, 1, "an unmoved fold within the clock bucket is not rebuilt");
  assert.equal(expiry(Date.parse("2026-09-28T00:00:00.000Z") + AGENT_CLOCK_MS), "expired", "the proposal's expiry passed with no new fact");
});

test("the nav badge reads the agent view's fold, so its count never folds past the agent pages", async (t) => {
  const { stateDir } = await corpus(t);
  const { db, lease } = projected(t, stateDir);
  assert.equal(readAgentFold(db, "core"), undefined, "control: no fold was committed before the agent view's");
  const instances = [{ state: state(), db, lease }];
  assert.equal(createAgentView({ instances: [{ name: "core", ledgerDir: stateDir, repo: REPO }], ledgerSource }).prepare({ instances }, () => true), true);
  assert.equal(createNavBadgeReadModelView(ledgerSource).prepare({ instances }, () => assert.fail("the badge folds nothing the agent view has not")), true);
});

// ---- the persisted fold ----

/** A store holding `n` panel facts (and one non-panel fact per 1,000), written straight into `fact`. */
function factStore(t: { after: (fn: () => void) => void }, n: number): { db: ReadModelDb; lease: ReadModelLease; root: string } {
  const root = makeTempDir("agent-fold");
  let db: ReadModelDb | undefined;
  t.after(() => {
    // SQLite may checkpoint and remove its WAL on close. Keep the directory until
    // close completes; if close fails, preserve the fixture and the failure.
    db?.close();
    rmSync(root, { recursive: true, force: true });
  });
  mkdirSync(join(root, "state"), { recursive: true });
  db = openProjectorReadModel(join(root, "state"), "core", fixedClock(NOW));
  const got = acquireLease(db, { holder: "fold-test", clock: fixedClock(NOW) });
  assert.ok(got.ok);
  addFacts(db, 0, n);
  return { db, lease: got.lease, root };
}

test("W1-T10430: agent fold teardown closes SQLite before deleting its directory", () => {
  const cleanup: Array<() => void> = [];
  const { db, root } = factStore({ after: (fn) => void cleanup.push(fn) }, 0);
  const close = db.close.bind(db);
  let directoryPresentAtClose: boolean | undefined;
  db.close = () => {
    directoryPresentAtClose = existsSync(root);
    close();
  };
  const failures: unknown[] = [];
  // Run every registered hook even on the negative control, so the real store is
  // closed after a reversed-order deletion fails. No external resource is faked.
  for (const finish of cleanup) {
    try { finish(); } catch (error) { failures.push(error); }
  }
  assert.deepEqual(failures, [], "fixture teardown completes without hiding a failure");
  assert.equal(directoryPresentAtClose, true, "the real SQLite close runs before any directory removal");
  assert.equal(existsSync(root), false, "the fixture is removed after the real close completes");
});

function addFacts(db: ReadModelDb, from: number, n: number): void {
  const insert = db.prepare("INSERT INTO fact(ts, ts_ms, step, body) VALUES(?, ?, ?, ?)");
  db.exec("BEGIN");
  for (let i = from; i < from + n; i++) {
    const ts = new Date(NOW - 10_000_000 + i).toISOString();
    const step = i % 1_000 === 999 ? "task.merged" : OPERATOR_AGENT_PROPOSAL_STEP;
    insert.run(ts, Date.parse(ts), step, JSON.stringify({ ts, step, n: i }));
  }
  db.exec("COMMIT");
}

type Step = { from: number; through: number; rows: number };

/** Passes of one fold step each (the pass budget), until the fold is caught up or `limit` passes ran. */
function passes(folds: ReturnType<typeof createAgentFolds>, slot: Parameters<ReturnType<typeof createAgentFolds>["advance"]>[0], limit: number): number {
  for (let pass = 1; pass <= limit; pass++) {
    let allowed = true;
    const done = folds.advance(slot, () => {
      const ok = allowed;
      allowed = false;
      return ok;
    });
    if (done) return pass;
  }
  return Number.POSITIVE_INFINITY;
}

test("W1-T5051: a large panel fact delta is folded across passes within budget", (t) => {
  const DELTA = 50_000;
  const { db, lease } = factStore(t, DELTA);
  const steps: Step[] = [];
  const folds = createAgentFolds({ onStep: ({ from, through, rows }) => void steps.push({ from, through, rows }) });
  const slot = { instance: "core", db, lease };
  const chunks = Math.ceil(DELTA / AGENT_FOLD_CHUNK);
  assert.equal(passes(folds, slot, chunks * 2), chunks, "one chunk per pass, never the whole delta in one");
  assert.equal(steps.length, chunks);
  for (const [i, step] of steps.entries()) {
    assert.ok(step.through - step.from <= AGENT_FOLD_CHUNK, `step ${i} stays within one chunk of facts`);
    assert.equal(step.from, i === 0 ? 0 : steps[i - 1]!.through, `step ${i} starts where the last one ended, never from seq 0 again`);
  }
  assert.equal(steps.reduce((sum, step) => sum + step.through - step.from, 0), DELTA, "every fact is read exactly once");
  assert.equal(folds.current(slot).rows.length, DELTA - DELTA / 1_000, "every panel fact is folded, and only those");
  assert.equal(readAgentFold(db, "core")?.lastSeq, DELTA, "the state is committed with the position it consumed");

  // A restart resumes from the committed pair: it reads only the facts written since.
  addFacts(db, DELTA, 10);
  const resumed: Step[] = [];
  const restarted = createAgentFolds({ onStep: (step) => void resumed.push(step) });
  assert.equal(passes(restarted, slot, 3), 1);
  assert.deepEqual(resumed, [{ instance: "core", from: DELTA, through: DELTA + 10, rows: 10 }]);
  assert.equal(restarted.current(slot).rows.length, folds.current(slot).rows.length, "the resumed fold holds what an uninterrupted one holds");
});

test("an agent fold catching up commits every span of chunks and once caught up, so a restart mid-delta re-reads at most one span", (t) => {
  const CHUNK = 10;
  const { db, lease } = factStore(t, CHUNK * (2 * AGENT_FOLD_COMMIT_CHUNKS + 5));
  const folds = createAgentFolds({ chunk: CHUNK });
  const slot = { instance: "core", db, lease };
  const committedAfter = (n: number): number | undefined => {
    for (let i = 0; i < n; i++) folds.advance(slot, (() => { let ok = true; return () => { const was = ok; ok = false; return was; }; })());
    return readAgentFold(db, "core")?.lastSeq;
  };
  assert.equal(committedAfter(AGENT_FOLD_COMMIT_CHUNKS - 1), undefined, "nothing is committed before a whole span");
  assert.equal(committedAfter(1), CHUNK * AGENT_FOLD_COMMIT_CHUNKS);
  assert.equal(committedAfter(AGENT_FOLD_COMMIT_CHUNKS), 2 * CHUNK * AGENT_FOLD_COMMIT_CHUNKS);
  assert.equal(committedAfter(5), CHUNK * (2 * AGENT_FOLD_COMMIT_CHUNKS + 5), "caught up: the rest is committed");
  addFacts(db, CHUNK * (2 * AGENT_FOLD_COMMIT_CHUNKS + 5), 1);
  db.exec("UPDATE fact SET step = 'task.merged' WHERE seq = (SELECT max(seq) FROM fact)");
  assert.equal(committedAfter(1), CHUNK * (2 * AGENT_FOLD_COMMIT_CHUNKS + 5), "a step that folded no panel fact commits nothing");
});

test("an agent fold commit refused for a lost lease keeps every folded fact and the last committed pair", (t) => {
  const { db, lease } = factStore(t, 20);
  const logged: Array<Record<string, unknown>> = [];
  const folds = createAgentFolds({ chunk: 10 });
  const log = (_step: string, extra: Record<string, unknown>): void => void logged.push(extra);
  assert.equal(folds.current({ instance: "core", db, lease, log }).rows.length, 20);
  assert.equal(readAgentFold(db, "core")?.lastSeq, 20);
  addFacts(db, 20, 5);
  const lost = { ...lease, holder: "someone-else" };
  assert.equal(folds.current({ instance: "core", db, lease: lost, log }).rows.length, 25, "the fold carries on in memory");
  assert.equal(readAgentFold(db, "core")?.lastSeq, 20, "the committed pair is the last whole one");
  assert.match(String(logged[0]?.error), /no longer owns/);
  assert.deepEqual([logged[0]?.seq, logged[0]?.committed], [25, 20]);
  // A restart under a held lease resumes from the committed pair and loses nothing.
  assert.equal(createAgentFolds().current({ instance: "core", db, lease }).rows.length, 25);
  assert.equal(readAgentFold(db, "core")?.lastSeq, 25);
});

test("an agent fold committed in another state version or past a shrunken store is folded again from the first fact", (t) => {
  const { db, lease } = factStore(t, 4);
  db.exec(AGENT_FOLD_DDL);
  writeAgentFold(db, lease, "core", { lastSeq: 4, stateJson: JSON.stringify({ version: 0, entries: [] }) });
  assert.equal(createAgentFolds().current({ instance: "core", db }).rows.length, 4, "another version's state is not trusted");
  writeAgentFold(db, lease, "core", { lastSeq: 99, stateJson: JSON.stringify({ version: 1, entries: [] }) });
  assert.equal(createAgentFolds().current({ instance: "core", db }).rows.length, 4, "a position past the store's newest fact is not trusted");
  const folds = createAgentFolds();
  assert.equal(folds.current({ instance: "core", db }).rows.length, 4);
  db.exec("DELETE FROM fact WHERE seq > 2");
  assert.equal(folds.current({ instance: "core", db }).rows.length, 2, "a store that shrank under the fold is folded again");
});

function repositoryUnitFixture(t: { after(run: () => void): void }) {
  const stateDir = makeTempDir("agent-repository-units");
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const instances = ["core", "site", "console"].map((name) => {
    const ledgerDir = join(stateDir, name);
    mkdirSync(ledgerDir);
    writeFileSync(join(ledgerDir, "ledger.ndjson"), "");
    return { name, ledgerDir, repo: `owner/${name}` };
  });
  switchViewsOn(stateDir, ["agent"], "shadow");
  let now = NOW;
  const clock: Clock = { now: () => now, date: () => new Date(now), iso: () => new Date(now).toISOString() };
  const posts: ReadModelWorkerMessage[] = [];
  const projector = createReadModelTicker({ stateDir, instances, views: [], holder: "agent-repository-units", clock,
    oracle: "off", post: (msg) => void posts.push(msg) });
  t.after(() => void projector.release());
  projector.start();
  projector.tick();
  for (const instance of instances) assert.equal(projector.acceptSnapshot({ instance: instance.name, ok: true,
    asOf: ANALYTICS_AS_OF, bodies: analyticsSourceBodies(busySnapshot(), instance.repo) }), true);
  const observed = () => {
    const last = posts.findLast((msg) => msg.type === "state");
    assert.ok(last && last.type === "state");
    return last.instances;
  };
  return { stateDir, instances, clock, projector, observed, advance: (by: number) => void (now += by) };
}

test("repository-scoped agent builds keep individually affordable repos off the heavy lane", (t) => {
  const f = repositoryUnitFixture(t);
  const spec = readModelLaneViews({ instances: f.instances }, f.clock, () => {}, createDemandBook({ clock: f.clock }))
    .find((view) => view.name === "agent");
  assert.ok(spec && "create" in spec);
  const scopes: string[][] = [];
  const posts: ReadModelWorkerMessage[] = [];
  const ticker = createReadModelTicker({ stateDir: f.stateDir, instances: f.instances, holder: "agent-repository-units", clock: f.clock,
    viewsOnly: true, lane: "fast", oracle: "off", passBudgetMs: 100, post: (msg) => void posts.push(msg),
    views: [{ ...spec, create: () => {
      const view = spec.create();
      return { ...view, materialize(ctx) {
        scopes.push(ctx.instances.map(({ state }) => state.instance));
        const result = view.materialize(ctx);
        // Controlled cost per repository: 30ms fits the native 40ms solo allowance;
        // bundling three unrelated repositories is a 90ms overrun of that SAME bound.
        f.advance(ctx.instances.length * 30);
        return result;
      } };
    } }],
  });
  t.after(() => void ticker.release());
  ticker.start();
  for (let i = 0; i < 3; i++) {
    ticker.observe(f.observed());
    ticker.tick();
    f.advance(100);
  }
  assert.ok(scopes.every((scope) => scope.length === 1), "each repository has its own measured cold build");
  assert.deepEqual([...new Set(scopes.flat())].sort(), ["console", "core", "site"], "every repository gets a build");
  assert.equal(posts.some((msg) => msg.type === "view_lane" && msg.heavy), false, "the sum of unrelated costs cannot promote every repo");
  const proposals = posts.flatMap((msg) => msg.type === "body" && msg.entry.key.includes("part=proposals") ? [msg.entry.body.data as AgentViewData] : []);
  assert.deepEqual([...new Set(proposals.map((proposal) => proposal.instance))].sort(), ["console", "core", "site"]);
  for (const proposal of proposals) {
    const body = proposal.body as AgentProposalsBody;
    assert.ok(body.records && body.records.length > 0, "real shared-store analytics produces proposals for this repo");
    assert.ok(body.records.every((record) => record.detail.state === "reported" && record.detail.repository === proposal.repository && record.detail.instanceId === proposal.instance));
  }
});

test("repository-scoped agent builds retain home analytics and refuse foreign evidence", (t) => {
  const f = repositoryUnitFixture(t);
  const home = openProjectorReadModel(f.stateDir, "core"), site = openProjectorReadModel(f.stateDir, "site");
  t.after(() => { site.close(); home.close(); });
  const view = createAgentView({ instances: f.instances, ledgerSource });
  const context = { now: NOW, sourceStore: home, instances: [{ state: state("site"), db: site }] };
  assert.equal(view.prepare(context, () => true), true);
  const read = () => view.materialize(context).find((body) => body.key === agentViewKey("site", "proposals"))!.data.body as AgentProposalsBody;
  const positive = read();
  assert.ok(positive.records && positive.records.length > 0, "a site-only unit still reads the home store's site snapshot");
  assert.ok(positive.records.every((record) => record.detail.state === "reported" && record.detail.repository === "owner/site" && record.detail.instanceId === "site"));
  const foreign = { ...busySnapshot(), asOf: new Date(NOW - 30_000).toISOString() };
  assert.equal(f.projector.acceptSnapshot({ instance: "site", ok: true, asOf: foreign.asOf!,
    bodies: analyticsSourceBodies(foreign, "owner/foreign") }), true);
  const refused = read();
  assert.ok(refused.records && refused.records.length > 0, "ranks remain visible without relabeling foreign evidence");
  assert.ok(refused.records.every((record) => record.detail.state === "unavailable"));
  assert.equal(refused.coverage?.complete, 0);
});
