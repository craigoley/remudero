// W1-T14903 — review width and the build lanes cut from ONE host memory reading, so active reviews cannot silently
// starve builds.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import {
  HOST_MEMORY_SHARED_STEP, laneTarget, publishSharedHostMemory, SHARED_HOST_MEMORY_STALE_MS, sharedBuildNeedMib, sharedHostMemory, sharedHostMemoryShort,
  type LaneMemoryReading,
} from "#src/lib/lane-governor.js";
import {
  readReviewHostObservation, reviewYieldsReReviews, selectAdaptiveReviewWidth, selectRuntimeReviewWidth, sharedMemoryAvailableMib,
  type ReviewCapacityObservation, type ReviewCapacityPolicy,
} from "#src/lib/review-capacity.js";
import { DEFAULT_SWEEP_POLICY, reReviewsJudgedHead, runSweep, selectReviewAdmissions, type OpenPrView, type SweepDeps } from "#test/helpers/sweep-test.js";

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

const tempRoots: string[] = [];
function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "rmd-shared-width-"));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
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
  assert.equal(paths.includes("/proc/meminfo"), false, "reviews do not take another kernel memory sample");
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
