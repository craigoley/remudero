// W1-T5053 (arch Phase 4 design §1.1 and §5, P4-T14): the `host` view carries the /host page's four route
// bodies, the skills list and the exact gauges in one read, built in the read-model worker's view thread. The
// credit-state edge is ledgered by the slow lane whether or not anyone reads; GET /v1/account-usage and the
// host view only read it. FALSIFIER: put the append back in the route and the first test reads no row while
// nobody reads, and the second reads an appended one.
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { test } from "node:test";
import { buildAccountUsageRoute, CREDIT_STATE_STEP, type AccountUsageDeps } from "../src/lib/account-usage.js";
import type { Clock } from "../src/lib/clock.js";
import { requestPause } from "../src/lib/fleet-control.js";
import {
  createHostView,
  HOST_PROBE_INTERVAL_MS,
  HOST_VIEW_NAME,
  hostLegacyView,
  hostReadDeps,
  hostViewConfig,
  readGhRateLimitRemainingAsync,
  type HostViewConfig,
  type HostViewData,
} from "../src/lib/host-view.js";
import type { LatestMeasurementRowsResult } from "../src/lib/measurement-cadence.js";
import { buildControlStatusRoute, controlStatusBody } from "../src/lib/panel-actions.js";
import { buildSkillsRoute } from "../src/lib/panel-skills.js";
import { writeProviderRoutingStatus } from "../src/lib/provider-routing-status.js";
import { runSlowLaneWorker, type SlowLaneMessage } from "../src/lib/read-model-slow-lane.js";
import { ledgerSource } from "../src/lib/read-model-worker.js";
import { buildProviderRoutingRoute, buildSelfMeasurementRoute } from "../src/lib/serve.js";
import type { Route } from "../src/lib/service.js";
import type { ReadModelInstanceState } from "../src/lib/task-view.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { buildViewRoutes } from "../src/lib/views.js";
import { ghShim } from "./helpers/gh-shim.js";

const CAPTURED = new URL("./fixtures/account-usage/claude-json.json", import.meta.url);
const SKILL = new URL("../.remudero/skills/review.yaml", import.meta.url);
const NOW = Date.parse("2026-09-22T12:00:00.000Z");
const CEILING = () => ({ usd: 150, provenance: "default" as const, committedDefaultUsd: 150 });

function measurementRow(ts: string, zeroTouchRate: number): string {
  return JSON.stringify({ ts, host: "fixture", run_id: `M-${ts}`, task_id: "MEASUREMENT", step: "measurement_cadence.ran", autonomy_rate: { status: "measured", zeroTouchRate } });
}

/** Core's state: a live ledger with a daemon poll and a measurement row, one archived measurement, the account file, a skill and a routing status. */
function world(): { root: string; ledgerPath: string; accountFilePath: string; config: HostViewConfig; setState: (state: string) => void; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}host-view-`));
  const stateDir = join(root, "state");
  mkdirSync(stateDir, { recursive: true });
  const ledgerPath = join(stateDir, "ledger.ndjson");
  writeFileSync(join(stateDir, "ledger.2026-09-21T12-00-00-000Z.ndjson.gz"), gzipSync(`${measurementRow("2026-09-21T11:00:00.000Z", 0.5)}\n`));
  writeFileSync(ledgerPath, [
    JSON.stringify({ ts: "2026-09-22T11:00:00.000Z", run_id: "R-1", task_id: "W1-T1", step: "run.start" }),
    measurementRow("2026-09-22T11:30:00.000Z", 0.57),
    JSON.stringify({ ts: "2026-09-22T11:59:00.000Z", run_id: "D", task_id: "DAEMON", step: "daemon.tick" }),
  ].join("\n") + "\n");
  const accountFilePath = join(root, "claude.json");
  const setState = (state: string): void => {
    const captured = JSON.parse(readFileSync(CAPTURED, "utf8")) as { cachedUsageUtilization: Record<string, unknown> };
    captured.cachedUsageUtilization.creditState = state;
    // A minute-old reading, so the usage is current and the route carries its age.
    captured.cachedUsageUtilization.fetchedAtMs = NOW - 60_000;
    writeFileSync(accountFilePath, JSON.stringify(captured));
  };
  setState("subscription");
  mkdirSync(join(root, ".remudero", "skills"), { recursive: true });
  copyFileSync(SKILL, join(root, ".remudero", "skills", "review.yaml"));
  writeProviderRoutingStatus(root, { state: "not-probed", enabledProviders: ["claude"], reservePercent: 10, observedAtMs: NOW - 60_000, cacheValidMs: 600_000 });
  requestPause(root, "host view fixture");
  const config: HostViewConfig = { controlRoot: root, ledgerPath, skillsRoot: root, accountFilePath };
  return { root, ledgerPath, accountFilePath, config, setState, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function edges(ledgerPath: string): Array<Record<string, unknown>> {
  return readFileSync(ledgerPath, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>).filter((r) => r.step === CREDIT_STATE_STEP);
}

const clockAt = (at: { ms: number }): Clock => ({ now: () => at.ms, date: () => new Date(at.ms), iso: () => new Date(at.ms).toISOString() });
const STATE: ReadModelInstanceState = { instance: "core", generation: 1, lease: "held", failures: 0, newestTs: "2026-09-22T11:59:00.000Z", tickedAt: NOW } as ReadModelInstanceState;
const ctx = (now: number) => ({ now, instances: [{ state: STATE }] });
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));

/** The deps the host view's routes answer with, pinned to the fixture's clock and ceiling. */
function pinned(config: HostViewConfig): ReturnType<typeof hostReadDeps> {
  const deps = hostReadDeps(config);
  return { ...deps, control: { ...deps.control, now: () => NOW }, account: { ...deps.account, now: () => NOW, resolveCeiling: CEILING }, providerRouting: { ...deps.providerRouting, now: () => NOW } };
}

/** Every route on one server; returns a JSON GET by path. */
async function serving(routes: Route[]): Promise<{ get: (path: string) => Promise<{ status: number; body: unknown }>; close: () => void }> {
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    void routes.find((r) => r.path === path)!.handler(req, res, { params: {} } as never);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    get: async (path) => {
      const res = await fetch(`${base}${path}`);
      return { status: res.status, body: await res.json() };
    },
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

/** The slow lane's body in this thread, its passes fired by hand. */
function lane(config: Parameters<typeof runSlowLaneWorker>[1]) {
  let onMessage: ((msg: { type?: string; held?: unknown }) => void) | undefined;
  const posted: SlowLaneMessage[] = [];
  let next: (() => void) | undefined;
  const handle = runSlowLaneWorker({ on: (_event, run) => (onMessage = run), postMessage: (m) => void posted.push(m as SlowLaneMessage) }, config, {
    schedule: (run) => {
      next = run;
      return () => void (next = undefined);
    },
  });
  const passes = (): number => posted.filter((m) => m.type === "unit" && m.unit === "credit-edge").length;
  const settled = async (want: number): Promise<void> => {
    const deadline = Date.now() + 5_000;
    while (passes() < want && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(passes(), want, "the credit-edge unit ran");
  };
  return { handle, lease: () => onMessage?.({ type: "lease", held: true }), fire: () => next?.(), settled };
}

test("W1-T5053: a credit state change is ledgered once with no reader", async () => {
  const w = world();
  const l = lane({ accountUsage: { ledgerPath: w.ledgerPath, root: w.root, accountFilePath: w.accountFilePath }, intervalMs: 60_000 });
  const at = { ms: NOW };
  const view = createHostView({ config: w.config, ledgerSource, clock: clockAt(at), deps: { read: pinned(w.config), rateLimit: async () => 1, diskFree: () => 1 } });
  try {
    l.lease();
    await l.settled(1);
    assert.deepEqual(edges(w.ledgerPath).map((r) => [r.state, r.previous]), [["subscription", undefined]], "the first known state is recorded with nobody reading");
    w.setState("credits");
    l.fire();
    await l.settled(2);
    assert.deepEqual(edges(w.ledgerPath).map((r) => [r.state, r.previous]), [["subscription", undefined], ["credits", "subscription"]], "the edge is recorded with nobody reading");
    l.fire();
    await l.settled(3);
    // The host view reads the same account file and appends nothing, however often it is built.
    for (let i = 0; i < 3; i++) {
      at.ms += HOST_PROBE_INTERVAL_MS;
      assert.equal((view.materialize(ctx(at.ms))[0]!.data as HostViewData).accountUsage.creditState, "credits");
    }
    assert.equal(edges(w.ledgerPath).length, 2, "an unchanged state appends nothing, and the view's builds append nothing");
  } finally {
    l.handle.stop();
    w.cleanup();
  }
});

test("W1-T5053: the account usage get route writes nothing", async () => {
  const w = world();
  w.setState("credits");
  const writes: unknown[] = [];
  const account: AccountUsageDeps = { ...pinned(w.config).account, writeLedger: (...args) => void writes.push(args) };
  // The host view's legacy side reads through the same deps the account route answers with.
  const legacy = hostLegacyView({ ...pinned(w.config), account }, () => undefined);
  const server = await serving([buildAccountUsageRoute(account), ...buildViewRoutes([legacy])]);
  try {
    const before = readFileSync(w.ledgerPath, "utf8");
    assert.deepEqual(edges(w.ledgerPath), [], "control: an unrecorded edge is there to be appended");
    for (let i = 0; i < 2; i++) {
      const usage = await server.get("/v1/account-usage");
      assert.equal(usage.status, 200);
      assert.equal((usage.body as { creditState?: string }).creditState, "credits");
      const host = await server.get(`/v1/views/${HOST_VIEW_NAME}`);
      assert.equal(host.status, 200);
      assert.equal((host.body as { data: HostViewData }).data.accountUsage.creditState, "credits");
    }
    assert.equal(readFileSync(w.ledgerPath, "utf8"), before, "a GET appended to the ledger");
    assert.deepEqual(writes, [], "a GET called the ledger appender");
  } finally {
    server.close();
    w.cleanup();
  }
});

test("W1-T5053: the host view carries each host route's body over the same inputs", async () => {
  const w = world();
  const at = { ms: NOW };
  const deps = pinned(w.config);
  const view = createHostView({ config: w.config, ledgerSource, clock: clockAt(at), deps: { read: deps, rateLimit: async () => 4321, diskFree: () => 123_456_789 } });
  const server = await serving([
    buildControlStatusRoute(deps.control),
    buildAccountUsageRoute(deps.account),
    buildProviderRoutingRoute(deps.providerRouting),
    buildSkillsRoute({ root: w.root }),
    buildSelfMeasurementRoute({ stateDir: join(w.root, "state"), prewarm: false }),
  ]);
  try {
    view.materialize(ctx(at.ms));
    await settle();
    const [body] = view.materialize(ctx(at.ms));
    // As the read model stores and serves it: JSON, where an undefined field is absent.
    const data = JSON.parse(JSON.stringify(body!.data)) as HostViewData;
    const route = async (path: string): Promise<unknown> => (await server.get(path)).body;
    assert.deepEqual(data.control, await route("/v1/control/status"));
    const usage = (await route("/v1/account-usage")) as Record<string, unknown>;
    assert.ok(Object.keys(usage).some((k) => k.endsWith("AgeMs")), "control: the route carries ages the view drops");
    assert.deepEqual(data.accountUsage, Object.fromEntries(Object.entries(usage).filter(([k]) => !k.endsWith("AgeMs"))));
    assert.deepEqual(data.providerRouting, await route("/v1/provider-routing"));
    assert.deepEqual({ skills: data.skills }, await route("/v1/skills"));
    assert.deepEqual(data.selfMeasurement, await route("/v1/self-measurement"));
    // CONTROLS: every part is populated, so no equality above holds by both sides being empty.
    assert.deepEqual([data.control.paused, data.control.daemonLive, data.skills.map((s) => s.name), data.providerRouting.state], [true, true, ["review"], "not-probed"]);
    assert.deepEqual(data.selfMeasurement.status === "ok" ? data.selfMeasurement.rows.map((r) => r.ts) : data.selfMeasurement, ["2026-09-22T11:30:00.000Z", "2026-09-21T11:00:00.000Z"], "the archive and the live file were both read");
    assert.deepEqual(data.gauges, { diskFreeBytes: 123_456_789, rateLimitRemaining: 4321 }, "the gauges are exact, never banded");
    assert.deepEqual(body!.sources.map((s) => [s.name, s.state]), [["host-probe:core", "fresh"], ["account:core", "fresh"], ["ledger:core", "fresh"]]);
  } finally {
    server.close();
    w.cleanup();
  }
});

test("W1-T5053: the host view never waits on the rate limit and re-reads no file when a reading lands", async () => {
  const w = world();
  const at = { ms: NOW };
  let reads = 0;
  let answer: (n: number) => void = () => {};
  let rateCalls = 0;
  const base = pinned(w.config);
  const read = { ...base, account: { ...base.account, readLedger: (path: string) => (reads++, JSON.parse(`[${readFileSync(path, "utf8").trim().split("\n").join(",")}]`) as Array<Record<string, unknown>>) } };
  const view = createHostView({
    config: w.config, ledgerSource, clock: clockAt(at), intervalMs: 1_000,
    deps: { read, diskFree: () => undefined, rateLimit: () => (rateCalls++, new Promise<number | undefined>((resolve) => (answer = resolve as (n: number) => void))), selfMeasurement: async () => ({ status: "ok", rows: [] }) },
  });
  try {
    const first = view.materialize(ctx(at.ms))[0]!.data as HostViewData;
    assert.deepEqual(first.gauges.reasons, { diskFreeBytes: `statfs of ${join(w.root, "state")} failed`, rateLimitRemaining: "gh api rate_limit has not answered yet" }, "the build answered without the rate limit");
    assert.equal(view.materialize(ctx(at.ms))[0]!.data, first, "an unchanged probe inside its interval is the same body");
    answer(4321);
    await settle();
    const landed = view.materialize(ctx(at.ms))[0]!.data as HostViewData;
    assert.equal(landed.gauges.rateLimitRemaining, 4321);
    assert.deepEqual(landed.selfMeasurement, { status: "ok", rows: [] });
    assert.deepEqual([reads, rateCalls], [1, 1], "a landing re-composes the probe: no file is read again and no new read starts");
    at.ms += 1_000;
    view.materialize(ctx(at.ms));
    assert.deepEqual([reads, rateCalls], [2, 2], "the next interval re-samples");
  } finally {
    w.cleanup();
  }
});

test("W1-T5053: a failed async reading is named and a host view without inputs builds nothing", async () => {
  const w = world();
  const at = { ms: NOW };
  const view = createHostView({
    config: w.config, ledgerSource, clock: clockAt(at),
    deps: { read: pinned(w.config), diskFree: () => 1, rateLimit: async () => { throw new Error("gh exploded"); }, selfMeasurement: async () => { throw new Error("union exploded"); } },
  });
  const quiet = createHostView({ config: w.config, ledgerSource, clock: clockAt(at), deps: { read: pinned(w.config), diskFree: () => 1, rateLimit: async () => undefined, selfMeasurement: async (): Promise<LatestMeasurementRowsResult> => ({ status: "ok", rows: [] }) } });
  try {
    view.materialize(ctx(at.ms));
    quiet.materialize(ctx(at.ms));
    await settle();
    const data = view.materialize(ctx(at.ms))[0]!.data as HostViewData;
    assert.equal(data.gauges.reasons?.rateLimitRemaining, "gh api rate_limit failed: gh exploded");
    assert.deepEqual(data.selfMeasurement, { status: "unreadable", reason: "the measurement read failed: union exploded" });
    assert.equal((quiet.materialize(ctx(at.ms))[0]!.data as HostViewData).gauges.reasons?.rateLimitRemaining, "gh api rate_limit did not answer a number");
    assert.deepEqual(createHostView({ ledgerSource }).materialize(ctx(at.ms)), [], "no config, no body");
    assert.deepEqual(view.materialize({ now: at.ms, instances: [] }), [], "no projected instance, no body");
    // A probe whose file read throws is not retried inside its interval.
    rmSync(join(w.root, ".remudero", "skills", "review.yaml"));
    writeFileSync(join(w.root, ".remudero", "skills", "broken.yaml"), "tools: [unclosed\n");
    const failing = createHostView({ config: w.config, ledgerSource, clock: clockAt(at), deps: { read: pinned(w.config), diskFree: () => 1, rateLimit: async () => 1, selfMeasurement: async () => ({ status: "ok", rows: [] }) } });
    assert.throws(() => failing.materialize(ctx(at.ms)));
    assert.deepEqual(failing.materialize(ctx(at.ms)), [], "inside the interval the failed probe is not re-run");
  } finally {
    w.cleanup();
  }
});

test("W1-T5053: the host legacy side computes the route parts and takes the view's sampled readings", () => {
  const w = world();
  const at = { ms: NOW };
  try {
    const view = createHostView({ config: w.config, ledgerSource, clock: clockAt(at), deps: { read: pinned(w.config), diskFree: () => 7, rateLimit: async () => 9, selfMeasurement: async () => ({ status: "ok", rows: [] }) } });
    const sampled = view.materialize(ctx(at.ms))[0]!.data as HostViewData;
    const withView = hostLegacyView(pinned(w.config), () => sampled).compute(new URLSearchParams());
    assert.ok(!("error" in withView));
    assert.deepEqual(withView.data, sampled, "over the same inputs the legacy side equals the view");
    const cold = hostLegacyView(pinned(w.config), () => undefined).compute(new URLSearchParams());
    assert.ok(!("error" in cold));
    assert.equal(cold.data.selfMeasurement.status, "unreadable");
    assert.deepEqual(Object.keys(cold.data.gauges.reasons ?? {}), ["diskFreeBytes", "rateLimitRemaining"]);
    rmSync(w.accountFilePath);
    const unknown = hostLegacyView(pinned(w.config), () => undefined).compute(new URLSearchParams());
    assert.ok(!("error" in unknown));
    assert.equal(unknown.sources[0]?.state, "stale", "an unreadable account file is a stale account source");
    const unknownView = createHostView({ config: w.config, ledgerSource, clock: clockAt(at), deps: { read: pinned(w.config), diskFree: () => 7, rateLimit: async () => 9, selfMeasurement: async () => ({ status: "ok", rows: [] }) } });
    assert.match(unknownView.materialize(ctx(at.ms))[0]!.sources[1]!.reason ?? "", /^account usage unreadable$/);
  } finally {
    w.cleanup();
  }
});

test("W1-T5053: the host view's config is the slow lane's inputs and its rate limit is a real gh read", async () => {
  assert.equal(hostViewConfig(undefined), undefined);
  assert.equal(hostViewConfig({ inbox: { root: "/repo" } }), undefined, "no credit-edge unit, no host inputs");
  assert.deepEqual(hostViewConfig({ inbox: { root: "/repo" }, accountUsage: { ledgerPath: "/ctl/state/ledger.ndjson", root: "/ctl", accountFilePath: "/home/.claude.json" } }),
    { controlRoot: "/ctl", ledgerPath: "/ctl/state/ledger.ndjson", skillsRoot: "/repo", accountFilePath: "/home/.claude.json" });
  assert.deepEqual(hostViewConfig({ accountUsage: { ledgerPath: "/ctl/state/ledger.ndjson", root: "/ctl" } }), { controlRoot: "/ctl", ledgerPath: "/ctl/state/ledger.ndjson", skillsRoot: "/ctl" });
  assert.equal(await readGhRateLimitRemainingAsync(async () => ({ resources: { core: { remaining: 12 } } })), 12);
  assert.equal(await readGhRateLimitRemainingAsync(async () => ({ resources: {} })), undefined);
  // The production seams, unfaked: a PATH `gh` answers the rate limit, and the real measurement reader runs.
  const shim = ghShim([{ when: "api rate_limit", stdout: JSON.stringify({ resources: { core: { remaining: 4999 } } }) }], { kind: "w1-t5053-gh" });
  const savedPath = process.env.PATH;
  process.env.PATH = `${shim.dir}:${savedPath}`;
  const w = world();
  try {
    const at = { ms: NOW };
    const view = createHostView({ config: w.config, ledgerSource, clock: clockAt(at), deps: { read: pinned(w.config) } });
    view.materialize(ctx(at.ms));
    const deadline = Date.now() + 10_000;
    let data = view.materialize(ctx(at.ms))[0]!.data as HostViewData;
    while ((data.gauges.rateLimitRemaining === undefined || data.selfMeasurement.status !== "ok") && Date.now() < deadline) {
      await settle();
      data = view.materialize(ctx(at.ms))[0]!.data as HostViewData;
    }
    assert.equal(data.gauges.rateLimitRemaining, 4999);
    assert.equal(typeof data.gauges.diskFreeBytes, "number", "the real statfs answered");
    assert.equal(data.selfMeasurement.status, "ok");
  } finally {
    process.env.PATH = savedPath;
    rmSync(shim.dir, { recursive: true, force: true });
    w.cleanup();
  }
});

test("W1-T5053: the control part reads an unreadable ledger as unknown liveness, not a failed body", () => {
  const w = world();
  try {
    const body = controlStatusBody({ root: w.root, ledgerPath: w.ledgerPath, readLedger: () => { throw new Error("EACCES"); } });
    assert.deepEqual([body.paused, body.daemonLive, body.daemonLiveReason], [true, undefined, "ledger-unreadable"]);
  } finally {
    w.cleanup();
  }
});
