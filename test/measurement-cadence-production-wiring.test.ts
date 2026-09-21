import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Config } from "../src/lib/config.js";
import { buildPlanReconcileCadenceInput, planReconcileCadence } from "../src/lib/measurement-cadence.js";
import { defaultPlanReconcileCadenceInput } from "../src/run-task.js";

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

const DRIFTED = Array.from({ length: 10 }, (_, i) => `W1-T${i + 1}`);
const driftedShards = (root: string) =>
  DRIFTED.map((taskId) => ({
    taskId,
    path: join(root, "plan", "tasks.d", `${taskId}.yaml`),
    text: `- id: ${taskId}\n  status: queued\n`,
  }));
const CONFIG = { root: "/fixture-state-root" } as Config;

test("W1-T3970: the production supplier lands credited drift through the scratch-index bridge", () => {
  const calls: Array<{ root: string; files: string[]; owner: string | undefined; target: unknown }> = [];
  const opts = defaultPlanReconcileCadenceInput("/fixture", CONFIG, {
    ledgerExists: () => true,
    readShards: () => driftedShards("/fixture"),
    creditedMergedIds: () => new Set(DRIFTED),
    ownerRepo: () => ({ owner: "acme", repo: "engine" }),
    landShards: (root, inputs, landOpts) => {
      calls.push({ root, files: inputs.map((i) => i.relPath), owner: landOpts?.landingOwner, target: landOpts?.targetRepository });
      return { landed: true, files: inputs.map((i) => i.relPath) };
    },
  });
  assert.ok(opts, "a live ledger and a readable projection must produce the cadence input");
  const report = planReconcileCadence(opts);
  assert.equal(report.status, "landed");
  assert.equal(report.drift, 10);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].root, "/fixture");
  assert.deepEqual(calls[0].files, DRIFTED.map((id) => `plan/tasks.d/${id}.yaml`));
  assert.equal(calls[0].owner, "measurement-cadence");
  assert.deepEqual(calls[0].target, { owner: "acme", repo: "engine" });
});

test("W1-T3970: a landing that finds nothing new is a success, a landing error is reported as failed", () => {
  const base = {
    ledgerExists: () => true,
    readShards: () => driftedShards("/fixture"),
    creditedMergedIds: () => new Set(DRIFTED),
    ownerRepo: () => ({ owner: "acme", repo: "engine" }),
  };
  const nothingNew = defaultPlanReconcileCadenceInput("/fixture", CONFIG, {
    ...base,
    landShards: () => ({ landed: false, files: [] }),
  });
  assert.equal(planReconcileCadence(nothingNew!).status, "landed", "already on origin/main is not a failure");

  const broken = defaultPlanReconcileCadenceInput("/fixture", CONFIG, {
    ...base,
    landShards: () => ({ landed: false, files: [], error: "push refused" }),
  });
  const report = planReconcileCadence(broken!);
  assert.equal(report.status, "failed", "an unlanded reconciliation must never read as landed");
  assert.equal(report.error, "push refused");
  assert.equal(report.drift, 10);
});

test("W1-T3970: no live ledger or an unreadable projection skips the rung instead of reporting a zero", () => {
  let read = false;
  const noLedger = defaultPlanReconcileCadenceInput("/fixture", CONFIG, {
    ledgerExists: () => false,
    readShards: () => {
      read = true;
      return [];
    },
  });
  assert.equal(noLedger, undefined);
  assert.equal(read, false, "with no ledger nothing is read, so a fixture root never reaches GitHub");

  const unreadable = defaultPlanReconcileCadenceInput("/fixture", CONFIG, {
    ledgerExists: () => true,
    readShards: () => driftedShards("/fixture"),
    creditedMergedIds: () => {
      throw new Error("gh unavailable");
    },
  });
  assert.equal(unreadable, undefined, "a failed credit read is not evidence of zero drift");
});

test("W1-T3970: a throwing landing seam yields a failed report, never a thrown cadence tick", () => {
  const opts = buildPlanReconcileCadenceInput({
    checkoutRoot: "/fixture",
    readShards: () => driftedShards("/fixture"),
    creditedMergedIds: () => new Set(DRIFTED),
    land: () => {
      throw new Error("gh exploded");
    },
  });
  const report = planReconcileCadence(opts);
  assert.equal(report.status, "failed");
  assert.equal(report.error, "gh exploded");
});

test("W1-T3970: an unresolvable shard id refuses the landing rather than inventing a path", () => {
  const opts = buildPlanReconcileCadenceInput({
    checkoutRoot: "/fixture",
    readShards: () => [{ taskId: "W1-T1", path: "/fixture/plan/tasks.d/W1-T1.yaml", text: "- id: W1-T1\n  status: queued\n" }],
    creditedMergedIds: () => new Set(["W1-T1"]),
    threshold: 1,
    land: () => undefined,
  });
  const orphan = planReconcileCadence({
    ...opts,
    shards: [{ taskId: "W1-T9", text: "- id: W1-T9\n  status: queued\n" }],
    isCreditedMerged: () => true,
  });
  assert.equal(orphan.status, "failed");
  assert.match(orphan.error ?? "", /could not resolve shard W1-T9/);
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
