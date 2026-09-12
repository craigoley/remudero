import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { seedDirtyFleetRepo } from "./helpers/dirty-fleet-repo.js";

import { rebaseDirtyFleetBranchViaGit, type OpenPrView } from "../src/lib/sweep.js";

const GIT_IDENTITY_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Remudero Test",
  GIT_AUTHOR_EMAIL: "remudero-test@example.invalid",
  GIT_COMMITTER_NAME: "Remudero Test",
  GIT_COMMITTER_EMAIL: "remudero-test@example.invalid",
};

const GIT_IDENTITY_KEYS = new Set([
  "EMAIL",
  "GIT_AUTHOR_EMAIL",
  "GIT_AUTHOR_NAME",
  "GIT_COMMITTER_EMAIL",
  "GIT_COMMITTER_NAME",
]);

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd, env: GIT_IDENTITY_ENV, encoding: "utf8", stdio: "pipe" }) as string;
}

function gitWithoutAmbientIdentity(
  file: string,
  args: readonly string[],
  opts: { cwd?: string; stdio?: "pipe" | "ignore"; encoding?: BufferEncoding } = {},
): string {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !GIT_IDENTITY_KEYS.has(key)));
  return execFileSync(file, [...args], {
    cwd: opts.cwd,
    encoding: opts.encoding ?? "utf8",
    env: {
      ...env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_SYSTEM: "/dev/null",
    },
    maxBuffer: 1 << 24,
    stdio: opts.stdio ?? "pipe",
  }) as string;
}

function dirtyFleetPr(branch: string, oldHead: string): OpenPrView {
  return {
    prNumber: 3333,
    prUrl: "https://github.com/acme/remudero/pull/3333",
    taskId: "W1-T3333",
    reviewState: "none",
    checksState: "none",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: "2026-09-12T00:00:00.000Z",
    headSha: oldHead,
    headRefName: branch,
    autoMergeArmed: false,
    mergeState: "dirty",
    mergeable: false,
    mergeableState: "dirty",
    mergeConflict: {
      files: [{ path: "README.md", oursDeleted: 0, theirsDeleted: 0 }],
      oursLog: "branch changed README.md",
      theirsLog: "main changed README.md too",
    },
  };
}

function seedContentConflict(root: string, branch: string): { oldHead: string; repoDir: string } {
  const { repoDir } = seedDirtyFleetRepo(root, branch);

  git(repoDir, ["checkout", branch]);
  writeFileSync(join(repoDir, "README.md"), "branch\n");
  git(repoDir, ["add", "README.md"]);
  git(repoDir, ["commit", "-m", "branch change"]);
  const oldHead = git(repoDir, ["rev-parse", "HEAD"]).trim();
  git(repoDir, ["push", "origin", branch]);

  git(repoDir, ["checkout", "main"]);
  writeFileSync(join(repoDir, "README.md"), "main\n");
  git(repoDir, ["add", "README.md"]);
  git(repoDir, ["commit", "-m", "main change"]);
  git(repoDir, ["push", "origin", "main"]);
  return { oldHead, repoDir };
}

test("W1-T3333: a rebase that refuses before starting is reported as error, not conflict", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-w1-t3333-no-start-"));
  const branch = "run-W1-T3333-1789187779834";
  try {
    const { repoDir, oldHead } = seedDirtyFleetRepo(root, branch);
    git(repoDir, ["config", "--unset-all", "user.name"]);
    git(repoDir, ["config", "--unset-all", "user.email"]);
    git(repoDir, ["config", "user.useConfigOnly", "true"]);

    const outcome = rebaseDirtyFleetBranchViaGit(repoDir, join(root, "rebase-worktree"), dirtyFleetPr(branch, oldHead), {
      git: gitWithoutAmbientIdentity,
    });

    assert.equal(outcome.outcome, "error");
    assert.match(outcome.reason, /committer identity|unable to auto-detect email|please tell me who you are/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T3333: a rebase that stops on a real content conflict is still reported as conflict", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-w1-t3333-conflict-"));
  const branch = "run-W1-T3333-1789187779834";
  try {
    const { repoDir, oldHead } = seedContentConflict(root, branch);

    const outcome = rebaseDirtyFleetBranchViaGit(repoDir, join(root, "rebase-worktree"), dirtyFleetPr(branch, oldHead));

    assert.equal(outcome.outcome, "conflict");
    assert.match(outcome.reason, /CONFLICT|could not apply|resolve all conflicts/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
