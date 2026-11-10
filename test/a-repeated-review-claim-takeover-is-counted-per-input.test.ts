import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { fixedClock } from "#src/lib/clock.js";
import { appendLedger } from "#src/lib/ledger.js";
import { readLedgerLines } from "#src/lib/status.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { REVIEW_LOCK_TTL_MS, postReviewPending, reviewInputDigest, type PostReviewPendingOpts } from "#src/lib/review.js";

/**
 * W1-T11930 — OBSERVED 2026-11-09: #17494's remudero-review history held 8 stale-claim takeovers between 17:05Z and
 * 22:08Z and no verdict from any of them. Each takeover posted a correct status and nothing counted them, so the
 * start-and-die loop was visible only by reading one head's status history. A takeover that follows another takeover
 * of the same input, with no verdict row between, now writes `review.claim_repeated` with the count.
 *
 * Own file: the takeover RULE is pinned by test/a-review-lock-older-than-its-ttl-is-reclaimable.test.ts and
 * test/a-re-run-review-takes-over-a-dead-owners-pending.test.ts; this file pins only the counting row.
 */

const TASK = "W1-T11930";
const SHA = "c".repeat(40);
const PR_URL = "https://github.com/o/r/pull/17494";
const DIGEST = reviewInputDigest(SHA, `Remudero-Task: ${TASK}`);
const INPUT_KEY = `${PR_URL}@${SHA}#${DIGEST}`;

type Post = { owner: string; repo: string; sha: string; state: string; description?: string };

/** One ledger, one input, and a clock each claim steps past the previous claim's TTL: every claim after the first is
 *  a stale-claim takeover, the shape #17494 repeated. `dead` takes over inside the TTL on proof of death instead. */
async function harness(run: (h: {
  ledgerPath: string;
  posts: Post[];
  claim: (runId: string, over?: Partial<PostReviewPendingOpts>) => Promise<boolean>;
  rows: (step: string) => Array<Record<string, unknown>>;
}) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}claim-repeated-`));
  try {
    const ledgerPath = join(dir, "ledger.ndjson");
    const posts: Post[] = [];
    let claims = 0;
    await run({
      ledgerPath,
      posts,
      rows: (step) => readLedgerLines(ledgerPath).filter((row) => row.step === step),
      claim: async (runId, over = {}) => (await postReviewPending({
        owner: "o", repo: "r", sha: SHA, taskId: TASK, prUrl: PR_URL, reviewInputDigest: DIGEST, runId, ledgerPath,
        ownerIdentity: { pid: 4100 + claims, startedAt: new Date().toISOString() },
        clock: fixedClock(Date.now() + claims++ * (REVIEW_LOCK_TTL_MS + 60_000)),
        assessPendingOwner: () => "unknown",
        fetchLifecycle: () => ({ merged: false, closed: false }),
        fetchStatus: () => ({ statuses: [] }),
        post: (o) => {
          posts.push({ owner: o.owner, repo: o.repo, sha: o.sha, state: o.state, ...(o.description !== undefined ? { description: o.description } : {}) });
        },
        ...over,
      })).posted,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("W1-T11930 criterion 1: a takeover that follows a takeover of the same input with no verdict between writes review.claim_repeated with the input key, head sha and count", async () => {
  await harness(async (h) => {
    assert.equal(await h.claim("run-1"), true);
    assert.equal(await h.claim("run-2"), true);
    assert.equal(await h.claim("run-3"), true);
    const second = h.rows("review.claim_repeated");
    assert.equal(second.length, 1, "the second consecutive takeover writes exactly one repeat row");
    assert.equal(second[0]!.run_id, "run-3");
    assert.equal(second[0]!.task_id, TASK);
    assert.equal(second[0]!.input_key, INPUT_KEY);
    assert.equal(second[0]!.head_sha, SHA);
    assert.ok(String(second[0]!.input_key).startsWith(`${PR_URL}@`), "the input key names the PR");
    assert.equal(second[0]!.review_input_digest, DIGEST);
    assert.equal(second[0]!.takeovers, 2);
    assert.equal(second[0]!.took_over_run_id, "run-2", "the row names the owner that died without a verdict");

    assert.equal(await h.claim("run-4"), true);
    // #17494's eighth: the owner is proven dead inside the TTL, the other takeover the rule allows.
    assert.equal(await h.claim("run-5", { clock: fixedClock(Date.now()), assessPendingOwner: () => "dead" }), true);
    assert.deepEqual(
      h.rows("review.claim_repeated").map((row) => [row.run_id, row.takeovers, row.took_over_run_id]),
      [["run-3", 2, "run-2"], ["run-4", 3, "run-3"], ["run-5", 4, "run-4"]],
      "each further takeover with no verdict between raises the count by one",
    );
    assert.equal(h.rows("review.pending_posted").length, 5, "the counting row is added beside the claim rows, never instead of one");
  });
});

test("W1-T11930 criterion 2: the first takeover of an input, and a takeover after a delivered verdict, write no repeat row and the count starts again at one", async (t) => {
  await t.test("the first takeover of an input", async () => {
    await harness(async (h) => {
      // Takeovers of ANOTHER head, body and PR are other inputs: none of them makes this input's first one a repeat.
      const other = { step: "review.pending_posted", ts: new Date(Date.now() - 2 * REVIEW_LOCK_TTL_MS).toISOString(), took_over_run_id: "run-gone" };
      appendLedger(h.ledgerPath, { ...other, run_id: "run-a", task_id: TASK, pr_url: PR_URL, head_sha: "d".repeat(40), review_input_digest: DIGEST });
      appendLedger(h.ledgerPath, { ...other, run_id: "run-b", task_id: TASK, pr_url: PR_URL, head_sha: SHA, review_input_digest: "another-body" });
      appendLedger(h.ledgerPath, { ...other, run_id: "run-c", task_id: TASK, pr_url: "https://github.com/o/r/pull/1", head_sha: SHA, review_input_digest: DIGEST });
      assert.equal(await h.claim("run-1"), true);
      assert.equal(h.posts.length, 1);
      assert.doesNotMatch(h.posts[0]!.description ?? "", /took over/, "control: the first claim of this input is not a takeover");
      assert.equal(await h.claim("run-2"), true);
      assert.match(h.posts[1]!.description ?? "", /took over.*run-1/, "control: the second claim is a takeover");
      assert.deepEqual(h.rows("review.claim_repeated"), [], "one takeover is not a repeat");
    });
  });

  await t.test("a takeover after a delivered verdict", async () => {
    await harness(async (h) => {
      assert.equal(await h.claim("run-1"), true);
      assert.equal(await h.claim("run-2"), true);
      assert.equal(await h.claim("run-3"), true);
      assert.equal(h.rows("review.claim_repeated").length, 1, "control: two takeovers with no verdict between are a repeat");
      // run-3 delivered a verdict the claim path does not treat as terminal, so a later run may claim this input again.
      appendLedger(h.ledgerPath, {
        run_id: "run-3", task_id: TASK, step: "review.posted", state: "error", head_sha: SHA, pr_url: PR_URL, review_input_digest: DIGEST,
      });
      assert.equal(await h.claim("run-4"), true);
      assert.match(h.posts[3]!.description ?? "", /took over.*run-3/, "control: the claim after the verdict is a takeover");
      assert.equal(h.rows("review.claim_repeated").length, 1, "a takeover after a delivered verdict is the first of a new count");
      assert.equal(await h.claim("run-5"), true);
      const repeats = h.rows("review.claim_repeated");
      assert.equal(repeats.length, 2);
      assert.equal(repeats[1]!.run_id, "run-5");
      assert.equal(repeats[1]!.takeovers, 2, "the count started again at one after the verdict, so the next takeover is the second");
    });
  });
});

test("W1-T11930 criterion 3: the statuses a takeover writes are the ones it wrote before the count existed", async () => {
  await harness(async (h) => {
    assert.equal(await h.claim("run-1"), true);
    assert.equal(await h.claim("run-2"), true);
    assert.equal(await h.claim("run-3"), true);
    assert.equal(await h.claim("run-4", { clock: fixedClock(Date.now()), assessPendingOwner: () => "dead" }), true);
    assert.equal(h.rows("review.claim_repeated").length, 2, "control: two of these takeovers were counted as repeats");
    const pending = { owner: "o", repo: "r", sha: SHA, state: "pending" };
    // The literal text of W1-T913, W1-T3647 and W1-T8088: a counted takeover posts one status, worded as an uncounted one.
    assert.deepEqual(h.posts, [
      { ...pending, description: "remudero-review: review in progress (owned by run run-1)" },
      { ...pending, description: "remudero-review: review in progress (owned by run run-2) — took over a stale claim (>= 42m old) from run run-1 (W1-T3647)" },
      { ...pending, description: "remudero-review: review in progress (owned by run run-3) — took over a stale claim (>= 42m old) from run run-2 (W1-T3647)" },
      { ...pending, description: "pending (owned by run run-4) — took over run run-3: owner proven dead" },
    ]);
  });
});
