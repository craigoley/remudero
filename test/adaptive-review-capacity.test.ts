// W1-T2853 — adaptive review concurrency is earned from backlog + current capacity and sheds
// future admissions under direct host/provider/reviewer pressure. The pure controller fixtures
// pin the safety policy; the sweep fixtures prove both production review paths consume the
// selected width; the worker-boundary fixture pins finally-released whole-process occupancy.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  initialReviewCapacityState,
  readReviewHostObservation,
  reviewProviderObservation,
  selectAdaptiveReviewWidth,
  selectRuntimeReviewWidth,
  summarizeReviewSettlements,
  type ReviewCapacityObservation,
  type ReviewCapacityPolicy,
  type ReviewCapacityState,
} from "../src/lib/review-capacity.js";
import { writeProviderRoutingStatus, type ProviderRoutingStatus } from "../src/lib/provider-routing-status.js";
import {
  DEFAULT_SWEEP_POLICY,
  runSweep,
  runSweepLightPass,
  validateReviewCapacityPolicy,
  type OpenPrView,
  type SweepDeps,
} from "../src/lib/sweep.js";
import { activeWorkerCount, withWorkerOccupancy } from "../src/lib/worker.js";
import { buildSweepEffects } from "../src/run-task.js";

const POLICY: ReviewCapacityPolicy = {
  hostWorkerBudget: 4,
  workerMemoryReserveMib: 1536,
  healthyWindowSamples: 3,
  sampleCadenceMs: 60_000,
  telemetryCadenceMs: 300_000,
  cpuPsiLowPct: 5,
  cpuPsiHighPct: 20,
  memoryPsiLowPct: 5,
  memoryPsiHighPct: 15,
  providerAllowancePct: 2,
  settlementWindowMs: 1_800_000,
  unhealthySettlementThreshold: 2,
  minHealthySettlements: 1,
  latencyExpansionRatio: 2,
};

function healthy(nowMs: number, over: Partial<ReviewCapacityObservation> = {}): ReviewCapacityObservation {
  return {
    nowMs,
    queueDepth: 5,
    activeWorkers: 0,
    memAvailableMib: 4096,
    cpuPsiSomeAvg10Pct: 1,
    memoryPsiSomeAvg10Pct: 1,
    provider: { fresh: true, readable: true, headroomPct: 80, reservePct: 5, ageMs: 1000 },
    settlements: { successes: 2, failures: 0, timeouts: 0 },
    ...over,
  };
}

function decide(
  state: ReviewCapacityState,
  observation: ReviewCapacityObservation,
): ReturnType<typeof selectAdaptiveReviewWidth> {
  return selectAdaptiveReviewWidth(state, POLICY, observation, { baseWidth: 2, minWidth: 1, maxWidth: 3 });
}

test("sustained healthy backlog earns lane 3, not one lucky sample", () => {
  let state = initialReviewCapacityState(2);
  let result = decide(state, healthy(0));
  assert.equal(result.decision.effectiveWidth, 2);
  state = result.state;
  result = decide(state, healthy(60_000));
  assert.equal(result.decision.effectiveWidth, 2);
  state = result.state;
  result = decide(state, healthy(120_000));
  assert.equal(result.decision.effectiveWidth, 3);
  assert.equal(result.decision.reason, "healthy-window");
  assert.equal(result.decision.evidence.healthySamples, 3);
});

test("the captured Azure pressure sample sheds an earned lane instead of expanding", () => {
  const state = initialReviewCapacityState(3);
  const result = decide(state, healthy(0, {
    activeWorkers: 2,
    memAvailableMib: 4268.28125,
    cpuPsiSomeAvg10Pct: 10.99,
    memoryPsiSomeAvg10Pct: 31.40,
  }));
  assert.equal(result.decision.effectiveWidth, 2);
  assert.equal(result.decision.reason, "memory-pressure");
});

test("direct pressure signals shed subsequent admissions without changing in-flight occupancy", () => {
  const pressured: Array<[string, Partial<ReviewCapacityObservation>, string]> = [
    ["cpu", { cpuPsiSomeAvg10Pct: 25 }, "cpu-pressure"],
    ["memory reserve", { memAvailableMib: 1000 }, "memory-reserve"],
    ["provider refusal", { provider: { fresh: true, readable: false, refused: true, ageMs: 10 } }, "provider-refused"],
    ["review failures", { settlements: { successes: 0, failures: 2, timeouts: 0 } }, "review-unhealthy"],
    [
      "review timeouts",
      { settlements: { successes: 0, failures: 0, timeouts: 2 } },
      "review-unhealthy",
    ],
    [
      "latency expansion",
      { settlements: { successes: 4, failures: 0, timeouts: 0, baselineLatencyMs: 100, recentLatencyMs: 250 } },
      "review-latency-expanded",
    ],
  ];
  for (const [label, over, reason] of pressured) {
    const result = decide(initialReviewCapacityState(2), healthy(0, { activeWorkers: 2, ...over }));
    assert.equal(result.decision.effectiveWidth, 1, label);
    assert.equal(result.decision.reason, reason, label);
    assert.equal(result.decision.evidence.activeWorkers, 2, `${label}: active work is observed, not cancelled`);
  }
});

test("missing/stale optional telemetry never authorises above base and does not collapse base", () => {
  const unavailable = healthy(0, {
    cpuPsiSomeAvg10Pct: undefined,
    memoryPsiSomeAvg10Pct: undefined,
    provider: { fresh: false, readable: false, ageMs: 120_000 },
    settlements: { successes: 0, failures: 0, timeouts: 0 },
  });
  assert.equal(decide(initialReviewCapacityState(2), unavailable).decision.effectiveWidth, 2);
  const earned = decide(initialReviewCapacityState(3), unavailable);
  assert.equal(earned.decision.effectiveWidth, 2);
  assert.equal(earned.decision.reason, "telemetry-unavailable");
});

test("host-worker budget and provider reserve plus allowance are scale-up prerequisites", () => {
  const crowded = decide(initialReviewCapacityState(2), healthy(0, { activeWorkers: 3 }));
  assert.equal(crowded.decision.effectiveWidth, 1, "three existing workers leave room for one new review only");
  assert.equal(crowded.decision.reason, "host-worker-budget");

  let state = initialReviewCapacityState(2);
  for (const nowMs of [0, 60_000, 120_000]) {
    state = decide(state, healthy(nowMs, { activeWorkers: 2 })).state;
  }
  assert.equal(state.effectiveWidth, 2, "2 active + 3 proposed exceeds the four-worker whole-process budget");

  state = initialReviewCapacityState(2);
  for (const nowMs of [0, 60_000, 120_000]) {
    state = decide(state, healthy(nowMs, {
      provider: { fresh: true, readable: true, headroomPct: 6, reservePct: 5, ageMs: 100 },
    })).state;
  }
  assert.equal(state.effectiveWidth, 2, "one point above reserve is below the two-point review allowance");
});

test("backlog, low-water pressure and settlement history independently refuse expansion", () => {
  const cases: Array<[string, Partial<ReviewCapacityObservation>, string]> = [
    ["queue already fits", { queueDepth: 2 }, "backlog-not-sustained"],
    ["cpu above low water", { cpuPsiSomeAvg10Pct: 6 }, "backlog-not-sustained"],
    ["memory above low water", { memoryPsiSomeAvg10Pct: 6 }, "backlog-not-sustained"],
    ["provider reserve", {
      provider: { fresh: true, readable: true, headroomPct: 6, reservePct: 5, ageMs: 100 },
    }, "provider-headroom"],
    ["insufficient settlements", {
      settlements: { successes: 0, failures: 0, timeouts: 0 },
    }, "review-history-insufficient"],
  ];
  for (const [label, over, reason] of cases) {
    const result = decide(initialReviewCapacityState(2), healthy(0, over));
    assert.equal(result.decision.effectiveWidth, 2, label);
    assert.equal(result.decision.reason, reason, label);
    assert.equal(result.decision.evidence.healthySamples, 0, label);
  }
});

test("decision telemetry fires on change and then only at the bounded periodic cadence", () => {
  let state = initialReviewCapacityState(2);
  let result = decide(state, healthy(0));
  assert.equal(result.decision.shouldLog, true);
  state = result.state;
  result = decide(state, healthy(60_000));
  assert.equal(result.decision.shouldLog, false);
  state = result.state;
  result = decide(state, healthy(120_000));
  assert.equal(result.decision.shouldLog, true, "width/reason change is logged immediately");
  state = result.state;
  result = decide(state, healthy(420_000));
  assert.equal(result.decision.shouldLog, true, "unchanged state is sampled once per telemetry cadence");
  assert.equal(typeof result.decision.evidence.memAvailableMib, "number");
  assert.equal(typeof result.decision.evidence.providerHeadroomPct, "number");
});

test("review-capacity policy rows are finite, bounded data", () => {
  const rows = Object.fromEntries(Object.entries(POLICY).map(([name, value]) => [name, { value, min: 0, max: Math.max(1, value * 10) }]));
  assert.deepEqual(validateReviewCapacityPolicy(rows), POLICY);
  assert.throws(
    () => validateReviewCapacityPolicy({ ...rows, cpuPsiLowPct: { value: 30, min: 0, max: 20 } }),
    /cpuPsiLowPct.*out of its declared bound/,
  );

  const invalid: Array<[string, unknown, RegExp]> = [
    ["top-level scalar", null, /must be a mapping/],
    ["missing row", { ...rows, hostWorkerBudget: undefined }, /hostWorkerBudget.*bounded numeric row/],
    ["non-numeric row", { ...rows, hostWorkerBudget: { value: "4", min: 1, max: 8 } }, /finite value\/min\/max/],
    ["inverted bound", { ...rows, hostWorkerBudget: { value: 4, min: 8, max: 1 } }, /min \(8\) > max \(1\)/],
    ["cpu watermarks", { ...rows, cpuPsiLowPct: { value: 20, min: 0, max: 30 } }, /PSI low watermarks/],
    ["memory watermarks", { ...rows, memoryPsiLowPct: { value: 15, min: 0, max: 30 } }, /PSI low watermarks/],
    ["non-integer worker budget", { ...rows, hostWorkerBudget: { value: 1.5, min: 1, max: 8 } }, /positive integer/],
    ["zero healthy samples", { ...rows, healthyWindowSamples: { value: 0, min: 0, max: 10 } }, /positive integer/],
    ["zero cadence", { ...rows, sampleCadenceMs: { value: 0, min: 0, max: 600000 } }, /cadence\/window values/],
    ["zero telemetry cadence", { ...rows, telemetryCadenceMs: { value: 0, min: 0, max: 600000 } }, /cadence\/window values/],
    ["zero settlement window", { ...rows, settlementWindowMs: { value: 0, min: 0, max: 3600000 } }, /cadence\/window values/],
    ["unit latency ratio", { ...rows, latencyExpansionRatio: { value: 1, min: 0, max: 10 } }, /greater than 1/],
  ];
  for (const [label, input, expected] of invalid) {
    assert.throws(() => validateReviewCapacityPolicy(input), expected, label);
  }
});

test("host PSI/memory readers preserve measured values and make failures explicit as absence", () => {
  const measured = readReviewHostObservation((target) => {
    if (target === "/proc/meminfo") return "MemTotal: 8000000 kB\nMemAvailable: 4370720 kB\n";
    if (target === "/sys/fs/cgroup/cpu.pressure") return "some avg10=10.99 avg60=1.00 avg300=1.00 total=10\n";
    if (target === "/sys/fs/cgroup/memory.pressure") return "some avg10=31.40 avg60=2.00 avg300=2.00 total=20\n";
    throw new Error(`unexpected ${target}`);
  });
  assert.deepEqual(measured, {
    memAvailableMib: 4370720 / 1024,
    cpuPsiSomeAvg10Pct: 10.99,
    memoryPsiSomeAvg10Pct: 31.40,
  });

  const unavailable = readReviewHostObservation(() => { throw new Error("unreadable"); });
  assert.deepEqual(unavailable, {});
});

test("provider projection uses the best fresh readable subscription and preserves refusal/staleness", () => {
  const fresh: ProviderRoutingStatus = {
    version: 1,
    state: "selected",
    freshness: "fresh",
    reservePercent: 5,
    observedAt: new Date(1_000).toISOString(),
    providers: [
      { provider: "claude", readable: true, windows: [{ name: "session", usedPercent: 80 }] },
      { provider: "codex", readable: true, windows: [{ name: "primary", usedPercent: 25 }] },
    ],
  };
  assert.deepEqual(reviewProviderObservation(fresh, 2_000), {
    fresh: true,
    readable: true,
    headroomPct: 75,
    reservePct: 5,
    ageMs: 1_000,
  });
  assert.deepEqual(reviewProviderObservation({ ...fresh, freshness: "stale" }, 2_000), {
    fresh: false,
    readable: false,
    ageMs: 1_000,
  });
  assert.equal(
    reviewProviderObservation({ ...fresh, state: "blocked", providers: [] }, 2_000).refused,
    true,
  );
});

test("review settlement fold derives failures, timeouts and recent-vs-baseline latency", () => {
  const at = (ms: number) => new Date(ms).toISOString();
  const lines: Array<Record<string, unknown>> = [];
  for (const [i, duration] of [100, 100, 250, 250].entries()) {
    const start = 1_000 + i * 1_000;
    lines.push({ step: "sweep.post_review.attempt", pr_number: i, head_sha: `sha${i}`, ts: at(start) });
    lines.push({ step: "sweep.post_review.done", pr_number: i, head_sha: `sha${i}`, ts: at(start + duration) });
  }
  lines.push({ step: "sweep.post_review.failed", pr_number: 9, head_sha: "sha9", ts: at(7_000), error: "timed out" });
  assert.deepEqual(summarizeReviewSettlements(lines, 10_000, 10_000), {
    successes: 4,
    failures: 1,
    timeouts: 1,
    baselineLatencyMs: 100,
    recentLatencyMs: 250,
  });
  assert.deepEqual(summarizeReviewSettlements(lines, 20_000, 1_000), {
    successes: 0,
    failures: 0,
    timeouts: 0,
  });
});

test("runtime adapter reads only the local provider snapshot/host telemetry and emits bounded evidence", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-review-runtime-"));
  const nowMs = Date.parse("2026-09-05T00:00:00Z");
  const capacity = {
    provider: "codex" as const,
    readable: true,
    windows: [{ name: "primary", usedPercent: 20, resetsAt: nowMs / 1000 + 3600 }],
  };
  writeProviderRoutingStatus(root, {
    state: "selected",
    enabledProviders: ["codex"],
    reservePercent: 5,
    observedAtMs: nowMs,
    cacheValidMs: 60_000,
    capacities: [capacity],
    selection: { provider: "codex", capacity, tightestRemainingPercent: 80 },
  });
  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const width = selectRuntimeReviewWidth({
    root,
    queueDepth: 4,
    activeWorkers: 0,
    nowMs,
    ledgerLines: [],
    policy: POLICY,
    baseWidth: 2,
    minWidth: 1,
    maxWidth: 3,
    log: (step, extra) => logs.push({ step, extra }),
  });
  assert.ok(width >= 1 && width <= 2, "one sample cannot earn lane 3; actual host pressure may shed to 1");
  assert.equal(logs.length, 1);
  assert.equal(logs[0]?.step, "review.capacity");
  assert.equal(logs[0]?.extra?.queue_depth, 4);
  assert.equal(logs[0]?.extra?.provider_headroom_pct, 80);
});

test("production buildSweepEffects wires the runtime controller at the real sweep boundary", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-review-effects-"));
  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const effects = buildSweepEffects(
    "acme",
    "adaptive-review-runtime",
    { root } as never,
    join(root, "state", "ledger.ndjson"),
    "ADAPTIVE-REVIEW-WIRING",
    { tasks: [] } as never,
    (step, extra) => logs.push({ step, extra }),
    DEFAULT_SWEEP_POLICY,
  );
  assert.equal(typeof effects.selectAdaptiveReviewWidth, "function");
  const width = effects.selectAdaptiveReviewWidth!({
    queueDepth: 4,
    nowMs: Date.parse("2026-09-05T00:00:00Z"),
    ledgerLines: [],
  });
  assert.ok(width >= DEFAULT_SWEEP_POLICY.reviewLaneMin);
  assert.ok(width <= DEFAULT_SWEEP_POLICY.reviewLanes, "unreadable provider telemetry cannot authorise lane three");
  assert.ok(logs.some((entry) => entry.step === "review.capacity"));
});

function reviewablePr(n: number): OpenPrView {
  return {
    prNumber: n,
    prUrl: `url/${n}`,
    taskId: `W1-ADAPT-${n}`,
    reviewState: "none",
    checksState: "green",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: "2026-09-04T00:00:00Z",
    createdAt: `2026-09-0${n - 4000}T00:00:00Z`,
    headSha: `sha${n}`,
    autoMergeArmed: false,
  };
}

function sweepDeps(postReview: NonNullable<SweepDeps["postReview"]>): SweepDeps {
  return {
    arm: () => {},
    close: () => {},
    dispatchFix: () => {},
    escalate: () => {},
    ledgerPath: join(mkdtempSync(join(tmpdir(), "rmd-adaptive-review-")), "ledger.ndjson"),
    runId: "ADAPTIVE-REVIEW",
    now: () => Date.parse("2026-09-05T00:00:00Z"),
    postReview,
    selectAdaptiveReviewWidth: ({ queueDepth }) => {
      assert.equal(queueDepth, 3);
      return 3;
    },
  };
}

async function observedConcurrency(run: (deps: SweepDeps) => Promise<unknown>): Promise<number> {
  let inFlight = 0;
  let maxInFlight = 0;
  const deps = sweepDeps(async () => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise<void>((resolve) => setImmediate(resolve));
    inFlight -= 1;
  });
  await run(deps);
  return maxInFlight;
}

test("full and light/event review paths both consume the adaptive width", async () => {
  const prs = [reviewablePr(4001), reviewablePr(4002), reviewablePr(4003)];
  assert.equal(await observedConcurrency((deps) => runSweep(prs, deps, DEFAULT_SWEEP_POLICY)), 3);
  assert.equal(await observedConcurrency((deps) => runSweepLightPass(prs, deps, DEFAULT_SWEEP_POLICY)), 3);

  const source = readFileSync(fileURLToPath(new URL("../src/lib/sweep.ts", import.meta.url)), "utf8");
  assert.match(source, /selectAdaptiveReviewWidth\(/, "production sweep source must call the adaptive selector");
});

test("light/event review falls back to the bounded base width when adaptive selection fails", async () => {
  const prs = [reviewablePr(4001), reviewablePr(4002), reviewablePr(4003)];
  const posted: number[] = [];
  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const deps = sweepDeps(async (pr) => { posted.push(pr.prNumber); });
  deps.selectAdaptiveReviewWidth = () => { throw new Error("capacity snapshot unavailable"); };
  deps.log = (step, extra) => logs.push({ step, extra });

  await runSweepLightPass(prs, deps, DEFAULT_SWEEP_POLICY);

  assert.deepEqual(posted.sort((a, b) => a - b), [4001, 4002]);
  assert.deepEqual(logs.filter((entry) => entry.step === "review.capacity.selector_failed"), [{
    step: "review.capacity.selector_failed",
    extra: {
      queue_depth: 3,
      base_width: DEFAULT_SWEEP_POLICY.reviewLanes,
      error: "capacity snapshot unavailable",
    },
  }]);
});

test("whole-process worker occupancy releases on success, throw and cancellation", async () => {
  assert.equal(activeWorkerCount(), 0);
  let releaseSuccess!: () => void;
  const success = withWorkerOccupancy(() => new Promise<void>((resolve) => { releaseSuccess = resolve; }));
  assert.equal(activeWorkerCount(), 1);
  releaseSuccess();
  await success;
  assert.equal(activeWorkerCount(), 0);

  await assert.rejects(withWorkerOccupancy(async () => { throw new Error("boom"); }), /boom/);
  assert.equal(activeWorkerCount(), 0);

  const abort = new DOMException("cancelled", "AbortError");
  await assert.rejects(withWorkerOccupancy(() => Promise.reject(abort)), /cancelled/);
  assert.equal(activeWorkerCount(), 0);

  const source = readFileSync(fileURLToPath(new URL("../src/lib/worker.ts", import.meta.url)), "utf8");
  assert.match(
    source,
    /spawnWorker[\s\S]+const releaseWorkerOccupancy = claimWorkerOccupancy\(\)[\s\S]+finally \{[\s\S]+releaseWorkerOccupancy\(\)/,
    "every real provider spawn enters and finally releases the shared counter without an async wrapper",
  );
});
