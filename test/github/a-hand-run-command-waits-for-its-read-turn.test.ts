import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import {
  applyGhReadCadence,
  GhReadCadenceRefusal,
  ghReadCadenceStampPath,
  readGhReadCadenceStampMs,
  stampGhRead,
  withGhTransportFloor,
  type GhReadCadenceDeps,
} from "#src/lib/github-transport.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

// W1-T12058 — observed on the host: `rmd review <n>` failed at once with "gh read cadence floor: a
// read-shaped call 4s after the last one (floor 180s)", because the fleet's reads share the core
// limiter's stamp. A refusal makes the operator re-run, and a re-run restarts the window. These tests
// drive the REAL `withGhTransportFloor` wrapper `rmd review` runs in, on a real stamp file, with only
// the clock and the sleep faked so the 180 s wait costs nothing.

const READ = ["api", "repos/o/r/pulls/1"] as const;
const WINDOW_MS = 180_000;
const AGE_MS = 5_000;

function fixture(t: TestContext, mode?: "enforce" | "advisory") {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}hand-run-turn-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // Whole seconds: a stamp's mtime is read back at the filesystem's resolution.
  let now = Math.floor(Date.now() / 1000) * 1000;
  const env: NodeJS.ProcessEnv = { RMD_GH_CACHE_HOME: dir };
  if (mode !== undefined) env.RMD_GH_TRANSPORT_FLOOR = mode;
  const stamp = ghReadCadenceStampPath(env)!;
  // Another fleet process read five seconds ago: this command's first read is inside the window.
  stampGhRead(stamp, "", now - AGE_MS);
  const sleeps: number[] = [];
  const warnings: string[] = [];
  const deps: GhReadCadenceDeps = {
    env,
    nowMs: () => now,
    sleepSync: (ms) => { sleeps.push(ms); now += ms; },
    warn: (line) => { warnings.push(line); },
  };
  return { env, stamp, sleeps, warnings, deps, now: () => now };
}

const slept = (sleeps: number[]): number => sleeps.reduce((sum, ms) => sum + ms, 0);

test("W1-T12058 criterion 1: with no mode set, a hand-run command's first read inside the window waits its turn and then runs", async (t) => {
  const f = fixture(t);
  let mode: string | undefined;
  const before = readGhReadCadenceStampMs(f.stamp);
  await withGhTransportFloor(() => {
    mode = f.env.RMD_GH_TRANSPORT_FLOOR;
    // Before W1-T12058 this threw GhReadCadenceRefusal: the wrapper defaulted to enforce.
    applyGhReadCadence([...READ], f.deps);
  }, f.env);
  assert.equal(mode, "wait", "the hand-run wrapper's default mode");
  assert.ok(slept(f.sleeps) >= WINDOW_MS - AGE_MS, `slept ${slept(f.sleeps)} ms, short of the floor`);
  const after = readGhReadCadenceStampMs(f.stamp);
  assert.ok(after !== undefined && before !== undefined && after > before, "the read ran and stamped its turn");
  assert.equal(f.env.RMD_GH_TRANSPORT_FLOOR, undefined, "the caller's unset mode is restored");
});

test("W1-T12058 criterion 2: RMD_GH_TRANSPORT_FLOOR=enforce still refuses and =advisory still paces, exactly as today", async (t) => {
  const enforced = fixture(t, "enforce");
  await withGhTransportFloor(() => {
    assert.throws(() => applyGhReadCadence([...READ], enforced.deps), GhReadCadenceRefusal);
  }, enforced.env);
  assert.deepEqual(enforced.sleeps, [], "an enforced read refuses without waiting");
  assert.equal(enforced.env.RMD_GH_TRANSPORT_FLOOR, "enforce");

  const advisory = fixture(t, "advisory");
  await withGhTransportFloor(() => {
    applyGhReadCadence([...READ], advisory.deps);
  }, advisory.env);
  assert.ok(slept(advisory.sleeps) < WINDOW_MS - AGE_MS, "an advisory read never waits out the floor");
  assert.equal(advisory.warnings.some((line) => line.includes("waiting")), false, "an advisory read prints no wait line");
  assert.equal(advisory.env.RMD_GH_TRANSPORT_FLOOR, "advisory");
});

test("W1-T12058 criterion 3: the wait is printed once with its length, so the person sees why the command paused", async (t) => {
  const f = fixture(t);
  await withGhTransportFloor(() => {
    applyGhReadCadence([...READ], f.deps);
  }, f.env);
  const waits = f.warnings.filter((line) => line.startsWith("gh read cadence (wait"));
  assert.equal(waits.length, 1, `one wait line, got: ${JSON.stringify(f.warnings)}`);
  const seconds = (WINDOW_MS - AGE_MS) / 1000;
  assert.match(waits[0]!, new RegExp(`waiting ${seconds}s for the 180s floor`));
});
