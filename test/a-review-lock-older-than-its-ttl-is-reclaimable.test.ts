import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { appendLedger } from "../src/lib/ledger.js";
import { readLedgerLines } from "../src/lib/status.js";
import { REVIEW_LOCK_TTL_MS, postReviewPending, type PrLifecycleState } from "../src/lib/review.js";

/**
 * W1-T3647 — #5672 measured the defect: a `remudero-review=pending` claim posted at 23:42 was
 * still pending at 01:42 (2h) while its owning run was demonstrably dead, and the ONLY thing that
 * ever cleared it was an unrelated new sha. `postReviewPending`'s idempotent-per-input guard had
 * no expiry and no staleness read at all — a same-sha repeat was ALWAYS a no-op, forever.
 *
 * Own file per this repo's coverage-at-file-level convention (see e.g.
 * test/review-pending-post-degrades.test.ts's own doc for why a shared-file suite is
 * uninformative about one behaviour specifically).
 */

const NOT_MERGED: PrLifecycleState = { merged: false, closed: false };

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "rmd-review-lock-ttl-"));
}

test("a review claim records when it was taken", async () => {
  const dir = tmpDir();
  try {
    const ledgerPath = join(dir, "ledger.ndjson");
    const before = Date.now();

    const result = await postReviewPending({
      owner: "o",
      repo: "r",
      sha: "abc1234",
      taskId: "W1-T3647-A",
      runId: "run-first",
      ledgerPath,
      fetchLifecycle: () => NOT_MERGED,
      post: () => {},
    });
    assert.equal(result.posted, true);

    const claim = readLedgerLines(ledgerPath).find((line) => line.step === "review.pending_posted");
    assert.ok(claim, "the pending post must record a review.pending_posted ledger line");
    assert.equal(typeof claim!.ts, "string", "the claim must carry its own ts field");
    const takenAtMs = Date.parse(claim!.ts as string);
    assert.ok(!Number.isNaN(takenAtMs), "the recorded ts must be a readable timestamp");
    assert.ok(takenAtMs >= before && takenAtMs <= Date.now(), "ts must date the moment this claim was taken");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a claim older than the ttl is taken over by the next reviewer", async () => {
  const dir = tmpDir();
  try {
    const ledgerPath = join(dir, "ledger.ndjson");
    const sha = "deadbeef1";
    // A claim older than REVIEW_LOCK_TTL_MS — the shape #5672 measured (a dead owner, same head).
    const staleTs = new Date(Date.now() - REVIEW_LOCK_TTL_MS - 60_000).toISOString();
    appendLedger(ledgerPath, {
      run_id: "run-dead",
      task_id: "W1-T3647-B",
      step: "review.pending_posted",
      head_sha: sha,
      ts: staleTs,
    });

    const posts: Array<{ description?: string }> = [];
    const result = await postReviewPending({
      owner: "o",
      repo: "r",
      sha,
      taskId: "W1-T3647-B",
      runId: "run-alive",
      ledgerPath,
      fetchLifecycle: () => NOT_MERGED,
      post: (o) => {
        posts.push(o as { description?: string });
      },
    });

    assert.equal(result.posted, true, "the next reviewer must post itself as the new holder, not defer");
    assert.equal(posts.length, 1, "the stale claim is reclaimed by posting, not by deleting the record");
    assert.match(posts[0]!.description ?? "", /took over/i);
    assert.match(posts[0]!.description ?? "", /run-dead/, "the takeover names the run it took over from");

    const pendingLines = readLedgerLines(ledgerPath).filter((line) => line.step === "review.pending_posted");
    assert.equal(pendingLines.length, 2, "reclaim adds a fresh claim rather than erasing the stale one");
    assert.equal(pendingLines[1]!.run_id, "run-alive", "the newest claim is owned by the reclaiming run");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a claim inside the ttl still defers (falsifier control)", async () => {
  const dir = tmpDir();
  try {
    const ledgerPath = join(dir, "ledger.ndjson");
    const sha = "deadbeef2";
    const freshTs = new Date(Date.now() - Math.floor(REVIEW_LOCK_TTL_MS / 2)).toISOString();
    appendLedger(ledgerPath, {
      run_id: "run-live",
      task_id: "W1-T3647-C",
      step: "review.pending_posted",
      head_sha: sha,
      ts: freshTs,
    });

    const posts: unknown[] = [];
    const result = await postReviewPending({
      owner: "o",
      repo: "r",
      sha,
      taskId: "W1-T3647-C",
      runId: "run-second",
      ledgerPath,
      fetchLifecycle: () => NOT_MERGED,
      post: (o) => {
        posts.push(o);
      },
    });

    assert.equal(result.posted, false, "a claim still inside the TTL is a live review in flight, never taken over");
    assert.equal(posts.length, 0);
    assert.match(result.reason ?? "", /no-op/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a claim with an unreadable age is treated as live", async () => {
  const dir = tmpDir();
  try {
    const ledgerPath = join(dir, "ledger.ndjson");
    const sha = "deadbeef3";
    // An unparsable ts — the "unreadable clock" arm design (c) requires to FAIL TOWARD HOLDING.
    appendLedger(ledgerPath, {
      run_id: "run-undated",
      task_id: "W1-T3647-D",
      step: "review.pending_posted",
      head_sha: sha,
      ts: "not-a-timestamp",
    });

    const posts: unknown[] = [];
    const result = await postReviewPending({
      owner: "o",
      repo: "r",
      sha,
      taskId: "W1-T3647-D",
      runId: "run-second",
      ledgerPath,
      fetchLifecycle: () => NOT_MERGED,
      post: (o) => {
        posts.push(o);
      },
    });

    assert.equal(result.posted, false, "an unreadable claim age must never let a second reviewer judge the same head");
    assert.equal(posts.length, 0, "no second status is posted while the age cannot be read");
    assert.match(result.reason ?? "", /no-op/);
    assert.match(result.reason ?? "", /run-undated/, "the held claim's original owner is still named");

    const pendingLines = readLedgerLines(ledgerPath).filter((line) => line.step === "review.pending_posted");
    assert.equal(pendingLines.length, 1, "an unreadable age never reclaims — the original claim is untouched");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
