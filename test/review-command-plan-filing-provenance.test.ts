import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { Config } from "../src/lib/config.js";
import type { Plan } from "../src/lib/plan.js";
import { DEFAULT_SWEEP_POLICY, type OpenPrView } from "../src/lib/sweep.js";
import { buildSweepEffects, reviewCommand, runReview } from "../src/run-task.js";

const REPO_ROOT = join(import.meta.dirname, "..");
const HEAD_SHA = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
const FILING_BODY = [
  "## Acceptance",
  "- W1-T3115 is filed as a well-formed task shard, not yet implemented | lint-plan and plan-index-check pass",
].join("\n");

function plan(): Plan {
  return { tasks: [], byId: new Map() } as unknown as Plan;
}

function greenFiling(): OpenPrView {
  return {
    prNumber: 42,
    prUrl: "https://github.com/acme/remudero/pull/42",
    taskId: "W1-T3115",
    reviewState: "none",
    checksState: "green",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: new Date(0).toISOString(),
    headSha: HEAD_SHA,
    headRefName: "run-W1-T3115-1788907100000",
    autoMergeArmed: false,
    isPlanFiling: true,
  };
}

test("W1-T3115: the post-review effect carries the already-measured plan-filing fact into its review runner", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-review-filing-handoff-"));
  const calls: Array<{ prNumber: number; isPlanFiling: boolean | undefined }> = [];
  const effects = buildSweepEffects(
    "acme",
    "remudero",
    { root } as Config,
    join(root, "state", "ledger.ndjson"),
    "SWEEP-W1-T3115",
    plan(),
    () => {},
    DEFAULT_SWEEP_POLICY,
    async (prNumber: number, isPlanFiling?: boolean) => {
      calls.push({ prNumber, isPlanFiling });
      return 0;
    },
  );

  await effects.postReview?.(greenFiling());
  assert.deepEqual(calls, [{ prNumber: 42, isPlanFiling: true }]);
});

async function reviewIdentity(opts: { planOnlyFiling: boolean; body?: string }): Promise<{
  taskId: string | undefined;
  criteria: number;
  claim: string | undefined;
  fetchViewCalls: number;
}> {
  const root = mkdtempSync(join(tmpdir(), "rmd-review-filing-command-"));
  let taskId: string | undefined;
  let criteria = 0;
  let claim: string | undefined;
  let fetchViewCalls = 0;
  const sentinel = "stop after review identity";
  await assert.rejects(
    () =>
      reviewCommand("42", ["--repo", "acme/remudero"], {
        planOnlyFiling: opts.planOnlyFiling,
        fetchView: () => {
          fetchViewCalls++;
          return {
            body: opts.body ?? FILING_BODY,
            html_url: "https://github.com/acme/remudero/pull/42",
            head: { ref: "run-W1-T3115-1788907100000", sha: HEAD_SHA },
            updated_at: new Date(0).toISOString(),
            number: 42,
          };
        },
        loadConfig: () => ({ root }) as Config,
        fetchHead: () => {},
        postReviewPending: async () => ({ posted: true }) as never,
        materialize: () => ({
          worktreePath: undefined,
          failure: { errorClass: "test", message: "fixture stops before a real worktree" },
        }) as never,
        runReview: (async (args: Parameters<typeof runReview>[0]) => {
          taskId = args.task.id;
          criteria = args.task.acceptance?.length ?? 0;
          claim = args.task.acceptance?.[0]?.claim;
          throw new Error(sentinel);
        }) as never,
      } as never),
    (error: Error) => error.message === sentinel,
  );
  return { taskId, criteria, claim, fetchViewCalls };
}

test("W1-T3115: reviewCommand uses a carried external-filing classification instead of recovering the run-branch task", async () => {
  const filing = await reviewIdentity({ planOnlyFiling: true });
  assert.equal(filing.taskId, "PR-42");
  assert.equal(filing.criteria, 1);
  assert.match(filing.claim ?? "", /filed as a well-formed task shard/);
  assert.equal(filing.fetchViewCalls, 1, "the handoff adds no second GitHub read or classifier");

  const implementation = await reviewIdentity({ planOnlyFiling: false });
  assert.equal(implementation.taskId, "W1-T3115");
  assert.equal(implementation.criteria, 6);

  const trailer = await reviewIdentity({
    planOnlyFiling: true,
    body: `${FILING_BODY}\n\nRemudero-Task: W1-T3115`,
  });
  assert.equal(trailer.taskId, "W1-T3115", "an exact trailer still wins over the carried filing fact");
  assert.equal(trailer.criteria, 6);
});
