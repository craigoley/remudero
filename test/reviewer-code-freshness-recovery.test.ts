import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { appendLedger } from "../src/lib/ledger.js";
import { DEFAULT_SWEEP_POLICY, runSweep, type OpenPrView, type SweepDeps } from "../src/lib/sweep.js";
import { readLedgerLines } from "../src/lib/status.js";

const NOW = Date.now();
const REQUIRED_REVIEWER_SOURCE = "required-reviewer-source";

function ledgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), "rmd-reviewer-code-recovery-")), "ledger.ndjson");
}

function pendingReview(): OpenPrView {
  return {
    prNumber: 3581,
    prUrl: "https://github.com/o/r/pull/3581",
    taskId: "W1-T3581",
    reviewState: "pending",
    checksState: "green",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: new Date(NOW - 120 * 60_000).toISOString(),
    headSha: "review-head",
    reviewInputDigest: "review-input",
    reviewPendingOwnerDead: true,
    autoMergeArmed: false,
  };
}

function appendWithheldReview(path: string, pr: OpenPrView, freshness: "stale" | "unreadable" = "stale"): void {
  appendLedger(path, {
    ts: new Date(NOW - 30 * 60_000).toISOString(),
    run_id: "REVIEW-OLD",
    task_id: pr.taskId ?? "",
    step: "review.post_refused",
    pr_url: pr.prUrl,
    head_sha: pr.headSha,
    review_input_digest: pr.reviewInputDigest,
    reviewer_code_freshness: freshness,
    ...(freshness === "stale" ? { origin_main_sha: REQUIRED_REVIEWER_SOURCE } : {}),
    reason: `reviewer-code freshness ${freshness}`,
  });
}

function sweepDeps(path: string, posted: number[], over: Partial<SweepDeps> = {}): SweepDeps {
  return {
    arm: () => {},
    close: () => {},
    dispatchFix: () => {},
    escalate: () => {},
    postReview: (pr) => { posted.push(pr.prNumber); },
    ledgerPath: path,
    now: () => NOW,
    runId: "SWEEP-W1-T3581",
    ...over,
  };
}

test("W1-T3581 fresh loaded reviewer code releases withheld pending review", async () => {
  const path = ledgerPath();
  const pr = pendingReview();
  appendWithheldReview(path, pr);

  const stoodDown: number[] = [];
  await runSweep(
    [pr],
    sweepDeps(path, stoodDown, {
      reviewerCodeRecovery: {
        loadedCodeSha: "loaded-descendant",
        isLoadedCodeAtOrAfter: () => false,
      },
    }),
    DEFAULT_SWEEP_POLICY,
  );
  assert.deepEqual(stoodDown, [], "a loaded SHA without ancestry proof must retain the pending ceiling");

  const posted: number[] = [];
  await runSweep(
    [pr],
    sweepDeps(path, posted, {
      reviewerCodeRecovery: {
        loadedCodeSha: "loaded-descendant",
        isLoadedCodeAtOrAfter: (required) => required === REQUIRED_REVIEWER_SOURCE,
      },
    }),
    DEFAULT_SWEEP_POLICY,
  );
  assert.deepEqual(posted, [pr.prNumber], "the existing post-review lane is re-admitted before the 60-minute ceiling");
});

test("W1-T3581 unproved loaded reviewer code keeps withheld pending review bounded", async () => {
  const cases: Array<{
    name: string;
    freshness?: "stale" | "unreadable";
    recovery?: SweepDeps["reviewerCodeRecovery"];
    expectedAncestryChecks: number;
  }> = [
    { name: "missing loaded-code provenance", expectedAncestryChecks: 0 },
    {
      name: "older or divergent loaded code",
      recovery: { loadedCodeSha: "older-or-divergent", isLoadedCodeAtOrAfter: () => false },
      expectedAncestryChecks: 1,
    },
    {
      name: "unreadable ancestry",
      recovery: { loadedCodeSha: "unreadable", isLoadedCodeAtOrAfter: () => { throw new Error("git unreadable"); } },
      expectedAncestryChecks: 1,
    },
    {
      name: "unreadable prior reviewer-code provenance",
      freshness: "unreadable",
      recovery: { loadedCodeSha: "newer", isLoadedCodeAtOrAfter: () => true },
      expectedAncestryChecks: 0,
    },
  ];

  for (const candidate of cases) {
    const path = ledgerPath();
    const pr = pendingReview();
    appendWithheldReview(path, pr, candidate.freshness);
    const posted: number[] = [];
    let ancestryChecks = 0;
    const recovery = candidate.recovery === undefined
      ? undefined
      : {
        ...candidate.recovery,
        isLoadedCodeAtOrAfter: (required: string) => {
          ancestryChecks += 1;
          return candidate.recovery!.isLoadedCodeAtOrAfter(required);
        },
      };
    await runSweep(
      [pr],
      sweepDeps(path, posted, { reviewerCodeRecovery: recovery }),
      DEFAULT_SWEEP_POLICY,
    );
    assert.deepEqual(posted, [], `${candidate.name} must not release a withheld terminal verdict`);
    assert.equal(ancestryChecks, candidate.expectedAncestryChecks, `${candidate.name} must reach the fail-closed ancestry boundary exactly when stale provenance is present`);
    const disposed = readLedgerLines(path).findLast((line) => line.step === "sweep.disposed");
    assert.match(String(disposed?.stand_down_reason), /freshness recovery backoff.*60m pending ceiling/);
    if (candidate.name === "unreadable ancestry") {
      assert.match(String(disposed?.stand_down_reason), /ancestry check failed \(Error\)/, "an unreadable ancestry check stays bounded and names the failed evidence channel");
    }
  }
});
