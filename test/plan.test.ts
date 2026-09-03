import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  assertRunnable,
  loadPlan,
  PlanError,
  selectTask,
  TASK_STATUSES,
  transitiveDependents,
  unmetDependencies,
  visibleCriteria,
} from "../src/lib/plan.js";

function planFile(yaml: string): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-plan-"));
  const p = join(dir, "tasks.yaml");
  writeFileSync(p, yaml);
  return p;
}

const YAML = `
- id: A
  title: first
  repo: remudero-sandbox
  depends_on: []
  type: implement
  verify: auto
  status: merged
  attempts: 0
- id: B
  title: second
  repo: remudero
  depends_on: [A]
  type: implement
  verify: auto
  status: queued
  attempts: 0
- id: C
  title: third
  repo: remudero
  depends_on: [B]
  type: implement
  verify: auto
  status: queued
  attempts: 0
`;

test("loads and indexes tasks", () => {
  const plan = loadPlan(planFile(YAML));
  assert.equal(plan.tasks.length, 3);
  assert.equal(selectTask(plan, "B").title, "second");
});

test("B is runnable (dep A merged); C is not (dep B queued)", () => {
  const plan = loadPlan(planFile(YAML));
  assert.deepEqual(unmetDependencies(plan, selectTask(plan, "B")), []);
  assert.deepEqual(unmetDependencies(plan, selectTask(plan, "C")), ["B"]);
  assert.doesNotThrow(() => assertRunnable(plan, selectTask(plan, "B")));
  assert.throws(() => assertRunnable(plan, selectTask(plan, "C")), PlanError);
});

test("rejects a dependency on an unknown task", () => {
  const bad = `
- id: X
  title: x
  repo: r
  depends_on: [NOPE]
  type: implement
  verify: auto
  status: queued
  attempts: 0
`;
  assert.throws(() => loadPlan(planFile(bad)), PlanError);
});

// ── W1-T2639: the status arm must TEACH the permitted vocabulary, like its
// risk/retirement siblings, instead of just refusing.

test("rejects an out-of-vocabulary status, naming every member of TASK_STATUSES", () => {
  const bad = `
- id: S
  title: s
  repo: r
  depends_on: []
  type: implement
  verify: auto
  status: shipped
  attempts: 0
`;
  assert.throws(() => loadPlan(planFile(bad)), (err: unknown) => {
    assert.ok(err instanceof PlanError);
    assert.match(err.message, /invalid status 'shipped'/);
    for (const s of TASK_STATUSES) {
      assert.ok(err.message.includes(s), `expected message to name '${s}': ${err.message}`);
    }
    return true;
  });
});

test("status vocabulary is unchanged: 'shipped' stays illegal and 'merged'/'done' remain the only merged-meaning members", () => {
  assert.ok(!(TASK_STATUSES as readonly string[]).includes("shipped"));
  assert.deepEqual([...TASK_STATUSES], [
    "queued",
    "recon",
    "prompted",
    "running",
    "review",
    "fixing",
    "diagnosing",
    "blocked",
    "merged",
    "done",
  ]);
});

test("rejects verify:human as not auto-runnable", () => {
  const y = `
- id: H
  title: h
  repo: r
  depends_on: []
  type: implement
  verify: human
  status: queued
  attempts: 0
`;
  const plan = loadPlan(planFile(y));
  assert.throws(() => assertRunnable(plan, selectTask(plan, "H")), PlanError);
});

// ── transitiveDependents (W1-T46 block-reasoning: does anything need this
// task to exist at all?) — A -> B -> C chain.

test("transitiveDependents: C (a leaf, nothing depends on it) is EMPTY — self-contained", () => {
  const plan = loadPlan(planFile(YAML));
  assert.deepEqual(transitiveDependents(plan, "C"), new Set());
});

test("transitiveDependents: B's only direct dependent is C", () => {
  const plan = loadPlan(planFile(YAML));
  assert.deepEqual(transitiveDependents(plan, "B"), new Set(["C"]));
});

test("transitiveDependents: A's transitive dependents are B AND C (through the chain)", () => {
  const plan = loadPlan(planFile(YAML));
  assert.deepEqual(transitiveDependents(plan, "A"), new Set(["B", "C"]));
});

test("transitiveDependents: an id with no declared tasks depending on it at all (unknown/isolated) is EMPTY", () => {
  const plan = loadPlan(planFile(YAML));
  assert.deepEqual(transitiveDependents(plan, "NOPE"), new Set());
});

test("the real plan/tasks.yaml loads; W1-T1 has no deps; W1-T1B gates the rest", () => {
  const plan = loadPlan(join(process.cwd(), "plan", "tasks.yaml"));
  assert.deepEqual(selectTask(plan, "W1-T1").depends_on, []);
  assert.deepEqual(selectTask(plan, "W1-T1B").depends_on, ["W1-T1"]);
  // Every later task depends on the CI gate (self-hosting safety).
  assert.ok(selectTask(plan, "W1-T2").depends_on.includes("W1-T1B"));
});

// ── W1-T166: holdout acceptance criteria ────────────────────────────────────

const YAML_WITH_HOLDOUT = `
- id: H
  title: has a holdout criterion
  repo: remudero
  depends_on: []
  type: implement
  verify: auto
  status: queued
  attempts: 0
  acceptance:
    - claim: "the ordinary criterion is visible"
      proof: "grep: ORDINARY_MARKER in src/x.ts"
    - claim: "HOLDOUT-SECRET-CLAIM-never-shown"
      proof: "HOLDOUT-SECRET-PROOF-never-shown"
      holdout: true
`;

test("a task's acceptance criteria carry `holdout: true` through YAML parsing unchanged", () => {
  const plan = loadPlan(planFile(YAML_WITH_HOLDOUT));
  const criteria = selectTask(plan, "H").acceptance ?? [];
  assert.equal(criteria.length, 2);
  assert.equal(criteria[0].holdout, undefined, "an ordinary criterion has no holdout flag");
  assert.equal(criteria[1].holdout, true);
});

test("visibleCriteria: filters out every holdout:true entry, keeping ordinary ones — the single choke point every worker-facing prompt assembler routes through", () => {
  const plan = loadPlan(planFile(YAML_WITH_HOLDOUT));
  const criteria = selectTask(plan, "H").acceptance ?? [];
  const visible = visibleCriteria(criteria);
  assert.deepEqual(
    visible.map((c) => c.claim),
    ["the ordinary criterion is visible"],
  );
});

test("visibleCriteria: a task with no declared criteria at all yields [] (never throws)", () => {
  assert.deepEqual(visibleCriteria([]), []);
});

test("visibleCriteria: generic over anything carrying an optional `holdout` flag (e.g. lib/review.ts's CriterionVerdict, not just AcceptanceCriterion)", () => {
  const verdictLike = [
    { claim: "a", met: true, holdout: false },
    { claim: "b", met: false, holdout: true },
  ];
  assert.deepEqual(
    visibleCriteria(verdictLike).map((c) => c.claim),
    ["a"],
  );
});
