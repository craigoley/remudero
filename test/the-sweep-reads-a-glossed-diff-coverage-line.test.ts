// The sweep's diff-coverage reporter feeds the red-base refresh decision. It reads repository paths
// through the fix prompt's parser and retains absolute checkout paths when CI prints those instead.
import assert from "node:assert/strict";
import { test } from "node:test";

import * as sweep from "../src/lib/sweep.js";

const HEADER =
  "diff-coverage: BLOCKED -- this diff adds source line(s) with zero covering tests, even though the aggregate coverage-ratchet floor may still be satisfied:";

test("a diff-coverage line glossed with a remedy is still reported as uncovered", () => {
  const logTail = [HEADER, "  - src/lib/daemon.ts:1528 -- add a test that throws from afterRow", "  - src/lib/daemon.ts:1530"].join("\n");
  const report = sweep.diffCoverageReport([{ name: "coverage-ratchet", logTail }]);
  assert.deepEqual(report?.uncovered, ["src/lib/daemon.ts:1528", "src/lib/daemon.ts:1530"]);
});

test("a glossed-only diff-coverage red still names its source file to the red-base refresh", () => {
  const logTail = [HEADER, "  - src/lib/daemon-memory-telemetry.ts:277 -- cover the rejected heap read"].join("\n");
  assert.deepEqual(sweep.failingSourceFilesFromCiFailures([{ name: "coverage-ratchet", logTail }]), [
    "src/lib/daemon-memory-telemetry.ts",
  ]);
});

test("an absolute diff-coverage path retains its checkout prefix and gloss", () => {
  const logTail = [HEADER, "  - C:\\workspace\\remudero\\src\\lib\\model-health.ts:47 -- cover the failure arm"].join("\n");
  const failures = [{ name: "coverage-ratchet", logTail }];
  assert.deepEqual(sweep.diffCoverageReport(failures)?.uncovered, [
    "C:\\workspace\\remudero\\src\\lib\\model-health.ts:47",
  ]);
  assert.deepEqual(sweep.failingSourceFilesFromCiFailures(failures), [
    "C:/workspace/remudero/src/lib/model-health.ts",
  ]);
});

test("an absolute path from another checkout does not match a source basename", () => {
  const logTail = [HEADER, "  - /workspace/other/foo.ts:12"].join("\n");
  const failures = [{ name: "coverage-ratchet", logTail }];
  assert.deepEqual(sweep.failingSourceFilesFromCiFailures(failures), ["/workspace/other/foo.ts"]);
  assert.deepEqual(
    sweep.decideRedBaseRefresh(failures, { behindBy: 3, baseChangedFiles: ["src/lib/foo.ts"] }).matchingBaseFiles,
    [],
  );
});
