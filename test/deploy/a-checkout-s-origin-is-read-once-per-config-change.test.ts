// W1-T14753: resolveOwnerRepoAt reads a checkout's origin once per change of the config git reads it from. Each
// `git config` spawn blocks the daemon's loop (9 s under host contention on 11-24 22:10Z).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveOwnerRepoAt, resolveOwnerRepoAtAsync } from "#src/lib/owner-repo.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

const git = (cwd: string, ...args: string[]): string => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });

function checkout(): { dir: string; root: string; worktree: string } {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}owner-repo-`));
  const root = join(dir, "main");
  git(dir, "init", "-q", root);
  git(root, "-c", "user.email=t@example.invalid", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "seed");
  git(root, "remote", "add", "origin", "https://github.com/acme/widgets.git");
  const worktree = join(dir, "wt");
  git(root, "worktree", "add", "-q", "--detach", worktree);
  return { dir, root, worktree };
}

/** Runs `read` with no `git` on PATH, so a read that spawns git fails. */
async function withoutGit<T>(read: () => T | Promise<T>): Promise<T> {
  const path = process.env.PATH;
  process.env.PATH = "";
  try {
    return await read();
  } finally {
    process.env.PATH = path;
  }
}

test("W1-T14753 a second owner-repo read of an unchanged checkout spawns no git", async () => {
  const f = checkout();
  try {
    for (const root of [f.root, f.worktree]) {
      assert.deepEqual(resolveOwnerRepoAt(root), { owner: "acme", repo: "widgets" });
      assert.deepEqual(await withoutGit(() => resolveOwnerRepoAt(root)), { owner: "acme", repo: "widgets" }, `${root}: sync, no spawn`);
      assert.deepEqual(await withoutGit(() => resolveOwnerRepoAtAsync(root)), { owner: "acme", repo: "widgets" }, `${root}: async, no spawn`);
    }
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("W1-T14753 an owner-repo read after the origin changes returns the new repo", async () => {
  const f = checkout();
  try {
    assert.deepEqual(resolveOwnerRepoAt(f.worktree), { owner: "acme", repo: "widgets" });
    assert.deepEqual(await withoutGit(() => resolveOwnerRepoAt(f.worktree)), { owner: "acme", repo: "widgets" }, "kept while unchanged");
    git(f.root, "remote", "set-url", "origin", "https://github.com/acme/gadgets-two.git");
    assert.deepEqual(resolveOwnerRepoAt(f.worktree), { owner: "acme", repo: "gadgets-two" }, "the changed config is read again");
    assert.deepEqual(await resolveOwnerRepoAtAsync(f.root), { owner: "acme", repo: "gadgets-two" });
    await assert.rejects(withoutGit(async () => resolveOwnerRepoAt(join(f.dir))), /no origin remote resolvable/,
      "a root with no .git entry still asks git");
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});
