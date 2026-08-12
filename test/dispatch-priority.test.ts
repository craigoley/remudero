import assert from "node:assert/strict";
import test from "node:test";
import { compareDispatch, dispatchOrder, nextRunnable } from "../src/lib/drain.js";
import type { Plan, Task } from "../src/lib/plan.js";
import { dispatchPriorityViolations, DISPATCH_PRIORITY_MAX, DISPATCH_PRIORITY_MIN, lintTask } from "../src/lib/task-linter.js";

// ── W1-T422: an explicit `priority:` field is the honest successor to the ────────────────
//    positional signal impl-DQ (lib/drain.ts) deliberately discarded ────────────────────────
//
// Design (v)'s falsifier, verbatim: with a fixture plan of ids T1<T2<T3 where T3 carries
// priority 1, dispatchOrder yields T3 first and T1,T2 in id order after; two tasks sharing
// priority 1 order by id (determinism); a priority on a blocked task draws the lint warn;
// and REVERTING the comparator change makes the ordering test fail while the tie test still
// passes — the discriminating pair. Both are below, and the comparator change is exercised
// directly (not just through nextRunnable/dispatchOrder), same as dispatch-order.test.ts.

function task(id: string, over: Partial<Task> = {}): Task {
  return {
    id,
    title: id,
    repo: "remudero",
    depends_on: [],
    type: "implement",
    verify: "auto",
    risk: "medium",
    status: "queued",
    attempts: 0,
    ...over,
  } as never;
}

function planOf(tasks: Task[]): Plan {
  return { tasks, byId: new Map(tasks.map((t) => [t.id, t])) } as never;
}

const NONE_MERGED = () => false;

test("THE DISCRIMINATING ORDERING TEST: a lower priority dispatches before a lower-id task without one", () => {
  // ids ascending T1 < T2 < T3, but T3 carries priority 1 — it must dispatch FIRST, and T1/T2
  // (both un-prioritized) keep falling back to id order after it. This is the exact fixture
  // design (v) names: reverting the comparator change (dropping the priority read) makes this
  // test fail while the tie test below still passes.
  const tasks = [task("W1-T1"), task("W1-T2"), task("W1-T3", { priority: 1 })];
  const plan = planOf(tasks);

  const order = dispatchOrder(tasks).map((t) => t.id);

  assert.deepEqual(order, ["W1-T3", "W1-T1", "W1-T2"], "the prioritized task fronts the queue");
  assert.equal(nextRunnable(plan, NONE_MERGED)?.id, "W1-T3");
});

test("THE TIE TEST: two tasks sharing a priority order by id (determinism preserved)", () => {
  // Both T2 and T1 carry the SAME priority — the tiebreak must still be id order, exactly as
  // the no-priority case. This test does NOT discriminate the comparator change on its own
  // (an id-only comparator restricted to these two priority-equal tasks would still pass it),
  // which is why it survives the revert design (v) describes while the ordering test above
  // does not.
  const tasks = [task("W1-T2", { priority: 5 }), task("W1-T1", { priority: 5 }), task("W1-T9")];
  const plan = planOf(tasks);

  const order = dispatchOrder(tasks).map((t) => t.id);

  assert.deepEqual(order, ["W1-T1", "W1-T2", "W1-T9"], "equal priorities fall back to id order, un-prioritized last");
  assert.equal(nextRunnable(plan, NONE_MERGED)?.id, "W1-T1");
});

test("absent priority is byte-identical to today's id-only order (priority ?? +Infinity)", () => {
  const tasks = [task("W1-T30"), task("W1-T10"), task("W1-T20")];

  assert.deepEqual(dispatchOrder(tasks).map((t) => t.id), ["W1-T10", "W1-T20", "W1-T30"]);
});

test("a prioritized task ranks ahead of every un-prioritized one regardless of id", () => {
  const tasks = [task("W1-T5"), task("W1-T900", { priority: 0 }), task("W1-T6")];

  assert.deepEqual(dispatchOrder(tasks).map((t) => t.id), ["W1-T900", "W1-T5", "W1-T6"]);
});

test("compareDispatch is a TOTAL order over priority+id — no unexpected ties", () => {
  const tasks = [
    task("W1-T10", { priority: 2 }),
    task("W1-T11", { priority: 2 }),
    task("W1-T1"),
    task("W1-T2"),
  ];
  for (const a of tasks) {
    for (const b of tasks) {
      if (a.id === b.id) continue;
      assert.notEqual(compareDispatch(a, b), 0, `${a.id} vs ${b.id} must not tie`);
    }
  }
});

// ── dispatch-priority lint (design (iii)) ──────────────────────────────────────────────────

test("dispatchPriorityViolations: silent when priority is absent", () => {
  assert.deepEqual(dispatchPriorityViolations(task("W1-T1")), []);
});

test("dispatchPriorityViolations: silent for an in-range priority on an open task", () => {
  assert.deepEqual(dispatchPriorityViolations(task("W1-T1", { priority: 1 })), []);
  assert.deepEqual(dispatchPriorityViolations(task("W1-T2", { priority: DISPATCH_PRIORITY_MIN })), []);
  assert.deepEqual(dispatchPriorityViolations(task("W1-T3", { priority: DISPATCH_PRIORITY_MAX })), []);
});

test("dispatchPriorityViolations: WARNS on a priority outside [0, 99]", () => {
  const violations = dispatchPriorityViolations(task("W1-T1", { priority: 100 }));
  assert.equal(violations.length, 1);
  assert.equal(violations[0].check, "dispatch-priority");
  assert.equal(violations[0].severity, "warn");

  const negative = dispatchPriorityViolations(task("W1-T1", { priority: -1 }));
  assert.equal(negative.length, 1);
  assert.equal(negative[0].severity, "warn");
});

test("dispatchPriorityViolations: WARNS on a priority set on a non-open (blocked/merged/done) task", () => {
  for (const status of ["blocked", "merged", "done"] as const) {
    const violations = dispatchPriorityViolations(task("W1-T1", { priority: 1, status }));
    assert.equal(violations.length, 1, `status:${status} should warn`);
    assert.equal(violations[0].check, "dispatch-priority");
    assert.equal(violations[0].severity, "warn");
  }
});

test("dispatchPriorityViolations: an out-of-range priority on a non-open task draws BOTH warnings", () => {
  const violations = dispatchPriorityViolations(task("W1-T1", { priority: 500, status: "blocked" }));
  assert.equal(violations.length, 2);
  assert.ok(violations.every((v) => v.severity === "warn"));
});

test("dispatch-priority never BLOCKS — lintTask.ok stays true regardless of the value", () => {
  const result = lintTask(task("W1-T1", { priority: 500, status: "blocked" }));
  assert.ok(result.violations.some((v) => v.check === "dispatch-priority"));
  assert.equal(
    result.ok,
    !result.violations.some((v) => v.check !== "dispatch-priority" && v.severity === "block"),
    "no dispatch-priority violation ever flips ok to false",
  );
});

test("lintTask is wired to dispatch-priority — a clean task carries no such violation", () => {
  const result = lintTask(task("W1-T1", { priority: 1 }));
  assert.equal(result.violations.filter((v) => v.check === "dispatch-priority").length, 0);
});
