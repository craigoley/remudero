import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { createAnalyticsView, type AnalyticsViewData } from "../src/lib/analytics-view.js";
import { deriveAnalyticsSnapshot } from "../src/lib/analytics-route.js";
import { analyticsSourceBodies } from "../src/lib/analytics-view.js";
import { createReadModelTicker, createReadModelWorker, runReadModelWorker, readModelSwitchesPath, type ReadModelWorkerMessage } from "../src/lib/read-model-worker.js";
import { createService } from "../src/lib/service.js";
import { buildReadModelViewRoutes } from "../src/lib/views.js";
import { makeTempDir } from "../src/lib/tmp.js";
import { SPEC, violations } from "./helpers/openapi-strict.js";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { fixedClock } from "../src/lib/clock.js";

const repository = "fixture/repo";
const at = new Date().toISOString();
function runtime(enabled = true, scope = "repository") {
  return { version: 1, repository, daemonRunId: "daemon-1", codeSha: null, configuredAt: at, observedAt: at,
    gardens: [{ name: "config", enabled, scope, cadenceMs: 1000, phase: "scheduled", observedAt: at,
      passId: null, nextDueAt: null, queueMs: null, executionMs: null, exit: null, reason: null,
      attempts: 0, completions: 0, failures: 0, lastCompletedAt: null, lastSuccessAt: null, lastFailureAt: null }] };
}

const passId = "12345678-1234-4123-8123-123456789abc";
const archive = (offset = 0) => `ledger.${new Date(Date.parse(at) + offset).toISOString().replace(/[:.]/g, "-")}.ndjson`;
const origin = { state: "linked", version: 1, name: "config", passId };
async function loadSpend() {
  assert.ok(existsSync(new URL("../src/lib/gardener-spend.ts", import.meta.url)),
    "the canonical spend implementation must exist before its contract can be exercised");
  return import("../src/lib/gardener-spend.js");
}
const parent = { ts: at, step: "garden.lifecycle", name: "config", passId, repository,
  daemon_run_id: "daemon-1", phase: "completed", exit: 0 };
const child = { ts: at, step: "implement.done", run_id: "child", task_id: "task", total_cost_usd: 2,
  gardener_origin: origin };
async function captured(t: { after(fn: () => void): void }, rows: unknown[], scope = "repository") {
  const { captureGardenerSpendSource, foldGardenerSpend } = await loadSpend();
  const dir = makeTempDir("gardener-spend-receipts");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const inventory = runtime(true, scope);
  Object.assign(inventory.gardens[0]!, { attempts: 1, completions: 1 });
  writeFileSync(join(dir, "gardener-runtime.json"), JSON.stringify(inventory));
  writeFileSync(join(dir, "ledger.ndjson"), rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  return { dir, spend: foldGardenerSpend(await captureGardenerSpendSource(dir), repository, at) };
}

test("W1-T8484: gardener spend requires the exact scoped parent pass", async t => {
  const { captureGardenerSpendSource } = await loadSpend();
  const { spend } = await captured(t, [child, parent]);
  assert.equal(spend.pricedSubtotalUsd, 2);
  assert.equal(spend.totalUsd, 2);
  assert.equal(spend.state, "complete");
  const { dir: clockDir } = await captured(t, [child, parent]);
  const frozen = fixedClock(Date.parse(at));
  assert.equal((await captureGardenerSpendSource(clockDir, frozen)).observedAt, at);
  for (const mismatch of [{ passId: "22345678-1234-4123-8123-123456789abc" },
    { name: "test" }, { repository: "other/repo" }, { daemon_run_id: "daemon-2" }]) {
    const { spend: rejected } = await captured(t, [child, { ...parent, ...mismatch }]);
    assert.equal(rejected.totalUsd, null);
    assert.equal(rejected.pricedSubtotalUsd, null);
    assert.equal(rejected.counts.unlinked, 1);
  }
  for (const mismatch of [{ repository: "other/repo" }, { daemon_run_id: "daemon-2" }]) {
    const { spend: rejected } = await captured(t, [parent, { ...child, ...mismatch }]);
    assert.equal(rejected.pricedSubtotalUsd, null);
    assert.equal(rejected.counts.unlinked, 1);
  }
  const passReceipt = { ...parent, step: "garden.pass", phase: undefined };
  assert.equal((await captured(t, [child, passReceipt])).spend.totalUsd, 2);
});

test("W1-T8484: gardener spend survives rotation without duplicate repository cost", async t => {
  const { captureGardenerSpendSource, foldGardenerSpend } = await loadSpend();
  const { dir } = await captured(t, [parent, child, { ...child, step: "verdict", total_cost_usd: 99 }]);
  const replay = [parent, child].map(row => JSON.stringify(row)).join("\n") + "\n";
  writeFileSync(join(dir, archive() + ".gz"), gzipSync(replay));
  writeFileSync(join(dir, archive(1000)), replay);
  for (let restart = 0; restart < 2; restart++) {
    const spend = foldGardenerSpend(await captureGardenerSpendSource(dir), repository, at);
    assert.equal(spend.totalUsd, 2);
    assert.equal(spend.counts.priced, 1);
  }
  writeFileSync(join(dir, "ledger.ndjson"), replay + JSON.stringify({ ...child, step: "recon.done" }) + "\n");
  const distinct = foldGardenerSpend(await captureGardenerSpendSource(dir), repository, at);
  assert.equal(distinct.totalUsd, 4, "two producer steps under one child run each carry real cost");
  assert.equal(distinct.counts.priced, 2);
  for (const scope of ["host", "fleet"]) {
    const { spend } = await captured(t, [parent, child], scope);
    assert.equal(spend.totalUsd, null);
    assert.equal(spend.pricedSubtotalUsd, null);
    assert.equal(spend.gardens[0]!.totalUsd, null);
  }
});

test("W1-T8484: incomplete gardener spend remains unknown rather than zero", async t => {
  const { captureGardenerSpendSource, foldGardenerSpend } = await loadSpend();
  for (const record of [{ ...child, total_cost_usd: undefined }, { ...child, total_cost_usd: -1 },
    { ...child, gardener_origin: undefined }, { ...child, gardener_origin: { state: "invalid", reason: "malformed" } },
    { ...child, gardener_origin: { ...origin, version: 0 } }, { ...child, gardener_origin: { ...origin, token: "secret" } }]) {
    const { spend } = await captured(t, [parent, record]);
    assert.equal(spend.totalUsd, null);
    assert.equal(spend.pricedSubtotalUsd, null);
    if (record.gardener_origin?.state === "linked" && "version" in record.gardener_origin &&
      record.gardener_origin.version === 1 && !("token" in record.gardener_origin)) {
      assert.equal(spend.counts.unpriced, 1);
      assert.equal(spend.state, "partial");
    }
  }
  for (const phase of ["running", "failed", "cancelled"]) {
    const { spend } = await captured(t, [child, { ...parent, phase, exit: null }]);
    assert.equal(spend.totalUsd, null);
    assert.equal(spend.pricedSubtotalUsd, 2);
    assert.equal(spend.state, "partial");
  }
  const interrupted = await captured(t, [child, { ...parent, phase: "cancelled", exit: null }, parent]);
  assert.equal(interrupted.spend.totalUsd, null, "a conflicting completion cannot erase interruption");
  const absent = await captured(t, [parent]);
  assert.equal(absent.spend.totalUsd, null);
  const zero = await captured(t, [parent, { ...child, total_cost_usd: 0 }]);
  assert.equal(zero.spend.totalUsd, 0, "an observed priced zero is measured");
  writeFileSync(join(zero.dir, archive(1000) + ".gz"), "corrupt archive");
  const partial = foldGardenerSpend(await captureGardenerSpendSource(zero.dir), repository, at);
  assert.equal(partial.totalUsd, null);
  assert.equal(partial.pricedSubtotalUsd, 0);
  assert.equal(partial.coverage.retainedCorpus, "partial");
  rmSync(join(absent.dir, "ledger.ndjson"));
  assert.equal(foldGardenerSpend(await captureGardenerSpendSource(absent.dir), repository, at).reason, "ledger_unavailable");
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
  writeFileSync(join(dir, "ledger.ndjson"), "");
  const source = await captureGardenerSpendSource(dir);
  assert.equal(JSON.stringify(source).includes("private-sentinel"), false);
  assert.equal(foldGardenerSpend(source, repository, at).reason, "correlation_not_available");
});

test("W1-T8484: missing or over-budget gardener spend preserves Analytics", async t => {
  const { captureGardenerSpendSource } = await loadSpend();
  const overflow = await captured(t, [parent, ...Array.from({ length: 500 }, (_, i) => ({ ...child, run_id: `child-${i}` }))]);
  const overflowSource = await captureGardenerSpendSource(overflow.dir);
  assert.equal(overflowSource.reason, "over_budget");
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
      for (const source of [undefined, { runtime: runtime() }, overflowSource, { runtime: oversized },
        { runtime: { ...runtime(), private: "x".repeat(65536) } }]) {
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
        if (source.runtime && (source.runtime as { gardens: unknown[] }).gardens.length === 1 &&
          !("private" in (source.runtime as object))) {
          assert.equal(data!.instances[0]!.gardenerSpend!.reason, "correlation_not_available");
        } else {
          assert.equal(data!.instances[0]!.gardenerSpend!.reason, "over_budget");
          assert.deepEqual(data!.instances[0]!.gardenerSpend!.gardens, []);
        }
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
      assert.equal(data!.instances[1]!.gardenerSpend!.reason, "correlation_not_available");
      assert.equal(data!.instances[1]!.gardenerSpend!.gardens.length, 1,
        "the per-repository inventory bound must not hide another repository's gardeners");
    } finally { fleet.release(); }
    const manyDir = join(stateDir, "many-repositories");
    mkdirSync(join(manyDir, "read-model"), { recursive: true });
    writeFileSync(join(manyDir, "ledger.ndjson"), "");
    writeFileSync(readModelSwitchesPath(manyDir), JSON.stringify({ views: { analytics: "serve" } }));
    const names = Array.from({ length: 20 }, (_, i) => `repo-${i}`);
    const many = createReadModelTicker({ stateDir: manyDir, instances: names.map(name => ({ name, ledgerDir: manyDir })),
      views: [createAnalyticsView()], oracle: "off", post: m => {
        if (m.type === "body" && m.entry.view === "analytics") data = m.entry.body.data as AnalyticsViewData;
      } });
    try {
      many.start(); many.tick();
      for (const name of names) {
        const repo = `fixture/${name}`;
        const snapshot = deriveAnalyticsSnapshot([], new Date().toISOString());
        const bodies = analyticsSourceBodies(snapshot, repo);
        const inventory = { ...runtime(), repository: repo,
          gardens: Array.from({ length: 32 }, (_, i) => ({ ...runtime().gardens[0], name: `garden-${String(i).padStart(2, "0")}-${"x".repeat(48)}` })) };
        Object.assign(bodies[0]!.body as object, { gardenerSpendSource: { runtime: inventory } });
        assert.equal(many.acceptSnapshot({ instance: name, ok: true, asOf: snapshot.asOf!, bodies }), true);
      }
      many.tick();
      assert.deepEqual(data!.coverage, { counted: 20, of: 20, missing: [] });
      const spends = data!.instances.flatMap(i => i.gardenerSpend ? [i.gardenerSpend] : []);
      assert.ok(spends.some(s => s.reason === "over_budget"), "the fleet byte budget must remain load-bearing");
      assert.ok(spends.reduce((bytes, s) => bytes + Buffer.byteLength(JSON.stringify(s)), 0) <= 65536);
    } finally { many.release(); }
  } finally { rmSync(stateDir, { recursive: true, force: true }); }
});

test("W1-T8484: real worker refresh serves gardener spend without request-time scans", async t => {
  await loadSpend();
  const stateDir = makeTempDir("gardener-spend-worker");
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const ledgerDir = join(stateDir, "core");
  mkdirSync(ledgerDir);
  mkdirSync(join(stateDir, "read-model"));
  const replay = [parent, child].map(row => JSON.stringify(row)).join("\n") + "\n";
  writeFileSync(join(ledgerDir, "ledger.ndjson"), replay);
  writeFileSync(join(ledgerDir, archive(1000) + ".gz"), gzipSync(replay));
  const inventory = runtime(false);
  Object.assign(inventory.gardens[0]!, { attempts: 1, completions: 1 });
  writeFileSync(join(ledgerDir, "gardener-runtime.json"), JSON.stringify(inventory));
  writeFileSync(readModelSwitchesPath(stateDir), JSON.stringify({ views: { analytics: "serve" } }));
  const posted: ReadModelWorkerMessage[] = [];
  let onMessage: ((msg: { type?: string }) => void) | undefined;
  t.after(() => onMessage?.({ type: "stop" }));
  const body = () => posted.findLast(m => m.type === "body" && m.entry.view === "analytics");
  const refresh = async (expected: number) => {
    runReadModelWorker({ on: (_event, run) => onMessage = run, postMessage: m => posted.push(m as ReadModelWorkerMessage), close() {} },
      { kind: "remudero-read-model", stateDir, instances: [{ name: "core", ledgerDir, repo: repository }], tickMs: 20,
        signal: new SharedArrayBuffer(8), slowLane: { intervalMs: 60000 } });
    const ready = () => {
      const message = body();
      return message?.type === "body" && (message.entry.body.data as AnalyticsViewData).instances[0]?.gardenerSpend?.totalUsd === expected;
    };
    const deadline = Date.now() + 20000;
    while (!ready() && Date.now() < deadline) await sleep(20);
    assert.ok(ready(), JSON.stringify(posted.filter(m => m.type === "log")));
    onMessage?.({ type: "stop" });
  };
  await refresh(2);
  writeFileSync(join(ledgerDir, archive(2000)), replay);
  writeFileSync(join(ledgerDir, "ledger.ndjson"), replay + JSON.stringify({ ...child, run_id: "child-2", total_cost_usd: 3 }) + "\n");
  await refresh(5);
  const message = body();
  assert.ok(message?.type === "body");
  const entry = message.entry;
  const spend = (entry.body.data as AnalyticsViewData).instances[0]!.gardenerSpend!;
  assert.equal(spend.gardens[0]!.enabled, false);
  assert.equal(spend.gardens[0]!.totalUsd, 5);
  assert.equal(spend.counts.priced, 2);
  assert.ok(Date.parse(spend.observedAt!) >= Date.parse(at));
  assert.equal(spend.window!.from, at);
  assert.equal(spend.coverage.retainedCorpus, "complete");
  assert.ok(Buffer.byteLength(JSON.stringify(spend)) <= 65536);
  assert.deepEqual(violations(entry.body, SPEC.components.schemas.AnalyticsView!), []);
  rmSync(join(ledgerDir, "ledger.ndjson"));
  rmSync(join(ledgerDir, archive(1000) + ".gz"));
  rmSync(join(ledgerDir, archive(2000)));
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
