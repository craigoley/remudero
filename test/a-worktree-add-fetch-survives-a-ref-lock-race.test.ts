import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { worktreeAdd } from "../src/lib/worker.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { gitRepo } from "./helpers/git-repo.js";

// MEASURED 2026-10-01: an operator `rmd plan` run died in worktreeAdd's `git fetch origin` with "cannot lock ref
// 'refs/remotes/origin/main': is at … but expected …" because the daemon fetched the same managed checkout at the
// same moment. self-sync's fetches already retry that transient lock (#8043); worktreeAdd's did not.

function cloneWithOrigin(): { repoDir: string; cleanup: () => void } {
  const seed = gitRepo({ kind: "wt-fetch-seed" });
  const origin = gitRepo({ bare: true, kind: "wt-fetch-origin" });
  seed.addRemote("origin", origin.dir);
  seed.git("push", "-q", "origin", "main");
  const clone = gitRepo({ cloneFrom: origin.dir, kind: "wt-fetch-clone" });
  return { repoDir: clone.dir, cleanup: () => [seed.dir, origin.dir, clone.dir].forEach((d) => rmSync(d, { recursive: true, force: true })) };
}

test("worktreeAdd retries a fetch that lost a transient ref-lock race", (t) => {
  const { repoDir, cleanup } = cloneWithOrigin();
  const wtRoot = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}wt-fetch-wt-`));
  t.after(() => { cleanup(); rmSync(wtRoot, { recursive: true, force: true }); });
  let fetches = 0;
  const fetchGit = (args: string[]): string => {
    fetches++;
    if (fetches === 1) throw new Error("Command failed: git fetch\nerror: cannot lock ref 'refs/remotes/origin/main': is at 1111 but expected 2222");
    return execFileSync("git", ["-C", repoDir, ...args], { encoding: "utf8" });
  };
  const wt = join(wtRoot, "wt");
  worktreeAdd(repoDir, wt, "run-wt-fetch-race", "origin/main", { fetchGit, sleepMs: () => {} });
  assert.equal(fetches, 2, "the lost race is fetched again");
  assert.ok(existsSync(join(wt, ".git")), "the worktree is created");
});
