import assert from "node:assert/strict";
import test from "node:test";
import { buildDispatchValueContext, costOfDelayReadyRow, filingDatesFromPlanHistory } from "../src/lib/dispatch-value.js";
import { dispatchOrder } from "../src/lib/drain.js";
import type { Task } from "../src/lib/plan.js";

const DAY = 86_400_000;
const NOW = Date.parse("2026-10-09T12:00:00Z");
const task = (id: string, over: Partial<Task> = {}): Task => ({
  id, title: id, repo: "remudero", depends_on: [], files: ["src/a.ts"],
  type: "implement", verify: "auto", risk: "high", status: "queued", attempts: 0, ...over,
});

// A measured src-class history so every open task has a cost and a class score.
const history: Array<Record<string, unknown>> = [];
const historyDates = new Map<string, number>();
for (let i = 0; i < 12; i++) {
  const id = `W1-T${6000 + i}`;
  historyDates.set(id, NOW - 3 * DAY);
  history.push({ step: "run.start", task_id: id, run_id: id, task_class: "src", ts: new Date(NOW - DAY).toISOString() });
  history.push({ step: "verdict", task_id: id, run_id: id, verdict: i % 2 === 0 ? "merged" : "no_pr", cost_usd: 2, ts: new Date(NOW - DAY).toISOString() });
}

test("W1-T7534: a letter-suffixed task id is dated and the cost-of-delay context is ready", () => {
  const filedAt = Math.floor((NOW - 2 * DAY) / 1000);
  // The shape `git log --format=filing:%ct -p --unified=0` prints for a filing that adds a letter-suffixed id.
  const dates = filingDatesFromPlanHistory(`filing:${filedAt}\n+- id: W1-T12e\n+  title: drill\n+- id: W1-T6100\n`);
  assert.equal(dates.get("W1-T12e"), filedAt * 1000, "the whole letter-suffixed token is dated");
  assert.equal(dates.has("W1-T12"), false, "the suffix is never truncated into another id");
  assert.equal(dates.get("W1-T6100"), filedAt * 1000);

  const lettered = task("W1-T12e", { verify: "human" });
  const plain = task("W1-T6100");
  const snapshot = { planTreeSha: "tree-sha", filedAtByTaskId: new Map([...historyDates, ...dates]) };
  const result = buildDispatchValueContext([lettered, plain], history, new Set([lettered.id, plain.id]), NOW, true, "seed", snapshot);
  assert.equal(result.kind, "ready", "a letter-suffixed open task no longer refuses the schedule");
  assert.ok(result.context.stridePassByTaskId?.has("W1-T12e"));
  assert.ok(result.context.stridePassByTaskId?.has(plain.id));
  assert.equal(result.context.costOfDelayUnscored, undefined);
  assert.deepEqual(costOfDelayReadyRow("tree-sha", result.context), { key: "ready", plan_tree_sha: "tree-sha" });
});

test("W1-T7534: an undatable open task is unscored and the rest of the queue keeps its stride order", () => {
  const fresh = task("W1-T6200");
  const old = task("W1-T6201");
  const undatable = task("W1-T6202");
  const tasks = [undatable, old, fresh];
  const dates = new Map([...historyDates, [fresh.id, NOW - DAY], [old.id, NOW - 20 * DAY]]);
  const snapshot = { planTreeSha: "tree-sha", filedAtByTaskId: dates };
  const result = buildDispatchValueContext(tasks, history, new Set(tasks.map(t => t.id)), NOW, true, "seed", snapshot);
  assert.equal(result.kind, "ready", "one undatable task never refuses the whole context");
  const context = result.context;
  assert.equal(context.stridePassByTaskId?.has(undatable.id), false);
  assert.equal(context.costOfDelayByTaskId?.has(undatable.id), false);
  assert.ok(context.stridePassByTaskId?.get(fresh.id)! > 0);
  assert.ok(context.stridePassByTaskId?.get(old.id)! > 0);
  assert.deepEqual(context.costOfDelayUnscored, [undatable.id]);

  // The two dated tasks keep the order their own stride passes give, and the unscored one follows them.
  const datedOnly = buildDispatchValueContext([old, fresh], history, new Set([old.id, fresh.id]), NOW, true, "seed", snapshot);
  assert.equal(datedOnly.kind, "ready");
  const scoredOrder = dispatchOrder([old, fresh], datedOnly.context).map(t => t.id);
  assert.deepEqual(dispatchOrder(tasks, context).map(t => t.id), [...scoredOrder, undatable.id]);
  assert.deepEqual([...context.stridePassByTaskId!].sort(), [...datedOnly.context.stridePassByTaskId!].sort());

  // The ready row names the gap, keyed once per plan tree.
  assert.deepEqual(costOfDelayReadyRow("tree-sha", context), { key: "ready:tree-sha", plan_tree_sha: "tree-sha", unscored: [undatable.id] });
  assert.notEqual(costOfDelayReadyRow("next-tree", context).key, costOfDelayReadyRow("tree-sha", context).key);
});
