/**
 * test/a-stuck-in-process-review-is-aborted-and-readmitted.test.ts — W1-T11340 criteria 2 and 3.
 *
 * OBSERVED 2026-11-04: the stale-pending rule re-ran #16763 and #16764 at 107 and 129 minutes, and each re-run stood
 * down with "review already in flight for this head (admitted by an overlapping light pass)" (W1-T7955): the head
 * stayed reserved until a review that never settled did, and the daemon escalated a stage-stall to a human. These
 * tests hold a first light pass's review open, then run a second pass with the pending past (or under) its ceiling.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";

import {
  DEFAULT_SWEEP_POLICY, REVIEW_IN_PROCESS_RECLAIMED_STEP, abortInProcessReviewPastCeiling, currentReviewSignal, inFlightReviewCount, runSweepLightPass,
  trackInFlightReview, type OpenPrView, type SweepDeps,
} from "#test/helpers/sweep-test.js";
import { appendLedger } from "#src/lib/ledger.js";
import { priorPostedReviewRow } from "#src/lib/review.js";
import { readLedgerLines } from "#src/lib/status.js";

const NOW = Date.parse("2026-11-04T16:47:00Z");
const CEILING_MS = DEFAULT_SWEEP_POLICY.pendingCeilingMinutes * 60_000;
const IN_FLIGHT = "review already in flight for this head (admitted by an overlapping light pass)";

function pr(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 16763, prUrl: "https://github.com/acme/scratch/pull/16763", taskId: "PR-16763",
    reviewState: "none", checksState: "green", unmetCriteria: [], priorStrikes: 0,
    lastActivityAt: "2026-11-04T16:20:07Z", headSha: "ebc13ba8cd", autoMergeArmed: false, ...over,
  };
}

/** The same head on a later pass: remudero-review now reads the first review's own pending. */
const pendingSinceFirstReview = (): OpenPrView => pr({ reviewState: "pending", reviewPendingSince: new Date(NOW).toISOString() });

function ledgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), "rmd-t11340-")), "ledger.ndjson");
}

function deps(path: string, now: number, over: Partial<SweepDeps> = {}): SweepDeps {
  return { arm: () => {}, close: () => {}, dispatchFix: () => {}, escalate: () => {}, ledgerPath: path, runId: "SWEEP-T11340", now: () => now, ...over };
}

/** A first pass whose review settles only when its lane aborts it (`honorsAbort`) or when the test lets it go. */
async function holdReviewOpen(honorsAbort: boolean): Promise<{ aborted: () => boolean; finish: () => Promise<void> }> {
  let let_go!: () => void;
  const gate = new Promise<void>((resolve) => { let_go = resolve; });
  let started!: () => void;
  const began = new Promise<void>((resolve) => { started = resolve; });
  let sawAbort = false;
  const first = runSweepLightPass([pr()], deps(ledgerPath(), NOW, {
    postReview: async () => {
      const signal = currentReviewSignal();
      started();
      await new Promise<void>((resolve, reject) => {
        void gate.then(resolve);
        signal?.addEventListener("abort", () => {
          sawAbort = true;
          if (honorsAbort) reject(signal.reason);
        }, { once: true });
      });
    },
  }), DEFAULT_SWEEP_POLICY);
  await began;
  return { aborted: () => sawAbort, finish: async () => { let_go(); await first; } };
}

const rows = (path: string, step: string): Record<string, unknown>[] => readLedgerLines(path).filter((l) => l.step === step);

test("W1-T11340: a stale pending held by this process's stuck review is aborted and re-admitted", async () => {
  const first = await holdReviewOpen(true);
  try {
    const lp = ledgerPath();
    const admitted: number[] = [];
    await runSweepLightPass([pendingSinceFirstReview()], deps(lp, NOW + CEILING_MS + 60_000, {
      postReview: (p) => { admitted.push(p.prNumber); },
    }), DEFAULT_SWEEP_POLICY);
    assert.equal(first.aborted(), true, "the stuck review's own controller was aborted");
    const reclaimed = rows(lp, REVIEW_IN_PROCESS_RECLAIMED_STEP);
    assert.equal(reclaimed.length, 1);
    assert.equal(reclaimed[0]?.outcome, "aborted");
    assert.equal(reclaimed[0]?.pr_number, 16763);
    assert.equal(reclaimed[0]?.head_sha, "ebc13ba8cd");
    assert.equal(reclaimed[0]?.ceiling_minutes, DEFAULT_SWEEP_POLICY.pendingCeilingMinutes);
    assert.ok(Number(reclaimed[0]?.run_age_ms) >= CEILING_MS, "the row carries the run's age against the ceiling");
    assert.deepEqual(admitted, [16763], "the freed head is admitted as usual in the same pass");
    const disposed = rows(lp, "sweep.disposed").find((l) => l.pr_number === 16763);
    assert.notEqual(disposed?.stand_down_reason, IN_FLIGHT);
  } finally {
    await first.finish();
  }
});

test("W1-T11340: a review under its ceiling still stands down as already in flight", async () => {
  const first = await holdReviewOpen(true);
  try {
    const lp = ledgerPath();
    const admitted: number[] = [];
    // Pending past the stale ceiling (the disposition re-runs it), but the review itself started a minute ago.
    const youngRun = pr({ reviewState: "pending", reviewPendingSince: new Date(NOW - CEILING_MS - 60_000).toISOString() });
    await runSweepLightPass([youngRun], deps(lp, NOW + 60_000, { postReview: (p) => { admitted.push(p.prNumber); } }), DEFAULT_SWEEP_POLICY);
    assert.equal(first.aborted(), false);
    assert.deepEqual(rows(lp, REVIEW_IN_PROCESS_RECLAIMED_STEP), []);
    assert.deepEqual(admitted, []);
    assert.equal(rows(lp, "sweep.disposed").find((l) => l.pr_number === 16763)?.stand_down_reason, IN_FLIGHT);
  } finally {
    await first.finish();
  }
});

test("W1-T11340: an aborted review that never settles is released and abandoned on the next pass", async () => {
  const first = await holdReviewOpen(false);
  try {
    const lp = ledgerPath();
    const admitted: number[] = [];
    const later = deps(lp, NOW + CEILING_MS + 60_000, { postReview: (p) => { admitted.push(p.prNumber); } });
    await runSweepLightPass([pendingSinceFirstReview()], later, DEFAULT_SWEEP_POLICY);
    assert.equal(first.aborted(), true);
    assert.equal(admitted.length, 0, "still unsettled after its abort: this pass leaves the head reserved");
    const inFlightBefore = inFlightReviewCount();
    await runSweepLightPass([pendingSinceFirstReview()], deps(lp, NOW + CEILING_MS + 120_000, {
      postReview: (p) => { admitted.push(p.prNumber); },
    }), DEFAULT_SWEEP_POLICY);
    assert.deepEqual(rows(lp, REVIEW_IN_PROCESS_RECLAIMED_STEP).map((r) => r.outcome), ["aborted", "released-unsettled"]);
    assert.deepEqual(admitted, [16763], "the next pass frees the head and admits it");
    assert.ok(inFlightReviewCount() < inFlightBefore, "the abandoned review no longer holds a restart drain or the review count");
  } finally {
    await first.finish();
  }
});

test("W1-T11340 criterion 3: the prior-verdict archive scan honors the review's cancellation", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-t11340-abort-"));
  try {
    const ledgerPath = join(root, "ledger.ndjson");
    appendLedger(ledgerPath, { run_id: "r", task_id: "PR-1", step: "sweep.disposed" });
    const url = "https://github.com/acme/scratch/pull/16763";
    writeFileSync(join(root, "ledger.2026-11-04T18-00-00-000Z.ndjson.gz"), gzipSync(`${JSON.stringify({
      ts: "2026-11-04T17:00:00.000Z", run_id: "r", task_id: "PR-16763", step: "review.posted", pr_url: url,
      head_sha: "would-be-found", decision_verdict: { state: "success", criteria: [] },
    })}\n`));
    // The lane's abort reaches the lookup through the review's own cancellation scope, as runReview's awaits carry
    // it: no signal is passed. The light pass aborts by PR number, exactly as reclaimStuckInProcessReviews does.
    let reach!: () => void;
    const reached = new Promise<void>((resolve) => { reach = resolve; });
    const lookup = trackInFlightReview(async () => {
      await reached;
      await priorPostedReviewRow(ledgerPath, "PR-16763", url);
    }, { prNumber: 99_163, taskId: "PR-16763", admittedAtMs: 0 });
    assert.ok(abortInProcessReviewPastCeiling(99_163, CEILING_MS, CEILING_MS), "a run at its ceiling is aborted");
    reach();
    await assert.rejects(lookup, { name: "AbortError" }, "an aborted review settles instead of finishing the scan");
    const explicit = new AbortController();
    explicit.abort(new Error("caller cancelled"));
    await assert.rejects(priorPostedReviewRow(ledgerPath, "PR-16763", url, { signal: explicit.signal }), /caller cancelled/);
    assert.equal((await priorPostedReviewRow(ledgerPath, "PR-16763", url))?.head_sha, "would-be-found",
      "the control: an unaborted lookup finds the archived verdict");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
