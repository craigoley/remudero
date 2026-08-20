import assert from "node:assert/strict";
import { test } from "node:test";

import { declaredScopeViolation, lintTask } from "../src/lib/task-linter.js";
import type { Task } from "../src/lib/plan.js";

// W1-T1030 — `declaredScopeViolation` (task-linter.ts) blocks any task with an absent or empty
// `files:`, and its own rationale is entirely about `overlappingPaths` at DISPATCH. But
// `isDispatchEligible` (drain.ts) refuses at `t.verify !== "auto"` BEFORE any path is ever read,
// so a task that is not `verify: auto` never reaches `overlappingPaths` and cannot serialise the
// dispatch lane by an undeclared scope — the rule was judging a path such a task cannot enter.
//
// This file pins the fix's BEHAVIOUR (design (ii)): a task the dispatcher can never reach
// (`verify: human`) is exempt from the declared-scope block; an ordinary dispatchable task
// (`verify: auto`) with no `files:` still blocks; and the exemption lapses the moment `verify`
// reads `auto` again, in the SAME test run as the first criterion (design (iii)).

/** A minimal, otherwise-clean Task fixture — mirrors test/task-linter.test.ts's own helper so
 *  this file gains no coupling to it (house rule: a coverage-load-bearing test lives in its own
 *  file, per this task's plan record). */
function task(over: Partial<Task> & { id: string }): Task {
  return {
    title: over.id,
    repo: "remudero",
    depends_on: [],
    type: "implement",
    verify: "auto",
    risk: "medium",
    status: "queued",
    attempts: 0,
    origin: "architect",
    acceptance: [{ claim: "does the thing", proof: "unit test test/foo.test.ts asserts the thing" }],
    ...over,
  };
}

test("W1-T1030: an unreachable task no longer blocks on an absent files", () => {
  const t = task({ id: "W1-T1030-UNREACHABLE", verify: "human", files: undefined });
  assert.equal(
    declaredScopeViolation(t),
    undefined,
    "a verify:human task never reaches isDispatchEligible's path-reading step, so the " +
      "declared-scope block cannot fire for it",
  );
  const res = lintTask(t);
  assert.ok(
    !res.violations.some((v) => v.check === "declared-scope"),
    "lintTask must not surface a declared-scope violation for a dispatcher-unreachable task",
  );
});

test("W1-T1030: an ordinary dispatchable task still blocks on an absent files", () => {
  const t = task({ id: "W1-T1030-DISPATCHABLE", verify: "auto", files: undefined });
  const v = declaredScopeViolation(t);
  assert.ok(v, "a verify:auto task with no files: must still draw the declared-scope violation");
  assert.equal(v?.check, "declared-scope");
  assert.equal(v?.severity, "block");
  const res = lintTask(t);
  assert.equal(res.ok, false);
  assert.ok(res.violations.some((x) => x.check === "declared-scope"));
});

test("W1-T1030: the exemption lapses when the task becomes dispatchable", () => {
  const human = task({ id: "W1-T1030-REBAND", verify: "human", files: undefined });
  assert.equal(
    declaredScopeViolation(human),
    undefined,
    "exempt while verify:human — dispatcher cannot reach it",
  );

  // Re-band to verify:auto — the sanctioned deriveStatus channel a task record can flip through
  // (rationale (4)): the exemption must lapse on the SAME record shape, in this SAME run, with
  // no separate bookkeeping to fall out of sync.
  const rebanded: Task = { ...human, verify: "auto" };
  const v = declaredScopeViolation(rebanded);
  assert.ok(v, "the moment verify reads auto again, the undeclared-scope block must re-apply");
  assert.equal(v?.check, "declared-scope");
  assert.equal(v?.severity, "block");
  const res = lintTask(rebanded);
  assert.equal(res.ok, false);
  assert.ok(res.violations.some((x) => x.check === "declared-scope"));
});

test("W1-T1030: the exemption predicate matches the dispatcher gate", () => {
  // isDispatchEligible (drain.ts) gates on `t.verify !== "auto"`, not on `t.type`. Pin the
  // exemption to that same field: a `type: manual` task at verify:auto (not a shape that exists
  // in the plan today, per rationale (2)/(3), but not forbidden either) must NOT be exempt,
  // because such a task DOES reach isDispatchEligible's path-reading step.
  const manualButAuto = task({ id: "W1-T1030-MANUAL-AUTO", type: "manual", verify: "auto", files: undefined });
  const v = declaredScopeViolation(manualButAuto);
  assert.ok(
    v,
    "type:manual is a proxy, not the gate isDispatchEligible checks — a manual task at " +
      "verify:auto still reaches the dispatcher's path-reading step and must still block",
  );
  assert.equal(v?.check, "declared-scope");

  // And the converse: an ordinary implement task at verify:human is exempt on the same field,
  // confirming the predicate is verify — not type — in both directions.
  const implementHuman = task({ id: "W1-T1030-IMPLEMENT-HUMAN", type: "implement", verify: "human", files: undefined });
  assert.equal(
    declaredScopeViolation(implementHuman),
    undefined,
    "an implement task at verify:human is equally unreachable by the dispatcher and must be exempt",
  );
});
