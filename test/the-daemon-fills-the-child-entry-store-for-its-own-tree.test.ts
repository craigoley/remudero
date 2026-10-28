// test/the-daemon-fills-the-child-entry-store-for-its-own-tree.test.ts — W1-T9601.
//
// W1-T9374 fills the shared child-entry store only from fresh run worktrees, so no build ever existed for the source
// hash of the daemon's OWN checkout, the tree every garden child starts from: each launch missed with
// no-stored-build and ran tsx. childEntryArgv now asks for one store build of that tree per source hash on such a
// miss, fire-and-forget, and the next launch hits. These tests drive childEntryArgv against temp trees and stores:
// a fake build seam for the request rules, and the real buildIntoStore (a child process) for the hit.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { childEntryArgv, DAEMON_TREE_FILL_SOURCE, type ChildEntryStoreOptions } from "#src/lib/child-entry-argv.js";
import {
  buildIntoStore, pruneChildEntryStore, STORE_IDLE_MS, type BuildIntoStoreOptions, type StoreBuildResult,
} from "#src/lib/child-entry-store.js";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(REPO, "scripts", "build-child-entries.mjs");
const script = createRequire(import.meta.url)(SCRIPT) as {
  CHILD_ENTRIES: readonly { name: string; source: string }[];
  sourceHash(root: string): string;
};
const MARKER = "W1-T9601-BUNDLE";
const GARDEN_ARGS = ["garden", "run", "fixture-garden"];
const OTHER_HASH = "0".repeat(64);
type Row = Record<string, unknown>;

/** A daemon-like tree: the real build script and install, and a stub for EVERY entry CHILD_ENTRIES declares. */
function daemonTree(): string {
  const root = mkdtempSync(join(tmpdir(), "rmd-own-tree-fill-"));
  mkdirSync(join(root, "scripts"), { recursive: true });
  copyFileSync(SCRIPT, join(root, "scripts", "build-child-entries.mjs"));
  for (const name of ["package.json", "package-lock.json"]) copyFileSync(join(REPO, name), join(root, name));
  for (const entry of script.CHILD_ENTRIES) {
    mkdirSync(dirname(join(root, entry.source)), { recursive: true });
    writeFileSync(join(root, entry.source),
      `console.log(JSON.stringify({ marker: ${JSON.stringify(MARKER)}, entry: ${JSON.stringify(entry.name)}, execArgv: process.execArgv, args: process.argv.slice(2) }));\n`);
  }
  symlinkSync(join(REPO, "node_modules"), join(root, "node_modules"), "dir");
  return root;
}
/** A store that holds a build for some other source, so a lookup hashes the tree and misses with no-stored-build. */
function storeWithOtherBuild(): string {
  const store = mkdtempSync(join(tmpdir(), "rmd-own-tree-store-"));
  mkdirSync(join(store, OTHER_HASH));
  return store;
}
const record = () => {
  const rows: Row[] = [];
  return { rows, log: (step: string, extra?: Row) => { rows.push({ step, ...extra }); } };
};
/** A build seam that records each request and answers `result` (a fresh promise each call). */
function fakeBuild(result: () => Promise<StoreBuildResult> = async () => ({ kind: "failed", reason: "fixture-build" })) {
  const calls: { tree: string; opts: BuildIntoStoreOptions }[] = [];
  return { calls, build: (tree: string, opts: BuildIntoStoreOptions) => { calls.push({ tree, opts }); return result(); } };
}
const gardenLaunch = (tree: string, store: ChildEntryStoreOptions) =>
  childEntryArgv(tree, "run-task", "src/run-task.ts", GARDEN_ARGS, undefined, store);
const settle = () => new Promise<void>((done) => setImmediate(done));
const fills = (rows: Row[]) => rows.filter((r) => r.step === "child_entry.store_miss").map((r) => r.daemon_tree_fill);
const remove = (...dirs: string[]) => dirs.forEach((d) => rmSync(d, { recursive: true, force: true }));

test("W1-T9601: a miss for the daemon tree requests one store build", async () => {
  const tree = daemonTree(), store = storeWithOtherBuild(), emptyTree = daemonTree();
  const emptyStore = mkdtempSync(join(tmpdir(), "rmd-own-tree-empty-store-"));
  try {
    const r = record(), fake = fakeBuild();
    const launch = gardenLaunch(tree, { root: store, log: r.log, ownTree: tree, daemonOwned: true, build: fake.build });
    assert.equal(launch.kind, "tsx", "the launch that missed still runs tsx: nothing waits for the build");
    assert.equal(launch.store?.outcome, "miss");
    const hash = launch.store?.hash;
    assert.equal(hash, script.sourceHash(tree));
    assert.equal(fake.calls.length, 1, "one store build was requested");
    assert.equal(fake.calls[0]!.tree, resolve(tree));
    assert.equal(fake.calls[0]!.opts.storeRoot, store);
    const requested = r.rows.filter((row) => row.step === "child_entry.store_build_requested");
    assert.deepEqual(requested, [{ step: "child_entry.store_build_requested", source: DAEMON_TREE_FILL_SOURCE, tree: resolve(tree), hash }]);
    assert.deepEqual(r.rows.find((row) => row.step === "child_entry.store_miss"),
      { step: "child_entry.store_miss", entry: "run-task", tree_reason: "no-manifest", outcome: "miss", reason: "no-stored-build", hash, daemon_tree_fill: "requested" });
    // An empty store misses without hashing the tree: the request then names no hash, and still asks once.
    const e = record(), emptyFake = fakeBuild();
    const empty = gardenLaunch(emptyTree, { root: emptyStore, log: e.log, ownTree: emptyTree, daemonOwned: true, build: emptyFake.build });
    assert.equal(empty.kind, "tsx");
    assert.equal(empty.store?.outcome === "miss" && empty.store.reason, "store-empty");
    assert.equal(emptyFake.calls.length, 1);
    assert.equal(e.rows.find((row) => row.step === "child_entry.store_build_requested")?.hash, null);
    await settle();
  } finally { remove(tree, store, emptyTree, emptyStore); }
});

test("W1-T9601: one build per source hash of the daemon tree", async () => {
  const tree = daemonTree(), store = storeWithOtherBuild(), slowTree = daemonTree(), emptyTree = daemonTree();
  const emptyStore = mkdtempSync(join(tmpdir(), "rmd-own-tree-empty-store-"));
  try {
    // Three misses at one hash, each after the previous build settled (failed): one request, never a retry.
    const r = record(), fake = fakeBuild();
    const opts = { root: store, log: r.log, ownTree: tree, daemonOwned: true, build: fake.build };
    for (let i = 0; i < 3; i++) {
      assert.equal(gardenLaunch(tree, opts).kind, "tsx");
      await settle();
    }
    assert.equal(fake.calls.length, 1, "a finished build is not retried at its hash");
    assert.deepEqual(fills(r.rows), ["requested", "already-tried", "already-tried"]);
    // The tree moves (sync_tree): a miss at the new hash requests a new build.
    const before = script.sourceHash(tree);
    writeFileSync(join(tree, "src", "moved.ts"), "export const moved = true;\n");
    const moved = gardenLaunch(tree, opts);
    assert.notEqual(moved.store?.hash, before);
    assert.equal(fake.calls.length, 2, "a new source hash asks again");
    assert.deepEqual(fills(r.rows).slice(3), ["requested"]);
    // A miss while the build still runs joins it.
    let release!: () => void;
    const slow = fakeBuild(() => new Promise((done) => { release = () => done({ kind: "skipped", reason: "fixture" }); }));
    const s = record();
    const slowOpts = { root: store, log: s.log, ownTree: slowTree, daemonOwned: true, build: slow.build };
    gardenLaunch(slowTree, slowOpts);
    gardenLaunch(slowTree, slowOpts);
    assert.equal(slow.calls.length, 1);
    assert.deepEqual(fills(s.rows), ["requested", "joined"]);
    release();
    await settle();
    // A store-empty miss keys on the tree alone; the hash its build reports is marked too, so no second build there.
    const emptyHash = script.sourceHash(emptyTree);
    const e = record(), reported = fakeBuild(async () => ({ kind: "failed", reason: "fixture-build", hash: emptyHash }));
    const emptyOpts = { root: emptyStore, log: e.log, ownTree: emptyTree, daemonOwned: true, build: reported.build };
    gardenLaunch(emptyTree, emptyOpts);
    await settle();
    mkdirSync(join(emptyStore, OTHER_HASH));
    const after = gardenLaunch(emptyTree, emptyOpts);
    assert.equal(after.store?.outcome === "miss" && after.store.reason, "no-stored-build");
    assert.equal(reported.calls.length, 1, "the hash the failed build reported is not built again");
    assert.deepEqual(fills(e.rows), ["requested", "already-tried"]);
  } finally { remove(tree, store, slowTree, emptyTree, emptyStore); }
});

test("W1-T9601: after the fill the next garden launch from the daemon tree runs the bundle", async () => {
  const tree = daemonTree();
  const store = mkdtempSync(join(tmpdir(), "rmd-own-tree-real-store-"));
  try {
    // The real default build: buildIntoStore in a child process, into the store, never into the tree.
    const r = record();
    const first = gardenLaunch(tree, { root: store, log: r.log, ownTree: tree, daemonOwned: true });
    assert.equal(first.kind, "tsx");
    const until = Date.now() + 60_000;
    while (!r.rows.some((row) => /^child_entry\.store_(built|build_failed)$/.test(String(row.step))) && Date.now() < until) {
      await new Promise((done) => setTimeout(done, 25));
    }
    const built = r.rows.find((row) => row.step === "child_entry.store_built");
    assert.ok(built, `the fill built the tree: ${JSON.stringify(r.rows)}`);
    const hash = script.sourceHash(tree);
    assert.equal(built.hash, hash);
    assert.equal(existsSync(join(tree, "dist")), false, "the build wrote only into the store");
    const next = gardenLaunch(tree, { root: store, log: r.log, ownTree: tree, daemonOwned: true });
    assert.equal(next.kind, "bundle");
    assert.equal(next.reason, "store-hit");
    const ran = spawnSync(process.execPath, next.argv, { cwd: tree, encoding: "utf8" });
    assert.equal(ran.status, 0, ran.stderr);
    const out = JSON.parse(ran.stdout) as { marker: string; entry: string; execArgv: string[]; args: string[] };
    assert.deepEqual([out.marker, out.entry, out.execArgv, out.args], [MARKER, "run-task", [], GARDEN_ARGS], "plain node ran the bundle");
    // Retention: the fill names the daemon's tree in liveTrees, so a prune past STORE_IDLE_MS keeps the hash it runs.
    writeFileSync(join(tree, "src", "moved.ts"), "export const moved = true;\n");
    let pruned: string[] = [];
    const prune = fakeBuild(async () => ({ kind: "skipped", reason: "fixture" }));
    gardenLaunch(tree, { root: store, ownTree: tree, daemonOwned: true, build: (t, o) => {
      pruned = pruneChildEntryStore(o.storeRoot, { liveTrees: o.liveTrees?.() ?? [], now: Date.now() + 2 * STORE_IDLE_MS });
      return prune.build(t, o);
    } });
    assert.deepEqual(pruned, []);
    assert.equal(existsSync(join(store, hash)), true, "the hash the daemon's tree runs survives retention");
  } finally { remove(tree, store); }
});

test("W1-T9601: a daemon tree that moved never runs the bundle built for its old source", async () => {
  const tree = daemonTree();
  const store = mkdtempSync(join(tmpdir(), "rmd-own-tree-stale-store-"));
  try {
    assert.equal((await buildIntoStore(tree, { storeRoot: store })).kind, "built");
    const old = gardenLaunch(tree, { root: store, ownTree: tree, daemonOwned: false });
    assert.equal(old.kind, "bundle");
    writeFileSync(join(tree, "src", "run-task.ts"), 'console.log("moved source");\n');
    const r = record(), fake = fakeBuild();
    const moved = gardenLaunch(tree, { root: store, log: r.log, ownTree: tree, daemonOwned: true, build: fake.build });
    assert.equal(moved.kind, "tsx", "the materialized bundle names the old source hash, so it never runs");
    assert.equal(moved.reason, "source-changed");
    assert.equal(moved.store?.outcome === "miss" && moved.store.reason, "no-stored-build");
    assert.equal(fake.calls.length, 1, "the moved tree asks for its own build");
    await settle();
  } finally { remove(tree, store); }
});

test("W1-T9601: a miss for another tree requests no build", async () => {
  const own = daemonTree(), other = daemonTree(), store = storeWithOtherBuild();
  const refusedStore = mkdtempSync(join(tmpdir(), "rmd-own-tree-refused-store-"));
  try {
    const r = record(), fake = fakeBuild();
    // Another tree, as a run worktree or a consumer gate is: no request, even in the daemon.
    assert.equal(gardenLaunch(other, { root: store, log: r.log, ownTree: own, daemonOwned: true, build: fake.build }).kind, "tsx");
    // The default own tree is this package's root, never a temp tree.
    assert.equal(gardenLaunch(other, { root: store, log: r.log, daemonOwned: true, build: fake.build }).kind, "tsx");
    // The daemon's tree in a process the daemon does not own: explicitly, and by default under the test runner.
    assert.equal(gardenLaunch(own, { root: store, log: r.log, ownTree: own, daemonOwned: false, build: fake.build }).kind, "tsx");
    assert.equal(gardenLaunch(own, { root: store, log: r.log, ownTree: own, build: fake.build }).kind, "tsx");
    // A stored build that is refused is not a missing one: no fill.
    mkdirSync(join(refusedStore, script.sourceHash(own)));
    const refused = gardenLaunch(own, { root: refusedStore, log: r.log, ownTree: own, daemonOwned: true, build: fake.build });
    assert.equal(refused.store?.outcome === "miss" && refused.store.reason, "stored-manifest-invalid");
    assert.equal(fake.calls.length, 0, "nothing asked for a build");
    assert.equal(r.rows.filter((row) => row.step === "child_entry.store_miss").length, 5);
    assert.deepEqual(fills(r.rows), [undefined, undefined, undefined, undefined, undefined]);
    assert.equal(r.rows.some((row) => row.step === "child_entry.store_build_requested"), false);
  } finally { remove(own, other, store, refusedStore); }
});
