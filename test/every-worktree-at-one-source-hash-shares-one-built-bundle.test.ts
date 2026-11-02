// test/every-worktree-at-one-source-hash-shares-one-built-bundle.test.ts — W1-T8776.
//
// A fresh worktree has no dist/, so a precompiled child entry was current only where a build had run. The shared
// store (src/lib/child-entry-store.ts) holds one build per source hash; buildIntoStore fills it in child processes
// running the tree's own scripts/build-child-entries.mjs, and childEntryArgv copies a stored build into a tree whose
// own bundle is not current, re-judging it before it runs. These tests drive the REAL build, copy and launch against
// fixture trees and assert on what runs and what the store and each tree hold afterwards.
// Decision record: docs/adr/0006-precompiled-daemon-child-entries.md.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync,
  utimesSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { childEntryArgv } from "#src/lib/child-entry-argv.js";
import {
  buildIntoStore, defaultChildEntryStoreRoot, materializeFromStore, pruneChildEntryStore, runBuildScriptInChild,
  type RunBuildScript,
} from "#src/lib/child-entry-store.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const NAME = "check-proof-main";
const SOURCE = "src/check-proof-main.ts";
const OUT = join("dist", "child-entries");

type Step = [string, Record<string, unknown> | undefined];
const recorder = (): { log: (s: string, e?: Record<string, unknown>) => void; steps: Step[] } => {
  const steps: Step[] = [];
  return { steps, log: (s, e) => void steps.push([s, e]) };
};

interface Ran { marker: string; repoRoot: string; whereUrl: string; dep: string; execArgv: string[] }

/** A dependency installed in ONE tree's node_modules, naming the tree it was installed into. */
function installDep(tree: string): void {
  const dep = join(tree, "node_modules", "fixture-dep");
  mkdirSync(dep, { recursive: true });
  writeFileSync(join(dep, "package.json"), '{ "name": "fixture-dep", "type": "module", "main": "index.js" }\n');
  writeFileSync(join(dep, "index.js"), "export const installedAt = import.meta.url;\n");
}

/**
 * A harness-shaped tree: the two declared entries, a lib module deriving the repo root from its own
 * import.meta.url, a bare import resolved from node_modules, and the tree's own copy of the build script
 * (whose esbuild is the repo's, linked in).
 */
function makeTree(): string {
  const root = mkdtempSync(join(tmpdir(), "rmd-store-tree-"));
  mkdirSync(join(root, "src", "lib"), { recursive: true });
  mkdirSync(join(root, "scripts"), { recursive: true });
  mkdirSync(join(root, "node_modules"), { recursive: true });
  symlinkSync(join(REPO_ROOT, "node_modules", "esbuild"), join(root, "node_modules", "esbuild"));
  installDep(root);
  copyFileSync(join(REPO_ROOT, "scripts", "build-child-entries.mjs"), join(root, "scripts", "build-child-entries.mjs"));
  writeFileSync(join(root, "package.json"), '{ "name": "fixture", "type": "module" }\n');
  writeFileSync(join(root, "package-lock.json"), '{ "lockfileVersion": 3 }\n');
  writeFileSync(
    join(root, "src", "lib", "where.ts"),
    [
      'import { dirname, join } from "node:path";',
      'import { fileURLToPath } from "node:url";',
      "export const whereUrl: string = import.meta.url;",
      'export const repoRoot: string = join(dirname(fileURLToPath(import.meta.url)), "..", "..");',
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(root, SOURCE),
    [
      'import { installedAt } from "fixture-dep";',
      'import { whereUrl, repoRoot } from "./lib/where.ts";',
      'const marker: string = "STORE-FIXTURE";',
      "console.log(JSON.stringify({ marker, repoRoot, whereUrl, dep: installedAt, execArgv: process.execArgv }));",
      "",
    ].join("\n"),
  );
  writeFileSync(join(root, "src", "run-task.ts"), 'export const runTask: string = "run-task";\n');
  writeFileSync(join(root, "src", "run-child-main.ts"), 'export const runChild: string = "run-child";\n');
  return root;
}

/** A fresh worktree at `from`'s source: the same tracked files, its own node_modules, and no dist/. */
function freshTree(from: string): string {
  const root = mkdtempSync(join(tmpdir(), "rmd-store-fresh-"));
  for (const p of ["src", "scripts", "package.json", "package-lock.json"]) cpSync(join(from, p), join(root, p), { recursive: true });
  mkdirSync(join(root, "node_modules"), { recursive: true });
  symlinkSync(join(REPO_ROOT, "node_modules", "esbuild"), join(root, "node_modules", "esbuild"));
  installDep(root);
  return root;
}

const runBundle = (argv: string[]): Ran => {
  const r = spawnSync(process.execPath, argv, { encoding: "utf8", cwd: tmpdir() });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim().split("\n").at(-1) ?? "") as Ran;
};

const digest = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");
const storedHashes = (store: string): string[] => readdirSync(store).filter((n) => /^[0-9a-f]{64}$/.test(n));

/** The store filled from a main-checkout tree, as the daemon fills it. */
async function filledStore(): Promise<{ main: string; store: string; hash: string; cleanup: string[] }> {
  const main = makeTree();
  const store = mkdtempSync(join(tmpdir(), "rmd-store-root-"));
  const built = await buildIntoStore(main, { storeRoot: store });
  assert.equal(built.kind, "built", `positive control: the build filled the store (${JSON.stringify(built)})`);
  return { main, store, hash: (built as { hash: string }).hash, cleanup: [main, store] };
}

const clean = (dirs: string[]): void => dirs.forEach((d) => rmSync(d, { recursive: true, force: true }));

test("W1-T8776: a fresh worktree at a stored source hash runs the stored bundle", async () => {
  const { store, hash, cleanup } = await filledStore();
  const fresh = freshTree(cleanup[0]);
  const corrupt = freshTree(cleanup[0]);
  cleanup.push(fresh, corrupt);
  try {
    assert.equal(existsSync(join(fresh, OUT)), false, "the fresh worktree starts with no dist/");
    const { log, steps } = recorder();
    const launch = childEntryArgv(fresh, NAME, SOURCE, ["a-proof"], undefined, { root: store, log });
    assert.equal(launch.kind, "bundle");
    assert.equal(launch.reason, "store-hit");
    assert.deepEqual(launch.store, { outcome: "hit", hash });
    assert.equal(launch.argv[0], join(fresh, OUT, `${NAME}.mjs`), "the bundle runs from the worktree, not the store");
    assert.equal(launch.argv.includes("--import"), false, "no tsx loader on the argv");
    assert.deepEqual(steps.map(([s]) => s), ["child_entry.store_hit"]);
    const ran = runBundle(launch.argv);
    assert.equal(ran.marker, "STORE-FIXTURE");
    assert.deepEqual(ran.execArgv, [], "the child ran under plain node");
    // A second launch in the same worktree finds its own current bundle and never asks the store.
    assert.equal(childEntryArgv(fresh, NAME, SOURCE, [], undefined, { root: store }).reason, "source-hash-match");

    // Manifest corruption AFTER publication: the re-check, not the copy, is what refuses to run it.
    let calls = 0;
    const build = (await import(pathToFileURL(join(REPO_ROOT, "scripts", "build-child-entries.mjs")).href)) as {
      childEntryIsCurrent(root: string, name: string): { current: boolean; reason: string; bundle?: string };
    };
    const corrupting = (root: string, name: string) => {
      calls += 1;
      if (calls === 2) appendFileSync(join(root, OUT, "manifest.json"), "\n}garbage");
      return build.childEntryIsCurrent(root, name);
    };
    const refused = childEntryArgv(corrupt, NAME, SOURCE, [], corrupting, { root: store });
    assert.equal(calls, 2, "the tree was judged again after the copy was published");
    assert.equal(refused.kind, "tsx");
    assert.equal(refused.store?.outcome, "miss");
    assert.match(String((refused.store as { reason: string }).reason), /^materialized-not-current: /);
  } finally {
    clean(cleanup);
  }
});

test("W1-T8776: a worktree with changed source misses the store and runs tsx", async () => {
  const { store, cleanup } = await filledStore();
  const changed = freshTree(cleanup[0]);
  cleanup.push(changed);
  try {
    writeFileSync(join(changed, "src", "lib", "added.ts"), "export const added = 1;\n");
    const { log, steps } = recorder();
    const launch = childEntryArgv(changed, NAME, SOURCE, ["a-proof"], undefined, { root: store, log });
    assert.equal(launch.kind, "tsx");
    assert.equal(launch.reason, "no-manifest", "the tree's own reason is kept");
    assert.equal(launch.store?.outcome, "miss");
    assert.equal((launch.store as { reason: string }).reason, "no-stored-build");
    assert.equal(launch.argv[0], "--import");
    assert.equal(launch.argv[2], join(changed, SOURCE));
    assert.deepEqual(steps.map(([s, e]) => [s, e?.reason, e?.tree_reason]), [["child_entry.store_miss", "no-stored-build", "no-manifest"]]);
    assert.equal(existsSync(join(changed, OUT)), false, "a miss writes nothing into the tree");
    // An empty store misses without hashing anything, and says so.
    const empty = mkdtempSync(join(tmpdir(), "rmd-store-empty-"));
    cleanup.push(empty);
    assert.deepEqual(childEntryArgv(changed, NAME, SOURCE, [], undefined, { root: empty }).store, { outcome: "miss", reason: "store-empty" });
    assert.deepEqual(childEntryArgv(changed, NAME, SOURCE, [], undefined, { root: join(changed, "package.json") }).store, { outcome: "miss", reason: "store-error: ENOTDIR" });
    // `root: false` never asks the store.
    assert.equal(childEntryArgv(changed, NAME, SOURCE, [], undefined, { root: false }).store, undefined);
  } finally {
    clean(cleanup);
  }
});

test("W1-T8776: a materialized bundle resolves its paths inside its own worktree", async () => {
  const { store, cleanup } = await filledStore();
  const one = freshTree(cleanup[0]);
  const two = freshTree(cleanup[0]);
  cleanup.push(one, two);
  try {
    for (const tree of [one, two]) {
      const launch = childEntryArgv(tree, NAME, SOURCE, [], undefined, { root: store });
      assert.equal(launch.reason, "store-hit");
      const ran = runBundle(launch.argv);
      assert.equal(ran.repoRoot, tree, "a path derived from import.meta.url lands in this worktree");
      assert.equal(ran.whereUrl, pathToFileURL(join(tree, "src", "lib", "where.ts")).href);
      assert.equal(ran.dep, pathToFileURL(join(tree, "node_modules", "fixture-dep", "index.js")).href, "node_modules resolves from this worktree");
      assert.equal(JSON.stringify(ran).includes(store), false, "nothing resolves into the store");
    }
  } finally {
    clean(cleanup);
  }
});

test("W1-T8776: a source hash already stored is not rebuilt", async () => {
  const main = makeTree();
  const store = mkdtempSync(join(tmpdir(), "rmd-store-root-"));
  const calls: string[][] = [];
  const counting: RunBuildScript = (script, args, cwd) => {
    calls.push([...args]);
    return runBuildScriptInChild(script, args, cwd);
  };
  const { log, steps } = recorder();
  try {
    const first = await buildIntoStore(main, { storeRoot: store, runScript: counting, log });
    assert.equal(first.kind, "built");
    const { hash, bytes, ms } = first as { hash: string; bytes: number; ms: number };
    assert.ok(bytes > 0 && ms >= 0);
    assert.deepEqual(steps, [["child_entry.store_built", { reason: "new-build", hash, ms, bytes }]]);
    assert.equal(existsSync(join(main, OUT)), false, "the build wrote into the store, not into the tree it read");
    assert.deepEqual(calls.map((a) => a.at(-1) === "--hash" ? "hash" : a.at(-2)), ["hash", "--out"]);
    const bundle = join(store, hash, `${NAME}.mjs`);
    const before = statSync(bundle);

    calls.length = 0;
    const [again, joined] = await Promise.all([
      buildIntoStore(main, { storeRoot: store, runScript: counting }),
      buildIntoStore(main, { storeRoot: store, runScript: counting }),
    ]);
    assert.deepEqual(again, { kind: "present", hash });
    assert.strictEqual(joined, again, "a concurrent call joins the one in flight");
    assert.deepEqual(calls, [["--root", main, "--hash"]], "only the hash ran: no second build");
    assert.equal(statSync(bundle).ino, before.ino, "the stored bundle is the same file");
    assert.deepEqual(readdirSync(store).filter((n) => n.startsWith(".")), [], "no temporary build directory is left");

    // Present is a no-op only after validation: a corrupted stored hash is rebuilt in place.
    writeFileSync(bundle, readFileSync(bundle, "utf8").replace("STORE-FIXTURE", "XTORE-FIXTURE"));
    calls.length = 0;
    const rebuilt = await buildIntoStore(main, { storeRoot: store, runScript: counting });
    assert.equal(rebuilt.kind, "built");
    assert.equal(calls.length, 2);
    assert.match(readFileSync(bundle, "utf8"), /STORE-FIXTURE/);

    // A peer that completes a valid build of the same hash first keeps it: this owner's copy is discarded.
    rmSync(join(store, hash), { recursive: true });
    const peer = mkdtempSync(join(tmpdir(), "rmd-store-peer-"));
    let peerIno = 0;
    const racing: RunBuildScript = async (script, args, cwd) => {
      const out = await runBuildScriptInChild(script, args, cwd);
      if (args.includes("--out")) {
        await runBuildScriptInChild(script, ["--root", main, "--out", join(peer, "b")], cwd);
        cpSync(join(peer, "b"), join(store, hash), { recursive: true });
        peerIno = statSync(bundle).ino;
      }
      return out;
    };
    try {
      assert.equal((await buildIntoStore(main, { storeRoot: store, runScript: racing })).kind, "built");
      assert.equal(statSync(bundle).ino, peerIno, "the peer's completed valid build was not overwritten");
      assert.deepEqual(readdirSync(store).filter((n) => n.startsWith(".")), [], "the losing copy is removed");
    } finally {
      rmSync(peer, { recursive: true, force: true });
    }
  } finally {
    clean([main, store]);
  }
});

test("W1-T8776: materialization isolates worktree writes from the store", async () => {
  const { store, hash, cleanup } = await filledStore();
  const one = freshTree(cleanup[0]);
  const two = freshTree(cleanup[0]);
  cleanup.push(one, two);
  try {
    assert.equal(materializeFromStore(one, store).outcome, "hit");
    assert.equal(materializeFromStore(two, store).outcome, "hit");
    const stored = join(store, hash, `${NAME}.mjs`);
    const inOne = join(one, OUT, `${NAME}.mjs`);
    const inTwo = join(two, OUT, `${NAME}.mjs`);
    const storedDigest = digest(stored);
    const twoDigest = digest(inTwo);
    assert.notEqual(statSync(inOne).ino, statSync(stored).ino, "a copy, not a hardlink to the stored file");
    assert.equal(statSync(inOne).nlink, 1);
    appendFileSync(inOne, "\nthrow new Error('edited in worktree one');\n");
    writeFileSync(join(one, OUT, "manifest.json"), "{}\n");
    assert.equal(digest(stored), storedDigest, "the stored bundle is unchanged");
    assert.equal(digest(inTwo), twoDigest, "the other worktree's bundle is unchanged");
    assert.equal(childEntryArgv(two, NAME, SOURCE, [], undefined, { root: false }).kind, "bundle");
    // The edited worktree is no longer current, and the store hands it a fresh copy.
    const relaunch = childEntryArgv(one, NAME, SOURCE, [], undefined, { root: store });
    assert.equal(relaunch.reason, "store-hit");
    assert.equal(digest(inOne), storedDigest);
  } finally {
    clean(cleanup);
  }
});

test("W1-T8776: invalid stored payloads safely miss before execution", async () => {
  const { store, hash, cleanup } = await filledStore();
  try {
    const stored = join(store, hash);
    const bundle = join(stored, `${NAME}.mjs`);
    const good = readFileSync(bundle);
    const cases: [string, () => void, string][] = [
      // Same size, one byte flipped: a size check alone would accept it.
      ["same-size corruption", () => writeFileSync(bundle, Buffer.from(good.toString("utf8").replace("STORE-FIXTURE", "XTORE-FIXTURE"))), "stored-bundle-digest-mismatch"],
      ["a payload never published", () => rmSync(bundle), "stored-bundle-missing"],
      ["a manifest never published", () => rmSync(join(stored, "manifest.json")), "stored-manifest-invalid"],
      ["a manifest for another source", () => {
        const m = JSON.parse(readFileSync(join(stored, "manifest.json"), "utf8")) as { sourceHash: string };
        writeFileSync(join(stored, "manifest.json"), JSON.stringify({ ...m, sourceHash: "0".repeat(64) }));
      }, "stored-hash-mismatch"],
    ];
    for (const [label, spoil, reason] of cases) {
      const manifest = readFileSync(join(stored, "manifest.json"));
      const tree = freshTree(cleanup[0]);
      cleanup.push(tree);
      spoil();
      const launch = childEntryArgv(tree, NAME, SOURCE, [], undefined, { root: store });
      assert.equal(launch.kind, "tsx", label);
      assert.deepEqual(launch.store, { outcome: "miss", reason, hash }, label);
      assert.equal(existsSync(join(tree, OUT)), false, `${label}: nothing was published into the tree`);
      writeFileSync(bundle, good);
      writeFileSync(join(stored, "manifest.json"), manifest);
    }
    // Positive control: the restored store still hits.
    const tree = freshTree(cleanup[0]);
    cleanup.push(tree);
    assert.equal(childEntryArgv(tree, NAME, SOURCE, [], undefined, { root: store }).reason, "store-hit");
  } finally {
    clean(cleanup);
  }
});

test("W1-T8776: a build that fails or a tree without the build script leaves the store unchanged", async () => {
  const broken = makeTree();
  const bare = mkdtempSync(join(tmpdir(), "rmd-store-bare-"));
  const store = mkdtempSync(join(tmpdir(), "rmd-store-root-"));
  try {
    writeFileSync(join(broken, SOURCE), "export const broken = ;\n");
    const { log, steps } = recorder();
    const failed = await buildIntoStore(broken, { storeRoot: store, log });
    assert.equal(failed.kind, "failed");
    assert.match((failed as { reason: string }).reason, /CHILD-ENTRY BUILD FAILED/);
    assert.equal(steps[0]?.[0], "child_entry.store_build_failed");
    assert.deepEqual(readdirSync(store), [], "no stored hash and no temporary directory");
    assert.deepEqual(await buildIntoStore(bare, { storeRoot: store, log }), { kind: "skipped", reason: "tree-has-no-build-script" });
    assert.deepEqual(steps[1], ["child_entry.store_build_skipped", { reason: "tree-has-no-build-script" }]);
    const silent = await buildIntoStore(broken, { storeRoot: store, runScript: async () => "no hash here\n" });
    assert.deepEqual(silent, { kind: "failed", reason: "hash-unreadable" });
    const [h1, h2] = ["1".repeat(64), "2".repeat(64)];
    const moved = await buildIntoStore(broken, { storeRoot: store, runScript: async (_s, args) => `source hash ${args.includes("--hash") ? h1 : h2}\n` });
    assert.deepEqual(moved, { kind: "failed", reason: `source-moved-during-build (${h2})`, hash: h1 });
    const empty = await buildIntoStore(broken, { storeRoot: store, runScript: async () => `source hash ${h1}\n` });
    assert.deepEqual(empty, { kind: "failed", reason: "built-manifest-invalid", hash: h1 }, "a build that published nothing is never stored");
    assert.deepEqual(readdirSync(store), [], "still no stored hash and no temporary directory");
  } finally {
    clean([broken, bare, store]);
  }
});

test("W1-T8776: retention drops a stored hash no recent main revision and no live worktree uses", async () => {
  const { store, hash, cleanup } = await filledStore();
  const live = freshTree(cleanup[0]);
  cleanup.push(live);
  try {
    const idle = "a".repeat(64);
    const recent = "b".repeat(64);
    const leftover = join(store, ".build-abandoned");
    for (const d of [idle, recent]) mkdirSync(join(store, d));
    mkdirSync(leftover);
    mkdirSync(join(store, "not-ours"));
    const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    for (const p of [join(store, idle), join(store, hash), leftover, join(store, "not-ours")]) utimesSync(p, old, old);
    assert.equal(materializeFromStore(live, store).outcome, "hit");
    utimesSync(join(store, hash), old, old); // idle in the store, but a live worktree runs it
    const removed = pruneChildEntryStore(store, { liveTrees: [live, join(store, "no-such-tree")] });
    assert.deepEqual(removed.sort(), [".build-abandoned", idle].sort());
    assert.deepEqual(storedHashes(store).sort(), [hash, recent].sort());
    assert.ok(existsSync(join(store, "not-ours")), "only the store's own names are pruned");
    assert.deepEqual(pruneChildEntryStore(store), [hash], "with no live worktree using it, the idle hash goes too");
    assert.deepEqual(pruneChildEntryStore(join(store, "absent")), []);
    // A live tree whose manifest is garbage runs tsx and pins nothing; one that cannot be read at all stops the pass.
    const garbled = mkdtempSync(join(tmpdir(), "rmd-store-garbled-"));
    const unreadable = mkdtempSync(join(tmpdir(), "rmd-store-unreadable-"));
    cleanup.push(garbled, unreadable);
    mkdirSync(join(garbled, OUT), { recursive: true });
    writeFileSync(join(garbled, OUT, "manifest.json"), "}{");
    mkdirSync(join(unreadable, OUT, "manifest.json"), { recursive: true });
    utimesSync(join(store, recent), old, old);
    assert.deepEqual(pruneChildEntryStore(store, { liveTrees: [garbled] }), [recent]);
    assert.throws(() => pruneChildEntryStore(store, { liveTrees: [unreadable] }), /EISDIR/);
    // After a build, retention runs and ledgers what it did, or why it could not.
    const { log, steps } = recorder();
    assert.equal((await buildIntoStore(cleanup[0], { storeRoot: store, log, liveTrees: () => [unreadable] })).kind, "built");
    assert.deepEqual(steps.map(([s]) => s), ["child_entry.store_built", "child_entry.store_prune_failed"]);
    mkdirSync(join(store, idle));
    utimesSync(join(store, idle), old, old);
    steps.length = 0;
    assert.equal((await buildIntoStore(cleanup[0], { storeRoot: store, log })).kind, "present");
    assert.deepEqual(steps, [
      ["child_entry.store_present", { reason: "source-hash-already-present", hash }],
      ["child_entry.store_pruned", { removed: [idle] }],
    ]);
  } finally {
    clean(cleanup);
  }
});

test("W1-T8776: the store root comes from the instance config, and an unreadable config never breaks a launch", () => {
  const home = mkdtempSync(join(tmpdir(), "rmd-store-home-"));
  const savedHome = process.env.HOME;
  try {
    assert.equal(defaultChildEntryStoreRoot(home), join(home, "Remudero", "child-entries"), "no config: loadConfig's default root");
    mkdirSync(join(home, ".config", "remudero"), { recursive: true });
    writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ root: "/srv/instance" }));
    assert.equal(defaultChildEntryStoreRoot(home), join("/srv/instance", "child-entries"));
    writeFileSync(join(home, ".config", "remudero", "config.json"), "{ not json");
    assert.throws(() => defaultChildEntryStoreRoot(home), SyntaxError);
    // The launch path reads this instance's config by default; an unreadable one means "no store", never a throw.
    process.env.HOME = home;
    const tree = makeTree();
    try {
      const launch = childEntryArgv(tree, NAME, SOURCE, []);
      assert.equal(launch.kind, "tsx");
      assert.equal(launch.store, undefined);
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    rmSync(home, { recursive: true, force: true });
  }
});
