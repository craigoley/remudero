// A machine-filed shard is named lowercase (`w1-t7090-selector-shadow-miss.yaml`) while the task
// id is upper-case. Every shard-by-id lookup used a case-sensitive `${taskId}-` prefix, so the
// fix lane's scope amendment for W1-T7090 was refused `shard-not-found` on #10369 (15:34Z).
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { makeTempDir } from "../src/lib/tmp.js";

const TASK_ID = "W1-T9090";
const LOWER_SHARD = "w1-t9090-a-machine-filed-shard.yaml";

function planWithLowercaseShard(): string {
  const dir = makeTempDir("lowercase-shard");
  mkdirSync(join(dir, "plan", "tasks.d"), { recursive: true });
  writeFileSync(join(dir, "plan", "tasks.yaml"), "[]\n");
  writeFileSync(join(dir, "plan", "tasks.d", LOWER_SHARD), `- id: ${TASK_ID}\n  title: a machine-filed task\n`);
  return dir;
}

test("the scope and proof amendment lookup finds a lowercase machine-filed shard by its task id", async () => {
  const dir = planWithLowercaseShard();
  try {
    const amendment = await import("../src/lib/proof-amendment.js");
    const found = amendment.findTaskShard(dir, TASK_ID);
    assert.ok(found, "a lowercase shard must not read as shard-not-found");
    assert.equal(found.path, `plan/tasks.d/${LOWER_SHARD}`);
    assert.match(found.text, /id: W1-T9090/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the refusal amendment lookup finds a lowercase machine-filed shard by its task id", async () => {
  const dir = planWithLowercaseShard();
  try {
    const refusal = await import("../src/lib/refusal-amendment.js");
    const found = refusal.readTaskShard(dir, TASK_ID);
    assert.ok(found, "a lowercase shard must be found, not fall through to the monolith");
    assert.equal(found.relPath, `plan/tasks.d/${LOWER_SHARD}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a diff adding a lowercase machine-filed shard contributes that task's shard", async () => {
  const emitter = await import("../src/lib/plan-pr-emitter.js");
  assert.equal(emitter.diffContributesTaskShard(TASK_ID, [`plan/tasks.d/${LOWER_SHARD}`]), true);
  assert.equal(emitter.diffContributesTaskShard("W1-T9091", [`plan/tasks.d/${LOWER_SHARD}`]), false, "a different id still does not match");
});
