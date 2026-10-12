import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { captureGardenerSpendSource, foldGardenerSpend } from "../src/lib/gardener-spend.js";
import { createAnalyticsView, type AnalyticsViewData } from "../src/lib/analytics-view.js";
import { deriveAnalyticsSnapshot } from "../src/lib/analytics-route.js";
import { analyticsSourceBodies } from "../src/lib/analytics-view.js";
import { createReadModelTicker, createReadModelWorker, runReadModelWorker, readModelSwitchesPath, type ReadModelWorkerMessage } from "../src/lib/read-model-worker.js";
import { createService } from "../src/lib/service.js";
import { buildReadModelViewRoutes } from "../src/lib/views.js";
import { makeTempDir } from "../src/lib/tmp.js";
import { SPEC, violations } from "./helpers/openapi-strict.js";
import type { AddressInfo } from "node:net";

const repository = "fixture/repo";
const at = new Date().toISOString();
function runtime(enabled = true, scope = "repository") {
  return { version: 1, repository, daemonRunId: "daemon-1", codeSha: null, configuredAt: at, observedAt: at,
    gardens: [{ name: "config", enabled, scope, cadenceMs: 1000, phase: "scheduled", observedAt: at,
      passId: null, nextDueAt: null, queueMs: null, executionMs: null, exit: null, reason: null,
      attempts: 0, completions: 0, failures: 0, lastCompletedAt: null, lastSuccessAt: null, lastFailureAt: null }] };
}

test("W1-T8484: incomplete gardener spend remains unknown rather than zero", async t => {
  for (const enabled of [true, false]) {
    const result = foldGardenerSpend({ runtime: runtime(enabled) }, repository, at);
    assert.equal(result.state, "not_collected");
    assert.equal(result.reason, "correlation_not_available");
    assert.equal(result.gardens[0]!.enabled, enabled);
    assert.equal(result.gardens[0]!.totalUsd, null);
    assert.equal(result.gardens[0]!.pricedSubtotalUsd, null);
    assert.deepEqual(result.counts, { priced: null, unpriced: null, unlinked: null });
    assert.equal(result.coverage.retainedCorpus, "not_collected");
    assert.equal(result.coverage.truncated, null);
    assert.equal(result.window, null);
  }
  for (const raw of [null, {}, { ...runtime(), version: 0 }, { ...runtime(), daemonRunId: "" }]) {
    const result = foldGardenerSpend({ runtime: raw }, repository, at);
    assert.equal(result.state, "not_collected");
    assert.equal(result.reason, "invalid_registry");
    assert.deepEqual(result.gardens, []);
  }
  assert.equal(foldGardenerSpend(undefined, repository, at).reason, "missing_materialization");
  assert.equal(foldGardenerSpend({ reason: "missing_registry" }, repository, at).reason, "missing_registry");
  assert.equal(foldGardenerSpend({ runtime: runtime() }, "other/repo", at).reason, "scope_mismatch");
  for (const scope of ["host", "fleet"]) {
    const result = foldGardenerSpend({ runtime: runtime(true, scope) }, repository, at);
    assert.equal(result.totalUsd, null);
    assert.equal(result.gardens[0]!.scope, scope);
  }
  const dir = makeTempDir("gardener-spend-source");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.deepEqual(await captureGardenerSpendSource(dir), { reason: "missing_registry" });
  const path = join(dir, "gardener-runtime.json");
  writeFileSync(path, "not json");
  assert.deepEqual(await captureGardenerSpendSource(dir), { reason: "invalid_registry" });
  writeFileSync(path, "x".repeat(65537));
  assert.deepEqual(await captureGardenerSpendSource(dir), { reason: "over_budget" });
  writeFileSync(path, JSON.stringify({ ...runtime(), private: "private-sentinel" }));
  const source = await captureGardenerSpendSource(dir);
  assert.equal(JSON.stringify(source).includes("private-sentinel"), false);
  assert.equal(foldGardenerSpend(source, repository, at).reason, "correlation_not_available");
});

test("W1-T8484: missing or over-budget gardener spend preserves Analytics", () => {
  const stateDir = makeTempDir("gardener-spend-budget");
  try {
    mkdirSync(join(stateDir, "read-model"));
    writeFileSync(join(stateDir, "ledger.ndjson"), "");
    writeFileSync(readModelSwitchesPath(stateDir), JSON.stringify({ views: { analytics: "serve" } }));
    let data: AnalyticsViewData | undefined;
    const ticker = createReadModelTicker({ stateDir, instances: [{ name: "core", ledgerDir: stateDir }],
      views: [createAnalyticsView()], oracle: "off", post: m => {
        if (m.type === "body" && m.entry.view === "analytics") data = m.entry.body.data as AnalyticsViewData;
      } });
    try {
      ticker.start();
      ticker.tick();
      const oversized = { ...runtime(), gardens: Array.from({ length: 33 }, (_, i) => ({ ...runtime().gardens[0], name: `garden-${i}` })) };
      for (const source of [undefined, { runtime: oversized }, { runtime: { ...runtime(), private: "x".repeat(65536) } }]) {
        const snapshot = deriveAnalyticsSnapshot([], new Date().toISOString());
        const bodies = analyticsSourceBodies(snapshot, repository);
        Object.assign(bodies[0]!.body as object, { gardenerSpendSource: source });
        assert.equal(ticker.acceptSnapshot({ instance: "core", ok: true, asOf: snapshot.asOf!, bodies }), true);
        ticker.tick();
        assert.deepEqual(data!.coverage, { counted: 1, of: 1, missing: [] });
        if (!source) {
          assert.equal(data!.instances[0]!.gardenerSpend, undefined);
          continue;
        }
        assert.equal(data!.instances[0]!.gardenerSpend!.reason, "over_budget");
        assert.deepEqual(data!.instances[0]!.gardenerSpend!.gardens, []);
        assert.ok(Buffer.byteLength(JSON.stringify(data!.instances[0]!.gardenerSpend)) <= 65536);
      }
    } finally { ticker.release(); }
    const fleetDir = join(stateDir, "fleet");
    mkdirSync(join(fleetDir, "read-model"), { recursive: true });
    writeFileSync(join(fleetDir, "ledger.ndjson"), "");
    writeFileSync(readModelSwitchesPath(fleetDir), JSON.stringify({ views: { analytics: "serve" } }));
    const fleet = createReadModelTicker({ stateDir: fleetDir,
      instances: ["core", "site"].map(name => ({ name, ledgerDir: fleetDir })), views: [createAnalyticsView()], oracle: "off",
      post: m => { if (m.type === "body" && m.entry.view === "analytics") data = m.entry.body.data as AnalyticsViewData; } });
    try {
      fleet.start();
      fleet.tick();
      for (const instance of ["core", "site"]) {
        const repo = `fixture/${instance}`;
        const snapshot = deriveAnalyticsSnapshot([], new Date().toISOString());
        const bodies = analyticsSourceBodies(snapshot, repo);
        const inventory = { ...runtime(), repository: repo, gardens: instance === "core"
          ? Array.from({ length: 32 }, (_, i) => ({ ...runtime().gardens[0], name: `garden-${i}` })) : runtime().gardens };
        Object.assign(bodies[0]!.body as object, { gardenerSpendSource: { runtime: inventory } });
        assert.equal(fleet.acceptSnapshot({ instance, ok: true, asOf: snapshot.asOf!, bodies }), true);
      }
      fleet.tick();
      assert.deepEqual(data!.coverage, { counted: 2, of: 2, missing: [] });
      assert.equal(data!.instances[0]!.gardenerSpend!.gardens.length, 32);
      assert.equal(data!.instances[1]!.gardenerSpend!.reason, "over_budget");
      assert.deepEqual(data!.instances[1]!.gardenerSpend!.gardens, []);
    } finally { fleet.release(); }
  } finally { rmSync(stateDir, { recursive: true, force: true }); }
});

test("W1-T8484: real worker refresh serves gardener spend without request-time scans", async t => {
  const stateDir = makeTempDir("gardener-spend-worker");
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const ledgerDir = join(stateDir, "core");
  mkdirSync(ledgerDir);
  mkdirSync(join(stateDir, "read-model"));
  writeFileSync(join(ledgerDir, "ledger.ndjson"), JSON.stringify({ ts: at, step: "implement.done", run_id: "child", cost_usd: 2 }) + "\n");
  writeFileSync(join(ledgerDir, "gardener-runtime.json"), JSON.stringify(runtime(false)));
  writeFileSync(readModelSwitchesPath(stateDir), JSON.stringify({ views: { analytics: "serve" } }));
  const posted: ReadModelWorkerMessage[] = [];
  let onMessage: ((msg: { type?: string }) => void) | undefined;
  runReadModelWorker({ on: (_event, run) => onMessage = run, postMessage: m => posted.push(m as ReadModelWorkerMessage), close() {} },
    { kind: "remudero-read-model", stateDir, instances: [{ name: "core", ledgerDir, repo: repository }], tickMs: 20,
      signal: new SharedArrayBuffer(8), slowLane: { intervalMs: 60000 } });
  t.after(() => onMessage?.({ type: "stop" }));
  const body = () => posted.findLast(m => m.type === "body" && m.entry.view === "analytics");
  const ready = () => {
    const message = body();
    return message?.type === "body" && (message.entry.body.data as AnalyticsViewData).instances[0]?.gardenerSpend?.reason === "correlation_not_available";
  };
  const deadline = Date.now() + 20000;
  while (!ready() && Date.now() < deadline) await sleep(20);
  assert.ok(ready(), JSON.stringify(posted.filter(m => m.type === "log")));
  onMessage?.({ type: "stop" });
  const message = body();
  assert.ok(message?.type === "body");
  const entry = message.entry;
  const spend = (entry.body.data as AnalyticsViewData).instances[0]!.gardenerSpend!;
  assert.equal(spend.gardens[0]!.enabled, false);
  assert.equal(spend.gardens[0]!.totalUsd, null);
  assert.equal(spend.observedAt, at);
  assert.deepEqual(violations(entry.body, SPEC.components.schemas.AnalyticsView!), []);
  rmSync(join(ledgerDir, "ledger.ndjson"));
  rmSync(join(ledgerDir, "gardener-runtime.json"));
  const restarted = createReadModelWorker({ stateDir, instances: [{ name: "core", ledgerDir, repo: repository }] });
  assert.deepEqual((restarted.body("analytics")!.body.data as AnalyticsViewData).instances[0]!.gardenerSpend, spend);
  const server = createService({ tokens: { read: "r", write: "w" }, routes: buildReadModelViewRoutes({ legacy: [], readModelViews: ["analytics"],
    readModel: restarted }) });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/views/analytics`;
  for (let i = 0; i < 2; i++) {
    const response = await fetch(url, { headers: { authorization: "Bearer r" } });
    assert.equal(response.status, 200);
    const cached = await response.json() as { data: AnalyticsViewData };
    assert.deepEqual(cached.data.instances[0]!.gardenerSpend, spend);
    assert.deepEqual(cached.data.coverage, { counted: 1, of: 1, missing: [] });
  }
});
