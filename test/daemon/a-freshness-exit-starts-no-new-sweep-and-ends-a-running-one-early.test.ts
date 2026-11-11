// W1-T12237: a freshness exit starts no sweep, and a running sweep ends between pull requests.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { setImmediate as flush } from "node:timers/promises";
import { runDaemon, type DaemonDeps, type ReviewAdmissionGate } from "#src/lib/daemon.js";
import { DEPLOY_RESTART_SCORE_THRESHOLD, FRESHNESS_COALESCE_WINDOW_MS } from "#src/lib/deploy-judge.js";
import { loadPlan } from "#src/lib/plan.js";
import { runSweep, type OpenPrView, type SweepDeps } from "#src/lib/sweep.js";
import { readLedgerLines } from "#src/lib/status.js";
import { writeLedger } from "#test/helpers/ledger-fixture.js";

type Row = { step: string; extra?: Record<string, unknown> };
type RunResult = Awaited<ReturnType<DaemonDeps["runOne"]>>;

const windowMs = FRESHNESS_COALESCE_WINDOW_MS.value;
const stale = { stale: true as const, oldSha: "a".repeat(40), newSha: "b".repeat(40),
  changes: Array.from({ length: DEPLOY_RESTART_SCORE_THRESHOLD.value }, (_, index) => ({
    sha: index === 0 ? "b".repeat(40) : String(index).padStart(40, "e"), subject: "fix: refresh", files: ["src/lib/daemon.ts"],
  })) };
const NOW = Date.UTC(2026, 10, 11, 8);

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function pr(prNumber: number): OpenPrView {
  return { prNumber, prUrl: `url/${prNumber}`, taskId: `W1-T${prNumber}`, headSha: `head-${prNumber}`,
    checksState: "green", reviewState: "success", autoMergeArmed: false, priorStrikes: 0, unmetCriteria: [],
    lastActivityAt: new Date(NOW).toISOString() };
}

function sweepDeps(log: (step: string, extra?: Record<string, unknown>) => void, arm: SweepDeps["arm"]): SweepDeps {
  return { arm, close: () => {}, dispatchFix: () => {}, escalate: () => {}, ledgerPath: writeLedger([]).path,
    runId: "w1-t12237", now: () => NOW, log };
}

function emptyPlan(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "rmd-t12237-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "tasks.yaml");
  writeFileSync(path, "[]\n");
  return loadPlan(path);
}

const restartRow = (rows: Row[]) => rows.find(({ step }) => step === "daemon_selfrestart_for_freshness")?.extra;

// An idle daemon: the first tick defers the stale reading and runs its pass; a later tick exits.
async function idleExit(t: TestContext, over: Partial<DaemonDeps> = {}, sweep?: DaemonDeps["sweep"]) {
  let nowMs = NOW;
  let calls = 0;
  const rows: Row[] = [];
  const summary = await runDaemon(emptyPlan(t), {
    now: () => new Date(nowMs),
    checkFreshness: () => stale,
    refreshMerged: () => () => true,
    runOne: async () => { assert.fail("an empty plan cannot dispatch"); },
    sweep: async (gate) => { calls++; return sweep?.(gate); },
    sleep: async () => { nowMs += windowMs; },
    log: (step, extra) => { rows.push({ step, extra }); },
    ...over,
  }, { freshnessMinLifetimeMs: 0 });
  return { summary, rows, calls: () => calls };
}

test("W1-T12237 criterion 1: a restart with no sweep running starts no sweep and names no_sweep_at_exit", async (t) => {
  const h = await idleExit(t);
  assert.equal(h.summary.stopReason, "stale");
  assert.equal(h.calls(), 1, "only the first tick's pass ran; the exit started none");
  assert.deepEqual(restartRow(h.rows), { old_sha: stale.oldSha, new_sha: stale.newSha, pre_exit_pass: "no_sweep_at_exit",
    stale_since_ms: NOW, last_pass_completed_ms: NOW });
  const exit = h.rows.find(({ step }) => step === "daemon.freshness_exit")?.extra;
  assert.equal((exit?.phases_ms as Record<string, unknown>).pre_exit_pass, undefined, "no pass was timed at exit");
});

test("W1-T12237 criterion 2: the stale reviewer exit and a requested restart start no sweep", async (t) => {
  const reviewer = await idleExit(t, { checkFreshness: () => ({ stale: false }) },
    async () => ({ reviewerCodeStale: { oldSha: stale.oldSha, newSha: stale.newSha } }));
  assert.equal(reviewer.summary.stopReason, "stale");
  const askedAt = reviewer.rows.findIndex(({ step }) => step === "review.stale_reviewer_restart_requested");
  assert.ok(askedAt >= 0, "the stale reviewer exit fired");
  assert.equal(reviewer.rows.slice(askedAt).some(({ step }) => step === "daemon.sweep.started"), false,
    "no sweep started after the restart was asked for");
  assert.equal(restartRow(reviewer.rows)?.pre_exit_pass, "no_sweep_at_exit");

  let requested = false;
  const request = await idleExit(t, {
    checkFreshness: () => ({ stale: false }),
    consumeRestartRequest: () => {
      if (requested) return null;
      requested = true;
      return { origin: "console", requestedAt: new Date(NOW + 1).toISOString() };
    },
  });
  assert.equal(request.summary.stopReason, "stale");
  assert.equal(restartRow(request.rows)?.pre_exit_pass, "no_sweep_at_exit");
});

// The latched exit: a restart decided while a lane runs, through the real dispatch tick (W1-T8170's harness).
async function latched(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "rmd-t12237-latch-"));
  const path = join(root, "tasks.yaml");
  writeFileSync(path, "- id: A\n  title: A\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n  files: [src/A.ts]\n");
  const lane = deferred<RunResult>();
  const sleeps: Array<ReturnType<typeof deferred<void>>> = [];
  const rows: Row[] = [];
  const arms: number[] = [];
  const epoch = Date.now();
  let nowMs = epoch;
  let isStale = false;
  let cleaning = false;
  let calls = 0;
  const run = runDaemon(loadPlan(path), {
    now: () => new Date(nowMs),
    checkFreshness: () => isStale ? stale : { stale: false },
    checkStop: () => cleaning ? "cleanup" : undefined,
    refreshMerged: () => () => false,
    runOne: () => lane.promise,
    sweep: async (gate?: ReviewAdmissionGate) => {
      calls++;
      await runSweep([pr(1), pr(2)], { ...sweepDeps((step, extra) => rows.push({ step, extra }),
        (open) => { arms.push(open.prNumber); return "armed"; }), continueReviewAdmissions: gate });
    },
    sleep: () => { const wait = deferred(); sleeps.push(wait); return wait.promise; },
    log: (step, extra) => { rows.push({ step, extra }); },
  }, { freshnessMinLifetimeMs: 0, laneCount: 1, max: 1, sweepRetriggerIntervalMs: 2 * windowMs });
  t.after(async () => {
    cleaning = true;
    lane.resolve({ taskId: "A", runId: "fixture", merged: true, verdict: "merged", costUsd: 0 });
    for (const wait of sleeps.splice(0)) wait.resolve();
    await run;
    rmSync(root, { recursive: true, force: true });
  });
  const tick = async (ageMs: number) => {
    nowMs = epoch + ageMs;
    for (const wait of sleeps.splice(0)) wait.resolve();
    await flush();
    await flush();
  };
  await flush();
  await flush();
  return { run, rows, arms, calls: () => calls, tick, stale: () => { isStale = true; },
    settle: async () => {
      nowMs++;
      lane.resolve({ taskId: "A", runId: "fixture", merged: true, verdict: "merged", costUsd: 0 });
      await flush();
      await flush();
    } };
}

test("W1-T12237 criterion 2: the exit after a restart decided during dispatch starts no sweep", async (t) => {
  const h = await latched(t);
  assert.equal(h.calls(), 1, "boot ran its pass");
  assert.deepEqual(h.arms, [1, 2], "the boot pass visited both pull requests");
  h.stale();
  await h.tick(1);
  await h.tick(windowMs + 1);
  assert.ok(h.rows.some(({ step, extra }) => step === "daemon.freshness_decision" && extra?.action === "restart"));
  await h.settle();
  assert.equal((await h.run).stopReason, "stale");
  assert.equal(h.calls(), 1, "the latched exit started no sweep");
  assert.equal(restartRow(h.rows)?.pre_exit_pass, "no_sweep_at_exit");
});

test("W1-T12237 criterion 4: a sweep that starts after the restart decision starts no stage", async (t) => {
  const h = await latched(t);
  h.stale();
  await h.tick(1);
  await h.tick(windowMs + 1);
  await h.tick(2 * windowMs + 2);
  assert.equal(h.calls(), 2, "the retrigger started a pass after the latch");
  const ended = h.rows.filter(({ step }) => step === "sweep.ended_early");
  assert.deepEqual(ended.map(({ extra }) => extra), [{ reason: "restart_decided", stage: "start", prs_not_visited: 2 }]);
  assert.deepEqual(h.arms, [1, 2], "the pass after the latch armed nothing");
  assert.equal(h.rows.filter(({ step }) => step === "sweep.pass").length, 1, "only the boot pass reached its walk");
  await h.settle();
  assert.equal((await h.run).stopReason, "stale");
  assert.equal(restartRow(h.rows)?.pre_exit_pass, "no_sweep_at_exit", "an early end is not a completed pass");
  assert.equal(restartRow(h.rows)?.sweep_ended_early, true);
});

test("W1-T12237 criterion 4: a sweep stopped in its prelude runs none of the later stages", async () => {
  const rows: Row[] = [];
  const marks: string[] = [];
  let asked = 0;
  let drafts = 0;
  const gate = Object.assign(() => true, { restartDecided: () => ++asked > 2 });
  const summary = await runSweep([{ ...pr(1), isDraft: true }, pr(2)], {
    ...sweepDeps((step, extra) => rows.push({ step, extra }), () => assert.fail("no arm after the stop")),
    continueReviewAdmissions: gate, markPrelude: (stage) => { marks.push(stage); },
    readyDraft: async () => { drafts++; },
  });
  assert.deepEqual(marks, ["sweep_entry", "reader_agreement"], "the pass stopped before the armed body guard");
  assert.equal(drafts, 0, "the draft stage had not begun, so it never ran");
  assert.deepEqual(rows.filter(({ step }) => step === "sweep.ended_early").map(({ extra }) => extra),
    [{ reason: "restart_decided", stage: "reader_agreement", prs_not_visited: 2 }]);
  assert.equal(rows.some(({ step }) => step === "sweep.pass" || step === "sweep.disposed"), false);
  assert.equal(summary.actionsTaken, 0);
});

test("W1-T12237 criterion 3: a running sweep finishes the pull request in hand and visits no other", async () => {
  const rows: Row[] = [];
  let decided = false;
  const armed: number[] = [];
  const gate = Object.assign(() => true, { restartDecided: () => decided });
  const deps = sweepDeps((step, extra) => rows.push({ step, extra }), () => "armed");
  await runSweep([pr(1), pr(2), pr(3)], {
    ...deps,
    arm: (open) => {
      armed.push(open.prNumber);
      decided = true;
      return "armed";
    },
    continueReviewAdmissions: gate,
  });
  const disposed = readLedgerLines(deps.ledgerPath).filter(({ step }) => step === "sweep.disposed");
  assert.equal(armed.length, 1, "the walk stopped after the pull request in hand");
  assert.deepEqual(disposed.map((row) => row.pr_number), [armed[0]], "the pull request in hand was disposed");
  assert.ok(rows.some(({ step }) => step === "sweep.summary"), "the pass settled with its summary row");
});

// A background pass is arming its first pull request when a later tick decides the restart.
async function armInHand(t: TestContext) {
  const arm = deferred<"armed">();
  const armBegun = deferred();
  const armed: number[] = [];
  const rows: Row[] = [];
  let armDone = false;
  let finished = false;
  let first = true;
  const exit = idleExit(t, {
    log: (step, extra) => {
      rows.push({ step, extra });
      if (step === "daemon.freshness_decision" && extra?.action === "restart") arm.resolve("armed");
    },
  }, async (gate) => {
    if (!first) return;
    first = false;
    await runSweep([pr(1), pr(2)], { ...sweepDeps((step, extra) => rows.push({ step, extra }), async (open) => {
      armed.push(open.prNumber);
      armBegun.resolve();
      const outcome = await arm.promise;
      armDone = true;
      return outcome;
    }), continueReviewAdmissions: gate });
  });
  void exit.then(() => { finished = true; });
  await armBegun.promise;
  const finishedWhileArming = finished;
  const { summary } = await exit;
  return { summary, rows, armed, armDone, finishedWhileArming };
}

test("W1-T12237 criterion 5: an arm begun for the pull request in hand completes and the exit waits for the sweep", async (t) => {
  const h = await armInHand(t);
  assert.equal(h.finishedWhileArming, false, "the exit waits for the running sweep");
  assert.equal(h.summary.stopReason, "stale");
  assert.equal(h.armDone, true, "the arm begun for the pull request in hand completed");
  assert.deepEqual(h.armed, [1], "no other pull request was visited");
  const settled = h.rows.findIndex(({ step }) => step === "daemon.sweep.settled");
  assert.ok(settled >= 0 && settled < h.rows.findIndex(({ step }) => step === "daemon.freshness_exit"),
    "the sweep settled before the exit");
  assert.equal(restartRow(h.rows)?.pre_exit_pass, "awaited_in_flight");
});

test("W1-T12237 criterion 7: a sweep that ended early writes one row and the restart row says so", async (t) => {
  const h = await armInHand(t);
  assert.deepEqual(h.rows.filter(({ step }) => step === "sweep.ended_early").map(({ extra }) => extra),
    [{ reason: "restart_decided", stage: "walk", prs_not_visited: 1 }]);
  assert.equal(h.rows.find(({ step }) => step === "daemon.sweep.settled")?.extra?.ended_early, true);
  assert.deepEqual(restartRow(h.rows), { old_sha: stale.oldSha, new_sha: stale.newSha, pre_exit_pass: "awaited_in_flight",
    stale_since_ms: NOW, last_pass_completed_ms: null, sweep_ended_early: true });
});

test("W1-T12237 criterion 6: the first tick of the next lifetime starts a whole sweep", async (t) => {
  const first = await idleExit(t);
  assert.equal(first.summary.stopReason, "stale");
  const rows: Row[] = [];
  const armed: number[] = [];
  let stopped = false;
  const next = await runDaemon(emptyPlan(t), {
    now: () => new Date(NOW),
    checkFreshness: () => ({ stale: false }),
    checkStop: () => stopped ? "test done" : undefined,
    refreshMerged: () => () => true,
    runOne: async () => { assert.fail("an empty plan cannot dispatch"); },
    sweep: async (gate) => {
      await runSweep([pr(1), pr(2)], { ...sweepDeps((step, extra) => rows.push({ step, extra }), (open) => {
        armed.push(open.prNumber);
        return "armed";
      }), continueReviewAdmissions: gate });
      stopped = true;
    },
    sleep: async () => {},
    log: (step, extra) => { rows.push({ step, extra }); },
  }, { freshnessMinLifetimeMs: 0 });
  assert.equal(next.stopReason, "stopped");
  assert.deepEqual(armed.sort(), [1, 2], "the first pass of the new lifetime visited every pull request");
  assert.equal(rows.some(({ step }) => step === "sweep.ended_early"), false);
});
