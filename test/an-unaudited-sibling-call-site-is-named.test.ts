import { strict as assert } from "node:assert";
import { test } from "node:test";

import { checkCallersAudited, judgeRubric, rubricAdvisorySection } from "../src/lib/review.js";

const REPORT = [
  "REPORT",
  "updated the shared reader call.",
  "No docs update because this is reviewer-internal behavior.",
  "PR_URL: https://github.com/o/r/pull/1",
].join("\n");

const PARTIAL_SHARED_READER_DIFF = [
  "diff --git a/src/lib/ledger.ts b/src/lib/ledger.ts",
  "+++ b/src/lib/ledger.ts",
  "@@",
  " function readRetroArchive(paths) {",
  "-  return openLedgerUnion(paths);",
  "+  return openLedgerUnion(paths, { days: 30 });",
  " }",
  "@@",
  " function readMainArchive(paths) {",
  "   return openLedgerUnion(paths);",
  " }",
].join("\n");

const FULLY_AUDITED_READER_DIFF = [
  "diff --git a/src/lib/ledger.ts b/src/lib/ledger.ts",
  "+++ b/src/lib/ledger.ts",
  "@@",
  " function readRetroArchive(paths) {",
  "-  return openLedgerUnion(paths);",
  "+  return openLedgerUnion(paths, { days: 30 });",
  " }",
  "@@",
  " function readMainArchive(paths) {",
  "-  return openLedgerUnion(paths);",
  "+  return openLedgerUnion(paths, { days: 30 });",
  " }",
].join("\n");

const MANY_CALLERS_DIFF = [
  "diff --git a/src/lib/ledger.ts b/src/lib/ledger.ts",
  "+++ b/src/lib/ledger.ts",
  "@@",
  " function changedReader(paths) {",
  "-  return openLedgerUnion(paths);",
  "+  return openLedgerUnion(paths, { days: 30 });",
  " }",
  "@@",
  " function sameFileOne(paths) {",
  "   return openLedgerUnion(paths);",
  " }",
  "@@",
  " function sameFileTwo(paths) {",
  "   return openLedgerUnion(paths);",
  " }",
  "diff --git a/src/lib/ledger-extra.ts b/src/lib/ledger-extra.ts",
  "+++ b/src/lib/ledger-extra.ts",
  "@@",
  " function sameDirOne(paths) {",
  "   return openLedgerUnion(paths);",
  " }",
  "@@",
  " function sameDirTwo(paths) {",
  "   return openLedgerUnion(paths);",
  " }",
  "@@",
  " function sameDirThree(paths) {",
  "   return openLedgerUnion(paths);",
  " }",
  "diff --git a/src/other/report.ts b/src/other/report.ts",
  "+++ b/src/other/report.ts",
  "@@",
  " function farAway(paths) {",
  "   return openLedgerUnion(paths);",
  " }",
].join("\n");

const SAME_CONTAINER_CALLERS_DIFF = [
  "diff --git a/src/lib/ledger.ts b/src/lib/ledger.ts",
  "+++ b/src/lib/ledger.ts",
  "@@",
  " function changedReader(paths) {",
  "-  return openLedgerUnion(paths);",
  "+  return openLedgerUnion(paths, { days: 30 });",
  " }",
  "@@",
  " function repeatedReader(paths, otherPaths) {",
  "   return openLedgerUnion(otherPaths) ?? openLedgerUnion(paths);",
  " }",
  "@@",
  " function repeatedReader(paths, otherPaths) {",
  "   return openLedgerUnion(paths) ?? openLedgerUnion(otherPaths);",
  " }",
].join("\n");

test("W1-T3239: an untouched sibling call site is named", () => {
  const verdict = checkCallersAudited(PARTIAL_SHARED_READER_DIFF);

  assert.equal(verdict.pass, false);
  assert.match(verdict.reason, /openLedgerUnion\(\)/);
  assert.match(verdict.reason, /src\/lib\/ledger\.ts::readMainArchive/);
  assert.match(verdict.reason, /return openLedgerUnion\(paths\);/);
});

test("W1-T3239: a fully-audited symbol produces no sibling section", () => {
  const rubric = judgeRubric({ diff: FULLY_AUDITED_READER_DIFF, report: REPORT });

  assert.equal(checkCallersAudited(FULLY_AUDITED_READER_DIFF).pass, true);
  assert.equal(rubric.failures.some((f) => f.key === "callers-audited"), false);
  assert.equal(rubricAdvisorySection(rubric), undefined);
});

test("W1-T3239: a symbol with many callers prints a bounded list and names the remainder", () => {
  const verdict = checkCallersAudited(MANY_CALLERS_DIFF);

  assert.equal(verdict.pass, false);
  assert.match(verdict.reason, /sameFileOne/);
  assert.match(verdict.reason, /sameFileTwo/);
  assert.match(verdict.reason, /sameDirOne/);
  assert.match(verdict.reason, /sameDirTwo/);
  assert.match(verdict.reason, /sameDirThree/);
  assert.doesNotMatch(verdict.reason, /farAway/);
  assert.match(verdict.reason, /1 more not shown/);
});

test("W1-T3239: sibling callers in the same container sort by call text", () => {
  const verdict = checkCallersAudited(SAME_CONTAINER_CALLERS_DIFF);

  assert.equal(verdict.pass, false);
  assert.match(
    verdict.reason,
    /openLedgerUnion\(otherPaths\).*openLedgerUnion\(paths\)/,
  );
});
