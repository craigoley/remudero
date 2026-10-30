import assert from "node:assert/strict";
import fs, { cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { childEntryArgv, childEntrySpawnedRow, type ChildEntryStoreOptions } from "#src/lib/child-entry-argv.js";
import { materializeFromStore } from "#src/lib/child-entry-store.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

interface HashStats { computed: number; reused: number; bytes_read: number; ms: number }
const script = createRequire(import.meta.url)(join(REPO_ROOT, "scripts/build-child-entries.mjs")) as {
  HASHED_ROOT_FILES: readonly string[];
  sourceHash(root: string, version?: string, stats?: HashStats): string;
  buildChildEntries(opts: { root: string; entries: { name: string; source: string }[]; workers: string[] }): Promise<{ sourceHash: string }>;
};
const NAME = "check-proof-main", SOURCE = "src/check-proof-main.ts";
const ORIGINAL = "console.log('before');\n", EDITED = "console.log('edited');\n";

function countSourceReads(t: TestContext, root: string) {
  const source = join(root, SOURCE);
  const read = fs.readFileSync;
  let count = 0;
  const spy = t.mock.method(fs, "readFileSync", (path: unknown, ...args: unknown[]) => {
    if (path === source) count++;
    return Reflect.apply(read, fs, [path, ...args]);
  });
  syncBuiltinESMExports();
  t.after(() => { spy.mock.restore(); syncBuiltinESMExports(); });
  return () => count;
}

async function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "rmd-t9709-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, "tree"), store = join(dir, "store");
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(store);
  writeFileSync(join(root, "package.json"), '{"type":"module"}\n');
  writeFileSync(join(root, SOURCE), ORIGINAL);
  await script.buildChildEntries({ root, entries: [{ name: NAME, source: SOURCE }], workers: [] });
  let calls = 0;
  const rows: Record<string, unknown>[] = [];
  const options: ChildEntryStoreOptions = {
    root: store, daemonOwned: false,
    hashSource: (tree, version, stats) => { calls++; return script.sourceHash(tree, version, stats); },
    log: (step, extra) => { rows.push({ step, ...extra }); },
  };
  return { root, store, rows, options, calls: () => calls,
    launch: () => childEntryArgv(root, NAME, SOURCE, [], undefined, options) };
}

test("W1-T9709: a source-changed launch hashes its tree once, on a store miss and on a store hit", async (t) => {
  for (const hit of [false, true]) await t.test(hit ? "store hit" : "store miss", async (sub) => {
    const f = await fixture(sub);
    writeFileSync(join(f.root, SOURCE), EDITED);
    const hash = script.sourceHash(f.root);
    if (hit) {
      const built = join(f.root, "dist/child-entries");
      const old = join(f.root, "old-build");
      cpSync(built, old, { recursive: true });
      await script.buildChildEntries({ root: f.root, entries: [{ name: NAME, source: SOURCE }], workers: [] });
      cpSync(built, join(f.store, hash), { recursive: true });
      rmSync(built, { recursive: true });
      cpSync(old, built, { recursive: true });
    } else mkdirSync(join(f.store, "0".repeat(64)));
    const reads = countSourceReads(sub, f.root);
    const launch = f.launch();
    assert.equal(f.calls(), 1);
    assert.equal(reads(), 1, "the source is read only once across judge, store and re-judge");
    assert.equal(launch.kind, hit ? "bundle" : "tsx");
    assert.equal(launch.reason, hit ? "store-hit" : "source-changed");
    assert.equal(launch.store?.outcome, hit ? "hit" : "miss");
    assert.equal(launch.store?.hash, hash);
    assert.equal(f.rows[0]!.tree_reason, "source-changed");
    assert.equal(launch.hash.computed, 1);
  });
  await t.test("a source edit during store publication refuses the stale bundle", async (sub) => {
    const f = await fixture(sub);
    const source = join(f.root, SOURCE);
    writeFileSync(source, EDITED);
    const hash = script.sourceHash(f.root);
    const built = join(f.root, "dist/child-entries");
    const old = join(f.root, "old-build");
    cpSync(built, old, { recursive: true });
    await script.buildChildEntries({ root: f.root, entries: [{ name: NAME, source: SOURCE }], workers: [] });
    cpSync(built, join(f.store, hash), { recursive: true });
    rmSync(built, { recursive: true });
    cpSync(old, built, { recursive: true });
    let changed = false;
    const copy = fs.copyFileSync;
    const copySpy = sub.mock.method(fs, "copyFileSync", (...args: unknown[]) => {
      Reflect.apply(copy, fs, args);
      if (!changed) {
        changed = true;
        writeFileSync(source, "console.log('during publication');\n");
      }
    });
    syncBuiltinESMExports();
    sub.after(() => { copySpy.mock.restore(); syncBuiltinESMExports(); });
    const reads = countSourceReads(sub, f.root);
    const launch = f.launch();
    assert.equal(changed, true, "the source changed while the store copy was in progress");
    assert.equal(f.calls(), 1);
    assert.equal(reads(), 1, "the changed launch still reads source content once");
    assert.equal(launch.hash.computed, 1);
    assert.equal(launch.kind, "tsx");
    assert.equal(launch.store?.outcome, "miss");
    assert.equal(launch.store?.reason, "materialized-not-current: source-signature-changed");
    assert.equal(f.launch().kind, "tsx", "the following launch re-hashes the changed source");
    assert.equal(f.calls(), 2);
  });
});

test("W1-T9709: a launch from an unchanged tree reuses its hash", async (t) => {
  const f = await fixture(t);
  const reads = countSourceReads(t, f.root);
  assert.equal(f.launch().kind, "bundle");
  const launch = f.launch();
  assert.equal(launch.kind, "bundle");
  assert.equal(f.calls(), 1);
  assert.equal(reads(), 1, "the second launch reads no source content");
  assert.deepEqual(launch.hash, { computed: 0, reused: 1, bytes_read: 0, ms: 0 });
});

test("W1-T9709: an edit that restores size and mtime is still re-hashed", async (t) => {
  const f = await fixture(t);
  const path = join(f.root, SOURCE);
  const fixed = new Date("2020-01-01T00:00:00Z");
  utimesSync(path, fixed, fixed);
  const before = statSync(path, { bigint: true });
  assert.equal(f.launch().kind, "bundle");
  writeFileSync(path, EDITED);
  utimesSync(path, fixed, fixed);
  const after = statSync(path, { bigint: true });
  assert.equal(after.size, before.size);
  assert.equal(after.mtimeNs, before.mtimeNs);
  assert.notEqual(after.ctimeNs, before.ctimeNs);
  const launch = f.launch();
  assert.equal(launch.kind, "tsx");
  assert.equal(launch.reason, "source-changed");
  assert.equal(f.calls(), 2);
  assert.equal(launch.hash.computed, 1);
});

test("W1-T9709: the launch rows name the hashes computed and reused", async (t) => {
  const f = await fixture(t);
  const expectedBytes = Buffer.byteLength(ORIGINAL) + Buffer.byteLength('{"type":"module"}\n');
  const first = f.launch();
  assert.equal(first.hash.computed, 1);
  assert.equal(first.hash.reused, 0);
  assert.equal(first.hash.bytes_read, expectedBytes);
  assert.ok(first.hash.ms >= 0 && Number.isFinite(first.hash.ms));
  assert.deepEqual(childEntrySpawnedRow(NAME, "garden", first).hash, first.hash);
  const reused = f.launch();
  assert.deepEqual(childEntrySpawnedRow(NAME, "garden", reused).hash,
    { computed: 0, reused: 1, bytes_read: 0, ms: 0 });
  writeFileSync(join(f.root, SOURCE), EDITED);
  const miss = f.launch();
  assert.deepEqual(f.rows.at(-1)!.hash, miss.hash);
  assert.equal(miss.hash.computed, 1);
  const current = await script.buildChildEntries({ root: f.root, entries: [{ name: NAME, source: SOURCE }], workers: [] });
  cpSync(join(f.root, "dist/child-entries"), join(f.store, current.sourceHash), { recursive: true });
  rmSync(join(f.root, "dist"), { recursive: true });
  const hit = f.launch();
  assert.equal(hit.reason, "store-hit");
  assert.deepEqual(f.rows.at(-1)!.hash, hit.hash);
  assert.equal(f.rows.at(-1)!.tree_hash, current.sourceHash);
  assert.deepEqual(hit.hash, { computed: 0, reused: 1, bytes_read: 0, ms: 0 });
});

test("W1-T9709: every source input invalidates the memo and roots stay separate", async (t) => {
  const f = await fixture(t);
  assert.equal(f.launch().kind, "bundle");
  const check = (edit: () => void) => {
    const before = f.calls();
    edit();
    const launch = f.launch();
    assert.equal(f.calls(), before + 1);
    assert.equal(launch.hash.computed, 1);
  };
  check(() => writeFileSync(join(f.root, "src/added.ts"), "export {};\n"));
  check(() => renameSync(join(f.root, "src/added.ts"), join(f.root, "src/renamed.ts")));
  check(() => rmSync(join(f.root, "src/renamed.ts")));
  for (const name of script.HASHED_ROOT_FILES) {
    check(() => {
      mkdirSync(join(f.root, "scripts"), { recursive: true });
      writeFileSync(join(f.root, name), name === "package.json" ? '{"type":"module","changed":true}' : "changed\n");
    });
  }
  const other = await fixture(t);
  assert.equal(other.launch().hash.computed, 1);
  assert.equal(other.launch().hash.reused, 1);
});

test("W1-T9709: symlinks and replaced inodes invalidate the memo", async (t) => {
  const f = await fixture(t);
  assert.equal(f.launch().kind, "bundle");
  const path = join(f.root, SOURCE), st = statSync(path);
  const replacement = join(f.root, "replacement");
  writeFileSync(replacement, EDITED);
  utimesSync(replacement, st.atime, st.mtime);
  const inode = lstatSync(path).ino;
  renameSync(replacement, path);
  assert.notEqual(lstatSync(path).ino, inode);
  assert.equal(f.launch().hash.computed, 1);
  symlinkSync("first", join(f.root, "src/link"));
  assert.equal(f.launch().hash.computed, 1);
  rmSync(join(f.root, "src/link"));
  symlinkSync("other", join(f.root, "src/link"));
  assert.equal(f.launch().hash.computed, 1);
  const target = join(f.root, "root-input");
  writeFileSync(target, "first");
  symlinkSync(target, join(f.root, "tsconfig.json"));
  assert.equal(f.launch().hash.computed, 1);
  writeFileSync(target, "other");
  assert.equal(f.launch().hash.computed, 1);
});

test("W1-T9709: a memo hit still refuses a corrupted bundle and store", async (t) => {
  const f = await fixture(t);
  assert.equal(f.launch().kind, "bundle");
  const bundle = join(f.root, "dist/child-entries", `${NAME}.mjs`);
  const bytes = readFileSync(bundle, "utf8");
  writeFileSync(bundle, bytes.replace("before", "broken"));
  const launch = f.launch();
  assert.equal(launch.kind, "tsx");
  assert.equal(launch.reason, "bundle-digest-mismatch");
  const hash = script.sourceHash(f.root);
  cpSync(join(f.root, "dist/child-entries"), join(f.store, hash), { recursive: true });
  assert.deepEqual(materializeFromStore(f.root, f.store, hash),
    { outcome: "miss", reason: "stored-bundle-digest-mismatch", hash });
});

test("W1-T9709: stat and hash failures fall back to tsx without caching a failure", async (t) => {
  const f = await fixture(t);
  f.options.hashSource = () => { throw new Error("hash-read-failed"); };
  const failed = f.launch();
  assert.equal(failed.kind, "tsx");
  assert.match(failed.reason, /hash-read-failed/);
  delete f.options.hashSource;
  assert.equal(f.launch().hash.computed, 1);
  rmSync(join(f.root, "src"), { recursive: true });
  const missing = f.launch();
  assert.equal(missing.kind, "tsx");
  assert.match(missing.reason, /ENOENT/);
});

test("W1-T9709: the default hash and a no-manifest store lookup read source once", async (t) => {
  const f = await fixture(t);
  delete f.options.hashSource;
  const reads = countSourceReads(t, f.root);
  const first = f.launch();
  assert.equal(first.kind, "bundle");
  assert.equal(first.hash.computed, 1);
  assert.equal(reads(), 1);
  assert.equal(f.launch().hash.reused, 1);
  assert.equal(reads(), 1);
  rmSync(join(f.root, "dist"), { recursive: true });
  mkdirSync(join(f.store, "0".repeat(64)));
  writeFileSync(join(f.root, SOURCE), EDITED);
  const missing = f.launch();
  assert.equal(missing.kind, "tsx");
  assert.equal(missing.reason, "no-manifest");
  assert.equal(missing.hash.computed, 1);
  assert.equal(reads(), 2);
});

test("W1-T9709: a tree changing during hashing is refused and not memoized", async (t) => {
  const f = await fixture(t);
  f.options.hashSource = (root, version, stats) => {
    const hash = script.sourceHash(root, version, stats);
    writeFileSync(join(root, SOURCE), EDITED);
    return hash;
  };
  const moving = f.launch();
  assert.equal(moving.kind, "tsx");
  assert.match(moving.reason, /source changed while hashing/);
  delete f.options.hashSource;
  const stable = f.launch();
  assert.equal(stable.kind, "tsx");
  assert.equal(stable.reason, "source-changed");
  assert.equal(stable.hash.computed, 1);
});

test("W1-T9709: an unreadable signature after publication refuses the bundle", async (t) => {
  const f = await fixture(t);
  const hash = script.sourceHash(f.root);
  cpSync(join(f.root, "dist/child-entries"), join(f.store, hash), { recursive: true });
  rmSync(join(f.root, "dist"), { recursive: true });
  const source = join(f.root, SOURCE);
  const lstat = fs.lstatSync;
  let checks = 0;
  const spy = t.mock.method(fs, "lstatSync", (path: unknown, ...args: unknown[]) => {
    if (path === source && ++checks === 3) throw new Error("stat refused after copy");
    return Reflect.apply(lstat, fs, [path, ...args]);
  });
  syncBuiltinESMExports();
  t.after(() => { spy.mock.restore(); syncBuiltinESMExports(); });
  const launch = f.launch();
  assert.equal(checks, 3);
  assert.equal(launch.kind, "tsx");
  assert.equal(launch.hash.computed, 1);
  assert.equal(f.calls(), 1);
  assert.equal(launch.store?.outcome, "miss");
  assert.match(launch.store?.reason ?? "", /source-signature-unavailable: stat refused after copy/);
});
