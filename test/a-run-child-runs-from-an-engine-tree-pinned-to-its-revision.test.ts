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
import { engineChildEntryArgv, childEntryArgv } from "../src/lib/child-entry-argv.js";
import { ENGINE_RECORD, enginePath, ensureEngineTree, listEngines, newestCurrentEngine, pruneEngineTrees } from "../src/lib/engine-tree.js";
import { writeStatus, type RunChildStatus } from "../src/lib/run-child-contract.js";
import { buildEngineAfterStore } from "../src/run-task.js";

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
  const repo = tmp();
  const git = (...args: string[]): string =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-C", repo, ...args], {
      encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
    }).trim();
  git("init", "--quiet", "-b", "main");
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
