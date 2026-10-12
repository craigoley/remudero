import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { readWorktreeBase, worktreeAdd, worktreeAddAsync } from "../src/lib/worker.js";
import { recordedWorktreeGitDir } from "../src/lib/worktree-git.js";
import { gitRepo, type GitRepo } from "./helpers/git-repo.js";

/**
 * W1-T6147: `git worktree add` checks the new tree out and runs `post-checkout` from whatever hooks
 * path the SOURCE clone names: a relative `core.hooksPath=hooks` resolves to the base's TRACKED
 * hooks/, and no hooksPath at all means the common gitdir's hooks/, which a codex writer can write
 * through its --add-dir git roots. The cut must run neither; the lane it leaves is otherwise the same.
 */

type Route = "tracked" | "gitdir";
type Cut = (repoDir: string, wt: string, branch: string) => void | Promise<void>;

function writeHook(path: string, marker: string): void {
  writeFileSync(path, `#!/bin/sh\necho fired > '${marker}'\n`);
  chmodSync(path, 0o755);
}

/** A clone whose post-checkout writes `<gitdir>/<route>-fired`, through ONE of the two routes. */
function hookedFixture(route: Route): { repo: GitRepo; marker: string } {
  const repo = gitRepo({ kind: `t6147-${route}` });
  const marker = join(repo.dir, ".git", `${route}-fired`);
  if (route === "tracked") {
    mkdirSync(join(repo.dir, "hooks"));
    writeHook(join(repo.dir, "hooks", "post-checkout"), marker);
    repo.git("add", "hooks/post-checkout");
    repo.git("commit", "--no-verify", "--quiet", "-m", "chore: track a post-checkout hook");
    // The operator setting hooks/pre-commit's own comment asks for, resolved in the tree checked out.
    repo.git("config", "core.hooksPath", "hooks");
  } else {
    mkdirSync(join(repo.dir, ".git", "hooks"), { recursive: true });
    writeHook(join(repo.dir, ".git", "hooks", "post-checkout"), marker);
  }
  repo.addRemote("origin", repo.dir);
  repo.git("fetch", "origin", "--quiet");
  return { repo, marker };
}

const CUTS: ReadonlyArray<[string, Cut]> = [
  ["worktreeAdd", (r, wt, b) => worktreeAdd(r, wt, b, "origin/main", { warn: () => {} })],
  ["worktreeAddAsync", (r, wt, b) => worktreeAddAsync(r, wt, b, "origin/main", { warn: () => {} })],
];

describe("W1-T6147: cutting a worktree runs no tracked or gitdir hook", () => {
  for (const route of ["tracked", "gitdir"] as const) {
    it(`the control: a raw git worktree add on the ${route} fixture runs its post-checkout`, () => {
      const { repo, marker } = hookedFixture(route);
      repo.git("worktree", "add", "-b", "control", "--no-track", join(repo.dir, "control"), "origin/main");
      assert.equal(existsSync(marker), true, `control: the ${route} hook is live, so a silent marker below means it was not run`);
    });

    for (const [name, cut] of CUTS) {
      it(`${name} cuts a lane from the ${route} fixture without running its post-checkout`, async () => {
        const { repo, marker } = hookedFixture(route);
        const wt = join(repo.dir, `lane-${name}`);
        await cut(repo.dir, wt, `run-${name}`);
        assert.equal(existsSync(marker), false, `the ${route} post-checkout ran while ${name} cut the tree`);
        // The lane is otherwise the one the harness has always cut.
        assert.equal(repo.git("-C", wt, "rev-parse", "--abbrev-ref", "HEAD"), `run-${name}`);
        assert.equal(repo.git("-C", wt, "rev-parse", "HEAD"), repo.git("rev-parse", "origin/main"));
        assert.equal(readWorktreeBase(wt), repo.git("rev-parse", "origin/main"));
        assert.equal(recordedWorktreeGitDir(wt), repo.git("-C", wt, "rev-parse", "--path-format=absolute", "--git-dir"));
        assert.equal(repo.git("-C", wt, "config", "--worktree", "--get", "core.hooksPath"), "hooks");
        const exclude = readFileSync(join(repo.dir, ".git", "info", "exclude"), "utf8");
        assert.ok(exclude.split("\n").some((l) => l.trim() === "node_modules"), "node_modules is excluded");
        assert.throws(() => execFileSync("git", ["-C", repo.dir, "config", "--get", `branch.run-${name}.remote`], { stdio: "pipe" }),
          "--no-track still writes no tracking config");
      });
    }
  }

  it("worktreeAddAsync's catch-up merge runs no gitdir post-merge either, which a raw merge in that clone does", async () => {
    const seed = gitRepo({ kind: "t6147-seed" });
    const origin = gitRepo({ bare: true, kind: "t6147-origin" });
    seed.addRemote("origin", origin.dir);
    seed.git("push", "-q", "origin", "main");
    const clone = gitRepo({ cloneFrom: origin.dir, kind: "t6147-clone" });
    const marker = join(clone.dir, ".git", "post-merge-fired");
    mkdirSync(join(clone.dir, ".git", "hooks"), { recursive: true });
    writeHook(join(clone.dir, ".git", "hooks", "post-merge"), marker);
    let advanced: string | undefined;
    const rows: string[] = [];
    const wt = join(clone.dir, "lane-catch-up");
    await worktreeAddAsync(clone.dir, wt, "run-catch-up", "origin/main", {
      warn: () => {},
      log: (step) => rows.push(step),
      readRemoteHead: (dir, ref) => {
        if (advanced === undefined) {
          writeFileSync(join(seed.dir, "landed.txt"), "landed\n");
          seed.git("add", "landed.txt");
          seed.git("commit", "-q", "-m", "landed while cutting");
          seed.git("push", "-q", "origin", "main");
          advanced = seed.git("rev-parse", "HEAD");
        }
        return execFileSync("git", ["-C", dir, "ls-remote", "origin", `refs/heads/${ref}`], { encoding: "utf8" }).split(/\s+/)[0]!;
      },
    });
    assert.ok(rows.includes("worktree.base_caught_up"), "positive control: the catch-up merge ran");
    assert.equal(headOf(wt), advanced);
    assert.equal(existsSync(marker), false, "the gitdir post-merge ran during the catch-up");
    clone.git("merge", "--ff-only", "--quiet", "origin/main");
    assert.equal(existsSync(marker), true, "control: the planted post-merge is live for a raw merge");
  });
});

function headOf(dir: string): string {
  return execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}
