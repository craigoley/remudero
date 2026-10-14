import assert from "node:assert/strict";
import test from "node:test";
import { buildDispatchValueContext } from "../src/lib/dispatch-value.js";
import { dispatchOrder } from "../src/lib/drain.js";
import type { Task } from "../src/lib/plan.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-10-14T04:47:21Z");
// The core fleet's measured median wait (filing to first start) on 2026-10-14.
const MEDIAN_WAIT = 9.5 * HOUR;
const task = (id: string, over: Partial<Task> = {}): Task => ({
  id, title: id, repo: "remudero", depends_on: [], files: [`src/${id}.ts`],
  type: "implement", verify: "auto", risk: "high", status: "queued", attempts: 0, ...over,
});

// Every measured task waited exactly one median wait and merged, so age moves urgency only.
const history: Array<Record<string, unknown>> = [];
const historyDates = new Map<string, number>();
for (let i = 0; i < 8; i++) {
  const id = `W1-T${6000 + i}`;
  const startedAt = NOW - 2 * DAY;
  historyDates.set(id, startedAt - MEDIAN_WAIT);
  history.push({ step: "run.start", task_id: id, run_id: id, task_class: "src", ts: new Date(startedAt).toISOString() });
  history.push({ step: "verdict", task_id: id, run_id: id, verdict: "merged", cost_usd: 2, ts: new Date(startedAt + HOUR).toISOString() });
}

function calibrate(tasks: Task[], filedAgo: Record<string, number>) {
  const filed = new Map(historyDates);
  for (const [id, ago] of Object.entries(filedAgo)) filed.set(id, NOW - ago);
  const result = buildDispatchValueContext(tasks, history, new Set(tasks.map(t => t.id)), NOW, true, "seed", {
    planTreeSha: "tree-sha", filedAtByTaskId: filed,
  });
  assert.equal(result.kind, "ready");
  return result.context;
}

test("a three-week-old priority-4 or unprioritized task does not outrank a day-old priority-0.92 or priority-1 task", () => {
  // The 2026-10-14 refills: W1-T3083 (priority 4) and W1-T2858, W1-T2947 (no priority), weeks old, started while
  // W1-T8950 (0.92), W1-T9062 (0.915) and W1-T9374 (1) waited.
  const backlog = task("W1-T3083", { priority: 4 });
  const unprioritized = task("W1-T2858");
  const ranked = task("W1-T8950", { priority: 0.92 });
  const fresh = task("W1-T9374", { priority: 1 });
  const tasks = [backlog, unprioritized, ranked, fresh];
  const context = calibrate(tasks, { [backlog.id]: 21 * DAY, [unprioritized.id]: 21 * DAY, [ranked.id]: DAY, [fresh.id]: DAY });
  const pass = (t: Task) => context.stridePassByTaskId!.get(t.id)!;
  for (const intent of [ranked, fresh]) {
    for (const old of [backlog, unprioritized]) assert.ok(pass(intent) < pass(old), `${intent.id} before ${old.id}`);
  }
  assert.deepEqual(dispatchOrder(tasks, context).map(t => t.id), [ranked.id, fresh.id, backlog.id, unprioritized.id]);
});

test("a starved priority-4 task is held behind a fresh priority-1 task for weeks, then still rises", () => {
  const starved = task("W1-T3083", { priority: 4 });
  const fresh = task("W1-T9374", { priority: 1 });
  const at = (age: number) => dispatchOrder([fresh, starved], calibrate([fresh, starved], { [starved.id]: age, [fresh.id]: 0 }))[0].id;
  assert.equal(at(21 * DAY), fresh.id, "three weeks of waiting does not erase a three-tier gap");
  // 2^3 = 8 urgency units: 1 + log2(1 + waits) reaches 8 at 127 median waits, about 50 days at 9.5 h.
  assert.equal(at(200 * MEDIAN_WAIT), starved.id, "no cap: a long enough wait lifts it");
});

test("an absent priority weighs as one tier below the lowest declared tier, never as a neutral value", () => {
  const top = task("W1-T7001", { priority: 1 });
  const low = task("W1-T7002", { priority: 4 });
  const absent = task("W1-T7003");
  const tasks = [absent, low, top];
  const context = calibrate(tasks, { [top.id]: 3 * DAY, [low.id]: 3 * DAY, [absent.id]: 3 * DAY });
  const score = (t: Task) => context.costOfDelayByTaskId!.get(t.id)!;
  assert.ok(Math.abs(score(low) / score(absent) - 2) < 1e-9, `low/absent ${score(low) / score(absent)}`);
  assert.ok(Math.abs(score(top) / score(low) - 8) < 1e-9, `top/low ${score(top) / score(low)}`);
  assert.deepEqual(dispatchOrder(tasks, context).map(t => t.id), [top.id, low.id, absent.id]);
});

test("a priority just under the queue head buys about six percent, which a longer wait outweighs", () => {
  const minted = task("W1-T7101", { priority: 0.92 });
  const plain = task("W1-T7102", { priority: 1 });
  const same = calibrate([minted, plain], { [minted.id]: DAY, [plain.id]: DAY });
  const ratio = same.costOfDelayByTaskId!.get(minted.id)! / same.costOfDelayByTaskId!.get(plain.id)!;
  assert.ok(Math.abs(ratio - 2 ** 0.08) < 1e-9, `ratio ${ratio}`);
  assert.equal(dispatchOrder([plain, minted], same)[0].id, minted.id, "equal age: the higher priority first");
  const older = calibrate([minted, plain], { [minted.id]: 0, [plain.id]: MEDIAN_WAIT });
  assert.equal(dispatchOrder([minted, plain], older)[0].id, plain.id, "one median wait outweighs the 0.08");
});
