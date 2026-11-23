import assert from "node:assert/strict";
import test from "node:test";
import { buildDispatchValueContext, DISPATCH_VALUE_WINDOW_MS, type DispatchValueContext } from "#src/lib/dispatch-value.js";
import { DEFAULT_LIVENESS_BOUND_MS } from "#src/lib/non-worker-verdict.js";
import type { Task } from "#src/lib/plan.js";

const DAY = 86_400_000;
const NOW = Date.parse("2026-10-09T12:00:00Z");
const task = (id: string): Task => ({
  id, title: id, repo: "remudero", depends_on: [], files: ["src/a.ts"], priority: 1,
  type: "implement", verify: "auto", risk: "high", status: "queued", attempts: 0,
});
const iso = (agoMs: number) => new Date(NOW - agoMs).toISOString();

// A measured src-class history inside the window, so every open task has a cost and a class score.
const history: Array<Record<string, unknown>> = [];
const baseFiled = new Map<string, number>();
for (let i = 0; i < 12; i++) {
  const id = `W1-T${6000 + i}`;
  baseFiled.set(id, NOW - 3 * DAY);
  history.push({ step: "run.start", task_id: id, run_id: id, task_class: "src", ts: iso(DAY) });
  history.push({ step: "verdict", task_id: id, run_id: id, verdict: i % 2 === 0 ? "merged" : "no_pr", cost_usd: 2, ts: iso(DAY) });
}

const STARTED = task("W1-T6300");
const PEER = task("W1-T6301");
const FILED_AGO = 30 * DAY;

/** One run of STARTED: a start, a worker row past it, and the verdict it ended with. */
function run(runId: string, agoMs: number, verdict: Record<string, unknown> = { verdict: "failed", stage: "run.error", reason: "the worker failed" }) {
  return [
    { step: "run.start", task_id: STARTED.id, run_id: runId, task_class: "src", ts: iso(agoMs) },
    { step: "worker.spawn", task_id: STARTED.id, run_id: runId, ts: iso(agoMs - 1000) },
    { step: "verdict", task_id: STARTED.id, run_id: runId, ...verdict, ts: iso(agoMs - 2000) },
  ];
}

function contextFor(extra: Array<Record<string, unknown>>, nowMs = NOW): DispatchValueContext {
  const filed = new Map([...baseFiled, [STARTED.id, NOW - FILED_AGO], [PEER.id, NOW - FILED_AGO]]);
  const result = buildDispatchValueContext([STARTED, PEER], [...history, ...extra], new Set([STARTED.id, PEER.id]), nowMs, true, "seed", {
    planTreeSha: "tree", filedAtByTaskId: filed,
  });
  assert.equal(result.kind, "ready");
  if (result.kind !== "ready") throw new Error("not ready");
  return result.context;
}
const startsOf = (context: DispatchValueContext) => context.costOfDelayInputsByTaskId!.get(STARTED.id)!.starts;
const passRatio = (context: DispatchValueContext) =>
  context.stridePassByTaskId!.get(STARTED.id)! / context.stridePassByTaskId!.get(PEER.id)!;
const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-9 * expected, `${actual} != ${expected}`);

test("W1-T14486 criterion 1: three counted starts 20 days old spend no stride", () => {
  const rows = [...run("old-a", 20 * DAY), ...run("old-b", 20 * DAY - 60_000), ...run("old-c", 20 * DAY - 120_000)];
  const context = contextFor(rows);
  assert.equal(startsOf(context), 0);
  assert.equal(context.costOfDelayInputsByTaskId!.get(PEER.id)!.starts, 0);
  close(passRatio(context), 1);
});

test("W1-T14486 criterion 2: a recent start still spends a stride and the window edge is measured from nowMs", (t) => {
  const recent = contextFor(run("recent", 2 * DAY));
  assert.equal(startsOf(recent), 1);
  close(passRatio(recent), 2);
  assert.equal(startsOf(contextFor(run("edge", DISPATCH_VALUE_WINDOW_MS))), 1);
  assert.equal(startsOf(contextFor(run("past-edge", DISPATCH_VALUE_WINDOW_MS + 1))), 0);
  // The wall clock is far past NOW; the window still reads only the nowMs argument.
  t.mock.method(Date, "now", () => NOW + 999 * DAY);
  assert.equal(startsOf(contextFor(run("recent", 2 * DAY))), 1);
});

test("W1-T14486 criterion 3: the orphan and streak exclusions are unchanged and old starts still feed waits and ages", () => {
  const orphan = [{ step: "run.start", task_id: STARTED.id, run_id: "orphan", task_class: "src", ts: iso(DEFAULT_LIVENESS_BOUND_MS + 60_000) }];
  assert.equal(startsOf(contextFor(orphan)), 0);
  const refused = run("refused", 2 * DAY, { verdict: "failed", stage: "run.error", cause: "push-auth-refused" });
  assert.equal(startsOf(contextFor(refused)), 0);
  assert.equal(startsOf(contextFor(run("own-failure", 2 * DAY))), 1);

  // Outside the window: counted and streak-excluded old runs give the same waits, urgency and score.
  const counted = contextFor([...run("old-a", 20 * DAY), ...run("old-b", 19 * DAY)]);
  const excluded = contextFor([
    ...run("old-a", 20 * DAY, { verdict: "failed", stage: "run.error", cause: "push-auth-refused" }),
    ...run("old-b", 19 * DAY, { verdict: "failed", stage: "run.error", cause: "push-auth-refused" }),
  ]);
  assert.deepEqual(counted.costOfDelayTierWaits, excluded.costOfDelayTierWaits);
  assert.deepEqual([...counted.costOfDelayInputsByTaskId!], [...excluded.costOfDelayInputsByTaskId!]);
  assert.deepEqual([...counted.costOfDelayByTaskId!], [...excluded.costOfDelayByTaskId!]);
  // The old starts are still wait evidence: without them the started task is censored, not an event.
  const unstarted = contextFor([]);
  const events = (context: DispatchValueContext) => context.costOfDelayTierWaits!.reduce((sum, tier) => sum + tier.events, 0);
  assert.equal(events(counted), events(unstarted) + 1);
  assert.notDeepEqual(counted.costOfDelayTierWaits, unstarted.costOfDelayTierWaits);
});
