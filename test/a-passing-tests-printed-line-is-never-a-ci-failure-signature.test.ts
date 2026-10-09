import assert from "node:assert/strict";
import { test } from "node:test";

import * as gardener from "../src/lib/ci-friction-gardener.js";

// #10392 (2026-10-09): fix rounds were handed the fixture lines a PASSING test prints on purpose as
// their failure signature, answered FLAKE, and spent a strike. A test runner's log names its failure
// only through its own markers.
const job = "coverage-shard (3/8)\tTest\t";
const at = (n: number) => `2026-10-09T19:12:0${n}.0000000Z `;

test("a passing test's printed failure-looking line never becomes the shard's signature", () => {
  const tail = [
    `${job}${at(1)}# Subtest: test/a-worktree-is-materialized.test.ts`,
    `${job}${at(2)}(worktree materialization failed [test] fixture: expected refusal)`,
    `${job}${at(3)}node_modules lockfile mismatch: worktree /tmp/x/worktrees/run-W1-T1-1 was cut from origin/main and refused`,
    `${job}${at(4)}ok 1 - test/a-worktree-is-materialized.test.ts`,
    `${job}${at(5)}# tests 1`,
    `${job}${at(6)}# pass 1`,
    `${job}${at(7)}# fail 0`,
  ].join("\n");
  assert.equal(gardener.ciFailureSignature(tail), gardener.RED_WITH_NO_FAILING_TEST);
});

test("a runner's not ok names the failing test file even when noise precedes it", () => {
  const tail = [
    `${job}${at(1)}(worktree materialization failed [test] fixture: expected refusal)`,
    `${job}${at(2)}ok 1 - test/a-worktree-is-materialized.test.ts`,
    `${job}${at(3)}not ok 2 - test/the-sweep-walks-oldest-first.test.ts`,
    `${job}${at(4)}# fail 1`,
  ].join("\n");
  assert.equal(gardener.ciFailureSignature(tail), "test/the-sweep-walks-oldest-first.test.ts");
});

test("a truncated coverage report is the shard's signature, not an unnamed flake", () => {
  const tail = [
    `${job}${at(1)}ok 1 - test/a.test.ts`,
    `${job}${at(2)}# fail 0`,
    `${job}${at(3)}COVERAGE-REPORT-FAILED: coverage-1-2.json bytes=4096 pid=77 (Unexpected end of JSON input)`,
  ].join("\n");
  assert.equal(gardener.ciFailureSignature(tail), "COVERAGE-REPORT-FAILED: coverage-N-N.json bytes=N pid=N (Unexpected end of JSON input)");
});

test("a log that is no test runner's keeps its first failure line", () => {
  assert.equal(gardener.ciFailureSignature("2026-09-29T13:05:00.1Z Error: census abc1234def refused 12 rows"), "Error: census  refused N rows");
  assert.equal(gardener.ciFailureSignature("all green"), undefined);
});
