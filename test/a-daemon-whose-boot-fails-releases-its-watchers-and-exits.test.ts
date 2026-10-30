import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as flush } from "node:timers/promises";
import { test } from "node:test";
import { daemonCommand } from "#test/helpers/run-task-daemon.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
import { startReadPlaneTelemetry } from "#src/lib/read-plane.js";

type Deps = NonNullable<Parameters<typeof daemonCommand>[1]>;
const stopped = { attempted: [], merged: [], stopReason: "stopped" as const, costUsd: 0, ticks: 0 };
const listeners = () => [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
const watchers = () => process.getActiveResourcesInfo().filter((name) => name === "FSEventWrap").length;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "rmd-boot-cleanup-"));
  mkdirSync(join(root, "state"));
  const plan = join(root, "tasks.yaml");
  writeFileSync(plan, "[]\n");
  const initialListeners = { SIGINT: process.listeners("SIGINT"), SIGTERM: process.listeners("SIGTERM") };
  type WatchHandle = { constructor: { name: string }; close(): void };
  const handles = () => (process as unknown as { _getActiveHandles(): WatchHandle[] })._getActiveHandles();
  const initialHandles = new Set(handles());
  const deps: Deps = {
    config: { root, claudeBin: "/bin/true" }, repoRoot: REPO_ROOT,
    startGithubAppRefresh: () => ({ armed: false }),
    applyMemoryPolicy: () => ({ heap_growing_percent: 10 }),
    daemonBoot: async () => ({ env_clean: true, billing_mode: "subscription", node_path: process.execPath, node_version: process.version }), checkPause: () => undefined, checkStop: () => undefined,
    readRunChildMode: () => "off", runDaemon: async () => stopped,
    bootClaimReserver: { mintAnchor: () => "fixture", attempt: () => "unreachable",
      holder: () => undefined, drop: () => false, list: () => [] },
    buildSweepHook: () => async () => {}, buildSweepLightHook: () => async () => {},
  };
  return {
    root, deps, lock: join(root, "state", "drain.lock"),
    run: (overrides: Deps = {}) => daemonCommand(["--allow-self-target", "--plan", plan, "--max", "0"], { ...deps, ...overrides }),
    rows: () => readFileSync(join(root, "state", "ledger.ndjson"), "utf8").trim().split("\n").map((line) => JSON.parse(line)),
    cleanup: async () => {
      // Keep a deliberately broken implementation from hanging this test runner during falsification.
      for (const handle of handles()) if (!initialHandles.has(handle) && handle.constructor.name === "FSWatcher") handle.close();
      for (const signal of ["SIGINT", "SIGTERM"] as const) {
        for (const listener of process.listeners(signal)) if (!initialListeners[signal].includes(listener)) process.removeListener(signal, listener);
      }
      await flush();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("W1-T9909: a boot that throws on an unreadable union releases its watcher and exits", async () => {
  const f = fixture();
  const beforeWatchers = watchers();
  const beforeListeners = listeners();
  const archive = join(f.root, "state", "ledger.2026-10-01.ndjson.gz");
  writeFileSync(archive, "not a gzip archive");
  let probed = false;
  try {
    await assert.rejects(f.run({ readRunChildMode: () => {
      probed = true;
      assert.equal(watchers(), beforeWatchers + 1, "positive control: the real watcher is armed before the refusal");
      assert.deepEqual(listeners(), beforeListeners.map((count) => count + 1));
      assert.equal(existsSync(f.lock), true);
      return "auto";
    } }), /run child settlements unreadable:/);
    assert.equal(probed, true);
    await flush();
    await flush();
    assert.equal(watchers(), beforeWatchers);
    assert.deepEqual(listeners(), beforeListeners);
    assert.equal(existsSync(f.lock), false);
  } finally {
    await f.cleanup();
  }
});

test("W1-T9909: the boot error propagates and a failed release is ledgered", async () => {
  const f = fixture();
  const bootError = new Error("boot refused by fixture");
  let closes = 0;
  const beforeListeners = listeners();
  try {
    await assert.rejects(f.run({
      wireSweepWake: () => ({ sleep: async () => "timeout", acknowledge: () => {}, close: () => {
        closes++;
        throw new Error("watcher close failed");
      } }),
      daemonBoot: async () => { throw bootError; },
    }), (error) => error === bootError);
    assert.equal(closes, 1);
    assert.deepEqual(listeners(), beforeListeners);
    assert.equal(existsSync(f.lock), false, "a failed watcher release cannot skip the lock release");
    assert.ok(f.rows().some((row) => row.step === "daemon.cleanup_failed" && row.resource === "github_event_wake" && row.error === "Error: watcher close failed"));
  } finally {
    await f.cleanup();
  }
});

function resources(failedRelease?: string) {
  const released = { wake: 0, socket: 0, read: 0, telemetry: 0, memory: 0 };
  const release = (key: keyof typeof released) => {
    released[key]++;
    if (key === failedRelease) throw new Error(`${key} release failed`);
  };
  const deps: Deps = {
    wireSweepWake: () => ({ sleep: async () => "timeout", acknowledge: () => {}, close: () => { release("wake"); } }),
    startGitCredentialSocket: async () => ({ socketPath: "/fixture/socket", close: async () => { release("socket"); } }),
    startReadPlane: () => ({ read: async () => { throw new Error("unexpected read"); }, stop: async () => { release("read"); } }),
    startLoopTelemetry: () => {
      const telemetry = startReadPlaneTelemetry();
      return { ...telemetry, stop: () => { telemetry.stop(); release("telemetry"); } };
    },
    startMemoryCensus: () => () => { release("memory"); },
  };
  return { released, deps };
}

test("W1-T9909: a normal stop releases each resource once", async () => {
  const f = fixture();
  const r = resources();
  const beforeListeners = listeners();
  try {
    assert.equal(await f.run({ ...r.deps, runDaemon: async () => {
      assert.equal(existsSync(f.lock), true);
      assert.deepEqual(r.released, { wake: 0, socket: 0, read: 0, telemetry: 0, memory: 0 });
      assert.deepEqual(listeners(), beforeListeners.map((count) => count + 1));
      writeFileSync(join(f.root, "state", "STOP"), "stop");
      return stopped;
    } }), 0);
    assert.deepEqual(r.released, { wake: 1, socket: 1, read: 1, telemetry: 1, memory: 1 });
    assert.equal(existsSync(join(f.root, "state", "STOP")), false);
    assert.deepEqual(listeners(), beforeListeners);
    assert.equal(existsSync(f.lock), false);
  } finally {
    await f.cleanup();
  }
});

for (const [factory, expected] of [
  ["startGitCredentialSocket", { wake: 1, socket: 0, read: 0, telemetry: 0, memory: 0 }],
  ["startReadPlane", { wake: 1, socket: 1, read: 0, telemetry: 0, memory: 0 }],
  ["startLoopTelemetry", { wake: 1, socket: 1, read: 1, telemetry: 0, memory: 0 }],
  ["startMemoryCensus", { wake: 1, socket: 1, read: 1, telemetry: 1, memory: 0 }],
] as const) {
  test(`a failure in ${factory} releases only acquired resources`, async () => {
    const f = fixture();
    const r = resources();
    const bootError = new Error(`${factory} refused`);
    const beforeListeners = listeners();
    try {
      await assert.rejects(f.run({ ...r.deps, [factory]: () => { throw bootError; } }), (error) => error === bootError);
      assert.deepEqual(r.released, expected);
      assert.deepEqual(listeners(), beforeListeners);
      assert.equal(existsSync(f.lock), false);
    } finally {
      await f.cleanup();
    }
  });
}

for (const [failedRelease, resource] of [
  ["read", "read_plane"], ["telemetry", "loop_telemetry"], ["memory", "memory_census"],
  ["wake", "github_event_wake"], ["socket", "git_credential_socket"],
] as const) {
  test(`a failed ${resource} release preserves the loop error and releases its siblings`, async () => {
    const f = fixture();
    const r = resources(failedRelease);
    const loopError = new Error("loop failed");
    try {
      await assert.rejects(f.run({ ...r.deps, runDaemon: async () => { throw loopError; } }), (error) => error === loopError);
      assert.deepEqual(r.released, { wake: 1, socket: 1, read: 1, telemetry: 1, memory: 1 });
      assert.equal(existsSync(f.lock), false);
      assert.ok(f.rows().some((row) => row.step === "daemon.cleanup_failed" && row.resource === resource && row.error === `Error: ${failedRelease} release failed`));
      if (failedRelease === "socket") assert.ok(f.rows().some((row) => row.reason === "git credential socket did not close: Error: socket release failed"));
    } finally {
      await f.cleanup();
    }
  });
}

test("a boot failure before watcher acquisition still releases the drain lock", async () => {
  const f = fixture();
  const bootError = new Error("wake wiring failed");
  const r = resources();
  const beforeListeners = listeners();
  try {
    await assert.rejects(f.run({ ...r.deps, wireSweepWake: () => { throw bootError; } }), (error) => error === bootError);
    assert.deepEqual(r.released, { wake: 0, socket: 0, read: 0, telemetry: 0, memory: 0 });
    assert.deepEqual(listeners(), beforeListeners);
    assert.equal(existsSync(f.lock), false);
  } finally {
    await f.cleanup();
  }
});
