import assert from "node:assert/strict";
import fs from "node:fs";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { defaultAsyncProofSpawner, defaultProofSpawner } from "#src/lib/review.js";
import { makeTempDir, removeOwnedTree, sweepStaleTempDirs } from "#src/lib/tmp.js";
import { usePassThroughProofSandbox } from "#test/helpers/pass-through-proof-sandbox.js";

usePassThroughProofSandbox();

const SEED = [".local", "share", "remudero", "dependencies", "key", "node_modules", "pkg"];

// The shape a killed W1-T11468 test leaves: a seed store with directories r-x and files r--.
function makeReadOnlyTree(base: string, beforeLock = (_deepest: string) => {}): string {
  const deepest = join(base, ...SEED);
  mkdirSync(deepest, { recursive: true });
  beforeLock(deepest);
  writeFileSync(join(deepest, "index.js"), "module.exports = 1;\n");
  chmodSync(join(deepest, "index.js"), 0o444);
  for (let dir = deepest; dir !== base; dir = dirname(dir)) chmodSync(dir, 0o555);
  return deepest;
}

function restoreModes(path: string): void {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return; // already removed
  }
  if (!st.isDirectory()) return;
  chmodSync(path, 0o755);
  for (const name of readdirSync(path)) restoreModes(join(path, name));
}

function snapshot(path: string): string[] {
  const st = lstatSync(path);
  const row = `${path} ${(st.mode & 0o7777).toString(8)}`;
  if (!st.isDirectory()) return [`${row} ${readFileSync(path, "utf8")}`];
  return [row, ...readdirSync(path).sort().flatMap((name) => snapshot(join(path, name)))];
}

const CHILD_TREE = `
const fs = require("node:fs"); const path = require("node:path");
const deepest = path.join(process.env.HOME, ${JSON.stringify(SEED.join("/"))});
fs.mkdirSync(deepest, { recursive: true });
fs.writeFileSync(path.join(deepest, "index.js"), "x");
fs.chmodSync(path.join(deepest, "index.js"), 0o444);
for (let d = deepest; d !== process.env.HOME; d = path.dirname(d)) fs.chmodSync(d, 0o555);
`;
const childExits0 = `${CHILD_TREE} process.stdout.write("HOME=" + process.env.HOME);`;
const childExits1 = `${CHILD_TREE} process.stderr.write("child failed HOME=" + process.env.HOME); process.exit(1);`;
const lockParent = `fs.chmodSync(path.dirname(process.env.HOME), 0o555);`;

const homeOf = (text: string): string => /HOME=(\S+)/.exec(text)![1]!;

function captureWarnings(t: TestContext): string[] {
  const seen: string[] = [];
  const listener = (warning: Error) => seen.push(warning.message);
  process.on("warning", listener);
  t.after(() => process.off("warning", listener));
  return seen;
}

async function bothSpawners(cwd: string, script: string, unlock = () => {}): Promise<Array<{ out?: string; error?: unknown }>> {
  const results: Array<{ out?: string; error?: unknown }> = [];
  try {
    results.push({ out: defaultProofSpawner(process.execPath, ["-e", script], cwd, 60_000) });
  } catch (error) {
    results.push({ error });
  }
  unlock();
  try {
    results.push({ out: await defaultAsyncProofSpawner(process.execPath, ["-e", script], cwd, 60_000) });
  } catch (error) {
    results.push({ error });
  }
  return results;
}

test("W1-T13819 criterion 1: removeOwnedTree removes a directory that holds a read-only tree three deep", (t) => {
  const dir = makeTempDir("t13819-c1");
  t.after(() => restoreModes(dir));
  makeReadOnlyTree(dir);
  assert.deepEqual(removeOwnedTree(dir), { ok: true });
  assert.equal(existsSync(dir), false);
  assert.deepEqual(removeOwnedTree(dir), { ok: true }, "a missing directory is ok");
});

test("W1-T13819 criterion 2: both spawners return the stdout of a child that leaves a read-only tree in its HOME, and the home is removed", async (t) => {
  const cwd = makeTempDir("t13819-c2");
  const homes: string[] = [];
  t.after(() => homes.forEach(restoreModes));
  for (const result of await bothSpawners(cwd, childExits0)) {
    assert.equal(result.error, undefined, `no EACCES: ${String((result.error as Error | undefined)?.message)}`);
    const home = homeOf(result.out!);
    homes.push(home);
    assert.match(home, /rmd-proof-home-/);
    assert.equal(result.out, `HOME=${home}`);
    assert.equal(existsSync(home), false);
  }
  assert.equal(homes.length, 2);
});

test("W1-T13819 criterion 3: a child that exits 1 stays the proof failure, not EACCES, and the home is removed", async (t) => {
  const cwd = makeTempDir("t13819-c3");
  const homes: string[] = [];
  t.after(() => homes.forEach(restoreModes));
  for (const result of await bothSpawners(cwd, childExits1)) {
    assert.equal(result.out, undefined);
    const error = result.error as { status?: unknown; stderr?: unknown; code?: unknown; message: string };
    assert.notEqual(error.code, "EACCES");
    assert.equal(error.status, 1);
    assert.match(String(error.stderr), /^child failed HOME=/);
    const home = homeOf(String(error.stderr));
    homes.push(home);
    assert.equal(existsSync(home), false);
  }
  assert.equal(homes.length, 2);
});

test("W1-T13819 criterion 4: a symbolic link to a read-only directory outside is removed as a link, and the outside is unchanged", (t) => {
  const outside = makeTempDir("t13819-c4-outside");
  const dir = makeTempDir("t13819-c4");
  t.after(() => {
    restoreModes(dir);
    restoreModes(outside);
  });
  mkdirSync(join(outside, "sub"));
  writeFileSync(join(outside, "sub", "kept.txt"), "kept\n");
  chmodSync(join(outside, "sub", "kept.txt"), 0o444);
  chmodSync(join(outside, "sub"), 0o555);
  chmodSync(outside, 0o555);
  const before = snapshot(outside);
  symlinkSync(outside, join(dir, "link"));
  makeReadOnlyTree(dir, (deepest) => symlinkSync(outside, join(deepest, "deep-link")));
  assert.deepEqual(removeOwnedTree(dir), { ok: true });
  assert.equal(existsSync(dir), false);
  assert.deepEqual(snapshot(outside), before);

  const racedOutside = makeTempDir("t13819-c4-raced-outside");
  const racedRoot = makeTempDir("t13819-c4-raced-root");
  const racedEntry = join(racedRoot, "entry");
  const parkedEntry = join(racedRoot, "parked-entry");
  mkdirSync(racedEntry);
  makeReadOnlyTree(racedEntry);
  mkdirSync(join(racedOutside, "sub"));
  writeFileSync(join(racedOutside, "sub", "kept.txt"), "unchanged\n");
  chmodSync(join(racedOutside, "sub", "kept.txt"), 0o444);
  chmodSync(join(racedOutside, "sub"), 0o555);
  chmodSync(racedOutside, 0o555);
  const racedBefore = snapshot(racedOutside);
  t.after(() => restoreModes(racedOutside));
  const originalOpen = fs.openSync;
  let swapped = false;
  fs.openSync = ((path: fs.PathLike, flags: string | number, mode?: number) => {
    if (!swapped && String(path) === racedEntry) {
      swapped = true;
      fs.renameSync(racedEntry, parkedEntry);
      symlinkSync(racedOutside, racedEntry);
      restoreModes(parkedEntry);
    }
    return originalOpen(path, flags, mode);
  }) as typeof fs.openSync;
  try {
    assert.deepEqual(removeOwnedTree(racedRoot), { ok: true });
  } finally {
    fs.openSync = originalOpen;
    restoreModes(racedRoot);
  }
  assert.equal(swapped, true);
  assert.equal(existsSync(racedRoot), false);
  assert.deepEqual(snapshot(racedOutside), racedBefore);
});

const UID0_SKIP = process.getuid?.() === 0 ? "uid 0 ignores directory modes, so no removal can be made to fail" : false;

test("W1-T13819 criterion 5: a removal that still fails returns its reason, and both spawners keep the child's own result", { skip: UID0_SKIP }, async (t) => {
  const warnings = captureWarnings(t);
  const parent = makeTempDir("t13819-c5-parent");
  const savedTmp = process.env.TMPDIR;
  const restoreTmp = () => {
    if (savedTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = savedTmp;
  };
  t.after(() => {
    restoreTmp();
    restoreModes(parent);
  });
  const dir = join(parent, "owned");
  mkdirSync(dir);
  makeReadOnlyTree(dir);
  chmodSync(parent, 0o555);
  const removal = removeOwnedTree(dir);
  assert.equal(removal.ok, false);
  if (removal.ok) return;
  assert.match(removal.reason, /EACCES|EPERM/);
  assert.ok(removal.reason.includes(dir), removal.reason);
  chmodSync(parent, 0o755);

  const cwd = makeTempDir("t13819-c5");
  process.env.TMPDIR = parent;
  const unlock = () => chmodSync(parent, 0o755);
  const passed = await bothSpawners(cwd, `${CHILD_TREE} ${lockParent} process.stdout.write("HOME=" + process.env.HOME);`, unlock);
  unlock();
  const failed = await bothSpawners(cwd, `${CHILD_TREE} ${lockParent} process.stderr.write("child failed HOME=" + process.env.HOME); process.exit(1);`, unlock);
  unlock();
  restoreTmp();
  await new Promise((resolve) => setImmediate(resolve));
  for (const result of passed) {
    assert.equal(result.error, undefined, `no removal error: ${String((result.error as Error | undefined)?.message)}`);
    assert.equal(result.out, `HOME=${homeOf(result.out!)}`);
  }
  for (const result of failed) {
    const error = result.error as { status?: unknown; stderr?: unknown; code?: unknown };
    assert.equal(error.status, 1);
    assert.notEqual(error.code, "EACCES");
    assert.match(String(error.stderr), /^child failed HOME=/);
  }
  const homes = [...passed.map((r) => homeOf(r.out!)), ...failed.map((r) => homeOf(String((r.error as { stderr: unknown }).stderr)))];
  for (const home of homes) {
    assert.ok(warnings.some((w) => w.includes(home) && /EACCES|EPERM/.test(w)), `a declared warning names ${home}`);
  }
});

test("W1-T13819 criterion 6: sweepStaleTempDirs removes a stale rmd- directory that holds a read-only tree", (t) => {
  const root = makeTempDir("t13819-c6-root");
  t.after(() => restoreModes(root));
  const stale = join(root, "rmd-proof-home-stale");
  mkdirSync(stale);
  makeReadOnlyTree(stale);
  const summary = sweepStaleTempDirs({ root, now: () => Date.now() + 48 * 60 * 60 * 1000 });
  assert.deepEqual(summary.removed, ["rmd-proof-home-stale"]);
  assert.equal(summary.kept.length, 0);
  assert.equal(existsSync(stale), false);
});
