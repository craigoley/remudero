/**
 * test/fix-lane/an-ops-task-in-round-review-reads-no-core-task-source.test.ts — W1-T13958.
 *
 * THE DEFECT (OBSERVED 2026-11-20, #19691 #19721 #19727): a fix round's in-round review of an
 * ops-catalog task posted "cannot-evaluate: promise source unavailable" over the real verdict. The
 * ops catalog labels its blobs "tasks.d/<file>", that label becomes `Task.sourcePath`, and the fix
 * rung built `reviewTask` with `Object.assign({}, opts.task, ...)`, keeping it. The promised
 * follow-up reader then refused a path that is not `plan/tasks.d/<file>.yaml` in the core head.
 * The lane review hands a fresh contract with no `sourcePath`, so it never hit this.
 *
 * THE FIX: drop `sourcePath` from `reviewTask` when the head-resolved catalog is ops. A core task
 * keeps it (invariant core-task-source-kept).
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { Config } from "#src/lib/config.js";
import type { IssueGateway, OpenIssue } from "#src/lib/escalate.js";
import type { Mount } from "#src/lib/mounts.js";
import { observePromisedFollowUps, type ReviewVerdict } from "#src/lib/review.js";
import type { CatalogTaskContract } from "#src/lib/task-lookup.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import type { WorkerResult } from "#src/lib/worker.js";
import { runFixRung } from "#test/helpers/run-task-test.js";

const MOUNT: Mount = { model: "sonnet", effort: "medium", maxTurns: 400, contextBudget: 120000 };

function workerResult(): WorkerResult {
  return {
    sessionId: "s",
    costUsd: 0,
    numTurns: 0,
    text: "fixed",
    blocks: [],
    stderr: "",
    subtype: "success",
    isError: false,
    apiError: false,
    permissionDenials: [],
    childEnvKeys: [],
    model: "default",
    effort: "default",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    modelUsage: {},
    compactionEvents: [],
    qualitySuspect: false,
  };
}

function verdict(state: "success" | "failure", met: boolean): ReviewVerdict & { headSha: string; reviewerOutcome: string } {
  return {
    state,
    criteria: [{ claim: "c", met, proof: "proof", reason: met ? "" : "not close enough", proof_exec: "not_executable" }],
    testTheater: false,
    summary: state === "success" ? "all criteria met" : "unmet criteria",
    floorDegraded: false,
    capped: false,
    keywordOnly: false,
    planOnly: false,
    headSha: "sha-1",
    reviewerOutcome: "success",
  };
}

function issueStore(): IssueGateway {
  return { create: () => "https://github.com/acme/remudero/issues/1", listOpen: (): OpenIssue[] => [], comment: () => {} };
}

/** Drive ONE strike of the real fix rung and return the `task` it handed `deps.runReview`. With
 *  `viaResolver: false` the deps match production's sweep and `rmd fix`: the contract is resolved
 *  before the rung, and no `resolveTaskContractAtHead` is wired. */
async function reviewedTaskFor(
  taskId: string,
  sourcePath: string,
  catalog: "public" | "ops",
  viaResolver = true,
): Promise<Record<string, unknown>> {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t13958-`));
  let reviewed: Record<string, unknown> | undefined;
  try {
    const contract: CatalogTaskContract = {
      criteria: [{ claim: "the head-resolved criterion", proof: "unit test: head" }],
      taskId,
      taskDeclaredFiles: ["src/x.ts"],
      taskCatalog: catalog,
      source: `plan at headsha task ${taskId} (1 criteria)`,
    };
    await runFixRung({
      taskId,
      runId: `${taskId}-1730000000000`,
      task: { id: taskId, title: "an in-round review", files: ["src/x.ts"], sourcePath } as never,
      prUrl: "https://github.com/acme/remudero/pull/3",
      branch: `run-${taskId}-1730000000000`,
      worktreePath: join(dir, "wt"),
      initialSessionId: "session-0",
      mount: MOUNT,
      settingsFile: join(dir, "settings.json"),
      config: {} as Config,
      budgetUsd: 10,
      reviewBase: { owner: "acme", repo: "remudero", headCheckoutDir: join(dir, "wt"), reviewerMount: MOUNT },
      strikeCap: 2,
      initialReview: verdict("failure", false),
      deps: {
        spawn: async () => workerResult(),
        waitForCiGreen: async () => "green",
        runReview: async (args) => {
          reviewed = args.task as unknown as Record<string, unknown>;
          return verdict("success", true);
        },
        push: () => {},
        issues: issueStore(),
        ledgerPath: join(dir, "ledger.ndjson"),
        log: () => {},
        say: () => {},
        account: (r) => r,
        fetchPrBody: async () => `## Summary\n\nfixture body.\n\nRemudero-Task: ${taskId}\n`,
        ...(viaResolver ? { resolveTaskContractAtHead: () => contract } : {}),
      },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.ok(reviewed, "the rung must have run its in-round review, or nothing below is measured");
  return reviewed;
}

test("W1-T13958 criterion 1: an ops-catalog task reaches the in-round review with no core-head sourcePath", async () => {
  const task = await reviewedTaskFor("W1-T13785", "tasks.d/W1-T13785-x.yaml", "ops");
  assert.equal(task.catalog, "ops");
  assert.equal("sourcePath" in task, false, `an ops blob label must not reach the core-head follow-up reader: ${String(task.sourcePath)}`);
  assert.deepEqual(task.files, ["src/x.ts"], "the head-resolved contract still reaches the reviewer");
});

test("W1-T13958 criterion 1: on the production path (no head resolver wired) an ops task reaches the review with no sourcePath", async () => {
  const task = await reviewedTaskFor("W1-T13785", "tasks.d/W1-T13785-x.yaml", "ops", false);
  assert.equal("sourcePath" in task, false, `the sweep and rmd fix wire no resolver, yet the ops label must not leak: ${String(task.sourcePath)}`);
  // The reader the in-round review runs: fed the task the rung handed over, it is not unknown.
  const observed = await observePromisedFollowUps({ diff: "", headSha: "sha-1", task: task as { id: string; sourcePath?: string } });
  assert.equal(observed.state, "complete", `no promise source unavailable verdict: ${JSON.stringify(observed)}`);
  const monolith = await reviewedTaskFor("W1-T13786", "tasks.yaml", "ops", false);
  assert.equal("sourcePath" in monolith, false, "the ops monolith label is an ops blob too");
});

test("W1-T13958 criterion 2: on the production path (no head resolver wired) a core task keeps its plan/tasks.d sourcePath", async () => {
  const task = await reviewedTaskFor("W1-T1", "plan/tasks.d/W1-T1-x.yaml", "public", false);
  assert.equal(task.sourcePath, "plan/tasks.d/W1-T1-x.yaml", "a core task's promised follow-ups are still read at the head");
});

test("W1-T13958 criterion 2: a core-catalog task keeps its plan/tasks.d sourcePath for the in-round review", async () => {
  const task = await reviewedTaskFor("W1-T1", "plan/tasks.d/W1-T1-x.yaml", "public");
  assert.equal(task.catalog, "public");
  assert.equal(task.sourcePath, "plan/tasks.d/W1-T1-x.yaml", "a core task's promised follow-ups are still read at the head");
});
