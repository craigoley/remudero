import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { age, fixture, git, repos, run } from "#test/helpers/host-cleanup-fixture.js";

function rig(t: { after(fn: () => void): void }) {
  const fx = fixture();
  t.after(() => rmSync(fx.root, { recursive: true, force: true }));
  const { main } = repos(fx);
  writeFileSync(join(main, ".gitignore"), "node_modules\ncoverage\n");
  git(main, "add", ".gitignore");
  git(main, "commit", "-qm", "ignore generated output");
  git(main, "push", "-q", "origin", "HEAD:main");
  const disk = realpathSync(fx.scratch);
  const hand = join(disk, "rmd-hand");
  mkdirSync(hand);
  writeFileSync(fx.env.RMD_CLEANUP_FSID!, `#!/usr/bin/env bash
case "$1" in
  "$RMD_CLEANUP_ROOT_FS"|"$FIXTURE_HAND_DISK"|"$FIXTURE_HAND_DISK"/*) echo 1 ;;
  *) echo 2 ;;
esac
`);

  function add(name: string, branch: string, deps = false, parent = hand) {
    const path = join(parent, name);
    git(main, "worktree", "add", "-qb", branch, path, "main");
    if (deps) {
      mkdirSync(join(path, "node_modules"));
      writeFileSync(join(path, "node_modules", "dependency"), "installed\n");
    }
    age(path);
    return path;
  }

  function pass(extra: Record<string, string> = {}) {
    const result = run(fx, {
      DRY_RUN: "0", RMD_CLEANUP_DRY_RUN: "0", RMD_CLEANUP_RECLAIM_ROOT_HAND_WORKTREES: "",
      RMD_CLEANUP_LIVE_CHECKOUTS: main, RMD_CLEANUP_AGENT_SCRATCH: "",
      RMD_CLEANUP_SCRATCH_ROOTS: disk, RMD_CLEANUP_TMP_ROOTS: disk, RMD_CLEANUP_TMP_GLOBS: "rmd-*",
      FIXTURE_HAND_DISK: disk,
      ...extra,
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return result.stdout;
  }

  function registered(path: string) {
    return git(main, "worktree", "list", "--porcelain", "-z").split("\0").includes(`worktree ${path}`);
  }

  return { fx, main, hand, add, pass, registered };
}

const reclaim = { RMD_CLEANUP_RECLAIM_ROOT_HAND_WORKTREES: "1" };

test("the host janitor finds idle hand worktrees on the root disk from known checkout registrations and reports reclaim by default", (t) => {
  const r = rig(t);
  const deps = r.add("hand tree with spaces", "run-W1-T1-1795386600804", true);
  const ready = r.add("wt-ready", "published");
  const otherDisk = r.add("wt-other-disk", "other-disk", true, join(r.fx.root, "other-disk"));
  const open = r.add("wt-open", "open", true);
  const locked = r.add("wt-locked", "locked", true);
  git(r.main, "worktree", "lock", locked);
  writeFileSync(r.fx.lsofList, `${open}/README\n`);

  const out = r.pass({ RMD_CLEANUP_WORKTREE_ROOTS: r.hand });
  assert.ok(out.includes(`WOULD-PRUNE ${deps}/node_modules:`), out);
  assert.ok(out.includes(`WOULD-REMOVE ${ready}:`), out);
  assert.ok(out.includes(`KEEP ${open}: held open by a process`), out);
  assert.ok(out.includes(`KEEP ${locked}: Git worktree is locked`), out);
  assert.ok(!out.includes(otherDisk), out);
  for (const path of [deps, ready, otherDisk, open, locked]) {
    assert.ok(existsSync(path), path);
    assert.ok(r.registered(path), path);
  }
  assert.ok(existsSync(join(deps, "node_modules", "dependency")));
  const receipt = join(r.fx.home, ".local/state/remudero/janitor-decisions.tsv");
  assert.ok(readFileSync(receipt, "utf8").split("\n").some((row) => row.includes(`\tplanned\tother\tWOULD-PRUNE ${deps}/node_modules:`)), out);

  age(r.hand);
  const tmpOnly = r.pass({ ...reclaim, RMD_CLEANUP_ONLY_TMP: "1" });
  assert.ok(existsSync(join(deps, "node_modules", "dependency")), tmpOnly);
  assert.ok(r.registered(ready), tmpOnly);
});

test("opt-in root-disk reclaim takes installed dependencies first and keeps a head the remote does not hold", (t) => {
  const r = rig(t);
  const published = r.add("wt-published", "published", true);
  const unpublished = r.add("wt-unpublished", "unpublished", true);
  git(unpublished, "commit", "-qm", "private commit", "--allow-empty");
  const privateHead = git(unpublished, "rev-parse", "HEAD");
  git(unpublished, "push", "-q", "origin", "HEAD:gone");
  git(r.main, "--git-dir", join(r.fx.root, "origin.git"), "update-ref", "-d", "refs/heads/gone");
  assert.equal(git(r.main, "rev-parse", "refs/remotes/origin/gone"), privateHead);
  age(unpublished);

  const preview = r.pass({ ...reclaim, RMD_CLEANUP_DRY_RUN: "1" });
  assert.ok(preview.includes(`WOULD-PRUNE ${published}/node_modules:`), preview);
  assert.ok(existsSync(join(published, "node_modules", "dependency")));

  const first = r.pass(reclaim);
  for (const path of [published, unpublished]) {
    assert.ok(first.includes(`PRUNE ${path}/node_modules:`), first);
    assert.ok(!existsSync(join(path, "node_modules")), path);
    assert.ok(r.registered(path), path);
    age(path);
  }

  const later = r.pass(reclaim);
  assert.ok(later.includes(`REMOVE ${published} (linked worktree)`), later);
  assert.ok(!existsSync(published), later);
  assert.ok(!r.registered(published), later);
  assert.ok(later.includes(`KEEP ${unpublished}: not-proven-published HEAD=${privateHead.trim()}`), later);
  assert.equal(git(unpublished, "rev-parse", "HEAD"), privateHead);
  assert.ok(r.registered(unpublished));
});
