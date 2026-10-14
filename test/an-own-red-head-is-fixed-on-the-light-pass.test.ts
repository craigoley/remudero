import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { appendLedger } from "../src/lib/ledger.js";
import { readLedgerLines } from "../src/lib/status.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import {
  drainDetachedSweepActions, runSweep, runSweepLightPass,
  type FixDispatchEvidence, type OpenPrView, type SweepDeps,
} from "../src/lib/sweep.js";
import { fixRungAllowedBesideInFlight, lightPassActionable } from "../src/run-task.js";

const NOW = Date.now();
const DEFERRED = "deferred to full sweep (light pass)";
const WORKING = [{ task_id: "W1-TOTHER", step: "run.start", ts: new Date(NOW).toISOString() }];

function ownRed(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 10866, prUrl: "https://github.com/o/r/pull/10866", taskId: "W1-T8086",
    headSha: "own-red-head", checksState: "red", reviewState: "pending", unmetCriteria: [],
    priorStrikes: 0, autoMergeArmed: false, lastActivityAt: new Date(NOW).toISOString(),
    redRequiredChecks: ["ci"], ciFailures: [{ name: "ci", logTail: "assertion failed in this diff" }],
    ...over,
  };
}

function fixture(t: TestContext, reviewOnly = false) {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t8086-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dispatched: FixDispatchEvidence[] = [];
  const admitted: number[] = [];
  const fixRungAllowed = !reviewOnly && fixRungAllowedBesideInFlight(WORKING, ["W1-TOTHER"]);
  assert.equal(fixRungAllowed, false);
  const deps: SweepDeps = {
    ledgerPath: join(dir, "ledger.ndjson"), runId: "SWEEP-T8086", now: () => NOW,
    arm: () => { assert.fail("an own-red head cannot arm"); },
    close: () => { assert.fail("an own-red head cannot close"); },
    escalate: () => { assert.fail("a continuing fix cannot escalate"); },
    actionable: (d) => lightPassActionable(d, fixRungAllowed, false, !reviewOnly, !reviewOnly),
    dispatchFix: (_pr, evidence) => { dispatched.push(evidence); },
    claimFixAdmission: (pr) => { admitted.push(pr.prNumber); return { admitted: true }; },
    readActiveWorkerCount: () => 0,
    readFixPressure: () => ({ availableMib: 8192, floorMib: 1024 }),
    fixProgressJudge: async () => ({ verdict: "continue", reason: "a repair is available" }),
  };
  const rows = () => readLedgerLines(deps.ledgerPath);
  const disposed = () => rows().filter((row) => row.step === "sweep.disposed");
  return { deps, dispatched, admitted, rows, disposed };
}

test("W1-T8086: a first-seen own-red head is dispatched on the light pass while another run is working", async (t) => {
  const f = fixture(t);
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  f.deps.dispatchFix = (_pr, evidence) => { f.dispatched.push(evidence); return pending; };
  try {
    await runSweepLightPass([ownRed()], f.deps);
    assert.equal(f.dispatched.length, 1, "the first light pass dispatches without any full sweep");
    assert.deepEqual(f.admitted, [10866], "dispatch uses the existing capacity claim");
    assert.deepEqual(f.dispatched[0]!.ciFailures, ownRed().ciFailures);
    assert.equal(f.disposed()[0]!.acted, true, "the pass returns while the fix is still waiting");
    assert.notEqual(f.disposed()[0]!.stand_down_reason, DEFERRED);
  } finally {
    release();
    await drainDetachedSweepActions();
  }
});

test("W1-T8086: a judged continue round is dispatched on the light pass, not deferred to the full sweep", async (t) => {
  const f = fixture(t);
  appendLedger(f.deps.ledgerPath, {
    run_id: "earlier", task_id: "W1-T8086", step: "fix.dispatch", round_id: "round-1",
    head_sha: "earlier-head", pr_number: 10866,
  });
  appendLedger(f.deps.ledgerPath, {
    run_id: "earlier", task_id: "W1-T8086", step: "fix.done", round_id: "round-1",
    head_sha: "earlier-head", pushed_head_sha: "own-red-head", fix_outcome: "FIXED",
  });
  await runSweepLightPass([ownRed({ priorStrikes: 1 })], f.deps);
  await drainDetachedSweepActions();
  assert.equal(f.dispatched.length, 1, "the judged next round runs in this light pass");
  const judgment = f.rows().findLast((row) => row.step === "fix.progress_judged");
  assert.ok(judgment, "the progress judge ran on this pass");
  assert.equal(judgment.verdict, "continue");
  assert.equal(f.dispatched[0]!.progressDecision!.verdict, "continue");
  assert.equal(f.disposed()[0]!.acted, true);
  assert.doesNotMatch(String(f.disposed()[0]!.reason), /NOT DISPATCHED.*deferred to full sweep/);
});

test("W1-T8086: an own-red head the fix capacity refuses names the capacity, not the full sweep", async (t) => {
  const f = fixture(t);
  const reason = "live host capacity exhausted for this light pass";
  f.deps.claimFixAdmission = (pr) => { f.admitted.push(pr.prNumber); return { admitted: false, reason }; };
  await runSweepLightPass([ownRed()], f.deps);
  await drainDetachedSweepActions();
  assert.deepEqual(f.admitted, [10866]);
  assert.equal(f.dispatched.length, 0);
  assert.equal(f.disposed()[0]!.acted, false);
  assert.equal(f.disposed()[0]!.stand_down_reason, reason);
  assert.doesNotMatch(String(f.disposed()[0]!.reason), /deferred to full sweep/);
  f.deps.claimFixAdmission = () => ({ admitted: true });
  await runSweepLightPass([ownRed()], f.deps);
  await drainDetachedSweepActions();
  assert.equal(f.dispatched.length, 1, "a refused capacity claim releases the existing fix mutex");
  const live = fixture(t);
  live.deps.claimFixAdmission = undefined;
  live.deps.readFixPressure = () => ({ availableMib: 1024, floorMib: 1024 });
  await runSweepLightPass([ownRed()], live.deps);
  assert.equal(live.dispatched.length, 0, "the production controller also refuses exhausted capacity");
  assert.equal(live.disposed()[0]!.acted, false);
  assert.match(String(live.disposed()[0]!.stand_down_reason), /^live host capacity exhausted for this light pass/);
  assert.doesNotMatch(String(live.disposed()[0]!.reason), /deferred to full sweep/);
});

test("W1-T8086: a review-only pass and the conflicted lane keep their gates", async (t) => {
  const reviewOnly = fixture(t, true);
  await runSweepLightPass([ownRed()], reviewOnly.deps);
  assert.equal(reviewOnly.dispatched.length, 0);
  assert.equal(reviewOnly.admitted.length, 0);
  assert.equal(reviewOnly.disposed()[0]!.stand_down_reason, DEFERRED);
  const ordinary = fixture(t);
  await runSweepLightPass([ownRed({
    checksState: "green", reviewState: "success", ciFailures: [], redRequiredChecks: [], mergeState: "dirty",
    headRefName: "run-W1-T8086-1791809247804",
    mergeConflict: { files: [{ path: "src/config.ts", oursDeleted: 0, theirsDeleted: 0 }], oursLog: "edit config", theirsLog: "edit config" },
  })], ordinary.deps);
  assert.equal(ordinary.disposed()[0]!.disposition, "conflicted");
  assert.equal(ordinary.disposed()[0]!.stand_down_reason, DEFERRED);
  assert.equal(ordinary.dispatched.length, 0);
  assert.equal(ordinary.admitted.length, 0);
  assert.equal(lightPassActionable("conflicted", true, false, true, true), true);
  assert.equal(lightPassActionable("blocked-fixable", false), false);
  assert.equal(lightPassActionable("blocked-fixable", false, false), false);
  assert.equal(lightPassActionable("blocked-fixable", false, false, true), false);
  assert.equal(lightPassActionable("blocked-fixable", false, true), true, "the requeue-only batch stays admitted");
});

test("W1-T8086: overlapping passes dispatch one fix round for one head", async (t) => {
  for (const besideFull of [false, true]) {
    const f = fixture(t);
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    f.deps.dispatchFix = (_pr, evidence) => { f.dispatched.push(evidence); return pending; };
    try {
      const light = runSweepLightPass([ownRed()], f.deps);
      const other = besideFull
        ? runSweep([ownRed()], { ...f.deps, actionable: () => true, detachFixWait: true })
        : runSweepLightPass([ownRed()], f.deps);
      await Promise.all([light, other]);
      assert.equal(f.dispatched.length, 1, besideFull ? "light beside full" : "light beside light");
      assert.equal(f.admitted.length, 1, "the duplicate never claims a host slot");
      assert.equal(f.disposed().filter((row) => row.acted === true).length, 1);
      assert.match(String(f.disposed().find((row) => row.acted === false)!.stand_down_reason), /duplicate fix-dispatch key/);
    } finally {
      release();
      await drainDetachedSweepActions();
    }
  }
});
