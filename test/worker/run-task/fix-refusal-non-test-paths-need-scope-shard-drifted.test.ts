import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { parse } from "yaml";
import type { Config } from "#src/lib/config.js";
import type { ReviewVerdict } from "#src/lib/review.js";
import { runFixRung } from "#src/run-task.js";
import { gitRepo } from "#test/helpers/git-repo.js";

test("W1-T10581: fix_refusal:non-test-paths-need-scope-shard-drifted is prevented, not retried", async (t) => {
  await t.test("task shard", (sub) => checkAmendmentUsesMain(sub, "plan/tasks.d/W1-T10581-fixture.yaml"));
  await t.test("inline task", (sub) => checkAmendmentUsesMain(sub, "plan/tasks.yaml"));
});

test("the fix scope writer retries a failed identity or base read before cutting its amendment", async (t) => {
  await t.test("identity read", (sub) => checkAmendmentUsesMain(sub, "plan/tasks.yaml", "identity"));
  await t.test("base read", (sub) => checkAmendmentUsesMain(sub, "plan/tasks.yaml", "base"));
});

async function checkAmendmentUsesMain(t: TestContext, planPath: string, readFault?: "identity" | "base") {
  const repo = gitRepo({ scope: t });
  repo.git("config", "user.name", "scope fixture");
  repo.git("config", "user.email", "scope@example.invalid");
  const taskId = "W1-T10581";
  const stale = `- id: ${taskId}\n  files: [src/fix.ts]\n`;
  const current = stale.replace("src/fix.ts", "src/fix.ts, src/from-main.ts");
  mkdirSync(join(repo.dir, dirname(planPath)), { recursive: true });
  mkdirSync(join(repo.dir, "src"));
  writeFileSync(join(repo.dir, planPath), stale);
  repo.git("add", planPath);
  repo.git("commit", "-qm", "file the task");
  const headSha = repo.git("rev-parse", "HEAD");
  writeFileSync(join(repo.dir, planPath), current);
  repo.git("commit", "-qam", "widen scope on main");
  const mainSha = repo.git("rev-parse", "HEAD");
  const mainRef = "refs/remotes/origin/main";
  repo.git("update-ref", mainRef, mainSha);
  repo.git("checkout", "--detach", headSha);

  const review: ReviewVerdict & { headSha: string; reviewerOutcome: "failure" } = {
    state: "failure", criteria: [{ claim: "repair", proof: "unit test: repair", met: false,
      reason: "broken", proof_exec: "not_executable" }],
    summary: "broken", testTheater: false, floorDegraded: false, capped: false, keywordOnly: false,
    planOnly: false, headSha, reviewerOutcome: "failure",
  };
  const mount = { model: "sonnet", effort: "medium", maxTurns: 20, contextBudget: 120000 } as const;
  const rows: Record<string, unknown>[] = [];
  let identityReads = 0;
  let amendmentCuts = 0;
  let amendedFiles: string[] | undefined;
  const result = await runFixRung({
    taskId, task: { id: taskId, title: "repair", files: ["src/fix.ts"] }, runId: "scope-fixture",
    prUrl: "https://github.com/acme/repo/pull/42", branch: `run-${taskId}-1`, worktreePath: repo.dir,
    initialSessionId: "initial", mount, settingsFile: join(repo.dir, "settings.json"),
    config: { root: repo.dir, workerProviders: { harnessCommitsFix: true } } as Config,
    budgetUsd: 10, strikeCap: 2, initialReview: review,
    reviewBase: { owner: "acme", repo: "repo", headCheckoutDir: repo.dir, reviewerMount: mount },
    deps: {
      spawn: async () => {
        writeFileSync(join(repo.dir, "src/needed.ts"), "needed repair\n");
        return {
          text: "FIX_OUTCOME: NEEDS_SCOPE src/needed.ts", blocks: [], sessionId: "fix", costUsd: 0,
          numTurns: 1, subtype: "success", isError: false, apiError: false, permissionDenials: [],
          childEnvKeys: [], tokens: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 },
          stderr: "", model: "sonnet", effort: "medium", compactionEvents: [], qualitySuspect: false,
          modelUsage: {}, provider: "codex",
        };
      },
      scopeAmendmentPortsIo: {
        worktreeAddFn: (_repo, wp, branch, base) => {
          amendmentCuts++;
          repo.addWorktree(wp, branch, base);
        },
        worktreeRemoveFn: (_repo, wp) => { repo.git("worktree", "remove", "--force", wp); },
        gitPushFn: (_wp, _branch, sha) => {
          assert.deepEqual(repo.git("diff", "--name-only", "origin/main", sha).split("\n"), [planPath]);
          amendedFiles = parse(repo.git("show", `${sha}:${planPath}`))[0].files;
        },
        probeExistingPlanPrFn: () => undefined,
        assertLiveWriteAllowedFn: () => {},
        createPlanPrRestFn: () => ({ prUrl: "https://github.com/acme/repo/pull/99", prNumber: 99 }),
      },
      fetchPrBody: async () => {
        identityReads++;
        if (readFault === "identity" && identityReads === 1) throw new Error("fixture body read failed");
        if (readFault === "base") {
          if (identityReads === 1) repo.git("update-ref", "-d", mainRef);
          else repo.git("update-ref", mainRef, mainSha);
        }
        return `Remudero-Task: ${taskId}`;
      },
      push: () => assert.fail("implementation must wait for the scope amendment"),
      waitForCiGreen: async () => assert.fail("no CI wait before scope merges"),
      runReview: async () => review,
      issues: { create: () => assert.fail("scope must not escalate"), listOpen: () => [], comment: () => {} },
      ledgerPath: join(repo.dir, "ledger.ndjson"), ledgerLines: () => rows,
      log: (step, extra) => { rows.push({ step, task_id: taskId, ...extra }); }, say: () => {}, account: (r) => r,
    },
  });

  assert.equal(result.reason, "awaiting scope amendment merge");
  assert.equal(amendmentCuts, 1);
  assert.deepEqual(amendedFiles, ["src/fix.ts", "src/from-main.ts", "src/needed.ts"]);
  const scopeRows = rows.filter((row) => row.step === "fix.scope_amendment" && row.outcome);
  if (readFault) {
    assert.deepEqual(scopeRows.map((row) => [row.outcome, row.reason, row.retry]), [
      ["refused", "scope-amendment-error", undefined], ["created", undefined, 1],
    ]);
    assert.match(String(scopeRows[0].detail), readFault === "identity" ? /fixture body read failed/ : /refs\/remotes\/origin\/main/);
  } else {
    assert.deepEqual(scopeRows.map((row) => [row.outcome, row.retry]), [["created", undefined]]);
  }
  assert.equal(rows.some((row) => row.step === "fix.commit_refused"), false);
}
