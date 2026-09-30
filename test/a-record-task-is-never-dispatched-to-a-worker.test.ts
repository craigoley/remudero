import assert from "node:assert/strict";
import { test } from "node:test";
import { lintTask, recordOnlyProofViolations } from "../src/lib/task-linter.js";
import type { Task } from "../src/lib/plan.js";

const SHARD = "plan/tasks.d/W1-T9100-a-record-fixture.yaml";

function task(over: Partial<Task> & { id: string }): Task {
  return {
    title: over.id,
    repo: "remudero",
    depends_on: [],
    type: "implement",
    verify: "auto",
    risk: "medium",
    status: "queued",
    attempts: 0,
    origin: "architect",
    sourcePath: SHARD,
    ...over,
  };
}

test("W1-T4818: a verify auto task whose every proof greps its own shard is refused", () => {
  const t = task({
    id: "W1-T9100",
    acceptance: [
      { claim: "the ruling is recorded", proof: `grep: the ruling stands in ${SHARD}` },
      { claim: "the rationale is recorded", proof: `grep: because of the incident in ${SHARD}` },
    ],
  });
  const violations = recordOnlyProofViolations(t);
  assert.equal(violations.length, 1);
  assert.equal(violations[0]!.check, "record-only-proofs");
  assert.equal(violations[0]!.severity, "block");
  assert.match(violations[0]!.message, /verify: human/);
  assert.match(violations[0]!.message, /real proofs/);
  const res = lintTask(t);
  assert.equal(res.ok, false);
  assert.ok(res.violations.some((v) => v.check === "record-only-proofs" && v.severity === "block"));
  // The same shape at verify: human is a record, not a dispatch — admitted.
  assert.deepEqual(recordOnlyProofViolations({ ...t, verify: "human" }), []);
  // A merged record is never refused.
  assert.deepEqual(recordOnlyProofViolations({ ...t, status: "merged" }), []);
});

test("W1-T4818: a task with one proof outside its shard is admitted", () => {
  const t = task({
    id: "W1-T9101",
    acceptance: [
      { claim: "the ruling is recorded", proof: `grep: the ruling stands in ${SHARD}` },
      { claim: "the code does the thing", proof: "grep: export function thing in src/lib/thing.ts" },
    ],
  });
  assert.deepEqual(recordOnlyProofViolations(t), []);
  assert.ok(!lintTask(t).violations.some((v) => v.check === "record-only-proofs"));
  // A task with no sourcePath (hand-built) is silent too.
  const hand = task({
    id: "W1-T9102",
    sourcePath: undefined,
    acceptance: [{ claim: "x", proof: `grep: the ruling stands in ${SHARD}` }],
  });
  assert.deepEqual(recordOnlyProofViolations(hand), []);
});
