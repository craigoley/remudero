/**
 * W1-T14400: on the Azure host a linked hand worktree held for unsaved work (uncommitted changes or unpublished
 * commits) used to be kept on every pass. Idle past the held-worktree window, it is preserved in the preserve-retire
 * format (patch, unpublished bundle, untracked tarball, MANIFEST), each read back, then removed with git worktree
 * remove; its branch stays. Driven as the real deploy/rmd-host-cleanup.sh against fixture roots only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { age, fixture, git, repos, run, type Fixture } from "#test/helpers/host-cleanup-fixture.js";

const DAY_HOURS = 24;
const handOnly = (root: string, extra: Record<string, string> = {}) => ({
  RMD_CLEANUP_WORKTREE_ROOTS: root, RMD_CLEANUP_LIVE_CHECKOUTS: "", RMD_CLEANUP_PRESERVE_ROOTS: "", RMD_CLEANUP_DUMP_ROOTS: "",
  RMD_CLEANUP_TMP_ROOTS: "", ...extra,
});

function copies(fx: Fixture, wt: string): string[] {
  const root = join(fx.root, "preserved");
  if (!existsSync(root)) return [];
  const stem = wt.replace(/^\//, "").replace(/\//g, "__") + "@";
  return readdirSync(root).filter(n => n.startsWith(stem)).map(n => join(root, n));
}

/** A linked worktree with an unpublished commit, an uncommitted edit and an untracked note. */
function heldHandTree(fx: Fixture, name: string) {
  const { main, addWorktree } = repos(fx);
  const branch = `hand/${name}`;
  const wt = addWorktree(name, branch);
  writeFileSync(join(wt, "feature.txt"), "unpublished work\n");
  git(wt, "add", "feature.txt");
  git(wt, "commit", "--quiet", "-m", "unpublished commit");
  writeFileSync(join(wt, "README"), "edited, not committed\n");
  writeFileSync(join(wt, "notes.md"), "untracked notes\n");
  return { main, wt, branch, root: join(wt, "..") };
}

test("W1-T14400 criterion 1: an idle hand worktree with uncommitted and unpushed work is saved and then removed, and git worktree add plus the patch restores it", () => {
  const fx = fixture();
  const { main, wt, branch, root } = heldHandTree(fx, "wt-T9001");
  age(wt, 10 * DAY_HOURS);

  const r = run(fx, handOnly(root));
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, new RegExp(`REMOVE ${wt}: .*idle 7 days, preserved then retired`));
  assert.equal(existsSync(wt), false, r.stdout);
  const [copy] = copies(fx, wt);
  assert.ok(copy, `a preserved copy exists:\n${r.stdout}`);
  for (const f of ["unpublished.bundle", "uncommitted.patch", "untracked.tar.gz", "refs.txt", "MANIFEST.txt"]) {
    assert.equal(existsSync(join(copy, f)), true, `${f} in ${copy}`);
  }
  assert.match(git(main, "branch", "--list", branch), new RegExp(branch.replace("/", "\\/")), "the branch stays in the clone");

  const restore = join(fx.root, "restore");
  git(main, "worktree", "add", "--quiet", restore, branch);
  assert.equal(readFileSync(join(restore, "feature.txt"), "utf8"), "unpublished work\n", "the commit is on the kept branch");
  git(restore, "apply", "--binary", join(copy, "uncommitted.patch"));
  assert.equal(readFileSync(join(restore, "README"), "utf8"), "edited, not committed\n", "the patch restores the edit");
});

test("W1-T14400 criterion 2: invariant:nothing-unsaved-is-removed — a failed save, a held worktree or a recent one is kept", () => {
  const fx = fixture();
  const { main, wt, root } = heldHandTree(fx, "wt-recent");
  const locked = join(root, "wt-locked");
  git(main, "worktree", "add", "--quiet", "-b", "hand/locked", locked, "main");
  writeFileSync(join(locked, "README"), "locked edit\n");
  git(main, "worktree", "lock", locked);
  const unsavable = join(root, "wt-unsavable");
  git(main, "worktree", "add", "--quiet", "-b", "hand/unsavable", unsavable, "main");
  writeFileSync(join(unsavable, "README"), "dirty\n");
  age(wt, 13);
  age(locked, 10 * DAY_HOURS);
  age(unsavable, 10 * DAY_HOURS);

  // The preserve root cannot be created, so the third worktree's save fails.
  const blocked = join(fx.root, "not-a-dir");
  writeFileSync(blocked, "a file, not a folder\n");
  const r = run(fx, handOnly(root, { RMD_CLEANUP_PRESERVE_ROOT: join(blocked, "preserved") }));
  assert.equal(r.status, 0, r.stderr + r.stdout);
  for (const kept of [wt, locked, unsavable]) {
    assert.equal(existsSync(kept), true, `${kept} stays:\n${r.stdout}`);
    assert.doesNotMatch(r.stdout, new RegExp(`REMOVE ${kept}[: ]`));
  }
  assert.match(r.stdout, new RegExp(`KEEP ${unsavable}: uncommitted changes; cannot create`));
  assert.match(r.stdout, new RegExp(`KEEP ${locked}: Git worktree is locked`));
});
