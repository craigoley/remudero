/**
 * AN APPROVE TREE IS CUT PER ATTEMPT, SO NO OTHER TREE AT THE SAME SHA CAN BLOCK IT.
 *
 * 2026-11-18: the daemon and serve are separate clones with their own `.git`, but they share one
 * worktree root. The daemon's ratify gateway approved an item at main's sha and its refused approve
 * left `approve-<sha12>` behind. Serve's `git worktree list` cannot see a tree the daemon's clone
 * registers, so it read the path as absent, ran `git worktree add` there, and every Approve at that
 * sha died on "already exists" until main moved. The fixtures below build that topology for real:
 * one bare origin, two clones of it, and one shared worktree root.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";

import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { hostWorktreeGit } from "#src/lib/worktree-git.js";
import { buildFreshTreeReviewRunner, freshOriginMainTreeRunner, type FreshTreeTools } from "#src/run-task.js";
import { gitRepo, type GitRepo } from "#test/helpers/git-repo.js";

/** One bare origin and two clones of it (the daemon's and serve's), both at the same main sha. */
function twoClonesOneRoot(): { daemon: GitRepo; serve: GitRepo; sha: string; root: string } {
  const origin = gitRepo({ bare: true, kind: "approve-tree-origin" });
  const author = gitRepo({ kind: "approve-tree-author" });
  author.addRemote("origin", origin.dir);
  author.git("push", "-q", "origin", "main");
  const daemon = gitRepo({ cloneFrom: origin.dir, kind: "approve-tree-daemon" });
  const serve = gitRepo({ cloneFrom: origin.dir, kind: "approve-tree-serve" });
  const root = join(mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}approve-tree-root-`)), "worktrees");
  mkdirSync(root);
  return { daemon, serve, sha: daemon.git("rev-parse", "HEAD"), root };
}

/** The production seams fleetRatifyGateway wires, minus the node_modules link a fixture has no source for. */
function seams(repo: GitRepo, root: string, sha: string, extra: Partial<FreshTreeTools> = {}) {
  return {
    git: (args: string[]) => hostWorktreeGit(args[1] ?? repo.dir, args.slice(2)),
    addWorktree: (dir: string, path: string, revision: string) => void hostWorktreeGit(dir, ["worktree", "add", "--detach", path, revision]),
    worktreeRoot: root,
    prepareWorktree: () => true,
    mainTip: async () => sha,
    ...extra,
  };
}

const approveTrees = (root: string) => readdirSync(root).filter((name) => name.startsWith("approve-") && !name.endsWith(".lock"));

test("an approve at a sha another clone's leftover tree already names still runs", { timeout: 60_000 }, async () => {
  const { daemon, serve, sha, root } = twoClonesOneRoot();
  // The daemon's approve is refused by its child, the 03:54Z adoption approve's shape.
  const refused = await freshOriginMainTreeRunner(daemon.dir, seams(daemon, root, sha))(async () => {
    throw new Error("ratify.approve_refused: duplicate");
  }).then(() => "resolved", (error: Error) => error.message);
  assert.match(refused, /approve_refused/);
  // A leftover the daemon's clone registers, at the sha-keyed name the old code derived.
  daemon.git("worktree", "add", "--detach", join(root, `approve-${sha.slice(0, 12)}`), sha);

  let ranIn: string | undefined;
  const outcome = await freshOriginMainTreeRunner(serve.dir, seams(serve, root, sha))(async (tree) => {
    ranIn = tree.path;
    assert.equal(hostWorktreeGit(tree.path, ["rev-parse", "HEAD"]).trim(), sha);
    return "queued";
  });
  assert.equal(outcome, "queued");
  assert.ok(ranIn, "serve's approve must reach its child");
  assert.notEqual(basename(ranIn), `approve-${sha.slice(0, 12)}`);
  // Each attempt removed its own tree; only the deliberate leftover stays.
  assert.deepEqual(approveTrees(root), [`approve-${sha.slice(0, 12)}`]);
});

test("two concurrent approves at one sha each run in their own tree", { timeout: 60_000 }, async () => {
  const { daemon, sha, root } = twoClonesOneRoot();
  const runner = freshOriginMainTreeRunner(daemon.dir, seams(daemon, root, sha));
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const seen: string[] = [];
  const attempt = () => runner(async (tree) => {
    seen.push(tree.path);
    if (seen.length === 2) release();
    await barrier; // both attempts hold their trees at once
    return tree.path;
  });
  const [a, b] = await Promise.all([attempt(), attempt()]);
  assert.notEqual(a, b);
  assert.deepEqual(approveTrees(root), []);
});

test("an attempt's failed tree removal never replaces the attempt's outcome", { timeout: 60_000 }, async () => {
  const { daemon, sha, root } = twoClonesOneRoot();
  const removed: string[] = [];
  const runner = freshOriginMainTreeRunner(daemon.dir, seams(daemon, root, sha, {
    removeWorktree: (_dir, path) => { removed.push(path); throw new Error("worktree remove: busy"); },
  }));
  const path = await runner(async (tree) => tree.path);
  assert.deepEqual(removed, [path]);
  assert.ok(existsSync(path), "a tree whose removal failed is left for the worktree reaper");
});

test("an approve whose add fails removes nothing it did not make", { timeout: 60_000 }, async () => {
  const { daemon, sha, root } = twoClonesOneRoot();
  const removed: string[] = [];
  const runner = freshOriginMainTreeRunner(daemon.dir, seams(daemon, root, sha, {
    addWorktree: () => { throw new Error("fatal: add refused"); },
    removeWorktree: (_dir, path) => void removed.push(path),
  }));
  await assert.rejects(runner(async () => assert.fail("no tree, no child")), /add refused/);
  assert.deepEqual(removed, []);
});

test("a reviewer tree's stable path held by a directory its clone does not register is cut beside it", { timeout: 60_000 }, async () => {
  const { daemon, serve, sha, root } = twoClonesOneRoot();
  const stable = join(root, `reviewer-${sha.slice(0, 12)}`);
  daemon.git("worktree", "add", "--detach", stable, sha); // registered by the OTHER clone
  const spawnedIn: string[] = [];
  const failures: string[] = [];
  const review = buildFreshTreeReviewRunner(serve.dir, {
    ...seams(serve, root, sha),
    git: (args) => hostWorktreeGit(args[1] ?? serve.dir, args.slice(2)),
    withWorktreeLease: async (_tree, action) => action(),
    spawnReview: async (worktree) => { spawnedIn.push(worktree); return 0; },
  });
  const code = await review("1", [], { originMainSha: sha }, (failure) => failures.push(failure));
  assert.deepEqual(failures, []);
  assert.equal(code, 0);
  assert.equal(spawnedIn.length, 1);
  assert.notEqual(spawnedIn[0], stable);
  assert.equal(hostWorktreeGit(spawnedIn[0]!, ["rev-parse", "HEAD"]).trim(), sha);
});
