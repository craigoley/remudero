// E17: every GET /v1/operator-agent/* read the ledger synchronously on serve's main thread, per
// request. With serve's read model wired in, each folds the worker's `panel.*` rows instead. These
// tests build a corpus through the routes themselves, rotate half of it into a gzip archive, and
// require each GET's body from the read model to equal the ledger computation, archive included,
// while every synchronous fs read on the main thread throws.
import assert from "node:assert/strict";
import fs, { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";

import { fixedClock, type Clock } from "../src/lib/clock.js";
import { createEmergencyStop } from "../src/lib/emergency-control.js";
import { appendFollowUpCandidate, FOLLOW_UP_POLICY_VERSION, type FollowUpCandidate } from "../src/lib/follow-up-policy.js";
import { EMERGENCY_STOP_ISSUED_LEDGER_STEP } from "../src/lib/ledger.js";
import {
  createOperatorAgentRowsSource,
  createOperatorAgentRowsView,
  OPERATOR_AGENT_ROWS_VIEW,
  type OperatorAgentRowsData,
} from "../src/lib/operator-agent-read-model.js";
import { buildOperatorAgentRoutes, OPERATOR_AGENT_CONSEQUENCE_PREFLIGHT_STEP, OPERATOR_AGENT_PROPOSAL_STEP } from "../src/lib/operator-agent.js";
import { appendPanelLedger } from "../src/lib/panel-actions.js";
import type { ReadModelDb } from "../src/lib/read-model-db.js";
import { createReadModelTicker, ledgerSource, type ReadModelWorkerMessage } from "../src/lib/read-model-worker.js";
import { createService, type Route } from "../src/lib/service.js";
import { makeTempDir } from "../src/lib/tmp.js";
import type { ViewBodyEntry, ViewSource } from "../src/lib/views.js";
import { profileInput } from "./helpers/delegation-profile-fixture.js";
import { planInput } from "./helpers/intent-plan-fixture.js";

const READ = "e17-read-token";
const WRITE = "e17-write-token";
const NOW = Date.parse("2026-09-20T11:00:00.000Z");
const clock: Clock = fixedClock(NOW);
const SCOPE = { principalId: "user_123", repository: "owner/repo" };

/** Every GET route, with the query its body is read with. */
const GETS = [
  "/v1/operator-agent/context",
  "/v1/operator-agent/proposals",
  "/v1/operator-agent/proposals?principalId=user_123&repository=owner%2Frepo",
  "/v1/operator-agent/experiments",
  "/v1/operator-agent/promotions",
  "/v1/operator-agent/consequences",
  "/v1/operator-agent/follow-ups",
  "/v1/operator-agent/settings",
  "/v1/operator-agent/preferences?principalId=user_123&repository=owner%2Frepo",
  "/v1/operator-agent/emergency/status",
  "/v1/operator-agent/actions",
  "/v1/operator-agent/delegations",
  "/v1/operator-agent/intent-plans",
] as const;

/** An id each route's body carries only because the archive was read. */
const ARCHIVED_MARKER: Record<(typeof GETS)[number], string> = {
  "/v1/operator-agent/context": "ctx:operator:timezone",
  "/v1/operator-agent/proposals": "operator-agent:repo:scale:queue-pressure",
  "/v1/operator-agent/proposals?principalId=user_123&repository=owner%2Frepo": "operator-agent:repo:scale:queue-pressure",
  "/v1/operator-agent/experiments": "experiment:repo:worker-pool",
  "/v1/operator-agent/promotions": "promotion:repo:worker-pool",
  "/v1/operator-agent/consequences": "cq-archived",
  "/v1/operator-agent/follow-ups": "follow-up:thread-1",
  "/v1/operator-agent/settings": "0.97",
  "/v1/operator-agent/preferences?principalId=user_123&repository=owner%2Frepo": "\"ordering\"",
  "/v1/operator-agent/emergency/status": "stop:fleet:archived",
  "/v1/operator-agent/actions": "action:deploy:canary",
  "/v1/operator-agent/delegations": "delegation:owner/repo:flow-runner",
  "/v1/operator-agent/intent-plans": "Promote the canary in repo owner/repo",
};

async function listen(t: { after: (fn: () => void) => void }, routes: Route[]): Promise<string> {
  const server = createService({ tokens: { read: READ, write: WRITE }, routes });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function post(base: string, path: string, body: unknown): Promise<number> {
  const res = await fetch(`${base}${path}`, { method: "POST", headers: { authorization: `Bearer ${WRITE}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  await res.text();
  return res.status;
}

async function get(base: string, path: string): Promise<{ status: number; body: unknown; headers: Headers }> {
  const res = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${READ}` } });
  return { status: res.status, body: await res.json(), headers: res.headers };
}

function experiment(): Record<string, unknown> {
  return {
    version: "experiment-v1",
    experimentId: "experiment:repo:worker-pool",
    proposalId: "operator-agent:repo:scale:queue-pressure",
    hypothesis: "Increasing the worker pool will reduce queue latency for the repository's worker tasks.",
    intervention: { summary: "Increase the worker pool from 2 to 4 for one observation window.", plan: "Apply the scoped worker-pool setting and restore it if the regression guard fires." },
    scope: { repo: "owner/repo", taskType: "worker", lane: "main", evidenceAnchors: ["ledger:queue-latency"] },
    baseline: {
      metricName: "queue_latency_p50", value: 8, unit: "minutes", denominator: 20, comparisonPopulation: "owner/repo worker tasks on main",
      windowStart: "2026-09-18T10:00:00.000Z", windowEnd: "2026-09-20T10:00:00.000Z", source: "ledger:queue-latency", freshness: "verified",
    },
    rollback: { plan: "Restore worker pool size to 2 and record the deployment receipt.", reason: "Rollback if queue latency regresses.", receipt: "change:worker-pool-restore" },
    createdAt: "2026-09-20T10:00:00.000Z",
    state: "proposed",
  };
}

function promotion(): Record<string, unknown> {
  return {
    version: "experiment-promotion-v1",
    promotionId: "promotion:repo:worker-pool",
    experimentId: "experiment:repo:worker-pool",
    candidate: "worker-pool-v2",
    baseline: "worker-pool-v1",
    scope: { repo: "owner/repo", policyScope: "owner/repo:worker", taskType: "worker", lane: "main" },
    comparisonPopulation: "owner/repo worker tasks on main",
    denominatorFloor: 10,
    observationWindow: { start: "2026-09-18T10:00:00.000Z", end: "2026-09-22T10:00:00.000Z" },
    guardMetrics: [{ metricName: "queue_latency_p50", unit: "minutes", direction: "max", abortThreshold: 12 }],
    maxExposure: 0.1,
    owner: "operator-agent",
    expiresAt: "2026-09-27T10:00:00.000Z",
    rollback: { plan: "Restore worker-pool-v1.", reason: "Rollback on regression.", receipt: "change:worker-pool-restore" },
    createdAt: "2026-09-20T11:00:00.000Z",
    state: "proposed",
  };
}

const followUp: FollowUpCandidate = {
  version: FOLLOW_UP_POLICY_VERSION,
  candidateId: "follow-up:thread-1",
  sourceEvent: "operator_agent.outcome_observed",
  workstream: "repo/experiment",
  reason: "The accepted experiment has no observed outcome yet.",
  freshness: "verified",
  dependency: "owner response",
  deduplicationKey: "repo/experiment:outcome",
  maxAttempts: 2,
  owner: "operator@example.test",
  nextQuestion: "Would you like to record the observed outcome?",
  createdAt: "2026-09-20T10:00:00.000Z",
};

function consequencePreflight(ledgerPath: string, id: string): void {
  appendPanelLedger(ledgerPath, OPERATOR_AGENT_CONSEQUENCE_PREFLIGHT_STEP, id, "test", {
    action_id: id, consequence_class: "irreversible", ready: false, at: "2026-09-20T10:30:00.000Z", code: "missing-approvers", reason: "needs an approver",
    approval: { target: `vendor:${id}`, expiresAt: "2026-09-21T10:00:00.000Z", approverRequired: true, recoveryStatement: "none" },
  });
}

function stopRow(id: string): string {
  const stop = createEmergencyStop({ id, scope: "fleet", reason: "halt the fleet while the incident is triaged", issuedBy: "operator", issuedAt: "2026-09-20T10:00:00.000Z", clearPolicy: "explicit-clear-required", incidentReceiptId: `incident:${id}` });
  return `${JSON.stringify({ ts: new Date().toISOString(), step: EMERGENCY_STOP_ISSUED_LEDGER_STEP, stop })}\n`;
}

/**
 * A corpus every GET has something in: the first half written through the routes and then rotated
 * into a gzip archive, the second half written to the new live file.
 */
async function corpus(t: { after: (fn: () => void) => void }): Promise<{ stateDir: string; ledgerPath: string }> {
  const root = makeTempDir("e17-operator-agent");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stateDir = join(root, "state");
  mkdirSync(stateDir, { recursive: true });
  const ledgerPath = join(stateDir, "ledger.ndjson");
  const base = await listen(t, buildOperatorAgentRoutes({ ledgerPath, now: () => NOW }));
  const proposal = {
    proposalId: "operator-agent:repo:scale:queue-pressure", repo: "owner/repo", proposalText: "Increase the worker pool for owner/repo.", confidence: 0.96,
    reasoning: "The queue and p50 latency crossed the conservative threshold together.", category: "scale", status: "pending",
    createdAt: "2026-09-20T10:00:00.000Z", expiresAt: "2026-09-27T10:00:00.000Z",
    evidence: [{ label: "Queued tasks", value: "8", source: "run-ledger", observedAt: "2026-09-20T10:00:00.000Z", freshness: "verified" }],
  };
  const context = {
    version: "context-item-v1", contextId: "ctx:operator:timezone", source: "operator-note:timezone", principal: "operator:alice", purpose: "schedule-follow-up",
    sensitivity: "moderate", authorityRef: "consent:alice:schedule", observedAt: "2026-09-20T10:00:00.000Z", freshness: "fresh",
    retention: { policy: "operator-configured", expiresAt: "2026-10-21T00:00:00.000Z" }, visibility: "private", derivationLinks: [], revocation: { state: "active" },
    content: "The operator prefers UTC reminders.",
  };
  const action = {
    version: "automation-action-v1", actionId: "action:deploy:canary", capability: "deploy.canary", summary: "Promote the canary build to ten percent of traffic.",
    scope: { flowId: "flow:canary", repo: "owner/repo" }, risk: "production", preconditions: [{ id: "health", source: "ledger:health", description: "The fleet health read is healthy." }],
    freshness: { maxAgeSeconds: 600 }, idempotencyKey: "idem:deploy:canary:1", createdAt: "2026-09-20T10:00:00.000Z", expiresAt: "2026-09-20T12:00:00.000Z", dryRun: true,
    approval: { policy: "human" }, rollback: { mode: "reversible", plan: "Route all traffic back to the stable build." }, receiptRef: "ledger:panel.operator_agent_action_receipt",
  };
  const written = [
    await post(base, "/v1/operator-agent/context", { context }),
    await post(base, "/v1/operator-agent/proposals", { proposal }),
    await post(base, "/v1/operator-agent/experiments", { experiment: experiment() }),
    await post(base, "/v1/operator-agent/promotions", { promotion: promotion() }),
    await post(base, "/v1/operator-agent/settings", { settings: { enabled: true, confidenceThreshold: 0.97 } }),
    await post(base, "/v1/operator-agent/actions", { action }),
    await post(base, "/v1/operator-agent/delegations", { profile: profileInput() }),
    await post(base, "/v1/operator-agent/intent-plans", planInput()),
    await post(base, "/v1/operator-agent/preferences/propose", { scope: SCOPE, effect: { kind: "ordering", value: "scale" } }),
  ];
  assert.deepEqual(written.map((status) => status >= 200 && status < 300), written.map(() => true), `every seed write landed: ${written.join(",")}`);
  consequencePreflight(ledgerPath, "cq-archived");
  appendFollowUpCandidate({ ledgerPath }, followUp);
  writeFileSync(ledgerPath, readFileSync(ledgerPath, "utf8") + stopRow("stop:fleet:archived"));
  // The rotation: everything so far moves into a gzip archive, and the live file starts empty.
  writeFileSync(join(stateDir, "ledger.2026-09-20T10-45-00-000Z.ndjson.gz"), gzipSync(readFileSync(ledgerPath)));
  writeFileSync(ledgerPath, "");
  const live = [
    await post(base, "/v1/operator-agent/proposals/decision", { proposalId: proposal.proposalId, decision: "more-info", note: "Show the queue window next time." }),
    await post(base, "/v1/operator-agent/experiments/decision", { experimentId: "experiment:repo:worker-pool", decision: "approved" }),
  ];
  assert.deepEqual(live, [200, 200]);
  consequencePreflight(ledgerPath, "cq-live");
  return { stateDir, ledgerPath };
}

/** The read model's body over the corpus: the projector and the view, ticked as the worker ticks them. */
function project(stateDir: string, chunk?: number): ViewBodyEntry {
  const posted: ViewBodyEntry[] = [];
  const view = createOperatorAgentRowsView(ledgerSource, chunk);
  const ticker = createReadModelTicker({
    stateDir, instances: [{ name: "core", ledgerDir: stateDir }], views: [view], holder: "e17-test",
    post: (message: ReadModelWorkerMessage) => void (message.type === "body" && posted.push(message.entry)),
  });
  for (let i = 0; i < 20 && posted.length === 0; i++) ticker.tick();
  ticker.release();
  const entry = posted.at(-1);
  assert.ok(entry, "the worker posted the operator-agent rows");
  return entry;
}

function readModelOf(entry: ViewBodyEntry | undefined, judged: ViewSource["state"] = "fresh") {
  const listeners = new Set<(posted: ViewBodyEntry) => void>();
  let current = entry;
  return {
    body: (view: string) => (view === OPERATOR_AGENT_ROWS_VIEW ? current : undefined),
    judge: (sources: readonly ViewSource[]) => sources.map((source) => ({ ...source, state: judged })),
    switches: () => ({ views: {} as Record<string, "serve" | "shadow" | "off" | "auto"> }),
    onBody: (listener: (posted: ViewBodyEntry) => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    post: (next: ViewBodyEntry) => {
      current = next;
      for (const listener of listeners) listener(next);
    },
  };
}

/** Runs `fn` with every synchronous fs read on this thread throwing, so a route that opens a file fails. */
async function withSyncReadsRefused<T>(fn: () => Promise<T>): Promise<T> {
  const names = ["readFileSync", "readdirSync", "statSync", "existsSync", "openSync", "readSync", "fstatSync"] as const;
  const saved = names.map((name) => [name, fs[name]] as const);
  for (const name of names) (fs as unknown as Record<string, unknown>)[name] = () => { throw new Error(`sync ${name} on the main thread`); };
  syncBuiltinESMExports();
  try {
    return await fn();
  } finally {
    for (const [name, original] of saved) (fs as unknown as Record<string, unknown>)[name] = original;
    syncBuiltinESMExports();
  }
}

test("every operator-agent GET body from the read model equals the ledger computation including archived rows", async (t) => {
  const { stateDir, ledgerPath } = await corpus(t);
  const legacyBase = await listen(t, buildOperatorAgentRoutes({ ledgerPath, now: () => NOW }));
  const expected = new Map<string, unknown>();
  for (const path of GETS) {
    const answer = await get(legacyBase, path);
    assert.equal(answer.status, 200, path);
    assert.ok(JSON.stringify(answer.body).includes(ARCHIVED_MARKER[path]), `the ledger answer for ${path} holds its archived row`);
    expected.set(path, answer.body);
  }
  const entry = project(stateDir);
  const servedBase = await listen(t, buildOperatorAgentRoutes({ ledgerPath, now: () => NOW, panelRows: createOperatorAgentRowsSource(readModelOf(entry), { instance: "core", clock }) }));
  await withSyncReadsRefused(async () => {
    for (const path of GETS) {
      const answer = await get(servedBase, path);
      assert.equal(answer.status, 200, `${path}: ${JSON.stringify(answer.body)}`);
      assert.deepEqual(answer.body, expected.get(path), path);
      assert.equal(answer.headers.get("x-rmd-stale-sources"), null, path);
    }
  });
});

test("an operator-agent GET served from the read model opens no ledger file on the main thread", async (t) => {
  const { stateDir, ledgerPath } = await corpus(t);
  const entry = project(stateDir);
  // The ledger is gone: a route that still reads it answers from nothing, or throws.
  rmSync(stateDir, { recursive: true, force: true });
  const servedBase = await listen(t, buildOperatorAgentRoutes({ ledgerPath, now: () => NOW, panelRows: createOperatorAgentRowsSource(readModelOf(entry), { instance: "core", clock }) }));
  await withSyncReadsRefused(async () => {
    for (const path of GETS) {
      const answer = await get(servedBase, path);
      assert.equal(answer.status, 200, `${path}: ${JSON.stringify(answer.body)}`);
      assert.ok(JSON.stringify(answer.body).includes(ARCHIVED_MARKER[path]), `${path} answered from the read model's rows`);
    }
  });
});

test("an operator-agent GET with no read-model body answers 503 with a reason and its sources", async (t) => {
  const { ledgerPath } = await corpus(t);
  const base = await listen(t, buildOperatorAgentRoutes({ ledgerPath, now: () => NOW, panelRows: createOperatorAgentRowsSource(readModelOf(undefined, "unavailable"), { instance: "core", clock, waitMs: 20 }) }));
  for (const path of GETS) {
    const answer = await get(base, path);
    assert.equal(answer.status, 503, path);
    assert.deepEqual(answer.body, {
      error: "unavailable",
      source: OPERATOR_AGENT_ROWS_VIEW,
      reason: "the read model has not materialized the operator-agent rows yet",
      sources: [{ name: "ledger:core", asOf: null, state: "unavailable" }],
    }, path);
  }
});

test("an operator-agent GET waits for the read model to apply this process's own write", async (t) => {
  const { stateDir, ledgerPath } = await corpus(t);
  const before = project(stateDir);
  const readModel = readModelOf(before);
  const base = await listen(t, buildOperatorAgentRoutes({ ledgerPath, now: () => NOW, panelRows: createOperatorAgentRowsSource(readModel, { instance: "core", clock, waitMs: 5_000 }) }));
  // A write through the served routes: the body above does not hold it yet.
  assert.equal(await post(base, "/v1/operator-agent/settings", { settings: { enabled: false, confidenceThreshold: 0.99 } }), 200);
  const pending = get(base, "/v1/operator-agent/settings");
  await new Promise((done) => setTimeout(done, 50));
  readModel.post(project(stateDir));
  const answer = await pending;
  assert.equal(answer.status, 200);
  assert.deepEqual((answer.body as { settings: unknown }).settings, { enabled: false, confidenceThreshold: 0.99 });
});

test("an operator-agent GET whose own write the read model never applies answers 503 naming that write", async (t) => {
  const { stateDir, ledgerPath } = await corpus(t);
  const base = await listen(t, buildOperatorAgentRoutes({ ledgerPath, now: () => NOW, panelRows: createOperatorAgentRowsSource(readModelOf(project(stateDir), "stale"), { instance: "core", clock, waitMs: 20 }) }));
  assert.equal(await post(base, "/v1/operator-agent/settings", { settings: { enabled: false, confidenceThreshold: 0.99 } }), 200);
  const answer = await get(base, "/v1/operator-agent/settings");
  assert.equal(answer.status, 503);
  const body = answer.body as { reason: string; sources: ViewSource[] };
  assert.match(body.reason, /has not applied this process's operator-agent write at \d{4}-/);
  assert.deepEqual(body.sources.map((source) => [source.name, source.state]), [["ledger:core", "stale"]]);
});

test("a stale read-model body still answers and names its stale sources in a header", async (t) => {
  const { stateDir, ledgerPath } = await corpus(t);
  const base = await listen(t, buildOperatorAgentRoutes({ ledgerPath, now: () => NOW, panelRows: createOperatorAgentRowsSource(readModelOf(project(stateDir), "stale"), { instance: "core", clock }) }));
  const answer = await get(base, "/v1/operator-agent/experiments");
  assert.equal(answer.status, 200);
  assert.equal(answer.headers.get("x-rmd-stale-sources"), "ledger:core");
});

test("an operator-agent rows view switched off answers from the ledger", async (t) => {
  const { ledgerPath } = await corpus(t);
  const readModel = { ...readModelOf(undefined), switches: () => ({ views: { [OPERATOR_AGENT_ROWS_VIEW]: "off" as const } }) };
  const base = await listen(t, buildOperatorAgentRoutes({ ledgerPath, now: () => NOW, panelRows: createOperatorAgentRowsSource(readModel, { instance: "core", clock }) }));
  const answer = await get(base, "/v1/operator-agent/emergency/status");
  assert.equal(answer.status, 200);
  assert.ok(JSON.stringify(answer.body).includes("stop:fleet:archived"));
});

test("the operator-agent rows view folds its facts in bounded steps and republishes only when they move", (t) => {
  const root = makeTempDir("e17-rows-view");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const rows = [1, 2, 3].map((i) => ({ ts: `2026-09-20T10:0${i}:00.000Z`, step: OPERATOR_AGENT_PROPOSAL_STEP, n: i }));
  writeFileSync(join(root, "ledger.ndjson"), rows.map((row) => `${JSON.stringify(row)}\n`).join(""));
  const entry = project(root, 1);
  const data = entry.body.data as OperatorAgentRowsData;
  assert.deepEqual(data.rows.map((row) => row.n), [1, 2, 3]);
  assert.equal(data.newestTs, "2026-09-20T10:03:00.000Z");
  // A step allowance of one fact: prepare stops short, and materialize builds nothing it has not folded.
  const view = createOperatorAgentRowsView(ledgerSource, 1);
  const facts = [{ seq: 1, ts: rows[0]!.ts, ts_ms: Date.parse(rows[0]!.ts), body: JSON.stringify(rows[0]) }];
  const db = { prepare: (sql: string) => ({ get: () => ({ m: 3 }), all: () => (sql.includes("seq > ?") ? facts : []) }) } as unknown as ReadModelDb;
  const state = { instance: "core", tickedAt: NOW, generation: 1, lease: "held", failures: 0, newestTs: null } as unknown as Parameters<typeof ledgerSource>[0];
  let allowed = 1;
  assert.equal(view.prepare({ instances: [{ state, db }] }, () => allowed-- > 0), false, "a fold past its allowance yields");
  assert.equal(view.prepare({ instances: [{ state: { ...state, tickedAt: undefined } }] }, () => true), true, "an unprojected store has nothing to fold");
  assert.deepEqual(view.materialize({ now: NOW, instances: [] }), []);
  assert.equal(view.materialize({ now: NOW, instances: [{ state, db }] }).length, 1);
  assert.deepEqual(view.materialize({ now: NOW, instances: [{ state, db }] }), [], "an unmoved fold is not republished");
});
