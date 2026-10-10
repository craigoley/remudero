// test/npm-run-typecheck-is-incremental-and-slotted.test.ts — worker agents call `npm run typecheck` directly, and as
// plain `tsc -p tsconfig.json --noEmit` that path stayed cold, full and unslotted after #10374/#10487: two such checks
// held 2.4 and 2.2 GB RSS for 18+ min on a host at load 30 (OBSERVED 2026-10-10). The script now runs
// scripts/typecheck.mjs → runTypecheck: incremental per worktree, and a cold check waits for a host test slot.
// FIXTURES ONLY: every tree, worktree, slot dir and buildinfo lives under this test's tmp dirs.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { TYPECHECK_BUILDINFO_NAME } from "../src/lib/typecheck-buildinfo.js";
import { acquireTestSlot } from "../src/lib/test-slot.js";
import { dirIsWritable, NPM_TYPECHECK_SLOT_LABEL, prepareTypecheckRun, runTypecheck, WORKTREE_BUILDINFO_NAME } from "../src/lib/typecheck-run.js";
import { gitRepo } from "./helpers/git-repo.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(REPO_ROOT, "scripts", "typecheck.mjs");
const TSCONFIG = JSON.stringify({ compilerOptions: { types: [], noEmit: true, strict: true }, include: ["*.ts"] });

function slotEnv(t: TestContext): string {
  const slots = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}npm-typecheck-slots-`));
  const keys = ["RMD_TEST_SLOT_DIR", "RMD_TEST_SLOTS", "RMD_TEST_SLOT_PARENT"];
  const saved = keys.map((key) => process.env[key]);
  process.env.RMD_TEST_SLOT_DIR = slots;
  process.env.RMD_TEST_SLOTS = "1";
  delete process.env.RMD_TEST_SLOT_PARENT;
  t.after(() => {
    keys.forEach((key, i) => { if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i]; });
    rmSync(slots, { recursive: true, force: true });
  });
  return slots;
}

const heldLabels = (slots: string): string[] => readdirSync(slots).map((name) => JSON.parse(readFileSync(join(slots, name), "utf8")).label);

/** A tiny project in a fresh git tree, its node_modules linked to this repo's install. */
function project(t: TestContext): { dir: string; git: (...args: string[]) => string; addWorktree: (path: string, branch: string) => { dir: string } } {
  const tree = gitRepo({ kind: "npm-typecheck" });
  t.after(() => tree.cleanup());
  symlinkSync(join(REPO_ROOT, "node_modules"), join(tree.dir, "node_modules"));
  writeFileSync(join(tree.dir, "tsconfig.json"), TSCONFIG);
  writeFileSync(join(tree.dir, "a.ts"), "export const a: number = 1;\n");
  writeFileSync(join(tree.dir, ".gitignore"), "node_modules\n");
  tree.git("add", "tsconfig.json", "a.ts", ".gitignore");
  tree.git("commit", "-qm", "base");
  return tree;
}

test("the package.json typecheck script resolves to the incremental, slotted wrapper, not plain tsc", () => {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };
  assert.equal(pkg.scripts.typecheck, "node --import tsx scripts/typecheck.mjs");
  assert.doesNotMatch(pkg.scripts.typecheck, /^tsc\b/);
  assert.match(readFileSync(SCRIPT, "utf8"), /import \{ runTypecheck \} from "\.\.\/src\/lib\/typecheck-run\.ts"/);
  assert.match(readFileSync(join(REPO_ROOT, "scripts", "check.mjs"), "utf8"), /"typecheck\.mjs"/, "npm run check's tsc rides the same wrapper");
});

test("npm run typecheck's wrapper passes --incremental and the worktree's own buildinfo to tsc", (t) => {
  slotEnv(t);
  const tree = project(t);
  const lane = tree.addWorktree(join(realpathSync(dirname(tree.dir)), `${RMD_TMP_PREFIX}npm-typecheck-lane-${process.pid}`), "lane");
  t.after(() => rmSync(lane.dir, { recursive: true, force: true }));
  symlinkSync(join(REPO_ROOT, "node_modules"), join(lane.dir, "node_modules"));
  const seen: string[][] = [];
  const code = runTypecheck(lane.dir, ["--pretty", "false"], { spawn: (_file, args) => { seen.push([...args]); return { status: 0 }; }, log: () => {} });
  assert.equal(code, 0);
  const laneGitDir = realpathSync(spawnSync("git", ["-C", lane.dir, "rev-parse", "--absolute-git-dir"], { encoding: "utf8" }).stdout.trim());
  assert.notEqual(laneGitDir, realpathSync(join(tree.dir, ".git")), "per worktree, not the canonical checkout's");
  assert.deepEqual(seen, [["-p", "tsconfig.json", "--noEmit", "--incremental", "--tsBuildInfoFile", join(laneGitDir, TYPECHECK_BUILDINFO_NAME), "--pretty", "false"]]);
});

test("a cold npm run typecheck takes a host test slot while tsc runs, and a warm one takes none", (t) => {
  const slots = slotEnv(t);
  const tree = project(t);
  const observed: string[][] = [];
  const realTsc = (file: string, args: readonly string[], cwd: string) => {
    observed.push(heldLabels(slots));
    const r = spawnSync(file, [...args], { cwd, encoding: "utf8" });
    return { status: r.status };
  };
  assert.equal(runTypecheck(tree.dir, [], { spawn: realTsc, log: () => {} }), 0);
  assert.deepEqual(heldLabels(slots), [], "the cold check released its slot");
  assert.ok(existsSync(join(tree.dir, ".git", TYPECHECK_BUILDINFO_NAME)), "the cold check left a buildinfo behind");
  assert.equal(runTypecheck(tree.dir, [], { spawn: realTsc, log: () => {} }), 0);
  assert.deepEqual(observed, [[NPM_TYPECHECK_SLOT_LABEL], []]);
});

test("the wrapper reports tsc's own diagnostics and exit code, cold and warm", (t) => {
  slotEnv(t);
  const tree = project(t);
  const run = () => spawnSync(process.execPath, ["--import", "tsx", SCRIPT], { cwd: tree.dir, encoding: "utf8", timeout: 60_000 });
  const clean = run();
  assert.equal(clean.status, 0, clean.stdout + clean.stderr);
  writeFileSync(join(tree.dir, "b.ts"), 'export const b: number = "two";\n');
  const plain = spawnSync(join(tree.dir, "node_modules", ".bin", "tsc"), ["-p", "tsconfig.json", "--noEmit"], { cwd: tree.dir, encoding: "utf8" });
  assert.notEqual(plain.status, 0, "the plain check is red on the type error");
  assert.match(plain.stdout, /b\.ts\(1,14\): error TS2322/);
  for (let i = 0; i < 2; i += 1) {
    const red = run();
    assert.equal(red.status, plain.status, red.stdout + red.stderr);
    assert.equal(red.stdout, plain.stdout, "identical diagnostics to a plain check");
  }
});

test("a tsc that cannot start is named and exits 127, and the cold slot is still released", (t) => {
  const slots = slotEnv(t);
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}npm-typecheck-nogit-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "node_modules"));
  const lines: string[] = [];
  assert.equal(runTypecheck(dir, [], { log: (line) => lines.push(line) }), 127);
  assert.match(lines.join("\n"), /"slot":"acquired"/);
  assert.match(lines.join("\n"), /could not run tsc: .*ENOENT/);
  assert.deepEqual(heldLabels(slots), []);
});

test("a sandboxed worker whose git dir is read-only keeps its buildinfo in the worktree, and tsc still reports its own result", (t) => {
  slotEnv(t);
  const tree = project(t);
  const lane = tree.addWorktree(join(realpathSync(dirname(tree.dir)), `${RMD_TMP_PREFIX}npm-typecheck-ro-${process.pid}`), "ro-lane");
  t.after(() => rmSync(lane.dir, { recursive: true, force: true }));
  symlinkSync(join(REPO_ROOT, "node_modules"), join(lane.dir, "node_modules"));
  const laneGitDir = realpathSync(spawnSync("git", ["-C", lane.dir, "rev-parse", "--absolute-git-dir"], { encoding: "utf8" }).stdout.trim());
  // Codex's sandbox binds the canonical checkout's git dir read-only; the worktree stays writable.
  const canWrite = (dir: string) => realpathSync(dir) !== laneGitDir;
  const prepared = prepareTypecheckRun(lane.dir, canWrite);
  assert.equal(prepared.where, "worktree");
  assert.equal(prepared.buildInfo, join(lane.dir, WORKTREE_BUILDINFO_NAME));
  assert.deepEqual(prepared.args, ["-p", "tsconfig.json", "--noEmit", "--incremental", "--tsBuildInfoFile", prepared.buildInfo]);
  const realTsc = (file: string, args: readonly string[], cwd: string) => {
    const r = spawnSync(file, [...args], { cwd, encoding: "utf8" });
    return { status: r.status };
  };
  assert.equal(runTypecheck(lane.dir, [], { spawn: realTsc, canWrite, log: () => {} }), 0);
  assert.ok(existsSync(prepared.buildInfo!), "tsc wrote the worktree buildinfo");
  assert.ok(!existsSync(join(laneGitDir, TYPECHECK_BUILDINFO_NAME)), "nothing was written into the read-only git dir");
  assert.equal(prepareTypecheckRun(lane.dir, () => false).where, "plain", "nowhere writable runs the plain check");
  assert.equal(dirIsWritable(lane.dir), true, "the default probe creates a file where it can");
  assert.equal(dirIsWritable(join(lane.dir, "no-such-dir")), false, "and refuses where tsc could not write either");
  // This repo's own ignore rule keeps the fallback out of every diff.
  assert.equal(spawnSync("git", ["-C", REPO_ROOT, "check-ignore", "-q", WORKTREE_BUILDINFO_NAME]).status, 0);
});

test("a slot holder in another pid namespace on the same host is live by its lease, not dead by its pid", (t) => {
  const slots = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}npm-typecheck-ns-slots-`));
  t.after(() => rmSync(slots, { recursive: true, force: true }));
  const base = { dir: slots, slots: 1, log: () => {}, bootId: () => "boot-1" };
  const first = acquireTestSlot("typecheck:npm", { ...base, pidNamespace: () => "pid:[111]" });
  assert.equal(first.outcome, "acquired");
  // A second sandboxed worker cannot see the first's pid: the probe says dead, the namespace says "not yours to judge".
  const peer = acquireTestSlot("typecheck:npm", { ...base, pidNamespace: () => "pid:[222]", isPidAlive: () => false, waitBoundMs: 0 });
  assert.equal(peer.outcome, "wait_bound_exceeded", peer.note);
  // Control: the same namespace with a dead pid is still reclaimed, as before.
  const sameNs = acquireTestSlot("typecheck:npm", { ...base, pidNamespace: () => "pid:[111]", isPidAlive: () => false, waitBoundMs: 0 });
  assert.equal(sameNs.outcome, "acquired", sameNs.note);
  sameNs.release();
  first.release();
});
