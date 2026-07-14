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
  unmetDependencies,
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

test("the real plan/tasks.yaml loads; W1-T1 has no deps; W1-T1B gates the rest", () => {
  const plan = loadPlan(join(process.cwd(), "plan", "tasks.yaml"));
  assert.deepEqual(selectTask(plan, "W1-T1").depends_on, []);
  assert.deepEqual(selectTask(plan, "W1-T1B").depends_on, ["W1-T1"]);
  // Every later task depends on the CI gate (self-hosting safety).
  assert.ok(selectTask(plan, "W1-T2").depends_on.includes("W1-T1B"));
});
