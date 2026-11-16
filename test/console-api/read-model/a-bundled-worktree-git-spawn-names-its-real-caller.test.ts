import assert from "node:assert/strict";
import childProcess, { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import test from "node:test";
import { buildSync } from "esbuild";
import { clockFromMillisFn } from "#src/lib/clock.js";
import { startReadPlaneTelemetry } from "#src/lib/read-plane.js";
import { makeTempDir } from "#src/lib/tmp.js";
import { hostWorktreeGit } from "#src/lib/worktree-git.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

type Row = { caller: string; leaf?: string; calls?: number };
type Sample = { sync_spawn_by_caller: Row[]; sync_spawn_top: Row[] };

const ACTUAL_CALLER = /^at actualCaller \(.*[/\\]run-task\.mjs:\d+:\d+\)$/;

// One single-file bundle, like the daemon's run-task.mjs: every frame has the same file, so only a leaf's
// function name can say it forwards the spawn. The repository is made before the meter starts.
let bundled: Sample | undefined;
function bundledSample(): Sample {
  if (bundled) return bundled;
  const dir = makeTempDir("bundled-worktree-git-caller");
  const repo = gitRepo({ seedCommit: false, kind: "bundled-worktree-git" }).dir;
  try {
    const outfile = join(dir, "run-task.mjs");
    buildSync({
      stdin: { contents: `
import { startReadPlaneTelemetry } from "#src/lib/read-plane.js";
import { hostWorktreeGit } from "#src/lib/worktree-git.js";
import { clockFromMillisFn } from "#src/lib/clock.js";
function actualCaller() { return hostWorktreeGit(${JSON.stringify(repo)}, ["rev-parse", "--git-dir"]); }
let now = 0;
const telemetry = startReadPlaneTelemetry({ clock: clockFromMillisFn(() => now += 3000) });
try {
  actualCaller();
  console.log(JSON.stringify({ sample: telemetry.sample() }));
} finally { telemetry.stop(); }
`, resolveDir: REPO_ROOT, sourcefile: "bundled-worktree-git-fixture.ts" },
      outfile, bundle: true, platform: "node", format: "esm", keepNames: true,
      packages: "external", logLevel: "silent",
    });
    const env = { ...process.env, NODE_V8_COVERAGE: undefined };
    bundled = (JSON.parse(execFileSync(process.execPath, [outfile], {
      cwd: REPO_ROOT, env, encoding: "utf8",
    })) as { sample: Sample }).sample;
    return bundled;
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
}

test("W1-T11795 criterion 1: a bundled hostWorktreeGit call charges both of its spawns to its real caller", () => {
  const sample = bundledSample();
  const rows = sample.sync_spawn_by_caller.filter((row) => ACTUAL_CALLER.test(row.caller));
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.leaf, "hostWorktreeGit");
  assert.equal(rows[0]!.calls, 2);
  for (const row of [...sample.sync_spawn_by_caller, ...sample.sync_spawn_top]) {
    assert.doesNotMatch(row.caller, /^at (?:\S+\.)?(?:hostWorktreeGit|vetPinnedConfig) /);
  }
  const top = sample.sync_spawn_top.filter((row) => ACTUAL_CALLER.test(row.caller));
  assert.equal(top.length, 2);
  for (const row of top) assert.equal(row.leaf, "hostWorktreeGit");
});

test("W1-T11795 criterion 2: the bundled vetPinnedConfig config read is charged to the real caller", () => {
  const sample = bundledSample();
  for (const row of [...sample.sync_spawn_by_caller, ...sample.sync_spawn_top]) {
    assert.doesNotMatch(row.caller, /vetPinnedConfig/);
    assert.notEqual(row.leaf, "vetPinnedConfig");
  }
  assert.equal(sample.sync_spawn_by_caller.length, 1);
  assert.match(sample.sync_spawn_by_caller[0]!.caller, ACTUAL_CALLER);
});

function actualSourceCaller(repo: string): void { hostWorktreeGit(repo, ["status"]); }

// The unbundled path matcher keeps working as before. This passes on main by design, so it carries no marker.
test("an unbundled hostWorktreeGit spawn keeps the calling function as caller and hostWorktreeGit as leaf", () => {
  const repo = makeTempDir("source-worktree-git-caller");
  const original = childProcess.execFileSync;
  let clock = 0;
  try {
    mkdirSync(join(repo, ".git"));
    Object.assign(childProcess, { execFileSync: () => { clock += 3000; return ""; } });
    syncBuiltinESMExports();
    const telemetry = startReadPlaneTelemetry({ clock: clockFromMillisFn(() => clock) });
    try {
      actualSourceCaller(repo);
      const rows = telemetry.sample().sync_spawn_by_caller;
      assert.equal(rows.length, 1);
      assert.match(String(rows[0]!.caller), /actualSourceCaller/);
      assert.equal(rows[0]!.leaf, "hostWorktreeGit");
      assert.equal(rows[0]!.calls, 2);
    } finally { telemetry.stop(); }
  } finally {
    Object.assign(childProcess, { execFileSync: original });
    syncBuiltinESMExports();
    rmSync(repo, { recursive: true, force: true });
  }
});
