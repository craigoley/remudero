// The sweep's diff-coverage reporter feeds the red-base refresh decision. It kept its own parser that
// only recognised a bare `  - path:line`, so a line the gate glosses with ` -- <remedy>` vanished —
// and with it the source path the refresh decision compares against main. It now reads the gate's
// list through the one parser the fix prompt already uses (diffCoverageTargets, #10463).
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
