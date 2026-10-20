import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import {
  applyGhReadCadence, applyGhReadCadenceAsync, ghReadCadenceStampPath, GhReadCadenceRefusal,
  resetGhCadenceAdvisoryForTest, withGhTransportFloorMode,
  type GhReadCadenceDeps,
} from "../src/lib/github-transport.js";
import { ghShim } from "./helpers/gh-shim.js";
import { gitRepo } from "./helpers/git-repo.js";

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
    // W1-T10271: a floor wait sleeps OUTSIDE the shared lock. Held, every sibling gave up on it after
    // 1 s, failed open and restamped, so the waiter's window restarted and core's waiter starved.
    assert.equal(existsSync(`${path}.lock`), false);
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

test("W1-T7957: an interrupted floor wait cannot admit the next read as a burst", async (t) => {
  for (const asyncRead of [false, true]) {
    const f = fixture(t);
    const interrupted = new Error("floor sleep interrupted");
    await withGhTransportFloorMode("wait", async () => {
      if (asyncRead) {
        await assert.rejects(applyGhReadCadenceAsync(["api", "repos/o/r/pulls"], {
          ...f.deps, sleep: async () => { throw interrupted; },
        }), (error) => error === interrupted);
      } else {
        assert.throws(() => applyGhReadCadence(["api", "repos/o/r/pulls"], {
          ...f.deps, sleepSync: () => { throw interrupted; },
        }), (error) => error === interrupted);
      }
      assert.deepEqual(f.events, []);
      assert.equal(existsSync(`${f.path}.lock`), false);
      const decision = asyncRead
        ? await applyGhReadCadenceAsync(["api", "repos/o/r/pulls"], f.deps)
        : applyGhReadCadence(["api", "repos/o/r/pulls"], f.deps);
      assert.equal(decision.allow, true);
      assert.deepEqual(f.events, ["sleep:60000", "stamp:1060000"]);
    }, f.env);
  }
});

test("W1-T7957: a read stamped during the wait extends the remaining floor", async (t) => {
  for (const asyncRead of [false, true]) {
    const f = fixture(t);
    let foreignStamp: number | undefined;
    let sleeps = 0;
    const sleep = (ms: number) => {
      f.deps.sleepSync!(ms);
      if (++sleeps === 1) foreignStamp = f.now() - 30_000;
    };
    const deps: GhReadCadenceDeps = {
      ...f.deps,
      readStampMs: () => foreignStamp ?? f.last(),
      stamp: (path) => { f.deps.stamp!(path); foreignStamp = undefined; },
      sleepSync: sleep,
      sleep: async (ms) => { await Promise.resolve(); sleep(ms); },
    };
    await withGhTransportFloorMode("wait", async () => {
      if (asyncRead) await applyGhReadCadenceAsync(["api", "repos/o/r/pulls"], deps);
      else applyGhReadCadence(["api", "repos/o/r/pulls"], deps);
      assert.deepEqual(f.events, ["sleep:60000", "sleep:150000", "stamp:1210000"]);
      assert.equal(f.warnings.length, 1, "one read prints one wait notice");
      f.events.length = 0;
      applyGhReadCadence(["api", "repos/o/r/pulls"], deps);
      assert.deepEqual(f.events, ["stamp:1210000"], "the completed wait earns the invocation's burst");
    }, f.env);
    assert.equal(existsSync(`${f.path}.lock`), false);
  }
});

test("W1-T7957: a synchronous read cannot skip a pending async floor wait", async (t) => {
  const f = fixture(t);
  let begin!: () => void;
  let resume!: () => void;
  const started = new Promise<void>((resolve) => { begin = resolve; });
  const held = new Promise<void>((resolve) => { resume = resolve; });
  await withGhTransportFloorMode("wait", async () => {
    const pending = applyGhReadCadenceAsync(["api", "repos/o/r/pulls"], {
      ...f.deps,
      sleep: async (ms) => { begin(); await held; await f.deps.sleep!(ms); },
    });
    await started;
    try {
      assert.throws(() => applyGhReadCadence(["api", "repos/o/r/pulls"], f.deps), GhReadCadenceRefusal);
      assert.deepEqual(f.events, [], "the refused read must not stamp or spend a burst");
    } finally {
      resume();
      await pending;
    }
    assert.deepEqual(f.events, ["sleep:60000", "stamp:1060000"]);
    f.events.length = 0;
    applyGhReadCadence(["api", "repos/o/r/pulls"], f.deps);
    assert.deepEqual(f.events, ["stamp:1060000"]);
  }, f.env);
  assert.equal(existsSync(`${f.path}.lock`), false);
});

test("W1-T7957: queued async reads share the burst earned after the floor wait", async (t) => {
  const f = fixture(t);
  await withGhTransportFloorMode("wait", async () => {
    const decisions = await Promise.all([
      applyGhReadCadenceAsync(["api", "repos/o/r/pulls"], f.deps),
      applyGhReadCadenceAsync(["api", "repos/o/r/issues"], f.deps),
    ]);
    assert.ok(decisions.every((decision) => decision.allow));
    assert.deepEqual(f.events, ["sleep:60000", "stamp:1060000", "stamp:1060000"]);
    assert.equal(f.warnings.length, 1, "the queued read uses the completed wait's burst");
  }, f.env);
  assert.equal(existsSync(`${f.path}.lock`), false);
});

test("W1-T7957: exhausting the invocation burst waits for the floor again", async (t) => {
  for (const asyncRead of [false, true]) {
    const f = fixture(t);
    const env = { ...f.env, RMD_GH_READ_BURST: "1" };
    const deps = { ...f.deps, env };
    const read = () => asyncRead
      ? applyGhReadCadenceAsync(["api", "repos/o/r/pulls"], deps)
      : applyGhReadCadence(["api", "repos/o/r/pulls"], deps);
    await withGhTransportFloorMode("wait", async () => {
      await read();
      await read();
      assert.deepEqual(f.events, ["sleep:60000", "stamp:1060000", "stamp:1060000"]);
      await read();
      assert.deepEqual(f.events, [
        "sleep:60000", "stamp:1060000", "stamp:1060000", "sleep:180000", "stamp:1240000",
      ]);
      assert.equal(f.warnings.length, 2, "each floor wait prints one notice");
    }, env);
    assert.equal(existsSync(`${f.path}.lock`), false);
  }
});

test("W1-T7957: a fresh invocation waits after the previous invocation's burst", async (t) => {
  for (const asyncRead of [false, true]) {
    const f = fixture(t);
    const read = () => asyncRead
      ? applyGhReadCadenceAsync(["api", "repos/o/r/pulls"], f.deps)
      : applyGhReadCadence(["api", "repos/o/r/pulls"], f.deps);
    await withGhTransportFloorMode("wait", async () => {
      await read();
      await read();
    }, f.env);
    assert.deepEqual(f.events, ["sleep:60000", "stamp:1060000", "stamp:1060000"]);
    f.events.length = 0;
    await withGhTransportFloorMode("wait", read, f.env);
    assert.deepEqual(f.events, ["sleep:180000", "stamp:1240000"]);
    assert.equal(existsSync(`${f.path}.lock`), false);
  }
});

test("W1-T7957: writes and budget probes neither wait nor earn a read burst", async (t) => {
  for (const asyncRead of [false, true]) {
    const f = fixture(t);
    await withGhTransportFloorMode("wait", async () => {
      for (const args of [["api", "repos/o/r/issues", "--method", "POST"], ["api", "rate_limit"]]) {
        const decision = asyncRead
          ? await applyGhReadCadenceAsync(args, f.deps)
          : applyGhReadCadence(args, f.deps);
        assert.equal(decision.allow, true);
        assert.equal(decision.paced, false);
        assert.deepEqual(f.events, [], "an exempt call must not wait or stamp");
        assert.equal(existsSync(`${f.path}.lock`), false);
      }
      if (asyncRead) await applyGhReadCadenceAsync(["api", "repos/o/r/pulls"], f.deps);
      else applyGhReadCadence(["api", "repos/o/r/pulls"], f.deps);
      assert.deepEqual(f.events, ["sleep:60000", "stamp:1060000"], "the first gated read still waits");
      assert.equal(f.warnings.length, 1);
    }, f.env);
    assert.equal(existsSync(`${f.path}.lock`), false);
  }
});

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const WINDOW_S = 180;
const STAMP_AGE_S = 120;

/** Run the real CLI with a stubbed `gh` and local remote. Freeze time after imports and advance it
 *  only through the transport's blocking sleep, so startup and scheduling cannot age the stamp. */
function runNextTaskId(t: TestContext, floor: "advisory" | undefined) {
  const dir = mkdtempSync(join(tmpdir(), "rmd-next-id-dispatch-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const shim = ghShim([{ when: "pulls", stdout: "[]" }]);
  const remote = gitRepo({ bare: true, kind: "next-id-remote" });
  t.after(() => remote.cleanup());
  const origin = execFileSync("git", ["-C", ROOT, "remote", "get-url", "origin"], { encoding: "utf8" }).trim();
  const plan = join(dir, "tasks.yaml");
  writeFileSync(plan, "- id: W1-T10\n  title: seed\n");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${shim.dir}:${process.env.PATH ?? ""}`,
    RMD_GH_CACHE_HOME: join(dir, "cache"),
    RMD_GH_COOLDOWN_S: String(WINDOW_S),
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `url.${remote.dir}.insteadOf`,
    GIT_CONFIG_VALUE_0: origin,
    // Blanked, never deleted (child_process re-injects a deleted key). Under tsx this child
    // source-maps a temp bootstrap that t.after removes before the shard renders lcov; enrolled, its
    // report left a shard with every test passing and no lcov at all. The dispatch line stays
    // covered in-process by test/triage-id-mint.test.ts.
    NODE_V8_COVERAGE: "",
  };
  delete env.RMD_GH_TRANSPORT_FLOOR;
  if (floor) env.RMD_GH_TRANSPORT_FLOOR = floor;
  const stampPath = ghReadCadenceStampPath(env)!;
  const sleepsPath = join(dir, "sleeps.json");
  const bootstrap = join(dir, "bootstrap.mjs");
  writeFileSync(bootstrap, `
    import assert from "node:assert/strict";
    import { existsSync, statSync, utimesSync, writeFileSync } from "node:fs";
    const { main } = await import(${JSON.stringify(join(ROOT, "src/run-task.ts"))});
    const { systemClock } = await import(${JSON.stringify(join(ROOT, "src/lib/clock.ts"))});
    const { stampGhRead } = await import(${JSON.stringify(join(ROOT, "src/lib/github-transport.ts"))});
    let now = Date.now();
    systemClock.now = () => now;
    const stampPath = ${JSON.stringify(stampPath)};
    const stampMs = now - ${STAMP_AGE_S * 1000};
    stampGhRead(stampPath);
    utimesSync(stampPath, stampMs / 1000, stampMs / 1000);
    const sleeps = [];
    writeFileSync(${JSON.stringify(sleepsPath)}, JSON.stringify(sleeps));
    Atomics.wait = (_view, _index, _value, ms) => {
      assert.equal(existsSync(stampPath + ".lock"), false, "the floor wait leaves the shared lock free (W1-T10271)");
      assert.equal(Math.round(statSync(stampPath).mtimeMs), stampMs, "sleep precedes stamping");
      sleeps.push(ms);
      now += ms;
      writeFileSync(${JSON.stringify(sleepsPath)}, JSON.stringify(sleeps));
      return "timed-out";
    };
    process.argv = [process.execPath, ${JSON.stringify(join(ROOT, "src/run-task.ts"))},
      "next-task-id", "--plan", ${JSON.stringify(plan)}, "--no-reserve"];
    await main();
  `);
  const run = spawnSync(
    process.execPath,
    ["--import", "tsx", bootstrap],
    { cwd: ROOT, env, encoding: "utf8", timeout: 120_000 },
  );
  assert.equal(run.status, 0, run.stderr);
  assert.equal(shim.calls().filter((call) => call.includes("pulls")).length, 1, "next-task-id makes exactly one open-PR read");
  return { stderr: run.stderr, stampPath, sleeps: JSON.parse(readFileSync(sleepsPath, "utf8")) };
}

test("W1-T7957: next-task-id waits for a read the hook stamped", { timeout: 180_000 }, (t) => {
  const result = runNextTaskId(t, undefined);
  assert.deepEqual(result.sleeps, [(WINDOW_S - STAMP_AGE_S) * 1000], "the read waits out the remaining floor");
  assert.ok(result.stderr.includes("gh read cadence (wait, W1-T7957)"), result.stderr);
  assert.ok(result.stderr.includes(result.stampPath) && result.stderr.includes(`${WINDOW_S}s`), result.stderr);
});

test("W1-T7957: the transport window reads RMD_GH_COOLDOWN_S like the hook", async (t) => {
  for (const [raw, windowS, waitMs] of [
    [undefined, 180, 60_000], ["", 180, 60_000], ["garbage", 180, 60_000],
    ["-1", 180, 60_000], ["1.5", 180, 60_000], [" 0", 180, 60_000],
    ["+0", 180, 60_000], ["240", 240, 120_000], ["0240", 240, 120_000],
    ["0\n", 180, 60_000], ["240\r\n", 180, 60_000],
    ["0", 0, 0], ["000", 0, 0],
  ] as const) {
    for (const asyncRead of [false, true]) {
      const f = fixture(t, raw);
      const decision = asyncRead
        ? await applyGhReadCadenceAsync(["api", "repos/o/r/pulls"], f.deps)
        : applyGhReadCadence(["api", "repos/o/r/pulls"], f.deps);
      assert.equal(decision.windowS, windowS, `override: ${raw}, async: ${asyncRead}`);
      assert.deepEqual(f.events, [...(waitMs > 0 ? [`sleep:${waitMs}`] : []), `stamp:${1_000_000 + waitMs}`]);
    }
  }
});

test("W1-T7957: an inherited advisory floor does not wait", { timeout: 180_000 }, async (t) => {
  const result = runNextTaskId(t, "advisory");
  assert.deepEqual(result.sleeps, [], "the read is not held to the window");
  assert.ok(result.stderr.includes("advisory, W1-T3297"), result.stderr);
  assert.ok(!result.stderr.includes("(wait, W1-T7957)"), result.stderr);
  const f = fixture(t);
  f.env.RMD_GH_TRANSPORT_FLOOR = "enforce";
  await withGhTransportFloorMode("wait", () => {
    assert.throws(() => applyGhReadCadence(["api", "repos/o/r/pulls"], f.deps), GhReadCadenceRefusal);
  }, f.env);
  assert.deepEqual(f.events, []);
  assert.equal(f.env.RMD_GH_TRANSPORT_FLOOR, "enforce");
});

test("W1-T7957: the shared cooldown applies to enforced and advisory reads", async (t) => {
  for (const asyncRead of [false, true]) {
    for (const mode of ["enforce", "advisory"] as const) {
      for (const cooldown of ["240", "0"]) {
        resetGhCadenceAdvisoryForTest();
        const f = fixture(t, cooldown, 200_000);
        f.env.RMD_GH_TRANSPORT_FLOOR = mode;
        const read = () => asyncRead
          ? applyGhReadCadenceAsync(["api", "repos/o/r/pulls"], f.deps)
          : applyGhReadCadence(["api", "repos/o/r/pulls"], f.deps);
        if (mode === "enforce" && cooldown === "240") {
          if (asyncRead) await assert.rejects(async () => await read(), GhReadCadenceRefusal);
          else assert.throws(read, GhReadCadenceRefusal);
          assert.deepEqual(f.events, []);
        } else {
          const decision = await read();
          assert.equal(decision.windowS, Number(cooldown));
          assert.equal(decision.paced, cooldown === "240");
          assert.deepEqual(f.events, ["stamp:1000000"]);
        }
        assert.equal(f.warnings.length, mode === "advisory" && cooldown === "240" ? 1 : 0);
        assert.equal(existsSync(`${f.path}.lock`), false);
      }
    }
  }
});
