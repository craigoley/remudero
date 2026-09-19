import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import { gitRepo } from "./helpers/git-repo.js";
import {
  CI_LEARNING_LANDING_BRANCH,
  ciLearningPendingOrigins,
  landCiLearningShards,
  landingIdentity,
} from "../src/lib/feedback-landing.js";
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
  const bare = gitRepo({ bare: true, kind: "ci-learning-landing-origin" });
  const seed = gitRepo({ seedCommit: true, kind: "ci-learning-landing-seed" });
  mkdirSync(join(seed.dir, "plan"), { recursive: true });
  writeFileSync(join(seed.dir, "plan", "tasks.yaml"), "[]\n");
  seed.git("add", "-A");
  seed.git("commit", "--quiet", "-m", "chore: add plan fixture");
  seed.addRemote("origin", bare.dir);
  seed.git("push", "--quiet", "origin", "main");
  seed.cleanup();
  return bare.dir;
}

function cloneRoot(bareOrigin: string): string {
  const checkout = gitRepo({ cloneFrom: bareOrigin, kind: "ci-learning-landing-checkout" });
  checkout.git("config", "user.name", "remudero ci-learning fixture");
  checkout.git("config", "user.email", "ci-learning-fixture@remudero.invalid");
  return checkout.dir;
}

function stateRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "rmd-ci-learning-landing-state-"));
  mkdirSync(join(root, "state"), { recursive: true });
  return root;
}

function fakeGh(prUrl: string, expectedBranch = CI_LEARNING_LANDING_BRANCH) {
  const calls: string[][] = [];
  let createCount = 0;
  const gh = (args: string[]): string => {
    calls.push(args);
    if (args[0] === "pr" && args[1] === "list") {
      return createCount > 0 ? JSON.stringify([{ url: prUrl }]) : JSON.stringify([]);
    }
    if (args[0] === "pr" && args[1] === "create") {
      createCount++;
      assert.ok(args.includes(expectedBranch), "the CI-learning landing PR uses its dedicated branch");
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

function landingBranchFiles(bareOrigin: string, branch = CI_LEARNING_LANDING_BRANCH): string[] {
  return execFileSync("git", ["--git-dir", bareOrigin, "ls-tree", "-r", "--name-only", branch], {
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

test("W1-T3492: malformed queued bytes, held findings, and refused drafts stay uncredited", () => {
  const bareOrigin = makeBareOrigin();
  const checkout = cloneRoot(bareOrigin);
  const root = stateRoot();
  const { gh } = fakeGh("https://github.com/o/r/pull/3496");
  const queue = join(root, "state", "ci-learning-pending", "plan", "tasks.d");
  mkdirSync(queue, { recursive: true });
  writeFileSync(join(queue, "W1-T9006-broken.yaml"), "tasks: [\n", "utf8");

  assert.deepEqual(
    ciLearningPendingOrigins(root, checkout),
    [],
    "unparseable queued bytes must not reserve an origin against a later valid finding",
  );

  const malformed = withLiveWritesAllowed(() =>
    landCiLearningShards([], checkout, {
      stateRoot: root,
      mintTaskId: () => "W1-T9006",
      planOrigins: [],
      renderShard: ciLearningShardYaml,
      recordVerdict: ciLearningRecordVerdict,
      gh,
    }),
  );
  assert.deepEqual(malformed.filed, [], "a malformed queued file must never receive filed credit after transport");
  assert.equal(pendingFiles(root).length, 1, "the malformed durable bytes remain visible for repair");

  const duplicate = withLiveWritesAllowed(() =>
    landCiLearningShards([draft()], checkout, {
      stateRoot: stateRoot(),
      mintTaskId: () => {
        throw new Error("a held finding must not consume an id");
      },
      planOrigins: [draft().findingId],
      renderShard: ciLearningShardYaml,
      recordVerdict: ciLearningRecordVerdict,
      gh,
    }),
  );
  assert.deepEqual(duplicate.skipped, [draft().findingId], "the already-held finding is skipped before staging");

  const rejectedDraft = draft("ci-learning:4321:rejected");
  const refused = withLiveWritesAllowed(() =>
    landCiLearningShards([rejectedDraft], checkout, {
      stateRoot: stateRoot(),
      mintTaskId: () => "W1-T9007",
      planOrigins: [],
      renderShard: ciLearningShardYaml,
      recordVerdict: () => ({ ok: false, reason: "fixture lint refusal" }),
      gh,
    }),
  );
  assert.deepEqual(refused.refused, [{ findingId: rejectedDraft.findingId, reason: "fixture lint refusal" }]);
});

test("W1-T3542 criterion 1: manual ci-learning uses the isolated landing queue too", async () => {
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
  const manualGh = fakeGh("https://github.com/o/r/pull/3542");
  const code = withLiveWritesAllowed(() =>
    ciLearningCommand(["--force"], {
      root: manualRoot,
      checkoutRoot: manualCheckout,
      loadWindow: () => repairedWindow(),
      planOrigins: [],
      landShards: (drafts, checkoutRoot, deps) =>
        landCiLearningShards(drafts, checkoutRoot, { ...deps, gh: manualGh.gh }),
    }),
  );

  assert.equal(code, 0, "the manual operator command still succeeds");
  assert.equal(git(manualCheckout, "status", "--porcelain").trim(), "", "the manual run leaves its checkout clean");
  assert.equal(pendingFiles(manualRoot).length, 1, "the manual run retains exact bytes in the durable queue");
  assert.equal(
    landingBranchFiles(manualBare).filter((f) => f.startsWith("plan/tasks.d/")).length,
    1,
    "the manual run reaches the same dedicated landing branch",
  );
  const reservationRef = git(manualBare, "for-each-ref", "--format=%(refname)", "refs/rmd-id/").trim();
  assert.ok(reservationRef, "the manual run reserves its generated task id before publishing the landing branch");
  const reservation = git(manualBare, "log", "-1", "--format=%B", reservationRef);
  assert.match(
    reservation,
    /branch=ci-learning-landing/,
    "the reservation names the dedicated landing branch rather than the manual checkout's main branch",
  );
});

test("the CI-learning reservation names the scoped landing branch that will file it", () => {
  const bareOrigin = makeBareOrigin();
  const checkout = cloneRoot(bareOrigin);
  const root = stateRoot();
  const targetRepository = { owner: "other", repo: "lessons" };
  const sourceRepository = { owner: "source", repo: "remudero" };
  const landingOwner = "fleet-east";
  const branch = landingIdentity({
    family: "ci-learning",
    targetRepository,
    sourceRepository,
    landingOwner,
  }).branch;
  const { gh } = fakeGh("https://github.com/o/r/pull/3543", branch);
  let reservedFor: string | undefined;

  const result = withLiveWritesAllowed(() =>
    landCiLearningShards([draft("ci-learning:4321:scoped")], checkout, {
      stateRoot: root,
      mintTaskId: (filingBranch) => {
        reservedFor = filingBranch;
        return "W1-T9008";
      },
      planOrigins: [],
      renderShard: ciLearningShardYaml,
      recordVerdict: ciLearningRecordVerdict,
      targetRepository,
      sourceRepository,
      landingOwner,
      gh,
    }),
  );

  assert.equal(reservedFor, branch, "the reservation holder is the same scoped branch the landing bridge pushes");
  assert.equal(result.filed.length, 1, "the scoped landing branch receives the staged shard");
  assert.equal(landingBranchFiles(bareOrigin, branch).filter((f) => f.startsWith("plan/tasks.d/")).length, 1);
});

test("W1-T3542 criterion 3: generated CLI and operator docs describe queue-backed CI-learning", () => {
  const cli = readFileSync("docs/cli-reference.md", "utf8");
  const guide = readFileSync("docs/operator-guide.md", "utf8");
  assert.match(cli, /queue-backed landing bridge/, "the generated CLI reference names the durable path");
  assert.match(guide, /queue-backed landing bridge/, "the operator guide names the durable path");
  assert.doesNotMatch(cli, /REPORT-ONLY: prints the drafts, writes no plan record/, "the stale report-only claim is gone");
  assert.doesNotMatch(guide, /Report-only: prints the drafts, writes no plan record/, "the stale guide claim is gone");
});
