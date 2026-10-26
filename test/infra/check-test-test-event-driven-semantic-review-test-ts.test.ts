import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { Config } from "#src/lib/config.js";
import { reviewCommand } from "#src/run-task.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

// PR #12954 spent a fix round here: its change made semantic review refuse a PR whose head task
// metadata is missing, and the old test fixture never read the exit code, so the refusal showed up
// only as "the real review command must reach runReview". This test pins the refusal by its
// outcome: the exit code first, then the effects and ledger rows only that refusal writes. Each
// review loads the plan twice (once at the head, once at origin/main), so the test makes only one.
const HEAD = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();

async function semanticReview() {
  const root = mkdtempSync(join(tmpdir(), "rmd-w1-t10239-"));
  const effects: string[] = [];
  try {
    const body = [
      "## Acceptance",
      "- a refused semantic review cannot publish a deterministic verdict | grep: review in src/lib/review.ts",
      "",
      "Remudero-Task: W1-T999999",
    ].join("\n");
    const deps = {
      fetchView: () => ({
        headRefOid: HEAD, headRefName: "codex/w1-t10239", body,
        url: "https://github.com/craigoley/remudero/pull/9998", number: 9998,
      }),
      fetchHead: () => {},
      contributorAdmission: async () => {},
      loadConfig: () => ({ root, installRoot: REPO_ROOT, claudeBin: "/bin/true" }) as Config,
      postReviewPending: async () => { effects.push("pending"); return { posted: true }; },
      materialize: () => {
        effects.push("materialize");
        return { worktreePath: undefined, failure: { errorClass: "test", message: "W1-T10239 fixture" } };
      },
      runReview: async () => {
        effects.push("review");
        return { state: "success", headSha: HEAD, reviewerOutcome: "not_attempted", criteria: [] };
      },
      executionMode: "semantic" as const,
    };
    const code = await reviewCommand("codex/w1-t10239", ["--repo", "craigoley/remudero"], deps as never);
    const ledgerPath = join(root, "state", "ledger.ndjson");
    const ledger = existsSync(ledgerPath)
      ? readFileSync(ledgerPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>)
      : [];
    return { code, effects, ledger };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("W1-T10239: check:test:test/event-driven-semantic-review.test.ts is prevented, not retried", async () => {
  const semantic = await semanticReview();
  assert.equal(semantic.code, 2, "semantic mode with no head task metadata must refuse with exit 2");
  assert.deepEqual(semantic.effects, [], "the refusal precedes pending status, materialization and review");
  assert.ok(semantic.ledger.some((row) =>
    row.step === "review.semantic_setup_refused" && row.reason === "head-task-metadata-unavailable"));
  assert.ok(!semantic.ledger.some((row) => row.step === "review.posted" || row.step === "automerge.armed"));
});
