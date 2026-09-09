import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadPlan, taskRecordPath } from "../src/lib/plan.js";

/**
 * test/task-record-path-is-constant-time.test.ts — W1-T2920.
 *
 * `taskRecordPath` used to answer "which file holds task X" by re-reading and re-parsing the
 * monolith, then every shard in directory order, until one contained the id — 866 ms worst case
 * over 1,078 shards, once per dispatch prompt, because the `Task` a shard's own parse produced
 * carried no memory of which file it came from.
 *
 * THE FIX: `parseTasksFromYaml` now stamps every `Task` with `sourcePath` (the file it was parsed
 * from), and `taskRecordPath` takes an optional already-loaded `Plan` — when given, the answer is
 * a `Map.get` against that stamp, never a file read.
 *
 * THE FALSIFIER IS A READ COUNT, NEVER WALL-CLOCK (R-45): this test proves the fast path performs
 * ZERO file reads by handing `taskRecordPath` a recording `TaskRecordPathIO` that throws if either
 * of its methods is ever invoked, then asserting the lookup still resolves correctly. If the fast
 * path ever regressed to touching the filesystem again, this test would fail on the very first
 * read rather than merely running slower.
 */

const SHARD_COUNT = 400;

function shardYaml(id: string): string {
  return [
    `- id: ${id}`,
    "  title: t",
    "  repo: remudero",
    "  type: implement",
    "  verify: auto",
    "  risk: low",
    "  status: queued",
    "",
  ].join("\n");
}

function bigPlanFixture(): { planPath: string; shardDir: string; lastId: string; lastShardPath: string } {
  const root = mkdtempSync(join(tmpdir(), "rmd-task-record-path-const-time-"));
  const planPath = join(root, "tasks.yaml");
  writeFileSync(planPath, "[]\n");
  const shardDir = join(root, "tasks.d");
  mkdirSync(shardDir, { recursive: true });

  let lastId = "";
  let lastShardPath = "";
  for (let i = 0; i < SHARD_COUNT; i++) {
    // Zero-padded so directory-listing order (what the OLD walk relied on) puts this LAST —
    // the worst case the old implementation ever paid: every earlier shard parsed before it.
    const id = `W1-T${String(i).padStart(5, "0")}`;
    const shardPath = join(shardDir, `${id}-shard.yaml`);
    writeFileSync(shardPath, shardYaml(id));
    lastId = id;
    lastShardPath = shardPath;
  }
  return { planPath, shardDir, lastId, lastShardPath };
}

/** A `TaskRecordPathIO` that throws the moment either primitive is called — the strongest
 *  possible "zero file reads" assertion: a mere call COUNT could still pass at 1, this fails
 *  the test outright the instant the fast path so much as glances at the filesystem. */
function poisonedIo(): { readFile: (p: string) => string; listShardFiles: (p: string) => string[] } {
  return {
    readFile: (p: string) => {
      throw new Error(`fast path must never call readFile, but it read ${p}`);
    },
    listShardFiles: (p: string) => {
      throw new Error(`fast path must never call listShardFiles, but it listed ${p}`);
    },
  };
}

test("taskRecordPath performs zero file reads once a Plan is already loaded", () => {
  const { planPath, lastId, lastShardPath } = bigPlanFixture();
  const plan = loadPlan(planPath); // one real load, exactly like a dispatch tick's own

  const resolved = taskRecordPath(planPath, lastId, plan, poisonedIo());
  assert.equal(resolved, lastShardPath, "the LAST shard in directory order — the old walk's worst case");
});

test("taskRecordPath with a loaded Plan returns undefined for an id no shard declares — still zero reads", () => {
  const { planPath } = bigPlanFixture();
  const plan = loadPlan(planPath);

  assert.equal(taskRecordPath(planPath, "W1-T-NOWHERE", plan, poisonedIo()), undefined);
});

test("every task's sourcePath points at the file that declares it", () => {
  const { planPath, shardDir } = bigPlanFixture();
  const plan = loadPlan(planPath);

  assert.equal(plan.tasks.length, SHARD_COUNT);
  for (const t of plan.tasks) {
    assert.equal(t.sourcePath, join(shardDir, `${t.id}-shard.yaml`), `${t.id} must name its own shard`);
  }
});

test("a task declared in the monolith gets the monolith as its sourcePath", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-task-record-path-const-time-monolith-"));
  const planPath = join(root, "tasks.yaml");
  writeFileSync(planPath, shardYaml("T-IN-MONOLITH"));

  const plan = loadPlan(planPath);
  assert.equal(plan.byId.get("T-IN-MONOLITH")?.sourcePath, planPath);
  // And the constant-time lookup agrees with it, still with zero reads.
  assert.equal(taskRecordPath(planPath, "T-IN-MONOLITH", plan, poisonedIo()), planPath);
});

test("omitting the Plan argument still falls back to the walk-and-parse behaviour", () => {
  // Backward compatibility: a caller with no loaded Plan handy (e.g. naming a plan file it has
  // not itself loaded) gets exactly the pre-W1-T2920 answer, unpoisoned IO included.
  const { planPath, lastId, lastShardPath } = bigPlanFixture();
  assert.equal(taskRecordPath(planPath, lastId), lastShardPath);
});
