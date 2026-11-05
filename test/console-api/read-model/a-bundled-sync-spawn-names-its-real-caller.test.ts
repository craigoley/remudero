import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { buildSync } from "esbuild";
import { makeTempDir } from "#src/lib/tmp.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

test("test/console-api/read-model/a-bundled-sync-spawn-names-its-real-caller.test.ts", () => {
  const dir = makeTempDir("bundled-spawn-caller");
  try {
    const outfile = join(dir, "dist", "child-entries", "run-task.mjs");
    buildSync({
      stdin: { contents: `
import childProcess from "node:child_process";
import { callerFrame, startReadPlaneTelemetry } from "#src/lib/read-plane.js";
import { clockFromMillisFn } from "#src/lib/clock.js";
import { ghExecFile } from "#src/lib/github-transport.js";
function directCaller() { return callerFrame(); }
function actualCaller() { ghExecFile(process.execPath, ["-e", ""]); }
function spawnOwner() { childProcess.execFileSync(process.execPath, ["-e", ""]); }
function shellOwner() { childProcess.execSync("true"); }
function syncOwner() { childProcess.spawnSync(process.execPath, ["-e", ""]); }
let now = 0;
const telemetry = startReadPlaneTelemetry({ clock: clockFromMillisFn(() => now += 3000) });
try {
  spawnOwner();
  shellOwner();
  syncOwner();
  const sample = telemetry.sample();
  telemetry.sample.takeLagInterval("shared");
  actualCaller();
  console.log(JSON.stringify({ frame: directCaller(), sample, sharedSample: telemetry.sample(),
    sharedLag: telemetry.sample.takeLagInterval("shared") }));
} finally { telemetry.stop(); }
`, resolveDir: REPO_ROOT, sourcefile: "bundled-spawn-fixture.ts" },
      outfile, bundle: true, platform: "node", format: "esm", keepNames: true,
      packages: "external", logLevel: "silent",
    });
    const env = { ...process.env, NODE_V8_COVERAGE: undefined };
    type Entry = { caller: string; leaf?: string; caller_is_leaf?: true };
    const result = JSON.parse(execFileSync(process.execPath, [outfile], {
      cwd: REPO_ROOT, env, encoding: "utf8",
    })) as { frame: { caller: string }; sample: {
      sync_spawn_by_caller: (Entry & { calls: number; total_ms: number })[];
      sync_spawn_top: (Entry & { duration_ms: number })[];
    }; sharedSample: { sync_spawn_by_caller: Entry[]; sync_spawn_top: Entry[] };
      sharedLag: { by_caller: Entry[]; top: Entry } };
    assert.match(result.frame.caller, /^at directCaller \(.*[/\\]run-task\.mjs:\d+:\d+\)$/);
    const totals = result.sample.sync_spawn_by_caller;
    const top = result.sample.sync_spawn_top;
    assert.equal(totals.length, 3);
    assert.equal(top.length, 3);
    for (const owner of ["spawnOwner", "shellOwner", "syncOwner"]) {
      const pattern = new RegExp(`^at ${owner} \\(.*[/\\\\]run-task\\.mjs:\\d+:\\d+\\)$`);
      assert.ok(totals.some(row => pattern.test(row.caller) && row.calls === 1 && row.total_ms === 3000), owner);
      assert.ok(top.some(row => pattern.test(row.caller) && row.duration_ms === 3000), owner);
    }
    assert.ok([...totals, ...top].every(row => row.leaf === undefined && row.caller_is_leaf === undefined));
    for (const rows of [result.sharedSample.sync_spawn_by_caller, result.sharedSample.sync_spawn_top,
      result.sharedLag.by_caller, [result.sharedLag.top]]) {
      assert.equal(rows.length, 1);
      assert.match(rows[0]!.caller, /^at actualCaller \(.*[/\\]run-task\.mjs:\d+:\d+\)$/);
      assert.equal(rows[0]!.leaf, "ghExecFile");
      assert.equal(rows[0]!.caller_is_leaf, undefined);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
