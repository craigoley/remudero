/**
 * usage-v1 — subscription burn per window, cash dollars per interval, and why the router chose each
 * worker's model, projected from rows the fleet already writes.
 *
 * The row shapes are copied from the core ledger read on 2026-09-24: `daemon.headroom` (window
 * "weekly (all models)", resets_at ISO), `worker.assignment` candidates ("session (5h)" with a
 * microsecond `+00:00` resetsAt, "codex primary 10080m"), and `routing.decision` exactly as PR #6991
 * writes it (rule, capability, considered, headroomPercent).
 */
import assert from "node:assert/strict";
import type { ServerResponse } from "node:http";
import { rmSync } from "node:fs";
import { test } from "node:test";

import { adaptLiveAnalyticsMetrics } from "../src/lib/analytics-live-metrics.js";
import {
  buildAnalyticsRoute,
  createAnalyticsSnapshotCache,
  deriveAnalyticsSnapshot,
  deriveAnalyticsSnapshotFromCheckpointedLedger,
  writeAnalyticsCheckpoint,
  type AnalyticsCheckpoint,
} from "../src/lib/analytics-route.js";
import { fixedClock } from "../src/lib/clock.js";
import {
  accumulateUsageLine,
  buildUsageProjection,
  usageTelemetryState,
  windowKind,
  withLiveProviderWindows,
} from "../src/lib/usage-telemetry.js";
import { writeLedger } from "./helpers/ledger-fixture.js";

const NOW = "2026-09-24T12:00:00.000Z";

function headroom(ts: string, used: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ts,
    step: "daemon.headroom",
    run_id: "DAEMON-1",
    task_id: "DAEMON",
    window: "weekly (all models)",
    percent_used: used,
    limit_pct: 95,
    resets_at: "2026-09-27T05:00:00.000Z",
    enforced: false,
    ...extra,
  };
}

function assignment(
  ts: string,
  opts: {
    id: string;
    runId?: string;
    provider?: string;
    model?: string;
    session?: number;
    codex?: number;
    decision?: Record<string, unknown>;
    mode?: string;
    candidates?: unknown[];
    codexResetsAt?: unknown;
  },
): Record<string, unknown> {
  const session = opts.session ?? 20;
  return {
    ts,
    step: "worker.assignment",
    lane: "run-task",
    run_id: opts.runId ?? `RUN-${opts.id}`,
    task_id: "W1-T9001",
    worker_assignment: {
      version: 1,
      id: opts.id,
      phase: "pre-execution",
      requested: { model: "sonnet", effort: "high", maxTurns: 400 },
      selected: { provider: opts.provider ?? "claude", model: opts.model ?? "claude-sonnet-5", effort: "high" },
      routing: {
        mode: opts.mode ?? "multi-provider",
        selectionPath: "auction",
        policy: { preference: "automatic", reservePercent: 5, provenance: "default" },
        ...(opts.decision ? { decision: opts.decision } : {}),
      },
      candidates: opts.candidates ?? [
        {
          provider: "claude",
          readable: true,
          model: "claude-sonnet-5",
          windows: [
            { name: "session (5h)", usedPercent: session, resetsAt: "2026-09-24T14:59:59.739259+00:00" },
            { name: "weekly (all models)", usedPercent: 69, resetsAt: "2026-09-27T05:00:00.739280+00:00" },
            { name: "reached", usedPercent: 100 },
          ],
        },
        { provider: "codex", readable: true, windows: [{ name: "codex primary 10080m", usedPercent: opts.codex ?? 76, resetsAt: opts.codexResetsAt ?? 1790417710 }] },
        { provider: "cash", readable: false, windows: [] },
      ],
    },
  };
}

function auctionDecision(selected: "claude" | "codex"): Record<string, unknown> {
  return {
    rule: "headroom-auction",
    capability: "balanced",
    considered: [
      { provider: "claude", model: "claude-sonnet-5", eligible: true, selected: selected === "claude" },
      { provider: "codex", model: "gpt-6-luna", eligible: true, selected: selected === "codex" },
      { eligible: true, selected: false },
    ],
    headroomPercent: { claude: 31, codex: 24 },
  };
}

function project(lines: Array<Record<string, unknown>>, now = NOW) {
  const state = usageTelemetryState();
  for (const line of lines) accumulateUsageLine(state, line);
  return buildUsageProjection(state, now);
}

function fakeResponse() {
  let status = 0;
  let body = "";
  const res = {
    statusCode: 0,
    setHeader() {},
    writeHead(code: number) { status = code; return this; },
    end(chunk?: string) { body = chunk ?? ""; if (!status) status = (res as { statusCode: number }).statusCode || 200; },
  } as unknown as ServerResponse;
  return { res, status: () => status, body: () => body };
}

test("usage-v1 reports each subscription window with its burn and its reset", () => {
  const usage = project([
    assignment("2026-09-24T09:10:00.000Z", { id: "a1", session: 10 }),
    assignment("2026-09-24T10:10:00.000Z", { id: "a2", session: 16 }),
    assignment("2026-09-24T11:10:00.000Z", { id: "a3", session: 22, codex: 78 }),
    assignment("2026-09-24T11:40:00.000Z", { id: "a4", session: 25, codex: 79 }),
  ]);
  const claude = usage.subscriptions.find((entry) => entry.provider === "claude")!;
  assert.equal(claude.state, "observed");
  assert.deepEqual(claude.windows.map((window) => `${window.kind}:${window.name}`), ["5h:session (5h)", "weekly:weekly (all models)"],
    "the reached marker is not a window, and the shortest window sorts first");
  const session = claude.windows[0]!;
  assert.equal(session.usedPercent, 25);
  assert.equal(session.remainingPercent, 75);
  assert.equal(session.resetsAt, "2026-09-24T14:59:59.739Z", "a microsecond +00:00 reset is normalised to ISO");
  assert.equal(session.asOf, "2026-09-24T11:40:00.000Z");
  assert.equal(session.source, "ledger");
  assert.equal(session.burn.lastHourPercent, 9, "16 at 10:xx to 25 at 11:40");
  assert.equal(session.burn.last24hPercent, 15);
  assert.equal(session.burn.ratePercentPerHour, 6, "15 points over 2h30m");
  assert.equal(session.series.length, 3);
  assert.equal(session.projectedExhaustionAt, null, "75 points at 6/h outlasts a reset 3h20m away");
  assert.equal(session.exhaustsBeforeReset, false);
  const codex = usage.subscriptions.find((entry) => entry.provider === "codex")!;
  assert.equal(codex.windows[0]!.kind, "weekly");
  assert.equal(codex.windows[0]!.usedPercent, 79);
  assert.equal(codex.windows[0]!.resetsAt, "2026-09-26T10:15:10.000Z", "codex rows carry epoch seconds as the fleet ledger does");
  const inMs = project([assignment("2026-09-24T11:00:00.000Z", { id: "ms", codexResetsAt: 1790417710000 })]);
  assert.equal(inMs.subscriptions[1]!.windows[0]!.resetsAt, "2026-09-26T10:15:10.000Z", "an epoch in milliseconds reads the same instant");
  assert.equal(usage.subscriptions.some((entry) => entry.provider === "cash"), false, "cash is money and never a subscription");
});

test("a window that will run out before its reset gets a projected exhaustion time", () => {
  const usage = project([
    assignment("2026-09-24T10:00:00.000Z", { id: "b1", session: 40 }),
    assignment("2026-09-24T11:00:00.000Z", { id: "b2", session: 70 }),
  ]);
  const session = usage.subscriptions[0]!.windows[0]!;
  assert.equal(session.burn.ratePercentPerHour, 30);
  assert.equal(session.exhaustsBeforeReset, true);
  assert.equal(session.projectedExhaustionAt, "2026-09-24T12:00:00.000Z");
});

test("a window reset counts the new reading as burn and never as a negative delta", () => {
  const usage = project([
    headroom("2026-09-24T09:30:00.000Z", 90, { resets_at: "2026-09-24T10:00:00.000Z" }),
    headroom("2026-09-24T10:30:00.000Z", 4),
    headroom("2026-09-24T11:30:00.000Z", 7),
  ]);
  const weekly = usage.subscriptions[0]!.windows[0]!;
  assert.equal(weekly.burn.last24hPercent, 7, "90 then a reset to 4 then 7 burned 7 points, not -83");
  assert.equal(weekly.limitPercent, 95, "the governor ceiling travels with the daemon reading");
});

test("a reading older than its own reset is marked stale", () => {
  const usage = project([assignment("2026-09-24T09:10:00.000Z", { id: "s1" })], "2026-09-24T16:00:00.000Z");
  const claude = usage.subscriptions[0]!;
  assert.equal(claude.windows[0]!.state, "stale", "the 5h window reset at 15:00 so a 09:10 reading describes an ended window");
  assert.equal(claude.windows[1]!.state, "observed");
  const allStale = project([headroom("2026-09-24T09:00:00.000Z", 50, { resets_at: "2026-09-24T10:00:00.000Z" })], NOW);
  assert.equal(allStale.subscriptions[0]!.state, "stale");
  assert.equal(allStale.subscriptions[1]!.state, "not-collected");
});

test("usage-v1 counts cash dollars per interval and per model", () => {
  const cash = (ts: string, model: string, usd: number) => ({ ts, step: "implement.done", provider: "cash", model, total_cost_usd: usd });
  const usage = project([
    cash("2026-09-23T11:00:00.000Z", "gpt-oss-120b", 2),
    cash("2026-09-23T13:00:00.000Z", "gpt-oss-120b", 0.4),
    cash("2026-09-24T01:00:00.000Z", "gpt-5-nano", 0.25),
    cash("2026-09-24T11:20:00.000Z", "gpt-5-nano", 0.1),
    { ts: "2026-09-24T11:30:00.000Z", step: "implement.done", provider: "cash" },
    { ts: "2026-09-24T11:40:00.000Z", step: "implement.done", provider: "claude", total_cost_usd: 9 },
  ]);
  const window = (name: string) => usage.cash.windows.find((entry) => entry.name === name)!;
  assert.equal(usage.cash.state, "observed");
  assert.equal(window("1h").usd, 0.1);
  assert.equal(window("1h").rows, 2);
  assert.equal(window("today-utc").usd, 0.35);
  assert.equal(window("24h").usd, 0.75);
  assert.equal(window("24h").complete, true);
  assert.deepEqual(usage.cash.byModel24h, [{ model: "gpt-oss-120b", usd: 0.4 }, { model: "gpt-5-nano", usd: 0.35 }, { model: "unreported", usd: 0 }]);
  assert.equal(usage.cash.series.length, 4);
  assert.equal(window("today-utc").complete, true);
});

test("usage-v1 names the routing rule and every candidate the router weighed", () => {
  const usage = project([
    assignment("2026-09-24T11:00:00.000Z", { id: "r1", runId: "RUN-A", decision: auctionDecision("codex"), provider: "codex", model: "gpt-6-luna" }),
    assignment("2026-09-24T10:00:00.000Z", { id: "r0", runId: "RUN-A", decision: auctionDecision("claude") }),
    assignment("2026-09-24T11:30:00.000Z", {
      id: "r2",
      runId: "RUN-B",
      mode: "mount-affinity",
      candidates: [{ provider: "claude", readable: true, windows: [], modelDecision: { requestedCapability: "economy", requestedEffort: "low", mappedCandidates: [] } }],
    }),
  ]);
  assert.equal(usage.routing.state, "observed");
  assert.equal(usage.routing.assignmentsObserved, 3);
  assert.equal(usage.routing.decisionsObserved, 2);
  assert.deepEqual(usage.routing.recent.map((entry) => entry.runId), ["RUN-B", "RUN-A"], "one newest decision per run");
  const runA = usage.routing.recent[1]!;
  assert.equal(runA.id, "r1", "an older row replayed later never replaces the newer decision");
  assert.equal(runA.assignmentsInRun, 2);
  assert.equal(runA.rule, "headroom-auction");
  assert.equal(runA.ruleSource, "decision");
  assert.equal(runA.capability, "balanced");
  assert.deepEqual(runA.selected, { provider: "codex", model: "gpt-6-luna", effort: "high" });
  assert.deepEqual(runA.considered.map((entry) => `${entry.provider}:${entry.selected}`), ["claude:false", "codex:true"]);
  assert.deepEqual(runA.headroomPercent, { claude: 31, codex: 24 });
  const legacy = usage.routing.recent[0]!;
  assert.equal(legacy.rule, "legacy:mount-affinity");
  assert.equal(legacy.ruleSource, "legacy-mode");
  assert.equal(legacy.capability, "economy", "a pre-decision row still names its tier from the model decision");
});

test("cash chosen while a subscription had room is flagged", () => {
  const cashFallback = (id: string, headroomPercent: Record<string, unknown>, considered: unknown[] = []) =>
    assignment("2026-09-24T11:00:00.000Z", {
      id,
      provider: "cash",
      model: "gpt-5-nano",
      decision: { rule: "cash-fallback", capability: "balanced", considered, headroomPercent },
    });
  const usage = project([
    cashFallback("c1", { claude: 3, codex: null }),
    cashFallback("c2", { claude: 40, codex: null, bogus: "x" }),
    cashFallback("c3", { claude: 2 }, [{ provider: "codex", eligible: true, selected: false }]),
    cashFallback("c4", "not-an-object" as never),
  ]);
  const flagged = Object.fromEntries(usage.routing.recent.map((entry) => [entry.id, entry.cashWhileSubscriptionHadRoom]));
  assert.deepEqual(flagged, { c1: false, c2: true, c3: true, c4: false },
    "3% is under the 5% reserve; 40% is room; an eligible subscription candidate is room");
  assert.deepEqual(usage.routing.recent.find((entry) => entry.id === "c2")!.headroomPercent, { claude: 40, codex: null });
  assert.equal(usage.routing.aggregates.last24h.cashWhileSubscriptionHadRoom, 2);
});

test("routing aggregates share the work by model and tier and rule", () => {
  const usage = project([
    assignment("2026-09-24T11:00:00.000Z", { id: "g1", decision: auctionDecision("claude") }),
    assignment("2026-09-24T11:05:00.000Z", { id: "g2", decision: auctionDecision("claude") }),
    assignment("2026-09-24T11:10:00.000Z", { id: "g3", decision: auctionDecision("codex"), provider: "codex", model: "gpt-6-luna" }),
    assignment("2026-09-20T11:10:00.000Z", { id: "g4", decision: { rule: "mount-affinity", capability: "economy", considered: [], headroomPercent: {} }, provider: "cash", model: "gpt-oss-120b" }),
  ]);
  const day = usage.routing.aggregates.last24h;
  assert.equal(day.total, 3);
  assert.deepEqual(day.byModel.map((row) => `${row.model}:${row.count}:${row.sharePercent}`), ["claude-sonnet-5:2:66.7", "gpt-6-luna:1:33.3"]);
  assert.deepEqual(day.byRule, [{ rule: "headroom-auction", count: 3, sharePercent: 100 }]);
  const week = usage.routing.aggregates.last7d;
  assert.equal(week.total, 4);
  assert.deepEqual(week.byTier.map((row) => `${row.tier}:${row.count}`), ["balanced:3", "economy:1"]);
  assert.deepEqual(week.byProvider.map((row) => row.provider), ["claude", "codex", "cash"]);
});

test("rows older than the retention horizon are pruned and malformed rows are ignored", () => {
  const usage = project([
    assignment("2026-09-10T11:00:00.000Z", { id: "old", decision: auctionDecision("claude") }),
    { ts: "2026-09-10T11:00:00.000Z", step: "implement.done", provider: "cash", total_cost_usd: 5 },
    headroom("2026-09-24T11:00:00.000Z", 60),
    assignment("2026-09-11T11:00:00.000Z", { id: "late", decision: auctionDecision("claude") }),
    { ts: "2026-09-11T11:00:00.000Z", step: "implement.done", provider: "cash", total_cost_usd: 5 },
    headroom("2026-09-11T11:00:00.000Z", 1),
    headroom("2026-09-24T11:10:00.000Z", 61, { window: undefined }),
    headroom("not-a-time", 61),
    { ts: NOW, step: "worker.assignment", worker_assignment: { id: "x", selected: {} } },
    { ts: NOW, step: "run.start" },
  ]);
  assert.equal(usage.coverage.from, "2026-09-24T11:00:00.000Z", "a nine-day-old hour does not survive a newer reading");
  assert.equal(usage.routing.aggregates.last7d.total, 0);
  assert.equal(usage.cash.series.length, 0);
  assert.equal(usage.subscriptions[0]!.windows[0]!.series.length, 1);
  assert.equal(usage.routing.assignmentsObserved, 2, "the retained counters still count what was seen");
});

test("window kinds read the provider window names", () => {
  assert.deepEqual(windowKind("codex secondary 300m"), { kind: "5h", durationMs: 18_000_000 });
  assert.deepEqual(windowKind("codex primary 10080m"), { kind: "weekly", durationMs: 604_800_000 });
  assert.deepEqual(windowKind("codex primary 60m"), { kind: "other", durationMs: 3_600_000 });
  assert.deepEqual(windowKind("weekly (Fable)"), { kind: "weekly", durationMs: 604_800_000 });
  assert.deepEqual(windowKind("monthly"), { kind: "other", durationMs: null });
});

test("the usage-v1 route overlays a newer live reading on the ledger window", async () => {
  const base = deriveAnalyticsSnapshot([assignment("2026-09-24T11:00:00.000Z", { id: "l1", session: 20 })], NOW);
  const live = adaptLiveAnalyticsMetrics({
    provider: {
      state: "selected",
      freshness: "fresh",
      observedAt: "2026-09-24T11:59:00.000Z",
      providers: [
        { provider: "claude", readable: true, windows: [{ name: "session (5h)", usedPercent: 33 }, { name: "weekly (all models)" }] },
        { provider: "codex", readable: false, windows: [] },
      ],
    },
  });
  const route = buildAnalyticsRoute({ currentSnapshot: () => base, currentLiveMetrics: () => live });
  const { res, body, status } = fakeResponse();
  await route.handler({ url: "/v1/analytics?projectionVersion=usage-v1" } as never, res, { params: {} });
  assert.equal(status(), 200);
  const got = JSON.parse(body()) as ReturnType<typeof buildUsageProjection>;
  assert.equal(got.version, "usage-v1");
  const session = got.subscriptions[0]!.windows[0]!;
  assert.equal(session.usedPercent, 33);
  assert.equal(session.source, "live-status");
  assert.equal(session.resetsAt, "2026-09-24T14:59:59.739Z", "a live reading with no reset keeps the ledger's");
  assert.equal(got.subscriptions[0]!.windows[1]!.source, "ledger", "a live window with no number never overwrites one");
  assert.equal(got.subscriptions[1]!.windows[0]!.source, "ledger", "an unreadable live account never overwrites one");
  assert.equal(Object.keys(base).includes("usage"), false, "the unversioned snapshot does not grow");

  const stale = withLiveProviderWindows(got, { ...live.provider.accounts, state: "stale" });
  assert.equal(stale, got, "a stale live snapshot is not an overlay");
  const cold = buildAnalyticsRoute({ currentSnapshot: () => ({ ...base, usage: undefined }) });
  const second = fakeResponse();
  await cold.handler({ url: "/v1/analytics?projectionVersion=usage-v1" } as never, second.res, { params: {} });
  const coldBody = JSON.parse(second.body()) as ReturnType<typeof buildUsageProjection>;
  assert.equal(coldBody.asOf, null);
  assert.equal(coldBody.routing.state, "not-collected");
  assert.equal(coldBody.cash.state, "not-collected");
});

test("the usage-v1 projection stays small under a busy week", () => {
  const lines: Array<Record<string, unknown>> = [];
  for (let index = 0; index < 2_000; index += 1) {
    const ts = new Date(Date.parse(NOW) - index * 5 * 60_000).toISOString();
    const decision = { ...auctionDecision(index % 2 ? "claude" : "codex"), ab: "sol-vs-sonnet" };
    lines.push(assignment(ts, { id: `busy-${index}`, runId: `RUN-${index % 700}`, decision, session: index % 90 }));
    lines.push(headroom(ts, 50 + (index % 40)));
  }
  const usage = project(lines);
  assert.equal(usage.routing.experiments.reduce((sum, arm) => sum + arm.runs, 0), 600, "marked runs are bounded, oldest dropped first");
  const bytes = Buffer.byteLength(JSON.stringify(usage));
  assert.ok(bytes < 96 * 1024, `usage-v1 is ${bytes} bytes; the console refuses a response over 128 KB`);
});

test("an analytics checkpoint written before usage-v1 is rescanned in full", async () => {
  const fixture = writeLedger([
    assignment("2026-09-24T10:00:00.000Z", { id: "k1", decision: auctionDecision("claude") }),
    headroom("2026-09-24T10:05:00.000Z", 66),
  ]);
  try {
    const first = await deriveAnalyticsSnapshotFromCheckpointedLedger(fixture.dir, fixedClock(Date.parse(NOW)));
    assert.equal(first.snapshot.usage?.routing.assignmentsObserved, 1);
    const legacy = structuredClone(first.checkpoint) as AnalyticsCheckpoint;
    delete legacy.state.usage;
    fixture.append([assignment("2026-09-24T11:00:00.000Z", { id: "k2", decision: auctionDecision("codex") })]);
    const resumed = await deriveAnalyticsSnapshotFromCheckpointedLedger(fixture.dir, fixedClock(Date.parse(NOW)), undefined, legacy);
    assert.equal(resumed.snapshot.usage?.routing.assignmentsObserved, 2, "a pre-usage checkpoint cannot resume, or k1 would be lost");
    const tail = await deriveAnalyticsSnapshotFromCheckpointedLedger(fixture.dir, fixedClock(Date.parse(NOW)), undefined, resumed.checkpoint);
    assert.equal(tail.snapshot.usage?.routing.assignmentsObserved, 2, "a usage-bearing checkpoint resumes without double counting");

    writeAnalyticsCheckpoint(fixture.dir, resumed.checkpoint);
    const cache = createAnalyticsSnapshotCache({ stateDir: fixture.dir });
    assert.equal(cache.current().usage?.routing.assignmentsObserved, 2, "a restarted serve answers usage-v1 from its checkpoint");
    writeAnalyticsCheckpoint(fixture.dir, legacy);
    assert.equal(createAnalyticsSnapshotCache({ stateDir: fixture.dir }).current().usage, undefined);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("a marked run joins its verdict into an experiment arm", () => {
  const marked = (ts: string, id: string, runId: string, provider: string, model: string) =>
    assignment(ts, { id, runId, provider, model, decision: { ...auctionDecision(provider === "codex" ? "codex" : "claude"), ab: "sol-vs-sonnet", arm_seed: 7, pinned: true, nested: { no: 1 } } });
  const usage = project([
    marked("2026-09-24T09:00:00.000Z", "m1", "RUN-X", "claude", "claude-sonnet-5"),
    marked("2026-09-24T09:30:00.000Z", "m2", "RUN-X", "claude", "claude-sonnet-5"),
    marked("2026-09-24T09:00:00.000Z", "m3", "RUN-Y", "codex", "gpt-6-sol"),
    marked("2026-09-24T09:10:00.000Z", "m4", "RUN-Z", "codex", "gpt-6-sol"),
    assignment("2026-09-24T09:00:00.000Z", { id: "m5", runId: "RUN-PLAIN", decision: auctionDecision("claude") }),
    { ...marked("2026-09-24T09:00:00.000Z", "m6", "", "claude", "claude-sonnet-5"), run_id: undefined },
    { ts: "2026-09-24T10:00:00.000Z", step: "verdict", run_id: "RUN-X", verdict: "merged", total_cost_usd: 2 },
    { ts: "2026-09-24T10:05:00.000Z", step: "verdict", run_id: "RUN-X", verdict: "failed", total_cost_usd: 9 },
    { ts: "2026-09-24T09:30:00.000Z", step: "verdict", run_id: "RUN-Y", success: false },
    { ts: "2026-09-24T10:00:00.000Z", step: "verdict", run_id: "RUN-PLAIN", verdict: "merged" },
  ]);
  const runX = usage.routing.recent.find((entry) => entry.runId === "RUN-X")!;
  assert.deepEqual(runX.markers, { ab: "sol-vs-sonnet", arm_seed: "7", pinned: "true" }, "scalar decision fields pass through by name");
  const arms = usage.routing.experiments.filter((arm) => arm.marker === "ab");
  assert.deepEqual(arms.map((arm) => `${arm.model}:${arm.runs}:${arm.terminals}:${arm.successes}`), ["gpt-6-sol:2:1:0", "claude-sonnet-5:1:1:1"]);
  const sonnet = arms.find((arm) => arm.model === "claude-sonnet-5")!;
  assert.equal(sonnet.successRatePercent, 100);
  assert.equal(sonnet.meanAssignmentsPerRun, 2, "a fix round is a second assignment in the same run");
  assert.equal(sonnet.meanDurationMs, 3_600_000, "first marked assignment to the run's verdict");
  assert.equal(sonnet.costUsd, 2, "only the first verdict of a run counts");
  assert.equal(sonnet.meanCostPerTerminalUsd, 2);
  const sol = arms.find((arm) => arm.model === "gpt-6-sol")!;
  assert.equal(sol.successRatePercent, 0);
  assert.equal(sol.meanDurationMs, 1_800_000);
  assert.equal(usage.routing.experiments.some((arm) => arm.marker === "nested"), false, "a non-scalar field is not a marker");
  assert.equal(usage.routing.aggregates.last24h.rows.length > 0, true);
  const unfinished = project([marked("2026-09-24T09:10:00.000Z", "u1", "RUN-U", "codex", "gpt-6-sol")]).routing.experiments[0]!;
  assert.equal(unfinished.successRatePercent, null, "no verdict yet is not a 0% success rate");
  assert.equal(unfinished.meanDurationMs, null);
  assert.equal(unfinished.meanCostPerTerminalUsd, null);
});
