import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runDaemon, type DaemonDeps } from "#src/lib/daemon.js";
import {
  cpuLaneBound,
  CPU_WEIGHTS_FILE,
  defaultLaneGovernorPorts,
  DISPATCH_LANE_CPU_CLASS,
  publishLaneCpuBound,
  publishedLaneCpuBound,
  readCgroupCpuUsageUsec,
  readCpuWeightShare,
  readLaneCpu,
  REVIEW_LANE_CPU_CLASS,
  runningLaneClasses,
  type LaneGovernorPorts,
  initialLaneCpuLearner,
  laneCpuReading,
  laneTarget,
  learnLaneCpu,
  parseCpuUsageUsec,
  type LaneCpuLearnerState,
  type LaneTargetInputs,
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

test("W1-T11129 criterion 1: usage_usec deltas teach the baseline while idle and the per-lane figure while lanes run", () => {
  assert.equal(parseCpuUsageUsec("usage_usec 1234\nuser_usec 1\n"), 1234);
  assert.equal(parseCpuUsageUsec("user_usec 1\n"), null);
  let state: LaneCpuLearnerState = initialLaneCpuLearner();
  const at = (atMs: number, usageUsec: number, runningClasses: string[]) => {
    state = learnLaneCpu(state, { atMs, usageUsec, runningClasses });
  };
  at(0, 0, []);
  at(10_000, 20_000_000, []); // 2 CPUs of non-lane work
  // 20 s long: 70 CPU-s over 20 s = 3.5 CPUs; less the 2 baseline, over 2 lanes.
  at(30_000, 90_000_000, ["implement", "implement"]);
  const reading = laneCpuReading(state, "implement");
  assert.equal(reading.baselineCpus, 2);
  assert.equal(reading.perLaneCpus, 0.75);
  assert.equal(laneCpuReading(state, "review").perLaneCpus, null);
  // A mixed-class interval, a backwards counter and an unlearned baseline teach nothing.
  const before = JSON.stringify(state.perClass);
  at(40_000, 190_000_000, ["implement", "review"]);
  at(50_000, 1, ["implement"]);
  assert.equal(JSON.stringify(state.perClass), before);
  const fresh = learnLaneCpu(learnLaneCpu(initialLaneCpuLearner(), { atMs: 0, usageUsec: 0, runningClasses: [] }), {
    atMs: 1000, usageUsec: 5_000_000, runningClasses: ["implement"],
  });
  assert.equal(fresh.idle.length, 0);
  assert.deepEqual(fresh.perClass, {});
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
  // Read only while the weight share is UNREAD (today's fixed line, W1-T11150's suite pins it); with a share, never.
  cpuPsiHighPct: 20,
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

test("W1-T11129 criterion 2: the shed is tiered, hold then shrink one then halve while it persists", () => {
  const prior: ReviewCapacityState = { effectiveWidth: 4, healthySamples: 2 };
  // The band just above the calm line holds: nothing shed, nothing added.
  const hold = run(prior, { cpuPsiFullAvg10Pct: 8, cpuPsiSomeAvg10Pct: 70, cpuWeightShare: 1 });
  assert.equal(hold.effectiveWidth, 4);
  assert.notEqual(hold.reason, "cpu-pressure");
  assert.equal(hold.evidence.healthySamples, 0);
  // Beyond it the first sample shrinks one lane...
  const first = selectAdaptiveReviewWidth(prior, POLICY, observation({ cpuPsiFullAvg10Pct: 25, cpuWeightShare: 1 }), BOUNDS);
  assert.equal(first.decision.reason, "cpu-pressure");
  assert.equal(first.decision.effectiveWidth, 3);
  // ...and an overload that persists halves.
  const second = selectAdaptiveReviewWidth(first.state, POLICY, observation({ cpuPsiFullAvg10Pct: 25, cpuWeightShare: 1 }), BOUNDS);
  assert.equal(second.decision.effectiveWidth, 1);
  assert.equal(cpuPressureTier({ cpuPsiFullAvg10Pct: 25, cpuPsiSomeAvg10Pct: 70 }, POLICY).tier, "shrink");
  assert.equal(cpuPressureTier({ cpuPsiFullAvg10Pct: 25, cpuPsiSomeAvg10Pct: 70 }, POLICY, true).tier, "halve");
  assert.equal(cpuPressureTier({ cpuPsiFullAvg10Pct: 8, cpuPsiSomeAvg10Pct: 70 }, POLICY).tier, "hold");
  assert.equal(cpuPressureTier({ cpuPsiSomeAvg10Pct: 70 }, POLICY).calm, false);
});

test("W1-T11129 criterion 2: the governor's learned cpu bound holds the width without stopping a lane", () => {
  const held = run({ effectiveWidth: 3, healthySamples: 2 }, { activeWorkers: 1, laneCpuBound: 4 });
  assert.equal(held.reason, "cpu-capacity-held");
  assert.equal(held.effectiveWidth, 3);
  assert.equal(held.evidence.healthySamples, 0);
  const room = run({ effectiveWidth: 3, healthySamples: 2 }, { activeWorkers: 1, laneCpuBound: 6 });
  assert.notEqual(room.reason, "cpu-capacity-held");
});

test("W1-T11129 criterion 2: width grows back on its own once the pressure eases", () => {
  let state: ReviewCapacityState = { effectiveWidth: 1, healthySamples: 0 };
  const stressed = selectAdaptiveReviewWidth(state, POLICY, observation({ cpuPsiFullAvg10Pct: 60 }), BOUNDS);
  assert.equal(stressed.decision.effectiveWidth, 1);
  state = stressed.state;
  const calm = selectAdaptiveReviewWidth(state, POLICY, observation({ cpuPsiFullAvg10Pct: 1 }), BOUNDS);
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
  let step = readLaneCpu(initialLaneCpuLearner(), ports, 0, {});
  write(1_000_000);
  step = readLaneCpu(step.learner, ports, 1_000, {});
  assert.equal(step.bound, null, "no lane has run yet: unlearned, so the cap stays at the cpu count");
  write(4_000_000);
  step = readLaneCpu(step.learner, ports, 2_000, { [DISPATCH_LANE_CPU_CLASS]: 2 });
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

test("W1-T11129 criterion 2: an unread weight share keeps today's fixed shed line", () => {
  // No share: today's line (cpuPsiHighPct) decides, unchanged; a known share of 1 decides by the tier instead.
  assert.equal(run({ effectiveWidth: 4, healthySamples: 0 }, { cpuPsiFullAvg10Pct: 20 }).reason, "cpu-pressure");
  assert.notEqual(run({ effectiveWidth: 4, healthySamples: 0 }, { cpuPsiFullAvg10Pct: 19 }).reason, "cpu-pressure");
  assert.notEqual(run({ effectiveWidth: 4, healthySamples: 0 }, { cpuPsiFullAvg10Pct: 8, cpuWeightShare: 1 }).reason, "cpu-pressure");
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
  assert.deepEqual(runningLaneClasses({ [DISPATCH_LANE_CPU_CLASS]: 2, [REVIEW_LANE_CPU_CLASS]: 1 }), ["implement", "implement", "review"]);
  assert.deepEqual(runningLaneClasses({ [DISPATCH_LANE_CPU_CLASS]: 0 }), []);
  const dir = cgroupDir(t);
  const stat = join(dir, "cpu.stat");
  const write = (usageUsec: number) => writeFileSync(stat, `usage_usec ${usageUsec}\n`);
  const ports: Pick<LaneGovernorPorts, "cpuCount" | "cpuUsageUsec"> = { cpuCount: () => 8, cpuUsageUsec: () => readCgroupCpuUsageUsec(stat) };
  write(0);
  let step = readLaneCpu(initialLaneCpuLearner(), ports, 0, {});
  write(1_000_000);
  step = readLaneCpu(step.learner, ports, 1_000, {}); // baseline: 1 CPU
  // Two reviews using 4 CPUs over the baseline: the review class learns 2 per lane; the implement bound stays unlearned.
  write(6_000_000);
  step = readLaneCpu(step.learner, ports, 2_000, { [REVIEW_LANE_CPU_CLASS]: 2 });
  assert.equal(laneCpuReading(step.learner, "review").perLaneCpus, 2);
  assert.equal(step.cpu.perLaneCpus, null, "the dispatch bound reads the implement class, which has not run");
  assert.equal(step.bound, null);
  assert.equal(step.learner.perClass.lane, undefined, "no lane is labelled by a catch-all class");
  // A build beside a review is a mixed interval: it teaches neither class.
  write(9_000_000);
  step = readLaneCpu(step.learner, ports, 3_000, { [DISPATCH_LANE_CPU_CLASS]: 1, [REVIEW_LANE_CPU_CLASS]: 1 });
  assert.equal(step.learner.perClass.implement, undefined);
  assert.deepEqual(step.learner.perClass.review, [2]);
  // A build alone teaches the implement class, and the dispatch bound follows it.
  write(10_500_000);
  step = readLaneCpu(step.learner, ports, 4_000, { [DISPATCH_LANE_CPU_CLASS]: 1 });
  assert.deepEqual(step.cpu, { baselineCpus: 1, perLaneCpus: 0.5 });
  assert.equal(step.bound, 14, "(8 - 1) / 0.5");
});

test("W1-T11129 criterion 1: after learning, an unread or throwing counter falls back to the cpu-count cap, not the old medians", (t) => {
  const dir = cgroupDir(t);
  const stat = join(dir, "cpu.stat");
  const write = (usageUsec: number) => writeFileSync(stat, `usage_usec ${usageUsec}\n`);
  const ports: Pick<LaneGovernorPorts, "cpuCount" | "cpuUsageUsec"> = { cpuCount: () => 8, cpuUsageUsec: () => readCgroupCpuUsageUsec(stat) };
  write(0);
  let step = readLaneCpu(initialLaneCpuLearner(), ports, 0, {});
  write(1_000_000);
  step = readLaneCpu(step.learner, ports, 1_000, {});
  write(4_000_000);
  step = readLaneCpu(step.learner, ports, 2_000, { [DISPATCH_LANE_CPU_CLASS]: 2 });
  assert.equal(step.bound, 7, "learned first");
  const learned = step.learner;
  // The counter goes unread (the file is gone): the reading is unread now, so the cap is the cpu count.
  rmSync(stat);
  const unread = readLaneCpu(learned, ports, 3_000, { [DISPATCH_LANE_CPU_CLASS]: 2 });
  assert.deepEqual(unread.cpu, { baselineCpus: null, perLaneCpus: null });
  assert.equal(unread.bound, null);
  const capped = laneTarget({ ...baseInputs, previous: { target: 20 }, cpu: unread.cpu });
  assert.equal(capped.target, 8, "the cap at the cpu count, not the learned 7");
  // A throwing port is the same unread counter.
  const thrown = readLaneCpu(learned, { cpuCount: () => 8, cpuUsageUsec: () => { throw new Error("EACCES"); } }, 3_000, {});
  assert.equal(thrown.bound, null);
  assert.deepEqual(thrown.cpu, { baselineCpus: null, perLaneCpus: null });
  // The history survives the gap, but the interval spanning it (lanes unseen) teaches nothing.
  assert.deepEqual(unread.learner.idle, learned.idle);
  assert.deepEqual(unread.learner.perClass, learned.perClass);
  write(100_000_000);
  const back = readLaneCpu(unread.learner, ports, 4_000, { [DISPATCH_LANE_CPU_CLASS]: 2 });
  assert.deepEqual(back.learner.perClass, learned.perClass, "the first sample after the gap only re-anchors the counter");
  assert.equal(back.bound, 7, "the counter is read again: the learned figures apply again");
});

test("W1-T11129 criterion 2: with the share known, width widens back one step per calm window", () => {
  const settleMs = POLICY.telemetryCadenceMs;
  // Shed to the floor on the container's own overload (share 1: no weight excuse).
  let state: ReviewCapacityState = { effectiveWidth: 4, healthySamples: 0 };
  let nowMs = 0;
  for (const full of [40, 40, 40]) {
    state = selectAdaptiveReviewWidth(state, POLICY, observation({ nowMs, cpuPsiFullAvg10Pct: full, cpuWeightShare: 1 }), BOUNDS).state;
    nowMs += 1_000;
  }
  assert.equal(state.effectiveWidth, 1);
  const widths: number[] = [];
  const calmAt = (at: number) => {
    const next = selectAdaptiveReviewWidth(state, POLICY, observation({ nowMs: at, cpuPsiFullAvg10Pct: 1, cpuWeightShare: 1 }), BOUNDS);
    state = next.state;
    widths.push(next.decision.effectiveWidth);
  };
  // The pressure eases: the first calm sample opens the window; a sample inside it adds nothing.
  calmAt(nowMs);
  calmAt(nowMs + settleMs / 2);
  assert.deepEqual(widths, [1, 1], "one calm sample is not a calm window: no 1 -> 4 jump");
  // Each whole calm window earns one lane, and the next lane needs a window of its own.
  calmAt(nowMs + settleMs);
  calmAt(nowMs + settleMs + 1_000);
  calmAt(nowMs + 2 * settleMs);
  calmAt(nowMs + 3 * settleMs);
  assert.deepEqual(widths, [1, 1, 2, 2, 3, 4]);
  // A pressured sample ends the window: calm must last a whole window again before the next step.
  state = { ...state, effectiveWidth: 2 };
  const pressed = selectAdaptiveReviewWidth(state, POLICY, observation({ nowMs: nowMs + 3 * settleMs + 1_000, cpuPsiFullAvg10Pct: 8, cpuWeightShare: 1 }), BOUNDS);
  assert.equal(pressed.decision.effectiveWidth, 2, "the hold band adds nothing");
  assert.equal(pressed.state.cpuCalmSinceMs, undefined);
  state = pressed.state;
  widths.length = 0;
  calmAt(nowMs + 3 * settleMs + 2_000);
  calmAt(nowMs + 4 * settleMs + 2_000);
  assert.deepEqual(widths, [2, 3]);
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

