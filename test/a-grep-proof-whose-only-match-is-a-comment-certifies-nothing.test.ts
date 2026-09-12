import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { judgeReview, matchedLinesAreAllComments } from "../src/lib/review.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import type { AcceptanceCriterion } from "../src/lib/plan.js";

function withFixtureCheckout(files: Record<string, string>, run: (cwd: string) => void): void {
  const cwd = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}remudero-comment-grep-`));
  try {
    for (const [path, contents] of Object.entries(files)) {
      const fullPath = join(cwd, path);
      mkdirSync(dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, contents);
    }
    run(cwd);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

test("comment-only grep matches withdraw the pass override", () => {
  const criteria: AcceptanceCriterion[] = [
    { claim: "the mutant call is wired", proof: "grep: MUTANT in src/lib/comment-only.ts" },
  ];
  withFixtureCheckout(
    {
      "src/lib/comment-only.ts": [
        "export const live = 1; // Compatibility target mentions MUTANT here.",
        "/*",
        "  MUTANT appears again inside a block comment.",
        " */",
        "export const other = 1;",
        "",
      ].join("\n"),
    },
    (headCheckoutDir) => {
      const verdict = judgeReview(criteria, {
        diff: "",
        report: "REPORT: unrelated cleanup with no proof keywords.",
        headCheckoutDir,
      });
      assert.equal(verdict.criteria[0].proof_exec, "executed_stale");
      assert.equal(verdict.criteria[0].met, false);
      assert.match(verdict.criteria[0].reason, /every executor-returned matching line is a comment/);
      assert.equal(verdict.state, "failure");
    },
  );
});

test("a non-comment grep match keeps the current pass behavior", () => {
  const criteria: AcceptanceCriterion[] = [
    { claim: "the mutant call is wired", proof: "grep: MUTANT in src/lib/mixed.ts" },
  ];
  withFixtureCheckout(
    {
      "src/lib/mixed.ts": [
        "// MUTANT also appears in a comment.",
        'export const live = "this is not a // MUTANT comment";',
        "",
      ].join("\n"),
    },
    (headCheckoutDir) => {
      const verdict = judgeReview(criteria, {
        diff: "",
        report: "REPORT: unrelated cleanup with no proof keywords.",
        headCheckoutDir,
      });
      assert.equal(verdict.criteria[0].proof_exec, "executed_pass");
      assert.equal(verdict.criteria[0].met, true);
      assert.equal(verdict.state, "success");
    },
  );
});

test("matchedLinesAreAllComments reads grep output lines, not the pattern shape", () => {
  const fileText = [
    "export const live = 1; // MUTANT in an inline comment",
    "/*",
    "  MUTANT in an unadorned block comment line",
    " */",
    'export const stringValue = "this is not a // MUTANT comment";',
  ].join("\n");
  assert.equal(
    matchedLinesAreAllComments([
      "src/lib/comment-only.ts:1:export const live = 1; // MUTANT in an inline comment",
      "src/lib/comment-only.ts:3:  MUTANT in an unadorned block comment line",
    ], { pattern: "MUTANT", fileText }),
    true,
  );
  assert.equal(
    matchedLinesAreAllComments([
      "src/lib/mixed.ts:1:// MUTANT in a comment",
      'src/lib/mixed.ts:5:export const stringValue = "this is not a // MUTANT comment";',
    ], { pattern: "MUTANT", fileText }),
    false,
  );
});

test("grep output without source coordinates falls back to its displayed comment shape", () => {
  const context = { pattern: "MUTANT", fileText: "export const live = 1;\n" };
  assert.equal(matchedLinesAreAllComments(["// MUTANT in a line comment"], context), true);
  assert.equal(matchedLinesAreAllComments(['export const live = "MUTANT";'], context), false);
});
