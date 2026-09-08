import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { appendLedger } from "../src/lib/ledger.js";
import { readLedgerLines } from "../src/lib/status.js";
import {
  DEFAULT_SWEEP_POLICY,
  runSweep,
  type OpenPrView,
  type SweepDeps,
  type SweepPolicy,
} from "../src/lib/sweep.js";

const NOW = Date.parse("2026-09-08T12:00:00.000Z");
const POLICY: SweepPolicy = { ...DEFAULT_SWEEP_POLICY, strikeCap: 2, pendingCeilingMinutes: 60 };

function ledgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), "rmd-permanent-diff-refusal-")), "ledger.ndjson");
}

function pr(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 4510,
    prUrl: "https://github.com/craigoley/remudero/pull/4510",
    taskId: "W1-T3130-SPECIMEN",
    reviewState: "none",
    checksState: "green",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: "2026-09-08T10:00:00.000Z",
    headSha: "head-a",
    reviewInputDigest: "digest-a",
    autoMergeArmed: false,
    ...over,
  };
}

function deps(path: string, posted: number[] = [], escalated: string[] = []): SweepDeps {
  return {
    arm: () => {},
    close: () => {},
    dispatchFix: () => {},
    escalate: (_pr, reason) => {
      escalated.push(reason);
    },
    postReview: (candidate) => {
      posted.push(candidate.prNumber);
    },
    ledgerPath: path,
    runId: "SWEEP-W1-T3130",
    now: () => NOW,
  };
}

function appendPostReviewThrow(path: string, candidate: OpenPrView, error: string, ts: string): void {
  appendLedger(path, {
    ts,
    run_id: "SWEEP-OLD",
    task_id: candidate.taskId ?? `PR-${candidate.prNumber}`,
    step: "review.post_refused",
    pr_url: candidate.prUrl,
    head_sha: candidate.headSha,
    review_input_digest: candidate.reviewInputDigest,
    reason: `post-review attempt threw — standing down rather than retrying this head unbounded: ${error}`,
  });
}

function diffCeilingError(): string {
  return [
    "Command failed: gh pr diff https://github.com/craigoley/remudero/pull/4510",
    "could not find pull request diff: HTTP 406: Sorry, the diff exceeded the maximum number of files (300).",
    "PullRequest.diff too_large",
  ].join("\n");
}

test("a 300-file GitHub diff refusal becomes a visible terminal disposition for the same head", async () => {
  const path = ledgerPath();
  const candidate = pr();
  appendPostReviewThrow(path, candidate, diffCeilingError(), "2026-09-08T10:00:00.000Z");

  const posted: number[] = [];
  const escalated: string[] = [];
  const first = await runSweep([candidate], deps(path, posted, escalated), POLICY);
  const second = await runSweep([candidate], deps(path, posted, escalated), POLICY);

  assert.deepEqual(posted, [], "the same oversized-diff head is not re-dispatched");
  assert.equal(first.actions[0].disposition, "blocked-ambiguous");
  assert.equal(second.actions[0].disposition, "blocked-ambiguous");
  assert.match(first.actions[0].reason, /300-file ceiling/);
  assert.match(first.actions[0].reason, /split the PR under 300 files/);
  assert.equal(escalated.length, 1, "the terminal escalation is deduped on the second pass");
  assert.equal(readLedgerLines(path).filter((line) => line.step === "sweep.post_review.failed").length, 0);
});

test("an unrecognised post-review throw retries under a bounded count and then stops", async () => {
  const path = ledgerPath();
  const candidate = pr({ prNumber: 4511, prUrl: "https://github.com/craigoley/remudero/pull/4511" });
  for (const ts of [
    "2026-09-08T08:00:00.000Z",
    "2026-09-08T09:01:00.000Z",
    "2026-09-08T10:02:00.000Z",
  ]) {
    appendPostReviewThrow(path, candidate, "gh: connection reset by peer", ts);
  }

  const posted: number[] = [];
  const summary = await runSweep([candidate], deps(path, posted), POLICY);

  assert.deepEqual(posted, [], "the cap stops the next unchanged retry");
  assert.equal(summary.actions[0].disposition, "blocked-ambiguous");
  assert.match(summary.actions[0].reason, /have thrown 3 time\(s\)/);
  assert.match(summary.actions[0].reason, /2-strike retry cap/);
});

test("permanent and counted post-review failures reset when the head sha changes", async () => {
  const path = ledgerPath();
  const permanent = pr({ prNumber: 4512, prUrl: "https://github.com/craigoley/remudero/pull/4512" });
  appendPostReviewThrow(path, permanent, diffCeilingError(), "2026-09-08T08:00:00.000Z");

  const counted = pr({
    prNumber: 4513,
    prUrl: "https://github.com/craigoley/remudero/pull/4513",
    headSha: "counted-old",
    reviewInputDigest: "digest-counted",
  });
  appendPostReviewThrow(path, counted, "gh: connection reset by peer", "2026-09-08T08:00:00.000Z");
  appendPostReviewThrow(path, counted, "gh: connection reset by peer", "2026-09-08T09:01:00.000Z");
  appendPostReviewThrow(path, counted, "gh: connection reset by peer", "2026-09-08T10:02:00.000Z");

  const posted: number[] = [];
  await runSweep(
    [
      { ...permanent, headSha: "head-b", reviewInputDigest: "digest-b" },
      { ...counted, headSha: "counted-new" },
    ],
    deps(path, posted),
    POLICY,
  );

  assert.deepEqual(posted.sort((a, b) => a - b), [4512, 4513]);
});

test("a transient post-review throw still re-dispatches when it is under the bound and past backoff", async () => {
  const path = ledgerPath();
  const candidate = pr({ prNumber: 4514, prUrl: "https://github.com/craigoley/remudero/pull/4514" });
  appendPostReviewThrow(path, candidate, "gh: connection reset by peer", "2026-09-08T10:59:00.000Z");

  const posted: number[] = [];
  const summary = await runSweep([candidate], deps(path, posted), POLICY);

  assert.deepEqual(posted, [4514]);
  assert.equal(summary.actions[0].disposition, "post-review");
});
