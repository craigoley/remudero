import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPlan, type Plan } from "../src/lib/plan.js";
import type { RunResult } from "../src/run-task.js";
import {
  DAEMON_EXIT_STALE,
  daemonExitCode,
  runDaemon,
  type DaemonDeps,
  type DaemonFreshness,
} from "../src/lib/daemon.js";
import { pauseDetail, requestPause, requestStop, resumeFleet, stopDetail } from "../src/lib/fleet-control.js";
import type { MergedSet } from "../src/lib/drain.js";
import {
  drainDetachedSweepActions,
  detachedSweepActionCount,
  runSweepLightPass,
  type OpenPrView,
  type SweepDeps,
} from "../src/lib/sweep.js";

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

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await settle();
  }
  assert.fail(message);
}

function blockedPr(): OpenPrView {
  return {
    prNumber: 2865,
    prUrl: "https://github.com/o/r/pull/2865",
    taskId: "W1-T2865-FIX",
    reviewState: "failure",
    checksState: "green",
    unmetCriteria: [
      { claim: "finish the repair", proof: "unit test: x", met: false, reason: "not done", proof_exec: "executed_fail" },
    ],
    priorStrikes: 0,
    lastActivityAt: "2026-09-05T04:00:00Z",
    headSha: "detached-fix-head",
    autoMergeArmed: false,
  };
}

function detachedFixSweepDeps(
  ledgerPath: string,
  dispatchFix: NonNullable<SweepDeps["dispatchFix"]>,
): SweepDeps {
  return {
    arm: () => {},
    close: () => {},
    dispatchFix,
    escalate: () => {},
    actionable: (disposition) => disposition === "blocked-fixable",
    ledgerPath,
    runId: "SWEEP-T2865",
    now: () => Date.parse("2026-09-05T04:40:00Z"),
  };
}

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
    // Up to date at BOTH boundaries of the FIRST tick (A gets dispatched normally);
    // origin/main advances only AFTER A is already in flight — proving the check
    // never abandons it. The third read is the next tick's top boundary.
    checkFreshness: (): DaemonFreshness => {
      tick += 1;
      return tick <= 2 ? { stale: false } : { stale: true, oldSha: OLD_SHA, newSha: NEW_SHA };
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
  // W1-T490 GAVE THIS SECTION'S OWN HEADING ("distinguishable from a crash-loop") ITS FIRST REAL
  // TEETH. The literal was 1, which made `stale` nonzero — satisfying launchd — but IDENTICAL to
  // `blocked`/`error`, so the container half could not tell a freshness restart from a crash and
  // charged both to `--restart=on-failure:N`. The assertion that carries this test's actual claim is
  // NONZERO-ness, which is unchanged; the exact value now discriminates as the heading always said
  // it should. The full both-directions pair lives in `test/daemon.test.ts` beside the mapping.
  assert.notEqual(daemonExitCode("stale"), 0, "still nonzero — KeepAlive{SuccessfulExit:false} must still restart");
  assert.equal(daemonExitCode("stale"), DAEMON_EXIT_STALE);
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

// ── W1-T936: PAUSE must be read before SELF-FRESHNESS ──────────────────────────
// Before this fix, `checkFreshness` was consulted (and could exit "stale") strictly
// above `checkPause` in `runDaemon`'s tick loop, so a paused daemon on a checkout
// that never fast-forwards its own ref hit the freshness exit on every tick, exited
// nonzero, and launchd's KeepAlive{SuccessfulExit:false} relaunched it straight back
// into the same PAUSE flag — the 2026-08-17 relaunch storm.

test("W1-T936: a paused daemon never exits for freshness", async () => {
  const plan = fixturePlan();
  const root = mkdtempSync(join(tmpdir(), "daemon-pause-freshness-never-exits-"));
  requestPause(root, "quiet hours");
  const clock = fakeClock();
  const lines: Array<{ step: string }> = [];
  let ticks = 0;

  const s = await runDaemon(plan, {
    refreshMerged: () => () => false,
    runOne: async (id) => okResult(id),
    sleep: clock.sleep,
    log: (step) => lines.push({ step }),
    checkPause: () => pauseDetail(root),
    // Origin/main is behind this process's boot sha on EVERY tick — if freshness
    // were consulted while paused, this would fire the "stale" exit immediately.
    checkFreshness: (): DaemonFreshness => ({ stale: true, oldSha: OLD_SHA, newSha: NEW_SHA }),
    // Stop after several paused heartbeats so the test terminates deterministically,
    // without ever clearing the PAUSE flag.
    checkStop: () => (++ticks >= 4 ? (requestStop(root, "test done"), stopDetail(root)) : undefined),
  });

  assert.notEqual(s.stopReason, "stale", "PAUSE must be honoured before a restart decision is taken");
  assert.equal(s.stopReason, "stopped", "the run only ends because the test's own STOP fired, never freshness");
  assert.ok(
    lines.some((l) => l.step === "daemon.pause"),
    "the daemon idled in-process on the pause heartbeat",
  );
  assert.equal(
    lines.filter((l) => l.step === "daemon_selfrestart_for_freshness").length,
    0,
    "a stale checkout never triggers the freshness restart while PAUSE is set",
  );
});

test("W1-T936: PAUSE is read before the freshness check", async () => {
  const plan = fixturePlan();
  const root = mkdtempSync(join(tmpdir(), "daemon-pause-before-freshness-order-"));
  const clock = fakeClock();
  const order: string[] = [];
  let ticks = 0;

  const s = await runDaemon(plan, {
    refreshMerged: () => () => true, // nothing runnable -> every tick idles
    runOne: async (id) => okResult(id),
    sleep: clock.sleep,
    // Never paused, so both deps are consulted every tick — the recorded order
    // proves the SOURCE ORDER of the two reads, not just short-circuiting.
    checkPause: () => {
      order.push("pause");
      return pauseDetail(root);
    },
    checkFreshness: (): DaemonFreshness => {
      order.push("freshness");
      return { stale: false };
    },
    checkStop: () => (++ticks >= 3 ? (requestStop(root, "test done"), stopDetail(root)) : undefined),
  });

  assert.equal(s.stopReason, "stopped");
  assert.ok(order.length >= 4, "both reads really were consulted across multiple ticks");
  for (let i = 0; i < order.length; i += 2) {
    assert.deepEqual(
      order.slice(i, i + 2),
      ["pause", "freshness"],
      `tick starting at call ${i}: pause must be read before freshness`,
    );
  }
});

test("W1-T936: clearing PAUSE lets the freshness exit fire", async () => {
  const plan = fixturePlan();
  const root = mkdtempSync(join(tmpdir(), "daemon-pause-clear-freshness-fires-"));
  requestPause(root, "starts paused"); // boots straight into an already-paused fleet
  const lines: Array<{ step: string }> = [];
  let sleeps = 0;
  const sleep: DaemonDeps["sleep"] = async (_ms) => {
    sleeps++;
    // The "operator" runs `rmd resume` after a couple of paused heartbeats —
    // origin/main is ALREADY stale the whole time, it just can't be acted on
    // until the hold clears.
    if (sleeps === 2) resumeFleet(root);
  };

  const s = await runDaemon(plan, {
    refreshMerged: () => () => false,
    runOne: async (id) => okResult(id),
    sleep,
    log: (step) => lines.push({ step }),
    checkPause: () => pauseDetail(root),
    checkFreshness: (): DaemonFreshness => ({ stale: true, oldSha: OLD_SHA, newSha: NEW_SHA }),
  });

  assert.equal(s.stopReason, "stale", "once PAUSE clears, the SAME process notices the stale checkout and restarts");
  const heartbeats = lines.filter((l) => l.step === "daemon.pause");
  assert.equal(heartbeats.length, 2, "exactly two paused heartbeats occurred before resume");
  assert.ok(
    lines.some((l) => l.step === "daemon_selfrestart_for_freshness"),
    "the freshness restart fires on the very next tick after the hold clears",
  );
});

// ── W1-T2845: re-check freshness at the pre-admission boundary ───────────────

test("W1-T2845: origin/main advancing during the awaited full sweep admits no stale-code task", async () => {
  const plan = fixturePlan();
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  let sweeps = 0;
  let runOneCalls = 0;
  let installs = 0;

  const s = await runDaemon(plan, {
    refreshMerged: () => () => false,
    runOne: async (id) => {
      runOneCalls++;
      return okResult(id);
    },
    sleep: fakeClock().sleep,
    log: (step, extra = {}) => lines.push({ step, extra }),
    checkFreshness: (): DaemonFreshness =>
      sweeps === 0
        ? { stale: false }
        : { stale: true, oldSha: OLD_SHA, newSha: NEW_SHA, installNeeded: true },
    runInstall: () => {
      installs++;
    },
    sweep: async () => {
      // This awaited rung stands in for the production sweep during which origin/main advanced.
      sweeps++;
    },
  });

  assert.equal(s.stopReason, "stale");
  assert.deepEqual(s.attempted, [], "nothing from the stale tick crossed the admission boundary");
  assert.equal(runOneCalls, 0, "stale code never reached runOne");
  assert.equal(installs, 1, "the shared stale-exit path performs the required install exactly once");
  assert.equal(sweeps, 2, "the ordinary sweep ran, then the W1-T1272 stale-exit sweep ran once");
  assert.equal(
    lines.filter((l) => l.step === "daemon_selfrestart_for_freshness").length,
    1,
    "the late observation uses the same named restart ledger path",
  );
});

test("W1-T2845: a pre-admission STOP wins before the simultaneous late freshness observation", async () => {
  const plan = fixturePlan();
  let stopReads = 0;
  let freshnessReads = 0;
  let runOneCalls = 0;
  const lines: Array<{ step: string }> = [];

  const s = await runDaemon(plan, {
    refreshMerged: () => () => false,
    runOne: async (id) => {
      runOneCalls++;
      return okResult(id);
    },
    sleep: fakeClock().sleep,
    log: (step) => lines.push({ step }),
    checkStop: () => (++stopReads === 2 ? "STOP raised during the tick" : undefined),
    checkFreshness: (): DaemonFreshness => {
      freshnessReads++;
      return freshnessReads === 1
        ? { stale: false }
        : { stale: true, oldSha: OLD_SHA, newSha: NEW_SHA };
    },
  });

  assert.equal(s.stopReason, "stopped");
  assert.equal(freshnessReads, 1, "the late freshness read is suppressed when STOP wins");
  assert.equal(runOneCalls, 0);
  assert.equal(lines.some((l) => l.step === "daemon_selfrestart_for_freshness"), false);
});

test("W1-T2845: a pre-admission PAUSE wins before late freshness and remains an in-process hold", async () => {
  const plan = fixturePlan();
  let pauseReads = 0;
  let freshnessReads = 0;
  let stopped = false;
  let runOneCalls = 0;
  const lines: Array<{ step: string }> = [];

  const s = await runDaemon(plan, {
    refreshMerged: () => () => false,
    runOne: async (id) => {
      runOneCalls++;
      return okResult(id);
    },
    sleep: async () => {
      stopped = true;
    },
    log: (step) => lines.push({ step }),
    checkStop: () => (stopped ? "test complete" : undefined),
    checkPause: () => (++pauseReads === 2 ? "PAUSE raised during the tick" : undefined),
    checkFreshness: (): DaemonFreshness => {
      freshnessReads++;
      return freshnessReads === 1
        ? { stale: false }
        : { stale: true, oldSha: OLD_SHA, newSha: NEW_SHA };
    },
  });

  assert.equal(s.stopReason, "stopped", "PAUSE idles; the test's later STOP ends the process");
  assert.equal(freshnessReads, 1, "the late freshness read is suppressed while PAUSE holds");
  assert.equal(runOneCalls, 0);
  assert.ok(lines.some((l) => l.step === "daemon.pause"));
  assert.equal(lines.some((l) => l.step === "daemon_selfrestart_for_freshness"), false);
});

for (const lateFreshness of ["fresh", "unavailable"] as const) {
  const article = lateFreshness === "unavailable" ? "an" : "a";
  test(`W1-T2845: ${article} ${lateFreshness} late observation preserves the existing dispatch path`, async () => {
    const plan = fixturePlan();
    let freshnessReads = 0;
    let runOneCalls = 0;
    const deps: DaemonDeps = {
      refreshMerged: () => () => false,
      runOne: async (id) => {
        runOneCalls++;
        return okResult(id);
      },
      sleep: fakeClock().sleep,
    };
    if (lateFreshness === "fresh") {
      deps.checkFreshness = () => {
        freshnessReads++;
        return { stale: false };
      };
    }

    const s = await runDaemon(plan, deps, { max: 1 });

    assert.equal(s.stopReason, "max_reached");
    assert.deepEqual(s.attempted, ["A"]);
    assert.equal(runOneCalls, 1);
    assert.equal(freshnessReads, lateFreshness === "fresh" ? 2 : 0);
  });
}

// ── W1-T2865: freshness is a daemon-lifetime boundary ───────────────────────

test("W1-T2865: the final freshness sweep's detached fix settles before the restart is ledgered", async () => {
  assert.equal(detachedSweepActionCount(), 0, "precondition: no detached action leaked from another test");
  const root = mkdtempSync(join(tmpdir(), "daemon-freshness-drain-"));
  const ledgerPath = join(root, "ledger.ndjson");
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  let releaseFix!: () => void;
  let fixSettled = false;
  const fixGate = new Promise<void>((resolve) => {
    releaseFix = () => {
      fixSettled = true;
      resolve();
    };
  });

  const daemon = runDaemon(fixturePlan(), {
    refreshMerged: () => () => false,
    runOne: async (id) => okResult(id),
    sleep: fakeClock().sleep,
    log: (step, extra = {}) => lines.push({ step, extra }),
    checkFreshness: (): DaemonFreshness => ({ stale: true, oldSha: OLD_SHA, newSha: NEW_SHA }),
    sweep: async () => {
      await runSweepLightPass(
        [blockedPr()],
        detachedFixSweepDeps(ledgerPath, () => fixGate as never),
      );
    },
  });

  await waitFor(() => detachedSweepActionCount() === 1, "the final sweep never registered its detached fix");
  const returnedBeforeSettlement = await Promise.race([
    daemon.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 25)),
  ]);
  const fixWasSettledBeforeRelease = fixSettled;
  const restartWasLoggedBeforeRelease = lines.some((line) => line.step === "daemon_selfrestart_for_freshness");

  releaseFix();
  const summary = await daemon;
  await drainDetachedSweepActions();

  assert.equal(returnedBeforeSettlement, false, "the stale summary must remain owned while the fix is settling");
  assert.equal(fixWasSettledBeforeRelease, false);
  assert.equal(restartWasLoggedBeforeRelease, false);
  assert.equal(summary.stopReason, "stale");
  assert.equal(fixSettled, true);
  assert.equal(detachedSweepActionCount(), 0);
  const steps = lines.map((line) => line.step);
  assert.equal(steps.filter((step) => step === "daemon.freshness_drain.started").length, 1);
  assert.equal(steps.filter((step) => step === "daemon.freshness_drain.completed").length, 1);
  assert.ok(steps.indexOf("daemon.freshness_drain.started") < steps.indexOf("daemon.freshness_drain.completed"));
  assert.ok(steps.indexOf("daemon.freshness_drain.completed") < steps.indexOf("daemon_selfrestart_for_freshness"));
  const started = lines.find((line) => line.step === "daemon.freshness_drain.started");
  const completed = lines.find((line) => line.step === "daemon.freshness_drain.completed");
  assert.equal(started?.extra.detached_sweep_actions, 1);
  assert.equal(completed?.extra.detached_sweep_actions, 1);
  assert.equal(completed?.extra.remaining_detached_sweep_actions, 0);
  assert.equal(typeof completed?.extra.duration_ms, "number");
});

test("W1-T2865: a zero-action freshness exit emits no drain telemetry", async () => {
  const lines: Array<{ step: string }> = [];
  const summary = await runDaemon(fixturePlan(), {
    refreshMerged: () => () => false,
    runOne: async (id) => okResult(id),
    sleep: fakeClock().sleep,
    log: (step) => lines.push({ step }),
    checkFreshness: (): DaemonFreshness => ({ stale: true, oldSha: OLD_SHA, newSha: NEW_SHA }),
    sweep: async () => {},
  });

  assert.equal(summary.stopReason, "stale");
  assert.equal(lines.some((line) => line.step.startsWith("daemon.freshness_drain.")), false);
});

test("W1-T2865: late freshness closes the interphase review clock before its final sweep", async () => {
  const waiters: Array<(result: "wake" | "timeout") => void> = [];
  const sweepTickerWaiters: Array<() => void> = [];
  let releaseOrphan!: () => void;
  let releaseFinalSweep!: () => void;
  const orphanGate = new Promise<void>((resolve) => { releaseOrphan = resolve; });
  const finalSweepGate = new Promise<void>((resolve) => { releaseFinalSweep = resolve; });
  let freshnessReads = 0;
  let sweepCalls = 0;
  let finalSweepStarted = false;
  let lightPasses = 0;
  let lateLightPasses = 0;

  const daemon = runDaemon(fixturePlan(), {
    refreshMerged: () => () => false,
    runOne: async (id) => okResult(id),
    sleep: () => new Promise<void>((resolve) => sweepTickerWaiters.push(resolve)),
    checkFreshness: (): DaemonFreshness =>
      ++freshnessReads === 1
        ? { stale: false }
        : { stale: true, oldSha: OLD_SHA, newSha: NEW_SHA },
    sweep: async () => {
      sweepCalls++;
      if (sweepCalls === 2) {
        finalSweepStarted = true;
        await finalSweepGate;
      }
    },
    sweepOrphans: async () => {
      await orphanGate;
      return { killed: [], leftAlone: [] };
    },
    sleepUntilSweepWake: () => new Promise((resolve) => waiters.push(resolve)),
    sweepLight: async () => {
      lightPasses++;
      if (finalSweepStarted) lateLightPasses++;
    },
  });

  await waitFor(() => sweepTickerWaiters.length === 1, "the ordinary full-sweep ticker never began waiting");
  await settle();
  sweepTickerWaiters.shift()!();
  await waitFor(() => waiters.length === 1, "the interphase clock never began waiting");
  waiters.shift()!("wake");
  await waitFor(() => lightPasses === 1, "the interphase clock did not consume its first wake");
  await waitFor(() => waiters.length >= 1, "the interphase clock did not resume waiting after its first wake");
  releaseOrphan();
  for (let i = 0; i < 10; i++) await settle();
  const finalSweepStartedBeforeClockSettled = finalSweepStarted;
  while (waiters.length > 0) waiters.shift()!("timeout");
  await waitFor(() => finalSweepStarted, "the final freshness sweep never started after the clock settled");
  await waitFor(() => sweepTickerWaiters.length === 1, "the final full-sweep ticker never began waiting");
  releaseFinalSweep();
  await settle();
  sweepTickerWaiters.shift()!();

  const summary = await daemon;
  assert.equal(summary.stopReason, "stale");
  assert.equal(sweepCalls, 2, "the ordinary and final freshness sweeps each ran once");
  assert.equal(
    finalSweepStartedBeforeClockSettled,
    false,
    "the late freshness boundary closes the interphase clock before starting its final sweep",
  );
  assert.equal(lightPasses, 1, "the clock admitted no pass after the late freshness boundary");
  assert.equal(lateLightPasses, 0, "no review or fix admission raced behind the final sweep");
});
