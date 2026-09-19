import assert from "node:assert/strict";
import { test } from "node:test";
import { sizingViolation } from "../src/lib/task-linter.js";
import type { Task } from "../src/lib/plan.js";

function task(over: Partial<Task> = {}): Task {
  return {
    id: "W1-T3735",
    title: "retired sizing fixture",
    repo: "remudero",
    depends_on: [],
    type: "implement",
    verify: "auto",
    risk: "medium",
    status: "blocked",
    attempts: 0,
    retirement: "withdrawn",
    files: ["src/lib/daemon.ts", "src/lib/review.ts", "src/lib/sweep.ts"],
    origin: "human",
    acceptance: [],
    ...over,
  } as Task;
}

test("a withdrawn record's sizing violation does not block", () => {
  const violation = sizingViolation(task());
  assert.ok(violation, "the retired record remains observable");
  assert.equal(violation.severity, "warn");
});

test("the downgraded sizing violation names the retirement", () => {
  const violation = sizingViolation(task());
  assert.ok(violation);
  assert.match(violation.message, /retired \(withdrawn\)/);
});

test("a withdrawn record is downgraded while a live record with the same span still blocks", () => {
  const retired = sizingViolation(task());
  assert.ok(retired);
  assert.equal(retired.severity, "warn");

  const violation = sizingViolation(task({ retirement: undefined, status: "queued" }));
  assert.ok(violation);
  assert.equal(violation.severity, "block");
});
