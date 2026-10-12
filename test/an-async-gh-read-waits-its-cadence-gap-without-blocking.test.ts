// W1-T4970 — AN ASYNC GH READ MUST NOT SLEEP THE WHOLE DAEMON LOOP FOR ITS CADENCE GAP.
//
// `ghJsonAsync` and `ghTextAsync` exist so a daemon read does not block, yet both paced through
// `applyGhReadCadence`, whose shared read gap and lock wait call `Atomics.wait` on the event loop.
// These tests count event-loop timer ticks while an async read waits; a blocking wait counts zero.
// No assertion reads a wall clock: the clock is injected where the gap arithmetic reads it.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, rmdirSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { ghShim } from "./helpers/gh-shim.js";

import {
  applyGhReadCadenceAsync,
  ghReadCadenceStampPath,
  ghTextAsync,
  readGhReadCadenceStampMs,
  stampGhRead,
} from "../src/lib/github-transport.js";

/** A self-rescheduling zero-delay timer: it can only advance while the event loop is free. */
function startTimerProbe(): { ticks(): number; stop(): void } {
  let ticks = 0;
  let live = true;
  let handle: NodeJS.Timeout | undefined;
  const spin = (): void => {
    if (!live) return;
    ticks += 1;
    handle = setTimeout(spin, 0);
  };
  handle = setTimeout(spin, 0);
  return {
    ticks: () => ticks,
    stop: () => {
      live = false;
      if (handle !== undefined) clearTimeout(handle);
    },
  };
}

/** A cache root whose shared stamp was just written by a "sibling" process: its mtime is the
 *  injected now, so the whole shared gap remains. */
function siblingStampedCache(label: string, gapMs: string): { dir: string; env: NodeJS.ProcessEnv; stamp: string; nowMs: number } {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}gh-async-gap-${label}-`));
  const env = { XDG_CACHE_HOME: dir, RMD_GH_SHARED_READ_GAP_MS: gapMs } as NodeJS.ProcessEnv;
  const stamp = ghReadCadenceStampPath(env) as string;
  stampGhRead(stamp);
  const nowMs = readGhReadCadenceStampMs(stamp) as number;
  return { dir, env, stamp, nowMs };
}

test("W1-T4970: a timer fires while an async read waits out the shared read gap", async () => {
  const { dir, env, stamp, nowMs } = siblingStampedCache("tick", "30");
  const probe = startTimerProbe();
  let ticksAtStamp: number | undefined;
  try {
    const ticksAtStart = probe.ticks();
    // The DEFAULT sleep — the one ghJsonAsync really uses. Only the clock is injected, so the
    // sibling stamp reads as zero milliseconds old and the full 30 ms gap is owed.
    await applyGhReadCadenceAsync(["api", "repos/o/r/pulls/1"], {
      env,
      nowMs: () => nowMs,
      warn: () => {},
      stamp: (path) => {
        ticksAtStamp = probe.ticks() - ticksAtStart;
        stampGhRead(path);
      },
    });
    assert.notEqual(ticksAtStamp, undefined, "the read must reach its stamp");
    assert.ok(
      (ticksAtStamp as number) > 0,
      `the event loop must keep firing timers while the read waits its gap (ticks: ${ticksAtStamp})`,
    );
    assert.equal(existsSync(`${stamp}.lock`), false, "the async read must release the shared lock");
  } finally {
    probe.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T4970: the async read still stamps the shared window after its gap", async () => {
  const { dir, env, stamp, nowMs } = siblingStampedCache("stamp", "40");
  const events: string[] = [];
  try {
    const foreign = readGhReadCadenceStampMs(stamp);
    const deps = {
      env,
      nowMs: () => nowMs,
      warn: () => {},
      sleep: async (ms: number): Promise<void> => {
        events.push(`sleep:${ms}`);
        // The stamp has not moved yet: the slot is taken only once the gap is over.
        assert.equal(readGhReadCadenceStampMs(stamp), foreign, "the stamp must not move before the gap ends");
        await new Promise<void>((resolve) => setImmediate(resolve));
      },
      stamp: (path: string | undefined) => {
        events.push("stamp");
        stampGhRead(path);
      },
    };
    const decision = await applyGhReadCadenceAsync(["api", "repos/o/r/pulls/2"], deps);
    assert.equal(decision.allow, true, "advisory mode allows the paced read");
    assert.deepEqual(events, ["sleep:40", "stamp"], "the full shared gap is awaited, then the window is stamped");
    assert.notEqual(readGhReadCadenceStampMs(stamp), undefined, "the shared window carries the new stamp");
    // The stamp is now this process's own: a second read in the same process owes no sibling gap.
    events.length = 0;
    await applyGhReadCadenceAsync(["api", "repos/o/r/pulls/2"], deps);
    assert.deepEqual(events, ["stamp"], "a process never waits on its own freshly written stamp");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("concurrent async reads in one process queue behind each other instead of racing the lock", async () => {
  const { dir, env, nowMs } = siblingStampedCache("queue", "20");
  const sleeps: number[] = [];
  try {
    const deps = {
      env,
      nowMs: () => nowMs,
      warn: () => {},
      sleep: async (ms: number): Promise<void> => {
        sleeps.push(ms);
        await new Promise<void>((resolve) => setImmediate(resolve));
      },
    };
    await Promise.all([
      applyGhReadCadenceAsync(["api", "repos/o/r/pulls/3"], deps),
      applyGhReadCadenceAsync(["api", "repos/o/r/pulls/4"], deps),
    ]);
    // Only the first owes the sibling gap; the second runs after it and finds this process's stamp.
    // Racing instead, the second would spin on the file lock this same process holds.
    assert.deepEqual(sleeps, [20], "the second read must wait for the first, not poll the lock");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an async read waits on a sibling's lock with timers still firing, then takes the lock", async () => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}gh-async-lock-`));
  try {
    const env = { XDG_CACHE_HOME: dir, RMD_GH_SHARED_READ_GAP_MS: "0" } as NodeJS.ProcessEnv;
    const stamp = ghReadCadenceStampPath(env) as string;
    const lock = `${stamp}.lock`;
    mkdirSync(lock, { recursive: true });
    let siblingReleased = false;
    // The sibling releases its lock from a TIMER. A blocked loop cannot run it, so a blocking lock
    // wait would give up and read while the sibling still held the lock.
    setTimeout(() => {
      rmdirSync(lock);
      siblingReleased = true;
    }, 5);
    let releasedAtStamp: boolean | undefined;
    await applyGhReadCadenceAsync(["api", "repos/o/r/pulls/5"], {
      env,
      warn: () => {},
      stamp: (path) => {
        releasedAtStamp = siblingReleased;
        stampGhRead(path);
      },
    });
    assert.equal(releasedAtStamp, true, "the read must run only after the sibling released the lock");
    assert.equal(existsSync(lock), false, "the read releases the lock it took");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an async read reclaims a stale sibling lock without waiting", async () => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}gh-async-stale-`));
  try {
    const env = { XDG_CACHE_HOME: dir } as NodeJS.ProcessEnv;
    const lock = `${ghReadCadenceStampPath(env) as string}.lock`;
    mkdirSync(lock, { recursive: true });
    utimesSync(lock, 1, 1);
    const sleeps: number[] = [];
    await applyGhReadCadenceAsync(["api", "repos/o/r"], {
      env,
      warn: () => {},
      sleep: async (ms) => void sleeps.push(ms),
    });
    assert.equal(existsSync(lock), false, "a stale owner cannot hold the shared cadence lock forever");
    assert.deepEqual(sleeps, [], "a stale lock is reclaimed without waiting for its former owner");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an async read fails open after bounded contention on an unreadable lock", async () => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}gh-async-unreadable-`));
  try {
    const env = { XDG_CACHE_HOME: dir, RMD_GH_SHARED_READ_GAP_MS: "0" } as NodeJS.ProcessEnv;
    const stamp = ghReadCadenceStampPath(env) as string;
    mkdirSync(join(dir, "remudero"), { recursive: true });
    symlinkSync("missing-lock-target", `${stamp}.lock`);
    const sleeps: number[] = [];
    await applyGhReadCadenceAsync(["api", "repos/o/r"], {
      env,
      warn: () => {},
      sleep: async (ms) => {
        sleeps.push(ms);
        await new Promise<void>((resolve) => setImmediate(resolve));
      },
    });
    assert.ok(sleeps.length > 0, "unreadable contention still uses the bounded retry path before failing open");
    assert.notEqual(readGhReadCadenceStampMs(stamp), undefined, "the read proceeds and stamps after giving up");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an async read with an unwritable cache root runs without a lock instead of throwing", async () => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}gh-async-unwritable-`));
  try {
    const fileParent = join(dir, "file-parent");
    writeFileSync(fileParent, "");
    const env = { XDG_CACHE_HOME: fileParent } as NodeJS.ProcessEnv;
    const stamped: Array<string | undefined> = [];
    const decision = await applyGhReadCadenceAsync(["api", "repos/o/r"], {
      env,
      warn: () => {},
      stamp: (path) => void stamped.push(path),
    });
    assert.equal(decision.allow, true);
    assert.deepEqual(stamped, [ghReadCadenceStampPath(env)], "the read is still stamped (fail open)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an async read whose lock vanished before release still completes", async () => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}gh-async-release-`));
  try {
    const env = { XDG_CACHE_HOME: dir } as NodeJS.ProcessEnv;
    const stamp = ghReadCadenceStampPath(env) as string;
    const decision = await applyGhReadCadenceAsync(["api", "repos/o/r"], {
      env,
      warn: () => {},
      stamp: (path) => {
        // Something removed the lock out from under the holder; the release must not throw.
        rmdirSync(`${stamp}.lock`);
        stampGhRead(path);
      },
    });
    assert.equal(decision.allow, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an async write and the budget probe need no shared coordination and stamp nothing", async () => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}gh-async-write-`));
  try {
    const env = { XDG_CACHE_HOME: dir } as NodeJS.ProcessEnv;
    const stamp = ghReadCadenceStampPath(env) as string;
    await applyGhReadCadenceAsync(["pr", "create", "--title", "x"], { env, warn: () => {} });
    await applyGhReadCadenceAsync(["api", "rate_limit"], { env, warn: () => {} });
    assert.equal(readGhReadCadenceStampMs(stamp), undefined, "neither a write nor the probe stamps the window");
    assert.equal(existsSync(`${stamp}.lock`), false, "neither takes the shared lock");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ghTextAsync paces its real transport through the async cadence and stamps the window", async () => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}gh-async-text-`));
  const shim = ghShim([{ when: "actions/jobs/9/logs", stdout: "plain log line" }], { kind: "async-text" });
  const saved = { xdg: process.env.XDG_CACHE_HOME, path: process.env.PATH, gap: process.env.RMD_GH_SHARED_READ_GAP_MS };
  try {
    process.env.XDG_CACHE_HOME = dir;
    process.env.RMD_GH_SHARED_READ_GAP_MS = "0";
    process.env.PATH = `${shim.dir}:${saved.path ?? ""}`;
    const body = await ghTextAsync(["api", "repos/o/r/actions/jobs/9/logs"]);
    assert.equal(body, "plain log line\n");
    assert.equal(shim.calls().length, 1);
    assert.notEqual(readGhReadCadenceStampMs(ghReadCadenceStampPath(process.env)), undefined, "the real read is stamped");
  } finally {
    for (const [key, value] of [
      ["XDG_CACHE_HOME", saved.xdg],
      ["PATH", saved.path],
      ["RMD_GH_SHARED_READ_GAP_MS", saved.gap],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(shim.dir, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});
