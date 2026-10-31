// test/a-run-child-runs-from-an-engine-tree-pinned-to-its-revision.test.ts — W1-T9077.
//
// deploy/entrypoint.sh's sync_tree moves the daemon's own checkout on every in-container restart, so a run child
// that outlives the daemon must run from an engine tree nothing moves (docs/adr/0007, A.1 and B.4). These drive
// engineChildEntryArgv, ensureEngineTree, newestCurrentEngine and pruneEngineTrees against fixture trees and a real
// git repository, and assert on the argv, the directories and the ledger rows they leave.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gitRepo } from "#test/helpers/git-repo.js";
import { engineChildEntryArgv, childEntryArgv } from "#src/lib/child-entry-argv.js";
import { ENGINE_RECORD, enginePath, ensureEngineTree, listEngines, newestCurrentEngine, pruneEngineTrees } from "#src/lib/engine-tree.js";
import { writeStatus, type RunChildStatus } from "#src/lib/run-child-contract.js";
import { buildEngineAfterStore } from "#src/run-task.js";

const tmp = (): string => realpathSync(mkdtempSync(join(tmpdir(), "rmd-engine-")));
const hashOf = (n: number): string => n.toString(16).padStart(64, "0");
const shaOf = (n: number): string => n.toString(16).padStart(40, "0");
type Row = { step: string; extra?: Record<string, unknown> };
const collect = (): { rows: Row[]; log: (step: string, extra?: Record<string, unknown>) => void } => {
  const rows: Row[] = [];
  return { rows, log: (step, extra) => void rows.push({ step, extra }) };
};

/** A published engine: a directory with its record, as ensureEngineTree leaves it. */
function plantEngine(state: string, n: number, builtAt: number): string {
  const root = enginePath(state, hashOf(n));
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, ENGINE_RECORD), JSON.stringify({ sha: shaOf(n), sourceHash: hashOf(n), builtAt }));
  return root;
}

const GEN = { containerId: "c1", initStart: "t0" };
const probe = { process: () => ({ state: "alive" as const, start: "proc:1" }), generation: () => GEN };

function plantRun(state: string, runId: string, engineSha: string, runState: RunChildStatus["state"]): void {
  const dir = join(state, "runs", runId);
  mkdirSync(dir, { recursive: true });
  writeStatus(dir, {
    schema: { major: 1, minor: 0 }, runId, identity: { pid: 4242, startTicks: "proc:1", containerGeneration: GEN },
    engineSha, entryKind: "bundle", phase: "implement", heartbeatAt: 1, state: runState,
  });
}

/** A real repository with `commits` commits, one src/ file and the files the engine build copies. */
function repoWithCommits(commits: number): { repo: string; shas: string[] } {
  const fixture = gitRepo({ seedCommit: false, kind: "engine" });
  const repo = fixture.dir;
  const git = (...args: string[]): string => fixture.git(...args);
  mkdirSync(join(repo, "src"), { recursive: true });
  const shas: string[] = [];
  for (let i = 0; i < commits; i++) {
    writeFileSync(join(repo, "src", "entry.ts"), `export const rev = ${i};\n`);
    git("add", "-A");
    git("commit", "--quiet", "-m", `commit ${i}`);
    shas.push(git("rev-parse", "HEAD"));
  }
  return { repo, shas };
}

test("W1-T9077: a run child argv names a bundle inside its engine tree", () => {
  const daemonCheckout = tmp();
  const engine = tmp();
  const asked: string[] = [];
  const currency = (root: string, name: string) => {
    asked.push(root);
    return { current: true, reason: "source-hash-match", bundle: join(root, "dist", "child-entries", `${name}.mjs`) };
  };
  const launch = engineChildEntryArgv(engine, "run-child", "src/run-child-main.ts", ["--run", "r1"], currency, { root: false });
  assert.equal(launch.kind, "bundle");
  assert.equal(launch.cwd, engine);
  assert.equal(launch.engineRoot, engine);
  assert.deepEqual(launch.argv, [join(engine, "dist", "child-entries", "run-child.mjs"), "--run", "r1"]);
  assert.deepEqual(asked, [engine], "currency is judged for the engine tree, never another");
  assert.ok(!launch.argv.some((a) => a.startsWith(daemonCheckout)), "nothing in the argv sits in the daemon's checkout");
  // The falsifier's shape: resolved from the daemon's checkout, the same call names that checkout instead.
  const wrong = childEntryArgv(daemonCheckout, "run-child", "src/run-child-main.ts", [], currency, { root: false });
  assert.ok(wrong.argv[0]!.startsWith(daemonCheckout));
});

test("W1-T9077: with no current bundle the fallback is tsx from the engine tree", () => {
  const engine = tmp();
  mkdirSync(join(engine, "node_modules", "tsx"), { recursive: true });
  writeFileSync(join(engine, "node_modules", "tsx", "package.json"), JSON.stringify({ name: "tsx", main: "index.js" }));
  writeFileSync(join(engine, "node_modules", "tsx", "index.js"), "");
  const stale = () => ({ current: false, reason: "no-manifest" });
  const launch = engineChildEntryArgv(engine, "run-child", "src/run-child-main.ts", ["--run", "r1"], stale, { root: false });
  assert.equal(launch.kind, "tsx");
  assert.equal(launch.reason, "no-manifest");
  assert.equal(launch.cwd, engine);
  assert.deepEqual(launch.argv, ["--import", join(engine, "node_modules", "tsx", "index.js"), join(engine, "src", "run-child-main.ts"), "--run", "r1"]);

  const bare = tmp();
  const noTsx = engineChildEntryArgv(bare, "run-child", "src/run-child-main.ts", [], stale, { root: false });
  assert.equal(noTsx.kind, "tsx");
  assert.match(noTsx.reason, /tsx-not-in-engine/, "an engine that cannot supply tsx says so");
});

test("W1-T9077: an engine a live run names is kept and an unnamed old one is removed", async () => {
  const state = tmp();
  const oldUnnamed = plantEngine(state, 1, 1000);
  const oldNamed = plantEngine(state, 2, 2000);
  const oldFinished = plantEngine(state, 3, 3000);
  const newest = plantEngine(state, 4, 4000);
  plantRun(state, "live-run", shaOf(2), "running");
  plantRun(state, "done-run", shaOf(3), "done");
  const { rows, log } = collect();
  const removed = await pruneEngineTrees(state, { repoDir: state, log, probe, git: async () => "" });
  assert.deepEqual(removed.sort(), [hashOf(1), hashOf(3)].sort());
  assert.ok(existsSync(oldNamed), "an engine a non-terminal status names is never removed");
  assert.ok(existsSync(newest), "the newest engine is kept");
  assert.ok(!existsSync(oldUnnamed), "an old engine no run names is removed");
  assert.ok(!existsSync(oldFinished), "a terminal run no longer holds its engine");
  assert.deepEqual(rows.map((r) => r.step), ["engine.pruned"]);
  assert.deepEqual(listEngines(state).map((e) => e.sourceHash), [hashOf(4), hashOf(2)]);
});

test("W1-T9077: a run directory that names no engine defers the prune", async () => {
  const state = tmp();
  const old = plantEngine(state, 1, 1000);
  plantEngine(state, 2, 2000);
  mkdirSync(join(state, "runs", "torn"), { recursive: true });
  const { rows, log } = collect();
  assert.deepEqual(await pruneEngineTrees(state, { repoDir: state, log, probe, git: async () => "" }), []);
  assert.ok(existsSync(old), "an answer that cannot be known removes nothing");
  assert.equal(rows[0]?.step, "engine.prune_deferred");
});

test("W1-T9077: a fast-forward builds the new engine off the loop", async () => {
  const { repo, shas } = repoWithCommits(2);
  const state = tmp();
  const { rows, log } = collect();
  const hash = hashOf(77);
  const seams = {
    linkNodeModules: () => "linked" as const,
    materialize: () => ({ outcome: "hit" as const, hash }),
    isCurrent: () => true,
  };
  let ticked = false;
  const pass = buildEngineAfterStore(repo, state, join(state, "child-entries"), { kind: "built", hash, ms: 1, bytes: 1 }, log, seams);
  setImmediate(() => { ticked = true; });
  assert.equal(ticked, false, "the call returned before any git work finished");
  await pass;
  assert.ok(ticked, "the event loop turned while the engine was being cut");
  const built = rows.find((r) => r.step === "engine.built");
  assert.ok(built, "the build is ledgered");
  assert.equal(built.extra?.sha, shas[1]);
  assert.equal(built.extra?.source_hash, hash);
  const root = enginePath(state, hash);
  assert.ok(existsSync(join(root, "src", "entry.ts")), "the engine tree holds the revision's files");
  assert.equal(execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), shas[1]);
  assert.equal(listEngines(state)[0]?.sha, shas[1]);
  assert.equal(rows.filter((r) => r.step === "engine.lag").length, 0, "an engine at main's tip does not lag");
  rmSync(repo, { recursive: true, force: true });
});

test("W1-T9077: a failed engine build is ledgered and leaves no engine", async () => {
  const { repo } = repoWithCommits(1);
  const state = tmp();
  const { rows, log } = collect();
  const hash = hashOf(78);
  const sha = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const result = await ensureEngineTree(state, sha, hash, {
    repoDir: repo, storeRoot: join(state, "store"), log,
    linkNodeModules: () => "linked", materialize: () => ({ outcome: "miss", reason: "no-stored-build" }),
  });
  assert.equal(result.kind, "failed");
  assert.deepEqual(listEngines(state), []);
  assert.equal(rows[0]?.step, "engine.build_failed");
  assert.match(String(rows[0]?.extra?.reason), /no-stored-build/);
  assert.deepEqual(existsSync(join(state, "engines")) ? (await import("node:fs")).readdirSync(join(state, "engines")) : [], [], "no half-built sibling remains");
  const bad = await ensureEngineTree(state, "not-a-sha", hash, { repoDir: repo, storeRoot: state, log });
  assert.equal(bad.kind, "failed");
});

test("W1-T9077: the newest current engine behind main ledgers engine.lag", async () => {
  const { repo, shas } = repoWithCommits(4);
  const state = tmp();
  const hash = hashOf(79);
  const build = await ensureEngineTree(state, shas[1]!, hash, {
    repoDir: repo, storeRoot: join(state, "store"),
    linkNodeModules: () => "linked", materialize: () => ({ outcome: "hit", hash }),
  });
  assert.equal(build.kind, "built");
  const { rows, log } = collect();
  const found = await newestCurrentEngine(state, shas[3]!, { repoDir: repo, log, isCurrent: () => true });
  assert.equal(found?.sha, shas[1]);
  assert.deepEqual(rows, [{ step: "engine.lag", extra: { engine_sha: shas[1], main_sha: shas[3], commits_behind: 2 } }]);
  const none = collect();
  assert.equal(await newestCurrentEngine(state, shas[3]!, { repoDir: repo, log: none.log, isCurrent: () => false }), undefined);
  assert.equal(none.rows[0]?.extra?.engine_sha, null, "an engine whose bundle is not current is not chosen");
  const tip = collect();
  assert.equal((await newestCurrentEngine(state, shas[1]!, { repoDir: repo, log: tip.log, isCurrent: () => true }))?.sha, shas[1]);
  assert.deepEqual(tip.rows, []);
});

const failing = (code?: number) => async (): Promise<string> => {
  throw Object.assign(new Error(`git failed${code === undefined ? "" : ` (${code})`}`), code === undefined ? {} : { code });
};

test("W1-T9077: listEngines reads a missing engines directory as none and surfaces any other fault", () => {
  const state = tmp();
  assert.deepEqual(listEngines(state), [], "no engines/ is no engines");
  writeFileSync(join(state, "engines"), "not a directory");
  assert.throws(() => listEngines(state), (err: NodeJS.ErrnoException) => err.code === "ENOTDIR", "a real fault is not read as none");
});

test("W1-T9077: pruning clears an engine even when git cannot unregister or prune it", async () => {
  const state = tmp();
  const old = plantEngine(state, 1, 1000);
  const newest = plantEngine(state, 2, 2000);
  const removed = await pruneEngineTrees(state, { repoDir: state, probe, git: failing(128) });
  assert.deepEqual(removed, [hashOf(1)]);
  assert.ok(!existsSync(old), "the directory is cleared although `git worktree remove` and `prune` both failed");
  assert.ok(existsSync(newest));
});

test("W1-T9077: a build whose git cut fails is a typed failure, not a throw", async () => {
  const state = tmp();
  const { rows, log } = collect();
  const result = await ensureEngineTree(state, shaOf(5), hashOf(5), { repoDir: state, storeRoot: state, log, git: failing() });
  assert.deepEqual(result, { kind: "failed", reason: "git failed" });
  assert.equal(rows[0]?.step, "engine.build_failed");
  assert.equal(rows[0]?.extra?.reason, "git failed");
  assert.deepEqual(listEngines(state), []);
});

test("W1-T9077: an unrecorded leftover at the engine path is cleared before the new tree is moved in", async () => {
  const { repo, shas } = repoWithCommits(1);
  const state = tmp();
  const hash = hashOf(80);
  const leftover = enginePath(state, hash);
  mkdirSync(leftover, { recursive: true });
  writeFileSync(join(leftover, "stale.txt"), "a build that died after its move");
  const result = await ensureEngineTree(state, shas[0]!, hash, {
    repoDir: repo, storeRoot: join(state, "store"),
    linkNodeModules: () => "linked", materialize: () => ({ outcome: "hit", hash }),
  });
  assert.deepEqual(result, { kind: "built", root: leftover, ms: (result as { ms: number }).ms });
  assert.ok(!existsSync(join(leftover, "stale.txt")), "the leftover is gone");
  assert.ok(existsSync(join(leftover, "src", "entry.ts")), "the engine tree sits where the leftover was");
  assert.equal(listEngines(state)[0]?.sha, shas[0]);
  rmSync(repo, { recursive: true, force: true });
});

test("W1-T9077: the default currency judgement reads the engine's own bundle manifest", async () => {
  const state = tmp();
  const noManifest = plantEngine(state, 1, 1000);
  const { rows, log } = collect();
  const git = async (): Promise<string> => "";
  assert.equal(await newestCurrentEngine(state, shaOf(1), { repoDir: state, log, git }), undefined, "no manifest is not current");
  assert.equal(rows[0]?.step, "engine.lag");
  assert.equal(rows[0]?.extra?.engine_sha, null);
  // A manifest naming an entry that cannot be vouched for is not current either: every entry must be.
  mkdirSync(join(noManifest, "dist", "child-entries"), { recursive: true });
  writeFileSync(join(noManifest, "dist", "child-entries", "manifest.json"), JSON.stringify({ entries: [{ name: "run-child" }] }));
  const second = collect();
  assert.equal(await newestCurrentEngine(state, shaOf(1), { repoDir: state, log: second.log, git }), undefined);
  assert.equal(second.rows[0]?.extra?.engine_sha, null);
});

test("W1-T9077: git's exit 1 means not-an-ancestor, any other failure skips the candidate with a reason", async () => {
  const state = tmp();
  plantEngine(state, 1, 1000);
  const notAncestor = collect();
  assert.equal(await newestCurrentEngine(state, shaOf(9), { repoDir: state, log: notAncestor.log, git: failing(1), isCurrent: () => true }), undefined);
  assert.deepEqual(notAncestor.rows.map((r) => r.step), ["engine.lag"], "exit 1 is an answer, not a skip");

  const unknown = collect();
  assert.equal(await newestCurrentEngine(state, shaOf(9), { repoDir: state, log: unknown.log, git: failing(128), isCurrent: () => true }), undefined);
  assert.deepEqual(unknown.rows.map((r) => r.step), ["engine.candidate_skipped", "engine.lag"]);
  assert.equal(unknown.rows[0]?.extra?.source_hash, hashOf(1));
  assert.match(String(unknown.rows[0]?.extra?.reason), /git failed \(128\)/);
});

test("W1-T9077: an unreadable commits-behind count still returns the engine and says so", async () => {
  const state = tmp();
  plantEngine(state, 1, 1000);
  const { rows, log } = collect();
  const git = async (_repo: string, args: readonly string[]): Promise<string> => {
    if (args[0] === "rev-list") throw new Error("rev-list down");
    return "";
  };
  const found = await newestCurrentEngine(state, shaOf(9), { repoDir: state, log, git, isCurrent: () => true });
  assert.equal(found?.sha, shaOf(1));
  assert.equal(rows[0]?.step, "engine.candidate_skipped");
  assert.match(String(rows[0]?.extra?.reason), /commits-behind unreadable: rev-list down/);
  assert.deepEqual(rows[1], { step: "engine.lag", extra: { engine_sha: shaOf(1), main_sha: shaOf(9), commits_behind: null } });
});
