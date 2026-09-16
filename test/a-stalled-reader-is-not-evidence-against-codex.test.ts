import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { clearCodexCapacityCache, readCodexCapacity } from "../src/lib/worker-provider.js";
import type { Config } from "../src/lib/config-schema.js";

// W1-T3690. MEASURED on the fleet 2026-09-16, inside the daemon's own container: `codex
// app-server --listen stdio://` answers `initialize` in 366ms with the daemon's exact filtered
// env, while the daemon reported BOTH the primary and the hedge "timed out after 10000ms;
// unfinished: initialize". Blocking the event loop for 12s reproduces that string against a
// perfectly healthy child -- because Node runs the timers phase BEFORE the poll phase that
// delivers stdout, so a blocked loop fires the deadline before reading a reply that already
// arrived. The wall time is the discriminator: 12000ms elapsed against a 10000ms budget.

function fakeChild(replyAfterMs: number) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter; stderr: EventEmitter; stdin: { write: (s: string) => void }; kill: () => void;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  child.stdin = {
    write: () => {
      // A NEVER-REPLYING child schedules nothing: a pending timer would hold the loop open and
      // the test runner would never exit.
      if (!Number.isFinite(replyAfterMs)) return;
      const t = setTimeout(() => {
        child.stdout.emit("data", Buffer.from(JSON.stringify({ id: 1, result: { codexHome: "/x" } }) + "\n"));
      }, replyAfterMs);
      t.unref();
    },
  };
  return child;
}

// codexBin points at a real executable only to satisfy resolveCodexBin's X_OK check; the spawn
// is injected below, so this binary is never actually run.
const CONFIG = {
  claudeBin: "/unused/claude",
  root: "/tmp",
  workerProviders: { enabled: ["codex"], codexBin: "/bin/sh" },
} as unknown as Config;

test("W1-T3690: a deadline that fires LATE is reported as this process stalling, not as Codex timing out", async () => {
  clearCodexCapacityCache();
  // The child never replies, and the monotonic source reports the deadline firing 3s late --
  // exactly what a blocked loop looks like from inside the timer callback.
  // A MONOTONIC SOURCE THAT ALWAYS SHOWS A LARGE GAP. Primary and hedge share one blocked loop in
  // reality, so both must observe an overrun; a source that alternated would starve only one and
  // let the other report an ordinary timeout.
  let tick = 0;
  const monotonic = () => (tick += 13_000) - 13_000;
  const capacity = await readCodexCapacity(CONFIG, {
    resolveEnv: { PATH: "/usr/bin" } as NodeJS.ProcessEnv,
    // deliberately never replies
    spawn: (() => fakeChild(Number.POSITIVE_INFINITY)) as never,
    timeoutMs: 10,
    monotonicNow: monotonic,
    forceRefresh: true,
  } as never);
  assert.equal(capacity.readable, false);
  assert.match(
    String(capacity.detail),
    /deadline overran/,
    `a late deadline must name the stall, got: ${capacity.detail}`,
  );
  assert.match(String(capacity.detail), /this process was stalled/);
  // AND IT MUST NOT CLAIM THE APP-SERVER TIMED OUT -- that is the false accusation this fixes.
  assert.doesNotMatch(String(capacity.detail), /app-server timed out after/);
});

test("W1-T3690: an ON-TIME deadline still reports an ordinary app-server timeout", async () => {
  clearCodexCapacityCache();
  const monotonic = () => 0; // never advances: the deadline fired on time
  const capacity = await readCodexCapacity(CONFIG, {
    resolveEnv: { PATH: "/usr/bin" } as NodeJS.ProcessEnv,
    spawn: (() => fakeChild(Number.POSITIVE_INFINITY)) as never,
    timeoutMs: 10,
    monotonicNow: monotonic,
    forceRefresh: true,
  } as never);
  assert.equal(capacity.readable, false);
  assert.match(String(capacity.detail), /app-server timed out after/, "a punctual deadline is a real timeout");
  assert.doesNotMatch(String(capacity.detail), /deadline overran/);
});

test("W1-T3690: a starved read buys NO failure backoff, so the next tick may read again", async () => {
  clearCodexCapacityCache();
  let spawns = 0;
  let calls = 0;
  const deps = {
    resolveEnv: { PATH: "/usr/bin" } as NodeJS.ProcessEnv,
    spawn: (() => { spawns++; return fakeChild(Number.POSITIVE_INFINITY); }) as never,
    timeoutMs: 10,
    monotonicNow: (() => { let t = 0; return () => (t += 13_000) - 13_000; })(),
    now: () => 1_000,
  };
  const first = await readCodexCapacity(CONFIG, deps as never);
  assert.match(String(first.detail), /deadline overran/);
  const spawnsAfterFirst = spawns;
  // A backed-off failure short-circuits WITHOUT spawning. If the starved read had been cached,
  // this second call would return "failure backoff ... retry in ..." and spawn nothing.
  const second = await readCodexCapacity(CONFIG, deps as never);
  assert.ok(spawns > spawnsAfterFirst, "a starved read must not suppress the next attempt");
  assert.doesNotMatch(String(second.detail), /failure backoff/, "starvation must not buy a backoff window");
});
