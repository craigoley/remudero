/**
 * W1-T13459: the real public plan composes `ok` with an empty ops catalog and with a one-task ops catalog. On any
 * other answer the test names each public record the composer refuses, so a CI failure says which record to fix.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { loadPlan, parseTasksFromYaml, type Plan } from "#src/lib/plan.js";
import { compositionHoldEdge, composeSecondaryPlan } from "#src/lib/task-lookup.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const EMPTY_OPS: Plan = { tasks: [], byId: new Map() };
const ONE_TASK_OPS_TEXT = [
  "- id: W1-T99990001",
  "  title: one-task ops catalog fixture",
  "  repo: remudero",
  "  type: implement",
  "  priority: 1",
  "  depends_on: []",
  "",
].join("\n");
const oneTaskOps = (): Plan => {
  const tasks = parseTasksFromYaml(ONE_TASK_OPS_TEXT, "ops/one-task.yaml");
  return { tasks, byId: new Map(tasks.map(task => [task.id, task])) };
};

const publicPlan = loadPlan(join(REPO_ROOT, "plan", "tasks.yaml"));
const publicIds = new Set(publicPlan.tasks.map(task => task.id));

test("the real public plan composes ok with an empty ops catalog and with a one-task ops catalog", () => {
  for (const [label, ops] of [["empty ops catalog", EMPTY_OPS], ["one-task ops catalog", oneTaskOps()]] as const) {
    const composition = composeSecondaryPlan(publicPlan, ops);
    if (composition.outcome !== "ok") {
      assert.fail(`${label}: composer refused the whole composition (${JSON.stringify(composition)})`);
    }
    const refused = [...composition.held]
      .filter(([id]) => publicIds.has(id))
      .map(([id, hold]) => `${id} (${compositionHoldEdge(hold)})`);
    assert.deepEqual(refused, [], `${label}: composer refuses these public records`);
    // Positive control: the composer really saw the corpus, so an empty refusal list is not an empty read.
    assert.equal(composition.plan.tasks.length, publicPlan.tasks.length - composition.pendingMoveIds.size + ops.tasks.length,
      `${label}: every public and ops record should compose`);
  }
  assert.ok(publicPlan.tasks.length > 0, "the real public plan must hold tasks");
});
