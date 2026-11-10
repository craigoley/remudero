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
import { REPO_ROOT } from "#test/helpers/repo-root.js";

test("W1-T11795 criterion 1: a bundled hostWorktreeGit call is charged to its real caller", () => {
  const dir = makeTempDir("bundled-worktree-git-caller");
  try {
    const repo = join(dir, "repo");
    mkdirSync(repo);
    execFileSync("git", ["init", "-q", repo]);
    const outfile = join(dir, "run-task.mjs");
    buildSync({
      stdin: { contents: `
import { startReadPlaneTelemetry } from "#src/lib/read-plane.js";
import { hostWorktreeGit } from "#src/lib/worktree-git.js";
import { clockFromMillisFn } from "#src/lib/clock.js";
const dir = ${JSON.stringify(repo)};
function actualCaller() { return hostWorktreeGit(dir, ["rev-parse", "--git-dir"]); }
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
    const result = JSON.parse(execFileSync(process.execPath, [outfile], {
      cwd: REPO_ROOT, env, encoding: "utf8",
    })) as { sample: {
      sync_spawn_by_caller: { caller: string; leaf?: string; calls: number }[];
      sync_spawn_top: { caller: string; leaf?: string }[];
    } };
    const pattern = /^at actualCaller \(.*[/\\]run-task\.mjs:\d+:\d+\)$/;
    const rows = result.sample.sync_spawn_by_caller.filter(row => pattern.test(row.caller));
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.leaf, "hostWorktreeGit");
    assert.equal(rows[0]!.calls, 2);
    for (const row of result.sample.sync_spawn_by_caller) {
      assert.doesNotMatch(row.caller, /^at (hostWorktreeGit|vetPinnedConfig)\b/);
    }
    for (const row of result.sample.sync_spawn_top.filter(r => pattern.test(r.caller))) {
      assert.equal(row.leaf, "hostWorktreeGit");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function callerBehindTheGitLeaf(worktree: string): void { hostWorktreeGit(worktree, ["status"]); }

test("W1-T11795 criterion 2: an unbundled hostWorktreeGit spawn keeps the calling function as caller", () => {
  const repo = makeTempDir("unbundled-worktree-git-caller");
  const original = childProcess.execFileSync;
  let clock = 0;
  try {
    mkdirSync(join(repo, ".git"));
    Object.assign(childProcess, { execFileSync: () => { clock += 3000; return ""; } });
    syncBuiltinESMExports();
    const telemetry = startReadPlaneTelemetry({ clock: clockFromMillisFn(() => clock) });
    try {
      callerBehindTheGitLeaf(repo);
      const top = telemetry.sample.takeLagInterval("t").top;
      assert.equal(top?.leaf, "hostWorktreeGit");
      assert.match(String(top?.caller), /callerBehindTheGitLeaf/);
      assert.equal(top?.caller_is_leaf, undefined);
    } finally {
      telemetry.stop();
    }
  } finally {
    Object.assign(childProcess, { execFileSync: original });
    syncBuiltinESMExports();
    rmSync(repo, { recursive: true, force: true });
  }
});
