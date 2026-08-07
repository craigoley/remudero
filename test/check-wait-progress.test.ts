// W1-T382: the worker's check-wait bound used to be an ITERATION COUNT — `waitForCiGreen`
// and `pollToGate` (src/run-task.ts) both gave up after a fixed `maxIters`, regardless of
// whether checks were still moving. Recon measured 21 of 21 PRs this repo ever booked as a
// check-wait timeout LATER MERGING (0 closed unmerged): the bound had a 100% false-positive
// rate. `checkWaitStalled` replaces it with a DERIVATIVE — stop only when the rollup shows
// no forward motion across `STALL_WINDOW` consecutive polls — never on elapsed polls.
//
// This file is deliberately separate from test/run-task.test.ts: that file intermittently
// crashes at FILE level under `--experimental-test-coverage`, which would make a
// coverage-load-bearing test for this predicate nondeterministically lose its own coverage.
//
// `checkWaitStalled` is PURE over `RollupEntry[]`-shaped readings — no I/O, no clock, nothing
// spawned — so all three falsifier directions below assert in-process.

import assert from "node:assert/strict";
import { test } from "node:test";
import { checkWaitStalled, STALL_WINDOW } from "../src/run-task.js";

/** `STALL_WINDOW` identical copies of `reading` — the minimum a real caller would have
 *  accumulated before {@link checkWaitStalled} has enough evidence to conclude stalled. */
function identicalWindow(reading: { name: string; conclusion?: string; status?: string }[]) {
  return Array.from({ length: STALL_WINDOW }, () => reading);
}

test("BITES (W1-T382): a rollup unchanged across the stall window with checks still pending concludes stalled and names which checks were pending", () => {
  const pending = [
    { name: "ci", status: "IN_PROGRESS" },
    { name: "lint", status: "QUEUED" },
  ];
  const result = checkWaitStalled(identicalWindow(pending));
  assert.equal(result.stalled, true, "STALL_WINDOW identical pending readings must conclude stalled");
  assert.deepEqual(
    new Set(result.pending),
    new Set(["ci", "lint"]),
    "the stalled verdict names every still-pending check, not just one",
  );
});

test("BITES (W1-T382): fewer than STALL_WINDOW identical readings is never enough evidence to conclude stalled", () => {
  const pending = [{ name: "ci", status: "IN_PROGRESS" }];
  const short = Array.from({ length: STALL_WINDOW - 1 }, () => pending);
  const result = checkWaitStalled(short);
  assert.equal(result.stalled, false, "one poll short of the window must keep waiting");
  assert.deepEqual(result.pending, []);
});

test("HOLDS (W1-T382, the defect reduced): a rollup whose pending set shrinks by one keeps waiting however many polls have elapsed", () => {
  // Simulates the shape of all 21 historically-false-blocked PRs: `ci` resolves partway
  // through a long run of otherwise-identical polls. Many more than STALL_WINDOW readings
  // are accumulated in total; the shrink sits inside the most recent window.
  const stillTwoPending = [{ name: "ci", status: "IN_PROGRESS" }, { name: "lint", status: "QUEUED" }];
  const oneResolved = [{ name: "ci", conclusion: "SUCCESS" }, { name: "lint", status: "QUEUED" }];
  const history = [
    ...Array.from({ length: 20 }, () => stillTwoPending), // 20 identical polls — way past STALL_WINDOW on its own
    oneResolved, // the pending set just shrank by one
    oneResolved,
    oneResolved,
  ];
  const result = checkWaitStalled(history);
  assert.equal(
    result.stalled,
    false,
    "the shrink inside the last STALL_WINDOW readings must keep this waiting, not conclude stalled",
  );
});

test("HOLDS (W1-T382, the defect reduced): a check flipping state keeps waiting however many polls have elapsed", () => {
  const pending = [{ name: "ci", status: "QUEUED" }];
  const inProgress = [{ name: "ci", status: "IN_PROGRESS" }];
  // Every poll differs from the last — real forward motion, never two identical readings in
  // a row — sustained well past STALL_WINDOW polls.
  const history: { name: string; status: string }[][] = [];
  for (let i = 0; i < STALL_WINDOW * 4; i++) {
    history.push(i % 2 === 0 ? pending : inProgress);
  }
  const result = checkWaitStalled(history);
  assert.equal(result.stalled, false, "alternating state every poll is continuous motion, never a stall");
});

test("HOLDS (W1-T382): a required check going red is never reported as merely pending, so the derivative adds no delay on top of the caller's own red short-circuit", () => {
  const pending = [{ name: "ci", status: "IN_PROGRESS" }];
  const wentRed = [{ name: "ci", conclusion: "FAILURE" }];

  // (a) the transition to red is itself a state change — checkWaitStalled reads it as
  // forward motion (not a stall), so nothing here would make a caller wait an extra
  // STALL_WINDOW polls before it could act on the red conclusion it already has.
  const atTransition = [...Array.from({ length: STALL_WINDOW - 1 }, () => pending), wentRed];
  assert.equal(
    checkWaitStalled(atTransition).stalled,
    false,
    "the poll where a check turns red must never be reported as a stall",
  );

  // (b) even if a red conclusion persisted long enough to fill the whole window, the
  // derivative excludes it from `pending` — a red check is a failure, never miscategorized
  // as "still waiting on it".
  const allRed = checkWaitStalled(identicalWindow(wentRed));
  assert.equal(allRed.stalled, true, "a persisted rollup is still a stall by the pure signature comparison");
  assert.deepEqual(allRed.pending, [], "a red check must never be named in `pending` — it already failed, it is not waiting");
});
