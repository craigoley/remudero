import assert from "node:assert/strict";
import test from "node:test";
import { buildDispatchValueContext } from "#src/lib/dispatch-value.js";
import { DEFAULT_LIVENESS_BOUND_MS, orphanedRunIds } from "#src/lib/status.js";
import type { Task } from "#src/lib/plan.js";

const DAY = 86_400_000;
const NOW = Date.parse("2026-10-09T12:00:00Z");
const task = (id: string): Task => ({
  id, title: id, repo: "remudero", depends_on: [], files: ["src/a.ts"],
  type: "implement", verify: "auto", risk: "high", status: "queued", attempts: 0,
});

// A measured src-class history so every open task has a cost and a class score.
const history: Array<Record<string, unknown>> = [];
const filed = new Map<string, number>();
for (let i = 0; i < 12; i++) {
  const id = `W1-T${6000 + i}`;
  filed.set(id, NOW - 3 * DAY);
  history.push({ step: "run.start", task_id: id, run_id: id, task_class: "src", ts: new Date(NOW - DAY).toISOString() });
  history.push({ step: "verdict", task_id: id, run_id: id, verdict: i % 2 === 0 ? "merged" : "no_pr", cost_usd: 2, ts: new Date(NOW - DAY).toISOString() });
}

const T = task("W1-T6300");
const iso = (agoMs: number) => new Date(NOW - agoMs).toISOString();
const start = (runId: string, agoMs: number) => ({ step: "run.start", task_id: T.id, run_id: runId, task_class: "src", ts: iso(agoMs) });
const OLD = DEFAULT_LIVENESS_BOUND_MS + 60_000;
const YOUNG = DEFAULT_LIVENESS_BOUND_MS - 60_000;

function startsFor(extra: Array<Record<string, unknown>>): number {
  filed.set(T.id, NOW - 2 * DAY);
  const result = buildDispatchValueContext([T], [...history, ...extra], new Set([T.id]), NOW, true, "seed", { planTreeSha: "tree", filedAtByTaskId: filed });
  assert.equal(result.kind, "ready");
  if (result.kind !== "ready") throw new Error("not ready");
  return result.context.costOfDelayInputsByTaskId!.get(T.id)!.starts;
}

test("W1-T8166: a proven orphan run spends no stride", () => {
  assert.equal(startsFor([start("orphan", OLD)]), 0);
  // A monitor row about the dead run is not an own row, so it is still an orphan.
  assert.equal(startsFor([start("orphan", OLD), { step: "run.running_long", task_id: T.id, run_id: "orphan", ts: iso(OLD / 2) }]), 0);
});

test("W1-T8166: a verdictless run that did work still spends a stride", () => {
  assert.equal(startsFor([start("worked", OLD), { step: "implement.resumed", task_id: T.id, run_id: "worked", ts: iso(OLD - 1000) }]), 1);
});

test("W1-T8166: a start inside the liveness bound still spends a stride", () => {
  assert.equal(startsFor([start("young", YOUNG)]), 1);
});

test("W1-T8166: the stride and the breaker agree on which runs are orphans", () => {
  const rows = [
    start("orphan-a", OLD), start("orphan-b", 2 * OLD),
    start("monitor-only", OLD), { step: "worker.stalled", task_id: T.id, run_id: "monitor-only", ts: iso(OLD / 2) },
    start("worked", OLD), { step: "implement.resumed", task_id: T.id, run_id: "worked", ts: iso(OLD - 1000) },
    start("young", YOUNG),
  ];
  const orphans = orphanedRunIds([...history, ...rows], T.id, undefined, { nowMs: NOW });
  assert.deepEqual([...orphans].sort(), ["monitor-only", "orphan-a", "orphan-b"]);
  assert.equal(startsFor(rows), 2, "the stride charges exactly the runs the breaker keeps: worked and young");
});
