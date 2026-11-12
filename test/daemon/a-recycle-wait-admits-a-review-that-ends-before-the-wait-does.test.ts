import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test, type TestContext } from "node:test";
import { deriveDrainWait } from "#src/lib/deployer.js";
import { recycleWaitAdmission, runDaemon, type LightPassScope } from "#src/lib/daemon.js";
import { loadPlan } from "#src/lib/plan.js";
import {
  predictRecycleWaitRuns, recycleWaitAdmits, soonestRecycleWaitRun, type RecycleWaitInput,
} from "#src/lib/recycle-wait-admission.js";
import {
  DEFAULT_SWEEP_POLICY, drainInFlightReviews, inFlightReviewCount, runSweepLightPass,
  type OpenPrView, type SweepDeps,
} from "#src/lib/sweep.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

const RECYCLE_REASON = "container recycle (deploy/recycle-container.sh)";
const RECYCLE = `PAUSE requested: ${RECYCLE_REASON}`;
const OPERATOR = "PAUSE requested: investigating an incident";
const T0 = Date.parse("2026-11-10T12:00:00.000Z");
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
type Row = { step: string; extra: Record<string, unknown> };

const input = (lengthMs: number | undefined, ...leftMs: Array<number | undefined>): RecycleWaitInput => ({
  lengthsMs: { review: lengthMs, "plan-review": lengthMs },
  runs: leftMs.map((left, i) => ({ runId: `run-${i}`, kind: i % 2 === 0 ? "build" : "fix", ageMs: 60_000,
    ...(left === undefined ? {} : { predictedLeftMs: left }) })),
});

/** Build runs that took 1800 s, 2400 s and 3000 s; one in flight for 600 s has 2400 s left. Reviews of `reviewS`. */
function ledgerLines(reviewS: number, atMs = T0): string[] {
  const lines: string[] = [];
  for (const [i, s] of [1800, 2400, 3000].entries()) {
    lines.push(JSON.stringify({ ts: new Date(atMs - 86_400_000).toISOString(), run_id: `old-${i}`, step: "implement.done", worker_duration_ms: s * 1000 }));
  }
  for (const pr of [11, 12, 13]) {
    const start = atMs - 3_600_000 - pr * 60_000;
    lines.push(JSON.stringify({ ts: new Date(start).toISOString(), step: "sweep.review_started", pr_number: pr }));
    lines.push(JSON.stringify({ ts: new Date(start + reviewS * 1000).toISOString(), step: "review.posted", pr_url: `https://github.com/o/r/pull/${pr}` }));
  }
  return lines;
}

function stateWithBuildRun(t: TestContext, startedAtMs: number): { root: string; state: string } {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}recycle-wait-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const state = join(root, "state");
  mkdirSync(join(state, "inflight"), { recursive: true });
  writeFileSync(join(state, "inflight", "W1-T1.lock"), JSON.stringify({ run_id: "build-1", startedAt: new Date(startedAtMs).toISOString() }));
  return { root, state };
}

function fixturePlan(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}recycle-wait-plan-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, "tasks.yaml");
  writeFileSync(file, "- id: A\n  title: a\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n");
  return loadPlan(file);
}

const fleetLaneAt = (state: string) => ({ stateDir: state, ledgerPath: join(state, "fleet-ledger.ndjson"), mergedLastDay: () => 0, approve: () => {} });

/** The review clock of a pause, driven through `runDaemon` with no lane in flight in the loop. */
async function pauseClock(t: TestContext, detail: string, reviewS: number, buildRun = true) {
  const rows: Row[] = [];
  const calls: Array<LightPassScope | undefined> = [];
  let nowMs = T0;
  let waits = 0;
  const { state } = stateWithBuildRun(t, T0 - 600_000);
  if (!buildRun) rmSync(join(state, "inflight", "W1-T1.lock"));
  const summary = await runDaemon(fixturePlan(t), {
    refreshMerged: () => () => true,
    runOne: async () => assert.fail("no dispatch under a pause"),
    checkPause: () => detail,
    checkStop: () => waits >= 12 ? "fixture finished" : undefined,
    now: () => new Date(nowMs),
    readLedgerLines: () => ledgerLines(reviewS),
    fleetLane: fleetLaneAt(state),
    sleep: async () => { await settle(); },
    sleepUntilSweepWake: async (ms) => {
      await settle();
      nowMs += ms;
      waits++;
      return waits % 2 === 0 ? "wake" : "timeout";
    },
    sweepLight: async (scope?: LightPassScope) => {
      calls.push(scope);
      scope?.admit?.("review", "light");
    },
    log: (step, extra = {}) => rows.push({ step, extra }),
  }, { pollIntervalMs: 1 });
  assert.equal(summary.stopReason, "stopped");
  return { rows, calls };
}

/** The in-flight ticker of a dispatch phase, with one lane in flight when the recycle PAUSE arrives. */
async function dispatchPhase(t: TestContext, detail: string, reviewS: number) {
  const rows: Row[] = [];
  const calls: Array<{ pause: string | undefined; scope: LightPassScope | undefined }> = [];
  let sleeps = 0;
  let pause: string | undefined;
  let release!: () => void;
  const lane = new Promise<void>((resolve) => { release = resolve; });
  const merged = new Set<string>();
  const { state } = stateWithBuildRun(t, Date.now() - 600_000);
  await runDaemon(fixturePlan(t), {
    refreshMerged: () => (id) => merged.has(id),
    runOne: async (id) => {
      await lane;
      merged.add(id);
      return { taskId: id, runId: `${id}-run`, merged: true, costUsd: 0, verdict: "merged" };
    },
    checkPause: () => pause,
    checkStop: () => undefined,
    readLedgerLines: () => ledgerLines(reviewS, Date.now()),
    fleetLane: fleetLaneAt(state),
    sweepLight: async (scope?: LightPassScope) => {
      calls.push({ pause, scope });
      if (pause !== undefined) scope?.admit?.("review", "light");
    },
    sleep: async () => {
      sleeps++;
      if (sleeps === 2) pause = detail;
      if (sleeps >= 10) release();
      await settle();
    },
    log: (step, extra = {}) => rows.push({ step, extra }),
  }, { max: 1, pollIntervalMs: 1 });
  await settle();
  return { rows, calls: calls.filter((c) => c.pause !== undefined) };
}

/** A light pass whose freed review places refill, as in test/deploy/a-light-pass-refill-admits-no-review-under-a-recycle-pause.test.ts. */
function refillFixture(t: TestContext, reviewS: number, firstPr: number, pausedAtStart = false) {
  const now = T0;
  const { state } = stateWithBuildRun(t, now - 600_000);
  const prs: OpenPrView[] = [0, 1, 2, 3].map((i) => firstPr + i).map((n) => ({
    prNumber: n, prUrl: `https://github.com/o/r/pull/${n}`, taskId: `W1-T${n}`,
    headSha: `head-${n}`, reviewState: "none", checksState: "green",
    unmetCriteria: [], priorStrikes: 0, autoMergeArmed: false,
    createdAt: new Date(now - (10 - n + firstPr) * 60_000).toISOString(),
    lastActivityAt: new Date(now - (n - firstPr + 1) * 60_000).toISOString(),
  }));
  const releases = new Map<number, () => void>();
  const gates = new Map(prs.map((pr) => [pr.prNumber, new Promise<void>((resolve) => releases.set(pr.prNumber, resolve))]));
  const started: number[] = [];
  const rows: Record<string, unknown>[] = [];
  const daemonRows: Row[] = [];
  let paused: string | undefined;
  const pause = () => {
    paused = RECYCLE;
    writeFileSync(join(state, "PAUSE"), JSON.stringify({ reason: RECYCLE_REASON, requestedAt: new Date(now).toISOString(), pid: process.pid, host: "fixture" }));
  };
  if (pausedAtStart) pause();
  const deps: SweepDeps = {
    ledgerPath: join(state, "ledger.ndjson"), runId: "recycle-wait-refill", now: () => now,
    readLedger: () => [], appendLine: (_path, row) => { rows.push(row); },
    readActiveWorkerCount: () => 0,
    arm: () => {}, close: () => {}, dispatchFix: () => {}, escalate: () => {},
    restartAdmission: recycleWaitAdmission({ ledgerLines: ledgerLines(reviewS, now), stateDir: state, nowMs: () => now,
      lengthsMs: { review: reviewS * 1000, "plan-review": reviewS * 1000 }, paused: () => paused },
    (step, extra = {}) => daemonRows.push({ step, extra })),
    postReview: async (pr) => {
      started.push(pr.prNumber);
      await gates.get(pr.prNumber);
    },
  };
  t.after(async () => {
    for (const release of releases.values()) release();
    await drainInFlightReviews({ boundMs: 1000, closeRefills: false });
  });
  return {
    deps, rows, daemonRows, pause,
    release: (n: number) => releases.get(firstPr + n - 1)!(),
    started: () => started.map((n) => n - firstPr + 1),
    /** Ends every review and every refill this fixture started, so the next fixture starts with free places. */
    finish: async () => {
      for (const release of releases.values()) release();
      for (let i = 0; i < 20; i++) await settle();
      await eventually(() => inFlightReviewCount() === 0);
    },
    start: async () => {
      await eventually(() => inFlightReviewCount() === 0);
      await runSweepLightPass(prs, deps, { ...DEFAULT_SWEEP_POLICY, reviewLanes: 2, reviewLaneMin: 2, reviewLaneMax: 2 });
    },
  };
}

async function eventually(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await settle();
  }
  assert.fail("the expected outcome did not arrive");
}

describe("test/daemon/a-recycle-wait-admits-a-review-that-ends-before-the-wait-does.test.ts", () => {
  // The refill tests run before the daemon tests: a daemon's stop drain closes this process's refills, as an exit does.
  test("W1-T12241 criterion 1: a review shorter than the smallest predicted time left is admitted", () => {
    assert.equal(recycleWaitAdmits("review", input(300_000, 2_400_000)), true);
    assert.equal(recycleWaitAdmits("plan-review", input(300_000, 2_400_000, 900_000)), true);
    assert.deepEqual(soonestRecycleWaitRun(input(300_000, 2_400_000, 900_000, 1_200_000))?.runId, "run-1",
      "the comparison is with the run predicted to end first");
    assert.equal(recycleWaitAdmits("review", input(1_000_000, 2_400_000, 900_000)), false,
      "a review that ends before the last run but after the first is not admitted");
    const lanes = [{ runId: "build-1", ageS: 600 }];
    const observed = [1_800_000, 2_400_000, 3_000_000];
    const predicted = predictRecycleWaitRuns("build", observed, lanes);
    assert.equal(predicted[0]!.predictedLeftMs, deriveDrainWait(observed, lanes).lanes[0]!.remaining_s * 1000,
      "the time left is the deployer's own prediction");
  });

  test("W1-T12241 criterion 2: longer, nothing in flight, no measured length, or an unreadable prediction is refused", () => {
    assert.equal(recycleWaitAdmits("review", input(2_500_000, 2_400_000)), false, "longer than the time left");
    assert.equal(recycleWaitAdmits("review", input(2_400_000, 2_400_000)), false, "equal is not shorter");
    assert.equal(recycleWaitAdmits("review", input(300_000)), false, "no build run or fix round in flight");
    assert.equal(recycleWaitAdmits("review", input(undefined, 2_400_000)), false, "no review length measured");
    assert.equal(recycleWaitAdmits("review", input(300_000, 2_400_000, undefined)), false, "one prediction unreadable");
    assert.equal(predictRecycleWaitRuns("build", [], [{ runId: "r", ageS: 10 }])[0]!.predictedLeftMs, undefined,
      "no observed run gives no prediction, never the fallback constant");
    assert.equal(predictRecycleWaitRuns("fix", [60_000], [{ runId: "r", ageS: 600 }])[0]!.predictedLeftMs, undefined,
      "a run older than every observed run has no prediction");
    assert.equal(predictRecycleWaitRuns("build", [60_000], [{ runId: "r", ageS: 10, judged: "ended" }]).length, 0,
      "a run that ended its round is not waited for");
  });

  test("W1-T12241 criterion 3: a fix round and a build dispatch are refused in every case", () => {
    for (const kind of ["fix-dispatch", "dispatch-refill"] as const) {
      for (const value of [input(1, 9_000_000), input(300_000, 2_400_000), input(undefined), input(1)]) {
        assert.equal(recycleWaitAdmits(kind, value), false, kind);
      }
    }
  });

  test("W1-T12241 criterion 6: under a pause that is not a recycle pause, the refill admits as today", async (t) => {
    const refill = refillFixture(t, 2500, 401);
    await refill.start();
    await eventually(() => refill.started().length === 2);
    refill.release(1);
    await eventually(() => refill.started().includes(3));
    assert.equal(refill.daemonRows.length, 0, "with no recycle pause the predicate writes nothing and admits");
    await refill.finish();
  });

  test("W1-T12241 criterion 5: under a recycle pause the refill of a freed review place asks the same function", async (t) => {
    const fits = refillFixture(t, 300, 101);
    await fits.start();
    await eventually(() => fits.started().length === 2);
    fits.pause();
    fits.release(1);
    await eventually(() => fits.started().includes(3));
    assert.deepEqual(fits.rows.filter((row) => row.step === "sweep.review_refilled").map((row) => row.pr_number), [103]);
    assert.equal(fits.rows.filter((row) => row.step === "sweep.review_refill_held").length, 0);
    await fits.finish();

    const outlives = refillFixture(t, 2500, 201);
    await outlives.start();
    await eventually(() => outlives.started().length === 2);
    outlives.pause();
    outlives.release(1);
    await eventually(() => outlives.rows.some((row) => row.step === "sweep.review_refill_held"));
    for (let i = 0; i < 5; i++) await settle();
    assert.deepEqual(outlives.started(), [1, 2], "a review that would outlive the wait gets no freed place");
    assert.equal(outlives.rows.filter((row) => row.step === "sweep.review_refilled").length, 0);
    assert.ok(outlives.daemonRows.some((r) => r.step === "daemon.admission_held" && r.extra.surface === "light-refill"
      && r.extra.reason === "recycle_pause"));
    await outlives.finish();
  });

  test("W1-T12241 criterion 7: each review admitted under a recycle pause writes one row with its length and time left", async (t) => {
    const h = refillFixture(t, 300, 301, true);
    await h.start();
    await eventually(() => h.started().length === 2);
    h.release(1);
    await eventually(() => h.started().includes(3));
    const admitted = h.daemonRows.filter((r) => r.step === "daemon.recycle_wait.review_admitted");
    assert.equal(admitted.length, h.started().length, "one row per admitted review");
    for (const row of admitted) {
      assert.equal(row.extra.review_length_ms, 300_000);
      assert.equal(row.extra.predicted_left_ms, 2_400_000);
      assert.equal(row.extra.run_id, "build-1");
      assert.equal(row.extra.run_kind, "build");
    }
    await h.finish();
  });

  test("W1-T12241 criterion 6: under a pause that is not a recycle pause, the review clock admits as today", async (t) => {
    for (const detail of [OPERATOR, `${RECYCLE} (operator)`]) {
      const clock = await pauseClock(t, detail, 2500);
      assert.ok(clock.calls.length > 0, "an operator pause clock still runs review passes");
      assert.ok(clock.calls.every((scope) => scope?.reviewOnly === true && scope.admit === undefined),
        "no recycle predicate is carried");
      assert.equal(clock.rows.filter((r) => r.step.startsWith("daemon.recycle_wait")).length, 0);
    }
  });

  test("W1-T12241 criterion 4: under a recycle pause the review clock admits a review that ends first, and holds one that does not", async (t) => {
    const admitted = await pauseClock(t, RECYCLE, 300);
    assert.ok(admitted.calls.length > 0, "the clock ran a pass under the recycle pause");
    assert.ok(admitted.calls.every((scope) => scope?.reviewOnly === true && scope.admit?.recycleWait === true),
      "each pass carries the recycle wait's predicate");
    assert.equal(admitted.rows.filter((r) => r.step === "daemon.review_clock.held").length, 0);

    for (const [reviewS, buildRun] of [[2500, true], [300, false]] as const) {
      const held = await pauseClock(t, RECYCLE, reviewS, buildRun);
      assert.deepEqual(held.calls, [], "no pass runs when the review would outlive the wait");
      assert.ok(held.rows.some((r) => r.step === "daemon.review_clock.held" && r.extra.reason === "recycle_pause"
        && r.extra.during_pause === true && r.extra.detail === RECYCLE), "the hold keeps today's row");
    }
  });

  test("W1-T12241 criterion 9: the in-flight ticker of a dispatch phase asks the same function under a recycle pause", async (t) => {
    const admitted = await dispatchPhase(t, RECYCLE, 300);
    assert.ok(admitted.calls.length > 0, "a review-only pass ran beside the build run");
    assert.ok(admitted.calls.every((c) => c.scope?.reviewOnly === true && c.scope.admit?.recycleWait === true));
    assert.ok(admitted.rows.some((r) => r.step === "daemon.recycle_wait.review_admitted" && r.extra.surface === "light"));

    const held = await dispatchPhase(t, RECYCLE, 2500);
    assert.deepEqual(held.calls, [], "no pass runs when the review would outlive the wait");
    assert.ok(held.rows.some((r) => r.step === "daemon.sweep_light.held" && r.extra.phase === "dispatch"
      && r.extra.reason === "recycle_pause" && r.extra.detail === RECYCLE));
  });
});
