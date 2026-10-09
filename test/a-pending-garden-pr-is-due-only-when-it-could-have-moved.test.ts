import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { clockFromMillisFn } from "../src/lib/clock.js";
import {
  GARDEN_DECISION_PENDING_RELEASE_MS, gardenPassDue, gardenPendingSignal, gardenPendingWatchPath, gardenStatePath, runGarden,
  type GardenAction, type GardenCheckout, type GardenerDeps, type GardenSpec,
} from "../src/lib/gardener.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

// OBSERVED 2026-10-09 on the fleet host: gate and export answered "due" on every 60 s poll while a PR was
// pending, about 55-60 passes an hour each and about 550 s of child CPU an hour, and each such pass only asked
// GitHub whether the PR had settled.

const PR = "https://github.com/o/r/pull/7";
const classes = ["a"] as const;
type C = typeof classes[number];

function fixture(t: { after: (fn: () => void) => void }, extra: Record<string, unknown> = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}pending-pace-`));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  writeFileSync(gardenStatePath(stateDir, "probe"), JSON.stringify({
    classes: { a: { alpha: 3, beta: 1 } }, lastCheap: "same",
    pending: { prUrl: PR, actionClass: "a", baseline: { trials: 0, successes: 0 } }, ...extra,
  }));
  let now = Date.parse("2026-10-09T12:00:00.000Z");
  const world = { head: "aaa", open: true, main: "m1", ghReads: 0 };
  const signal = (prUrl: string) => gardenPendingSignal(prUrl,
    world.open ? [{ url: PR, headRefOid: world.head, updatedAt: `u-${world.head}` }] : [], world.main);
  const deps: GardenerDeps = {
    stateDir, repoRoot: stateDir, clock: clockFromMillisFn(() => now), pendingSignal: signal,
    openWorkspace: () => { throw new Error("a pending pass files nothing"); },
    log: () => {},
    prState: () => (world.ghReads += 1, world.open ? "open" : "merged"),
  };
  const spec: GardenSpec<C, unknown, GardenAction<C>, GardenCheckout> = {
    name: "probe", classes, cheapFingerprint: () => "same",
    inventory: () => { throw new Error("an unchanged pending pass reads no inventory"); },
    fingerprint: () => "f", candidates: () => [], scorecard: () => ({}), apply: () => undefined,
  };
  return { stateDir, deps, spec, world, tick: (ms: number) => { now += ms; } };
}

/** Poll once a minute for `minutes`, running a pass whenever the probe says due. */
function poll(f: ReturnType<typeof fixture>, minutes: number): number {
  let passes = 0;
  for (let i = 0; i < minutes; i++) {
    if (gardenPassDue(f.spec, f.deps)) {
      runGarden(f.spec, f.deps);
      passes += 1;
    }
    f.tick(60_000);
  }
  return passes;
}

test("a pending garden PR with nothing moved backs off, and snaps back when its head, its open row or main moves", (t) => {
  const f = fixture(t);
  const quietHour = poll(f, 60);
  assert.ok(quietHour <= 20, `a quiet pending hour runs a growing-wait handful of passes, not one a poll (ran ${quietHour})`);
  assert.ok(quietHour >= 5, `the paced wait still looks again (ran ${quietHour})`);
  assert.equal(f.world.ghReads, quietHour, "each pass is one GitHub read; a skipped poll makes none");
  const secondHour = poll(f, 60);
  assert.ok(secondHour < quietHour, `the wait keeps growing with the quiet (${secondHour} after ${quietHour})`);

  assert.equal(gardenPassDue(f.spec, f.deps), false, "unchanged inputs inside the wait are not due");
  f.world.head = "bbb";
  assert.equal(gardenPassDue(f.spec, f.deps), true, "a pushed head is due at once");
  runGarden(f.spec, f.deps);
  f.tick(60_000);
  assert.equal(gardenPassDue(f.spec, f.deps), true, "the wait snapped back to the next poll");
  runGarden(f.spec, f.deps);
  assert.equal(gardenPassDue(f.spec, f.deps), false);
  f.world.main = "m2";
  assert.equal(gardenPassDue(f.spec, f.deps), true, "main moving is due at once");
  runGarden(f.spec, f.deps);
  f.tick(60_000);
  runGarden(f.spec, f.deps);
  assert.equal(gardenPassDue(f.spec, f.deps), false);
  f.world.open = false;
  assert.equal(gardenPassDue(f.spec, f.deps), true, "a PR leaving the open list is due at once");
});

test("a pending garden PR is due on its release clock, with no watch, and with no signal at all", (t) => {
  const recorded = Date.parse("2026-10-09T12:00:00.000Z");
  const f = fixture(t, { pendingRecordedAt: new Date(recorded).toISOString() });
  assert.equal(gardenPassDue(f.spec, f.deps), true, "no watch yet: the first pass records one");
  runGarden(f.spec, f.deps);
  assert.ok(existsSync(gardenPendingWatchPath(f.stateDir, "probe")));
  f.tick(GARDEN_DECISION_PENDING_RELEASE_MS / 2);
  runGarden(f.spec, f.deps);
  f.tick(60_000);
  assert.equal(gardenPassDue(f.spec, f.deps), false, "half a day quiet waits more than a minute");
  f.tick(GARDEN_DECISION_PENDING_RELEASE_MS / 2);
  assert.equal(gardenPassDue(f.spec, f.deps), true, "the decision backstop is due on the clock");
  runGarden(f.spec, f.deps);
  f.tick(60_000);
  assert.equal(gardenPassDue(f.spec, f.deps), false, "a release clock is due once, not on every poll after it");

  const merged = fixture(t, { pending: { prUrl: PR, actionClass: "a", baseline: { trials: 4, successes: 2 }, atMerge: { trials: 4, successes: 2 },
    mergeSeenAt: new Date(recorded - 2 * GARDEN_DECISION_PENDING_RELEASE_MS).toISOString() } });
  merged.world.open = false;
  const reads = { inventory: 0 };
  const metricSpec = { ...merged.spec, inventory: () => (reads.inventory += 1, {}), metric: () => ({ trials: 6, successes: 3 }) };
  const mergedDeps = { ...merged.deps, prState: () => "merged" as const };
  for (let minute = 0; minute < 60; minute++) {
    if (gardenPassDue(metricSpec, mergedDeps)) runGarden(metricSpec, mergedDeps);
    merged.tick(60_000);
  }
  assert.ok(reads.inventory >= 1 && reads.inventory <= 20,
    `a merged metric still waiting past its release is not re-read on every poll (read ${reads.inventory} times in an hour)`);

  const blind = fixture(t);
  const deps = { ...blind.deps, pendingSignal: undefined };
  runGarden(blind.spec, deps);
  blind.tick(60_000);
  assert.equal(gardenPassDue(blind.spec, deps), true, "with no signal a pending PR is paced on the clock alone");
  writeFileSync(gardenStatePath(blind.stateDir, "probe"), JSON.stringify({ classes: { a: { alpha: 3, beta: 1 } }, lastCheap: "same" }));
  runGarden(blind.spec, deps);
  assert.equal(existsSync(gardenPendingWatchPath(blind.stateDir, "probe")), false, "a settled pending drops its watch");
  writeFileSync(gardenStatePath(blind.stateDir, "probe"), "not json");
  assert.throws(() => runGarden(blind.spec, deps), "an unreadable state still fails the pass");
  assert.equal(existsSync(gardenPendingWatchPath(blind.stateDir, "probe")), false, "and records no watch over it");
});

test("a pending PR's signal names its head while open, its absence once settled, and main", () => {
  const rows = [{ url: PR, headRefOid: "abc", updatedAt: "2026-10-09T12:00:00Z" }];
  assert.equal(gardenPendingSignal(PR, rows, "m"), "pr:abc@2026-10-09T12:00:00Z main:m");
  assert.equal(gardenPendingSignal(PR, [], "m"), "pr:not-open main:m");
  assert.equal(gardenPendingSignal(PR, undefined, undefined), "pr:unknown main:unknown");
});
