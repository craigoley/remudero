import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { buildSync } from "esbuild";
import { makeTempDir } from "#src/lib/tmp.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

test("test/console-api/read-model/a-bundled-sync-spawn-names-its-real-caller.test.ts — W1-T11410 criterion 1: production ghExecFile keeps its bundled caller and leaf", () => {
  const dir = makeTempDir("bundled-spawn-caller");
  try {
    const outfile = join(dir, "run-task.mjs");
    buildSync({
      stdin: { contents: `
import childProcess from "node:child_process";
import { startReadPlaneTelemetry } from "#src/lib/read-plane.js";
import { ghExecFile } from "#src/lib/github-transport.js";
import { clockFromMillisFn } from "#src/lib/clock.js";
function actualCaller() { return ghExecFile(process.execPath, ["-e", ""], { encoding: "utf8" }); }
function spawnOwner() { childProcess.execFileSync(process.execPath, ["-e", ""]); }
function shellOwner() { childProcess.execSync("true"); }
function syncOwner() { childProcess.spawnSync(process.execPath, ["-e", ""]); }
let now = 0;
const telemetry = startReadPlaneTelemetry({ clock: clockFromMillisFn(() => now += 3000) });
try {
  actualCaller();
  spawnOwner();
  shellOwner();
  syncOwner();
  console.log(JSON.stringify({ sample: telemetry.sample() }));
} finally { telemetry.stop(); }
`, resolveDir: REPO_ROOT, sourcefile: "bundled-spawn-fixture.ts" },
      outfile, bundle: true, platform: "node", format: "esm", keepNames: true,
      packages: "external", logLevel: "silent",
    });
    const env = { ...process.env, NODE_V8_COVERAGE: undefined };
    const result = JSON.parse(execFileSync(process.execPath, [outfile], {
      cwd: REPO_ROOT, env, encoding: "utf8",
    })) as { frame: { caller: string }; sample: {
      sync_spawn_by_caller: { caller: string; leaf?: string; calls: number; total_ms: number }[];
      sync_spawn_top: { caller: string; leaf?: string; duration_ms: number }[];
    } };
    const totals = result.sample.sync_spawn_by_caller;
    const top = result.sample.sync_spawn_top;
    assert.equal(totals.length, 4);
    assert.equal(top.length, 3);
    const actual = totals.find(row => /^at actualCaller \(.*[/\\]run-task\.mjs:\d+:\d+\)$/.test(row.caller));
    assert.ok(actual);
    assert.equal(actual.leaf, "ghExecFile");
    const actualTop = top.find(row => /^at actualCaller \(.*[/\\]run-task\.mjs:\d+:\d+\)$/.test(row.caller));
    assert.ok(actualTop);
    assert.equal(actualTop.leaf, "ghExecFile");
    for (const owner of ["spawnOwner", "shellOwner", "syncOwner"]) {
      const pattern = new RegExp(`^at ${owner} \\(.*[/\\\\]run-task\\.mjs:\\d+:\\d+\\)$`);
      assert.ok(totals.some(row => pattern.test(row.caller) && row.calls === 1 && row.total_ms === 3000), owner);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
