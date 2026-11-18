import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { loadPlan, mergePlanBlobs } from "#src/lib/plan.js";
import { composeSecondaryPlan } from "#src/lib/task-lookup.js";
import { repoRoot } from "#test/helpers/repo-root.js";

// A CI suite composes the real public plan with an empty ops catalog and with a one-task ops catalog,
// answers ok, and on any other answer names each public record the composer refuses.
test("the real public plan composes with an empty and a one-task ops catalog", () => {
  const publicPlan = loadPlan(join(repoRoot(), "plan", "tasks.yaml"));
  assert.ok(publicPlan.tasks.length > 0, "the real public plan must load with tasks");
  const catalogs: Array<[string, ReturnType<typeof mergePlanBlobs>]> = [
    ["empty ops catalog", mergePlanBlobs([])],
    ["one-task ops catalog", mergePlanBlobs([{
      label: "ops-composition-probe.yaml",
      text: "- id: OPS-COMPOSITION-PROBE-1\n  title: composition probe\n  repo: remudero\n  type: implement\n  priority: 0\n  depends_on: []\n",
    }])],
  ];
  for (const [name, catalog] of catalogs) {
    const result = composeSecondaryPlan(publicPlan, catalog);
    if (result.outcome === "ok") continue;
    const secondaryIds = new Set(catalog.tasks.map(task => task.id));
    const refused = publicPlan.tasks
      .filter(task => secondaryIds.has(task.id) || task.depends_on.some(id => secondaryIds.has(id)))
      .map(task => task.id);
    const duplicate = "taskId" in result && result.taskId !== undefined ? ` duplicate=${result.taskId}` : "";
    assert.fail(`${name} composed as ${result.outcome}${duplicate}; refused public records: ${refused.join(", ") || "(none named)"}`);
  }
});
