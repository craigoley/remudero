import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { clockFromMillisFn } from "#src/lib/clock.js";
import { daemonBoot, reportLoopLag, SPAWN_HELPER_SWITCH, takeSyncSpawn } from "#src/lib/daemon.js";
import { startReadPlaneTelemetry, type SyncSpawnCallerTotal } from "#src/lib/read-plane.js";
import { installedSpawnHelper, installSpawnHelper, runDirect, runRouted, startSpawnHelper, type SpawnHelper,
  type SpawnRequest, type SpawnResult } from "#src/lib/spawn-helper.js";

type Row = { step: string } & Record<string, unknown>;
const capture = (): { rows: Row[]; log: (step: string, extra?: Record<string, unknown>) => void } => {
  const rows: Row[] = [];
  return { rows, log: (step, extra = {}) => { rows.push({ step, ...extra }); } };
};

// Captured at import, before any meter is installed: the shape the git and gh leaves use.
const execFilePromise = promisify(execFile);
function asyncSpawningCaller(): Promise<void> {
  const child = execFile("git", ["--version"]);
  return new Promise((resolve) => { child.on("close", () => resolve()); });
}
async function capturedPromiseCaller(): Promise<void> { await execFilePromise("git", ["--version"]); }

const named = (list: unknown, fn: string): SyncSpawnCallerTotal | undefined =>
  (list as SyncSpawnCallerTotal[] | undefined)?.find((total) => String(total.caller).includes(fn));

async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !predicate(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(predicate(), "condition never held");
}

test("W1-T9754: an async spawn meters its synchronous loop time by caller", async () => {
  let ms = 0;
  // Every reading of the meter's clock advances it 5 ms, so one spawn call reads exactly 5 ms on the loop.
  const telemetry = startReadPlaneTelemetry({ clock: clockFromMillisFn(() => (ms += 5)) });
  try {
    await asyncSpawningCaller();
    await asyncSpawningCaller();
    await capturedPromiseCaller();
    const { rows, log } = capture();
    reportLoopLag({ phase: "dispatch", dueAtMs: 0, observedAtMs: 10_000, intervalMs: 1000,
      ...takeSyncSpawn({ readLoopTelemetry: telemetry.sample }, "ticker") }, log);
    const lag = rows.find((row) => row.step === "daemon.loop_lag");
    assert.equal(lag?.async_spawn_sync_ms, 15, "three spawn calls, 5 ms each, on the lag row");
    assert.deepEqual([named(lag?.async_spawn_sync_by_caller, "asyncSpawningCaller")?.total_ms,
      named(lag?.async_spawn_sync_by_caller, "asyncSpawningCaller")?.calls], [10, 2]);
    assert.deepEqual([named(lag?.async_spawn_sync_by_caller, "capturedPromiseCaller")?.total_ms,
      named(lag?.async_spawn_sync_by_caller, "capturedPromiseCaller")?.calls], [5, 1],
    "a promisify(execFile) captured before the meter started is metered too");
    assert.equal(lag?.sync_spawn_ms, 0, "an async spawn is not counted as a sync one");
    const alive = telemetry.sample();
    assert.equal(alive.async_spawn_sync_ms, 15, "the daemon.alive window carries the same total");
    assert.equal(named(alive.async_spawn_sync_by_caller, "asyncSpawningCaller")?.calls, 2);
    assert.equal(telemetry.sample().async_spawn_sync_ms, 0, "the alive window resets on reading");
    const next = telemetry.sample.takeLagInterval("ticker");
    assert.deepEqual(next, { top: undefined, sync_spawn_ms: 0 }, "the lag window resets to an idle reading");
  } finally {
    telemetry.stop();
  }
  const after = startReadPlaneTelemetry({ clock: clockFromMillisFn(() => (ms += 5)) });
  after.stop();
  await asyncSpawningCaller();
  assert.equal(after.sample().async_spawn_sync_ms, 0, "a stopped meter restores the spawn it wrapped");
});

test("W1-T9754: an attribution failure costs the caller's name, never the spawn or its time", async () => {
  const own = Object.getOwnPropertyDescriptor(Error, "prepareStackTrace");
  const restore = (): void => {
    if (own) Object.defineProperty(Error, "prepareStackTrace", own);
    else delete (Error as { prepareStackTrace?: unknown }).prepareStackTrace;
  };
  let ms = 0;
  const telemetry = startReadPlaneTelemetry({ clock: clockFromMillisFn(() => (ms += 5)) });
  try {
    // The caller capture installs its own stack formatter; refusing that assignment makes the capture throw.
    Object.defineProperty(Error, "prepareStackTrace", { configurable: true, get: () => undefined,
      set: () => { throw new Error("no frames today"); } });
    const child = execFile("true");
    restore();
    const exited = await new Promise((resolve) => { child.on("close", (code) => resolve(code)); });
    const lag = telemetry.sample.takeLagInterval("t");
    assert.equal(exited, 0, "the spawn ran");
    assert.equal(lag.async_spawn_sync_ms, 5, "its loop time is still counted");
    assert.deepEqual(lag.async_by_caller, [], "with no caller to name");
  } finally {
    restore();
    telemetry.stop();
  }
});

const comparable = (result: SpawnResult): Pick<SpawnResult, "exitCode" | "signal" | "stdout" | "stderr" | "error"> =>
  ({ exitCode: result.exitCode, signal: result.signal, stdout: result.stdout, stderr: result.stderr,
    ...(result.error === undefined ? {} : { error: result.error }) });

const CASES: Array<[string, SpawnRequest]> = [
  ["git --version", { file: "git", args: ["--version"] }],
  ["a non-zero exit with both streams", { file: "sh", args: ["-c", "echo out; echo err >&2; exit 3"] }],
  ["stdin is delivered", { file: "cat", input: "hello\nworld" }],
  ["cwd and env are the request's", { file: "sh", args: ["-c", "pwd; echo $W1_T9754"], cwd: "/",
    env: { PATH: process.env.PATH, W1_T9754: "seen" } }],
  ["a missing binary", { file: "w1-t9754-no-such-binary" }],
  ["a timeout kills the child", { file: "sleep", args: ["5"], timeoutMs: 100 }],
];

test("W1-T9754: the spawn helper matches a direct spawn and falls back when dead", async () => {
  const { rows, log } = capture();
  const helper = startSpawnHelper({ log });
  try {
    assert.equal(helper.unhealthy(), undefined);
    for (const [name, request] of CASES) {
      const [viaHelper, direct] = await Promise.all([helper.run(request), runDirect(request)]);
      assert.equal(viaHelper.via, "helper", name);
      assert.equal(direct.via, "direct", name);
      assert.deepEqual(comparable(viaHelper), comparable(direct), name);
    }
    const version = await helper.run({ file: "git", args: ["--version"] });
    assert.match(version.stdout, /^git version /);
    assert.equal(version.exitCode, 0);
    assert.ok(rows.some((row) => row.step === "spawn.routed" && row.via === "helper" && row.command === "git"
      && typeof row.sync_ms === "number"), "each routed spawn's row names its path and its loop ms");
    process.kill(helper.pid as number, "SIGKILL");
    await until(() => helper.unhealthy() !== undefined);
    assert.match(String(helper.unhealthy()), /^helper_exited: SIGKILL$/);
    for (const [name, request] of CASES) {
      const fallback = await helper.run(request);
      assert.equal(fallback.via, "direct", name);
      assert.equal(fallback.reason, "helper_exited: SIGKILL", `${name}: the fallback names why`);
      assert.deepEqual(comparable(fallback), comparable(await runDirect(request)), name);
    }
    assert.ok(rows.some((row) => row.step === "spawn.routed" && row.via === "direct"
      && row.reason === "helper_exited: SIGKILL"), "the fallback's row names its reason");
  } finally {
    helper.stop();
  }
});

test("W1-T9754: a request in flight when the helper garbles is failed, never re-run", async () => {
  const garbling = startSpawnHelper({ source: `require("node:readline").createInterface({ input: process.stdin })
    .on("line", () => process.stdout.write("not json\\n"));` });
  try {
    const inFlight = await garbling.run({ file: "git", args: ["--version"] });
    assert.deepEqual([inFlight.via, inFlight.error, inFlight.exitCode], ["helper", "helper_died_in_flight", null]);
    assert.match(String(inFlight.reason), /^helper_garbled: /);
    const after = await garbling.run({ file: "git", args: ["--version"] });
    assert.equal(after.via, "direct");
    assert.match(String(after.reason), /^helper_garbled: /);
  } finally {
    garbling.stop();
  }
  assert.match(String(garbling.unhealthy()), /^helper_garbled: /, "stopping keeps the first reason");
});

test("W1-T9754: a throwing row writer and an unspawnable request still settle", async () => {
  const helper = startSpawnHelper({ log: () => { throw new Error("ledger down"); } });
  try {
    assert.equal((await helper.run({ file: "true" })).exitCode, 0, "the row is lost, the result is not");
  } finally {
    helper.stop();
  }
  const invalid = await runDirect({ file: 42 as unknown as string });
  assert.deepEqual([invalid.via, invalid.exitCode, invalid.error], ["direct", null, "ERR_INVALID_ARG_TYPE"]);
});

test("W1-T9754: the boot starts and installs the helper only when the switch is on", async () => {
  installSpawnHelper(undefined);
  const unrouted = await runRouted({ file: "true" });
  assert.deepEqual([unrouted.via, unrouted.reason], ["direct", "helper_not_installed"]);
  const off = capture();
  await daemonBoot(off.log, {});
  assert.equal(off.rows.some((row) => row.step === "daemon.spawn_helper"), false);
  assert.equal(installedSpawnHelper(), undefined, "switch off: no helper");
  const on = capture();
  await daemonBoot(on.log, { [SPAWN_HELPER_SWITCH]: "on" });
  let helper: SpawnHelper | undefined;
  try {
    helper = installedSpawnHelper();
    const row = on.rows.find((r) => r.step === "daemon.spawn_helper");
    assert.deepEqual([row?.started, row?.pid, row?.switch], [true, helper?.pid, "RMD_SPAWN_HELPER"]);
    const routed = await runRouted({ file: "git", args: ["--version"] });
    assert.equal(routed.via, "helper");
    assert.match(routed.stdout, /^git version /);
  } finally {
    helper?.stop();
    installSpawnHelper(undefined);
  }
});

const median = (values: number[]): number => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? NaN;

test("W1-T9754: a large parent spawns through the helper for less loop time", async () => {
  // The helper is started while this process is small, as the daemon's boot does; only then does the parent grow.
  const helper = startSpawnHelper();
  const ballast: Buffer[] = [];
  const telemetry = startReadPlaneTelemetry();
  try {
    for (let i = 0; i < 16; i++) ballast.push(Buffer.allocUnsafe(64 << 20).fill(i + 1));
    assert.ok(process.memoryUsage().rss > 1024 * 1024 * 1024, "the parent holds 1 GB of resident ballast");
    const request: SpawnRequest = { file: "true" };
    const direct: number[] = [];
    const routed: number[] = [];
    telemetry.sample();
    for (let i = 0; i < 5; i++) direct.push((await runDirect(request)).sync_ms);
    const directMeter = telemetry.sample().async_spawn_sync_ms;
    for (let i = 0; i < 5; i++) {
      const result = await helper.run(request);
      assert.equal(result.via, "helper");
      assert.equal(result.exitCode, 0);
      routed.push(result.sync_ms);
    }
    const routedMeter = telemetry.sample().async_spawn_sync_ms;
    assert.ok(median(routed) < median(direct),
      `helper p50 ${median(routed).toFixed(3)} ms must be under direct p50 ${median(direct).toFixed(3)} ms`);
    assert.ok(routedMeter < directMeter,
      `the meter saw ${routedMeter} ms of forks through the helper against ${directMeter} ms direct`);
  } finally {
    telemetry.stop();
    helper.stop();
    ballast.length = 0;
  }
});
