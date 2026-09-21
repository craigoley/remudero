import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildPlanReconcileCadenceInput, planReconcileCadence } from "../src/lib/measurement-cadence.js";

test("W1-T3970: production measurement cadence supplies plan reconciliation inputs", () => {
  const landed: Array<Array<{ relPath: string; content: string }>> = [];
  const opts = buildPlanReconcileCadenceInput({
    checkoutRoot: "/fixture",
    readShards: () => [
      { taskId: "W1-T1", path: "/fixture/plan/tasks.d/W1-T1.yaml", text: "- id: W1-T1\n  status: queued\n" },
      { taskId: "W1-T2", path: "/fixture/plan/tasks.d/W1-T2.yaml", text: "- id: W1-T2\n  status: queued\n" },
    ],
    creditedMergedIds: () => new Set(["W1-T1"]),
    threshold: 1,
    land: (inputs) => landed.push([...inputs]),
  });
  const report = planReconcileCadence(opts);
  assert.equal(report.status, "landed");
  assert.deepEqual(landed, [[{ relPath: "plan/tasks.d/W1-T1.yaml", content: "- id: W1-T1\n  status: merged\n" }]]);
  assert.deepEqual(report.taskIds, ["W1-T1"]);
});

test("W1-T3970: daemon checkout remains clean", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-plan-reconcile-wiring-"));
  try {
    let landed = false;
    const opts = buildPlanReconcileCadenceInput({
      checkoutRoot: root,
      readShards: () => [{ taskId: "W1-T3", path: join(root, "plan/tasks.d/W1-T3.yaml"), text: "  status: queued\n" }],
      creditedMergedIds: () => new Set(["W1-T3"]),
      threshold: 1,
      land: () => {
        landed = true;
      },
    });
    assert.equal(planReconcileCadence(opts).status, "landed");
    assert.equal(landed, true);
    assert.equal(existsSync(join(root, "plan")), false, "landing must not write the daemon checkout");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
