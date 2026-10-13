import assert from "node:assert/strict";
import test from "node:test";
import * as value from "../src/lib/dispatch-value.js";
import { dispatchOrder } from "../src/lib/drain.js";
import type { Task } from "../src/lib/plan.js";

const NOW = 1_800_000_000_000;
const AGE = 10_000_000;
type Sample = readonly [number, { valid: number; total: number }];
const share = (samples: readonly Sample[], age: number) => {
  const module = value as typeof value & { validityShareNearAge: (s: readonly Sample[], a: number) => { valid: number; total: number } };
  assert.equal(typeof module.validityShareNearAge, "function", "the production neighbourhood reader is wired");
  return module.validityShareNearAge(samples, age);
};
const task = (id: string): Task => ({ id, title: id, repo: "remudero", depends_on: [], files: ["src/a.ts"],
  type: "implement", verify: "auto", risk: "high", status: "queued", attempts: 0, priority: 1 });
function corpus(ages: number[], staleIndex: number) {
  const rows: Array<Record<string, unknown>> = [];
  const dates = new Map<string, number>();
  const start = NOW - 1_000;
  ages.forEach((age, i) => {
    const id = `W1-T${5000 + i}`;
    dates.set(id, start - age);
    rows.push({ step: "run.start", task_id: id, run_id: id, task_class: "src", ts: new Date(start).toISOString() });
    rows.push({ step: "verdict", task_id: id, run_id: id, verdict: i === staleIndex ? "already_satisfied" : "merged", cost_usd: 2, ts: new Date(start + 1).toISOString() });
  });
  return { rows, dates };
}
function calibrate(tasks: Task[], history: ReturnType<typeof corpus>, ages: number[], nowMs = NOW) {
  const dates = new Map(history.dates);
  tasks.forEach((t, i) => dates.set(t.id, NOW - ages[i]));
  const result = value.buildDispatchValueContext(tasks, history.rows, new Set(tasks.map(t => t.id)), nowMs, true,
    "fixed-tree", { planTreeSha: "fixed-tree", filedAtByTaskId: dates });
  assert.equal(result.kind, "ready");
  return result;
}

test("W1-T9038: the validity share pools the runs nearest a task age, not the one nearest run", () => {
  const ages = Array.from({ length: 25 }, (_, i) => AGE + i * 1_000);
  const history = corpus(ages, 0);
  const t = task("W1-T101");
  const result = calibrate([t], history, [AGE]);
  const estimate = result.estimates.get("src")!;
  const classFactor = result.context.scoreByClass.get("src")! * estimate.alpha / (estimate.alpha + estimate.beta);
  const probability = result.context.costOfDelayByTaskId!.get(t.id)! / classFactor;
  const prior = 25 / 27;
  assert.ok(Math.abs(probability - (4 + value.DISPATCH_VALUE_PRIOR_WEIGHT * prior) / (5 + value.DISPATCH_VALUE_PRIOR_WEIGHT)) < 1e-12);
  assert.notEqual(probability, 2 * prior / 3, "one stale run is not the neighbourhood's validity share");
});

test("W1-T9038: a one-minute step in nowMs does not reorder same-tier tasks", () => {
  const ages = [-100_000, -50_000, 0, 50_000, 100_000, ...Array.from({ length: 20 }, (_, i) => 1_000_000 + i * 1_000)].map(x => AGE + x);
  const history = corpus(ages, 2);
  const tasks = [task("W1-T102"), task("W1-T101")];
  const a = calibrate(tasks, history, [AGE - 30_000, AGE]);
  const b = calibrate(tasks, history, [AGE - 30_000, AGE], NOW + 60_000);
  assert.deepEqual([...a.context.costOfDelayByTaskId!], [...b.context.costOfDelayByTaskId!]);
  assert.deepEqual(dispatchOrder(tasks, a.context).map(t => t.id), ["W1-T101", "W1-T102"]);
  assert.deepEqual(dispatchOrder(tasks, b.context), dispatchOrder(tasks, a.context));
});

test("W1-T9038: the neighbourhood share is order-independent and includes ties at its edge", () => {
  const samples: Sample[] = [[0, { valid: 1, total: 1 }], [-10, { valid: 1, total: 2 }],
    [10, { valid: 2, total: 2 }], [50, { valid: 0, total: 4 }]];
  const before = JSON.stringify(samples);
  assert.deepEqual(share(samples, 0), { valid: 4, total: 5 });
  assert.deepEqual(share([...samples].reverse(), 0), { valid: 4, total: 5 });
  assert.equal(JSON.stringify(samples), before, "the caller's calibration evidence is not mutated");
});

test("W1-T9038: empty history retains zero evidence and the fleet prior", () => {
  assert.deepEqual(share([], AGE), { valid: 0, total: 0 });
  const history = corpus([AGE], 0);
  history.dates.clear();
  const t = task("W1-T101");
  const result = calibrate([t], history, [AGE]);
  const estimate = result.estimates.get("src")!;
  const expected = 0.5 * result.context.scoreByClass.get("src")! * (estimate.alpha / (estimate.alpha + estimate.beta));
  assert.equal(result.context.costOfDelayByTaskId!.get(t.id), expected);
});

test("W1-T9038: repeated ages count dated runs and preserve the established grouped ranking", () => {
  const samples: Sample[] = [[AGE, { valid: 10, total: 10 }], [AGE * 30, { valid: 0, total: 10 }]];
  assert.deepEqual(share(samples, AGE), { valid: 10, total: 10 });
  assert.deepEqual(share(samples, AGE * 30), { valid: 0, total: 10 });
  assert.deepEqual(share(samples, AGE * 15.5), { valid: 10, total: 20 });
});

test("W1-T9038: the neighbourhood grows with dated-run count rather than a fixed ceiling", () => {
  const samples: Sample[] = Array.from({ length: 81 }, (_, i) => [AGE + i, { valid: i % 2, total: 1 }]);
  assert.deepEqual(share(samples, AGE), { valid: 4, total: 9 });
  assert.deepEqual(share(samples.slice(0, 25), AGE), { valid: 2, total: 5 });
});

test("W1-T9038: invalid age or tally evidence refuses rather than stalling the neighbourhood", () => {
  for (const age of [NaN, Infinity, -Infinity]) assert.throws(() => share([[0, { valid: 1, total: 1 }]], age), RangeError);
  for (const sample of [[NaN, { valid: 1, total: 1 }], [0, { valid: 2, total: 1 }], [0, { valid: 0, total: -1 }],
    [0, { valid: 0, total: 0 }], [0, { valid: 0.5, total: 1 }]] as Sample[]) {
    assert.throws(() => share([sample], 0), RangeError);
  }
});
