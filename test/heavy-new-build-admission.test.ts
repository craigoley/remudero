import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as yieldTurn } from "node:timers/promises";
import { loadPlan, TaskAdmissionError, type Plan } from "../src/lib/plan.js";
import { runDaemon, runLanePool, type DaemonDeps, type LanePoolControl } from "../src/lib/daemon.js";
import { runDrain, type DrainDeps } from "../src/lib/drain.js";
import * as dispatchGovernor from "../src/lib/dispatch-governor.js";
import { heavyNewBuildGate, type HeavyBuildHold } from "../src/lib/heavy-build-reservation.js";
import { drainDetachedSweepActions } from "../src/lib/sweep.js";
import type { RunResult } from "../src/lib/run-result.js";

// Added tests also run against the real merge base. Missing new exports must
// fail named feature assertions there, not prevent the test file from loading.
const checkNewBuildReservation: typeof dispatchGovernor.checkNewBuildReservation = (...args) => {
  assert.equal(typeof dispatchGovernor.checkNewBuildReservation, "function", "NEW-build reservation decision is absent in this Git tree");
  return dispatchGovernor.checkNewBuildReservation(...args);
};
const newBuildReservationPayload: typeof dispatchGovernor.newBuildReservationPayload = (...args) => {
  assert.equal(typeof dispatchGovernor.newBuildReservationPayload, "function", "NEW-build reservation payload is absent in this Git tree");
  return dispatchGovernor.newBuildReservationPayload(...args);
};

const HOLD: HeavyBuildHold = {
  deferred: true, requestId: "a".repeat(64), readyAtMs: 1, expiresAtMs: 3_600_001,
  detail: "test heavy READY reserves NEW implement admissions",
};
const ok = (id: string): RunResult => ({ taskId: id, runId: `${id}-test`, merged: true, verdict: "merged", costUsd: 0.5 });
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function fixtureRoot(t: TestContext): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rmd-heavy-admission-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function fixturePlan(t: TestContext, ids = ["A", "B"]): Plan {
  const path = join(fixtureRoot(t), "tasks.yaml");
  writeFileSync(path, ids.map((id) => `- id: ${id}\n  title: task ${id}\n  repo: remudero\n  type: implement\n  verify: auto\n  status: queued\n  depends_on: []\n  files: [src/${id.toLowerCase()}.ts]\n`).join(""));
  return loadPlan(path);
}
function daemonDeps(overrides: Partial<DaemonDeps>): DaemonDeps {
  return {
    refreshMerged: () => () => false, runOne: async (id) => ok(id), readLedgerLines: () => [],
    checkCostGovernor: () => undefined, checkQueueGovernor: () => undefined,
    checkMemoryGovernor: () => undefined, checkQuietHours: () => undefined,
    sweepLight: async () => {}, sleep: async () => { await yieldTurn(); }, ...overrides,
  };
}

test("NEW-build decision is optional, implement-only, and distinguishes held from UNKNOWN", () => {
  assert.equal(checkNewBuildReservation({}, { type: "implement" }), undefined);
  assert.equal(checkNewBuildReservation({ checkHeavyNewBuild: () => undefined }, { type: "implement" }), undefined);
  for (const type of ["review", "diagnose", "recon", "manual"] as const) {
    assert.equal(checkNewBuildReservation({ checkHeavyNewBuild: () => assert.fail("non-implement must not read reservation") }, { type }), undefined);
  }
  const held = checkNewBuildReservation({ checkHeavyNewBuild: () => HOLD }, { type: "implement" });
  assert.equal(held?.kind, "held");
  assert.deepEqual(newBuildReservationPayload(held!), {
    scope: "NEW-implement-only", source: "heavy_ready", state: "held", reason: HOLD.detail,
    request_id: HOLD.requestId, ready_at_ms: HOLD.readyAtMs, expires_at_ms: HOLD.expiresAtMs,
  });
  for (const error of [new Error("reader unavailable"), "reader unavailable"]) {
    const unknown = checkNewBuildReservation({ checkHeavyNewBuild: () => { throw error; } }, { type: "implement" });
    assert.deepEqual(unknown, { kind: "unavailable", reason: "reader unavailable" });
    assert.equal(newBuildReservationPayload(unknown!).state, "unavailable");
  }
});

test("real explicit-dir adapter keeps configured ENOENT as UNKNOWN, not an empty reservation", (t) => {
  const rows: string[] = [];
  const log = (step: string) => { rows.push(step); };
  assert.equal(heavyNewBuildGate(log)(), undefined, "unconfigured adapter is disabled");
  const reading = checkNewBuildReservation({
    checkHeavyNewBuild: heavyNewBuildGate(log, { dir: join(fixtureRoot(t), "missing-private-dir") }),
  }, { type: "implement" });
  assert.equal(reading?.kind, "unavailable");
  assert.match(reading!.reason, /heavy READY observation unavailable/);
  assert.deepEqual(rows, ["heavy_ready.unavailable"]);
});

test("pool fifth-argument refusal creates no work or settlement slot, including between first-wave starts", async () => {
  const tasks = ["A", "B", "C"].map((id) => ({ id }));
  const started: string[] = [];
  const checks: Array<[string, number, boolean]> = [];
  let held = false;
  const outcome = await runLanePool(tasks, (id) => {
    started.push(id); held = true; return Promise.resolve(id);
  }, () => undefined, { inFlight: 0 }, (task, lane, refill) => {
    checks.push([task.id, lane, refill]); return !held;
  });
  assert.deepEqual(started, ["A"]);
  assert.deepEqual(tasks.map((task) => task.id), ["A"]);
  assert.deepEqual(checks, [["A", 0, false], ["B", 1, false], ["C", 2, false]]);
  assert.deepEqual(outcome, { settled: [{ status: "fulfilled", value: "A" }] });
  const allHeld = [{ id: "X" }];
  assert.deepEqual(await runLanePool(allHeld, async () => assert.fail("held work started"), () => undefined, { inFlight: 0 }, () => false), { settled: [] });
  assert.deepEqual(allHeld, []);
  const control = [{ id: "X" }, { id: "Y" }];
  assert.equal((await runLanePool(control, async (id) => id, () => undefined)).length, 2, "unwired pool still starts both lanes");
});

for (const direction of ["hold", "release"] as const) {
  test(`pool final admission sees ${direction} during the promised refill handoff`, { timeout: 2_000 }, async (t) => {
    const tasks = ["A", "B"].map((id) => ({ id, type: "implement" as const }));
    const a = deferred<string>(), b = deferred<string>();
    const proposal = deferred<(typeof tasks)[number] | undefined>();
    const refillRequested = deferred<void>(), refillChecked = deferred<void>();
    const started: string[] = [], lanes = { inFlight: 0 };
    let held = false, observedHeld = false;
    const work = runLanePool(tasks, (id) => {
      started.push(id); return id === "A" ? a.promise : id === "B" ? b.promise : Promise.resolve(id);
    }, (_lane, finished) => {
      if (finished.id !== "A") return undefined;
      refillRequested.resolve(undefined); return proposal.promise;
    }, lanes, (task, lane, refill) => {
      const admitted = checkNewBuildReservation({ checkHeavyNewBuild: () => held ? HOLD : undefined }, task) === undefined;
      if (refill) {
        assert.equal(lane, 0); observedHeld = held; refillChecked.resolve(undefined);
      }
      return admitted;
    });
    t.after(async () => { proposal.resolve(undefined); a.resolve("A"); b.resolve("B"); await work; });
    assert.deepEqual(started, ["A", "B"]);
    a.resolve("A");
    await refillRequested.promise;
    held = direction === "release";
    proposal.resolve({ id: "C", type: "implement" });
    // The pool's settlement handler propagates fulfillment first; this changes the reading before
    // its subsequent take(). A check only in the producer/conclude would be stale here.
    queueMicrotask(() => { held = direction === "hold"; });
    await refillChecked.promise;
    assert.equal(observedHeld, direction === "hold");
    assert.deepEqual(started, direction === "hold" ? ["A", "B"] : ["A", "B", "C"]);
    b.resolve("B");
    const outcome = await work;
    assert.equal(lanes.inFlight, 0);
    assert.equal(outcome.fault, undefined);
    assert.equal(outcome.settled.length, direction === "hold" ? 2 : 3);
    assert.deepEqual(tasks.map((task) => task.id), started, "no phantom settlement/index for a declined refill");
  });
}

for (const laneCount of [1, 2]) for (const curated of [false, true]) {
  test(`drain ${laneCount} lane ${curated ? "curated" : "natural"}: hold after prefetch, then release dispatches exactly once`, { timeout: 2_000 }, async (t) => {
    const plan = fixturePlan(t), credited = new Set<string>(), started: string[] = [];
    const reading = deferred<string>(), readStarted = deferred<void>();
    const rows: Array<{ step: string; fields: Record<string, unknown> }> = [];
    let held = false;
    const deps: DrainDeps = {
      refreshMerged: () => (id) => credited.has(id), isOpenPr: (id) => id === "A" ? 7 : undefined,
      readLiveState: () => { readStarted.resolve(undefined); return reading.promise; },
      checkHeavyNewBuild: () => held ? HOLD : undefined,
      runOne: async (id) => { started.push(id); credited.add(id); return ok(id); },
      log: (step, fields = {}) => rows.push({ step, fields }),
    };
    const opts = { laneCount, max: 2, ...(curated ? { curated: ["A", "B"] } : {}) };
    const work = runDrain(plan, deps, opts);
    t.after(() => reading.resolve("CLOSED"));
    await readStarted.promise;
    held = true; reading.resolve("CLOSED");
    const refused = await work;
    assert.equal(refused.stopReason, "new_build_deferred");
    assert.equal(refused.stopDetail, HOLD.detail);
    assert.deepEqual(refused.attempted, []);
    assert.deepEqual(refused.merged, []);
    assert.equal(refused.costUsd, 0);
    assert.deepEqual(started, []);
    assert.ok(rows.some((row) => row.step === "dispatch.new_build_held" && row.fields.request_id === HOLD.requestId));
    assert.ok(!rows.some((row) => row.step === "drain.iteration"));
    held = false;
    const resumed = await runDrain(plan, deps, opts);
    assert.deepEqual(started, ["A", "B"]);
    assert.deepEqual(resumed.attempted, ["A", "B"]);
    assert.deepEqual(resumed.merged, ["A", "B"]);
    assert.equal(resumed.costUsd, 1);
    assert.equal(resumed.stopReason, "max_reached");
  });
}

for (const curated of [false, true]) {
  test(`drain two-lane ${curated ? "curated" : "natural"} partial hold lets its accepted active settle`, { timeout: 2_000 }, async (t) => {
    const plan = fixturePlan(t), active = deferred<RunResult>(), started = deferred<void>(), laterHeld = deferred<void>();
    const calls: string[] = [];
    let held = false, finished = false;
    const work = runDrain(plan, {
      refreshMerged: () => () => false, checkHeavyNewBuild: () => held ? HOLD : undefined,
      runOne: (id) => { calls.push(id); held = true; started.resolve(undefined); return active.promise; },
      log: (step, fields) => { if (step === "dispatch.new_build_held" && fields?.task === "B") laterHeld.resolve(undefined); },
    }, { laneCount: 2, max: 2, ...(curated ? { curated: ["A", "B"] } : {}) });
    void work.then(() => { finished = true; }, () => { finished = true; });
    t.after(async () => { active.resolve(ok("A")); await work; });
    await started.promise;
    await laterHeld.promise;
    assert.deepEqual(calls, ["A"]);
    assert.equal(finished, false, "the admission hold did not abort the active sibling");
    active.resolve(ok("A"));
    const summary = await work;
    assert.deepEqual(summary.attempted, ["A"]);
    assert.deepEqual(summary.merged, ["A"]);
    assert.equal(summary.costUsd, 0.5);
    assert.equal(summary.stopReason, "new_build_deferred");
  });
}

for (const delayedRead of ["branch", "merged"] as const) {
  test(`daemon refuses NEW refill after an awaited ${delayedRead} read; existing actives settle`, { timeout: 2_000 }, async (t) => {
    const plan = fixturePlan(t, ["A", "B", "C"]), credited = new Set<string>(), calls: string[] = [];
    const a = deferred<RunResult>(), b = deferred<RunResult>(), bothStarted = deferred<void>();
    const readStarted = deferred<void>(), releaseRead = deferred<void>(), heldOrStarted = deferred<void>();
    const rows: Array<{ step: string; task: unknown }> = [];
    let held = false, stop = false;
    const snapshot = () => { const ids = new Set(credited); return (id: string) => ids.has(id); };
    const work = runDaemon(plan, daemonDeps({
      refreshMerged: snapshot,
      refreshMergedAsync: async () => {
        if (credited.has("A") && delayedRead === "merged") { readStarted.resolve(undefined); await releaseRead.promise; }
        return snapshot();
      },
      readPushedRunBranches: () => {
        if (credited.has("A") && delayedRead === "branch") {
          readStarted.resolve(undefined); return releaseRead.promise.then(() => "");
        }
        return "";
      },
      checkHeavyNewBuild: () => held ? HOLD : undefined,
      checkStop: () => stop ? "test complete" : undefined,
      runOne: async (id) => {
        calls.push(id);
        if (calls.length === 2) bothStarted.resolve(undefined);
        if (id === "C") heldOrStarted.resolve(undefined);
        const result = await (id === "A" ? a.promise : id === "B" ? b.promise : Promise.resolve(ok(id)));
        credited.add(id); return result;
      },
      log: (step, fields) => {
        rows.push({ step, task: fields?.task });
        if (step === "dispatch.new_build_held" && fields?.task === "C") heldOrStarted.resolve(undefined);
      },
    }), { laneCount: 2, max: 3, pollIntervalMs: 10 });
    t.after(async () => { stop = true; releaseRead.resolve(undefined); a.resolve(ok("A")); b.resolve(ok("B")); await work; });
    await bothStarted.promise;
    a.resolve(ok("A"));
    await readStarted.promise;
    held = true; releaseRead.resolve(undefined);
    await heldOrStarted.promise;
    assert.deepEqual(calls, ["A", "B"], "stale pre-read admission cannot start C");
    assert.ok(!rows.some((row) => row.step === "daemon.iteration" && row.task === "C"));
    stop = true; b.resolve(ok("B"));
    const summary = await work;
    assert.deepEqual(summary.attempted, ["A", "B"]);
    assert.deepEqual(summary.merged, ["A", "B"]);
    assert.equal(summary.costUsd, 1);
  });
}

test("held console kick survives and the SAME daemon dispatches it exactly once after release", { timeout: 2_000 }, async (t) => {
  const plan = fixturePlan(t, ["A"]), calls: string[] = [], clears: string[] = [];
  const rows: string[] = [];
  let held = true, pending = true, released = false;
  const summary = await runDaemon(plan, daemonDeps({
    pendingKicks: () => pending ? [{ taskId: "A", origin: "test" }] : [],
    clearKick: (id) => { clears.push(id); pending = false; },
    checkHeavyNewBuild: () => held ? HOLD : undefined,
    runOne: async (id) => { calls.push(id); return ok(id); },
    log: (step) => { rows.push(step); },
    sleep: async () => {
      if (rows.includes("dispatch.new_build_held") && !released) {
        assert.equal(pending, true);
        assert.deepEqual(clears, []);
        assert.deepEqual(calls, []);
        held = false; released = true;
      }
      await yieldTurn();
    },
  }), { laneCount: 1, max: 1, pollIntervalMs: 10 });
  assert.equal(released, true, "positive control: the reservation actually deferred this daemon");
  assert.deepEqual(calls, ["A"]);
  assert.deepEqual(clears, ["A"]);
  assert.equal(rows.filter((step) => step === "console.kick_dispatched").length, 1);
  assert.equal(rows.filter((step) => step === "daemon.iteration").length, 1);
  assert.deepEqual(summary.attempted, ["A"]);
  assert.equal(summary.stopReason, "max_reached");
});

test("NEW-build hold does not gate review, retro, auto-triage or sweep work", { timeout: 2_000 }, async (t) => {
  const plan = fixturePlan(t), actions: string[] = [], rows: string[] = [];
  let stop = false, reviewPending = true;
  t.after(async () => { await drainDetachedSweepActions({ boundMs: 500 }); });
  const summary = await runDaemon(plan, daemonDeps({
    checkHeavyNewBuild: () => HOLD, checkStop: () => stop ? "test complete" : undefined,
    runOne: async () => assert.fail("held NEW implement started"),
    sweep: async () => { actions.push("sweep"); },
    pendingPrActions: () => reviewPending ? [{ action: "review", prNumber: 7, origin: "test", requestedAt: "test" }] : [],
    runPrAction: async () => { actions.push("review"); return { outcome: "completed" }; },
    clearPrAction: () => { reviewPending = false; },
    checkRetroTrigger: () => ({ fire: true, reason: "merges", mergesSinceMarker: 10, daysSinceMarker: 0 }),
    runRetroTrigger: async () => { actions.push("retro"); },
    checkAutoTriage: () => ({ fire: true, feedbackId: "heavy-admission-control", reason: "test" }),
    runAutoTriage: async () => { actions.push("triage"); },
    log: (step) => { rows.push(step); },
    sleep: async () => {
      if (rows.includes("dispatch.new_build_held")) stop = true;
      await yieldTurn();
    },
  }), { laneCount: 1, pollIntervalMs: 10 });
  await drainDetachedSweepActions({ boundMs: 500 });
  assert.ok(rows.includes("dispatch.new_build_held"), "hold was really observed, not an empty-queue control");
  for (const action of ["review", "retro", "triage", "sweep"]) assert.ok(actions.includes(action), `${action} still ran`);
  assert.deepEqual(summary.attempted, []);
  assert.equal(summary.costUsd, 0);
  assert.equal(summary.stopReason, "stopped");
});

for (const laneCount of [1, 2]) {
  test(`daemon ${laneCount} lane first wave re-reads a hold raised while its interphase clock stops`, { timeout: 2_000 }, async (t) => {
    const ids = laneCount === 1 ? ["A"] : ["A", "B"];
    const plan = fixturePlan(t, ids), credited = new Set<string>(), calls: string[] = [];
    const firstWait = deferred<void>(), clockWaiting = deferred<void>(), admittedBeforeStop = deferred<void>();
    const heldOrStarted = deferred<void>(), rows: string[] = [], readings: boolean[] = [];
    let firstClockWait = true, selected = false, held = false, stop = false, clockWaits = 0, completed = false;
    const work = runDaemon(plan, daemonDeps({
      refreshMerged: () => (id) => credited.has(id), checkStop: () => stop ? "test cleanup" : undefined,
      memoryGovernor: { step: () => ({ tier: "clear", heapGrowingPercent: 50, changed: false, previousTier: "clear", reading: { rss_bytes: 0 } }) },
      heapStatistics: () => ({ used_heap_size: 0, heap_size_limit: 1 }),
      checkQuietHours: () => { if (selected) admittedBeforeStop.resolve(undefined); return undefined; },
      checkHeavyNewBuild: () => { readings.push(held); return held ? HOLD : undefined; },
      sleepUntilSweepWake: async () => {
        clockWaits++;
        // A removed-fix control must report its extra post-completion wait, not
        // spin forever and lose TAP. This pending promise owns no event-loop handle.
        if (completed) return new Promise<undefined>(() => {});
        if (firstClockWait) {
          firstClockWait = false; clockWaiting.resolve(undefined); await firstWait.promise;
        } else await yieldTurn();
        return undefined;
      },
      runOne: async (id) => { calls.push(id); heldOrStarted.resolve(undefined); credited.add(id); return ok(id); },
      log: (step) => {
        rows.push(step);
        if (step === "daemon.tick_phases") selected = true;
        if (step === "dispatch.new_build_held") heldOrStarted.resolve(undefined);
      },
    }), { laneCount, max: ids.length, pollIntervalMs: 10 });
    t.after(async () => { stop = true; firstWait.resolve(undefined); await work; });
    await clockWaiting.promise;
    await admittedBeforeStop.promise;
    // All earlier ports are synchronous here. One turn reaches clock.stop(), which cannot
    // finish while the real interphase runner's first injected wait is unresolved.
    await yieldTurn();
    assert.equal(selected, true, "positive control: a runnable first wave was selected");
    assert.deepEqual(calls, [], "the actual clock stop still prevents runOne");
    assert.equal(readings.length, 0, "reservation admission must follow the awaited clock stop");
    held = true; firstWait.resolve(undefined);
    await heldOrStarted.promise;
    assert.deepEqual(calls, [], "a hold raised during stop refuses the already-selected first wave");
    assert.equal(rows.filter((step) => step === "dispatch.new_build_held").length, ids.length);
    assert.ok(!rows.includes("daemon.iteration"), "held work spends no attempt");
    held = false;
    const summary = await work;
    completed = true;
    assert.deepEqual(calls, ids, "release starts each task exactly once in the same daemon");
    assert.deepEqual(summary.attempted, ids);
    assert.deepEqual(summary.merged, ids);
    assert.equal(summary.costUsd, ids.length * 0.5);
    assert.equal(summary.stopReason, "max_reached");
    assert.ok(readings.includes(true) && readings.includes(false), "both actual-start verdicts were exercised");
    const stoppedAt = clockWaits;
    for (let turn = 0; turn < 3; turn++) await yieldTurn();
    assert.equal(clockWaits, stoppedAt, "a held tick must retire its prior clock before a new tick owns one");
  });
}

test("SRE governor evaluates new evidence on a later tick while NEW implement stays held", { timeout: 2_000 }, async (t) => {
  const plan = fixturePlan(t, ["A"]), nowMs = Date.parse("2026-10-11T12:00:00Z");
  const rows: Array<Record<string, unknown>> = [];
  const receipt = (id: string) => ({
    ts: new Date(nowMs).toISOString(), step: "sre.runbook", id, fingerprint: "b".repeat(64), mode: "shadow", outcome: "would_act",
  });
  rows.push(receipt("heavy-control-first"));
  let stop = false, secondAdded = false, governorReads = 0;
  const pauses: string[] = [];
  const work = runDaemon(plan, daemonDeps({
    now: () => new Date(nowMs), checkStop: () => stop ? "test complete" : undefined,
    memoryGovernor: { step: () => ({ tier: "clear", heapGrowingPercent: 50, changed: false, previousTier: "clear", reading: { rss_bytes: 0 } }) },
    heapStatistics: () => ({ used_heap_size: 0, heap_size_limit: 1 }),
    checkHeavyNewBuild: () => HOLD,
    runOne: async () => assert.fail("held NEW implement started"),
    sreGovernor: {
      readLedger: () => { governorReads++; return rows; }, laneOff: () => undefined,
      pauseLane: (text) => { pauses.push(text); }, resumeLane: () => { pauses.push("resumed"); },
    },
    log: (step, fields = {}) => { rows.push({ ts: new Date(nowMs).toISOString(), ...fields, step }); },
    sleep: async () => {
      if (rows.some((row) => row.step === "dispatch.new_build_held") && !secondAdded) {
        secondAdded = true; rows.push(receipt("heavy-control-second"));
      } else if (rows.some((row) => row.step === "sre.governor" && row.runbook === "heavy-control-second")) stop = true;
      await yieldTurn();
    },
  }), { laneCount: 1, pollIntervalMs: 10 });
  t.after(async () => { stop = true; await work; });
  const summary = await work;
  const heldAt = rows.findIndex((row) => row.step === "dispatch.new_build_held");
  const secondAt = rows.findIndex((row) => row.step === "sre.governor" && row.runbook === "heavy-control-second");
  assert.ok(heldAt >= 0 && secondAdded, "positive control: NEW admission was held before new SRE evidence arrived");
  assert.ok(governorReads >= 2 && secondAt > heldAt, "the real governor still evaluates evidence after a held tick");
  assert.equal(rows[secondAt].to, "shadow", "the reservation must not become an SRE global stop");
  assert.deepEqual(pauses, []);
  assert.deepEqual(summary.attempted, []);
  assert.equal(summary.costUsd, 0);
  assert.equal(summary.stopReason, "stopped");
});

test("pool first-wave admission fault drains the owned sibling rejection without a phantom slot", { timeout: 2_000 }, async (t) => {
  const tasks = ["A", "B", "C"].map((id) => ({ id })), originalB = tasks[1];
  const a = deferred<string>(), lanes = { inFlight: 0 }, started: string[] = [];
  const sentinel = new Error("first-wave admission sentinel"), workerFailure = new Error("owned worker rejection");
  let ended = false;
  const work = runLanePool(tasks, (id) => { started.push(id); return a.promise; },
    () => assert.fail("fault must close refills"), lanes, (task) => {
      if (task.id === "B") throw sentinel;
      return true;
    });
  void work.then(() => { ended = true; });
  t.after(async () => { a.resolve("cleanup"); await work; });
  assert.deepEqual(started, ["A"], "first wave still starts synchronously and C never starts");
  assert.equal(lanes.inFlight, 1);
  await yieldTurn();
  assert.equal(ended, false, "an admission fault cannot abandon an active worker");
  a.reject(workerFailure);
  const outcome = await work;
  assert.deepEqual(outcome.settled, [{ status: "rejected", reason: workerFailure }]);
  assert.deepEqual(outcome.fault, { task: originalB, lane: 1, phase: "admit", reason: sentinel });
  assert.equal(outcome.fault!.reason, sentinel, "preserve original exception identity");
  assert.deepEqual(tasks.map((task) => task.id), ["A"]);
  assert.equal(lanes.inFlight, 0);
});

test("pool fault presence survives falsy throws from admit and the sixth-argument onStarted hook", { timeout: 2_000 }, async () => {
  for (const phase of ["admit", "onStarted"] as const) for (const reason of [undefined, null, false, 0, ""]) {
    const tasks = [{ id: "A" }, { id: "B" }], first = tasks[0], started: string[] = [];
    const lanes = { inFlight: 0 };
    const work = runLanePool(tasks, (id) => { started.push(id); return Promise.resolve(id); },
      () => assert.fail("fault must not propose new work"), lanes,
      phase === "admit" ? () => { throw reason; } : undefined,
      (task, lane, refill) => {
        assert.equal(task, first);
        assert.equal(lane, 0);
        assert.equal(refill, false);
        assert.equal(lanes.inFlight, 1, "pool owns the worker before calling onStarted");
        throw reason;
      });
    assert.deepEqual(started, phase === "admit" ? [] : ["A"]);
    const outcome = await work;
    assert.ok(outcome.fault, `${phase}: ${String(reason)} is not a refusal or clear reading`);
    assert.equal(outcome.fault.reason, reason);
    assert.equal(outcome.fault.phase, phase);
    assert.equal(outcome.fault.task, first);
    assert.equal(outcome.settled.length, phase === "admit" ? 0 : 1);
    assert.equal(tasks.length, outcome.settled.length);
    assert.equal(lanes.inFlight, 0);
  }
});

test("onStarted fault keeps the actual pending worker and its rejection handler", { timeout: 2_000 }, async (t) => {
  const tasks = [{ id: "A" }, { id: "B" }], a = deferred<string>(), lanes = { inFlight: 0 };
  const sentinel = new Error("onStarted sentinel"), workerFailure = new Error("worker after logging failure");
  const started: string[] = [], hooks: string[] = [];
  let ended = false;
  const work = runLanePool(tasks, (id) => { started.push(id); return a.promise; },
    () => assert.fail("onStarted fault closes refill"), lanes, () => true, (task) => {
      hooks.push(task.id); assert.deepEqual(started, ["A"]); throw sentinel;
    });
  void work.then(() => { ended = true; });
  t.after(async () => { a.resolve("cleanup"); await work; });
  await yieldTurn();
  assert.equal(ended, false);
  a.reject(workerFailure);
  const outcome = await work;
  assert.deepEqual(started, ["A"]);
  assert.deepEqual(hooks, ["A"]);
  assert.deepEqual(outcome.settled, [{ status: "rejected", reason: workerFailure }]);
  assert.equal(outcome.fault!.phase, "onStarted");
  assert.equal(outcome.fault!.reason, sentinel);
  assert.equal(lanes.inFlight, 0);
});

for (const promised of [false, true]) {
  test(`pool ${promised ? "promised" : "synchronous"} refill admission fault waits only for actual siblings`, { timeout: 2_000 }, async (t) => {
    const tasks = [{ id: "A" }, { id: "B" }], a = deferred<string>(), b = deferred<string>();
    const proposal = deferred<{ id: string } | undefined>(), proposed = deferred<void>(), checked = deferred<void>();
    const sentinel = new Error("refill admission sentinel"), candidate = { id: "C" };
    const lanes = { inFlight: 0 }, started: string[] = [];
    let ended = false;
    const work = runLanePool(tasks, (id) => {
      started.push(id); return id === "A" ? a.promise : b.promise;
    }, (_lane, finished) => {
      assert.equal(finished.id, "B"); proposed.resolve(undefined);
      return promised ? proposal.promise : candidate;
    }, lanes, (_task, lane, refill) => {
      if (refill) { assert.equal(lane, 1); checked.resolve(undefined); throw sentinel; }
      return true;
    });
    void work.then(() => { ended = true; });
    t.after(async () => { proposal.resolve(undefined); a.resolve("A"); b.resolve("B"); await work; });
    assert.deepEqual(started, ["A", "B"]);
    b.resolve("B"); await proposed.promise;
    if (promised) proposal.resolve(candidate);
    await checked.promise; await yieldTurn();
    assert.equal(ended, false);
    assert.deepEqual(started, ["A", "B"]);
    a.resolve("A");
    const outcome = await work;
    assert.deepEqual(outcome.fault, { task: candidate, lane: 1, phase: "admit", reason: sentinel });
    assert.equal(outcome.fault!.reason, sentinel);
    assert.deepEqual(outcome.settled, [{ status: "fulfilled", value: "A" }, { status: "fulfilled", value: "B" }]);
    assert.equal(lanes.inFlight, 0);
  });
}

for (const late of ["fulfill", "reject"] as const) {
  test(`pool fault retires a stuck refill proposal and handles its late ${late}`, { timeout: 2_000 }, async (t) => {
    const tasks = ["A", "B", "C"].map((id) => ({ id }));
    const a = deferred<string>(), b = deferred<string>(), c = deferred<string>();
    const pending = deferred<{ id: string } | undefined>(), pendingRequested = deferred<void>(), checked = deferred<void>();
    const sentinel = new Error("other refill admission sentinel"), lateReason = new Error("late retired proposal");
    const candidate = { id: "E" }, started: string[] = [], lanes = { inFlight: 0 };
    let ended = false;
    const work = runLanePool(tasks, (id) => {
      started.push(id); return id === "A" ? a.promise : id === "B" ? b.promise : c.promise;
    }, (_lane, finished) => {
      if (finished.id === "A") { pendingRequested.resolve(undefined); return pending.promise; }
      assert.equal(finished.id, "B"); return candidate;
    }, lanes, (task, _lane, refill) => {
      if (refill && task.id === "E") { checked.resolve(undefined); throw sentinel; }
      return true;
    });
    void work.then(() => { ended = true; });
    t.after(async () => { pending.resolve(undefined); a.resolve("A"); b.resolve("B"); c.resolve("C"); await work; });
    a.resolve("A"); await pendingRequested.promise;
    b.resolve("B"); await checked.promise; await yieldTurn();
    assert.equal(ended, false, "C is a real worker and must finish");
    c.resolve("C");
    const outcome = await work; // deliberately BEFORE pending settles: proposals are not workers
    assert.equal(outcome.fault!.reason, sentinel);
    assert.equal(outcome.fault!.task, candidate);
    assert.equal(outcome.settled.length, 3);
    if (late === "fulfill") pending.resolve({ id: "D" });
    else pending.reject(lateReason);
    await yieldTurn();
    assert.deepEqual(started, ["A", "B", "C"], "late proposals cannot reopen starts");
    assert.deepEqual(tasks.map((task) => task.id), started);
    assert.equal(outcome.fault!.reason, sentinel, "late rejection cannot replace the first fault");
    assert.equal(lanes.inFlight, 0, "retired proposal completion cannot underflow worker accounting");
  });
}

test("opt-in pool reports unexpected refill producer faults instead of orphaning its active sibling", { timeout: 2_000 }, async (t) => {
  for (const promised of [false, true]) {
    const tasks = [{ id: "A" }, { id: "B" }], a = deferred<string>(), b = deferred<string>();
    const proposal = deferred<{ id: string } | undefined>(), proposed = deferred<void>();
    const sentinel = new Error("producer sentinel"), lanes = { inFlight: 0 };
    const work = runLanePool(tasks, (id) => id === "A" ? a.promise : b.promise, () => {
      proposed.resolve(undefined); if (promised) return proposal.promise; throw sentinel;
    }, lanes, () => true);
    t.after(async () => { a.resolve("A"); b.resolve("B"); proposal.resolve(undefined); await work; });
    b.resolve("B"); await proposed.promise;
    if (promised) proposal.reject(sentinel);
    await yieldTurn();
    a.resolve("A");
    const outcome = await work;
    assert.equal(outcome.fault!.phase, "refill");
    assert.equal(outcome.fault!.reason, sentinel);
    assert.equal(outcome.settled.length, 2);
    assert.equal(lanes.inFlight, 0);
  }
});

test("daemon held-log fault is classified, not a phantom attempt or consumed console kick", { timeout: 2_000 }, async (t) => {
  const plan = fixturePlan(t, ["A"]), calls: string[] = [], clears: string[] = [];
  const rows: Array<{ step: string; fields: Record<string, unknown> }> = [];
  const sentinel = new Error("held-log sentinel");
  let thrown = false, stop = false;
  const work = runDaemon(plan, daemonDeps({
    pendingKicks: () => [{ taskId: "A", origin: "test" }], clearKick: (id) => { clears.push(id); },
    checkStop: () => stop ? "test cleanup" : undefined,
    checkHeavyNewBuild: () => HOLD,
    runOne: async (id) => { calls.push(id); return ok(id); },
    log: (step, fields = {}) => {
      rows.push({ step, fields });
      if (step === "dispatch.new_build_held" && !thrown) { thrown = true; throw sentinel; }
    },
  }), { laneCount: 1, max: 1, pollIntervalMs: 10 });
  t.after(async () => { stop = true; await work; });
  const summary = await work;
  assert.equal(thrown, true, "real admission logging seam reached");
  assert.equal(summary.stopReason, "error");
  assert.match(summary.stopDetail ?? "", /A: admit: held-log sentinel/);
  assert.deepEqual(calls, []);
  assert.deepEqual(clears, []);
  assert.deepEqual(summary.attempted, []);
  assert.deepEqual(summary.merged, []);
  assert.equal(summary.costUsd, 0);
  assert.equal(rows.find((row) => row.step === "dispatch.pool_failed")?.fields.phase, "admit");
  assert.equal(rows.find((row) => row.step === "dispatch.settled_set")?.fields.dispatched, 0);
});

test("daemon later first-wave admission log fault drains and credits only its actual sibling", { timeout: 2_000 }, async (t) => {
  const plan = fixturePlan(t, ["A", "B", "C"]), a = deferred<RunResult>(), faultSeen = deferred<void>();
  const credited = new Set<string>(), calls: string[] = [], rows: Array<{ step: string; fields: Record<string, unknown> }> = [];
  const sentinel = new Error("later admission log sentinel");
  let held = false, thrown = false, stop = false, ended = false;
  const work = runDaemon(plan, daemonDeps({
    refreshMerged: () => (id) => credited.has(id), checkStop: () => stop ? "test cleanup" : undefined,
    checkHeavyNewBuild: () => held ? HOLD : undefined,
    runOne: async (id) => { calls.push(id); held = true; const result = await a.promise; credited.add(id); return result; },
    log: (step, fields = {}) => {
      rows.push({ step, fields });
      if (step === "dispatch.new_build_held" && fields.task === "B" && !thrown) {
        thrown = true; faultSeen.resolve(undefined); throw sentinel;
      }
    },
  }), { laneCount: 3, max: 3, pollIntervalMs: 10 });
  void work.then(() => { ended = true; });
  t.after(async () => { stop = true; a.resolve(ok("A")); await work; });
  await faultSeen.promise; await yieldTurn();
  assert.equal(ended, false, "admission error cannot finish while A still runs");
  assert.deepEqual(calls, ["A"]);
  a.resolve(ok("A"));
  const summary = await work;
  assert.equal(summary.stopReason, "error");
  assert.match(summary.stopDetail ?? "", /B: admit: later admission log sentinel/);
  assert.deepEqual(summary.attempted, ["A"]);
  assert.deepEqual(summary.merged, ["A"]);
  assert.equal(summary.costUsd, 0.5);
  const settled = rows.find((row) => row.step === "dispatch.settled_set")!.fields;
  assert.equal(settled.dispatched, 1);
  assert.deepEqual((settled.tasks as Array<{ id: string }>).map((task) => task.id), ["A"]);
});

for (const failingStep of ["daemon.iteration", "console.kick_dispatched"] as const) {
  test(`daemon ${failingStep} fault happens after ownership and keeps actual attempt/kick/cost/credit`, { timeout: 2_000 }, async (t) => {
    const plan = fixturePlan(t), a = deferred<RunResult>(), faultSeen = deferred<void>();
    const credited = new Set<string>(), calls: string[] = [], clears: string[] = [];
    const rows: Array<{ step: string; fields: Record<string, unknown> }> = [], sentinel = new Error("accepted log sentinel");
    const withKick = failingStep === "console.kick_dispatched";
    let pending = true, thrown = false, stop = false, ended = false;
    const work = runDaemon(plan, daemonDeps({
      refreshMerged: () => (id) => credited.has(id), checkStop: () => stop ? "test cleanup" : undefined,
      checkHeavyNewBuild: () => undefined,
      pendingKicks: () => withKick && pending ? [{ taskId: "A", origin: "test" }] : [],
      clearKick: (id) => { assert.deepEqual(calls, ["A"], "kick cannot clear before actual runOne"); clears.push(id); pending = false; },
      runOne: async (id) => { calls.push(id); const result = await a.promise; credited.add(id); return result; },
      log: (step, fields = {}) => {
        rows.push({ step, fields });
        if (step === failingStep && fields.task === "A" && !thrown) {
          thrown = true; faultSeen.resolve(undefined); throw sentinel;
        }
      },
    }), { laneCount: 2, max: 2, pollIntervalMs: 10 });
    void work.then(() => { ended = true; });
    t.after(async () => { stop = true; a.resolve(ok("A")); await work; });
    await faultSeen.promise; await yieldTurn();
    assert.equal(ended, false);
    assert.deepEqual(calls, ["A"], "no later start after an accepted-bookkeeping fault");
    assert.deepEqual(clears, withKick ? ["A"] : []);
    a.resolve(ok("A"));
    const summary = await work;
    assert.equal(summary.stopReason, "error");
    assert.match(summary.stopDetail ?? "", /A: onStarted: accepted log sentinel/);
    assert.deepEqual(summary.attempted, ["A"], "logging failure cannot erase the owned attempt");
    assert.deepEqual(summary.merged, ["A"]);
    assert.equal(summary.costUsd, 0.5);
    assert.equal(rows.find((row) => row.step === "dispatch.pool_failed")?.fields.phase, "onStarted");
    assert.equal(rows.find((row) => row.step === "dispatch.settled_set")?.fields.dispatched, 1);
  });
}

test("daemon classifies the original TaskAdmissionError pool fault as stand-down, not generic fatal", { timeout: 2_000 }, async (t) => {
  const plan = fixturePlan(t, ["A"]), sentinel = new TaskAdmissionError("admission classification sentinel");
  const rows: Array<{ step: string; fields: Record<string, unknown> }> = [];
  let thrown = false, stop = false;
  const summary = await runDaemon(plan, daemonDeps({
    checkHeavyNewBuild: () => HOLD, checkStop: () => stop ? "test complete" : undefined,
    runOne: async () => assert.fail("unstarted admission fault cannot run"),
    log: (step, fields = {}) => {
      rows.push({ step, fields });
      if (step === "dispatch.new_build_held" && !thrown) { thrown = true; throw sentinel; }
      if (step === "daemon.admission_stood_down") stop = true;
    },
  }), { laneCount: 1, pollIntervalMs: 10 });
  assert.equal(thrown, true);
  assert.equal(summary.stopReason, "stopped");
  assert.equal(rows.find((row) => row.step === "daemon.admission_stood_down")?.fields.reason, sentinel.message);
  assert.equal(rows.find((row) => row.step === "dispatch.pool_failed")?.fields.phase, "admit");
  assert.deepEqual(summary.attempted, []);
  assert.equal(summary.costUsd, 0);
});

test("four-argument pool keeps its array API, synchronous first wave and lane-local rejected proposal", { timeout: 2_000 }, async (t) => {
  const tasks = [{ id: "A" }, { id: "B" }], a = deferred<string>(), b = deferred<string>();
  const proposal = deferred<{ id: string } | undefined>(), proposed = deferred<void>();
  const lanes = { inFlight: 0 }, started: string[] = [];
  const work = runLanePool(tasks, (id) => { started.push(id); return id === "A" ? a.promise : b.promise; },
    () => { proposed.resolve(undefined); return proposal.promise; }, lanes);
  t.after(async () => { a.resolve("A"); b.resolve("B"); proposal.resolve(undefined); await work; });
  assert.deepEqual(started, ["A", "B"], "legacy first wave remains synchronous");
  b.resolve("B"); await proposed.promise;
  proposal.reject(new Error("legacy failed proposal")); await yieldTurn();
  a.resolve("A");
  const settled: PromiseSettledResult<string>[] = await work; // compile-time legacy return control
  assert.deepEqual(settled, [{ status: "fulfilled", value: "A" }, { status: "fulfilled", value: "B" }]);
  assert.deepEqual(tasks.map((task) => task.id), ["A", "B"]);
  assert.equal(lanes.inFlight, 0);
});

test("daemon refill logging fault owns C first, then drains and credits all actual siblings", { timeout: 2_000 }, async (t) => {
  const plan = fixturePlan(t, ["A", "B", "C"]), credited = new Set<string>(), calls: string[] = [];
  const a = deferred<RunResult>(), b = deferred<RunResult>(), c = deferred<RunResult>();
  const bothStarted = deferred<void>(), faultSeen = deferred<void>(), sentinel = new Error("refilled log sentinel");
  const rows: Array<{ step: string; fields: Record<string, unknown> }> = [];
  let thrown = false, stop = false, ended = false;
  const work = runDaemon(plan, daemonDeps({
    refreshMerged: () => (id) => credited.has(id), checkStop: () => stop ? "test cleanup" : undefined,
    checkHeavyNewBuild: () => undefined,
    runOne: async (id) => {
      calls.push(id); if (calls.length === 2) bothStarted.resolve(undefined);
      const result = await (id === "A" ? a.promise : id === "B" ? b.promise : c.promise);
      credited.add(id); return result;
    },
    log: (step, fields = {}) => {
      rows.push({ step, fields });
      if (step === "dispatch.lane_refilled" && fields.next_task === "C" && !thrown) {
        thrown = true; faultSeen.resolve(undefined); throw sentinel;
      }
    },
  }), { laneCount: 2, max: 3, pollIntervalMs: 10 });
  void work.then(() => { ended = true; });
  t.after(async () => { stop = true; a.resolve(ok("A")); b.resolve(ok("B")); c.resolve(ok("C")); await work; });
  await bothStarted.promise;
  b.resolve(ok("B")); await faultSeen.promise; await yieldTurn();
  assert.deepEqual(calls, ["A", "B", "C"], "real refill runOne precedes its accepted telemetry");
  assert.equal(ended, false);
  c.resolve(ok("C")); await yieldTurn();
  assert.equal(ended, false, "the fault cannot abandon A, even after C finishes");
  a.resolve(ok("A"));
  const summary = await work;
  assert.equal(summary.stopReason, "error");
  assert.match(summary.stopDetail ?? "", /C: onStarted: refilled log sentinel/);
  assert.deepEqual(summary.attempted, ["A", "B", "C"]);
  assert.deepEqual(summary.merged, ["A", "B", "C"]);
  assert.equal(summary.costUsd, 1.5);
  assert.equal(rows.find((row) => row.step === "dispatch.settled_set")?.fields.dispatched, 3);
});

for (const late of ["fulfill", "reject"] as const) {
  test(`pool seventh-argument external close retires a pending proposal and handles late ${late}`, { timeout: 2_000 }, async (t) => {
    const tasks = [{ id: "A" }, { id: "B" }], a = deferred<string>(), b = deferred<string>();
    const pending = deferred<{ id: string } | undefined>(), proposed = deferred<void>();
    const sentinel = new Error("external phase sentinel"), workerFailure = new Error("owned B rejection");
    const control: LanePoolControl = {}, lanes = { inFlight: 0 }, calls: string[] = [];
    let ended = false;
    const work = runLanePool(tasks, (id) => { calls.push(id); return id === "A" ? a.promise : b.promise; },
      () => { proposed.resolve(undefined); return pending.promise; }, lanes, undefined, undefined, control);
    void work.then(() => { ended = true; });
    t.after(async () => { a.resolve("A"); b.resolve("B"); pending.resolve(undefined); await work; });
    assert.deepEqual(calls, ["A", "B"], "control-only opt-in preserves synchronous first wave");
    a.resolve("A"); await proposed.promise;
    control.close!(sentinel, "dispatch.concurrent_set");
    control.close!(new Error("later phase failure"), "later");
    await yieldTurn();
    assert.equal(ended, false, "closing cannot abandon B");
    assert.equal(lanes.inFlight, 1);
    b.reject(workerFailure);
    const outcome = await work; // pending is deliberately still unresolved
    assert.deepEqual(outcome.externalFault, { phase: "dispatch.concurrent_set", reason: sentinel });
    assert.equal(outcome.externalFault!.reason, sentinel);
    assert.equal(outcome.fault, undefined, "external phases do not fabricate a task fault");
    assert.deepEqual(outcome.settled, [{ status: "fulfilled", value: "A" }, { status: "rejected", reason: workerFailure }]);
    if (late === "fulfill") pending.resolve({ id: "C" }); else pending.reject(new Error("late proposal failure"));
    await yieldTurn();
    assert.deepEqual(calls, ["A", "B"]);
    assert.deepEqual(tasks.map((task) => task.id), calls);
    assert.equal(lanes.inFlight, 0);
  });
}

test("pool external close preserves falsy first faults and seals even inside admission/refill callbacks", { timeout: 2_000 }, async (t) => {
  for (const reason of [undefined, null, false, 0, ""]) {
    const control: LanePoolControl = {}, tasks = [{ id: "A" }, { id: "B" }];
    const outcome = await runLanePool(tasks, async () => assert.fail("closed admission cannot start"),
      () => undefined, undefined, () => { control.close!(reason, "external admission"); return true; }, undefined, control);
    assert.deepEqual(outcome, { settled: [], externalFault: { phase: "external admission", reason } });
    assert.deepEqual(tasks, []);
    const internalControl: LanePoolControl = {};
    const internalWork = runLanePool([{ id: "A" }], async () => assert.fail("failed admission cannot start"),
      () => undefined, undefined, () => { throw reason; }, undefined, internalControl);
    internalControl.close!(new Error("later external log"));
    const internal = await internalWork;
    assert.ok(internal.fault);
    assert.equal(internal.fault.reason, reason);
    assert.equal(internal.externalFault, undefined);
  }
  const control: LanePoolControl = {}, b = deferred<string>(), pending = deferred<{ id: string } | undefined>();
  const proposed = deferred<void>(), sentinel = new Error("close inside producer"), calls: string[] = [];
  const work = runLanePool([{ id: "A" }, { id: "B" }], (id) => {
    calls.push(id); return id === "A" ? Promise.resolve(id) : b.promise;
  }, () => { control.close!(sentinel); proposed.resolve(undefined); return pending.promise; }, undefined, undefined, undefined, control);
  t.after(async () => { b.resolve("B"); pending.resolve(undefined); await work; });
  await proposed.promise; b.resolve("B");
  const outcome = await work;
  assert.equal(outcome.externalFault!.reason, sentinel);
  assert.equal(outcome.externalFault!.phase, "external");
  pending.reject(new Error("late producer rejection")); await yieldTurn();
  assert.deepEqual(calls, ["A", "B"]);
});

for (const permanent of [false, true]) {
  test(`daemon concurrent-log ${permanent ? "repeated named-boundary" : "one-shot"} failure seals NEW and credits/classifies real workers`, { timeout: 2_000 }, async (t) => {
    const plan = fixturePlan(t, ["A", "B", "C"]), a = deferred<RunResult>(), b = deferred<RunResult>();
    const faultSeen = deferred<void>(), credited = new Set<string>(), calls: string[] = [];
    const rows: Array<{ step: string; fields: Record<string, unknown> }> = [];
    const sentinel = new Error("concurrent phase sentinel"), later = new Error("persistent named log sentinel");
    let thrown = false, stop = false, ended = false, refillRead = false;
    const work = runDaemon(plan, daemonDeps({
      refreshMerged: () => (id) => credited.has(id), checkStop: () => stop ? "cleanup" : undefined,
      readPushedRunBranches: () => { if (credited.has("A")) refillRead = true; return ""; },
      runOne: async (id) => {
        calls.push(id); const result = await (id === "A" ? a.promise : b.promise); credited.add(id); return result;
      },
      log: (step, fields = {}) => {
        rows.push({ step, fields });
        if (step === "dispatch.concurrent_set" && !thrown) { thrown = true; faultSeen.resolve(undefined); throw sentinel; }
        if (permanent && thrown && (step === "dispatch.settled_set" || step === "dispatch.pool_failed")) throw later;
      },
    }), { laneCount: 2, max: 3, pollIntervalMs: 10 });
    void work.then(() => { ended = true; }, () => { ended = true; });
    t.after(async () => { stop = true; a.resolve(ok("A")); b.resolve(ok("B")); await work; });
    await faultSeen.promise; await yieldTurn();
    assert.deepEqual(calls, ["A", "B"]); assert.equal(ended, false);
    a.resolve(ok("A")); await yieldTurn();
    assert.equal(ended, false, "phase fault must still drain B");
    assert.equal(refillRead, false, "a phase fault seals before any new proposal read");
    b.reject(new TaskAdmissionError("real B admission stand-down"));
    const summary = await work;
    assert.equal(summary.stopReason, "error");
    assert.match(summary.stopDetail ?? "", /^dispatch.concurrent_set: concurrent phase sentinel/);
    if (permanent) assert.match(summary.stopDetail!, /dispatch.settled_set: persistent named log sentinel/);
    assert.deepEqual(calls, ["A", "B"]); assert.deepEqual(summary.attempted, calls);
    assert.deepEqual(summary.merged, ["A"]); assert.equal(summary.costUsd, 0.5);
    assert.ok(rows.some((row) => row.step === "daemon.admission_stood_down" && row.fields.task === "B"));
    assert.equal(rows.find((row) => row.step === "dispatch.settled_set")?.fields.dispatched, 2);
  });
}

for (const failingStep of ["dispatch.settled_set", "dispatch.pool_failed"] as const) for (const permanent of [false, true]) {
  test(`daemon ${failingStep} ${permanent ? "repeated named-boundary" : "one-shot"} fault keeps original pool failure and all actual credit`, { timeout: 2_000 }, async (t) => {
    const plan = fixturePlan(t, ["A", "B", "C"]), a = deferred<RunResult>(), b = deferred<RunResult>();
    const faultSeen = deferred<void>(), credited = new Set<string>(), calls: string[] = [];
    const rows: Array<{ step: string; fields: Record<string, unknown> }> = [];
    const original = new Error("original B onStarted sentinel"), secondary = new Error("secondary phase log sentinel");
    let startedFault = false, logFault = false, stop = false;
    const work = runDaemon(plan, daemonDeps({
      refreshMerged: () => (id) => credited.has(id), checkStop: () => stop ? "cleanup" : undefined,
      runOne: async (id) => {
        calls.push(id); const result = await (id === "A" ? a.promise : b.promise); credited.add(id); return result;
      },
      log: (step, fields = {}) => {
        rows.push({ step, fields });
        if (step === "daemon.iteration" && fields.task === "B" && !startedFault) {
          startedFault = true; faultSeen.resolve(undefined); throw original;
        }
        if (step === failingStep && (!logFault || permanent)) { logFault = true; throw secondary; }
        if (permanent && logFault && step === "dispatch.pool_failed") throw secondary;
      },
    }), { laneCount: 3, max: 3, pollIntervalMs: 10 });
    t.after(async () => { stop = true; a.resolve(ok("A")); b.resolve(ok("B")); await work; });
    await faultSeen.promise;
    assert.deepEqual(calls, ["A", "B"], "C cannot start after B's original post-start fault");
    a.resolve(ok("A")); b.resolve(ok("B"));
    const summary = await work;
    assert.equal(summary.stopReason, "error");
    assert.match(summary.stopDetail ?? "", /^B: onStarted: original B onStarted sentinel;/);
    assert.ok(summary.stopDetail!.includes(`${failingStep}: secondary phase log sentinel`));
    assert.deepEqual(summary.attempted, ["A", "B"]); assert.deepEqual(summary.merged, ["A", "B"]);
    assert.equal(summary.costUsd, 1);
    assert.equal(rows.find((row) => row.step === "dispatch.pool_failed")?.fields.error, original.message);
    assert.equal(rows.find((row) => row.step === "dispatch.settled_set")?.fields.dispatched, 2);
    assert.ok(rows.some((row) => row.step === "daemon.summary"), "normal summary cleanup is reached");
  });
}

test("daemon settled-log-only fault is an explicit phase error after genuine accounting", { timeout: 2_000 }, async (t) => {
  const plan = fixturePlan(t), calls: string[] = [], sentinel = new Error("settled only sentinel");
  let waits = 0, waitsAtFault = 0;
  const summary = await runDaemon(plan, daemonDeps({
    sleepUntilSweepWake: async () => { waits++; await yieldTurn(); return undefined; },
    runOne: async (id) => { calls.push(id); return ok(id); },
    log: (step) => { if (step === "dispatch.settled_set") { waitsAtFault = waits; throw sentinel; } },
  }), { laneCount: 2, max: 2, pollIntervalMs: 10 });
  assert.equal(summary.stopReason, "error");
  assert.equal(summary.stopDetail, "dispatch.settled_set: settled only sentinel");
  assert.deepEqual(summary.attempted, calls); assert.deepEqual(summary.merged, calls);
  assert.equal(summary.costUsd, 1);
  assert.ok(waitsAtFault > 0 && waits > waitsAtFault, "real interphase clock restarts after settlement");
  const stoppedAt = waits;
  for (let turn = 0; turn < 3; turn++) await yieldTurn();
  assert.equal(waits, stoppedAt, "normal error summary stops the restarted clock");
});

test("daemon pool-failed logging fault does not replace TaskAdmissionError caller classification", { timeout: 2_000 }, async (t) => {
  const plan = fixturePlan(t, ["A"]), original = new TaskAdmissionError("original stand-down sentinel");
  const rows: string[] = [];
  const summary = await runDaemon(plan, daemonDeps({
    checkHeavyNewBuild: () => HOLD,
    runOne: async () => assert.fail("held fault cannot fabricate an attempt"),
    log: (step) => {
      rows.push(step);
      if (step === "dispatch.new_build_held") throw original;
      if (step === "dispatch.pool_failed") throw new Error("permanent pool-failed sink refusal");
    },
  }), { laneCount: 1, pollIntervalMs: 10 });
  assert.ok(rows.includes("daemon.admission_stood_down"), "classify original, not the logger exception");
  assert.equal(summary.stopReason, "error");
  assert.equal(summary.stopDetail, "dispatch.pool_failed: permanent pool-failed sink refusal");
  assert.deepEqual(summary.attempted, []); assert.deepEqual(summary.merged, []); assert.equal(summary.costUsd, 0);
});

test("daemon synchronous maintenance scheduling fault seals NEW without dropping active accounting", { timeout: 2_000 }, async (t) => {
  const plan = fixturePlan(t, ["A", "B", "C"]), a = deferred<RunResult>(), b = deferred<RunResult>();
  const faultSeen = deferred<void>(), calls: string[] = [], sentinel = new Error("maintenance scheduling sentinel");
  let ended = false, stop = false;
  const deps = daemonDeps({
    checkStop: () => stop ? "cleanup" : undefined,
    runOne: (id) => { calls.push(id); return id === "A" ? a.promise : b.promise; },
  });
  Object.defineProperty(deps, "repositoryMaintenance", { get: () => { faultSeen.resolve(undefined); throw sentinel; } });
  const work = runDaemon(plan, deps, { laneCount: 2, max: 3, pollIntervalMs: 10 });
  void work.then(() => { ended = true; }, () => { ended = true; });
  t.after(async () => { stop = true; a.resolve(ok("A")); b.resolve(ok("B")); await work; });
  await faultSeen.promise; await yieldTurn();
  assert.equal(ended, false); assert.deepEqual(calls, ["A", "B"]);
  a.resolve(ok("A")); b.resolve(ok("B"));
  const summary = await work;
  assert.equal(summary.stopReason, "error");
  assert.equal(summary.stopDetail, "dispatch.repository_maintenance: maintenance scheduling sentinel");
  assert.deepEqual(summary.attempted, ["A", "B"]); assert.deepEqual(summary.merged, ["A", "B"]);
  assert.equal(summary.costUsd, 1);
});

test("daemon later pool-failed logger error cannot replace an original falsy admission fault", { timeout: 2_000 }, async (t) => {
  const plan = fixturePlan(t, ["A"]);
  for (const reason of [undefined, null, false, 0, ""]) {
    const summary = await runDaemon(plan, daemonDeps({
      checkHeavyNewBuild: () => HOLD,
      runOne: async () => assert.fail("failed admission starts no work"),
      log: (step) => {
        if (step === "dispatch.new_build_held") throw reason;
        if (step === "dispatch.pool_failed") throw new Error("secondary logger error");
      },
    }), { laneCount: 1, pollIntervalMs: 10 });
    assert.equal(summary.stopReason, "error");
    assert.equal(summary.stopDetail, `A: admit: ${String(reason)}; dispatch.pool_failed: secondary logger error`);
    assert.deepEqual(summary.attempted, []); assert.deepEqual(summary.merged, []); assert.equal(summary.costUsd, 0);
  }
});
