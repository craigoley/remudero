// W1-T14903 — review width and the build lanes cut from ONE host memory reading, so active reviews cannot silently
// starve builds.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { fixedClock } from "#src/lib/clock.js";
import { loadHostMemoryBudgetPolicy } from "#src/lib/host-memory-shadow.js";
import {
  defaultLaneGovernorPorts, HOST_MEMORY_SHARED_STEP, laneTarget, openSharedHostMemoryPass, publishSharedHostMemory, readLaneMemory,
  SHARED_HOST_MEMORY_STALE_MS, setSharedHostMemoryReader, sharedBuildNeedMib, sharedHostMemory, sharedHostMemoryShort,
  type LaneMemoryReading,
} from "#src/lib/lane-governor.js";
import {
  initialReviewCapacityState, readReviewHostObservation, reviewYieldsReReviews, selectAdaptiveReviewWidth, selectRuntimeReviewWidth,
  sharedMemoryAvailableMib, summarizeReviewSettlements, type ReviewCapacityObservation, type ReviewCapacityPolicy,
} from "#src/lib/review-capacity.js";
import {
  DEFAULT_SWEEP_POLICY, drainInFlightReviews, RE_REVIEW_HELD_FOR_BUILD_REASON, reReviewsJudgedHead, reReviewYieldsForBuild,
  reviewOutcomeTaskIdFor, runSweep, runSweepLightPass, selectReviewAdmissions, type OpenPrView, type SweepDeps,
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
async function fullSweep(prs: OpenPrView[], root: string, hooks: {
  readMainRepair?: () => Promise<undefined>; seed?: Record<string, unknown>[];
} = {}): Promise<{
  effects: string[]; modes: string[]; rows: Record<string, unknown>[]; summary: Awaited<ReturnType<typeof runSweep>>;
}> {
  const effects: string[] = [];
  const modes: string[] = [];
  const rows: Record<string, unknown>[] = [...(hooks.seed ?? [])];
  const log = (step: string, extra?: Record<string, unknown>): void => { rows.push({ step, ...extra }); };
  const deps: SweepDeps = {
    ledgerPath: "/unused/shared-memory-ledger", runId: "shared-memory", now: () => NOW, repairAdmissionSurface: "full",
    readLedger: () => rows, appendLine: (_path, row) => { rows.push(row); }, log,
    dispatchFix: () => {}, dispatchPlanOnlyRepair: () => true,
    postReview: (p, mode) => { effects.push(`review:${p.prNumber}`); modes.push(`${p.prNumber}:${mode?.kind ?? "none"}`); },
    arm: () => "armed", escalate: () => {}, close: () => {},
    selectAdaptiveReviewWidth: ({ queueDepth, nowMs, ledgerLines, memoryPass }) => selectRuntimeReviewWidth({
      root, queueDepth, activeWorkers: 0, nowMs, ledgerLines, policy: POLICY, ...BOUNDS, log, cpuWeightShare: 1,
      readHostObservation: () => ({ memAvailableMib: 30_000, cpuPsiSomeAvg10Pct: 0, cpuPsiFullAvg10Pct: 0, memoryPsiSomeAvg10Pct: 0 }),
      ...(memoryPass === undefined ? {} : { memoryPass }),
    }),
    ...(hooks.readMainRepair === undefined ? {} : { readMainRepair: hooks.readMainRepair }),
  };
  const summary = await runSweep(prs, deps);
  return { effects, modes, rows, summary };
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

test("W1-T14903 a build outranks a re-review when memory is short — a status restore runs no review and is never held", async () => {
  // The reviewer's replay: a stale-claim takeover wrote pending over a delivered success on this exact head and input, so
  // admission re-posts that verdict (W1-T11729) and runs no review. Held while short, the required status stayed pending.
  const restorable = pr({
    prNumber: 10, prUrl: "https://github.com/o/r/pull/10", headSha: "abab101", reviewedHeadSha: "abab101", reviewState: "pending",
    reviewPendingOwnerDead: true, reviewPendingSince: "2026-11-25T15:00:00Z", reviewInputDigest: "digest-10",
  });
  const delivered = {
    step: "review.posted", ts: "2026-11-25T14:00:00Z", task_id: reviewOutcomeTaskIdFor(restorable), pr_url: restorable.prUrl,
    head_sha: restorable.headSha, review_input_digest: "digest-10", state: "success", decision_verdict: { state: "success" },
  };
  const rejudge = pr({ prNumber: 7, prUrl: "https://github.com/o/r/pull/7", headSha: "bbbb222", reviewedHeadSha: "bbbb222" });
  const first = pr({ prNumber: 8, prUrl: "https://github.com/o/r/pull/8", headSha: "cccc333" });
  assert.equal(reReviewsJudgedHead(restorable), true, "the restorable head is a judged head");
  assert.equal(reReviewYieldsForBuild(restorable, [delivered]), false, "its delivered verdict is re-posted, so it never yields");
  assert.equal(reReviewYieldsForBuild(restorable, []), true, "with no delivered verdict on the ledger it would run a review");
  assert.equal(reReviewYieldsForBuild(rejudge, [delivered]), true, "another head's verdict exempts nothing");
  assert.equal(reReviewYieldsForBuild(first, [delivered]), false, "a first review never yields");
  // The light pass's selector: while short, the re-review waits and the restore is admitted beside the first review.
  const lightShort = selectReviewAdmissions([restorable, rejudge, first], DEFAULT_SWEEP_POLICY, NOW, undefined, 4, 0, undefined,
    undefined, true, [delivered]).spawning.map((p) => p.prNumber).sort((a, b) => a - b);
  assert.deepEqual(lightShort, [8, 10], "short of memory, the restore is admitted and only the re-review waits");
  // The full sweep: the restore is posted on the short snapshot exactly as on a roomy one, and is not held.
  const restoredOn = async (snapshot: number): Promise<{ modes: string[]; held: unknown }> => {
    publishSharedHostMemory(reading(snapshot), NOW);
    const swept = await fullSweep([restorable, first], tempRoot(), { seed: [delivered] });
    const shared = swept.rows.find((row) => row.step === HOST_MEMORY_SHARED_STEP);
    return { modes: swept.modes.filter((mode) => mode.startsWith("10:")), held: shared?.withheld_prs };
  };
  const roomy = await restoredOn(30_000);
  assert.equal(roomy.modes.length, 1, `with room the head's one admission posts (${roomy.modes.join(", ")})`);
  const short = await restoredOn(-110);
  assert.deepEqual(short.modes, roomy.modes, "short of memory the restore still posts");
  assert.equal(short.held, undefined, "the pass withholds no restore");
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
    const refills = [width(pinnedRoot, NOW, pinned)];
    assert.equal(pinned.width?.ownMib, kernelMib, "the pass's row names the current kernel reading as the lane's own");
    // A refill past the pin's stale bound re-pins (here nothing fresh is left to pin); its width is still bounded.
    refills.push(...passes.slice(1).map((offset) => width(pinnedRoot, NOW + offset, pinned)));
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

// ---- Light passes whose refills run on a clock the test advances, past the pin's stale bound ----

const iso = (ms: number): string => new Date(ms).toISOString();
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
async function eventually(predicate: () => boolean, message: string): Promise<void> {
  for (let i = 0; i < 300; i++) {
    if (predicate()) return;
    await settle();
  }
  assert.fail(message);
}
async function quiet(): Promise<void> {
  for (let i = 0; i < 30; i++) await settle();
}
const REFILL_POLICY = { ...DEFAULT_SWEEP_POLICY, reviewLanes: 3, reviewLaneMin: 1, reviewLaneMax: 4 };
/** Eleven minutes after the pass read: past {@link SHARED_HOST_MEMORY_STALE_MS}. */
const LATE = NOW + SHARED_HOST_MEMORY_STALE_MS + 60_000;
const OWN_MIB = 30_000;
const ownHost = () => ({ memAvailableMib: OWN_MIB, cpuPsiSomeAvg10Pct: 0, cpuPsiFullAvg10Pct: 0, memoryPsiSomeAvg10Pct: 0 });

/** A light pass whose reviews hold until released, whose width is the production runtime width over an own
 *  MemAvailable of 30,000 MiB, and whose clock the test moves. Every width it cuts is recorded with the snapshot read. */
function lightHarness(root: string, extra: Partial<SweepDeps> = {}) {
  let clock = NOW;
  const holds = new Map<number, { promise: Promise<void>; resolve: () => void }>();
  const hold = (n: number) => {
    let entry = holds.get(n);
    if (entry === undefined) {
      let resolve!: () => void;
      const promise = new Promise<void>((r) => { resolve = r; });
      entry = { promise, resolve };
      holds.set(n, entry);
    }
    return entry;
  };
  const started: number[] = [];
  const released = new Set<number>();
  const rows: Record<string, unknown>[] = [];
  const widths: Array<{ nowMs: number; width: number; snapshotAt: number | undefined; snapshotMib: number | undefined }> = [];
  const log = (step: string, fields?: Record<string, unknown>): void => { rows.push({ step, ...fields }); };
  const deps: SweepDeps = {
    ledgerPath: "/unused/shared-memory-refill-ledger", runId: "shared-memory-refill", now: () => clock,
    readLedger: () => [], appendLine: (_path, row) => { rows.push(row as Record<string, unknown>); }, log,
    readActiveWorkerCount: () => 0,
    dispatchFix: () => {}, arm: () => "armed", escalate: () => {}, close: () => {},
    postReview: async (p) => {
      started.push(p.prNumber);
      await hold(p.prNumber).promise;
    },
    selectAdaptiveReviewWidth: ({ queueDepth, nowMs, ledgerLines, memoryPass }) => {
      const width = selectRuntimeReviewWidth({
        root, queueDepth, activeWorkers: 0, nowMs, ledgerLines, policy: POLICY, ...BOUNDS, log, cpuWeightShare: 1,
        readHostObservation: ownHost, ...(memoryPass === undefined ? {} : { memoryPass }),
      });
      widths.push({ nowMs, width, snapshotAt: memoryPass?.snapshot?.atMs, snapshotMib: memoryPass?.snapshot?.availableMib });
      return width;
    },
    ...extra,
  };
  return {
    deps, started, released, rows, widths,
    setClock: (ms: number) => { clock = ms; },
    release: (n: number) => { released.add(n); hold(n).resolve(); },
    sharedRows: () => rows.filter((row) => row.step === HOST_MEMORY_SHARED_STEP),
    finish: async () => {
      for (let n = 1; n <= 12; n++) hold(n).resolve();
      await drainInFlightReviews({ boundMs: 1000 });
      await quiet();
    },
  };
}

function lightPr(n: number, over: Partial<OpenPrView> = {}): OpenPrView {
  return pr({ prNumber: n, prUrl: `https://github.com/o/r/pull/${n}`, headSha: `head${n}`, taskId: `W1-T${n}`, ...over });
}

test("W1-T14903 both lanes read one memory snapshot — a light-pass refill past the stale bound re-pins the fresh one", async () => {
  // The reviewer's replay: own MemAvailable 30,000 MiB, the dispatch loop's projection -110 MiB. The pass cut width 2,
  // then a lane freed 11 minutes later refilled at width 3 on its own reading while the build lane read -110 MiB.
  const h = lightHarness(tempRoot());
  publishSharedHostMemory(reading(-110), NOW);
  try {
    await runSweepLightPass([1, 2, 3, 4].map((n) => lightPr(n)), h.deps, REFILL_POLICY);
    await eventually(() => h.started.length > 0, "the pass admitted no review");
    const atStart = h.widths.filter((w) => w.nowMs === NOW);
    assert.ok(atStart.length > 0);
    for (const w of atStart) {
      assert.equal(w.snapshotAt, NOW, "the pass pins the dispatch loop's reading");
      assert.ok(w.width < BOUNDS.baseWidth, `the pass cuts width ${w.width} from the -110 MiB snapshot`);
    }
    // +1 minute, inside the bound: the freed lane's refill reads the pass's own pin.
    h.setClock(NOW + 60_000);
    h.release(h.started[0]!);
    await eventually(() => h.widths.some((w) => w.nowMs === NOW + 60_000), "the +1 min refill cut no width");
    await quiet();
    for (const w of h.widths.filter((w) => w.nowMs === NOW + 60_000)) {
      assert.equal(w.snapshotAt, NOW, "inside the bound the refill reads the pinned snapshot");
      assert.ok(w.width < BOUNDS.baseWidth);
    }
    assert.deepEqual(h.sharedRows().map((row) => row.snapshot_at), [iso(NOW)], "inside the bound the pass keeps its one row");
    // +11 minutes: the dispatch loop re-published -110 MiB; a lane frees past the pin's bound.
    h.setClock(LATE);
    publishSharedHostMemory(reading(-110), LATE);
    const pending = h.started.find((n) => !h.released.has(n));
    assert.ok(pending !== undefined, "a review is still running to free a lane late");
    h.release(pending);
    await eventually(() => h.widths.some((w) => w.nowMs === LATE), "the late refill cut no width");
    const late = h.widths.filter((w) => w.nowMs === LATE);
    for (const w of late) {
      assert.equal(w.snapshotAt, LATE, "past the bound the refill re-pins the snapshot the build lane just read");
      assert.equal(w.snapshotMib, -110);
      assert.ok(w.width < BOUNDS.baseWidth, `the late refill's width ${w.width} is cut from -110 MiB, not its own 30,000`);
    }
    await eventually(() => h.sharedRows().some((row) => row.snapshot_at === iso(LATE)), "the late refill wrote no row");
    const rows = h.sharedRows();
    assert.equal(rows[0]?.snapshot_at, iso(NOW), "the pass's own row stays first, unchanged");
    const lateRow = rows.find((row) => row.snapshot_at === iso(LATE))!;
    assert.equal(lateRow.available_mib, -110, "the late refill's row names the fresh snapshot");
    assert.equal(lateRow.review_read_mib, -110);
    assert.equal(lateRow.review_own_mib, OWN_MIB);
    assert.ok(h.widths.some((w) => w.nowMs === LATE && w.width === lateRow.review_width), "the row names a width the late refill cut");
    assert.ok(Number(lateRow.review_width) < Number(lateRow.review_own_width), "and that width is the shared cut, below its own");
  } finally {
    await h.finish();
  }
  // The same late call with no shared snapshot is what the refill read before: its own 30,000 MiB, base width.
  publishSharedHostMemory({ unread: "own reading only" }, NOW);
  assert.equal(selectRuntimeReviewWidth({
    root: tempRoot(), queueDepth: 3, activeWorkers: 0, nowMs: LATE, ledgerLines: [], policy: POLICY, ...BOUNDS, log: () => {},
    cpuWeightShare: 1, readHostObservation: ownHost,
  }), BOUNDS.baseWidth, "its own reading alone would have refilled at base width");
});

test("W1-T14903 a build outranks a re-review when memory is short — a refill past the stale bound still yields", async () => {
  // The reviewer's replay: memory short, judged head #7 held by the pass; the first review settles 11 minutes later,
  // the refill re-reads the open PRs and, its pin expired, admitted #7 though the dispatch loop republished -110 MiB.
  const rejudge = lightPr(7, { reviewedHeadSha: "head7" });
  const first = lightPr(8);
  const lateRefill = async (
    republished: number, settled: (h: ReturnType<typeof lightHarness>) => boolean,
  ): Promise<{ started: number[]; rows: Record<string, unknown>[] }> => {
    const h = lightHarness(tempRoot(), { readOpenPrsForRefill: async () => [rejudge] });
    publishSharedHostMemory(reading(-110), NOW);
    try {
      await runSweepLightPass([rejudge, first], h.deps, REFILL_POLICY);
      await eventually(() => h.started.includes(8), "the first review did not start");
      await quiet();
      assert.equal(h.started.includes(7), false, "short of memory the pass holds the re-review");
      h.setClock(LATE);
      publishSharedHostMemory(reading(republished), LATE);
      h.release(8);
      await eventually(() => h.widths.some((w) => w.nowMs === LATE), "the late refill cut no width");
      await eventually(() => settled(h), `the late refill on ${republished} MiB did not settle`);
      await quiet();
      return { started: [...h.started], rows: h.sharedRows() };
    } finally {
      await h.finish();
    }
  };
  const short = await lateRefill(-110, (h) => h.sharedRows().some((row) => row.snapshot_at === iso(LATE)));
  assert.deepEqual(short.started, [8], "still short at +11 min: the refill leaves #7 for the build");
  assert.equal(short.rows[0]?.snapshot_at, iso(NOW));
  assert.deepEqual(short.rows[0]?.withheld_prs, [7], "the pass's row names the held re-review");
  const lateRow = short.rows.find((row) => row.snapshot_at === iso(LATE));
  assert.ok(lateRow, "the late refill writes its own row");
  assert.equal(lateRow.yielded, "re-review");
  assert.deepEqual(lateRow.withheld_prs, [7], "the late row names the re-review the refill held");
  // Control: the same late refill on a roomy republished snapshot admits #7, so the hold above is the snapshot's.
  const roomy = await lateRefill(30_000, (h) => h.started.includes(7));
  assert.ok(roomy.started.includes(7), `with room at +11 min the refill admits the re-review (${roomy.started.join(", ")})`);
  assert.equal(roomy.rows.find((row) => row.snapshot_at === iso(LATE))?.yielded === "re-review", false);
});

const MIB = 1024 * 1024;
const PSI = "some avg10=0.00 avg60=0.00 avg300=0.00 total=0\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n";
/** The governor's host ports over fixture files: 4 GiB charged under an 8,379 MiB memory.high and ~976 MiB available
 *  on the host, below the review lane's 1,536 MiB reserve. */
function shortHostPorts() {
  const files: Record<string, string> = {
    "/sys/fs/cgroup/memory.current": String(4096 * MIB),
    "/sys/fs/cgroup/memory.max": String(8379 * MIB),
    "/sys/fs/cgroup/memory.high": String(8379 * MIB),
    "/sys/fs/cgroup/memory.swap.current": "0",
    "/sys/fs/cgroup/memory.stat": `anon ${3000 * MIB}\nfile ${1096 * MIB}\ninactive_file ${96 * MIB}\npswpin 0\n`,
    "/sys/fs/cgroup/memory.events": "low 0\nhigh 7\nmax 0\noom 0\noom_kill 0\n",
    "/sys/fs/cgroup/memory.pressure": PSI,
    "/proc/pressure/memory": PSI,
    "/proc/meminfo": "MemTotal: 16000000 kB\nMemAvailable: 1000000 kB\n",
  };
  return {
    clock: fixedClock(NOW),
    policy: () => loadHostMemoryBudgetPolicy(),
    readLedger: () => undefined,
    readTail: () => "",
    readHostServe: undefined,
    listStateDir: () => [],
    daemonPid: () => undefined,
    instance: () => "fixture",
    estimate: () => 1400,
    typical: () => 900,
    readFile: (path: string): string => {
      const text = files[path];
      if (text === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
      return text;
    },
  };
}

test("W1-T14903 each pass writes host_memory.shared rows — a daemon booted under PAUSE writes them before any dispatch read", async () => {
  // The reviewer's replay: an operator PAUSE held across a restart. The daemon builds its lane governor's ports at
  // boot, but the paused loop never takes a dispatch reading, so the re-read hook installed on the first read() never
  // was, and every pause pass wrote no row and cut width from its own memory.
  const unbooted = lightHarness(tempRoot());
  try {
    await runSweepLightPass([lightPr(8)], unbooted.deps, REFILL_POLICY);
    await eventually(() => unbooted.started.includes(8), "the unbooted pass admitted no review");
  } finally {
    await unbooted.finish();
  }
  assert.equal(unbooted.sharedRows().length, 0, "with no governor in the process nothing is read and no row is written");
  assert.equal(unbooted.widths[0]?.snapshotAt, undefined);
  assert.equal(unbooted.widths[0]?.width, BOUNDS.baseWidth, "with no snapshot the width is the lane's own");

  const root = tempRoot();
  const hostPorts = shortHostPorts();
  const governor = defaultLaneGovernorPorts(join(root, "state"), hostPorts);
  assert.equal(typeof governor.read, "function", "the ports are built; PAUSE means read() is never called");
  const expected = readLaneMemory(root, hostPorts).hostBaseAvailableMib;
  assert.ok(typeof expected === "number" && expected < POLICY.workerMemoryReserveMib, `the host fixture reads short (${expected})`);
  const paused = lightHarness(tempRoot());
  try {
    await runSweepLightPass([lightPr(9)], paused.deps, REFILL_POLICY);
    await eventually(() => paused.started.includes(9), "the paused pass admitted no review");
  } finally {
    await paused.finish();
  }
  const rows = paused.sharedRows();
  assert.equal(rows.length, 1, "the paused pass re-read the snapshot through the governor's reader and wrote its row");
  assert.equal(rows[0]?.snapshot_at, iso(NOW));
  assert.equal(rows[0]?.available_mib, Math.round(expected));
  assert.ok(paused.widths.length > 0);
  for (const width of paused.widths) {
    assert.equal(width.snapshotAt, NOW, "the paused pass's width read the re-read snapshot");
    assert.ok(width.width < BOUNDS.baseWidth, `cut from the short snapshot, the width is ${width.width}`);
  }
  assert.ok(paused.widths.some((w) => w.width === rows[0]?.review_width), "the row names the width the pass cut");
  assert.equal(rows[0]?.review_own_width, BOUNDS.baseWidth, "its own 30,000 MiB alone would hold base width");
});
