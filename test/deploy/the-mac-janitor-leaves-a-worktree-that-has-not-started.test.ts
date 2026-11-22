import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { ghShim } from "#test/helpers/gh-shim.js";
import { fixture, git, repos } from "#test/helpers/host-cleanup-fixture.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const janitor = join(REPO_ROOT, "deploy/mac/remudero-janitor.sh");
const guard = join(REPO_ROOT, "deploy/workspace-retirement-guard.sh");
const github = "https://github.com/craigoley/remudero.git";
const dispatch = "refs/rmd-dispatch/W1-T13216";
const reservation = "refs/rmd-id/W1-T13217";

function rig(t: TestContext) {
  const fx = fixture();
  t.after(() => rmSync(fx.root, { recursive: true, force: true }));
  const { main } = repos(fx);
  const origin = join(fx.root, "origin.git");
  git(main, "remote", "set-url", "origin", github);
  git(main, "config", `url.file://${origin}.insteadOf`, github);
  const treeRoot = join(realpathSync(fx.home), "Remudero");
  mkdirSync(treeRoot);
  const decisions = join(fx.root, "decisions.tsv");
  const shim = ghShim([
    { when: "select(.state", stdout: "1 1" },
    { when: "--jq length", exit: 1 },
  ], { parent: fx.root });
  const env = {
    ...process.env, ...fx.env, HOME: fx.home, TMPDIR: fx.scratch,
    PATH: `${shim.dir}:${join(fx.root, "bin")}:${process.env.PATH}`,
    REMUDERO_JANITOR_ACCOUNT_HOME: fx.home, REMUDERO_JANITOR_SCAN_ROOTS: fx.scratch,
    REMUDERO_JANITOR_DIRECTORY_ROOTS: fx.scratch, REMUDERO_JANITOR_LOG: join(fx.root, "janitor.log"),
    REMUDERO_JANITOR_LOCK_DIR: join(fx.root, "janitor.lock"), REMUDERO_JANITOR_DECISION_LOG: decisions,
  };
  function worktree(name: string, branch?: string, start = "origin/main") {
    const path = join(treeRoot, name);
    git(main, "worktree", "add", ...(branch ? ["-b", branch] : ["--detach"]), path, start);
    return path;
  }
  function pass(flag: "--apply" | "--dry-run", idleHours = 0) {
    // Advance only the janitor's clock, so real mtimes and ctimes agree on both hosts.
    const now = Math.floor(Date.now() / 1000) + idleHours * 3600 + 1;
    const date = ghShim([{ when: "+%s", stdout: String(now) }], { command: "date", parent: fx.root });
    const result = spawnSync("bash", [janitor, flag], {
      encoding: "utf8", timeout: 30_000, env: { ...env, PATH: `${date.dir}:${env.PATH}` },
    });
    assert.equal(result.status, 0, result.error?.message ?? result.stderr + result.stdout);
    return result.stdout;
  }
  return { main, origin, worktree, pass, env, shim, decisions };
}

test("W1-T13216 criterion 1: a new branch and a detached ancestor of main keep the six-hour rule", (t) => {
  const r = rig(t);
  git(r.main, "commit", "--allow-empty", "-m", "advance main");
  git(r.main, "push", r.origin, "HEAD:main");
  git(r.main, "update-ref", "refs/remotes/origin/main", "HEAD");
  const branch = r.worktree("wt-new", "run-W1-T13216-1795000000000");
  const detached = r.worktree("wt-detached", undefined, "origin/main^");
  const base = git(branch, "rev-parse", "HEAD").trim();
  const result = spawnSync("bash", ["-c", 'source "$1"; rmd_commit_pulls_finished "$2" "$3" && echo finished',
    "proof", guard, branch, base], { encoding: "utf8", env: r.env });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "finished", "the same main commit's own PR is closed");
  const lookupCount = r.shim.calls().length;
  const recent = r.pass("--apply");
  for (const path of [branch, detached]) {
    assert.ok(existsSync(path), recent);
    assert.ok(recent.includes(`SKIP recent-file-activity 0h ${path}`), recent);
  }
  assert.equal(r.shim.calls().length, lookupCount, recent);
  const idle = r.pass("--apply", 7);
  for (const path of [branch, detached]) assert.equal(existsSync(path), false, idle);
  assert.doesNotMatch(idle, /pull-request-finished/);
});

test("W1-T13216 criterion 2: aged dispatch and filing worktrees stay only while their refs are held", (t) => {
  const r = rig(t);
  const dispatched = r.worktree("wt-dispatch", "run-W1-T13216-1795000000000");
  const filerBranch = "run-unfiled-1795000000001";
  const filer = r.worktree("wt-filing", filerBranch);
  const otherBranch = `${filerBranch}0`;
  const other = r.worktree("wt-unheld", otherBranch);
  const tree = git(r.main, "rev-parse", "HEAD^{tree}").trim();
  const anchor = git(r.main, "commit-tree", tree, "-m", "reserve W1-T13217", "-m",
    `rmd-id holder branch=${filerBranch} pid=123 host=fixture`).trim();
  git(r.main, "push", r.origin, `HEAD:${dispatch}`, `${anchor}:${reservation}`);
  // This reservation was written elsewhere. The checkout cannot read its anchor.
  const remoteAnchor = git(r.origin, "commit-tree", tree, "-m", "reserve W1-T13218", "-m",
    `rmd-id holder branch=${otherBranch} pid=123 host=another-host`).trim();
  git(r.origin, "update-ref", "refs/rmd-id/W1-T13218", remoteAnchor);
  const held = r.pass("--apply", 7);
  assert.ok(held.includes(`SKIP not-started-held ${dispatch} ${dispatched}`), held);
  assert.ok(held.includes(`SKIP not-started-held ${reservation} ${filer}`), held);
  assert.ok(existsSync(dispatched) && existsSync(filer), held);
  assert.equal(existsSync(other), false, held);
  git(r.main, "push", r.origin, `:${dispatch}`, `:${reservation}`);
  const released = r.pass("--apply", 7);
  for (const path of [dispatched, filer]) {
    assert.ok(released.split("\n").some((line) => line.includes("REMOVED-WORKTREE 7h") && line.includes(path)), released);
    assert.equal(existsSync(path), false, released);
  }
});

test("W1-T13216 criterion 3: dry-run and apply identify recent, held and unreadable-ref worktrees", (t) => {
  const r = rig(t);
  const path = r.worktree("wt-report", "run-W1-T13216-1795000000000");
  git(r.main, "push", r.origin, `HEAD:${dispatch}`);
  for (const mode of ["--dry-run", "--apply"] as const) {
    const recent = r.pass(mode);
    assert.ok(recent.includes(`SKIP recent-file-activity 0h ${path}`), recent);
    const held = r.pass(mode, 7);
    assert.ok(held.includes(`SKIP not-started-held ${dispatch} ${path}`), held);
    renameSync(r.origin, `${r.origin}.offline`);
    try {
      const offline = r.pass(mode, 7);
      assert.ok(offline.includes(`SKIP publication-unverified ${path} (not-started-refs-unreadable)`), offline);
      assert.ok(existsSync(path), offline);
    } finally {
      renameSync(`${r.origin}.offline`, r.origin);
    }
  }
  const rows = readFileSync(r.decisions, "utf8").split("\n").map((line) => line.split("\t"));
  for (const reason of ["recent-file-activity", "not-started-held", "not-started-refs-unreadable"]) {
    assert.equal(rows.filter((row) => row[2] === "keep" && row[4]?.includes(path) && row[4]?.includes(reason)).length, 2);
  }
});

test("W1-T13216 criterion 4: a published PR tip still retires, and dirty or unpublished work stays", (t) => {
  const r = rig(t);
  const finished = r.worktree("wt-finished");
  git(finished, "commit", "--allow-empty", "-m", "finished PR tip");
  const head = git(finished, "rev-parse", "HEAD").trim();
  git(finished, "push", r.origin, "HEAD:refs/pull/42/head");
  const dirty = r.worktree("wt-dirty", "dirty", head);
  writeFileSync(join(dirty, "notes"), "uncommitted work\n");
  const unpublished = r.worktree("wt-unpublished");
  git(unpublished, "commit", "--allow-empty", "-m", "unpublished tip");
  git(unpublished, "push", r.origin, "HEAD:refs/rmd-dispatch/W1-T99999");
  const recent = r.pass("--apply");
  assert.match(recent, /REMOVED-WORKTREE pull-request-finished .*wt-finished/);
  assert.equal(existsSync(finished), false, recent);
  const idle = r.pass("--apply", 7);
  assert.match(idle, /SKIP dirty +.*wt-dirty/);
  assert.match(idle, /SKIP not-proven-published .*wt-unpublished/);
  assert.ok(existsSync(dirty) && existsSync(unpublished), idle);
});

test("an unreadable local main ref leaves the six-hour rule in force for a published PR tip", (t) => {
  const r = rig(t);
  const path = r.worktree("wt-no-local-main");
  git(path, "commit", "--allow-empty", "-m", "finished PR tip");
  git(path, "push", r.origin, "HEAD:refs/pull/42/head");
  git(r.main, "update-ref", "-d", "refs/remotes/origin/main");
  const recent = r.pass("--apply");
  assert.ok(recent.includes(`SKIP recent-file-activity 0h ${path}`), recent);
  assert.ok(existsSync(path), recent);
  const idle = r.pass("--apply", 7);
  assert.match(idle, /REMOVED-WORKTREE 7h .*wt-no-local-main/);
  assert.equal(existsSync(path), false, idle);
});
