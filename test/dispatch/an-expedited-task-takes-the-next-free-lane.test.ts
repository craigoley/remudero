/**
 * W1-T14654: an expedited task takes the next free lane (operator ruling 2026-11-24, "Expedite lane").
 *
 * compareDispatch orders by stride pass first and priority only as a tiebreak, so on 2026-11-24 dispatch claimed
 * tasks at priority 1 to 2.09 from 07:00Z to 13:20Z while a 0.2 task and four 0.1 operator asks waited. A task that
 * declares a non-blank `expedite`, or whose origin is an operator ruling, now goes ahead of the stride order, and
 * at most max(1, lanes - 1) expedited tasks are in flight, so the ordinary queue always keeps a lane.
 * These drive runnableCandidates over hand-built plans, and runDaemon with only the worker spawn faked.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate as drainMicrotasks } from "node:timers/promises";

import { runDaemon, type DaemonDeps } from "#src/lib/daemon.js";
import { partitionByFileOverlap } from "#src/lib/dispatch-overlap.js";
import * as drain from "#src/lib/drain.js";
import { dispatchOrder, runnableCandidates, type NextRunnableOpts } from "#src/lib/drain.js";
import { meaningOfStep } from "#src/lib/ledger-steps.js";
import type { Plan, Task } from "#src/lib/plan.js";
import { hostIndependentDaemonDeps } from "#test/helpers/daemon-host-pins.js";

type Over = Partial<Task> & { files?: string[] };

function task(id: string, over: Over = {}): Task {
  return {
    id, title: id, repo: "remudero", type: "implement", verify: "auto", risk: "low", status: "queued",
    attempts: 0, depends_on: [], priority: 1, files: [`src/${id}.ts`], ...over,
  };
}

function plan(tasks: Task[]): Plan {
  return { tasks, byId: new Map(tasks.map((t) => [t.id, t])) };
}

/** A ready cost-of-delay order: stride pass first, priority only as a tiebreak. */
function strideContext(passes: Record<string, number>): NonNullable<NextRunnableOpts["dispatchValueContext"]> {
  return {
    scoreByClass: new Map<string, number>(), openDependentFanoutByTaskId: new Map<string, number>(),
    stridePassByTaskId: new Map(Object.entries(passes)),
  };
}

const notMerged = () => false;
const ids = (tasks: readonly Task[]) => tasks.map((t) => t.id);
const LEAK = "fix for a live cost leak";
const RULING = "operator-ruling#expedite-lane-2026-11-24";
const isExpedited = (t: Task) => drain.expediteReason(t) !== undefined;

test("W1-T14654 criterion 1: an expedited task with a worse stride pass is returned first", () => {
  const tasks = [task("ORD1"), task("ORD2"), task("EXP", { priority: 0.1, expedite: LEAK })];
  const dispatchValueContext = strideContext({ ORD1: 0.2, ORD2: 0.5, EXP: 2 });
  assert.deepEqual(ids(dispatchOrder(tasks, dispatchValueContext)), ["ORD1", "ORD2", "EXP"],
    "control: the stride order alone puts the expedited task last, as origin/main dispatches it");
  assert.deepEqual(ids(runnableCandidates(plan(tasks), notMerged, 1, { dispatchValueContext })), ["EXP"]);
  assert.deepEqual(ids(runnableCandidates(plan(tasks), notMerged, 3, { dispatchValueContext })), ["EXP", "ORD1", "ORD2"],
    "the rest keep their stride order behind it");

  // Two expedited tasks keep their own stride order between them.
  const two = [...tasks, task("EXP2", { expedite: "storm", priority: 2 })];
  const context = strideContext({ ORD1: 0.2, ORD2: 0.5, EXP: 2, EXP2: 1.5 });
  assert.deepEqual(ids(runnableCandidates(plan(two), notMerged, 4, { dispatchValueContext: context })), ["EXP2", "EXP", "ORD1", "ORD2"],
    "four lanes give the expedited share 3, and the two fill it in their own order: EXP2 then EXP");
  assert.deepEqual(ids(runnableCandidates(plan(two), notMerged, 2, { dispatchValueContext: context })), ["EXP2", "ORD1"],
    "two lanes give the share 1: EXP2 leads and the ordinary queue keeps the other lane");
});

test("W1-T14654 criterion 2: an operator-ruling origin expedites with reason operator ruling; a blank or non-string expedite does not", () => {
  assert.equal(drain.expediteReason(task("A", { origin: RULING })), "operator ruling");
  assert.equal(drain.expediteReason(task("A", { origin: RULING, expedite: "  " })), "operator ruling", "a blank declared reason falls back to the origin");
  assert.equal(drain.expediteReason(task("A", { origin: RULING, expedite: `  ${LEAK}  ` })), LEAK, "a declared reason is kept, trimmed");
  assert.equal(drain.expediteReason(task("A", { expedite: LEAK })), LEAK);
  for (const expedite of ["", "   ", "\n\t", 1, true, { reason: LEAK }, null, undefined]) {
    for (const origin of [undefined, "architect", "operator-ruling", "garden#operator-ruling#x", " operator-ruling#x"]) {
      const t = task("A", { origin, expedite: expedite as unknown as string });
      assert.equal(drain.expediteReason(t), undefined, `expedite ${JSON.stringify(expedite)} with origin ${String(origin)}`);
    }
  }

  const tasks = [task("ORD"), task("RUL", { origin: RULING, priority: 3 }), task("BLANK", { expedite: "  ", priority: 2 })];
  const dispatchValueContext = strideContext({ ORD: 0.1, RUL: 3, BLANK: 2 });
  assert.deepEqual(ids(runnableCandidates(plan(tasks), notMerged, 3, { dispatchValueContext })), ["RUL", "ORD", "BLANK"],
    "the ruling task leads; the blank expedite keeps its stride place");
});

test("W1-T14654 criterion 3: at most max(1, N - 1) expedited tasks are in flight, and the free lanes left take the stride order", () => {
  const free = (n: number) => Array.from({ length: n }, (_, i) => task(`E${i}`, { expedite: LEAK, priority: 0.1 }));
  const ordinary = [task("O1"), task("O2"), task("O3"), task("O4")];
  const passes: Record<string, number> = { O1: 0.1, O2: 0.2, O3: 0.3, O4: 0.4 };
  for (let i = 0; i < 4; i++) passes[`E${i}`] = 5 + i;
  const dispatchValueContext = strideContext(passes);
  const runningExpedited = (n: number) => Array.from({ length: n }, (_, i) => task(`RE${i}`, { expedite: LEAK }));
  const runningOrdinary = (n: number) => Array.from({ length: n }, (_, i) => task(`RO${i}`));
  let cases = 0;
  for (let lanes = 1; lanes <= 4; lanes++) {
    for (let expeditedRunning = 0; expeditedRunning <= lanes; expeditedRunning++) {
      for (let ordinaryRunning = 0; expeditedRunning + ordinaryRunning < lanes; ordinaryRunning++) {
        const inFlight = [...runningExpedited(expeditedRunning), ...runningOrdinary(ordinaryRunning)];
        const limit = lanes - inFlight.length;
        const picked = runnableCandidates(plan([...free(4), ...ordinary]), notMerged, limit, { dispatchValueContext, inFlight });
        const label = `lanes=${lanes} expedited running=${expeditedRunning} ordinary running=${ordinaryRunning}`;
        assert.equal(picked.length, limit, `${label}: every free lane is filled`);
        const expeditedAfter = expeditedRunning + picked.filter(isExpedited).length;
        const share = Math.max(1, lanes - 1);
        assert.equal(expeditedAfter, Math.max(expeditedRunning, Math.min(share, expeditedRunning + limit)), `${label}: the share is filled, never passed`);
        assert.ok(expeditedAfter <= Math.max(share, expeditedRunning), label);
        assert.deepEqual(ids(picked.filter((t) => !isExpedited(t))), ids(ordinary).slice(0, picked.filter((t) => !isExpedited(t)).length),
          `${label}: the ordinary lanes take the stride order`);
        cases++;
      }
    }
  }
  assert.equal(cases, 20, "every lane split was measured");

  // Three lanes, two expedited running: the third lane is the ordinary queue's.
  const twoRunning = runnableCandidates(plan([...free(2), ...ordinary]), notMerged, 1, { dispatchValueContext, inFlight: runningExpedited(2) });
  assert.deepEqual(ids(twoRunning), ["O1"]);
  // One lane, nothing running: the only lane is the next free lane.
  assert.deepEqual(ids(runnableCandidates(plan([...free(2), ...ordinary]), notMerged, 1, { dispatchValueContext })), ["E0"]);

  // A refill packs a pool of every lane over the lanes in flight; the share is read from the lane total it names.
  const pool = (expediteLanes?: number) => runnableCandidates(plan([...free(3), ...ordinary]), notMerged, 3,
    { dispatchValueContext, inFlight: [...runningExpedited(1), ...runningOrdinary(1)], ...(expediteLanes === undefined ? {} : { expediteLanes }) });
  assert.deepEqual(ids(pool(3)), ["E0", "O1", "O2"], "three lanes, one expedited running: one more");
  assert.deepEqual(ids(pool(2)), ["O1", "O2", "O3"], "two lanes, one expedited running: none");
  assert.deepEqual(ids(pool()), ["E0", "E1", "E2"], "without a lane total the pass counts in flight plus its limit: five");
});

test("W1-T14654 criterion 4: each expedited start writes one dispatch.expedited row, declared in ledger-steps.ts", { timeout: 10_000 }, async () => {
  assert.equal(drain.EXPEDITED_STEP, "dispatch.expedited");
  assert.deepEqual(meaningOfStep("dispatch.expedited")?.writer, ["runDaemon"]);
  assert.match(meaningOfStep("dispatch.expedited")?.meaning ?? "", /expedite/);

  const seen: Array<[string, unknown]> = [];
  const direct = runnableCandidates(plan([task("ORD"), task("RUL", { origin: RULING, priority: 3 })]), notMerged, 2,
    { onExpedited: (t, start) => seen.push([t.id, start]) });
  assert.deepEqual(ids(direct), ["RUL", "ORD"]);
  assert.deepEqual(seen, [["RUL", { reason: "operator ruling", lanes: 2, share: 1, expedited_in_flight: 0 }]]);

  // The daemon: lane A runs, B frees, and its refill pool holds an ordinary task and an expedited one.
  const drive = async (aExpedited: boolean) => {
    const A = task("A", aExpedited ? { expedite: LEAK, priority: 0 } : { priority: 0 });
    const B = task("B", { priority: 0 });
    const ORD = task("ORD", { depends_on: ["B"], priority: 1 });
    const EXP = task("EXP", { depends_on: ["B"], priority: 2, expedite: LEAK });
    const started: string[] = [];
    const rows: Array<{ step: string; extra?: Record<string, unknown> }> = [];
    const merged = new Set<string>();
    let releaseA!: () => void;
    const aHeld = new Promise<void>((resolve) => { releaseA = resolve; });
    let stopped = false;
    const deps: DaemonDeps = {
      ...hostIndependentDaemonDeps(),
      refreshMerged: () => (id) => merged.has(id),
      log: (step, extra) => { rows.push({ step, extra }); },
      runOne: async (id) => {
        started.push(id);
        if (id === "A") await aHeld;
        if (id !== "A" && id !== "B") stopped = true;
        merged.add(id);
        return { taskId: id, runId: `${id}-run`, merged: true, verdict: "merged", costUsd: 0 };
      },
      checkStop: () => (stopped ? "fixture complete" : undefined),
      sleep: async () => { await drainMicrotasks(); },
    };
    const run = runDaemon(plan([A, B, ORD, EXP]), deps, { laneCount: 2, max: 3 });
    for (let i = 0; i < 50 && started.length < 3; i++) await drainMicrotasks();
    releaseA();
    await run;
    return { started, expedited: rows.filter((r) => r.step === "dispatch.expedited").map((r) => r.extra) };
  };
  const ordinaryRunning = await drive(false);
  assert.deepEqual(ordinaryRunning.started, ["A", "B", "EXP"], "the refilled lane takes the expedited task");
  assert.deepEqual(ordinaryRunning.expedited, [{ task: "EXP", reason: LEAK, lanes: 2, share: 1, expedited_in_flight: 0 }]);
  const expeditedRunning = await drive(true);
  assert.deepEqual(expeditedRunning.started, ["A", "B", "ORD"], "two lanes, A expedited: the refill keeps the ordinary lane");
  assert.deepEqual(expeditedRunning.expedited, [{ task: "A", reason: LEAK, lanes: 2, share: 1, expedited_in_flight: 0 }],
    "A's own start wrote its row; the held EXP wrote none");
});

test("W1-T14654 criterion 5: invariant holds-still-hold, a held expedited task is never dispatched, and with none the order is origin/main's", () => {
  const ordinary = [task("O1"), task("O2", { priority: 2 }), task("O3", { priority: 0.5, files: ["src/shared.ts"] })];
  const dispatchValueContext = strideContext({ O1: 0.3, O2: 0.1, O3: 0.6, H: 9 });
  const baseline = runnableCandidates(plan(ordinary), notMerged, 3, { dispatchValueContext });
  assert.deepEqual(ids(baseline), ["O2", "O1", "O3"], "origin/main's stride order");
  assert.equal(JSON.stringify(runnableCandidates(plan(ordinary), notMerged, 3, { dispatchValueContext, onExpedited: () => assert.fail("no expedited") })),
    JSON.stringify(baseline), "with no expedited task the pass is byte-identical");

  const expedite = { expedite: LEAK, priority: 0.1 } as const;
  const holds: Array<[string, Task, NextRunnableOpts]> = [
    ["verify: human, unreleased", task("H", { ...expedite, verify: "human" }), {}],
    ["needs_input, unanswered", task("H", { ...expedite, needs_input: { question: "which lane?", asked_at: "2026-11-24T00:00:00Z" } }), { inputAnswer: () => "  " }],
    ["an open dependency", task("H", { ...expedite, depends_on: ["O1"] }), {}],
    ["a tripped breaker", task("H", { ...expedite }), { isCircuitTripped: (id) => id === "H" }],
    ["a dispatch hold", task("H", { ...expedite, origin: RULING, dispatch_hold: true }), {}],
  ];
  for (const [hold, held, opts] of holds) {
    const picked = runnableCandidates(plan([...ordinary, held]), notMerged, 4, { dispatchValueContext, ...opts });
    assert.deepEqual(ids(picked), ids(baseline), `${hold}: the held task is not returned and the order is unchanged`);
  }
  assert.deepEqual(ids(runnableCandidates(plan([...ordinary, task("H", { ...expedite, verify: "human" })]), notMerged, 4,
    { dispatchValueContext, releasedIds: new Set(["H"]) })), ["H", "O2", "O1", "O3"], "control: released, it leads");

  // Scope overlap with an in-flight task: a disjoint ordinary task takes the lane, and the pack's fallback is serialized.
  const running = task("RUN", { files: ["src/shared.ts"] });
  const overlapping = task("H", { ...expedite, files: ["src/shared.ts"] });
  const opts: NextRunnableOpts = { dispatchValueContext, inFlight: [running] };
  assert.deepEqual(ids(runnableCandidates(plan([...ordinary, overlapping]), notMerged, 1, opts)), ["O2"]);
  const fallback = runnableCandidates(plan([overlapping]), notMerged, 1, opts);
  assert.deepEqual(ids(fallback), ["H"], "nothing disjoint is left: the pack falls back, as on origin/main");
  const partition = partitionByFileOverlap([running, ...fallback]);
  assert.deepEqual(ids(partition.dispatch), ["RUN"], "the partition serializes it behind the in-flight task");
  assert.deepEqual(partition.serialized.map((d) => [d.task, d.blockedBy]), [["H", "RUN"]]);
});
