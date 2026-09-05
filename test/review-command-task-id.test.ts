import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Config } from "../src/lib/config.js";
import { appendLedger } from "../src/lib/ledger.js";
import { reviewCommand, resolveReviewTaskId, runReview } from "../src/run-task.js";

const REPO_ROOT = join(import.meta.dirname, "..");
const HEAD_SHA = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
const RUN_BRANCH = "run-W1-T2846-1788560597630";
const PR_URL = "https://github.com/acme/remudero/pull/42";

function restView(body: string, headRefName = RUN_BRANCH, number = 42) {
  return {
    body,
    html_url: `https://github.com/acme/remudero/pull/${number}`,
    head: { ref: headRefName, sha: HEAD_SHA },
    updated_at: new Date(0).toISOString(),
    number,
  };
}

function stoppedMaterialization() {
  return {
    worktreePath: undefined,
    failure: { errorClass: "test", message: "fixture stops before a real worktree" },
  } as never;
}

test("W1-T2846: reviewCommand and the board builder call the same higher-level task-id resolver", () => {
  const source = readFileSync(join(REPO_ROOT, "src", "run-task.ts"), "utf8");
  assert.match(source, /const taskId = resolveReviewTaskId\(body, view\.headRefName,/);
  assert.match(source, /return resolveReviewTaskId\(pr\.body \?\? "", pr\.headRefName,/);
});

test("W1-T2846: an untrailered fleet run branch is judged and ledgered under its W1 task with plan criteria", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-review-branch-task-id-"));
  const sentinel = "stop after task identity is captured";
  let fetchViewCalls = 0;
  let fetchHeadCalls = 0;
  let reviewedTaskId: string | undefined;
  let reviewedCriteria = 0;

  await assert.rejects(
    () =>
      reviewCommand("42", ["--repo", "acme/remudero"], {
        fetchView: () => {
          fetchViewCalls++;
          return restView("");
        },
        loadConfig: () => ({ root }) as Config,
        fetchHead: () => {
          fetchHeadCalls++;
        },
        postReviewPending: async () => ({ posted: true }) as never,
        materialize: stoppedMaterialization,
        runReview: (async (args: Parameters<typeof runReview>[0]) => {
          reviewedTaskId = args.task.id;
          reviewedCriteria = args.task.acceptance?.length ?? 0;
          throw new Error(sentinel);
        }) as never,
      }),
    (error: Error) => error.message === sentinel,
  );

  assert.equal(reviewedTaskId, "W1-T2846");
  assert.equal(reviewedCriteria, 7, "criteria resolve from W1-T2846 at the reviewed head, not an empty body");
  assert.equal(fetchViewCalls, 1, "the fallback adds no PR-view REST or GraphQL read");
  assert.equal(fetchHeadCalls, 1, "the existing local git fetch remains exactly once");
  const ledger = readFileSync(join(root, "state", "ledger.ndjson"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.ok(ledger.length > 0);
  assert.ok(ledger.every((line) => line.task_id === "W1-T2846"), "every review row uses the resolved task identity");
});

test("W1-T2846: an exact trailer wins when it disagrees with the run branch", () => {
  assert.equal(resolveReviewTaskId("Remudero-Task: W1-T9999", RUN_BRANCH, false), "W1-T9999");
});

test("W1-T2846: a positively marked plan-only filing never inherits its run-branch id", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-review-plan-filing-id-"));
  const ledgerPath = join(root, "state", "ledger.ndjson");
  const body = ["## Acceptance", "- the task is filed | grep: W1-T2846 in plan/tasks.d"].join("\n");
  appendLedger(ledgerPath, {
    run_id: "filing-run",
    task_id: "RETRO",
    step: "pr.opened",
    pr_url: PR_URL,
    plan_only: true,
  });
  const sentinel = "stop after plan-only identity is captured";
  let reviewedTaskId: string | undefined;

  await assert.rejects(
    () =>
      reviewCommand("42", ["--repo", "acme/remudero"], {
        fetchView: () => restView(body),
        loadConfig: () => ({ root }) as Config,
        fetchHead: () => {},
        postReviewPending: async () => ({ posted: true }) as never,
        materialize: stoppedMaterialization,
        runReview: (async (args: Parameters<typeof runReview>[0]) => {
          reviewedTaskId = args.task.id;
          throw new Error(sentinel);
        }) as never,
      }),
    (error: Error) => error.message === sentinel,
  );

  assert.equal(reviewedTaskId, "PR-42");
  assert.equal(resolveReviewTaskId(body, RUN_BRANCH, true), undefined);
});

test("W1-T2846: a manual non-run branch with no trailer remains unattributed", () => {
  assert.equal(resolveReviewTaskId("## Acceptance\n- claim | grep: x in src/x.ts", "codex/manual-fix", false), undefined);
});
