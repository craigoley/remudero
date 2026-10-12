import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { startInterphaseReviewClock, type DaemonDeps } from "../src/lib/daemon.js";
import { readLedgerLines } from "../src/lib/status.js";
import { DEFAULT_SWEEP_POLICY, runSweepLightPass, type OpenPrView, type SweepDeps } from "./helpers/sweep-test.js";

const NOW = Date.parse("2026-09-28T22:00:00Z");
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

async function eventually(predicate: () => boolean, message: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await settle();
  }
  assert.fail(message);
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

class WakeClock {
  private pending = false;
  private waiter: ((result: "wake" | "timeout") => void) | undefined;

  readonly sleep: NonNullable<DaemonDeps["sleepUntilSweepWake"]> = () => {
    if (this.pending) {
      this.pending = false;
      return Promise.resolve("wake");
    }
    assert.equal(this.waiter, undefined);
    return new Promise((resolve) => { this.waiter = resolve; });
  };

  get waiting(): boolean { return this.waiter !== undefined; }

  wake(): void {
    if (!this.waiter) { this.pending = true; return; }
    const waiter = this.waiter;
    this.waiter = undefined;
    waiter("wake");
  }

  timeout(): void {
    if (!this.waiter) return;
    const waiter = this.waiter;
    this.waiter = undefined;
    waiter("timeout");
  }
}

function reviewPr(number: number): OpenPrView {
  return {
    prNumber: number,
    prUrl: `https://github.com/o/r/pull/${number}`,
    taskId: `W1-T${number}`,
    reviewState: "none",
    checksState: "green",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: `2026-09-${number === 1 ? "27" : "28"}T12:00:00Z`,
    createdAt: `2026-09-${number === 1 ? "27" : "28"}T12:00:00Z`,
    headSha: `head-${number}`,
    autoMergeArmed: false,
  };
}

function reviewDeps(postReview: NonNullable<SweepDeps["postReview"]>): SweepDeps {
  return {
    ledgerPath: join(mkdtempSync(join(tmpdir(), "rmd-t4732-")), "ledger.ndjson"),
    runId: "W1-T4732",
    now: () => NOW,
    arm: () => {},
    close: () => {},
    dispatchFix: () => {},
    escalate: () => {},
    postReview,
  };
}

test("W1-T4732: a newly green PR starts review before an earlier review settles", async () => {
  const wake = new WakeClock();
  const oldReview = deferred();
  const posted: number[] = [];
  const old = reviewPr(1);
  const fresh = reviewPr(2);
  const deps = reviewDeps(async (pr) => {
    posted.push(pr.prNumber);
    if (pr.prNumber === old.prNumber) await oldReview.promise;
  });
  let passNumber = 0;
  const clock = startInterphaseReviewClock({
    sleepUntilSweepWake: wake.sleep,
    sweepLight: async (scope) => {
      passNumber++;
      if (passNumber === 1) {
        assert.equal(scope, undefined);
        await runSweepLightPass([old], deps);
      } else {
        assert.equal(scope?.reviewOnly, true, "overlap may only review");
        await runSweepLightPass([old, fresh], deps);
      }
    },
  } as DaemonDeps, 60_000, () => {});
  try {
    await eventually(() => wake.waiting, "clock did not begin waiting");
    wake.wake();
    await eventually(() => posted.includes(1), "old review did not begin");
    wake.wake();
    await eventually(() => posted.includes(2), "newly green PR waited for the old reviewer");
    assert.deepEqual(posted, [1, 2], "the reserved old head is not reviewed twice");
  } finally {
    oldReview.resolve();
    const stopped = clock.stop();
    wake.timeout();
    await stopped;
  }
});

test("W1-T4732: overlapping light passes respect review width and drain on stop", async () => {
  const old = deferred();
  const middle = deferred();
  const posted: number[] = [];
  const deps = reviewDeps(async (pr) => {
    posted.push(pr.prNumber);
    if (pr.prNumber === 1) await old.promise;
    if (pr.prNumber === 2) await middle.promise;
  });
  const policy = { ...DEFAULT_SWEEP_POLICY, reviewLanes: 2 };
  const first = runSweepLightPass([reviewPr(1)], deps, policy);
  await eventually(() => posted.includes(1), "first review did not start");
  const second = runSweepLightPass([reviewPr(2), reviewPr(3)], deps, policy);
  await eventually(() => posted.includes(2), "the second semantic slot was not used");
  await runSweepLightPass([reviewPr(3)], deps, policy);
  assert.deepEqual(posted, [1, 2], "a third overlapping pass must not exceed reviewLanes or repeat a head");
  const wake = new WakeClock();
  const held = [deferred(), deferred()];
  let calls = 0;
  const clock = startInterphaseReviewClock({
    sleepUntilSweepWake: wake.sleep,
    sweepLight: async (scope) => {
      const index = calls++;
      if (index > 0) assert.equal(scope?.reviewOnly, true);
      await held[index]?.promise;
    },
  } as DaemonDeps, 60_000, () => {});
  try {
    await eventually(() => wake.waiting, "clock did not begin waiting");
    wake.wake();
    await eventually(() => calls === 1, "first clock pass did not start");
    wake.wake();
    await eventually(() => calls === 2, "second clock pass did not start");
    wake.wake();
    await settle();
    assert.equal(calls, 2, "third wake stays pending while two passes are active");
    let stopped = false;
    const stop = clock.stop().then(() => { stopped = true; });
    wake.timeout();
    await settle();
    assert.equal(stopped, false, "stop must await admitted passes");
    held[0]!.resolve();
    await settle();
    assert.equal(stopped, false, "both admitted passes must drain");
    held[1]!.resolve();
    await stop;
    assert.equal(calls, 2, "stop prevents the pending third wake from starting");
  } finally {
    held.forEach((pass) => pass.resolve());
    wake.timeout();
    old.resolve();
    middle.resolve();
    await Promise.all([first, second]);
  }
});

test("W1-T4732: plan-filing losers name the local and overlapping admission limits", async () => {
  const held = deferred();
  const posted: number[] = [];
  const deps = reviewDeps(async (pr) => {
    posted.push(pr.prNumber);
    if (pr.prNumber === 1) await held.promise;
  });
  const filing = (number: number): OpenPrView => ({ ...reviewPr(number), isPlanFiling: true });
  const policy = { ...DEFAULT_SWEEP_POLICY, planFilingAdmissionBound: 1 };
  const first = runSweepLightPass([filing(1), filing(2)], deps, policy);
  try {
    await eventually(() => posted.includes(1), "the first plan filing did not start review");
    await eventually(
      () => readLedgerLines(deps.ledgerPath).some((row) => row.step === "sweep.disposed" && row.pr_number === 2),
      "the same-pass plan filing did not stand down",
    );
    await runSweepLightPass([filing(3)], deps, policy);
    const disposed = readLedgerLines(deps.ledgerPath).filter((row) => row.step === "sweep.disposed");
    assert.equal(
      disposed.find((row) => row.pr_number === 2)?.stand_down_reason,
      "not admitted this pass: at most 1 plan-filing post-review admissions per light pass",
    );
    assert.equal(
      disposed.find((row) => row.pr_number === 3)?.stand_down_reason,
      "not admitted this pass: at most 0 plan-filing post-review admissions available across light passes",
    );
    assert.deepEqual(posted, [1], "neither loser starts a review while the plan-filing slot is held");
  } finally {
    held.resolve();
    await first;
  }
});
