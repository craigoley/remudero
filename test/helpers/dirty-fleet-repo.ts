import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A real on-disk repo whose fleet branch is BEHIND its origin/main — the fixture the dirty-fleet
 * rebase acceptance test drives `defaultDirtyFleetRebaseGit` over.
 *
 * IT LIVES UNDER test/helpers/ FOR A MEASURED REASON, not for tidiness. The fixture-copy census
 * scans `test/*.test.ts` non-recursively and refused this PR at `gitInitSites: 220 > baseline 218`
 * and `gitInitFiles: 144 > baseline 143` — a new test file hand-rolling its own repo setup is
 * exactly the duplication that ratchet exists to stop. `test/helpers/*.ts` is outside its
 * population by design, and sharing the seed is the census's remedy rather than a baseline bump
 * (which, beside this PR's `src/lib/sweep.ts` change, would also entangle Rule 25).
 *
 * THE REPO CARRIES ITS OWN COMMITTER IDENTITY. `GIT_ENV` below stamps the commits made HERE, but
 * the code under test spawns git with no env of its own, so its committer comes from whatever
 * GLOBAL gitconfig the host has. A dev container has one; a CI runner has none for a repo under
 * /tmp. That difference alone made the acceptance test pass locally and fail in CI, reported as a
 * bare `conflict` — so the identity is set on the repo, which its worktrees inherit.
 */
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Remudero Test",
  GIT_AUTHOR_EMAIL: "remudero-test@example.invalid",
  GIT_COMMITTER_NAME: "Remudero Test",
  GIT_COMMITTER_EMAIL: "remudero-test@example.invalid",
};

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd, env: GIT_ENV, encoding: "utf8", stdio: "pipe" }) as string;
}

export interface DirtyFleetRepo {
  /** The working checkout the sweep is pointed at. */
  repoDir: string;
  /** The bare origin it pushes to, so a rebase can be observed to actually move the remote. */
  originDir: string;
  /** The fleet branch's head BEFORE the rebase — the lease the push is made against. */
  oldHead: string;
}

/** Seed `root` with an origin, a `main` that moved, and `branch` one commit behind it. The two
 *  commits touch DISJOINT files, so any rebase failure here is environmental, never a real
 *  conflict — which is what makes the acceptance test's `rebased` assertion meaningful. */
export function seedDirtyFleetRepo(root: string, branch: string): DirtyFleetRepo {
  const repoDir = join(root, "checkout");
  const originDir = join(root, "origin.git");
  mkdirSync(repoDir, { recursive: true });
  git(root, ["init", "--bare", originDir]);
  git(repoDir, ["init"]);
  git(repoDir, ["config", "user.name", "Remudero Test"]);
  git(repoDir, ["config", "user.email", "remudero-test@example.invalid"]);
  git(repoDir, ["checkout", "-b", "main"]);
  writeFileSync(join(repoDir, "README.md"), "base\n");
  git(repoDir, ["add", "README.md"]);
  git(repoDir, ["commit", "-m", "initial"]);
  git(repoDir, ["remote", "add", "origin", originDir]);
  git(repoDir, ["push", "-u", "origin", "main"]);

  git(repoDir, ["checkout", "-b", branch]);
  writeFileSync(join(repoDir, "branch.txt"), "branch change\n");
  git(repoDir, ["add", "branch.txt"]);
  git(repoDir, ["commit", "-m", "branch change"]);
  const oldHead = git(repoDir, ["rev-parse", "HEAD"]).trim();
  git(repoDir, ["push", "-u", "origin", branch]);

  git(repoDir, ["checkout", "main"]);
  writeFileSync(join(repoDir, "main.txt"), "main change\n");
  git(repoDir, ["add", "main.txt"]);
  git(repoDir, ["commit", "-m", "main change"]);
  git(repoDir, ["push", "origin", "main"]);
  return { repoDir, originDir, oldHead };
}

/** The sha `ref` points at on the seeded repo's origin — how the test proves the branch MOVED. */
export function remoteHeadSha(repoDir: string, ref: string): string {
  return git(repoDir, ["ls-remote", "origin", ref]).trim().split(/\s+/)[0];
}
