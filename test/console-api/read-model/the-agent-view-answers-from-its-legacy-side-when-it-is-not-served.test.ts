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

test("W1-T13180 criterion 1: with no agent switch entry serve answers /v1/views/agent from the worker's own readers, not 404 view_disabled", async (t) => {
  t.mock.method(systemClock, "now", () => NOW);
  const w = world(t);
  // Serve has no analytics refresh yet, so the worker's body to compare is the one built before any committed snapshot.
  const worker = workerBodies(w);
  const routes = buildServeRoutes(serveDeps(w));
  assert.ok(routes.some((route) => route.path === `/v1/views/${AGENT_VIEW_NAME}`), "serve routes the agent view");
  const base = await listen({ after: w.onClose }, routes);
  for (const part of PARTS) {
    const res = await get(base, `/v1/views/agent?instance=core&part=${part}`);
    assert.equal(res.status, 200, `${part}: ${JSON.stringify(res.body)}`);
    const body = res.body as ViewBody<AgentViewData>;
    assert.equal(body.view, AGENT_VIEW_NAME);
    assert.deepEqual(body.data, worker.get(agentViewKey("core", part))!.data, `${part} equals the worker's body over the same facts`);
  }
  // CONTROL: the bodies carry the ledger's facts, so equality is not two empty reads.
  const history = (await get(base, "/v1/views/agent?instance=core&part=history")).body as ViewBody<AgentViewData>;
  assert.match(JSON.stringify(history.data.body), /operator-agent:repo:fix:slow-runs/);
  const proposals = (await get(base, "/v1/views/agent?instance=core&part=proposals")).body as ViewBody<AgentViewData>;
  assert.deepEqual(proposals.data.body, { reason: "no analytics refresh has completed yet, so no proposal is generated" });
  assert.deepEqual(proposals.sources.map((source) => [source.name, source.state]), [["ledger:core", "fresh"], ["analytics:core", "unavailable"]]);
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

test("W1-T13180 criterion 2: shadow answers from the legacy side and still offers the request to the comparator; serve answers the worker's body", async (t) => {
  const w = world(t);
  const legacy = agentLegacyView({ scopes: () => [{ instanceId: "core", repository: REPO, analytics: busySnapshot, ledgerPath: w.ledgerPath }], clock: fixedClock(NOW) });
  const key = agentViewKey("core", "history");
  // A worker body marked so it cannot be mistaken for the legacy answer.
  const workerData = { instance: "core", part: "history", repository: REPO, body: { proposals: [], source: "worker-marker" } };
  const workerBody: ViewBody = { view: AGENT_VIEW_NAME, version: 1, generatedAt: iso(0), asOf: iso(0), stale: false, sources: [{ name: "ledger:core", asOf: iso(0), state: "fresh" }], data: workerData };
  const entry: ViewBodyEntry = { view: AGENT_VIEW_NAME, key, version: 1, generation: 1, etag: viewEtag(AGENT_VIEW_NAME, 1, false, workerData), body: workerBody };
  const expected = renderView(legacy, fixedClock(NOW), new URLSearchParams(key));
  assert.ok(!("error" in expected));

  const shadowed: string[] = [];
  const shadowBase = await listen({ after: w.onClose }, routesIn("shadow", legacy, entry, shadowed));
  const inShadow = await get(shadowBase, `/v1/views/agent?${key}`);
  assert.equal(inShadow.status, 200);
  assert.deepEqual((inShadow.body as ViewBody).data, expected.body.data, "shadow keeps legacy primary");
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
  assert.equal(inOff.status, 200, "no switch entry answers from the legacy side");
  assert.deepEqual((inOff.body as ViewBody).data, expected.body.data);
});

test("W1-T13180 criterion 3: invariant one-proposal-engine, the legacy answer equals the worker's body for every part over the same facts", (t) => {
  const w = world(t);
  writeSourceSnapshot(w.db, w.lease, { instance: "core", ok: true, asOf: ANALYTICS_AS_OF, bodies: analyticsSourceBodies(busySnapshot(), REPO) });
  const worker = workerBodies(w);
  const legacy = agentLegacyView({ scopes: () => [{ instanceId: "core", repository: REPO, analytics: busySnapshot, ledgerPath: w.ledgerPath }], clock: fixedClock(NOW) });
  for (const part of PARTS) {
    const rendered = renderView(legacy, fixedClock(NOW), new URLSearchParams({ instance: "core", part }));
    assert.ok(!("error" in rendered), part);
    const built = worker.get(agentViewKey("core", part))!;
    assert.deepEqual(rendered.body.data, built.data, `${part}: one engine, one answer`);
    assert.deepEqual(rendered.body.sources.map((source) => source.name), (built.sources as Array<{ name: string }>).map((source) => source.name), `${part} names the worker's sources`);
  }
  // CONTROL: the engine really ranked proposals, so the equality covers a ranking, not two refusals.
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
