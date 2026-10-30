import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { harnessCommitForShellLessWorker, runFixRung } from "#test/helpers/run-task-test.js";
import { commitWorkerEdits } from "#test/helpers/run-task-commit-seam.js";
import { GIT_REPO_FIXTURE_IDENTITY, gitRepo } from "#test/helpers/git-repo.js";
import type { Config } from "#src/lib/config.js";
import type { Mount } from "#src/lib/mounts.js";
import type { ReviewVerdict } from "#src/lib/review.js";
import type { WorkerResult } from "#src/lib/worker.js";

function fixture(t: TestContext) {
  const repo = gitRepo({ scope: t, kind: "empty-fix-surface" });
  repo.git("config", "user.name", GIT_REPO_FIXTURE_IDENTITY.name);
  repo.git("config", "user.email", GIT_REPO_FIXTURE_IDENTITY.email);
  mkdirSync(join(repo.dir, "scripts"));
  writeFileSync(join(repo.dir, "README.md"), "before\n");
  writeFileSync(join(repo.dir, "scripts/source-size-baseline.json"), "{}\n");
  repo.git("add", "--", "README.md", "scripts/source-size-baseline.json");
  repo.git("commit", "-qm", "seed generated baseline");
  writeFileSync(join(repo.dir, "README.md"), "unrelated unpublished edit\n");
  return repo;
}

test("W1-T10722: fix-lane-commit-refused-the-task-declares-no-files-so-there-is-no-surface-to-stage clears without a person", async t => {
  const repo = fixture(t);
  const mount: Mount = { model: "sonnet", effort: "medium", maxTurns: 20, contextBudget: 120000 };
  const review: ReviewVerdict & { headSha: string; reviewerOutcome: string } = {
    state: "failure", criteria: [{ claim: "repair the check", proof: "unit test: repair the check",
      met: false, reason: "still failing", proof_exec: "not_executable" }],
    testTheater: false, summary: "still failing", floorDegraded: false, capped: false,
    keywordOnly: false, planOnly: false, headSha: repo.git("rev-parse", "HEAD"), reviewerOutcome: "failure",
  };
  const worker: WorkerResult = {
    sessionId: "writer-session", costUsd: 0, numTurns: 1,
    text: "REPORT\nCOMMIT_MESSAGE: fix(worker): repair admitted surfaces", blocks: [], stderr: "",
    subtype: "success", isError: false, apiError: false, permissionDenials: [], childEnvKeys: [],
    model: "sonnet", effort: "medium", tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    modelUsage: {}, compactionEvents: [], qualitySuspect: false,
  };
  let dispatched = 0;
  let pushed = 0;
  const outcome = await runFixRung({
    taskId: "W1-T10722", runId: "W1-T10722-fixture",
    task: { id: "W1-T10722", title: "repair the check", files: [] },
    prUrl: "https://github.com/acme/remudero/pull/10722", branch: "main",
    worktreePath: repo.dir, initialSessionId: "", mount, settingsFile: join(repo.dir, "settings.json"),
    config: { root: repo.dir, workerProviders: { harnessCommitsFix: true } } as Config,
    budgetUsd: 10, strikeCap: 1, initialReview: review,
    escalationJudge: async () => { throw new Error("must not ask an operator"); },
    reviewBase: { owner: "acme", repo: "remudero", headCheckoutDir: repo.dir, reviewerMount: mount },
    deps: {
      spawn: async () => {
        dispatched++;
        mkdirSync(join(repo.dir, "test"));
        writeFileSync(join(repo.dir, "test/repair.test.ts"), "export {};\n");
        writeFileSync(join(repo.dir, "scripts/source-size-baseline.json"), '{"repaired": true}\n');
        return worker;
      },
      push: () => { pushed++; }, waitForCiGreen: async () => "green",
      runReview: async () => ({ ...review, state: "success" }),
      fetchPrBody: async () => "REPORT\nRemudero-Task: W1-T10722",
      fetchPrDiffFiles: async () => [],
      issues: { create: () => { throw new Error("must not ask an operator"); }, listOpen: () => [], comment: () => {} },
      ledgerPath: join(repo.dir, "ledger.ndjson"), log: () => {}, say: () => {}, account: value => value,
      readHeadShaForProvenance: () => review.headSha, commitsAhead: () => 0,
      worktreeHasUncommittedChanges: () => true,
      harnessCommitForShellLessWorker: input => {
        assert.deepEqual(input.declaredPaths, []);
        assert.equal(input.admitTests, true);
        return harnessCommitForShellLessWorker(input);
      },
    },
  });
  assert.equal(outcome.outcome, "fixed");
  assert.equal(dispatched, 1);
  assert.equal(pushed, 1);
  assert.equal(repo.git("show", "HEAD:test/repair.test.ts"), "export {};");
  assert.equal(repo.git("show", "HEAD:scripts/source-size-baseline.json"), '{"repaired": true}');
  assert.equal(repo.git("show", "HEAD:README.md"), "before");
  assert.equal(readFileSync(join(repo.dir, "README.md"), "utf8"), "unrelated unpublished edit\n");
});

test("empty-scope fix rounds can commit a generated repair without a test edit", t => {
  const repo = fixture(t);
  writeFileSync(join(repo.dir, "scripts/source-size-baseline.json"), '{"repaired": true}\n');
  const result = commitWorkerEdits(repo.dir, [], "fix(worker): repair generated baseline", {}, [], { admitTests: true });
  assert.equal(result.committed, true);
  assert.deepEqual(result.regenerable, ["scripts/source-size-baseline.json"]);
  assert.deepEqual(result.undeclared, ["README.md"]);
  assert.equal(repo.git("show", "HEAD:scripts/source-size-baseline.json"), '{"repaired": true}');
  assert.equal(repo.git("show", "HEAD:README.md"), "before");
});

test("empty-scope fix rounds refuse unrelated edits without staging them", t => {
  const repo = fixture(t);
  const before = repo.git("rev-parse", "HEAD");
  const result = commitWorkerEdits(repo.dir, [], "fix(worker): reject unrelated edit", {}, [], { admitTests: true });
  assert.equal(result.committed, false);
  assert.deepEqual(result.undeclared, ["README.md"]);
  assert.match(result.reason!, /outside its declared files/);
  assert.equal(repo.git("rev-parse", "HEAD"), before);
  assert.equal(repo.git("diff", "--cached", "--name-only"), "");
});

test("ordinary empty-scope tasks still refuse admitted repair surfaces", t => {
  const repo = fixture(t);
  writeFileSync(join(repo.dir, "scripts/source-size-baseline.json"), '{"repaired": true}\n');
  const before = repo.git("rev-parse", "HEAD");
  const result = commitWorkerEdits(repo.dir, [], "fix(worker): reject unpermitted repair");
  assert.equal(result.committed, false);
  assert.match(result.reason!, /declares no files/);
  assert.equal(repo.git("rev-parse", "HEAD"), before);
  assert.equal(repo.git("diff", "--cached", "--name-only"), "");
});
