import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { loadMounts, mountsPath, resolveMount } from "../src/lib/mounts.js";
import { loadPlan, parseTasksFromYaml, PlanError, TASK_RISKS, TASK_TYPES } from "../src/lib/plan.js";
import { resolveRunMounts } from "../src/run-task.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const INVESTIGATE_FIXTURE = `- id: T-investigate
  title: Investigate a measured failure
  repo: remudero
  depends_on: []
  type: investigate
  verify: auto
  risk: medium
  status: queued
  attempts: 0
`;

test("investigate is a validated task type with a complete shipped mount", () => {
  assert.ok(TASK_TYPES.includes("investigate"));

  const [parsed] = parseTasksFromYaml(INVESTIGATE_FIXTURE, "fixture");
  assert.equal(parsed.type, "investigate");

  const mounts = loadMounts(mountsPath(REPO_ROOT));
  for (const risk of TASK_RISKS) {
    assert.doesNotThrow(() => resolveMount(mounts, parsed.type, risk));
  }

  const resolved = resolveRunMounts(
    REPO_ROOT,
    { type: parsed.type, risk: parsed.risk, files: ["test/example.test.ts"] },
    () => undefined,
  );
  assert.equal(resolved.mount.model, "sonnet");
  assert.equal(resolved.mount.effort, "high");
  assert.equal(resolved.mount.maxTurns, 400);
});

test("any real plan investigate records resolve instead of reaching a fatal mount miss", () => {
  const plan = loadPlan(fileURLToPath(new URL("../plan/tasks.yaml", import.meta.url)));
  const tasks = plan.tasks.filter((task) => task.type === "investigate");

  const mounts = loadMounts(mountsPath(REPO_ROOT));
  for (const task of tasks) {
    assert.doesNotThrow(
      () => resolveMount(mounts, task.type, task.risk),
      `${task.id} must resolve at investigate x ${task.risk}`,
    );
  }
});

test("an undeclared YAML-only task type is refused by the parser before dispatch", () => {
  const yaml = INVESTIGATE_FIXTURE.replace("type: investigate", "type: invented");

  assert.throws(
    () => parseTasksFromYaml(yaml, "fixture"),
    (error: unknown) => error instanceof PlanError && /invalid type 'invented'/.test(error.message),
  );
});
