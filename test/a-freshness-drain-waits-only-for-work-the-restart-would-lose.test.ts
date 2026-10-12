import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runDaemon } from "../src/lib/daemon.js";
import { loadPlan } from "../src/lib/plan.js";
import {
  detachSweepAction, detachedSweepActionCount, drainDetachedSweepActions,
  drainInFlightReviews, trackInFlightReview,
  runSweepLightPass, type DetachedActionKind, type DetachedFixPhase,
  buildSweepEffects,
} from "./helpers/sweep-test.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import type { runFixRung } from "./helpers/run-task-test.js";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

async function waitFor(predicate: () => boolean) {
  for (let i = 0; i < 2000; i++) {
    if (predicate()) return;
    await tick();
  }
  assert.fail("the expected drain state was never observed");
}

function fixturePlan() {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t5721-`));
  const file = join(root, "tasks.yaml");
  writeFileSync(file, "- id: A\n  title: a\n  repo: remudero\n  type: implement\n  risk: low\n  depends_on: []\n  status: queued\n");
  return loadPlan(file);
}

test("test/a-freshness-drain-waits-only-for-work-the-restart-would-lose.test.ts: releases retro and CI wait at once, awaiting the live worker and review", async () => {
  const retro = gate();
  const ci = gate();
  const worker = gate();
  const review = gate();
  const rows: Array<{ step: string; extra: Record<string, unknown> }> = [];
  let registered = false;
  let finished = false;
  const daemon = runDaemon(fixturePlan(), {
    refreshMerged: () => () => true,
    runOne: async (taskId) => ({ taskId, runId: taskId, merged: true, costUsd: 0, verdict: "merged" }),
    sleep: tick,
    checkFreshness: () => ({ stale: true, oldSha: "a".repeat(40), newSha: "b".repeat(40) }),
    log: (step, extra = {}) => rows.push({ step, extra }),
    sweep: async () => {
      if (registered) return;
      registered = true;
      detachSweepAction(retro.promise, { actionKind: "retro", taskId: "DAEMON" });
      detachSweepAction(ci.promise, { actionKind: "fix-dispatch", taskId: "CI", phase: "ci-wait" });
      detachSweepAction(worker.promise, { actionKind: "fix-dispatch", taskId: "WORKER", phase: "worker" });
      void trackInFlightReview(review.promise);
    },
  }, { sweepWallClockBoundMs: 1000 }).then((result) => { finished = true; return result; });
  try {
    await waitFor(() => rows.some((row) => row.step === "daemon.freshness_drain.started"));
    const releases = rows.filter((row) => row.step === "daemon.detached_action_released");
    assert.deepEqual(releases.map((row) => [row.extra.action_kind, row.extra.phase, row.extra.reason]), [
      ["retro", "best-effort", "best-effort cadence is redone after restart"],
      ["fix-dispatch", "ci-wait", "pushed fix CI wait is re-derived after restart"],
    ]);
    assert.equal(finished, false);
    worker.release();
    for (let i = 0; i < 20; i++) await tick();
    assert.equal(finished, false, "the review is still running after the worker finishes");
    review.release();
    await waitFor(() => finished);
    assert.equal((await daemon).stopReason, "stale");
    assert.equal(detachedSweepActionCount(), 2, "released work remains registered for dedup until it settles");
    assert.equal(rows.some((row) => row.step === "daemon.detached_action_abandoned"), false);
    assert.equal(rows.find((row) => row.step === "daemon.freshness_drain.completed")!.extra.abandoned_in_flight_reviews, 0);
  } finally {
    for (const held of [retro, ci, worker, review]) held.release();
    await daemon;
    await drainDetachedSweepActions();
    await drainInFlightReviews({ boundMs: 1000 });
  }
});

test("freshness releases every best-effort cadence without losing its in-flight dedup", async () => {
  const held = gate();
  const kinds: DetachedActionKind[] = ["retro", "auto-triage", "ci-learning", "measurement-cadence", "benchmark-cohort"];
  for (const actionKind of kinds) detachSweepAction(held.promise, { actionKind, taskId: "DAEMON" });
  const releases: string[] = [];
  try {
    assert.deepEqual(await drainDetachedSweepActions({
      boundMs: 0, freshness: true, onRelease: (action) => releases.push(action.actionKind),
    }), []);
    assert.deepEqual(releases, kinds);
    assert.equal(detachedSweepActionCount(), kinds.length);
  } finally {
    held.release();
    await drainDetachedSweepActions();
  }
});

test("a live detached fix entering its CI wait wakes the freshness drain before its bound", async () => {
  const worker = gate();
  const ci = gate();
  const releases: Array<{ phase: string; taskId: string }> = [];
  const sweep = await runSweepLightPass([{
    prNumber: 5721, prUrl: "https://github.com/o/r/pull/5721", taskId: "FIX",
    reviewState: "failure", checksState: "green", headSha: "head", priorStrikes: 0,
    autoMergeArmed: false, lastActivityAt: new Date().toISOString(),
    unmetCriteria: [{ claim: "repair", proof: "unit test: repair", met: false, reason: "broken", proof_exec: "executed_fail" }],
  }], {
    arm: () => {}, close: () => {}, escalate: () => {},
    readLedger: () => [], appendLine: () => {}, ledgerPath: "/unused", runId: "T5721",
    dispatchFix: async (_pr, _evidence, onPhase) => {
      assert.equal(typeof onPhase, "function", "the sweep forwards the phase seam to its detached fix");
      await worker.promise;
      onPhase!("ci-wait");
      await ci.promise;
      onPhase!("worker");
    },
  });
  let finished = false;
  const drain = drainDetachedSweepActions({
    boundMs: 1000, freshness: true, onRelease: (action) => releases.push(action),
  }).then((result) => { finished = true; return result; });
  try {
    assert.equal(sweep.length, 1);
    for (let i = 0; i < 20; i++) await tick();
    assert.equal(finished, false, "a running worker still holds the drain");
    worker.release();
    await waitFor(() => finished);
    assert.deepEqual(await drain, []);
    assert.deepEqual(releases.map(({ phase, taskId }) => [phase, taskId]), [["ci-wait", "FIX"]]);
    assert.equal(detachedSweepActionCount(), 1, "CI is still pending");
  } finally {
    worker.release();
    ci.release();
    await drain;
    await drainDetachedSweepActions();
  }
});

test("the freshness bound reports only the live fix and review, with a conservative omitted phase", async () => {
  const held = gate();
  detachSweepAction(held.promise, { actionKind: "retro", taskId: "DAEMON" });
  detachSweepAction(held.promise, { actionKind: "fix-dispatch", taskId: "CI", phase: "ci-wait" });
  detachSweepAction(held.promise, { actionKind: "fix-dispatch", taskId: "LIVE" });
  void trackInFlightReview(held.promise);
  try {
    const [abandoned, reviews] = await Promise.all([
      drainDetachedSweepActions({ boundMs: 0, freshness: true }),
      drainInFlightReviews({ boundMs: 0 }),
    ]);
    assert.deepEqual(abandoned.map(({ actionKind, taskId }) => [actionKind, taskId]), [["fix-dispatch", "LIVE"]]);
    assert.equal(reviews, 1);
    assert.ok(abandoned[0]!.ageMs >= 0);
  } finally {
    held.release();
    await drainDetachedSweepActions();
    await drainInFlightReviews({ boundMs: 1000 });
  }
});

test("ordinary drains still await cadences and CI waits", async () => {
  const held = gate();
  detachSweepAction(held.promise, { actionKind: "retro", taskId: "DAEMON" });
  const changePhase = detachSweepAction(held.promise, { actionKind: "fix-dispatch", taskId: "CI", phase: "ci-wait" });
  const phases: DetachedFixPhase[] = ["worker", "ci-wait"];
  let finished = false;
  const drain = drainDetachedSweepActions().then((result) => { finished = true; return result; });
  try {
    for (const phase of phases) {
      changePhase(phase);
      for (let i = 0; i < 20; i++) await tick();
      assert.equal(finished, false);
    }
    held.release();
    assert.deepEqual(await drain, []);
  } finally {
    held.release();
    await drain;
  }
});

test("a fix that resumes work before the freshness drain starts is awaited again", async () => {
  const held = gate();
  const changePhase = detachSweepAction(held.promise, { actionKind: "fix-dispatch", taskId: "FIX", phase: "ci-wait" });
  changePhase("worker");
  const releases: string[] = [];
  try {
    const abandoned = await drainDetachedSweepActions({
      boundMs: 0, freshness: true, onRelease: (action) => releases.push(action.phase),
    });
    assert.deepEqual(abandoned.map((action) => action.taskId), ["FIX"]);
    assert.deepEqual(releases, []);
  } finally {
    held.release();
    await drainDetachedSweepActions();
  }
});

test("the production fix adapter marks only the CI wait releasable and restores worker phase on success and error", async () => {
  for (const failCi of [false, true]) {
    const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t5721-adapter-`));
    const worker = gate();
    const ci = gate();
    const phases: DetachedFixPhase[] = [];
    const errors: string[] = [];
    let enteredWorker = false;
    let dispatch: Promise<unknown> | undefined;
    try {
      for (const path of ["state/inflight", "repos/fixture", "tmp"]) mkdirSync(join(root, path), { recursive: true });
      const effects = buildSweepEffects({
        owner: "o", repo: "fixture", repoRoot: process.cwd(), config: { root } as never,
        ledgerPath: join(root, "state", "ledger.ndjson"), runId: "T5721", plan: fixturePlan(),
        log: (step, extra) => { if (step === "sweep.fix.error") errors.push(String(extra?.error)); },
        dispatchFixPreflightStandDownImpl: async () => undefined,
        ghJsonImpl: () => ({ headRefName: "run-A-1791276532882", headRefOid: "head", body: "" }),
        fixBranchClaimKeyImpl: () => "t5721-branch",
        registeredWorktreeOwnerImpl: () => undefined,
        createFixRungWorktreeImpl: () => undefined,
        captureWorktreeSnapshotImpl: () => ({ headSha: "head" }),
        buildFixRungDispatchArgsImpl: () => ({}),
        openTaskIdsFromPlanImpl: () => new Set(),
        runFixRungImpl: async (args: Parameters<typeof runFixRung>[0]) => {
          args.deps.log("fix.dispatch");
          enteredWorker = true;
          await worker.promise;
          await args.deps.waitForCiGreen("https://github.com/o/fixture/pull/5721", () => {});
        },
        waitForCiGreenImpl: async () => {
          assert.equal(phases.at(-1), "ci-wait");
          await ci.promise;
          if (failCi) throw new Error("CI read failed");
          return { state: "green" };
        },
        readPackageScriptsImpl: () => ({}),
        worktreeRemoveImpl: () => {},
      });
      dispatch = Promise.resolve(effects.dispatchFix!({
        prNumber: 5721, prUrl: "https://github.com/o/fixture/pull/5721", taskId: "A",
        headSha: "head", priorStrikes: 0, reviewState: "failure", checksState: "green",
        unmetCriteria: [], autoMergeArmed: false, lastActivityAt: new Date().toISOString(),
      }, { unmetCriteria: [] }, (phase) => phases.push(phase)));
      await waitFor(() => enteredWorker);
      assert.deepEqual(phases, [], "no release is declared during the worker or before push");
      worker.release();
      await waitFor(() => phases.length === 1);
      ci.release();
      await dispatch;
      assert.deepEqual(phases, ["ci-wait", "worker"]);
      assert.deepEqual(errors, failCi ? ["CI read failed"] : []);
    } finally {
      worker.release();
      ci.release();
      await dispatch;
      rmSync(root, { recursive: true, force: true });
    }
  }
});
