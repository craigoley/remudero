import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { commitWorkerEdits, FixRoundPushError, harnessCommitForShellLessWorker, pushFixRound, runFixRung } from "./helpers/run-task-test.js";
import type { Config } from "../src/lib/config.js";
import type { WorkerResult } from "../src/lib/worker.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import { gitRepo } from "./helpers/git-repo.js";

const branch = "run-W1-T4072-1";
const ref = `refs/heads/${branch}`;
const message = "fix(runner): save the round";
type Row = { step: string } & Record<string, unknown>;

function fixture() {
  const repo = gitRepo({ branch });
  repo.git("config", "user.name", "round fixture");
  repo.git("config", "user.email", "round@remudero.invalid");
  writeFileSync(join(repo.dir, "declared.txt"), "before\n");
  for (let i = 0; i < 37; i++) writeFileSync(join(repo.dir, `other-${i}.txt`), "old\n");
  repo.git("add", "-A");
  repo.git("commit", "-qm", "seed");
  const priorHeadSha = repo.git("rev-parse", "HEAD");
  repo.git("update-ref", "refs/remotes/origin/main", priorHeadSha);
  return { repo, priorHeadSha };
}

test("W1-T4072: a branch moved during the round refuses the commit and names both heads", () => {
  const { repo, priorHeadSha } = fixture();
  const operator = repo.addWorktree(join(repo.dir, "operator"), "operator");
  operator.git("commit", "--allow-empty", "-qm", "operator moved");
  const movedSha = operator.git("rev-parse", "HEAD");
  operator.git("symbolic-ref", "HEAD", ref);
  writeFileSync(join(repo.dir, "declared.txt"), "fixed\n");
  const rows: Row[] = [];
  const count = harnessCommitForShellLessWorker({
    harnessOwnsGit: true, commitCount: 0, worktreePath: repo.dir,
    report: `COMMIT_MESSAGE: ${message}`, declaredPaths: ["declared.txt"],
    priorHeadSha, branch, log: (step, extra) => rows.push({ step, ...extra }), say: () => {},
  }, {
    commit: (dir, paths, msg, _deps, acceptance, options) => commitWorkerEdits(dir, paths, msg, {
      runGit: (args) => {
        if (args[0] === "update-ref") repo.git("update-ref", ref, movedSha, priorHeadSha);
        return execFileSync("git", ["-C", repo.dir, ...args], { encoding: "utf8" });
      },
    }, acceptance, options),
    ahead: () => 1,
  });
  assert.equal(count, 0);
  assert.equal(repo.git("rev-parse", "HEAD"), movedSha);
  const row = rows.find((r) => r.step === "fix.head_moved_under_round");
  assert.equal(row?.prior_head_sha, priorHeadSha);
  assert.equal(row?.observed_head_sha, movedSha);
  assert.deepEqual(row?.other_worktrees, [operator.dir]);
  assert.equal(readFileSync(join(repo.dir, "declared.txt"), "utf8"), "fixed\n");
});

test("W1-T4072: a stale index never enters the commit tree", () => {
  const { repo, priorHeadSha: oldSha } = fixture();
  for (let i = 0; i < 37; i++) writeFileSync(join(repo.dir, `other-${i}.txt`), "main advanced\n");
  repo.git("add", "-A");
  repo.git("commit", "-qm", "main advanced");
  const priorHeadSha = repo.git("rev-parse", "HEAD");
  repo.git("read-tree", oldSha);
  writeFileSync(join(repo.dir, "declared.txt"), "fixed\n");
  const index = readFileSync(repo.git("rev-parse", "--path-format=absolute", "--git-path", "index"));
  const result = commitWorkerEdits(repo.dir, ["declared.txt"], message, {}, [], { priorHeadSha, branch });
  assert.equal(result.committed, true);
  assert.equal(repo.git("rev-parse", "HEAD^"), priorHeadSha);
  assert.equal(repo.git("diff", "--name-only", priorHeadSha, "HEAD"), "declared.txt");
  for (let i = 0; i < 37; i++) assert.equal(repo.git("show", `HEAD:other-${i}.txt`), "main advanced");
  assert.deepEqual(readFileSync(repo.git("rev-parse", "--path-format=absolute", "--git-path", "index")), index);
});

test("W1-T4072: an unmoved branch commits exactly the declared paths", () => {
  const { repo, priorHeadSha } = fixture();
  writeFileSync(join(repo.dir, "declared.txt"), "fixed\n");
  writeFileSync(join(repo.dir, "new.txt"), "new\n");
  repo.git("rm", "other-0.txt");
  writeFileSync(join(repo.dir, "other-1.txt"), "undeclared staged\n");
  repo.git("add", "other-1.txt");
  const result = commitWorkerEdits(repo.dir, ["declared.txt", "new.txt", "other-0.txt"], message, {}, [], { priorHeadSha, branch });
  assert.equal(result.committed, true);
  assert.equal(result.sha, repo.git("rev-parse", "HEAD"));
  assert.equal(repo.git("rev-parse", "HEAD^"), priorHeadSha);
  assert.deepEqual(repo.git("diff", "--name-only", priorHeadSha, "HEAD").split("\n"), ["declared.txt", "new.txt", "other-0.txt"]);
  assert.equal(repo.git("show", "HEAD:other-1.txt"), "old");
  assert.deepEqual(result.undeclared, ["other-1.txt"]);
});

test("W1-T4072: a branch already moved refuses before staging", () => {
  const { repo, priorHeadSha } = fixture();
  repo.git("commit", "--allow-empty", "-qm", "concurrent writer");
  const moved = repo.git("rev-parse", "HEAD");
  writeFileSync(join(repo.dir, "declared.txt"), "fixed\n");
  const result = commitWorkerEdits(repo.dir, ["declared.txt"], message, {}, [], { priorHeadSha });
  assert.equal(result.committed, false);
  assert.equal(result.headMoved?.prior_head_sha, priorHeadSha);
  assert.equal(result.headMoved?.observed_head_sha, moved);
  assert.deepEqual(result.headMoved?.other_worktrees, []);
  assert.equal(repo.git("rev-parse", "HEAD"), moved);
});

test("W1-T4072: a stale index cannot manufacture an empty fix", () => {
  const { repo, priorHeadSha } = fixture();
  writeFileSync(join(repo.dir, "declared.txt"), "staged residue\n");
  repo.git("add", "declared.txt");
  writeFileSync(join(repo.dir, "declared.txt"), "before\n");
  const result = commitWorkerEdits(repo.dir, ["declared.txt"], message, {}, [], { priorHeadSha, branch });
  assert.equal(result.committed, false);
  assert.equal(result.reason, "the worker changed nothing");
  assert.equal(repo.git("rev-parse", "HEAD"), priorHeadSha);
});

test("W1-T4072: a removed branch is named as absent and never recreated", () => {
  const { repo, priorHeadSha } = fixture();
  repo.git("update-ref", "-d", ref);
  writeFileSync(join(repo.dir, "declared.txt"), "fixed\n");
  const result = commitWorkerEdits(repo.dir, ["declared.txt"], message, {}, [], { priorHeadSha, branch });
  assert.equal(result.committed, false);
  assert.equal(result.headMoved?.prior_head_sha, priorHeadSha);
  assert.equal(result.headMoved?.observed_head_sha, "<absent>");
  assert.equal(repo.git("for-each-ref", "--format=%(refname)", ref), "");
});

test("W1-T4072: a ref lock failure is preserved when the branch did not move", () => {
  const { repo, priorHeadSha } = fixture();
  writeFileSync(join(repo.dir, "declared.txt"), "fixed\n");
  const failure = new Error("ref lock is held");
  assert.throws(() => commitWorkerEdits(repo.dir, ["declared.txt"], message, {
    runGit: (args) => {
      if (args[0] === "update-ref") throw failure;
      return execFileSync("git", ["-C", repo.dir, ...args], { encoding: "utf8" });
    },
  }, [], { priorHeadSha, branch }), (error) => error === failure);
  assert.equal(repo.git("rev-parse", "HEAD"), priorHeadSha);
});

test("W1-T4072: an elided lease is refused when the remote postcondition disagrees", async () => {
  const { repo, priorHeadSha } = fixture();
  const observed = "f".repeat(40);
  const calls: string[][] = [];
  await assert.rejects(() => withLiveWritesAllowed(() => pushFixRound(repo.dir, branch, priorHeadSha, priorHeadSha, {
    exec: (_file, args) => { calls.push(args); },
    capture: (_file, args) => args.includes("ls-remote") ? `${observed}\t${ref}\n` : priorHeadSha,
  })), (error) => error instanceof FixRoundPushError && error.detail.includes(observed));
  assert.deepEqual(calls, [["-C", repo.dir, "push", `--force-with-lease=${ref}:${priorHeadSha}`, "origin", `${priorHeadSha}:${ref}`]]);
});

test("W1-T4072: a lease without the committed sha refuses before pushing", async () => {
  const { repo, priorHeadSha } = fixture();
  let pushes = 0;
  await assert.rejects(() => pushFixRound(repo.dir, branch, undefined, priorHeadSha, {
    exec: () => { pushes++; },
  }), (error) => error instanceof FixRoundPushError && error.detail.includes("without the committed head sha"));
  assert.equal(pushes, 0);
});

function fixFixture() {
  const { repo, priorHeadSha } = fixture();
  const origin = gitRepo({ bare: true });
  repo.addRemote("origin", origin.dir);
  repo.git("push", "-q", "origin", `${priorHeadSha}:${ref}`);
  const rows: Row[] = [];
  const review = { state: "failure" as const, headSha: priorHeadSha, reviewerOutcome: "failure",
    criteria: [], testTheater: false, summary: "repair needed", floorDegraded: false, capped: false,
    keywordOnly: false, planOnly: false };
  const mount = { model: "sonnet", effort: "medium", maxTurns: 10, contextBudget: 120000 };
  const worker: WorkerResult = { sessionId: "fix", costUsd: 0, numTurns: 1,
    text: `REPORT\nCOMMIT_MESSAGE: ${message}`, blocks: [], stderr: "", subtype: "success",
    isError: false, apiError: false, permissionDenials: [], childEnvKeys: [], model: "test", effort: "test",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, modelUsage: {}, compactionEvents: [], qualitySuspect: false };
  let waits = 0;
  let pushes = 0;
  const run: Parameters<typeof runFixRung>[0] = { guardRoundHead: true, taskId: "W1-T4072", runId: "moved-push",
    task: { id: "W1-T4072", title: "repair", files: ["declared.txt"] },
    prUrl: "https://github.com/acme/remudero/pull/4072", branch, worktreePath: repo.dir, initialSessionId: "fix",
    mount, settingsFile: join(repo.dir, "settings.json"),
    config: { root: repo.dir, workerProviders: { harnessCommitsFix: true } } as Config,
    budgetUsd: 5, strikeCap: 1, initialReview: review,
    reviewBase: { owner: "acme", repo: "remudero", headCheckoutDir: repo.dir, reviewerMount: mount },
    escalationJudge: async () => ({ decision: "deliver", reason: "test" }),
    deps: {
      spawn: async () => { writeFileSync(join(repo.dir, "declared.txt"), "fixed\n"); return worker; },
      waitForCiGreen: async () => { waits++; return "green"; },
      runReview: async () => ({ ...review, state: "success" }), fetchPrBody: async () => "REPORT",
      push: async (wt, br, sha, prior) => {
        pushes++;
        await withLiveWritesAllowed(() => pushFixRound(wt, br, sha, prior));
      },
      issues: { create: () => "https://github.com/acme/remudero/issues/1", listOpen: () => [], comment: () => {} },
      ledgerPath: join(repo.dir, "ledger.ndjson"), log: (step, extra) => rows.push({ step, ...extra }),
      say: () => {}, account: (r) => r,
    },
  };
  return { repo, priorHeadSha, origin, rows, run, worker, counts: () => ({ waits, pushes }) };
}

test("W1-T4072: a refused push is ledgered not swallowed", async () => {
  const f = fixFixture();
  const { repo, priorHeadSha, origin, rows } = f;
  let pushedPrior: string | undefined;
  f.run.deps.push = async (wt, br, sha, prior) => {
    pushedPrior = prior;
    const moved = repo.git("commit-tree", repo.git("rev-parse", `${priorHeadSha}^{tree}`), "-p", priorHeadSha, "-m", "remote advanced");
    repo.git("push", "-q", "origin", `${moved}:${ref}`);
    await withLiveWritesAllowed(() => pushFixRound(wt, br, sha, prior));
  };
  const result = await runFixRung(f.run);
  assert.equal(pushedPrior, priorHeadSha);
  assert.equal(result.outcome, "stood_down");
  assert.equal(f.counts().waits, 0);
  const failed = rows.find((r) => r.step === "fix.push_failed");
  assert.equal(failed?.pr_head_sha, priorHeadSha);
  assert.match(String(failed?.error), /stale info|rejected|refused/);
  assert.notEqual(origin.git("rev-parse", ref), repo.git("rev-parse", "HEAD"));
});

test("W1-T4072: an unchanged round lands its exact commit under the recorded lease", async () => {
  const f = fixFixture();
  const result = await runFixRung(f.run);
  assert.equal(result.outcome, "fixed");
  assert.deepEqual(f.counts(), { waits: 1, pushes: 1 });
  const committed = f.rows.find((r) => r.step === "implement.harness_commit")?.sha;
  assert.equal(f.origin.git("rev-parse", ref), committed);
  assert.equal(f.repo.git("rev-parse", "HEAD^"), f.priorHeadSha);
  assert.equal(f.repo.git("diff", "--name-only", f.priorHeadSha, "HEAD"), "declared.txt");
});

test("W1-T4072: a moved round stands down without claiming the foreign commit", async () => {
  const f = fixFixture();
  let moved: string;
  f.run.deps.spawn = async () => {
    f.repo.git("commit", "--allow-empty", "-qm", "concurrent writer");
    moved = f.repo.git("rev-parse", "HEAD");
    writeFileSync(join(f.repo.dir, "declared.txt"), "fixed\n");
    return f.worker;
  };
  const result = await runFixRung(f.run);
  assert.equal(result.outcome, "stood_down");
  assert.deepEqual(f.counts(), { waits: 0, pushes: 0 });
  const row = f.rows.find((r) => r.step === "fix.head_moved_under_round");
  assert.equal(row?.prior_head_sha, f.priorHeadSha);
  assert.equal(row?.observed_head_sha, moved!);
  assert.equal(f.rows.find((r) => r.step === "fix.done")?.subtype, "commit_refused");
  assert.equal(f.repo.git("rev-parse", "HEAD"), moved!);
});

test("W1-T4072: a head moved after the harness commit is refused by the push", async () => {
  const f = fixFixture();
  f.run.deps.readRoundCommits = async () => {
    f.repo.git("commit", "--allow-empty", "-qm", "concurrent writer");
    return [];
  };
  const result = await runFixRung(f.run);
  assert.equal(result.outcome, "stood_down");
  assert.equal(f.counts().waits, 0);
  const committed = f.rows.find((r) => r.step === "implement.harness_commit")?.sha;
  assert.equal(f.rows.find((r) => r.step === "fix.push_failed")?.head_sha, committed);
  assert.equal(f.origin.git("rev-parse", ref), f.priorHeadSha);
});
