import assert from "node:assert/strict";
import { test } from "node:test";
import {
  declaredFilesAbsentFromChange,
  isTestOnlyCompletionOfExistingBehaviour,
  type DeclaredFileBaseFact,
  type RiskJudgeChangeView,
} from "../src/lib/risk-judge.js";

// W1-T2991 — A DECLARED FILE ABSENT FROM A DIFF IS NOT PROOF OF DRIFT.
//
// MEASURED on #4316: the risk judge escalated high / confidence 0.85 because the declared
// FILES TOUCHED named src/lib/task-linter.ts while the actual change showed only a test file. Its
// own text states the limit that made it wrong — "on the change's description/files alone, NO DIFF
// WAS READ". `ownFalsifierRenameCandidates` was already in that file at the merge base, landed by
// #4019; the only missing piece was the falsifier the PR added. A correct, green, review-passing PR
// was blocked and routed to a human.

const view = (files: Array<[string, number, number]>, truncated = false): RiskJudgeChangeView => ({
  files: files.map(([path, additions, deletions]) => ({ path, additions, deletions })),
  truncated,
});

// ── the set arithmetic ────────────────────────────────────────────────────────────────────────

test("W1-T2991: a declared file the change does not touch is named", () => {
  const absent = declaredFilesAbsentFromChange(
    ["src/lib/task-linter.ts", "test/a-renamed-shard.test.ts"],
    view([["test/a-renamed-shard.test.ts", 128, 0]]),
  );
  assert.deepEqual(absent, ["src/lib/task-linter.ts"], "exactly #4316's shape");
});

test("W1-T2991: a TRUNCATED change view yields no facts, because absence cannot be read from a capped list", () => {
  const absent = declaredFilesAbsentFromChange(
    ["src/lib/task-linter.ts"],
    view([["test/x.test.ts", 1, 0]], true),
  );
  assert.deepEqual(absent, [], "a path missing from a capped list is not a path missing from the change");
});

// ── the predicate that decides whether the absence is explained ───────────────────────────────

test("W1-T2991: a declared file already satisfying the task does not escalate", () => {
  // #4316 exactly: the file was there at the base and the change's own tests reference it.
  const facts: DeclaredFileBaseFact[] = [
    { path: "src/lib/task-linter.ts", existsAtBase: true, referencedByChangedTests: true },
  ];
  assert.equal(
    isTestOnlyCompletionOfExistingBehaviour(facts),
    true,
    "present at base AND referenced by the change's tests is a test-only completion of behaviour " +
      "that already landed — the one reading that separates 'already done' from 'not done'",
  );
});

test("W1-T2991: a genuinely unimplemented declared file still escalates", () => {
  const facts: DeclaredFileBaseFact[] = [
    { path: "src/lib/never-written.ts", existsAtBase: false, referencedByChangedTests: false },
  ];
  assert.equal(
    isTestOnlyCompletionOfExistingBehaviour(facts),
    false,
    "an implement task that ships no implementation is a real defect and this must not hide it",
  );
});

test("W1-T2991: one unexplained file among several still escalates", () => {
  const facts: DeclaredFileBaseFact[] = [
    { path: "src/lib/task-linter.ts", existsAtBase: true, referencedByChangedTests: true },
    { path: "src/lib/other.ts", existsAtBase: true, referencedByChangedTests: false },
  ];
  assert.equal(
    isTestOnlyCompletionOfExistingBehaviour(facts),
    false,
    "EVERY absent declared file must be accounted for — suppression is not a majority vote",
  );
});

test("W1-T2991: an unreadable merge-base escalates", () => {
  for (const fact of [
    { path: "src/lib/x.ts", referencedByChangedTests: true },
    { path: "src/lib/x.ts", existsAtBase: true },
    { path: "src/lib/x.ts" },
  ] as DeclaredFileBaseFact[]) {
    assert.equal(
      isTestOnlyCompletionOfExistingBehaviour([fact]),
      false,
      `an unknown reading must never suppress an escalation (${JSON.stringify(fact)}) — absence of ` +
        "evidence is not evidence, and this fails toward the judge's own verdict",
    );
  }
});

test("W1-T2991: nothing declared missing is not the same fact as everything explained", () => {
  assert.equal(
    isTestOnlyCompletionOfExistingBehaviour([]),
    false,
    "an empty fact set must not suppress: it means this never established anything, not that it cleared",
  );
});
