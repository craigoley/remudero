import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs, { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { systemClock } from "../src/lib/clock.js";
import {
  applyGhReadCadence, applyGhReadCadenceAsync, ghReadCadenceStampPath,
  readGhReadCadenceStampMs, stampGhRead, withGhTransportFloorMode,
  type GhReadCadenceDeps,
} from "../src/lib/github-transport.js";
import { HANDLERS } from "../src/run-task.js";

function fixture(t: TestContext, cooldown?: string, elapsedMs = 120_000) {
  const dir = mkdtempSync(join(tmpdir(), "rmd-next-id-floor-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = { RMD_GH_CACHE_HOME: dir, RMD_GH_TRANSPORT_FLOOR: "wait", RMD_GH_COOLDOWN_S: cooldown };
  const path = ghReadCadenceStampPath(env)!;
  let now = 1_000_000;
  let last = now - elapsedMs;
  const events: string[] = [];
  const warnings: string[] = [];
  const sleep = (ms: number) => {
    assert.equal(existsSync(`${path}.lock`), true);
    events.push(`sleep:${ms}`);
    now += ms;
  };
  const deps: GhReadCadenceDeps = {
    env, nowMs: () => now, readStampMs: () => last,
    stamp: (target) => { assert.equal(target, path); last = now; events.push(`stamp:${now}`); },
    sleepSync: sleep, sleep: async (ms) => { await Promise.resolve(); sleep(ms); },
    warn: (line) => void warnings.push(line),
  };
  return { env, path, events, warnings, deps, now: () => now, last: () => last };
}

test("W1-T7957: a wait-mode read waits out the shared floor before reading", async (t) => {
  for (const [asyncRead, elapsedMs] of [
    [false, 120_000], [false, 120_500], [true, 120_000], [true, 120_500],
  ] as const) {
    const f = fixture(t, undefined, elapsedMs);
    const waitMs = 180_000 - elapsedMs;
    const admittedAt = 1_000_000 + waitMs;
    await withGhTransportFloorMode("wait", async () => {
      const decision = asyncRead
        ? await applyGhReadCadenceAsync(["api", "repos/o/r/pulls"], f.deps)
        : applyGhReadCadence(["api", "repos/o/r/pulls"], f.deps);
      assert.equal(decision.allow, true);
      f.events.push(`read:${f.now()}`);
      assert.deepEqual(f.events, [`sleep:${waitMs}`, `stamp:${admittedAt}`, `read:${admittedAt}`]);
      assert.equal(f.last(), admittedAt);
      assert.equal(f.warnings.length, 1);
      assert.ok(f.warnings[0].includes(`waiting ${waitMs / 1000}s`));
      assert.ok(f.warnings[0].includes("180s"));
      assert.ok(f.warnings[0].includes(f.path));
      f.events.length = 0;
      applyGhReadCadence(["api", "repos/o/r/pulls"], f.deps);
      assert.deepEqual(f.events, [`stamp:${admittedAt}`], "the invocation's next read uses its burst");
    }, f.env);
    assert.equal(existsSync(`${f.path}.lock`), false);
  }
});

async function runHandler(t: TestContext, advisory: boolean) {
  const dir = mkdtempSync(join(tmpdir(), "rmd-next-id-dispatch-"));
  const keys = ["RMD_GH_CACHE_HOME", "RMD_GH_COOLDOWN_S", "RMD_GH_TRANSPORT_FLOOR"] as const;
  const saved = keys.map((key) => process.env[key]);
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    keys.forEach((key, i) => saved[i] === undefined ? delete process.env[key] : process.env[key] = saved[i]);
    rmSync(dir, { recursive: true, force: true });
  });
  process.env.RMD_GH_CACHE_HOME = dir;
  delete process.env.RMD_GH_COOLDOWN_S;
  if (advisory) process.env.RMD_GH_TRANSPORT_FLOOR = "advisory";
  else delete process.env.RMD_GH_TRANSPORT_FLOOR;
  const path = ghReadCadenceStampPath(process.env)!;
  stampGhRead(path);
  let now = readGhReadCadenceStampMs(path)! + 120_000;
  const startedAt = now;
  const events: string[] = [];
  const warnings: string[] = [];
  const write = fs.writeFileSync;
  t.mock.method(systemClock, "now", () => now);
  t.mock.method(Atomics, "wait", (_array: unknown, _index: number, _value: number, ms: number) => {
    assert.equal(existsSync(`${path}.lock`), true);
    events.push(`sleep:${ms}`);
    now += ms;
    return "timed-out";
  });
  t.mock.method(fs, "writeFileSync", (target: fs.PathOrFileDescriptor, ...args: unknown[]) => {
    (write as (...args: unknown[]) => void)(target, ...args);
    if (target === path) {
      events.push("stamp");
      utimesSync(path, now / 1000, now / 1000);
    }
  });
  t.mock.method(childProcess, "execFileSync", (file: string, args: string[]) => {
    if (file === "gh") {
      assert.equal(args[0], "api");
      assert.ok(args.some((arg) => arg.includes("/pulls")));
      events.push(`read:${now - startedAt}`);
      return "[]";
    }
    assert.equal(file, "git");
    return args.includes("get-url") || args.includes("remote.origin.url") ? "https://github.com/o/r.git" : "";
  });
  t.mock.method(childProcess, "spawnSync", () => ({ status: 0, stdout: "", stderr: "" }));
  t.mock.method(process.stderr, "write", (line: string) => { warnings.push(line); return true; });
  t.mock.method(console, "log", () => {});
  syncBuiltinESMExports();
  const plan = join(dir, "tasks.yaml");
  writeFileSync(plan, "- id: W1-T10\n  title: seed\n");
  const handler = HANDLERS.get("next-task-id");
  assert.ok(handler);
  assert.equal(await handler(["--plan", plan, "--no-reserve"]), 0);
  assert.equal(process.env.RMD_GH_TRANSPORT_FLOOR, advisory ? "advisory" : undefined);
  return { events, warnings, path, now, stamp: readGhReadCadenceStampMs(path) };
}

test("W1-T7957: next-task-id waits for a read the hook stamped", async (t) => {
  const result = await runHandler(t, false);
  assert.deepEqual(result.events, ["sleep:60000", "stamp", "read:60000"]);
  assert.equal(result.stamp, result.now);
  assert.ok(result.warnings.some((line) => line.includes(result.path) && line.includes("180s")));
});

test("W1-T7957: the transport window reads RMD_GH_COOLDOWN_S like the hook", async (t) => {
  for (const [raw, windowS, waitMs] of [
    [undefined, 180, 60_000], ["", 180, 60_000], ["garbage", 180, 60_000],
    ["-1", 180, 60_000], ["1.5", 180, 60_000], [" 0", 180, 60_000],
    ["+0", 180, 60_000], ["240", 240, 120_000], ["0240", 240, 120_000],
    ["0\n", 180, 60_000], ["240\r\n", 180, 60_000],
    ["0", 0, 0], ["000", 0, 0],
  ] as const) {
    const f = fixture(t, raw);
    const decision = applyGhReadCadence(["api", "repos/o/r/pulls"], f.deps);
    assert.equal(decision.windowS, windowS, `override: ${raw}`);
    assert.deepEqual(f.events, [...(waitMs > 0 ? [`sleep:${waitMs}`] : []), `stamp:${1_000_000 + waitMs}`]);
  }
});

test("W1-T7957: an inherited advisory floor does not wait", async (t) => {
  const result = await runHandler(t, true);
  assert.deepEqual(result.events, ["stamp", "read:0"]);
  assert.ok(result.warnings.some((line) => line.includes("advisory, W1-T3297")));
});
