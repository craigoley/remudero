import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { judgeCriterion, type ProofExecutor } from "#src/lib/review.js";

// W1-T14658 (invariant title-resolves-or-fails): since W1-T14653 the filing linter accepts a `unit test:` title of
// any length as long as it carries no narrative commas or semicolons. The build must then resolve that title or fail
// it — a long single title that matches no test is executed_fail, never a prose degrade to the keyword floor.

/** 120 characters, no commas or semicolons: one title the filing linter accepts. */
const LONG_TITLE =
  "a review verdict names the merged pull request and the task it closes when the ledger holds a single row for that run id";
/** A second 120-character single title that no test in the fake suite carries. */
const ABSENT_LONG_TITLE =
  "the drain loop leaves a queued task alone when its claim ref already exists on origin and the claiming run is still live";

/** A fake suite: a name-filtered proof passes when a test carries its exact title and matches nothing otherwise. */
function suiteOf(...titles: string[]): ProofExecutor {
  return (w) => (titles.includes(w.label) ? "pass" : "no-match");
}

/** The executor is injected, so no head checkout is read; the cwd is only a label and is never created. */
const HEAD = join(tmpdir(), "w1-t14658-uncreated-head");

function judge(title: string, exec: ProofExecutor) {
  const criterion = { claim: "the verdict names the merged pull request", proof: `unit test: ${title}` };
  // The report echoes the claim's words, so the keyword floor alone would be met.
  const reportTokens = new Set(["the", "verdict", "names", "merged", "pull", "request"]);
  return judgeCriterion(criterion, reportTokens, undefined, { cwd: HEAD, exec });
}

test("W1-T14658: a 120-character title that matches no test fails at build", () => {
  assert.equal(LONG_TITLE.length, 120);
  assert.doesNotMatch(LONG_TITLE, /[,;]/);
  const v = judge(LONG_TITLE, suiteOf());
  assert.equal(v.proof_exec, "executed_fail", "a long single title matching zero tests is test theater, not prose");
  assert.equal(v.met, false, "the failure overrides the keyword floor");
  assert.notEqual(v.proof_skip, "prose-no-match");

  // A multi-clause body of the same length keeps the prose path (design point 1).
  const narrative =
    "a review verdict names the merged pull request, the task it closes, and the run id when the ledger holds one row on main";
  assert.equal(narrative.length, 120);
  const prose = judge(narrative, suiteOf());
  assert.equal(prose.proof_exec, "not_executable");
  assert.equal(prose.proof_skip, "prose-no-match");
});

test("W1-T14658: a 120-character title that matches its test passes at build", () => {
  assert.equal(LONG_TITLE.length, 120);
  assert.equal(ABSENT_LONG_TITLE.length, 120);
  assert.doesNotMatch(ABSENT_LONG_TITLE, /[,;]/);
  const suite = suiteOf(LONG_TITLE);
  const v = judge(LONG_TITLE, suite);
  assert.equal(v.proof_exec, "executed_pass");
  assert.equal(v.met, true);

  // Contrast: in the very same suite a 120-character title that names no test is executed_fail, so the pass above
  // is the title resolving, not a long body being waved through.
  const absent = judge(ABSENT_LONG_TITLE, suite);
  assert.equal(absent.proof_exec, "executed_fail");
  assert.equal(absent.met, false);
});
