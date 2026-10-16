// test/an-engine-tree-never-resolves-modules-through-a-worktree.test.ts — W1-T9738.
//
// An engine tree is what a run child that outlives the daemon runs from (W1-T9077). buildEngineAfterStore cut it from a
// run's own worktree and linked its node_modules to `<worktree>/node_modules`, a path the worker can rewrite. These
// build engines over a temp `<root>/{state,worktrees}` with a real git repository, a fake install and a worktree whose
// node_modules links to it, and assert on the link, the ledger rows and which engine is current.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gitRepo } from "./helpers/git-repo.js";
import {
  ENGINE_RECORD, engineModules, enginePath, ensureEngineTree, listEngines, newestCurrentEngine, pruneEngineTrees, resolveTrustedModules,
  workerWritableRoots,
} from "../src/lib/engine-tree.js";
import { buildEngineAfterStore } from "../src/run-task.js";

const hashOf = (n: number): string => n.toString(16).padStart(64, "0");
const shaOf = (n: number): string => n.toString(16).padStart(40, "0");
type Row = { step: string; extra?: Record<string, unknown> };
const collect = (): { rows: Row[]; log: (step: string, extra?: Record<string, unknown>) => void } => {
  const rows: Row[] = [];
  return { rows, log: (step, extra) => void rows.push({ step, extra }) };
};
const probe = { process: () => ({ state: "alive" as const, start: "proc:1" }), generation: () => ({ containerId: "c1", initStart: "t0" }) };

/** `<root>/state`, `<root>/worktrees`, a managed checkout at `<root>/repos/r` with one commit, and a fake install. */
function fixture(): { root: string; state: string; worktrees: string; repo: string; install: string; sha: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rmd-engine-modules-")));
  const state = join(root, "state");
  const worktrees = join(root, "worktrees");
  mkdirSync(state, { recursive: true });
  mkdirSync(worktrees, { recursive: true });
  const install = join(root, "install", "node_modules");
  mkdirSync(join(install, "some-package"), { recursive: true });
  const r = gitRepo({ seedCommit: false, kind: "engine-modules" });
  mkdirSync(join(r.dir, "src"), { recursive: true });
  writeFileSync(join(r.dir, "src", "entry.ts"), "export const rev = 0;\n");
  writeFileSync(join(r.dir, ".gitignore"), "node_modules\n");
  r.git("add", "-A");
  r.git("commit", "--quiet", "-m", "commit 0");
  mkdirSync(join(root, "repos"), { recursive: true });
  const repo = join(root, "repos", "r");
  execFileSync("git", ["clone", "--quiet", r.dir, repo]);
  return { root, state, worktrees, repo, install, sha: r.git("rev-parse", "HEAD") };
}

/** A run worktree of `repo` under `<root>/worktrees`, as the dispatch cuts one. */
function runWorktree(f: ReturnType<typeof fixture>, name: string): string {
  const wt = join(f.worktrees, name);
  execFileSync("git", ["-C", f.repo, "worktree", "add", "--quiet", "--detach", wt, f.sha]);
  return wt;
}

test("W1-T9738: an engine links node_modules to the install, never into a worktree", async () => {
  const f = fixture();
  // The managed checkout's node_modules is a link to the install, as a borrowed checkout's is.
  symlinkSync(f.install, join(f.repo, "node_modules"), "dir");
  const wt = runWorktree(f, "run-W1-T1-1");
  // The worker's own node_modules: a directory it wrote, not the install.
  mkdirSync(join(wt, "node_modules", "some-package"), { recursive: true });
  const { rows, log } = collect();
  const hash = hashOf(91);
  await buildEngineAfterStore(wt, f.state, join(f.state, "store"), { kind: "built", hash, ms: 1, bytes: 1 }, log, {
    materialize: () => ({ outcome: "hit", hash }), isCurrent: () => true,
  });
  const engine = enginePath(f.state, hash);
  const failed = rows.find((r) => r.step === "engine.build_failed");
  assert.equal(failed, undefined, `the build succeeded: ${JSON.stringify(failed)}`);
  const link = readlinkSync(join(engine, "node_modules"));
  assert.equal(link, realpathSync(f.install), "the engine's link names the resolved install directly");
  assert.ok(!link.startsWith(f.worktrees), "the link never points into a worktrees root");
  assert.equal(rows.find((r) => r.step === "engine.built")?.extra?.node_modules_target, realpathSync(f.install), "the build row names its target");
  assert.equal(JSON.parse(readFileSync(join(engine, ENGINE_RECORD), "utf8")).nodeModulesTarget, realpathSync(f.install));
  // The worktree is reaped: the engine still resolves its modules and stays current.
  rmSync(wt, { recursive: true, force: true });
  assert.ok(existsSync(join(engine, "node_modules", "some-package")));
  const current = collect();
  assert.equal((await newestCurrentEngine(f.state, f.sha, { repoDir: f.repo, log: current.log, isCurrent: () => true }))?.sourceHash, hash);
  assert.deepEqual(current.rows, []);
  assert.deepEqual(engineModules(engine, undefined, workerWritableRoots(f.state)), { kind: "trusted", target: realpathSync(f.install) });

  // A worktree whose node_modules links to the install is followed to the install it names, never linked through.
  const g = fixture();
  const wt2 = runWorktree(g, "run-W1-T2-2");
  symlinkSync(g.install, join(wt2, "node_modules"), "dir");
  const second = collect();
  const built = await ensureEngineTree(g.state, g.sha, hashOf(92), {
    repoDir: wt2, storeRoot: join(g.state, "store"), log: second.log, materialize: () => ({ outcome: "hit", hash: hashOf(92) }),
  });
  assert.equal(built.kind, "built", JSON.stringify(second.rows));
  assert.equal(readlinkSync(join(enginePath(g.state, hashOf(92)), "node_modules")), realpathSync(g.install));
});

test("W1-T9738: an untrusted or missing node_modules source publishes no engine", async () => {
  const f = fixture();
  const wt = runWorktree(f, "run-W1-T3-3");
  // A worker replaced its worktree's node_modules with a real directory of its own.
  mkdirSync(join(wt, "node_modules", "some-package"), { recursive: true });
  const { rows, log } = collect();
  const hash = hashOf(93);
  const hit = () => ({ outcome: "hit" as const, hash });
  const untrusted = await ensureEngineTree(f.state, f.sha, hash, { repoDir: wt, storeRoot: join(f.state, "store"), log, materialize: hit });
  assert.equal(untrusted.kind, "failed");
  assert.match((untrusted as { reason: string }).reason, /^node-modules-untrusted: .* under worker-writable /);
  assert.deepEqual(rows.map((r) => r.step), ["engine.build_failed"]);
  assert.match(String(rows[0]?.extra?.reason), /node-modules-untrusted/);
  assert.deepEqual(listEngines(f.state), [], "no engine is published");
  assert.ok(!existsSync(join(f.state, "engines")), "nothing is cut");

  // No source at all, and a source that does not resolve.
  const none = await ensureEngineTree(f.state, f.sha, hash, { repoDir: f.repo, storeRoot: f.state, materialize: hit, resolveModulesSource: () => undefined });
  assert.deepEqual(none, { kind: "failed", reason: "node-modules-missing: no node_modules source" });
  const gone = join(f.root, "gone", "node_modules");
  symlinkSync(join(f.root, "nowhere"), join(f.root, "dangling"), "dir");
  const dangling = await ensureEngineTree(f.state, f.sha, hash, { repoDir: f.repo, storeRoot: f.state, materialize: hit, resolveModulesSource: () => join(f.root, "dangling") });
  assert.match((dangling as { reason: string }).reason, /^node-modules-missing: .*dangling does not resolve/);
  assert.equal(resolveTrustedModules(gone, []).ok, false);
  assert.deepEqual(listEngines(f.state), []);

  // A root that is itself a link still holds what sits under its real path.
  const aliased = join(f.root, "aliased-worktrees");
  symlinkSync(f.worktrees, aliased, "dir");
  assert.equal(resolveTrustedModules(join(wt, "node_modules"), [aliased]).ok, false);
  assert.deepEqual(resolveTrustedModules(f.install, [aliased]), { ok: true, target: realpathSync(f.install) });
  // Any failure other than "does not resolve" is not an answer.
  writeFileSync(join(f.root, "a-file"), "");
  assert.throws(() => resolveTrustedModules(join(f.root, "a-file", "node_modules"), []), (err: NodeJS.ErrnoException) => err.code === "ENOTDIR");
});

test("W1-T9738: an engine linked into a worktree is not current", async () => {
  const f = fixture();
  const wt = runWorktree(f, "run-W1-T4-4");
  symlinkSync(f.install, join(wt, "node_modules"), "dir");
  /** An engine as origin/main built it: its node_modules a link to the worktree's node_modules path. */
  const plant = (n: number, builtAt: number, target: string, recorded?: string): string => {
    const root = enginePath(f.state, hashOf(n));
    mkdirSync(root, { recursive: true });
    symlinkSync(target, join(root, "node_modules"), "dir");
    writeFileSync(join(root, ENGINE_RECORD), JSON.stringify({ sha: f.sha, sourceHash: hashOf(n), builtAt, ...(recorded ? { nodeModulesTarget: recorded } : {}) }));
    return root;
  };
  const linked = plant(5, 5000, join(wt, "node_modules"));
  const { rows, log } = collect();
  assert.equal(await newestCurrentEngine(f.state, f.sha, { repoDir: f.repo, log, isCurrent: () => true }), undefined, "a live worktree link is not current");
  assert.equal(rows[0]?.step, "engine.candidate_skipped");
  assert.match(String(rows[0]?.extra?.reason), /^node-modules-untrusted: .* links through .*run-W1-T4-4/);

  // The worktree is reaped: the link dangles, and the engine is still not current.
  rmSync(wt, { recursive: true, force: true });
  execFileSync("git", ["-C", f.repo, "worktree", "prune"]);
  const reaped = collect();
  assert.equal(await newestCurrentEngine(f.state, f.sha, { repoDir: f.repo, log: reaped.log, isCurrent: () => true }), undefined, "a dangling link is not current");
  assert.match(String(reaped.rows[0]?.extra?.reason), /^node-modules-dangling: /);

  // A link into a worktree's real directory, a target that is not the recorded one, and a directory that is not a link.
  const wt2 = runWorktree(f, "run-W1-T5-5");
  mkdirSync(join(wt2, "node_modules"), { recursive: true });
  const roots = workerWritableRoots(f.state);
  assert.equal(engineModules(plant(6, 600, join(wt2, "node_modules")), undefined, roots).kind, "untrusted");
  assert.match(String((engineModules(plant(7, 700, f.install, "/elsewhere"), "/elsewhere", roots) as { detail: string }).detail), /not the recorded \/elsewhere/);
  const notALink = enginePath(f.state, hashOf(8));
  mkdirSync(join(notALink, "node_modules"), { recursive: true });
  assert.match(String((engineModules(notALink, undefined, roots) as { detail: string }).detail), /is not a link/);
  assert.deepEqual(engineModules(enginePath(f.state, hashOf(9)), undefined, roots), { kind: "absent" });

  // An older engine linked straight to the install is chosen past the unsafe newest, which then loses its retention.
  const safe = plant(1, 100, realpathSync(f.install), realpathSync(f.install));
  const chosen = await newestCurrentEngine(f.state, f.sha, { repoDir: f.repo, isCurrent: () => true });
  assert.equal(chosen?.root, safe);
  const removed = await pruneEngineTrees(f.state, { repoDir: f.repo, probe, keep: chosen?.sourceHash });
  assert.ok(removed.includes(hashOf(5)), "the newest, dangling engine is pruned");
  assert.ok(!existsSync(linked));
  assert.ok(existsSync(safe));
});
