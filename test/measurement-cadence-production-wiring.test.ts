import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Config } from "../src/lib/config.js";
import { buildPlanReconcileCadenceInput, planReconcileCadence } from "../src/lib/measurement-cadence.js";
import { buildMeasurementCadenceDaemonHooks, defaultPlanReconcileCadenceInput } from "../src/run-task.js";

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

const SHARD_PATH = "/fixture/plan/tasks.d/W1-T9.yaml";
const offlineCoverage = () => ({ status: "refused" as const, reason: "no_coverage_merged_artifact" as const, detail: "offline fixture" });

test("W1-T3970: the production hook runs the reconcile rung from the inputs it is handed", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-plan-reconcile-hook-"));
  try {
    mkdirSync(join(root, "state"), { recursive: true });
    const landed: Array<{ relPath: string; content: string }[]> = [];
    const hooks = buildMeasurementCadenceDaemonHooks({
      config: { root } as Config,
      now: () => new Date("2026-08-25T12:00:00Z"),
      coverageImprovementReader: offlineCoverage,
      planReconcileInput: () =>
        defaultPlanReconcileCadenceInput("/fixture", {
          readShards: () => [{ taskId: "W1-T9", path: SHARD_PATH, text: "- id: W1-T9\n  status: queued\n" }],
          creditedMergedIds: () => new Set(["W1-T9"]),
          land: (inputs) => landed.push([...inputs]),
        }),
    });
    const result = await hooks.runMeasurementCadence();
    assert.deepEqual(result.planReconcile?.taskIds, ["W1-T9"], "a credited queued shard must be found without a human");
    // Default threshold is above one shard: reported, nothing landed — but the rung RAN.
    assert.equal(result.planReconcile?.status, "reported");
    assert.deepEqual(landed, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T3970: a bare hook skips the rung — no credit projection read, no plan PR landed", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-plan-reconcile-bare-"));
  try {
    mkdirSync(join(root, "state"), { recursive: true });
    const hooks = buildMeasurementCadenceDaemonHooks({
      config: { root } as Config,
      now: () => new Date("2026-08-25T12:00:00Z"),
      coverageImprovementReader: offlineCoverage,
    });
    const result = await hooks.runMeasurementCadence();
    assert.equal(result.planReconcile, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T3970: an unreadable credit projection skips the rung instead of reporting zero drift", () => {
  const input = defaultPlanReconcileCadenceInput("/fixture", {
    readShards: () => [{ taskId: "W1-T9", path: SHARD_PATH, text: "- id: W1-T9\n  status: queued\n" }],
    creditedMergedIds: () => {
      throw new Error("gh unavailable");
    },
  });
  assert.equal(input, undefined);
});

test("W1-T3970: an unreadable shard directory skips the rung", () => {
  const input = defaultPlanReconcileCadenceInput("/fixture", {
    readShards: () => {
      throw new Error("ENOENT");
    },
    creditedMergedIds: () => new Set(["W1-T9"]),
  });
  assert.equal(input, undefined);
});

type LandResult = ReturnType<typeof import("../src/lib/feedback-landing.js").landPlanReconcileShards>;

test("W1-T3970: the default landing hands the repo-relative shard to the scratch-index bridge", () => {
  const seen: Array<{ root: string; inputs: Array<{ relPath: string; content: string }> }> = [];
  const input = defaultPlanReconcileCadenceInput("/fixture", {
    readShards: () => [{ taskId: "W1-T9", path: SHARD_PATH, text: "- id: W1-T9\n  status: queued\n" }],
    creditedMergedIds: () => new Set(["W1-T9"]),
    landShards: (root, inputs) => {
      seen.push({ root, inputs: [...inputs] });
      return { landed: true, files: ["plan/tasks.d/W1-T9.yaml"] } as LandResult;
    },
  });
  assert.ok(input);
  const report = planReconcileCadence({ ...input, threshold: 1 });
  assert.equal(report.status, "landed");
  assert.deepEqual(seen, [
    { root: "/fixture", inputs: [{ relPath: "plan/tasks.d/W1-T9.yaml", content: "- id: W1-T9\n  status: merged\n" }] },
  ]);
});

test("W1-T3970: the default landing throws when the bridge lands nothing or errors", () => {
  for (const result of [{ landed: false, files: [] }, { landed: false, files: [], error: "push refused" }]) {
    const input = defaultPlanReconcileCadenceInput("/fixture", {
      readShards: () => [{ taskId: "W1-T9", path: SHARD_PATH, text: "- id: W1-T9\n  status: queued\n" }],
      creditedMergedIds: () => new Set(["W1-T9"]),
      landShards: () => result as LandResult,
    });
    assert.ok(input);
    assert.throws(() => planReconcileCadence({ ...input, threshold: 1 }), /push refused|did not produce a PR/);
  }
});

test("W1-T3970: a landing that produces no PR throws rather than reporting a landed reconciliation", () => {
  const input = defaultPlanReconcileCadenceInput("/fixture", {
    readShards: () => [{ taskId: "W1-T9", path: SHARD_PATH, text: "- id: W1-T9\n  status: queued\n" }],
    creditedMergedIds: () => new Set(["W1-T9"]),
    land: () => {
      throw new Error("plan reconciliation landing did not produce a PR");
    },
  });
  assert.ok(input);
  assert.throws(() => planReconcileCadence({ ...input, threshold: 1 }), /did not produce a PR/);
});
