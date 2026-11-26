// W1-T14903 — review width and the build lanes cut from ONE host memory reading, so active reviews cannot silently
// starve builds.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import {
  HOST_MEMORY_SHARED_STEP, laneTarget, openSharedHostMemoryPass, publishSharedHostMemory, SHARED_HOST_MEMORY_STALE_MS,
  setSharedHostMemoryReader, sharedBuildNeedMib, sharedHostMemory, sharedHostMemoryShort, type LaneMemoryReading,
} from "#src/lib/lane-governor.js";
import {
  initialReviewCapacityState, readReviewHostObservation, reviewYieldsReReviews, selectAdaptiveReviewWidth, selectRuntimeReviewWidth,
  sharedMemoryAvailableMib, summarizeReviewSettlements, type ReviewCapacityObservation, type ReviewCapacityPolicy,
} from "#src/lib/review-capacity.js";
import {
  DEFAULT_SWEEP_POLICY, RE_REVIEW_HELD_FOR_BUILD_REASON, reReviewsJudgedHead, runSweep, runSweepLightPass, selectReviewAdmissions,
  type OpenPrView, type SweepDeps,
} from "#test/helpers/sweep-test.js";

const NOW = Date.parse("2026-11-25T16:24:00Z");

const POLICY = {
  hostWorkerBudget: 16,
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
const BOUNDS = { minWidth: 1, baseWidth: 3, maxWidth: 4 };

function observation(memAvailableMib: number | undefined): ReviewCapacityObservation {
  return {
    nowMs: NOW,
    ...(memAvailableMib === undefined ? {} : { memAvailableMib }),
    cpuPsiSomeAvg10Pct: 0.03,
    cpuPsiFullAvg10Pct: 0,
    cpuWeightShare: 1,
    memoryPsiSomeAvg10Pct: 0,
    activeWorkers: 2,
    queueDepth: 6,
    settlements: { failures: 0, timeouts: 0, successes: 5, baselineLatencyMs: 1000, recentLatencyMs: 1000 },
    provider: { fresh: true, readable: true, refused: false, headroomPct: 80, reservePct: 5 },
  } as unknown as ReviewCapacityObservation;
}

function reviewWidth(memAvailableMib: number | undefined): { width: number; reason: string } {
  const result = selectAdaptiveReviewWidth({ effectiveWidth: BOUNDS.baseWidth, healthySamples: 0 }, POLICY, observation(memAvailableMib), BOUNDS);
  return { width: result.decision.effectiveWidth, reason: result.decision.reason };
}

function reading(hostBaseAvailableMib: number | null, extra: Partial<LaneMemoryReading> = {}): LaneMemoryReading {
  return {
    containerBaseMib: null, containerOnsetMib: null, containerArmCounts: false, containerBasis: "test",
    hostBaseAvailableMib, hostReserveMib: 2048, perLaneMib: 2313, perLaneTypicalMib: 843, containerPressed: false, ...extra,
  };
}

/** One full sweep over `prs` whose review width is the production runtime width, cut for this pass. */
async function fullSweep(prs: OpenPrView[], root: string, hooks: { readMainRepair?: () => Promise<undefined> } = {}): Promise<{
  effects: string[]; rows: Record<string, unknown>[]; summary: Awaited<ReturnType<typeof runSweep>>;
}> {
  const effects: string[] = [];
  const rows: Record<string, unknown>[] = [];
  const log = (step: string, extra?: Record<string, unknown>): void => { rows.push({ step, ...extra }); };
  const deps: SweepDeps = {
    ledgerPath: "/unused/shared-memory-ledger", runId: "shared-memory", now: () => NOW, repairAdmissionSurface: "full",
    readLedger: () => rows, appendLine: (_path, row) => { rows.push(row); }, log,
    dispatchFix: () => {}, dispatchPlanOnlyRepair: () => true,
    postReview: (p) => { effects.push(`review:${p.prNumber}`); },
    arm: () => "armed", escalate: () => {}, close: () => {},
    selectAdaptiveReviewWidth: ({ queueDepth, nowMs, ledgerLines, memoryPass }) => selectRuntimeReviewWidth({
      root, queueDepth, activeWorkers: 0, nowMs, ledgerLines, policy: POLICY, ...BOUNDS, log, cpuWeightShare: 1,
      readHostObservation: () => ({ memAvailableMib: 30_000, cpuPsiSomeAvg10Pct: 0, cpuPsiFullAvg10Pct: 0, memoryPsiSomeAvg10Pct: 0 }),
      ...(memoryPass === undefined ? {} : { memoryPass }),
    }),
    ...(hooks.readMainRepair === undefined ? {} : { readMainRepair: hooks.readMainRepair }),
  };
  const summary = await runSweep(prs, deps);
  return { effects, rows, summary };
}

function pr(over: Partial<OpenPrView>): OpenPrView {
  return {
    prNumber: 1, prUrl: "https://github.com/o/r/pull/1", taskId: "W1-TX", reviewState: "none", checksState: "green",
    unmetCriteria: [], priorStrikes: 0, lastActivityAt: "2026-11-25T10:00:00Z", headSha: "aaaa111", autoMergeArmed: false,
    ...over,
  };
}

const tempRoots: string[] = [];
function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "rmd-shared-width-"));
  tempRoots.push(root);
  return root;
}

// The reviewer's replay of 2026-11-25 16:24Z: kernel MemAvailable 8,130 MiB, cgroup memory PSI 8%, calm CPU, and
// review settlements whose recent latency is 6x the baseline. Fed through the width's host-reading seam.
const REPLAY_POLICY = { ...POLICY, settlementWindowMs: 3_600_000 } as ReviewCapacityPolicy;
const replayHost = () => ({
  memAvailableMib: 8_130, cpuPsiSomeAvg10Pct: 0.03, cpuPsiFullAvg10Pct: 0, memoryPsiSomeAvg10Pct: 8,
  hostLoad1: 1, hostCpuCount: 8,
});
function sixfoldLatencyLines(): Record<string, unknown>[] {
  const iso = (ms: number): string => new Date(ms).toISOString();
  const lines: Record<string, unknown>[] = [];
  for (let i = 0; i < 4; i++) {
    const start = NOW - 4 * 3_600_000 + i * 20 * 60_000; // baseline: 10 minute reviews, before the settlement window
    lines.push({ step: "sweep.post_review.attempt", ts: iso(start), pr_number: 100 + i, head_sha: `base${i}` });
    lines.push({ step: "sweep.post_review.done", ts: iso(start + 10 * 60_000), pr_number: 100 + i, head_sha: `base${i}` });
  }
  for (let i = 0; i < 4; i++) {
    const start = NOW - 70 * 60_000 + i * 60_000; // recent: 60 minute reviews settling inside the window
    lines.push({ step: "sweep.post_review.attempt", ts: iso(start), pr_number: 200 + i, head_sha: `recent${i}` });
    lines.push({ step: "sweep.post_review.done", ts: iso(start + 60 * 60_000), pr_number: 200 + i, head_sha: `recent${i}` });
  }
  return lines;
}

afterEach(() => {
  setSharedHostMemoryReader(undefined);
  publishSharedHostMemory({ unread: "test reset" }, NOW);
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("W1-T14903 both lanes read one memory snapshot", () => {
  const measured = reading(-110);
  publishSharedHostMemory(measured, NOW);
  const build = laneTarget({ inFlight: 2, memory: measured, cpuCount: 8, maxLanes: 3 });
  assert.equal(build.target, 1, "the build lane's projection of -110 MiB holds builds to one");
  assert.equal(build.binding, "host");
  const shared = sharedHostMemory(NOW);
  assert.ok(shared, "the reading the build lane took is the snapshot review capacity reads");
  assert.equal(shared.availableMib, -110);
  const reviewReads = sharedMemoryAvailableMib(8_130, shared);
  assert.equal(reviewReads, -110, "review capacity reads the same snapshot, not its own 8,130 MiB");
  assert.equal(reviewWidth(8_130).reason === "memory-reserve", false, "its own reading alone sees room (origin/main's view)");
  const cut = reviewWidth(reviewReads);
  assert.equal(cut.reason, "memory-reserve", "on the shared snapshot the review lane sees what the build lane sees");
  assert.ok(cut.width < reviewWidth(8_130).width);
  assert.equal(sharedHostMemory(NOW + SHARED_HOST_MEMORY_STALE_MS + 1), undefined, "a stale snapshot is not read");
  publishSharedHostMemory(measured, NOW + 5_000);
  assert.equal(sharedHostMemory(NOW)?.availableMib, -110, "a snapshot re-read after a pass took its clock is still read");
  assert.equal(sharedMemoryAvailableMib(8_130, undefined), 8_130, "with no fresh snapshot each lane reads its own");
  const paths: string[] = [];
  const host = readReviewHostObservation((path) => {
    paths.push(path);
    return path.includes("pressure") ? "some avg10=0.00 avg60=0.00 avg300=0.00 total=0" : "MemAvailable: 999999 kB";
  }, () => ({ load1: 1, cpuCount: 8 }), shared.availableMib);
  assert.equal(host.memAvailableMib, -110);
  assert.equal(paths.includes("/proc/meminfo"), false, "a supplied snapshot reading replaces the kernel memory sample");
});

test("W1-T14903 both lanes read one memory snapshot — a dispatch re-read while the sweep awaits main changes no cut", async () => {
  // The reviewer's replay: the pass cuts review width from 30,000 MiB, then the dispatch loop re-publishes -110 MiB
  // while the full sweep awaits readMainRepair. Every consumer in that pass must read the snapshot the pass started on.
  const rejudge = pr({ prNumber: 7, prUrl: "https://github.com/o/r/pull/7", headSha: "bbbb222", reviewedHeadSha: "bbbb222" });
  const first = pr({ prNumber: 8, prUrl: "https://github.com/o/r/pull/8", headSha: "cccc333" });
  publishSharedHostMemory(reading(30_000), NOW);
  const swept = await fullSweep([rejudge, first], tempRoot(), {
    readMainRepair: async () => { publishSharedHostMemory(reading(-110), NOW); return undefined; },
  });
  assert.equal(sharedHostMemory(NOW)?.availableMib, -110, "the dispatch loop did re-publish mid-pass");
  assert.deepEqual(swept.effects.sort(), ["review:7", "review:8"],
    "admission reads the 30,000 MiB snapshot the width was cut from, so the re-review is not held on -110 MiB");
  const shared = swept.rows.filter((row) => row.step === HOST_MEMORY_SHARED_STEP);
  assert.equal(shared.length, 1, "one pass, one snapshot, one row");
  assert.equal(shared[0]?.available_mib, 30_000, "the row names the snapshot every consumer in the pass read");
  assert.equal(shared[0]?.review_read_mib, 30_000);
  assert.equal(shared[0]?.yielded, "none");
});

test("W1-T14903 a build outranks a re-review when memory is short", () => {
  const rejudge = pr({ prNumber: 7, prUrl: "https://github.com/o/r/pull/7", headSha: "bbbb222", reviewedHeadSha: "bbbb222" });
  const first = pr({ prNumber: 8, prUrl: "https://github.com/o/r/pull/8", headSha: "cccc333" });
  assert.equal(reReviewsJudgedHead(rejudge), true);
  assert.equal(reReviewsJudgedHead(first), false);
  const roomy = selectReviewAdmissions([rejudge, first], DEFAULT_SWEEP_POLICY, NOW, undefined, 4, 0, undefined, undefined, false);
  assert.deepEqual(roomy.spawning.map((p) => p.prNumber).sort(), [7, 8], "with room both reviews start");
  const short = selectReviewAdmissions([rejudge, first], DEFAULT_SWEEP_POLICY, NOW, undefined, 4, 0, undefined, undefined, true);
  assert.deepEqual(short.spawning.map((p) => p.prNumber), [8], "short of memory, the re-review waits and the first review starts");
  // The production default reads the shared snapshot: short exactly when the build lane's host arm admits no build.
  publishSharedHostMemory(reading(0), NOW);
  const need = sharedBuildNeedMib(sharedHostMemory(NOW)!);
  for (const room of [need - 1, need]) {
    const snapshotReading = reading(2_048 + room);
    publishSharedHostMemory(snapshotReading, NOW);
    const admitsBuild = laneTarget({ inFlight: 1, memory: snapshotReading, cpuCount: 8, maxLanes: 3 }).target > 1;
    assert.equal(sharedHostMemoryShort(sharedHostMemory(NOW)), !admitsBuild, `short matches the build lane's own rule at room ${room}`);
  }
  publishSharedHostMemory(reading(2_048 + need - 1), NOW);
  assert.equal(reviewYieldsReReviews(NOW), true);
  assert.deepEqual(selectReviewAdmissions([rejudge, first], DEFAULT_SWEEP_POLICY, NOW, undefined, 4, 0).spawning.map((p) => p.prNumber), [8]);
  publishSharedHostMemory(reading(2_048 + need), NOW);
  assert.equal(reviewYieldsReReviews(NOW), false, "room for one more build: nothing yields");
  // W1-T14903 review 2026-11-26: at exactly one build's room the re-review used to start beside the build, unordered,
  // and could take the room first. It now yields until the room holds the build AND its own reserve.
  const reviewReserve = DEFAULT_SWEEP_POLICY.reviewCapacity.workerMemoryReserveMib;
  assert.ok(reviewReserve > 0);
  publishSharedHostMemory(reading(2_048 + need + reviewReserve), NOW);
  assert.deepEqual(selectReviewAdmissions([rejudge, first], DEFAULT_SWEEP_POLICY, NOW, undefined, 4, 0).spawning.map((p) => p.prNumber).sort(), [7, 8],
    "room for a build and the re-review: nothing yields");
});

test("W1-T14903 a build outranks a re-review when memory is short — at the reserve boundary the build goes first", () => {
  // The reviewer's inputs: an 843 MiB build need (typical 843, tail already reserved) at 842 and 843 MiB above reserve.
  const boundary = (room: number): LaneMemoryReading => reading(2_048 + room, { hostTailMib: 1_470 });
  publishSharedHostMemory(boundary(0), NOW);
  assert.equal(sharedBuildNeedMib(sharedHostMemory(NOW)!), 843);
  const rejudge = pr({ prNumber: 7, prUrl: "https://github.com/o/r/pull/7", headSha: "bbbb222", reviewedHeadSha: "bbbb222" });
  // A GitHub exact-head SUCCESS with no local review.posted row: W1-T2860 re-runs the reviewer on a judged head.
  const statusOnly = pr({
    prNumber: 9, prUrl: "https://github.com/o/r/pull/9", headSha: "eeee555", reviewState: "success", reviewInputDigest: "digest-9",
    priorReviewAttemptsForInput: 0,
  });
  const first = pr({ prNumber: 8, prUrl: "https://github.com/o/r/pull/8", headSha: "cccc333" });
  assert.equal(reReviewsJudgedHead(statusOnly), true, "a head GitHub already judged is a re-review");
  const admitted = (): number[] =>
    selectReviewAdmissions([rejudge, statusOnly, first], DEFAULT_SWEEP_POLICY, NOW, undefined, 4, 0).spawning.map((p) => p.prNumber).sort();
  for (const room of [842, 843]) {
    publishSharedHostMemory(boundary(room), NOW);
    const build = laneTarget({ inFlight: 1, memory: boundary(room), cpuCount: 8, maxLanes: 3 });
    assert.equal(build.target > 1, room >= 843, `the build lane admits a build at ${room} MiB only once it fits`);
    assert.deepEqual(admitted(), [8], `at ${room} MiB both re-reviews wait, so the build takes the room first`);
  }
  publishSharedHostMemory(boundary(843 + DEFAULT_SWEEP_POLICY.reviewCapacity.workerMemoryReserveMib), NOW);
  assert.ok(laneTarget({ inFlight: 1, memory: boundary(843 + DEFAULT_SWEEP_POLICY.reviewCapacity.workerMemoryReserveMib), cpuCount: 8,
    maxLanes: 3 }).target > 1);
  assert.deepEqual(admitted(), [7, 8, 9], "room for the build and a review: the re-reviews start too");
});

test("W1-T14903 a build outranks a re-review when memory is short — every held re-review is disposed, never dropped", async () => {
  // The reviewer's replay: a full sweep on a short snapshot held #7 out of the code lane, and the unstarted-tail loop
  // never finalized it — no sweep.disposed row, a hole in summary.actions, and actions.find threw a TypeError.
  const rejudges = [
    pr({ prNumber: 7, prUrl: "https://github.com/o/r/pull/7", headSha: "bbbb222", reviewedHeadSha: "bbbb222" }),
    pr({ prNumber: 9, prUrl: "https://github.com/o/r/pull/9", headSha: "ffff666", reviewedHeadSha: "ffff666" }),
  ];
  const first = pr({ prNumber: 8, prUrl: "https://github.com/o/r/pull/8", headSha: "cccc333" });
  for (const [snapshot, started] of [[-110, ["review:8"]], [30_000, ["review:7", "review:8", "review:9"]]] as const) {
    publishSharedHostMemory(reading(snapshot), NOW);
    const swept = await fullSweep([...rejudges, first], tempRoot());
    assert.deepEqual(swept.effects.sort(), [...started], `snapshot ${snapshot}: the reviews it admits`);
    const actions = Array.from(swept.summary.actions);
    assert.equal(actions.length, 3, `snapshot ${snapshot}: one action per PR`);
    assert.ok(actions.every((action) => action !== undefined), `snapshot ${snapshot}: summary.actions has no hole`);
    for (const held of rejudges) {
      const action = swept.summary.actions.find((entry) => entry.prNumber === held.prNumber);
      assert.ok(action, `snapshot ${snapshot}: #${held.prNumber} is accounted for in the pass summary`);
      const disposed = swept.rows.filter((row) => row.step === "sweep.disposed" && row.pr_number === held.prNumber);
      assert.ok(disposed.length >= 1, `snapshot ${snapshot}: #${held.prNumber} writes a sweep.disposed row`);
      const heldRows = disposed.filter((row) => row.stand_down_reason === RE_REVIEW_HELD_FOR_BUILD_REASON);
      assert.equal(heldRows.length, snapshot < 0 ? 1 : 0, `snapshot ${snapshot}: #${held.prNumber} names the build hold only when held`);
      if (snapshot < 0) {
        assert.equal(action.acted, false, "a held re-review is not acted on this pass");
        assert.equal(heldRows[0]?.acted, false);
        assert.equal(heldRows[0]?.disposition, "post-review");
      }
    }
  }
});

test("W1-T14903 shared memory never raises a lane width", () => {
  const ownReadings = [-4_000, 0, 900, 1_535, 1_536, 4_000, 8_130, 26_000];
  const snapshots = [-4_558, -110, 1_200, 1_908, 6_812, 30_000];
  for (const own of ownReadings) {
    for (const projected of snapshots) {
      publishSharedHostMemory(reading(projected), NOW);
      const read = sharedMemoryAvailableMib(own, sharedHostMemory(NOW))!;
      assert.ok(read <= own, `the review lane never reads more than its own ${own} MiB`);
      assert.ok(reviewWidth(read).width <= reviewWidth(own).width, `review width never rises (own ${own}, snapshot ${projected})`);
      const build = laneTarget({ inFlight: 1, memory: reading(projected), cpuCount: 8, maxLanes: 3 });
      publishSharedHostMemory({ unread: "compare" }, NOW);
      assert.deepEqual(laneTarget({ inFlight: 1, memory: reading(projected), cpuCount: 8, maxLanes: 3 }), build,
        "publishing the snapshot changes no build target");
    }
  }
  for (const projected of snapshots) {
    const run = (snapshot: boolean): number => {
      publishSharedHostMemory(snapshot ? reading(projected) : { unread: "own reading only" }, NOW);
      return selectRuntimeReviewWidth({
        root: tempRoot(), queueDepth: 6, activeWorkers: 2, nowMs: NOW, ledgerLines: [],
        policy: POLICY, ...BOUNDS, log: () => {},
      });
    };
    assert.ok(run(true) <= run(false), `the production width never rises on the shared snapshot ${projected}`);
  }
  const prs = [pr({ prNumber: 1, reviewedHeadSha: "aaaa111" }), pr({ prNumber: 2, prUrl: "https://github.com/o/r/pull/2", headSha: "dddd444" })];
  for (const width of [0, 1, 2, 4]) {
    const yielded = selectReviewAdmissions(prs, DEFAULT_SWEEP_POLICY, NOW, undefined, width, 0, undefined, undefined, true).spawning;
    const open = selectReviewAdmissions(prs, DEFAULT_SWEEP_POLICY, NOW, undefined, width, 0, undefined, undefined, false).spawning;
    assert.ok(yielded.length <= open.length, "yielding never admits more reviews");
  }
});

test("W1-T14903 shared memory never raises a lane width — the reviewer's replay keeps origin/main's latency cut", () => {
  const ledgerLines = sixfoldLatencyLines();
  const settlements = summarizeReviewSettlements(ledgerLines, NOW, REPLAY_POLICY.settlementWindowMs);
  assert.equal(settlements.recentLatencyMs! / settlements.baselineLatencyMs!, 6, "the replay's 6x latency ratio");
  // origin/main's width for these readings: its own MemAvailable, so the proportional latency cut, not the reserve cut.
  const main = selectAdaptiveReviewWidth(initialReviewCapacityState(BOUNDS.baseWidth), REPLAY_POLICY, {
    nowMs: NOW, queueDepth: 6, activeWorkers: 2, ...replayHost(), cpuWeightShare: 1, settlements,
    provider: { fresh: false, readable: false, refused: false },
  } as unknown as ReviewCapacityObservation, BOUNDS).decision;
  assert.equal(main.reason, "review-latency-expanded");
  assert.equal(main.effectiveWidth, 1);
  const run = (snapshot: LaneMemoryReading | undefined): number => {
    publishSharedHostMemory(snapshot ?? { unread: "origin/main reads its own" }, NOW);
    return selectRuntimeReviewWidth({
      root: tempRoot(), queueDepth: 6, activeWorkers: 2, nowMs: NOW, ledgerLines, policy: REPLAY_POLICY, ...BOUNDS,
      cpuWeightShare: 1, readHostObservation: replayHost, log: () => {},
    });
  };
  assert.equal(run(undefined), main.effectiveWidth, "with no snapshot the runtime width is origin/main's");
  assert.ok(run(reading(-110, { hostMeasuredAvailableMib: 8_130 })) <= main.effectiveWidth,
    "a -110 MiB projection's one-lane reserve cut never lifts the width above origin/main's latency cut");
});

test("W1-T14903 shared memory never raises a lane width — a kernel fall after the snapshot's read bounds the width", () => {
  // The reviewer's replay: the build lane read 30,000 MiB, then the kernel fell to 500 MiB while the snapshot was still
  // fresh (30 s to 599 s old). origin/main reads the current kernel each pass; the width must never exceed its width.
  const kernelMib = 500;
  let kernelReads = 0;
  const kernel = () => {
    kernelReads += 1;
    return { memAvailableMib: kernelMib, cpuPsiSomeAvg10Pct: 0, cpuPsiFullAvg10Pct: 0, memoryPsiSomeAvg10Pct: 0 };
  };
  const passes = [0, 1_000, 2_000];
  const width = (root: string, nowMs: number, memoryPass?: ReturnType<typeof openSharedHostMemoryPass>): number =>
    selectRuntimeReviewWidth({
      root, queueDepth: 6, activeWorkers: 2, nowMs, ledgerLines: [], policy: POLICY, ...BOUNDS, cpuWeightShare: 1,
      readHostObservation: kernel, log: () => {}, ...(memoryPass === undefined ? {} : { memoryPass }),
    });
  publishSharedHostMemory({ unread: "origin/main reads its own" }, NOW);
  const mainRoot = tempRoot();
  const main = passes.map((offset) => width(mainRoot, NOW + offset));
  assert.ok(main[0]! < BOUNDS.baseWidth, "origin/main cuts the width on the current 500 MiB reading");
  for (const ageMs of [30_000, 599_000]) {
    const lane = reading(30_000, { hostMeasuredAvailableMib: 30_000 });
    // A direct caller reading the live snapshot, then one pinned pass whose refills reuse it.
    publishSharedHostMemory(lane, NOW - ageMs);
    const liveRoot = tempRoot();
    const before = kernelReads;
    const live = passes.map((offset) => width(liveRoot, NOW + offset));
    assert.equal(kernelReads - before, passes.length, `snapshot ${ageMs} ms old: every pass takes a current kernel reading`);
    publishSharedHostMemory(lane, NOW - ageMs);
    const pinned = openSharedHostMemoryPass(NOW);
    assert.equal(pinned.snapshot?.measuredMib, 30_000, "the pinned snapshot still carries the 30,000 MiB lane read");
    const pinnedRoot = tempRoot();
    const refills = passes.map((offset) => width(pinnedRoot, NOW + offset, pinned));
    assert.equal(pinned.width?.ownMib, kernelMib, "the pass's row names the current kernel reading as the lane's own");
    passes.forEach((_, i) => {
      assert.ok(live[i]! <= main[i]!, `snapshot ${ageMs} ms old, pass ${i}: live width ${live[i]} <= origin/main ${main[i]}`);
      assert.ok(refills[i]! <= main[i]!, `snapshot ${ageMs} ms old, refill ${i}: pinned width ${refills[i]} <= origin/main ${main[i]}`);
    });
  }
});

test("W1-T14903 the width ceiling advances independently across shed and recovery passes", () => {
  const root = tempRoot();
  const run = (nowMs: number): number => selectRuntimeReviewWidth({
    root, queueDepth: 6, activeWorkers: 2, nowMs, ledgerLines: [], policy: POLICY, ...BOUNDS, log: () => {},
  });
  publishSharedHostMemory(reading(-110), NOW);
  const shed = run(NOW);
  assert.ok(shed < reviewWidth(30_000).width, "the shared projection can shed the review lane");
  publishSharedHostMemory(reading(30_000), NOW + 60_000);
  const legacyCeiling = reviewWidth(30_000).width;
  for (let pass = 1; pass <= 6; pass++) {
    assert.ok(run(NOW + 60_000 + pass * 1_000) <= legacyCeiling,
      "recovery follows an independently advanced legacy ceiling after the shared controller shed");
  }
});

test("W1-T14903 the review width pass writes one host_memory.shared row per snapshot", () => {
  const root = tempRoot();
  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const pass = (nowMs: number): number => selectRuntimeReviewWidth({
    root, queueDepth: 4, activeWorkers: 0, nowMs, ledgerLines: [], policy: POLICY, ...BOUNDS,
    log: (step, extra) => logs.push({ step, extra }),
  });
  publishSharedHostMemory(reading(-110), NOW);
  for (let i = 0; i < 4; i++) pass(NOW + i * 1_000);
  const rows = logs.filter((row) => row.step === HOST_MEMORY_SHARED_STEP);
  const capacityRows = logs.filter((row) => row.step === "review.capacity");
  assert.equal(rows.length, 4, "every pass records the shared reading, even when it is unchanged");
  assert.ok(rows.length >= capacityRows.length, "every recorded review pass records its shared reading");
  assert.equal(rows[0]?.extra?.available_mib, -110);
  assert.equal(rows[0]?.extra?.review_read_mib, -110, "the review lane read the shared snapshot, not its own");
  assert.equal(rows[0]?.extra?.short, true);
  assert.ok(Number(rows[0]?.extra?.review_width) <= Number(rows[0]?.extra?.review_own_width));
  publishSharedHostMemory(reading(30_000), NOW + 60_000);
  pass(NOW + 60_000);
  const next = logs.filter((row) => row.step === HOST_MEMORY_SHARED_STEP);
  assert.equal(next.length, rows.length + 1, "a changed share writes its own row");
  assert.equal(next.at(-1)?.extra?.short, false);
});

test("W1-T14903 each pass writes one host_memory.shared row, and a paused pass re-reads an expired snapshot", async () => {
  // The reviewer's inputs: a full sweep holding a same-head re-review wrote one row from the width pass and a second
  // from re-review admission, for one snapshot.
  const rejudge = pr({ prNumber: 7, prUrl: "https://github.com/o/r/pull/7", headSha: "bbbb222", reviewedHeadSha: "bbbb222" });
  const first = pr({ prNumber: 8, prUrl: "https://github.com/o/r/pull/8", headSha: "cccc333" });
  publishSharedHostMemory(reading(-110), NOW);
  const short = await fullSweep([rejudge, first], tempRoot());
  assert.deepEqual(short.effects, ["review:8"]);
  const rows = short.rows.filter((row) => row.step === HOST_MEMORY_SHARED_STEP);
  assert.equal(rows.length, 1, "one snapshot in one pass writes one row");
  assert.equal(rows[0]?.yielded, "re-review");
  assert.deepEqual(rows[0]?.withheld_prs, [7]);
  assert.equal(typeof rows[0]?.review_width, "number", "the one row carries the review width's share too");
  // Paused: nothing dispatches, so nothing re-publishes and the snapshot expires. The pass re-reads it through the
  // build lane's own reader rather than writing no row and reading its own memory.
  publishSharedHostMemory(reading(-110), NOW - SHARED_HOST_MEMORY_STALE_MS - 1);
  assert.equal(sharedHostMemory(NOW), undefined, "the snapshot has expired");
  let reads = 0;
  setSharedHostMemoryReader(() => { reads += 1; return reading(-110); });
  const paused = await fullSweep([rejudge, first], tempRoot());
  assert.equal(reads, 1, "the expired snapshot is re-read once for the pass");
  const pausedRows = paused.rows.filter((row) => row.step === HOST_MEMORY_SHARED_STEP);
  assert.equal(pausedRows.length, 1);
  assert.equal(pausedRows[0]?.snapshot_at, new Date(NOW).toISOString(), "the row names the re-read snapshot");
  assert.deepEqual(paused.effects, ["review:8"], "the re-read snapshot still holds the re-review back");
  setSharedHostMemoryReader(() => { throw new Error("meminfo unreadable"); });
  publishSharedHostMemory(reading(-110), NOW - SHARED_HOST_MEMORY_STALE_MS - 1);
  const unread = await fullSweep([rejudge, first], tempRoot());
  assert.equal(unread.rows.filter((row) => row.step === HOST_MEMORY_SHARED_STEP).length, 0, "an unreadable re-read pins nothing");
  assert.deepEqual(unread.effects.sort(), ["review:7", "review:8"]);
});

test("W1-T14903 a light pass and its per-PR sweeps read one pinned snapshot and write one row", async () => {
  const rejudge = pr({ prNumber: 7, prUrl: "https://github.com/o/r/pull/7", headSha: "bbbb222", reviewedHeadSha: "bbbb222" });
  const first = pr({ prNumber: 8, prUrl: "https://github.com/o/r/pull/8", headSha: "cccc333" });
  const effects: string[] = [];
  const rows: Record<string, unknown>[] = [];
  publishSharedHostMemory(reading(-110), NOW);
  await runSweepLightPass([rejudge, first], {
    ledgerPath: "/unused/shared-memory-light-ledger", runId: "shared-memory-light", now: () => NOW,
    readLedger: () => rows, appendLine: (_path, row) => { rows.push(row); }, log: (step, extra) => { rows.push({ step, ...extra }); },
    dispatchFix: () => {}, postReview: (p) => { effects.push(`review:${p.prNumber}`); },
    arm: () => "armed", escalate: () => {}, close: () => {},
  });
  assert.deepEqual(effects, ["review:8"], "short of memory, the light pass holds the re-review back");
  const shared = rows.filter((row) => row.step === HOST_MEMORY_SHARED_STEP);
  assert.equal(shared.length, 1, "the light pass and every per-PR sweep it fans out to write one row");
  assert.equal(shared[0]?.yielded, "re-review");
  assert.deepEqual(shared[0]?.withheld_prs, [7]);
});

test("W1-T14903 the full sweep's review lane holds a re-review back while memory is short", async () => {
  const rejudge = pr({ prNumber: 7, prUrl: "https://github.com/o/r/pull/7", headSha: "bbbb222", reviewedHeadSha: "bbbb222" });
  const first = pr({ prNumber: 8, prUrl: "https://github.com/o/r/pull/8", headSha: "cccc333" });
  const sweep = async (): Promise<{ effects: string[]; rows: Record<string, unknown>[] }> => {
    const effects: string[] = [];
    const rows: Record<string, unknown>[] = [];
    const deps: SweepDeps = {
      ledgerPath: "/unused/shared-memory-ledger", runId: "shared-memory", now: () => NOW,
      readLedger: () => rows, appendLine: (_path, row) => { rows.push(row); }, log: (step, extra) => { rows.push({ step, ...extra }); },
      dispatchFix: () => {}, dispatchPlanOnlyRepair: () => true,
      postReview: (p) => { effects.push(`review:${p.prNumber}`); },
      arm: () => "armed", escalate: () => {}, close: () => {},
    };
    await runSweep([rejudge, first], deps);
    return { effects, rows };
  };
  publishSharedHostMemory(reading(30_000), NOW);
  assert.deepEqual((await sweep()).effects.sort(), ["review:7", "review:8"], "with room both reviews run");
  publishSharedHostMemory(reading(-110), NOW);
  const short = await sweep();
  assert.deepEqual(short.effects, ["review:8"], "short of memory, the full sweep holds the re-review back");
  const held = short.rows.find((row) => row.step === HOST_MEMORY_SHARED_STEP && row.yielded === "re-review");
  assert.ok(held, "the held re-review is recorded");
  assert.deepEqual(held.withheld_prs, [7]);
});
