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
  git(clone, "update-ref", "refs/remotes/origin/main", "HEAD");
  git(clone, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
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

function stubUnpublishedHead(r: HomeRig, head: string): void {
  r.shim.addRoute({
    when: `api repos/craigoley/remudero/commits/${head}/pulls`,
    stderr: `gh: No commit found for SHA: ${head} (HTTP 422)\n{"message":"No commit found for SHA: ${head}","documentation_url":"https://docs.github.com/rest/commits/commits#list-pull-requests-associated-with-a-commit"}`,
    exit: 1,
  });
}

const drop = (r: HomeRig) => { rmSync(r.fx.root, { recursive: true, force: true }); rmSync(r.shim.dir, { recursive: true, force: true }); };

test("W1-T14929 an idle linked worktree of a home clone is preserve-retired", () => {
  const r = homeRig();
  try {
    const wt = linkedTree(r, ".claude/worktrees", "wt-idle");
    stubUnpublishedHead(r, git(wt, "rev-parse", "HEAD").trim());
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

test("W1-T14929 an unpublished home-tree HEAD with GitHub 422 is not treated as an open PR", () => {
  const r = homeRig();
  try {
    const wt = linkedTree(r, ".worktrees", "wt-unpublished-head");
    const head = git(wt, "rev-parse", "HEAD").trim();
    stubUnpublishedHead(r, head);
    age(wt, 10 * DAY_HOURS);

    const out = pass(r);
    assert.match(out, new RegExp(`REMOVE ${wt}: uncommitted changes; idle 7 days, preserved then retired`));
    assert.equal(existsSync(wt), false, out);
    assert.ok(copies(r, wt)[0], out);
    assert.ok(r.shim.calls().some(call => call.includes(head)), "HEAD itself is checked with GitHub");
  } finally { drop(r); }
});

test("W1-T14929 an unpublished HEAD still checks related published PR tips", () => {
  const r = homeRig();
  try {
    const wt = linkedTree(r, ".worktrees", "wt-unpublished-after-pr");
    git(wt, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    git(wt, "push", "-q", r.origin, "HEAD:refs/heads/hand/published-pr-tip");
    git(wt, "update-ref", "refs/remotes/origin/hand/published-pr-tip", "HEAD");
    const publishedTip = git(wt, "rev-parse", "HEAD").trim();
    writeFileSync(join(wt, "followup.txt"), "local commit after the published tip\n");
    git(wt, "add", "followup.txt");
    git(wt, "commit", "-q", "-m", "local commit after the published tip");
    const head = git(wt, "rev-parse", "HEAD").trim();
    stubUnpublishedHead(r, head);
    age(wt, 10 * DAY_HOURS);

    const out = pass(r, { GH_OPEN: "1" });
    assert.equal(existsSync(wt), true, `related published PR tip keeps the tree:\n${out}`);
    assert.match(out, new RegExp(`KEEP ${wt}: linked worktree of ${r.clone} has an open pull request`));
    assert.ok(r.shim.calls().some(call => call.includes(publishedTip)), `the related published tip is checked: ${r.shim.calls().join(" | ")}\n${out}`);
  } finally { drop(r); }
});

test("W1-T14929 a diverged same-named origin tip with an open PR keeps the home tree", () => {
  const r = homeRig();
  try {
    const wt = linkedTree(r, ".worktrees", "wt-diverged-pr-tip");
    git(wt, "push", "-q", r.origin, "HEAD:refs/heads/hand/wt-diverged-pr-tip");
    git(wt, "update-ref", "refs/remotes/origin/hand/wt-diverged-pr-tip", "HEAD");
    const publishedTip = git(wt, "rev-parse", "HEAD").trim();
    git(wt, "commit", "--amend", "--no-edit", "-q", "-m", "rebased unpublished head");
    const amendedHead = git(wt, "rev-parse", "HEAD").trim();
    assert.notEqual(amendedHead, publishedTip, "the local branch diverges from its published PR tip");
    age(wt, 10 * DAY_HOURS);

    const out = pass(r, { GH_OPEN: "1" });
    assert.equal(existsSync(wt), true, `published branch PR tip keeps the tree:\n${out}`);
    assert.match(out, new RegExp(`KEEP ${wt}: linked worktree of ${r.clone} has an open pull request`));
    assert.ok(r.shim.calls().some(call => call.includes(publishedTip)), `published tip is checked: ${r.shim.calls().join(" | ")}\n${out}`);
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

test("W1-T14929 a home checkout and a live linked tree are kept: a detached or renamed tree with an open pull request", () => {
  const r = homeRig();
  try {
    const detached = linkedTree(r, ".worktrees", "wt-detached");
    git(detached, "push", "-q", r.origin, "HEAD:refs/heads/run-W1-T9001-1");
    git(detached, "update-ref", "refs/remotes/origin/run-W1-T9001-1", "HEAD");
    git(detached, "checkout", "-q", "--detach");
    const renamed = linkedTree(r, ".worktrees", "wt-renamed");
    git(renamed, "push", "-q", r.origin, "HEAD:refs/heads/pr-branch-elsewhere");
    git(renamed, "update-ref", "refs/remotes/origin/pr-branch-elsewhere", "HEAD");
    writeFileSync(join(renamed, "more.txt"), "a later unpublished commit\n");
    git(renamed, "add", "more.txt");
    git(renamed, "commit", "-q", "-m", "after the PR head");
    for (const p of [detached, renamed]) age(p, 10 * DAY_HOURS);

    const out = pass(r, { GH_OPEN: "1" });
    for (const kept of [detached, renamed]) {
      assert.equal(existsSync(kept), true, `${kept} stays:\n${out}`);
      assert.match(out, new RegExp(`KEEP ${kept}: linked worktree of ${r.clone} has an open pull request`));
      assert.deepEqual(copies(r, kept), []);
    }
  } finally { drop(r); }
});

test("W1-T14929 home clone PR lookup covers detached HEADs without holding base commits for unrelated refs", () => {
  const r = homeRig();
  try {
    const atBase = join(r.clone, ".worktrees", "wt-at-base");
    mkdirSync(join(r.clone, ".worktrees"), { recursive: true });
    git(r.clone, "worktree", "add", "-q", "--detach", atBase, "main");
    writeFileSync(join(atBase, "README"), "dirty work on base\n");

    // An unrelated later origin branch contains main. It is not evidence of a PR for a tree
    // whose HEAD is already in the default branch.
    git(r.clone, "checkout", "-q", "-b", "unrelated-later");
    writeFileSync(join(r.clone, "later.txt"), "unrelated later branch\n");
    git(r.clone, "add", "later.txt");
    git(r.clone, "commit", "-q", "-m", "unrelated later branch");
    git(r.clone, "update-ref", "refs/remotes/origin/unrelated-later", "HEAD");
    age(atBase, 10 * DAY_HOURS);

    const detached = linkedTree(r, ".worktrees", "wt-pull-ref");
    git(detached, "update-ref", "refs/pull/12/head", "HEAD");
    git(detached, "checkout", "-q", "--detach");
    age(detached, 10 * DAY_HOURS);

    const out = pass(r, { GH_OPEN: "1" });
    assert.match(out, new RegExp(`REMOVE ${atBase}: uncommitted changes; idle 7 days, preserved then retired`));
    assert.equal(existsSync(atBase), false, out);
    assert.equal(existsSync(detached), true, `detached open-PR HEAD stays:\n${out}`);
    assert.match(out, new RegExp(`KEEP ${detached}: linked worktree of ${r.clone} has an open pull request`));
    assert.deepEqual(copies(r, detached), []);
  } finally { drop(r); }
});

test("W1-T14929 a recent clean home linked tree waits for the retain window after its PR is finished", () => {
  const r = homeRig();
  try {
    const wt = join(r.clone, ".worktrees", "wt-recent-clean");
    mkdirSync(join(r.clone, ".worktrees"), { recursive: true });
    git(r.clone, "worktree", "add", "-q", "--detach", wt, "main");
    age(wt, 10 * DAY_HOURS);
    writeFileSync(join(wt, "README"), "published\n"); // Recent clean payload; Git's HEAD metadata stays old.
    // Make the finished-PR fast path eligible, so the test distinguishes it from idle-window handling.
    r.shim.addRoute({
      when: '"\\(length) \\([.[] | select(.state == "closed")] | length)"',
      stdout: "1 1",
    });

    const out = pass(r, { GH_OPEN: "0" });
    assert.equal(existsSync(wt), true, `recent tree waits for retention:\n${out}`);
    assert.match(out, new RegExp(`KEEP ${wt}: written within 10080 min`));
    assert.deepEqual(copies(r, wt), []);
  } finally { drop(r); }
});
