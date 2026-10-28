import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { clockFromMillisFn } from "#src/lib/clock.js";
import { reportLoopLag } from "#src/lib/daemon.js";
import { ghExecFile } from "#src/lib/github-transport.js";
import { startReadPlaneTelemetry } from "#src/lib/read-plane.js";
import { hostWorktreeGit } from "#src/lib/worktree-git.js";

// W1-T7745: a slow execFileSync UNDER the telemetry wrapper; each call advances a fake clock by `pending`.
function withSlowSpawn(run: (telemetry: ReturnType<typeof startReadPlaneTelemetry>, setMs: (ms: number) => void) => void): void {
  const original = childProcess.execFileSync;
  let clock = 0;
  let pending = 0;
  Object.assign(childProcess, { execFileSync: () => { clock += pending; return ""; } });
  syncBuiltinESMExports();
  const telemetry = startReadPlaneTelemetry({ clock: clockFromMillisFn(() => clock) });
  try {
    run(telemetry, (ms) => { pending = ms; });
  } finally {
    telemetry.stop();
    Object.assign(childProcess, { execFileSync: original });
    syncBuiltinESMExports();
  }
}

function callerBehindTheGitLeaf(worktree: string): void { hostWorktreeGit(worktree, ["status"]); }
function callerBehindGhExecFile(): void { ghExecFile("gh", ["pr", "list"], { encoding: "utf8" }); }
function plainSpawnCaller(): void { childProcess.execFileSync("git", ["fetch"]); }

test("W1-T7745: a spawn through hostWorktreeGit records the calling function as caller and the leaf as leaf", () => {
  const repo = mkdtempSync(join(tmpdir(), "rmd-t7745-"));
  try {
    mkdirSync(join(repo, ".git")); // a bare .git directory is all the pin reads; the spawn itself is faked
    withSlowSpawn((telemetry, setMs) => {
      setMs(3000);
      callerBehindTheGitLeaf(repo);
      const top = telemetry.sample.takeLagInterval("t").top;
      assert.equal(top?.leaf, "hostWorktreeGit");
      assert.match(String(top?.caller), /callerBehindTheGitLeaf/);
      assert.doesNotMatch(String(top?.caller), /worktree-git/);
      assert.equal(top?.caller_is_leaf, undefined);
    });
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("W1-T7745: a spawn through ghExecFile records the calling function as caller", () => {
  withSlowSpawn((telemetry, setMs) => {
    telemetry.sample.takeLagInterval("t");
    setMs(3000);
    callerBehindGhExecFile();
    const top = telemetry.sample.takeLagInterval("t").top;
    assert.match(String(top?.caller), /callerBehindGhExecFile/);
    assert.equal(top?.leaf, "ghExecFile");
    const direct = telemetry.sample();
    assert.ok(direct.sync_spawn_top.every((e) => !/github-transport/.test(String(e.caller))));
  });
});

test("W1-T7745: a spawn with no frame outside the leaves says the caller is the leaf, and a plain spawn has no leaf", () => {
  withSlowSpawn((telemetry, setMs) => {
    setMs(3000);
    plainSpawnCaller();
    const plain = telemetry.sample().sync_spawn_top[0];
    assert.match(String(plain?.caller), /plainSpawnCaller/);
    assert.equal(plain?.leaf, undefined);
    assert.equal(plain?.caller_is_leaf, undefined);
  });
});

test("W1-T7745: a later lag interval with no spawn names none before the alive sample", () => {
  withSlowSpawn((telemetry, setMs) => {
    telemetry.sample.takeLagInterval("t");
    setMs(3000);
    plainSpawnCaller();
    assert.equal(telemetry.sample.takeLagInterval("t").top?.command, "git");
    const second = telemetry.sample.takeLagInterval("t");
    assert.equal(second.top, undefined, "no daemon.alive sample has run, and the second interval still names none");
    assert.equal(second.sync_spawn_ms, 0);
    // The alive window is its own: the taking above did not close it.
    assert.equal(telemetry.sample().sync_spawn_top.length, 1);
  });
});

test("W1-T7745: each loop_lag row carries the sync_spawn_ms of its own interval", () => {
  withSlowSpawn((telemetry, setMs) => {
    telemetry.sample.takeLagInterval("t");
    const rows: Array<Record<string, unknown> | undefined> = [];
    const lag = (): void => reportLoopLag(
      { phase: "p", dueAtMs: 0, observedAtMs: 5000, intervalMs: 1000, syncSpawnTop: undefined,
        ...((): { syncSpawnMs: number } => ({ syncSpawnMs: telemetry.sample.takeLagInterval("t").sync_spawn_ms }))() },
      (_s, extra) => rows.push(extra));
    setMs(1500); plainSpawnCaller(); setMs(700); plainSpawnCaller();
    lag();
    setMs(400); plainSpawnCaller();
    lag();
    lag();
    assert.deepEqual(rows.map((r) => r?.sync_spawn_ms), [2200, 400, 0]);
  });
});
