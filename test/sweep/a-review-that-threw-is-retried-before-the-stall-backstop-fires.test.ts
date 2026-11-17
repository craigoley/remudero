import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { appendLedger } from "#src/lib/ledger.js";
import { retryableReviewThrowBackoffMinutes } from "#src/lib/sweep.js";
import { DEFAULT_SWEEP_POLICY, runSweep, type OpenPrView, type SweepDeps, type SweepPolicy } from "#test/helpers/sweep-test.js";

// W1-T13257. Production 2026-11-16, remudero-console PR 2591: one post-review attempt threw at 20:14Z on a healed
// worktree with no .git entry; the 60m flat backoff outlasted the 30m awaiting-review stall backstop, so the PR sat
// green and unreviewed for 55 minutes and opened an incident.
const NOW = Date.now();
const POLICY: SweepPolicy = { ...DEFAULT_SWEEP_POLICY, strikeCap: 2, pendingCeilingMinutes: 60 };
const isoBefore = (minutes: number): string => new Date(NOW - minutes * 60_000).toISOString();
const ledgerPath = (): string => join(mkdtempSync(join(tmpdir(), "rmd-review-throw-retry-")), "ledger.ndjson");

function pr(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 2591, prUrl: "https://github.com/craigoley/remudero/pull/2591", taskId: "W1-T13257-SPECIMEN",
    reviewState: "none", checksState: "green", unmetCriteria: [], priorStrikes: 0, lastActivityAt: isoBefore(120),
    headSha: "head-a", reviewInputDigest: "digest-a", autoMergeArmed: false, ...over,
  };
}

function deps(path: string, posted: number[], escalated: string[] = []): SweepDeps {
  return {
    arm: () => {}, close: () => {}, dispatchFix: () => {},
    escalate: (_pr, reason) => { escalated.push(reason); },
    postReview: (candidate) => { posted.push(candidate.prNumber); },
    ledgerPath: path, runId: "SWEEP-W1-T13257", now: () => NOW,
  };
}

function appendThrow(path: string, candidate: OpenPrView, ts: string): void {
  appendLedger(path, {
    ts, run_id: "SWEEP-OLD", task_id: candidate.taskId ?? `PR-${candidate.prNumber}`, step: "review.post_refused",
    pr_url: candidate.prUrl, head_sha: candidate.headSha, review_input_digest: candidate.reviewInputDigest,
    reason: "post-review attempt threw — standing down rather than retrying this head unbounded: worktree-git: " +
      "refusing a host git call into /home/node/Remudero/worktrees/healed-x: the worktree has no .git entry",
  });
}

async function admitted(throwsMinutesAgo: readonly number[]): Promise<boolean> {
  const path = ledgerPath();
  const candidate = pr();
  for (const minutes of throwsMinutesAgo) appendThrow(path, candidate, isoBefore(minutes));
  const posted: number[] = [];
  await runSweep([candidate], deps(path, posted), POLICY);
  return posted.includes(candidate.prNumber);
}

test("W1-T13257 criterion 1: one throw is retried after 5 minutes, long before the pending ceiling", async () => {
  assert.equal(await admitted([3]), false, "inside the first 5-minute backoff the review stands down");
  assert.equal(await admitted([6]), true, "6 minutes after one throw the review runs again");
  assert.equal(await admitted([29]), true, "the retry lands before the 30-minute stall backstop");
});

test("W1-T13257 criterion 2: each further throw doubles the wait, never past the pending ceiling", async () => {
  const ceiling = { pendingCeilingMinutes: 60 };
  assert.deepEqual([1, 2, 3, 4, 5, 6].map((n) => retryableReviewThrowBackoffMinutes(n, ceiling)), [5, 10, 20, 40, 60, 60]);
  assert.equal(retryableReviewThrowBackoffMinutes(0, ceiling), 5, "a missing count reads as one throw");
  // Two throws on one input: 10 minutes after the latest.
  assert.equal(await admitted([30, 8]), false);
  assert.equal(await admitted([30, 11]), true);
});

test("W1-T13257 criterion 3: invariant:throw-strike-cap-still-escalates and a new head starts with no wait", async () => {
  const path = ledgerPath();
  const candidate = pr();
  for (const minutes of [200, 150, 100]) appendThrow(path, candidate, isoBefore(minutes));
  const posted: number[] = [];
  const summary = await runSweep([candidate], deps(path, posted), POLICY);
  assert.deepEqual(posted, [], "three throws over a 2-strike cap never post again");
  assert.match(JSON.stringify(summary.actions), /exceeding the 2-strike retry cap/);

  const fresh = ledgerPath();
  appendThrow(fresh, candidate, isoBefore(1));
  const postedNew: number[] = [];
  await runSweep([{ ...candidate, headSha: "head-b", reviewInputDigest: "digest-b" }], deps(fresh, postedNew), POLICY);
  assert.deepEqual(postedNew, [candidate.prNumber], "a throw on the old head never delays the new one");
});
