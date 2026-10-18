import assert from "node:assert/strict";
import test from "node:test";
import { buildDispatchValueContext, dispatchUrgency } from "../src/lib/dispatch-value.js";
import type { DispatchValueContext } from "../src/lib/dispatch-value.js";
import { dispatchOrder } from "../src/lib/drain.js";
import type { Task } from "../src/lib/plan.js";

const HOUR = 3_600_000;
const NOW = Date.parse("2026-10-17T02:00:00Z");
const task = (id: string, over: Partial<Task> = {}): Task => ({
  id, title: id, repo: "remudero", depends_on: [], files: ["src/a.ts"],
  type: "implement", verify: "auto", risk: "high", status: "queued", attempts: 0, ...over,
});

interface Waiting { task: Task; filedAgo: number }

// Merged history, as in the W1-T9967 file: eight starts outside the plan after 10 h, and P1 starts after 6, 10,
// 24 and 30 h, so the P1 tier's censoring-aware wait is 24 h.
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
  const tasks = [...STARTED.filter(s => s.inPlan).map(s => task(s.id, { priority: 1 })), ...waiting.map(w => w.task)];
  const result = buildDispatchValueContext(tasks, rows, new Set(waiting.map(w => w.task.id)), NOW, true, "seed", {
    planTreeSha: "tree-sha", filedAtByTaskId: filed,
  });
  assert.equal(result.kind, "ready");
  return result.context;
}

/** `length` open dependents of `head`, each depending on the one before (the restructure chain's shape). */
function chain(head: Task, firstId: number, length: number, priority: number | undefined, filedAgo: number): Waiting[] {
  return Array.from({ length }, (_, i) => ({
    task: task(`W1-T${firstId + i}`, { depends_on: [i === 0 ? head.id : `W1-T${firstId + i - 1}`], ...(priority === undefined ? {} : { priority }) }),
    filedAgo,
  }));
}

const withoutDependents = (waiting: readonly Waiting[]): Waiting[] => waiting.map(w => ({ ...w, task: { ...w.task, depends_on: [] } }));
const tiers = (order: readonly Task[]) => order.map(t => t.priority ?? null);

test("W1-T9968: a P2 with 29 open dependents does not outrank a fresh P1", () => {
  // Base: 2^-1 * (1 + log2(1 + 12h/24h)) * (1 + 29) = 23.8x the fresh P1's urgency of 1, so the P2 sorted first.
  const p1 = task("W1-T9926", { priority: 1 });
  const p2 = task("W1-T9874", { priority: 2 });
  const context = calibrate([{ task: p1, filedAgo: 0 }, { task: p2, filedAgo: 12 * HOUR }, ...chain(p2, 7000, 29, 2, 12 * HOUR)]);
  assert.equal(context.openDependentFanoutByTaskId.get(p2.id), 29);
  assert.deepEqual(dispatchOrder([p2, p1], context).map(t => t.id), [p1.id, p2.id]);
  const cod = context.costOfDelayByTaskId!;
  const inputs = context.costOfDelayInputsByTaskId!.get(p2.id)!;
  const expectedValue = Array.from({ length: 29 }, (_, i) =>
    dispatchUrgency(1 + i + 1, 12 * HOUR / inputs.median_wait_ms)).reduce((sum, value) => sum + value, 0);
  assert.equal(inputs.dependent_value, expectedValue, "each P2 wave contributes at its own depth");
  assert.ok(cod.get(p2.id)! > cod.get(p1.id)!, "tier slots keep P1 first even when P2 has a larger weighted score");
});

test("W1-T9968: inside one tier more open dependents still dispatch first", () => {
  const plain = task("W1-T7100", { priority: 2 });
  const head = task("W1-T7101", { priority: 2 });
  for (const headAgo of [12 * HOUR, 11 * HOUR]) {
    const waiting = [{ task: plain, filedAgo: 12 * HOUR }, { task: head, filedAgo: headAgo }, ...chain(head, 7102, 29, 2, headAgo)];
    assert.deepEqual(dispatchOrder([plain, head], calibrate(waiting)).map(t => t.id), [head.id, plain.id], `head filed ${headAgo / HOUR} h ago`);
  }
  // The control: with no dependents, the younger head waits behind the older plain task, so the fan-out moved it.
  const younger = [{ task: plain, filedAgo: 12 * HOUR }, { task: head, filedAgo: 11 * HOUR }, ...chain(head, 7102, 29, 2, 11 * HOUR)];
  assert.deepEqual(dispatchOrder([plain, head], calibrate(withoutDependents(younger))).map(t => t.id), [plain.id, head.id]);
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

test("W1-T9968: dropping every dependent leaves each order slot to the same tier", () => {
  const TIERS = [1, 2, 3, undefined];
  let crossedAtBase = 0, reorderedWithin = 0, checked = 0;
  for (let seed = 1; seed <= 24; seed++) {
    const draw = rng(seed);
    const waiting: Waiting[] = [];
    let next = 8000;
    for (const priority of TIERS) {
      for (let i = 0; i < 4; i++) {
        const ready = task(`W1-T${next++}`, priority === undefined ? {} : { priority });
        const filedAgo = Math.floor(draw() * 60) * HOUR;
        waiting.push({ task: ready, filedAgo });
        // About half the ready tasks head a chain whose blocked members sit in a random tier.
        if (draw() < 0.5) {
          const length = 1 + Math.floor(draw() * 30);
          waiting.push(...chain(ready, next, length, TIERS[Math.floor(draw() * TIERS.length)], Math.floor(draw() * filedAgo / HOUR) * HOUR));
          next += length;
        }
      }
    }
    const open = waiting.map(w => w.task);
    const ready = open.filter(t => t.depends_on.length === 0);
    const withFanout = calibrate(waiting);
    const without = calibrate(withoutDependents(waiting));
    const bare = new Map(withoutDependents(waiting).map(w => [w.task.id, w.task]));
    const strip = (order: readonly Task[]) => order.map(t => bare.get(t.id)!);
    assert.deepEqual(tiers(dispatchOrder(open, withFanout)), tiers(dispatchOrder(strip(open), without)), `seed ${seed}: every open task`);
    const readyOrder = dispatchOrder(ready, withFanout);
    const readyWithout = dispatchOrder(strip(ready), without);
    assert.deepEqual(tiers(readyOrder), tiers(readyWithout), `seed ${seed}: the dispatchable tasks`);
    checked += ready.length;
    if (readyOrder.some((t, i) => t.id !== readyWithout[i].id)) reorderedWithin++;
    // Positive control: ordering by the full product, fan-out included (the base pass), crosses a tier.
    const cod = withFanout.costOfDelayByTaskId!;
    const base = [...ready].sort((a, b) => cod.get(b.id)! - cod.get(a.id)! || (a.id < b.id ? -1 : 1));
    if (tiers(base).some((p, i) => p !== tiers(readyWithout)[i])) crossedAtBase++;
  }
  assert.equal(checked, 24 * 16, "every seed scored its sixteen ready tasks");
  assert.ok(crossedAtBase > 0, "the full fan-out product moves a tier on some queue");
  assert.ok(reorderedWithin > 0, "fan-out still reorders inside a tier on some queue");
});
