import assert from "node:assert/strict";
import test from "node:test";
import { buildDispatchValueContext, stridePassInputs } from "#src/lib/dispatch-value.js";
import type { DispatchValueContext } from "#src/lib/dispatch-value.js";
import { dispatchOrder, nextRunnable, runnableCandidates } from "#src/lib/drain.js";
import { NO_OBSERVED_SCOPE } from "#src/lib/dispatch-overlap.js";
import { captureDispatchFrontier, dispatchPickPayload } from "#src/lib/daemon.js";
import type { Plan, Task } from "#src/lib/plan.js";

const HOUR = 3_600_000;
const NOW = Date.parse("2026-10-17T02:00:00Z");
const task = (id: string, over: Partial<Task> = {}): Task => ({
  id, title: id, repo: "remudero", depends_on: [], files: ["src/a.ts"],
  type: "implement", verify: "auto", risk: "high", status: "queued", attempts: 0, ...over,
});

interface Waiting { task: Task; filedAgo: number }

// Merged history, as in the W1-T9968 file: P1 starts after 6, 10, 24 and 30 h, so the P1 tier's wait is 24 h.
const STARTED = [
  ...Array.from({ length: 8 }, (_, i) => ({ id: `W1-T${6000 + i}`, wait: 10 * HOUR, inPlan: false })),
  ...[6, 10, 24, 30].map((wait, i) => ({ id: `W1-T${6100 + i}`, wait: wait * HOUR, inPlan: true })),
];

function calibrate(waiting: readonly Waiting[]): DispatchValueContext {
  const rows: Array<Record<string, unknown>> = [];
  const filed = new Map<string, number>();
  for (const s of STARTED) {
    const at = NOW - 40 * HOUR;
    filed.set(s.id, at - s.wait);
    rows.push({ step: "run.start", task_id: s.id, run_id: s.id, task_class: "src", ts: new Date(at).toISOString() });
    rows.push({ step: "verdict", task_id: s.id, run_id: s.id, verdict: "merged", cost_usd: 2, ts: new Date(at + HOUR).toISOString() });
  }
  for (const w of waiting) filed.set(w.task.id, NOW - w.filedAgo);
  const tasks = [...STARTED.filter(s => s.inPlan).map(s => task(s.id, { priority: 1, status: "done" })), ...waiting.map(w => w.task)];
  const result = buildDispatchValueContext(tasks, rows, new Set(waiting.map(w => w.task.id)), NOW, true, "seed", {
    planTreeSha: "tree-sha", filedAtByTaskId: filed,
  });
  assert.equal(result.kind, "ready");
  return result.context;
}

const planOf = (tasks: readonly Task[]): Plan => ({ tasks: [...tasks], byId: new Map(tasks.map(t => [t.id, t])) });
const unmerged = () => false;

/** `length` open dependents of `head`, each depending on the one before. */
function chain(head: Task, firstId: number, length: number, priority: number, filedAgo: number): Waiting[] {
  return Array.from({ length }, (_, i) => ({
    task: task(`W1-T${firstId + i}`, { depends_on: [i === 0 ? head.id : `W1-T${firstId + i - 1}`], priority }),
    filedAgo,
  }));
}

/** The W1-T9874 / W1-T9378 queue: a human P2 holding the best P2 slot, a P2 head with 29 dependents, fresh P1s. */
function falsifierQueue() {
  const human = task("W1-T9378", { priority: 2, verify: "human" });
  const head = task("W1-T9874", { priority: 2 });
  const p1s = ["W1-T9926", "W1-T9927", "W1-T9928"].map(id => task(id, { priority: 1 }));
  const waiting: Waiting[] = [
    { task: human, filedAgo: 36 * HOUR }, { task: head, filedAgo: 12 * HOUR }, ...chain(head, 7000, 29, 2, 12 * HOUR),
    ...p1s.map(t => ({ task: t, filedAgo: 0 })),
  ];
  const tasks = waiting.map(w => w.task);
  return { human, head, p1s, tasks, context: calibrate(waiting) };
}

test("W1-T10028: an ineligible same-tier task lends no fan-out slot", () => {
  const { human, head, p1s, tasks, context } = falsifierQueue();
  const everyone = context.stridePassByTaskId!;
  // The control: dealt over every open task (W1-T9968 alone), W1-T9874 borrows W1-T9378's slot and outranks the P1s.
  assert.ok(everyone.get(head.id)! < everyone.get(p1s[0].id)!, "dealt over every open task, the P2 head sorts above a P1");
  const dealtOverAll = dispatchOrder(tasks.filter(t => t.depends_on.length === 0 && t !== human), context);
  assert.equal(dealtOverAll[0].id, head.id, "so a selector that orders first and filters after dispatches it first");
  const plan = planOf(tasks);
  const picked = runnableCandidates(plan, unmerged, 10, { dispatchValueContext: context });
  assert.deepEqual(picked.map(t => t.id), [...p1s.map(t => t.id), head.id], "the P1s dispatch before the P2 head");
  assert.equal(nextRunnable(plan, unmerged, { dispatchValueContext: context })!.id, p1s[0].id);
  assert.ok(!picked.some(t => t.id === human.id), "the human task never dispatches");
});

/** mulberry32: a fixed seed gives the same queue on every run. */
function rng(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

test("W1-T10028: every cross-tier pair of eligible tasks keeps its no-fan-out order", () => {
  const TIERS = [1, 2, 3];
  let crossedWhenDealtOverAll = 0, checked = 0;
  for (let seed = 1; seed <= 24; seed++) {
    const draw = rng(seed);
    const waiting: Waiting[] = [];
    let next = 8000;
    for (const priority of TIERS) {
      for (let i = 0; i < 6; i++) {
        const kind = draw();
        // About a third of each tier is a task the selector declines: verify human, retired, status blocked.
        const over: Partial<Task> = kind < 0.12 ? { verify: "human" } : kind < 0.24 ? { status: "blocked", retirement: "retired" } : kind < 0.34 ? { status: "blocked" } : {};
        const ready = task(`W1-T${next++}`, { priority, ...over });
        const filedAgo = Math.floor(draw() * 100) * HOUR;
        waiting.push({ task: ready, filedAgo });
        if (draw() < 0.5) {
          const length = 1 + Math.floor(draw() * 30);
          waiting.push(...chain(ready, next, length, TIERS[Math.floor(draw() * TIERS.length)], Math.floor(draw() * filedAgo / HOUR) * HOUR));
          next += length;
        }
      }
    }
    const open = waiting.map(w => w.task);
    const context = calibrate(waiting);
    const order = runnableCandidates(planOf(open), unmerged, open.length, { dispatchValueContext: context });
    // A dependency on a retired task is released (plan.ts's unmetDependencies), so such a dependent is eligible.
    const retired = new Set(open.filter(t => t.retirement !== undefined).map(t => t.id));
    const eligible = open.filter(t => t.verify === "auto" && t.status === "queued" && t.depends_on.every(id => retired.has(id)));
    assert.deepEqual(new Set(order.map(t => t.id)), new Set(eligible.map(t => t.id)), `seed ${seed}: the dispatchable set`);
    // The no-fan-out order of the eligible set: their own pass0, which no dependent moves.
    const pass0 = (t: Task) => stridePassInputs(context)!.get(t.id)!.pass0;
    const noFanout = [...eligible].sort((a, b) => pass0(a) - pass0(b));
    assert.deepEqual(order.map(t => t.priority), noFanout.map(t => t.priority), `seed ${seed}: tiers in the no-fan-out order`);
    checked += eligible.length;
    const overAll = dispatchOrder(eligible, context).map(t => t.priority);
    if (overAll.some((p, i) => p !== noFanout[i].priority)) crossedWhenDealtOverAll++;
  }
  assert.ok(checked > 24 * 8, "the queues hold eligible tasks");
  assert.ok(crossedWhenDealtOverAll > 0, "dealt over every open task, an ineligible task's slot moves a tier on some queue");
});

test("W1-T10028: the dispatch pick row reports the rank and stride pass the selector used", () => {
  const { head, p1s, tasks, context } = falsifierQueue();
  const plan = planOf(tasks);
  const selection = captureDispatchFrontier(plan, { dispatchValueContext: context });
  const picked = runnableCandidates(plan, unmerged, 1, selection.opts);
  assert.equal(picked[0].id, p1s[0].id);
  const expected = [...p1s.map(t => t.id), head.id];
  assert.deepEqual(selection.eligible.map(t => t.id), expected, "the frontier is the selector's order, not the eligibility walk's");
  for (const [index, id] of expected.entries()) {
    const payload = dispatchPickPayload(plan.byId.get(id)!, "tick", selection.eligible, selection.context, [], [], NO_OBSERVED_SCOPE);
    assert.equal(payload.rank, index + 1, `${id}: rank`);
    assert.equal(payload.stride_pass, selection.context!.stridePassByTaskId!.get(id), `${id}: the redealt pass`);
  }
  const headRow = dispatchPickPayload(head, "tick", selection.eligible, selection.context, [], [], NO_OBSERVED_SCOPE);
  assert.notEqual(headRow.stride_pass, context.stridePassByTaskId!.get(head.id), "not the pre-pass pass, which held the human task's slot");
});
