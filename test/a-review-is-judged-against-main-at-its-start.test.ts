import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { Config } from "#src/lib/config.js";
import { ledgerPathFor } from "#src/lib/ledger-path.js";
import { postReviewStatusGuarded } from "#src/lib/review.js";
import type { ReviewerCodeFreshness } from "#src/lib/self-sync.js";
import { readLedgerLines } from "#src/lib/status.js";
import { buildReviewerCodeFreshnessGate, reviewCommand, type ReviewRunResult } from "#src/run-task.js";

/**
 * JUDGE AT REVIEW START — operator ruling 2026-10-06.
 *
 * The publication guard (W1-T3337) re-read reviewer-code freshness just before posting, so a
 * review-path merge landing DURING a review withheld a verdict judged by code that was current when
 * the review began. Measured on the fleet host, 2026-09-30..10-06: 35 of 51 "materially behind"
 * withholds were fresh or immaterially behind at review start. The gate's start reading now
 * decides publication; code already materially behind at start still withholds (W1-T3337's own
 * failure case); an unreadable start reading keeps the just-in-time read, and is ledgered.
 */

const OLD = "a".repeat(40);
const MAIN_AT_START = "b".repeat(40);
const MAIN_AFTER_MERGE = "c".repeat(40);
const REPO_ROOT = process.cwd();

const FRESH_AT_START: ReviewerCodeFreshness = {
  status: "fresh", codeSha: MAIN_AT_START, originMainSha: MAIN_AT_START, advance: "none",
};
const STALE_AT_START: ReviewerCodeFreshness = {
  status: "stale", codeSha: OLD, originMainSha: MAIN_AT_START, changedPaths: ["src/lib/review.ts"],
};
const UNREADABLE_AT_START: ReviewerCodeFreshness = {
  status: "unreadable", reason: "git fetch origin failed: exceeded its 60000ms bound",
};
const MERGED_DURING_REVIEW: ReviewerCodeFreshness = {
  status: "stale", codeSha: MAIN_AT_START, originMainSha: MAIN_AFTER_MERGE, changedPaths: ["src/lib/review.ts"],
};

function successResult(head: string, verdictWithheld?: string): ReviewRunResult {
  return {
    state: "success",
    criteria: [{ claim: "the fixture holds", proof: "proof", met: true, reason: "", proof_exec: "not_executable" }],
    testTheater: false,
    summary: "fixture success",
    floorDegraded: false,
    capped: false,
    keywordOnly: false,
    planOnly: false,
    headSha: head,
    reviewerOutcome: "success",
    ...(verdictWithheld === undefined ? {} : { verdictWithheld }),
  };
}

/** Drive `rmd review` with a fake reviewer that posts through the REAL W1-T228 guard. */
async function reviewWith(
  start: ReviewerCodeFreshness | undefined,
  justInTime: ReviewerCodeFreshness | (() => ReviewerCodeFreshness),
  onReview: () => void = () => {},
  extraArgs: string[] = [],
) {
  const root = mkdtempSync(join(tmpdir(), "rmd-judge-at-start-"));
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  const posts: string[] = [];
  let justInTimeReads = 0;
  const originalLog = console.log;
  console.log = () => {};
  try {
    const code = await reviewCommand("6011", ["--repo", "acme/remudero", ...extraArgs], {
      fetchView: () => ({
        number: 6011,
        html_url: "https://github.com/acme/remudero/pull/6011",
        head: { ref: "fixture", sha: head },
        updated_at: new Date(0).toISOString(),
        body: "## Acceptance\n- the fixture holds | manual fixture",
      }),
      loadConfig: () => ({ root, claudeBin: "/bin/true" }) as Config,
      fetchHead: () => {},
      materialize: () => ({ worktreePath: undefined, failure: { errorClass: "other", message: "not needed" } }),
      postReviewPending: async () => ({ posted: false }),
      reviewerCodeFreshness: () => {
        justInTimeReads++;
        return typeof justInTime === "function" ? justInTime() : justInTime;
      },
      ...(start === undefined ? {} : { reviewStartFreshness: start }),
      runReview: async (args) => {
        onReview();
        const posted = await postReviewStatusGuarded({
          owner: "acme",
          repo: "remudero",
          sha: head,
          state: "success",
          taskId: "PR-6011",
          evidence: "no_evidence",
          ledgerPath: args.ledgerPath!,
          runId: args.runId!,
          reviewerCodeFreshness: await args.reviewerCodeFreshness!(),
          fetchLifecycle: () => ({ merged: false, closed: false }),
          post: (o) => {
            posts.push(o.state);
          },
        });
        return successResult(head, posted.posted ? undefined : posted.reason);
      },
    });
    const rows = readLedgerLines(ledgerPathFor({ root } as Config));
    return { code, posts, justInTimeReads, rows };
  } finally {
    console.log = originalLog;
    rmSync(root, { recursive: true, force: true });
  }
}

test("judge at review start: a review fresh at its start publishes although main materially advanced during it", async () => {
  const { code, posts, justInTimeReads } = await reviewWith(FRESH_AT_START, MERGED_DURING_REVIEW);
  assert.deepEqual(posts, ["success"], "the verdict judged by code fresh at start is published");
  assert.equal(code, 0);
  assert.equal(justInTimeReads, 0, "the mid-review advance is not re-read at post time");
});

test("judge at review start: a review whose code was materially behind at its start is still withheld", async () => {
  const fresh: ReviewerCodeFreshness = { status: "fresh", codeSha: OLD, originMainSha: OLD, advance: "none" };
  const { code, posts, justInTimeReads, rows } = await reviewWith(STALE_AT_START, fresh);
  assert.deepEqual(posts, [], "W1-T3337: code stale when it judged never publishes");
  assert.equal(code, 2);
  assert.equal(justInTimeReads, 0);
  const refused = rows.find((row) => row.step === "review.post_refused");
  assert.equal(refused?.reviewer_code_freshness, "stale");
  assert.equal(refused?.origin_main_sha, MAIN_AT_START, "the refusal names main as of the review start");
});

test("judge at review start: an unreadable start reading is ledgered and falls back to the just-in-time read", async () => {
  const { code, posts, justInTimeReads, rows } = await reviewWith(UNREADABLE_AT_START, MERGED_DURING_REVIEW);
  assert.equal(justInTimeReads, 1, "today's just-in-time read decides");
  assert.deepEqual(posts, []);
  assert.equal(code, 2);
  const row = rows.find((r) => r.step === "review.reviewer_freshness_unreadable_at_start");
  assert.ok(row, "the unreadable pre-review reading leaves a ledger row");
  assert.equal(row.reason, UNREADABLE_AT_START.reason);
  assert.equal(row.pr_url, "https://github.com/acme/remudero/pull/6011");
});

test("judge at review start: with no start reading the just-in-time read still decides", async () => {
  const { code, posts, justInTimeReads, rows } = await reviewWith(undefined, FRESH_AT_START);
  assert.deepEqual(posts, ["success"]);
  assert.equal(code, 0);
  assert.equal(justInTimeReads, 1);
  assert.equal(rows.some((r) => r.step === "review.reviewer_freshness_unreadable_at_start"), false);
});

test("judge at review start: the freshness gate hands its start reading to the review it admits", async () => {
  const handed: Array<ReviewerCodeFreshness | undefined> = [];
  const readings = [FRESH_AT_START, UNREADABLE_AT_START];
  const gate = buildReviewerCodeFreshnessGate(
    () => readings.shift()!,
    () => {},
    async (_pr, _rest, deps) => {
      handed.push(deps.reviewStartFreshness);
      return 0;
    },
  );
  await gate.call("6011", [], { executionMode: "semantic" });
  await gate.call("6012", [], {});
  assert.deepEqual(handed, [FRESH_AT_START, UNREADABLE_AT_START]);
});

test("judge at review start: a PR closed before its review starts leaves a ledger row naming the decline", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-closed-decline-"));
  try {
    const code = await reviewCommand("8303", ["--repo", "acme/remudero"], {
      resolveOwnerRepo: () => ({ owner: "acme", repo: "remudero" }),
      fetchView: () => ({
        state: "closed",
        number: 8303,
        html_url: "https://github.com/acme/remudero/pull/8303",
        head: { ref: "topic", sha: "d".repeat(40) },
        merged_at: "2026-10-06T14:00:00Z",
      }),
      loadConfig: () => ({ root, claudeBin: "/bin/true" }) as Config,
      fetchHead: () => {
        throw new Error("closed PR must not fetch its old head");
      },
    });
    assert.equal(code, 2);
    const row = readLedgerLines(ledgerPathFor({ root } as Config)).find(
      (r) => r.step === "review.skipped_closed_before_review",
    );
    assert.ok(row, "the closed-PR decline is ledgered");
    assert.equal(row.pr_url, "https://github.com/acme/remudero/pull/8303");
    assert.equal(row.head_sha, "d".repeat(40));
    assert.equal(row.merged, true);
    assert.equal(row.task_id, "PR-8303");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** W1-T9727 — a fresh-tree child is handed no start reading; the gate asks it to take its own. Its reader answers
 *  `before` until the fake reviewer starts and `during` after: main moves DURING the review, as it does across a
 *  memory-admission wait on the fleet. */
async function freshTreeReview(before: () => ReviewerCodeFreshness, during: ReviewerCodeFreshness) {
  let reviewing = false;
  return reviewWith(undefined, () => (reviewing ? during : before()), () => {
    reviewing = true;
  }, ["--judge-at-own-start"]);
}

test("W1-T9727: a fresh-tree review is judged against main at its own start", async () => {
  const { code, posts, justInTimeReads } = await freshTreeReview(() => FRESH_AT_START, MERGED_DURING_REVIEW);
  assert.deepEqual(posts, ["success"], "fresh when it began, so main's advance during the review never withholds it");
  assert.equal(code, 0);
  assert.equal(justInTimeReads, 1, "one reading, taken before the reviewer ran");
});

test("W1-T9727: a fresh-tree review whose own start reading is stale is still withheld", async () => {
  const fresh: ReviewerCodeFreshness = { status: "fresh", codeSha: MAIN_AT_START, originMainSha: MAIN_AT_START, advance: "none" };
  const { code, posts, rows } = await freshTreeReview(() => STALE_AT_START, fresh);
  assert.deepEqual(posts, [], "W1-T3337: code stale when it judged never publishes");
  assert.equal(code, 2);
  const refused = rows.find((row) => row.step === "review.post_refused");
  assert.equal(refused?.origin_main_sha, MAIN_AT_START, "the refusal names main as of the review start");
});

test("W1-T9727: a thrown own start reading is unreadable and the just-in-time read decides", async () => {
  const { code, posts, rows, justInTimeReads } = await freshTreeReview(() => {
    throw new Error("git fetch origin failed: exit 128");
  }, MERGED_DURING_REVIEW);
  const row = rows.find((r) => r.step === "review.reviewer_freshness_unreadable_at_start");
  assert.ok(row, "the unreadable own start reading leaves a ledger row");
  assert.match(String(row.reason), /git fetch origin failed: exit 128/);
  assert.equal(justInTimeReads, 2, "the just-in-time read follows the unreadable start reading");
  assert.deepEqual(posts, [], "the just-in-time read saw main materially ahead");
  assert.equal(code, 2);
});

test("W1-T9727: the freshness gate asks a fresh-tree review to judge at its own start", async () => {
  const handed: string[][] = [];
  const gate = buildReviewerCodeFreshnessGate(
    () => STALE_AT_START,
    () => {},
    async () => {
      throw new Error("a stale reading never reaches the in-process review");
    },
    async (_pr, rest) => {
      handed.push(rest);
      return 0;
    },
  );
  assert.equal(await gate.call("6011", ["--repo", "acme/remudero"], {}), 0);
  assert.equal(handed.length, 1);
  assert.ok(handed[0]!.includes("--judge-at-own-start"), `fresh-tree args ${JSON.stringify(handed[0])}`);
});
