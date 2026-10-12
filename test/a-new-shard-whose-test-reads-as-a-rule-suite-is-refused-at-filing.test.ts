import assert from "node:assert/strict";
import { test } from "node:test";

import { RULE_SUITE_NAME_RE } from "../src/lib/ci-parity.js";
import { lintTask, newShardRuleSuiteViolations, type LintOpts } from "../src/lib/task-linter.js";
import type { Task } from "../src/lib/plan.js";

const PATH = "test/x-census.test.ts";
const NEW_SHARD: LintOpts = { riskTransition: { baseTask: undefined } };

function shard(over: Partial<Task> = {}): Task {
  return {
    id: "W1-T9999",
    title: "a shard that files a test",
    repo: "remudero",
    depends_on: [],
    type: "implement",
    verify: "auto",
    risk: "low",
    status: "queued",
    attempts: 0,
    files: ["src/lib/x.ts", PATH],
    acceptance: [{ claim: "x holds", proof: `unit test: ${PATH}` }],
    ...over,
  } as Task;
}

test("test/a-new-shard-whose-test-reads-as-a-rule-suite-is-refused-at-filing.test.ts", async (t) => {
  await t.test("a new shard declaring a census-named test is refused naming the path", () => {
    const [v, ...rest] = newShardRuleSuiteViolations(shard(), NEW_SHARD);
    assert.equal(rest.length, 0);
    assert.equal(v!.check, "new-shard-rule-suite");
    assert.equal(v!.severity, "block");
    assert.ok(v!.message.includes(PATH));
    assert.equal(lintTask(shard(), NEW_SHARD).ok, false);
  });

  await t.test("the path is read from a unit test proof alone when files does not name it", () => {
    const only = shard({ files: ["src/lib/x.ts"] });
    assert.equal(newShardRuleSuiteViolations(only, NEW_SHARD).length, 1);
  });

  await t.test("the changed-tasks pass shape (a post-merge context with no base task) is refused too", () => {
    const ci: LintOpts = {
      postMergeAmendment: { statusResolvable: true, merged: false, baseAcceptance: undefined, baseTask: undefined, followUpFiled: false },
      baseAcceptance: [],
    };
    assert.equal(newShardRuleSuiteViolations(shard(), ci).length, 1);
  });

  await t.test("a reasoned not-a-rule-suite marker in the design passes", () => {
    const design = "the builder copies `@not-a-rule-suite: exercises one function` into the header";
    assert.deepEqual(newShardRuleSuiteViolations(shard({ rationale: design }), NEW_SHARD), []);
    assert.deepEqual(newShardRuleSuiteViolations({ ...shard(), design } as Task, NEW_SHARD), []);
  });

  await t.test("a marker with no reason does not pass", () => {
    assert.equal(newShardRuleSuiteViolations(shard({ rationale: "@not-a-rule-suite:" }), NEW_SHARD).length, 1);
  });

  await t.test("census-precheck in files with the basename beside PRECHECK_PARITY passes", () => {
    const files = ["scripts/census-precheck.mjs", PATH];
    const named = shard({ files, rationale: "add PRECHECK_PARITY row for x-census.test.ts" });
    assert.deepEqual(newShardRuleSuiteViolations(named, NEW_SHARD), []);
    const unnamed = shard({ files, rationale: "add PRECHECK_PARITY rows for other suites" });
    assert.equal(newShardRuleSuiteViolations(unnamed, NEW_SHARD).length, 1);
    const noFile = shard({ rationale: "add PRECHECK_PARITY row for x-census.test.ts" });
    assert.equal(newShardRuleSuiteViolations(noFile, NEW_SHARD).length, 1);
  });

  await t.test("a renamed slug passes", () => {
    const renamed = shard({
      files: ["src/lib/x.ts", "test/x-counts.test.ts"],
      acceptance: [{ claim: "x holds", proof: "unit test: test/x-counts.test.ts" }],
    });
    assert.deepEqual(newShardRuleSuiteViolations(renamed, NEW_SHARD), []);
  });

  await t.test("an unchanged base shard, a path already at base, and a caller with no diff are not refused", () => {
    assert.deepEqual(newShardRuleSuiteViolations(shard(), { riskTransition: { baseTask: shard() } }), []);
    assert.deepEqual(newShardRuleSuiteViolations(shard(), { ...NEW_SHARD, pathExistsAtBase: (p) => p === PATH }), []);
    assert.deepEqual(newShardRuleSuiteViolations(shard(), {}), []);
  });

  await t.test("listRuleSuites' name pattern is the one exported pattern", () => {
    for (const name of ["x-census", "y-ratchet", "z-baseline", "A-CENSUS"]) {
      assert.equal(RULE_SUITE_NAME_RE.test(name), true);
    }
    assert.equal(RULE_SUITE_NAME_RE.test("x-counts"), false);
  });
});
