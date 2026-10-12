import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate as yieldTurn } from "node:timers/promises";
import { runDrain, type DrainDeps } from "../src/lib/drain.js";
import { TaskAdmissionError, type Plan, type Task } from "../src/lib/plan.js";
import type { HeavyBuildHold } from "../src/lib/heavy-build-reservation.js";
import type { RunResult } from "../src/lib/run-result.js";

const HOLD: HeavyBuildHold = {
  deferred: true, requestId: "a".repeat(64), readyAtMs: 1, expiresAtMs: 3_600_001,
  detail: "test READY hold",
};
const ok = (id: string): RunResult => ({
  taskId: id, runId: `${id}-test`, merged: true, verdict: "merged", costUsd: 0.5,
});
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function fixturePlan(ids = ["A", "B", "C"]): Plan {
  const tasks: Task[] = ids.map((id) => ({
    id, title: `task ${id}`, repo: "remudero", type: "implement", verify: "auto",
    risk: "medium", status: "queued", depends_on: [], attempts: 0, files: [`src/${id.toLowerCase()}.ts`],
  }));
  return { tasks, byId: new Map(tasks.map((task) => [task.id, task])) };
}
function drainDeps(overrides: Partial<DrainDeps> = {}): DrainDeps {
  return {
    refreshMerged: () => () => false, runOne: async (id) => ok(id), readLedgerLines: () => [],
    checkCostGovernor: () => undefined, checkQueueGovernor: () => undefined,
    checkMemoryGovernor: () => undefined, checkQuietHours: () => undefined,
    checkHeavyNewBuild: () => undefined, ...overrides,
  };
}
function observe<T>(work: Promise<T>) {
  let ended = false;
  const outcome = work.then(
    (value) => { ended = true; return { status: "fulfilled" as const, value }; },
    (reason: unknown) => { ended = true; return { status: "rejected" as const, reason }; },
  );
  return { outcome, ended: () => ended };
}
type Row = { step: string; fields: Record<string, unknown> };

// The promises stay genuinely in flight across a full turn after the real logger throws. No
// mocked settlement or sleep bound stands in for ownership, and a rejected sibling is not credit.
for (const failingStep of ["dispatch.new_build_held", "drain.iteration", "dispatch.concurrent_set"] as const) {
  for (const siblingOutcome of ["credit", "reject"] as const) {
    test(`parallel drain ${failingStep} fault owns and settles its ${siblingOutcome} sibling before fatal`, { timeout: 2_000 }, async (t) => {
      const a = deferred<RunResult>(), b = deferred<RunResult>(), faultSeen = deferred<void>();
      const sentinel = new TaskAdmissionError("boundary sentinel"), workerReason = new TypeError("A worker sentinel");
      const calls: string[] = [], rows: Row[] = [], credited = new Set<string>();
      let held = false, thrown = false;
      const work = observe(runDrain(fixturePlan(), drainDeps({
        refreshMerged: () => (id) => credited.has(id),
        checkHeavyNewBuild: () => held ? HOLD : undefined,
        runOne: (id) => {
          calls.push(id);
          if (failingStep === "dispatch.new_build_held") held = true;
          return (id === "A" ? a.promise : b.promise).then((result) => {
            if (result.merged) credited.add(id);
            return result;
          });
        },
        log: (step, fields = {}) => {
          rows.push({ step, fields });
          if (step === failingStep && (step === "dispatch.concurrent_set" || fields.task === "B") && !thrown) {
            thrown = true; faultSeen.resolve(undefined); throw sentinel;
          }
        },
      }), { laneCount: failingStep === "dispatch.concurrent_set" ? 2 : 3, max: 3 }));
      t.after(async () => { a.resolve(ok("A")); b.resolve(ok("B")); await work.outcome; });
      await faultSeen.promise;
      await yieldTurn();
      const expectedCalls = failingStep === "dispatch.new_build_held" ? ["A"] : ["A", "B"];
      assert.deepEqual(calls, expectedCalls, "iteration logging follows real ownership; the fault closes later starts");
      assert.equal(work.ended(), false, "fatal cannot orphan A while it is actually running");
      if (expectedCalls.includes("B")) {
        b.resolve(ok("B"));
        await yieldTurn();
        assert.equal(work.ended(), false, "B's credit cannot let the fault abandon A");
      }
      if (siblingOutcome === "reject") a.reject(workerReason);
      else a.resolve(ok("A"));
      const outcome = await work.outcome;
      assert.ok(outcome.status === "fulfilled", "the owned boundary fault is a fatal drain summary, not an escaped rejection");
      const summary = outcome.value;
      const expectedMerged = expectedCalls.filter((id) => id !== "A" || siblingOutcome === "credit");
      assert.equal(summary.stopReason, "error", "neither hold nor remaining budget can hide the logger fault");
      assert.equal(summary.error, sentinel, "preserve the original admission-error instance for caller classification");
      assert.ok(summary.error instanceof TaskAdmissionError);
      assert.equal(Object.hasOwn(rows.find((row) => row.step === "drain.summary")!.fields, "error"), false,
        "original exception identity is caller-only, not serialized into the ledger");
      assert.equal(Object.hasOwn(JSON.parse(JSON.stringify(summary)), "error"), false,
        "CLI JSON must not serialize arbitrary properties from the original exception either");
      assert.deepEqual(summary.attempted, expectedCalls);
      assert.deepEqual(summary.merged, expectedMerged);
      assert.deepEqual(summary.continued, []);
      assert.equal(summary.costUsd, expectedMerged.length * 0.5);
      assert.deepEqual(calls, expectedCalls, "no second pass starts C after a concurrent-set fault");
      assert.match(summary.stopDetail ?? "", failingStep === "dispatch.new_build_held"
        ? /B: admit: boundary sentinel/
        : failingStep === "drain.iteration" ? /B: onStarted: boundary sentinel/ : /dispatch: dispatch.concurrent_set: boundary sentinel/);
      const settled = rows.find((row) => row.step === "dispatch.settled_set")!.fields;
      assert.equal(settled.dispatched, expectedCalls.length, "no refused task gets a settlement slot");
      assert.deepEqual((settled.tasks as Array<{ id: string }>).map((task) => task.id), expectedCalls);
      assert.equal(rows.some((row) => row.step === "drain.lane_error" && row.fields.task === "A"), siblingOutcome === "reject");
    });
  }
}

for (const phase of ["admit", "start", "held-log"] as const) {
  test(`parallel drain standalone ${phase} fault has no phantom attempt, credit, settlement or cost`, { timeout: 2_000 }, async () => {
    const sentinel = new TaskAdmissionError(`${phase} sentinel`), calls: string[] = [], rows: Row[] = [];
    const hold: HeavyBuildHold = { ...HOLD, get requestId(): string { throw sentinel; } };
    const deps = drainDeps({
      checkHeavyNewBuild: () => phase === "start" ? undefined : phase === "admit" ? hold : HOLD,
      runOne: async (id) => { calls.push(id); return ok(id); },
      log: (step, fields = {}) => {
        rows.push({ step, fields });
        if (phase === "held-log" && step === "dispatch.new_build_held") throw sentinel;
      },
    });
    if (phase === "start") Object.defineProperty(deps, "runOne", { get() { throw sentinel; } });
    const summary = await runDrain(fixturePlan(), deps, { laneCount: 3, max: 3 });
    assert.equal(summary.stopReason, "error");
    assert.equal(summary.error, sentinel);
    assert.match(summary.stopDetail ?? "", phase === "start" ? /A: start: start sentinel/ : /A: admit:/);
    assert.deepEqual(calls, []);
    assert.deepEqual(summary.attempted, []);
    assert.deepEqual(summary.merged, []);
    assert.deepEqual(summary.continued, []);
    assert.equal(summary.costUsd, 0);
    const settled = rows.find((row) => row.step === "dispatch.settled_set")!.fields;
    assert.equal(settled.dispatched, 0);
    assert.deepEqual(settled.tasks, []);
    assert.ok(!rows.some((row) => row.step === "drain.iteration"));
    assert.ok(!rows.some((row) => row.step === "drain.continued" || row.step === "drain.lane_error"));
  });
}

for (const reason of [undefined, null, false, 0, ""] as const) {
  test(`parallel drain preserves a falsy logger reason (${String(reason)}) as a fatal, unstarted fault`, async () => {
    const summary = await runDrain(fixturePlan(), drainDeps({
      checkHeavyNewBuild: () => HOLD,
      runOne: async () => assert.fail("fault cannot start work"),
      log: (step) => { if (step === "dispatch.new_build_held") throw reason; },
    }), { laneCount: 3, max: 3 });
    assert.equal(summary.stopReason, "error");
    assert.equal(Object.hasOwn(summary, "error"), true, "undefined is still an observed failure, not an absent fault");
    assert.equal(summary.error, reason);
    assert.equal(summary.stopDetail, `A: admit: ${String(reason)}`);
    assert.deepEqual(summary.attempted, []);
    assert.equal(summary.costUsd, 0);
  });
}

for (const failureClass of ["fatal", "delivery", "toolchain"] as const) {
  test(`parallel drain synchronous runOne ${failureClass} throw is an actual attempt and keeps legacy classification`, { timeout: 2_000 }, async (t) => {
    const b = deferred<RunResult>(), bothInvoked = deferred<void>(), calls: string[] = [], rows: Row[] = [];
    const reason = failureClass === "fatal" ? new TypeError("run sentinel")
      : failureClass === "delivery" ? new Error("Command failed: bounded test worker")
      : Object.assign(new Error("toolchain sentinel"), { name: "WorktreeNodeModulesRefusedError", reasonClass: "blocked_toolchain" });
    const work = observe(runDrain(fixturePlan(["A", "B"]), drainDeps({
      runOne: (id) => {
        calls.push(id);
        if (id === "A") throw reason;
        bothInvoked.resolve(undefined); return b.promise;
      },
      log: (step, fields = {}) => { rows.push({ step, fields }); },
    }), { laneCount: 2, max: 2 }));
    t.after(async () => { b.resolve(ok("B")); await work.outcome; });
    await bothInvoked.promise;
    await yieldTurn();
    assert.deepEqual(calls, ["A", "B"], "a real run rejection does not close its admitted sibling");
    assert.equal(work.ended(), false);
    b.resolve(ok("B"));
    const outcome = await work.outcome;
    assert.ok(outcome.status === "fulfilled");
    assert.deepEqual(outcome.value.attempted, ["A", "B"]);
    assert.deepEqual(outcome.value.merged, ["B"]);
    assert.equal(outcome.value.costUsd, 0.5);
    if (failureClass === "fatal") {
      assert.equal(outcome.value.stopReason, "error");
      assert.equal(outcome.value.error, reason);
      assert.equal(outcome.value.stopDetail, "A: run sentinel");
      assert.deepEqual(outcome.value.continued, []);
    } else {
      assert.equal(outcome.value.stopReason, "max_reached");
      assert.equal(Object.hasOwn(outcome.value, "error"), false);
      assert.deepEqual(outcome.value.continued, [{ taskId: "A", verdict: failureClass === "delivery" ? "lane_failed" : "blocked_toolchain" }]);
    }
    assert.equal(rows.find((row) => row.step === "dispatch.settled_set")!.fields.dispatched, 2);
  });
}

test("parallel drain repeated reporter faults retain the first logger reason and credit all real siblings", { timeout: 2_000 }, async (t) => {
  const a = deferred<RunResult>(), b = deferred<RunResult>(), faultSeen = deferred<void>(), calls: string[] = [];
  const first = new TaskAdmissionError("first logger sentinel"), later = new Error("later reporter sentinel");
  let faulted = false;
  const work = observe(runDrain(fixturePlan(), drainDeps({
    runOne: (id) => { calls.push(id); return id === "A" ? a.promise : b.promise; },
    log: (step, fields) => {
      if (faulted) throw later;
      if (step === "drain.iteration" && fields?.task === "B") {
        faulted = true; faultSeen.resolve(undefined); throw first;
      }
    },
  }), { laneCount: 3, max: 3 }));
  t.after(async () => { a.resolve(ok("A")); b.resolve(ok("B")); await work.outcome; });
  await faultSeen.promise;
  await yieldTurn();
  assert.equal(work.ended(), false);
  b.resolve(ok("B")); a.resolve(ok("A"));
  const outcome = await work.outcome;
  assert.ok(outcome.status === "fulfilled");
  assert.equal(outcome.value.stopReason, "error");
  assert.equal(outcome.value.error, first, "even fatal-summary logging cannot replace the original classification");
  assert.deepEqual(calls, ["A", "B"]);
  assert.deepEqual(outcome.value.attempted, calls);
  assert.deepEqual(outcome.value.merged, calls);
  assert.equal(outcome.value.costUsd, 1);
});

test("parallel drain post-settle pressure reporter fault cannot skip actual sibling accounting", { timeout: 2_000 }, async (t) => {
  const a = deferred<RunResult>(), b = deferred<RunResult>(), batchSeen = deferred<void>(), routed: string[][] = [];
  const hookReason = new Error("pressure hook sentinel"), reporterReason = new Error("pressure reporter sentinel");
  const work = observe(runDrain(fixturePlan(["A", "B"]), drainDeps({
    isLifetimeCapExceeded: (id) => id === "A",
    onLifetimePressure: async (tasks) => { routed.push(tasks.map((task) => task.id)); throw hookReason; },
    runOne: (id) => id === "A" ? a.promise : b.promise,
    log: (step) => {
      if (step === "dispatch.concurrent_set") batchSeen.resolve(undefined);
      if (step === "dispatch.lifetime_pressure.failed") throw reporterReason;
    },
  }), { laneCount: 2, max: 2 }));
  t.after(async () => { a.resolve(ok("A")); b.resolve(ok("B")); await work.outcome; });
  await batchSeen.promise;
  b.resolve(ok("B"));
  await yieldTurn();
  assert.deepEqual(routed, [], "pressure routing still waits for every real worker");
  assert.equal(work.ended(), false);
  a.resolve(ok("A"));
  const outcome = await work.outcome;
  assert.ok(outcome.status === "fulfilled");
  assert.deepEqual(routed, [["A"]]);
  assert.equal(outcome.value.stopReason, "error");
  assert.equal(outcome.value.error, reporterReason);
  assert.equal(outcome.value.stopDetail, "dispatch: lifetime_pressure: pressure reporter sentinel");
  assert.deepEqual(outcome.value.attempted, ["A", "B"]);
  assert.deepEqual(outcome.value.merged, ["A", "B"]);
  assert.equal(outcome.value.costUsd, 1);
});

for (const legacyStop of ["blocked", "stopped", "new_build_deferred"] as const) {
  test(`parallel drain keeps legacy ${legacyStop} after actual siblings settle`, { timeout: 2_000 }, async (t) => {
    const a = deferred<RunResult>(), b = deferred<RunResult>(), batchSeen = deferred<void>(), calls: string[] = [];
    let held = false, stopped = false;
    const work = observe(runDrain(fixturePlan(), drainDeps({
      checkStop: () => stopped ? "operator stop" : undefined,
      checkHeavyNewBuild: () => held ? HOLD : undefined,
      runOne: (id) => {
        calls.push(id);
        if (legacyStop === "new_build_deferred") held = true;
        return id === "A" ? a.promise : b.promise;
      },
      log: (step) => { if (step === "dispatch.concurrent_set") batchSeen.resolve(undefined); },
    }), { laneCount: 2, max: 3 }));
    t.after(async () => { stopped = true; a.resolve(ok("A")); b.resolve(ok("B")); await work.outcome; });
    await batchSeen.promise;
    if (legacyStop === "stopped") stopped = true;
    await yieldTurn();
    assert.equal(work.ended(), false);
    const expectedCalls = legacyStop === "new_build_deferred" ? ["A"] : ["A", "B"];
    assert.deepEqual(calls, expectedCalls);
    a.resolve(legacyStop === "blocked" ? { ...ok("A"), merged: false, verdict: "blocked_review", costUsd: 0.3 } : ok("A"));
    await yieldTurn();
    if (expectedCalls.includes("B")) {
      assert.equal(work.ended(), false, "a blocker or stop must still wait for B");
      b.resolve(ok("B"));
    }
    const outcome = await work.outcome;
    assert.ok(outcome.status === "fulfilled");
    assert.equal(outcome.value.stopReason, legacyStop);
    assert.equal(Object.hasOwn(outcome.value, "error"), false);
    assert.deepEqual(outcome.value.attempted, expectedCalls);
    assert.deepEqual(outcome.value.merged, legacyStop === "blocked" ? ["B"] : expectedCalls);
    assert.equal(outcome.value.costUsd, legacyStop === "blocked" ? 0.8 : expectedCalls.length * 0.5);
    assert.deepEqual(calls, expectedCalls);
  });
}

test("parallel drain max counts actual invocations only and a normal summary logger still throws", async () => {
  const calls: string[] = [], sentinel = new Error("normal summary logger sentinel");
  const summary = await runDrain(fixturePlan(), drainDeps({
    runOne: async (id) => { calls.push(id); return ok(id); },
  }), { laneCount: 3, max: 1 });
  assert.equal(summary.stopReason, "max_reached");
  assert.equal(summary.stopDetail, "1 task(s)");
  assert.deepEqual(summary.attempted, ["A"]);
  assert.deepEqual(summary.merged, ["A"]);
  assert.equal(summary.costUsd, 0.5);
  assert.deepEqual(calls, ["A"]);
  calls.length = 0;
  await assert.rejects(runDrain(fixturePlan(), drainDeps({
    runOne: async (id) => { calls.push(id); return ok(id); },
    log: (step) => { if (step === "drain.summary") throw sentinel; },
  }), { laneCount: 3, max: 1 }), (reason: unknown) => reason === sentinel);
  assert.deepEqual(calls, ["A"], "no change to the max ceiling or normal logger exception semantics");
});
