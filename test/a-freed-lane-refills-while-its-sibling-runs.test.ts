// W1-T4416 — ONE SLOW WORKER IDLED EVERY OTHER LANE. The daemon awaited `Promise.allSettled` over
// its whole dispatch batch, so a lane that finished sat empty until the slowest sibling ended
// (measured 2026-09-24: one batch admitted at 23:55Z, nothing else started until 01:31Z, with
// eight worker slots and zero active). These drive the REAL runDaemon at laneCount 2; only the
// worker spawn (`runOne`) is faked, as deferred promises the test settles by hand.

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as drainMicrotasks } from "node:timers/promises";
import { test } from "node:test";
import { loadPlan } from "../src/lib/plan.js";
import { runDaemon, runLanePool, type DaemonDeps } from "../src/lib/daemon.js";
import type { RunResult } from "../src/run-task.js";

/** A slow, B fast, C the next runnable task — all `files:`-disjoint so every one may share a pass. */
function threeDisjointPlan() {
  const dir = mkdtempSync(join(tmpdir(), "rmd-lane-refill-"));
  const f = join(dir, "tasks.yaml");
  const task = (id: string) =>
    `- id: ${id}\n  title: ${id}\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n  files: [src/${id}.ts]\n`;
  writeFileSync(f, task("A") + task("B") + task("C"));
  return loadPlan(f);
}

function okResult(id: string): RunResult {
  return { taskId: id, merged: true, verdict: "merged", costUsd: 0, prUrl: `https://x/${id}` } as unknown as RunResult;
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

type Line = { step: string; extra?: Record<string, unknown> };

/** A and B are held open until the test releases them; any later task completes at once. */
function harness(extra: Partial<DaemonDeps> = {}) {
  const steps: Line[] = [];
  const started: string[] = [];
  const release = { A: deferred<RunResult>(), B: deferred<RunResult>() };
  const bothStarted = deferred<void>();
  let aSettled = false;
  const startedWhileARan: string[] = [];
  const runOne = (id: string): Promise<RunResult> => {
    started.push(id);
    if (!aSettled && id !== "A") startedWhileARan.push(id);
    if (started.includes("A") && started.includes("B")) bothStarted.resolve();
    if (id === "A" || id === "B") return release[id].promise;
    return Promise.resolve(okResult(id));
  };
  const settleA = () => {
    aSettled = true;
    release.A.resolve(okResult("A"));
  };
  const run = runDaemon(
    threeDisjointPlan(),
    {
      refreshMerged: () => () => false,
      log: (step: string, extra?: Record<string, unknown>) => steps.push({ step, extra }),
      runOne,
      sleep: async () => {},
      ...extra,
    } as unknown as DaemonDeps,
    { max: 3, laneCount: 2 },
  );
  return { steps, started, release, bothStarted, settleA, startedWhileARan, run };
}

test("a lane that finishes first admits the next task while its sibling is still running", async () => {
  const h = harness();
  await h.bothStarted.promise;
  h.release.B.resolve(okResult("B"));
  await drainMicrotasks();
  // Observed BEFORE A is released: the refill must not wait on the slowest sibling.
  assert.deepEqual(h.startedWhileARan, ["B", "C"], "C started on B's freed lane while A still ran");
  h.settleA();
  const summary = await h.run;
  assert.equal(summary.stopReason, "max_reached");

  const refilled = h.steps.filter((l) => l.step === "dispatch.lane_refilled");
  assert.deepEqual(
    refilled.map((l) => l.extra),
    [{ lane: 1, finished_task: "B", next_task: "C" }],
    "one refill row naming the lane, what finished and what it admitted",
  );
  const settled = h.steps.filter((l) => l.step === "dispatch.settled_set");
  assert.equal(settled.length, 1, "still one settled row per pass");
  const x = settled[0]!.extra as { tasks: Array<{ id: string }>; dispatched: number };
  assert.equal(x.dispatched, 3, "the settled row covers the refilled lane too");
  assert.deepEqual(x.tasks.map((t) => t.id), ["A", "B", "C"]);
  const held = h.steps.filter((l) => l.step === "dispatch.lane_refill_held").map((l) => l.extra?.reason);
  assert.deepEqual(held, ["max reached"], "C's own lane is refused at max, and A settles last with nothing to refill");
});

test("a refilled lane re-checks the pause and the stop signal before admitting", async () => {
  for (const hold of ["pause", "stop"] as const) {
    let raised = false;
    let stopAtTop = false;
    const h = harness({
      checkPause: () => (hold === "pause" && raised ? "operator pause" : undefined),
      checkStop: () => (stopAtTop || (hold === "stop" && raised) ? "operator stop" : undefined),
      // A pause at the top of the next tick sleeps; end the run there.
      sleep: async () => {
        stopAtTop = true;
      },
    });
    await h.bothStarted.promise;
    raised = true; // raised AFTER admission, so only the refill can observe it
    h.release.B.resolve(okResult("B"));
    await drainMicrotasks();
    assert.deepEqual(h.startedWhileARan, ["B"], `${hold}: nothing admitted onto B's freed lane`);
    h.settleA();
    const summary = await h.run;
    assert.equal(summary.stopReason, "stopped");
    assert.deepEqual(h.started, ["A", "B"], `${hold}: C was never dispatched`);
    const held = h.steps.find((l) => l.step === "dispatch.lane_refill_held");
    assert.equal(held?.extra?.reason, `${hold}: operator ${hold}`);
    assert.equal(held?.extra?.finished_task, "B");
    assert.equal(h.steps.filter((l) => l.step === "dispatch.lane_refilled").length, 0);
  }
});

test("a rejected lane closes refill for the pass and the fatal path still reports it", async () => {
  const h = harness();
  await h.bothStarted.promise;
  h.release.B.promise.catch(() => {});
  (h.release.B as { resolve: (v: RunResult) => void }).resolve(Promise.reject(new Error("lane B died")) as never);
  await drainMicrotasks();
  assert.deepEqual(h.startedWhileARan, ["B"], "a rejection never refills");
  h.settleA();
  const summary = await h.run;
  assert.equal(summary.stopReason, "error");
  assert.match(summary.stopDetail ?? "", /B: lane B died/);
  const held = h.steps.find((l) => l.step === "dispatch.lane_refill_held");
  assert.equal(held?.extra?.reason, "a lane rejected");
});

test("a failed fresh read on refill is ledgered and admits nothing", async () => {
  let reads = 0;
  const h = harness({
    refreshMerged: () => {
      reads++;
      if (reads > 1) throw new Error("projection unreadable");
      return () => false;
    },
  });
  await h.bothStarted.promise;
  h.release.B.resolve(okResult("B"));
  await drainMicrotasks();
  assert.deepEqual(h.startedWhileARan, ["B"]);
  h.settleA();
  await h.run.catch(() => undefined); // the next tick's own read throws too; only the refill row matters
  const held = h.steps.find((l) => l.step === "dispatch.lane_refill_held");
  assert.equal(held?.extra?.reason, "refill read failed: projection unreadable");
});

test("a governed refill names the governor and admits nothing", async () => {
  let governed = false;
  const h = harness({
    checkQueueGovernor: () => (governed ? { deferred: true, observedOpenCount: 9, wipLimit: 9 } : undefined),
  } as unknown as Partial<DaemonDeps>);
  await h.bothStarted.promise;
  governed = true;
  h.release.B.resolve(okResult("B"));
  await drainMicrotasks();
  assert.deepEqual(h.startedWhileARan, ["B"]);
  const held = h.steps.find((l) => l.step === "dispatch.lane_refill_held");
  assert.equal(held?.extra?.reason, "governor: queue");
  governed = false;
  h.settleA();
  await h.run;
});

test("the lane pool resolves at once over an empty batch", async () => {
  const settled = await runLanePool([], async () => 1, () => undefined);
  assert.deepEqual(settled, []);
});
