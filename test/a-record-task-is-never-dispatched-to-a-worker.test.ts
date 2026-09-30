import assert from "node:assert/strict";
import { test } from "node:test";

import { lintTask, recordOnlyAutoViolations } from "../src/lib/task-linter.js";
import type { Task } from "../src/lib/plan.js";

const SHARD = "plan/tasks.d/W1-T2982-record-only.yaml";

function recordTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "W1-T2982",
    title: "Record the operator ruling",
    repo: "remudero",
    depends_on: [],
    type: "implement",
    verify: "auto",
    risk: "high",
    band_meaning: "span",
    status: "queued",
    attempts: 0,
    origin: "operator",
    files: ["src/lib/task-linter.ts"],
    sourcePath: `/checkout/${SHARD}`,
    acceptance: [
      { claim: "the ruling is recorded", proof: `grep: recorded ruling in ${SHARD}` },
      { claim: "the decision is recorded", proof: `grep: recorded decision in ${SHARD}` },
    ],
    ...overrides,
  };
}

test("W1-T4818: a verify auto task whose every proof greps its own shard is refused", () => {
  const task = recordTask();
  const violations = recordOnlyAutoViolations(task);
  assert.equal(violations.length, 1);
  assert.equal(violations[0]?.severity, "block");
  assert.match(violations[0]?.message ?? "", /verify: human/);
  assert.match(violations[0]?.message ?? "", /real proofs/);
  assert.equal(lintTask(task).ok, false, "the real lint entrypoint must refuse the record task");
});

test("W1-T4818: a task with one proof outside its shard is admitted", () => {
  const task = recordTask({
    acceptance: [
      { claim: "the ruling is recorded", proof: `grep: recorded ruling in ${SHARD}` },
      { claim: "the implementation changes", proof: "grep: implementation changed in src/lib/task-linter.ts" },
    ],
  });
  assert.deepEqual(recordOnlyAutoViolations(task), []);
  assert.equal(lintTask(task).ok, true);
});

test("a human-verified record is not blocked by the auto-dispatch rule", () => {
  const task = recordTask({ verify: "human" });
  assert.deepEqual(recordOnlyAutoViolations(task), []);
});
