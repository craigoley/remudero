import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { loadMounts, mountsPath, resolveMount } from "../src/lib/mounts.js";
import { loadPlan, parseTasksFromYaml, PlanError, TASK_TYPES } from "../src/lib/plan.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

function shard(type: string): string {
  return `- id: T-${type}
  title: A task of every declared type
  repo: remudero
  depends_on: []
  type: ${type}
  verify: auto
  risk: medium
  status: queued
  attempts: 0
`;
}

test("W1-T3371: a task type outside the declared union is refused at load, naming shard, field and value", () => {
  // req() only ever checked the field was PRESENT. A present-but-invalid value passed the loader
  // and detonated four days later inside resolveMount, taking the daemon's dispatch loop with it.
  // The fixture is BUILT here rather than string-replaced into a live shard: a replace against a
  // real file silently becomes a no-op the moment that file's type changes, which is exactly how
  // this suite's predecessor went green on main while asserting nothing.
  assert.throws(
    () => parseTasksFromYaml(shard("invented"), "fixture"),
    (error: unknown) =>
      error instanceof PlanError &&
      /T-invented/.test(error.message) &&
      /type/.test(error.message) &&
      /invented/.test(error.message),
    "the refusal must name the shard, the field and the value — the three facts the crash message lacked",
  );
});

test("W1-T3371: every declared task type still loads and resolves a mount, so the refusal discriminates", () => {
  assert.ok(TASK_TYPES.length >= 5, `positive control: the union must be a real population (${TASK_TYPES.length})`);
  const mounts = loadMounts(mountsPath(REPO_ROOT));
  for (const type of TASK_TYPES) {
    const [parsed] = parseTasksFromYaml(shard(type), "fixture");
    assert.equal(parsed.type, type, `${type} must still load`);
    if (type === "manual") continue; // manual is never dispatched, so it carries no route
    assert.doesNotThrow(() => resolveMount(mounts, parsed.type, "medium"), `${type} must resolve a mount`);
  }
});

test("W1-T3371: the committed plan carries no unroutable task type", () => {
  // THE CHECK THAT WOULD HAVE CAUGHT IT ON THE DAY IT WAS FILED. A validator that only ever sees
  // fixtures proves nothing about the tree it ships with.
  const plan = loadPlan(fileURLToPath(new URL("../plan/tasks.yaml", import.meta.url)));
  assert.ok(plan.tasks.length > 100, `positive control: the real plan must load (${plan.tasks.length} tasks)`);
  const mounts = loadMounts(mountsPath(REPO_ROOT));
  for (const task of plan.tasks) {
    if (task.type === "manual") continue;
    assert.doesNotThrow(() => resolveMount(mounts, task.type, task.risk), `${task.id} (${task.type} x ${task.risk})`);
  }
});
