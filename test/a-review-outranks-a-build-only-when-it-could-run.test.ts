/**
 * W1-T7095: the shadow verdict says WHO WOULD HAVE WAITED. A non-review start would yield only to an ELIGIBLE, QUEUED
 * review that memory alone keeps from starting and that the yield would make fit — never when no review can run. Waits
 * age, so no class or instance starves; routine deferrals collapse to one machine row per (class, instance, reason); a
 * sustained zero-worker shortfall raises exactly one decision per scenario. SHADOW ONLY: no real start is delayed or
 * reordered.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { fixedClock } from "../src/lib/clock.js";
import type { HostMemoryReading, ReadingEntry, WorkerClass } from "../src/lib/host-memory-ledger.js";
import {
  HOST_MEMORY_PRIORITY_PROPOSAL,
  capacityDecisionText,
  priorityScore,
  publishReviewDemand,
  rankDemand,
  readReviewDemand,
  resetHostMemoryPriorityStateForTests,
  takeCapacityDecisions,
  wouldYieldToReview,
  type CapacityDecision,
  type HostMemoryPriorityPolicy,
  type ObservedDemand,
  type ReviewDemandReading,
  type WaitingDemand,
  type YieldContext,
} from "../src/lib/host-memory-priority.js";
import {
  counterfactualReviewVerdict,
  evaluateShadowMemory,
  recordShadowMemoryVerdict,
  resetShadowMemoryStateForTests,
  shadowDeferralReport,
  type HostMemoryBudgetPolicy,
  type ShadowEntryInput,
  type ShadowInputs,
  type ShadowMemoryPorts,
} from "../src/lib/host-memory-shadow.js";
import type { LedgerLine } from "../src/lib/ledger.js";
import { publishLightPassReviewDemand, type OpenPrView } from "../src/lib/sweep.js";
import { DEFAULT_SWEEP_POLICY } from "../src/lib/sweep.js";
import { createClaudeExecutableCache, spawnWorker, type SpawnWorkerArgs } from "../src/lib/worker.js";
import { gitWorkTreeAncestor } from "../src/lib/worker-home.js";

const REPO_ROOT = join(import.meta.dirname, "..");
const NOW = Date.parse("2026-10-10T12:00:00.000Z");
const MIN = 60_000;
const MIB = 1024 * 1024;
const PRIORITY = HOST_MEMORY_PRIORITY_PROPOSAL;

const POLICY: HostMemoryBudgetPolicy = {
  mode: "shadow",
  hostReserveMib: 2048,
  containerReserveMib: 1024,
  swapInPagesPerSecMax: 256,
  psiSomeAvg10Max: 10,
  psiFullAvg10Max: 2,
  serveColdStartReserveMib: 7680,
  uncertaintyMarginMib: 256,
  daemonGrowthUnmeasuredMib: 1024,
  daemonGrowthMinSamples: 6,
  staleReadingMs: 600_000,
};

function entry(over: Partial<ShadowEntryInput> = {}): ShadowEntryInput {
  return {
    id: "start", owner: "here@c1", workerClass: "implement", estimateMib: 2048,
    estimateSource: { kind: "measured", samples: 12 }, status: "owned", walkComplete: true,
    resident: { mib: 0, complete: true }, ageMs: 1000, ...over,
  };
}

/**
 * Fully measured. Base headroom = MemAvailable - 200 growth. With the build counted, a 1024 MiB review leaves
 * 4300 - 2048 - 1024 = 1228 < 2048: it defers on unrealized reservations ALONE. With the build yielded it fits.
 */
function inputs(over: Partial<ShadowInputs> = {}): ShadowInputs {
  return {
    memAvailable: { mib: 4500 },
    swapIn: { pagesPerSec: 0 },
    psi: { someAvg10: 0, someAvg60: 0, fullAvg10: 0, fullAvg60: 0 },
    container: { currentMib: 3000, maxMib: 12_000 },
    ledger: { state: "present" },
    entries: [entry()],
    start: { reservationId: "start", workerClass: "implement", estimateMib: 2048 },
    daemonGrowth: [{ instance: "here", samples: 30, growthMib: 200 }],
    serve: { scenario: "serve-steady", basis: "serve.memory 60s ago" },
    ...over,
  };
}

function row(over: Partial<ObservedDemand> = {}): ObservedDemand {
  return {
    schema: 1, instance: "other", instanceHostUnique: true, eligible: 1, laneReady: 1,
    oldestEligibleSince: new Date(NOW - MIN).toISOString(), publishedAt: new Date(NOW - 30_000).toISOString(),
    refreshBoundMs: PRIORITY.demandRefreshBoundMs, stale: false, ageMs: 30_000, ...over,
  };
}

function demand(rows: ObservedDemand[]): ReviewDemandReading {
  return { state: "present", rows, unreadableRows: 0 };
}

function ctx(snapshot: ShadowInputs, rows: ObservedDemand[], over: Partial<YieldContext> = {}): YieldContext {
  return {
    start: { instance: "here", workerClass: snapshot.start.workerClass, waitingSinceMs: NOW },
    demand: demand(rows),
    reservations: snapshot.entries,
    reviewVerdict: (withStart) => counterfactualReviewVerdict(snapshot, POLICY, withStart),
    policy: PRIORITY,
    now: NOW,
    ...over,
  };
}

test("a build start would yield only to an eligible queued review that memory alone blocks and that the yield would make fit", () => {
  const snapshot = inputs();
  assert.equal(evaluateShadowMemory(snapshot, POLICY).wouldAdmit, true, "the build itself fits");
  assert.deepEqual(counterfactualReviewVerdict(snapshot, POLICY, true).reasons, ["unrealized-reservations"], "the review defers on memory alone");
  assert.equal(counterfactualReviewVerdict(snapshot, POLICY, false).wouldAdmit, true, "and fits once the build yields");
  const decision = wouldYieldToReview(ctx(snapshot, [row()]));
  assert.equal(decision.yield, true);
  assert.ok(decision.yield && decision.to.instance === "other" && decision.reviewReasons.includes("unrealized-reservations"));

  // Every refusal arm, each named.
  const why = (c: YieldContext): string => {
    const d = wouldYieldToReview(c);
    return d.yield ? "yield" : d.why;
  };
  assert.equal(why(ctx(inputs({ memAvailable: { mib: 8192 } }), [row()])), "review-fits", "a review memory does not block");
  assert.equal(why(ctx(inputs({ memAvailable: { mib: 3000 } }), [row()])), "yield-would-not-fit", "the yield must make it fit");
  const review = inputs({ start: { reservationId: "start", workerClass: "review", estimateMib: 1024 } });
  assert.equal(why(ctx(review, [row()])), "start-is-review");
  assert.equal(why(ctx(snapshot, [row({ instance: "other", laneReady: 0 })])), "review-lane-busy", "a review waiting on a lane");
  const started = inputs({ entries: [entry(), entry({ id: "rv", owner: "other@c2", workerClass: "review", ageMs: 5_000 })] });
  assert.equal(why(ctx(started, [row()])), "review-started", "a review opened since its demand row is no longer queued");
});

test("with no eligible review it would not yield", () => {
  assert.equal(wouldYieldToReview(ctx(inputs(), [])).yield, false);
  const none = wouldYieldToReview(ctx(inputs(), [row({ eligible: 0, laneReady: 0, oldestEligibleSince: null })]));
  assert.deepEqual(none, { yield: false, why: "no-eligible-review" });
  const missing = wouldYieldToReview(ctx(inputs(), [], { demand: { state: "missing", rows: [], unreadableRows: 0 } }));
  assert.deepEqual(missing, { yield: false, why: "no-eligible-review" });
});

test("with a stale demand row it would not yield, and the stale row is kept, not deleted", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-review-demand-"));
  try {
    const location = () => ({ dir, scope: "host" as const });
    const instance = () => ({ name: "other", hostUnique: true });
    const published = publishReviewDemand({ eligible: 2, laneReady: 1, oldestEligibleSince: new Date(NOW - MIN).toISOString() },
      { location, instance, clock: fixedClock(NOW), root: "/r/other" });
    assert.equal(published?.eligible, 2);
    const fresh = readReviewDemand({ location, clock: fixedClock(NOW + MIN) });
    assert.equal(fresh.rows.length, 1);
    assert.equal(fresh.rows[0]!.stale, false);
    assert.equal(wouldYieldToReview(ctx(inputs(), [], { demand: fresh, now: NOW + MIN })).yield, true, "positive control");
    const later = NOW + PRIORITY.demandRefreshBoundMs + MIN;
    const stale = readReviewDemand({ location, clock: fixedClock(later) });
    assert.equal(stale.rows.length, 1, "a stale row is not deleted");
    assert.equal(stale.rows[0]!.stale, true);
    const decision = wouldYieldToReview(ctx(inputs(), [], { demand: stale, now: later }));
    assert.equal(decision.yield === false && decision.why, "demand-stale");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("with a review blocked by something else it would not yield", () => {
  const swapping = inputs({ swapIn: { pagesPerSec: 5_000 } });
  const decision = wouldYieldToReview(ctx(swapping, [row()]));
  assert.equal(decision.yield === false && decision.why, "review-blocked-by-other");
  assert.equal(decision.yield === false && decision.detail, "swap-in");
  const pressured = wouldYieldToReview(ctx(inputs({ psi: { someAvg10: 50, someAvg60: 40 } }), [row()]));
  assert.equal(pressured.yield === false && pressured.why, "review-blocked-by-other");
});

test("aging lets an older implement demand outrank a newer review", () => {
  const review: WaitingDemand = { instance: "other", workerClass: "review", waitingSinceMs: NOW - MIN };
  const fresh: WaitingDemand = { instance: "here", workerClass: "implement", waitingSinceMs: NOW };
  const old: WaitingDemand = { instance: "here", workerClass: "implement", waitingSinceMs: NOW - 120 * MIN };
  assert.ok(priorityScore(review, PRIORITY, NOW) > priorityScore(fresh, PRIORITY, NOW), "review outranks an equally new build");
  assert.deepEqual(rankDemand([review, old], PRIORITY, NOW)[0], old, "an older implement outranks a newer review");
  const aged = wouldYieldToReview(ctx(inputs(), [row()], { start: old }));
  assert.equal(aged.yield === false && aged.why, "start-outranks-review");
  const noAging: HostMemoryPriorityPolicy = { ...PRIORITY, agingPerMinute: 0 };
  assert.equal(wouldYieldToReview(ctx(inputs(), [row()], { start: old, policy: noAging })).yield, true,
    "without aging the old build would wait forever");
});

test("no instance's demand is overtaken indefinitely in a long mixed sequence", () => {
  const classes: Record<string, WorkerClass> = { a: "implement", b: "fix", c: "review", d: "review" };
  const run = (policy: HostMemoryPriorityPolicy, steps: number): Record<string, number> => {
    // Every instance always has a next demand; one is served per minute; a served instance's next demand waits anew.
    const heads = new Map(Object.entries(classes).map(([instance, workerClass]) =>
      [instance, { instance, workerClass, waitingSinceMs: NOW }]));
    const longest: Record<string, number> = Object.fromEntries(Object.keys(classes).map((k) => [k, 0]));
    for (let t = 1; t <= steps; t += 1) {
      const at = NOW + t * MIN;
      const top = rankDemand([...heads.values()], policy, at)[0]!;
      longest[top.instance] = Math.max(longest[top.instance]!, (at - top.waitingSinceMs) / MIN);
      heads.set(top.instance, { ...top, waitingSinceMs: at });
    }
    const end = NOW + steps * MIN;
    for (const head of heads.values()) longest[head.instance] = Math.max(longest[head.instance]!, (end - head.waitingSinceMs) / MIN);
    return longest;
  };
  const aged = run(PRIORITY, 600);
  for (const [instance, minutes] of Object.entries(aged)) {
    assert.ok(minutes < 120, `${instance} waited at most ${minutes} min across 600 mixed steps`);
  }
  const unaged = run({ ...PRIORITY, agingPerMinute: 0 }, 600);
  assert.equal(unaged.a, 600, "the falsifier: without aging the implement instance is overtaken for the whole sequence");
});

// ── the recorder end to end ──────────────────────────────────────────────────────────────────────────────────────

function enoent(path: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`ENOENT: no such file, open '${path}'`), { code: "ENOENT" });
}

function files(memAvailableMib: number, extra: Record<string, string> = {}): (path: string) => string {
  const table: Record<string, string> = {
    "/proc/meminfo": `MemTotal: 16400000 kB\nMemAvailable: ${memAvailableMib * 1024} kB\n`,
    "/proc/vmstat": "pgpgin 1\npswpin 100\npswpout 4\n",
    "/proc/pressure/memory": "some avg10=0.00 avg60=0.00 avg300=0.00 total=1\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=1\n",
    "/sys/fs/cgroup/memory.current": `${3000 * MIB}\n`,
    "/sys/fs/cgroup/memory.max": `${12_000 * MIB}\n`,
    "/sys/fs/cgroup/memory.swap.current": "0\n",
    "/sys/fs/cgroup/memory.stat": "anon 1\nfile 1\n",
    "/sys/fs/cgroup/memory.events": "low 0\nhigh 0\nmax 0\noom 0\noom_kill 0\n",
    ...extra,
  };
  return (path) => {
    const text = table[path];
    if (text === undefined) throw enoent(path);
    return text;
  };
}

function reading(entries: Array<Partial<ReadingEntry>>): HostMemoryReading {
  const full = entries.map((e, i): ReadingEntry => ({
    id: `r${i}`, owner: "here@c1", workerClass: "implement", estimateMib: 2048,
    estimateSource: { kind: "measured", samples: 9 }, status: "owned", ageMs: 1000, sinceVerifiedMs: 1000,
    walkComplete: true, path: `/ledger/r${i}.json`, ...e,
  }));
  return {
    state: "present", scope: "host", dir: "/ledger", entries: full,
    counts: { live: full.length, uncertain: 0, incompleteWalk: 0, localScope: 0, unreadable: 0 },
    reservedMib: full.reduce((sum, e) => sum + e.estimateMib, 0),
  };
}

function tail(at: number, serve = "serve.memory"): string {
  const alive = (ms: number, rssMib: number) =>
    JSON.stringify({ ts: new Date(ms).toISOString(), step: "daemon.alive", rss_bytes: rssMib * MIB, vm_swap_bytes: 0 });
  return [...Array(8).keys()].map((i) => alive(at - (8 - i) * MIN, 4000 + (i === 3 ? 300 : 0)))
    .concat(JSON.stringify({ ts: new Date(at - MIN).toISOString(), step: serve })).join("\n");
}

/** Snapshot: 5000 MiB available, 300 MiB growth. The build (2048) fits; a review beside it does not; alone it does. */
function ports(at: number, over: Partial<ShadowMemoryPorts> & { rows?: LedgerLine[]; reviewSince?: number } = {}): Partial<ShadowMemoryPorts> {
  const rows = over.rows ?? [];
  const since = over.reviewSince ?? at - MIN;
  return {
    clock: fixedClock(at),
    readFile: files(5000),
    readTail: () => tail(at),
    readLedger: () => reading([{ id: "start" }]),
    policy: () => POLICY,
    write: (_path, line) => void rows.push(line),
    stderr: () => undefined,
    readReviewDemand: () => demand([row({ oldestEligibleSince: new Date(since).toISOString(), publishedAt: new Date(at - 30_000).toISOString() })]),
    priorityPolicy: () => PRIORITY,
    ...over,
  };
}

const START = { runId: "run-x", taskId: "W1-T7095", workerClass: "implement" as const, reservationId: "start", root: "/state/here" };

test("the shadow verdict consults the priority rule: a yield is recorded as would-yield-to-review, and waits age per instance", () => {
  resetShadowMemoryStateForTests();
  try {
    const rows: LedgerLine[] = [];
    const decisions: Array<{ yield: boolean; why?: string; wait: number }> = [];
    for (let i = 0; i < 20; i += 1) {
      const at = NOW + i * 5 * MIN;
      const outcome = recordShadowMemoryVerdict(START, ports(at, { rows }));
      assert.equal(outcome.kind, "recorded");
      const shadow = rows.filter((r) => r.step === "memory_budget.shadow").at(-1)!;
      const priority = shadow.review_priority as { yield: boolean; why?: string };
      decisions.push({ yield: priority.yield, why: priority.why, wait: shadow.would_wait_ms as number });
      if (priority.yield) assert.ok((shadow.reasons as string[]).includes("would-yield-to-review"));
    }
    assert.equal(decisions[0]!.yield, true, "a fresh build yields to the queued review");
    const outranked = decisions.findIndex((d) => d.why === "start-outranks-review");
    assert.ok(outranked > 0 && outranked <= 10, `the waiting build outranks the newer review after aging (step ${outranked})`);
    assert.ok(decisions[outranked - 1]!.wait > 0, "the would-be wait accumulated across the yields");
  } finally {
    resetShadowMemoryStateForTests();
  }
});

test("routine deferrals collapse to one summary row per class, instance and reason and never escalate", () => {
  resetShadowMemoryStateForTests();
  resetHostMemoryPriorityStateForTests();
  try {
    const rows: LedgerLine[] = [];
    const pressured = files(8192, { "/proc/pressure/memory": "some avg10=50.00 avg60=40.00 avg300=1 total=1\n" });
    for (let i = 0; i < 40; i += 1) {
      const workerClass: WorkerClass = i % 2 === 0 ? "implement" : "fix";
      recordShadowMemoryVerdict({ ...START, workerClass }, ports(NOW + i * MIN, { rows, readFile: pressured, readReviewDemand: () => demand([]) }));
    }
    const summaries = rows.filter((r) => r.step === "memory_budget.deferral_summary");
    assert.deepEqual(summaries.map((r) => [r.worker_class, r.instance, r.reason]).sort(),
      [["fix", "here", "psi"], ["implement", "here", "psi"]], "one row per class, instance and reason");
    assert.ok(summaries.every((r) => r.owner === "machine" && r.escalate === false));
    assert.equal(rows.filter((r) => r.step === "memory_budget.shadow").length, 40, "every verdict is still recorded");
    const report = shadowDeferralReport();
    assert.deepEqual(report.map((r) => r.count).sort(), [20, 20], "the queryable report keeps the full count");
    assert.ok(report.every((r) => typeof r.waitMs.p50 === "number" && r.waitMs.max >= r.waitMs.p50), "the wait distribution");
    assert.equal(rows.filter((r) => r.step === "memory_budget.capacity_decision").length, 0);
    assert.deepEqual(takeCapacityDecisions(), [], "a routine deferral never becomes a human decision");
  } finally {
    resetShadowMemoryStateForTests();
    resetHostMemoryPriorityStateForTests();
  }
});

function prView(n: number): OpenPrView {
  return {
    prNumber: n, prUrl: `https://github.com/o/r/pull/${n}`, taskId: `W1-T${n}`, reviewState: "none", checksState: "green",
    unmetCriteria: [], priorStrikes: 0, lastActivityAt: "2026-10-10T11:00:00Z", headSha: `head${n}`, autoMergeArmed: false,
  };
}

test("a sustained zero-worker shortfall raises exactly one deduplicated decision per scenario", () => {
  resetShadowMemoryStateForTests();
  resetHostMemoryPriorityStateForTests();
  const dir = mkdtempSync(join(tmpdir(), "rmd-review-demand-"));
  try {
    const rows: LedgerLine[] = [];
    // 600 MiB available: even with zero workers the host is short of its 2048 MiB reserve.
    const short = (at: number, serve: string) =>
      ports(at, { rows, readFile: files(600), readTail: () => tail(at, serve), readReviewDemand: () => demand([]) });
    const below = PRIORITY.zeroWorkerShortfallSamples - 1;
    for (let i = 0; i < below; i += 1) recordShadowMemoryVerdict(START, short(NOW + i * MIN, "serve.memory"));
    assert.equal(rows.filter((r) => r.step === "memory_budget.capacity_decision").length, 0, "not yet sustained");
    for (let i = below; i < 30; i += 1) recordShadowMemoryVerdict(START, short(NOW + i * MIN, "serve.memory"));
    for (let i = 30; i < 60; i += 1) recordShadowMemoryVerdict(START, short(NOW + i * MIN, "serve.stop"));
    const raised = rows.filter((r) => r.step === "memory_budget.capacity_decision");
    assert.deepEqual(raised.map((r) => r.scenario), ["serve-steady", "serve-stopped"], "one per scenario");

    // The sweep drains the queue through its escalation path, once.
    const escalated: CapacityDecision[] = [];
    const deps = {
      ledgerPath: join(dir, "root", "state", "ledger.jsonl"),
      runId: "sweep-x",
      reviewDemand: { location: () => ({ dir, scope: "host" as const }), clock: fixedClock(NOW) },
      escalateMemoryCapacity: (d: CapacityDecision) => {
        escalated.push(d);
        return "https://github.com/o/r/issues/1";
      },
    };
    publishLightPassReviewDemand([], [], DEFAULT_SWEEP_POLICY, NOW, { delivered: new Map(), refused: new Map(), retryableThrows: new Map(), freshnessBackoffs: new Set() } as never, deps);
    publishLightPassReviewDemand([], [], DEFAULT_SWEEP_POLICY, NOW, { delivered: new Map(), refused: new Map(), retryableThrows: new Map(), freshnessBackoffs: new Set() } as never, deps);
    assert.deepEqual(escalated.map((d) => d.scenario), ["serve-steady", "serve-stopped"], "exactly one escalation per scenario");
    const text = capacityDecisionText(escalated[0]!);
    assert.match(text.detail, /\d+(\.\d+)? GB short/);
    assert.deepEqual(text.options.map((o) => o.label), [...escalated[0]!.levers]);
    assert.equal(text.options.length, 3, "a smaller baseline, less concurrency, more RAM");
    assert.ok(!text.options.some((o) => o.label === text.recommendation), "it never chooses a lever");
  } finally {
    resetShadowMemoryStateForTests();
    resetHostMemoryPriorityStateForTests();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the sweep publishes its eligible review demand", () => {
  resetHostMemoryPriorityStateForTests();
  const dir = mkdtempSync(join(tmpdir(), "rmd-review-demand-"));
  try {
    const location = () => ({ dir, scope: "host" as const });
    const outcomes = { delivered: new Map(), refused: new Map(), retryableThrows: new Map(), freshnessBackoffs: new Set() } as never;
    const base = { ledgerPath: join(dir, "here", "state", "ledger.jsonl"), runId: "sweep-x" };
    publishLightPassReviewDemand([prView(1), prView(2)], [prView(1)], DEFAULT_SWEEP_POLICY, NOW, outcomes,
      { ...base, dryRun: true, reviewDemand: { location, clock: fixedClock(NOW) } });
    assert.equal(readReviewDemand({ location, clock: fixedClock(NOW) }).state, "missing", "a dry run writes nothing");
    publishLightPassReviewDemand([prView(1), prView(2)], [prView(1)], DEFAULT_SWEEP_POLICY, NOW, outcomes,
      { ...base, reviewDemand: { location, clock: fixedClock(NOW), instance: () => ({ name: "here", hostUnique: false }) } });
    const published = readReviewDemand({ location, clock: fixedClock(NOW + MIN) });
    assert.equal(published.rows.length, 1);
    const r = published.rows[0]!;
    assert.deepEqual([r.instance, r.eligible, r.laneReady, r.oldestEligibleSince, r.stale], ["here", 2, 1, new Date(NOW).toISOString(), false]);
  } finally {
    resetHostMemoryPriorityStateForTests();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── no real start is delayed or reordered ───────────────────────────────────────────────────────────────────────

function fixtureRoot(prefix: string): string {
  const parent = [tmpdir(), dirname(REPO_ROOT)].find((candidate) => gitWorkTreeAncestor(candidate) === undefined);
  assert.ok(parent, "the test host must provide a scratch parent outside every Git work tree");
  return mkdtempSync(join(parent, prefix));
}

async function startWorker(root: string, memoryShadow: Partial<ShadowMemoryPorts>): Promise<{ queried: number; result: unknown }> {
  let queried = 0;
  const result = await spawnWorker({
    cwd: root,
    permissionMode: "bypassPermissions" as const,
    settingsFile: join(REPO_ROOT, "settings", "worker.json"),
    prompt: "work",
    model: "claude-sonnet-4-6",
    effort: "high",
    runId: "run-priority",
    taskId: "W1-T7095",
    workerClass: "implement",
    config: { claudeBin: "/unused", root, dailyCapUsd: 20 } as never,
    providerRouting: {
      readClaudeHealth: async () => ({ degradedModels: [], source: "unknown", detail: "unread" }),
      readClaude: async () => ({ provider: "claude", readable: true, windows: [{ name: "claude weekly", usedPercent: 10, resetsAt: NOW / 1000 + 3600 }] }),
      writeStatus: () => {},
      now: () => NOW,
    },
    claudeExecutable: {
      cache: createClaudeExecutableCache(),
      deps: { env: { RMD_CLAUDE_BIN: "/fake/claude" }, home: root, exists: () => true, which: () => "/fake/claude", canExecute: () => true, locations: [] },
    },
    keychain: {
      platform: "linux" as const,
      readCredentialFile: () => JSON.stringify({ claudeAiOauth: { accessToken: "stub", expiresAt: 4_102_444_800_000 } }),
    },
    memoryShadow,
    queryFn: (() => {
      queried += 1;
      return (async function* () {
        yield { type: "result", subtype: "success", is_error: false, result: "done", session_id: "s", total_cost_usd: 0.25, num_turns: 3 };
      })();
    }) as never,
  } as SpawnWorkerArgs).catch((error: unknown) => error);
  return { queried, result };
}

test("no real start is delayed or reordered: a start that would yield starts exactly as one that would not", async () => {
  const root = fixtureRoot("rmd-review-priority-start-");
  try {
    const runs: Record<string, { queried: number; result: unknown; rows: LedgerLine[] }> = {};
    const cases: Record<string, Partial<ShadowMemoryPorts>> = {
      yield: {},
      none: { readReviewDemand: () => demand([]) },
    };
    for (const [name, over] of Object.entries(cases)) {
      resetShadowMemoryStateForTests();
      const rows: LedgerLine[] = [];
      const run = await startWorker(root, ports(NOW, { rows, readLedger: () => reading([]), ...over }));
      runs[name] = { ...run, rows };
    }
    const shadow = (name: string) => runs[name]!.rows.find((r) => r.step === "memory_budget.shadow")!;
    assert.equal(shadow("yield").would_yield_to_review, true, "the counterfactual says this start would have yielded");
    assert.equal(shadow("none").would_yield_to_review, false);
    for (const name of Object.keys(cases)) assert.equal(runs[name]!.queried, 1, `${name}: the worker started exactly once`);
    const shape = (r: unknown) => {
      const x = r as { isError: boolean; text: string; numTurns: number; subtype: string };
      return { isError: x.isError, text: x.text, numTurns: x.numTurns, subtype: x.subtype };
    };
    assert.deepEqual(shape(runs.yield!.result), shape(runs.none!.result), "the yield verdict changes nothing about the start");
    assert.deepEqual(shape(runs.yield!.result), { isError: false, text: "done", numTurns: 3, subtype: "success" });
  } finally {
    resetShadowMemoryStateForTests();
    rmSync(root, { recursive: true, force: true });
  }
});
