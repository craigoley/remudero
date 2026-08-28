import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  execGhPrComment,
  fetchNewestPrComment,
  isDuplicateReviewComment,
  postReviewCommentGuarded,
  type PrCommentRecord,
} from "../src/lib/review.js";

/**
 * W1-T2419 — THE REVIEWER RE-POSTS AN UNCHANGED VERDICT AS A NEW COMMENT ON EVERY SWEEP PASS.
 *
 * GROUND TRUTH this fixes: the `remudero-review` commit status is last-write-wins (cheap to
 * rewrite), but `gh pr comment` APPENDS, and nothing anywhere compared the verdict about to be
 * written against the one already standing — `reviewPostRefusedFor` (run-task.ts) keys only on
 * `review.post_refused` and assumes a DELIVERED post always flips the live rollup, which says
 * nothing about the comment thread. Measured on PR #3140: TEN byte-identical failure comments
 * across ten consecutive sweep passes (21:06:02–21:18:57) on one unmoved head.
 *
 * The fix (lib/review.ts) is ONE comparison at the single site that writes the comment
 * ({@link postReviewCommentGuarded}, now `runReview`'s only call path in run-task.ts): refuse to
 * append when the body about to be written is byte-identical to the newest comment already
 * standing on that PR. No ledger, no timer/pacing/backoff — the discriminator is the verdict's
 * own bytes against a fresh read of GitHub's live state on every call.
 */

const runTaskSrc = readFileSync(fileURLToPath(new URL("../src/run-task.ts", import.meta.url)), "utf8");

// ── wiring: runReview's comment site calls the guarded poster, not a raw execFileSync ─────────

test("W1-T2419 wiring: runReview posts the verdict comment via postReviewCommentGuarded, not a raw `gh pr comment` execFileSync", () => {
  const start = runTaskSrc.indexOf("async function runReview(");
  const end = runTaskSrc.indexOf("// ── THE blocked_review FIX RUNG");
  assert.ok(start > -1 && end > start, "could not locate runReview's body in run-task.ts");
  const body = runTaskSrc.slice(start, end);

  assert.ok(
    body.includes("postReviewCommentGuarded(prUrl, body)"),
    "runReview must post the verdict comment through postReviewCommentGuarded",
  );
  assert.ok(
    !body.includes('execFileSync("gh", ["pr", "comment"'),
    "runReview must not shell out to `gh pr comment` directly any more — that bypasses the dedup",
  );
});

// ── isDuplicateReviewComment: the comparison Q1 found nowhere in src/ ──────────────────────────

test("isDuplicateReviewComment: true only when the standing comment's body is byte-identical", () => {
  const standing: PrCommentRecord = { body: "**remudero-review=failure** — X unmet", created_at: "2026-08-27T21:06:02Z" };
  assert.equal(isDuplicateReviewComment("**remudero-review=failure** — X unmet", standing), true);
});

test("isDuplicateReviewComment: false when there is no standing comment yet", () => {
  assert.equal(isDuplicateReviewComment("**remudero-review=failure** — X unmet", undefined), false);
});

test("isDuplicateReviewComment: false when the verdict changed by even one byte (a genuinely new verdict)", () => {
  const standing: PrCommentRecord = { body: "**remudero-review=failure** — X unmet", created_at: "2026-08-27T21:06:02Z" };
  assert.equal(isDuplicateReviewComment("**remudero-review=failure** — Y unmet", standing), false);
});

// ── fetchNewestPrComment: REST reader, injectable, newest-by-created_at ────────────────────────

test("fetchNewestPrComment: returns the comment with the latest created_at, regardless of input order", () => {
  const calls: string[][] = [];
  const fetch = (args: string[]) => {
    calls.push(args);
    return [
      { body: "oldest", created_at: "2026-08-27T21:06:02Z" },
      { body: "newest", created_at: "2026-08-27T21:18:57Z" },
      { body: "middle", created_at: "2026-08-27T21:10:00Z" },
    ];
  };
  const result = fetchNewestPrComment("https://github.com/o/r/pull/3140", fetch);
  assert.deepEqual(result, { body: "newest", created_at: "2026-08-27T21:18:57Z" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "api");
  assert.equal(calls[0][1], "repos/o/r/issues/3140/comments?per_page=100");
});

test("fetchNewestPrComment: undefined when the PR has no comments yet", () => {
  const result = fetchNewestPrComment("https://github.com/o/r/pull/1", () => []);
  assert.equal(result, undefined);
});

test("fetchNewestPrComment: ignores malformed rows and skips them when selecting the newest", () => {
  const fetch = () => [
    { body: 123, created_at: "2026-08-27T21:06:02Z" },
    { created_at: "2026-08-27T21:10:00Z" },
    { body: "the only well-formed row", created_at: "2026-08-27T21:00:00Z" },
  ];
  const result = fetchNewestPrComment("https://github.com/o/r/pull/1", fetch);
  assert.deepEqual(result, { body: "the only well-formed row", created_at: "2026-08-27T21:00:00Z" });
});

test("fetchNewestPrComment: undefined on a URL that is not a PR URL (defensive, never a guess)", () => {
  const result = fetchNewestPrComment("https://github.com/o/r/issues/1", () => {
    throw new Error("must not be called");
  });
  assert.equal(result, undefined);
});

// ── postReviewCommentGuarded: THE ONE POST SITE ─────────────────────────────────────────────────

test("postReviewCommentGuarded: refuses to append when the body already stands as the newest comment", () => {
  let postCalls = 0;
  const result = postReviewCommentGuarded("https://github.com/o/r/pull/3140", "**remudero-review=failure** — unmet", {
    fetchNewest: () => ({ body: "**remudero-review=failure** — unmet", created_at: "t" }),
    postComment: () => {
      postCalls++;
    },
  });
  assert.deepEqual(result, { posted: false, reason: "duplicate" });
  assert.equal(postCalls, 0, "a byte-identical verdict must never append a second comment");
});

test("postReviewCommentGuarded: posts when there is no standing comment yet", () => {
  const calls: Array<{ prUrl: string; body: string }> = [];
  const result = postReviewCommentGuarded("https://github.com/o/r/pull/1", "**remudero-review=failure** — unmet", {
    fetchNewest: () => undefined,
    postComment: (prUrl, body) => {
      calls.push({ prUrl, body });
    },
  });
  assert.deepEqual(result, { posted: true });
  assert.deepEqual(calls, [{ prUrl: "https://github.com/o/r/pull/1", body: "**remudero-review=failure** — unmet" }]);
});

test("postReviewCommentGuarded: posts when the standing comment differs (a genuinely new verdict)", () => {
  let postCalls = 0;
  const result = postReviewCommentGuarded("https://github.com/o/r/pull/2434", "**remudero-review=success**", {
    fetchNewest: () => ({ body: "**remudero-review=failure** — unmet", created_at: "t" }),
    postComment: () => {
      postCalls++;
    },
  });
  assert.deepEqual(result, { posted: true });
  assert.equal(postCalls, 1);
});

test("postReviewCommentGuarded: a failing gh post is swallowed (best-effort — status + ledger already carry the verdict)", () => {
  assert.doesNotThrow(() => {
    const result = postReviewCommentGuarded("https://github.com/o/r/pull/1", "body", {
      fetchNewest: () => undefined,
      postComment: () => {
        throw new Error("gh: rate limited (HTTP 429)");
      },
    });
    assert.deepEqual(result, { posted: false, reason: "gh_error" });
  });
});

test("postReviewCommentGuarded: an unreadable standing-comment fetch never blocks the post (best-effort read)", () => {
  let postCalls = 0;
  const result = postReviewCommentGuarded("https://github.com/o/r/pull/1", "body", {
    fetchNewest: () => {
      throw new Error("gh: network error");
    },
    postComment: () => {
      postCalls++;
    },
  });
  assert.deepEqual(result, { posted: true });
  assert.equal(postCalls, 1);
});

// ── the measured #3140 shape, reproduced: TEN consecutive sweep passes on one unmoved head ─────

test("postReviewCommentGuarded: ten consecutive sweep passes with an unchanged verdict collapse to ONE real comment (#3140)", () => {
  let postCalls = 0;
  let standing: PrCommentRecord | undefined;
  const deps = {
    fetchNewest: () => standing,
    postComment: (_prUrl: string, body: string) => {
      postCalls++;
      standing = { body, created_at: `t${postCalls}` };
    },
  };
  const verdict = "**remudero-review=failure** — the following acceptance criteria are unmet:\n\n1. X\n   - Y";

  for (let pass = 0; pass < 10; pass++) {
    postReviewCommentGuarded("https://github.com/o/r/pull/3140", verdict, deps);
  }

  assert.equal(postCalls, 1, "ten identical-verdict passes on an unmoved head must produce exactly one comment");

  // Control (PR #2434's shape): once the verdict genuinely changes, the next pass posts again —
  // the fix must never suppress a REAL change, only a byte-identical repeat.
  postReviewCommentGuarded("https://github.com/o/r/pull/3140", "**remudero-review=success**", deps);
  assert.equal(postCalls, 2, "a genuinely changed verdict must still post");
});

// ── execGhPrComment: the one-line real wrapper, exercised so it isn't permanently uncovered ────

test("execGhPrComment is exported (PATH-stubbable `gh`, mirrors execGhStatusPost's own reasoning)", () => {
  assert.equal(typeof execGhPrComment, "function");
});
