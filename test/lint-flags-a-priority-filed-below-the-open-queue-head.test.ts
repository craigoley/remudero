import assert from "node:assert/strict";
import { test } from "node:test";

import type { Plan, Task } from "#src/lib/plan.js";
import { lintPlan } from "#src/lib/task-linter.js";

function mk(id: string, status: string, priority?: number): Task {
  return { id, title: id, status, priority } as unknown as Task;
}
function mkPlan(tasks: Task[]): Plan {
  return { tasks, byId: new Map(tasks.map((t) => [t.id, t])) } as unknown as Plan;
}
const warns = (plan: Plan, id: string) =>
  lintPlan(plan).get(id)!.violations.filter((v) => v.check === "dispatch-priority" && /queue head/.test(v.message));

test("W1-T9328: a priority below every other open task warns with the queue head value", () => {
  const plan = mkPlan([mk("A", "queued", 1), mk("B", "queued", 1), mk("C", "queued", 0.9), mk("D", "merged", 0.5)]);
  const w = warns(plan, "C");
  assert.equal(w.length, 1);
  assert.equal(w[0].severity, "warn");
  assert.match(w[0].message, /queue head 1 \(2 other/);
});

test("W1-T9328: a priority at the head, absent, or on a closed task does not warn and nothing blocks", () => {
  const plan = mkPlan([
    mk("A", "queued", 1),
    mk("B", "queued", 1),
    mk("C", "queued", 0.9),
    mk("E", "queued"),
    mk("F", "merged", 0.1),
    mk("D", "merged", 0.5),
  ]);
  assert.equal(warns(plan, "A").length, 0);
  assert.equal(warns(plan, "E").length, 0);
  assert.equal(warns(plan, "F").length, 0);
  assert.equal(warns(mkPlan([mk("S", "queued", 0.5)]), "S").length, 0);
  const res = lintPlan(plan).get("C")!;
  assert.ok(res.violations.every((v) => v.severity !== "block" || v.check !== "dispatch-priority"));
  assert.equal(warns(plan, "C").every((v) => v.severity === "warn"), true);
});
