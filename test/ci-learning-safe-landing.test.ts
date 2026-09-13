import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import { CI_LEARNING_LANDING_BRANCH, landCiLearningShards } from "../src/lib/feedback-landing.js";
import { buildCiLearningCadenceRunner, ciLearningCommand } from "../src/run-task.js";
import {
  ciLearningRecordVerdict,
  ciLearningShardYaml,
  type CiLearningShardDraft,
} from "../src/lib/measurement-cadence.js";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env: GIT_ENV });
}

function makeBareOrigin(): string {
  const bare = mkdtempSync(join(tmpdir(), "rmd-ci-learning-landing-origin-"));
  execFileSync("git", ["init", "--quiet", "--bare", "-b", "main", bare], { encoding: "utf8", env: GIT_ENV });

  const seed = mkdtempSync(join(tmpdir(), "rmd-ci-learning-landing-seed-"));
  execFileSync("git", ["init", "--quiet", "-b", "main", seed], { encoding: "utf8", env: GIT_ENV });
  mkdirSync(join(seed, "plan"), { recursive: true });
  writeFileSync(join(seed, "README.md"), "seed\n");
  writeFileSync(join(seed, "plan", "tasks.yaml"), "[]\n");
  git(seed, "add", "-A");
  git(seed, "commit", "--quiet", "-m", "chore: seed");
  git(seed, "remote", "add", "origin", bare);
  git(seed, "push", "--quiet", "origin", "main");
  rmSync(seed, { recursive: true, force: true });
  return bare;
}

function cloneRoot(bareOrigin: string): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-ci-learning-landing-checkout-"));
  execFileSync("git", ["clone", "--quiet", bareOrigin, dir], { encoding: "utf8", env: GIT_ENV });
  return dir;
}

function stateRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "rmd-ci-learning-landing-state-"));
  mkdirSync(join(root, "state"), { recursive: true });
  return root;
}

function fakeGh(prUrl: string) {
  const calls: string[][] = [];
  let createCount = 0;
  const gh = (args: string[]): string => {
    calls.push(args);
    if (args[0] === "pr" && args[1] === "list") {
      return createCount > 0 ? JSON.stringify([{ url: prUrl }]) : JSON.stringify([]);
    }
    if (args[0] === "pr" && args[1] === "create") {
      createCount++;
      assert.ok(args.includes(CI_LEARNING_LANDING_BRANCH), "the CI-learning landing PR uses its dedicated branch");
      return `Creating pull request for ${CI_LEARNING_LANDING_BRANCH} into main\n${prUrl}\n`;
    }
    if (args[0] === "pr" && args[1] === "merge") return "";
    throw new Error(`unexpected gh call in test fixture: ${JSON.stringify(args)}`);
  };
  return { gh, calls, createCount: () => createCount };
}

function repairedWindow() {
  return {
    prs: [
      {
        number: 4321,
        commits: [
          { sha: "aaa1111", rollup: [{ name: "ci-gate", conclusion: "FAILURE" }], changedFiles: ["src/lib/x.ts"] },
          { sha: "bbb2222", rollup: [{ name: "ci-gate", conclusion: "SUCCESS" }], changedFiles: ["src/lib/x.ts"] },
        ],
      },
    ],
  } as never;
}

function draft(findingId = "ci-learning:4321:ci-gate"): CiLearningShardDraft {
  return {
    findingId,
    title: "teach the ci gate its repaired failure shape",
    gate: "ci-gate",
    pr: 4321,
    prs: [4321],
    repairFiles: ["src/lib/x.ts"],
    dominantRepairFiles: [{ file: "src/lib/x.ts", prs: 1 }],
    action: "gate",
    author_class: "machine",
    verify: "human",
    remedySurface: "test",
  };
}

function pendingFiles(root: string): string[] {
  const dir = join(root, "state", "ci-learning-pending", "plan", "tasks.d");
  if (!existsSync(dir)) return [];
  return execFileSync("find", [dir, "-type", "f", "-name", "*.yaml", "-print"], { encoding: "utf8" })
    .trim()
    .split("\n")
    .filter(Boolean);
}

function landingBranchFiles(bareOrigin: string): string[] {
  return execFileSync("git", ["--git-dir", bareOrigin, "ls-tree", "-r", "--name-only", CI_LEARNING_LANDING_BRANCH], {
    encoding: "utf8",
    env: GIT_ENV,
    stdio: ["ignore", "pipe", "ignore"],
  })
    .trim()
    .split("\n")
    .filter(Boolean);
}

test("W1-T3492 criterion 1: scheduled CI-learning stages outside the checkout and lands exact task bytes", async () => {
  const bareOrigin = makeBareOrigin();
  const checkout = cloneRoot(bareOrigin);
  const root = stateRoot();
  const { gh } = fakeGh("https://github.com/o/r/pull/3492");

  const run = buildCiLearningCadenceRunner({
    root,
    checkoutRoot: checkout,
    loadWindow: () => repairedWindow(),
    loadLessons: () => ({ status: "unreadable" }),
    planOrigins: [],
    mintTaskId: () => "W1-T9001",
    landShards: (drafts, checkoutRoot, deps) => landCiLearningShards(drafts, checkoutRoot, { ...deps, gh }),
    recordFire: () => {},
  });

  const result = await withLiveWritesAllowed(() => run());

  assert.equal(result.filedCount, 1, "the scheduled run reports the queued shard landed");
  assert.equal(git(checkout, "status", "--porcelain").trim(), "", "the daemon checkout remains clean");
  assert.equal(existsSync(join(checkout, "plan", "tasks.d")), false, "no task shard is written under the checkout");

  const staged = pendingFiles(root);
  assert.equal(staged.length, 1, "the durable state queue holds the staged bytes until main proves durability");
  const [relPath] = landingBranchFiles(bareOrigin).filter((f) => f.startsWith("plan/tasks.d/"));
  assert.ok(relPath, "the dedicated landing branch carries the generated task shard");
  const onBranch = execFileSync("git", ["--git-dir", bareOrigin, "show", `${CI_LEARNING_LANDING_BRANCH}:${relPath}`], {
    encoding: "utf8",
    env: GIT_ENV,
  });
  assert.equal(onBranch, readFileSync(staged[0]!, "utf8"), "the landing branch receives the exact staged bytes");
});

test("W1-T3492 criterion 2: pending CI-learning bytes survive transport failure, retry, and acknowledge only after merge", () => {
  const bareOrigin = makeBareOrigin();
  const checkout = cloneRoot(bareOrigin);
  const root = stateRoot();
  const { gh } = fakeGh("https://github.com/o/r/pull/3493");
  const failingPushGit = (args: string[], opts?: { env?: NodeJS.ProcessEnv }): string => {
    if (args[0] === "push") throw new Error("simulated push outage");
    return execFileSync("git", ["-C", checkout, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: opts?.env ?? GIT_ENV,
    });
  };

  const first = withLiveWritesAllowed(() =>
    landCiLearningShards([draft()], checkout, {
      stateRoot: root,
      mintTaskId: () => "W1-T9002",
      planOrigins: [],
      renderShard: ciLearningShardYaml,
      recordVerdict: ciLearningRecordVerdict,
      gh,
      git: failingPushGit,
    }),
  );
  assert.equal(first.filed.length, 0, "a failed landing transport reports zero filed work");
  assert.equal(pendingFiles(root).length, 1, "the staged shard remains retryable in daemon state");
  assert.throws(() => landingBranchFiles(bareOrigin), /Command failed: git/);

  const retry = withLiveWritesAllowed(() =>
    landCiLearningShards([], checkout, {
      stateRoot: root,
      mintTaskId: () => {
        throw new Error("retry must reuse the staged task id");
      },
      planOrigins: [],
      renderShard: ciLearningShardYaml,
      recordVerdict: ciLearningRecordVerdict,
      gh,
    }),
  );
  assert.equal(retry.filed.length, 1, "a later pass retries the pending staged bytes");
  assert.equal(pendingFiles(root).length, 1, "the queue is not deleted merely because the branch was pushed");

  execFileSync("git", ["--git-dir", bareOrigin, "update-ref", "refs/heads/main", `refs/heads/${CI_LEARNING_LANDING_BRANCH}`], {
    encoding: "utf8",
    env: GIT_ENV,
  });

  const afterMerge = withLiveWritesAllowed(() =>
    landCiLearningShards([], checkout, {
      stateRoot: root,
      mintTaskId: () => {
        throw new Error("acknowledgement must not mint");
      },
      planOrigins: [],
      renderShard: ciLearningShardYaml,
      recordVerdict: ciLearningRecordVerdict,
      gh,
    }),
  );
  assert.equal(afterMerge.filed.length, 0, "merged pending bytes need no new landing");
  assert.deepEqual(pendingFiles(root), [], "the queue is removed only after origin/main has the identical blob");
});

test("W1-T3492 criterion 3: a second scheduled firing reuses a pending finding instead of minting a duplicate id", async () => {
  const bareOrigin = makeBareOrigin();
  const checkout = cloneRoot(bareOrigin);
  const root = stateRoot();
  const { gh, createCount } = fakeGh("https://github.com/o/r/pull/3494");
  let minted = 0;
  const run = buildCiLearningCadenceRunner({
    root,
    checkoutRoot: checkout,
    loadWindow: () => repairedWindow(),
    loadLessons: () => ({ status: "unreadable" }),
    planOrigins: [],
    mintTaskId: () => `W1-T900${++minted}`,
    landShards: (drafts, checkoutRoot, deps) => landCiLearningShards(drafts, checkoutRoot, { ...deps, gh }),
    recordFire: () => {},
  });

  const first = await withLiveWritesAllowed(() => run());
  const second = await withLiveWritesAllowed(() => run());

  assert.equal(first.draftCount, 1, "control: the first firing drafts the lesson");
  assert.equal(second.draftCount, 0, "the pending queue participates in mint-time idempotency");
  assert.equal(minted, 1, "no second task id is consumed for the same pending finding");
  assert.equal(createCount(), 1, "the second pass reuses the existing landing PR");
  assert.equal(landingBranchFiles(bareOrigin).filter((f) => f.startsWith("plan/tasks.d/")).length, 1);
});

test("W1-T3492 criterion 4: manual ci-learning keeps the direct checkout writer while scheduled uses isolated landing", async () => {
  const scheduledBare = makeBareOrigin();
  const scheduledCheckout = cloneRoot(scheduledBare);
  const scheduledRoot = stateRoot();
  const { gh } = fakeGh("https://github.com/o/r/pull/3495");
  const scheduled = buildCiLearningCadenceRunner({
    root: scheduledRoot,
    checkoutRoot: scheduledCheckout,
    loadWindow: () => repairedWindow(),
    loadLessons: () => ({ status: "unreadable" }),
    planOrigins: [],
    mintTaskId: () => "W1-T9005",
    landShards: (drafts, checkoutRoot, deps) => landCiLearningShards(drafts, checkoutRoot, { ...deps, gh }),
    recordFire: () => {},
  });
  await withLiveWritesAllowed(() => scheduled());
  assert.equal(git(scheduledCheckout, "status", "--porcelain").trim(), "", "scheduled filing reaches only the isolated landing path");

  const manualBare = makeBareOrigin();
  const manualCheckout = cloneRoot(manualBare);
  const manualRoot = stateRoot();
  const code = ciLearningCommand(["--force"], {
    root: manualRoot,
    checkoutRoot: manualCheckout,
    loadWindow: () => repairedWindow(),
    planOrigins: [],
  });

  assert.equal(code, 0, "the manual operator command still succeeds");
  const manualStatus = git(manualCheckout, "status", "--porcelain");
  assert.match(manualStatus, /\?\? plan\/tasks\.d\//, "the manual verb retains its direct checkout-writing behavior");
  assert.equal(existsSync(join(manualRoot, "state", "ci-learning-pending")), false, "manual filing does not use the daemon staging queue");
});
