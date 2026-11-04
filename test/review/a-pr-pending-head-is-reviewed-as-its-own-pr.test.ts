import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { reviewCommand as reviewCommandImpl, type ReviewCommandDeps, type ReviewCommandHost } from "#src/cli/commands/review.js";
import type { Config } from "#src/lib/config.js";
import { DEFAULT_RISK } from "#src/lib/plan.js";
import { parseAcceptanceBlock } from "#src/lib/review.js";
import { UNTASKED_REVIEW_BUDGET_USD, usesUntaskedReviewMetadata } from "#src/lib/tick-read-worker.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

function unexpected(): never { throw new Error("unexpected review fixture dependency"); }
const reviewHost: ReviewCommandHost = {
  GIT_UNTRACKED_FILES_ALL: "--untracked-files=all",
  JUDGE_AT_OWN_START_FLAG: "--judge-at-own-start",
  acceptedReviewAttemptId: (value) => typeof value === "string" ? value : undefined,
  attributeWorkerStreamEvent: unexpected,
  ledgeredNonDispatchSpawn: unexpected,
  lintPlanForReview: unexpected,
  liveWorkerRunIds: new Set<string>(),
  materializeReviewWorktree: unexpected,
  readHeadShaRest: unexpected,
  readMainPlanTreeSha: unexpected,
  realDeps: () => ({ reviewWorktree: { fetch: unexpected } }) as unknown as ReturnType<ReviewCommandHost["realDeps"]>,
  reviewPostedDescription: (verdict) => verdict.summary,
  reviewWorkerLockId: (runId) => runId,
  reviewerClockBoundMs: unexpected,
  reviewSubjectGit: unexpected,
};
const reviewCommand = reviewCommandImpl.bind(null, reviewHost);

const PROOF = "test/review/a-pr-pending-head-is-reviewed-as-its-own-pr.test.ts";
const BRANCH = "run-PR-pending-1793751990458";
const HEAD = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
const ACCEPTANCE = "## Acceptance\n- the change works | grep: review in src/lib/review.ts\n";

async function review(taskId: string, headRefName: string, replayed = false) {
  const root = mkdtempSync(join(tmpdir(), "rmd-pr-pending-review-"));
  let captured: Parameters<NonNullable<ReviewCommandDeps["runReview"]>>[0] | undefined;
  let pending: Parameters<NonNullable<ReviewCommandDeps["postReviewPending"]>>[0] | undefined;
  let posted: Parameters<NonNullable<ReviewCommandDeps["postStatus"]>>[0] | undefined;
  const effects: string[] = [];
  try {
    const code = await reviewCommand(headRefName, ["--repo", "craigoley/remudero"], {
      resolveOwnerRepo: () => ({ owner: "craigoley", repo: "remudero" }),
      fetchView: () => ({
        headRefOid: HEAD, headRefName, number: 16499,
        url: "https://github.com/craigoley/remudero/pull/16499",
        body: `${ACCEPTANCE}\nRemudero-Task: ${taskId}`,
      }),
      loadConfig: () => ({ root, installRoot: REPO_ROOT, claudeBin: "/bin/true" }) as Config,
      executionMode: "semantic",
      fetchHead: () => {},
      postReviewPending: async (args) => { pending = args; effects.push("pending"); return { posted: true }; },
      postStatus: async (args) => { posted = args; effects.push("status"); return { posted: true }; },
      reviewerCodeFreshness: () => ({ status: "fresh", codeSha: HEAD, originMainSha: HEAD, advance: "none" }),
      materialize: () => {
        effects.push("materialize");
        return { worktreePath: undefined, failure: { errorClass: "other", message: "fixture" } };
      },
      runReview: async (args) => {
        captured = args;
        effects.push("review");
        return {
          state: "success", headSha: HEAD, reviewerOutcome: "success", criteria: [],
          testTheater: false, summary: "fixture review complete", floorDegraded: false,
          capped: false, keywordOnly: false, planOnly: false,
          ...(replayed ? { decisionDisposition: "replayed" as const, reviewDecisionDigest: "a".repeat(64) } : {}),
        };
      },
    });
    const rows: Array<Record<string, unknown>> = readFileSync(join(root, "state", "ledger.ndjson"), "utf8")
      .trim().split("\n").map(line => JSON.parse(line));
    return { code, captured, pending, posted, effects, rows };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test(`${PROOF}: the placeholder qualifies only on its exact numeric run branch`, () => {
  for (const epoch of ["0", "1", "001", "1793751990458"]) {
    assert.equal(usesUntaskedReviewMetadata("PR-pending", `run-PR-pending-${epoch}`), true, epoch);
  }
  for (const branch of [
    "codex/foreign", "run-unfiled-1", "run-PR-16499-1", "run-PR-pending-",
    "run-PR-pending-other-1", "run-PR-pending-1x", "run-PR-pending--1",
    "prefix-run-PR-pending-1", "run-pr-pending-1", "run-PR-pending-1/suffix",
  ]) {
    assert.equal(usesUntaskedReviewMetadata("PR-pending", branch), false, branch);
  }
  for (const id of ["PR-Pending", "pr-pending", "PR-pending-extra", "W1-T999999"]) {
    assert.equal(usesUntaskedReviewMetadata(id, BRANCH), false, id);
  }
});

test(`${PROOF}: semantic review receives untasked risk and budget and reaches a verdict`, async () => {
  const { code, captured, pending, posted, effects, rows } = await review("PR-pending", BRANCH);
  assert.equal(code, 0);
  assert.ok(captured, "the placeholder must reach the normal review path");
  assert.equal(captured.task.id, "PR-pending");
  assert.deepEqual(captured.task.acceptance, parseAcceptanceBlock(ACCEPTANCE));
  assert.equal(captured.task.risk, DEFAULT_RISK);
  assert.equal(captured.task.budget_usd, UNTASKED_REVIEW_BUDGET_USD);
  assert.equal(captured.budgetUsd, UNTASKED_REVIEW_BUDGET_USD);
  assert.equal(captured.spawnReviewer, true);
  assert.equal(captured.requireSemanticReview, true);
  assert.ok(captured.reviewerMount);
  assert.equal(captured.reviewReplaySetupInput?.untasked, true);
  assert.equal(pending?.sha, HEAD);
  assert.equal(pending?.taskId, "PR-pending");
  assert.equal(pending?.prUrl, "https://github.com/craigoley/remudero/pull/16499");
  assert.equal(posted, undefined);
  assert.deepEqual(effects, ["pending", "materialize", "review"]);
  const defaults = rows.filter(row => row.step === "review.reviewer.untasked_defaults");
  assert.deepEqual(defaults.map(row => [row.task_risk, row.hard_cap_usd]),
    [[DEFAULT_RISK, UNTASKED_REVIEW_BUDGET_USD]]);
  assert.ok(!rows.some(row => row.step === "review.semantic_setup_refused"));
});

test(`${PROOF}: a replayed placeholder verdict restores a terminal status for its own head`, async () => {
  const { code, captured, posted, effects, rows } = await review("PR-pending", BRANCH, true);
  assert.equal(code, 0);
  assert.equal(captured?.requireSemanticReview, true);
  assert.equal(posted?.state, "success");
  assert.equal(posted?.sha, HEAD);
  assert.equal(posted?.taskId, "PR-pending");
  assert.equal(posted?.prUrl, "https://github.com/craigoley/remudero/pull/16499");
  assert.deepEqual(effects, ["pending", "materialize", "review", "status"]);
  const terminal = rows.filter(row => row.step === "review.posted");
  assert.equal(terminal.length, 1);
  assert.equal(terminal[0].state, "success");
  assert.equal(terminal[0].head_sha, HEAD);
  assert.equal(terminal[0].status_recovered, true);
});

test(`${PROOF}: foreign placeholder heads and unresolved filed tasks still refuse metadata`, async () => {
  for (const [id, branch] of [
    ["PR-pending", "codex/foreign"],
    ["W1-T999999", "run-W1-T999999-1"],
  ]) {
    const { code, captured, pending, posted, effects, rows } = await review(id, branch);
    assert.equal(code, 2, `${id} on ${branch}`);
    assert.equal(captured, undefined);
    assert.equal(pending, undefined);
    assert.equal(posted, undefined);
    assert.deepEqual(effects, []);
    assert.equal(rows.find(row => row.step === "review.reviewer.skipped")?.reason,
      "head-task-metadata-unavailable");
    assert.equal(rows.find(row => row.step === "review.semantic_setup_refused")?.reason,
      "head-task-metadata-unavailable");
    assert.ok(!rows.some(row => row.step === "review.reviewer.untasked_defaults"));
  }
});
