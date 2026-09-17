/**
 * test/a-blocked-task-with-no-disposition-is-reported.test.ts — W1-T3686.
 *
 * `blockedRecordUnruledViolations` (W1-T2634) names every `status: blocked` task with no legal
 * `retirement:`, unconditionally, over the whole plan — but it never asks whether `depends_on` is
 * WHY the task is blocked, so an ORDINARILY blocked task (a real, unmet dependency explains it) is
 * reported identically to one parked by NOTHING at all. `blockedWithoutDispositionViolations`
 * (src/lib/task-linter.ts) closes that gap: it fires only when BOTH mechanisms this repo already
 * has for moving a blocked task forward — dispatch's `status: queued` gate, and W1-T1287's
 * `retirement:` unparking — pass through it untouched.
 *
 * This suite proves it against every one of the task record's five acceptance criteria, IN ORDER:
 *
 *   1. a task blocked by nothing (no unmet dependency, no retirement) is reported by name
 *   2. a blocked task with an unmet dependency is not reported
 *   3. a retired blocked task is not reported
 *   4. a prose-only retirement is reported as unreadable, not accepted
 *   5. the rule warns and never refuses
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { loadPlanFromYaml, RETIREMENT_REASONS, type Plan, type Task } from "../src/lib/plan.js";
import { blockedWithoutDispositionViolations, lintPlan, type LintViolation } from "../src/lib/task-linter.js";

// ── shared fixtures (pure, in-memory — no I/O, mirrors the W1-T2634 suite this one sits beside) ─

function task(id: string, over: Partial<Task> = {}): Task {
  return {
    id,
    title: id,
    repo: "remudero",
    depends_on: [],
    type: "implement",
    verify: "auto",
    status: "queued",
    attempts: 0,
    ...over,
  } as never;
}

function planOf(tasks: Task[]): Plan {
  return { tasks, byId: new Map(tasks.map((t) => [t.id, t])) } as never;
}

function checkFor(violations: LintViolation[]): LintViolation[] {
  return violations.filter((v) => v.check === "blocked-without-disposition");
}

// ── ACCEPTANCE 1: a task blocked by nothing is reported by name ────────────────────────────────
// Test name below is the task's own `proof:` string verbatim (minus the "unit test: " prefix) —
// the review floor matches proof to a literal test name, not a paraphrase.

test("a task blocked by nothing is reported by name", () => {
  const t = task("W1-PARKED-BY-NOTHING", { status: "blocked", depends_on: [] });
  const plan = planOf([t]);
  const violations = checkFor(blockedWithoutDispositionViolations(t, plan));
  assert.equal(violations.length, 1);
  assert.equal(violations[0]!.severity, "warn");
  assert.match(violations[0]!.message, /W1-PARKED-BY-NOTHING/);
  assert.match(violations[0]!.message, /retirement/);
});

test("criterion 1b: measured over the LOADED plan (loadPlanFromYaml), matching the four real shards this task names — depends_on: [], status: blocked, no retirement:", () => {
  const yaml = `
- id: W1-YAML-PARKED
  title: "parked by nothing"
  repo: remudero
  depends_on: []
  type: implement
  verify: auto
  status: blocked
  attempts: 0
- id: W1-YAML-QUEUED
  title: "not blocked at all"
  repo: remudero
  depends_on: []
  type: implement
  verify: auto
  status: queued
  attempts: 0
`;
  const plan = loadPlanFromYaml(yaml, "test-fixture");
  const results = lintPlan(plan);
  const named = new Set<string>();
  for (const [id, result] of results) {
    if (checkFor(result.violations).length > 0) named.add(id);
  }
  assert.deepEqual([...named], ["W1-YAML-PARKED"], "only the blocked, unmet-dependency-free, unruled task may be named");
});

// ── ACCEPTANCE 2: a blocked task with an unmet dependency is not reported ───────────────────────
// Test name below is the task's own `proof:` string verbatim (minus the "unit test: " prefix).

test("a blocked task with an unmet dependency is not reported", () => {
  const blocker = task("W1-BLOCKER", { status: "queued" });
  const t = task("W1-ORDINARILY-BLOCKED", { status: "blocked", depends_on: ["W1-BLOCKER"] });
  const plan = planOf([blocker, t]);
  assert.deepEqual(checkFor(blockedWithoutDispositionViolations(t, plan)), [], "a real, unmet dependency must silence the report");
});

test("criterion 2b: a blocked task whose depends_on names a MERGED task IS reported — a satisfied dependency does not explain the block", () => {
  const dep = task("W1-DEP-MERGED", { status: "merged" });
  const t = task("W1-STILL-PARKED", { status: "blocked", depends_on: ["W1-DEP-MERGED"] });
  const plan = planOf([dep, t]);
  assert.equal(checkFor(blockedWithoutDispositionViolations(t, plan)).length, 1, "a merged dependency is MET — it cannot explain the block");
});

test("criterion 2c: a blocked task whose depends_on names a RETIRED task is reported — a retired dependency is excluded, never treated as unmet (mirrors unmetDependencies in plan.ts)", () => {
  const dep = task("W1-DEP-RETIRED", { status: "blocked", retirement: "retired" } as Partial<Task>);
  const t = task("W1-STILL-PARKED-2", { status: "blocked", depends_on: ["W1-DEP-RETIRED"] });
  const plan = planOf([dep, t]);
  assert.equal(checkFor(blockedWithoutDispositionViolations(t, plan)).length, 1, "a retired dependency does not explain the block either");
});

// ── ACCEPTANCE 3: a retired blocked task is not reported ───────────────────────────────────────
// Test name below is the task's own `proof:` string verbatim (minus the "unit test: " prefix).

test("a retired blocked task is not reported", () => {
  assert.deepEqual([...RETIREMENT_REASONS], ["retired", "closed", "withdrawn"], "sanity: exactly three legal values, unchanged");
  for (const reason of RETIREMENT_REASONS) {
    const t = task("W1-RULED", { status: "blocked", retirement: reason, depends_on: [] } as Partial<Task>);
    const plan = planOf([t]);
    assert.deepEqual(checkFor(blockedWithoutDispositionViolations(t, plan)), [], `retirement: ${reason} must pass with zero violations`);
  }
});

// ── ACCEPTANCE 4: a prose-only retirement is reported as unreadable ─────────────────────────────
// Test name below is the task's own `proof:` string verbatim (minus the "unit test: " prefix).

test("a prose-only retirement is reported as unreadable", () => {
  const t = task("W1-PROSE-ONLY", {
    status: "blocked",
    depends_on: [],
    rationale: "RETIREMENT RECORD: this shard is superseded by W1-OTHER, which the operator ruled survives.",
  } as Partial<Task>);
  const plan = planOf([t]);
  const violations = checkFor(blockedWithoutDispositionViolations(t, plan));
  assert.equal(violations.length, 1, "prose alone must never suppress the report — only the structured field may");
  assert.equal(violations[0]!.severity, "warn");
});

test("criterion 4b: the prose-only message reads distinctly as UNREADABLE, not as \"no disposition at all\"", () => {
  const prosed = task("W1-PROSE-ONLY-2", {
    status: "blocked",
    depends_on: [],
    note: "withdrawn by the operator, see rationale for the full ruling",
  } as Partial<Task>);
  const bare = task("W1-BARE", { status: "blocked", depends_on: [] });
  const plan = planOf([prosed, bare]);
  const prosedMessage = checkFor(blockedWithoutDispositionViolations(prosed, plan))[0]!.message;
  const bareMessage = checkFor(blockedWithoutDispositionViolations(bare, plan))[0]!.message;
  assert.match(prosedMessage, /unreadable/i, "a prose-carrying record must say its disposition is unreadable, not absent");
  assert.doesNotMatch(bareMessage, /unreadable/i, "a record with no disposition language at all must not claim one exists");
  assert.notEqual(prosedMessage, bareMessage, "the two cases must produce distinguishable text");
});

// ── ACCEPTANCE 5: the rule warns and never refuses ──────────────────────────────────────────────
// Test name below is the task's own `proof:` string verbatim (minus the "unit test: " prefix).

test("the blocked-without-disposition rule warns and does not refuse", () => {
  const cases: Task[] = [
    task("W1-WARN-1", { status: "blocked", depends_on: [] }),
    task("W1-WARN-2", { status: "blocked", depends_on: [], rationale: "retired per operator note" } as Partial<Task>),
  ];
  const plan = planOf(cases);
  for (const t of cases) {
    for (const v of checkFor(blockedWithoutDispositionViolations(t, plan))) {
      assert.equal(v.severity, "warn", `${t.id} must never be blocking`);
    }
  }
});

test("criterion 5b: lintPlan over a plan whose ONLY violation is this class still reports ok: true for that task", () => {
  const t = task("W1-ONLY-THIS-CHECK", {
    status: "blocked",
    depends_on: [],
    files: ["test/a-blocked-task-with-no-disposition-is-reported.test.ts"],
    origin: "architect",
    acceptance: [
      {
        claim: "the thing holds",
        proof: "unit test: test/a-blocked-task-with-no-disposition-is-reported.test.ts",
      },
    ],
  } as Partial<Task>);
  const plan = planOf([t]);
  const results = lintPlan(plan);
  const result = results.get("W1-ONLY-THIS-CHECK")!;
  const named = checkFor(result.violations);
  assert.equal(named.length, 1, "the violation must actually be present");
  assert.equal(named[0]!.severity, "warn");
  assert.equal(result.ok, true, "a plan whose only violation is this class must never fail the gate");
});
