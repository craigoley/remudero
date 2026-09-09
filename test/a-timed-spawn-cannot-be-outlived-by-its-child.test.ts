/**
 * W1-T3266 — A TIMED SPAWN CANNOT BE OUTLIVED BY ITS CHILD.
 *
 * MEASURED 2026-09-09 as a six-hour outage: a base-tree proof child pegged a full core for 5h54m
 * while the daemon sat in `ep_poll` holding `drain.lock` and an inflight latch. Nine PRs went
 * unreviewed; the last `review.*` row of any kind was 11:59:06Z and nothing escalated.
 *
 * THE BOUND HAD ALREADY FIRED. `defaultProofSpawner` passes `timeout` to `execFileSync`, but that
 * kills with SIGTERM by default, and a node process in a SYNCHRONOUS cpu loop never turns its event
 * loop, so the handler that would honour it can never run.
 *
 * EVERY FIXTURE HERE IS SELF-BOUNDED, deliberately: a suite about runaway children must not be able
 * to become one. The spinner exits on its own after {@link SPIN_MS} even if every kill fails, so the
 * worst case is a slow test rather than the outage it describes.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { defaultProofSpawner } from "../src/lib/review.js";
import { makeTempDir } from "../src/lib/tmp.js";
import { assertWallClockBound } from "./helpers/wall-clock-bound.js";

/** The fixture's own ceiling. Long enough that an unkilled child is unmistakable against the 1s
 *  bound below, short enough that a total failure of this fix costs seconds, never a hung suite. */
const SPIN_MS = 10_000;
/** The bound under test — far below SPIN_MS, so "returned early" can only mean the kill worked. */
const BOUND_MS = 1_000;

/** The body that blocks a child's main thread for `ms` without burning cpu. A handler registered
 *  with `process.on("SIGTERM")` can never run while this is executing, which is the whole point. */
const blockFor = (ms: number) =>
  `const sab = new Int32Array(new SharedArrayBuffer(4));\nAtomics.wait(sab, 0, 0, ${ms});`;

/** A child that IGNORES SIGTERM and BLOCKS ITS MAIN THREAD: the shape that stalled the fleet.
 *  `Atomics.wait` rather than a busy loop — a blocked thread cannot run a signal handler either way,
 *  and this one does it at ~zero CPU so a suite about runaway children never becomes a load problem
 *  on the runner measuring it. */
function spinnerDir(): string {
  const dir = makeTempDir("t3266");
  writeFileSync(
    join(dir, "spin.js"),
    `process.on("SIGTERM", () => {});\n${blockFor(SPIN_MS)}\n`,
  );
  // A parent that spawns a grandchild inheriting the same stdout pipe, then spins itself.
  writeFileSync(
    join(dir, "parent.js"),
    `const { spawn } = require("node:child_process");\n` +
      `spawn(process.execPath, [${JSON.stringify(join(dir, "spin.js"))}], { stdio: ["ignore", "inherit", "ignore"] });\n` +
      `process.on("SIGTERM", () => {});\n${blockFor(SPIN_MS)}\n`,
  );
  writeFileSync(join(dir, "quick.js"), `process.stdout.write("done-quickly");\n`);
  return dir;
}

/** Run `script` through the REAL production spawner and report how long it took to come back. */
function elapsedThrough(dir: string, script: string): { ms: number; stdout: string } {
  const started = Date.now();
  let stdout = "";
  try {
    stdout = defaultProofSpawner(process.execPath, [join(dir, script)], dir, BOUND_MS);
  } catch {
    // A bounded kill surfaces as a throw. WHAT it throws is settled elsewhere (W1-T2742 owns the
    // verdict a timed-out proof earns); this suite asks only WHETHER the call comes back.
  }
  return { ms: Date.now() - started, stdout };
}

test("W1-T3266: a child that ignores SIGTERM and spins does not outlive its bound", () => {
  const dir = spinnerDir();
  const { ms } = elapsedThrough(dir, "spin.js");
  // Generous headroom over the 1s bound for a loaded runner, and still an order of magnitude below
  // SPIN_MS — so this can only pass if the child was actually killed, never if it merely finished.
  assertWallClockBound(
    ms,
    SPIN_MS / 2,
    `the spawner must return once its bound expires; it took ${ms}ms against a ${SPIN_MS}ms child ` +
      "(SIGTERM alone measured 120s on a 3s bound — the child ran to completion)",
  );
});

test("W1-T3266: a grandchild holding the pipe does not keep the orchestrator blocked", () => {
  // The failure one level down: kill the direct child and a surviving grandchild can still hold the
  // stdout pipe the synchronous read is draining.
  const dir = spinnerDir();
  const { ms } = elapsedThrough(dir, "parent.js");
  assertWallClockBound(ms, SPIN_MS / 2, `a grandchild must not hold the spawner open; it took ${ms}ms`);
});

test("W1-T3266: a child that finishes INSIDE its bound is never signalled, and its stdout is intact", () => {
  // The positive control. Without it, "the child is dead" is satisfied by a spawner that kills
  // everything immediately — which would refuse every slow proof on a loaded runner.
  const dir = spinnerDir();
  const started = Date.now();
  const out = defaultProofSpawner(process.execPath, [join(dir, "quick.js")], dir, 30_000);
  assert.equal(out.trim(), "done-quickly", "stdout must come back byte-identical, unkilled");
  assertWallClockBound(Date.now() - started, 30_000, "and it must not have waited out its bound");
});

test("W1-T3266: the production spawner names the untrappable signal, so the choice is readable", () => {
  // @source-text-subject — the subject IS the call site's option, and an absence/presence in source
  // text is what a reader of this decision needs; no behavioural path expresses "which signal".
  const src = new URL("../src/lib/review.ts", import.meta.url);
  const text = readFileSync(src, "utf8");
  assert.match(text, /killSignal: "SIGKILL"/, "the bound must name a signal a spinning child cannot trap");
});
