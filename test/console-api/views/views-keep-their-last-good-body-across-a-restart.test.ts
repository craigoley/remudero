/**
 * W1-T13457: after a serve restart the Console's views answer their last committed body, marked stale, instead of
 * 404 `view_not_ready` or a repositories body with no summaries, so the Console stops falling back to its legacy
 * routes while serve warms. Invariant stale-says-so: a body carried across a restart is stale until this run's
 * worker posts that key.
 */
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { agentViewKey } from "#src/lib/agent-view.js";
import type { Clock } from "#src/lib/clock.js";
import { openProjectorReadModel } from "#src/lib/ledger-projector.js";
import { acquireLease, readModelSidecarDir, type ReadModelDb } from "#src/lib/read-model-db.js";
import { CARRIED_BODY_REASON, CARRIED_BODY_SOURCE, committedBody, createReadModelWorker, readModelSwitchesPath } from "#src/lib/read-model-worker.js";
import { REPOSITORIES_SOURCES_FILE, REPOSITORIES_VIEW_VERSION, committedRepositorySummaries, createRepositoriesReadModelView, type RepositoriesData } from "#src/lib/repositories-view.js";
import { buildReadModelViewRoutes, viewEtag, type ViewBody, type ViewSource } from "#src/lib/views.js";
import { onReadModelClose, readModelFixtureDir } from "#test/helpers/read-model-fixture-dir.js";

type TestCtx = { after: (fn: () => void | Promise<void>) => void };

const NOW = Date.now();
const iso = (ms: number): string => new Date(ms).toISOString();
const clock: Clock = { now: () => NOW, date: () => new Date(NOW), iso: () => iso(NOW) };
/** When the committed bodies were built: five seconds ago, inside the ledger budget, so by clocks alone they read fresh. */
const BUILT_AT = NOW - 5_000;
const AGENT_KEY = agentViewKey("core", "proposals");
const INBOX_KEY = "section=needsYou";
const SUMMARY = { repos: [{ id: "craigoley/remudero", reponame: "remudero", health: { status: "verified" } }], registry: { state: "available" } };
const VIEW_BODY_DDL = `CREATE TABLE IF NOT EXISTS view_body(view TEXT NOT NULL, key TEXT NOT NULL, version INTEGER NOT NULL,
  generation INTEGER NOT NULL, etag TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(view, key)) WITHOUT ROWID;`;

const fresh = (name: string): ViewSource => ({ name, asOf: iso(BUILT_AT), state: "fresh" });

/** The bodies the last serve committed: each was fresh when it was built. `instances` has no source of its own. */
const COMMITTED: Array<{ view: string; key: string; version: number; sources: ViewSource[]; data: unknown }> = [
  { view: "repositories", key: "", version: REPOSITORIES_VIEW_VERSION, sources: [fresh("ledger:core"), fresh("repositories:core")],
    data: { instances: [{ instanceId: "core", summary: SUMMARY }], projects: [] } },
  { view: "instances", key: "", version: 1, sources: [], data: { instances: [{ name: "core" }] } },
  { view: "inbox", key: INBOX_KEY, version: 1, sources: [fresh("ledger:core")], data: { items: [{ id: "ask-1" }] } },
  { view: "agent", key: AGENT_KEY, version: 1, sources: [fresh("ledger:core")], data: { part: "proposals", body: { proposals: [] } } },
];

function body(view: string, version: number, sources: ViewSource[], data: unknown): ViewBody {
  return { view, version, generatedAt: iso(BUILT_AT), asOf: iso(BUILT_AT), stale: false, sources, data };
}

/**
 * A store as a hard-killed serve leaves it (the OOM case): every committed body in place, and the projector lease
 * still held by the dead process, last renewed two seconds ago, so nothing released it.
 */
function killedServeStore(t: TestCtx, kind: string): string {
  const stateDir = readModelFixtureDir(t, kind).dir;
  const db = openProjectorReadModel(stateDir, "core");
  try {
    db.exec(VIEW_BODY_DDL);
    const insert = db.prepare("INSERT INTO view_body(view, key, version, generation, etag, body) VALUES(?, ?, ?, ?, ?, ?)");
    for (const row of COMMITTED) {
      insert.run(row.view, row.key, row.version, 7, viewEtag(row.view, row.version, false, row.data), JSON.stringify(body(row.view, row.version, row.sources, row.data)));
    }
    const killedAt = NOW - 2_000;
    acquireLease(db, { holder: "killed-serve", clock: { now: () => killedAt, date: () => new Date(killedAt), iso: () => iso(killedAt) } });
  } finally {
    db.close();
  }
  mkdirSync(dirname(readModelSwitchesPath(stateDir)), { recursive: true });
  writeFileSync(readModelSwitchesPath(stateDir), JSON.stringify({ projector: "on", views: Object.fromEntries(COMMITTED.map((row) => [row.view, "serve"])) }));
  return stateDir;
}

function read(routes: ReturnType<typeof buildReadModelViewRoutes>, path: string): { status: number; body: ViewBody & { error?: string } } {
  const route = routes.find((r) => r.path === path.split("?")[0])!;
  let status = 0;
  let text = "";
  const res = { headersSent: false, writeHead: (code: number) => ((status = code), res), end: (chunk?: string) => void (text += chunk ?? ""), once: () => res } as unknown as ServerResponse;
  void route.handler({ url: path, headers: {} } as never, res, {} as never);
  return { status, body: JSON.parse(text) as ViewBody & { error?: string } };
}

const PATHS = { repositories: "/v1/views/repositories", instances: "/v1/views/instances", inbox: `/v1/views/inbox?${INBOX_KEY}`, agent: `/v1/views/agent?${AGENT_KEY}` };

const SILENT_WORKER = new URL("data:text/javascript,setInterval(() => {}, 1000)");

test("W1-T13457 criterion 1: a restarted serve answers every committed body at once, stale with a warming reason", (t) => {
  const stateDir = killedServeStore(t, "carry-c1");
  const handle = createReadModelWorker({ stateDir, instances: [{ name: "core", ledgerDir: stateDir }], workerUrl: SILENT_WORKER, stopWaitMs: 20, clock, every: () => () => {} });
  onReadModelClose(t, () => void handle.stop());
  handle.start();
  const routes = buildReadModelViewRoutes({ legacy: [], readModelViews: Object.keys(PATHS), readModel: handle, clock });
  for (const [view, path] of Object.entries(PATHS)) {
    const answer = read(routes, path);
    assert.equal(answer.status, 200, `${view} answers its committed body before the worker's first body, not ${answer.body.error ?? answer.status}`);
    const committed = COMMITTED.find((row) => row.view === view)!;
    assert.deepEqual(answer.body.data, committed.data, `${view} answers the body the last serve committed`);
    assert.equal(answer.body.stale, true, `${view} says it is stale`);
    const ledger = answer.body.sources.filter((source) => source.name.startsWith("ledger:"));
    assert.ok(ledger.every((source) => source.state === "stale" && source.phase === "warming" && source.reason === CARRIED_BODY_REASON),
      `${view}: every ledger source is stale, warming, and says the body was carried`);
  }
  const sourceless = read(routes, PATHS.instances).body.sources;
  assert.deepEqual(sourceless.map((source) => [source.name, source.state, source.reason]), [[CARRIED_BODY_SOURCE, "stale", CARRIED_BODY_REASON]],
    "a body with no clock of its own still says it is carried");
});

test("W1-T13457 criterion 2: the repositories view never publishes an empty or summary-less instances list over a committed one while an instance warms", (t) => {
  const stateDir = readModelFixtureDir(t, "carry-c2").dir;
  const db: ReadModelDb = openProjectorReadModel(stateDir, "core");
  onReadModelClose(t, () => db.close());
  const sourcesPath = join(readModelSidecarDir(dirname(db.path)), REPOSITORIES_SOURCES_FILE);
  writeFileSync(sourcesPath, JSON.stringify({ instances: [{ instanceId: "core", options: { root: stateDir } }] }));
  const committedRow = COMMITTED.find((row) => row.view === "repositories")!;
  const committed = (view: string, key: string): ViewBody | undefined =>
    view === "repositories" && key === "" ? body(view, committedRow.version, committedRow.sources, committedRow.data) : undefined;
  // The projector has opened the store but not ticked since serve started: the instance is warming.
  const warming = [{ state: { instance: "core", generation: 0 }, db }];
  const warmingSourceOf = (state: { instance: string }): ViewSource => ({ name: `ledger:${state.instance}`, asOf: null, state: "stale", phase: "warming", reason: "projector has not ticked yet" });

  // Positive control: with nothing committed the warming build carries no summary, which is what overwrote the store.
  const cold = createRepositoriesReadModelView(warmingSourceOf).materialize({ now: NOW, instances: warming });

  assert.equal(cold[0]!.data.instances[0]!.summary, undefined, "control: a first-ever boot has no summary to carry");

  const view = createRepositoriesReadModelView(warmingSourceOf);
  const [carried] = view.materialize({ now: NOW, instances: warming, committed });
  const instance = carried!.data.instances[0]!;
  assert.deepEqual(instance.summary, SUMMARY, "the committed summary is carried, not replaced by an instance with none");
  assert.match(instance.reason ?? "", /not projected/, "the instance still says why it was not recomputed");
  const source = carried!.sources.find((s) => s.name === "repositories:core")!;
  assert.deepEqual([source.state, source.phase, source.asOf], ["stale", "warming", iso(BUILT_AT)], "its source is stale, warming, and as old as the committed summary");
  assert.match(source.reason ?? "", /committed before serve restarted/);
  assert.deepEqual(carried!.data.projects.flatMap((p) => p.repos.map((r) => [r.id, r.state])), [["craigoley/remudero", "stale"]], "the portfolio keeps the repository, marked stale");
  assert.equal(view.legacy("", NOW, carried!.data), undefined, "a carried summary has no facts of this run to pair, so it is not shadow-sampled");

  rmSync(sourcesPath);
  const [kept] = createRepositoriesReadModelView(warmingSourceOf).materialize({ now: NOW, instances: warming, committed });
  assert.deepEqual(kept!.data.instances, committedRow.data && (committedRow.data as RepositoriesData).instances, "unpublished sources keep the committed instances, never an empty list");
  assert.match(kept!.data.reason ?? "", /not published/, "and name why nothing was recomputed");
  assert.ok(kept!.sources.length > 0 && kept!.sources.every((s) => s.state === "stale" && s.phase === "warming"), "every source of the kept portfolio is stale");
  assert.deepEqual(createRepositoriesReadModelView(warmingSourceOf).materialize({ now: NOW, instances: warming })[0]!.data.instances, [], "control: a first-ever boot still says the sources are unpublished");

  assert.deepEqual([...committedRepositorySummaries(committed)].map(([id, s]) => [id, s.generated_at]), [["core", iso(BUILT_AT)]], "the carried summary is stamped with its source's as-of");
  assert.equal(committedRepositorySummaries(() => ({ ...body("repositories", REPOSITORIES_VIEW_VERSION + 1, [], committedRow.data) })).size, 0, "a body of another version is not carried");
  assert.equal(committedBody(db, "repositories", ""), undefined, "an empty store has no committed body");
});

/** A stand-in worker: posts a fresh repositories body and a projector that has ticked, and nothing for the agent key. */
function postingWorker(dir: string): URL {
  const path = join(dir, "worker.mjs");
  const data = (COMMITTED.find((row) => row.view === "repositories")!.data as RepositoriesData);
  const sources = [{ name: "ledger:core", asOf: iso(NOW - 1_000), state: "fresh" }, { name: "repositories:core", asOf: iso(NOW - 1_000), state: "fresh" }];
  const entry = { view: "repositories", key: "", version: REPOSITORIES_VIEW_VERSION, generation: 8, etag: viewEtag("repositories", REPOSITORIES_VIEW_VERSION, false, data),
    body: { view: "repositories", version: REPOSITORIES_VIEW_VERSION, generatedAt: iso(NOW - 1_000), asOf: iso(NOW - 1_000), stale: false, sources, data } };
  const state = { instance: "core", generation: 8, lease: "held", failures: 0, newestTs: iso(NOW - 1_000), tickedAt: NOW - 500 };
  writeFileSync(path, `import { parentPort } from "node:worker_threads";
parentPort.postMessage({ type: "state", at: ${NOW - 500}, instances: [${JSON.stringify(state)}], switches: { projector: "on", views: {} } });
parentPort.postMessage({ type: "body", entry: ${JSON.stringify(entry)} });
setInterval(() => {}, 1000);
`);
  return pathToFileURL(path);
}

test("W1-T13457 criterion 3: invariant:stale-says-so — a carried body is judged stale until the worker posts that key", async (t) => {
  const stateDir = killedServeStore(t, "carry-c3");
  const handle = createReadModelWorker({ stateDir, instances: [{ name: "core", ledgerDir: stateDir }], workerUrl: postingWorker(stateDir), stopWaitMs: 20, clock, every: () => () => {} });
  onReadModelClose(t, () => void handle.stop());
  const routes = buildReadModelViewRoutes({ legacy: [], readModelViews: Object.keys(PATHS), readModel: handle, clock });
  // The dead serve renewed its lease two seconds ago and the rows are five seconds old: by clocks alone this would read fresh.
  assert.equal(read(routes, PATHS.repositories).body.stale, true, "before the worker posts, the carried body is stale whatever its clocks say");
  handle.start();
  const deadline = Date.now() + 10_000;
  while (handle.state().instances.get("core")?.tickedAt === undefined && Date.now() < deadline) await sleep(10);
  while (read(routes, PATHS.repositories).body.stale && Date.now() < deadline) await sleep(10);
  const rebuilt = read(routes, PATHS.repositories).body;
  assert.equal(rebuilt.stale, false, "the key the worker posted is judged by its own build");
  assert.ok(rebuilt.sources.every((source) => source.reason !== CARRIED_BODY_REASON));
  const agent = read(routes, PATHS.agent).body;
  assert.equal(agent.stale, true, "a key the worker has not posted stays stale even after the projector ticked");
  assert.ok(agent.sources.some((source) => source.reason === CARRIED_BODY_REASON), "and says it is carried");
});
