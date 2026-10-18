/**
 * W1-T9743 — a light pass's review backlog never holds a wait-disposed PR past the ceiling.
 *
 * The in-flight ticker awaits the light pass. On 2026-10-16 (16:13, 16:24, 16:39Z) each pass returned only once
 * its admitted PLAN-FILING reviews posted: W1-T5491 detached the spawning lane's review wait, never the plan lane's.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { readLedgerLines } from "#src/lib/status.js";
import * as sweep from "#src/lib/sweep.js";
import {
  DEFAULT_SWEEP_POLICY, drainDetachedSweepActions, drainInFlightReviews, runSweepLightPass,
  type OpenPrView, type SweepDeps,
} from "#src/lib/sweep.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

const T0 = Date.now();
const PLAN = 12362;
const WAITING = 12122;
const OWN_RED = 12267;
const CEILING_MS = DEFAULT_SWEEP_POLICY.pendingCeilingMinutes * 60_000;

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

function planFiling(): OpenPrView {
  return {
    prNumber: PLAN, prUrl: `https://github.com/o/r/pull/${PLAN}`, taskId: "W1-T9845", isPlanFiling: true,
    headSha: "plan-head", checksState: "green", reviewState: "none", unmetCriteria: [], priorStrikes: 0,
    autoMergeArmed: false, lastActivityAt: new Date(T0 - 120_000).toISOString(), createdAt: new Date(T0 - 120_000).toISOString(),
  };
}

/** Green, its review pending since just before T0, posted by a reviewer that has since died. */
function waitingOnDeadReviewer(): OpenPrView {
  return {
    prNumber: WAITING, prUrl: `https://github.com/o/r/pull/${WAITING}`, taskId: "W1-T9500",
    headSha: "wait-head", checksState: "green", reviewState: "pending", reviewPendingSince: new Date(T0 - 60_000).toISOString(),
    unmetCriteria: [], priorStrikes: 0, autoMergeArmed: false, lastActivityAt: new Date(T0 - 60_000).toISOString(),
    createdAt: new Date(T0 - 600_000).toISOString(),
  };
}

function ownRed(): OpenPrView {
  return {
    prNumber: OWN_RED, prUrl: `https://github.com/o/r/pull/${OWN_RED}`, taskId: "W1-T8879",
    headSha: "own-red-head", checksState: "red", reviewState: "pending", unmetCriteria: [], priorStrikes: 1,
    autoMergeArmed: false, lastActivityAt: new Date(T0).toISOString(),
    redRequiredChecks: ["ci"], ciFailures: [{ name: "ci", logTail: "assertion failed in this diff" }],
  };
}

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t9743-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const clock = { ms: T0 };
  const deps: SweepDeps = {
    ledgerPath: join(dir, "ledger.ndjson"), runId: "SWEEP-T9743", now: () => clock.ms,
    readActiveWorkerCount: () => 0,
    actionable: (d) => d === "post-review" || d === "blocked-fixable",
    arm: () => { assert.fail("nothing here arms"); },
    close: () => { assert.fail("nothing here closes"); },
    escalate: () => { assert.fail("nothing here escalates"); },
    dispatchFix: () => {},
  };
  const disposed = (prNumber?: number) => readLedgerLines(deps.ledgerPath)
    .filter((row) => row.step === "sweep.disposed" && (prNumber === undefined || row.pr_number === prNumber));
  return { deps, clock, disposed };
}

/** Whether `pass` settles while the held work is still running; never waits it out. */
async function returnsWhileHeld(pass: Promise<unknown>): Promise<boolean> {
  return Promise.race([pass.then(() => true), delay(2_000).then(() => false)]);
}

test("W1-T9743: a long review never holds a wait PR past the ceiling", async (t) => {
  const f = fixture(t);
  const planReview = gate();
  const reviewed: number[] = [];
  f.deps.postReview = async (pr) => {
    reviewed.push(pr.prNumber);
    if (pr.prNumber === PLAN) await planReview.promise;
  };
  const first = runSweepLightPass([planFiling(), waitingOnDeadReviewer()], f.deps);
  try {
    assert.equal(await returnsWhileHeld(first), true, "the pass returns while its admitted plan review runs");
    assert.deepEqual(reviewed, [PLAN]);
    assert.equal(f.disposed(PLAN).at(-1)?.acted, true, "the plan review's admission is recorded inside the pass");
    assert.equal(f.disposed(WAITING).at(-1)?.disposition, "wait");
    // The plan review is still running when the dead reviewer's pending passes the ceiling.
    f.clock.ms = T0 + CEILING_MS + 5 * 60_000;
    assert.equal(await returnsWhileHeld(runSweepLightPass([planFiling(), waitingOnDeadReviewer()], f.deps)), true);
    const redisposed = f.disposed(WAITING).at(-1)!;
    assert.equal(redisposed.disposition, "post-review", "the stale pending is re-run, not waited on");
    assert.equal(redisposed.acted, true);
    assert.ok(Number(redisposed.snapshot_age_ms) < CEILING_MS, "re-disposed from a snapshot inside the ceiling");
    assert.deepEqual(reviewed, [PLAN, WAITING], "the held plan review is never admitted twice");
    assert.match(String(f.disposed(PLAN).at(-1)?.stand_down_reason), /already in flight/);
  } finally {
    planReview.resolve();
    await first;
    await drainInFlightReviews({ boundMs: 1_000 });
  }
});

test("W1-T9743: a disposition row names its snapshot age", async (t) => {
  const f = fixture(t);
  f.deps.snapshotPublishedAtMs = T0 - 90_000;
  f.deps.claimFixAdmission = () => ({ admitted: true });
  f.deps.readFixPressure = () => ({ availableMib: 8192, floorMib: 1024 });
  const judged = gate();
  // A judge whose worker waits in the memory admission, so the pass detaches its fix rung (W1-T9780).
  f.deps.fixProgressJudge = async () => {
    await sweep.lightPassMemoryWaitPorts().sleep(0);
    await judged.promise;
    return { verdict: "continue", reason: "first round" };
  };
  const first = runSweepLightPass([ownRed()], f.deps);
  try {
    assert.equal(await returnsWhileHeld(first), true);
    await runSweepLightPass([ownRed()], f.deps);
    const held = f.disposed(OWN_RED);
    assert.equal(held.length, 1);
    assert.equal(held[0]!.in_flight_action, "light-pass-action");
    assert.equal(held[0]!.snapshot_age_ms, 90_000, "the held row names the age of the view it disposed");
    judged.resolve();
    await first;
    await drainDetachedSweepActions();
    const rows = f.disposed();
    assert.equal(rows.length, 2, "the detached fix rung disposed once it was judged");
    for (const row of rows) assert.equal(row.snapshot_age_ms, 90_000, String(row.reason));
  } finally {
    judged.resolve();
    await first;
    await drainDetachedSweepActions();
  }
});
