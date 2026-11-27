import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import type { Config } from "#src/lib/config.js";
import { ReviewerWorktreeLeasedError, withReviewerWorktreeLease } from "#src/lib/reviewer-worktree-lease.js";
import { DEFAULT_WORKTREE_REAP_GRACE_MS, worktreeRemoveAsync } from "#src/lib/worker.js";
import { gitRepo, type GitRepo } from "#test/helpers/git-repo.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

// check-proof runs this file against main, where the reaper does not exist: that is a failing assertion, not a crash.
const reaperModule = existsSync(join(REPO_ROOT, "src", "lib", "reviewer-tree-reaper.ts"))
  ? await import("#src/lib/reviewer-tree-reaper.js") : undefined;
type Reap = typeof import("#src/lib/reviewer-tree-reaper.js").reapRetiredReviewerTreesAsync;
// W1-T14886: the reaper also walks the cut directory beside the code checkout; a fixture names its own code root so
// a pass never reads the real checkout's neighbours.
const reap: Reap = (config, log, opts = {}) => {
  assert.ok(reaperModule, "the production reviewer tree reaper must exist");
  return reaperModule.reapRetiredReviewerTreesAsync(config, log, { codeRoot: join(config.root, "code"), ...opts });
};

interface Row { step: string; extra?: Record<string, unknown> }
interface Reaped { roots: string[]; unreadable_roots: { root: string; error: string }[]; removed: { name: string; bytes: number }[]; bytes_freed: number;
  kept: { name: string; reason: string }[] }

const OLD_MS = DEFAULT_WORKTREE_REAP_GRACE_MS * 2;

/** A scratch repo with two commits, an origin whose main is the second, and a config root of its own. */
function fixture(t: TestContext, opts: { origin?: boolean } = {}) {
  const repo = gitRepo({ scope: t, kind: "t14148-repo" });
  writeFileSync(join(repo.dir, "a.txt"), "one\n".repeat(2000));
  repo.git("add", "a.txt"); repo.git("commit", "--quiet", "-m", "one");
  const oldSha = repo.git("rev-parse", "HEAD");
  writeFileSync(join(repo.dir, "a.txt"), "two\n");
  repo.git("commit", "--quiet", "-am", "two");
  const mainSha = repo.git("rev-parse", "HEAD");
  if (opts.origin !== false) {
    const origin = gitRepo({ scope: t, kind: "t14148-origin", bare: true });
    repo.addRemote("origin", origin.dir);
    repo.git("push", "--quiet", "origin", "main");
    repo.git("fetch", "--quiet", "origin");
  }
  const root = ownedFixtureDir(t, "t14148-root").dir;
  const trees = join(root, "state", "engines", "worktrees");
  mkdirSync(trees, { recursive: true });
  const rows: Row[] = [];
  const log = (step: string, extra?: Record<string, unknown>) => { rows.push({ step, extra }); };
  return { repo, oldSha, mainSha, trees, rows, log, config: { root } as Config };
}

function cut(repo: GitRepo, trees: string, name: string, sha: string): string {
  const path = join(trees, name);
  repo.git("worktree", "add", "--quiet", "--detach", path, sha);
  return path;
}

function age(path: string, ms = OLD_MS): void {
  const when = (Date.now() - ms) / 1000;
  utimesSync(path, when, when);
}

function reapedRows(rows: Row[]): Reaped[] {
  return rows.filter((r) => r.step === "reviewer_tree.reaped").map((r) => r.extra as unknown as Reaped);
}

function sha12(sha: string): string { return sha.slice(0, 12); }

test("W1-T14148 criterion 1: a tree leased by a live child pid, or borrowed by this process, is kept", async (t) => {
  const f = fixture(t);
  const held = cut(f.repo, f.trees, `reviewer-${sha12(f.oldSha)}`, f.oldSha); age(held);
  const child = spawn("sleep", ["60"], { stdio: "ignore" });
  t.after(() => { child.kill("SIGKILL"); });
  assert.ok(child.pid);
  writeFileSync(`${held}.lock`, JSON.stringify({ version: "reviewer-worktree-lease-v1", pid: child.pid,
    host: hostname(), startedAt: new Date().toISOString(), run_id: "a-spawned-reviewer" }));
  const first = await reap(f.config, f.log);
  assert.deepEqual(first.kept, [{ name: `reviewer-${sha12(f.oldSha)}`, reason: "leased" }]);
  assert.equal(existsSync(held), true, "a live holder's tree survives the pass");

  const borrowed = cut(f.repo, f.trees, `reviewer-${sha12(f.oldSha)}-4242-0badcafe`, f.oldSha); age(borrowed);
  const inside = await withReviewerWorktreeLease(borrowed, () => reap(f.config, f.log));
  assert.ok(inside.kept.some((k) => k.name === `reviewer-${sha12(f.oldSha)}-4242-0badcafe` && k.reason === "leased"));
  assert.equal(inside.removed.length, 0);
  assert.equal(existsSync(borrowed), true, "this process's own borrow survives the pass");
  assert.equal(reapedRows(f.rows).length, 0, "a pass that only keeps leased trees writes no row");
});

test("W1-T14148 criterion 2: an idle tree at an old sha is removed through git and its bytes are ledgered", async (t) => {
  const f = fixture(t);
  const name = `reviewer-${sha12(f.oldSha)}`;
  const tree = cut(f.repo, f.trees, name, f.oldSha); age(tree);
  const summary = await reap(f.config, f.log);
  assert.equal(existsSync(tree), false, "the directory is gone");
  assert.doesNotMatch(f.repo.git("worktree", "list", "--porcelain"), new RegExp(name), "git no longer lists it");
  const rows = reapedRows(f.rows);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].removed.map((r) => r.name), [name]);
  assert.ok(rows[0].removed[0].bytes > 0, "the tree's own bytes are measured");
  assert.equal(rows[0].bytes_freed, rows[0].removed.reduce((sum, r) => sum + r.bytes, 0));
  assert.ok(rows[0].bytes_freed > 0);
  assert.ok(rows[0].roots.includes(f.trees), "the legacy engines/worktrees root is still walked");
  assert.deepEqual(summary.removed, rows[0].removed);
  assert.equal(existsSync(`${tree}.lock`), false, "the pass releases its own claim");
});

test("W1-T14148 criterion 3: the tree at the registering repo's origin/main is kept however old it is", async (t) => {
  const f = fixture(t);
  const tree = cut(f.repo, f.trees, `reviewer-${sha12(f.mainSha)}`, f.mainSha); age(tree, OLD_MS * 100);
  const summary = await reap(f.config, f.log);
  assert.deepEqual(summary.kept, [{ name: `reviewer-${sha12(f.mainSha)}`, reason: "current-main" }]);
  assert.equal(existsSync(tree), true);
  assert.equal(reapedRows(f.rows).length, 0);
});

test("W1-T14148 criterion 4: a tree touched within the worktree-reaper grace is kept as recent activity", async (t) => {
  const f = fixture(t);
  const tree = cut(f.repo, f.trees, `reviewer-${sha12(f.oldSha)}`, f.oldSha);
  age(tree, DEFAULT_WORKTREE_REAP_GRACE_MS / 2);
  const summary = await reap(f.config, f.log);
  assert.deepEqual(summary.kept, [{ name: `reviewer-${sha12(f.oldSha)}`, reason: "recent-activity" }]);
  assert.equal(existsSync(tree), true);
});

test("W1-T14148 criterion 5: an unparseable lock keeps the tree as lease-unknown and the pass writes a row", async (t) => {
  const f = fixture(t);
  const name = `reviewer-${sha12(f.oldSha)}`;
  const tree = cut(f.repo, f.trees, name, f.oldSha); age(tree);
  writeFileSync(`${tree}.lock`, "{not a lease");
  const summary = await reap(f.config, f.log);
  assert.deepEqual(summary.kept, [{ name, reason: "lease-unknown" }]);
  assert.equal(existsSync(tree), true, "an unknown lease is never treated as free");
  assert.equal(readFileSync(`${tree}.lock`, "utf8"), "{not a lease", "the corrupt lock is preserved");
  const rows = reapedRows(f.rows);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].removed.length, 0);
  assert.deepEqual(rows[0].kept, [{ name, reason: "lease-unknown" }]);
});

test("W1-T14148 criterion 6: a per-attempt tree is removed and other names and lock files are untouched", async (t) => {
  const f = fixture(t);
  const attempt = `reviewer-${sha12(f.oldSha)}-31337-abcdef12`;
  const perAttempt = cut(f.repo, f.trees, attempt, f.oldSha); age(perAttempt);
  const approve = cut(f.repo, f.trees, `approve-${sha12(f.oldSha)}-1-abcdef12`, f.oldSha); age(approve);
  const notes = join(f.trees, "reviewer-notes"); mkdirSync(notes); age(notes);
  const orphanLock = join(f.trees, `reviewer-${sha12(f.oldSha)}.lock`);
  writeFileSync(orphanLock, "kept as is");
  const summary = await reap(f.config, f.log);
  assert.deepEqual(summary.removed.map((r) => r.name), [attempt]);
  assert.equal(existsSync(perAttempt), false);
  assert.equal(existsSync(approve), true);
  assert.equal(existsSync(notes), true);
  assert.equal(readFileSync(orphanLock, "utf8"), "kept as is");
  assert.equal(summary.kept.length, 0, "names outside both shapes are never candidates");
});

test("W1-T14148 criterion 7: while the pass removes a tree, a borrow of that tree is refused", async (t) => {
  const f = fixture(t);
  const tree = cut(f.repo, f.trees, `reviewer-${sha12(f.oldSha)}`, f.oldSha); age(tree);
  let entered!: () => void; const removing = new Promise<void>((done) => { entered = done; });
  let open!: () => void; const gate = new Promise<void>((done) => { open = done; });
  const pass = reap(f.config, f.log, { removeWorktree: async (repoDir, path) => {
    entered(); await gate; await worktreeRemoveAsync(repoDir, path);
  } });
  await removing;
  let ran = false;
  try {
    await assert.rejects(withReviewerWorktreeLease(tree, async () => { ran = true; }), ReviewerWorktreeLeasedError);
    assert.equal(ran, false, "the borrow never runs its action");
  } finally { open(); }
  const summary = await pass;
  assert.equal(summary.removed.length, 1);
  assert.equal(existsSync(`${tree}.lock`), false, "the pass's claim is gone once it settles");
});

test("W1-T14148: a removal that loses its own claim keeps the tree as removal-failed", async (t) => {
  const f = fixture(t);
  const name = `reviewer-${sha12(f.oldSha)}`;
  const tree = cut(f.repo, f.trees, name, f.oldSha); age(tree);
  const foreign = JSON.stringify({ version: "reviewer-worktree-lease-v1", pid: process.pid, host: hostname(),
    startedAt: new Date().toISOString(), run_id: "someone-else" });
  const summary = await reap(f.config, f.log, { removeWorktree: async () => { writeFileSync(`${tree}.lock`, foreign); } });
  assert.deepEqual(summary.kept, [{ name, reason: "removal-failed" }]);
  assert.equal(readFileSync(`${tree}.lock`, "utf8"), foreign, "another owner's lease is never removed");
  assert.equal(reapedRows(f.rows).length, 1);
});

test("W1-T14148: unregistered trees, an unreadable origin/main and stray files are kept or skipped", async (t) => {
  const f = fixture(t, { origin: false });
  const tree = cut(f.repo, f.trees, `reviewer-${sha12(f.oldSha)}`, f.oldSha); age(tree);
  const bare = join(f.trees, "reviewer-0123456789ab"); mkdirSync(bare); age(bare);
  const dangling = join(f.trees, "reviewer-ba9876543210"); mkdirSync(dangling); age(dangling);
  writeFileSync(join(dangling, ".git"), "gitdir: ../nowhere/.git/worktrees/x\n");
  writeFileSync(join(f.trees, "reviewer-aaaaaaaaaaaa"), "a file, not a tree");
  const summary = await reap(f.config, f.log);
  assert.deepEqual([...summary.kept].sort((a, b) => a.name.localeCompare(b.name)), [
    { name: "reviewer-0123456789ab", reason: "unregistered" },
    { name: `reviewer-${sha12(f.oldSha)}`, reason: "main-unreadable" },
    { name: "reviewer-ba9876543210", reason: "unregistered" },
  ].sort((a, b) => a.name.localeCompare(b.name)));
  assert.equal(existsSync(tree), true);
  assert.equal(reapedRows(f.rows).length, 1);
});

test("W1-T14148: a missing or unreadable root is an empty pass, and one pass runs at a time", async (t) => {
  const missing = ownedFixtureDir(t, "t14148-missing").dir;
  const rows: Row[] = [];
  const log = (step: string, extra?: Record<string, unknown>) => { rows.push({ step, extra }); };
  assert.deepEqual((await reap({ root: missing } as Config, log)).removed, []);
  const fileRoot = ownedFixtureDir(t, "t14148-file-root").dir;
  mkdirSync(join(fileRoot, "state", "engines"), { recursive: true });
  writeFileSync(join(fileRoot, "state", "engines", "worktrees"), "not a directory");
  assert.equal(rows.length, 0, "a missing root writes no row");
  const unreadable = await reap({ root: fileRoot } as Config, log);
  assert.deepEqual(unreadable.kept, []);
  // W1-T14886: a root that exists but cannot be listed is reported, never skipped silently.
  assert.deepEqual(unreadable.unreadable_roots.map((u) => u.root), [join(fileRoot, "state", "engines", "worktrees")]);
  assert.equal(reapedRows(rows).length, 1);
  rows.length = 0;
  const a = reap({ root: missing } as Config, log);
  const b = reap({ root: missing } as Config, log);
  assert.equal(a, b, "a second caller gets the pass already running");
  await a;
});

/** W1-T14886: a fixture whose code checkout sits at `<root>/slots/a`, so reviews cut trees in `<root>/slots/worktrees`. */
function slotFixture(t: TestContext) {
  const f = fixture(t);
  const codeRoot = join(f.config.root, "slots", "a");
  mkdirSync(codeRoot, { recursive: true });
  const slotTrees = join(f.config.root, "slots", "worktrees");
  mkdirSync(slotTrees, { recursive: true });
  return { ...f, codeRoot, slotTrees };
}

test("W1-T14886 a retired reviewer tree in the slots worktrees directory is reaped", async (t) => {
  const f = slotFixture(t);
  const name = `reviewer-${sha12(f.oldSha)}`;
  const tree = cut(f.repo, f.slotTrees, name, f.oldSha); age(tree);
  const summary = await reap(f.config, f.log, { codeRoot: f.codeRoot });
  assert.equal(existsSync(tree), false, "the retired tree in the cut directory is gone");
  assert.doesNotMatch(f.repo.git("worktree", "list", "--porcelain"), new RegExp(name), "git no longer lists it");
  assert.deepEqual(summary.removed.map((r) => r.name), [name]);
  assert.ok(summary.removed[0].bytes > 0 && summary.bytes_freed === summary.removed[0].bytes, "its bytes are reported");
  const rows = reapedRows(f.rows);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].bytes_freed, summary.bytes_freed, "the ledger row carries the bytes freed");
});

test("W1-T14886 the current-main and leased reviewer trees are kept", async (t) => {
  const f = slotFixture(t);
  const current = cut(f.repo, f.slotTrees, `reviewer-${sha12(f.mainSha)}`, f.mainSha); age(current, OLD_MS * 100);
  const leased = cut(f.repo, f.slotTrees, `reviewer-${sha12(f.oldSha)}-4242-0badcafe`, f.oldSha); age(leased);
  const summary = await withReviewerWorktreeLease(leased, () => reap(f.config, f.log, { codeRoot: f.codeRoot }));
  assert.deepEqual([...summary.kept].sort((a, b) => a.name.localeCompare(b.name)), [
    { name: `reviewer-${sha12(f.mainSha)}`, reason: "current-main" },
    { name: `reviewer-${sha12(f.oldSha)}-4242-0badcafe`, reason: "leased" },
  ].sort((a, b) => a.name.localeCompare(b.name)));
  assert.equal(summary.removed.length, 0);
  assert.equal(existsSync(current), true, "the tree at origin/main survives");
  assert.equal(existsSync(leased), true, "a leased tree survives");
});

test("W1-T14886 the reaper walks the directory a reviewer tree is cut in", async (t) => {
  assert.ok(reaperModule, "the production reviewer tree reaper must exist");
  const { reviewerTreeCutRoot } = reaperModule;
  assert.equal(typeof reviewerTreeCutRoot, "function", "the cut directory is named by one exported function");
  const f = slotFixture(t);
  assert.equal(reviewerTreeCutRoot(f.codeRoot), join(f.codeRoot, "..", "worktrees"));
  const summary = await reap(f.config, f.log, { codeRoot: f.codeRoot });
  assert.equal(summary.roots[0], resolve(reviewerTreeCutRoot(f.codeRoot)), "the cut directory is the first root walked");
  assert.ok(summary.roots.includes(resolve(f.trees)), "the legacy engines/worktrees root is walked as well");
});
