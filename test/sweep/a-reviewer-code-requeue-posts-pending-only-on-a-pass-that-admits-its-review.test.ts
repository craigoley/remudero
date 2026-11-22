/**
 * W1-T13704 — a reviewer-code requeue posts remudero-review pending only on a pass that admits the review.
 *
 * Replays 2026-11-18 13:00Z: after a daemon reboot the W1-T11847 requeue posted pending on #19375 and #19372 from a
 * light pass that admitted neither review, and that pending held both PRs for the 60 min ceiling with no reviewer
 * behind it. The pass's admission is `actionable("post-review")`; a light pass refuses it per PR that lost the bound.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { appendLedger } from "#src/lib/ledger.js";
import { withLiveWritesAllowed } from "#src/lib/live-write-guard.js";
import { readLedgerLines } from "#src/lib/status.js";
import { REVIEWER_CODE_ADVANCED } from "#src/lib/review.js";
import {
  DEFAULT_SWEEP_POLICY, REVIEW_REQUEUED_STEP, runSweep, type Disposition, type OpenPrView, type ReviewDispatchMode,
  type SweepDeps,
} from "#src/lib/sweep.js";
import { makeTempDir } from "#src/lib/tmp.js";

const PR = 19375;
const URL = `https://github.com/craigoley/remudero/pull/${PR}`;
const TASK = "W1-T90375";
const HEAD = "a".repeat(40);
const DIGEST = "v2:t13704";
const CODE = "c".repeat(40);
const MAIN = "e".repeat(40);
const NOW = Date.parse("2026-11-18T13:00:47Z");

function fixture() {
  const ledgerPath = join(makeTempDir("t13704-sweep"), "ledger.ndjson");
  appendLedger(ledgerPath, {
    ts: "2026-11-18T12:41:02Z", run_id: "review-original", task_id: TASK, step: "review.posted", state: "success",
    pr_url: URL, head_sha: HEAD, review_input_digest: DIGEST, reviewer_code_sha: CODE,
  });
  const pr: OpenPrView = {
    prNumber: PR, prUrl: URL, taskId: TASK, headSha: HEAD, reviewInputDigest: DIGEST, reviewState: "success",
    checksState: "green", unmetCriteria: [], priorStrikes: 0, autoMergeArmed: false,
    lastActivityAt: "2026-11-18T12:41:02Z",
  };
  const posts: string[] = [];
  const reviews: ReviewDispatchMode[] = [];
  const judged: unknown[] = [];
  const run = async (view: OpenPrView, over: Partial<SweepDeps> = {}) => {
    const deps: SweepDeps = {
      ledgerPath, runId: "DAEMON-1795006451613-7", now: () => NOW,
      reviewerCodeAdvance: {
        judge: async (sha) => { judged.push(sha); return { status: "stale", codeSha: MAIN, originMainSha: MAIN, changedPaths: ["src/lib/review.ts"] }; },
        postPending: async (target) => { posts.push(target.headSha); return { posted: true }; },
      },
      arm: () => assert.fail("a requeued head is never armed on its old verdict"),
      close: () => assert.fail("unexpected close"), dispatchFix: () => assert.fail("unexpected fix"),
      escalate: () => assert.fail("unexpected escalation"),
      postReview: (_pr, mode = { kind: "full-review" }) => { reviews.push(mode); },
      ...over,
    };
    await withLiveWritesAllowed(() => runSweep([view], deps, DEFAULT_SWEEP_POLICY));
    return readLedgerLines(ledgerPath).findLast((row) => row.step === "sweep.disposed");
  };
  const requeues = () => readLedgerLines(ledgerPath)
    .filter((row) => row.step === REVIEW_REQUEUED_STEP && row.reason === REVIEWER_CODE_ADVANCED);
  return { pr, posts, reviews, judged, run, requeues };
}

/** A light pass that lost this PR's post-review admission: every other disposition is left to the base predicate. */
const notAdmitting = (d: Disposition) => d !== "post-review";

test("W1-T13704 criterion 1: a pass that does not admit the requeued review posts no pending and leaves the delivered verdict showing", async () => {
  const f = fixture();
  const row = await f.run(f.pr, { actionable: notAdmitting });
  assert.deepEqual(f.posts, [], "no pending is posted over the delivered verdict on a pass that admits no review");
  assert.deepEqual(f.reviews, [], "no review is started");
  assert.equal(f.requeues().length, 1, "the requeue itself is still recorded once");
  assert.equal(row?.disposition, "wait", JSON.stringify(row));
  assert.match(String(row?.reason), /requeue waits for a pass that admits its review/, JSON.stringify(row));
  assert.match(String(row?.reason), /delivered verdict stays showing/, JSON.stringify(row));

  // The next non-admitting pass still posts nothing and writes no second requeue row.
  await f.run(f.pr, { actionable: notAdmitting });
  assert.deepEqual(f.posts, []);
  assert.equal(f.requeues().length, 1);
});

test("W1-T13704 criterion 2: a pass that admits the requeued review posts pending and starts the review in that same pass", async () => {
  const f = fixture();
  await f.run(f.pr, { actionable: notAdmitting });
  assert.deepEqual(f.posts, []);
  // The admitting pass that follows: the requeue row is already written, so it posts pending and reviews now.
  const row = await f.run(f.pr, { actionable: () => true });
  assert.deepEqual(f.posts, [HEAD], "pending is posted on the exact head by the admitting pass");
  assert.deepEqual(f.reviews.map((mode) => mode.kind), ["full-review"], "the review starts in the same pass");
  assert.equal(row?.disposition, "post-review", JSON.stringify(row));
  assert.equal(f.requeues().length, 1);

  // A pass with no admission predicate at all (the full sweep) admits too, from a fresh requeue.
  const g = fixture();
  const full = await g.run(g.pr);
  assert.deepEqual(g.posts, [HEAD]);
  assert.deepEqual(g.reviews.map((mode) => mode.kind), ["full-review"]);
  assert.equal(full?.disposition, "post-review", JSON.stringify(full));
});

test("W1-T13704 criterion 3: the requeue still writes one row per head and reviewer-code sha, and a pending head is admitted without a second post", async () => {
  const f = fixture();
  for (let pass = 0; pass < 3; pass++) await f.run(f.pr, { actionable: notAdmitting });
  assert.equal(f.requeues().length, 1, "repeated non-admitting passes add no requeue row");
  assert.deepEqual(f.judged, [CODE], "the reviewer code is judged once; the row is the dedupe");
  const [requeue] = f.requeues();
  assert.equal(requeue?.requeue_key, `${URL}|${HEAD}|${CODE}`);
  assert.equal(requeue?.judged_reviewer_code_sha, CODE);

  // GitHub already shows pending on this head: the admitting pass admits it with no post (the branch W1-T13704 leaves unchanged).
  const pending = { ...f.pr, reviewState: "pending" as const };
  const admitted = await f.run(pending, { actionable: () => true });
  assert.equal(admitted?.disposition, "post-review", JSON.stringify(admitted));
  assert.deepEqual(f.posts, [], "a head already showing pending gets no second post");
  assert.equal(f.reviews.length, 1);
  assert.equal(f.requeues().length, 1, "one requeue row per head and reviewer-code sha");
});
