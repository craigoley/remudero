import assert from "node:assert/strict";
import { test } from "node:test";
// @ts-ignore executable census module has no declaration file.
import { evaluateAdmittedCensusSuites } from "#scripts/census-precheck.mjs";

const REACH = "test/the-affected-suite-reach-ratchet.test.ts";

function evaluate(path: string, head: string | null, base: string | null, fails = false) {
  const runs: string[][] = [];
  const result = evaluateAdmittedCensusSuites({
    changed: [path],
    readHead: (name: string) => name === path ? head : null,
    readBase: (name: string) => name === path ? base : null,
    loadMembers: () => [],
    runSuites: (files: string[]) => {
      runs.push(files);
      return fails && files.includes(REACH) ? [REACH] : [];
    },
  });
  return { result, reachRuns: runs.filter(files => files.includes(REACH)) };
}

test("W1-T10793: check:test:test/the-affected-suite-reach-ratchet.test.ts is prevented, not retried", () => {
  // Removing an isolated suite changes the percentage denominator, even without a new importer.
  const deleted = evaluate("test/isolated.test.ts", null, "export {};", true);
  assert.deepEqual(deleted.reachRuns, [[REACH]], "ask the reach gate once before publication");
  assert.equal(deleted.result.unmeasured, null);
  assert.equal(deleted.result.violations.length, 1);
  assert.match(deleted.result.violations[0], /^census-suite: test\/the-affected-suite-reach-ratchet\.test\.ts fails/);

  for (const path of ["src/isolated.ts", "scripts/isolated.mjs", "bin/isolated.js"]) {
    assert.deepEqual(evaluate(path, null, "export {};").reachRuns, [[REACH]], path);
  }
  // Removing a helper import can detach suites and move the same percentage.
  assert.deepEqual(evaluate("test/helper.ts", "export {};", 'import "#src/lib/isolated.js";').reachRuns, [[REACH]]);
  for (const path of [REACH, "package.json"]) {
    assert.deepEqual(evaluate(path, "changed", "previous").reachRuns, [[REACH]], path);
  }
});

test("reach prevention preserves clean and unrelated edits without retries", () => {
  const clean = evaluate("test/isolated.test.ts", null, "export {};");
  assert.deepEqual(clean.reachRuns, [[REACH]]);
  assert.deepEqual(clean.result, { violations: [], unmeasured: null });
  for (const [path, head, base] of [
    ["docs/isolated.md", null, "prose"],
    ["test/isolated.test.ts", "export const n = 2;", "export const n = 1;"],
    ["test/unchanged.test.ts", 'import "#src/lib/isolated.js";', 'import "#src/lib/isolated.js";'],
  ]) {
    assert.deepEqual(evaluate(path!, head!, base!).reachRuns, [], path!);
  }
});
