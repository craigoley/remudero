import assert from "node:assert/strict";
import { test } from "node:test";

import type { Task } from "../src/lib/plan.js";
import { lintTask, type LintOpts } from "../src/lib/task-linter.js";

function shard(overrides: Partial<Task> = {}): Task {
  return {
    id: "W1-T4862",
    title: "an unbuilt proof fixture",
    repo: "remudero",
    depends_on: [],
    type: "implement",
    verify: "auto",
    risk: "low",
    status: "queued",
    attempts: 0,
    origin: "architect",
    files: ["src/lib/task-linter.ts", "test/unbuilt-proof.test.ts"],
    acceptance: [{ claim: "the unbuilt behavior works", proof: "unit test: unbuilt behavior works" }],
    ...overrides,
  };
}

const opts: LintOpts = {
  resolveNameFilteredCandidates: () => ({ status: "absent", files: [] }),
  blockedDisposition: { baseTask: shard() },
};

test("W1-T4862: a retired shard with unbuilt test proofs lints clean", () => {
  for (const retirement of ["retired", "closed", "withdrawn"] as const) {
    const result = lintTask(shard({ status: "blocked", retirement }), opts);
    assert.equal(result.ok, true);
    const findings = result.violations.filter((v) => v.check === "proof-unit-test-unresolvable");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "warn");
    assert.match(findings[0].message, /DOWNGRADED/);
    assert.deepEqual(result.violations.filter((v) => v.check === "blocked-task-disposition"), []);
  }
});

test("W1-T4862: a queued shard with an unresolvable test proof is still refused", () => {
  for (const overrides of [{}, { retirement: "retired" as const }]) {
    const result = lintTask(shard(overrides), opts);
    assert.equal(result.ok, false);
    assert.deepEqual(
      result.violations.filter((v) => v.check === "proof-unit-test-unresolvable").map((v) => v.severity),
      ["block"],
    );
  }
});

test("W1-T4862: a blocked shard without a disposition remains refused", () => {
  const result = lintTask(shard({ status: "blocked" }), opts);
  assert.equal(result.ok, false);
  for (const check of ["proof-unit-test-unresolvable", "blocked-task-disposition"]) {
    assert.ok(result.violations.some((v) => v.check === check && v.severity === "block"));
  }
});

test("W1-T4862: a retired shard still needs record provenance", () => {
  const result = lintTask(shard({ status: "blocked", retirement: "retired", origin: "" }), opts);
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((v) => v.check === "provenance" && v.severity === "block"));
});
