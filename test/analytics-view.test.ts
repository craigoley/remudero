// W1-T5055 (arch Phase 4 P4-T16, design D10): the analytics refresh moves to the read model's slow lane, which
// commits each instance's output as `source_snapshot` rows, and the `analytics` view merges every instance's row
// in core. These tests drive the real ticker over real SQLite stores, the real refresh over a real ledger, and
// the real worker with its slow lane and view threads.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { gzipSync } from "node:zlib";
import {
  ANALYTICS_REFRESH_TIMEOUT_MS,
  createAnalyticsSnapshotCache,
  deriveAnalyticsSnapshot,
  deriveAnalyticsSnapshotFromCheckpointedLedger,
  scanAnalyticsLedger,
  writeAnalyticsCheckpoint,
  type AnalyticsSnapshot,
  type AnalyticsTimer,
  type CashSpendSnapshot,
} from "../src/lib/analytics-route.js";
import {
  ANALYTICS_SOURCE_CONSOLE_V1,
  ANALYTICS_SOURCE_SIGNALS,
  ANALYTICS_SOURCE_USAGE,
  ANALYTICS_DETAILS_MAX_BYTES,
  ANALYTICS_DETAILS_TOTAL_BYTES,
  ANALYTICS_SOURCE_NAMES,
  ANALYTICS_STALE_AFTER_MS,
  ANALYTICS_VIEW_NAME,
  analyticsLegacyView,
  analyticsConsoleSource,
  analyticsDetails,
  analyticsSourceBodies,
  createAnalyticsView,
  mergeAnalytics,
  type AnalyticsConsoleSource,
  type AnalyticsViewData,
} from "../src/lib/analytics-view.js";
import type { Clock } from "../src/lib/clock.js";
import { LEDGER_PROJECTOR_SCHEMA_VERSION } from "../src/lib/ledger-projector.js";
import { attachReadModel, currentReadModelPath, flushReadModelTransactions, sourceSnapshotStates, type SourceSnapshotWrite } from "../src/lib/read-model-db.js";
import { runSlowLaneWorker, type AnalyticsRefresh, type SlowLaneMessage } from "../src/lib/read-model-slow-lane.js";
import { createReadModelTicker, readModelSwitchesPath, runReadModelWorker, type ReadModelWorkerMessage } from "../src/lib/read-model-worker.js";
import { makeTempDir } from "../src/lib/tmp.js";
import { buildUsageProjection, accumulateUsageLine, usageTelemetryState } from "../src/lib/usage-telemetry.js";
import { createViewShadow, legacyViewSampler, type ShadowEvidence, type ShadowRequest } from "../src/lib/view-shadow.js";
import type { ViewSource } from "../src/lib/views.js";
import { switchViewsOn } from "./helpers/read-model-switches.js";
import { SPEC, violations } from "./helpers/openapi-strict.js";
import { fakeGitHub } from "./helpers/fake-github.js";
import { GARDENER_SPEND_SOURCE_NAME } from "#src/lib/analytics-view.js";
import { captureGardenerSpendSource, foldGardenerSpend } from "#src/lib/gardener-spend.js";
import { createReadModelWorker } from "#src/lib/read-model-worker.js";
import { createService } from "#src/lib/service.js";
import { buildReadModelViewRoutes } from "#src/lib/views.js";
import type { AddressInfo } from "node:net";

type TestCtx = { after: (fn: () => void | Promise<void>) => void };
const fixtureClosers = new WeakMap<TestCtx, Array<() => void | Promise<void>>>();

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
  t.after(async () => {
    for (const close of fixtureClosers.get(t) ?? []) await close();
    await flushReadModelTransactions();
    rmSync(dir, { recursive: true, force: true });
  });
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

function written(instance: string, snapshot: AnalyticsSnapshot, repository?: string): SourceSnapshotWrite {
  return { instance, ok: true, asOf: snapshot.asOf!, bodies: analyticsSourceBodies(snapshot, repository) };
}

function metric(data: AnalyticsViewData, key: string): { value: number | null; instances: number; notCollectedReason?: string } {
  const found = data.overview.find((m) => m.key === key);
  assert.ok(found, `the overview carries ${key}`);
  return found;
}

/** Two instances' stores, a ticker building only the analytics view over them, and its latest analytics body. */
function world(t: TestCtx, clock: Clock, opts: { stateDir?: string; holder?: string; names?: string[]; modelApprovalConfig?: { capturedAt: string; approvals: unknown } } = {}) {
  const stateDir = opts.stateDir ?? scratch(t, "analytics-view-state");
  const instances = (opts.names ?? ["core", "site"]).map((name) => ({ name, ledgerDir: join(stateDir, "ledgers", name) }));
  for (const { ledgerDir: dir } of instances) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "ledger.ndjson"), `${JSON.stringify({ ts: iso(T0 - MINUTE), step: "daemon.tick" })}\n`);
  }
  // W1-T5896 builds no view whose switch is absent; a test that set its own switch keeps it.
  if (!existsSync(readModelSwitchesPath(stateDir))) switchViewsOn(stateDir, [ANALYTICS_VIEW_NAME]);
  const posted: ReadModelWorkerMessage[] = [];
  const ticker = createReadModelTicker({
    stateDir, instances, views: [createAnalyticsView({ modelApprovalConfig: opts.modelApprovalConfig })],
    clock, holder: opts.holder ?? "holder-1", oracle: "off", post: (m) => void posted.push(m),
  });
  const closers = fixtureClosers.get(t) ?? [];
  closers.push(() => { ticker.release(); });
  fixtureClosers.set(t, closers);
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

test("cached model approvals use loaded host provenance independent of analytics source time", async () => {
  const { clock } = handClock(T0);
  const capturedAt = iso(T0 - 10 * MINUTE);
  const view = analyticsLegacyView({ scopes: () => [], clock, modelApprovalConfig: { capturedAt,
    approvals: [{ model: "gpt-6-astra", approvedBy: "fixture-operator", approvedAt: iso(T0 - 20 * MINUTE), expiresAt: iso(T0 + MINUTE) }] } });
  const result = view.compute(new URLSearchParams());
  assert.ok("data" in result);
  assert.deepEqual(result.data.modelApprovals, { version: "host-model-approvals-v1", scope: "serving-host", sourceKind: "loaded-config",
    capturedAt, state: "reported", approvals: [{ model: "gpt-6-astra", approvedBy: "fixture-operator",
      approvedAt: iso(T0 - 20 * MINUTE), expiresAt: iso(T0 + MINUTE) }] });
  assert.equal(result.data.coverage.counted, 0, "host permission records do not fabricate repository coverage");
  assert.equal(JSON.stringify(result.data.modelApprovals).includes("repository"), false);
});

test("cached model approvals whitelist and bound loaded host records without granting repository permission", async () => {
  const { clock } = handClock(T0);
  const record = { model: "gpt-6-astra", approvedBy: "fixture-operator", approvedAt: iso(T0 - MINUTE), secret: "private-sentinel" };
  const read = async (approvals: unknown) => {
    const result = analyticsLegacyView({ scopes: () => [], clock, modelApprovalConfig: { capturedAt: iso(T0), approvals } }).compute(new URLSearchParams());
    assert.ok("data" in result);
    return result.data.modelApprovals;
  };
  const valid = await read([record]);
  assert.equal(valid?.state, "reported");
  assert.equal(JSON.stringify(valid).includes("private-sentinel"), false);
  assert.deepEqual(violations(valid, SPEC.components.schemas.HostModelApprovalsEvidence), []);
  for (const approvals of [[{ model: "x" }], Array.from({ length: 101 }, (_, i) => ({ ...record, model: `model-${i}` })), [record, record],
    [{ ...record, approvedAt: iso(T0 + MINUTE) }], [{ ...record, expiresAt: "invalid" }], [{ ...record, approvedBy: " " }],
    [{ ...record, model: "x".repeat(161) }], null]) {
    const invalid = await read(approvals);
    assert.equal(invalid?.state, "unavailable");
    assert.equal(invalid && "approvals" in invalid, false, "a rejected corpus is not a measured empty list");
    assert.deepEqual(violations(invalid, SPEC.components.schemas.HostModelApprovalsEvidence), []);
  }
  const oversized = Array.from({ length: 100 }, (_, i) => ({ ...record, model: `m${i}${"x".repeat(150)}`, approvedBy: "界".repeat(160) }));
  assert.equal((await read(oversized))?.state, "unavailable");
  const throwing = Object.defineProperty({}, "model", { get() { throw Error("private-sentinel"); } });
  assert.equal((await read([throwing]))?.state, "unavailable");
});

test("cached model approvals retain unknown invalid and expired semantics", async () => {
  const { clock } = handClock(T0);
  const read = async (input?: { capturedAt: string; approvals: unknown }) => {
    const result = analyticsLegacyView({ scopes: () => [], clock, modelApprovalConfig: input }).compute(new URLSearchParams());
    assert.ok("data" in result);
    return result.data.modelApprovals;
  };
  assert.equal(await read(), undefined, "a caller with no configured source never invents an empty corpus");
  const empty = await read({ capturedAt: iso(T0), approvals: [] });
  assert.deepEqual(empty, { version: "host-model-approvals-v1", scope: "serving-host", sourceKind: "loaded-config",
    capturedAt: iso(T0), state: "reported", approvals: [] });
  for (const capturedAt of ["invalid", iso(T0 + MINUTE)]) assert.equal((await read({ capturedAt, approvals: [] }))?.state, "unavailable");
  const expired = await read({ capturedAt: iso(T0 - MINUTE), approvals: [{ model: "claude-fable-5-1", approvedBy: "fixture-operator",
    approvedAt: iso(T0 - 10 * MINUTE), expiresAt: iso(T0) }] });
  assert.equal(expired?.state, "reported");
  if (expired?.state === "reported") assert.equal(expired.approvals[0].expiresAt, iso(T0), "expiry is retained for a separate read-time evaluation, not recaptured as fresh config");
  const invalidClock = analyticsLegacyView({ scopes: () => [], clock: { ...clock, now: () => NaN }, modelApprovalConfig: { capturedAt: iso(T0), approvals: [] } }).compute(new URLSearchParams());
  assert.ok("data" in invalidClock);
  assert.equal(invalidClock.data.modelApprovals?.state, "unavailable");
});

test("cached model approvals reach the real worker view and survive a warm restart without request fanout", (t) => {
  const { clock } = handClock(T0);
  const modelApprovalConfig = { capturedAt: iso(T0 - MINUTE), approvals: [] };
  const first = world(t, clock, { names: ["core"], modelApprovalConfig });
  t.after(() => first.ticker.release());
  assert.equal(first.ticker.acceptSnapshot(written("core", snapshotOf(CORE_LINES, T0 - 2 * MINUTE))), true);
  first.ticker.tick();
  assert.equal(metric(first.body().data, "runs.completed").value, 2);
  assert.deepEqual(first.body().data.modelApprovals, { version: "host-model-approvals-v1", scope: "serving-host", sourceKind: "loaded-config",
    capturedAt: modelApprovalConfig.capturedAt, state: "reported", approvals: [] });
  first.ticker.release();
  const resumed = world(t, clock, { names: ["core"], stateDir: first.stateDir, holder: "resumed", modelApprovalConfig });
  t.after(() => resumed.ticker.release());
  assert.deepEqual(resumed.body().data.modelApprovals, first.body().data.modelApprovals);
});

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

test("cached analytics details retain three repositories and their measured cash through a warm restart", (t) => {
  const { clock } = handClock(T0);
  const names = ["core", "site", "console"];
  const repos = ["craigoley/remudero", "craigoley/remudero-site", "craigoley/remudero-console"];
  const first = world(t, clock, { names });
  const amounts = [1.25, 2.5, 5];
  names.forEach((name, i) => {
    const snapshot = snapshotOf([
      ...CORE_LINES,
      { ts: iso(T0 - MINUTE), step: "implement.done", provider: "cash", model: "cash-test", cost_usd: amounts[i], repo: "untrusted/ledger-label" },
      { ts: iso(T0 - MINUTE), step: "fix.done", provider: "cash", model: "cash-test" },
    ], T0);
    assert.equal(snapshot.spend.cash.windows.find((window) => window.name === "7d")?.usd, amounts[i], "positive control: each real producer corpus has different measured cash");
    first.ticker.acceptSnapshot(written(name, snapshot, repos[i]));
  });
  first.ticker.tick();
  const before = first.body();
  assert.deepEqual(before.data.instances.map((entry) => entry.repository), repos);
  assert.deepEqual(before.data.instances.map((entry) => {
    assert.ok(entry.details?.state === "reported");
    assert.equal(entry.details.version, "analytics-details-v1");
    assert.equal(entry.details.asOf, iso(T0));
    assert.equal(entry.details.usage?.version, "usage-v2");
    assert.ok(entry.details.signals.timeSeries.length > 0);
    const cash = entry.details.signals.spend.cash as CashSpendSnapshot;
    return cash.windows.find((window) => window.name === "7d")?.usd;
  }), amounts);
  const firstDetails = before.data.instances[0]!.details;
  assert.ok(firstDetails?.state === "reported");
  assert.equal((firstDetails.signals.spend.cash as CashSpendSnapshot).windows[0]!.unpricedRows, 1);
  first.ticker.release();
  const after = world(t, clock, { names, stateDir: first.stateDir, holder: "details-restart" });
  t.after(() => after.ticker.release());
  assert.deepEqual(after.body().data, before.data, "no refresh/provider/ledger scan is needed to recover stored detail projections");
});

test("cached analytics details refuse mixed snapshot times and corrupt stored JSON without erasing metrics", (t) => {
  const { clock } = handClock(T0);
  const w = world(t, clock);
  t.after(() => w.ticker.release());
  const snapshot = snapshotOf(CORE_LINES, T0);
  w.ticker.acceptSnapshot(written("core", snapshot, "craigoley/remudero"));
  const db = attachReadModel(currentReadModelPath(w.stateDir, "core", LEDGER_PROJECTOR_SCHEMA_VERSION), LEDGER_PROJECTOR_SCHEMA_VERSION);
  t.after(() => db.close());
  // This is fixture-only corruption in a real persisted row, not an injected read fake.
  db.prepare("UPDATE source_snapshot SET body = '{' WHERE instance = ? AND name = ?").run("core", ANALYTICS_SOURCE_SIGNALS);
  w.ticker.tick();
  assert.deepEqual(w.body().data.instances[0]!.details, { version: "analytics-details-v1", state: "unavailable", asOf: snapshot.asOf, reason: "stored analytics details could not be read" });
  assert.equal(metric(w.body().data, "runs.completed").value, 2);
  const next = snapshotOf(CORE_LINES, T0 + MINUTE);
  w.ticker.acceptSnapshot(written("core", next, "craigoley/remudero"));
  w.ticker.tick();
  assert.equal(w.body().data.instances[0]!.details?.state, "reported");
  // Only usage moves: do not join new usage onto the old cash/metrics snapshot.
  w.ticker.acceptSnapshot({ instance: "core", ok: true, asOf: iso(T0 + 2 * MINUTE), bodies: [analyticsSourceBodies(snapshotOf(CORE_LINES, T0 + 2 * MINUTE))[2]!] });
  w.ticker.tick();
  const mixed = w.body().data.instances[0]!.details;
  assert.ok(mixed?.state === "unavailable");
  assert.match(mixed.reason, /another snapshot/);
  assert.equal(metric(w.body().data, "runs.completed").value, 2);
});

test("cached analytics details preserve the last values and mark a usage-only refresh failure stale", (t) => {
  const { clock } = handClock(T0);
  const w = world(t, clock);
  t.after(() => w.ticker.release());
  w.ticker.acceptSnapshot(written("core", snapshotOf(CORE_LINES, T0), "craigoley/remudero"));
  w.ticker.tick();
  const kept = w.body().data.instances[0];
  w.ticker.acceptSnapshot({ instance: "core", ok: false, names: [ANALYTICS_SOURCE_USAGE], error: "usage refresh failed", atMs: T0 + MINUTE });
  w.ticker.tick();
  assert.deepEqual(w.body().data.instances[0], kept);
  assert.deepEqual([w.reading("analytics:core")?.state, w.reading("analytics:core")?.phase], ["stale", "failed"]);
});

test("cached analytics details keep unknown repository identity and absent usage explicit and strip private snapshot fields", () => {
  const snapshot = snapshotOf(CORE_LINES, T0);
  const bodies = analyticsSourceBodies(snapshot, "not/a/slug");
  assert.equal((bodies[0]!.body as AnalyticsConsoleSource).repository, undefined);
  const details = analyticsDetails(snapshot.asOf!, { ...(bodies[1]!.body as object), operatorAgentMemory: { secret: "PRIVATE-SENTINEL" } }, { ...snapshot.usage!, privateLedger: "PRIVATE-SENTINEL" });
  assert.equal(details.state, "reported");
  assert.equal(JSON.stringify(details).includes("PRIVATE-SENTINEL"), false);
  assert.equal(analyticsDetails(snapshot.asOf!, bodies[1]!.body, null).state, "reported", "null usage means not collected, not a fabricated empty projection");
  assert.equal(analyticsDetails(snapshot.asOf!, null, snapshot.usage).state, "unavailable");
  assert.equal(analyticsDetails(snapshot.asOf!, bodies[1]!.body, { ...snapshot.usage, version: "usage-v999" }).state, "unavailable");
});

test("cached analytics details bound a twelve-repository response without silently dropping metrics or claiming complete details", () => {
  const snapshot = snapshotOf(CORE_LINES, T0);
  const bodies = analyticsSourceBodies(snapshot);
  const oversized = { ...(bodies[1]!.body as object), timeSeries: [{ ...snapshot.timeSeries[0]!, comment: "x".repeat(ANALYTICS_DETAILS_MAX_BYTES) }] };
  const refused = analyticsDetails(snapshot.asOf!, oversized, snapshot.usage);
  assert.equal(refused.state, "unavailable");
  const large = analyticsDetails(snapshot.asOf!, { ...(bodies[1]!.body as object), timeSeries: [{ ...snapshot.timeSeries[0]!, comment: "x".repeat(160 * 1024) }] }, snapshot.usage);
  assert.ok(large.state === "reported");
  const inputs = Array.from({ length: 12 }, (_, i) => ({ instanceId: `repo-${i}`, snapshot: { asOf: snapshot.asOf!, console: analyticsConsoleSource(snapshot, `org/repo-${i}`), details: large } }));
  const merged = mergeAnalytics(inputs, T0);
  assert.equal(merged.data.coverage.counted, 12);
  assert.equal(merged.data.instances.length, 12);
  assert.ok(merged.data.instances.some((entry) => entry.details?.state === "unavailable"));
  const bytes = merged.data.instances.reduce((total, entry) => total + (entry.details?.state === "reported" ? entry.details.payloadBytes : 0), 0);
  assert.ok(bytes > 0 && bytes <= ANALYTICS_DETAILS_TOTAL_BYTES);
  assert.ok(Buffer.byteLength(JSON.stringify(merged)) < 2 * 1024 * 1024);
});

test("cached analytics details declare populated spend, subscription and routing projections without permitting private fields", () => {
  const ts = iso(T0 - MINUTE);
  const assignment = { ts, step: "worker.assignment", run_id: "R-core-a", task_id: "W1-T1", lane: "run-task", worker_assignment: {
    version: 1, id: "cached-assignment", phase: "pre-execution",
    requested: { model: "sonnet", effort: "high", maxTurns: 400 },
    selected: { provider: "cash", model: "cached-test", effort: "high" },
    routing: { mode: "cash", selectionPath: "auction", policy: { preference: "automatic", reservePercent: 5, provenance: "default" }, decision: {
      rule: "headroom-auction", capability: "balanced", headroomPercent: { claude: 80 },
      trial: "cached-test", trialArm: "cash", trialReason: "bounded schema fixture",
      considered: [{ provider: "claude", model: "sonnet", eligible: true, selected: false, reason: "not selected" }],
    } },
    candidates: [{ provider: "claude", readable: true, windows: [{ name: "session (5h)", usedPercent: 20, resetsAt: iso(T0 + 3_600_000) }] }],
  } };
  const rows = [...CORE_LINES, assignment,
    { ts, step: "implement.done", provider: "cash", run_id: "R-core-a", model: "cached-test", total_cost_usd: 1.5 },
    { ts, step: "verdict", run_id: "R-core-a", success: true, selection_assignment_id: "cached-assignment", verdict: "merged", total_cost_usd: 1.5 },
    { ts, step: "implement.step_up", model: "cached-test" },
  ];
  const snapshot = snapshotOf(rows, T0);
  const bodies = analyticsSourceBodies(snapshot, "craigoley/remudero");
  // Positive controls: nonempty nested arrays validate real elements, not just their empty wrappers.
  assert.ok(snapshot.usage!.subscriptions.some((entry) => entry.windows.length > 0));
  assert.ok(snapshot.usage!.routing.recent.length > 0 && snapshot.usage!.routing.experiments.length > 0);
  assert.ok(snapshot.usage!.cash.byModel24h.length > 0 && snapshot.routingTelemetry.buckets.length > 0);
  const schema = SPEC.components.schemas.AnalyticsStoredDetails!;
  for (const usage of [snapshot.usage, null]) {
    const details = analyticsDetails(snapshot.asOf!, bodies[1]!.body, usage);
    assert.deepEqual(violations(details, schema), []);
    assert.ok(details.state === "reported");
    assert.ok(violations({ ...details, signals: { ...details.signals, privateLedger: "PRIVATE" } }, schema).length > 0);
    assert.ok(violations({ ...details, signals: { ...details.signals, spend: { cash: { ...snapshot.spend.cash, privateLedger: "PRIVATE" } } } }, schema).length > 0);
  }
  const state = usageTelemetryState();
  for (const row of rows) accumulateUsageLine(state, row);
  assert.deepEqual(violations(analyticsDetails(snapshot.asOf!, bodies[1]!.body, buildUsageProjection(state, snapshot.asOf!, undefined, "usage-v1")), schema), []);
  const refused = analyticsDetails(snapshot.asOf!, null, null);
  assert.deepEqual(violations(refused, schema), []);
  assert.ok(violations({ ...refused, state: "reported" }, schema).length > 0, "reported without projections cannot validate");
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
function lane(config: Parameters<typeof runSlowLaneWorker>[1], refresh?: AnalyticsRefresh, clock?: Clock,
  inbox?: NonNullable<Parameters<typeof runSlowLaneWorker>[2]>["inbox"]) {
  let onMessage: ((msg: { type?: string; held?: unknown; modes?: unknown; instances?: unknown }) => void) | undefined;
  const posted: SlowLaneMessage[] = [];
  let next: (() => void) | undefined;
  const handle = runSlowLaneWorker({ on: (_event, run) => (onMessage = run), postMessage: (m) => void posted.push(m as SlowLaneMessage) }, config, {
    ...(clock ? { clock } : {}),
    ...(refresh ? { analyticsRefresh: refresh } : {}),
    ...(inbox ? { inbox } : {}),
    schedule: (run) => {
      next = run;
      return () => void (next = undefined);
    },
  });
  const allSnapshots = (): SourceSnapshotWrite[] => posted.flatMap((m) => (m.type === "source_snapshot" ? [m.snapshot] : []));
  const snapshots = () => allSnapshots().filter(s => s.ok ? s.bodies.some(b => b.name === ANALYTICS_SOURCE_CONSOLE_V1) : s.names.includes(ANALYTICS_SOURCE_CONSOLE_V1));
  const passes = (): number => posted.filter((m) => m.type === "unit" && m.unit === "analytics").length;
  const legs = (): number => posted.filter(m => m.type === "end" && m.work.unit === "analytics" && m.work.instance !== undefined).length;
  return {
    handle, posted, snapshots, allSnapshots,
    switchOn: (mode = "shadow") => onMessage?.({ type: "views", modes: { [ANALYTICS_VIEW_NAME]: mode } }),
    lease: (held = true, instances = config.analytics?.instances.map(i => i.name) ?? []) => onMessage?.({ type: "lease", held, instances }),
    fire: () => next?.(),
    settle: async (want: { passes: number; snapshots?: number; legs?: number }): Promise<void> => {
      const deadline = Date.now() + 10_000;
      while ((passes() < want.passes || snapshots().length < (want.snapshots ?? 0) || legs() < (want.legs ?? 0)) && Date.now() < deadline) await sleep(5);
      assert.equal(passes(), want.passes);
      if (want.snapshots !== undefined) assert.equal(snapshots().length, want.snapshots);
      if (want.legs !== undefined) assert.equal(legs(), want.legs);
    },
  };
}

/** Real rotations with a replayed row and live tail; no provider or production ledger. */
function boundedCorpus(t: TestCtx, kind: string) {
  const stateDir = scratch(t, kind);
  const row = (verb: string) => JSON.stringify({ ts: iso(T0 - MINUTE), step: "cli.invoked", verb });
  const names = ["ledger.2026-10-05T11-01-00-000Z.ndjson.gz", "ledger.2026-10-05T11-02-00-000Z.ndjson", "ledger.2026-10-05T11-03-00-000Z.ndjson.gz"];
  writeFileSync(join(stateDir, names[0]!), gzipSync(row(`${kind}-alpha`) + "\n"));
  writeFileSync(join(stateDir, names[1]!), row(`${kind}-alpha`) + "\n" + row(`${kind}-bravo`) + "\n");
  writeFileSync(join(stateDir, names[2]!), gzipSync(row(`${kind}-charlie`) + "\n"));
  writeFileSync(join(stateDir, "ledger.ndjson"), row(`${kind}-delta`) + "\n");
  return { stateDir, names, row };
}

/** Charge actual scanner clock reads, not wall-clock sleeps or a fake partial result. */
function boundedClock() {
  let at = T0;
  return { clock: { now: () => (at += 35_000), date: () => new Date(at), iso: () => iso(at) },
    advance: () => { at += 2 * MINUTE; } };
}

test("W1-T9523: slow-lane bounded legs resume to the same complete analytics fold", async t => {
  for (const mode of ["cold", "rewritten", "live-replaced", "live-missing", "checkpoint-corrupt"] as const) {
    const f = boundedCorpus(t, mode);
    if (mode !== "cold") {
      const first = await deriveAnalyticsSnapshotFromCheckpointedLedger(f.stateDir, handClock(T0 - MINUTE).clock);
      if (mode === "checkpoint-corrupt") (first.checkpoint.state as { startsByRun: unknown }).startsByRun = 7;
      writeAnalyticsCheckpoint(f.stateDir, first.checkpoint);
      if (mode === "rewritten") writeFileSync(join(f.stateDir, f.names[0]!), gzipSync(f.row("rewritten-extra") + "\n"));
      if (mode === "live-replaced") writeFileSync(join(f.stateDir, "ledger.ndjson"), f.row("replaced") + "\n");
      if (mode === "live-missing") rmSync(join(f.stateDir, "ledger.ndjson"));
    }
    const { clock, advance } = boundedClock();
    const l = lane({ analytics: { instances: [{ name: "core", stateDir: f.stateDir }], intervalMs: MINUTE } }, undefined, clock);
    t.after(() => l.handle.stop());
    l.switchOn(); l.lease();
    await l.settle({ passes: 1, legs: 1 });
    assert.equal(l.snapshots().length, 0, "the default scanner must yield before publishing the partial corpus");
    if (mode === "cold") {
      writeFileSync(join(f.stateDir, "ledger.2026-10-05T11-04-00-000Z.ndjson"), f.row("new-rotation") + "\n");
      writeFileSync(join(f.stateDir, "ledger.ndjson"), f.row("changed-live") + "\n");
    }
    for (let i = 2; i <= 6 && !l.snapshots().some(s => s.ok); i++) {
      advance(); l.fire(); await l.settle({ passes: i, legs: i });
      if (mode === "live-missing" && i === 2) {
        assert.equal(l.snapshots().length, 0, "missing live evidence retains the prior successful source clock");
        assert.ok(l.posted.some(m => m.type === "log" && m.extra.progress_refused === "live-missing"));
        writeFileSync(join(f.stateDir, "ledger.ndjson"), f.row(`${mode}-delta`) + "\n");
      }
    }
    const writes = l.snapshots();
    assert.equal(writes.length, 1, `${mode}: partial legs are progress, never success or fresh-empty snapshots: ${JSON.stringify(l.posted.filter(m => m.type === "log"))}`);
    assert.ok(writes[0]?.ok);
    const complete = await deriveAnalyticsSnapshotFromCheckpointedLedger(f.stateDir, handClock(Date.parse(writes[0].asOf)).clock);
    assert.deepEqual(writes[0].bodies, analyticsSourceBodies(complete.snapshot));
    assert.equal(complete.snapshot.invocationsByVerb[`${mode}-alpha`], 1, "replayed rows are not double-counted");
    if (mode === "cold") assert.equal(complete.snapshot.invocationsByVerb["new-rotation"], 1);
    const progress = l.posted.filter(m => m.type === "log" && m.step === "analytics.source_snapshot_progress");
    assert.ok(progress.length > 0);
    assert.ok(progress.some(m => m.type === "log" && m.extra.scan_mode === "continue"));
    if (mode === "rewritten") assert.ok(progress.some(m => m.type === "log" && m.extra.scan_reason === "archive-rewritten"));
  }
});

test("W1-T9523: slow-lane progress preserves unavailable evidence and repository isolation", async t => {
  for (const bad of ["gzip", "malformed", "missing"] as const) {
    const f = boundedCorpus(t, bad);
    if (bad === "gzip") writeFileSync(join(f.stateDir, f.names[0]!), "not gzip");
    if (bad === "malformed") writeFileSync(join(f.stateDir, f.names[1]!), "{broken\n");
    if (bad === "missing") { for (const file of [...f.names, "ledger.ndjson"]) rmSync(join(f.stateDir, file)); }
    const { clock, advance } = boundedClock();
    const l = lane({ analytics: { instances: [{ name: "core", stateDir: f.stateDir }], intervalMs: MINUTE } }, undefined, clock);
    t.after(() => l.handle.stop()); l.switchOn(); l.lease();
    for (let i = 1; i <= 6 && !l.snapshots().length; i++) {
      if (i > 1) { advance(); l.fire(); } await l.settle({ passes: i, legs: i });
    }
    assert.equal(l.snapshots().length, 1);
    assert.equal(l.snapshots()[0]?.ok, false, `${bad} source evidence cannot become a completed snapshot`);
  }
  const corrupt = boundedCorpus(t, "corrupt-progress");
  const timing = boundedClock();
  let corrupted = false;
  const realWithCorruptProgress: AnalyticsRefresh = async (dir, clock, signal, prior, options) => {
    if (options?.progress && !corrupted) {
      (options.progress.state as { startsByRun: unknown }).startsByRun = 7;
      corrupted = true;
    }
    return scanAnalyticsLedger(dir, clock, signal, prior, options);
  };
  const c = lane({ analytics: { instances: [{ name: "core", stateDir: corrupt.stateDir }], intervalMs: MINUTE } }, realWithCorruptProgress, timing.clock);
  t.after(() => c.handle.stop()); c.switchOn(); c.lease();
  for (let i = 1; i <= 8 && !c.snapshots().some(s => s.ok); i++) {
    if (i > 1) { timing.advance(); c.fire(); } await c.settle({ passes: i, legs: i });
  }
  assert.ok(corrupted, "the real default-produced progress reached the real scanner");
  const recovered = c.snapshots()[0]; assert.ok(recovered?.ok);
  const recoveredExpected = await deriveAnalyticsSnapshotFromCheckpointedLedger(corrupt.stateDir, handClock(Date.parse(recovered.asOf)).clock);
  assert.deepEqual(recovered.bodies, analyticsSourceBodies(recoveredExpected.snapshot), "corrupt progress restarts rather than blending a corrupt fold");
  const a = boundedCorpus(t, "isolation-core"), b = boundedCorpus(t, "isolation-site");
  const { clock, advance } = boundedClock();
  const l = lane({ analytics: { instances: [{ name: "core", stateDir: a.stateDir, repository: "owner/core" },
    { name: "site", stateDir: b.stateDir, repository: "owner/site" }], intervalMs: MINUTE } }, undefined, clock);
  t.after(() => l.handle.stop()); l.switchOn(); l.lease();
  for (let i = 1; i <= 6 && !["core", "site"].every(name => l.snapshots().some(s => s.ok && s.instance === name)); i++) {
    if (i > 1) { advance(); l.fire(); } await l.settle({ passes: i, legs: 2 * i });
  }
  for (const [name, f] of [["core", a], ["site", b]] as const) {
    const last = l.snapshots().findLast(s => s.ok && s.instance === name); assert.ok(last?.ok);
    const expected = await deriveAnalyticsSnapshotFromCheckpointedLedger(f.stateDir, handClock(Date.parse(last.asOf)).clock);
    assert.deepEqual(last.bodies, analyticsSourceBodies(expected.snapshot, `owner/${name}`));
  }
});

test("W1-T9523: partial analytics does not starve Inbox or publish after ownership loss", async t => {
  const core = boundedCorpus(t, "fair-core"), site = scratch(t, "fair-site"), inboxRoot = scratch(t, "fair-inbox");
  writeFileSync(join(site, "ledger.ndjson"), JSON.stringify({ ts: iso(T0), step: "cli.invoked", verb: "site-only" }) + "\n");
  mkdirSync(join(inboxRoot, "plan")); mkdirSync(join(inboxRoot, "state"));
  const planPath = join(inboxRoot, "plan/tasks.yaml"), ledgerPath = join(inboxRoot, "state/ledger.ndjson");
  writeFileSync(planPath, "[]\n"); writeFileSync(ledgerPath, "");
  writeFileSync(join(inboxRoot, "state/inbox-proposals.json"), JSON.stringify({ proposals: [] }));
  const { clock } = boundedClock();
  const l = lane({ inbox: { root: inboxRoot, inboxRoot, planPath, ledgerPath, repository: "owner/core" },
    analytics: { instances: [{ name: "core", stateDir: core.stateDir }, { name: "site", stateDir: site }], intervalMs: MINUTE } }, undefined, clock,
  { statusGithub: fakeGitHub(), github: { prView: () => null }, ratify: { approve() {}, reframe() {} }, inboxMainSha: () => "a".repeat(40) });
  t.after(() => l.handle.stop()); l.switchOn(); l.lease(); await l.settle({ passes: 1, legs: 2 });
  assert.ok(l.posted.some(m => m.type === "unit" && m.unit === "inbox" && m.ok));
  assert.ok(l.snapshots().some(s => s.ok && s.instance === "site"));
  assert.equal(l.snapshots().some(s => s.ok && s.instance === "core"), false);
  for (const loss of ["lease", "switch", "stop"] as const) {
    let finish!: () => void;
    const blocked = new Promise<void>(resolve => { finish = resolve; });
    const refresh: AnalyticsRefresh = async (dir, time, signal, prior, options) => {
      const result = await scanAnalyticsLedger(dir, time, signal, prior, options); await blocked;
      if (loss === "switch") throw new Error("late read failure");
      return result;
    };
    const q = lane({ analytics: { instances: [{ name: "site", stateDir: site }, { name: "next", stateDir: site }] } }, refresh, handClock(T0).clock);
    t.after(() => q.handle.stop()); q.switchOn(); q.lease(); await q.settle({ passes: 1 });
    if (loss === "lease") { q.lease(false); q.lease(true); }
    else if (loss === "switch") { q.switchOn("off"); q.switchOn(); }
    else q.handle.stop();
    finish(); await q.settle({ passes: loss === "lease" ? 2 : 1, legs: 1 });
    assert.equal(q.snapshots().length, 0, `a ${loss} transition fences the older in-flight result`);
  }
});

test("W1-T9523: bounded analytics retains timeout and completed-source semantics", async t => {
  assert.equal(ANALYTICS_REFRESH_TIMEOUT_MS, 120_000);
  const dir = scratch(t, "bounded-timeout");
  const refresh: AnalyticsRefresh = async (_dir, _clock, signal) => new Promise((_resolve, reject) => {
    signal!.addEventListener("abort", () => reject(signal!.reason), { once: true });
  });
  const l = lane({ analytics: { instances: [{ name: "core", stateDir: dir }], timeoutMs: 20 } }, refresh, handClock(T0).clock);
  t.after(() => l.handle.stop()); l.switchOn(); l.lease(); await l.settle({ passes: 1, legs: 1, snapshots: 1 });
  const failed = l.snapshots()[0];
  assert.ok(failed && !failed.ok);
  assert.match(failed.error, /analytics refresh exceeded 20 ms/);
  assert.equal(l.posted.some(m => m.type === "log" && m.step === "analytics.source_snapshot_built"), false);
  const f = boundedCorpus(t, "late-result"), actual = await deriveAnalyticsSnapshotFromCheckpointedLedger(f.stateDir, handClock(T0).clock);
  let finish!: () => void, aborted!: () => void;
  const finished = new Promise<void>(resolve => { finish = resolve; }), abortSeen = new Promise<void>(resolve => { aborted = resolve; });
  const delayed: AnalyticsRefresh = async (_dir, _clock, signal) => {
    signal!.addEventListener("abort", aborted, { once: true }); await finished; return actual;
  };
  const q = lane({ analytics: { instances: [{ name: "core", stateDir: f.stateDir }], timeoutMs: 20 } }, delayed, handClock(T0).clock);
  t.after(() => q.handle.stop()); q.switchOn(); q.lease(); await q.settle({ passes: 1 });
  await abortSeen; finish(); await q.settle({ passes: 1, legs: 1, snapshots: 1 });
  assert.equal(q.snapshots()[0]?.ok, false, "a result that resolves after abort cannot advance the successful source clock");
  assert.equal(q.posted.some(m => m.type === "log" && m.step === "analytics.source_snapshot_built"), false);
});

/** Current-generation files, including exact replay in gzip, plain and live forms. */
function recentGarden(dir: string, repository = "fixture/recent") {
  const runtime = { version: 1, repository, daemonRunId: "recent-generation", codeSha: null,
    configuredAt: iso(T0), observedAt: iso(T0), gardens: [{ name: "config", enabled: true, scope: "repository",
      cadenceMs: 1000, phase: "completed", observedAt: iso(T0), passId: null, nextDueAt: null,
      queueMs: null, executionMs: null, exit: 0, reason: null, attempts: 1, completions: 1, failures: 0,
      lastCompletedAt: iso(T0), lastSuccessAt: iso(T0), lastFailureAt: null }] };
  const passId = "12345678-1234-4123-8123-123456789abc";
  const rows = [{ ts: iso(T0), step: "garden.lifecycle", name: "config", passId, repository,
    daemon_run_id: runtime.daemonRunId, phase: "completed", exit: 0 },
  { ts: iso(T0), step: "machine_judge.attempt_spend", run_id: "recent-child", task_id: "fixture-task",
    billing_mode: "api", total_cost_usd: 2, gardener_origin: { state: "linked", version: 1, name: "config", passId } }];
  const text = rows.map(row => JSON.stringify(row)).join("\n") + "\n";
  writeFileSync(join(dir, "gardener-runtime.json"), JSON.stringify(runtime));
  writeFileSync(join(dir, "ledger.2026-10-05T12-00-00-000Z.ndjson.gz"), gzipSync(text));
  writeFileSync(join(dir, "ledger.2026-10-05T12-00-01-000Z.ndjson"), text);
  writeFileSync(join(dir, "ledger.ndjson"), text);
  return { runtime, rows, text };
}

test("W1-T10461: recent gardener telemetry refreshes while historical analytics remains incomplete", async t => {
  const { clock } = handClock(T0 + MINUTE);
  const stateDir = scratch(t, "independent-worker-history");
  const ledgerDir = join(stateDir, "core");
  mkdirSync(ledgerDir); recentGarden(ledgerDir);
  switchViewsOn(stateDir, [ANALYTICS_VIEW_NAME]);
  const oldAsOf = iso(T0 - MINUTE);
  const damaged = join(ledgerDir, "ledger.2026-10-04T00-00-00-000Z.ndjson.gz");
  const damagedBytes = gzipSync('{"invalid historical row"\n');
  writeFileSync(damaged, damagedBytes);
  // Seed against the SAME ledger identity as the real worker. Replacing a shorter live file
  // after projection legitimately resets its store, which is not this source-isolation scenario.
  const initial = createReadModelTicker({ stateDir, instances: [{ name: "core", ledgerDir }], views: [createAnalyticsView()],
    clock, holder: "independent-fixture-seed", oracle: "off", post() {} });
  try {
    initial.start(); initial.tick();
    initial.acceptSnapshot(written("core", snapshotOf(CORE_LINES, T0 - MINUTE), "fixture/recent")); initial.tick();
  } finally { initial.release(); }
  const posted: ReadModelWorkerMessage[] = [];
  let onMessage: ((msg: { type?: string }) => void) | undefined;
  const signal = new SharedArrayBuffer(8);
  const stopped = new Int32Array(signal);
  runReadModelWorker({ on: (_event, run) => onMessage = run, postMessage: m => posted.push(m as ReadModelWorkerMessage), close() {} },
    { kind: "remudero-read-model", stateDir, instances: [{ name: "core", ledgerDir, repo: "fixture/recent" }],
      tickMs: 20, signal, slowLane: { intervalMs: 60000 } });
  const stop = async () => {
    onMessage?.({ type: "stop" });
    const deadline = Date.now() + 5000;
    while (!Atomics.load(stopped, 1) && Date.now() < deadline) await sleep(10);
    assert.equal(Atomics.load(stopped, 1), 1, "owned worker drains before fixture cleanup");
  };
  fixtureClosers.set(t, [stop]);
  const latest = () => posted.findLast(m => m.type === "body" && m.entry.view === ANALYTICS_VIEW_NAME);
  const ready = () => {
    const m = latest();
    return m?.type === "body" && (m.entry.body.data as AnalyticsViewData).instances[0]?.gardenerSpend?.totalUsd === 2 &&
      m.entry.body.sources.some(s => s.name === "analytics:core" && s.phase === "failed");
  };
  const deadline = Date.now() + 30000;
  while (!ready() && Date.now() < deadline) await sleep(20);
  assert.ok(ready(), JSON.stringify(posted.filter(m => m.type === "log")));
  const m = latest(); assert.ok(m?.type === "body");
  assert.equal(m.entry.body.sources.find(s => s.name === "analytics:core")?.asOf, oldAsOf);
  assert.equal(m.entry.body.sources.find(s => s.name === "gardener-spend:core")?.state, "fresh");
  assert.equal(m.entry.body.stale, true, "recent money never repairs the whole historical envelope");
  assert.deepEqual(readFileSync(damaged), damagedBytes, "historical evidence is byte-for-byte retained");
  assert.deepEqual(violations(m.entry.body, SPEC.components.schemas.AnalyticsView!), []);
  await stop();
  // A new cache answers the persisted projection with no collector or ledger access on requests.
  rmSync(ledgerDir, { recursive: true });
  const restarted = createReadModelWorker({ stateDir, instances: [{ name: "core", ledgerDir, repo: "fixture/recent" }] });
  const server = createService({ tokens: { read: "r", write: "w" }, routes: buildReadModelViewRoutes({ legacy: [],
    readModelViews: [ANALYTICS_VIEW_NAME], readModel: restarted }) });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    for (let i = 0; i < 2; i++) {
      const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/views/analytics`, { headers: { authorization: "Bearer r" } });
      assert.equal(response.status, 200);
      const body = await response.json() as { data: AnalyticsViewData; sources: ViewSource[]; stale: boolean };
      assert.equal(body.data.instances[0]!.gardenerSpend!.totalUsd, 2);
      assert.equal(body.sources.find(s => s.name === "analytics:core")?.asOf, oldAsOf);
      assert.equal(body.stale, true);
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
  }
});

test("W1-T10461: independent gardener capture obeys cancellation ownership and bounded cadence", async t => {
  const { clock, advance } = handClock(T0 + MINUTE);
  const stateDir = scratch(t, "independent-cadence"); recentGarden(stateDir);
  const other = scratch(t, "independent-other"); recentGarden(other, "fixture/other");
  let historicalCalls = 0;
  const refresh: AnalyticsRefresh = async () => { historicalCalls++; throw Error("historical incomplete"); };
  const l = lane({ analytics: { instances: [{ name: "core", stateDir, repository: "fixture/recent" },
    { name: "other", stateDir: other, repository: "fixture/other" }], intervalMs: 1000 } }, refresh, clock);
  t.after(() => l.handle.stop()); l.switchOn(); l.lease();
  await l.settle({ passes: 1, snapshots: 2, legs: 2 });
  const gardener = () => l.allSnapshots().filter(s => s.ok && s.bodies.some(b => b.name === GARDENER_SPEND_SOURCE_NAME));
  assert.equal(gardener().length, 2, "both due repositories get one independent complete capture");
  l.fire(); await l.settle({ passes: 2 });
  assert.equal(gardener().length, 2, "another lane pass is not another provider or ledger capture");
  advance(1000); l.lease(true, ["other"]); await l.settle({ passes: 3, snapshots: 3, legs: 3 });
  assert.deepEqual(gardener().map(s => s.instance), ["core", "other", "other"]);
  l.switchOn("off"); advance(1000); l.fire(); await l.settle({ passes: 4 });
  assert.equal(historicalCalls, 3); assert.equal(gardener().length, 3);
  l.switchOn(); l.fire(); l.handle.stop();
  await sleep(30);
  assert.equal(gardener().length, 3, "stop cancels in-flight real filesystem capture before publication");
});

test("W1-T10461: gardener source freshness compatibility and fleet budgets remain independent", async t => {
  const { clock, advance } = handClock(T0 + MINUTE);
  const w = world(t, clock, { names: ["core"] });
  const sourceDir = scratch(t, "independent-source"); recentGarden(sourceDir);
  const source = await captureGardenerSpendSource(sourceDir, clock);
  const historical = written("core", snapshotOf(CORE_LINES, T0 - MINUTE), "fixture/recent"); assert.ok(historical.ok);
  historical.bodies = historical.bodies.map(b => b.name === ANALYTICS_SOURCE_CONSOLE_V1 ? { ...b, body: { ...b.body as object, gardenerSpendSource: source } } : b);
  w.ticker.acceptSnapshot(historical); w.ticker.tick();
  assert.equal(w.body().data.instances[0]!.gardenerSpend!.materializedAt, historical.asOf, "legacy row fallback retains its old clock");
  w.ticker.acceptSnapshot({ instance: "core", ok: false, names: [GARDENER_SPEND_SOURCE_NAME], error: "no current evidence", atMs: clock.now() });
  w.ticker.tick();
  assert.equal(w.body().data.instances[0]!.gardenerSpend!.totalUsd, null, "a failed first independent capture cannot revive embedded success");
  const fresh: SourceSnapshotWrite = { instance: "core", ok: true, asOf: source.observedAt!, bodies: [{ name: GARDENER_SPEND_SOURCE_NAME, body: { repository: "fixture/recent", source } }] };
  w.ticker.acceptSnapshot(fresh); advance(10000); w.ticker.tick();
  assert.equal(w.body().data.instances[0]!.gardenerSpend!.materializedAt, source.observedAt);
  assert.equal(w.body().sources.find(s => s.name === "analytics:core")!.asOf, historical.asOf);
  assert.equal(w.body().sources.find(s => s.name === "gardener-spend:core")!.state, "fresh");
  const cold = world(t, clock, { names: ["cold"] });
  cold.ticker.acceptSnapshot({ ...fresh, instance: "cold" }); cold.ticker.tick();
  assert.equal(cold.body().data.coverage.counted, 0);
  assert.equal(cold.body().data.instances[0]!.repository, "fixture/recent");
  assert.equal(cold.body().data.instances[0]!.gardenerSpend!.totalUsd, 2);
  const names = Array.from({ length: 12 }, (_, i) => `repo-${i}`);
  const fleet = world(t, clock, { names });
  for (const name of names) {
    const repository = `fixture/${name}`;
    const dir = scratch(t, "independent-fleet-source"), { runtime } = recentGarden(dir, repository);
    runtime.gardens = Array.from({ length: 32 }, (_, i) => ({ ...runtime.gardens[0]!, name: i === 0 ? "config" : `garden-${i}` }));
    writeFileSync(join(dir, "gardener-runtime.json"), JSON.stringify(runtime));
    const source = await captureGardenerSpendSource(dir, clock, { repository });
    fleet.ticker.acceptSnapshot({ instance: name, ok: true, asOf: source.observedAt!,
      bodies: [{ name: GARDENER_SPEND_SOURCE_NAME, body: { repository, source } }] });
  }
  fleet.ticker.tick();
  const spend = fleet.body().data.instances.map(i => i.gardenerSpend);
  assert.equal(spend.length, 12); assert.ok(spend.every(s => s?.totalUsd === 2), "all repositories reserve monetary evidence first");
  assert.ok(Buffer.byteLength(JSON.stringify(spend)) <= 65536);
  assert.ok(spend.some(s => s!.workerCalls?.state !== "complete"), "optional call coverage cannot crowd other repositories' money out");
  const history = snapshotOf(CORE_LINES, T0 - MINUTE);
  const compared = compareAnalytics([["core", history]], [["core", history]], data => {
    data.instances[0]!.gardenerSpend = foldGardenerSpend(source, "fixture/recent", source.observedAt!);
  });
  assert.ok(compared.diffs.some(d => d.path.includes("gardenerSpend") && d.classification === "real"),
    "legacy disagreement is not fabricated parity or an automatic view promotion");
  advance(ANALYTICS_STALE_AFTER_MS + 1); w.ticker.tick();
  assert.equal(w.body().sources.find(s => s.name === "gardener-spend:core")!.state, "stale");
  assert.equal(foldGardenerSpend(source, "wrong/repository", source.observedAt!).totalUsd, null);
});

test("the slow lane refreshes each instance's analytics off serve's loop and posts its source snapshots", async (t) => {
  const stateDir = scratch(t, "analytics-lane");
  writeFileSync(join(stateDir, "ledger.ndjson"), CORE_LINES.map((l) => `${JSON.stringify(l)}\n`).join(""));
  const l = lane({ analytics: { instances: [{ name: "core", stateDir, repository: "craigoley/remudero" }] }, intervalMs: 60_000 });
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
  assert.equal(console.repository, "craigoley/remudero", "the configured repository travels with the slow-lane snapshot, not the ledger's o/r label");
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
    { kind: "remudero-read-model", stateDir, instances: [{ name: "core", ledgerDir, repo: "craigoley/remudero" }], tickMs: 20, signal: new SharedArrayBuffer(8), slowLane: { intervalMs: 60_000 }, modelApprovalConfig: { capturedAt: iso(T0), approvals: [] } },
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
  assert.equal(merged()!.instances[0]!.repository, "craigoley/remudero", "the real worker supplies the identity to its default analytics unit");
  assert.deepEqual(merged()!.modelApprovals, { version: "host-model-approvals-v1", scope: "serving-host", sourceKind: "loaded-config", capturedAt: iso(T0), state: "reported", approvals: [] }, "the default worker relays the same source to its actual view thread");
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
  const body = mergeAnalytics(view.map(([instanceId, snapshot]) => {
    const bodies = analyticsSourceBodies(snapshot);
    return { instanceId, snapshot: { asOf: snapshot.asOf!, console: bodies[0]!.body as AnalyticsConsoleSource, details: analyticsDetails(snapshot.asOf!, bodies[1]!.body, bodies[2]!.body) } };
  }), T0);
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
