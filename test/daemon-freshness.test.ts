import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPlan, type Plan } from "../src/lib/plan.js";
import type { RunResult } from "../src/run-task.js";
import {
  daemonExitCode,
  runDaemon,
  type DaemonFreshness,
} from "../src/lib/daemon.js";
import { requestStop, stopDetail } from "../src/lib/fleet-control.js";
import type { MergedSet } from "../src/lib/drain.js";

// W1-T126 — DAEMON SELF-FRESHNESS. The same small linear plan test/daemon.test.ts uses
// (A -> B -> C chain, D independent), trimmed to just A/B since these tests only need
// "one task in flight, one task that WOULD be picked up next".
const YAML = `
- id: A
  title: a
  repo: remudero
  type: implement
  depends_on: []
  status: queued
- id: B
  title: b
  repo: remudero
  type: implement
  depends_on: []
  status: queued
`;

function fixturePlan(): Plan {
  const dir = mkdtempSync(join(tmpdir(), "daemon-freshness-"));
  const f = join(dir, "tasks.yaml");
  writeFileSync(f, YAML);
  return loadPlan(f);
}

const okResult = (id: string): RunResult => ({ taskId: id, runId: id + "-run", merged: true, costUsd: 0.5, verdict: "merged" });

/** A fake clock: resolves instantly (no real wall-clock wait) but records every call. */
function fakeClock(): { sleep: (ms: number) => Promise<void>; calls: number[] } {
  const calls: number[] = [];
  return { sleep: async (ms: number) => { calls.push(ms); }, calls };
}

const OLD_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const NEW_SHA = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

// ── claim 1: stale fixture ─────────────────────────────────────────────────────
// "in-flight work completes, the restart is ledgered as
// daemon_selfrestart_for_freshness, and the next process records the NEW sha"

test("stale fixture: lets the in-flight task finish, THEN stops as stale and ledgers daemon_selfrestart_for_freshness", async () => {
  const plan = fixturePlan();
  const merged = new Set<string>();
  const mergedSet: MergedSet = (id) => merged.has(id);
  const clock = fakeClock();
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  let tick = 0;

  const s = await runDaemon(plan, {
    refreshMerged: () => mergedSet,
    runOne: async (id) => {
      merged.add(id);
      return okResult(id);
    },
    sleep: clock.sleep,
    log: (step, extra = {}) => lines.push({ step, extra }),
    // Up to date for the FIRST tick (A gets dispatched normally); origin/main advances
    // only AFTER A is already in flight — proving the check never abandons it.
    checkFreshness: (): DaemonFreshness => {
      tick += 1;
      return tick === 1 ? { stale: false } : { stale: true, oldSha: OLD_SHA, newSha: NEW_SHA };
    },
  });

  assert.deepEqual(s.merged, ["A"], "A completed before the restart — never abandoned mid-flight");
  assert.equal(s.stopReason, "stale");
  assert.ok(!merged.has("B"), "B was runnable but the loop stopped for freshness before dispatching it");

  const restartLine = lines.find((l) => l.step === "daemon_selfrestart_for_freshness");
  assert.ok(restartLine, "the intentional restart is ledgered under its own, distinct step name");
  assert.equal(restartLine?.extra.old_sha, OLD_SHA);
  assert.equal(restartLine?.extra.new_sha, NEW_SHA);
});

test("stale fixture: the next process (booted at the reported newSha) reads itself as up to date", async () => {
  // Simulates "the next process records the NEW sha": a freshly-restarted process whose
  // OWN boot sha is now NEW_SHA compares itself against an unchanged origin/main and
  // finds nothing stale — the restart is a one-shot, not a storm.
  const plan = fixturePlan();
  const clock = fakeClock();
  let ticks = 0;
  const root = mkdtempSync(join(tmpdir(), "daemon-freshness-nextproc-"));

  const s = await runDaemon(plan, {
    refreshMerged: () => () => false,
    runOne: async (id) => okResult(id),
    sleep: clock.sleep,
    checkFreshness: (): DaemonFreshness => ({ stale: false }), // this process's boot sha === NEW_SHA now
    checkStop: () => (++ticks >= 2 ? (requestStop(root, "test done"), stopDetail(root)) : undefined),
  });

  assert.notEqual(s.stopReason, "stale", "a process already booted at the latest sha never self-restarts");
});

// ── claim 2: current fixture (falsifier) ────────────────────────────────────────
// "NO restart — the falsifier proving the check reads the sha rather than restarting
// on a timer"

test("current fixture: never restarts for freshness across many idle polls — proves this reads the sha, not a timer", async () => {
  const plan = fixturePlan(); // both A and B will be marked merged, so every tick is idle
  const clock = fakeClock();
  const lines: Array<{ step: string }> = [];
  let ticks = 0;
  const root = mkdtempSync(join(tmpdir(), "daemon-freshness-current-"));
  let freshnessCalls = 0;

  const s = await runDaemon(plan, {
    refreshMerged: () => () => true, // nothing runnable -> every tick idles
    runOne: async (id) => okResult(id),
    sleep: clock.sleep,
    log: (step) => lines.push({ step }),
    checkFreshness: (): DaemonFreshness => {
      freshnessCalls += 1;
      return { stale: false };
    },
    // Stop after several idle polls so the test terminates deterministically.
    checkStop: () => (++ticks >= 5 ? (requestStop(root, "test done"), stopDetail(root)) : undefined),
  });

  assert.equal(s.stopReason, "stopped");
  // checkStop is consulted first each tick and wins the final iteration (ticks reaches
  // 5 and requests the stop before checkFreshness runs that same tick) — so freshness is
  // consulted once per PRIOR idle poll, one fewer than the stop-triggering tick itself.
  assert.ok(freshnessCalls >= 4, "the check really was consulted every tick, not skipped");
  assert.equal(
    lines.filter((l) => l.step === "daemon_selfrestart_for_freshness").length,
    0,
    "up-to-date, every tick, across many polls -> never restarts",
  );
});

test("with no checkFreshness dependency injected, the loop behaves exactly as before this check existed", async () => {
  const plan = fixturePlan();
  const clock = fakeClock();
  let ticks = 0;
  const root = mkdtempSync(join(tmpdir(), "daemon-freshness-omitted-"));

  const s = await runDaemon(plan, {
    refreshMerged: () => () => true,
    runOne: async (id) => okResult(id),
    sleep: clock.sleep,
    checkStop: () => (++ticks >= 2 ? (requestStop(root, "test done"), stopDetail(root)) : undefined),
  });

  assert.equal(s.stopReason, "stopped");
});

// ── claim 3: nonzero exit, distinguishable from a crash-loop ────────────────────

test("daemonExitCode(\"stale\") is nonzero, like blocked/error — so KeepAlive{SuccessfulExit:false} actually restarts", () => {
  assert.equal(daemonExitCode("stale"), 1);
  assert.notEqual(daemonExitCode("stale"), daemonExitCode("stopped"));
  assert.notEqual(daemonExitCode("stale"), daemonExitCode("max_reached"));
});

test("a stale restart's ledger line is its OWN distinct step, never the generic daemon.stop/daemon.summary lines a crash shares", async () => {
  const plan = fixturePlan();
  const clock = fakeClock();
  const lines: Array<{ step: string }> = [];

  await runDaemon(plan, {
    refreshMerged: () => () => false,
    runOne: async (id) => okResult(id),
    sleep: clock.sleep,
    log: (step) => lines.push({ step }),
    checkFreshness: (): DaemonFreshness => ({ stale: true, oldSha: OLD_SHA, newSha: NEW_SHA }),
  });

  // A generic uncaught-throw crash never emits this step — only the intentional
  // self-restart path does, so a supervisor/crash-loop reader can grep for it
  // specifically instead of inferring intent from the bare nonzero exit code.
  assert.ok(lines.some((l) => l.step === "daemon_selfrestart_for_freshness"));
  assert.ok(!lines.some((l) => l.step === "daemon.stop"), "stale is not routed through the STOP ledger line");
});

// ── priority ordering ────────────────────────────────────────────────────────

test("a hard STOP still wins outright over a pending freshness restart", async () => {
  const plan = fixturePlan();
  const clock = fakeClock();
  const root = mkdtempSync(join(tmpdir(), "daemon-freshness-stopwins-"));
  requestStop(root, "halt everything");

  const s = await runDaemon(plan, {
    refreshMerged: () => () => false,
    runOne: async (id) => okResult(id),
    sleep: clock.sleep,
    checkStop: () => stopDetail(root),
    checkFreshness: (): DaemonFreshness => ({ stale: true, oldSha: OLD_SHA, newSha: NEW_SHA }),
  });

  assert.equal(s.stopReason, "stopped", "a deliberately halted fleet never self-restarts for freshness");
});

// ── W1-T151: INSTALL FRESHNESS on the self-restart path ─────────────────────────
// "the daemon self-restart (W1-T126) reinstalls on a lock change before re-exec,
// not just re-pulls" — given a package-lock.json change between the boot sha and
// the new sha, runs npm install BEFORE re-exec; with no lock change it re-execs
// WITHOUT installing.

test("stale + installNeeded: runInstall runs BEFORE the loop stops for restart", async () => {
  const plan = fixturePlan();
  const clock = fakeClock();
  const calls: string[] = [];

  const s = await runDaemon(plan, {
    refreshMerged: () => () => false,
    runOne: async (id) => okResult(id),
    sleep: clock.sleep,
    checkFreshness: (): DaemonFreshness => ({ stale: true, oldSha: OLD_SHA, newSha: NEW_SHA, installNeeded: true }),
    runInstall: () => calls.push("install"),
  });

  assert.deepEqual(calls, ["install"], "runInstall was called exactly once");
  assert.equal(s.stopReason, "stale");
});

test("stale WITHOUT installNeeded: re-execs (stops as stale) WITHOUT ever calling runInstall", async () => {
  const plan = fixturePlan();
  const clock = fakeClock();
  const calls: string[] = [];

  const s = await runDaemon(plan, {
    refreshMerged: () => () => false,
    runOne: async (id) => okResult(id),
    sleep: clock.sleep,
    checkFreshness: (): DaemonFreshness => ({ stale: true, oldSha: OLD_SHA, newSha: NEW_SHA }), // installNeeded omitted
    runInstall: () => calls.push("install"),
  });

  assert.deepEqual(calls, [], "no lock change -> runInstall is never consulted");
  assert.equal(s.stopReason, "stale");
});

test("stale + installNeeded but NO runInstall dep injected: still restarts (optional dep, behavior unchanged)", async () => {
  const plan = fixturePlan();
  const clock = fakeClock();

  const s = await runDaemon(plan, {
    refreshMerged: () => () => false,
    runOne: async (id) => okResult(id),
    sleep: clock.sleep,
    checkFreshness: (): DaemonFreshness => ({ stale: true, oldSha: OLD_SHA, newSha: NEW_SHA, installNeeded: true }),
    // runInstall omitted entirely
  });

  assert.equal(s.stopReason, "stale", "installNeeded with no runInstall wired never throws or hangs");
});
