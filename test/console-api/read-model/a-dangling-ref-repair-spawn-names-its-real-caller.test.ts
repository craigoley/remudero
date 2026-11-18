import assert from "node:assert/strict";
import childProcess, { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildSync } from "esbuild";
import { clockFromMillisFn } from "#src/lib/clock.js";
import { setDanglingRefRepairLog } from "#src/lib/git-fetch-retry.js";
import { startReadPlaneTelemetry, SYNC_SPAWN_LEAF_FRAME_NAMES, SYNC_SPAWN_LEAF_FRAMES } from "#src/lib/read-plane.js";
import { makeTempDir } from "#src/lib/tmp.js";
import { hostWorktreeGit } from "#src/lib/worktree-git.js";
import { GIT_REPO_FIXTURE_IDENTITY, originWithClone } from "#test/helpers/git-repo.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

/**
 * W1-T13548 — A DANGLING-REF REPAIR SPAWN NAMES ITS REAL CALLER. W1-T13409 made the sync git leaf repair a ref that
 * names a missing object and fetch once more, from hostWorktreeGit's catch. The repair runner was an unnamed arrow and
 * retryAfterDanglingRefRepair was no known leaf, so the meter charged 6 of a repaired fetch's 8 spawns to them.
 *
 * FIXTURES ONLY: an origin and a clone in throwaway directories, broken the way the heartbeat broke the shared clone.
 */

type Row = { caller: string; leaf?: string; calls?: number };
type Sample = { sync_spawn_by_caller: Row[]; sync_spawn_top: Row[] };

const ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: GIT_REPO_FIXTURE_IDENTITY.name,
  GIT_AUTHOR_EMAIL: GIT_REPO_FIXTURE_IDENTITY.email,
  GIT_COMMITTER_NAME: GIT_REPO_FIXTURE_IDENTITY.name,
  GIT_COMMITTER_EMAIL: GIT_REPO_FIXTURE_IDENTITY.email,
};
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const MAIN = ["fetch", "origin", "main"];
const ACTUAL_CALLER = /^at actualCaller \(.*[/\\]run-task\.mjs:\d+:\d+\)$/;
const PLUMBING = /<anonymous>|retryAfterDanglingRefRepair|gitSync|runHostWorktreeGit/;

setDanglingRefRepairLog(() => {});

function git(dir: string, args: string[], env: NodeJS.ProcessEnv = ENV): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** W1-T13409's fixture: a commit pushed through origin from a private object directory, which is then deleted, so
 *  the clone's refs/remotes/origin/beat names an object the clone lacks and a plain fetch fails. */
function danglingRefFixture(): { root: string; clone: string } {
  const root = mkdtempSync(join(tmpdir(), "rmd-dangling-caller-"));
  const { clone } = originWithClone(join(root, "clone"));
  const priv = mkdtempSync(join(tmpdir(), "rmd-dangling-caller-objects-"));
  const env = { ...ENV, GIT_OBJECT_DIRECTORY: priv, GIT_ALTERNATE_OBJECT_DIRECTORIES: join(clone.dir, ".git", "objects") };
  const id = git(clone.dir, ["commit-tree", EMPTY_TREE, "-m", "beat"], env);
  git(clone.dir, ["push", "--quiet", "origin", `${id}:refs/heads/beat`], env);
  rmSync(priv, { recursive: true, force: true });
  assert.throws(() => git(clone.dir, MAIN), /bad object refs\/remotes\/origin\/beat/, "the fixture breaks a plain fetch");
  return { root, clone: clone.dir };
}

/** The repair worked: every ref names an object the clone has, and a plain fetch succeeds again. */
function assertRepaired(clone: string): void {
  for (const line of git(clone, ["for-each-ref", "--format=%(objectname)"]).split("\n")) git(clone, ["cat-file", "-e", line]);
  git(clone, MAIN);
}

function assertNoPlumbingCaller(sample: Sample): void {
  for (const row of [...sample.sync_spawn_by_caller, ...sample.sync_spawn_top]) {
    assert.doesNotMatch(row.caller, PLUMBING, JSON.stringify(row));
  }
}

test("W1-T13548 criterion 1: a bundled repaired fetch charges every spawn to the function that called hostWorktreeGit", () => {
  const dir = makeTempDir("bundled-dangling-ref-caller");
  const { root, clone } = danglingRefFixture();
  try {
    const outfile = join(dir, "run-task.mjs");
    buildSync({
      stdin: { contents: `
import { setDanglingRefRepairLog } from "#src/lib/git-fetch-retry.js";
import { startReadPlaneTelemetry } from "#src/lib/read-plane.js";
import { hostWorktreeGit } from "#src/lib/worktree-git.js";
import { clockFromMillisFn } from "#src/lib/clock.js";
setDanglingRefRepairLog(() => {});
function actualCaller() { return hostWorktreeGit(${JSON.stringify(clone)}, ${JSON.stringify(MAIN)}); }
let now = 0;
const telemetry = startReadPlaneTelemetry({ clock: clockFromMillisFn(() => now += 3000) });
try {
  actualCaller();
  console.log(JSON.stringify({ sample: telemetry.sample() }));
} finally { telemetry.stop(); }
`, resolveDir: REPO_ROOT, sourcefile: "bundled-dangling-ref-fixture.ts" },
      outfile, bundle: true, platform: "node", format: "esm", keepNames: true,
      packages: "external", logLevel: "silent",
    });
    const env = { ...process.env, NODE_V8_COVERAGE: undefined };
    const sample = (JSON.parse(execFileSync(process.execPath, [outfile], { cwd: REPO_ROOT, env, encoding: "utf8" })) as { sample: Sample }).sample;
    assertRepaired(clone);
    assert.equal(sample.sync_spawn_by_caller.length, 1, JSON.stringify(sample.sync_spawn_by_caller));
    assert.match(sample.sync_spawn_by_caller[0]!.caller, ACTUAL_CALLER);
    assert.equal(sample.sync_spawn_by_caller[0]!.leaf, "hostWorktreeGit");
    assert.ok(sample.sync_spawn_by_caller[0]!.calls! > 2, "the repair's spawns are in the row");
    assertNoPlumbingCaller(sample);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

function actualSourceCaller(clone: string): string { return hostWorktreeGit(clone, MAIN); }

test("W1-T13548 criterion 2: a repaired fetch from source charges every spawn to the function that called hostWorktreeGit", () => {
  const { root, clone } = danglingRefFixture();
  try {
    let now = 0;
    const telemetry = startReadPlaneTelemetry({ clock: clockFromMillisFn(() => now += 3000) });
    let sample: Sample;
    try {
      actualSourceCaller(clone);
      sample = telemetry.sample() as unknown as Sample;
    } finally { telemetry.stop(); }
    assertRepaired(clone);
    assert.equal(sample.sync_spawn_by_caller.length, 1, JSON.stringify(sample.sync_spawn_by_caller));
    assert.match(sample.sync_spawn_by_caller[0]!.caller, /^at actualSourceCaller /);
    assert.equal(sample.sync_spawn_by_caller[0]!.leaf, "hostWorktreeGit");
    assert.ok(sample.sync_spawn_by_caller[0]!.calls! > 2, "the repair's spawns are in the row");
    for (const row of [...sample.sync_spawn_by_caller, ...sample.sync_spawn_top]) {
      for (const field of [row.caller, row.leaf ?? ""]) assert.doesNotMatch(field, /retryAfterDanglingRefRepair|git-fetch-retry|<anonymous>/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** The function names on the stack of each git spawn, innermost first. */
function spawnStacks(run: () => void): string[][] {
  const stacks: string[][] = [];
  const original = childProcess.execFileSync;
  Object.assign(childProcess, { execFileSync: (...args: Parameters<typeof execFileSync>) => {
    const prepare = Error.prepareStackTrace;
    Error.prepareStackTrace = (_error, sites) => sites;
    const holder: { stack?: unknown } = {};
    Error.captureStackTrace(holder);
    const sites = holder.stack as NodeJS.CallSite[];
    Error.prepareStackTrace = prepare;
    stacks.push(sites.map(site => site.getFunctionName() ?? ""));
    return original(...args);
  } });
  syncBuiltinESMExports();
  try {
    run();
  } finally {
    Object.assign(childProcess, { execFileSync: original });
    syncBuiltinESMExports();
  }
  return stacks;
}

test("W1-T13548 criterion 3: the meter skips the repair frames by their own names, and no path pattern names git-fetch-retry", () => {
  const { root, clone } = danglingRefFixture();
  try {
    const stacks = spawnStacks(() => actualSourceCaller(clone));
    assertRepaired(clone);
    // The frame just inside retryAfterDanglingRefRepair is the function it was handed: the repair runner, or the retry.
    const handed = new Set(stacks.map(names => names.indexOf("retryAfterDanglingRefRepair"))
      .flatMap((at, i) => at > 0 ? [stacks[i]![at - 1]!] : []));
    assert.ok(handed.has("runHostWorktreeGit"), `the retry ran: ${[...handed].join(", ")}`);
    const runners = [...handed].filter(name => name !== "runHostWorktreeGit");
    assert.equal(runners.length, 1, `one repair runner: ${JSON.stringify(runners)}`);
    const runner = runners[0]!;
    assert.notEqual(runner, "", "the repair runner has a name");
    assert.ok(SYNC_SPAWN_LEAF_FRAME_NAMES.has(runner), `${runner} is a named leaf`);
    assert.ok(SYNC_SPAWN_LEAF_FRAME_NAMES.has("retryAfterDanglingRefRepair"));
    for (const ext of ["ts", "js", "mjs", "cjs"]) {
      const line = `    at retryAfterDanglingRefRepair (${REPO_ROOT}/src/lib/git-fetch-retry.${ext}:1:1)`;
      const other = `    at fetchOriginRetryingRefLock (${REPO_ROOT}/dist/git-fetch-retry.${ext}:1:1)`;
      for (const leaf of SYNC_SPAWN_LEAF_FRAMES) {
        assert.doesNotMatch(line, leaf);
        assert.doesNotMatch(other, leaf);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
