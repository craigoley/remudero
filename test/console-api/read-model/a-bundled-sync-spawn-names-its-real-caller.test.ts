import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { buildSync } from "esbuild";
import { makeTempDir } from "#src/lib/tmp.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
import type { ReadPlaneSample } from "#src/lib/read-plane.js";

test("test/console-api/read-model/a-bundled-sync-spawn-names-its-real-caller.test.ts", () => {
  const dir = makeTempDir("bundled-spawn-caller");
  try {
    const outfile = join(dir, "run-task.mjs");
    buildSync({
      stdin: { contents: `
import childProcess from "node:child_process";
import { callerFrame, startReadPlaneTelemetry } from "#src/lib/read-plane.js";
import { clockFromMillisFn } from "#src/lib/clock.js";
import { ghExecFile } from "#src/lib/github-transport.js";
function frameOwner() { return callerFrame(); }
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
  actualCaller();
  console.log(JSON.stringify({ frame: frameOwner(), sample, shared: telemetry.sample() }));
} finally { telemetry.stop(); }
`, resolveDir: REPO_ROOT, sourcefile: "bundled-spawn-fixture.ts" },
      outfile, bundle: true, platform: "node", format: "esm", keepNames: true,
      packages: "external", logLevel: "silent",
    });
    const env = { ...process.env, NODE_V8_COVERAGE: undefined };
    const result = JSON.parse(execFileSync(process.execPath, [outfile], {
      cwd: REPO_ROOT, env, encoding: "utf8",
    })) as { frame: { caller: string }; sample: ReadPlaneSample; shared: ReadPlaneSample };
    assert.match(result.frame.caller, /^at frameOwner \(.*[/\\]run-task\.mjs:\d+:\d+\)$/);
    const totals = result.sample.sync_spawn_by_caller;
    const top = result.sample.sync_spawn_top;
    assert.equal(totals.length, 3);
    assert.equal(top.length, 3);
    for (const owner of ["spawnOwner", "shellOwner", "syncOwner"]) {
      const pattern = new RegExp(`^at ${owner} \\(.*[/\\\\]run-task\\.mjs:\\d+:\\d+\\)$`);
      assert.ok(totals.some(row => pattern.test(row.caller ?? "") && row.calls === 1 && row.total_ms === 3000), owner);
      assert.ok(top.some(row => pattern.test(row.caller ?? "") && row.duration_ms === 3000), owner);
    }
    assert.ok(totals.every(row => row.leaf === undefined && row.caller_is_leaf === undefined));
    assert.ok(top.every(row => row.leaf === undefined && row.caller_is_leaf === undefined));
    assert.equal(result.shared.sync_spawn_by_caller.length, 1);
    assert.equal(result.shared.sync_spawn_top.length, 1);
    const [sharedTotal] = result.shared.sync_spawn_by_caller;
    const [sharedTop] = result.shared.sync_spawn_top;
    for (const row of [sharedTotal!, sharedTop!]) {
      assert.match(row.caller!, /^at actualCaller \(.*[/\\]run-task\.mjs:\d+:\d+\)$/);
      assert.equal(row.leaf, "ghExecFile");
      assert.equal(row.caller_is_leaf, undefined);
    }
    assert.equal(sharedTotal!.calls, 1);
    assert.equal(sharedTotal!.total_ms, 3000);
    assert.equal(sharedTop!.duration_ms, 3000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
