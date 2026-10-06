/**
 * W1-T5707 — /mnt/rmd's top level sat in no janitor root, so ad-hoc workspaces there
 * (thread-followups-*, fh5, tf5-*) were never swept while the disk filled. Driven as the real
 * deploy/rmd-host-cleanup.sh against a fixture state-disk parent (RMD_CLEANUP_STATE_PARENTS): an idle
 * unknown name goes through the scratch-unit guards and bundle archive, then is removed; a
 * deny-listed name, a fresh entry, a held entry and a mount point are kept, each with its reason.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, lutimesSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { age, fixture, git, repos, run, type Fixture } from "./helpers/host-cleanup-fixture.js";

/** A state-disk fixture whose filesystem ids are named per path: `mounted` and the archive differ. */
function stateDisk(fx: Fixture, opts: { unmounted?: boolean } = {}) {
  const state = join(fx.root, "mnt-rmd");
  const mounted = join(state, "mounted-volume");
  const archive = fx.env.RMD_CLEANUP_WORKTREE_ARCHIVE_ROOT;
  const fsid = join(fx.root, "bin", "state-fsid");
  writeFileSync(fsid, [
    "#!/usr/bin/env bash",
    `case "$1" in`,
    `  "${mounted}") echo mnt ;;`,
    `  "${archive}"|"${archive}"/*|"${fx.root}") echo archive ;;`,
    `  "${fx.rootfs}") echo ${opts.unmounted ? "state" : "root"} ;;`,
    "  *) echo state ;;",
    "esac",
    "",
  ].join("\n"));
  chmodSync(fsid, 0o755);
  mkdirSync(state);
  const entry = (name: string): string => {
    const p = join(state, name);
    mkdirSync(p, { recursive: true });
    writeFileSync(join(p, "data"), `${name}\n`);
    return p;
  };
  const env = { RMD_CLEANUP_STATE_PARENTS: state, RMD_CLEANUP_TMP_ROOTS: "", RMD_CLEANUP_FSID: fsid };
  return { state, mounted, entry, env };
}

test("test/the-janitor-reaps-the-state-disks-ad-hoc-top-level.test.ts", () => {
  const fx = fixture();
  const { main } = repos(fx);
  const disk = stateDisk(fx);

  // an ad-hoc workspace: a clone carrying a branch nobody pushed, plus payload beside it
  const followups = disk.entry("thread-followups-x");
  const clone = join(followups, "remudero");
  git(fx.root, "clone", "--quiet", join(fx.root, "origin.git"), clone);
  git(clone, "checkout", "-q", "-b", "followups");
  git(clone, "commit", "-q", "--allow-empty", "-m", "never pushed");
  const unpublished = git(clone, "rev-parse", "HEAD").trim();
  const fh5 = disk.entry("fh5");
  const state2 = disk.entry("state2");
  const containerd = disk.entry("containerd");
  age(disk.state);
  const fresh = disk.entry("tf5-fresh");

  const r = run(fx, disk.env);
  assert.equal(r.status, 0, r.stderr + r.stdout);

  // the idle unknown name is archived first, then reaped
  assert.equal(existsSync(followups), false, r.stdout);
  const bundles = readdirSync(join(fx.env.RMD_CLEANUP_WORKTREE_ARCHIVE_ROOT, "scratch")).filter(n => n.endsWith(".bundle"));
  assert.equal(bundles.length, 1, r.stdout);
  const heads = git(main, "bundle", "list-heads", join(fx.env.RMD_CLEANUP_WORKTREE_ARCHIVE_ROOT, "scratch", bundles[0]));
  assert.ok(heads.includes(`${unpublished} refs/heads/followups`), heads);
  assert.ok(r.stdout.indexOf(`ARCHIVE-WORKTREE ${clone}`) >= 0, r.stdout);
  assert.ok(r.stdout.indexOf(`ARCHIVE-WORKTREE ${clone}`) < r.stdout.indexOf(`REMOVE ${followups}\n`), r.stdout);
  assert.equal(existsSync(fh5), false, r.stdout);
  assert.ok(r.stdout.includes(`REMOVE ${fh5}\n`), r.stdout);

  // deny-listed state is kept however idle, and says why
  for (const kept of [state2, containerd]) {
    assert.equal(readFileSync(join(kept, "data"), "utf8"), `${kept.split("/").pop()}\n`, r.stdout);
    assert.ok(r.stdout.includes(`KEEP ${kept}: state-disk deny-list\n`), r.stdout);
  }
  // a fresh ad-hoc entry is under the 720-minute threshold
  assert.equal(existsSync(join(fresh, "data")), true, r.stdout);
  assert.ok(r.stdout.includes(`KEEP ${fresh}: written within 720 min\n`), r.stdout);
  // the parent itself is never a unit
  assert.equal(existsSync(disk.state), true);
  assert.ok(r.stdout.includes(`KEEP ${disk.state}: workspace parent root\n`), r.stdout);
});

test("a held, mounted or symlinked state-disk entry is kept with its reason", () => {
  const fx = fixture();
  const disk = stateDisk(fx);
  const held = disk.entry("tf5-held");
  disk.entry("mounted-volume");
  const elsewhere = join(fx.root, "elsewhere");
  mkdirSync(elsewhere);
  writeFileSync(join(elsewhere, "precious"), "keep\n");
  const link = join(disk.state, "tf5-link");
  symlinkSync(elsewhere, link);
  age(disk.state); age(elsewhere);
  const old = new Date(Date.now() - 13 * 3600_000);
  lutimesSync(link, old, old);
  writeFileSync(fx.lsofList, `${held}\n`); // a process whose cwd is inside it

  const r = run(fx, disk.env);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(existsSync(join(held, "data")), true, r.stdout);
  assert.ok(r.stdout.includes(`KEEP ${held}: held open by a process\n`), r.stdout);
  assert.equal(existsSync(join(disk.mounted, "data")), true, r.stdout);
  assert.ok(r.stdout.includes(`KEEP ${disk.mounted}: mount point\n`), r.stdout);
  assert.equal(lstatSync(link).isSymbolicLink(), true, r.stdout);
  assert.ok(r.stdout.includes(`KEEP ${link}: symbolic link\n`), r.stdout);
  assert.equal(readFileSync(join(elsewhere, "precious"), "utf8"), "keep\n");
});

test("an unmounted state disk is never swept: its directory sits on the root filesystem", () => {
  const fx = fixture();
  const disk = stateDisk(fx, { unmounted: true });
  const stray = disk.entry("thread-followups-y");
  age(disk.state);
  const r = run(fx, disk.env);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(existsSync(join(stray, "data")), true, r.stdout);
  assert.ok(r.stdout.includes(`KEEP ${disk.state}: on the same filesystem as ${fx.rootfs} (state disk not mounted)\n`), r.stdout);
});

test("DRY_RUN=1 only logs the state-disk reap", () => {
  const fx = fixture();
  const disk = stateDisk(fx);
  const idle = disk.entry("fh5");
  age(disk.state);
  const r = run(fx, { ...disk.env, DRY_RUN: "1" });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.ok(r.stdout.includes(`DRYRUN would: rm -rf -- ${idle}\n`), r.stdout);
  assert.equal(existsSync(join(idle, "data")), true);
});
