import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readLedgerLines } from "#src/lib/status.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { reviewerCodeJudge } from "#src/lib/self-sync.js";
import {
  REVIEWER_TOKEN_ENV,
  claimReviewDecision,
  postReviewCommentGuarded,
  postReviewPending,
  postReviewStatusGuarded,
  reviewDescriptionWithCodeProvenance,
  reviewInputDigest,
  reviewOutboxDir,
  reviewOutboxEntryPath,
  type PostReviewStatusGuardedOpts,
  type PrLifecycleState,
  type ReviewVerdict,
} from "#src/lib/review.js";

/** W1-T11928. OBSERVED 2026-11-09 22:49Z: run review-PR17494-1794264570958 computed a PASS for head f38aea2263e8 and
 *  then logged review.post_failed, the process holding no GitHub credential. The fixtures mirror that review: one
 *  computed PASS, a post that throws, and the pass that follows it. */

const TASK = "W1-T17494";
const PR_URL = "https://github.com/o/r/pull/17494";
const HEAD = `f38aea2263e8${"0".repeat(28)}`;
const MOVED_HEAD = `0b5e1d9a77c4${"1".repeat(28)}`;
const BODY = "## Acceptance\n- the PASS survives a failed post";
const INPUT = reviewInputDigest(HEAD, BODY);
const DECISION = `sha256:${"d".repeat(64)}`;
const DESCRIPTION = "remudero-review: PASS - 3 criteria substantiated, no test theater";
const COMMENT = `**remudero-review=success** — ${DESCRIPTION}`;
const SECRET = "ghs_W1T11928doNotWriteThisToDisk";
// W1-T11847: the verdict names the full sha of the reviewer code that judged it, and the drain posts it only while
// that code is still current at origin/main (here origin/main is that code).
const CODE = "c".repeat(40);
const POSTED = reviewDescriptionWithCodeProvenance(DESCRIPTION, CODE);
const CURRENT = reviewerCodeJudge(() => ({ status: "fresh", codeSha: CODE, originMainSha: CODE, advance: "none" }), "/unused");

const VERDICT: ReviewVerdict = {
  state: "success",
  criteria: [1, 2, 3].map((n) => ({
    claim: `criterion ${n}`, proof: `grep: criterion ${n} in test/x.test.ts`, met: true, reason: "substantiated",
    proof_exec: "executed_pass" as const,
  })),
  testTheater: false, summary: DESCRIPTION, floorDegraded: false, capped: false, keywordOnly: false, planOnly: false,
};

type Post = { owner: string; repo: string; sha: string; state: string; description?: string };

function fixture(name: string) {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}${name}-`));
  const ledgerPath = join(dir, "ledger.ndjson");
  const posts: Post[] = [];
  const lifecycle = (sha: string): PrLifecycleState => ({ merged: false, closed: false, reviewInputDigest: reviewInputDigest(sha, BODY) });
  const terminal = (post: PostReviewStatusGuardedOpts["post"]): PostReviewStatusGuardedOpts => ({
    owner: "o", repo: "r", sha: HEAD, state: "success", description: DESCRIPTION, verdict: VERDICT, taskId: TASK,
    evidence: "executed", ledgerPath, runId: "review-PR17494-1794264570958", prUrl: PR_URL, reviewInputDigest: INPUT,
    reviewDecisionDigest: DECISION,
    reviewerCodeFreshness: { status: "fresh", codeSha: CODE, originMainSha: CODE, advance: "none" },
    readReviewStatusHistory: async () => ({ kind: "readable", failures: [] }),
    fetchLifecycle: () => lifecycle(HEAD), post,
  });
  const failThePost = () => postReviewStatusGuarded(terminal(() => {
    throw new Error(`gh: no credential in this process (GH_TOKEN=${SECRET})`);
  }));
  const record = (o: Post): void => { posts.push({ ...o }); };
  const steps = (step: string) => readLedgerLines(ledgerPath).filter((line) => line.step === step);
  const entries = () => (existsSync(reviewOutboxDir(ledgerPath)) ? readdirSync(reviewOutboxDir(ledgerPath)) : []);
  return { dir, ledgerPath, posts, lifecycle, terminal, failThePost, record, steps, entries };
}

test("W1-T11928 criterion 1: a verdict whose post failed is in an outbox entry when the call returns, and the entry holds no credential", async () => {
  const f = fixture("outbox-write");
  const saved = { reviewer: process.env[REVIEWER_TOKEN_ENV], gh: process.env.GH_TOKEN };
  process.env[REVIEWER_TOKEN_ENV] = SECRET;
  process.env.GH_TOKEN = SECRET;
  try {
    const result = await f.failThePost();
    assert.equal(result.posted, false);

    const path = reviewOutboxEntryPath(f.ledgerPath, PR_URL, INPUT);
    assert.deepEqual(f.entries().map((name) => join(reviewOutboxDir(f.ledgerPath), name)), [path], "one entry, and no staging file left beside it");
    const raw = readFileSync(path, "utf8");
    const entry = JSON.parse(raw) as Record<string, unknown>;
    assert.equal(entry.state, "success");
    assert.equal(entry.description, POSTED);
    assert.equal(entry.reviewer_code_sha, CODE);
    assert.equal(entry.head_sha, HEAD);
    assert.equal(entry.input_key, INPUT);
    assert.equal(entry.comment_body, COMMENT);

    // The thrown error and both token variables carried the secret; the entry is a fixed list of verdict fields.
    assert.equal(raw.includes(SECRET), false, "no credential reaches the outbox");
    assert.deepEqual(Object.keys(entry).sort(), [
      "comment_body", "decision_verdict", "description", "evidence", "head_sha", "input_key", "owner", "pr_url", "repo",
      "review_decision_digest", "reviewer_code_sha", "run_id", "state", "task_id", "version", "written_at",
    ]);
    assert.equal(f.steps("review.post_failed")[0]?.outboxed, true, "the failure row says the verdict was kept");
  } finally {
    if (saved.reviewer === undefined) delete process.env[REVIEWER_TOKEN_ENV]; else process.env[REVIEWER_TOKEN_ENV] = saved.reviewer;
    if (saved.gh === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = saved.gh;
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("W1-T11928 criterion 2: the next pass for that input posts the outbox verdict, removes the entry, and admits no reviewer", async () => {
  const f = fixture("outbox-drain");
  try {
    await f.failThePost();
    assert.equal(f.entries().length, 1);

    const comments: Array<{ url: string; body: string }> = [];
    const pending = await postReviewPending({
      owner: "o", repo: "r", sha: HEAD, taskId: TASK, runId: "review-next-pass", ledgerPath: f.ledgerPath, prUrl: PR_URL,
      reviewInputDigest: INPUT, fetchLifecycle: () => f.lifecycle(HEAD), post: f.record,
      readReviewStatusHistory: async () => ({ kind: "readable", failures: [] }),
      commentDeps: { fetchNewestReview: () => undefined, postReview: (url, body) => { comments.push({ url, body }); } },
      fetchStatus: () => { throw new Error("a pass that posts the outbox verdict reads no pending claim"); },
      judgeReviewerCode: CURRENT,
    });

    assert.equal(pending.outbox, "posted");
    assert.deepEqual(f.posts, [{ owner: "o", repo: "r", sha: HEAD, state: "success", description: POSTED }],
      "the stored verdict is the only status posted: no pending claim precedes it");
    assert.deepEqual(comments, [{ url: PR_URL, body: COMMENT }]);
    assert.deepEqual(f.entries(), [], "a posted entry is removed");
    assert.equal(f.steps("review.pending_posted").length, 0);
    assert.equal(f.steps("review.outbox_posted")[0]?.outbox_run_id, "review-PR17494-1794264570958");

    // claimReviewDecision is the reviewer's admission: only `owned` starts one.
    const claim = await claimReviewDecision({ ledgerPath: f.ledgerPath, taskId: TASK, prUrl: PR_URL, digest: DECISION });
    if (claim.kind === "owned") claim.release();
    assert.equal(claim.kind, "replay", "the posted verdict is the decision's terminal, so no reviewer is admitted");
    assert.equal(claim.kind === "replay" && claim.terminal.verdict.summary, DESCRIPTION);
    assert.equal(claim.kind === "replay" && claim.terminal.state, "success");
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("W1-T11928 criterion 2: the entry builds its comment from the verdict the review passes, and the next pass posts that comment", async () => {
  const f = fixture("outbox-comment");
  try {
    // The review passes its verdict and no comment text: it builds its own comment only after a post that succeeds.
    const summary = "remudero-review: FAIL - 1 of 3 criteria unmet";
    const failed: ReviewVerdict = {
      ...VERDICT, state: "failure", summary,
      criteria: VERDICT.criteria.map((c, i) => (i === 1
        ? { ...c, met: false, reason: "the proof ran and failed", proof_exec: "executed_fail" as const, failureTail: "not ok 1 <drain>" }
        : c)),
    };
    const result = await postReviewStatusGuarded({
      ...f.terminal(() => { throw new Error("gh: no credential in this process"); }),
      state: "failure", description: summary, verdict: failed,
    });
    assert.equal(result.posted, false);
    const entry = JSON.parse(readFileSync(reviewOutboxEntryPath(f.ledgerPath, PR_URL, INPUT), "utf8")) as Record<string, unknown>;
    const body = String(entry.comment_body);
    assert.match(body, /^\*\*remudero-review=failure\*\* — the following acceptance criterion is unmet:/);
    assert.match(body, /1\. criterion 2\n {3}- the proof ran and failed/);
    assert.match(body, /<pre>not ok 1 &lt;drain&gt;<\/pre>/, "the proof output is escaped as the review escapes it");
    assert.equal(body.includes("criterion 1") || body.includes("criterion 3"), false, "a met criterion is not listed");

    const comments: Array<{ url: string; body: string }> = [];
    const pending = await postReviewPending({
      owner: "o", repo: "r", sha: HEAD, taskId: TASK, runId: "review-next-pass", ledgerPath: f.ledgerPath, prUrl: PR_URL,
      reviewInputDigest: INPUT, fetchLifecycle: () => f.lifecycle(HEAD), post: f.record,
      readReviewStatusHistory: async () => ({ kind: "readable", failures: [] }),
      commentDeps: { fetchNewestReview: () => undefined, postReview: (url, text) => { comments.push({ url, body: text }); } },
      fetchStatus: () => { throw new Error("a pass that posts the outbox verdict reads no pending claim"); },
      judgeReviewerCode: CURRENT,
    });

    assert.equal(pending.outbox, "posted");
    assert.deepEqual(f.posts.map((post) => [post.sha, post.state]), [[HEAD, "failure"]]);
    assert.deepEqual(comments, [{ url: PR_URL, body }], "the next pass posts the comment the entry carried");
    assert.equal(f.steps("review.outbox_posted")[0]?.comment, "posted");
    assert.deepEqual(f.entries(), []);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("W1-T11928 criterion 2: an outbox verdict whose head has moved is never posted and is discarded with a ledger row", async () => {
  const f = fixture("outbox-stale");
  try {
    await f.failThePost();
    const pending = await postReviewPending({
      owner: "o", repo: "r", sha: MOVED_HEAD, taskId: TASK, runId: "review-moved-head", ledgerPath: f.ledgerPath,
      prUrl: PR_URL, reviewInputDigest: reviewInputDigest(MOVED_HEAD, BODY), fetchLifecycle: () => f.lifecycle(MOVED_HEAD),
      post: f.record, fetchStatus: () => ({ statuses: [] }),
    });

    assert.equal(pending.outbox, undefined);
    assert.deepEqual(f.posts.filter((post) => post.sha === HEAD), [], "nothing is posted on the head the PR left");
    assert.deepEqual(f.posts.map((post) => [post.sha, post.state]), [[MOVED_HEAD, "pending"]], "the pass goes on to review the new head");
    assert.deepEqual(f.entries(), []);
    const discarded = f.steps("review.outbox_discarded");
    assert.equal(discarded.length, 1);
    assert.equal(discarded[0]?.head_sha, HEAD);
    assert.equal(discarded[0]?.current_head_sha, MOVED_HEAD);
    assert.match(String(discarded[0]?.reason), /head moved/);
    assert.equal(f.steps("review.posted").length, 0, "a discarded verdict is no terminal");
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("W1-T11928 criterion 3: a review whose post succeeds writes no outbox entry and posts the same status and comment", async () => {
  const f = fixture("outbox-success");
  try {
    const result = await postReviewStatusGuarded(f.terminal(f.record));
    assert.equal(result.posted, true);
    assert.equal(existsSync(reviewOutboxDir(f.ledgerPath)), false, "a successful post leaves no outbox behind");
    assert.equal(f.steps("review.post_failed").length, 0);

    // The same review for a second task: the status carries the caller's fields and nothing from the outbox.
    assert.equal((await postReviewStatusGuarded({ ...f.terminal(f.record), taskId: "W1-T17494-second" })).posted, true);
    const expected = { owner: "o", repo: "r", sha: HEAD, state: "success", description: POSTED };
    assert.deepEqual(f.posts, [expected, expected], "the status posted holds no outbox field");

    const comments: Array<{ url: string; body: string }> = [];
    const comment = postReviewCommentGuarded(PR_URL, COMMENT, {
      fetchNewestReview: () => undefined, postReview: (url, body) => { comments.push({ url, body }); },
    });
    assert.deepEqual(comment, { posted: true });
    assert.deepEqual(comments, [{ url: PR_URL, body: COMMENT }]);
    assert.equal(existsSync(reviewOutboxDir(f.ledgerPath)), false);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});
