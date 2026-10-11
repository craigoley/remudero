import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { makeTempDir } from "../src/lib/tmp.js";
import { withReviewerWorktreeLease } from "../src/lib/reviewer-worktree-lease.js";
import { reviewAdvanceIsMaterial } from "../src/lib/self-sync.js";
import { reapStaleWorktrees } from "../src/lib/worker.js";
import { buildFreshTreeReviewRunner } from "../src/run-task.js";
import { gitRepo } from "./helpers/git-repo.js";

function fixture(t: { after: (fn: () => void) => void }) {
  const root = makeTempDir("reviewer-lease");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "reviewer"); mkdirSync(path);
  return { root, path, lock: `${path}.lock` };
}

function foreign() {
  return { version: "reviewer-worktree-lease-v1", pid: process.pid, host: hostname(),
    startedAt: new Date().toISOString(), run_id: "a-different-live-reviewer" };
}

test("reviewer lease retains the real source through native publication while the real reaper removes an idle sibling", async (t) => {
  const repo = gitRepo({ kind: "reviewer-lease-reaper" }); t.after(() => repo.cleanup());
  const root = makeTempDir("reviewer-lease-reaper"); t.after(() => rmSync(root, { recursive: true, force: true }));
  const active = join(root, "reviewer-active"); const idle = join(root, "reviewer-idle");
  repo.git("worktree", "add", "--detach", active, "HEAD");
  repo.git("worktree", "add", "--detach", idle, "HEAD");
  await withReviewerWorktreeLease(active, async () => {
    const swept = reapStaleWorktrees(root, { maxAgeMs: 0 });
    assert.ok(swept.keptReasons?.some((row) => row.name === "reviewer-active" && row.reason === "live-pid"));
    assert.ok(swept.reaped.includes("reviewer-idle"), "the real reaper must positively remove its eligible corpus");
    const child = spawnSync(process.execPath, ["-e", "const fs=require('node:fs');fs.readFileSync(process.argv[1]+'/.git');fs.readFileSync(process.argv[1]+'.lock');console.log('terminal-source-readable')", active], { encoding: "utf8" });
    assert.equal(child.status, 0, child.stderr); assert.match(child.stdout, /terminal-source-readable/);
    assert.ok(existsSync(active)); assert.equal(existsSync(idle), false);
  });
  assert.equal(existsSync(`${active}.lock`), false);
  assert.ok(reapStaleWorktrees(root, { maxAgeMs: 0 }).reaped.includes("reviewer-active"));
});

test("one concurrent reviewer completion retains every remaining borrow", async (t) => {
  const f = fixture(t); let finishA!: () => void; let finishB!: () => void;
  const a = withReviewerWorktreeLease(f.path, () => new Promise<void>((done) => { finishA = done; }));
  const b = withReviewerWorktreeLease(f.path, () => new Promise<void>((done) => { finishB = done; }));
  const raw = readFileSync(f.lock, "utf8"); finishA(); await a;
  assert.equal(readFileSync(f.lock, "utf8"), raw); finishB(); await b;
  assert.equal(existsSync(f.lock), false);
});

test("reviewer native failure releases only its own lease and preserves the original failure", async (t) => {
  const f = fixture(t); const failure = new Error("native reviewer failed");
  await assert.rejects(withReviewerWorktreeLease(f.path, async () => { throw failure; }), (error) => error === failure);
  assert.equal(existsSync(f.lock), false);
});

test("foreign and corrupt reviewer claims refuse without executing or deleting their holder", async (t) => {
  const f = fixture(t);
  for (const raw of [JSON.stringify(foreign()), JSON.stringify({ ...foreign(), host: "a-different-host" }),
    "not-json", JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })]) {
    writeFileSync(f.lock, raw); let called = false;
    await assert.rejects(withReviewerWorktreeLease(f.path, async () => { called = true; }));
    assert.equal(called, false); assert.equal(readFileSync(f.lock, "utf8"), raw);
  }
});

test("the shipped fresh reviewer runner refuses a dirty cached tree before starting another native review", async (t) => {
  const repo = gitRepo({ kind: "reviewer-runner-dirty-cache" }); t.after(() => repo.cleanup());
  writeFileSync(join(repo.dir, "review-source.txt"), "clean source\n");
  repo.git("add", "review-source.txt"); repo.git("commit", "--quiet", "-m", "seed reviewer source");
  repo.addRemote("origin", repo.dir); repo.git("branch", "-M", "main");
  mkdirSync(join(repo.dir, "node_modules"));
  const root = makeTempDir("reviewer-runner-dirty-cache"); t.after(() => rmSync(root, { recursive: true, force: true }));
  const sha = repo.git("rev-parse", "HEAD"); let calls = 0;
  const runner = buildFreshTreeReviewRunner(repo.dir, {
    git: (args) => spawnGit(args), worktreeRoot: root,
    addWorktree: (dir, path, head) => { spawnGit(["-C", dir, "worktree", "add", "--detach", path, head]); },
    spawnReview: async () => { calls++; return 0; },
  });
  assert.equal(await runner("10783", [], { originMainSha: sha }), 0);
  const path = join(root, `reviewer-${sha.slice(0, 12)}`);
  writeFileSync(join(path, "review-source.txt"), "unreviewed changed source\n");
  let failure = "";
  assert.equal(await runner("10783", [], { originMainSha: sha }, (why) => { failure = why; }), undefined);
  assert.match(failure, /cached reviewer worktree.*no longer an exact clean detached checkout/);
  assert.equal(calls, 1); assert.equal(existsSync(`${path}.lock`), false);
});

test("a replacement reviewer claim survives release and invalidates a success-shaped callback", async (t) => {
  const f = fixture(t); const raw = JSON.stringify(foreign());
  await assert.rejects(withReviewerWorktreeLease(f.path, async () => { writeFileSync(f.lock, raw); return 0; }), /lease changed/);
  assert.equal(readFileSync(f.lock, "utf8"), raw);
});

test("native and lease failures are both retained when ownership changes", async (t) => {
  const f = fixture(t); const failure = new Error("real native failure"); const raw = JSON.stringify(foreign());
  await assert.rejects(withReviewerWorktreeLease(f.path, async () => { writeFileSync(f.lock, raw); throw failure; }), (error) => {
    assert.ok(error instanceof AggregateError); assert.equal(error.errors[0], failure); return true;
  });
  assert.equal(readFileSync(f.lock, "utf8"), raw);
});

test("missing roots and symbolic or nonregular lease paths cannot acquire reviewer ownership", async (t) => {
  const f = fixture(t);
  await assert.rejects(withReviewerWorktreeLease(join(f.root, "ghost"), async () => 0));
  const link = join(f.root, "link"); symlinkSync(f.path, link);
  await assert.rejects(withReviewerWorktreeLease(link, async () => 0), /real directory/);
  mkdirSync(f.lock); await assert.rejects(withReviewerWorktreeLease(f.path, async () => 0), /regular file/);
});

test("a naturally exited real reviewer lease owner can be reclaimed without a live-owner override", async (t) => {
  const f = fixture(t); const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const module = JSON.stringify(join(root, "src/lib/reviewer-worktree-lease.ts"));
  const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
    `import{withReviewerWorktreeLease}from ${module};await withReviewerWorktreeLease(${JSON.stringify(f.path)},async()=>{process.exit(0)});`], { cwd: root, encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr); const prior = readFileSync(f.lock, "utf8");
  await withReviewerWorktreeLease(f.path, async () => { assert.notEqual(readFileSync(f.lock, "utf8"), prior); });
  assert.equal(existsSync(f.lock), false);
});

test("the shipped fresh reviewer runner keeps its default lease through the native child and refuses a vanished cached tree", async (t) => {
  const repo = gitRepo({ kind: "reviewer-runner-lease" }); t.after(() => repo.cleanup());
  repo.addRemote("origin", repo.dir); repo.git("branch", "-M", "main");
  mkdirSync(join(repo.dir, "node_modules"));
  const root = makeTempDir("reviewer-runner-lease"); t.after(() => rmSync(root, { recursive: true, force: true }));
  const sha = repo.git("rev-parse", "HEAD"); let calls = 0;
  const runner = buildFreshTreeReviewRunner(repo.dir, {
    git: (args) => spawnGit(args),
    addWorktree: (dir, path, head) => { spawnGit(["-C", dir, "worktree", "add", "--detach", path, head]); },
    worktreeRoot: root,
    spawnReview: async (path) => {
      calls++; assert.ok(existsSync(`${path}.lock`));
      assert.ok(reapStaleWorktrees(root, { maxAgeMs: 0 }).keptReasons?.some((row) => row.reason === "live-pid"));
      const child = spawnSync(process.execPath, ["-e", "require('node:fs').readFileSync(process.argv[1]+'/.git')", path]);
      assert.equal(child.status, 0); return 0;
    },
  });
  assert.equal(await runner("10783", [], { originMainSha: sha }), 0);
  const path = join(root, `reviewer-${sha.slice(0, 12)}`); assert.equal(existsSync(`${path}.lock`), false);
  repo.git("worktree", "remove", "--force", path);
  assert.equal(await runner("10783", [], { originMainSha: sha }), undefined);
  assert.equal(calls, 1, "a disappeared cached tree cannot be spawned as fresh");
});

function spawnGit(args: string[]): string {
  const child = spawnSync("git", args, { encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr); return child.stdout;
}

test("reviewer lease changes are material to the loaded reviewer code", () => {
  assert.equal(reviewAdvanceIsMaterial(["src/lib/reviewer-worktree-lease.ts"]), true);
});
