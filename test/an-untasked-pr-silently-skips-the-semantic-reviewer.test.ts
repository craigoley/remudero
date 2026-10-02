import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { Config } from "../src/lib/config.js";
import { reviewCommand, UNTASKED_REVIEW_BUDGET_USD } from "../src/run-task.js";

const REPO_ROOT = process.cwd();
const HEAD = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();

async function review(body: string) {
  const root = mkdtempSync(join(tmpdir(), "rmd-untasked-review-"));
  let captured: Record<string, any> | undefined;
  try {
    const deps = {
      fetchView: () => ({
        headRefOid: HEAD,
        headRefName: "codex/not-a-run-branch",
        body,
        url: "https://github.com/craigoley/remudero/pull/5106",
        number: 5106,
      }),
      fetchHead: () => {},
      loadConfig: () => ({ root, installRoot: REPO_ROOT, claudeBin: "/bin/true" }) as Config,
      postReviewPending: async () => ({ posted: true }),
      materialize: () => ({ worktreePath: undefined, failure: { errorClass: "test", message: "fixture" } }),
      runReview: async (args: Record<string, any>) => {
        captured = { ...args };
        return { state: "success", headSha: HEAD, reviewerOutcome: "not_attempted", criteria: [] };
      },
      executionMode: "semantic" as const,
    };
    await reviewCommand("codex/not-a-run-branch", ["--repo", "craigoley/remudero"], deps as never);
    assert.ok(captured, "the review command must reach runReview");
    const ledgerPath = join(root, "state", "ledger.ndjson");
    const ledger = existsSync(ledgerPath)
      ? readFileSync(ledgerPath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>)
      : [];
    return { args: captured, ledger };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("an untrailered PR with no derivable task id still spawns the semantic reviewer under a default risk and budget", async () => {
  const { args, ledger } = await review("## Acceptance\n- it works | grep: review in src/lib/review.ts\n");

  assert.equal(args.task.id, "PR-5106");
  assert.equal(args.spawnReviewer, true, "an untasked PR must still be reviewed semantically");
  assert.equal(args.task.risk, "medium");
  assert.equal(args.task.budget_usd, UNTASKED_REVIEW_BUDGET_USD);
  assert.equal(args.budgetUsd, UNTASKED_REVIEW_BUDGET_USD);
  assert.ok(args.reviewerMount, "a reviewer mount must be resolved for the default risk");
  assert.ok(ledger.some((r) => r.step === "review.reviewer.untasked_defaults" && r.task_id === "PR-5106"));
  assert.ok(!ledger.some((r) => r.step === "review.reviewer.skipped"), "no skip row for an untasked PR");
});

test("a derived task id whose shard is missing still skips under its own distinct plan-resolution reason", async () => {
  const { args, ledger } = await review("## Acceptance\n- x | grep: review in src/lib/review.ts\n\nRemudero-Task: W1-T999999");

  assert.equal(args.spawnReviewer, false);
  assert.equal(args.budgetUsd, undefined);
  const skips = ledger.filter((r) => r.step === "review.reviewer.skipped");
  assert.deepEqual(skips.map((r) => r.reason), ["head-task-metadata-unavailable"]);
});
