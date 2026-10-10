import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { appendLedger } from "../src/lib/ledger.js";
import { readLedgerLines } from "../src/lib/status.js";
import { DEFAULT_SWEEP_POLICY, runSweepLightPass, type OpenPrView, type SweepDeps } from "./helpers/sweep-test.js";

function view(n: number, now: number): OpenPrView {
  return {
    prNumber: n, prUrl: `https://github.com/o/r/pull/${n}`, taskId: `W1-T${n}`,
    headSha: `head-${n}`, reviewInputDigest: `input-${n}`, reviewState: "none",
    checksState: "green", unmetCriteria: [], priorStrikes: 0, autoMergeArmed: false,
    createdAt: new Date(now - (100 - n) * 60_000).toISOString(),
    lastActivityAt: new Date(now - 10 * 60_000).toISOString(),
  };
}

test("W1-T6044: flow-awaiting-review-checks-green-review-never-posted clears without a person", async (t) => {
  for (const [freshness, loaded] of [["stale", true], ["unreadable", true], ["unreadable", false]] as const) {
    await t.test(`${freshness}, loaded=${loaded}`, async () => {
      const now = Date.now();
      const dir = mkdtempSync(join(tmpdir(), "rmd-flow-review-"));
      try {
        const ledgerPath = join(dir, "ledger.ndjson");
        const older = view(1, now), waiting = view(2, now);
        appendLedger(ledgerPath, {
          ts: new Date(now - 60_000).toISOString(), run_id: "prior-review",
          task_id: older.taskId!, step: "review.post_refused", pr_url: older.prUrl,
          head_sha: older.headSha, review_input_digest: older.reviewInputDigest,
          reviewer_code_freshness: freshness, reason: `reviewer-code freshness ${freshness}`,
        });
        const posted: number[] = [];
        const deps: SweepDeps = {
          ledgerPath, runId: "flow-review", now: () => now,
          arm: () => assert.fail("review admission must not arm"), close: () => assert.fail("must not close"),
          dispatchFix: () => assert.fail("must not fix"), escalate: () => assert.fail("must not ask a person"),
          reviewerCodeRecovery: loaded ? {
            loadedCodeSha: "loaded", isLoadedCodeAtOrAfter: () => false,
            probeFreshness: async () => ({ status: "fresh", codeSha: "loaded", originMainSha: "loaded", advance: "none" }),
          } : undefined,
          postReview: (pr) => {
            posted.push(pr.prNumber);
            appendLedger(ledgerPath, {
              run_id: "review", task_id: pr.taskId!, step: "review.posted", state: "success",
              pr_url: pr.prUrl, head_sha: pr.headSha, review_input_digest: pr.reviewInputDigest,
            });
          },
        };
        const policy = { ...DEFAULT_SWEEP_POLICY, reviewLanes: 1 };
        await runSweepLightPass([older, waiting], deps, policy);
        assert.deepEqual(posted, [waiting.prNumber], "a backed-off head must leave the slot to the never-reviewed PR");
        assert.equal(readLedgerLines(ledgerPath).filter(row => row.step === "review.posted").length, 1);
        const held = readLedgerLines(ledgerPath).findLast(row => row.step === "sweep.disposed" && row.pr_number === older.prNumber);
        assert.match(String(held?.stand_down_reason), /freshness recovery backoff/);
        await runSweepLightPass([older, { ...waiting, reviewState: "success" }], {
          ...deps, actionable: d => d === "post-review",
        }, policy);
        assert.deepEqual(posted, [waiting.prNumber], "the delivered verdict must not be posted twice");
        await runSweepLightPass([older, { ...waiting, reviewState: "success" }], {
          ...deps, now: () => now + 61 * 60_000, actionable: d => d === "post-review",
        }, policy);
        assert.deepEqual(posted, [waiting.prNumber, older.prNumber], "elapsed backoff or a due fresh-source probe releases the older head");
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });
  }
});
