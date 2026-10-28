import { strict as assert } from "node:assert";
import { test } from "node:test";
import { checkCallersAudited, judgeRubric, rubricAdvisorySection } from "#src/lib/review.js";

const REPORT = "Adjusted scratch handling. No docs update because this is reviewer-internal behavior.";

function contextCaller(file: string): string[] {
  return [
    `diff --git a/${file} b/${file}`,
    `+++ b/${file}`,
    "@@",
    " function existingReader(paths) {",
    "   return join(tmpdir(), paths);",
    " }",
    "-const label = 'old';",
    "+const label = 'new';",
  ];
}

test("added library calls in a new file produce no sibling section", () => {
  const diff = [
    "diff --git a/src/lib/new-scratch.ts b/src/lib/new-scratch.ts",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/src/lib/new-scratch.ts",
    "@@ -0,0 +1,4 @@",
    "+const root = join(tmpdir(), 'scratch');",
    "+mkdirSync(root);",
    "+const dirs = [];",
    "+dirs.push(mkdtempSync(root));",
    ...contextCaller("src/lib/existing-reader.ts"),
  ].join("\n");
  assert.equal(checkCallersAudited(diff).pass, true);
  const rubric = judgeRubric({ diff, report: REPORT });
  assert.equal(rubric.failures.some((f) => f.key === "callers-audited"), false);
  assert.doesNotMatch(rubricAdvisorySection(rubric) ?? "", /untouched sibling call site/);
});

test("added-only calls in an existing file produce no sibling section", () => {
  const diff = [
    ...contextCaller("src/lib/existing-reader.ts"),
    "@@",
    "+const extra = join(tmpdir(), 'extra');",
  ].join("\n");
  assert.equal(checkCallersAudited(diff).pass, true);
});

test("call additions and deletions in different files are not a changed call", () => {
  const diff = [
    "diff --git a/src/lib/removed.ts b/src/lib/removed.ts",
    "+++ b/src/lib/removed.ts",
    "@@",
    "-const old = join(tmpdir(), 'old');",
    "diff --git a/src/lib/added.ts b/src/lib/added.ts",
    "+++ b/src/lib/added.ts",
    "@@",
    "+const added = join(tmpdir(), 'new');",
    ...contextCaller("src/lib/existing-reader.ts"),
  ].join("\n");
  assert.equal(checkCallersAudited(diff).pass, true);
});

test("a changed definition still names an untouched sibling call", () => {
  const diff = [
    "diff --git a/src/lib/reader.ts b/src/lib/reader.ts",
    "+++ b/src/lib/reader.ts",
    "@@",
    "-export function read(paths) {",
    "+export function read(paths, options) {",
    "   return paths;",
    " }",
    "@@",
    " function oldReader(paths) {",
    "   return read(paths);",
    " }",
  ].join("\n");
  const verdict = checkCallersAudited(diff);
  assert.equal(verdict.pass, false);
  assert.match(verdict.reason, /read\(\) at src\/lib\/reader.ts::oldReader/);
});
