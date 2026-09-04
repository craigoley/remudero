import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { appendLedger } from "../src/lib/ledger.js";
import {
  DEFAULT_SWEEP_POLICY,
  runSweep,
  runSweepLightPass,
  type OpenPrView,
  type SweepDeps,
} from "../src/lib/sweep.js";
import { readLedgerLines } from "../src/lib/status.js";

const NOW = Date.now();
const THROW_REASON =
  "post-review attempt threw — standing down rather than retrying this head unbounded: transient transport";

function ledgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), "rmd-post-review-throw-backoff-")), "ledger.ndjson");
}

function reviewPr(n = 2753, over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: n,
    prUrl: `https://github.com/o/r/pull/${n}`,
    taskId: `W1-T${n}`,
    reviewState: "none",
    checksState: "green",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: new Date(NOW - 120 * 60_000).toISOString(),
    headSha: `sha-${n}`,
    reviewInputDigest: `digest-${n}`,
    autoMergeArmed: false,
    ...over,
  };
}

function deps(path: string, posted: number[], over: Partial<SweepDeps> = {}): SweepDeps {
  return {
    arm: () => {},
    close: () => {},
    dispatchFix: () => {},
    escalate: () => {},
    postReview: (pr) => {
      posted.push(pr.prNumber);
    },
    ledgerPath: path,
    runId: "SWEEP-W1-T2753",
    now: () => NOW,
    ...over,
  };
}

function appendOutcome(
  path: string,
  pr: OpenPrView,
  step: "review.posted" | "review.post_refused",
  reason: string,
  ts: string | undefined,
): void {
  appendLedger(path, {
    ts,
    run_id: "REVIEW-OLD",
    task_id: pr.taskId ?? "",
    step,
    pr_url: pr.prUrl,
    head_sha: pr.headSha,
    review_input_digest: pr.reviewInputDigest,
    reason,
  });
}

test("a thrown review attempt is re-admitted after the existing pending ceiling", async () => {
  const path = ledgerPath();
  const pr = reviewPr();
  appendOutcome(path, pr, "review.post_refused", THROW_REASON, new Date(NOW - 61 * 60_000).toISOString());

  const posted: number[] = [];
  await runSweep([pr], deps(path, posted), DEFAULT_SWEEP_POLICY);
  assert.deepEqual(posted, [pr.prNumber]);
});

test("a recent thrown attempt stands down with a timed retry reason, not a durable-refusal claim", async () => {
  const path = ledgerPath();
  const pr = reviewPr();
  appendOutcome(path, pr, "review.post_refused", THROW_REASON, new Date(NOW - 30 * 60_000).toISOString());

  const posted: number[] = [];
  await runSweep([pr], deps(path, posted), DEFAULT_SWEEP_POLICY);
  assert.deepEqual(posted, []);
  const disposed = readLedgerLines(path).findLast((line) => line.step === "sweep.disposed");
  assert.match(String(disposed?.stand_down_reason), /threw 30m ago/);
  assert.match(String(disposed?.stand_down_reason), /retry backoff.*60m pending ceiling/);
  assert.doesNotMatch(String(disposed?.stand_down_reason), /already REFUSED/);
});

test("a timed-outcome head does not consume the light pass review admission", async () => {
  const path = ledgerPath();
  const backedOff = reviewPr(2753);
  const eligible = reviewPr(2754, {
    lastActivityAt: new Date(NOW - 60 * 60_000).toISOString(),
  });
  appendOutcome(path, backedOff, "review.post_refused", THROW_REASON, new Date(NOW - 30 * 60_000).toISOString());

  const posted: number[] = [];
  await runSweepLightPass(
    [backedOff, eligible],
    deps(path, posted),
    { ...DEFAULT_SWEEP_POLICY, reviewLanes: 1 },
  );
  assert.deepEqual(posted, [eligible.prNumber]);

  const backedOffDisposition = readLedgerLines(path).findLast(
    (line) => line.step === "sweep.disposed" && line.pr_number === backedOff.prNumber,
  );
  assert.match(String(backedOffDisposition?.stand_down_reason), /retry backoff.*60m pending ceiling/);
});

test("a second throw advances the retry clock instead of licensing per-sweep retries", async () => {
  const path = ledgerPath();
  const pr = reviewPr();
  appendOutcome(path, pr, "review.post_refused", THROW_REASON, new Date(NOW - 61 * 60_000).toISOString());

  const firstAttempts: number[] = [];
  const first = deps(path, firstAttempts, {
    postReview: (candidate) => {
      firstAttempts.push(candidate.prNumber);
      throw new Error("transient transport");
    },
  });
  const firstSummary = await runSweep([pr], first, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(firstAttempts, [pr.prNumber]);
  assert.equal(firstSummary.actionsFailed, 1);

  const earlyRetry: number[] = [];
  await runSweep(
    [pr],
    deps(path, earlyRetry, { now: () => NOW + 30 * 60_000 }),
    DEFAULT_SWEEP_POLICY,
  );
  assert.deepEqual(earlyRetry, [], "the fresh throw starts a new bounded interval");

  const elapsedRetry: number[] = [];
  await runSweep(
    [pr],
    deps(path, elapsedRetry, { now: () => NOW + 61 * 60_000 }),
    DEFAULT_SWEEP_POLICY,
  );
  assert.deepEqual(elapsedRetry, [pr.prNumber]);
});

test("an undated thrown attempt is admitted once and a fresh failure restores a dated bound", async () => {
  const path = ledgerPath();
  const pr = reviewPr();
  appendOutcome(path, pr, "review.post_refused", THROW_REASON, undefined);

  const firstAttempts: number[] = [];
  await runSweep(
    [pr],
    deps(path, firstAttempts, {
      postReview: (candidate) => {
        firstAttempts.push(candidate.prNumber);
        throw new Error("transient transport");
      },
    }),
    DEFAULT_SWEEP_POLICY,
  );
  assert.deepEqual(firstAttempts, [pr.prNumber]);

  const secondAttempts: number[] = [];
  await runSweep(
    [pr],
    deps(path, secondAttempts, { now: () => NOW + 1 * 60_000 }),
    DEFAULT_SWEEP_POLICY,
  );
  assert.deepEqual(secondAttempts, [], "the newly dated throw restores the backoff");
});

test("delivered verdicts and semantic or lifecycle refusals remain durably deduped", async () => {
  const path = ledgerPath();
  const delivered = reviewPr(1);
  const semantic = reviewPr(2);
  const merged = reviewPr(3);
  appendOutcome(path, delivered, "review.posted", "success", new Date(NOW - 24 * 60 * 60_000).toISOString());
  appendOutcome(path, semantic, "review.post_refused", "operator precedence refusal", new Date(NOW - 24 * 60 * 60_000).toISOString());
  appendOutcome(
    path,
    merged,
    "review.post_refused",
    "PR is already merged — refusing to post remudero-review against a closed lifecycle (W1-T228 lifecycle rule)",
    new Date(NOW - 24 * 60 * 60_000).toISOString(),
  );

  const posted: number[] = [];
  await runSweep([delivered, semantic, merged], deps(path, posted), DEFAULT_SWEEP_POLICY);
  assert.deepEqual(posted, []);
});

test("a new head or changed body creates a fresh exact-input key immediately", async () => {
  const path = ledgerPath();
  const old = reviewPr();
  appendOutcome(path, old, "review.post_refused", THROW_REASON, new Date(NOW - 1 * 60_000).toISOString());

  const changedBody = reviewPr(2754, {
    taskId: old.taskId,
    prUrl: old.prUrl,
    headSha: old.headSha,
    reviewInputDigest: "corrected-body",
  });
  const changedHead = reviewPr(2755, {
    taskId: old.taskId,
    prUrl: old.prUrl,
    headSha: "new-head",
    reviewInputDigest: old.reviewInputDigest,
  });
  const posted: number[] = [];
  await runSweep([changedBody, changedHead], deps(path, posted), DEFAULT_SWEEP_POLICY);
  assert.deepEqual(posted.sort((a, b) => a - b), [2754, 2755]);
});
