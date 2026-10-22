// test/the-fleet-typecheck-is-incremental-per-worktree.test.ts — the fleet's full `tsc --noEmit` ran cold every time:
// 3.0–3.7 GB RSS in the core daemon container and 7 OOM kills of 4 GiB validation containers in 3 days (OBSERVED
// 2026-10-09). A check against its own buildinfo peaks at about half that and reports the same diagnostics. These
// fixtures run the REAL compiler: a seeded, incremental check must still fail on a type error, exactly as a cold one.
// FIXTURES ONLY: every repo, worktree, link and buildinfo lives under this test's tmp dirs.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { typecheckStep, type PreflightSpawn } from "../src/lib/commit-message.js";
import { mergedHeadTypechecks, mergedTypecheckArgv, type TypecheckSpawn } from "../src/lib/merge-probe.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import {
  canonicalBuildInfo,
  gitDirOf,
  prepareWorktreeTypecheck,
  publishBuildInfo,
  invalidateUnsafeCompilerCache,
  worktreeBuildInfoPath,
  rebaseBuildInfo,
  seedBuildInfo,
  TYPECHECK_BUILDINFO_NAME,
  typecheckArgs,
} from "../src/lib/typecheck-buildinfo.js";
import { openWeightIncrementalTypecheck, OPENWEIGHT_CHECKS } from "../src/lib/worker-provider.js";
import { gitRepo } from "./helpers/git-repo.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TS_VERSION = (JSON.parse(readFileSync(createRequire(import.meta.url).resolve("typescript/package.json"), "utf8")) as { version: string }).version;

const TSCONFIG = JSON.stringify({
  compilerOptions: { target: "ES2022", module: "esnext", moduleResolution: "bundler", strict: true, types: ["node"], skipLibCheck: true, noEmit: true },
  include: ["*.ts"],
});
const A_CLEAN = "export function width(n: number): number { return n * 2; }\n";
const A_BROKEN = "export function width(n: string): string { return n + n; }\n";
const B = 'import { width } from "./a";\nexport const w: number = width(3);\n';

/** A canonical checkout whose `node_modules` links the repo's install, and a linked worktree two levels deeper whose
 *  `node_modules` links the canonical one — the fleet's layout (`remudero/` beside `worktrees/<id>/`). */
function fleetLayout(): { canonical: string; wt: string; root: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}incr-typecheck-`)));
  const repo = gitRepo({ kind: "incr-typecheck-canonical" });
  const canonical = realpathSync(repo.dir);
  symlinkSync(join(REPO_ROOT, "node_modules"), join(canonical, "node_modules"));
  for (const [name, text] of [["tsconfig.json", TSCONFIG], ["a.ts", A_CLEAN], ["b.ts", B]] as const) writeFileSync(join(canonical, name), text);
  mkdirSync(join(root, "worktrees"));
  const wt = join(root, "worktrees", "lane-1");
  repo.addWorktree(wt, "lane-1");
  symlinkSync(join(canonical, "node_modules"), join(wt, "node_modules"));
  for (const [name, text] of [["tsconfig.json", TSCONFIG], ["a.ts", A_CLEAN], ["b.ts", B]] as const) writeFileSync(join(wt, name), text);
  return { canonical, wt, root };
}

/** The real compiler, through the step's own spawn shape; the argv is recorded. */
function realSpawn(seen: string[][]): PreflightSpawn {
  return (file, args, options) => {
    seen.push([...args]);
    const r = spawnSync(file, [...args], { cwd: options?.cwd, encoding: "utf8", env: { ...process.env, ...options?.env } });
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
}

const errors = (detail: string): string[] => detail.split("\n").filter((l) => /error TS\d+/.test(l)).sort();

test("the fleet typecheck is incremental: preflight's tsc argv carries --incremental and a buildinfo in the worktree's own git dir", () => {
  const fx = fleetLayout();
  const seen: string[][] = [];
  assert.equal(typecheckStep(fx.wt, realSpawn(seen), { memoryHeadroom: () => undefined }).ok, true);
  const wtGitDir = realpathSync(spawnSync("git", ["-C", fx.wt, "rev-parse", "--absolute-git-dir"], { encoding: "utf8" }).stdout.trim());
  assert.deepEqual(seen, [["-p", "tsconfig.json", "--noEmit", "--incremental", "--tsBuildInfoFile", join(wtGitDir, TYPECHECK_BUILDINFO_NAME)]]);
  assert.ok(existsSync(join(wtGitDir, TYPECHECK_BUILDINFO_NAME)), "the check wrote its buildinfo where it said it would");
  assert.notEqual(wtGitDir, realpathSync(join(fx.canonical, ".git")), "per worktree, not the shared common dir");
  const status = spawnSync("git", ["-C", fx.wt, "status", "--porcelain", "--ignored"], { encoding: "utf8" }).stdout;
  assert.doesNotMatch(status, /tsbuildinfo/, "the buildinfo is invisible to git, so it can never ride a diff");
});

test("a worktree's first typecheck is seeded from the canonical checkout's buildinfo, rebased so every recorded file resolves", () => {
  const fx = fleetLayout();
  assert.equal(typecheckStep(fx.canonical, realSpawn([])).ok, true, "the canonical checkout's own check writes the seed");
  const canonical = canonicalBuildInfo(fx.wt)!;
  assert.equal(canonical.root, fx.canonical);
  assert.ok(existsSync(canonical.buildInfo));
  const prepared = { buildInfo: worktreeBuildInfoPath(fx.wt)! };
  assert.equal(publishBuildInfo(canonical, { root: fx.wt, buildInfo: prepared.buildInfo }, TS_VERSION), "published");
  // The worktree sits deeper than the canonical checkout, so a verbatim copy's `./node_modules/...` would name nothing.
  const info = JSON.parse(readFileSync(prepared.buildInfo!, "utf8")) as { fileNames: string[] };
  const located = info.fileNames.filter((p) => p.startsWith("./") || p.startsWith("../"));
  assert.ok(located.some((p) => p.includes(`node_modules/@types/node/`)), "the seed records declaration files outside the tree");
  const dangling = located.filter((p) => !existsSync(resolve(dirname(prepared.buildInfo!), p)));
  assert.deepEqual(dangling, [], "every recorded file resolves from the worktree's buildinfo");
  assert.ok(located.some((p) => resolve(dirname(prepared.buildInfo!), p) === join(fx.wt, "b.ts")), "tree files map to the worktree's own copy");
  assert.equal(seedBuildInfo(canonical, { root: fx.wt, buildInfo: prepared.buildInfo }, "fixture-compatible"), "kept", "compatible compilers keep the worktree cache");
  assert.equal(prepareWorktreeTypecheck(fx.wt).seed, TS_VERSION === "7.0.2" ? "cold-compiler-version" : "kept");
});

test("a seeded incremental typecheck still fails on a type error a dependent file picks up, with the same diagnostics as a cold check", () => {
  const fx = fleetLayout();
  assert.equal(typecheckStep(fx.canonical, realSpawn([])).ok, true);
  writeFileSync(join(fx.wt, "a.ts"), A_BROKEN); // b.ts is unchanged; only its dependency moved
  const incremental = typecheckStep(fx.wt, realSpawn([]));
  assert.equal(incremental.ok, false, incremental.detail);
  const cold = spawnSync(join(fx.wt, "node_modules", ".bin", "tsc"), ["-p", "tsconfig.json", "--noEmit"], { cwd: fx.wt, encoding: "utf8" });
  assert.notEqual(cold.status, 0);
  assert.ok(errors(incremental.detail).some((l) => l.startsWith("b.ts(")), incremental.detail);
  assert.deepEqual(errors(incremental.detail), errors(cold.stdout + cold.stderr));
  const again = typecheckStep(fx.wt, realSpawn([]));
  assert.deepEqual(errors(again.detail), errors(cold.stdout + cold.stderr), "a warm re-run reports the cached errors, not a pass");
});

test("a seed for another TypeScript version or an unparseable seed is not written, and the check runs cold", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}incr-seed-`)));
  const from = { root: join(dir, "canon"), buildInfo: join(dir, "canon.tsbuildinfo") };
  const to = { root: join(dir, "a", "b", "wt"), buildInfo: join(dir, "wt.tsbuildinfo") };
  writeFileSync(from.buildInfo, JSON.stringify({ version: "0.0.1-fixture", fileNames: ["./canon/x.ts"] }));
  assert.equal(seedBuildInfo(from, to, "fixture-compatible"), "mismatch");
  writeFileSync(from.buildInfo, "{ not json");
  assert.equal(seedBuildInfo(from, to, "fixture-compatible"), "mismatch");
  assert.equal(existsSync(to.buildInfo), false);
  assert.equal(seedBuildInfo({ ...from, buildInfo: join(dir, "absent") }, to, "fixture-compatible"), "no-seed");
  assert.equal(seedBuildInfo(from, { ...to, buildInfo: join(dir, "no-such-dir", "wt.tsbuildinfo") }, "fixture-compatible"), "mismatch");
  writeFileSync(from.buildInfo, JSON.stringify({ version: "fixture-compatible", fileNames: [] }));
  assert.equal(seedBuildInfo(from, { ...to, buildInfo: join(dir, "no-such-dir", "wt.tsbuildinfo") }, "fixture-compatible"), "unwritable");
});

test("rebasing keeps a tree file tree-relative, an outside file at its absolute place, and a bundled lib by name", () => {
  const text = JSON.stringify({
    version: TS_VERSION,
    fileNames: ["lib.es5.d.ts", "../src/a.ts", "../node_modules/@types/node/index.d.ts", "../../shared/x.d.ts"],
    packageJsons: ["../package.json"],
    missingPackageJsons: ["../../package.json"],
    options: { outDir: "../dist", rootDir: "..", tsBuildInfoFile: "./rmd-typecheck.tsbuildinfo", strict: true, module: 199 },
  });
  const out = JSON.parse(rebaseBuildInfo(
    text,
    { root: "/r/remudero", buildInfo: "/r/remudero/.git/rmd-typecheck.tsbuildinfo" },
    { root: "/r/worktrees/lane", buildInfo: "/r/remudero/.git/worktrees/lane/rmd-typecheck.tsbuildinfo" },
    TS_VERSION,
  )!) as Record<string, unknown>;
  assert.deepEqual(out.fileNames, ["lib.es5.d.ts", "../../../../worktrees/lane/src/a.ts", "../../../node_modules/@types/node/index.d.ts", "../../../../shared/x.d.ts"]);
  assert.deepEqual(out.packageJsons, ["../../../../worktrees/lane/package.json"]);
  assert.deepEqual(out.missingPackageJsons, ["../../../../package.json"]);
  assert.deepEqual(out.options, { outDir: "../../../../worktrees/lane/dist", rootDir: "../../../../worktrees/lane", tsBuildInfoFile: "./rmd-typecheck.tsbuildinfo", strict: true, module: 199 });
});

test("a tree with no git directory runs the plain, non-incremental check", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}incr-nogit-`)));
  assert.deepEqual(prepareWorktreeTypecheck(dir), { args: typecheckArgs(undefined), seed: "no-seed" });
  assert.deepEqual(typecheckArgs(undefined), ["-p", "tsconfig.json", "--noEmit"]);
  writeFileSync(join(dir, ".git"), "not a gitdir line\n");
  assert.equal(gitDirOf(dir), undefined, "a .git file naming no gitdir");
  writeFileSync(join(dir, ".git"), "gitdir: ./gone\n");
  assert.equal(gitDirOf(dir), undefined, "a gitdir that no longer exists");
  assert.equal(canonicalBuildInfo(dir), undefined);
  mkdirSync(join(dir, "linked", "commondir"), { recursive: true }); // a commondir that cannot be read as a file
  writeFileSync(join(dir, ".git"), "gitdir: ./linked\n");
  assert.equal(canonicalBuildInfo(dir), undefined, "an unreadable commondir names no canonical checkout");
  assert.equal(prepareWorktreeTypecheck(dir).seed, "no-seed");
});

test("the open-weight typecheck keeps its buildinfo in the worker's home, never the worktree", () => {
  const fx = fleetLayout();
  assert.equal(typecheckStep(fx.canonical, realSpawn([])).ok, true);
  const home = realpathSync(mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}incr-home-`)));
  const argv = openWeightIncrementalTypecheck(OPENWEIGHT_CHECKS["typecheck"]!, fx.wt, home);
  assert.deepEqual(argv, [...OPENWEIGHT_CHECKS["typecheck"]!, "--incremental", "--tsBuildInfoFile", join(home, TYPECHECK_BUILDINFO_NAME)]);
  assert.equal(existsSync(join(home, TYPECHECK_BUILDINFO_NAME)), TS_VERSION !== "7.0.2", "the known unsafe compiler gets no canonical seed");
  assert.ok(!argv.some((a) => a.startsWith(fx.wt + sep)), "nothing the check writes lands in the worktree's diff");
});

test("the merge probe's check runs incremental against a buildinfo in its own scratch dir, and publishes the canonical seed", async () => {
  assert.deepEqual(mergedTypecheckArgv("/h/tsc", "/s/typecheck-1.tsbuildinfo", "/s/tree/w.json"), [
    "/h/tsc", "--noEmit", "--incremental", "--tsBuildInfoFile", "/s/typecheck-1.tsbuildinfo", "-p", "/s/tree/w.json",
  ]);
  const repo = gitRepo({ kind: "incr-typecheck-probe" });
  const managed = realpathSync(repo.dir);
  writeFileSync(join(managed, ".gitignore"), "node_modules\n");
  writeFileSync(join(managed, "tsconfig.json"), TSCONFIG);
  writeFileSync(join(managed, "a.ts"), A_CLEAN);
  repo.git("add", ".gitignore", "tsconfig.json", "a.ts");
  repo.git("commit", "-q", "-m", "base");
  symlinkSync(join(REPO_ROOT, "node_modules"), join(managed, "node_modules"));
  const root = realpathSync(mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}incr-probe-`)));
  const wt = join(root, "wt");
  const lane = repo.addWorktree(wt, "lane-probe", "main");
  symlinkSync(join(managed, "node_modules"), join(wt, "node_modules"));
  writeFileSync(join(wt, "b.ts"), B);
  lane.git("add", "b.ts");
  lane.git("commit", "-q", "-m", "branch adds b");
  writeFileSync(join(managed, "c.ts"), "export const c = 1;\n");
  repo.git("add", "c.ts");
  repo.git("commit", "-q", "-m", "main adds c");
  const seen: (readonly string[])[] = [];
  const recording: TypecheckSpawn = (file, args, options) => {
    seen.push(args);
    return spawn(file, [...args], options);
  };
  const result = await mergedHeadTypechecks(wt, { mainRef: "main", spawn: recording });
  assert.equal(result.outcome, "passes", JSON.stringify(result));
  assert.equal(seen.length, 1);
  const at = seen[0]!.indexOf("--tsBuildInfoFile");
  assert.ok(seen[0]!.includes("--incremental") && at > 0, seen[0]!.join(" "));
  assert.ok(!seen[0]![at + 1]!.startsWith(managed + sep) && !seen[0]![at + 1]!.startsWith(wt + sep), "the compiler writes only to scratch");
  const seed = join(managed, ".git", TYPECHECK_BUILDINFO_NAME);
  assert.ok(existsSync(seed), "the probe's check is published as the canonical seed");
  assert.equal(prepareWorktreeTypecheck(wt).seed, TS_VERSION === "7.0.2" ? "cold-compiler-version" : "seeded", "only a compatible compiler starts from the published seed");
});


test("the native typecheck cache preserves cold diagnostics after global-declaration transitions", () => {
  for (const mode of ["global-only", "dependency-and-global"] as const) {
    const repo = gitRepo({ kind: `global-cache-${mode}` });
    const root = realpathSync(repo.dir);
    const modules = join(root, "node_modules");
    mkdirSync(join(modules, ".bin"), { recursive: true });
    symlinkSync(join(REPO_ROOT, "node_modules", ".bin", "tsc"), join(modules, ".bin", "tsc"));
    symlinkSync(join(REPO_ROOT, "node_modules", "typescript"), join(modules, "typescript"));
    for (const name of ["dep-a", "dep-b"]) {
      mkdirSync(join(modules, name));
      writeFileSync(join(modules, name, "package.json"), JSON.stringify({ name, version: "1.0.0", types: "index.d.ts" }));
    }
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify({
      compilerOptions: { target: "ES2022", module: "esnext", moduleResolution: "bundler", strict: true, types: [], skipLibCheck: true, noEmit: true },
      include: ["*.ts"],
    }));
    const a = join(modules, "dep-a", "index.d.ts");
    const b = join(modules, "dep-b", "index.d.ts");
    writeFileSync(a, 'export type Kind = "a" | "b";');
    writeFileSync(b, 'declare global { interface DepBGlobal { marker: string; } } export {};');
    writeFileSync(join(root, "middle.ts"), 'export type { Kind } from "dep-a";');
    writeFileSync(join(root, "consumer.ts"), 'import type { Kind } from "./middle"; export function describe(kind: Kind): string { switch (kind) { case "a": return "first"; case "b": return "second"; } }');
    writeFileSync(join(root, "env.ts"), 'import "dep-b";');
    writeFileSync(join(root, "global-consumer.ts"), 'const globalObject: DepBGlobal = { marker: "ok" }; export {globalObject};');
    assert.equal(typecheckStep(root, realSpawn([])).ok, true, mode);
    assert.ok(existsSync(worktreeBuildInfoPath(root)!));
    if (mode === "dependency-and-global") writeFileSync(a, 'export type Kind = "a" | "b" | "c";');
    writeFileSync(b, 'declare global { interface DepBGlobal { marker: string; extra: number; } } export {};');
    const warm = spawnSync(join(modules, ".bin", "tsc"), ["-p", "tsconfig.json", "--noEmit", "--checkers", "1", "--incremental", "--tsBuildInfoFile", worktreeBuildInfoPath(root)!], {
      cwd: root, encoding: "utf8", env: { ...process.env, GOMAXPROCS: "2", GOMEMLIMIT: "512MiB" },
    });
    if (TS_VERSION === "7.0.2" && mode === "global-only") {
      assert.equal(warm.status, 0, `${mode}: positive witness must reach the reproduced unsafe cache`);
      assert.deepEqual(errors(warm.stdout + warm.stderr), [], mode);
    }
    const guarded = typecheckStep(root, realSpawn([]));
    const cold = spawnSync(join(modules, ".bin", "tsc"), ["-p", "tsconfig.json", "--noEmit", "--checkers", "1"], {
      cwd: root, encoding: "utf8", env: { ...process.env, GOMAXPROCS: "2", GOMEMLIMIT: "512MiB" },
    });
    assert.notEqual(cold.status, 0, `cold positive control must see ${mode}`);
    assert.ok(errors(cold.stdout + cold.stderr).length > 0);
    assert.equal(guarded.ok, false, `${mode}: ${guarded.detail}`);
    assert.deepEqual(errors(guarded.detail), errors(cold.stdout + cold.stderr), mode);
    assert.deepEqual(errors(typecheckStep(root, realSpawn([])).detail), errors(cold.stdout + cold.stderr), `${mode}: own existing cache`);
  }
});

test("unsafe compiler cache invalidation preserves seeds and compatible targets and refuses an undeletable target", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}unsafe-cache-`)));
  const from = { root: dir, buildInfo: join(dir, "source.tsbuildinfo") };
  const to = { root: dir, buildInfo: join(dir, "target.tsbuildinfo") };
  writeFileSync(from.buildInfo, "source seed stays intact");
  writeFileSync(to.buildInfo, "old target");
  assert.equal(invalidateUnsafeCompilerCache(to.buildInfo, "fixture-compatible"), false);
  assert.equal(invalidateUnsafeCompilerCache(to.buildInfo, undefined), false);
  assert.equal(readFileSync(to.buildInfo, "utf8"), "old target");
  assert.equal(seedBuildInfo(from, to, "7.0.2"), "cold-compiler-version");
  assert.equal(existsSync(to.buildInfo), false);
  assert.equal(readFileSync(from.buildInfo, "utf8"), "source seed stays intact");
  mkdirSync(to.buildInfo);
  assert.throws(() => invalidateUnsafeCompilerCache(to.buildInfo, "7.0.2"), /EISDIR|ERR_FS_EISDIR|ENOTEMPTY/);
});
