import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test, type TestContext } from "node:test";
import { runDaemon, type LightPassScope } from "#src/lib/daemon.js";
import { loadPlan } from "#src/lib/plan.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

const RECYCLE = "PAUSE requested: container recycle (deploy/recycle-container.sh)";
const OPERATOR = "PAUSE requested: investigating an incident";
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
type Row = { step: string; extra: Record<string, unknown> };

function fixturePlan(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}recycle-no-review-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, "tasks.yaml");
  writeFileSync(file, "- id: A\n  title: a\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n");
  return loadPlan(file);
}

async function dispatchPhase(t: TestContext, detail: string, clear = false) {
  const rows: Row[] = [];
  const calls: Array<{ pause: string | undefined; reviewOnly: boolean; tick: number }> = [];
  let sleeps = 0;
  let pause: string | undefined;
  let release!: () => void;
  const lane = new Promise<void>((resolve) => { release = resolve; });
  const merged = new Set<string>();
  const summary = await runDaemon(fixturePlan(t), {
    refreshMerged: () => (id) => merged.has(id),
    runOne: async (id) => {
      await lane;
      merged.add(id);
      return { taskId: id, runId: `${id}-run`, merged: true, costUsd: 0, verdict: "merged" };
    },
    checkPause: () => pause,
    checkStop: () => undefined,
    sweepLight: async (scope?: LightPassScope) => {
      calls.push({ pause, reviewOnly: scope?.reviewOnly === true, tick: sleeps });
    },
    sleep: async () => {
      sleeps++;
      if (sleeps === 2) pause = detail;
      if (clear && sleeps === 6) pause = undefined;
      if (sleeps >= 10) release();
      await settle();
    },
    log: (step, extra = {}) => rows.push({ step, extra }),
  }, { max: 1, pollIntervalMs: 1 });
  await settle();
  assert.deepEqual(summary.merged, ["A"], "the lane admitted before PAUSE finishes normally");
  assert.ok(calls.some((c) => c.pause === undefined), "control: the unpaused ticker ran");
  return { rows, calls };
}

async function pauseClock(t: TestContext, initialPause: string, clear = false, existingReview = false) {
  const rows: Row[] = [];
  const calls: Array<{ pause: string | undefined; reviewOnly: boolean }> = [];
  let waits = 0;
  let pause: string | undefined = initialPause;
  let nowMs = 0;
  let merged = !clear;
  let releaseReview!: () => void;
  const review = new Promise<void>((resolve) => { releaseReview = resolve; });
  let finishedDuringRecycle = false;
  const summary = await runDaemon(fixturePlan(t), {
    refreshMerged: () => () => merged,
    runOne: async (id) => {
      assert.equal(clear, true, "only the resume fixture dispatches");
      assert.equal(pause, undefined, "dispatch waits for the recycle pause to clear");
      for (let i = 0; i < 6; i++) await settle();
      merged = true;
      return { taskId: id, runId: `${id}-run`, merged: true, costUsd: 0, verdict: "merged" };
    },
    checkPause: () => pause,
    checkStop: () => waits >= 24 ? "fixture finished" : undefined,
    now: () => new Date(nowMs),
    sleep: async () => { await settle(); },
    sleepUntilSweepWake: async (ms) => {
      await settle();
      nowMs += ms;
      waits++;
      if (clear && waits === 10) pause = undefined;
      if (waits === 10) releaseReview();
      return waits % 2 === 0 ? "wake" : "timeout";
    },
    sweepLight: async (scope?: LightPassScope) => {
      calls.push({ pause, reviewOnly: scope?.reviewOnly === true });
      if (existingReview) {
        pause = RECYCLE;
        await review;
        finishedDuringRecycle = pause === RECYCLE;
      }
    },
    log: (step, extra = {}) => rows.push({ step, extra }),
  }, { pollIntervalMs: 1 });
  assert.equal(summary.stopReason, "stopped");
  assert.ok(rows.filter((r) => r.step === "daemon.pause").length >= 3,
    "control: multiple paused ticks and clock waits elapsed");
  return { rows, calls, finishedDuringRecycle };
}

describe("test/a-recycle-pause-admits-no-new-review-worker.test.ts", () => {
  test("W1-T8136: a recycle pause runs no review-only light pass", async (t) => {
    for (const detail of [RECYCLE, `${RECYCLE}; actor: operator@fleet`]) {
      const { calls, rows } = await dispatchPhase(t, detail);
      assert.deepEqual(calls.filter((c) => c.pause !== undefined), [], "no new pass during recycle");
      assert.ok(rows.some((r) => r.step === "daemon.sweep_light.held"
        && r.extra.phase === "dispatch" && r.extra.reason === "recycle_pause" && r.extra.detail === detail),
      "the dispatch ticker names the recycle hold while the lane is in flight");
    }
  });

  test("W1-T8136: the pause review clock admits no review under a recycle pause", async (t) => {
    for (const detail of [RECYCLE, `${RECYCLE}; actor: operator@fleet`]) {
      const { calls, rows } = await pauseClock(t, detail);
      assert.deepEqual(calls, [], "neither interval nor event wakes admit a review");
      assert.ok(rows.some((r) => r.step === "daemon.review_clock.held"
        && r.extra.during_pause === true && r.extra.reason === "recycle_pause" && r.extra.detail === detail),
      "the pause clock reports why it skipped its pass");
    }
  });

  test("W1-T8136: an operator pause still runs the review-only pass", async (t) => {
    for (const detail of [OPERATOR, `${RECYCLE} (operator)`]) {
      const dispatch = await dispatchPhase(t, detail);
      const paused = dispatch.calls.filter((c) => c.pause === detail);
      assert.ok(paused.length > 0, "operator pause admits reviews beside an in-flight lane");
      assert.ok(paused.every((c) => c.reviewOnly), "the fix rung stays closed");
      const clock = await pauseClock(t, detail);
      assert.ok(clock.calls.length > 0, "operator pause clock still admits reviews");
      assert.ok(clock.calls.every((c) => c.reviewOnly), "pause clock runs only review passes");
    }
  });

  test("W1-T8136: reviews resume once the recycle pause clears", async (t) => {
    const dispatch = await dispatchPhase(t, RECYCLE, true);
    assert.deepEqual(dispatch.calls.filter((c) => c.pause === RECYCLE), []);
    const heldAt = dispatch.rows.findIndex((r) => r.step === "daemon.sweep_light.held"
      && r.extra.reason === "recycle_pause");
    assert.ok(heldAt >= 0, "the recycle pause was observed before clearing");
    assert.ok(dispatch.calls.some((c) => c.tick >= 6 && c.pause === undefined),
      "the dispatch ticker resumes light passes after the recycle hold clears");
    const clock = await pauseClock(t, RECYCLE, true);
    assert.deepEqual(clock.calls.filter((c) => c.pause === RECYCLE), []);
    assert.ok(clock.calls.some((c) => c.pause === undefined), "reviews resume on a later unpaused pass");
    assert.ok(clock.rows.some((r) => r.step === "daemon.review_clock.held"
      && r.extra.reason === "recycle_pause"), "the clock held admission before clearing");
  });

  test("W1-T8136: a review already in flight finishes during the recycle pause", async (t) => {
    const { calls, rows, finishedDuringRecycle } = await pauseClock(t, OPERATOR, false, true);
    assert.deepEqual(calls, [{ pause: OPERATOR, reviewOnly: true }], "no second review starts during drain");
    assert.equal(finishedDuringRecycle, true, "the admitted review completes under the recycle hold");
    assert.ok(rows.some((r) => r.step === "daemon.review_clock.pass" && r.extra.during_pause === true),
      "the finished review pass still reports completion");
    assert.ok(rows.some((r) => r.step === "daemon.review_clock.held" && r.extra.reason === "recycle_pause"),
      "the existing pause clock notices the transition from operator to recycle pause");
  });
});
