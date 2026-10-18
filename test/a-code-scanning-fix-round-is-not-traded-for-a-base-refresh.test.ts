import assert from "node:assert/strict";
import { test } from "node:test";

import { codeqlBlockerCiFailure, codeScanningFixCiFailures, decideRedBaseRefresh } from "#src/lib/sweep.js";

// 2026-10-17, #12570 (W1-T9928): the code-scanning fix round for alert #429 reached the fix rung at
// 14:25Z behind main by 18, main having changed only two scripts/ files. The alert red read as
// fileless, W1-T8038's harness rule matched those files, and main was merged instead of the worker run.
const alert429 = {
  alertNumber: 429,
  ruleId: "js/file-system-race",
  severity: "high",
  path: "src/lib/test-slot-mutation.ts",
  line: 239,
  message: "The file may have changed since it was checked.",
};
const harnessOnlyMain = ["scripts/census-precheck.mjs", "scripts/fixture-copy-census.mjs"];

test("W1-T10065: an alert red is not refreshed on a harness-only main change", () => {
  const decision = decideRedBaseRefresh(codeScanningFixCiFailures([alert429], "a real race"), {
    behindBy: 18,
    baseChangedFiles: harnessOnlyMain,
  });
  assert.equal(decision.refresh, false, "merging main cannot clear an alert in a file main did not touch");
  assert.deepEqual(decision.matchingBaseFiles, []);
  assert.deepEqual(decision.failingSourceFiles, ["src/lib/test-slot-mutation.ts"], "the ledger row names the alert's file");

  // The review-thread blocker builds the same alert shape and takes the same path.
  const blocker = decideRedBaseRefresh([codeqlBlockerCiFailure({ ...alert429, alertNumber: 430 })], {
    behindBy: 18,
    baseChangedFiles: harnessOnlyMain,
  });
  assert.equal(blocker.refresh, false);
  assert.deepEqual(blocker.failingSourceFiles, ["src/lib/test-slot-mutation.ts"]);

  // A location line in an ordinary job's log is not an alert: only the alert's own name admits it.
  const impostor = decideRedBaseRefresh([{ name: "Scan", logTail: "location: src/lib/test-slot-mutation.ts:239" }], {
    behindBy: 18,
    baseChangedFiles: harnessOnlyMain,
  });
  assert.deepEqual(impostor.failingSourceFiles, []);
  assert.equal(impostor.refresh, true, "a fileless non-alert red keeps W1-T8038's harness rule");
});

test("W1-T10065: an alert red is refreshed when main changed its file", () => {
  const decision = decideRedBaseRefresh(codeScanningFixCiFailures([alert429], "a real race"), {
    behindBy: 18,
    baseChangedFiles: [...harnessOnlyMain, "src/lib/test-slot-mutation.ts"],
  });
  assert.equal(decision.refresh, true);
  assert.deepEqual(decision.matchingBaseFiles, ["src/lib/test-slot-mutation.ts"]);
});

test("W1-T10065: a cancelled red with no file still matches a harness path", () => {
  const cancelled = { name: "ci-shard (3/8)", conclusion: "CANCELLED", logTail: "The operation was canceled." };
  const alone = decideRedBaseRefresh([cancelled], { behindBy: 18, baseChangedFiles: harnessOnlyMain });
  assert.equal(alone.refresh, true);
  assert.deepEqual(alone.matchingBaseFiles, harnessOnlyMain);

  // A cancelled job beside an alert keeps the rule as today: the job may be what main's harness fixed.
  const mixed = decideRedBaseRefresh([...codeScanningFixCiFailures([alert429], "a real race"), cancelled], {
    behindBy: 18,
    baseChangedFiles: harnessOnlyMain,
  });
  assert.equal(mixed.refresh, true);
  assert.deepEqual(mixed.matchingBaseFiles, harnessOnlyMain);
});
