// W1-T5055 (arch Phase 4 P4-T16, design D10): the analytics refresh moves to the read model's slow lane, which
// commits each instance's output as `source_snapshot` rows, and the `analytics` view merges every instance's row
// in core. These tests drive the real ticker over real SQLite stores, the real refresh over a real ledger, and
// the real worker with its slow lane and view threads.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import {
  createAnalyticsSnapshotCache,
  deriveAnalyticsSnapshot,
  deriveAnalyticsSnapshotFromCheckpointedLedger,
  writeAnalyticsCheckpoint,
  type AnalyticsSnapshot,
  type AnalyticsTimer,
} from "../src/lib/analytics-route.js";
import {
  ANALYTICS_SOURCE_CONSOLE_V1,
  ANALYTICS_SOURCE_NAMES,
  ANALYTICS_STALE_AFTER_MS,
  ANALYTICS_VIEW_NAME,
  analyticsLegacyView,
  analyticsSourceBodies,
  createAnalyticsView,
  mergeAnalytics,
  type AnalyticsConsoleSource,
  type AnalyticsViewData,
} from "../src/lib/analytics-view.js";
import type { Clock } from "../src/lib/clock.js";
import { LEDGER_PROJECTOR_SCHEMA_VERSION } from "../src/lib/ledger-projector.js";
import { attachReadModel, currentReadModelPath, sourceSnapshotStates, type SourceSnapshotWrite } from "../src/lib/read-model-db.js";
import { runSlowLaneWorker, type AnalyticsRefresh, type SlowLaneMessage } from "../src/lib/read-model-slow-lane.js";
import { createReadModelTicker, readModelSwitchesPath, runReadModelWorker, type ReadModelWorkerMessage } from "../src/lib/read-model-worker.js";
import { makeTempDir } from "../src/lib/tmp.js";
import { createViewShadow, legacyViewSampler, type ShadowEvidence, type ShadowRequest } from "../src/lib/view-shadow.js";
import type { ViewSource } from "../src/lib/views.js";
import { switchViewsOn } from "./helpers/read-model-switches.js";

type TestCtx = { after: (fn: () => void) => void };

const T0 = Date.parse("2026-10-05T12:00:00.000Z");
const MINUTE = 60_000;

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function handClock(start: number): { clock: Clock; advance: (ms: number) => void } {
  let ms = start;
  return { clock: { now: () => ms, date: () => new Date(ms), iso: () => new Date(ms).toISOString() }, advance: (by) => void (ms += by) };
}

function scratch(t: TestCtx, kind: string): string {
  const dir = makeTempDir(kind);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** One resolved run of `durationMs`, with one worker call carrying `tokens`. */
function run(id: string, startMs: number, durationMs: number, tokens: Record<string, number>): Array<Record<string, unknown>> {
  return [
    { ts: iso(startMs), step: "run.start", run_id: id, task_id: `W1-${id}`, repo: "o/r", run_type: "implement" },
    { ts: iso(startMs + 1), step: "implement.done", run_id: id, model: "claude-opus-5-5", lane: "implement", tokens },
    { ts: iso(startMs + durationMs), step: "verdict", run_id: id, task_id: `W1-${id}`, verdict: "merged" },
  ];
}

/** Core: two runs of 10 s and 20 s, 90 of 100 prompt tokens read from cache. Site: one 1000 s run, none of 300 cached. */
const CORE_LINES = [...run("r1", T0 - 60 * MINUTE, 10_000, { input: 10, output: 5, cacheRead: 90 }), ...run("r2", T0 - 50 * MINUTE, 20_000, { output: 5 })];
const SITE_LINES = run("s1", T0 - 40 * MINUTE, 1_000_000, { input: 300, output: 7 });

function snapshotOf(lines: ReadonlyArray<Record<string, unknown>>, atMs: number): AnalyticsSnapshot {
  return deriveAnalyticsSnapshot(lines, iso(atMs));
}

function written(instance: string, snapshot: AnalyticsSnapshot): SourceSnapshotWrite {
  return { instance, ok: true, asOf: snapshot.asOf!, bodies: analyticsSourceBodies(snapshot) };
}

function metric(data: AnalyticsViewData, key: string): { value: number | null; instances: number; notCollectedReason?: string } {
  const found = data.overview.find((m) => m.key === key);
  assert.ok(found, `the overview carries ${key}`);
  return found;
}

/** Two instances' stores, a ticker building only the analytics view over them, and its latest analytics body. */
function world(t: TestCtx, clock: Clock, opts: { stateDir?: string; holder?: string } = {}) {
  const stateDir = opts.stateDir ?? scratch(t, "analytics-view-state");
  const coreDir = join(stateDir, "ledgers", "core");
  const siteDir = join(stateDir, "ledgers", "site");
  for (const dir of [coreDir, siteDir]) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "ledger.ndjson"), `${JSON.stringify({ ts: iso(T0 - MINUTE), step: "daemon.tick" })}\n`);
  }
  // W1-T5896 builds no view whose switch is absent; a test that set its own switch keeps it.
  if (!existsSync(readModelSwitchesPath(stateDir))) switchViewsOn(stateDir, [ANALYTICS_VIEW_NAME]);
  const posted: ReadModelWorkerMessage[] = [];
  const ticker = createReadModelTicker({
    stateDir, instances: [{ name: "core", ledgerDir: coreDir }, { name: "site", ledgerDir: siteDir }], views: [createAnalyticsView()],
    clock, holder: opts.holder ?? "holder-1", oracle: "off", post: (m) => void posted.push(m),
  });
  ticker.start();
  ticker.tick();
  const body = (): { data: AnalyticsViewData; sources: ViewSource[]; stale: boolean } => {
    const last = posted.findLast((m) => m.type === "body" && m.entry.view === ANALYTICS_VIEW_NAME);
    assert.ok(last?.type === "body", "the analytics view posted a body");
    return { data: last.entry.body.data as AnalyticsViewData, sources: last.entry.body.sources, stale: last.entry.body.stale };
  };
  const logs = (step: string) => posted.flatMap((m) => (m.type === "log" && m.step === step ? [m.extra] : []));
  /** A source's latest reading as serve holds it: a body whose data did not move is not re-posted, its sources are. */
  const reading = (name: string): ViewSource | undefined => posted.flatMap((m) => (m.type === "sources" ? m.sources : [])).findLast((s) => s.name === name);
  return { stateDir, ticker, posted, body, logs, reading };
}

test("analytics fixtures explicitly enable snapshots while an unswitched analytics view stays dark", (t) => {
  const { clock } = handClock(T0);
  const darkState = scratch(t, "analytics-unswitched-state");
  switchViewsOn(darkState, []);
  const dark = world(t, clock, { stateDir: darkState });
  t.after(() => dark.ticker.release());
  assert.equal(dark.ticker.acceptSnapshot(written("core", snapshotOf(CORE_LINES, T0 - MINUTE))), true);
  dark.ticker.tick();
  assert.equal(dark.posted.some((m) => m.type === "body" && m.entry.view === ANALYTICS_VIEW_NAME), false,
    "an explicit empty switch file stays dark even after a real non-empty snapshot is committed");

  const served = world(t, clock);
  t.after(() => served.ticker.release());
  assert.equal(served.ticker.acceptSnapshot(written("core", snapshotOf(CORE_LINES, T0 - MINUTE))), true);
  served.ticker.tick();
  assert.equal(metric(served.body().data, "runs.completed").value, 2,
    "positive control: the explicitly served view materializes its real snapshot");
});

test("W1-T5055: the analytics view merges every instance snapshot", (t) => {
  const { clock } = handClock(T0);
  const w = world(t, clock);
  t.after(() => w.ticker.release());
  const core = snapshotOf(CORE_LINES, T0 - MINUTE);
  const site = snapshotOf(SITE_LINES, T0 - 2 * MINUTE);
  // CONTROL: the refresh read every run, so each instance has its own non-trivial numbers to merge.
  assert.deepEqual([core.consoleV1.metrics.find((m) => m.key === "runs.completed")?.value, site.consoleV1.metrics.find((m) => m.key === "runs.completed")?.value], [2, 1]);
  assert.equal(w.ticker.acceptSnapshot(written("core", core)), true);
  assert.equal(w.ticker.acceptSnapshot(written("site", site)), true);
  w.ticker.tick();
  const { data, sources, stale } = w.body();
  assert.deepEqual(data.coverage, { counted: 2, of: 2, missing: [] });
  assert.deepEqual([metric(data, "runs.completed").value, metric(data, "runs.completed").instances], [3, 2], "the second instance's run is counted");
  assert.equal(metric(data, "tokens.total").value, 10 + 5 + 90 + 5 + 300 + 7);
  // The ratio of the summed terms (90 / 400), not the mean of the two ratios (0.9 and 0) = 0.45.
  assert.equal(metric(data, "cache.reuse").value, 90 / 400);
  // The median of every run together (10 s, 20 s, 1000 s), not the mean of the two p50s (10 s and 1000 s).
  assert.equal(metric(data, "duration.p50.ms").value, 20_000);
  assert.equal(metric(data, "queue.pending").value, null, "a metric no instance collects stays not collected, never zero");
  assert.deepEqual(data.instances.map((i) => [i.instanceId, i.metrics?.find((m) => m.key === "runs.completed")?.value]), [["core", 2], ["site", 1]]);
  assert.deepEqual(sources.map((s) => [s.name, s.state, s.asOf]), [["analytics:core", "fresh", core.asOf], ["analytics:site", "fresh", site.asOf]]);
  assert.equal(stale, false);
});

test("W1-T5055: after a restart the analytics view answers from the persisted source snapshot", (t) => {
  const { clock } = handClock(T0);
  const first = world(t, clock);
  const core = snapshotOf(CORE_LINES, T0 - MINUTE);
  assert.equal(first.ticker.acceptSnapshot(written("core", core)), true);
  assert.equal(first.ticker.acceptSnapshot(written("site", snapshotOf(SITE_LINES, T0 - MINUTE))), true);
  first.ticker.tick();
  const before = first.body();
  first.ticker.release();

  // A new process: a new ticker and holder over the same store, and no refresh has run in it.
  const second = world(t, clock, { stateDir: first.stateDir, holder: "holder-2" });
  t.after(() => second.ticker.release());
  assert.equal(second.posted.some((m) => m.type === "log" && m.step === "read_model.source_snapshot_dropped"), false);
  const after = second.body();
  assert.deepEqual(after.data, before.data, "the restarted view answers the committed snapshots");
  assert.equal(metric(after.data, "runs.completed").value, 3);
  assert.deepEqual(after.sources.map((s) => [s.name, s.state, s.asOf]), before.sources.map((s) => [s.name, s.state, s.asOf]));
});

test("an instance with no snapshot yet is left out of the overview, named, and its source reads unavailable", (t) => {
  const { clock } = handClock(T0);
  const w = world(t, clock);
  t.after(() => w.ticker.release());
  w.ticker.tick();
  const cold = w.body();
  assert.deepEqual(cold.data.coverage, { counted: 0, of: 2, missing: ["core", "site"] });
  assert.deepEqual(cold.data.overview.map((m) => m.value), [null, null, null, null, null, null], "no refresh yet is not collected, never zero");
  assert.ok(cold.data.overview.every((m) => m.notCollectedReason === "no instance has completed an analytics refresh yet"), JSON.stringify(cold.data.overview));

  assert.equal(w.ticker.acceptSnapshot(written("core", snapshotOf(CORE_LINES, T0 - MINUTE))), true);
  w.ticker.tick();
  const { data, sources, stale } = w.body();
  assert.deepEqual(data.coverage, { counted: 1, of: 2, missing: ["site"] });
  assert.deepEqual([metric(data, "runs.completed").value, metric(data, "cache.reuse").value, metric(data, "duration.p50.ms").value], [2, 0.9, 10_000]);
  assert.deepEqual(data.instances[1], { instanceId: "site", reason: "no analytics refresh has completed yet" });
  assert.deepEqual(sources.map((s) => [s.name, s.state, s.phase]), [["analytics:core", "fresh", undefined], ["analytics:site", "unavailable", "warming"]]);
  assert.equal(stale, true, "a partial overview is never presented as the whole fleet's");
});

test("a failed refresh keeps the last committed snapshot and says so, never fresh zeros", (t) => {
  const { clock, advance } = handClock(T0);
  const w = world(t, clock);
  t.after(() => w.ticker.release());
  assert.equal(w.ticker.acceptSnapshot({ instance: "site", ok: false, names: ANALYTICS_SOURCE_NAMES, error: "ledger unreadable", atMs: T0 }), true);
  const core = snapshotOf(CORE_LINES, T0 - MINUTE);
  assert.equal(w.ticker.acceptSnapshot(written("core", core)), true);
  w.ticker.tick();
  const kept = w.body();
  advance(MINUTE);
  assert.equal(w.ticker.acceptSnapshot({ instance: "core", ok: false, names: ANALYTICS_SOURCE_NAMES, error: "analytics refresh exceeded 120000 ms", atMs: T0 + MINUTE }), true);
  w.ticker.tick();
  const { data } = w.body();
  assert.deepEqual(data, kept.data, "the overview is the snapshot the failure kept");
  assert.equal(metric(data, "runs.completed").value, 2);
  const coreSource = w.reading("analytics:core")!;
  assert.deepEqual([coreSource.state, coreSource.phase, coreSource.asOf], ["stale", "failed", core.asOf]);
  assert.match(String(coreSource.reason), /refresh failed \(analytics refresh exceeded 120000 ms\)/);
  const siteSource = w.reading("analytics:site")!;
  assert.deepEqual([siteSource.state, siteSource.phase], ["unavailable", "failed"], "a failure before any snapshot is unavailable");
  assert.deepEqual(data.instances[1], { instanceId: "site", reason: "the analytics refresh failed: ledger unreadable" });

  // The next good refresh clears the failure.
  assert.equal(w.ticker.acceptSnapshot(written("core", snapshotOf(CORE_LINES, T0 + MINUTE))), true);
  w.ticker.tick();
  assert.equal(w.reading("analytics:core")?.state, "fresh");
});

test("a snapshot past its bound reads stale and behind", (t) => {
  const { clock, advance } = handClock(T0);
  const w = world(t, clock);
  t.after(() => w.ticker.release());
  assert.equal(w.ticker.acceptSnapshot(written("core", snapshotOf(CORE_LINES, T0))), true);
  advance(ANALYTICS_STALE_AFTER_MS + MINUTE);
  w.ticker.tick();
  const source = w.reading("analytics:core")!;
  assert.deepEqual([source.state, source.phase, source.reason], ["stale", "behind", "analytics 33 min old"]);
});

test("a source snapshot is not committed through a lost writer lease, and the last committed one stands", (t) => {
  const { clock } = handClock(T0);
  const w = world(t, clock);
  t.after(() => w.ticker.release());
  const core = snapshotOf(CORE_LINES, T0 - MINUTE);
  assert.equal(w.ticker.acceptSnapshot(written("core", core)), true);
  // Another serve takes the home store's lease.
  const path = currentReadModelPath(w.stateDir, "core", LEDGER_PROJECTOR_SCHEMA_VERSION);
  const thief = attachReadModel(path, LEDGER_PROJECTOR_SCHEMA_VERSION);
  t.after(() => thief.close());
  thief.prepare("UPDATE lease SET holder = 'another-serve'").run();
  assert.equal(w.ticker.acceptSnapshot(written("core", snapshotOf(CORE_LINES, T0))), false);
  assert.match(String(w.logs("read_model.source_snapshot_failed")[0]?.error), /lease_lost/);
  assert.deepEqual(sourceSnapshotStates(thief, ANALYTICS_SOURCE_CONSOLE_V1).map((s) => [s.instance, s.asOf]), [["core", core.asOf]], "the fenced write left the committed snapshot");
});

test("a source snapshot is dropped, not written, while the projector is switched off", (t) => {
  const { clock, advance } = handClock(T0);
  const w = world(t, clock);
  t.after(() => w.ticker.release());
  writeFileSync(readModelSwitchesPath(w.stateDir), JSON.stringify({ projector: "off" }));
  advance(10_000);
  w.ticker.tick();
  assert.equal(w.ticker.acceptSnapshot(written("core", snapshotOf(CORE_LINES, T0))), false);
  assert.deepEqual(w.logs("read_model.source_snapshot_dropped"), [{ instance: "core", ok: true, reason: "projector switched off" }]);
});

test("serve's legacy merge over its own caches matches the read-model body for the same snapshots", (t) => {
  const { clock } = handClock(T0);
  const w = world(t, clock);
  t.after(() => w.ticker.release());
  const core = snapshotOf(CORE_LINES, T0 - MINUTE);
  const site = snapshotOf(SITE_LINES, T0 - MINUTE);
  w.ticker.acceptSnapshot(written("core", core));
  w.ticker.acceptSnapshot(written("site", site));
  w.ticker.tick();
  const legacy = analyticsLegacyView({ clock, scopes: () => [{ instanceId: "core", analytics: () => core }, { instanceId: "site", analytics: () => site }] });
  const computed = legacy.compute(new URLSearchParams());
  assert.ok(!("error" in computed));
  assert.deepEqual(computed.data, w.body().data, "the two sides agree on the same inputs");
  assert.deepEqual(computed.sources, w.body().sources);
  assert.deepEqual(legacy.shadowSources, { overview: ["analytics:core", "analytics:site"], coverage: ["analytics:core", "analytics:site"], "instances[instanceId=core]": "analytics:core", "instances[instanceId=site]": "analytics:site" });
});

test("the legacy merge leaves out a cold cache and merges cache reuse only from carried token terms", () => {
  const core = snapshotOf(CORE_LINES, T0);
  // A snapshot restored from a checkpoint file carries only what JSON kept: no cache token terms.
  const restored = JSON.parse(JSON.stringify(snapshotOf(SITE_LINES, T0))) as AnalyticsSnapshot;
  const cold = { ...core, asOf: null } as AnalyticsSnapshot;
  const compute = (scopes: Array<{ instanceId: string; analytics: () => AnalyticsSnapshot }>) => {
    const out = analyticsLegacyView({ scopes: () => scopes }).compute(new URLSearchParams());
    assert.ok(!("error" in out));
    return out.data;
  };
  const alone = compute([{ instanceId: "site", analytics: () => restored }, { instanceId: "dark", analytics: () => cold }]);
  assert.deepEqual(alone.coverage, { counted: 1, of: 2, missing: ["dark"] });
  assert.equal(metric(alone, "cache.reuse").value, 0, "a lone instance's own ratio stands");
  const both = compute([{ instanceId: "core", analytics: () => core }, { instanceId: "site", analytics: () => restored }]);
  assert.deepEqual([metric(both, "cache.reuse").value, metric(both, "cache.reuse").notCollectedReason], [null, "an instance's snapshot carries no cache token terms; awaiting its next refresh"]);
  assert.equal(analyticsLegacyView({ scopes: () => [] }).shadowSources && Object.keys(analyticsLegacyView({ scopes: () => [] }).shadowSources!).length, 0);
});

test("the analytics view builds nothing while this serve has no home store open", () => {
  assert.deepEqual(createAnalyticsView().materialize({ now: T0, instances: [{ state: { instance: "core" } }] }), []);
});

test("a corpus with no worker call and no resolved run merges to not collected", () => {
  const empty = deriveAnalyticsSnapshot([], iso(T0));
  const { data } = mergeAnalytics([{ instanceId: "core", snapshot: { asOf: empty.asOf!, console: analyticsSourceBodies(empty)[0]!.body as AnalyticsConsoleSource } }], T0);
  assert.deepEqual([metric(data, "cache.reuse").value, metric(data, "duration.p50.ms").value, metric(data, "runs.completed").value], [null, null, 0]);
  assert.equal(metric(data, "duration.p50.ms").notCollectedReason, "no run.start/verdict pair has resolved yet");
});

/** The slow lane's body in this thread, its passes fired by hand. */
function lane(config: Parameters<typeof runSlowLaneWorker>[1], refresh?: AnalyticsRefresh, clock?: Clock) {
  let onMessage: ((msg: { type?: string; held?: unknown; modes?: unknown }) => void) | undefined;
  const posted: SlowLaneMessage[] = [];
  let next: (() => void) | undefined;
  const handle = runSlowLaneWorker({ on: (_event, run) => (onMessage = run), postMessage: (m) => void posted.push(m as SlowLaneMessage) }, config, {
    ...(clock ? { clock } : {}),
    ...(refresh ? { analyticsRefresh: refresh } : {}),
    schedule: (run) => {
      next = run;
      return () => void (next = undefined);
    },
  });
  const snapshots = (): SourceSnapshotWrite[] => posted.flatMap((m) => (m.type === "source_snapshot" ? [m.snapshot] : []));
  const passes = (): number => posted.filter((m) => m.type === "unit" && m.unit === "analytics").length;
  return {
    handle, posted, snapshots,
    switchOn: (mode = "shadow") => onMessage?.({ type: "views", modes: { [ANALYTICS_VIEW_NAME]: mode } }),
    lease: () => onMessage?.({ type: "lease", held: true }),
    fire: () => next?.(),
    settle: async (want: { passes: number; snapshots: number }): Promise<void> => {
      const deadline = Date.now() + 10_000;
      while ((passes() < want.passes || snapshots().length < want.snapshots) && Date.now() < deadline) await sleep(5);
      assert.deepEqual([passes(), snapshots().length], [want.passes, want.snapshots]);
    },
  };
}

test("the slow lane refreshes each instance's analytics off serve's loop and posts its source snapshots", async (t) => {
  const stateDir = scratch(t, "analytics-lane");
  writeFileSync(join(stateDir, "ledger.ndjson"), CORE_LINES.map((l) => `${JSON.stringify(l)}\n`).join(""));
  const l = lane({ analytics: { instances: [{ name: "core", stateDir }] }, intervalMs: 60_000 });
  t.after(() => l.handle.stop());
  l.lease();
  await l.settle({ passes: 1, snapshots: 0 });
  assert.equal(l.snapshots().length, 0, "the analytics view is not switched on, so nothing is refreshed");
  l.switchOn();
  l.fire();
  await l.settle({ passes: 2, snapshots: 1 });
  const write = l.snapshots()[0]!;
  assert.ok(write.ok);
  assert.deepEqual(write.bodies.map((b) => b.name), [...ANALYTICS_SOURCE_NAMES]);
  const console = write.bodies[0]!.body as AnalyticsConsoleSource;
  assert.deepEqual([console.projection.metrics.find((m) => m.key === "runs.completed")?.value, console.cacheReuseTokens, console.taskDurationsMs], [2, { input: 10, cacheRead: 90, cacheCreation: 0 }, [10_000, 20_000]]);
  assert.equal((write.bodies[1]!.body as { version: string }).version, "console-signals-v1");
  assert.equal("queue" in (write.bodies[1]!.body as object), false, "the live readings are serve's and are not written as zeros");
  l.fire();
  await l.settle({ passes: 3, snapshots: 1 });
  assert.ok(l.posted.some((m) => m.type === "log" && m.step === "analytics.source_snapshot_built"));
});

test("the slow lane posts a failure, not a snapshot, when a refresh throws, cannot read its ledger or times out", async (t) => {
  const { clock, advance } = handClock(T0);
  const unreadable = { ...snapshotOf([], T0), benchmarkEvidence: { reason: "ledger-source-unreadable" } } as unknown as AnalyticsSnapshot;
  const priors: unknown[] = [];
  let calls = 0;
  const refresh: AnalyticsRefresh = async (_dir, _clock, signal, prior) => {
    priors.push(prior);
    calls++;
    if (calls === 1) throw new Error("disk gone");
    if (calls === 2) return { snapshot: unreadable, checkpoint: {} as never };
    return new Promise((_resolve, reject) => signal!.addEventListener("abort", () => reject(signal!.reason)));
  };
  const dir = scratch(t, "analytics-lane-fail");
  const l = lane({ analytics: { instances: [{ name: "core", stateDir: dir }], timeoutMs: 20, intervalMs: MINUTE }, intervalMs: 1_000 }, refresh, clock);
  t.after(() => l.handle.stop());
  l.switchOn("auto");
  l.lease();
  await l.settle({ passes: 1, snapshots: 1 });
  l.fire();
  await l.settle({ passes: 2, snapshots: 1 });
  assert.equal(calls, 1, "a refresh is not due again before its interval");
  advance(MINUTE);
  l.fire();
  await l.settle({ passes: 3, snapshots: 2 });
  advance(MINUTE);
  l.fire();
  await l.settle({ passes: 4, snapshots: 3 });
  assert.deepEqual(l.snapshots().map((s) => (s.ok ? "ok" : s.error)), ["disk gone", "the ledger could not be read", "analytics refresh exceeded 20 ms"]);
  assert.deepEqual(l.snapshots().map((s) => !s.ok && [...s.names]), [[...ANALYTICS_SOURCE_NAMES], [...ANALYTICS_SOURCE_NAMES], [...ANALYTICS_SOURCE_NAMES]]);
  assert.deepEqual(priors, [undefined, undefined, undefined], "with no checkpoint file and no good refresh, each starts cold");
});

test("the read-model worker commits a real slow lane's analytics refresh and serves the merged view", async (t) => {
  const stateDir = scratch(t, "analytics-worker");
  const ledgerDir = join(stateDir, "core");
  mkdirSync(ledgerDir, { recursive: true });
  writeFileSync(join(ledgerDir, "ledger.ndjson"), CORE_LINES.map((l) => `${JSON.stringify(l)}\n`).join(""));
  mkdirSync(join(stateDir, "read-model"), { recursive: true });
  writeFileSync(readModelSwitchesPath(stateDir), JSON.stringify({ views: { [ANALYTICS_VIEW_NAME]: "shadow" } }));
  const posted: ReadModelWorkerMessage[] = [];
  let onMessage: ((msg: { type?: string }) => void) | undefined;
  runReadModelWorker(
    { on: (_event, run) => (onMessage = run), postMessage: (m) => void posted.push(m as ReadModelWorkerMessage), close: () => {} },
    { kind: "remudero-read-model", stateDir, instances: [{ name: "core", ledgerDir }], tickMs: 20, signal: new SharedArrayBuffer(8), slowLane: { intervalMs: 60_000 } },
  );
  t.after(() => onMessage?.({ type: "stop" }));
  const merged = (): AnalyticsViewData | undefined => {
    const last = posted.findLast((m) => m.type === "body" && m.entry.view === ANALYTICS_VIEW_NAME);
    return last?.type === "body" ? (last.entry.body.data as AnalyticsViewData) : undefined;
  };
  const deadline = Date.now() + 60_000;
  while (merged()?.coverage.counted !== 1 && Date.now() < deadline) await sleep(20);
  assert.deepEqual(merged()?.coverage, { counted: 1, of: 1, missing: [] }, JSON.stringify(posted.filter((m) => m.type === "log")));
  assert.equal(metric(merged()!, "runs.completed").value, 2);
  onMessage?.({ type: "stop" });
});

// Host reading 2026-10-06T18:34Z: every analytics sample diffed overview runs.completed 1751 vs 1752, tokens.total
// and cache.reuse, classified real. The overview merges EVERY instance, but the shadow paired it with the first
// instance's source only: core's as-of matched, console's differed (legacy 18:30:00.792Z, body 18:30:55.440Z), so
// console's own entry was timing while the overview it feeds stayed real on every sample.
const NO_EVIDENCE: ShadowEvidence = { legacyAsOfMs: null, viewAsOfMs: null, named: new Set(), namedBeforeHorizon: new Set(), namedInGap: new Set(), rowsInGap: 0, duplicateIds: new Set(), duplicateRows: 0 };

/** One analytics sample: legacy rendered over `legacy` as serve's sampler renders it, compared against a body merged over `view`. */
function compareAnalytics(legacy: Array<[string, AnalyticsSnapshot]>, view: Array<[string, AnalyticsSnapshot]>, tamper?: (data: AnalyticsViewData) => void) {
  const { clock } = handClock(T0);
  const posted: ShadowRequest[] = [];
  const definition = analyticsLegacyView({ clock, scopes: () => legacy.map(([instanceId, snapshot]) => ({ instanceId, analytics: () => snapshot })) });
  legacyViewSampler({ legacy: [definition], clock, defer: (run) => run(), post: (request) => void posted.push(request) })(ANALYTICS_VIEW_NAME, "", new URLSearchParams());
  assert.ok(posted[0]?.legacy, "legacy rendered the sample");
  const body = mergeAnalytics(view.map(([instanceId, snapshot]) => ({ instanceId, snapshot: { asOf: snapshot.asOf!, console: analyticsSourceBodies(snapshot)[0]!.body as AnalyticsConsoleSource } })), T0);
  tamper?.(body.data);
  const asOf = body.sources.map((s) => s.asOf!).sort()[0]!;
  const shadow = createViewShadow({ clock, log: () => {}, evidence: () => NO_EVIDENCE });
  return shadow.compare({ view: ANALYTICS_VIEW_NAME, key: "", requests: 0, legacy: posted[0].legacy, body: { data: body.data, asOf, sources: body.sources } });
}

test("an analytics overview diff from a later instance's refresh is timing when the body read that instance at another as-of", () => {
  const core = snapshotOf(CORE_LINES, T0 - 5 * MINUTE);
  const siteBefore = snapshotOf(SITE_LINES, T0 - 4 * MINUTE);
  // Site's next refresh counted one more run; the body merged it, legacy still merged the one before.
  const siteAfter = snapshotOf([...SITE_LINES, ...run("s2", T0 - 30 * MINUTE, 2_000, { input: 50, output: 1 })], T0 - 3 * MINUTE);
  const compared = compareAnalytics([["core", core], ["site", siteBefore]], [["core", core], ["site", siteAfter]]);
  const real = compared.diffs.filter((d) => d.classification === "real");
  assert.deepEqual(real, [], "a diff explained by the second instance's as-of is not real");
  const overview = compared.diffs.filter((d) => d.path.startsWith("overview"));
  assert.ok(overview.length > 0, "the overview differs: the comparison is not vacuous");
  for (const d of overview) assert.match(d.reason, new RegExp(`legacy read analytics:site as of ${iso(T0 - 4 * MINUTE)}, the body as of ${iso(T0 - 3 * MINUTE)}`), d.path);
});

test("an analytics overview diff over the same snapshots of every instance stays real", () => {
  const core = snapshotOf(CORE_LINES, T0 - 5 * MINUTE);
  const site = snapshotOf(SITE_LINES, T0 - 4 * MINUTE);
  const compared = compareAnalytics([["core", core], ["site", site]], [["core", core], ["site", site]], (data) => {
    const runs = data.overview.find((m) => m.key === "runs.completed")!;
    runs.value = Number(runs.value) + 1;
  });
  assert.deepEqual(compared.diffs.map((d) => [d.path, d.classification]), [["overview[key=runs.completed].value", "real"]]);
});

// Host reading 2026-10-06 20:25-21:07Z: all 42 analytics samples diffed overview cache.reuse, legacy
// `{ value: null, instances: 0, notCollectedReason: "an instance's snapshot carries no cache token terms; ..." }`
// vs the view's `{ value: 0.8349751415071711, instances: 3 }`. Legacy's core snapshot stayed as of 20:06:30.548Z
// across three serves (20:21, 20:36, 20:52Z): each booted onto core's checkpoint, and each core refresh timed out
// at 120 s. The terms are non-enumerable, so JSON left them out of the checkpoint's snapshot.
const noTimers = (): AnalyticsTimer => ({ unref: () => {}, cancel: () => {} });

/** Core's checkpoint as a refresh writes it, and the snapshot that refresh built. */
async function checkpointed(t: TestCtx, lines: ReadonlyArray<Record<string, unknown>>): Promise<{ stateDir: string; built: AnalyticsSnapshot }> {
  const stateDir = scratch(t, "analytics-checkpoint");
  writeFileSync(join(stateDir, "ledger.ndjson"), lines.map((line) => `${JSON.stringify(line)}\n`).join(""));
  const { snapshot, checkpoint } = await deriveAnalyticsSnapshotFromCheckpointedLedger(stateDir, handClock(T0 - MINUTE).clock);
  writeAnalyticsCheckpoint(stateDir, checkpoint);
  return { stateDir, built: snapshot };
}

test("a serve booted onto its analytics checkpoint merges cache reuse from the checkpoint's own token terms", async (t) => {
  const { stateDir, built } = await checkpointed(t, CORE_LINES);
  assert.equal((JSON.parse(readFileSync(join(stateDir, ".analytics-console-v1.checkpoint.json"), "utf8")) as { snapshot: AnalyticsSnapshot }).snapshot.cacheReuseTokens,
    undefined, "control: the checkpoint's own snapshot carries no terms");
  // Never started: a boot serves the checkpoint until its first refresh completes.
  const restored = createAnalyticsSnapshotCache({ stateDir, schedule: noTimers }).current();
  assert.equal(restored.asOf, built.asOf, "positive control: legacy serves the restored checkpoint, not a cold cache");
  assert.deepEqual(restored.cacheReuseTokens, built.cacheReuseTokens);
  const site = snapshotOf(SITE_LINES, T0 - MINUTE);
  const compared = compareAnalytics([["core", restored], ["site", site]], [["core", built], ["site", site]]);
  assert.deepEqual(compared.diffs, [], "legacy over the restored snapshot merges what the view merges over the refresh's rows");
});

test("a checkpoint carrying no token terms restores none, and its cache reuse diff stays real", async (t) => {
  const { stateDir, built } = await checkpointed(t, CORE_LINES);
  const path = join(stateDir, ".analytics-console-v1.checkpoint.json");
  const file = JSON.parse(readFileSync(path, "utf8")) as { state: Record<string, unknown>; snapshotHidden?: unknown };
  delete file.state.tokensTotal;
  delete file.snapshotHidden; // a checkpoint written before hidden fields round-tripped
  writeFileSync(path, JSON.stringify(file));
  const restored = createAnalyticsSnapshotCache({ stateDir, schedule: noTimers }).current();
  assert.equal(restored.asOf, built.asOf, "positive control: the checkpoint was restored");
  assert.equal(restored.cacheReuseTokens, undefined, "no terms are invented");
  const site = snapshotOf(SITE_LINES, T0 - MINUTE);
  const compared = compareAnalytics([["core", restored], ["site", site]], [["core", built], ["site", site]]);
  assert.deepEqual(compared.diffs.map((d) => [d.path, d.classification]), [
    ["overview[key=cache.reuse].instances", "real"], ["overview[key=cache.reuse].notCollectedReason", "real"], ["overview[key=cache.reuse].value", "real"],
  ]);
});
