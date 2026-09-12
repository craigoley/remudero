import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { appendLedger } from "../src/lib/ledger.js";
import {
  DEFAULT_SWEEP_POLICY,
  runSweep,
  type OpenPrView,
  type SweepDeps,
} from "../src/lib/sweep.js";
import { readLedgerLines } from "../src/lib/status.js";

const NOW = Date.now();
const DIFF_CEILING_REASON =
  "post-review attempt threw — standing down rather than retrying this head unbounded: PullRequest.diff too_large";

function ledgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), "rmd-reviewer-code-freshness-")), "ledger.ndjson");
}

function reviewPr(n = 3448, over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: n,
    prUrl: `https://github.com/o/r/pull/${n}`,
    taskId: `W1-T${n}`,
    reviewState: "pending",
    checksState: "green",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: new Date(NOW - 120 * 60_000).toISOString(),
    headSha: `sha-${n}`,
    reviewInputDigest: `digest-${n}`,
    reviewPendingOwnerDead: true,
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
    runId: "SWEEP-W1-T3448",
    now: () => NOW,
    ...over,
  };
}

function appendOutcome(
  path: string,
  pr: OpenPrView,
  step: "review.posted" | "review.post_refused",
  ts: string | undefined,
  over: Record<string, unknown> = {},
): void {
  appendLedger(path, {
    ts,
    run_id: "REVIEW-OLD",
    task_id: pr.taskId ?? "",
    step,
    pr_url: pr.prUrl,
    head_sha: pr.headSha,
    review_input_digest: pr.reviewInputDigest,
    ...over,
  });
}

function appendFreshnessRefusal(
  path: string,
  pr: OpenPrView,
  freshness: "stale" | "unreadable",
  ts: string | undefined,
): void {
  appendOutcome(path, pr, "review.post_refused", ts, {
    reason: `reviewer-code freshness ${freshness}`,
    reviewer_code_freshness: freshness,
  });
}

test("stale reviewer-code refusal is re-admitted after the pending ceiling", async () => {
  const path = ledgerPath();
  const pr = reviewPr();
  appendFreshnessRefusal(path, pr, "stale", new Date(NOW - 61 * 60_000).toISOString());

  const posted: number[] = [];
  await runSweep([pr], deps(path, posted), DEFAULT_SWEEP_POLICY);
  assert.deepEqual(posted, [pr.prNumber]);
});

test("stale reviewer-code refusal backs off before the pending ceiling", async () => {
  const path = ledgerPath();
  const pr = reviewPr();
  appendFreshnessRefusal(path, pr, "stale", new Date(NOW - 30 * 60_000).toISOString());

  const posted: number[] = [];
  await runSweep([pr], deps(path, posted), DEFAULT_SWEEP_POLICY);
  assert.deepEqual(posted, []);
  const disposed = readLedgerLines(path).findLast((line) => line.step === "sweep.disposed");
  assert.match(String(disposed?.stand_down_reason), /reviewer-code freshness refusal/);
  assert.match(String(disposed?.stand_down_reason), /freshness recovery backoff.*60m pending ceiling/);
  assert.doesNotMatch(String(disposed?.stand_down_reason), /already REFUSED/);
});

test("a repeated stale freshness refusal restores the retry bound", async () => {
  const path = ledgerPath();
  const pr = reviewPr();
  appendFreshnessRefusal(path, pr, "stale", new Date(NOW - 61 * 60_000).toISOString());

  const firstAttempts: number[] = [];
  await runSweep(
    [pr],
    deps(path, firstAttempts, {
      postReview: (candidate) => {
        firstAttempts.push(candidate.prNumber);
        appendFreshnessRefusal(path, candidate, "stale", new Date(NOW).toISOString());
      },
    }),
    DEFAULT_SWEEP_POLICY,
  );
  assert.deepEqual(firstAttempts, [pr.prNumber]);

  const earlyRetry: number[] = [];
  await runSweep(
    [pr],
    deps(path, earlyRetry, { now: () => NOW + 30 * 60_000 }),
    DEFAULT_SWEEP_POLICY,
  );
  assert.deepEqual(earlyRetry, [], "the fresh stale-code refusal starts a new bounded interval");

  const elapsedRetry: number[] = [];
  await runSweep(
    [pr],
    deps(path, elapsedRetry, { now: () => NOW + 61 * 60_000 }),
    DEFAULT_SWEEP_POLICY,
  );
  assert.deepEqual(elapsedRetry, [pr.prNumber]);
});

test("unreadable and undated freshness refusals remain recoverable", async () => {
  const path = ledgerPath();
  const unreadable = reviewPr(3449);
  const undated = reviewPr(3450);
  appendFreshnessRefusal(path, unreadable, "unreadable", new Date(NOW - 61 * 60_000).toISOString());
  appendFreshnessRefusal(path, undated, "stale", undefined);

  const firstAttempts: number[] = [];
  await runSweep(
    [unreadable, undated],
    deps(path, firstAttempts, {
      postReview: (candidate) => {
        firstAttempts.push(candidate.prNumber);
        appendFreshnessRefusal(path, candidate, "stale", new Date(NOW).toISOString());
      },
    }),
    DEFAULT_SWEEP_POLICY,
  );
  assert.deepEqual(firstAttempts.sort((a, b) => a - b), [unreadable.prNumber, undated.prNumber]);

  const secondAttempts: number[] = [];
  await runSweep(
    [unreadable, undated],
    deps(path, secondAttempts, { now: () => NOW + 1 * 60_000 }),
    DEFAULT_SWEEP_POLICY,
  );
  assert.deepEqual(secondAttempts, [], "the recovery admission is one-shot until a fresh bound elapses");
});

test("non-freshness review outcomes stay durable", async () => {
  const path = ledgerPath();
  const delivered = reviewPr(1);
  const lifecycle = reviewPr(2);
  const precedence = reviewPr(3);
  const diffCeiling = reviewPr(4);
  const old = new Date(NOW - 24 * 60 * 60_000).toISOString();
  appendOutcome(path, delivered, "review.posted", old, { state: "success" });
  appendOutcome(path, lifecycle, "review.post_refused", old, {
    reason: "PR is already merged — refusing to post remudero-review against a closed lifecycle",
  });
  appendOutcome(path, precedence, "review.post_refused", old, {
    reason: "operator precedence refusal",
  });
  appendOutcome(path, diffCeiling, "review.post_refused", old, {
    reason: DIFF_CEILING_REASON,
  });

  const posted: number[] = [];
  await runSweep([delivered, lifecycle, precedence, diffCeiling], deps(path, posted), DEFAULT_SWEEP_POLICY);
  assert.deepEqual(posted, []);
});
