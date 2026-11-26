// W1-T14903 — review width and the build lanes cut from ONE host memory reading, so active reviews cannot silently
// starve builds.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  laneTarget, publishSharedHostMemory, SHARED_HOST_MEMORY_STALE_MS, sharedHostMemory, sharedHostMemoryShort,
  type LaneMemoryReading,
} from "#src/lib/lane-governor.js";
import {
  reviewYieldsReReviews, selectAdaptiveReviewWidth, sharedMemoryAvailableMib,
  type ReviewCapacityObservation, type ReviewCapacityPolicy,
} from "#src/lib/review-capacity.js";
import { DEFAULT_SWEEP_POLICY, reReviewsJudgedHead, selectReviewAdmissions, type OpenPrView } from "../helpers/sweep-test.js";

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

function reading(hostBaseAvailableMib: number | null): LaneMemoryReading {
  return {
    containerBaseMib: null, containerOnsetMib: null, containerArmCounts: false, containerBasis: "test",
    hostBaseAvailableMib, hostReserveMib: 2048, perLaneMib: 2313, perLaneTypicalMib: 843, containerPressed: false,
  };
}

function pr(over: Partial<OpenPrView>): OpenPrView {
  return {
    prNumber: 1, prUrl: "https://github.com/o/r/pull/1", taskId: "W1-TX", reviewState: "none", checksState: "green",
    unmetCriteria: [], priorStrikes: 0, lastActivityAt: "2026-11-25T10:00:00Z", headSha: "aaaa111", autoMergeArmed: false,
    ...over,
  };
}

afterEach(() => publishSharedHostMemory({ unread: "test reset" }, NOW));

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
  assert.equal(sharedMemoryAvailableMib(8_130, undefined), 8_130, "with no fresh snapshot each lane reads its own");
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
  // The production default reads the shared snapshot: short when no build fits above the reserve.
  publishSharedHostMemory(reading(2_048 + 842), NOW);
  assert.equal(sharedHostMemoryShort(sharedHostMemory(NOW)), true);
  assert.equal(reviewYieldsReReviews(NOW), true);
  assert.deepEqual(selectReviewAdmissions([rejudge, first], DEFAULT_SWEEP_POLICY, NOW, undefined, 4, 0).spawning.map((p) => p.prNumber), [8]);
  publishSharedHostMemory(reading(2_048 + 843), NOW);
  assert.equal(reviewYieldsReReviews(NOW), false, "room for one build at its typical peak: nothing yields");
  assert.deepEqual(selectReviewAdmissions([rejudge, first], DEFAULT_SWEEP_POLICY, NOW, undefined, 4, 0).spawning.map((p) => p.prNumber).sort(), [7, 8]);
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
  const prs = [pr({ prNumber: 1, reviewedHeadSha: "aaaa111" }), pr({ prNumber: 2, prUrl: "https://github.com/o/r/pull/2", headSha: "dddd444" })];
  for (const width of [0, 1, 2, 4]) {
    const yielded = selectReviewAdmissions(prs, DEFAULT_SWEEP_POLICY, NOW, undefined, width, 0, undefined, undefined, true).spawning;
    const open = selectReviewAdmissions(prs, DEFAULT_SWEEP_POLICY, NOW, undefined, width, 0, undefined, undefined, false).spawning;
    assert.ok(yielded.length <= open.length, "yielding never admits more reviews");
  }
});
