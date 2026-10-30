import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { appendLedger } from "#src/lib/ledger.js";
import { readLedgerLines } from "#src/lib/status.js";
import { DEFAULT_SWEEP_POLICY, runSweep, type OpenPrView } from "#test/helpers/sweep-test.js";

test("W1-T10975: check:test:test/post-review-throw-backoff.test.ts is prevented, not retried", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "rmd-review-retry-clock-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "ledger.ndjson");
  const now = Date.now() - 2 * 60 * 60_000;
  const pr: OpenPrView = {
    prNumber: 2753,
    prUrl: "https://github.com/o/r/pull/2753",
    taskId: "W1-T2753",
    reviewState: "none",
    checksState: "green",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: new Date(now - 120 * 60_000).toISOString(),
    headSha: "retry-clock-head",
    reviewInputDigest: "retry-clock-body",
    autoMergeArmed: false,
  };
  appendLedger(path, {
    ts: new Date(now - 61 * 60_000).toISOString(),
    run_id: "REVIEW-OLD",
    task_id: pr.taskId!,
    step: "review.post_refused",
    pr_url: pr.prUrl,
    head_sha: pr.headSha,
    review_input_digest: pr.reviewInputDigest,
    reason: "post-review attempt threw — standing down rather than retrying this head unbounded: transport",
  });
  const attempts: number[] = [];
  const deps = {
    arm: () => {}, close: () => {}, dispatchFix: () => {}, escalate: () => {},
    ledgerPath: path,
    runId: "SWEEP-RETRY-CLOCK",
    now: () => now,
    postReview: (candidate: OpenPrView) => {
      attempts.push(candidate.prNumber);
      throw new Error("transport");
    },
  };
  const summary = await runSweep([pr], deps, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(attempts, [2753]);
  assert.equal(summary.actionsFailed, 1);
  const marker = readLedgerLines(path).findLast((line) => line.step === "review.post_refused");
  assert.equal(marker?.ts, new Date(now).toISOString());

  const retried: number[] = [];
  const retry = { ...deps, postReview: (candidate: OpenPrView) => { retried.push(candidate.prNumber); } };
  await runSweep([pr], { ...retry, now: () => now + 30 * 60_000 }, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(retried, []);
  await runSweep([pr], { ...retry, now: () => now + 61 * 60_000 }, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(retried, [2753]);
});
