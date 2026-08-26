/**
 * test/retirement-reaches-its-reader.test.ts — the `retirement` field's only USE and its only
 * CONSUMER must agree, measured against the REAL plan rather than a fixture.
 *
 * W1-T1287 added `Task.retirement` and exactly one reader, `deriveRetiredBlockers`
 * (`src/lib/status-board.ts`), which gates on `t.status === "blocked" && t.retirement !== undefined`.
 * That guard follows `plan.ts`'s own field doc, which scopes the field to a `status: "blocked"`
 * record and states that `isDispatchEligible` (lib/drain.ts), `assertRunnable` (lib/plan.ts) and
 * `isOpenLintTask` (run-task.ts) "read `status` alone and never this field — a task with and
 * without `retirement` filters identically at all three".
 *
 * The one record that carried the field was written at `status: queued`, so it rendered no row and
 * — far worse — stayed dispatchable: `run-W1-T2275-<epoch>` merged as #2923 at 2026-08-26T10:32:04Z,
 * 18h59m after the retirement ruling merged (#2840, 2026-08-25T15:32:41Z). The record was the wrong
 * side, not the reader: widening the guard would have the board announce a retirement the
 * dispatcher is free to ignore, and would change no filter.
 *
 * `test/task-retirement-reason.test.ts` pins the FIELD's behaviour on synthetic tasks. This file
 * pins the invariant that keeps the shipped plan reachable by that behaviour, and is deliberately
 * the only place that reads the real `plan/tasks.yaml` for it.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { loadPlan, type Plan, type Task } from "../src/lib/plan.js";
import { runnableCandidates } from "../src/lib/drain.js";
import { buildStatusBoard, renderStatusBoardText, type StatusBoardDeps } from "../src/lib/status-board.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const NOW_MS = Date.parse("2026-08-26T00:00:00.000Z");

/** The shipped plan, read through the loader rather than a raw YAML parse — the same object every
 *  consumer in `src/` sees. */
function realPlan(): Plan {
  return loadPlan(join(REPO_ROOT, "plan", "tasks.yaml"));
}

function retirementBearing(plan: Plan): Task[] {
  return plan.tasks.filter((t) => t.retirement !== undefined);
}

function tmpRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "retirement-reader-"));
  mkdirSync(join(root, "state"), { recursive: true });
  return root;
}

/** An EMPTY ledger — every other blocker class is a pure ledger read, so this isolates the one
 *  class derived from the plan alone. */
function emptyLedger(): string {
  const p = join(mkdtempSync(join(tmpdir(), "retirement-reader-ledger-")), "ledger.ndjson");
  writeFileSync(p, "");
  return p;
}

function baseDeps(overrides: Partial<StatusBoardDeps> = {}): StatusBoardDeps {
  return {
    queryService: () => ({ running: false, pid: null }),
    repoDir: "/nonexistent/repo/for/tests",
    now: () => NOW_MS,
    resolveOriginMainSha: () => undefined,
    isPidAlive: () => true,
    ...overrides,
  };
}

/** The same plan with `retirement`-bearing tasks forced back to `queued` — the state this file
 *  exists to forbid, used as the DISCRIMINATOR for the rendering assertion below. */
function withRetiredTasksRequeued(plan: Plan): Plan {
  const tasks = plan.tasks.map((t) => (t.retirement === undefined ? t : ({ ...t, status: "queued" } as Task)));
  return { ...plan, tasks, byId: new Map(tasks.map((t) => [t.id, t])) } as Plan;
}

test("every retirement-bearing task in the shipped plan is `status: blocked` — the field's only use must satisfy its only consumer's guard", () => {
  const plan = realPlan();
  const bearing = retirementBearing(plan);

  // POSITIVE CONTROL. The invariant below is vacuously true over an empty set, and a zero here is
  // indistinguishable from a query that cannot see the corpus. If the plan ever legitimately
  // carries no retirement at all, that is an operator ruling to record — not a silent pass.
  assert.ok(plan.tasks.length > 0, "the real plan must load and yield tasks, or nothing below is measuring anything");
  assert.ok(
    bearing.length > 0,
    "the shipped plan carries no `retirement:` at all — the invariant below would pass over an empty set; " +
      "re-derive the corpus before trusting a green here",
  );

  const misSet = bearing.filter((t) => t.status !== "blocked").map((t) => `${t.id} (status: ${t.status})`);
  assert.deepEqual(
    misSet,
    [],
    "a `retirement:` on a non-blocked task is inert: `deriveRetiredBlockers` renders no row for it, and " +
      "dispatch/assertRunnable/isOpenLintTask read `status` alone, so the ruling stops nothing",
  );
});

test("the shipped plan renders a `retired` blocker row for every retirement it declares, naming the recorded reason", () => {
  const plan = realPlan();
  const bearing = retirementBearing(plan);
  const model = buildStatusBoard(tmpRoot(), emptyLedger(), baseDeps({ plan }));

  const rendered = model.blockers.rows.filter((r) => r.kind === "retired").map((r) => r.taskId).sort();
  assert.deepEqual(rendered, bearing.map((t) => t.id).sort(), "every declared retirement reaches the board, and nothing else does");

  const text = renderStatusBoardText(model);
  for (const t of bearing) {
    assert.match(text, new RegExp(`retired\\s+: ${t.id} — \\S`), `the rendered board names ${t.id} with a non-empty reason`);
  }
});

test("DISCRIMINATOR: the same plan with those tasks back at `queued` renders no retired row at all", () => {
  const plan = realPlan();
  const bearing = retirementBearing(plan);
  assert.ok(bearing.length > 0, "control: there is something to re-queue");

  const model = buildStatusBoard(tmpRoot(), emptyLedger(), baseDeps({ plan: withRetiredTasksRequeued(plan) }));
  assert.deepEqual(
    model.blockers.rows.filter((r) => r.kind === "retired"),
    [],
    "the previous test would pass on an over-broad guard too; this is the state that produced no row, so it must stay empty",
  );
});

test("a retirement-bearing task is offered for dispatch at `queued` and never at `blocked` — why the record was corrected, not the reader", () => {
  const plan = realPlan();
  const bearing = retirementBearing(plan);
  const target = bearing[0]!;

  // Only the target task, so the selector's answer is about it and nothing else. Nothing is merged
  // and it declares no dependencies it does not already satisfy in the shipped plan.
  const solo = (status: Task["status"]): Plan => {
    const t = { ...target, status } as Task;
    return { tasks: [t], byId: new Map([[t.id, t]]) } as Plan;
  };

  const atQueued = runnableCandidates(solo("queued"), () => false, 5).map((t) => t.id);
  assert.deepEqual(atQueued, [target.id], "control: with `queued` the retired id IS offered — the retirement field alone stops nothing");

  const atBlocked = runnableCandidates(solo("blocked"), () => false, 5).map((t) => t.id);
  assert.deepEqual(atBlocked, [], "`blocked` is the only field value that carries the ruling into the dispatcher");
});
