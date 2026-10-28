import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import { clockFromMillisFn } from "#src/lib/clock.js";
import { reportLoopLag } from "#src/lib/daemon.js";
import { runStepsSync, step } from "#src/lib/git-push.js";
import { startReadPlaneTelemetry, type SyncSpawnCallerTotal } from "#src/lib/read-plane.js";

// W1-T9577: execFileSync faked UNDER the telemetry wrapper; each call advances a fake clock by the pending ms.
function withTimedSpawns(run: (telemetry: ReturnType<typeof startReadPlaneTelemetry>, setMs: (ms: number) => void) => void): void {
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

function manyShortCalls(): void { childProcess.execFileSync("gh", ["issue", "list"]); }
function longCallerA(): void { childProcess.execFileSync("git", ["fetch"]); }
function longCallerB(): void { childProcess.execFileSync("git", ["gc"]); }
function longCallerC(): void { childProcess.execFileSync("git", ["log"]); }
function fourthCaller(): void { childProcess.execFileSync("gh", ["pr", "view"]); }
function smallCaller(): void { childProcess.execFileSync("git", ["rev-parse"]); }

// escalate.ts's gh issue gateway in miniature: an anonymous `run`, driven through git-push's runStepsSync.
function issueGateway(exec?: (args: string[]) => string): { label(name: string): string } {
  const run = exec ?? ((args: string[]) => String(childProcess.execFileSync("gh", args)));
  return { label: (name) => runStepsSync((function* () { return yield* step(() => run(["label", name])); })()) };
}
const gateway = issueGateway();
function openIssueSite(): void { gateway.label("a"); }
function commentSite(): void { gateway.label("b"); }
function localClosureSite(): void { ((): void => { childProcess.execFileSync("git", ["status"]); })(); }

const named = (list: SyncSpawnCallerTotal[] | undefined, fn: string): SyncSpawnCallerTotal | undefined =>
  list?.find((total) => String(total.caller).includes(fn));

test("W1-T9577: many short spawns from one caller are named by their total", () => {
  withTimedSpawns((telemetry, setMs) => {
    telemetry.sample.takeLagInterval("t");
    setMs(500);
    for (let i = 0; i < 20; i++) manyShortCalls();
    const lag = telemetry.sample.takeLagInterval("t");
    assert.equal(lag.top, undefined, "no single call reaches the top list's minimum");
    const sample = telemetry.sample();
    assert.deepEqual(sample.sync_spawn_top, [], "sync_spawn_top is unchanged");
    for (const list of [sample.sync_spawn_by_caller, lag.by_caller]) {
      const total = named(list, "manyShortCalls");
      assert.equal(total?.total_ms, 10_000);
      assert.equal(total?.calls, 20);
    }
    assert.equal(sample.sync_spawn_unnamed_ms, 0);
  });
});

test("W1-T9577: a fourth caller is named by its total, not dropped by the top three", () => {
  withTimedSpawns((telemetry, setMs) => {
    setMs(3000); longCallerA();
    setMs(2800); longCallerB();
    setMs(2600); longCallerC();
    setMs(2100); fourthCaller(); fourthCaller();
    const sample = telemetry.sample();
    assert.deepEqual(sample.sync_spawn_top.map((e) => e.duration_ms), [3000, 2800, 2600]);
    assert.ok(sample.sync_spawn_top.every((e) => !String(e.caller).includes("fourthCaller")), "the top three drop it");
    const order = sample.sync_spawn_by_caller.map((total) =>
      ["fourthCaller", "longCallerA", "longCallerB", "longCallerC"].find((fn) => String(total.caller).includes(fn)));
    assert.deepEqual(order, ["fourthCaller", "longCallerA", "longCallerB", "longCallerC"]);
    assert.deepEqual([sample.sync_spawn_by_caller[0]?.total_ms, sample.sync_spawn_by_caller[0]?.calls], [4200, 2]);
  });
});

test("W1-T9577: an anonymous caller is named by its chain", () => {
  withTimedSpawns((telemetry, setMs) => {
    setMs(400);
    openIssueSite(); openIssueSite(); commentSite();
    const sample = telemetry.sample();
    assert.equal(sample.sync_spawn_by_caller.length, 2, "one closure, two call sites, two totals");
    const [first, second] = sample.sync_spawn_by_caller;
    assert.equal(first?.caller, second?.caller, "both reach the same anonymous closure");
    assert.match(String(first?.caller), /^at <anonymous> \(/);
    assert.match(String(first?.caller_chain?.[0]), /^<anonymous>@a-loop-freeze-names-every-caller-that-held-it\.test\.ts:\d+$/);
    assert.ok(first?.caller_chain?.includes("runStepsSync"), "the chain runs on through the foreign driver");
    assert.deepEqual(sample.sync_spawn_by_caller.map((t) =>
      [["openIssueSite", "commentSite"].find((fn) => t.caller_chain?.includes(fn)), t.total_ms]),
    [["openIssueSite", 800], ["commentSite", 400]]);
    setMs(2500); openIssueSite();
    assert.ok(telemetry.sample().sync_spawn_top[0]?.caller_chain?.includes("openIssueSite"), "the top entry carries it too");
    setMs(100); localClosureSite();
    assert.deepEqual(telemetry.sample().sync_spawn_by_caller[0]?.caller_chain?.slice(1), ["localClosureSite"],
      "a closure defined where it runs ends at the function around it");
    setMs(100); smallCaller();
    assert.equal(telemetry.sample().sync_spawn_by_caller[0]?.caller_chain, undefined, "a named caller needs no chain");
  });
});

test("W1-T9577: caller totals and the unnamed remainder sum to the window", () => {
  withTimedSpawns((telemetry, setMs) => {
    telemetry.sample.takeLagInterval("t");
    setMs(700.4); longCallerA(); longCallerA(); longCallerA();
    setMs(0.6); smallCaller();
    setMs(2500); fourthCaller();
    // A spawn whose attribution throws: its time is the window's, but no caller can be read for it.
    setMs(5); childProcess.execFileSync({ toString: () => { throw new Error("unreadable argv"); } } as never);
    const lag = telemetry.sample.takeLagInterval("t");
    const sample = telemetry.sample();
    const sum = (list: SyncSpawnCallerTotal[] | undefined): number => (list ?? []).reduce((n, t) => n + t.total_ms, 0);
    assert.equal(sum(sample.sync_spawn_by_caller) + sample.sync_spawn_unnamed_ms, Math.round(sample.sync_spawn_ms));
    assert.equal(sum(lag.by_caller) + (lag.unnamed_ms ?? NaN), lag.sync_spawn_ms);
    assert.equal(lag.sync_spawn_ms, 4607);
    assert.equal(lag.unnamed_ms, 5, "time no caller could be read for is the remainder, not lost");
    assert.deepEqual(lag.by_caller?.map((t) => t.total_ms), [2500, 2101, 1]);

    const rows: Array<Record<string, unknown> | undefined> = [];
    reportLoopLag({ phase: "p", dueAtMs: 0, observedAtMs: 5000, intervalMs: 1000, syncSpawnTop: lag.top,
      syncSpawnMs: lag.sync_spawn_ms, syncSpawnByCaller: lag.by_caller, syncSpawnUnnamedMs: lag.unnamed_ms },
    (_step, extra) => rows.push(extra));
    assert.deepEqual(rows[0]?.sync_spawn_by_caller, lag.by_caller, "daemon.loop_lag carries the totals");
    assert.equal(rows[0]?.sync_spawn_unnamed_ms, 5);
    assert.deepEqual(telemetry.sample.takeLagInterval("t"), { top: undefined, sync_spawn_ms: 0 }, "an idle interval names none");
  });
});
