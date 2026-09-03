import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { appendLedger } from "../src/lib/ledger.js";
import { DEFAULT_SWEEP_POLICY, runSweep, type OpenPrView, type SweepDeps } from "../src/lib/sweep.js";
import { readLedgerLines } from "../src/lib/status.js";

function ledgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), "rmd-review-claim-timing-")), "ledger.ndjson");
}

function reviewablePr(): OpenPrView {
  return {
    prNumber: 100,
    prUrl: "https://github.com/o/r/pull/100",
    taskId: "W1-T100",
    reviewState: "none",
    checksState: "green",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: "2026-09-03T12:00:00Z",
    createdAt: "2026-09-03T12:00:00Z",
    headSha: "review-head",
    autoMergeArmed: false,
  };
}

function fixablePr(): OpenPrView {
  return {
    ...reviewablePr(),
    prNumber: 101,
    prUrl: "https://github.com/o/r/pull/101",
    taskId: "W1-T101",
    reviewState: "failure",
    unmetCriteria: [
      {
        claim: "the fix lands",
        proof: "unit test: test/example.test.ts",
        met: false,
        reason: "not yet",
        proof_exec: "executed_fail",
      },
    ],
    headSha: "fix-head",
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function deps(path: string, overrides: Partial<SweepDeps> = {}): SweepDeps {
  return {
    arm: () => {},
    close: () => {},
    dispatchFix: () => {},
    escalate: () => {},
    ledgerPath: path,
    runId: "SWEEP-TEST",
    now: () => Date.parse("2026-09-03T12:10:00Z"),
    ...overrides,
  };
}

test("W1-T2771: a pending review candidate owns no mutex until a worker starts it", async () => {
  const path = ledgerPath();
  const blocker = deferred();
  const blockerStarted = deferred();
  const reviewStarts: string[] = [];
  const review = reviewablePr();

  const postReview = async (pr: OpenPrView): Promise<void> => {
    reviewStarts.push(pr.prUrl);
    appendLedger(path, {
      run_id: "REVIEW",
      task_id: pr.taskId ?? "",
      step: "review.posted",
      head_sha: pr.headSha,
      state: "success",
    });
  };

  const full = runSweep(
    [review, fixablePr()],
    deps(path, {
      runId: "FULL",
      postReview,
      dispatchFix: async () => {
        blockerStarted.resolve();
        await blocker.promise;
      },
    }),
    DEFAULT_SWEEP_POLICY,
  );

  await blockerStarted.promise;
  const light = await runSweep([review], deps(path, { runId: "LIGHT", postReview }), DEFAULT_SWEEP_POLICY);
  const startsBeforeFullResumes = reviewStarts.length;
  blocker.resolve();
  const fullSummary = await full;

  assert.equal(startsBeforeFullResumes, 1, "the light pass starts the review while the full sweep is stalled elsewhere");
  assert.equal(reviewStarts.length, 1, "the stale full sweep re-reads the delivered outcome instead of reviewing twice");
  assert.equal(light.actions[0]?.acted, true, "the overtaking light pass owns the one real review attempt");
  assert.equal(fullSummary.actions[0]?.acted, false, "the original full sweep stands down after its action-time read");
  const fullRow = readLedgerLines(path).find((line) => line.step === "sweep.disposed" && line.run_id === "FULL" && line.pr_number === 100);
  assert.match(String(fullRow?.stand_down_reason ?? ""), /already DELIVERED/, "the stand-down is attributed to the fresh delivered outcome");
});

test("W1-T2771: simultaneous action-time claims still start one exact-input review", async () => {
  const path = ledgerPath();
  const reviewStarted = deferred();
  const releaseReview = deferred();
  let starts = 0;
  const review = reviewablePr();
  const postReview = async (): Promise<void> => {
    starts += 1;
    reviewStarted.resolve();
    await releaseReview.promise;
  };
  const firstDeps = deps(path, {
    runId: "FIRST",
    postReview,
  });
  const secondDeps = deps(path, {
    runId: "SECOND",
    postReview: async () => {
      await postReview();
    },
  });

  const first = runSweep([review], firstDeps, DEFAULT_SWEEP_POLICY);
  await reviewStarted.promise;
  const second = await runSweep([review], secondDeps, DEFAULT_SWEEP_POLICY);
  releaseReview.resolve();
  await first;

  assert.equal(starts, 1, "the module-level mutex still excludes the concurrent duplicate");
  assert.equal(second.actions[0]?.acted, false);
  const secondRow = readLedgerLines(path).find((line) => line.step === "sweep.disposed" && line.run_id === "SECOND");
  assert.match(String(secondRow?.stand_down_reason ?? ""), /duplicate review key/);
});

test("W1-T2771: an unstarted tail never releases another pass's active claim", async () => {
  const path = ledgerPath();
  const reviewStarted = deferred();
  const releaseReview = deferred();
  let starts = 0;
  const review = reviewablePr();
  const postReview = async (): Promise<void> => {
    starts += 1;
    reviewStarted.resolve();
    await releaseReview.promise;
  };

  const owner = runSweep([review], deps(path, { runId: "OWNER", postReview }), DEFAULT_SWEEP_POLICY);
  await reviewStarted.promise;

  await runSweep(
    [review],
    deps(path, {
      runId: "GATED",
      postReview,
      continueReviewAdmissions: () => false,
    }),
    DEFAULT_SWEEP_POLICY,
  );
  const contender = await runSweep([review], deps(path, { runId: "CONTENDER", postReview }), DEFAULT_SWEEP_POLICY);
  releaseReview.resolve();
  await owner;

  assert.equal(starts, 1, "the gated pass never deletes the active owner's mutex claim");
  assert.equal(contender.actions[0]?.acted, false, "a third caller still sees the active owner and stands down");
  const contenderRow = readLedgerLines(path).find((line) => line.step === "sweep.disposed" && line.run_id === "CONTENDER");
  assert.match(String(contenderRow?.stand_down_reason ?? ""), /duplicate review key/);
});

test("W1-T2771: a failed action-time re-read fails closed, releases the claim, and never posts", async () => {
  const path = ledgerPath();
  const review = reviewablePr();
  let reads = 0;
  let postReviewCalled = false;

  const summary = await runSweep(
    [review],
    deps(path, {
      postReview: async () => {
        postReviewCalled = true;
      },
      // The top-of-function `prior` snapshot (read #1) must still succeed so the review is even
      // identified as a candidate; only the action-time re-read inside `claimReview` (read #2)
      // fails, exercising the `catch` that reads the ledger closed instead of throwing out of
      // the sweep.
      readLedger: (p) => {
        reads += 1;
        if (reads === 1) return readLedgerLines(p);
        throw new Error("ledger disk read boom");
      },
    }),
    DEFAULT_SWEEP_POLICY,
  );

  assert.equal(postReviewCalled, false, "a failed re-read must never let the review post");
  assert.equal(summary.actions[0]?.acted, false, "the sweep stands the candidate down rather than acting on a stale claim");
  const row = readLedgerLines(path).find((line) => line.step === "sweep.disposed" && line.pr_number === 100);
  assert.match(
    String(row?.stand_down_reason ?? ""),
    /review action-time outcome read failed closed \(ledger disk read boom\)/,
    "the disposed row carries the read failure so an operator can see why the claim was released",
  );

  // The claim is released on the failed-read path (not leaked), so a later pass with a healthy
  // ledger reader can still claim and post the review normally.
  const retry = await runSweep([review], deps(path, { postReview: async () => { postReviewCalled = true; } }), DEFAULT_SWEEP_POLICY);
  assert.equal(postReviewCalled, true, "a subsequent pass with a working ledger reader can still claim the released key");
  assert.equal(retry.actions[0]?.acted, true);
});
