/**
 * test/a-retired-surface-keeps-no-dispatchable-task.test.ts — W1-T3659.
 *
 * THE DEFECT THIS GUARDS AGAINST: `apps/dashboard` is an unreachable surface — the in-daemon
 * console was retired (remudero-site#36 forwards `/console` to the dedicated Next.js console in
 * craigoley/remudero-console), `RMD_CONSOLE_BUILD_ROOT` is unset, `GET /console/` 404s — yet seven
 * risk:high tasks (W1-T153/156/157/158/159/3177/3296) stayed `status: queued` against it for weeks,
 * because nothing ever checked "does this task's declared scope point at a surface nobody can
 * reach?". They are retired now (`status: blocked` + `retirement: retired`, W1-T1287's mechanism),
 * but that retirement is a hand sweep — it fixes today and nothing else. The NEXT surface this
 * project retires can strand its own tasks the exact same silent way.
 *
 * THE CHECK: walks the REAL plan (plan/tasks.yaml + its plan/tasks.d/*.yaml shards, loaded exactly
 * as the daemon loads it) and asserts that no DISPATCHABLE task — one whose `status` has not been
 * withdrawn (not `blocked`, not a terminal `merged`/`done`) — declares a `files:` entry under a
 * declared unreachable SURFACE (a path prefix, `apps/dashboard`), never a hardcoded list of the
 * seven ids. A check keyed on ids would need a second edit for the next retired surface and say
 * nothing when someone forgets it; a check keyed on the surface catches whatever lands there next.
 *
 * LOAD-BEARING, NOT A SNAPSHOT: the second test proves the check actually reacts to the plan
 * rather than merely agreeing with today's retirement — it takes one of the seven, straight out of
 * the real plan, flips ONLY its `status` back to `queued` (the exact falsifier the task record
 * names: "Return any one of the seven to `status: queued`"), and asserts the same check now catches
 * it — naming both the task id AND the surface, not a bare id.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { loadPlan, type Plan, type Task, type TaskStatus } from "../src/lib/plan.js";

// Loaded VERBATIM from the real, still-open plan (monolith + tasks.d shards) — the same file the
// daemon dispatches from, not a hand-built fixture. Mirrors test/task-linter.test.ts's REAL_PLAN.
const REAL_PLAN = loadPlan(fileURLToPath(new URL("../plan/tasks.yaml", import.meta.url)));

// The declared unreachable surfaces — a list of SURFACES (path prefixes under the repo root),
// never a list of task ids. `apps/dashboard` is the one measured unreachable today (rationale:
// RMD_CONSOLE_BUILD_ROOT unset, GET /console/ 404); a future retirement adds another prefix here,
// not another id somewhere else.
const UNREACHABLE_SURFACES = ["apps/dashboard"] as const;

// A task the fleet will still hand out. `status: blocked` is exactly the withdrawal W1-T1287's
// retirement sweep uses (isDispatchEligible, drain.ts, refuses every `status: "blocked"` task
// before it ever reads a file path); `merged`/`done` are terminal — this check asks the same
// question a fresh dispatch pass would: "would this task's declared scope ever be read again?".
const WITHDRAWN_OR_TERMINAL: ReadonlySet<TaskStatus> = new Set(["blocked", "merged", "done"]);

function isDispatchable(t: Task): boolean {
  return !WITHDRAWN_OR_TERMINAL.has(t.status);
}

function underSurface(file: string, surface: string): boolean {
  return file === surface || file.startsWith(`${surface}/`);
}

interface UnreachableSurfaceViolation {
  taskId: string;
  surface: string;
  file: string;
}

/** The check itself: every dispatchable task's declared `files:` entry that falls under one of
 *  `surfaces`, named by BOTH the task id and the surface it hit — so a caller reporting a
 *  violation names the surface, never only an id. Empty means clean. */
function dispatchableTasksUnderUnreachableSurfaces(
  plan: Plan,
  surfaces: readonly string[] = UNREACHABLE_SURFACES,
): UnreachableSurfaceViolation[] {
  const violations: UnreachableSurfaceViolation[] = [];
  for (const t of plan.tasks) {
    if (!isDispatchable(t)) continue;
    for (const file of t.files ?? []) {
      const surface = surfaces.find((s) => underSurface(file, s));
      if (surface) violations.push({ taskId: t.id, surface, file });
    }
  }
  return violations;
}

test("a retired surface keeps no dispatchable task", () => {
  const violations = dispatchableTasksUnderUnreachableSurfaces(REAL_PLAN);
  assert.deepEqual(
    violations,
    [],
    "no dispatchable task may declare a file under an unreachable surface " +
      `(checked surface(s): ${UNREACHABLE_SURFACES.join(", ")}); found: ` +
      violations.map((v) => `${v.taskId} -> ${v.surface} (${v.file})`).join(", "),
  );
});

test("a task returned to queued against an unreachable surface is caught", () => {
  // Pick one of the seven straight out of the real plan — no fixture, no hardcoded id list on the
  // CHECK's side (UNREACHABLE_SURFACES names only the surface); this id is used only to construct
  // the falsifier scenario, and the assertions below name it back from the CHECK's own output.
  const target = REAL_PLAN.byId.get("W1-T159");
  assert.ok(target, "expected W1-T159 in the real plan — fixture assumption for this falsifier");
  assert.equal(target.status, "blocked", "fixture assumption: W1-T159 is withdrawn at HEAD");
  assert.ok(
    target.files?.some((f) => underSurface(f, "apps/dashboard")),
    "fixture assumption: W1-T159 still declares a file under apps/dashboard",
  );

  // The falsifier the task record names, verbatim: return it to `status: queued` — nothing else.
  // `retirement` is left untouched on purpose: the check must react to `status`, the field
  // isDispatchEligible actually gates on, not require a second field to also change.
  const reopened: Task = { ...target, status: "queued" };
  const mutatedPlan: Plan = {
    tasks: REAL_PLAN.tasks.map((t) => (t.id === reopened.id ? reopened : t)),
    byId: new Map(REAL_PLAN.byId).set(reopened.id, reopened),
  };

  const violations = dispatchableTasksUnderUnreachableSurfaces(mutatedPlan);
  const hit = violations.find((v) => v.taskId === "W1-T159");
  assert.ok(
    hit,
    "reopening a retired task against the declared unreachable surface must be caught, naming " +
      "that id and the surface — the check is load-bearing, not a snapshot of today's plan",
  );
  assert.equal(hit?.surface, "apps/dashboard", "the violation names the SURFACE, not only the id");

  // And the original, unmutated REAL_PLAN load stays clean — mutating a derived plan object never
  // touches the loader's own return value, so the first test's result cannot leak from this one.
  assert.deepEqual(dispatchableTasksUnderUnreachableSurfaces(REAL_PLAN), []);
});
