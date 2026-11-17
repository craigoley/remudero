import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { loadPlan, loadPlanFromYaml, type Plan } from "#src/lib/plan.js";
import { composeSecondaryPlan } from "#src/lib/task-lookup.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

// The real public plan, read once: the composer must accept it beside each ops catalog below.
const publicPlan: Plan = loadPlan(join(REPO_ROOT, "plan", "tasks.yaml"));

const EMPTY_CATALOG = "[]\n";
const ONE_TASK_CATALOG = [
  "- id: OPS-PROBE-T1",
  "  title: a one-task ops catalog probe",
  "  repo: remudero",
  "  type: implement",
  "  priority: 0",
  "  depends_on: []",
  "",
].join("\n");

/**
 * The public records the composer refuses beside `catalog`, named by id. A duplicate names the public record
 * that collides with a catalog id; an invalid cross-catalog dependency names each public record that depends on a
 * catalog id (the composer's own answer carries no list, so the suite derives it from the same two plans).
 */
function refusedPublicRecords(primary: Plan, catalog: Plan): string[] {
  const catalogIds = new Set(catalog.tasks.map(task => task.id));
  return primary.tasks
    .filter(task => catalogIds.has(task.id) || task.depends_on.some(id => catalogIds.has(id)))
    .map(task => task.id);
}

test("the real public plan composes ok with an empty ops catalog", () => {
  const catalog = loadPlanFromYaml(EMPTY_CATALOG, "empty ops catalog");
  const result = composeSecondaryPlan(publicPlan, catalog);
  if (result.outcome !== "ok") {
    assert.fail(`composer refused the empty catalog (${result.outcome}); refused public records: ${refusedPublicRecords(publicPlan, catalog).join(", ") || "none named"}`);
  }
  assert.equal(result.plan.tasks.length, publicPlan.tasks.length);
});

test("the real public plan composes ok with a one-task ops catalog", () => {
  const catalog = loadPlanFromYaml(ONE_TASK_CATALOG, "one-task ops catalog");
  const result = composeSecondaryPlan(publicPlan, catalog);
  if (result.outcome !== "ok") {
    assert.fail(`composer refused the one-task catalog (${result.outcome}); refused public records: ${refusedPublicRecords(publicPlan, catalog).join(", ") || "none named"}`);
  }
  assert.equal(result.plan.tasks.length, publicPlan.tasks.length + 1);
});

test("a catalog task that collides with a public id is refused and the colliding public record is named", () => {
  const collidingId = publicPlan.tasks[0]!.id;
  const catalog = loadPlanFromYaml(ONE_TASK_CATALOG.replace("OPS-PROBE-T1", collidingId), "colliding catalog");
  const result = composeSecondaryPlan(publicPlan, catalog);
  assert.equal(result.outcome, "duplicate_task_id");
  assert.equal(result.taskId, collidingId);
  assert.ok(refusedPublicRecords(publicPlan, catalog).includes(collidingId), "the colliding public record is named");
});

test("a public record that depends on a catalog id is refused and that public record is named", () => {
  const dependent = publicPlan.tasks.find(task => task.depends_on.length === 0)!;
  const tasks = [...publicPlan.tasks, { ...dependent, id: "PUBLIC-DEP-PROBE", depends_on: ["OPS-PROBE-T1"] }];
  const publicWithDependency: Plan = { tasks, byId: new Map(tasks.map(task => [task.id, task])) };
  const catalog = loadPlanFromYaml(ONE_TASK_CATALOG, "one-task catalog");
  const result = composeSecondaryPlan(publicWithDependency, catalog);
  assert.equal(result.outcome, "invalid_cross_catalog_dependency");
  assert.deepEqual(refusedPublicRecords(publicWithDependency, catalog), ["PUBLIC-DEP-PROBE"]);
});
