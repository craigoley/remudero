/**
 * W1-T14929: the host janitor lists each home clone's linked worktrees with `git worktree list` and judges them,
 * though they sit outside the sweep roots. An idle one with unsaved work is preserved, then retired; one whose
 * admin directory is gone is saved as a tarball, then removed. The clone's own checkout and a live, locked or
 * open-pull-request tree are kept. Driven as the real deploy/rmd-host-cleanup.sh against fixture roots only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { ghShim, type GhShim } from "#test/helpers/gh-shim.js";
import { age, fixture, git, run, type Fixture } from "#test/helpers/host-cleanup-fixture.js";

const DAY_HOURS = 24;
const GITHUB = "https://github.com/craigoley/remudero.git";

interface HomeRig { fx: Fixture; shim: GhShim; clone: string; origin: string }

/** A home clone (~/rmd-op) whose origin is GitHub by URL and a local bare repository underneath. */
function homeRig(): HomeRig {
  const fx = fixture();
  const shim = ghShim();
  shim.addRoute({ when: 'select(.state == "open")', stdoutEnv: "GH_OPEN" });
  const origin = join(fx.root, "origin.git");
  git(fx.root, "init", "-q", "--bare", "-b", "main", origin);
  const clone = join(fx.home, "rmd-op");
  git(fx.root, "clone", "-q", origin, clone);
  writeFileSync(join(clone, "README"), "published\n");
  writeFileSync(join(clone, ".gitignore"), "node_modules/\n");
  git(clone, "add", ".");
  git(clone, "commit", "-q", "-m", "base");
  git(clone, "push", "-q", "origin", "HEAD:main");
  git(clone, "remote", "set-url", "origin", GITHUB);
  git(clone, "config", `url.file://${origin}.insteadOf`, GITHUB);
  return { fx, shim, clone, origin };
}

function pass(r: HomeRig, extra: Record<string, string> = {}) {
  const out = run(r.fx, {
    RMD_CLEANUP_LIVE_CHECKOUTS: r.clone, RMD_CLEANUP_WORKTREE_ROOTS: "", RMD_CLEANUP_PRESERVE_ROOTS: "",
    RMD_CLEANUP_DUMP_ROOTS: "", RMD_CLEANUP_AGENT_SCRATCH: "", RMD_CLEANUP_TMP_ROOTS: "",
    RMD_CLEANUP_GH_TOKEN_FILE: join(r.fx.root, "no-token"), GH_TOKEN: "fixture-token",
    PATH: `${r.shim.dir}:${process.env.PATH}`, GH_OPEN: "0", ...extra,
  });
  assert.equal(out.status, 0, out.stderr + out.stdout);
  return out.stdout;
}

/** A linked worktree of the clone at `dir`/`name`, with an unpublished commit and an uncommitted edit. */
function linkedTree(r: HomeRig, dir: string, name: string): string {
  const wt = join(r.clone, dir, name);
  mkdirSync(join(r.clone, dir), { recursive: true });
  git(r.clone, "worktree", "add", "-q", "-b", `hand/${name}`, wt, "main");
  writeFileSync(join(wt, "feature.txt"), "unpublished\n");
  git(wt, "add", "feature.txt");
  git(wt, "commit", "-q", "-m", "unpublished commit");
  writeFileSync(join(wt, "README"), "edited, not committed\n");
  return wt;
}

function copies(r: HomeRig, wt: string): string[] {
  const root = join(r.fx.root, "preserved");
  if (!existsSync(root)) return [];
  const stem = wt.replace(/^\//, "").replace(/\//g, "__") + "@";
  return readdirSync(root).filter(n => n.startsWith(stem)).map(n => join(root, n));
}

const drop = (r: HomeRig) => { rmSync(r.fx.root, { recursive: true, force: true }); rmSync(r.shim.dir, { recursive: true, force: true }); };

test("W1-T14929 an idle linked worktree of a home clone is preserve-retired", () => {
  const r = homeRig();
  try {
    const wt = linkedTree(r, ".claude/worktrees", "wt-idle");
    age(wt, 10 * DAY_HOURS);
    const out = pass(r);
    assert.match(out, new RegExp(`REMOVE ${wt}: uncommitted changes; idle 7 days, preserved then retired`));
    assert.equal(existsSync(wt), false, out);
    const [copy] = copies(r, wt);
    assert.ok(copy, out);
    for (const f of ["unpublished.bundle", "uncommitted.patch", "MANIFEST.txt"]) assert.equal(existsSync(join(copy, f)), true, `${f} in ${copy}`);
    assert.match(git(r.clone, "branch", "--list", "hand/wt-idle"), /hand\/wt-idle/, "the branch stays");
    assert.equal(existsSync(join(r.clone, "README")), true, "the clone's own checkout stays");
  } finally { drop(r); }
});

test("W1-T14929 a home checkout and a live linked tree are kept", () => {
  const r = homeRig();
  try {
    const open = linkedTree(r, ".worktrees", "wt-open");
    const locked = linkedTree(r, ".worktrees", "wt-locked");
    git(r.clone, "worktree", "lock", locked);
    const pr = linkedTree(r, ".worktrees", "wt-pr");
    // Pushed: the fixture writes the local origin and the remote-tracking ref (a GitHub push is blocked in tests).
    git(pr, "push", "-q", r.origin, "HEAD:refs/heads/hand/wt-pr");
    git(pr, "update-ref", "refs/remotes/origin/hand/wt-pr", "HEAD");
    for (const p of [open, locked, pr, r.clone]) age(p, 10 * DAY_HOURS);
    writeFileSync(r.fx.lsofList, `${open}\n`);

    const out = pass(r, { GH_OPEN: "1" });
    for (const kept of [open, locked, pr]) {
      assert.equal(existsSync(kept), true, `${kept} stays:\n${out}`);
      assert.doesNotMatch(out, new RegExp(`REMOVE ${kept}[: ]`));
      assert.deepEqual(copies(r, kept), [], `nothing is saved for ${kept}`);
    }
    assert.match(out, new RegExp(`KEEP ${pr}: linked worktree of ${r.clone} has an open pull request`));
    assert.equal(existsSync(join(r.clone, "README")), true, "the clone's own checkout is never retired");
    assert.doesNotMatch(out, new RegExp(`REMOVE ${r.clone}[: ]`));
  } finally { drop(r); }
});

test("W1-T14929 an admin-less linked tree is saved then removed", () => {
  const r = homeRig();
  try {
    const wt = linkedTree(r, ".worktrees", "wt-gone");
    mkdirSync(join(wt, "node_modules", "dep"), { recursive: true });
    writeFileSync(join(wt, "node_modules", "dep", "index.js"), "regenerable\n");
    rmSync(join(r.clone, ".git", "worktrees", "wt-gone"), { recursive: true, force: true });
    age(wt, 10 * DAY_HOURS);

    const out = pass(r);
    assert.match(out, new RegExp(`REMOVE ${wt}: linked worktree of ${r.clone} without admin directory; saved then removed`));
    assert.equal(existsSync(wt), false, out);
    const [copy] = copies(r, wt);
    assert.ok(copy, out);
    const listing = execFileSync("tar", ["-tzf", join(copy, "tree.tar.gz")], { encoding: "utf8" });
    assert.match(listing, /^wt-gone\/feature\.txt$/m, "the tree's files are in the tarball");
    assert.doesNotMatch(listing, /node_modules/, "node_modules is left out");
  } finally { drop(r); }
});
