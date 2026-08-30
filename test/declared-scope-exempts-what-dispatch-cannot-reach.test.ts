import assert from "node:assert/strict";
import { test } from "node:test";

import { changedTaskIds, declaredScopeViolation, lintPlan, lintTask } from "../src/lib/task-linter.js";
import type { Plan, Task } from "../src/lib/plan.js";

// W1-T2481 — `declaredScopeViolation` (task-linter.ts) blocks any task with an absent or empty
// `files:`, and its own message says the harm lands at the DISPATCHER: an undeclared scope
// "overlaps every co-dispatched candidate at the dispatcher ... serializing the lane". But
// `isDispatchEligible` (drain.ts) refuses `t.status === "blocked"` and returns BEFORE it ever
// reaches `overlappingPaths` — so a blocked record cannot produce that harm by construction, the
// same shape W1-T1030 already fixed for `verify: human`. This file pins that SECOND exemption,
// keyed on `status`, not on `retirement:` (a blocked-and-unscoped tombstone cannot acquire a
// retirement ruling without first tripping the very rule the ruling would exempt it from — the
// rationale's "obvious choice deadlocks" point), and confirms it lapses the instant the record
// becomes dispatchable again, in the SAME run as the exemption itself.

/** A minimal, otherwise-clean Task fixture — mirrors test/declared-scope-unreachable-task.test.ts's
 *  own helper so this file gains no coupling to it (a coverage-load-bearing test lives in its own
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

test("W1-T2481: a blocked task with no declared scope emits no declared-scope violation", () => {
  const t = task({ id: "W1-T2481-BLOCKED", status: "blocked", files: undefined });
  assert.equal(
    declaredScopeViolation(t),
    undefined,
    "isDispatchEligible refuses status:blocked before it ever reaches overlappingPaths, so the " +
      "declared-scope block cannot fire for a record dispatch can never reach",
  );
  const res = lintTask(t);
  assert.ok(
    !res.violations.some((v) => v.check === "declared-scope"),
    "lintTask must not surface a declared-scope violation for a blocked, unscoped task",
  );
});

test("W1-T2481: a dispatchable task with no declared scope still emits it unchanged", () => {
  const t = task({ id: "W1-T2481-DISPATCHABLE", status: "queued", files: undefined });
  const v = declaredScopeViolation(t);
  assert.ok(v, "an unblocked task with no files: must still draw the declared-scope violation");
  assert.equal(v?.check, "declared-scope");
  assert.equal(v?.severity, "block");
  const res = lintTask(t);
  assert.equal(res.ok, false);
  assert.ok(res.violations.some((x) => x.check === "declared-scope"));
});

test("W1-T2481: un-blocking a task makes the violation reappear on the same record", () => {
  const blocked = task({ id: "W1-T2481-REBAND", status: "blocked", files: undefined });
  assert.equal(
    declaredScopeViolation(blocked),
    undefined,
    "exempt while status:blocked — the dispatcher cannot reach it",
  );

  // Un-block it — itself a plan edit, so the SAME record shape re-lints in this SAME run, per
  // rationale (5): "the check moves to when it matters rather than being removed".
  const unblocked: Task = { ...blocked, status: "queued" };
  const v = declaredScopeViolation(unblocked);
  assert.ok(v, "the moment status leaves blocked, the undeclared-scope block must re-apply");
  assert.equal(v?.check, "declared-scope");
  assert.equal(v?.severity, "block");
  const res = lintTask(unblocked);
  assert.equal(res.ok, false);
  assert.ok(res.violations.some((x) => x.check === "declared-scope"));
});

test("W1-T2481: a blocked task that does declare a scope is unaffected in either direction", () => {
  const blockedScoped = task({ id: "W1-T2481-BLOCKED-SCOPED", status: "blocked", files: ["src/lib/plan.ts"] });
  assert.equal(
    declaredScopeViolation(blockedScoped),
    undefined,
    "a declared files: already exempted this task before status was ever consulted",
  );

  const queuedScoped: Task = { ...blockedScoped, status: "queued" };
  assert.equal(
    declaredScopeViolation(queuedScoped),
    undefined,
    "un-blocking a task that already declares a scope changes nothing — the exemption is silent " +
      "for it in both states",
  );
});

test("W1-T2481: editing a tombstone that has no declared scope no longer fails a changed-tasks pass", () => {
  // Models `lintPlanCommand`'s `--base` branch (run-task.ts): the OLD plan snapshot, the NEW
  // (edited) snapshot, `changedTaskIds` scoping the check to what the diff touched, then
  // `lintPlan` re-grading only those ids — exactly what a `--base` CI pass does.
  const before = task({
    id: "W1-T2481-TOMBSTONE",
    status: "blocked",
    files: undefined,
    retirement: undefined,
  });
  // W1-T2474's census marking a retirement ruling is the plan edit that reddened lint-plan pre-fix
  // (rationale: "Measured on #3305 ... 13 failing, all of them this class").
  const after: Task = { ...before, retirement: "retired" };

  const changed = changedTaskIds([before], [after]);
  assert.ok(changed.has("W1-T2481-TOMBSTONE"), "the retirement edit must register as a changed task");

  const plan: Plan = { tasks: [after], byId: new Map([[after.id, after]]) };
  const results = lintPlan(plan);
  const res = results.get("W1-T2481-TOMBSTONE");
  assert.ok(res);
  assert.ok(
    !res!.violations.some((v) => v.check === "declared-scope"),
    "a changed-tasks pass over the edited tombstone must not inherit its pre-existing " +
      "declared-scope violation now that it is exempt",
  );
});

test("W1-T2481: no other linter check changes behaviour for any task in either state", () => {
  const shared = {
    files: ["src/lib/task-linter.ts"],
    acceptance: [{ claim: "does the thing", proof: "unit test test/foo.test.ts asserts the thing" }],
  };
  const blocked = task({ id: "W1-T2481-PARITY", status: "blocked", ...shared });
  const queued: Task = { ...blocked, status: "queued" };

  const blockedChecks = lintTask(blocked).violations.map((v) => v.check).sort();
  const queuedChecks = lintTask(queued).violations.map((v) => v.check).sort();
  assert.deepEqual(
    blockedChecks,
    queuedChecks,
    "with a declared scope present, the exemption never engages, so blocked and unblocked must " +
      "draw identical violation sets from every other check",
  );
});

test("W1-T2481: deleting the exemption restores the failure on the blocked record", () => {
  // Re-derive declaredScopeViolation WITHOUT the status:blocked exemption — the predicate this
  // task adds — to pin that the fix, not some unrelated change, is what makes the first test
  // pass. Mirrors the exemption's own two guard clauses (files present, verify:human) so this
  // stays a faithful "delete just the new line" simulation.
  function withoutStatusExemption(t: Task): boolean {
    if (!(t.files === undefined || t.files.length === 0)) return false;
    if (t.verify === "human") return false;
    return true; // no status:blocked exemption — the pre-fix behaviour
  }
  const blocked = task({ id: "W1-T2481-PREFIX", status: "blocked", files: undefined });
  assert.equal(
    declaredScopeViolation(blocked),
    undefined,
    "sanity: the actual fixed function is exempt for this fixture",
  );
  assert.equal(
    withoutStatusExemption(blocked),
    true,
    "without the status:blocked exemption this fixture would draw the violation — confirming " +
      "the exemption, and not some other change, is what silences it",
  );
});
