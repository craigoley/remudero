/**
 * W1-T14891: a worktree root on the state disk that a container bind mount shadows (the daemon mounts the scratch
 * copy over its worktrees folder) is reached by no container. The janitor judges its trees as hand worktrees: an
 * idle one with unsaved work is preserved (MANIFEST, verified bundle, patch), then retired. A root a running
 * container mounts is left alone. Driven as the real deploy/rmd-host-cleanup.sh against fixture roots only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { age, fixture, git, run, type Fixture } from "#test/helpers/host-cleanup-fixture.js";

const DAY_HOURS = 24;

interface Rig { fx: Fixture; state: string; root: string; clone: string }

/** A state disk with state2/worktrees, and a clone on the host whose linked worktrees live there. */
function rig(): Rig {
  const fx = fixture();
  const state = join(fx.root, "mnt-rmd");
  const root = join(state, "state2", "worktrees");
  mkdirSync(root, { recursive: true });
  const origin = join(fx.root, "origin.git");
  git(fx.root, "init", "-q", "--bare", "-b", "main", origin);
  const clone = join(fx.root, "clone");
  git(fx.root, "clone", "-q", origin, clone);
  writeFileSync(join(clone, "README"), "published\n");
  git(clone, "add", "README");
  git(clone, "commit", "-q", "-m", "base");
  git(clone, "push", "-q", "origin", "HEAD:main");
  return { fx, state, root, clone };
}

/** A tree under the shadowed root with an unpublished commit and an uncommitted edit, idle ten days. */
function shadowedTree(r: Rig, name: string): { wt: string; commit: string } {
  const wt = join(r.root, name);
  git(r.clone, "worktree", "add", "-q", "-b", `run/${name}`, wt, "main");
  writeFileSync(join(wt, "feature.txt"), "unpublished\n");
  git(wt, "add", "feature.txt");
  git(wt, "commit", "-q", "-m", "unpublished commit");
  writeFileSync(join(wt, "README"), "edited, not committed\n");
  age(wt, 10 * DAY_HOURS);
  return { wt, commit: git(wt, "rev-parse", "HEAD").trim() };
}

function pass(r: Rig, extra: Record<string, string> = {}) {
  const out = run(r.fx, {
    RMD_CLEANUP_STATE_DISK: r.state, RMD_CLEANUP_WORKTREE_ROOTS: "", RMD_CLEANUP_LIVE_CHECKOUTS: "",
    RMD_CLEANUP_PRESERVE_ROOTS: "", RMD_CLEANUP_DUMP_ROOTS: "", RMD_CLEANUP_RETAIN_ROOTS: "",
    RMD_CLEANUP_AGENT_SCRATCH: "", RMD_CLEANUP_TMP_ROOTS: "", RMD_CLEANUP_STATE_PARENTS: "",
    RMD_CLEANUP_PUBLISHED_REMOTES: join(r.fx.root, "origin.git"), ...extra,
  });
  assert.equal(out.status, 0, out.stderr + out.stdout);
  return out.stdout;
}

function copies(r: Rig, wt: string): string[] {
  const root = join(r.fx.root, "preserved");
  if (!existsSync(root)) return [];
  const stem = wt.replace(/^\//, "").replace(/\//g, "__") + "@";
  return readdirSync(root).filter(n => n.startsWith(stem)).map(n => join(root, n));
}

/** A docker stub with one running container whose mounts are `mounts` ([source, destination] pairs). */
function container(r: Rig, mounts: Array<[string, string]>): string {
  const docker = join(r.fx.root, "docker-mounts");
  const pairs = mounts.map(([src, dst]) => `${src}\\t${dst}\\n`).join("");
  const sources = mounts.map(([src]) => `${src}\\n`).join("");
  writeFileSync(docker, `#!/usr/bin/env bash
case "$1" in
  ps) printf 'fixture-container\\n' ;;
  inspect) case "$*" in *.Name*) printf '/fixture-container\\n' ;; *Destination*) printf '${pairs}' ;; *) printf '${sources}' ;; esac ;;
  *) exit 64 ;;
esac
`, { mode: 0o755 });
  return docker;
}

test("W1-T14891 a shadowed state-disk worktree is preserve-retired", () => {
  const r = rig();
  const { wt } = shadowedTree(r, "run-W1-T9001-1");
  const out = pass(r);
  assert.match(out, new RegExp(`shadowed worktree root ${r.root} \\(no running container reaches it\\)`), "the default root is the state disk's state2/worktrees");
  assert.match(out, new RegExp(`REMOVE ${wt}: under shadowed worktree root ${r.root}; idle 7 days, preserved then retired`));
  assert.equal(existsSync(wt), false, out);
  const [copy] = copies(r, wt);
  assert.ok(copy, out);
  assert.match(readFileSync(join(copy, "MANIFEST.txt"), "utf8"), new RegExp(`path:   ${wt}`));
  assert.equal(existsSync(join(copy, "uncommitted.patch")), true);
});

test("W1-T14891 an unpublished commit is bundled before the tree is removed", () => {
  const r = rig();
  const { wt, commit } = shadowedTree(r, "run-W1-T9002-1");
  const out = pass(r);
  assert.equal(existsSync(wt), false, out);
  const [copy] = copies(r, wt);
  assert.ok(copy, out);
  const bundle = join(copy, "unpublished.bundle");
  git(r.clone, "bundle", "verify", bundle);
  const restore = join(r.fx.root, "restore");
  git(r.fx.root, "clone", "-q", join(r.fx.root, "origin.git"), restore);
  git(restore, "fetch", "-q", bundle, `${commit}:restored`);
  assert.equal(git(restore, "rev-parse", "restored").trim(), commit, "the bundle restores the unpublished commit");
});

test("W1-T14891 a mounted worktree root is left alone", () => {
  const r = rig();
  const { wt } = shadowedTree(r, "run-W1-T9003-1");
  const out = pass(r, { RMD_CLEANUP_DOCKER: container(r, [[r.root, "/home/node/Remudero/worktrees"]]) });
  assert.match(out, new RegExp(`KEEP ${r.root}: a running container reaches this worktree root`));
  assert.equal(existsSync(wt), true, out);
  assert.doesNotMatch(out, new RegExp(`REMOVE ${wt}[: ]`));
  assert.deepEqual(copies(r, wt), []);
});

test("W1-T14891 a mounted worktree root is left alone when the mount source is a bind alias", () => {
  const r = rig();
  const { wt } = shadowedTree(r, "run-W1-T9007-1");
  const alias = join(r.fx.root, "mount-alias");
  mkdirSync(alias);
  const st = statSync(r.root);
  const identity = `${st.dev}:${st.ino}`;
  // The host's own stat, found before the stub dir joins PATH (Linux and macOS keep it in different places).
  const realStat = execFileSync("sh", ["-c", "command -v stat"], { encoding: "utf8" }).trim();
  const statStub = join(r.fx.root, "stat");
  writeFileSync(statStub, `#!/usr/bin/env bash
for arg; do path="$arg"; done
if [ "$path" = "${alias}" ] || [ "$path" = "${r.root}" ]; then printf '%s\\n' '${identity}'; exit 0; fi
exec "${realStat}" "$@"
`, { mode: 0o755 });
  const out = pass(r, {
    PATH: `${r.fx.root}:${process.env.PATH}`,
    RMD_CLEANUP_DOCKER: container(r, [[alias, "/home/node/Remudero/worktrees"]]),
  });
  assert.match(out, new RegExp(`KEEP ${r.root}: a running container reaches this worktree root`));
  assert.equal(existsSync(wt), true, out);
  assert.deepEqual(copies(r, wt), []);
});

test("W1-T14891 a file bind mount does not make the state-disk root unreadable", () => {
  const r = rig();
  const { wt } = shadowedTree(r, "run-W1-T9010-1");
  const accountFile = join(r.fx.root, "account-file");
  writeFileSync(accountFile, "fixture account data\n");
  const out = pass(r, { RMD_CLEANUP_DOCKER: container(r, [[accountFile, "/etc/account-file"]]) });
  assert.match(out, new RegExp(`REMOVE ${wt}: under shadowed worktree root ${r.root}; idle 7 days, preserved then retired`));
  assert.equal(existsSync(wt), false, out);
  assert.ok(copies(r, wt)[0], out);
});

test("W1-T14891 a container-form gitdir is translated before preserving and retiring", () => {
  const r = rig();
  const hostState2 = join(r.state, "state2");
  const clone = join(hostState2, "remudero");
  mkdirSync(hostState2, { recursive: true });
  git(r.fx.root, "clone", "-q", join(r.fx.root, "origin.git"), clone);
  const wt = join(r.root, "run-W1-T9008-1");
  git(clone, "worktree", "add", "-q", "-b", "run/container-form", wt, "main");
  writeFileSync(join(wt, "feature.txt"), "unpublished\n");
  git(wt, "add", "feature.txt");
  git(wt, "commit", "-q", "-m", "unpublished container-form commit");
  writeFileSync(join(wt, "README"), "edited, not committed\n");
  writeFileSync(join(wt, "loose.txt"), "untracked payload\n");
  age(wt, 10 * DAY_HOURS);

  const gitfile = join(wt, ".git");
  const hostGitdir = readFileSync(gitfile, "utf8").trim().slice("gitdir: ".length);
  const backfile = join(hostGitdir, "gitdir");
  const hostBackpointer = readFileSync(backfile, "utf8").trim();
  const stateAlias = join(r.fx.root, "state2-bind-alias");
  symlinkSync(hostState2, stateAlias);
  writeFileSync(gitfile, "gitdir: /home/node/Remudero/remudero/.git/worktrees/run-W1-T9008-1\n");
  writeFileSync(backfile, "/home/node/Remudero/worktrees/run-W1-T9008-1/.git\n");

  const scratchWorktrees = join(r.fx.root, "container-scratch-worktrees");
  mkdirSync(scratchWorktrees, { recursive: true });
  const docker = container(r, [[stateAlias, "/home/node/Remudero"], [scratchWorktrees, "/home/node/Remudero/worktrees"]]);
  const out = pass(r, { RMD_CLEANUP_DOCKER: docker });
  assert.match(out, new RegExp(`REMOVE ${wt}: under shadowed worktree root ${r.root}; idle 7 days, preserved then retired`));
  assert.equal(existsSync(wt), false, out);
  const [copy] = copies(r, wt);
  assert.ok(copy, out);
  assert.match(readFileSync(join(copy, "MANIFEST.txt"), "utf8"), new RegExp(`path:   ${wt}`));
  assert.equal(existsSync(join(copy, "uncommitted.patch")), true);
  const savedTar = join(copy, "untracked.tar.gz");
  assert.equal(existsSync(savedTar), true);
  assert.match(execFileSync("tar", ["-tzf", savedTar], { encoding: "utf8" }), /loose\.txt/);
  assert.equal(hostBackpointer, `${wt}/.git`);
});

test("W1-T14891 a dry run reads translated container Git metadata without rewriting its pointers", () => {
  const r = rig();
  const hostState2 = join(r.state, "state2");
  const clone = join(hostState2, "remudero");
  mkdirSync(hostState2, { recursive: true });
  git(r.fx.root, "clone", "-q", join(r.fx.root, "origin.git"), clone);
  const wt = join(r.root, "run-W1-T9011-1");
  git(clone, "worktree", "add", "-q", "-b", "run/dry-run-container-form", wt, "main");
  age(wt, 10 * DAY_HOURS);
  const gitfile = join(wt, ".git");
  const hostGitdir = readFileSync(gitfile, "utf8").trim().slice("gitdir: ".length);
  const backfile = join(hostGitdir, "gitdir");
  const originalGitfile = "gitdir: /home/node/Remudero/remudero/.git/worktrees/run-W1-T9011-1\n";
  const originalBackpointer = "/home/node/Remudero/worktrees/run-W1-T9011-1/.git\n";
  writeFileSync(gitfile, originalGitfile);
  writeFileSync(backfile, originalBackpointer);
  const scratch = join(r.fx.root, "scratch");
  mkdirSync(scratch, { recursive: true });
  const docker = container(r, [[hostState2, "/home/node/Remudero"], [scratch, "/home/node/Remudero/worktrees"]]);
  const out = pass(r, { DRY_RUN: "1", RMD_CLEANUP_DOCKER: docker });
  assert.match(out, new RegExp(`DRYRUN would: preserve then retire ${wt}`));
  assert.equal(readFileSync(gitfile, "utf8"), originalGitfile);
  assert.equal(readFileSync(backfile, "utf8"), originalBackpointer);
});

test("W1-T14891 a shadowed state-disk worktree is preserve-retired: the state folder is mounted and a deeper mount covers its worktrees", () => {
  const r = rig();
  const { wt } = shadowedTree(r, "run-W1-T9004-1");
  const scratchCopy = join(r.fx.root, "scratch-worktrees");
  mkdirSync(scratchCopy, { recursive: true });
  const docker = container(r, [[join(r.state, "state2"), "/home/node/Remudero"], [scratchCopy, "/home/node/Remudero/worktrees"]]);
  const out = pass(r, { RMD_CLEANUP_DOCKER: docker });
  assert.match(out, new RegExp(`shadowed worktree root ${r.root} \\(no running container reaches it\\)`));
  assert.equal(existsSync(wt), false, out);
  assert.ok(copies(r, wt)[0], out);

  const reached = rig();
  const kept = shadowedTree(reached, "run-W1-T9005-1").wt;
  const parentOnly = container(reached, [[join(reached.state, "state2"), "/home/node/Remudero"]]);
  const keptOut = pass(reached, { RMD_CLEANUP_DOCKER: parentOnly });
  assert.match(keptOut, new RegExp(`KEEP ${reached.root}: a running container reaches this worktree root`));
  assert.equal(existsSync(kept), true, keptOut);
});

test("W1-T14891 an unpublished commit is bundled before the tree is removed: a clean tree waits the held window and leaves a MANIFEST", () => {
  const r = rig();
  const wt = join(r.root, "run-W1-T9006-1");
  git(r.clone, "worktree", "add", "-q", "-b", "run/clean", wt, "main");
  age(wt, 2 * DAY_HOURS);
  const early = pass(r);
  assert.equal(existsSync(wt), true, `a clean tree idle two days stays:\n${early}`);
  age(wt, 10 * DAY_HOURS);
  const out = pass(r);
  assert.equal(existsSync(wt), false, out);
  const [copy] = copies(r, wt);
  assert.ok(copy && existsSync(join(copy, "MANIFEST.txt")), `a clean tree also leaves a MANIFEST:\n${out}`);
});
