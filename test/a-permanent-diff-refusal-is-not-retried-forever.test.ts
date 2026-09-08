import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_SWEEP_POLICY,
  POST_REVIEW_ATTEMPT_CAP,
  POST_REVIEW_PERMANENT_DIFF_RE,
  deriveDisposition,
  detectPostReviewStall,
  postReviewExhaustedReason,
  postReviewIsExhausted,
  postReviewRefusalAtHead,
  type OpenPrView,
} from "../src/lib/sweep.js";

// W1-T3130 — a PERMANENT `gh pr diff` refusal was retried 143 times on PR #4510 over three days,
// ~2.5 min apart. The error is verbatim from that incident.

const REAL_406 =
  "Command failed: gh pr diff https://github.com/craigoley/remudero/pull/4510\n" +
  "could not find pull request diff: HTTP 406: Sorry, the diff exceeded the maximum number of " +
  "files (300). Consider using 'List pull requests files' API or locally cloning the repository instead.";

const failed = (pr: number, sha: string, error: string) =>
  ({ step: "sweep.post_review.failed", pr_number: pr, head_sha: sha, error }) as Record<string, unknown>;
const done = (pr: number, sha: string) =>
  ({ step: "sweep.post_review.done", pr_number: pr, head_sha: sha }) as Record<string, unknown>;

const view = (over: Partial<OpenPrView> = {}): OpenPrView =>
  ({
    prNumber: 4510, prUrl: "u", reviewState: "pending", checksState: "green", unmetCriteria: [],
    priorStrikes: 0, strikeHistory: [], lastActivityAt: new Date().toISOString(), headSha: "be612fd",
    autoMergeArmed: false, isDependabot: false, criteriaRecoverable: false,
    reviewPendingOwnerDead: true, ...over,
  }) as unknown as OpenPrView;

// ── the classifier ────────────────────────────────────────────────────────────────────────────

test("W1-T3130: the real #4510 error is recognised as permanent, and a transient one is not", () => {
  // LITERAL both-arm fixtures: the negative-reachability census reads the arguments, and a
  // const-bound one hides the arm from a static scan (the CONVENTIONAL_TITLE_PREFIX_RE precedent).
  assert.equal(POST_REVIEW_PERMANENT_DIFF_RE.test("HTTP 406: Sorry, the diff exceeded the maximum number of files (300)."), true);
  assert.equal(POST_REVIEW_PERMANENT_DIFF_RE.test("HTTP 502 Bad Gateway"), false);
  assert.equal(POST_REVIEW_PERMANENT_DIFF_RE.test("API rate limit exceeded"), false);
  assert.equal(POST_REVIEW_PERMANENT_DIFF_RE.test(REAL_406), true, "and the real incident text");
  // MATCHED ON THE STABLE HALF: a different PR's 406 is the same permanent condition.
  assert.equal(POST_REVIEW_PERMANENT_DIFF_RE.test(REAL_406.replace(/4510/g, "9999")), true);
});

test("W1-T3130: a permanent refusal at this head disposes to a terminal state naming ceiling and remedy", () => {
  const lines = [failed(4510, "be612fd", REAL_406)];
  const pr = view({ postReviewRefusal: postReviewRefusalAtHead(lines, 4510, "be612fd") });
  assert.equal(postReviewIsExhausted(pr), true, "one permanent refusal is enough — retrying cannot help");
  const d = deriveDisposition(pr, DEFAULT_SWEEP_POLICY, Date.now());
  assert.notEqual(d.disposition, "post-review", "THE LOOP: this is the arm that fired 143 times");
  assert.equal(d.disposition, "blocked-ambiguous", "escalated, never silent");
  assert.match(d.reason, /300-file ceiling/);
  assert.match(d.reason, /Split it into PRs of at most 300 files/, "the remedy, not just the cause");
});

test("W1-T3130: an UNRECOGNISED throw is bounded by the attempt cap, so classification need not be exhaustive", () => {
  const under = Array.from({ length: POST_REVIEW_ATTEMPT_CAP - 1 }, () => failed(4510, "be612fd", "HTTP 502"));
  assert.equal(postReviewIsExhausted(view({ postReviewRefusal: postReviewRefusalAtHead(under, 4510, "be612fd") })), false);
  const at = Array.from({ length: POST_REVIEW_ATTEMPT_CAP }, () => failed(4510, "be612fd", "HTTP 502"));
  const pr = view({ postReviewRefusal: postReviewRefusalAtHead(at, 4510, "be612fd") });
  assert.equal(postReviewIsExhausted(pr), true);
  assert.match(postReviewExhaustedReason(pr), /consecutive failures at this head/);
  assert.match(postReviewExhaustedReason(pr), /a new push resets it/);
});

test("W1-T3130: a transient failure BELOW the cap still re-dispatches — a recoverable PR is not frozen", () => {
  const lines = [failed(4510, "be612fd", "HTTP 502 Bad Gateway")];
  const pr = view({ postReviewRefusal: postReviewRefusalAtHead(lines, 4510, "be612fd") });
  assert.equal(postReviewIsExhausted(pr), false);
  assert.equal(deriveDisposition(pr, DEFAULT_SWEEP_POLICY, Date.now()).disposition, "post-review");
});

// ── head-keying, which is what makes a fix retryable ───────────────────────────────────────────

test("W1-T3130: a new head resets both the permanent mark and the count", () => {
  const lines = [failed(4510, "old", REAL_406), failed(4510, "old", REAL_406), failed(4510, "old", REAL_406)];
  assert.equal(postReviewRefusalAtHead(lines, 4510, "old").attempts, 3);
  const fresh = postReviewRefusalAtHead(lines, 4510, "SPLIT-abc");
  assert.equal(fresh.attempts, 0, "the split PR is a new head and gets a clean start");
  assert.equal(fresh.permanentReason, undefined);
  assert.equal(postReviewIsExhausted(view({ headSha: "SPLIT-abc", postReviewRefusal: fresh })), false);
});

test("W1-T3130: a `.done` at the same head resets the run, so a recovered PR is not held against itself", () => {
  const lines = [failed(4510, "h", "HTTP 502"), failed(4510, "h", "HTTP 502"), done(4510, "h"), failed(4510, "h", "HTTP 502")];
  assert.equal(postReviewRefusalAtHead(lines, 4510, "h").attempts, 1);
});

// ── the reason detectPostReviewStall did not catch this ───────────────────────────────────────

test("W1-T3130: the count is PER-PR, where detectPostReviewStall's global run is masked by other PRs", () => {
  // THE MEASURED SHAPE: over 2026-09-05..09-08 the corpus held 11 `.failed` against 230 `.done`
  // and ZERO stall rows, while #4510 was re-dispatched 143 times. Any other PR's success resets a
  // global run, so one permanently-stuck PR is arithmetically invisible to it.
  const interleaved: Record<string, unknown>[] = [];
  for (let i = 0; i < 20; i++) {
    interleaved.push(failed(4510, "be612fd", REAL_406));
    interleaved.push(done(9999, "other")); // a DIFFERENT pr succeeding
  }
  const global = detectPostReviewStall(interleaved);
  assert.equal(global.stalled, false, "the shipped detector reads this as healthy — reproduced, not asserted from memory");
  assert.equal(global.consecutiveFailures, 0, "the last row was another PR's success, so the run is empty");

  const mine = postReviewRefusalAtHead(interleaved, 4510, "be612fd");
  assert.equal(mine.attempts, 20, "keyed per-PR, the same corpus shows twenty failures");
  assert.ok(mine.permanentReason !== undefined);
});

// ── the field is optional and absence is never "blocked" ───────────────────────────────────────

test("W1-T3130: an absent refusal reads as no attempts, never as blocked", () => {
  assert.equal(postReviewIsExhausted(view({ postReviewRefusal: undefined })), false);
  assert.equal(deriveDisposition(view(), DEFAULT_SWEEP_POLICY, Date.now()).disposition, "post-review");
  // An undated head cannot be keyed, so it counts nothing rather than guessing.
  assert.equal(postReviewRefusalAtHead([failed(4510, "h", REAL_406)], 4510, undefined).attempts, 0);
});

test("W1-T3130: the terminal row is ordered BEFORE the post-review row — the order IS the mechanism", () => {
  // There is no second guard on the post-review arm: one was written and deleted because no test
  // could distinguish it from dead code. So the ORDER is what stops the loop, and a reorder would
  // silently restore it. This asserts the property directly, on the real table.
  const exhausted = view({ postReviewRefusal: { attempts: 99, permanentReason: "x" } });
  assert.equal(deriveDisposition(exhausted, DEFAULT_SWEEP_POLICY, Date.now()).disposition, "blocked-ambiguous");
  // ...and the SAME view with the refusal cleared reaches post-review, so the row above is the
  // discriminator and not some unrelated term.
  const clean = view({ postReviewRefusal: undefined });
  assert.equal(deriveDisposition(clean, DEFAULT_SWEEP_POLICY, Date.now()).disposition, "post-review");
});
