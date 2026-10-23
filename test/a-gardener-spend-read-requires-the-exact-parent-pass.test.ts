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

test("W1-T10160: owned machine-judge receipts preserve partial money and reported zero", async t => {
  const producer = { ...child, step: "machine_judge.attempt_spend", total_cost_usd: 0.25, billing_mode: "api" };
  const restated = [{ ...child, step: "worker.attempt", total_cost_usd: 99 },
    { ...child, step: "verdict", total_cost_usd: 99 }];
  const known = await captured(t, [parent, producer, ...restated]);
  assert.equal(known.spend.totalUsd, 0.25);
  for (const zero of [true, false]) {
    const row = { ...producer, total_cost_usd: zero ? 0 : undefined,
      provider: zero ? "cash" : "codex", billing_mode: zero ? "api" : "subscription",
      ...(zero ? {} : { notional_cost_usd: 5 }) };
    const { spend } = await captured(t, [parent, producer, { ...row, run_id: "second-attempt" }, ...restated]);
    assert.equal(spend.pricedSubtotalUsd, 0.25);
    assert.equal(spend.totalUsd, zero ? 0.25 : null);
    assert.deepEqual(spend.counts, { priced: zero ? 2 : 1, unpriced: zero ? 0 : 1, unlinked: 0 });
  }
});

test("W1-T9658: default gardener capture observes unpriced assigned calls", async t => {
  const assignment = { ts: at, step: "worker.assignment", run_id: "assigned-child", task_id: "judge",
    gardener_origin: origin, worker_assignment: { id: "assignment-1", selected: { provider: "codex", model: "fixture" } } };
  const attempt = { ts: at, step: "worker.attempt", run_id: "assigned-child", task_id: "judge",
    gardener_origin: origin, selection_assignment_id: "assignment-1", billing_mode: "subscription" };
  const { spend } = await captured(t, [attempt, assignment, { ...parent, phase: "running", exit: undefined }]);
  const calls = spend.workerCalls;
  assert.ok(calls, "the real default capture must collect assignment-linked usage separately from money");
  assert.equal(calls.state, "complete");
  assert.deepEqual(calls.counts, { assignments: 1, matched: 1, missing: 0, orphan: 0, conflicting: 0, invalid: 0 });
  assert.deepEqual(calls.billingModes, { api: 0, subscription: 1, unknown: 0 });
  assert.deepEqual(calls.priceCoverage, { reported: 0, unreported: 1 });
  assert.equal(calls.gardens[0]!.name, "config");
  assert.equal(calls.window!.from, at);
  assert.equal(calls.observedAt, spend.observedAt);
  assert.equal(spend.totalUsd, null, "a counted call is neither a completed parent nor a measured price");
  assert.equal(spend.pricedSubtotalUsd, null);
});

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

test("parent-only gardener history cannot consume the cost-bearing receipt budget", async t => {
  const { captureGardenerSpendSource, foldGardenerSpend } = await loadSpend();
  const quiet = Array.from({ length: 700 }, (_, index) => ({ ...parent,
    passId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}` }));
  for (const producerFirst of [false, true]) {
    const records = producerFirst ? [child, ...quiet, parent] : [...quiet, parent, child];
    const { dir } = await captured(t, records);
    const inventory = runtime();
    Object.assign(inventory.gardens[0]!, { attempts: 701, completions: 701 });
    writeFileSync(join(dir, "gardener-runtime.json"), JSON.stringify(inventory));
    const source = await captureGardenerSpendSource(dir);
    assert.equal(source.reason, undefined, "uncharged lifecycle detail is not cost payload overflow");
    assert.equal(source.compact?.passes.length, 1, "only cost-bearing passes are serialized, with their exact parent state");
    const spend = foldGardenerSpend(source, repository, at);
    assert.equal(spend.pricedSubtotalUsd, 2);
    assert.equal(spend.counts.priced, 1);
    assert.equal(spend.totalUsd, null, "unpriced parent-only attempts are not inferred zero");
    assert.equal(spend.state, "partial");
  }
});

test("W1-T8667: genuine compact overflow preserves independent Analytics", async t => {
  const { captureGardenerSpendSource } = await loadSpend();
  const capacity = await captured(t, [parent, ...Array.from({ length: 500 }, (_, i) => ({ ...child, run_id: `child-${i}` }))]);
  assert.equal(capacity.spend.totalUsd, 1000);
  // The payload bound separates real cost-bearing cardinality, not idle lifecycle detail.
  const overflow = await captured(t, Array.from({ length: 1000 }, (_, i) => {
    const id = `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
    return [{ ...parent, passId: id }, { ...child, run_id: `child-${i}`, gardener_origin: { ...origin, passId: id } }];
  }).flat());
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

test("W1-T8667: real worker materializes many gardener receipts before cached reads", async t => {
  await loadSpend();
  const stateDir = makeTempDir("gardener-spend-worker");
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const ledgerDir = join(stateDir, "core");
  mkdirSync(ledgerDir);
  mkdirSync(join(stateDir, "read-model"));
  const replay = [parent, ...Array.from({ length: 500 }, (_, i) => ({ ...child, run_id: `child-${i}` }))]
    .map(row => JSON.stringify(row)).join("\n") + "\n";
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
      return message?.type === "body" && (message.entry.body.data as AnalyticsViewData).instances[0]?.gardenerSpend?.pricedSubtotalUsd === expected;
    };
    const deadline = Date.now() + 20000;
    while (!ready() && Date.now() < deadline) await sleep(20);
    assert.ok(ready(), JSON.stringify(posted.filter(m => m.type === "log")));
    onMessage?.({ type: "stop" });
  };
  await refresh(1000);
  const initial = body();
  assert.ok(initial?.type === "body");
  assert.equal((initial.entry.body.data as AnalyticsViewData).instances[0]!.gardenerSpend!.totalUsd, 1000);
  writeFileSync(join(ledgerDir, archive(2000)), replay);
  writeFileSync(join(ledgerDir, "ledger.ndjson"), replay + [
    { ...child, run_id: "child-extra", total_cost_usd: 3 },
    { ...child, run_id: "unpriced", total_cost_usd: undefined },
    { ...parent, phase: "cancelled", exit: null },
    { ...parent, repository: "other/repo" },
  ].map(row => JSON.stringify(row)).join("\n") + "\n");
  await refresh(1003);
  const message = body();
  assert.ok(message?.type === "body");
  const entry = message.entry;
  const spend = (entry.body.data as AnalyticsViewData).instances[0]!.gardenerSpend!;
  assert.equal(spend.gardens[0]!.enabled, false);
  assert.equal(spend.gardens[0]!.totalUsd, null);
  assert.equal(spend.pricedSubtotalUsd, 1003);
  assert.equal(spend.state, "partial");
  assert.deepEqual(spend.counts, { priced: 501, unpriced: 1, unlinked: 0 });
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

// W1-T9658 fixtures always enter through real files and the default union collector.
const callObservedAt = new Date(Date.parse(at) + 1000).toISOString();
const callMaterializedAt = new Date(Date.parse(at) + 2000).toISOString();
const emptyCallCounts = { assignments: 0, matched: 0, missing: 0, orphan: 0, conflicting: 0, invalid: 0 };
function assignedCall(id: string, attemptFields: Record<string, unknown> = {}, gardenOrigin = origin) {
  const shared = { ts: at, run_id: `private-run-${id}`, task_id: `private-task-${id}`, gardener_origin: gardenOrigin };
  return {
    assignment: { ...shared, step: "worker.assignment",
      worker_assignment: { id, selected: { provider: "codex", model: "fixture" } } },
    attempt: { ...shared, step: "worker.attempt", selection_assignment_id: id,
      billing_mode: "subscription", ...attemptFields },
  };
}
async function capturedCalls(t: { after(fn: () => void): void }, rows: unknown[], inventory?: ReturnType<typeof runtime>) {
  const { dir } = await captured(t, rows);
  if (!inventory) {
    inventory = runtime();
    Object.assign(inventory.gardens[0]!, { attempts: 1, completions: 1 });
  }
  writeFileSync(join(dir, "gardener-runtime.json"), JSON.stringify(inventory));
  const { captureGardenerSpendSource, foldGardenerSpend } = await loadSpend();
  const collect = () => captureGardenerSpendSource(dir, fixedClock(Date.parse(callObservedAt)));
  const source = await collect();
  return { dir, source, collect, spend: foldGardenerSpend(source, repository, callMaterializedAt) };
}
function callsOf(spend: Awaited<ReturnType<typeof captured>>["spend"]) {
  assert.ok(spend.workerCalls, "default source collection must expose workerCalls");
  assert.equal(spend.workerCalls.version, "gardener-worker-calls-v1");
  return spend.workerCalls;
}
function onlyMoney(spend: Awaited<ReturnType<typeof captured>>["spend"]) {
  const { workerCalls: _calls, ...money } = spend;
  return money;
}
function assertUnknownCalls(spend: Awaited<ReturnType<typeof captured>>["spend"], reason: string) {
  const calls = callsOf(spend);
  assert.equal(calls.state, "not_collected");
  assert.equal(calls.reason, reason);
  assert.equal(calls.observedAt, null);
  assert.equal(calls.window, null);
  assert.deepEqual(calls.counts, { assignments: null, matched: null, missing: null, orphan: null, conflicting: null, invalid: null });
  assert.deepEqual(calls.billingModes, { api: null, subscription: null, unknown: null });
  assert.deepEqual(calls.priceCoverage, { reported: null, unreported: null });
  assert.deepEqual(calls.gardens, []);
}

test("W1-T9658: gardener call coverage never duplicates canonical spend", async t => {
  await t.test("billing and reported price presence do not add dollars", async t => {
    const moneyRows = [parent, child, { ...child, step: "recon.done", total_cost_usd: 3 },
      { ...child, step: "verdict", total_cost_usd: 999 }];
    const modes = [
      { billing_mode: "subscription" },
      { billing_mode: "api", total_cost_usd: 0 },
      { billing_mode: "api", total_cost_usd: 73 },
      { billing_mode: "other", total_cost_usd: -1 },
      { billing_mode: "API", total_cost_usd: "7" },
      { billing_mode: "subscription", total_cost_usd: null },
      { billing_mode: undefined, notional_cost_usd: 99, billed_cost_usd: 88 },
      { billing_mode: "api", total_cost_usd: Number.NaN },
      { billing_mode: "api", total_cost_usd: Number.POSITIVE_INFINITY },
      { billing_mode: null, total_cost_usd: true },
    ];
    const rows = modes.flatMap((fields, i) => Object.values(assignedCall(`price-${i}`, fields)));
    const control = await capturedCalls(t, moneyRows);
    const measured = await capturedCalls(t, [...rows, ...moneyRows, ...rows]);
    assert.equal(control.spend.totalUsd, 5, "positive control: two real canonical producers, no verdict dollars");
    assert.deepEqual(onlyMoney(measured.spend), onlyMoney(control.spend), "exclude only the new optional workerCalls field");
    const calls = callsOf(measured.spend);
    assert.equal(calls.state, "complete");
    assert.deepEqual(calls.counts, { ...emptyCallCounts, assignments: 10, matched: 10 });
    assert.deepEqual(calls.billingModes, { api: 4, subscription: 2, unknown: 4 });
    assert.deepEqual(calls.priceCoverage, { reported: 2, unreported: 8 });
    assert.deepEqual(calls.gardens, [{ name: "config", counts: calls.counts,
      billingModes: calls.billingModes, priceCoverage: calls.priceCoverage }]);
  });
  await t.test("gzip, plain and live replay deduplicate semantic calls across timestamps", async t => {
    const { assignment, attempt } = assignedCall("rotation");
    const rows = [attempt, child, assignment, parent];
    const { dir, collect, spend } = await capturedCalls(t, rows);
    const { foldGardenerSpend } = await loadSpend();
    const replay = rows.map(row => JSON.stringify(row)).join("\n") + "\n";
    writeFileSync(join(dir, archive() + ".gz"), gzipSync(replay));
    writeFileSync(join(dir, archive(1000)), replay);
    writeFileSync(join(dir, "ledger.ndjson"), replay + [
      { ...assignment, ts: new Date(Date.parse(at) + 500).toISOString(), repository, daemon_run_id: "daemon-1" },
      { ...attempt, ts: new Date(Date.parse(at) + 500).toISOString(), repository, daemon_run_id: "daemon-1" },
    ].map(row => JSON.stringify(row)).join("\n") + "\n");
    for (let restart = 0; restart < 2; restart++) {
      const replayed = foldGardenerSpend(await collect(), repository, callMaterializedAt);
      assert.deepEqual(onlyMoney(replayed), onlyMoney(spend));
      assert.deepEqual(callsOf(replayed), callsOf(spend));
      assert.deepEqual(callsOf(replayed).counts, { ...emptyCallCounts, assignments: 1, matched: 1 });
    }
  });
});

test("W1-T9658: gardener call coverage preserves scoped evidence gaps", async t => {
  const { assignment, attempt } = assignedCall("scoped");
  const otherPass = "22345678-1234-4123-8123-123456789abc";
  await t.test("all six parent/assignment/attempt orders give the same scoped join", async t => {
    const permutations = [[parent, assignment, attempt], [parent, attempt, assignment],
      [assignment, parent, attempt], [assignment, attempt, parent], [attempt, parent, assignment], [attempt, assignment, parent]];
    let expected: ReturnType<typeof callsOf> | undefined;
    for (const rows of permutations) {
      const calls = callsOf((await capturedCalls(t, rows)).spend);
      assert.deepEqual(calls.counts, { ...emptyCallCounts, assignments: 1, matched: 1 });
      assert.equal(calls.state, "complete");
      if (expected) assert.deepEqual(calls, expected);
      expected = calls;
    }
  });
  for (const [label, rows] of [
    ["no parent", [assignment, attempt]],
    ...[{ name: "test" }, { passId: otherPass }, { repository: "other/repo" }, { daemon_run_id: "daemon-2" }]
      .map(mismatch => [`parent ${JSON.stringify(mismatch)}`, [assignment, attempt, { ...parent, ...mismatch }]] as const),
  ] as const) {
    await t.test(label, async t => {
      const calls = callsOf((await capturedCalls(t, [...rows])).spend);
      assert.equal(calls.counts.matched, 0);
      assert.equal(calls.counts.orphan, 1, "a terminal attempt without a valid exact parent is orphaned");
      assert.equal(calls.state, "partial");
    });
  }
  for (const mismatch of [
    { gardener_origin: { ...origin, name: "test" } }, { gardener_origin: { ...origin, passId: otherPass } },
    { repository: "other/repo" }, { daemon_run_id: "daemon-2" },
    { run_id: "wrong-run" }, { task_id: "wrong-task" }, { run_id: "" }, { task_id: "" },
  ]) {
    for (const side of ["assignment", "attempt"] as const) {
      await t.test(`${side} mismatch ${JSON.stringify(mismatch)}`, async t => {
        const rows = [parent, side === "assignment" ? { ...assignment, ...mismatch } : assignment,
          side === "attempt" ? { ...attempt, ...mismatch } : attempt];
        const calls = callsOf((await capturedCalls(t, rows)).spend);
        assert.equal(calls.counts.matched, 0);
        assert.equal(calls.state, "partial");
      });
    }
  }
  await t.test("missing assignments, terminals, immutable IDs and observed-assignment proof remain gaps", async t => {
    const missing = callsOf((await capturedCalls(t, [parent, assignment])).spend);
    assert.deepEqual(missing.counts, { ...emptyCallCounts, assignments: 1, missing: 1 });
    const orphan = callsOf((await capturedCalls(t, [parent, attempt])).spend);
    assert.deepEqual(orphan.counts, { ...emptyCallCounts, orphan: 1 });
    for (const rows of [
      [parent, { ...assignment, worker_assignment: { selected: assignment.worker_assignment.selected } }, attempt],
      [parent, assignment, { ...attempt, selection_assignment_id: undefined }],
      [parent, assignment, { ...attempt, selection_assignment_id: "different-id" }],
      [parent, assignment, { ...attempt, assignment_observed: false }],
    ]) {
      const calls = callsOf((await capturedCalls(t, rows)).spend);
      assert.equal(calls.counts.matched, 0);
      assert.equal(calls.state, "partial");
      assert.ok(calls.counts.missing! + calls.counts.orphan! + calls.counts.invalid! > 0);
    }
  });
  await t.test("conflicting assignment and attempt restatements quarantine one ID in either order", async t => {
    for (const conflicting of [{ ...assignment, run_id: "restated-run" },
      { ...attempt, total_cost_usd: 11 }, { ...attempt, billing_mode: "api" }]) {
      let expected: ReturnType<typeof callsOf> | undefined;
      for (const rows of [[parent, assignment, attempt, conflicting], [conflicting, attempt, assignment, parent]]) {
        const calls = callsOf((await capturedCalls(t, rows)).spend);
        assert.deepEqual(calls.counts, { ...emptyCallCounts, assignments: 1, conflicting: 1 });
        assert.deepEqual(calls.billingModes, { api: 0, subscription: 0, unknown: 0 });
        assert.deepEqual(calls.priceCoverage, { reported: 0, unreported: 0 });
        assert.equal(calls.state, "partial");
        if (expected) assert.deepEqual(calls, expected);
        expected = calls;
      }
    }
  });
  await t.test("malformed attributed rows and origins are invalid and preserve good money", async t => {
    for (const malformed of [
      { ...attempt, selection_assignment_id: ["scoped"] }, { ...attempt, run_id: 7 },
      { ...attempt, gardener_origin: { ...origin, version: 0 } },
      { ...attempt, gardener_origin: { ...origin, passId: "malformed" } },
      { ...attempt, gardener_origin: { ...origin, private: "private-origin-sentinel" } },
    ]) {
      const { spend } = await capturedCalls(t, [parent, child, assignment, malformed]);
      const calls = callsOf(spend);
      assert.equal(spend.pricedSubtotalUsd, 2);
      assert.equal(calls.counts.matched, 0);
      assert.ok(calls.counts.invalid! >= 1, JSON.stringify(malformed));
      assert.equal(calls.state, "partial");
      assert.equal(JSON.stringify(spend).includes("private-origin-sentinel"), false);
    }
  });
  await t.test("global counts aggregate repository gardens and ignore host/fleet workers", async t => {
    const inventory = runtime();
    inventory.gardens = ["config", "second", "host", "fleet"].map((name, i) => ({ ...inventory.gardens[0]!,
      name, scope: i < 2 ? "repository" : name }));
    const rows = inventory.gardens.flatMap(g => [
      { ...parent, name: g.name }, ...Object.values(assignedCall(`scope-${g.name}`, {}, { ...origin, name: g.name })),
    ]);
    const calls = callsOf((await capturedCalls(t, rows, inventory)).spend);
    assert.equal(calls.state, "complete");
    assert.deepEqual(calls.counts, { ...emptyCallCounts, assignments: 2, matched: 2 });
    assert.deepEqual(calls.gardens.map(g => g.name).sort(), ["config", "second"]);
    for (const garden of calls.gardens) assert.deepEqual(garden.counts, { ...emptyCallCounts, assignments: 1, matched: 1 });
    assert.deepEqual(calls.billingModes, { api: 0, subscription: 2, unknown: 0 });
    assert.deepEqual(calls.priceCoverage, { reported: 0, unreported: 2 });
  });
  await t.test("two repository gardens retain their own mismatched-origin gaps in either order", async t => {
    const inventory = runtime();
    inventory.gardens = ["config", "second"].map(name => ({ ...inventory.gardens[0]!, name }));
    const parents = [parent, { ...parent, name: "second" }];
    for (const [assignedName, attemptedName] of [["config", "second"], ["second", "config"]]) {
      const assigned = { ...assignment, gardener_origin: { ...origin, name: assignedName! } };
      const attempted = { ...attempt, gardener_origin: { ...origin, name: attemptedName! } };
      let expected: ReturnType<typeof callsOf> | undefined;
      for (const rows of [[...parents, assigned, attempted], [attempted, assigned, ...parents.toReversed()]]) {
        const calls = callsOf((await capturedCalls(t, rows, inventory)).spend);
        assert.equal(calls.state, "partial");
        assert.deepEqual(calls.counts, { ...emptyCallCounts, assignments: 1, missing: 1, orphan: 1, conflicting: 1 });
        assert.deepEqual(calls.gardens.find(g => g.name === assignedName)!.counts,
          { ...emptyCallCounts, assignments: 1, missing: 1, conflicting: 1 });
        assert.deepEqual(calls.gardens.find(g => g.name === attemptedName)!.counts, { ...emptyCallCounts, orphan: 1 });
        assert.deepEqual(calls.billingModes, { api: 0, subscription: 0, unknown: 0 });
        assert.deepEqual(calls.priceCoverage, { reported: 0, unreported: 0 });
        if (expected) assert.deepEqual(calls, expected);
        expected = calls;
      }
    }
    const restated = { ...attempt, gardener_origin: { ...origin, name: "second" } };
    let expected: ReturnType<typeof callsOf> | undefined;
    for (const rows of [[...parents, assignment, attempt, restated], [restated, attempt, assignment, ...parents.toReversed()]]) {
      const calls = callsOf((await capturedCalls(t, rows, inventory)).spend);
      assert.deepEqual(calls.counts, { ...emptyCallCounts, assignments: 1, conflicting: 1 });
      if (expected) assert.deepEqual(calls, expected);
      expected = calls;
    }
  });
  await t.test("the full 32-garden repository inventory stays bounded", async t => {
    const inventory = runtime();
    inventory.gardens = Array.from({ length: 32 }, (_, i) => ({ ...inventory.gardens[0]!, name: `garden-${i}` }));
    const rows = inventory.gardens.flatMap(g => [{ ...parent, name: g.name },
      ...Object.values(assignedCall(`bounded-${g.name}`, {}, { ...origin, name: g.name }))]);
    const { source, spend } = await capturedCalls(t, rows, inventory);
    const calls = callsOf(spend);
    assert.equal(calls.state, "complete");
    assert.equal(calls.gardens.length, 32);
    assert.deepEqual(calls.counts, { ...emptyCallCounts, assignments: 32, matched: 32 });
    assert.ok(Buffer.byteLength(JSON.stringify(source)) <= 65536);
    assert.ok(Buffer.byteLength(JSON.stringify(spend)) <= 65536);
    const properties = SPEC.components.schemas.GardenerWorkerCalls!.properties as Record<string, { maxItems?: number }>;
    assert.equal(properties.gardens!.maxItems, 32);
    assert.deepEqual(violations(spend, SPEC.components.schemas.GardenerSpend!), []);
  });
  await t.test("invalid retained usage is isolated from valid monetary evidence", async t => {
    const { source, spend } = await capturedCalls(t, [parent, child, assignment, attempt]);
    assert.ok(source.workerCalls && source.workerCalls !== "over_budget");
    const good = source.workerCalls;
    const { foldGardenerSpend } = await loadSpend();
    const mutations: Array<(value: ReturnType<typeof callsOf>) => void> = [
      value => { Reflect.deleteProperty(value.counts, "matched"); },
      value => { Reflect.deleteProperty(value.billingModes, "api"); },
      value => { Reflect.deleteProperty(value.priceCoverage, "reported"); },
      value => { Reflect.deleteProperty(value.gardens[0]!.counts, "invalid"); },
      value => { Object.assign(value, { privateIds: ["private-capture-sentinel"] }); },
      value => { Object.assign(value.counts, { privateToken: "private-capture-sentinel" }); },
      value => { Object.assign(value.window!, { rawId: "private-capture-sentinel" }); },
      value => { Object.assign(value.gardens[0]!, { prompt: "private-capture-sentinel" }); },
      value => { value.counts.assignments = -1; },
      value => { value.counts.assignments = 2; value.gardens[0]!.counts.assignments = 2; },
      value => { value.state = "partial"; value.reason = "incomplete_evidence";
        value.counts.assignments = 2; value.gardens[0]!.counts.assignments = 2; },
      value => { value.state = "partial"; value.reason = "incomplete_evidence";
        value.counts.missing = 1; value.gardens[0]!.counts.missing = 1; },
      value => { value.gardens[0]!.counts.invalid = -1; },
      value => { value.counts.matched = 1.5; },
      value => { value.billingModes.api = 1; },
      value => { value.priceCoverage.reported = 1; },
      value => { value.billingModes.subscription = 0; value.gardens[0]!.billingModes.subscription = 0; },
      value => { value.priceCoverage.unreported = 0; value.gardens[0]!.priceCoverage.unreported = 0; },
      value => { value.gardens[0]!.priceCoverage.unreported = 0; },
      value => { value.gardens[0]!.counts.matched = 0; },
      value => { Object.assign(value, { version: "unrecognized" }); },
    ];
    for (const mutate of mutations) {
      const value = structuredClone(good.value);
      mutate(value);
      const folded = foldGardenerSpend({ ...source, workerCalls: { ...good, value } }, repository, callMaterializedAt);
      assertUnknownCalls(folded, "invalid_capture");
      assert.deepEqual(onlyMoney(folded), onlyMoney(spend));
      assert.equal(JSON.stringify(folded).includes("private-capture-sentinel"), false);
    }
    for (const mismatch of [{ repository: "other/repo" }, { daemonRunId: "daemon-2" }]) {
      const folded = foldGardenerSpend({ ...source, workerCalls: { ...good, ...mismatch } }, repository, callMaterializedAt);
      assertUnknownCalls(folded, "scope_mismatch");
      assert.deepEqual(onlyMoney(folded), onlyMoney(spend));
    }
  });
  await t.test("null or missing persisted usage values are invalid without erasing money", async t => {
    const { source, spend } = await capturedCalls(t, [parent, child, assignment, attempt]);
    assert.ok(source.workerCalls && source.workerCalls !== "over_budget");
    const { foldGardenerSpend } = await loadSpend();
    for (const value of [null, undefined]) {
      const persisted = JSON.parse(JSON.stringify({ ...source, workerCalls: { ...source.workerCalls, value } }));
      const folded = foldGardenerSpend(persisted, repository, callMaterializedAt);
      assertUnknownCalls(folded, "invalid_capture");
      assert.deepEqual(onlyMoney(folded), onlyMoney(spend));
    }
  });
});

test("W1-T9658: cached gardener usage survives the real materialization boundary", async t => {
  await t.test("new empty capture measures zero; legacy missing capture remains unknown", async t => {
    const { spend: empty } = await capturedCalls(t, [], runtime());
    const calls = callsOf(empty);
    assert.equal(calls.state, "complete");
    assert.equal(calls.reason, "observed");
    assert.deepEqual(calls.counts, emptyCallCounts);
    assert.equal(calls.observedAt, callObservedAt);
    assert.deepEqual(calls.window, { from: at, through: callObservedAt });
    assert.equal(empty.materializedAt, callMaterializedAt);
    const { assignment, attempt } = assignedCall("legacy");
    const { source, spend } = await capturedCalls(t, [parent, child, assignment, attempt]);
    const { workerCalls: _calls, ...legacy } = source;
    const { foldGardenerSpend } = await loadSpend();
    const old = foldGardenerSpend(legacy, repository, callMaterializedAt);
    assertUnknownCalls(old, "missing_capture");
    assert.deepEqual(onlyMoney(old), onlyMoney(spend));
    const { workerCalls: _optional, ...oldPublic } = spend;
    assert.deepEqual(violations(oldPublic, SPEC.components.schemas.GardenerSpend!), [], "the new public property stays optional");
  });
  await t.test("unread archives and malformed corpus retain money with partial usage", async t => {
    const { assignment, attempt } = assignedCall("incomplete");
    const { dir, collect } = await capturedCalls(t, [parent, child, assignment, attempt]);
    const { foldGardenerSpend } = await loadSpend();
    for (const malformed of [false, true]) {
      if (malformed) writeFileSync(join(dir, "ledger.ndjson"), [parent, child, assignment, attempt]
        .map(row => JSON.stringify(row)).join("\n") + "\nnot-json\n");
      else writeFileSync(join(dir, archive() + ".gz"), "corrupt gzip");
      const spend = foldGardenerSpend(await collect(), repository, callMaterializedAt);
      assert.equal(spend.pricedSubtotalUsd, 2);
      const calls = callsOf(spend);
      assert.equal(calls.state, "partial");
      assert.equal(calls.reason, "incomplete_evidence");
      assert.deepEqual(calls.counts, { ...emptyCallCounts, assignments: 1, matched: 1 });
      if (!malformed) rmSync(join(dir, archive() + ".gz"));
    }
  });
  await t.test("usage identity overflow cannot consume the independent monetary budget", async t => {
    const excess = Array.from({ length: 16385 }, (_, i) => assignedCall(`overflow-${i}`).assignment);
    for (const moneyFirst of [true, false]) {
      const rows = moneyFirst ? [parent, child, ...excess] : [...excess, parent, child];
      const { source, spend } = await capturedCalls(t, rows);
      assert.equal(source.reason, undefined);
      assert.equal(spend.pricedSubtotalUsd, 2);
      assert.deepEqual(spend.counts, { priced: 1, unpriced: 0, unlinked: 0 });
      const calls = callsOf(spend);
      assert.notEqual(calls.state, "complete");
      assert.equal(calls.reason, "over_budget");
      assert.ok(Buffer.byteLength(JSON.stringify(source)) <= 65536);
      assert.ok(Buffer.byteLength(JSON.stringify(spend)) <= 65536);
    }
  });
  await t.test("real worker refresh persists usage for authenticated reads after ledger removal", async t => {
    const stateDir = makeTempDir("gardener-worker-call-cache");
    t.after(() => rmSync(stateDir, { recursive: true, force: true }));
    const ledgerDir = join(stateDir, "core");
    mkdirSync(ledgerDir);
    mkdirSync(join(stateDir, "read-model"));
    writeFileSync(readModelSwitchesPath(stateDir), JSON.stringify({ views: { analytics: "serve" } }));
    const inventory = runtime();
    Object.assign(inventory.gardens[0]!, { attempts: 1, completions: 1 });
    writeFileSync(join(ledgerDir, "gardener-runtime.json"), JSON.stringify(inventory));
    const first = assignedCall("cache-secret-id", { prompt: "private-prompt-sentinel", tokens: 123456789 });
    const second = assignedCall("cache-second", { billing_mode: "api", total_cost_usd: 55 });
    const rows = [first.attempt, child, first.assignment, parent];
    const replay = rows.map(row => JSON.stringify(row)).join("\n") + "\n";
    writeFileSync(join(ledgerDir, "ledger.ndjson"), replay);
    writeFileSync(join(ledgerDir, archive() + ".gz"), gzipSync(replay));
    writeFileSync(join(ledgerDir, archive(1000)), replay);
    const posted: ReadModelWorkerMessage[] = [];
    let onMessage: ((msg: { type?: string }) => void) | undefined;
    t.after(() => onMessage?.({ type: "stop" }));
    const refresh = async (expectedMatched: number) => {
      const start = posted.length;
      runReadModelWorker({ on: (_event, run) => onMessage = run,
        postMessage: m => posted.push(m as ReadModelWorkerMessage), close() {} },
      { kind: "remudero-read-model", stateDir, instances: [{ name: "core", ledgerDir, repo: repository }], tickMs: 20,
        signal: new SharedArrayBuffer(8), slowLane: { intervalMs: 60000 } });
      try {
        const latest = () => posted.slice(start).findLast(m => {
          if (m.type !== "body" || m.entry.view !== "analytics") return false;
          const spend = (m.entry.body.data as AnalyticsViewData).instances[0]?.gardenerSpend;
          // Warm snapshots already contain the same money. Wait for the requested usage
          // transition, not the earlier cached balance, through the real refresh boundary.
          return spend?.pricedSubtotalUsd === 2 && spend.workerCalls?.counts.matched === expectedMatched;
        });
        const deadline = Date.now() + 20000;
        while (!latest() && Date.now() < deadline) await sleep(20);
        const message = latest();
        assert.ok(message?.type === "body", JSON.stringify(posted.filter(m => m.type === "log")));
        return message.entry;
      } finally { onMessage?.({ type: "stop" }); }
    };
    const initial = await refresh(1);
    const before = (initial.body.data as AnalyticsViewData).instances[0]!.gardenerSpend!;
    assert.deepEqual(callsOf(before).counts, { ...emptyCallCounts, assignments: 1, matched: 1 });
    writeFileSync(join(ledgerDir, "ledger.ndjson"), replay + [second.attempt, second.assignment]
      .map(row => JSON.stringify(row)).join("\n") + "\n");
    const entry = await refresh(2);
    const spend = (entry.body.data as AnalyticsViewData).instances[0]!.gardenerSpend!;
    const calls = callsOf(spend);
    assert.equal(spend.totalUsd, 2, "reported worker prices never become an extra monetary producer");
    assert.deepEqual(calls.counts, { ...emptyCallCounts, assignments: 2, matched: 2 });
    assert.deepEqual(calls.billingModes, { api: 1, subscription: 1, unknown: 0 });
    assert.deepEqual(calls.priceCoverage, { reported: 1, unreported: 1 });
    assert.ok(calls.gardens.length <= 32);
    assert.ok(Buffer.byteLength(JSON.stringify(spend)) <= 65536);
    assert.deepEqual(violations(entry.body, SPEC.components.schemas.AnalyticsView!), []);
    for (const secret of ["cache-secret-id", "private-run-", "private-task-", "private-prompt-sentinel", "123456789", "selection_assignment_id"])
      assert.equal(JSON.stringify(spend).includes(secret), false, `public evidence must omit ${secret}`);
    for (const leaked of [
      { ...calls, privateIds: ["secret"] },
      { ...calls, counts: { ...calls.counts, tokens: 1 } },
      { ...calls, window: { ...calls.window, rawId: "secret" } },
      { ...calls, gardens: [{ ...calls.gardens[0], prompt: "secret" }] },
    ]) assert.ok(violations({ ...spend, workerCalls: leaked }, SPEC.components.schemas.GardenerSpend!).length > 0);
    for (const path of ["ledger.ndjson", archive() + ".gz", archive(1000), "gardener-runtime.json"]) rmSync(join(ledgerDir, path));
    const restarted = createReadModelWorker({ stateDir, instances: [{ name: "core", ledgerDir, repo: repository }] });
    assert.deepEqual((restarted.body("analytics")!.body.data as AnalyticsViewData).instances[0]!.gardenerSpend, spend);
    const server = createService({ tokens: { read: "r", write: "w" }, routes: buildReadModelViewRoutes({ legacy: [],
      readModelViews: ["analytics"], readModel: restarted }) });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    t.after(() => { server.closeAllConnections(); server.close(); });
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/views/analytics`;
    assert.equal((await fetch(url)).status, 401);
    for (let read = 0; read < 2; read++) {
      const response = await fetch(url, { headers: { authorization: "Bearer r" } });
      assert.equal(response.status, 200);
      const cached = await response.json() as { data: AnalyticsViewData };
      assert.deepEqual(cached.data.instances[0]!.gardenerSpend, spend);
      assert.deepEqual(cached.data.coverage, { counted: 1, of: 1, missing: [] });
      assert.deepEqual(violations(cached, SPEC.components.schemas.AnalyticsView!), []);
      assert.equal(existsSync(join(ledgerDir, "ledger.ndjson")), false, "cached reads cannot depend on the removed ledger");
    }
  });
  await t.test("fleet usage cannot crowd out independently valid repository money", async t => {
    const stateDir = makeTempDir("gardener-calls-fleet-budget");
    t.after(() => rmSync(stateDir, { recursive: true, force: true }));
    const names = Array.from({ length: 12 }, (_, i) => `repo-${i}`);
    const { captureGardenerSpendSource } = await loadSpend();
    const sources: Awaited<ReturnType<typeof captureGardenerSpendSource>>[] = [];
    for (const name of names) {
      const dir = join(stateDir, name), repo = `fixture/${name}`;
      mkdirSync(dir);
      const inventory = { ...runtime(), repository: repo, gardens: Array.from({ length: 32 }, (_, i) => ({
        ...runtime().gardens[0]!, name: `garden-${String(i).padStart(2, "0")}-${"x".repeat(48)}` })) };
      const garden = inventory.gardens[0]!;
      Object.assign(garden, { attempts: 1, completions: 1 });
      const gardenerOrigin = { ...origin, name: garden.name };
      const call = assignedCall(name);
      writeFileSync(join(dir, "gardener-runtime.json"), JSON.stringify(inventory));
      writeFileSync(join(dir, "ledger.ndjson"), [
        { ...parent, repository: repo, name: garden.name },
        { ...child, repository: repo, gardener_origin: gardenerOrigin },
        { ...call.assignment, repository: repo, gardener_origin: gardenerOrigin },
        { ...call.attempt, repository: repo, gardener_origin: gardenerOrigin },
      ].map(row => JSON.stringify(row)).join("\n") + "\n");
      sources.push(await captureGardenerSpendSource(dir, fixedClock(Date.parse(callObservedAt))));
    }
    const render = (includeUsage: boolean) => {
      const dir = join(stateDir, includeUsage ? "usage" : "control");
      mkdirSync(join(dir, "read-model"), { recursive: true });
      writeFileSync(join(dir, "ledger.ndjson"), "");
      writeFileSync(readModelSwitchesPath(dir), JSON.stringify({ views: { analytics: "serve" } }));
      let data: AnalyticsViewData | undefined;
      const ticker = createReadModelTicker({ stateDir: dir, instances: names.map(name => ({ name, ledgerDir: dir })),
        views: [createAnalyticsView()], oracle: "off", post: m => { if (m.type === "body" && m.entry.view === "analytics") data = m.entry.body.data as AnalyticsViewData; } });
      try {
        ticker.start(); ticker.tick();
        for (const [i, name] of names.entries()) {
          const snapshot = deriveAnalyticsSnapshot([], callMaterializedAt);
          const bodies = analyticsSourceBodies(snapshot, `fixture/${name}`);
          const { workerCalls: _calls, ...money } = sources[i]!;
          Object.assign(bodies[0]!.body as object, { gardenerSpendSource: includeUsage ? sources[i] : money });
          assert.equal(ticker.acceptSnapshot({ instance: name, ok: true, asOf: snapshot.asOf!, bodies }), true);
        }
        ticker.tick();
        assert.ok(data);
        assert.deepEqual(data.coverage, { counted: 12, of: 12, missing: [] });
        assert.ok(data.instances.reduce((n, i) => n + (i.gardenerSpend ? Buffer.byteLength(JSON.stringify(i.gardenerSpend)) : 0), 0) <= 65536);
        return data;
      } finally { ticker.release(); }
    };
    const control = render(false), measured = render(true);
    const baseline = control.instances.filter(i => i.gardenerSpend?.pricedSubtotalUsd === 2);
    assert.ok(baseline.length >= 10, "positive control: money alone fits for at least ten repositories");
    for (const instance of baseline) {
      const actual = measured.instances.find(i => i.instanceId === instance.instanceId)?.gardenerSpend;
      assert.equal(actual?.pricedSubtotalUsd, 2, `optional usage must not hide ${instance.instanceId}'s valid money`);
    }
  });
});
