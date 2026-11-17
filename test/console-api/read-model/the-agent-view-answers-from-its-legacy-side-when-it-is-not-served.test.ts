// W1-T13180: the console's agent pages read only `/v1/views/agent`, and with no `agent` entry in
// read-model/switches.json the view is `off`. With no legacy side it answered 404 `view_disabled` on every
// request (87 of 87 on 2026-11-16). Serve now gives the view a legacy side: agentPartBodies, the readers the
// worker's body is built by, over the instance's own ledger and analytics, so the two sides cannot disagree.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { AGENT_VIEW_NAME, AGENT_VIEW_PARTS, agentLegacyView, agentViewKey, createAgentView, type AgentProposalsBody, type AgentViewData, type AgentViewPart } from "#src/lib/agent-view.js";
import { coldAnalyticsSnapshot, type AnalyticsSnapshot } from "#src/lib/analytics-route.js";
import { analyticsSourceBodies } from "#src/lib/analytics-view.js";
import { fixedClock, systemClock } from "#src/lib/clock.js";
import { openProjectorReadModel } from "#src/lib/ledger-projector.js";
import { OPERATOR_AGENT_PROPOSAL_STEP, OPERATOR_AGENT_SETTINGS_STEP } from "#src/lib/operator-agent.js";
import { acquireLease, flushReadModelTransactions, writeSourceSnapshot, type ReadModelDb, type ReadModelLease } from "#src/lib/read-model-db.js";
import { createReadModelTicker, ledgerSource, type ReadModelInstanceState } from "#src/lib/read-model-worker.js";
import { buildServeRoutes, type ServeDeps } from "#src/lib/serve.js";
import { buildReadModelViewRoutes, renderView, viewEtag, type ViewBody, type ViewBodyEntry, type ViewSwitchMode } from "#src/lib/views.js";
import { get, listen } from "#test/helpers/operator-agent-corpus.js";
import { readModelFixtureDir, type ReadModelFixtureTestScope } from "#test/helpers/read-model-fixture-dir.js";

const NOW = Date.parse("2026-09-20T11:00:00.000Z");
const REPO = "owner/repo";
const ANALYTICS_AS_OF = new Date(NOW - 60_000).toISOString();
const iso = (msAgo: number): string => new Date(NOW - msAgo).toISOString();
const state = (): ReadModelInstanceState => ({ instance: "core", generation: 1, lease: "held", failures: 0, newestTs: null, tickedAt: NOW });
const PARTS = Object.keys(AGENT_VIEW_PARTS) as AgentViewPart[];

/** An analytics refresh whose metrics and routing buckets make the one engine propose something. */
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

/** Core's ledger with a durable proposal and repository-scoped settings, projected into core's store under this test's lease. */
function world(t: ReadModelFixtureTestScope): { root: string; stateDir: string; ledgerPath: string; db: ReadModelDb; lease: ReadModelLease; onClose: (close: () => unknown) => void } {
  const { dir: root, onClose } = readModelFixtureDir(t, "agent-legacy-side");
  const stateDir = join(root, "state");
  mkdirSync(stateDir, { recursive: true });
  const ledgerPath = join(stateDir, "ledger.ndjson");
  writeFileSync(ledgerPath, [
    { ts: iso(120_000), step: OPERATOR_AGENT_PROPOSAL_STEP, task_id: "operator-agent", proposal: { proposalId: "operator-agent:repo:fix:slow-runs", repo: REPO, proposalText: "t", confidence: 0.95, reasoning: "r", category: "fix", status: "pending", createdAt: iso(120_000), evidence: [] } },
    { ts: iso(110_000), step: OPERATOR_AGENT_SETTINGS_STEP, task_id: "operator-agent", settings: { enabled: true, confidenceThreshold: 0.5 }, scope: { kind: "repository", repository: REPO } },
  ].map((row) => `${JSON.stringify(row)}\n`).join(""));
  const ticker = createReadModelTicker({ stateDir, instances: [{ name: "core", ledgerDir: stateDir }], views: [], holder: "agent-legacy-test", post: () => {} });
  for (let i = 0; i < 5; i++) ticker.tick();
  ticker.release();
  const db = openProjectorReadModel(stateDir, "core");
  onClose(() => db.close());
  onClose(flushReadModelTransactions);
  const got = acquireLease(db, { holder: "agent-legacy-test" });
  assert.ok(got.ok, "the test holds the store's lease");
  return { root, stateDir, ledgerPath, db, lease: got.lease, onClose };
}

/** The worker's bodies for core, one per part, built the way the read-model worker builds them. */
function workerBodies(w: ReturnType<typeof world>): Map<string, { data: AgentViewData; sources: unknown[] }> {
  const view = createAgentView({ instances: [{ name: "core", ledgerDir: w.stateDir, repo: REPO }], ledgerSource });
  const instances = [{ state: state(), db: w.db, lease: w.lease }];
  assert.equal(view.prepare({ instances }, () => true), true);
  return new Map(view.materialize({ now: NOW, instances }).map((entry) => [entry.key, { data: entry.data, sources: entry.sources }]));
}

/** Serve's whole route list over core's ledger, with no read-model worker and so no switch entry: every view is `off`. */
function serveDeps(w: ReturnType<typeof world>): ServeDeps {
  const github = { prByRef: () => null, findMergedByTrailer: () => null, headRefName: () => undefined, prBody: () => undefined };
  mkdirSync(join(w.root, "plan"), { recursive: true });
  writeFileSync(join(w.root, "plan", "tasks.yaml"), "[]\n");
  return {
    board: { plan: { tasks: [], byId: new Map() }, ledgerPath: w.ledgerPath, github },
    panelGraph: { root: w.root, planPath: join(w.root, "plan", "tasks.yaml"), ledgerPath: w.ledgerPath, github: { prView: () => null }, statusGithub: github, ratify: { approve: () => {}, reframe: () => {} } },
    ledgerPath: w.ledgerPath,
    issues: { close: () => {} },
    fleetControlRoot: w.root,
    questionsRoot: w.root,
    tokens: { read: "r", write: "w" },
    consoleSha: "aaaaaaaa",
    resolveCurrentSha: () => "aaaaaaaa",
    gatewayCheckout: async () => ({ state: "clean" }) as never,
    githubAppRefresh: { start: () => ({ armed: false, stop() {} }) as never },
    instances: { stateBase: join(w.root, "instances") },
    assistantRepository: REPO,
  };
}

test("W1-T13180 criterion 1: with no agent switch entry serve routes /v1/views/agent and, with no worker body, answers 503 view_not_ready, not 404 view_disabled (W1-T13282)", async (t) => {
  t.mock.method(systemClock, "now", () => NOW);
  const w = world(t);
  const routes = buildServeRoutes(serveDeps(w));
  assert.ok(routes.some((route) => route.path === `/v1/views/${AGENT_VIEW_NAME}`), "serve routes the agent view");
  const base = await listen({ after: w.onClose }, routes);
  for (const part of PARTS) {
    const res = await get(base, `/v1/views/agent?instance=core&part=${part}`);
    assert.equal(res.status, 503, `${part}: ${JSON.stringify(res.body)}`);
    assert.equal((res.body as { error: string }).error, "view_not_ready", part);
  }
});

/** The agent view's routes as serve builds them, over a read model whose switch for the view is `mode`. */
function routesIn(mode: ViewSwitchMode | undefined, legacy: ReturnType<typeof agentLegacyView>, entry: ViewBodyEntry | undefined, shadowed: string[]) {
  return buildReadModelViewRoutes({
    legacy: [legacy],
    readModelViews: [AGENT_VIEW_NAME],
    requiredParams: { [AGENT_VIEW_NAME]: ["instance", "part"] },
    clock: fixedClock(NOW),
    shadow: (view, key) => void shadowed.push(`${view}:${key}`),
    readModel: {
      switches: () => ({ views: (mode ? { [AGENT_VIEW_NAME]: mode } : {}) as Record<string, ViewSwitchMode> }),
      body: (view, key) => (view === AGENT_VIEW_NAME && entry && key === entry.key ? entry : undefined),
      judge: (sources) => [...sources],
    },
  });
}

test("W1-T13180 criterion 2: shadow answers from the legacy side (not ready since W1-T13282) and still offers the request to the comparator; serve answers the worker's body", async (t) => {
  const w = world(t);
  const legacy = agentLegacyView({ scopes: () => [{ instanceId: "core", repository: REPO, analytics: busySnapshot, ledgerPath: w.ledgerPath }], clock: fixedClock(NOW) });
  const key = agentViewKey("core", "history");
  // A worker body marked so it cannot be mistaken for the legacy answer.
  const workerData = { instance: "core", part: "history", repository: REPO, body: { proposals: [], source: "worker-marker" } };
  const workerBody: ViewBody = { view: AGENT_VIEW_NAME, version: 1, generatedAt: iso(0), asOf: iso(0), stale: false, sources: [{ name: "ledger:core", asOf: iso(0), state: "fresh" }], data: workerData };
  const entry: ViewBodyEntry = { view: AGENT_VIEW_NAME, key, version: 1, generation: 1, etag: viewEtag(AGENT_VIEW_NAME, 1, false, workerData), body: workerBody };
  const shadowed: string[] = [];
  const shadowBase = await listen({ after: w.onClose }, routesIn("shadow", legacy, entry, shadowed));
  const inShadow = await get(shadowBase, `/v1/views/agent?${key}`);
  assert.equal(inShadow.status, 503, "shadow keeps the legacy side primary, and it is not ready (W1-T13282)");
  for (let i = 0; i < 50 && shadowed.length === 0; i++) await new Promise((done) => setImmediate(done));
  assert.deepEqual(shadowed, [`${AGENT_VIEW_NAME}:${key}`], "the shadowed request is offered to the comparator once it finished");

  const served: string[] = [];
  const serveBase = await listen({ after: w.onClose }, routesIn("serve", legacy, entry, served));
  const inServe = await get(serveBase, `/v1/views/agent?${key}`);
  assert.equal(inServe.status, 200);
  assert.deepEqual((inServe.body as ViewBody).data, workerData, "serve answers the worker's body as before");
  assert.deepEqual(served, [], "serve is not sampled");

  const offBase = await listen({ after: w.onClose }, routesIn(undefined, legacy, entry, []));
  const inOff = await get(offBase, `/v1/views/agent?${key}`);
  assert.equal(inOff.status, 503, "with no switch entry and no serve default here, the legacy side answers not ready");
});

test("W1-T13180 criterion 3: invariant one-proposal-engine, the worker's body is the only proposal engine and the legacy side computes none (W1-T13282)", (t) => {
  const w = world(t);
  writeSourceSnapshot(w.db, w.lease, { instance: "core", ok: true, asOf: ANALYTICS_AS_OF, bodies: analyticsSourceBodies(busySnapshot(), REPO) });
  const worker = workerBodies(w);
  const legacy = agentLegacyView({ scopes: () => [{ instanceId: "core", repository: REPO, analytics: busySnapshot, ledgerPath: w.ledgerPath }], clock: fixedClock(NOW) });
  for (const part of PARTS) {
    const rendered = renderView(legacy, fixedClock(NOW), new URLSearchParams({ instance: "core", part }));
    assert.ok("error" in rendered && rendered.error === "view_not_ready", `${part}: the legacy side ranks nothing`);
  }
  // CONTROL: the engine really ranked proposals, so the worker is the one engine, not two refusals.
  const proposals = worker.get(agentViewKey("core", "proposals"))!.data.body as AgentProposalsBody;
  assert.ok((proposals.proposals ?? []).length > 0, JSON.stringify(proposals));
  assert.equal(proposals.records?.length, proposals.proposals!.length, "each ranked proposal carries its record");
});

test("W1-T13180 criterion 4: a request without instance or part, or naming an unknown part or instance, still answers 400", async (t) => {
  t.mock.method(systemClock, "now", () => NOW);
  const w = world(t);
  const base = await listen({ after: w.onClose }, buildServeRoutes(serveDeps(w)));
  for (const [query, detail] of [["?part=history", /needs \?instance=/], ["?instance=core", /needs \?part=/], ["", /needs \?instance=/]] as const) {
    const res = await get(base, `/v1/views/agent${query}`);
    assert.equal(res.status, 400, query);
    assert.equal((res.body as { error: string }).error, "invalid_request", query);
    assert.match((res.body as { detail: string }).detail, detail, query);
  }
  const unknownPart = await get(base, "/v1/views/agent?instance=core&part=nope");
  assert.equal(unknownPart.status, 400);
  assert.match(JSON.stringify(unknownPart.body), /unknown agent part: nope/);
  const unknownInstance = await get(base, "/v1/views/agent?instance=elsewhere&part=history");
  assert.equal(unknownInstance.status, 400);
  assert.deepEqual(unknownInstance.body, { error: "invalid_request", detail: "unknown instance: elsewhere; serve has core" });
  // An unknown part is refused in serve mode too, before a held body could answer.
  const legacy = agentLegacyView({ scopes: () => [{ instanceId: "core", repository: REPO, analytics: busySnapshot, ledgerPath: w.ledgerPath }], clock: fixedClock(NOW) });
  const served = await listen({ after: w.onClose }, routesIn("serve", legacy, undefined, []));
  const inServe = await get(served, "/v1/views/agent?instance=core&part=nope");
  assert.equal(inServe.status, 400);
});
