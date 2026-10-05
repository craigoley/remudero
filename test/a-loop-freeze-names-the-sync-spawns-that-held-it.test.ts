import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import { reportLoopLag } from "../src/lib/daemon.js";
import { startReadPlaneTelemetry } from "../src/lib/read-plane.js";

// Inject a slow execFileSync UNDER the telemetry wrapper: each call advances a fake clock by `ms`.
function withSlowExecFileSync(run: (call: (file: string, args: string[], ms: number) => void,
  telemetry: ReturnType<typeof startReadPlaneTelemetry>) => void): void {
  const original = childProcess.execFileSync;
  let clock = 0;
  let pending = 0;
  Object.assign(childProcess, { execFileSync: () => { clock += pending; return ""; } });
  syncBuiltinESMExports();
  const telemetry = startReadPlaneTelemetry({ now: () => clock });
  try {
    run((file, args, ms) => { pending = ms; childProcess.execFileSync(file, args); }, telemetry);
  } finally {
    telemetry.stop();
    Object.assign(childProcess, { execFileSync: original });
    syncBuiltinESMExports();
  }
}

test("with an injected slow execFileSync, a 3 s gh call and a 2.5 s git call appear in sync_spawn_top longest first with command, first argument and a caller frame, a 1 s call does not, at most three entries are kept, and the list resets after a sample", () => {
  withSlowExecFileSync((call, telemetry) => {
    call("git", ["fetch", "--prune"], 2500);
    call("gh", ["pr", "list", "--token", "SECRET"], 3000);
    call("gh", ["api", "x"], 1000);
    const sample = telemetry.sample();
    assert.equal(sample.sync_spawn_ms, 6500);
    assert.deepEqual(sample.sync_spawn_top.map((e) => [e.command, e.first_arg, e.duration_ms]),
      [["gh", "pr", 3000], ["git", "fetch", 2500]]);
    assert.match(String(sample.sync_spawn_top[0]!.caller), /a-loop-freeze-names-the-sync-spawns/);
    assert.ok(!JSON.stringify(sample).includes("SECRET"), "no argument beyond the first is recorded");

    call("git", ["a"], 2100); call("git", ["b"], 2200); call("git", ["c"], 2300); call("git", ["d"], 2400);
    assert.equal(telemetry.sample.peek()?.first_arg, "d");
    const capped = telemetry.sample();
    assert.deepEqual(capped.sync_spawn_top.map((e) => e.first_arg), ["d", "c", "b"]);

    assert.deepEqual(telemetry.sample().sync_spawn_top, []);
    assert.equal(telemetry.sample.peek(), undefined);
  });
});

test("daemon.loop_lag carries the top synchronous spawn of the window it closes", () => {
  const rows: Array<Record<string, unknown> | undefined> = [];
  const top = { via: "execFileSync", command: "gh", first_arg: "pr", duration_ms: 3000 };
  reportLoopLag({ phase: "p", dueAtMs: 0, observedAtMs: 5000, intervalMs: 1000, syncSpawnTop: top },
    (_s, extra) => rows.push(extra));
  assert.deepEqual(rows[0]!.sync_spawn_top, top);
});
