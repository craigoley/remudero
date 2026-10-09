import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import {
  applyGhReadCadence,
  applyGhReadCadenceAsync,
  GH_APP_READ_BUCKET,
  GhReadCadenceRefusal,
  ghReadCadenceStampPath,
  readGhReadCadenceStampMs,
  resetGhCadenceAdvisoryForTest,
  routeInteractiveGhRead,
  stampGhRead,
} from "../src/lib/github-transport.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

function cache() {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}gh-interactive-cadence-`));
  const env = { XDG_CACHE_HOME: dir, RMD_GH_SHARED_READ_GAP_MS: "30" };
  return { dir, env };
}

describe("test/an-interactive-gh-read-awaits-its-cadence.test.ts", () => {
  for (const outcome of ["minted", "unconfigured", "rejected", "missing-token"] as const) {
    test(`interactive ${outcome} routing lets timers tick before stamping its cadence gap`, async () => {
      const { dir, env } = cache();
      const stamp = ghReadCadenceStampPath(env, outcome === "minted" ? GH_APP_READ_BUCKET : undefined)!;
      stampGhRead(stamp);
      const nowMs = readGhReadCadenceStampMs(stamp)!;
      let ticks = 0;
      let ticksAtStamp = 0;
      const timer = setInterval(() => ticks += 1, 1);
      try {
        const route = await routeInteractiveGhRead(["pr", "view", "123"], {
          env,
          nowMs: () => nowMs,
          warn: () => {},
          mint: async () => {
            if (outcome === "rejected") throw new Error("mint unavailable");
            return outcome === "minted" ? { ok: true, token: "app-token" }
              : { ok: outcome === "missing-token" };
          },
          stamp: (path) => {
            assert.equal(path, stamp);
            ticksAtStamp = ticks;
            stampGhRead(path);
          },
        });
        assert.ok(ticksAtStamp > 0, "a timer must fire during the gap, before the read stamps");
        assert.equal(route.decision.allow, true);
        assert.equal(route.usesAppToken, outcome === "minted");
        assert.deepEqual(route.envOverlay, outcome === "minted" ? { GH_TOKEN: "app-token" } : {});
        assert.equal(existsSync(`${stamp}.lock`), false);
      } finally {
        clearInterval(timer);
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  test("a sync read beside its own async holder skips every sleep and advises once", async (t) => {
    const { dir, env } = cache();
    const stamp = ghReadCadenceStampPath(env)!;
    stampGhRead(stamp);
    let latest = readGhReadCadenceStampMs(stamp)!;
    const warnings: string[] = [];
    const syncSleeps: number[] = [];
    const stamped: Array<string | undefined> = [];
    let entered!: () => void;
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => entered = resolve);
    const gap = new Promise<void>((resolve) => release = resolve);
    resetGhCadenceAdvisoryForTest();
    const deps = {
      env,
      nowMs: () => latest,
      readStampMs: () => latest,
      stamp: (path: string | undefined) => void stamped.push(path),
    };
    const holder = applyGhReadCadenceAsync(["pr", "view", "123"], {
      ...deps,
      warn: () => {},
      sleep: async (ms) => {
        assert.equal(ms, 30);
        entered();
        await gap;
      },
    });
    try {
      await waiting;
      assert.equal(existsSync(`${stamp}.lock`), true, "the async read really holds the file lock");
      t.mock.method(process.stderr, "write", (line: string) => {
        warnings.push(line.trimEnd());
        return true;
      });
      const syncDeps = {
        ...deps,
        warn: (line: string) => void warnings.push(line),
        sleepSync: (ms: number) => {
          syncSleeps.push(ms);
          assert.fail("the sync read must not sleep for either the lock or gap");
        },
      };
      assert.equal(applyGhReadCadence(["pr", "view", "124"], {
        ...deps,
        sleepSync: syncDeps.sleepSync,
      }).allow, true);
      assert.equal(applyGhReadCadence(["pr", "view", "125"], syncDeps).allow, true);
      assert.deepEqual(syncSleeps, [], "even a sleep error swallowed by the lock loop is detected");
      assert.deepEqual(stamped, [stamp, stamp], "both sync reads run before the holder is released");
      assert.equal(warnings.length, 1);
      assert.match(warnings[0]!, /same process.*async read/);
      assert.equal(existsSync(`${stamp}.lock`), true, "the sync read leaves its holder's lock intact");
      assert.throws(() => applyGhReadCadence(["pr", "view", "127"], {
        ...syncDeps,
        env: { ...env, RMD_GH_TRANSPORT_FLOOR: "enforce" },
      }), GhReadCadenceRefusal, "bypassing the wait does not bypass an enforce-mode refusal");
      assert.deepEqual(stamped, [stamp, stamp], "a refused read must not stamp");

      const otherEnv = { XDG_CACHE_HOME: join(dir, "other"), RMD_GH_SHARED_READ_GAP_MS: "0" };
      const otherLock = `${ghReadCadenceStampPath(otherEnv)!}.lock`;
      mkdirSync(otherLock, { recursive: true });
      const otherSleeps: number[] = [];
      applyGhReadCadence(["pr", "view", "128"], {
        env: otherEnv,
        warn: () => {},
        sleepSync: (ms) => {
          otherSleeps.push(ms);
          rmdirSync(otherLock);
        },
      });
      assert.deepEqual(otherSleeps, [25], "the async queue only bypasses waits for its own stamp path");
      release();
      await holder;
      assert.deepEqual(stamped, [stamp, stamp, stamp]);
      assert.equal(existsSync(`${stamp}.lock`), false);

      latest += 1;
      const sleeps: number[] = [];
      applyGhReadCadence(["pr", "view", "126"], {
        ...syncDeps,
        sleepSync: (ms) => void sleeps.push(ms),
      });
      assert.deepEqual(sleeps, [30], "after the queue drains, a foreign stamp is paced again");
      assert.equal(warnings.length, 1);
    } finally {
      release();
      await holder;
      t.mock.restoreAll();
      resetGhCadenceAdvisoryForTest();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a sync read still polls a lock without a same-process async holder", () => {
    const { dir, env } = cache();
    env.RMD_GH_SHARED_READ_GAP_MS = "0";
    const stamp = ghReadCadenceStampPath(env)!;
    const lock = `${stamp}.lock`;
    mkdirSync(lock, { recursive: true });
    const sleeps: number[] = [];
    try {
      const decision = applyGhReadCadence(["pr", "view", "123"], {
        env,
        warn: () => {},
        sleepSync: (ms) => {
          sleeps.push(ms);
          rmdirSync(lock);
        },
      });
      assert.equal(decision.allow, true);
      assert.deepEqual(sleeps, [25], "a foreign holder still takes the ordinary lock retry path");
      assert.notEqual(readGhReadCadenceStampMs(stamp), undefined);
      assert.equal(existsSync(lock), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
