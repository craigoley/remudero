import { test } from "node:test";
import assert from "node:assert/strict";
import { derivedFixCommit } from "#src/run-task.js";

test("W1-T7680: fix-lane-commit-refused-no-anchored-commit-message-line-in-the-report clears without a person", () => {
  const d = derivedFixCommit("Add Widget Tests", "https://github.com/o/r/pull/42");
  assert.equal(d?.subject, "fix: repair add widget tests on #42");
  assert.ok(d!.subject.length <= 100);
  // a task-title fallback yields a subject too, so the refusal has nothing left to refuse on
  const long = derivedFixCommit("x".repeat(300), "https://github.com/o/r/pull/7");
  assert.ok(long !== undefined && long.subject.length <= 100);
});
