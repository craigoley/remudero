import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setImmediate as drainMicrotasks } from "node:timers/promises";
import { runDaemon, type DaemonDeps } from "#src/lib/daemon.js";
import {
  cpuLaneBound,
  CPU_WEIGHTS_FILE,
  defaultLaneGovernorPorts,
  DISPATCH_LANE_CPU_CLASS,
  publishLaneCpuBound,
  publishedLaneCpuBound,
  publishedLaneCpuPerLane,
  readCgroupCpuUsageUsec,
  readCpuWeightShare,
  readLaneCpu,
  relabelLaneCpu,
  REVIEW_LANE_CPU_CLASS,
  type LaneGovernorPorts,
  initialLaneCpuLearner,
  laneCpuReading,
  laneTarget,
  learnLaneCpu,
  parseCpuUsageUsec,
  type LaneCpuLearnerState,
  type LaneTargetInputs,
  type RunningLane,
} from "#src/lib/lane-governor.js";
import {
  cpuPressureTier,
  cpuWeightShare,
  selectAdaptiveReviewWidth,
  selectRuntimeReviewWidth,
  type ReviewCapacityObservation,
  type ReviewCapacityPolicy,
  type ReviewCapacityState,
} from "#src/lib/review-capacity.js";
import { loadPlan } from "#src/lib/plan.js";
import { trackInFlightReview } from "#src/lib/sweep.js";
import type { RunResult } from "#src/lib/run-result.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

// W1-T11129 — the governor learns CPU from cgroup cpu.stat; review sheds on that and on PSI relative to its weight share.

const memory: LaneTargetInputs["memory"] = { unread: "test" };
const baseInputs = { inFlight: 1, memory, cpuCount: 8, previous: { target: 6 } } as const;

test("W1-T11129 criterion 1: the cpu bound is host cpus less the learned baseline over the per-lane median", () => {
  assert.equal(cpuLaneBound(8, { baselineCpus: 2, perLaneCpus: 1.5 }), 4);
  const result = laneTarget({ ...baseInputs, previous: { target: 6 }, cpu: { baselineCpus: 2, perLaneCpus: 1.5 } });
  assert.equal(result.target, 4);
  assert.equal(result.binding, "cpu");
});

test("W1-T11129 criterion 1: an unread or unlearned input keeps the cap at the cpu count", () => {
  for (const cpu of [undefined, { baselineCpus: null, perLaneCpus: 1 }, { baselineCpus: 1, perLaneCpus: null }, { baselineCpus: 1, perLaneCpus: 0 }]) {
    assert.equal(cpuLaneBound(8, cpu), null);
    const result = laneTarget({ ...baseInputs, previous: { target: 20 }, cpu });
    assert.equal(result.target, 8);
    assert.equal(result.binding, "cpu");
  }
});

const builds = (...ids: string[]): RunningLane[] => ids.map((id) => ({ id, cls: DISPATCH_LANE_CPU_CLASS }));
const reviews = (...ids: string[]): RunningLane[] => ids.map((id) => ({ id, cls: REVIEW_LANE_CPU_CLASS }));

test("W1-T11129 criterion 1: usage_usec deltas teach the baseline while idle and the per-lane figure while lanes run", () => {
  assert.equal(parseCpuUsageUsec("usage_usec 1234\nuser_usec 1\n"), 1234);
  assert.equal(parseCpuUsageUsec("user_usec 1\n"), null);
  let state: LaneCpuLearnerState = initialLaneCpuLearner();
  // Each call closes the interval on `lanes` (a lane start or end follows); relabel opens the next on the new set.
  const close = (atMs: number, usageUsec: number, lanes: RunningLane[]) => {
    state = learnLaneCpu(state, { atMs, usageUsec, lanes, closes: true });
  };
  close(0, 0, []);
  close(10_000, 20_000_000, []); // 2 CPUs of non-lane work
  state = relabelLaneCpu(state, builds("A", "B"));
  // 20 s long: 70 CPU-s over 20 s = 3.5 CPUs; less the 2 baseline, over 2 lanes.
  close(30_000, 90_000_000, builds("A", "B"));
  const reading = laneCpuReading(state, "implement");
  assert.equal(reading.baselineCpus, 2);
  assert.equal(reading.perLaneCpus, 0.75);
  assert.equal(laneCpuReading(state, "review").perLaneCpus, null);
  // A mixed-class interval, a backwards counter and an unlearned baseline teach nothing.
  const before = JSON.stringify(state.perClass);
  const mixed = [...builds("A"), ...reviews("R")];
  state = relabelLaneCpu(state, mixed);
  close(40_000, 190_000_000, mixed);
  close(50_000, 1, mixed);
  assert.equal(JSON.stringify(state.perClass), before);
  const fresh = learnLaneCpu(
    relabelLaneCpu(learnLaneCpu(initialLaneCpuLearner(), { atMs: 0, usageUsec: 0, lanes: [], closes: true }), builds("A")),
    { atMs: 1000, usageUsec: 5_000_000, lanes: builds("A"), closes: true },
  );
  assert.equal(fresh.idle.length, 0);
  assert.deepEqual(fresh.perClass, {});
});

test("W1-T11129 criterion 1: an interval is credited only to the lanes that ran through it", () => {
  let state: LaneCpuLearnerState = initialLaneCpuLearner();
  const sample = (atMs: number, usageUsec: number, lanes: RunningLane[], closes = false) => {
    state = learnLaneCpu(state, { atMs, usageUsec, lanes, closes });
  };
  sample(0, 0, [], true);
  sample(10_000, 10_000_000, [], true); // baseline: 1 CPU
  state = relabelLaneCpu(state, builds("A", "B"));
  // A plain reading on the same lanes extends the open interval: nothing is learned, nothing is re-anchored.
  const open = state;
  sample(15_000, 25_000_000, builds("A", "B"));
  assert.deepEqual(state, open);
  // A ends at 30 s: the sample BEFORE its removal credits the whole 20 s (3 CPUs) to both builds: 1 per lane.
  sample(30_000, 70_000_000, builds("A", "B"), true);
  assert.deepEqual(state.perClass, { implement: [1] });
  state = relabelLaneCpu(state, builds("B"));
  // A sample that finds lanes nobody sampled in (C started unseen) re-opens the interval there and teaches nothing,
  // and so does one taken AFTER a removal (the set it sees is not the set that ran).
  sample(40_000, 90_000_000, builds("B", "C"));
  assert.deepEqual(state.perClass, { implement: [1] });
  assert.equal(state.last?.atMs, 40_000);
  sample(50_000, 120_000_000, builds("C"), true);
  assert.deepEqual(state.perClass, { implement: [1] }, "B ended inside the interval: its CPU is lent to no one");
  assert.deepEqual(state.idle, [1]);
  // Ending the last lane: the interval is the build's, never the idle baseline's.
  state = relabelLaneCpu(state, builds("C"));
  sample(60_000, 140_000_000, builds("C"), true);
  assert.deepEqual(state.perClass, { implement: [1, 1] });
  assert.deepEqual(state.idle, [1], "a build that ran to the end of the interval never reads as idle");
});

const POLICY = {
  hostWorkerBudget: 8,
  workerMemoryReserveMib: 1536,
  healthyWindowSamples: 3,
  sampleCadenceMs: 60_000,
  telemetryCadenceMs: 300_000,
  cpuPsiLowPct: 5,
  memoryPsiLowPct: 5,
  memoryPsiHighPct: 15,
  providerAllowancePct: 2,
  latencyExpansionRatio: 2,
  unhealthySettlementThreshold: 2,
  minHealthySettlements: 1,
} as unknown as ReviewCapacityPolicy;
const BOUNDS = { minWidth: 1, baseWidth: 4, maxWidth: 5 };

function observation(over: Partial<ReviewCapacityObservation>): ReviewCapacityObservation {
  return {
    nowMs: 0,
    queueDepth: 10,
    activeWorkers: 0,
    memAvailableMib: 20_000,
    cpuPsiSomeAvg10Pct: 70,
    cpuPsiFullAvg10Pct: 0,
    memoryPsiSomeAvg10Pct: 0,
    settlements: { successes: 3, failures: 0, timeouts: 0 },
    provider: { fresh: true, readable: true, refused: false, headroomPct: 80, reservePct: 2 },
    ...over,
  } as ReviewCapacityObservation;
}

const run = (prior: ReviewCapacityState, over: Partial<ReviewCapacityObservation>) =>
  selectAdaptiveReviewWidth(prior, POLICY, observation(over), BOUNDS).decision;

test("W1-T11129 criterion 2: a PSI full that is only the low weight's own contention does not shed", () => {
  // The measured host: core's full 40 under some 70, its weight 59 against serve's 303 and a sibling's 59.
  const share = cpuWeightShare(59, [59, 303, 59]);
  assert.ok(share !== undefined && share < 0.2);
  const decision = run({ effectiveWidth: 4, healthySamples: 0 }, { cpuPsiFullAvg10Pct: 40, cpuWeightShare: share });
  assert.notEqual(decision.reason, "cpu-pressure");
  assert.equal(decision.effectiveWidth, 4);
  // The same reading with no weight excuse (a share of 1: the container is the whole host) is its own overload.
  assert.equal(run({ effectiveWidth: 4, healthySamples: 0 }, { cpuPsiFullAvg10Pct: 40, cpuWeightShare: 1 }).reason, "cpu-pressure");
});

test("W1-T11129 criterion 2: with the share known, the shed and its restore keep W1-T11150's one-lane cadence", () => {
  const prior: ReviewCapacityState = { effectiveWidth: 4, healthySamples: 2 };
  // The band just above the calm line neither sheds nor grows.
  const hold = run(prior, { cpuPsiFullAvg10Pct: 8, cpuPsiSomeAvg10Pct: 70, cpuWeightShare: 1 });
  assert.equal(hold.effectiveWidth, 4);
  assert.notEqual(hold.reason, "cpu-pressure");
  assert.equal(hold.evidence.healthySamples, 0);
  // Beyond it each overloaded sample sheds exactly one lane, however long the overload persists: no halving.
  let state = prior;
  const shed: number[] = [];
  for (let i = 0; i < 3; i++) {
    const step = selectAdaptiveReviewWidth(state, POLICY, observation({ nowMs: i * 1_000, cpuPsiFullAvg10Pct: 25, cpuWeightShare: 1 }), BOUNDS);
    assert.equal(step.decision.reason, "cpu-pressure");
    shed.push(step.decision.effectiveWidth);
    state = step.state;
  }
  assert.deepEqual(shed, [3, 2, 1]);
  // Relief restores in proportion (W1-T11150) at once, not one lane per calm window.
  const eased = selectAdaptiveReviewWidth(state, POLICY, observation({ nowMs: 3_000, cpuPsiFullAvg10Pct: 6, cpuWeightShare: 1 }), BOUNDS);
  assert.ok(eased.decision.effectiveWidth >= 3, `restored in proportion to relief, got ${eased.decision.effectiveWidth}`);
  assert.equal(cpuPressureTier({ cpuPsiFullAvg10Pct: 25, cpuPsiSomeAvg10Pct: 70, cpuWeightShare: 1 }, POLICY).tier, "shed");
  assert.equal(cpuPressureTier({ cpuPsiFullAvg10Pct: 8, cpuPsiSomeAvg10Pct: 70, cpuWeightShare: 1 }, POLICY).tier, "hold");
  assert.equal(cpuPressureTier({ cpuPsiSomeAvg10Pct: 70 }, POLICY).calm, false);
});

test("W1-T11129 criterion 2: the governor's learned cpu bound holds the width without stopping a lane", () => {
  const held = run({ effectiveWidth: 3, healthySamples: 2 }, { activeWorkers: 1, laneCpuBound: 4, cpuWeightShare: 1 });
  assert.equal(held.reason, "cpu-capacity-held");
  assert.equal(held.effectiveWidth, 3);
  assert.equal(held.evidence.healthySamples, 0);
  const room = run({ effectiveWidth: 3, healthySamples: 2 }, { activeWorkers: 1, laneCpuBound: 6, cpuWeightShare: 1 });
  assert.notEqual(room.reason, "cpu-capacity-held");
});

test("W1-T11129 criterion 2: width grows back on its own once the pressure eases", () => {
  let state: ReviewCapacityState = { effectiveWidth: 1, healthySamples: 0 };
  const stressed = selectAdaptiveReviewWidth(state, POLICY, observation({ cpuPsiFullAvg10Pct: 60, cpuWeightShare: 1 }), BOUNDS);
  assert.equal(stressed.decision.effectiveWidth, 1);
  state = stressed.state;
  const calm = selectAdaptiveReviewWidth(state, POLICY, observation({ cpuPsiFullAvg10Pct: 1, cpuWeightShare: 1 }), BOUNDS);
  assert.equal(calm.decision.effectiveWidth, 4);
  assert.notEqual(calm.decision.reason, "cpu-pressure");
});

test("W1-T11129 criterion 2: cpuWeightShare is the container's weight over the running total", () => {
  assert.equal(cpuWeightShare(100, [100, 300]), 0.25);
  assert.equal(cpuWeightShare(0, [100]), undefined);
  assert.equal(cpuWeightShare(100, []), undefined);
});

function cgroupDir(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-lane-cpu-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("W1-T11129 criterion 1: the real cpu.stat reader and readLaneCpu learn the bound the daemon hands laneTarget", (t) => {
  const dir = cgroupDir(t);
  const stat = join(dir, "cpu.stat");
  const write = (usageUsec: number) => writeFileSync(stat, `usage_usec ${usageUsec}\nuser_usec 1\nsystem_usec 1\n`);
  const ports: Pick<LaneGovernorPorts, "cpuCount" | "cpuUsageUsec"> = { cpuCount: () => 8, cpuUsageUsec: () => readCgroupCpuUsageUsec(stat) };
  // Idle twice (one CPU of non-lane work), then two implement lanes using three CPUs: 1 baseline + 1 per lane.
  write(0);
  let step = readLaneCpu(initialLaneCpuLearner(), ports, 0, []);
  write(1_000_000);
  step = readLaneCpu(step.learner, ports, 1_000, [], true); // two builds start: the idle interval closes
  assert.equal(step.bound, null, "no lane has run yet: unlearned, so the cap stays at the cpu count");
  write(4_000_000);
  step = readLaneCpu(relabelLaneCpu(step.learner, builds("A", "B")), ports, 2_000, builds("A", "B"), true);
  assert.deepEqual(step.cpu, { baselineCpus: 1, perLaneCpus: 1 });
  assert.equal(step.bound, 7, "(8 host cpus - 1 baseline) / 1 cpu per lane");
  const result = laneTarget({ ...baseInputs, previous: { target: 20 }, cpu: step.cpu });
  assert.equal(result.target, 7);
  assert.equal(result.binding, "cpu");
  // The real default port is the container's own cgroup file; off Linux it reads as unread, never a throw.
  const usage = defaultLaneGovernorPorts(join(dir, "state")).cpuUsageUsec!();
  assert.ok(usage === null || Number.isFinite(usage));
});

test("W1-T11129 criterion 1: runDaemon samples cpu.stat on each lane-target reading and publishes the learned bound", async (t) => {
  const dir = cgroupDir(t);
  const planFile = join(dir, "tasks.yaml");
  writeFileSync(planFile, "- id: A\n  title: A\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n  files: [src/A.ts]\n");
  let calls = 0;
  const ports: LaneGovernorPorts = {
    mode: () => "shadow",
    read: () => { throw new Error("memory unread in this test"); },
    cpuCount: () => 8,
    cpuUsageUsec: () => { calls += 1; return calls * 1_000_000; },
  };
  publishLaneCpuBound(5);
  const merged = new Set<string>();
  const clock = { ms: Date.parse("2026-11-04T00:00:00Z") };
  await runDaemon(loadPlan(planFile), {
    refreshMerged: () => (id: string) => merged.has(id),
    log: () => {},
    runOne: async (id: string) => { merged.add(id); return { taskId: id, merged: true, verdict: "merged", costUsd: 0, prUrl: "https://x" } as unknown as RunResult; },
    sleep: async () => {},
    now: () => new Date((clock.ms += 1_000)),
    laneGovernor: ports,
  } as unknown as DaemonDeps, { max: 1, laneCount: 2, pollIntervalMs: 1000 });
  assert.ok(calls >= 1, "the production lane-target reading consulted the cgroup cpu counter");
  assert.equal(publishedLaneCpuBound(), undefined, "a reading that learned nothing publishes no bound, replacing the stale one");
});

test("W1-T11129 criterion 1: in runDaemon, a build that ends inside an interval lends its CPU to no lane that remains", async (t) => {
  const dir = cgroupDir(t);
  const planFile = join(dir, "tasks.yaml");
  const task = (id: string) => `- id: ${id}\n  title: ${id}\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n  files: [src/${id}.ts]\n`;
  writeFileSync(planFile, task("A") + task("B") + task("C"));
  // The container's real CPU, integrated over the test's clock: 1 CPU of non-lane work plus 1 CPU per build running.
  // A build's CPU starts when its worker is called and stops when the test ends it, exactly as a child's would.
  const clock = { ms: Date.parse("2026-11-04T00:00:00Z") };
  let usageUsec = 0, buildsRunning = 0, accruedAtMs = clock.ms;
  const accrue = () => { usageUsec += (clock.ms - accruedAtMs) * 1000 * (1 + buildsRunning); accruedAtMs = clock.ms; };
  const advance = (ms: number) => { accrue(); clock.ms += ms; accrue(); };
  const ports: LaneGovernorPorts = {
    mode: () => "shadow",
    read: () => { throw new Error("memory unread in this test"); },
    cpuCount: () => 8,
    cpuUsageUsec: () => { accrue(); return usageUsec; },
  };
  const release: Record<string, (r: RunResult) => void> = {};
  const started: string[] = [];
  const merged = new Set<string>();
  const end = async (id: string) => {
    accrue();
    buildsRunning -= 1;
    release[id]!({ taskId: id, merged: true, verdict: "merged", costUsd: 0, prUrl: `https://x/${id}` } as unknown as RunResult);
    for (let i = 0; i < 20; i++) await drainMicrotasks();
  };
  publishLaneCpuBound(null);
  t.after(() => publishLaneCpuBound(null));
  const run = runDaemon(loadPlan(planFile), {
    refreshMerged: () => (id: string) => merged.has(id),
    log: () => {},
    runOne: (id: string) => {
      accrue();
      buildsRunning += 1;
      started.push(id);
      return new Promise<RunResult>((resolve) => { release[id] = resolve; }).then((r) => { merged.add(id); return r; });
    },
    // Every admission reads this first: a minute of idle host passes before each build is admitted.
    categorizedRefusalRejoinFor: () => { advance(60_000); return undefined; },
    sleep: async () => {},
    now: () => new Date(clock.ms),
    laneGovernor: ports,
  } as unknown as DaemonDeps, { max: 3, laneCount: 2, pollIntervalMs: 1000 });
  for (let i = 0; i < 50 && started.length < 2; i++) await drainMicrotasks();
  assert.deepEqual(started, ["A", "B"]);
  // A and B both run for 100 s (3 CPUs in all), then A ends while B runs on.
  advance(100_000);
  await end("A");
  assert.equal(publishedLaneCpuBound(), 7,
    "the 100 s A and B ran together are credited to both: 1 CPU per build, so (8 - 1 baseline) / 1; crediting them to " +
    "the one build left after the refill would read 2 per build and a bound of 3");
  for (let i = 0; i < 50 && started.length < 3; i++) await drainMicrotasks();
  assert.deepEqual(started, ["A", "B", "C"], "A's freed lane refilled with C");
  advance(50_000);
  await end("B");
  advance(20_000);
  await end("C");
  const summary = await run;
  assert.equal(summary.stopReason, "max_reached");
  assert.equal(publishedLaneCpuBound(), 7, "every interval, the last lane's included, learned 1 CPU per build");
});

test("W1-T11129 criterion 2: an unread weight share holds: no fixed PSI line sheds", () => {
  const prior: ReviewCapacityState = { effectiveWidth: 4, healthySamples: 2 };
  // The 2026-10-27 readings (core's full of 36-44) and beyond, with no share read: held at width 4, never shed to 1.
  for (const full of [20, 40, 90]) {
    const held = run(prior, { cpuPsiFullAvg10Pct: full });
    assert.notEqual(held.reason, "cpu-pressure", `full ${full} with no share is not a shed`);
    assert.equal(held.effectiveWidth, 4);
    assert.equal(held.evidence.healthySamples, 0, "a hold, not calm: the width does not grow on it either");
    assert.equal(cpuPressureTier({ cpuPsiFullAvg10Pct: full, cpuPsiSomeAvg10Pct: 70 }, POLICY).tier, "hold");
  }
  // With the share known, calm is the low watermark: recovery keeps its line.
  assert.equal(cpuPressureTier({ cpuPsiFullAvg10Pct: 5, cpuPsiSomeAvg10Pct: 70, cpuWeightShare: 1 }, POLICY).calm, true);
  // A stale record reads as no share (readCpuWeightShare's own suite below), so it holds the same way.
  // The same reading with the share known judges by the share: a share of 1 has no weight excuse and sheds.
  assert.equal(run(prior, { cpuPsiFullAvg10Pct: 40, cpuWeightShare: 1 }).reason, "cpu-pressure");
});

test("W1-T11129 criterion 2: an unread share holds the other way too: a quiet PSI adds no lane", () => {
  // The reviewer's case: no share read, PSI full 0, a healthy backlog that would earn lane 5 of a 4-lane base.
  let state: ReviewCapacityState = { effectiveWidth: 4, healthySamples: 0 };
  const widths: number[] = [];
  for (let i = 0; i < 6; i++) {
    const step = selectAdaptiveReviewWidth(state, POLICY, observation({ nowMs: i * 60_000, cpuPsiFullAvg10Pct: 0 }), BOUNDS);
    widths.push(step.decision.effectiveWidth);
    state = step.state;
  }
  assert.deepEqual(widths, [4, 4, 4, 4, 4, 4], "held at its width: PSI with no share is no evidence to widen on");
  assert.equal(cpuPressureTier({ cpuPsiFullAvg10Pct: 0, cpuPsiSomeAvg10Pct: 70 }, POLICY).calm, false);
  // The same quiet host with the share known is calm, and the healthy window widens as it always did.
  state = { effectiveWidth: 4, healthySamples: 0 };
  for (let i = 0; i < 6; i++) {
    state = selectAdaptiveReviewWidth(state, POLICY, observation({ nowMs: i * 60_000, cpuPsiFullAvg10Pct: 0, cpuWeightShare: 1 }), BOUNDS).state;
  }
  assert.equal(state.effectiveWidth, 5);
});

test("W1-T11129 criterion 2: W1-T11150's relief replay keeps its widths with a learned share, readings unchanged", () => {
  // W1-T11150's own fixture and sequence (a-review-shed-that-does-not-lower-pressure-stops-shedding), plus only a share.
  const policy = { ...POLICY, hostWorkerBudget: 16, settlementWindowMs: 1_800_000 } as ReviewCapacityPolicy;
  const bounds = { minWidth: 1, baseWidth: 4, maxWidth: 4 };
  let state: ReviewCapacityState = { effectiveWidth: 4, healthySamples: 0 };
  const widths: number[] = [];
  for (const [at, full] of [[0, 25], [5_000, 25], [10_000, 25], [20_000, 19], [30_000, 12], [40_000, 6]] as const) {
    const step = selectAdaptiveReviewWidth(state, policy, {
      nowMs: 1_000_000 + at, memAvailableMib: 28_000, cpuPsiSomeAvg10Pct: 80, cpuPsiFullAvg10Pct: full, cpuWeightShare: 0.8125,
      memoryPsiSomeAvg10Pct: 0, activeWorkers: 0, queueDepth: 9, hostLoad1: 40, hostCpuCount: 8,
      settlements: { failures: 0, timeouts: 0, successes: 5, cpuPhaseMs: 60_000 },
      provider: { fresh: true, readable: true, refused: false, headroomPct: 80, reservePct: 5 },
    } as unknown as ReviewCapacityObservation, bounds);
    widths.push(step.decision.effectiveWidth);
    state = step.state;
  }
  assert.deepEqual(widths, [3, 2, 1, 2, 3, 4], "one lane per overloaded sample, restored in proportion to relief");
});

test("W1-T11129 criterion 2: the shed reads the governor's learned cpu bound, one lane a sample, share or no share", () => {
  for (const share of [1, undefined]) {
    // Two builds run and the governor has learned room for four lanes: a width of 4 is two past it.
    let state: ReviewCapacityState = { effectiveWidth: 4, healthySamples: 2 };
    const steps: Array<[number, string]> = [];
    for (let i = 0; i < 4; i++) {
      const step = selectAdaptiveReviewWidth(state, POLICY, observation({
        nowMs: i * 60_000, activeWorkers: 2, laneCpuBound: 4, cpuPsiFullAvg10Pct: 0, ...(share === undefined ? {} : { cpuWeightShare: share }),
      }), BOUNDS);
      steps.push([step.decision.effectiveWidth, step.decision.reason]);
      state = step.state;
    }
    assert.deepEqual(steps.map(([w]) => w), [3, 2, 2, 2], `share ${share}: shed one a sample down to the learned capacity, then held`);
    assert.deepEqual(steps.slice(0, 2).map(([, r]) => r), ["cpu-pressure", "cpu-pressure"]);
  }
  // A relief restore never climbs back past the learned capacity.
  const prior: ReviewCapacityState = { effectiveWidth: 2, healthySamples: 0 };
  const calm = selectAdaptiveReviewWidth(prior, POLICY, observation({ activeWorkers: 2, laneCpuBound: 4, cpuPsiFullAvg10Pct: 1, cpuWeightShare: 1 }), BOUNDS);
  assert.equal(calm.decision.effectiveWidth, 2);
});

test("W1-T11129 criterion 1: in runDaemon, a review that starts and ends between build samples is its own lane", async (t) => {
  const dir = cgroupDir(t);
  const planFile = join(dir, "tasks.yaml");
  const task = (id: string) => `- id: ${id}\n  title: ${id}\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n  files: [src/${id}.ts]\n`;
  writeFileSync(planFile, task("A") + task("B"));
  // The container's CPU integrated over the test clock: 1 CPU of non-lane work, 1 per build, 2 per review.
  const clock = { ms: Date.parse("2026-11-05T00:00:00Z") };
  let usageUsec = 0, buildsRunning = 0, reviewsRunning = 0, accruedAtMs = clock.ms;
  const accrue = () => { usageUsec += (clock.ms - accruedAtMs) * 1000 * (1 + buildsRunning + 2 * reviewsRunning); accruedAtMs = clock.ms; };
  const advance = (ms: number) => { accrue(); clock.ms += ms; accrue(); };
  const sampledAt: number[] = [];
  const ports: LaneGovernorPorts = {
    mode: () => "shadow",
    read: () => { throw new Error("memory unread in this test"); },
    cpuCount: () => 8,
    cpuUsageUsec: () => { accrue(); sampledAt.push(clock.ms); return usageUsec; },
  };
  // Reviews register through the production registry, exactly as the sweep's review lane does.
  const startReview = () => {
    let end!: () => void;
    const work = new Promise<void>((resolve) => { end = resolve; });
    accrue();
    reviewsRunning += 1;
    void trackInFlightReview(work, { prNumber: 1, kind: "full-review" });
    return async () => { accrue(); reviewsRunning -= 1; end(); for (let i = 0; i < 20; i++) await drainMicrotasks(); };
  };
  const release: Record<string, (r: RunResult) => void> = {};
  const started: string[] = [];
  const merged = new Set<string>();
  let admissions = 0;
  publishLaneCpuBound(null);
  t.after(() => publishLaneCpuBound(null));
  const run = runDaemon(loadPlan(planFile), {
    refreshMerged: () => (id: string) => merged.has(id),
    log: () => {},
    runOne: (id: string) => {
      accrue();
      buildsRunning += 1;
      started.push(id);
      return new Promise<RunResult>((resolve) => { release[id] = resolve; }).then((r) => { merged.add(id); return r; });
    },
    // The first admission: a minute of idle host, then a review runs ALONE for 50 s before any build starts.
    categorizedRefusalRejoinFor: () => {
      if (admissions++ === 0) {
        advance(60_000);
        endFirst = startReview();
        advance(50_000);
      }
      return undefined;
    },
    sleep: async () => {},
    now: () => new Date(clock.ms),
    laneGovernor: ports,
  } as unknown as DaemonDeps, { max: 2, laneCount: 2, pollIntervalMs: 1000 });
  let endFirst: (() => Promise<void>) | undefined;
  for (let i = 0; i < 50 && started.length < 2; i++) await drainMicrotasks();
  assert.deepEqual(started, ["A", "B"]);
  // The first review ends while A and B build; a second starts and ends between their samples.
  advance(30_000);
  const endedAt = clock.ms;
  await endFirst!();
  advance(40_000);
  const secondStartedAt = clock.ms;
  const endSecond = startReview();
  advance(20_000);
  const secondEndedAt = clock.ms;
  await endSecond();
  advance(40_000);
  const end = async (id: string) => {
    accrue();
    buildsRunning -= 1;
    release[id]!({ taskId: id, merged: true, verdict: "merged", costUsd: 0, prUrl: `https://x/${id}` } as unknown as RunResult);
    for (let i = 0; i < 20; i++) await drainMicrotasks();
  };
  await end("A");
  advance(10_000);
  await end("B");
  const summary = await run;
  assert.equal(summary.stopReason, "max_reached");
  for (const at of [endedAt, secondStartedAt, secondEndedAt]) {
    assert.ok(sampledAt.includes(at), `the counter was sampled at the review transition (${at - Date.parse("2026-11-05T00:00:00Z")} ms)`);
  }
  assert.equal(publishedLaneCpuPerLane(REVIEW_LANE_CPU_CLASS), 2, "the review that ran alone is credited 2 CPUs a lane");
  assert.equal(publishedLaneCpuPerLane(DISPATCH_LANE_CPU_CLASS), 1, "no review CPU leaks into a build interval: 1 CPU a build");
  assert.equal(publishedLaneCpuBound(), 7, "(8 host cpus - 1 baseline) / 1 cpu per build");
});

test("W1-T11129 criterion 2: no cpuPsiHighPct remains, in the policy file or in any decision", () => {
  const policyText = readFileSync(join(REPO_ROOT, "plan", "policy.yaml"), "utf8");
  assert.equal(/^\s*cpuPsiHighPct:/m.test(policyText), false, "plan/policy.yaml carries no cpuPsiHighPct row");
  // A policy object that still carries the old field decides exactly as one without it, share or no share.
  const withStale = { ...POLICY, cpuPsiHighPct: 20 } as unknown as ReviewCapacityPolicy;
  const prior: ReviewCapacityState = { effectiveWidth: 4, healthySamples: 2 };
  for (const over of [{ cpuPsiFullAvg10Pct: 25 }, { cpuPsiFullAvg10Pct: 25, cpuWeightShare: 1 }, { cpuPsiFullAvg10Pct: 3 }]) {
    assert.deepEqual(
      selectAdaptiveReviewWidth(prior, withStale, observation(over), BOUNDS).decision,
      selectAdaptiveReviewWidth(prior, POLICY, observation(over), BOUNDS).decision,
    );
  }
});

test("W1-T11129 criterion 2: the runtime adapter reads the daemon's published cpu lane bound", (t) => {
  const root = cgroupDir(t);
  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  publishLaneCpuBound(3);
  t.after(() => publishLaneCpuBound(null));
  selectRuntimeReviewWidth({
    root, queueDepth: 4, activeWorkers: 0, nowMs: Date.parse("2026-11-04T00:00:00Z"), ledgerLines: [], policy: POLICY,
    baseWidth: 2, minWidth: 1, maxWidth: 3, log: (step, extra) => logs.push({ step, extra }),
  });
  assert.equal(logs[0]?.step, "review.capacity");
  assert.equal(logs[0]?.extra?.lane_cpu_bound, 3, "the bound reaches the observation the CPU verdict reads");
  assert.equal(logs[0]?.extra?.cpu_weight_share, null, "no cpu-weights.json under the root: the share is unread and the row says so");
});

test("W1-T11129 criterion 1: each running lane is labelled by its class, and a class learns only from its own intervals", (t) => {
  const dir = cgroupDir(t);
  const stat = join(dir, "cpu.stat");
  const write = (usageUsec: number) => writeFileSync(stat, `usage_usec ${usageUsec}\n`);
  const ports: Pick<LaneGovernorPorts, "cpuCount" | "cpuUsageUsec"> = { cpuCount: () => 8, cpuUsageUsec: () => readCgroupCpuUsageUsec(stat) };
  // Each step closes the interval on the lanes that ran through it, then opens the next on `next`.
  let learner = initialLaneCpuLearner();
  const close = (atMs: number, usageUsec: number, lanes: RunningLane[], next: RunningLane[]) => {
    write(usageUsec);
    const step = readLaneCpu(learner, ports, atMs, lanes, true);
    learner = relabelLaneCpu(step.learner, next);
    return step;
  };
  close(0, 0, [], []);
  close(1_000, 1_000_000, [], reviews("r1", "r2")); // baseline: 1 CPU
  // Two reviews using 4 CPUs over the baseline: the review class learns 2 per lane; the implement bound stays unlearned.
  let step = close(2_000, 6_000_000, reviews("r1", "r2"), [...builds("A"), ...reviews("r1")]);
  assert.equal(laneCpuReading(learner, "review").perLaneCpus, 2);
  assert.equal(step.cpu.perLaneCpus, null, "the dispatch bound reads the implement class, which has not run");
  assert.equal(step.bound, null);
  assert.equal(learner.perClass.lane, undefined, "no lane is labelled by a catch-all class");
  // A build beside a review is a mixed interval: it teaches neither class.
  close(3_000, 9_000_000, [...builds("A"), ...reviews("r1")], builds("A"));
  assert.equal(learner.perClass.implement, undefined);
  assert.deepEqual(learner.perClass.review, [2]);
  // A build alone teaches the implement class, and the dispatch bound follows it. A lane listed twice is one lane.
  step = close(4_000, 10_500_000, [...builds("A"), ...builds("A")], []);
  assert.deepEqual(step.cpu, { baselineCpus: 1, perLaneCpus: 0.5 });
  assert.equal(step.bound, 14, "(8 - 1) / 0.5");
});

test("W1-T11129 criterion 1: after learning, an unread or throwing counter falls back to the cpu-count cap, not the old medians", (t) => {
  const dir = cgroupDir(t);
  const stat = join(dir, "cpu.stat");
  const write = (usageUsec: number) => writeFileSync(stat, `usage_usec ${usageUsec}\n`);
  const ports: Pick<LaneGovernorPorts, "cpuCount" | "cpuUsageUsec"> = { cpuCount: () => 8, cpuUsageUsec: () => readCgroupCpuUsageUsec(stat) };
  write(0);
  let step = readLaneCpu(initialLaneCpuLearner(), ports, 0, []);
  write(1_000_000);
  step = readLaneCpu(step.learner, ports, 1_000, [], true);
  write(4_000_000);
  step = readLaneCpu(relabelLaneCpu(step.learner, builds("A", "B")), ports, 2_000, builds("A", "B"), true);
  assert.equal(step.bound, 7, "learned first");
  const learned = relabelLaneCpu(step.learner, builds("A", "B"));
  // The counter goes unread (the file is gone): the reading is unread now, so the cap is the cpu count.
  rmSync(stat);
  const unread = readLaneCpu(learned, ports, 3_000, builds("A", "B"));
  assert.deepEqual(unread.cpu, { baselineCpus: null, perLaneCpus: null });
  assert.equal(unread.bound, null);
  const capped = laneTarget({ ...baseInputs, previous: { target: 20 }, cpu: unread.cpu });
  assert.equal(capped.target, 8, "the cap at the cpu count, not the learned 7");
  // A throwing port is the same unread counter.
  const thrown = readLaneCpu(learned, { cpuCount: () => 8, cpuUsageUsec: () => { throw new Error("EACCES"); } }, 3_000, []);
  assert.equal(thrown.bound, null);
  assert.deepEqual(thrown.cpu, { baselineCpus: null, perLaneCpus: null });
  // The history survives the gap, but the interval spanning it (lanes unseen) teaches nothing.
  assert.deepEqual(unread.learner.idle, learned.idle);
  assert.deepEqual(unread.learner.perClass, learned.perClass);
  write(100_000_000);
  const back = readLaneCpu(unread.learner, ports, 4_000, builds("A", "B"), true);
  assert.deepEqual(back.learner.perClass, learned.perClass, "the first sample after the gap only re-anchors the counter");
  assert.equal(back.bound, 7, "the counter is read again: the learned figures apply again");
});

const TUNER = join(REPO_ROOT, "deploy", "memory-high-tuner.sh");
const FLEET = [
  { name: "remudero-daemon", id: "a".repeat(64), weight: 59 },
  { name: "remudero-serve", id: "b".repeat(64), weight: 303 },
  { name: "remudero-console-daemon", id: "c".repeat(64), weight: 59 },
];

/** A host cgroup tree with one scope per fleet container, and fake docker and date, for the shipped tuner. */
function tunerHost(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), "rmd-cpu-weights-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cg = join(root, "cg");
  for (const c of FLEET) {
    const scope = join(cg, "system.slice", `docker-${c.id}.scope`);
    mkdirSync(scope, { recursive: true });
    writeFileSync(join(scope, "memory.high"), `${2048 * 1024 * 1024}\n`);
    writeFileSync(join(scope, "cpu.weight"), `${c.weight}\n`);
  }
  mkdirSync(join(root, "bin"));
  mkdirSync(join(root, "cfg", "state"), { recursive: true });
  writeFileSync(join(root, "meminfo"), "MemTotal: 32000000 kB\nMemAvailable: 9216000 kB\n");
  const clock = join(root, "now");
  const fake = (name: string, body: string) => {
    writeFileSync(join(root, "bin", name), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(join(root, "bin", name), 0o755);
  };
  // Node-side clocks cannot move Bash's: every `date -u +%s` reads this file.
  fake("date", `case "$*" in "-u +%s") cat '${clock}' ;; *) printf '1970-01-01T00:00:00Z\n' ;; esac`);
  const ids = FLEET.map((c) => `${c.name}) echo ${c.id} ;;`).join(" ");
  const ps = FLEET.map((c) => `${c.name} ${c.id}`).join("\\n");
  fake("docker", `case "$1" in inspect) case "$4" in ${ids} *) exit 1 ;; esac ;; ps) printf '${ps}\\n' ;; esac`);
  const env: NodeJS.ProcessEnv = {
    PATH: `${join(root, "bin")}:${process.env.PATH}`,
    RMD_CGROUP_ROOT: cg,
    RMD_MEMINFO_PATH: join(root, "meminfo"),
    RMD_VMSTAT_PATH: join(root, "absent-vmstat"),
    RMD_HOST_PSI_MEMORY_PATH: join(root, "absent-psi"),
    RMD_MEMORY_HIGH_SUDO: "env",
  };
  const stateDir = join(root, "cfg", "state");
  const tick = (container: string, atS: number) => {
    writeFileSync(clock, `${atS}\n`);
    const run = spawnSync("bash", [TUNER, "--container", container, "--state-dir", join(root, "cfg")], { encoding: "utf8", env });
    assert.equal(run.status, 0, run.stderr);
    return run.stdout;
  };
  const scope = (name: string) => join(cg, "system.slice", `docker-${FLEET.find((c) => c.name === name)!.id}.scope`);
  return { root, stateDir, tick, scope, file: join(stateDir, CPU_WEIGHTS_FILE) };
}

test("W1-T11129 criterion 2: the host tuner records every fleet container's cpu.weight and the daemon reads its share from it", (t) => {
  const h = tunerHost(t);
  const t0 = 1_800_000_000;
  h.tick("remudero-daemon", t0);
  const first = JSON.parse(readFileSync(h.file, "utf8"));
  assert.equal(first.self, "remudero-daemon");
  assert.deepEqual(first.weights, { "remudero-daemon": 59, "remudero-serve": 303, "remudero-console-daemon": 59 });
  assert.equal(first.previous_updated_at_s, null);
  assert.equal(readCpuWeightShare(h.stateDir, t0 * 1000), undefined, "a first record has no write interval to judge freshness by");
  h.tick("remudero-daemon", t0 + 300);
  const share = readCpuWeightShare(h.stateDir, (t0 + 300) * 1000);
  assert.equal(share, 59 / (59 + 303 + 59), "the daemon's weight over every running fleet container's");
  // The runtime adapter reads the same record under its root and judges PSI against it.
  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  publishLaneCpuBound(null);
  const width = selectRuntimeReviewWidth({
    root: join(h.root, "cfg"), queueDepth: 4, activeWorkers: 0, nowMs: (t0 + 300) * 1000, ledgerLines: [], policy: POLICY,
    baseWidth: 2, minWidth: 1, maxWidth: 3, log: (step, extra) => logs.push({ step, extra }),
  });
  assert.ok(width >= 1);
  assert.equal(logs[0]?.extra?.cpu_weight_share, share, "the share reaches the review.capacity row");
  // Stale: two write intervals with no new record and the share is unread again.
  assert.equal(readCpuWeightShare(h.stateDir, (t0 + 300 + 600) * 1000), share);
  assert.equal(readCpuWeightShare(h.stateDir, (t0 + 300 + 601) * 1000), undefined);
  // Serve is tuned from core's state dir: its tick leaves the daemon's record alone.
  const before = readFileSync(h.file, "utf8");
  h.tick("remudero-serve", t0 + 600);
  assert.equal(readFileSync(h.file, "utf8"), before);
  // One unreadable sibling weight refreshes nothing, so the old record ages out instead of lying.
  rmSync(join(h.scope("remudero-serve"), "cpu.weight"));
  const out = h.tick("remudero-daemon", t0 + 900);
  assert.match(out, /cpu-weights\.json not refreshed/);
  assert.equal(readFileSync(h.file, "utf8"), before);
  assert.equal(readCpuWeightShare(h.stateDir, (t0 + 900) * 1000), share);
  assert.equal(readCpuWeightShare(h.stateDir, (t0 + 1_000) * 1000), undefined);
});

test("W1-T11129 criterion 2: an unreadable or malformed weights record keeps the share unread", (t) => {
  const dir = cgroupDir(t);
  const at = 1_800_000_000;
  const put = (body: string) => writeFileSync(join(dir, CPU_WEIGHTS_FILE), body);
  assert.equal(readCpuWeightShare(dir, at * 1000), undefined, "no file");
  put("{not json");
  assert.equal(readCpuWeightShare(dir, at * 1000), undefined);
  put(JSON.stringify({ self: "remudero-daemon", weights: { "remudero-serve": 303 }, updated_at_s: at, previous_updated_at_s: at - 300 }));
  assert.equal(readCpuWeightShare(dir, at * 1000), undefined, "the record does not name this daemon's weight");
  put(JSON.stringify({ self: "remudero-daemon", weights: { "remudero-daemon": 59, "remudero-serve": 303 }, updated_at_s: at, previous_updated_at_s: at }));
  assert.equal(readCpuWeightShare(dir, at * 1000), undefined, "no positive write interval");
  put(JSON.stringify({ self: "remudero-daemon", weights: { "remudero-daemon": 59, "remudero-serve": 303 }, updated_at_s: at, previous_updated_at_s: at - 300 }));
  assert.equal(readCpuWeightShare(dir, at * 1000), 59 / 362);
});

