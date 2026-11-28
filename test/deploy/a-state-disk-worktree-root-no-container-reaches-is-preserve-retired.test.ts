/**
 * W1-T14891: a worktree root on the state disk that a container bind mount shadows (the daemon mounts the scratch
 * copy over its worktrees folder) is reached by no container. The janitor judges its trees as hand worktrees: an
 * idle one with unsaved work is preserved (MANIFEST, verified bundle, patch), then retired. A root a running
 * container mounts is left alone. Driven as the real deploy/rmd-host-cleanup.sh against fixture roots only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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

/** A docker stub with one running container that mounts `path`. */
function mounted(r: Rig, path: string): string {
  const docker = join(r.fx.root, "docker-mounted");
  writeFileSync(docker, `#!/usr/bin/env bash
case "$1" in
  ps) printf 'fixture-container\\n' ;;
  inspect) case "$*" in *.Name*) printf '/fixture-container\\n' ;; *) printf '%s\\n' '${path}' ;; esac ;;
  *) exit 64 ;;
esac
`, { mode: 0o755 });
  return docker;
}

test("W1-T14891 a shadowed state-disk worktree is preserve-retired", () => {
  const r = rig();
  const { wt } = shadowedTree(r, "run-W1-T9001-1");
  const out = pass(r);
  assert.match(out, new RegExp(`shadowed worktree root ${r.root} \\(no running container mounts it\\)`), "the default root is the state disk's state2/worktrees");
  assert.match(out, new RegExp(`REMOVE ${wt}: uncommitted changes; idle 7 days, preserved then retired`));
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
  const out = pass(r, { RMD_CLEANUP_DOCKER: mounted(r, r.root) });
  assert.match(out, new RegExp(`KEEP ${r.root}: a running container mounts this worktree root`));
  assert.equal(existsSync(wt), true, out);
  assert.doesNotMatch(out, new RegExp(`REMOVE ${wt}[: ]`));
  assert.deepEqual(copies(r, wt), []);
});
