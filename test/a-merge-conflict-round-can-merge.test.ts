import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
  harnessCommitForShellLessWorker,
  renderFixPrompt,
  runFixRung,
  startHarnessMergeForConflict,
} from "../src/run-task.js";
import { fixWorkerTools } from "../src/lib/fix-fence.js";
import type { Config } from "../src/lib/config.js";
import type { Mount } from "../src/lib/mounts.js";
import type { CriterionVerdict, ReviewVerdict } from "../src/lib/review.js";
import type { WorkerResult } from "../src/lib/worker.js";
import { gitRepo } from "./helpers/git-repo.js";

const MOUNT: Mount = { model: "sonnet", effort: "medium", maxTurns: 20, contextBudget: 20_000 };

function workerResult(text: string): WorkerResult {
  return {
    sessionId: "merge-fix-session",
    costUsd: 0,
    numTurns: 1,
    text,
    blocks: [],
    stderr: "",
    subtype: "success",
    isError: false,
    apiError: false,
    permissionDenials: [],
    childEnvKeys: [],
    model: "sonnet",
    effort: "medium",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    modelUsage: {},
    compactionEvents: [],
    qualitySuspect: false,
  };
}

function failedReview(): ReviewVerdict & { headSha: string; reviewerOutcome: string } {
  const criterion: CriterionVerdict = {
    claim: "the conflict is resolved",
    proof: "unit test: the conflict is resolved",
    met: false,
    reason: "conflict remains",
    proof_exec: "not_executable",
  };
  return {
    state: "failure",
    criteria: [criterion],
    testTheater: false,
    summary: "conflict remains",
    floorDegraded: false,
    capped: false,
    keywordOnly: false,
    planOnly: false,
    headSha: "head-before",
    reviewerOutcome: "failure",
  };
}

function passedReview(): ReviewVerdict & { headSha: string; reviewerOutcome: string } {
  return {
    state: "success",
    criteria: [{ claim: "the conflict is resolved", proof: "unit test: the conflict is resolved", met: true, reason: "passed", proof_exec: "executed_pass" }],
    testTheater: false,
    summary: "resolved",
    floorDegraded: false,
    capped: false,
    keywordOnly: false,
    planOnly: false,
    headSha: "head-after",
    reviewerOutcome: "success",
  };
}

function conflictFixture() {
  const origin = gitRepo({ bare: true, kind: "W1-T4458-origin" });
  const source = gitRepo({ kind: "W1-T4458-source" });
  source.addRemote("origin", origin.dir);
  writeFileSync(join(source.dir, "README.md"), "base\n");
  source.git("add", "README.md");
  source.git("commit", "-m", "seed README");
  source.git("push", "origin", "main");

  const local = gitRepo({ cloneFrom: origin.dir, kind: "W1-T4458-local" });
  local.git("switch", "-c", "feature");
  writeFileSync(join(local.dir, "README.md"), "feature side\n");
  local.git("add", "README.md");
  local.git("commit", "-m", "feature side");

  writeFileSync(join(source.dir, "README.md"), "main side\n");
  source.git("add", "README.md");
  source.git("commit", "-m", "main side");
  source.git("push", "origin", "main");
  local.git("fetch", "origin");
  local.git("config", "user.name", "W1-T4458 fixture");
  local.git("config", "user.email", "w1-t4458@example.test");

  return { local, origin, source };
}

test("W1-T4458: the harness starts the merge a shell-less conflict round resolves", () => {
  const fixture = conflictFixture();
  try {
    const merge = startHarnessMergeForConflict(fixture.local.dir);
    assert.equal(merge.outcome, "conflicted");
    assert.deepEqual(merge.unresolvedPaths, ["README.md"]);
    assert.match(fixture.local.git("status", "--porcelain"), /UU README\.md/);

    const tools = fixWorkerTools(true);
    assert.ok(!tools.includes("Bash"), "the harness-owned round must not expose Bash");
    assert.deepEqual(fixWorkerTools(false), ["Read", "Write", "Edit", "Grep", "Glob", "Bash"]);
    const prompt = renderFixPrompt({
      harnessCommits: true,
      task: { id: "W1-T4458", title: "merge conflict" },
      round: 1,
      branch: "run-W1-T4458-1",
      evidence: {
        mergeConflict: {
          files: [{ path: "README.md", oursDeleted: 0, theirsDeleted: 0 }],
          oursLog: "feature side",
          theirsLog: "main side",
        },
      },
    });
    assert.match(prompt, /Do NOT run git or gh/);
    assert.match(prompt, /you have no shell on this round/);
  } finally {
    fixture.local.cleanup();
    fixture.source.cleanup();
    fixture.origin.cleanup();
  }
});

test("W1-T4458: a commit the worker made is pushed, not discarded", () => {
  const fixture = conflictFixture();
  try {
    assert.equal(startHarnessMergeForConflict(fixture.local.dir).outcome, "conflicted");
    writeFileSync(join(fixture.local.dir, "README.md"), "resolved union\n");

    const committedAhead = harnessCommitForShellLessWorker({
      harnessOwnsGit: true,
      commitCount: 0,
      report: "REPORT\nCOMMIT_MESSAGE: fix(merge): resolve the conflict",
      worktreePath: fixture.local.dir,
      declaredPaths: ["README.md"],
      log: () => {},
      say: () => {},
    });
    assert.ok(committedAhead > 0, "the harness must observe the worker's merge commit ahead of main");

    const localHead = fixture.local.git("rev-parse", "HEAD");
    fixture.local.git("push", "origin", "HEAD:feature");
    assert.equal(fixture.origin.git("rev-parse", "refs/heads/feature"), localHead);
  } finally {
    fixture.local.cleanup();
    fixture.source.cleanup();
    fixture.origin.cleanup();
  }
});

test("W1-T4458: the fix rung wires the harness merge before the worker", async () => {
  const snapshot = { status: "", diff: "", untrackedHash: "clean" };
  const mergeCalls: string[] = [];
  const spawnedTools: string[][] = [];
  const pushed: string[] = [];
  const outcome = await runFixRung({
    taskId: "W1-T4458",
    runId: "W1-T4458-run",
    task: { id: "W1-T4458", title: "merge conflict", files: ["README.md"] },
    prUrl: "https://github.com/acme/remudero/pull/4458",
    branch: "run-W1-T4458-1",
    worktreePath: process.cwd(),
    initialSessionId: "merge-fix-session",
    mount: MOUNT,
    settingsFile: "/tmp/w1-t4458-settings.json",
    config: { workerProviders: { harnessCommitsFix: true } } as Config,
    budgetUsd: 1,
    strikeCap: 1,
    initialReview: failedReview(),
    mergeConflict: {
      files: [{ path: "README.md", oursDeleted: 0, theirsDeleted: 0 }],
      oursLog: "feature side",
      theirsLog: "main side",
    },
    birthWorktreeSnapshot: snapshot,
    reviewBase: { owner: "acme", repo: "remudero", headCheckoutDir: process.cwd(), reviewerMount: MOUNT },
    deps: {
      spawn: async (args) => {
        spawnedTools.push(args.tools ?? []);
        return workerResult("REPORT\nCOMMIT_MESSAGE: fix(merge): resolve conflict");
      },
      startHarnessMergeForConflict: (path) => {
        mergeCalls.push(path);
        return { outcome: "conflicted", unresolvedPaths: ["README.md"] };
      },
      captureWorktreeSnapshot: () => snapshot,
      harnessCommitForShellLessWorker: () => 1,
      waitForCiGreen: async () => "green",
      runReview: async () => passedReview(),
      push: (_path, branch) => pushed.push(branch),
      issues: { create: () => "https://github.com/acme/remudero/issues/4458" },
      ledgerPath: "/tmp/w1-t4458-ledger.ndjson",
      log: () => {},
      say: () => {},
      account: (result) => result,
    },
  });
  assert.equal(outcome.outcome, "fixed");
  assert.deepEqual(mergeCalls, [process.cwd()]);
  assert.ok(spawnedTools.every((tools) => !tools.includes("Bash")), "the harness-owned worker is shell-less");
  assert.deepEqual(pushed, ["run-W1-T4458-1"]);
});

test("W1-T4458: an unrelated merge failure is not mistaken for a conflict", () => {
  assert.throws(
    () => startHarnessMergeForConflict("/worktree", {
      runGit: (args) => {
        if (args.includes("merge")) throw new Error("origin/main is unreadable");
        return "";
      },
    }),
    /harness merge failed without unresolved paths: origin\/main is unreadable/,
  );
});

test("W1-T4458: an unreadable conflict state remains a named merge failure", () => {
  assert.throws(
    () => startHarnessMergeForConflict("/worktree", {
      runGit: (args) => {
        if (args.includes("merge")) throw new Error("merge exited 1");
        throw new Error("status read failed");
      },
    }),
    /harness merge failed and conflict state could not be read: merge=merge exited 1; state=status read failed/,
  );
});
