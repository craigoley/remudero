/**
 * W1-T13459: the real public plan composes `ok` with an empty ops catalog and with a one-task ops catalog. On any
 * other answer the test names each public record the composer refuses, so a CI failure says which record to fix.
 */
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { loadPlanQuarantiningDuplicates, mergePlanBlobs, type Plan, type Task } from "#src/lib/plan.js";
import { composeSecondaryPlan } from "#src/lib/task-lookup.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const EMPTY: Plan = { tasks: [], byId: new Map() };

/**
 * One copy of this suite holds the plan at a time on a Linux host. Composing the whole plan parses it as one document,
 * and flake-screen runs 2 x cores copies of an added suite at once, which ended its CI runner (exit 143). The turn is
 * an abstract socket, so the kernel frees it when the holder exits, however it exits. A host that refuses the socket
 * for any other reason runs without a turn and says so.
 */
async function takePlanTurn(): Promise<void> {
  if (process.platform !== "linux") return;
  for (;;) {
    const server = createServer();
    const refusal = await new Promise<NodeJS.ErrnoException | undefined>(resolve => {
      server.once("error", resolve);
      server.listen("\0rmd-test-W1-T13459-plan-turn", () => resolve(undefined));
    });
    if (refusal === undefined) {
      server.unref();
      return;
    }
    if (refusal.code !== "EADDRINUSE") {
      console.error(`plan turn unavailable, running without it: ${refusal.message}`);
      return;
    }
    await sleep(500);
  }
}

await takePlanTurn();
const loaded = loadPlanQuarantiningDuplicates(join(REPO_ROOT, "plan", "tasks.yaml"));
const publicPlan = loaded.plan;
const shardCount = readdirSync(join(REPO_ROOT, "plan", "tasks.d")).filter(name => name.endsWith(".yaml")).length;

const planOf = (tasks: Task[]): Plan => ({ tasks, byId: new Map(tasks.map(task => [task.id, task])) });

/** The floor: a census over nothing must not pass. */
const floorCheck = (plan: Plan, shards: number): boolean => shards > 0 && plan.tasks.length >= shards;

/** Ids of the public records the composer's record check refuses, found by composing each record alone. */
function refusedRecordIds(plan: Plan): string[] {
  const refused: string[] = [];
  for (const record of plan.tasks) {
    if (composeSecondaryPlan(planOf([record]), EMPTY).outcome !== "ok") refused.push(record.id);
  }
  return refused;
}

function failureMessage(label: string, plan: Plan, composition: { outcome: string }): string {
  return `${label}: composer answered ${composition.outcome}; refused public records: ${refusedRecordIds(plan).join(", ") || "(none found alone)"}`;
}

test("W1-T13459 criterion 1: the real public plan quarantines nothing, holds at least one task per shard, and composes ok with an empty ops plan", () => {
  assert.deepEqual(loaded.quarantined, [], "a quarantined shard must not hide from the composer");
  assert.ok(shardCount > 0, "plan/tasks.d must hold shard files");
  assert.ok(publicPlan.tasks.length >= shardCount, `plan holds ${publicPlan.tasks.length} tasks for ${shardCount} shards`);
  const composition = composeSecondaryPlan(publicPlan, EMPTY);
  assert.equal(composition.outcome, "ok", failureMessage("empty ops plan", publicPlan, composition));
});

test("W1-T13459 criterion 2: a one-task preserve-external ops plan depending on a public id composes ok and is secondary", () => {
  let n = 99990001;
  while (publicPlan.byId.has(`W1-T${n}`)) n++;
  const opsId = `W1-T${n}`;
  const dependency = publicPlan.tasks[0]!.id;
  const text = [
    `- id: ${opsId}`,
    "  title: one-task ops catalog fixture",
    "  repo: remudero",
    "  type: implement",
    "  priority: 1",
    `  depends_on: [${dependency}]`,
    "",
  ].join("\n");
  const ops = mergePlanBlobs([{ label: "ops/one-task.yaml", text }], {}, { dependencyMode: "preserve-external" });
  assert.equal(ops.tasks.length, 1);
  const composition = composeSecondaryPlan(publicPlan, ops);
  assert.equal(composition.outcome, "ok", failureMessage("one-task ops plan", publicPlan, composition));
  if (composition.outcome !== "ok") return;
  assert.ok(composition.secondaryIds.has(opsId), "the ops id must be among the secondary ids");
});

test("W1-T13459 criterion 3: the finder names exactly the record whose verify is a mapping, and the floor refuses an empty plan", () => {
  assert.deepEqual(refusedRecordIds(publicPlan), [], "no real public record may be refused alone");
  const source = publicPlan.tasks[0]!;
  let n = 99990101;
  while (publicPlan.byId.has(`W1-T${n}`)) n++;
  const bad = { ...source, id: `W1-T${n}`, verify: { proof: "x" } } as unknown as Task;
  const copy = planOf([...publicPlan.tasks, bad]);
  assert.deepEqual(refusedRecordIds(copy), [bad.id]);
  assert.equal(floorCheck(EMPTY, shardCount), false, "an empty plan must not pass the floor");
  assert.equal(floorCheck(EMPTY, 0), false);
  assert.equal(floorCheck(publicPlan, shardCount), true);
});
