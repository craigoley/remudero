// Phase 1 cutover (arch D4): the read-model worker becomes the single GitHub fetcher behind the
// switches.json key `github`. Exactly one keep-warm walks serve's gateway in either position, and a
// worker that is not live (no lease, silent, stopped) hands the fetch straight back to serve.

import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import type { Clock } from "../src/lib/clock.js";
import { createGithubKeepWarm, type WarmRefreshOutcome, type WarmRefreshTelemetry } from "../src/lib/github-refresh-pacer.js";
import { READ_MODEL_LEASE_TTL_MS } from "../src/lib/read-model-db.js";
import { buildServeServer, type ServeDeps } from "../src/lib/serve.js";
import { GITHUB_FETCHER_STEP, createReadModelWorker, readModelSwitchesPath, readReadModelSwitches } from "../src/lib/read-model-worker.js";
import type { ShadowRequest } from "../src/lib/view-shadow.js";
import { makeTempDir } from "../src/lib/tmp.js";

type TestCtx = { after: (fn: () => void) => void };
const HOUR_MS = 3_600_000;
const T0 = Date.parse("2026-10-01T12:00:00.000Z");

/** A manual clock and timer queue, so both keep-warms are read without real sleeps. */
function manualTime(startMs: number) {
  let now = startMs;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const clock: Clock = { now: () => now, date: () => new Date(now), iso: () => new Date(now).toISOString() };
  const setTimeout = ((fn: () => void, ms?: number) => {
    const id = nextId++;
    timers.set(id, { at: now + (ms ?? 0), fn });
    return { id, unref() {} } as unknown as ReturnType<typeof globalThis.setTimeout>;
  }) as unknown as typeof globalThis.setTimeout;
  const clearTimeout = ((handle: { id: number } | undefined) => {
    if (handle) timers.delete(handle.id);
  }) as unknown as typeof globalThis.clearTimeout;
  const advance = (ms: number): void => {
    const end = now + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      now = Math.max(now, due[1].at);
      due[1].fn();
    }
    now = end;
  };
  return { clock, setTimeout, clearTimeout, advance };
}

/** A worker thread that posts the lease state it is told to, through the handle's shadow channel. */
function leaseWorker(dir: string): URL {
  const path = join(dir, "lease-worker.mjs");
  writeFileSync(path, `import { parentPort } from "node:worker_threads";
parentPort.on("message", (m) => {
  if (m.type === "shadow" && m.lease) parentPort.postMessage({ type: "state", at: 1, instances: [{ instance: "core", generation: 0, lease: m.lease, failures: 0, newestTs: null }], switches: { projector: "on", views: {} } });
});
setInterval(() => {}, 1000);
`);
  return pathToFileURL(path);
}

function rig(t: TestCtx) {
  const stateDir = makeTempDir("gh-fetcher");
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const time = manualTime(T0);
  const calls = { serve: 0, worker: 0 };
  const walks: number[] = [];
  let last: WarmRefreshOutcome | undefined;
  const walk = (): void => {
    walks.push(time.clock.now());
    const reset = (time.clock.now() + HOUR_MS / 2) / 1000;
    last = { seq: (last?.seq ?? 0) + 1, settledAtMs: time.clock.now(), durationMs: 0, rateLimited: false, failed: false,
      spend: [{ resource: "core", calls: 18, reading: { remaining: 14_000, limit: 15_000, reset, resource: "core" } }] };
  };
  const telemetry = (): WarmRefreshTelemetry => ({ inFlight: false, last });
  const rows: Array<[string, Record<string, unknown>]> = [];
  const log = (step: string, extra: Record<string, unknown> = {}): void => void rows.push([step, extra]);
  const timers = { clock: time.clock, setTimeout: time.setTimeout, clearTimeout: time.clearTimeout, targetFreshnessMs: 150_000, telemetry, log };
  const serve = createGithubKeepWarm({ ...timers, refresh: () => (calls.serve++, walk()) });
  let tick = (): void => {};
  let states = 0;
  const handle = createReadModelWorker({
    stateDir, instances: [{ name: "core", ledgerDir: stateDir }], workerUrl: leaseWorker(stateDir), stopWaitMs: 50, clock: time.clock, log,
    observe: (msg) => void (msg.type === "state" && states++),
    every: (run) => ((tick = run), () => {}),
    github: { serve, ...timers, refresh: () => (calls.worker++, walk()) },
  });
  t.after(() => {
    handle.stop();
    serve.stop();
  });
  const switchTo = (github: "serve" | "worker"): void => {
    mkdirSync(dirname(readModelSwitchesPath(stateDir)), { recursive: true });
    writeFileSync(readModelSwitchesPath(stateDir), JSON.stringify({ github }));
  };
  /** The worker reports `lease` for the home instance, and the handle has heard it. */
  const say = async (lease: "held" | "elsewhere"): Promise<void> => {
    const before = states;
    handle.shadow({ lease } as unknown as ShadowRequest);
    for (let i = 0; i < 400 && states === before; i++) await sleep(5);
    assert.equal(handle.state().instances.get("core")?.lease, lease, "a positive control: the worker's new state reached the handle");
  };
  /** Who fetched over one hour of keep-warm time. */
  const hour = (): { serve: number; worker: number } => {
    calls.serve = 0;
    calls.worker = 0;
    time.advance(HOUR_MS);
    return { ...calls };
  };
  const owners = (): unknown[] => rows.filter(([step]) => step === GITHUB_FETCHER_STEP).map(([, extra]) => extra.owner);
  return { handle, serve, time, walks, rows, switchTo, say, hour, owners, tick: () => tick() };
}

test("exactly one keep-warm fetches github facts in either switch position", async (t) => {
  const r = rig(t);
  r.handle.start();
  r.serve.start();
  const serving = r.hour();
  assert.ok(serving.serve >= 10, `with no switch serve keeps the facts warm, got ${serving.serve} walks`);
  assert.equal(serving.worker, 0, "the worker never fetches while serve owns the gateway");

  r.switchTo("worker");
  await r.say("held");
  r.tick();
  const handed = r.hour();
  assert.ok(handed.worker >= 10, `switched to worker the worker keeps the facts warm, got ${handed.worker} walks`);
  assert.equal(handed.serve, 0, "serve's keep-warm is off while the worker fetches");

  r.switchTo("serve");
  await r.say("held");
  r.tick();
  const back = r.hour();
  assert.ok(back.serve >= 10, `switched back to serve, serve fetches again, got ${back.serve} walks`);
  assert.equal(back.worker, 0, "the rollback leaves the worker no fetch");
  assert.deepEqual(r.owners(), ["worker", "serve"], "each handover is ledgered once");
});

test("a worker without its lease or gone silent hands the github fetch back to serve", async (t) => {
  const r = rig(t);
  r.switchTo("worker");
  r.handle.start();
  r.serve.start();
  const unleased = r.hour();
  assert.ok(unleased.serve >= 10 && unleased.worker === 0, `switched to worker before the worker holds a lease, serve fetches: ${JSON.stringify(unleased)}`);

  await r.say("held");
  r.tick();
  assert.equal(r.hour().serve, 0, "a leased worker took the fetch");
  await r.say("elsewhere");
  r.tick();
  const elsewhere = r.hour();
  assert.ok(elsewhere.serve >= 10 && elsewhere.worker === 0, `a worker whose lease is held elsewhere hands back: ${JSON.stringify(elsewhere)}`);

  await r.say("held");
  r.tick();
  r.time.advance(READ_MODEL_LEASE_TTL_MS);
  r.tick();
  const silent = r.hour();
  assert.ok(silent.serve >= 10 && silent.worker === 0, `a worker silent for a lease TTL hands back: ${JSON.stringify(silent)}`);

  await r.say("held");
  r.tick();
  r.handle.stop();
  const stopped = r.hour();
  assert.ok(stopped.serve >= 10 && stopped.worker === 0, `a stopped worker hands back: ${JSON.stringify(stopped)}`);
  assert.deepEqual(r.owners(), ["worker", "serve", "worker", "serve", "worker", "serve"]);
});

test("a github fetch handover counts each walk once in the keep-warm rollup", async (t) => {
  const r = rig(t);
  r.switchTo("worker");
  r.handle.start();
  r.serve.start();
  r.time.advance(10 * 60_000);
  for (let i = 0; i < 3; i++) {
    await r.say("held");
    r.tick();
    r.time.advance(10 * 60_000);
    await r.say("elsewhere");
    r.tick();
    r.time.advance(10 * 60_000);
  }
  r.handle.stop();
  r.serve.stop();
  const rollups = r.rows.filter(([step]) => step === "github.keep_warm.rollup");
  assert.ok(rollups.length >= 6, `each owner's stop flushes its window under the same step, got ${rollups.length}`);
  const counted = rollups.reduce((sum, [, extra]) => sum + Number(extra.refreshes), 0);
  assert.ok(r.walks.length >= 10, `a positive control: walks happened, got ${r.walks.length}`);
  assert.equal(counted, r.walks.length, "every walk is counted by exactly one keep-warm");
});

test("a reader noted by serve speeds the worker github keep-warm", async (t) => {
  const r = rig(t);
  r.switchTo("worker");
  r.handle.start();
  r.serve.start();
  await r.say("held");
  r.tick();
  r.hour();
  const idle = r.hour().worker;
  const before = r.walks.length;
  for (let i = 0; i < 120; i++) {
    r.handle.noteGithubRead?.();
    r.time.advance(30_000);
  }
  const reading = r.walks.length - before;
  assert.ok(idle >= 10, `a positive control: the idle worker walks, got ${idle}`);
  assert.ok(reading >= idle * 1.8, `a reader roughly doubles the worker's refresh rate: idle ${idle} vs read ${reading} per hour`);
});

test("the github switch reads serve or worker and refuses any other mode", (t) => {
  const dir = makeTempDir("gh-switch");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = readModelSwitchesPath(dir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ github: "worker" }));
  const read = readReadModelSwitches(path);
  assert.equal(read.ok && read.switches.github, "worker");
  writeFileSync(path, JSON.stringify({ github: "both" }));
  assert.deepEqual(readReadModelSwitches(path), { ok: false, reason: 'github has mode "both"' }, "an unknown mode is unreadable, so serve keeps the fetch");
});

test("serve hands its gateway keep-warm to a live worker switched to fetch github", async (t) => {
  const root = makeTempDir("gh-fetcher-serve");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stateDir = join(root, "state");
  mkdirSync(join(stateDir, "read-model"), { recursive: true });
  writeFileSync(readModelSwitchesPath(stateDir), JSON.stringify({ github: "worker" }));
  const ledgerPath = join(stateDir, "ledger.ndjson");
  const planPath = join(root, "plan.yaml");
  writeFileSync(ledgerPath, "");
  writeFileSync(planPath, "[]\n");
  const workerPath = join(root, "held-worker.mjs");
  writeFileSync(workerPath, `import { parentPort } from "node:worker_threads";
setInterval(() => parentPort.postMessage({ type: "state", at: 1, instances: [{ instance: "core", generation: 0, lease: "held", failures: 0, newestTs: null }], switches: { projector: "on", views: {} } }), 20);
`);
  let walks = 0;
  const github = { prByRef: () => null, findMergedByTrailer: () => null, headRefName: () => undefined, prBody: () => undefined,
    warmsOffLoop: () => true, warm: () => void walks++, warmTelemetry: () => ({ inFlight: false }) };
  const rows: string[] = [];
  const ticks: Array<() => void> = [];
  const deps: ServeDeps = {
    board: { plan: { tasks: [], byId: new Map() }, ledgerPath, github },
    panelGraph: { root, planPath, ledgerPath, github: { prView: () => null }, statusGithub: github, ratify: { approve: () => {}, reframe: () => {} } },
    ledgerPath, issues: { close: () => {} }, fleetControlRoot: root, questionsRoot: root, tokens: { read: "r", write: "w" }, consoleSha: "aaaaaaaa",
    resolveCurrentSha: () => "aaaaaaaa", gatewayCheckout: async () => ({ state: "clean" }) as never, githubAppRefresh: { start: () => ({ armed: false, stop() {} }) as never },
    analytics: { readSnapshot: () => new Promise(() => {}) },
    readModel: { workerUrl: pathToFileURL(workerPath), stopWaitMs: 50, every: (run) => (ticks.push(run), () => {}) },
    log: (step, extra) => void (step === GITHUB_FETCHER_STEP && rows.push(String(extra?.owner))),
  };
  const server = buildServeServer(deps);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    for (let i = 0; i < 400 && rows.length === 0; i++) {
      for (const run of ticks) run();
      await sleep(10);
    }
    assert.deepEqual(rows, ["worker"], "serve's own keep-warm is handed to the leased worker");
    assert.ok(walks >= 1, "a positive control: serve's keep-warm walked the gateway before the handover");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
