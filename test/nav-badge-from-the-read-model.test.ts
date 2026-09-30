import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { coldAnalyticsSnapshot, createAnalyticsSnapshotCache, type AnalyticsSnapshot } from "../src/lib/analytics-route.js";
import { fixedClock, systemClock } from "../src/lib/clock.js";
import {
  createNavBadgeReadModelView,
  createNavBadgeSourcePublisher,
  navBadgeSourcesPath,
  navBadgeView,
  operatorAgentCandidates,
  startNavBadgeSourcePublisher,
  type NavBadgeData,
  type NavBadgeScope,
} from "../src/lib/nav-badge-view.js";
import {
  OPERATOR_AGENT_DECISION_STEP,
  OPERATOR_AGENT_OUTCOME_STEP,
  OPERATOR_AGENT_PROPOSAL_STEP,
  OPERATOR_AGENT_SETTINGS_STEP,
  createOperatorAgentMemorySource,
} from "../src/lib/operator-agent.js";
import {
  createReadModelTicker,
  createReadModelWorker,
  ledgerSource,
  readModelSwitchesPath,
  type ReadModelBodyEntry,
  type ReadModelWorkerMessage,
} from "../src/lib/read-model-worker.js";
import { buildServeServer, darkReadModelViews, type ServeDeps } from "../src/lib/serve.js";
import { makeTempDir } from "../src/lib/tmp.js";
import { buildReadModelViewRoutes, renderView, type ViewBody } from "../src/lib/views.js";

// P1-07: the nav badge materialized by the read-model worker must be the Phase 0 (#8042) answer,
// persisted so a restarted serve answers warm, and dark until the switch file names it `serve`.

const NOW = systemClock.now();
const CLOCK = fixedClock(NOW);
const CORE_REPO = "craigoley/remudero";
const CONSOLE_REPO = "craigoley/remudero-console";
const SILENT_WORKER = new URL("data:text/javascript,setInterval(() => {}, 1000)");

type TestCtx = { after: (fn: () => void) => void };

function scratch(t: TestCtx, kind: string): string {
  const dir = makeTempDir(kind);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function iso(msAgo: number): string {
  return new Date(NOW - msAgo).toISOString();
}

function busySnapshot(asOf: string | null = iso(60_000)): AnalyticsSnapshot {
  const base = coldAnalyticsSnapshot();
  const snapshot = {
    ...base,
    asOf,
    consoleV1: {
      ...base.consoleV1,
      metrics: [
        { key: "runs.completed", class: "observed", value: 10 },
        { key: "tokens.total", class: "provider_reported", value: 1_000_000 },
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

function candidateId(repository: string, instanceId: string, signal: string): string {
  const found = operatorAgentCandidates(busySnapshot(), { repository, instanceId }, []).find((c) => c.signal === signal);
  assert.ok(found, `the busy snapshot proposes ${signal}`);
  return found.proposalId;
}

function proposalRow(msAgo: number, proposalId: string, repo: string, category: string): string {
  return JSON.stringify({
    ts: iso(msAgo), step: OPERATOR_AGENT_PROPOSAL_STEP,
    proposal: { proposalId, repo, proposalText: "t", confidence: 0.9, reasoning: "r", category, status: "pending", createdAt: iso(msAgo), evidence: [] },
  });
}

/** Two instances' panel facts: accepted, rejected-elsewhere, an outcome, a scoped threshold and a malformed row. */
function panelCorpus(): { core: { archive: string[]; live: string[] }; console: { archive: string[]; live: string[] } } {
  const coreBurn = candidateId(CORE_REPO, "core", "token-burn");
  const coreFailure = candidateId(CORE_REPO, "core", "worker-failure-rate-implement-sonnet");
  const accepted = [proposalRow(3_600_000, coreBurn, CORE_REPO, "optimize"), JSON.stringify({ ts: iso(3_000_000), step: OPERATOR_AGENT_DECISION_STEP, proposal_id: coreBurn, decision: "accepted", at: iso(3_000_000) })];
  const outcome = JSON.stringify({ ts: iso(2_000_000), step: OPERATOR_AGENT_OUTCOME_STEP, proposal_id: coreFailure, outcome: { summary: "s", helped: false, observedAt: iso(2_000_000) } });
  const elsewhere = "operator-agent:elsewhere:x:optimize:token-burn";
  const rejected = [proposalRow(1_800_000, elsewhere, CONSOLE_REPO, "optimize"), JSON.stringify({ ts: iso(1_700_000), step: OPERATOR_AGENT_DECISION_STEP, proposal_id: elsewhere, decision: "rejected", at: iso(1_700_000) })];
  const settings = JSON.stringify({ ts: iso(1_000_000), step: OPERATOR_AGENT_SETTINGS_STEP, settings: { enabled: true, confidenceThreshold: 0.99 }, scope: { kind: "repository", repository: CONSOLE_REPO } });
  const malformed = JSON.stringify({ ts: iso(900_000), step: OPERATOR_AGENT_PROPOSAL_STEP, proposal: { proposalId: "bad" } });
  const noise = JSON.stringify({ ts: iso(800_000), step: "run.start", task_id: "W1-T1" });
  return {
    core: { archive: [...accepted, noise], live: [accepted[1], outcome, malformed] },
    console: { archive: rejected, live: [settings, noise] },
  };
}

function writeLedger(dir: string, archive: string[], live: string[]): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `ledger.${new Date(NOW - 3_500_000).toISOString().replace(/[:.]/g, "-")}.ndjson.gz`), gzipSync(`${archive.join("\n")}\n`));
  writeFileSync(join(dir, "ledger.ndjson"), `${live.join("\n")}\n`);
}

interface Fixture {
  stateDir: string;
  consoleDir: string;
  inboxRoot: string;
  scopes: NavBadgeScope[];
}

/** The legacy inputs exactly as serve builds them: each instance's memory from its own analytics refresh. */
async function fixture(t: TestCtx, opts: { inbox?: boolean } = {}): Promise<Fixture> {
  const root = scratch(t, "nav-badge-rm");
  const stateDir = join(root, "state");
  const consoleDir = join(root, "instances", "console", "state");
  const corpus = panelCorpus();
  writeLedger(stateDir, corpus.core.archive, corpus.core.live);
  writeLedger(consoleDir, corpus.console.archive, corpus.console.live);
  if (opts.inbox !== false) {
    writeFileSync(join(stateDir, "inbox-classified.json"), JSON.stringify({ generatedAt: iso(30_000), states: { "ruling:a": "ready", "ruling:b": "not_ready", "ruling:c": "declined", "adoption:x": "ready", "adoption:y": "drafting" } }));
  }
  const scopes: NavBadgeScope[] = [];
  for (const [instanceId, repository, dir] of [["core", CORE_REPO, stateDir], ["console", CONSOLE_REPO, consoleDir]] as const) {
    const cache = createAnalyticsSnapshotCache({ stateDir: dir, clock: CLOCK });
    await cache.refresh();
    assert.equal(cache.current().operatorAgentMemory.state, "ready", `${instanceId}'s analytics refresh read its ledger`);
    scopes.push({ instanceId, repository, analytics: () => busySnapshot(), memory: createOperatorAgentMemorySource(() => cache.current().operatorAgentMemory), ledgerPath: join(dir, "ledger.ndjson") });
  }
  return { stateDir, consoleDir, inboxRoot: root, scopes };
}

function tickBodies(f: Fixture, opts: { holder?: string; now?: number } = {}): Map<string, ReadModelBodyEntry> {
  const bodies = new Map<string, ReadModelBodyEntry>();
  const ticker = createReadModelTicker({
    stateDir: f.stateDir,
    instances: [{ name: "core", ledgerDir: f.stateDir }, { name: "console", ledgerDir: f.consoleDir }],
    views: [createNavBadgeReadModelView(ledgerSource)],
    clock: fixedClock(opts.now ?? NOW),
    holder: opts.holder ?? "serve-a",
    post: (m: ReadModelWorkerMessage) => void (m.type === "body" && bodies.set(m.entry.key, m.entry)),
  });
  ticker.tick();
  ticker.release();
  return bodies;
}

function legacyData(f: Fixture, query = ""): NavBadgeData {
  const rendered = renderView(navBadgeView({ scopes: () => f.scopes, inboxRoot: f.inboxRoot, clock: CLOCK }), CLOCK, new URLSearchParams(query));
  assert.ok(!("error" in rendered));
  return rendered.body.data;
}

function data(entry: ReadModelBodyEntry | undefined): NavBadgeData {
  assert.ok(entry, "the worker materialized this body");
  return entry.body.data as NavBadgeData;
}

test("the read-model nav badge equals the phase 0 computation over the same inputs", async (t) => {
  const f = await fixture(t);
  assert.equal(createNavBadgeSourcePublisher({ stateDir: f.stateDir, inboxStateDir: join(f.inboxRoot, "state"), scopes: () => f.scopes })(), true);
  const bodies = tickBodies(f);

  const legacy = legacyData(f);
  // The fixture must discriminate: decisions, a scoped threshold and the inbox all move the counts.
  assert.equal(legacy.agent.count, 1, "core's token-burn was accepted and console's threshold 0.99 hides its worker-failure proposal");
  assert.deepEqual(legacy.inbox, { ready: 1, needsYou: 2, fleet: 2 });
  assert.deepEqual(data(bodies.get("")), legacy);
  for (const instance of ["core", "console"]) {
    assert.deepEqual(data(bodies.get(`instances=${instance}`)), legacyData(f, `instances=${instance}`), `${instance} alone`);
  }
  const sources = bodies.get("")!.body.sources.map((source) => source.name);
  assert.deepEqual(sources, ["analytics:core", "analytics:console", "ledger:core", "ledger:console", "inbox-classification"]);
});

test("a restarted serve answers the read-model nav badge warm from its persisted body and analytics source", async (t) => {
  const f = await fixture(t);
  createNavBadgeSourcePublisher({ stateDir: f.stateDir, inboxStateDir: join(f.inboxRoot, "state"), scopes: () => f.scopes })();
  const before = data(tickBodies(f).get(""));

  // The next process's analytics caches are cold: publishing keeps the persisted slice, never a null.
  const coldScopes = f.scopes.map((scope) => ({ ...scope, analytics: () => busySnapshot(null) }));
  assert.equal(createNavBadgeSourcePublisher({ stateDir: f.stateDir, inboxStateDir: join(f.inboxRoot, "state"), scopes: () => coldScopes })(), true);
  const warm = createReadModelWorker({ stateDir: f.stateDir, instances: [{ name: "core", ledgerDir: f.stateDir }] });
  assert.deepEqual(warm.body("nav-badge")?.body.data, before, "the committed body answers before the first tick");

  const after = tickBodies({ ...f, scopes: coldScopes }, { holder: "serve-b", now: NOW + 1_000 });
  assert.equal(data(after.get("")).agent.count, 1);
  assert.deepEqual(data(after.get("")), before, "counted from the persisted analytics source");
});

test("a cold source reads absent with a reason and never zero", async (t) => {
  const f = await fixture(t, { inbox: false });
  const unpublished = data(tickBodies(f).get(""));
  assert.equal(unpublished.agent.count, undefined);
  assert.equal(unpublished.agent.atLeast, undefined);
  assert.match(unpublished.agent.reason ?? "", /not published/);
  assert.deepEqual(Object.keys(unpublished.inbox), ["reason"]);

  const coldConsole = f.scopes.map((scope) => (scope.instanceId === "console" ? { ...scope, analytics: () => busySnapshot(null) } : scope));
  createNavBadgeSourcePublisher({ stateDir: f.stateDir, inboxStateDir: join(f.inboxRoot, "state"), scopes: () => coldConsole })();
  const partial = tickBodies(f, { holder: "serve-b" }).get("")!;
  const agent = data(partial).agent;
  assert.equal(agent.count, undefined, "a partial sum is never a total");
  assert.equal(agent.atLeast, 1);
  assert.deepEqual(agent.instances.find((i) => i.instanceId === "console"), { instanceId: "console", repository: CONSOLE_REPO, reason: "analytics has not completed its first refresh" });
  assert.deepEqual(data(partial).inbox, { reason: "no inbox classification has been written yet" });
  assert.equal(partial.body.stale, true);
  assert.deepEqual(partial.body.sources.filter((s) => s.state === "unavailable").map((s) => s.name), ["analytics:console", "inbox-classification"]);
});

test("an instance the read model has not projected is not counted", async (t) => {
  const f = await fixture(t);
  createNavBadgeSourcePublisher({ stateDir: f.stateDir, inboxStateDir: join(f.inboxRoot, "state"), scopes: () => f.scopes })();
  const bodies = new Map<string, ReadModelBodyEntry>();
  const view = createNavBadgeReadModelView(ledgerSource);
  const ticker = createReadModelTicker({ stateDir: f.stateDir, instances: [{ name: "core", ledgerDir: f.stateDir }], views: [view], clock: CLOCK, post: (m) => void (m.type === "body" && bodies.set(m.entry.key, m.entry)) });
  ticker.tick();
  ticker.release();
  assert.deepEqual(data(bodies.get("instances=console")).agent, {
    proposalIds: [], instances: [{ instanceId: "console", repository: CONSOLE_REPO, reason: "the read model does not project this instance" }], reason: "1 of 1 instances not counted",
  });
  const unticked = view.materialize({ now: NOW, instances: [{ state: { instance: "core", generation: 0, lease: "none", failures: 0, newestTs: null }, db: { path: join(f.stateDir, "read-model", "core.v1.sqlite") } as never }] });
  assert.match((unticked[1].data as NavBadgeData).agent.instances[0].reason ?? "", /has not projected/);
  assert.deepEqual(view.materialize({ now: NOW, instances: [] }), [], "no read model open: nothing to materialize");
});

test("the source publisher writes only on change and keeps running when a write fails", (t) => {
  const root = scratch(t, "nav-badge-pub");
  const scope: NavBadgeScope = { instanceId: "core", repository: CORE_REPO, analytics: () => busySnapshot(), ledgerPath: join(root, "ledger.ndjson") };
  const publish = createNavBadgeSourcePublisher({ stateDir: root, inboxStateDir: root, scopes: () => [scope] });
  assert.equal(publish(), true);
  assert.equal(publish(), false, "an unchanged slice is not rewritten");

  let run: (() => void) | undefined;
  let stopped = false;
  const logs: string[] = [];
  writeFileSync(join(root, "blocker"), "");
  const stop = startNavBadgeSourcePublisher({
    stateDir: join(root, "blocker"), inboxStateDir: root, scopes: () => [scope], log: (step) => void logs.push(step),
    every: (fn) => ((run = fn), () => void (stopped = true)),
  });
  run?.();
  assert.deepEqual(logs, ["read_model.nav_badge_sources_failed", "read_model.nav_badge_sources_failed"], "a failed write is logged each time");
  stop();
  assert.equal(stopped, true);
  const timed = startNavBadgeSourcePublisher({ stateDir: root, inboxStateDir: root, scopes: () => [scope] });
  timed();
});

function serveDeps(root: string, stateDir: string, every: (run: () => void) => () => void): ServeDeps {
  const ledgerPath = join(stateDir, "ledger.ndjson");
  const planPath = join(root, "plan.yaml");
  writeFileSync(planPath, "[]\n");
  const github = { prByRef: () => null, findMergedByTrailer: () => null, headRefName: () => undefined, prBody: () => undefined };
  return {
    board: { plan: { tasks: [], byId: new Map() }, ledgerPath, github },
    panelGraph: { root, planPath, ledgerPath, github: { prView: () => null }, statusGithub: github, ratify: { approve: () => {}, reframe: () => {} } },
    ledgerPath,
    issues: { close: () => {} },
    fleetControlRoot: root,
    questionsRoot: root,
    tokens: { read: "r", write: "w" },
    consoleSha: "aaaaaaaa",
    resolveCurrentSha: () => "aaaaaaaa",
    gatewayCheckout: async () => ({ state: "clean" }) as never,
    githubAppRefresh: { start: () => ({ armed: false, stop() {} }) as never },
    assistantRepository: CORE_REPO,
    readModel: { workerUrl: SILENT_WORKER, every },
  };
}

async function listen(t: TestCtx, server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function badge(url: string): Promise<ViewBody<NavBadgeData>> {
  const res = await fetch(`${url}/v1/views/nav-badge`, { headers: { authorization: "Bearer r" } });
  assert.equal(res.status, 200);
  return (await res.json()) as ViewBody<NavBadgeData>;
}

test("serve keeps the nav badge on its legacy computation until the switch file names serve", async (t) => {
  const f = await fixture(t);
  createNavBadgeSourcePublisher({ stateDir: f.stateDir, inboxStateDir: join(f.inboxRoot, "state"), scopes: () => f.scopes })();
  tickBodies(f);
  const runs: Array<() => void> = [];
  const url = await listen(t, buildServeServer(serveDeps(f.inboxRoot, f.stateDir, (run) => (runs.push(run), () => {}))));

  const dark = await badge(url);
  assert.equal(dark.sources.some((s) => s.name.startsWith("ledger:")), false, "dark: the legacy computation answers");
  mkdirSync(join(f.stateDir, "read-model"), { recursive: true });
  writeFileSync(readModelSwitchesPath(f.stateDir), JSON.stringify({ views: { "nav-badge": "serve" } }));
  for (const run of runs) run();
  const served = await badge(url);
  assert.equal(served.sources.some((s) => s.name === "ledger:core"), true, "switched to serve: the persisted read-model body answers");
  assert.equal(served.data.agent.count, 1);
});

test("a dark view answers from its legacy computation in shadow mode and from the read model in serve mode", () => {
  const legacy = { name: "nav-badge", version: 1, compute: () => ({ data: "legacy", sources: [] }) };
  let switches: Record<string, "serve" | "shadow" | "off"> = { "nav-badge": "shadow" };
  const entry = { view: "nav-badge", key: "", version: 1, generation: 1, etag: 'W/"x"', body: { view: "nav-badge", version: 1, generatedAt: iso(0), asOf: null, stale: false, sources: [], data: "read-model" } };
  const source = darkReadModelViews({ body: () => entry, judge: (s) => [...s], switches: () => ({ views: switches }) }, ["nav-badge"]);
  const answer = (): unknown => {
    let sent = "";
    const [route] = buildReadModelViewRoutes({ legacy: [legacy], readModel: source });
    void route.handler({ url: "/v1/views/nav-badge", headers: {} } as never, { writeHead: () => undefined, end: (text: string) => void (sent = text) } as never, {} as never);
    return (JSON.parse(sent) as { data: unknown }).data;
  };
  assert.equal(answer(), "legacy");
  switches = { "nav-badge": "serve" };
  assert.equal(answer(), "read-model");
  assert.deepEqual(source.judge([{ name: "x", asOf: null, state: "fresh" }], 0), [{ name: "x", asOf: null, state: "fresh" }]);
});
