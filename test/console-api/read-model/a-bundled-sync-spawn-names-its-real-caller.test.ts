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
    const outfile = join(dir, "run-task.mjs");
    buildSync({
      stdin: { contents: `
import childProcess from "node:child_process";
import { callerFrame, startReadPlaneTelemetry } from "#src/lib/read-plane.js";
import { clockFromMillisFn } from "#src/lib/clock.js";
import { ghExecFile } from "#src/lib/github-transport.js";
function actualCaller() { return callerFrame(); }
function actualLeafCaller() { ghExecFile(process.execPath, ["-e", ""]); }
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
  actualLeafCaller();
  const lag = telemetry.sample.takeLagInterval("bundled");
  console.log(JSON.stringify({ frame: actualCaller(), sample, leafSample: telemetry.sample(), lag }));
} finally { telemetry.stop(); }
`, resolveDir: REPO_ROOT, sourcefile: "bundled-spawn-fixture.ts" },
      outfile, bundle: true, platform: "node", format: "esm", keepNames: true,
      packages: "external", logLevel: "silent",
    });
    const env = { ...process.env, NODE_V8_COVERAGE: undefined };
    const result = JSON.parse(execFileSync(process.execPath, [outfile], {
      cwd: REPO_ROOT, env, encoding: "utf8",
    })) as { frame: { caller: string }; sample: Sample; leafSample: Sample;
      lag: { by_caller: CallerTotal[] } };
    assert.match(result.frame.caller, /^at actualCaller \(.*[/\\]run-task\.mjs:\d+:\d+\)$/);
    const totals = result.sample.sync_spawn_by_caller;
    const top = result.sample.sync_spawn_top;
    assert.equal(totals.length, 3);
    assert.equal(top.length, 3);
    for (const owner of ["spawnOwner", "shellOwner", "syncOwner"]) {
      const pattern = new RegExp(`^at ${owner} \\(.*[/\\\\]run-task\\.mjs:\\d+:\\d+\\)$`);
      assert.ok(totals.some(row => pattern.test(row.caller) && row.calls === 1 && row.total_ms === 3000), owner);
      assert.ok(top.some(row => pattern.test(row.caller) && row.duration_ms === 3000), owner);
    }
    for (const row of [...totals, ...top]) assert.equal(row.leaf, undefined);
    const leafTotals = result.leafSample.sync_spawn_by_caller;
    const leafTop = result.leafSample.sync_spawn_top;
    assert.equal(leafTotals.length, 1);
    assert.equal(leafTop.length, 1);
    assert.equal(leafTotals[0]!.calls, 1);
    assert.equal(leafTotals[0]!.total_ms, 3000);
    assert.equal(leafTop[0]!.duration_ms, 3000);
    const lagLeaf = result.lag.by_caller.find(row => row.leaf === "ghExecFile");
    assert.ok(lagLeaf, "lag intervals retain the bundled shared leaf too");
    for (const row of [...leafTotals, ...leafTop, lagLeaf]) {
      assert.match(row.caller, /^at actualLeafCaller \(.*[/\\]run-task\.mjs:\d+:\d+\)$/);
      assert.equal(row.leaf, "ghExecFile");
      assert.equal(row.caller_is_leaf, undefined);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

interface Attribution { caller: string; leaf?: string; caller_is_leaf?: true }
interface CallerTotal extends Attribution { calls: number; total_ms: number }
interface Sample {
  sync_spawn_by_caller: CallerTotal[];
  sync_spawn_top: (Attribution & { duration_ms: number })[];
}
