import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ReviewCommandDeps } from "#src/cli/commands/review.js";
import type { Config } from "#src/lib/config.js";
import { DEFAULT_RISK } from "#src/lib/plan.js";
import { parseAcceptanceBlock } from "#src/lib/review.js";
import { UNTASKED_REVIEW_BUDGET_USD, usesUntaskedReviewMetadata } from "#src/lib/tick-read-worker.js";
import { reviewCommand } from "#src/run-task.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const PROOF = "test/review/a-pr-pending-head-is-reviewed-as-its-own-pr.test.ts";
const BRANCH = "run-PR-pending-1793751990458";
const HEAD = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
const ACCEPTANCE = "## Acceptance\n- the change works | grep: review in src/lib/review.ts\n";

async function review(taskId: string, headRefName: string) {
  const root = mkdtempSync(join(tmpdir(), "rmd-pr-pending-review-"));
  let captured: Parameters<NonNullable<ReviewCommandDeps["runReview"]>>[0] | undefined;
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
      postReviewPending: async () => { effects.push("pending"); return { posted: true }; },
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
        };
      },
    });
    const rows: Array<Record<string, unknown>> = readFileSync(join(root, "state", "ledger.ndjson"), "utf8")
      .trim().split("\n").map(line => JSON.parse(line));
    return { code, captured, effects, rows };
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
  const { code, captured, effects, rows } = await review("PR-pending", BRANCH);
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
  assert.deepEqual(effects, ["pending", "materialize", "review"]);
  assert.equal(rows.filter(row => row.step === "review.reviewer.untasked_defaults").length, 1);
  assert.ok(!rows.some(row => row.step === "review.semantic_setup_refused"));
});

test(`${PROOF}: foreign placeholder heads and unresolved filed tasks still refuse metadata`, async () => {
  for (const [id, branch] of [
    ["PR-pending", "codex/foreign"],
    ["W1-T999999", "run-W1-T999999-1"],
  ]) {
    const { code, captured, effects, rows } = await review(id, branch);
    assert.equal(code, 2, `${id} on ${branch}`);
    assert.equal(captured, undefined);
    assert.deepEqual(effects, []);
    assert.equal(rows.find(row => row.step === "review.reviewer.skipped")?.reason,
      "head-task-metadata-unavailable");
    assert.equal(rows.find(row => row.step === "review.semantic_setup_refused")?.reason,
      "head-task-metadata-unavailable");
    assert.ok(!rows.some(row => row.step === "review.reviewer.untasked_defaults"));
  }
});
