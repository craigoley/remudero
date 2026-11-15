import assert from "node:assert/strict";
import { test } from "node:test";
import { buildPlanReconcileCadenceInput, planReconcileCadence } from "#src/lib/measurement-cadence.js";
import {
  PLAN_RECONCILE_LANDING_BODY_BUDGET,
  PLAN_RECONCILE_LANDING_FILE_LIMIT,
  planReconcileProofTemplate,
  planReconcilePrBody,
  takePlanReconcileBatch,
} from "#src/lib/plan-reconcile-batch.js";

const GITHUB_BODY_LIMIT = 65_536;
type Landed = { relPath: string; content: string };

/** `count` queued shards W1-T1..W1-T<count>, each at a fixture path; `text` is mutable so a merge can be simulated. */
function shards(count: number) {
  return Array.from({ length: count }, (_, i) => {
    const taskId = `W1-T${i + 1}`;
    return { taskId, path: `/fixture/plan/tasks.d/${taskId}.yaml`, text: `- id: ${taskId}\n  status: queued\n` };
  });
}

/** The cadence over `records`, every one credited, landing through `land`; the lint hold is stubbed clean. */
function cadence(records: ReturnType<typeof shards>, land: (inputs: readonly Landed[]) => void) {
  return planReconcileCadence(buildPlanReconcileCadenceInput({
    checkoutRoot: "/fixture",
    readShards: () => records,
    creditedMergedIds: () => new Set(records.map((r) => r.taskId)),
    threshold: 1,
    lint: () => new Map(),
    land,
  }));
}

test("W1-T11859 criterion 1: a drift over the limit lands one batch, lowest task number first, and a small drift lands whole", () => {
  const handed: Landed[][] = [];
  const report = cadence(shards(200), (inputs) => handed.push([...inputs]));
  assert.equal(report.status, "landed");
  assert.equal(report.drift, 200, "the report still names the whole drift");
  assert.equal(handed.length, 1);
  assert.equal(handed[0].length, PLAN_RECONCILE_LANDING_FILE_LIMIT);
  assert.deepEqual(
    handed[0].map((i) => i.relPath),
    Array.from({ length: PLAN_RECONCILE_LANDING_FILE_LIMIT }, (_, i) => `plan/tasks.d/W1-T${i + 1}.yaml`),
    "numeric order: W1-T2 before W1-T10, never the string order",
  );

  const small: Landed[][] = [];
  cadence(shards(3), (inputs) => small.push([...inputs]));
  assert.deepEqual(small[0].map((i) => i.relPath), ["plan/tasks.d/W1-T1.yaml", "plan/tasks.d/W1-T2.yaml", "plan/tasks.d/W1-T3.yaml"]);
});

test("W1-T11859 criterion 2: a full batch of long paths stays under GitHub's body limit, cut by the budget", () => {
  const longPath = (n: number) => `plan/tasks.d/W1-T${n}-${"x".repeat(160 - `plan/tasks.d/W1-T${n}-.yaml`.length)}.yaml`;
  const items = Array.from({ length: 400 }, (_, i) => ({ taskId: `W1-T${i + 1000}`, file: longPath(i + 1000) }));
  const batch = takePlanReconcileBatch(items, (item) => item.file);
  const body = planReconcilePrBody(batch.map((b) => b.file), planReconcileProofTemplate);
  assert.ok(body.length <= PLAN_RECONCILE_LANDING_BODY_BUDGET, `body ${body.length} within the budget`);
  assert.ok(PLAN_RECONCILE_LANDING_BODY_BUDGET < GITHUB_BODY_LIMIT);
  assert.ok(batch.length < PLAN_RECONCILE_LANDING_FILE_LIMIT, "the budget, not the file limit, cut this batch");
  assert.ok(batch.length > 100, "and it is still a useful batch");

  const huge = [{ taskId: "W1-T5", file: `plan/tasks.d/${"y".repeat(70_000)}.yaml` }];
  assert.equal(takePlanReconcileBatch(huge, (item) => item.file).length, 1, "a drift is never starved by one long path");
});

test("W1-T11859 criterion 3: repeated fires over a 397-shard drift land every shard once, each within the limits", () => {
  const records = shards(397);
  const seen = new Set<string>();
  let fires = 0;
  for (; fires < 10; fires++) {
    const handed: Landed[][] = [];
    const report = cadence(records, (inputs) => handed.push([...inputs]));
    if (report.status === "clear") break;
    assert.equal(handed.length, 1);
    assert.ok(handed[0].length <= PLAN_RECONCILE_LANDING_FILE_LIMIT);
    for (const input of handed[0]) {
      assert.equal(seen.has(input.relPath), false, `${input.relPath} landed once`);
      seen.add(input.relPath);
      const record = records.find((r) => input.relPath.endsWith(`${r.taskId}.yaml`))!;
      record.text = input.content; // the landing merged: the next fire reads this shard as no longer drifted
    }
  }
  assert.ok(PLAN_RECONCILE_LANDING_FILE_LIMIT <= 300, "within GitHub's 300-file review ceiling, whatever the constant says");
  assert.ok(fires > 1, "a 397-shard drift is more than one pull request can hold");
  assert.equal(fires, Math.ceil(397 / PLAN_RECONCILE_LANDING_FILE_LIMIT), "ceil(397 / limit) landing fires, then a clear one");
  assert.equal(seen.size, 397);
});
