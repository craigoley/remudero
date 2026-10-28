import assert from "node:assert/strict";
import { test } from "node:test";
import {
  detachedSweepActionCount, drainDetachedSweepActions, productionFixProgressJudge,
  runSweep, runSweepLightPass, type OpenPrView, type SweepDeps,
} from "#src/lib/sweep.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

function fixture(waitForMemory = true, holdJudge = waitForMemory) {
  const now = Date.now();
  const rows: Record<string, unknown>[] = [];
  const admission = deferred();
  const entered = deferred();
  let spawns = 0;
  const dispatched: number[] = [];
  const reviewed: number[] = [];
  const pr: OpenPrView = {
    prNumber: 9814, prUrl: "https://github.com/fixture/repo/pull/9814", taskId: "W1-T9814",
    headSha: "memory-held-head", checksState: "red", reviewState: "pending", unmetCriteria: [],
    priorStrikes: 3, autoMergeArmed: false, lastActivityAt: new Date(now).toISOString(),
    reviewInputDigest: "body-A", redRequiredChecks: ["ci"],
    ciFailures: [{ name: "ci", logTail: "Error: fixture assertion failed" }],
  };
  const deps: SweepDeps = {
    ledgerPath: "/unused/t9814-ledger", runId: "SWEEP-T9814", now: () => now,
    readLedger: () => [...rows],
    appendLine: (_path, row) => { rows.push({ ts: new Date(now).toISOString(), ...row }); },
    readTaskContractRevision: () => "contract-A",
    arm: () => { assert.fail("red CI cannot arm"); },
    close: () => { assert.fail("no close authorized"); },
    escalate: () => { assert.fail("a continue verdict cannot escalate"); },
    dispatchFix: (candidate) => { dispatched.push(candidate.prNumber); },
    postReview: (candidate) => { reviewed.push(candidate.prNumber); },
    claimFixAdmission: () => ({ admitted: true }),
    readActiveWorkerCount: () => 0,
    readFixPressure: () => ({ availableMib: 8192, floorMib: 1024 }),
    fixProgressJudge: productionFixProgressJudge({ cwd: ".", settingsFile: "settings/worker.json",
      mount: { model: "fixture", effort: "low", maxTurns: 1, contextBudget: 10000 },
      spawn: async (args) => {
        spawns++;
        if (waitForMemory) {
          await args.memoryShadow!.sleep!(0);
        }
        entered.resolve();
        if (holdJudge) await admission.promise;
        return { text: 'FIX_PROGRESS: {"verdict":"continue","reason":"fixture permits repair"}' } as never;
      } }),
  };
  return { pr, deps, rows, admission, entered, dispatched, reviewed, spawns: () => spawns };
}

test("W1-T9814: a full pass stands down on a head held by a memory-waiting light-pass action", async () => {
  const f = fixture();
  const light = runSweepLightPass([f.pr], f.deps);
  let full: ReturnType<typeof runSweep> | undefined;
  try {
    await f.entered.promise;
    await light;
    let returned = false;
    full = runSweep([f.pr], f.deps).then((summary) => { returned = true; return summary; });
    await turn();
    assert.equal(f.spawns(), 1, "the held head must not admit another progress judge");
    assert.equal(returned, true, "the full pass returns while the original judge is waiting");
    const summary = await full;
    assert.equal(summary.total, 1);
    assert.equal(summary.byDisposition.wait, 1);
    assert.equal(summary.actionsTaken, 0);
    const row = f.rows.findLast((row) => row.step === "sweep.disposed");
    assert.equal(row?.disposition, "wait");
    assert.equal(row?.acted, false);
    assert.equal(row?.in_flight_action, "light-pass-action");
    assert.match(String(row?.reason), /still waiting for memory admission/);
    assert.deepEqual(f.dispatched, []);
    await runSweep([{ ...f.pr, headSha: "new-head" }], f.deps);
    assert.equal(f.spawns(), 2, "a different head remains eligible for its own judgment");
  } finally {
    f.admission.resolve();
    await light;
    await full;
    await drainDetachedSweepActions();
  }
});

test("W1-T9814: a full pass progress judgment waiting for memory leaves the pass", async () => {
  const f = fixture();
  const ready = { ...f.pr, prNumber: 9815, headSha: "ready-head", checksState: "green" as const,
    reviewState: "none" as const, priorStrikes: 0, redRequiredChecks: [], ciFailures: [] };
  let returned = false;
  const pass = runSweep([f.pr, ready], f.deps).then((summary) => { returned = true; return summary; });
  try {
    await f.entered.promise;
    await turn();
    assert.equal(returned, true, "admission must not hold the rest of the full pass");
    assert.deepEqual(f.reviewed, [9815], "another head progresses during the memory wait");
    assert.deepEqual(f.dispatched, []);
    assert.equal(f.rows.some((row) => row.step === "fix.progress_judged"), false);
    assert.match(String(f.rows.findLast((row) => row.pr_number === 9814 && row.step === "sweep.disposed")?.stand_down_reason),
      /progress judgment waiting for memory admission/);
    assert.equal(detachedSweepActionCount(), 1);
    await runSweep([f.pr], f.deps);
    await runSweepLightPass([f.pr], f.deps);
    assert.equal(f.spawns(), 1, "both surfaces honor the full pass's hold");
    for (const freshness of [false, true]) {
      const waiting = await drainDetachedSweepActions({ boundMs: 0, freshness });
      assert.equal(waiting.length, 1);
      assert.equal(waiting[0]?.actionKind, "light-pass-action");
    }
    let drained = false;
    const drain = drainDetachedSweepActions().then(() => { drained = true; });
    await turn();
    assert.equal(drained, false, "stop waits for the detached judgment");
    f.admission.resolve();
    await drain;
    assert.equal(detachedSweepActionCount(), 0);
    const judged = f.rows.find((row) => row.step === "fix.progress_judged");
    assert.equal(judged?.verdict, "continue");
    assert.equal(judged?.reason, "fixture permits repair");
    await runSweep([f.pr], f.deps);
    assert.equal(f.spawns(), 1, "the next pass consumes the settled judgment");
    const reused = f.rows.findLast((row) => row.step === "fix.progress_reused");
    assert.equal(reused?.input_key, judged?.input_key);
    assert.equal(reused?.judged_at, judged?.ts);
    assert.deepEqual(f.dispatched, [9814]);
    await pass;
  } finally {
    f.admission.resolve();
    await pass;
    await drainDetachedSweepActions();
  }
});

test("W1-T9814: an unheld head is judged by the full pass as today", async () => {
  const f = fixture(false);
  await runSweep([f.pr], f.deps);
  assert.equal(f.spawns(), 1);
  assert.equal(f.rows.find((row) => row.step === "fix.progress_judged")?.verdict, "continue");
  assert.deepEqual(f.dispatched, [9814]);
  assert.equal(detachedSweepActionCount(), 0);
  const slow = fixture(false, true);
  let returned = false;
  const pass = runSweep([slow.pr], slow.deps).then(() => { returned = true; });
  try {
    await slow.entered.promise;
    await turn();
    assert.equal(returned, false, "a judgment without a memory-wait signal stays inline");
    assert.equal(detachedSweepActionCount(), 0);
    assert.deepEqual(slow.dispatched, []);
    slow.admission.resolve();
    await pass;
    assert.deepEqual(slow.dispatched, [9814]);
  } finally {
    slow.admission.resolve();
    await pass;
  }
});
