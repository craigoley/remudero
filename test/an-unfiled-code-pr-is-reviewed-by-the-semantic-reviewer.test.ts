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
const CODE_BODY = "## Acceptance\n- it works | grep: review in src/lib/review.ts\n";

async function review(body: string, headRefName: string) {
  const root = mkdtempSync(join(tmpdir(), "rmd-unfiled-code-review-"));
  let captured: Record<string, any> | undefined;
  try {
    const deps = {
      fetchView: () => ({
        headRefOid: HEAD,
        headRefName,
        body,
        url: "https://github.com/craigoley/remudero/pull/5865",
        number: 5865,
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
    await reviewCommand(headRefName, ["--repo", "craigoley/remudero"], deps as never);
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

test("a non-plan run-unfiled PR logs untasked_defaults and spawns the semantic reviewer under the default risk and cap", async () => {
  const { args, ledger } = await review(CODE_BODY, "run-unfiled-1791211800000");

  assert.equal(args.spawnReviewer, true, "an unfiled code PR must be reviewed semantically");
  assert.equal(args.task.risk, "medium");
  assert.equal(args.budgetUsd, UNTASKED_REVIEW_BUDGET_USD);
  assert.ok(args.reviewerMount, "a reviewer mount must be resolved for the default risk");
  assert.equal(ledger.filter((r) => r.step === "review.reviewer.untasked_defaults").length, 1);
  assert.ok(!ledger.some((r) => r.step === "review.reviewer.skipped"), "no head-task-metadata-unavailable skip");
});

test("a PR with no task id at all still logs untasked_defaults and spawns the semantic reviewer", async () => {
  const { args, ledger } = await review(CODE_BODY, "codex/not-a-run-branch");

  assert.equal(args.spawnReviewer, true);
  assert.equal(args.budgetUsd, UNTASKED_REVIEW_BUDGET_USD);
  assert.equal(ledger.filter((r) => r.step === "review.reviewer.untasked_defaults").length, 1);
  assert.ok(!ledger.some((r) => r.step === "review.reviewer.skipped"));
});

test("a real task id whose shard lacks risk still logs head-task-metadata-unavailable", async () => {
  const { args, ledger } = await review(`${CODE_BODY}\nRemudero-Task: W1-T999999`, "run-unfiled-1791211800000");

  assert.equal(args.spawnReviewer, false);
  assert.equal(args.budgetUsd, undefined);
  assert.ok(!ledger.some((r) => r.step === "review.reviewer.untasked_defaults"));
  assert.deepEqual(
    ledger.filter((r) => r.step === "review.reviewer.skipped").map((r) => r.reason),
    ["head-task-metadata-unavailable"],
  );
});
