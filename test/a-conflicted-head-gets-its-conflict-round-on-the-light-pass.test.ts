import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { readLedgerLines } from "#src/lib/status.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import {
  drainDetachedSweepActions, runSweep, runSweepLightPass,
  type FixDispatchEvidence, type OpenPrView, type SweepDeps,
} from "#src/lib/sweep.js";
import { fixRungAllowedBesideInFlight, lightPassActionable } from "#src/run-task.js";

// 2026-10-14 on the core ledger: 220 `conflicted` rows read "deferred to full sweep (light pass)" against
// 7 that acted, while full passes finished a median 18.9 min apart (p90 44.5, max 100). #11679 went dirty
// at 14:09Z and wrote that deferral on every light pass until an operator merged main into it.
const NOW = Date.now();
const DEFERRED = "deferred to full sweep (light pass)";
// Another run is WORKING, not awaiting CI, so W1-T1211's waiting-run gate reads closed, as it did all day.
const WORKING = [{ task_id: "W1-TOTHER", step: "run.start", ts: new Date(NOW).toISOString() }];
const CONFLICT = {
  files: [{ path: "src/lib/machine-filing-judge.ts", oursDeleted: 0, theirsDeleted: 0 }],
  oursLog: "re-ask schedule", theirsLog: "refusedReleases",
};

function dirty(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 11679, prUrl: "https://github.com/o/r/pull/11679", taskId: "W1-T8830",
    headSha: "cc0e8dae-conflicted-head", checksState: "green", reviewState: "success", unmetCriteria: [],
    priorStrikes: 0, autoMergeArmed: false, lastActivityAt: new Date(NOW).toISOString(),
    mergeState: "dirty", headRefName: "run-W1-T8830-1791982973874", mergeConflict: CONFLICT,
    ...over,
  };
}

function fixture(t: TestContext, reviewOnly = false) {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}conflight-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dispatched: FixDispatchEvidence[] = [];
  const admitted: number[] = [];
  const fixRungAllowed = !reviewOnly && fixRungAllowedBesideInFlight(WORKING, ["W1-TOTHER"]);
  assert.equal(fixRungAllowed, false, "the waiting-run gate is closed, as on 2026-10-14");
  const deps: SweepDeps = {
    ledgerPath: join(dir, "ledger.ndjson"), runId: "SWEEP-CONFLIGHT", now: () => NOW,
    arm: () => { assert.fail("a conflicted head cannot arm"); },
    close: () => { assert.fail("a conflicted head cannot close"); },
    escalate: () => { assert.fail("a first conflict round cannot escalate"); },
    // Exactly as `buildSweepLightHook` wires its ordinary batch.
    actionable: (d) => lightPassActionable(d, fixRungAllowed, false, !reviewOnly, !reviewOnly),
    dispatchFix: (_pr, evidence) => { dispatched.push(evidence); },
    claimFixAdmission: (pr) => { admitted.push(pr.prNumber); return { admitted: true }; },
    readActiveWorkerCount: () => 0,
    readFixPressure: () => ({ availableMib: 8192, floorMib: 1024 }),
  };
  const disposed = () => readLedgerLines(deps.ledgerPath).filter((row) => row.step === "sweep.disposed");
  return { deps, dispatched, admitted, disposed };
}

test("a conflicted head gets its conflict round on the first light pass while another run is working", async (t) => {
  const f = fixture(t);
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  f.deps.dispatchFix = (_pr, evidence) => { f.dispatched.push(evidence); return pending; };
  try {
    // No full sweep runs here at all: the light pass alone must take the round.
    await runSweepLightPass([dirty()], f.deps);
    const row = f.disposed()[0]!;
    assert.equal(row.disposition, "conflicted");
    assert.equal(row.acted, true, "the first light pass that sees the conflict dispatches its round");
    assert.notEqual(row.stand_down_reason, DEFERRED);
    assert.equal(f.dispatched.length, 1);
    assert.deepEqual(f.dispatched[0]!.mergeConflict, CONFLICT, "the round carries the captured conflict evidence");
    assert.deepEqual(f.admitted, [11679], "the round takes the existing fix-capacity claim");
  } finally {
    release();
    await drainDetachedSweepActions();
  }
});

test("a conflicted head the fix capacity refuses writes a row naming the capacity, not the full sweep", async (t) => {
  const f = fixture(t);
  const reason = "live host capacity exhausted for this light pass";
  f.deps.claimFixAdmission = (pr) => { f.admitted.push(pr.prNumber); return { admitted: false, reason }; };
  await runSweepLightPass([dirty()], f.deps);
  await drainDetachedSweepActions();
  assert.deepEqual(f.admitted, [11679]);
  assert.equal(f.dispatched.length, 0);
  assert.equal(f.disposed().length, 1, "the deferral still writes its sweep.disposed row");
  assert.equal(f.disposed()[0]!.acted, false);
  assert.equal(f.disposed()[0]!.stand_down_reason, reason);
  // A refused claim releases the per-head fix mutex, so the next pass with capacity takes the round.
  f.deps.claimFixAdmission = () => ({ admitted: true });
  await runSweepLightPass([dirty()], f.deps);
  await drainDetachedSweepActions();
  assert.equal(f.dispatched.length, 1);
  // The production controller refuses on exhausted memory too, and says so.
  const live = fixture(t);
  live.deps.claimFixAdmission = undefined;
  live.deps.readFixPressure = () => ({ availableMib: 1024, floorMib: 1024 });
  await runSweepLightPass([dirty()], live.deps);
  assert.equal(live.dispatched.length, 0);
  assert.equal(live.disposed()[0]!.acted, false);
  assert.match(String(live.disposed()[0]!.stand_down_reason), /^live host capacity exhausted for this light pass/);
});

test("a review-only light pass still stands the conflict round down and writes its deferral row", async (t) => {
  const f = fixture(t, true);
  await runSweepLightPass([dirty()], f.deps);
  assert.equal(f.dispatched.length, 0);
  assert.equal(f.admitted.length, 0, "a review-only pass never claims a fix slot");
  assert.equal(f.disposed().length, 1);
  assert.equal(f.disposed()[0]!.disposition, "conflicted");
  assert.equal(f.disposed()[0]!.stand_down_reason, DEFERRED);
  assert.equal(lightPassActionable("conflicted", false), false, "every 2-argument caller keeps its shape");
  assert.equal(lightPassActionable("conflicted", false, true), false, "the requeue-only batch never resolves conflicts");
  assert.equal(lightPassActionable("conflicted", false, false, true, true), true);
});

test("overlapping passes dispatch one conflict round for one head", async (t) => {
  for (const besideFull of [false, true]) {
    const f = fixture(t);
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    f.deps.dispatchFix = (_pr, evidence) => { f.dispatched.push(evidence); return pending; };
    try {
      const light = runSweepLightPass([dirty()], f.deps);
      const other = besideFull
        ? runSweep([dirty()], { ...f.deps, actionable: () => true, detachFixWait: true })
        : runSweepLightPass([dirty()], f.deps);
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
