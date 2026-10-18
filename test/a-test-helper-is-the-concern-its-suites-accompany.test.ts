import { strict as assert } from "node:assert";
import { test } from "node:test";
import { checkOneConcern } from "#src/lib/review.js";
import { subsystemsOf } from "#src/lib/task-linter.js";
import type { Task } from "#src/lib/plan.js";

function diffOf(files: string[]): string {
  return files.flatMap((file) => [
    `diff --git a/${file} b/${file}`,
    `+++ b/${file}`,
    "@@",
    "+const changed = true;",
  ]).join("\n");
}

test("a setup helper and its behavior-named suite are one concern", () => {
  const files = ["test/setup/tmp-hygiene.ts", "test/a-test-process-sweeps-only-its-own-claude-scratch-root.test.ts"];
  const verdict = checkOneConcern(diffOf(files));
  assert.equal(verdict.pass, true);
  assert.equal(verdict.reason, "single concern (tmp-hygiene)");
  assert.deepEqual([...subsystemsOf({ files } as Task)], ["tmp-hygiene"]);
});

test("a test helper and its differently named suites are one concern", () => {
  const files = ["test/helpers/captured-console.ts", "test/a-console-claim.test.ts", "test/helpers/a-nested-claim.test.ts"];
  const verdict = checkOneConcern(diffOf(files));
  assert.equal(verdict.pass, true);
  assert.equal(verdict.reason, "single concern (captured-console)");
  assert.deepEqual([...subsystemsOf({ files } as Task)], ["captured-console"]);
});

test("two helpers and two source modules still count as two concerns", () => {
  for (const files of [
    ["test/helpers/one.ts", "test/setup/two.ts", "test/a-behavior.test.ts"],
    ["src/lib/one.ts", "src/lib/two.ts", "test/a-behavior.test.ts"],
  ]) {
    assert.equal(checkOneConcern(diffOf(files)).pass, false);
    assert.deepEqual([...subsystemsOf({ files } as Task)].sort(), ["one", "two"]);
  }
});

test("suite-only diffs still count their own concerns", () => {
  const files = ["test/one.test.ts", "test/two.test.ts"];
  assert.equal(checkOneConcern(diffOf(files)).pass, false);
  assert.deepEqual([...subsystemsOf({ files } as Task)].sort(), ["one", "two"]);
});
