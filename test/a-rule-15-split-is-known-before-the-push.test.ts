// test/a-rule-15-split-is-known-before-the-push.test.ts — W1-T3040.
//
// MEASURED 2026-09-07: three PRs — #4404, #4406, #4413 — each carried a NEW plan shard alongside
// src/ and test/ files. Each was refused by `remudero-review` under Standing rule 15 AFTER a full
// CI cycle. Each was repaired the same mechanical way: lift the shard into its own plan-only PR,
// drop it from the implementation. The gate NAMED that remedy in its own refusal every time.
// Nothing executed it, and nothing asked the question at the one moment it is free: before pushing.
//
// ONE PREDICATE, NEVER TWO. The check imports the reviewer's OWN `criterionFieldTampered` and
// `planOnlyDiff`. A local check that disagreed with the gate would be worse than none — it would
// send an author to split a PR the reviewer would have passed, or clear one it is about to refuse.

import assert from "node:assert/strict";
import { test } from "node:test";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const { judgeRule15 } = (await import(
  pathToFileURL(join(REPO_ROOT, "scripts/rule15-precheck.mjs")).href
)) as { judgeRule15: (diff: string, files: string[]) => { ok: boolean; planPaths?: string[]; otherPaths?: string[]; reason?: string } };

/** A diff that ADDS a criterion field to a shard — the shape Rule 15 protects. */
const CRITERION_HUNK = [
  "diff --git a/plan/tasks.d/W1-T1-x.yaml b/plan/tasks.d/W1-T1-x.yaml",
  "--- a/plan/tasks.d/W1-T1-x.yaml",
  "+++ b/plan/tasks.d/W1-T1-x.yaml",
  "@@ -1,2 +1,4 @@",
  "     acceptance:",
  '+      - claim: "a thing this task must do"',
  '+        proof: "unit test: a real title"',
].join("\n");

/** The shard hunk PLUS a source hunk. `planOnlyDiff` reads the DIFF, not a file list, so a fixture
 *  whose file list claimed source changes its diff text did not contain read as plan-only — and the
 *  first draft of this test asserted against exactly that inconsistency. The diff is the truth. */
const CRITERION_ADD = [
  CRITERION_HUNK,
  "diff --git a/src/lib/x.ts b/src/lib/x.ts",
  "--- a/src/lib/x.ts",
  "+++ b/src/lib/x.ts",
  "@@ -1 +1,2 @@",
  "+const a = 1;",
].join("\n");

test("W1-T3040: a shard beside source files is refused, and the split is named on both sides", () => {
  const v = judgeRule15(CRITERION_ADD, ["plan/tasks.d/W1-T1-x.yaml", "src/lib/x.ts", "test/x.test.ts"]);
  assert.equal(v.ok, false, "this is exactly the shape remudero-review refuses");
  assert.deepEqual(v.planPaths, ["plan/tasks.d/W1-T1-x.yaml"], "the shard belongs in its own PR");
  assert.deepEqual(v.otherPaths, ["src/lib/x.ts", "test/x.test.ts"], "and the implementation stays");
});

test("W1-T3040: the same criteria change ALONE is fine — that is the plan-only exemption", () => {
  const v = judgeRule15(CRITERION_HUNK, ["plan/tasks.d/W1-T1-x.yaml"]);
  assert.equal(v.ok, true, "a plan-only filing is what the rule asks for, not a violation");
  assert.match(v.reason ?? "", /plan-only/);
});

test("W1-T3040: source files with no criteria change are fine — the check is not a plan-touch alarm", () => {
  // The false positive that would make this useless: refusing every PR that touches src/.
  const v = judgeRule15("diff --git a/src/x.ts b/src/x.ts\n+++ b/src/x.ts\n+const a = 1;\n", ["src/lib/x.ts"]);
  assert.equal(v.ok, true);
  assert.match(v.reason ?? "", /no criterion field/);
});

test("W1-T3040: a plan file touched WITHOUT adding a criterion is fine — a note or status edit", () => {
  const diff = [
    "diff --git a/plan/tasks.d/W1-T1-x.yaml b/plan/tasks.d/W1-T1-x.yaml",
    "+++ b/plan/tasks.d/W1-T1-x.yaml",
    '+    note: "an observation appended by the build"',
  ].join("\n");
  const v = judgeRule15(diff, ["plan/tasks.d/W1-T1-x.yaml", "src/lib/x.ts"]);
  assert.equal(v.ok, true, "rule 15 protects CRITERIA, not every line of a shard");
});

test("W1-T3040: it uses the reviewer's own predicate, so the two cannot disagree", async () => {
  // The whole design rests on this: re-deriving the rule locally is how a check starts telling
  // authors to split PRs the gate would have passed.
  const review = (await import(pathToFileURL(join(REPO_ROOT, "src/lib/review.ts")).href)) as {
    criterionFieldTampered: (d: string) => boolean;
  };
  assert.equal(review.criterionFieldTampered(CRITERION_HUNK), true, "the reviewer sees the same tamper");
  assert.equal(judgeRule15(CRITERION_ADD, ["plan/tasks.d/W1-T1-x.yaml", "src/x.ts"]).ok, false, "and so does the check");
});
