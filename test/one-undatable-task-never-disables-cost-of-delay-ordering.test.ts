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
  // W1-T9967: every ready row now reports the tier waits, so it is keyed per plan tree; it names no gap.
  const { tier_waits: waits, ...row } = costOfDelayReadyRow("tree-sha", result.context);
  assert.deepEqual(row, { key: "ready:tree-sha", plan_tree_sha: "tree-sha" });
  assert.ok(waits && waits.length > 0);
});

test("W1-T7534: an undatable open task is imputed at age zero and the rest of the queue keeps its stride order", () => {
  const fresh = task("W1-T6200");
  const old = task("W1-T6201");
  const undatable = task("W1-T6202");
  const tasks = [undatable, old, fresh];
  const dates = new Map([...historyDates, [fresh.id, NOW - DAY], [old.id, NOW - 20 * DAY]]);
  const snapshot = { planTreeSha: "tree-sha", filedAtByTaskId: dates };
  const result = buildDispatchValueContext(tasks, history, new Set(tasks.map(t => t.id)), NOW, true, "seed", snapshot);
  assert.equal(result.kind, "ready", "one undatable task never refuses the whole context");
  const context = result.context;
  // W1-T9323: undatable no longer means unscored — it is scored at age zero and named as imputed.
  assert.equal(context.stridePassByTaskId?.has(undatable.id), true);
  assert.equal(context.costOfDelayByTaskId?.has(undatable.id), true);
  assert.ok(context.stridePassByTaskId?.get(fresh.id)! > 0);
  assert.ok(context.stridePassByTaskId?.get(old.id)! > 0);
  assert.deepEqual(context.costOfDelayImputed, [undatable.id]);
  assert.equal(context.costOfDelayUnscored, undefined);
  assert.ok(context.stridePassByTaskId?.get(undatable.id)! > 0);

  // The ordering is total over all three tasks, each by its own stride pass.
  const byPass = [...tasks].sort((a, b) => context.stridePassByTaskId!.get(a.id)! - context.stridePassByTaskId!.get(b.id)!);
  assert.deepEqual(dispatchOrder(tasks, context).map(t => t.id), byPass.map(t => t.id));

  // The ready row names the gap, keyed once per plan tree.
  const { tier_waits: waits, ...row } = costOfDelayReadyRow("tree-sha", context);
  assert.deepEqual(row, { key: "ready:tree-sha", plan_tree_sha: "tree-sha", imputed: [undatable.id] });
  assert.ok(waits && waits.length > 0);
  assert.notEqual(costOfDelayReadyRow("next-tree", context).key, costOfDelayReadyRow("tree-sha", context).key);
});
