import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { setImmediate as yieldTurn } from "node:timers/promises";
import { runDaemon, type DaemonDeps, type DaemonSummary } from "../src/lib/daemon.js";
import { loadPlan, TaskAdmissionError, type Plan } from "../src/lib/plan.js";
import type { RunResult } from "../src/lib/run-result.js";

function planFixture(t: TestContext, dependent = false): Plan {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "rmd-settled-fault-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "tasks.yaml");
  writeFileSync(path, (dependent ? ["A", "B", "D"] : ["A", "B"]).map((id) =>
    `- id: ${id}\n  title: task ${id}\n  repo: remudero\n  type: implement\n  verify: auto\n  status: queued\n  depends_on: [${id === "D" ? "A" : ""}]\n  files: [src/${id.toLowerCase()}.ts]\n`).join(""));
  return loadPlan(path);
}
const result = (id: string, verdict: RunResult["verdict"] = "merged"): RunResult => ({
  taskId: id, runId: `${id}-settled`, merged: verdict === "merged", verdict, costUsd: id === "A" ? 0.25 : 0.75,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function depsFixture(t: TestContext, overrides: Partial<DaemonDeps>): DaemonDeps {
  let finished = false;
  t.after(() => { finished = true; });
  return {
    refreshMerged: () => () => false, readLedgerLines: () => [], runOne: async (id) => result(id),
    checkCostGovernor: () => undefined, checkQueueGovernor: () => undefined,
    checkMemoryGovernor: () => undefined, checkQuietHours: () => undefined,
    memoryGovernor: { step: () => ({ tier: "clear", previousTier: "clear", changed: false, heapGrowingPercent: 50, reading: { rss_bytes: 0 } }) },
    heapStatistics: () => ({ used_heap_size: 0, heap_size_limit: 1 }),
    sweepLight: async () => {}, sleep: async () => { await yieldTurn(); },
    // A removed repair may leak a clock. Retain its observable failure without spinning forever or accepting timeout as evidence.
    sleepUntilSweepWake: async () => { if (finished) return new Promise<undefined>(() => {}); await yieldTurn(); return undefined; }, ...overrides,
  };
}
function assertReportingFault(summary: DaemonSummary, step: string, detail?: string): void {
  assert.equal(summary.stopReason, "error", "a failed reporting sink cannot produce successful assurance");
  const fault = summary.reportingFaults?.find((row) => row.phase === `report.${step}`);
  assert.ok(fault, `caller must see the separately named ${step} reporting fault`);
  if (detail !== undefined) assert.equal(fault.detail, detail);
}

for (const sinkReason of [new Error("sink unavailable"), undefined, null, false, 0, ""] as const) {
  test(`post-settlement classification reporting fault preserves real sibling credit (${String(sinkReason)})`, { timeout: 3_000 }, async (t) => {
    const a = deferred<RunResult>(), b = deferred<RunResult>(), started = deferred<void>();
    const calls: string[] = [], classified: string[] = [];
    let activeB = true, completed = false, stop = false, clockWaits = 0, serviceStops = 0;
    const work = runDaemon(planFixture(t), depsFixture(t, {
      runOne: (id) => { calls.push(id); if (calls.length === 2) started.resolve(undefined); return id === "A" ? a.promise : b.promise; },
      checkStop: () => stop ? "test cleanup" : undefined,
      gardens: [() => ({ stop: () => { serviceStops++; } })],
      sleepUntilSweepWake: async () => {
        clockWaits++;
        if (completed) return new Promise<undefined>(() => {}); // no event-loop handle: an unfixed clock must produce TAP, not hang
        await yieldTurn(); return undefined;
      },
      log: (step, fields) => {
        if (step === "daemon.admission_stood_down") {
          assert.equal(activeB, false, "classification must not run until the actual sibling settles");
          classified.push(String(fields?.reason)); throw sinkReason;
        }
      },
    }), { laneCount: 2, max: 2, pollIntervalMs: 10 });
    // Attach both outcomes before releasing either worker; an unfixed sink failure is an assertion failure, not an unhandled rejection.
    const outcome = work.then((summary) => ({ summary }), (error: unknown) => ({ error }));
    t.after(async () => { stop = true; a.resolve(result("A")); b.resolve(result("B")); await outcome; });
    await started.promise;
    a.reject(new TaskAdmissionError("original admission invalidated"));
    await yieldTurn();
    assert.deepEqual(classified, [], "positive pending-sibling control");
    activeB = false; b.resolve(result("B"));
    const closed = await outcome; completed = true;
    assert.ok("summary" in closed, "a sink exception must not replace the original classification");
    assert.deepEqual(calls, ["A", "B"]);
    assert.deepEqual(classified, ["original admission invalidated"]);
    assert.deepEqual(closed.summary.attempted, ["A", "B"]);
    assert.deepEqual(closed.summary.merged, ["B"]);
    assert.equal(closed.summary.costUsd, 0.75);
    assertReportingFault(closed.summary, "daemon.admission_stood_down", sinkReason instanceof Error ? sinkReason.message : String(sinkReason));
    assert.ok(clockWaits > 0, "positive control: the real injected clock ran");
    assert.equal(serviceStops, 1, "owned service stops once, independently of reporting");
    const stoppedAt = clockWaits;
    for (let turn = 0; turn < 3; turn++) await yieldTurn();
    assert.equal(clockWaits, stoppedAt, "post-settlement reporting failure must retire the restarted clock");
  });
}

for (const step of ["daemon.block.awaiting_merge", "daemon.merge_credit_correction", "daemon.blocked", "daemon.block.parked"] as const) {
  test(`post-settlement ${step} repeated sink refusal preserves later sibling reconciliation`, { timeout: 3_000 }, async (t) => {
    const calls: string[] = [], sinkCalls: string[] = [];
    const verdict = step === "daemon.block.awaiting_merge" ? "awaiting_merge" : step === "daemon.merge_credit_correction" ? "task_already_merged" : "blocked";
    let escalations = 0, ranA = false;
    const summary = await runDaemon(planFixture(t, verdict === "blocked"), depsFixture(t, {
      refreshMerged: () => { const aVisible = ranA && verdict === "task_already_merged"; return (id) => id === "A" && aVisible; },
      isOpenPr: () => undefined, isCreditIndeterminate: () => false,
      runOne: async (id) => { calls.push(id); ranA ||= id === "A"; return result(id, id === "A" ? verdict : "merged"); },
      escalateBlock: async () => { escalations++; },
      log: (name) => { if (name === step || name === "daemon.summary") { sinkCalls.push(name); throw new Error(`sink refused ${name}`); } },
    }), { laneCount: 2, max: 2, pollIntervalMs: 10 });
    assert.deepEqual(calls, ["A", "B"], "no downstream dispatch or reporting retry");
    assert.deepEqual(summary.attempted, ["A", "B"]);
    assert.deepEqual(summary.merged, verdict === "task_already_merged" ? ["A", "B"] : ["B"]);
    assert.equal(summary.costUsd, 1, "a partial first result never duplicates cost or hides its sibling");
    assert.equal(escalations, verdict === "blocked" ? 1 : 0);
    assertReportingFault(summary, step);
    assertReportingFault(summary, "daemon.summary");
    assert.deepEqual(sinkCalls, [step, "daemon.summary"], "never retry through a failed sink");
  });
}

test("post-settlement no-fault control preserves ordinary accounting and max", async (t) => {
  const summary = await runDaemon(planFixture(t), depsFixture(t, {}), { laneCount: 2, max: 2, pollIntervalMs: 10 });
  assert.equal(summary.stopReason, "max_reached");
  assert.deepEqual(summary.merged, ["A", "B"]);
  assert.equal(summary.costUsd, 1);
  assert.equal(summary.reportingFaults, undefined);
});

test("post-settlement idle-window reporter refusal preserves all settled worker accounting", { timeout: 3_000 }, async (t) => {
  let now = 0, samples = 0;
  const outcome = await runDaemon(planFixture(t), depsFixture(t, {
    now: () => new Date(now),
    runOne: async (id) => { await yieldTurn(); now = 3_600_001; return result(id); },
    log: (step, fields) => {
      if (step === "lane.idle_summary" && fields?.partial !== true) {
        samples++; throw new Error("idle-window sink refused");
      }
    },
  }), { laneCount: 2, max: 2, pollIntervalMs: 10 }).then((summary) => ({ summary }), (error: unknown) => ({ error }));
  assert.equal(samples, 1, "positive control: the post-settlement window actually emitted");
  assert.ok("summary" in outcome, "idle reporting cannot discard completed sibling accounting");
  assert.equal(outcome.summary.stopReason, "error");
  assert.match(outcome.summary.stopDetail ?? "", /dispatch.sample_idle_lane: idle-window sink refused/);
  assert.deepEqual(outcome.summary.merged, ["A", "B"]);
  assert.equal(outcome.summary.costUsd, 1);
});

test("summary sink refusal is explicit error assurance, not a delivered success receipt", async (t) => {
  const summary = await runDaemon(planFixture(t), depsFixture(t, {
    log: (step) => { if (step === "daemon.summary") throw new Error("summary not delivered"); },
  }), { laneCount: 2, max: 2, pollIntervalMs: 10 });
  assert.equal(summary.costUsd, 1);
  assert.deepEqual(summary.merged, ["A", "B"]);
  assertReportingFault(summary, "daemon.summary", "summary not delivered");
});

for (const hostile of ["message-getter", "proxy-descriptor"] as const) {
  test(`reporting fault detail does not execute arbitrary thrown-object properties (${hostile})`, async (t) => {
    let getterCalls = 0;
    const reason = hostile === "message-getter"
      ? Object.defineProperty({}, "message", { get() { getterCalls++; throw new Error("hostile getter"); } })
      : new Proxy({}, { getOwnPropertyDescriptor() { throw new Error("descriptor refused"); } });
    const closed = await runDaemon(planFixture(t), depsFixture(t, {
      log: (step) => { if (step === "daemon.summary") throw reason; },
    }), { laneCount: 2, max: 2, pollIntervalMs: 10 }).then((summary) => ({ summary }), () => ({ rejected: true }));
    assert.equal(getterCalls, 0);
    assert.ok("summary" in closed, "reporting failure must be returned safely rather than thrown into the test reporter");
    assertReportingFault(closed.summary, "daemon.summary", hostile === "message-getter" ? "[non-string reporting failure]" : "[uninspectable reporting failure]");
  });
}

test("post-settlement semantic callback failure still propagates after owned services and clock close", { timeout: 3_000 }, async (t) => {
  const original = new Error("semantic escalation failed"), calls: string[] = [];
  let serviceStops = 0, clockWaits = 0, completed = false;
  const work = runDaemon(planFixture(t, true), depsFixture(t, {
    runOne: async (id) => { calls.push(id); return result(id, id === "A" ? "blocked" : "merged"); },
    escalateBlock: async () => { throw original; },
    gardens: [() => ({ stop: () => { serviceStops++; } })],
    sleepUntilSweepWake: async () => { clockWaits++; if (completed) return new Promise<undefined>(() => {}); await yieldTurn(); return undefined; },
  }), { laneCount: 2, max: 2, pollIntervalMs: 10 });
  const error = await work.then(() => undefined, (reason: unknown) => reason); completed = true;
  assert.equal(error, original, "do not convert real semantic exceptions into successful dispositions");
  assert.deepEqual(calls, ["A", "B"]);
  assert.equal(serviceStops, 1);
  assert.ok(clockWaits > 0);
  const stoppedAt = clockWaits;
  for (let turn = 0; turn < 3; turn++) await yieldTurn();
  assert.equal(clockWaits, stoppedAt);
});

test("owned cleanup attempts every garden and preserves even falsy stop failures", async (t) => {
  const stops: number[] = [];
  const error = await runDaemon(planFixture(t), depsFixture(t, {
    gardens: [
      () => ({ stop: () => { stops.push(1); throw 0; } }),
      () => ({ stop: () => { stops.push(2); throw null; } }),
      () => ({ stop: () => { stops.push(3); } }),
    ],
  }), { laneCount: 2, max: 2, pollIntervalMs: 10 }).then(() => undefined, (reason: unknown) => reason);
  assert.deepEqual(stops, [1, 2, 3], "a first cleanup failure cannot prevent later owned cleanup");
  assert.ok(error instanceof AggregateError);
  assert.equal(error.message, "owned daemon cleanup failed");
  const gardens = error.errors[0];
  assert.ok(gardens instanceof AggregateError);
  assert.deepEqual(gardens.errors, [0, null], "presence, not truthiness, owns cleanup failure");
});

test("post-settlement semantic failure keeps original priority when cleanup also fails", async (t) => {
  const original = new Error("original semantic callback"), secondary = new Error("garden stop failed");
  const stops: number[] = [];
  const error = await runDaemon(planFixture(t, true), depsFixture(t, {
    runOne: async (id) => result(id, id === "A" ? "blocked" : "merged"),
    escalateBlock: async () => { throw original; },
    gardens: [
      () => ({ stop: () => { stops.push(1); throw secondary; } }),
      () => ({ stop: () => { stops.push(2); } }),
    ],
  }), { laneCount: 2, max: 2, pollIntervalMs: 10 }).then(() => undefined, (reason: unknown) => reason);
  assert.deepEqual(stops, [1, 2]);
  assert.ok(error instanceof AggregateError);
  assert.equal(error.message, "post-settlement reconciliation and cleanup failed");
  assert.equal(error.errors[0], original, "secondary cleanup failure must not replace the original semantic exception");
  const cleanup = error.errors[1];
  assert.ok(cleanup instanceof AggregateError);
  assert.equal(cleanup.errors[0].errors[0], secondary);
});

test("post-settlement lifetime-pressure reporting refusal preserves all actual work accounting", async (t) => {
  const calls: string[] = [], observations: string[][] = [];
  const closed = await runDaemon(planFixture(t), depsFixture(t, {
    isLifetimeCapExceeded: (id) => id === "A",
    runOne: async (id) => { calls.push(id); return result(id); },
    onLifetimePressure: async (tasks) => {
      assert.deepEqual(calls, ["A", "B"], "the lifetime observer runs after actual dispatch settlement");
      observations.push(tasks.map((task) => task.id)); throw new Error("observer refused");
    },
    log: (step) => { if (step === "dispatch.lifetime_pressure.failed") throw new Error("lifetime sink refused"); },
  }), { laneCount: 2, max: 2, pollIntervalMs: 10 }).then((summary) => ({ summary }), () => ({ rejected: true }));
  assert.ok("summary" in closed, "a lifetime failure reporter must not interrupt settled accounting");
  assert.deepEqual(observations, [["A"]]);
  assert.deepEqual(closed.summary.merged, ["A", "B"]);
  assert.equal(closed.summary.costUsd, 1);
  assertReportingFault(closed.summary, "dispatch.lifetime_pressure.failed", "lifetime sink refused");
});

test("hard operator STOP keeps clean-stop authority despite a refused summary sink", async (t) => {
  let stops = 0;
  const closed = await runDaemon(planFixture(t), depsFixture(t, {
    checkStop: () => "operator hard STOP",
    runOne: async () => assert.fail("STOP must not admit new work"),
    gardens: [() => ({ stop: () => { stops++; } })],
    log: (step) => { if (step === "daemon.summary") throw new Error("STOP receipt refused"); },
  }), { laneCount: 2, max: 2, pollIntervalMs: 10 }).then((summary) => ({ summary }), () => ({ rejected: true }));
  assert.ok("summary" in closed, "return STOP authority and explicit failed reporting, not a sink exception");
  assert.equal(closed.summary.stopReason, "stopped", "reporting failure must not invite a KeepAlive relaunch after hard STOP");
  assert.deepEqual(closed.summary.attempted, []);
  assert.equal(closed.summary.costUsd, 0);
  assert.equal(stops, 1);
  assert.deepEqual(closed.summary.reportingFaults, [{ phase: "report.daemon.summary", detail: "STOP receipt refused" }]);
  assert.match(closed.summary.stopDetail ?? "", /operator hard STOP/);
});

test("a rejected real pause-clock wait still attempts every owned service cleanup", { timeout: 3_000 }, async (t) => {
  const clockEntered = deferred<void>(), clockWait = deferred<undefined>(), pausedTick = deferred<undefined>();
  const original = new Error("pause clock wait failed");
  let stop = false, serviceStops = 0;
  const outcome = runDaemon(planFixture(t), depsFixture(t, {
    checkPause: () => "fixture pause", checkStop: () => stop ? "operator STOP" : undefined,
    runOne: async () => { assert.fail("no worker may start during the fixture pause"); },
    sleepUntilSweepWake: (ms) => {
      if (ms === 1_000) { clockEntered.resolve(); return clockWait.promise; }
      assert.equal(ms, 2_000); return pausedTick.promise;
    },
    gardens: [() => ({ stop: () => { serviceStops++; } }), () => ({ stop: () => { serviceStops++; } })],
  }), { pollIntervalMs: 2_000 }).then((summary) => ({ summary }), (error: unknown) => ({ error }));
  t.after(async () => { stop = true; pausedTick.resolve(undefined); clockWait.resolve(undefined); await outcome; });
  await clockEntered.promise;
  stop = true; pausedTick.resolve(undefined);
  // The next real tick enters summary/stop(), attaching its await before the wait rejects.
  await yieldTurn(); clockWait.reject(original);
  const closed = await outcome;
  assert.ok("error" in closed && closed.error instanceof AggregateError);
  assert.deepEqual(closed.error.errors, [original], "retain the clock failure rather than successful closure");
  assert.equal(serviceStops, 2, "one failing clock cannot skip either owned garden");
});

test("invalid merge-credit evidence reporting refusal preserves pending credit and sibling accounting", async (t) => {
  const summary = await runDaemon(planFixture(t), depsFixture(t, {
    readLedgerLines: () => ["{invalid-json"],
    runOne: async (id) => result(id, id === "A" ? "task_already_merged" : "merged"),
    log: (step) => { if (step === "daemon.merge_credit_evidence_invalid") throw new Error("invalid evidence reporter refused"); },
  }), { laneCount: 2, max: 2, pollIntervalMs: 10 });
  assert.deepEqual(summary.attempted, ["A", "B"]);
  assert.deepEqual(summary.merged, ["B"], "malformed evidence must never mint A's merged credit");
  assert.equal(summary.costUsd, 1, "retain actual completed sibling costs without duplication");
  assertReportingFault(summary, "daemon.merge_credit_evidence_invalid", "invalid evidence reporter refused");
});
