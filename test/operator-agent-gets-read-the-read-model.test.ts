// E17: every GET /v1/operator-agent/* read the ledger synchronously on serve's main thread, per
// request. With serve's read model wired in, each folds the worker's `panel.*` rows instead. These
// tests build a corpus through the routes themselves, rotate half of it into a gzip archive, and
// require each GET's body from the read model to equal the ledger computation, archive included,
// while every synchronous fs read on the main thread throws.
import assert from "node:assert/strict";
import fs, { rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { test } from "node:test";

import {
  createOperatorAgentRowsSource,
  createOperatorAgentRowsView,
  OPERATOR_AGENT_ROWS_VIEW,
  type OperatorAgentRowsData,
} from "../src/lib/operator-agent-read-model.js";
import { buildOperatorAgentRoutes, OPERATOR_AGENT_PROPOSAL_STEP } from "../src/lib/operator-agent.js";
import type { ReadModelDb } from "../src/lib/read-model-db.js";
import { createReadModelTicker, ledgerSource, type ReadModelWorkerMessage } from "../src/lib/read-model-worker.js";
import { makeTempDir } from "../src/lib/tmp.js";
import type { ViewBodyEntry, ViewSource } from "../src/lib/views.js";
import { clock, corpus, get, listen, NOW, post } from "./helpers/operator-agent-corpus.js";

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
