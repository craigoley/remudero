import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { test } from "node:test";

import { fixedClock } from "#src/lib/clock.js";
import { readLedgerLines } from "#src/lib/status.js";
import { writeLedger } from "#test/helpers/ledger-fixture.js";
import { REVIEW_RUN_SETTLED_STEPS } from "#src/lib/sweep.js";
import {
  REVIEW_CLAIM_SETTLING_STEPS, REVIEW_LOCK_TTL_MS, REVIEW_REQUEUED_STEP, REVIEWER_CODE_ADVANCED, postReviewPending, reviewInputDigest,
} from "#src/lib/review.js";

/**
 * W1-T14764 — OBSERVED 2026-11-24 on wreckterra #46: five reviews of one input, each after a reviewer-code advance, and
 * every pending after the first said "took over a stale claim" although each earlier run had posted its PASS seconds
 * after its own pending. A claim whose own run later posted a terminal verdict for the input is a finished review.
 */

const TASK = "W1-T14764";
const SHA = "4".repeat(40);
const PR_URL = "https://github.com/o/r/pull/46";
const DIGEST = reviewInputDigest(SHA, `Remudero-Task: ${TASK}`);
const INPUT = { task_id: TASK, pr_url: PR_URL, head_sha: SHA, review_input_digest: DIGEST };

/** The shared ledger fixture, seeded with `rows` and removed after `run`. */
async function seeded(rows: Array<Record<string, unknown>>, run: (path: string) => Promise<void>): Promise<void> {
  const fixture = writeLedger(rows);
  try {
    await run(fixture.path);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
}

async function claim(ledgerPath: string, runId: string, posts: string[]): Promise<boolean> {
  return (await postReviewPending({
    owner: "o", repo: "r", sha: SHA, taskId: TASK, prUrl: PR_URL, reviewInputDigest: DIGEST, runId, ledgerPath,
    reviewEngineRevision: "e12d63f".padEnd(40, "0"),
    ownerIdentity: { pid: 4242, startedAt: new Date().toISOString() },
    clock: fixedClock(Date.now() + REVIEW_LOCK_TTL_MS + 60_000),
    assessPendingOwner: () => "unknown",
    fetchLifecycle: () => ({ merged: false, closed: false }),
    fetchStatus: () => ({ statuses: [] }),
    post: (o) => { posts.push(o.description ?? ""); },
  })).posted;
}

function pendingRows(ledgerPath: string): Array<Record<string, unknown>> {
  return readLedgerLines(ledgerPath).filter((row) => row.step === "review.pending_posted");
}

test("W1-T14764 a re-review after a finished run posts pending without took_over_run_id and says re-review", async () => {
  const ts = new Date().toISOString();
  await seeded([
    { ...INPUT, ts, run_id: "run-A", step: "review.pending_posted", owner_pid: 1, owner_started_at: ts },
    { ...INPUT, ts, run_id: "run-A", step: "review.posted", state: "success" },
    // The advance that clears run-A's verdict, so a later run may review this input again.
    { ts, run_id: "sweep", step: REVIEW_REQUEUED_STEP, reason: REVIEWER_CODE_ADVANCED, pr_url: PR_URL, head_sha: SHA },
  ], async (ledgerPath) => {
    const posts: string[] = [];
    assert.equal(await claim(ledgerPath, "run-B", posts), true, "the re-review claims the input");
    assert.equal(posts.length, 1);
    assert.doesNotMatch(posts[0]!, /took over/, "a finished review is not a stale claim");
    assert.equal(
      posts[0],
      "remudero-review: review in progress (owned by run run-B) — re-review of this input at reviewer code e12d63f (prior run run-A)",
    );
    const row = pendingRows(ledgerPath).at(-1)!;
    assert.equal(row.run_id, "run-B");
    assert.equal(row.took_over_run_id, undefined);
    assert.equal(row.prior_run_id, "run-A");
    assert.deepEqual(readLedgerLines(ledgerPath).filter((r) => r.step === "review.claim_repeated"), []);
  });
  // Every other row by which a run settles its claim, written as review.ts's CLI writes it: no digest, often no task id.
  for (const step of REVIEW_CLAIM_SETTLING_STEPS) {
    const ts = new Date().toISOString();
    await seeded([
      { ...INPUT, ts, run_id: "run-A", step: "review.pending_posted", owner_pid: 1, owner_started_at: ts },
      { ts, run_id: "run-A", step, pr_url: PR_URL, head_sha: SHA, reason: "fixture" },
    ], async (ledgerPath) => {
      const posts: string[] = [];
      assert.equal(await claim(ledgerPath, "run-B", posts), true, `${step}: the re-review claims the input`);
      assert.match(posts[0]!, /re-review of this input .*\(prior run run-A\)$/, `${step} settles run-A's claim`);
      assert.equal(pendingRows(ledgerPath).at(-1)!.took_over_run_id, undefined, `${step}: no takeover recorded`);
    });
  }
});

test("W1-T14764 the claim-settling steps are sweep's settled steps other than review.posted", () => {
  assert.deepEqual([...REVIEW_CLAIM_SETTLING_STEPS].sort(), [...REVIEW_RUN_SETTLED_STEPS].filter((s) => s !== "review.posted").sort());
});

test("W1-T14764 a pending row with no terminal row from its run is still taken over once stale", async () => {
  const ts = new Date().toISOString();
  await seeded([
    { ...INPUT, ts, run_id: "run-A", step: "review.pending_posted", owner_pid: 1, owner_started_at: ts },
    // Another run's verdict, and run-A's verdict on another head, settle nothing for run-A's claim on this input.
    { ...INPUT, ts, run_id: "run-Z", step: "review.posted", state: "error" },
    { ...INPUT, ts, run_id: "run-A", step: "review.posted", state: "success", head_sha: "5".repeat(40) },
    { ts, run_id: "run-Z", step: "review.stood_down", pr_url: PR_URL, head_sha: SHA },
    { ts, run_id: "run-A", step: "review.stood_down", pr_url: PR_URL, head_sha: SHA, review_input_digest: "another-body" },
  ], async (ledgerPath) => {
    const posts: string[] = [];
    assert.equal(await claim(ledgerPath, "run-B", posts), true);
    assert.equal(
      posts[0],
      "remudero-review: review in progress (owned by run run-B) — took over a stale claim (>= 42m old) from run run-A (W1-T3647)",
    );
    const row = pendingRows(ledgerPath).at(-1)!;
    assert.equal(row.took_over_run_id, "run-A");
    assert.equal(row.prior_run_id, undefined);
  });
});
