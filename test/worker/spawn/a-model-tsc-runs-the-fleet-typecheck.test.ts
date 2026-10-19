import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";

import { worktreeAdd, worktreeAddAsync } from "#src/lib/worker.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const ENTRY = join(REPO_ROOT, "scripts", "tsc-entry.mjs");
const COMPILER = join(REPO_ROOT, "node_modules", "typescript", "bin", "tsc");

function project(t: TestContext) {
  const repo = gitRepo({ kind: "raw-tsc-project" });
  t.after(() => repo.cleanup());
  const modules = join(repo.dir, "dependency-fixture");
  mkdirSync(join(modules, ".bin"), { recursive: true });
  symlinkSync(modules, join(repo.dir, "node_modules"));
  symlinkSync(join(REPO_ROOT, "node_modules", "typescript"), join(modules, "typescript"));
  symlinkSync(ENTRY, join(modules, ".bin", "tsc"));
  writeFileSync(join(repo.dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { types: [], strict: true, noEmit: true }, files: ["input.ts"] }));
  writeFileSync(join(repo.dir, "input.ts"), "export const value: number = 1;\n");
  writeFileSync(join(repo.dir, ".gitignore"), "node_modules\n*.tsbuildinfo\n");
  repo.git("add", "tsconfig.json", "input.ts", ".gitignore");
  repo.git("commit", "-qm", "fixture project");
  const run = (args: string[], reentrant = false, cwd = repo.dir) => {
    const env = { ...process.env, RMD_TSC_ENTRY: reentrant ? "1" : "" };
    return spawnSync(process.execPath, [ENTRY, ...args], { cwd, env, encoding: "utf8", timeout: 30_000 });
  };
  return { ...repo, run, info: join(repo.dir, ".git", "rmd-typecheck.tsbuildinfo") };
}

test("W1-T9405: a raw whole-project no-emit call uses the real incremental wrapper and compiler", (t) => {
  const p = project(t);
  const result = p.run(["--noEmit", "-p", ".", "--pretty", "false"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /"step":"typecheck.raw_routed"/);
  assert.match(result.stderr, /"step":"typecheck.cold"/);
  assert.ok(existsSync(p.info), "the actual compiler wrote the per-worktree incremental buildinfo");
  const info = JSON.parse(readFileSync(p.info, "utf8"));
  assert.ok(Array.isArray(info.fileNames) && info.fileNames.some((name: string) => name.endsWith("input.ts")));
});

test("W1-T9405: default delegation preserves the real compiler diagnostics and exit status", (t) => {
  const p = project(t);
  writeFileSync(join(p.dir, "input.ts"), 'export const value: number = "bad";\n');
  const args = ["--noEmit", "-p", ".", "--pretty", "false"];
  const plain = spawnSync(process.execPath, [COMPILER, ...args], { cwd: p.dir, encoding: "utf8" });
  assert.notEqual(plain.status, 0, "positive control: the real compiler rejects this fixture");
  const delegated = p.run(args);
  assert.equal(delegated.status, plain.status, delegated.stderr);
  assert.equal(delegated.stdout, plain.stdout);
  assert.match(delegated.stdout, /TS2322/);
});

test("W1-T9405: compiler-owned option values route without a project flag while source filenames do not", (t) => {
  const p = project(t);
  const through = p.run(["--noEmit", "--lib", "es2022", "--pretty", "false"]);
  assert.equal(through.status, 0, through.stdout + through.stderr);
  assert.match(through.stderr, /typecheck.raw_routed/);
  assert.ok(existsSync(p.info));
  unlinkSync(p.info);
  for (const args of [["--noEmit", "input.ts"], ["--noEmit", "-p", ".", "input.ts"], ["--noEmit", "--unknown-fixture-option"]]) {
    const plain = spawnSync(process.execPath, [COMPILER, ...args], { cwd: p.dir, encoding: "utf8" });
    const raw = p.run(args);
    assert.equal(raw.status, plain.status, raw.stderr);
    assert.equal(raw.stdout, plain.stdout);
    assert.doesNotMatch(raw.stderr, /typecheck.raw_routed/);
    assert.equal(existsSync(p.info), false);
  }
});

test("W1-T9405: a child environment reentry passes raw argv straight to the real compiler", (t) => {
  const p = project(t);
  const result = p.run(["--noEmit", "--project", "tsconfig.json", "--pretty", "false"], true);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.doesNotMatch(result.stderr, /typecheck.raw_routed|typecheck.cold/);
  assert.equal(existsSync(p.info), false, "the environment guard alone prevents delegation, even without an incremental argv guard");
});

test("W1-T9405: argv ownership and non-root invocations stay with the real compiler", async (t) => {
  assert.ok(existsSync(ENTRY), "the real entry module exists");
  // @ts-ignore executable builtins-only module, like the existing scripts/typecheck.mjs.
  const { wholeProjectNoEmitArgs } = await import("#scripts/tsc-entry.mjs");
  assert.deepEqual(wholeProjectNoEmitArgs(["--noEmit", "--pretty", "false"]), ["--pretty", "false"]);
  assert.deepEqual(wholeProjectNoEmitArgs(["-p", ".", "--noEmit", "--types", "node"]), ["--types", "node"]);
  for (const args of [
    ["--version"], ["--noEmit", "input.ts"], ["--noEmit", "-p", "other.json"],
    ["--noEmit", "--incremental"], ["--noEmit", "--tsBuildInfoFile", "own.info"],
    ["--noEmit", "--build"], ["--noEmit", "-b"], ["--noEmit", "--watch"], ["--noEmit", "-w"],
    ["--noEmit", "--listFiles"], ["--noEmit", "--listFilesOnly"], ["--noEmit", "false"],
    ["--noEmit", "--noEmit"], ["--noEmit", "--project=."], ["--noEmit", "--showConfig"],
    ["--noEmit", "--generateCpuProfile", "profile.cpuprofile"], ["--noEmit", "--generateTrace", "trace"],
  ]) assert.equal(wholeProjectNoEmitArgs(args), undefined, JSON.stringify(args));
  const p = project(t);
  const child = join(p.dir, "subdir"); mkdirSync(child);
  const direct = spawnSync(process.execPath, [COMPILER, "--noEmit", "-p", "..", "--pretty", "false"], { cwd: child, encoding: "utf8" });
  const through = p.run(["--noEmit", "-p", "..", "--pretty", "false"], false, child);
  assert.equal(through.status, direct.status, through.stderr);
  assert.equal(through.stdout, direct.stdout);
  assert.doesNotMatch(through.stderr, /typecheck.raw_routed/);
  assert.equal(existsSync(p.info), false);
});

test("W1-T9405: unreadable git metadata keeps compiler ownership and a real spawn failure is explicit", async (t) => {
  const p = project(t);
  renameSync(join(p.dir, ".git"), join(p.dir, ".git-kept"));
  writeFileSync(join(p.dir, ".git"), "invalid gitdir fixture\n");
  const result = p.run(["--noEmit", "-p", ".", "--pretty", "false"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.doesNotMatch(result.stderr, /typecheck.raw_routed/);
  // @ts-ignore executable builtins-only module.
  const { runTscEntry } = await import("#scripts/tsc-entry.mjs");
  assert.equal(runTscEntry(["--version"], join(p.dir, "absent")), 127, "the default native spawn really fails ENOENT");
  assert.equal(runTscEntry(["--version"], p.dir, () => ({ status: null, signal: "SIGTERM" })), 143);
  assert.equal(runTscEntry(["--version"], p.dir, () => ({ status: null })), 1);
});

function managed(t: TestContext, managedLayout = true) {
  const root = gitRepo({ kind: "raw-tsc-install" });
  t.after(() => root.cleanup());
  const repo = join(root.dir, managedLayout ? "repos/remudero" : "operator");
  mkdirSync(dirname(repo), { recursive: true });
  root.git("clone", "-q", root.dir, repo);
  const modules = join(root.dir, "install", "dependency-fixture");
  mkdirSync(join(modules, ".bin"), { recursive: true });
  mkdirSync(join(modules, "typescript", "bin"), { recursive: true });
  const original = join(modules, "typescript", "bin", "tsc");
  writeFileSync(original, "original compiler\n");
  const bin = join(modules, ".bin", "tsc"); symlinkSync("../typescript/bin/tsc", bin);
  const entry = join(root.dir, "install", "scripts", "tsc-entry.mjs");
  mkdirSync(dirname(entry), { recursive: true }); writeFileSync(entry, "fixture entry\n");
  symlinkSync(modules, join(root.dir, "install", "node_modules"));
  symlinkSync(modules, join(repo, "node_modules"));
  execFileSync("git", ["-C", repo, "fetch", "-q", "origin", "main"]);
  const rows: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const cut = (name: string, async = false, fixtureInstall = true, typecheckRename?: (from: string, to: string) => void) => {
    const path = join(root.dir, managedLayout ? "worktrees" : "lanes", name);
    mkdirSync(dirname(path), { recursive: true });
    const opts = { ...(fixtureInstall ? { typecheckInstallRoot: join(root.dir, "install") } : {}), typecheckRename,
      log: (step: string, extra?: Record<string, unknown>) => { rows.push({ step, extra }); } };
    return async ? worktreeAddAsync(repo, path, name, "origin/main", opts) : worktreeAdd(repo, path, name, "origin/main", opts);
  };
  return { root, repo, modules, original, bin, entry, cut, rows };
}

test("W1-T9405: both real worktree-add paths install an idempotent tsc entry and rehook an npm reset", async (t) => {
  const f = managed(t);
  f.cut("first");
  assert.equal(realpathSync(f.bin), realpathSync(f.entry), "sync worktree add reaches the hook");
  const inode = lstatSync(f.bin).ino;
  await f.cut("second", true);
  assert.equal(lstatSync(f.bin).ino, inode, "async worktree add does not rewrite an already routed entry");
  unlinkSync(f.bin); symlinkSync("../typescript/bin/tsc", f.bin);
  await f.cut("third", true);
  assert.equal(realpathSync(f.bin), realpathSync(f.entry), "a restored npm link is rehooked at the next cut");
  assert.equal(readFileSync(f.original, "utf8"), "original compiler\n");
});

test("W1-T9405: an operator checkout and an unexpected tsc wrapper are never overwritten", (t) => {
  const operator = managed(t, false); operator.cut("operator-lane");
  assert.equal(realpathSync(operator.bin), operator.original);
  const custom = managed(t);
  const other = join(custom.modules, "custom-tsc"); writeFileSync(other, "custom\n");
  unlinkSync(custom.bin); symlinkSync(other, custom.bin);
  custom.cut("custom-lane");
  assert.equal(realpathSync(custom.bin), other);
  const foreign = managed(t); foreign.cut("foreign-lane", false, false);
  assert.equal(realpathSync(foreign.bin), foreign.original, "the real default harness identity refuses a foreign install even inside a managed layout");
  assert.ok(foreign.rows.some(r => r.extra?.reason === "not-harness-install"));
});

test("W1-T9405: an install without the entry stays unchanged and a real filesystem failure is named", (t) => {
  const absent = managed(t); unlinkSync(absent.entry); absent.cut("missing-entry");
  assert.equal(realpathSync(absent.bin), absent.original);
  const broken = managed(t); unlinkSync(broken.bin); unlinkSync(broken.entry);
  writeFileSync(broken.entry, "fixture entry\n");
  // A real ENOTDIR, without permissions fakes or changing a shared dependency payload.
  const dir = dirname(broken.bin); rmdirSync(dir); writeFileSync(dir, "not a directory\n");
  broken.cut("filesystem-failure");
  assert.ok(broken.rows.some(r => r.step === "worktree.typecheck_entry_failed"), "the real filesystem failure is visible without refusing worktree creation");
});

test("W1-T9405: a failed atomic repoint cleans its temporary link and names an unreadable cleanup", (t) => {
  const failed = managed(t);
  let temporary: string | undefined;
  failed.cut("rename-failure", false, true, (from) => { temporary = from; throw new Error("fixture rename failure"); });
  assert.ok(temporary);
  assert.equal(existsSync(temporary), false, "the real default unlink cleans the failed rename's temporary link");
  assert.equal(realpathSync(failed.bin), failed.original);
  assert.ok(failed.rows.some(r => r.step === "worktree.typecheck_entry_failed" && String(r.extra?.error).includes("fixture rename failure")));
  const missing = managed(t);
  missing.cut("cleanup-failure", false, true, (from) => { unlinkSync(from); throw new Error("fixture rename lost its source"); });
  assert.equal(realpathSync(missing.bin), missing.original);
  assert.ok(missing.rows.some(r => r.extra?.cleanup === true && String(r.extra?.error).includes("ENOENT")), "the real unlink failure is named, not reported as successful installation");
});
