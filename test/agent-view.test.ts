// W1-T5051 (arch Phase 4 P4-T12): the `agent` view family. Each part must equal its GET /v1/operator-agent/*
// route over the same ledger (archive included), `proposals` must equal the nav badge's engine over the same
// analytics, and the per-instance fold must spread a large panel fact delta over passes, resuming from its
// committed position after a restart.
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { AGENT_CLOCK_MS, AGENT_VIEW_PARTS, agentViewKey, createAgentView, type AgentProposalsBody, type AgentViewData, type AgentViewPart } from "../src/lib/agent-view.js";
import { coldAnalyticsSnapshot, type AnalyticsSnapshot } from "../src/lib/analytics-route.js";
import { analyticsSourceBodies } from "../src/lib/analytics-view.js";
import { fixedClock } from "../src/lib/clock.js";
import { openProjectorReadModel } from "../src/lib/ledger-projector.js";
import { readLedgerUnionRecordsSync } from "../src/lib/ledger-union.js";
import { createNavBadgeReadModelView, navBadgeView, type NavBadgeData } from "../src/lib/nav-badge-view.js";
import { buildOperatorAgentRoutes, OPERATOR_AGENT_PROPOSAL_STEP } from "../src/lib/operator-agent.js";
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
import { createReadModelTicker, ledgerSource, type ReadModelInstanceState } from "../src/lib/read-model-worker.js";
import { makeTempDir } from "../src/lib/tmp.js";
import { renderView } from "../src/lib/views.js";
import { corpus, get, listen, NOW } from "./helpers/operator-agent-corpus.js";

const REPO = "owner/repo";
const ANALYTICS_AS_OF = new Date(NOW - 60_000).toISOString();
const state = (instance = "core"): ReadModelInstanceState => ({ instance, generation: 1, lease: "held", failures: 0, newestTs: null, tickedAt: NOW });

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
function factStore(t: { after: (fn: () => void) => void }, n: number): { db: ReadModelDb; lease: ReadModelLease } {
  const root = makeTempDir("agent-fold");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "state"), { recursive: true });
  const db = openProjectorReadModel(join(root, "state"), "core", fixedClock(NOW));
  t.after(() => db.close());
  const got = acquireLease(db, { holder: "fold-test", clock: fixedClock(NOW) });
  assert.ok(got.ok);
  addFacts(db, 0, n);
  return { db, lease: got.lease };
}

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
