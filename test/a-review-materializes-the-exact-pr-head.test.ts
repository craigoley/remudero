// W1-T2751: GitHub's immutable PR-head ref, not the mutable source branch, is checkout authority.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import type { Config } from "../src/lib/config.js";
import { materializeReviewWorktree, type ReviewWorktreeDeps } from "../src/run-task.js";

const MADE: string[] = [];
after(() => {
  for (const dir of MADE) rmSync(dir, { recursive: true, force: true });
});

const IDENTITY_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: "pipe",
    env: IDENTITY_ENV,
  }).trim();
}

interface PullRefFixture {
  config: Config;
  consumer: string;
  headSha: string;
  sourceSha: string;
}

/** A local GitHub-shaped origin: the PR ref and mutable source branch deliberately disagree. */
function pullRefFixture(prNumber: number, publishPullRef = true): PullRefFixture {
  const root = mkdtempSync(join(tmpdir(), "rmd-exact-pr-head-"));
  MADE.push(root);
  const origin = join(root, "origin.git");
  const seed = join(root, "seed");
  const consumer = join(root, "consumer");
  const configRoot = join(root, "state");
  const sourceBranch = "mutable-source";

  execFileSync("git", ["init", "--quiet", "--bare", "--initial-branch=main", origin], {
    env: IDENTITY_ENV,
    stdio: "pipe",
  });
  execFileSync("git", ["init", "--quiet", "--initial-branch=main", seed], {
    env: IDENTITY_ENV,
    stdio: "pipe",
  });
  writeFileSync(join(seed, "review-input.txt"), "base\n");
  git(seed, ["add", "."]);
  git(seed, ["commit", "--quiet", "-m", "base"]);
  git(seed, ["remote", "add", "origin", origin]);
  git(seed, ["push", "--quiet", "origin", "main"]);

  git(seed, ["checkout", "--quiet", "-b", "pull-head"]);
  writeFileSync(join(seed, "review-input.txt"), "exact pull head\n");
  git(seed, ["add", "."]);
  git(seed, ["commit", "--quiet", "-m", "pull head"]);
  const headSha = git(seed, ["rev-parse", "HEAD"]);
  if (publishPullRef) git(seed, ["push", "--quiet", "origin", `HEAD:refs/pull/${prNumber}/head`]);

  git(seed, ["checkout", "--quiet", "main"]);
  git(seed, ["checkout", "--quiet", "-b", sourceBranch]);
  writeFileSync(join(seed, "review-input.txt"), "later mutable branch\n");
  git(seed, ["add", "."]);
  git(seed, ["commit", "--quiet", "-m", "source branch moved"]);
  const sourceSha = git(seed, ["rev-parse", "HEAD"]);
  git(seed, ["push", "--quiet", "origin", sourceBranch]);

  execFileSync("git", ["clone", "--quiet", "--no-local", origin, consumer], {
    env: IDENTITY_ENV,
    stdio: "pipe",
  });
  mkdirSync(join(configRoot, "worktrees"), { recursive: true });
  return { config: { claudeBin: "/bin/true", root: configRoot }, consumer, headSha, sourceSha };
}

test("W1-T2751: a review materializes the supplied PR head even when the mutable source branch points elsewhere", () => {
  const prNumber = 751;
  const fixture = pullRefFixture(prNumber);
  assert.notEqual(fixture.headSha, fixture.sourceSha, "the control requires two genuinely different commits");
  assert.throws(
    () => git(fixture.consumer, ["cat-file", "-e", `${fixture.headSha}^{commit}`]),
    "the consumer must not already hold the hidden PR object before materialization",
  );

  const result = materializeReviewWorktree(
    fixture.config,
    fixture.consumer,
    prNumber,
    fixture.headSha,
  );
  assert.ok(result.worktreePath, "the documented PR-head ref is sufficient to materialize the review input");
  try {
    assert.equal(git(result.worktreePath!, ["rev-parse", "HEAD"]), fixture.headSha);
    assert.equal(readFileSync(join(result.worktreePath!, "review-input.txt"), "utf8"), "exact pull head\n");
    assert.throws(
      () => git(fixture.consumer, ["show-ref", "--verify", `refs/remotes/origin/pull/${prNumber}/head`]),
      "fetching the PR input must not create a reusable local branch or remote-tracking ref",
    );
  } finally {
    git(fixture.consumer, ["worktree", "remove", "--force", result.worktreePath!]);
  }
});

test("W1-T2751: the materializer threads the PR number to fetch and the supplied SHA to worktree add", () => {
  const calls: string[] = [];
  const expectedSha = "cafef00d";
  const deps: ReviewWorktreeDeps = {
    fetch: (repoDir, prNumber) => calls.push(`fetch:${repoDir}:${prNumber}`),
    addWorktree: (repoDir, worktreePath, revision) => calls.push(`add:${repoDir}:${worktreePath}:${revision}`),
    revParseHead: () => expectedSha,
  };
  const config = { claudeBin: "/bin/true", root: mkdtempSync(join(tmpdir(), "rmd-exact-pr-unit-")) } as Config;
  MADE.push(config.root);
  const result = materializeReviewWorktree(config, "/repo", 752, expectedSha, deps);

  assert.ok(result.worktreePath);
  assert.deepEqual(calls, [
    "fetch:/repo:752",
    `add:/repo:${result.worktreePath}:${expectedSha}`,
  ]);
});

test("W1-T2751: a missing PR-head ref is a named fetch failure with no source-branch fallback", () => {
  const prNumber = 753;
  const fixture = pullRefFixture(prNumber, false);
  const result = materializeReviewWorktree(
    fixture.config,
    fixture.consumer,
    prNumber,
    fixture.headSha,
  );

  assert.equal(result.worktreePath, undefined);
  assert.equal(result.failure?.errorClass, "fetch-failure");
  assert.match(result.failure?.message ?? "", /refs\/pull\/753\/head|couldn't find remote ref/);
  assert.equal(git(fixture.consumer, ["worktree", "list", "--porcelain"]).includes("review-PR753-"), false);
});

test("W1-T2751: the exact-tip mismatch assertion still throws and tears down the created worktree", () => {
  const removed: string[] = [];
  const deps: ReviewWorktreeDeps = {
    fetch: () => {},
    addWorktree: () => {},
    revParseHead: () => "different-sha",
    removeWorktree: (_repoDir, worktreePath) => removed.push(worktreePath),
  };
  const config = { claudeBin: "/bin/true", root: mkdtempSync(join(tmpdir(), "rmd-exact-pr-mismatch-")) } as Config;
  MADE.push(config.root);

  assert.throws(
    () => materializeReviewWorktree(config, "/repo", 754, "expected-sha", deps),
    /different-sha.*expected-sha|expected-sha.*different-sha/s,
  );
  assert.equal(removed.length, 1, "the rejected worktree is removed exactly once");
  assert.match(removed[0] ?? "", /review-PR754-/);
});
