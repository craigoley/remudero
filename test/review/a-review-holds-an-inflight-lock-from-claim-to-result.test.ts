// W1-T14947 — `rmd review` holds one in-flight lock under state/inflight/reviews from before its pending post until after
// its terminal row, so a container recycle's drain can see it; the lock is never a task run (invariant one-lock-per-review).
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import * as reviewCommand from "#src/cli/commands/review.js";
import { liveInflightRuns } from "#src/lib/report-commands.js";
import { ghShim } from "#test/helpers/gh-shim.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const { REVIEW_INFLIGHT_DIR } = reviewCommand;

function fixtureHost(head: string): reviewCommand.ReviewCommandHost {
  const unrelated = (): never => { throw new Error("unexpected unrelated orchestration port"); };
  return {
    GIT_UNTRACKED_FILES_ALL: "--untracked-files=all", JUDGE_AT_OWN_START_FLAG: "--judge-at-own-start",
    acceptedReviewAttemptId: (value) => typeof value === "string" ? value : undefined, attributeWorkerStreamEvent: unrelated,
    ledgeredNonDispatchSpawn: unrelated, lintPlanForReview: unrelated, liveWorkerRunIds: new Set(), materializeReviewWorktree: unrelated,
    readHeadShaRest: () => head, readMainPlanTreeSha: unrelated,
    realDeps: () => ({ reviewWorktree: { fetch: unrelated } }) as unknown as ReturnType<reviewCommand.ReviewCommandHost["realDeps"]>,
    reviewPostedDescription: (verdict) => verdict.summary, reviewWorkerLockId: (runId) => runId,
    reviewerClockBoundMs: (override) => override!, reviewSubjectGit: unrelated,
  };
}

/** Drives the real reviewCommand with its publication ports faked; `reviewThrows` makes the judged review throw. */
async function drive(t: TestContext, reviewThrows = false) {
  const fixture = gitRepo({ scope: t, kind: "review-inflight-lock" });
  const root = fixture.dir;
  writeFileSync(join(root, "changed.ts"), "export const changed = true;\n");
  fixture.git("add", "changed.ts");
  fixture.git("commit", "-qm", "changed");
  const head = fixture.git("rev-parse", "HEAD");
  const prUrl = "https://github.com/acme/remudero/pull/1";
  const view = { number: 1, state: "open", merged_at: null, body: "## Acceptance\n- changed exists | grep: changed in changed.ts\n",
    html_url: prUrl, head: { ref: "topic", sha: head } };
  const shim = ghShim([
    { when: "pulls/1/reviews", stdout: "[]" },
    { when: "pulls/1", stdout: JSON.stringify(view) },
    { when: "pr diff", stdout: "diff --git a/changed.ts b/changed.ts\n+++ b/changed.ts\n@@ -0,0 +1 @@\n+export const changed = true;\n" },
    { when: "pr view", stdout: '{"state":"OPEN"}' },
    { when: "/status", stdout: '{"statuses":[]}' },
    { when: "api ", stdout: "{}" },
  ], { kind: "review-inflight-lock" });
  const reviewsDir = join(root, "state", "inflight", REVIEW_INFLIGHT_DIR);
  const heldLocks = () => existsSync(reviewsDir) ? readdirSync(reviewsDir).filter((name) => name.endsWith(".lock")) : [];
  const seen: Array<[string, number]> = [];
  const previousPath = process.env.PATH;
  process.env.PATH = `${shim.dir}:${previousPath ?? ""}`;
  let outcome: number | Error;
  try {
    outcome = await reviewCommand.reviewCommand(fixtureHost(head), "1", ["--repo", "acme/remudero"], {
      resolveOwnerRepo: () => ({ owner: "acme", repo: "remudero" }),
      fetchView: () => view,
      loadConfig: () => ({ root, installRoot: REPO_ROOT, claudeBin: "/unused" }) as never,
      fetchHead: () => {},
      executionMode: "deterministic",
      materialize: () => ({ worktreePath: root }),
      withMaterialized: async (_path, _repo, run) => run(),
      buildBaseProof: () => ({ baseCheckoutDir: undefined, baseUnreadablePaths: new Set(), baseIsCheckout: false, addedTestFiles: new Set() }),
      postReviewPending: async () => { seen.push(["review.pending_posted", heldLocks().length]); return { posted: true }; },
      reviewerCodeFreshness: () => ({ status: "fresh", codeSha: head, originMainSha: head, advance: "none" }),
      readReviewStatusHistory: async () => ({ kind: "readable", failures: [] }),
      runReview: async () => {
        // The reviewer worker has run and exited here; the verdict is still to be posted.
        seen.push(["reviewer worker exited", heldLocks().length]);
        if (reviewThrows) throw new Error("the review threw");
        // A replayed decision: reviewCommand itself restores the status and writes the terminal review.posted row after this.
        return { state: "success", headSha: head, reviewerOutcome: "completed", keywordOnly: false, criteria: [], testTheater: false,
          summary: "fixture verdict", floorDegraded: false, capped: false, planOnly: false,
          decisionDisposition: "replayed", reviewDecisionDigest: "v2:prior" };
      },
      postStatus: async () => { seen.push(["review.posted", heldLocks().length]); return { posted: true }; },
    });
  } catch (error) {
    outcome = error as Error;
  } finally {
    process.env.PATH = previousPath;
    rmSync(shim.dir, { recursive: true, force: true });
  }
  return { outcome, seen, after: heldLocks() };
}

test("W1-T14947 a review holds its in-flight lock from claim to result", async (t) => {
  const ran = await drive(t);
  assert.equal(ran.outcome, 0, String(ran.outcome));
  assert.deepEqual(ran.seen.filter(([step]) => step !== "reviewer worker exited"), [["review.pending_posted", 1], ["review.posted", 1]],
    "one review lock is held at the pending post and at the terminal post");
  assert.deepEqual(ran.after, [], "released once the review ends");
  const thrown = await drive(t, true);
  assert.ok(thrown.outcome instanceof Error && /the review threw/.test(thrown.outcome.message), String(thrown.outcome));
  assert.deepEqual(thrown.after, [], "a thrown error releases the lock too");
});

test("W1-T14947 the lock outlives the reviewer worker", async (t) => {
  const ran = await drive(t);
  assert.deepEqual(ran.seen.find(([step]) => step === "reviewer worker exited"), ["reviewer worker exited", 1],
    "between the reviewer's exit and the posted verdict the review still holds its lock");
});

test("W1-T14947 a review lock is not a task run", (t) => {
  const dir = join(gitRepo({ scope: t, kind: "review-lock-not-a-task" }).dir, "inflight");
  mkdirSync(join(dir, REVIEW_INFLIGHT_DIR), { recursive: true });
  const alive = { pid: process.pid, run_id: "run-a", host: "fixture-host", startedAt: new Date(0).toISOString() };
  writeFileSync(join(dir, REVIEW_INFLIGHT_DIR, "review-run-a.lock"), JSON.stringify(alive));
  assert.deepEqual(liveInflightRuns(dir, () => true), [], "a live review lock is no task run");
  writeFileSync(join(dir, "W1-T1.lock"), JSON.stringify({ ...alive, run_id: "dispatch-run" }));
  assert.deepEqual(liveInflightRuns(dir, () => true).map((run) => run.taskId), ["W1-T1"],
    "positive control: a top-level task lock is still read");
});
