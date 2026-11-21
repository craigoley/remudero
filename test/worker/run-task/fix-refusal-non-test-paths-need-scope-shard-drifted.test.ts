import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { parse } from "yaml";
import { runFixRung } from "#src/cli/commands/fix.js";
import type { Config } from "#src/lib/config.js";
import type { ReviewVerdict } from "#src/lib/review.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { fixCommandHost } from "#test/helpers/run-task-test.js";

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
  const remote = gitRepo({ scope: t, bare: true });
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
  repo.addRemote("origin", remote.dir);
  repo.git("push", "origin", "main");
  const advances = ["src/first-advance.ts", "src/second-advance.ts"].map((path) => {
    writeFileSync(join(repo.dir, planPath), current.replace("src/from-main.ts", `src/from-main.ts, ${path}`));
    repo.git("commit", "-qam", `grant ${path} on main`);
    return repo.git("rev-parse", "HEAD");
  });
  repo.git("push", "origin", "main:refs/heads/prepared-advances");
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
  let probes = 0;
  let amendmentBase: string | undefined;
  let workerRounds = 0;
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
        workerRounds++;
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
        gitPushFn: (_wp, _branch, sha) => {
          assert.deepEqual(repo.git("diff", "--name-only", "origin/main", sha).split("\n"), [planPath]);
          amendmentBase = repo.git("rev-parse", `${sha}^`);
          amendedFiles = parse(repo.git("show", `${sha}:${planPath}`))[0].files;
        },
        probeExistingPlanPrFn: () => {
          if (!readFault) {
            // The local tracking ref still names the previous shard until real worktreeAdd fetches.
            assert.equal(repo.git("rev-parse", "origin/main"), probes === 0 ? mainSha : advances[probes - 1]);
            remote.git("update-ref", "refs/heads/main", advances[probes]);
          }
          probes++;
          return undefined;
        },
        assertLiveWriteAllowedFn: () => {},
        createPlanPrRestFn: () => ({ prUrl: "https://github.com/acme/repo/pull/99", prNumber: 99 }),
      },
      fetchPrBody: async () => {
        identityReads++;
        if (readFault === "identity" && identityReads === 1) throw new Error("fixture body read failed");
        if (readFault === "base") {
          repo.git("remote", "set-url", "origin", identityReads === 1 ? join(remote.dir, "missing-origin") : remote.dir);
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
  }, fixCommandHost());

  assert.equal(result.reason, "awaiting scope amendment merge", JSON.stringify(rows.filter((row) =>
    row.step === "fix.scope_amendment" || row.step === "fix.commit_refused")));
  assert.equal(workerRounds, 1);
  const cuts = rows.filter((row) => row.step === "worktree.add");
  assert.equal(cuts.length, 1);
  assert.equal(existsSync(String(cuts[0].worktreePath)), false);
  assert.equal(amendmentBase, readFault ? mainSha : advances[0]);
  assert.deepEqual(amendedFiles, ["src/fix.ts", "src/from-main.ts", ...(!readFault ? ["src/first-advance.ts"] : []), "src/needed.ts"]);
  const scopeRows = rows.filter((row) => row.step === "fix.scope_amendment" && row.outcome);
  if (readFault) {
    assert.deepEqual(scopeRows.map((row) => [row.outcome, row.reason, row.retry]), [
      ["refused", "scope-amendment-error", undefined], ["created", undefined, 1],
    ]);
    assert.match(String(scopeRows[0].detail), readFault === "identity" ? /fixture body read failed/ : /missing-origin/);
  } else {
    assert.equal(probes, 1);
    assert.deepEqual(scopeRows.map((row) => [row.outcome, row.retry]), [["created", undefined]]);
  }
  assert.equal(rows.some((row) => row.step === "fix.commit_refused"), false);
}
