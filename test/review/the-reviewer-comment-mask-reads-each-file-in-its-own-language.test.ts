import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { AcceptanceCriterion } from "#src/lib/plan.js";
import { judgeReview, matchedLinesAreAllComments } from "#src/lib/review.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

function withFixtureCheckout(files: Record<string, string>, run: (cwd: string) => void): void {
  const cwd = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}remudero-comment-grammar-`));
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

function judgeOne(proof: string, files: Record<string, string>) {
  const criteria: AcceptanceCriterion[] = [{ claim: "the policy value is set", proof }];
  let verdict: ReturnType<typeof judgeReview> | undefined;
  withFixtureCheckout(files, (headCheckoutDir) => {
    verdict = judgeReview(criteria, { diff: "", report: "REPORT: unrelated cleanup.", headCheckoutDir });
  });
  return verdict!.criteria[0]!;
}

// plan/policy.yaml's shape at #13282: a header comment holding `src/lib/*.ts`, a later value line.
const POLICY_SHAPED_YAML = [
  "# Policy (W1-T47). These values (thresholds, gates,",
  "# cadence) were literals scattered across src/lib/*.ts — a value change was an edit to",
  "# code. They live here now.",
  "version: 1",
  "autonomy:",
  "  # OPERATOR 2026-10-21: act",
  "  mode: act",
  "",
].join("\n");

test("W1-T10372: a YAML value line after a stray slash-star is not a comment", () => {
  assert.equal(
    matchedLinesAreAllComments(["7:  mode: act"], { pattern: "mode: act", fileText: POLICY_SHAPED_YAML, path: "plan/policy.yaml" }),
    false,
  );
  // Control: the same file read under the legacy JavaScript grammar IS blinded by the `/*`.
  assert.equal(matchedLinesAreAllComments(["7:  mode: act"], { pattern: "mode: act", fileText: POLICY_SHAPED_YAML }), true);
  const graded = judgeOne("grep: mode: act in plan/policy.yaml", { "plan/policy.yaml": POLICY_SHAPED_YAML });
  assert.equal(graded.proof_exec, "executed_pass", graded.reason);
  assert.equal(graded.met, true);
});

test("W1-T10372: a YAML hash comment and a TS block comment are still comments", () => {
  const yamlComment = judgeOne("grep: OPERATOR 2026-10-21: act in plan/policy.yaml", { "plan/policy.yaml": POLICY_SHAPED_YAML });
  assert.equal(yamlComment.proof_exec, "executed_stale");
  assert.match(yamlComment.reason, /every executor-returned matching line is a comment/);
  const ts = ["export const live = 1;", "/*", "  MUTANT inside a block comment", " */", ""].join("\n");
  const tsComment = judgeOne("grep: MUTANT in src/lib/block.ts", { "src/lib/block.ts": ts });
  assert.equal(tsComment.proof_exec, "executed_stale");
  assert.equal(
    matchedLinesAreAllComments(["3:  MUTANT inside a block comment"], { pattern: "MUTANT", fileText: ts, path: "src/lib/block.ts" }),
    true,
  );
});

test("a YAML hash inside a quoted scalar or a block scalar is not a comment", () => {
  const yaml = [
    'title: "issue #42 is open"',
    "note: it's # a real comment",
    "rationale: |",
    "  #13282 sat on plan-proof-unrunnable",
    "after: 1 # tail",
    "",
  ].join("\n");
  const ctx = (pattern: string) => ({ pattern, fileText: yaml, path: "plan/tasks.d/x.yaml" });
  assert.equal(matchedLinesAreAllComments(["1:" + 'title: "issue #42 is open"'], ctx("#42")), false);
  assert.equal(matchedLinesAreAllComments(["2:note: it's # a real comment"], ctx("a real comment")), true);
  assert.equal(matchedLinesAreAllComments(["4:  #13282 sat on plan-proof-unrunnable"], ctx("#13282 sat")), false);
  assert.equal(matchedLinesAreAllComments(["5:after: 1 # tail"], ctx("tail")), true);
  // A regex pattern (no literal occurrence) falls back to the line's first non-blank character.
  assert.equal(matchedLinesAreAllComments(["5:after: 1 # tail"], ctx("^after")), false);
  assert.equal(matchedLinesAreAllComments(["2:note: it's # a real comment"], ctx("^note.*$")), false);
  assert.equal(matchedLinesAreAllComments(["# displayed comment"], ctx("^#")), true);
});

test("a Markdown file or an unknown extension masks nothing", () => {
  const md = ["See src/lib/*.ts for the readers.", "* a bullet", "// not a comment in prose", ""].join("\n");
  for (const path of ["docs/readers.md", "data/readers.txt"]) {
    const ctx = (pattern: string) => ({ pattern, fileText: md, path });
    assert.equal(matchedLinesAreAllComments(["2:* a bullet"], ctx("a bullet")), false);
    assert.equal(matchedLinesAreAllComments(["3:// not a comment in prose"], ctx("not a comment")), false);
    assert.equal(matchedLinesAreAllComments(["2:* a bullet"], ctx("^[*] a")), false);
    assert.equal(matchedLinesAreAllComments(["* a bullet"], ctx("^[*] a")), false);
  }
});
