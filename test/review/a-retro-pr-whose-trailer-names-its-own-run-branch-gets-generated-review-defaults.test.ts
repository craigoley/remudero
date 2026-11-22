import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ReviewCommandDeps } from "#src/cli/commands/review.js";
import type { Config } from "#src/lib/config.js";
import { UNTASKED_REVIEW_BUDGET_USD, usesUntaskedReviewMetadata } from "#src/lib/tick-read-worker.js";
import { reviewCommand } from "#src/run-task.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const retroId = "RETRO-1794737755052";
const retroHead = "run-RETRO-1794737755052";

test("W1-T12883 criterion 1: a numeric retro trailer matches its own run branch", () => {
  assert.equal(usesUntaskedReviewMetadata(retroId, retroHead), true);
});

test("W1-T12883 criterion 2: foreign, mismatched, suffixed and filed task branches stay ineligible", () => {
  for (const head of ["codex/foreign", "run-RETRO-1794737755053", `${retroHead}-other-1794737755099`]) {
    assert.equal(usesUntaskedReviewMetadata(retroId, head), false, head);
  }
  for (const head of ["run-W1-T999999", "run-W1-T999999-1791211800000"]) {
    assert.equal(usesUntaskedReviewMetadata("W1-T999999", head), false, head);
  }
  assert.equal(usesUntaskedReviewMetadata("RETRO-not-an-epoch", "run-RETRO-not-an-epoch"), false);
});

test("W1-T12883 criterion 3: semantic review records generated defaults for the retro PR", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "rmd-retro-review-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const headSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  const ledgerPath = join(root, "state", "ledger.ndjson");
  const deps: ReviewCommandDeps = {
    resolveOwnerRepo: () => ({ owner: "craigoley", repo: "remudero" }),
    fetchView: () => ({
      headRefOid: headSha,
      headRefName: retroHead,
      body: `Remudero-Task: ${retroId}`,
      url: "https://github.com/craigoley/remudero/pull/18670",
      number: 18670,
    }),
    fetchHead: () => {},
    loadConfig: () => ({ root, installRoot: REPO_ROOT, claudeBin: "/bin/true" }) as Config,
    startPhasesLedgerPath: ledgerPath,
    postReviewPending: async () => ({ posted: true }),
    materialize: () => ({ worktreePath: undefined, failure: { errorClass: "other", message: "fixture" } }),
    runReview: async (args) => {
      assert.equal(args.task.id, retroId);
      assert.equal(args.spawnReviewer, true);
      assert.equal(args.requireSemanticReview, true);
      return {
        state: "success",
        headSha,
        reviewerOutcome: "not_attempted",
        criteria: [],
        summary: "fixture verdict",
        testTheater: false,
        floorDegraded: false,
        capped: false,
        keywordOnly: false,
        planOnly: false,
      };
    },
    executionMode: "semantic",
  };
  const code = await reviewCommand(retroHead, ["--repo", "craigoley/remudero"], deps);

  const ledger = readFileSync(ledgerPath, "utf8").trim().split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const defaults = ledger.filter((row) => row.step === "review.reviewer.untasked_defaults");
  assert.deepEqual(defaults.map((row) => [row.task_id, row.task_risk, row.hard_cap_usd]),
    [[retroId, "medium", UNTASKED_REVIEW_BUDGET_USD]]);
  assert.equal(ledger.some((row) => row.step === "review.semantic_setup_refused"), false);
  assert.equal(code, 0);
});
