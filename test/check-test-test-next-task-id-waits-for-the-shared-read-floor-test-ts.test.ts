import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { systemClock } from "#src/lib/clock.js";
import {
  applyGhReadCadence, applyGhReadCadenceAsync, ghReadCadenceStampPath,
  readGhReadCadenceStampMs, resetGhCadenceAdvisoryForTest, stampGhRead,
  withGhTransportFloorMode,
} from "#src/lib/github-transport.js";

test("W1-T10012: check:test:test/next-task-id-waits-for-the-shared-read-floor.test.ts is prevented, not retried", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-floor-clock-"));
  const previousNow = systemClock.now;
  t.after(() => {
    systemClock.now = previousNow;
    resetGhCadenceAdvisoryForTest();
    rmSync(dir, { recursive: true, force: true });
  });
  for (const asyncRead of [false, true]) {
    for (const mode of ["wait", "advisory"] as const) {
      const env = {
        RMD_GH_CACHE_HOME: join(dir, `${mode}-${asyncRead}`),
        RMD_GH_COOLDOWN_S: "180",
        RMD_GH_SHARED_READ_GAP_MS: "0",
        RMD_GH_TRANSPORT_FLOOR: mode,
      };
      const path = ghReadCadenceStampPath(env)!;
      let now = 1_000_000;
      systemClock.now = () => now;
      stampGhRead(path);
      assert.equal(readGhReadCadenceStampMs(path), now, "the default stamp uses the cadence clock");
      now += 120_000;
      const sleeps: number[] = [];
      const warnings: string[] = [];
      const sleep = (ms: number) => {
        assert.equal(existsSync(`${path}.lock`), false, "floor waits release the shared lock");
        assert.equal(readGhReadCadenceStampMs(path), 1_000_000, "waiting must precede restamping");
        sleeps.push(ms);
        now += ms;
      };
      resetGhCadenceAdvisoryForTest();
      const deps = { env, sleepSync: sleep, sleep: async (ms: number) => sleep(ms),
        warn: (line: string) => void warnings.push(line) };
      await withGhTransportFloorMode("wait", async () => {
        const decision = asyncRead
          ? await applyGhReadCadenceAsync(["api", "repos/o/r/pulls"], deps)
          : applyGhReadCadence(["api", "repos/o/r/pulls"], deps);
        assert.equal(decision.allow, true);
        assert.equal(decision.paced, true);
        assert.deepEqual(sleeps, mode === "wait" ? [60_000] : []);
        assert.equal(readGhReadCadenceStampMs(path), now);
        assert.equal(warnings.length, 1);
        assert.ok(warnings[0].includes(mode === "wait" ? "(wait, W1-T7957)" : "advisory, W1-T3297"));
      }, env);
      assert.equal(existsSync(`${path}.lock`), false);
    }
  }
});
