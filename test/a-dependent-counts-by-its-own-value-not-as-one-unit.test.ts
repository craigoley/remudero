import assert from "node:assert/strict";
import test from "node:test";
import { buildDispatchValueContext, costOfDelayReadyRow, dispatchUrgency, explainDispatchScore } from "#src/lib/dispatch-value.js";
import { dispatchOrder } from "#src/lib/drain.js";
import type { Task } from "#src/lib/plan.js";

const HOUR = 3_600_000;
const NOW = Date.parse("2026-10-17T12:00:00Z");
const task = (id: string, priority = 1, depends_on: string[] = []): Task => ({
  id, title: id, repo: "remudero", depends_on, priority, files: ["src/a.ts"],
  type: "implement", verify: "auto", risk: "high", status: "queued", attempts: 0,
});

function calibrate(tasks: Task[], ages: Record<string, number> = {}, closed: string[] = []) {
  const rows: Array<Record<string, unknown>> = [];
  const filed = new Map(tasks.map(t => [t.id, NOW - (ages[t.id] ?? 0)]));
  for (let i = 0; i < 8; i++) {
    const id = `W1-T${6000 + i}`;
    filed.set(id, NOW - 12 * HOUR);
    rows.push({ step: "run.start", task_id: id, run_id: id, task_class: "src", ts: new Date(NOW - 10 * HOUR).toISOString() });
    rows.push({ step: "verdict", task_id: id, run_id: id, verdict: "merged", cost_usd: 2, ts: new Date(NOW - 9 * HOUR).toISOString() });
  }
  const result = buildDispatchValueContext(tasks, rows, new Set(tasks.filter(t => !closed.includes(t.id)).map(t => t.id)), NOW, true, "seed", {
    planTreeSha: "fixed-tree", filedAtByTaskId: filed,
  });
  assert.equal(result.kind, "ready");
  return result.context;
}

function chain(head: Task, length: number, priority = 2): Task[] {
  return Array.from({ length }, (_, i) => task(`W1-T${7000 + i}`, priority, [i === 0 ? head.id : `W1-T${7000 + i - 1}`]));
}

const score = (context: ReturnType<typeof calibrate>, id: string) => {
  const value = context.costOfDelayByTaskId?.get(id);
  assert.equal(typeof value, "number");
  return value!;
};
const inputs = (context: ReturnType<typeof calibrate>, id: string) => {
  const value = context.costOfDelayInputsByTaskId?.get(id);
  assert.ok(value);
  return value;
};

test("W1-T10020: 21 chained P2 waves under an enabler do not lift it past an independent P1 unless its own value exceeds it", () => {
  const head = task("W1-T10", 2);
  const lone = task("W1-T20");
  const tasks = [head, lone, ...chain(head, 21)];
  const sameAge = Object.fromEntries(tasks.map(t => [t.id, HOUR]));
  const context = calibrate(tasks, sameAge);
  assert.equal(dispatchOrder([head, lone], context)[0].id, lone.id);
  assert.ok(score(context, lone.id) > score(context, head.id));
  const older = calibrate(tasks, { ...sameAge, [head.id]: 16 * HOUR });
  assert.ok(inputs(older, head.id).urgency > inputs(older, lone.id).urgency);
  assert.equal(dispatchOrder([head, lone], older)[0].id, head.id);
});

test("W1-T10020: a P1 enabler of 21 chained P2 waves yields to a lone P1 that has waited one tier unit", () => {
  const head = task("W1-T10");
  const lone = task("W1-T20");
  const context = calibrate([head, lone, ...chain(head, 21)], { [lone.id]: 2 * HOUR });
  assert.equal(inputs(context, lone.id).urgency, 2);
  assert.equal(dispatchOrder([head, lone], context)[0].id, lone.id);
  assert.ok(score(context, lone.id) > score(context, head.id));
});

test("W1-T10020: a P1 enabler of P1 dependents still outranks a lone P1", () => {
  const head = task("W1-T20");
  const lone = task("W1-T10");
  const context = calibrate([head, lone, ...chain(head, 3, 1)]);
  assert.equal(dispatchOrder([lone, head], context)[0].id, head.id);
  assert.equal(explainDispatchScore(head, context).dependent_value, 0.5 + 0.25 + 0.125);
});

test("W1-T10020: lengthening a chain of P2 waves from 21 to 42 adds less than one P2 wave of urgency", () => {
  const head = task("W1-T10");
  const lone = task("W1-T20");
  const short = calibrate([head, lone, ...chain(head, 21)]);
  const long = calibrate([head, lone, ...chain(head, 42)]);
  const delta = score(long, head.id) - score(short, head.id);
  assert.ok(delta > 0, "distant waves still have positive value");
  assert.ok(delta < score(long, "W1-T7041"), "the added tail is worth less than one P2 wave");
  assert.ok(explainDispatchScore(head, long).dependent_value! < dispatchUrgency(1, 0));
});

test("W1-T10020: a fan of open dependents adds the value of each dependent", () => {
  const fan = task("W1-T20");
  const one = task("W1-T10");
  const children = [task("W1-T30", 1, [fan.id]), task("W1-T31", 1, [fan.id]), task("W1-T32", 1, [fan.id])];
  const context = calibrate([fan, one, ...children, task("W1-T40", 1, [one.id])]);
  assert.equal(dispatchOrder([one, fan], context)[0].id, fan.id);
  assert.equal(explainDispatchScore(fan, context).dependent_value, 3 * dispatchUrgency(1, 0));
  assert.equal(explainDispatchScore(one, context).dependent_value, dispatchUrgency(1, 0));
});

test("W1-T10020: a dependency cycle terminates and is named in the ready row", { timeout: 2000 }, () => {
  const a = task("W1-T10", 1, ["W1-T11", "W1-T20"]);
  const b = task("W1-T11", 1, [a.id]);
  const self = task("W1-T12", 1, ["W1-T12"]);
  const outside = task("W1-T20");
  const after = task("W1-T21", 1, [a.id, outside.id]);
  const context = calibrate([after, outside, self, b, a]);
  const row = costOfDelayReadyRow("fixed-tree", context);
  assert.deepEqual(row.dependent_cycle, [a.id, b.id, self.id]);
  assert.equal(row.key, "ready:fixed-tree");
  assert.equal(explainDispatchScore(a, context).dependent_value, 0);
  assert.equal(explainDispatchScore(b, context).dependent_value, 0);
  assert.equal(explainDispatchScore(self, context).dependent_value, 0);
  assert.equal(explainDispatchScore(outside, context).dependent_value, dispatchUrgency(1, 0));
  assert.ok(score(context, outside.id) > score(context, a.id));
  assert.deepEqual(dispatchOrder([outside], context).map(t => t.id), [outside.id]);
});

test("W1-T10020: the ready row reports each dependent value beside its open-dependent count", () => {
  const head = task("W1-T10");
  const lone = task("W1-T20");
  const waves = chain(head, 3);
  const tasks = [head, lone, ...waves];
  const ages = { [head.id]: HOUR, [waves[0].id]: 2 * HOUR, [waves[1].id]: 4 * HOUR, [waves[2].id]: 6 * HOUR };
  const context = calibrate(tasks, ages);
  const expected = waves.reduce((sum, wave, i) => sum + dispatchUrgency(1 + i + 1, ages[wave.id] / (2 * HOUR)), 0);
  const row = costOfDelayReadyRow("fixed-tree", context);
  assert.deepEqual(row.dependent_value?.find(entry => entry.id === head.id), {
    id: head.id, open_dependents: 3, own_urgency: dispatchUrgency(0, 0.5), dependent_value: expected,
  });
  assert.deepEqual(row.dependent_value?.map(entry => entry.id), [head.id, waves[0].id, waves[1].id]);
  assert.equal(explainDispatchScore(head, context).dependent_value, expected);
  assert.equal(explainDispatchScore(lone, context).dependent_value, 0);
  assert.equal(row.dependent_cycle, undefined);
  assert.equal(row.key, "ready:fixed-tree");
  assert.deepEqual(costOfDelayReadyRow("fixed-tree", calibrate([...tasks].reverse(), ages)), row);
  const plain = calibrate([head, lone], ages);
  assert.equal(score(context, lone.id), score(plain, lone.id), "independent scores are unchanged");
  assert.equal(costOfDelayReadyRow("fixed-tree", plain).dependent_value, undefined);
});

test("W1-T10020: longest open dependency depth discounts shortcuts and counts a diamond once", () => {
  const head = task("W1-T10");
  const waves = chain(head, 3);
  const shortcut = task("W1-T30", 2, [head.id, waves[2].id]);
  const context = calibrate([head, ...waves, shortcut]);
  assert.equal(context.openDependentFanoutByTaskId.get(head.id), 4);
  assert.equal(explainDispatchScore(head, context).dependent_value,
    [1, 2, 3, 4].reduce((sum, depth) => sum + dispatchUrgency(1 + depth, 0), 0));
  const unrelated = task("W1-T40");
  const unrelatedWaves = chain(unrelated, 3).map((t, i) => task(`W1-T${8000 + i}`, 2, [i === 0 ? unrelated.id : `W1-T${8000 + i - 1}`]));
  const joined = task("W1-T50", 2, [head.id, unrelatedWaves[2].id]);
  const jointContext = calibrate([head, unrelated, ...unrelatedWaves, joined]);
  assert.equal(explainDispatchScore(head, jointContext).dependent_value, dispatchUrgency(1 + 4, 0));
});

test("W1-T10020: merged and out-of-plan dependencies add no level or value", () => {
  const head = task("W1-T10", 1, ["W1-T999"]);
  const merged = task("W1-T20", 1, [head.id]);
  const child = task("W1-T30", 2, [head.id, merged.id, "W1-T998"]);
  const context = calibrate([head, merged, child], {}, [merged.id]);
  assert.equal(explainDispatchScore(head, context).dependent_value, dispatchUrgency(2, 0));
  assert.equal(context.openDependentFanoutByTaskId.get(head.id), 1);
  assert.equal(context.costOfDelayByTaskId?.has(merged.id), false);
});

test("W1-T10020: overlapping cycles name every member independently of traversal order", () => {
  const a = task("W1-T10", 1, ["W1-T11", "W1-T12"]);
  const b = task("W1-T11", 1, [a.id]);
  const c = task("W1-T12", 1, [b.id]);
  const outside = task("W1-T20");
  const context = calibrate([a, b, c, outside]);
  assert.deepEqual(costOfDelayReadyRow("fixed-tree", context).dependent_cycle, [a.id, b.id, c.id]);
  for (const member of [a, b, c]) assert.equal(explainDispatchScore(member, context).dependent_value, 0);
  const reordered = calibrate([{ ...a, depends_on: [...a.depends_on].reverse() }, b, c, outside]);
  assert.deepEqual(costOfDelayReadyRow("fixed-tree", reordered), costOfDelayReadyRow("fixed-tree", context));
});
