import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { Config } from "../src/lib/config.js";
import { DEFAULT_RISK } from "../src/lib/plan.js";
import { DEFAULT_BUDGET_USD, reviewCommand, runReview } from "../src/run-task.js";

const REPO_ROOT = process.cwd();
const HEAD = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();

test("W1-T3387: an untasked PR receives the conservative semantic-review defaults", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-untasked-semantic-review-"));
  let captured: Parameters<typeof runReview>[0] | undefined;
  try {
    await reviewCommand("untasked-pr", ["--repo", "craigoley/remudero"], {
      executionMode: "semantic",
      fetchView: () => ({
        headRefOid: HEAD,
        headRefName: "codex/untasked-pr",
        body: ["## Acceptance", "- the deterministic floor still runs | grep: review in src/lib/review.ts"].join("\n"),
        url: "https://github.com/craigoley/remudero/pull/9998",
        number: 9998,
      }),
      fetchHead: () => {},
      loadConfig: () => ({ root, claudeBin: "/bin/true" }) as Config,
      postReviewPending: async () => ({ posted: true }),
      materialize: () => ({
        worktreePath: undefined,
        failure: { errorClass: "test", message: "untasked semantic-review fixture" },
      }),
      runReview: async (args: Parameters<typeof runReview>[0]) => {
        captured = args;
        return { state: "success", headSha: HEAD, reviewerOutcome: "not_attempted", criteria: [] } as Awaited<ReturnType<typeof runReview>>;
      },
    });

    assert.ok(captured, "the real review command must reach the reviewer seam");
    assert.equal(captured.spawnReviewer, true, "an untasked PR must not silently skip semantic review");
    assert.equal(captured.budgetUsd, DEFAULT_BUDGET_USD, "the synthetic PR identity receives the conservative hard budget");
    assert.ok(captured.reviewerMount, "the synthetic PR identity resolves a reviewer mount");
    assert.ok(existsSync(captured.settingsFile), "the reviewer receives a rendered settings file");

    const ledger = readFileSync(join(root, "state", "ledger.ndjson"), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.ok(
      ledger.some(
        (row) =>
          row.step === "review.semantic_mode" &&
          row.task_risk === DEFAULT_RISK &&
          row.hard_cap_usd === DEFAULT_BUDGET_USD,
      ),
      "the durable semantic-mode row names the conservative defaults",
    );
    assert.ok(
      !ledger.some((row) => row.step === "review.reviewer.skipped" && row.reason === "head-task-metadata-unavailable"),
      "the metadata skip is reserved for a claimed task whose metadata could not be resolved",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
