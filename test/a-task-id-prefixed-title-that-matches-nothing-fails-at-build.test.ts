import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Task } from "#src/lib/plan.js";
import { judgeCriterion, type ProofExecutor } from "#src/lib/review.js";
import { proofResolvabilityViolations } from "#src/lib/task-linter.js";

// W1-T14715 (invariant prefixed-title-resolves-or-fails): the build judges a zero-match `unit test:` body as prose by
// the SAME narrative rule the filing linter uses (two commas, or "; " with one), so a "W1-Txxxx: ..." title — the
// repo's most common shape — that filing accepts as one title must resolve or fail at build.

/** 120 characters: a task-id prefix, then one title with no commas or semicolons. */
const PREFIXED_TITLE =
  "W1-T14715: a merged pull request names its task in the trailer when its run branch carries the same id as its plan's row";
/** A body with two commas: a narrative the linter refuses as one title. */
const TWO_COMMA_BODY = "W1-T14715: the retry loop backs off, waits longer each time, and gives up after the last attempt";

/** The executor is injected, so no head checkout is read; the cwd is only a label and is never created. */
const HEAD = join(tmpdir(), "w1-t14715-uncreated-head");
const NOTHING_MATCHES: ProofExecutor = () => "no-match";

function judge(body: string) {
  const criterion = { claim: "the pull request names its task", proof: `unit test: ${body}` };
  return judgeCriterion(criterion, new Set(["the", "pull", "request", "names", "its", "task"]), undefined, { cwd: HEAD, exec: NOTHING_MATCHES });
}

/** Does the filing linter refuse `body` as a narrative rather than accept it as one title? */
function filingRefuses(body: string): boolean {
  const task = { id: "W1-T14715", title: "fixture", acceptance: [{ claim: "c", proof: `unit test: ${body}` }] } as unknown as Task;
  return proofResolvabilityViolations(task).length > 0;
}

test("W1-T14715: a task-id-prefixed 120-character title that matches no test fails at build", () => {
  assert.equal(PREFIXED_TITLE.length, 120);
  assert.equal(filingRefuses(PREFIXED_TITLE), false, "filing accepts it as one title");
  const v = judge(PREFIXED_TITLE);
  assert.equal(v.proof_exec, "executed_fail");
  assert.equal(v.met, false, "the failure overrides the keyword floor");

  // One comma, a dash or a parenthesis is still one title to the linter, so the build fails it too.
  for (const body of ["W1-T14715: the loop backs off, then stops", "W1-T14715: the loop backs off — then stops", "W1-T14715: the loop (once) stops"]) {
    assert.equal(filingRefuses(body), false, body);
    assert.equal(judge(body).proof_exec, "executed_fail", body);
  }
});

test("W1-T14715: a body with two commas that matches nothing stays prose", () => {
  assert.equal(filingRefuses(TWO_COMMA_BODY), true, "filing refuses it as a narrative");
  const v = judge(TWO_COMMA_BODY);
  assert.equal(v.proof_exec, "not_executable");
  assert.equal(v.proof_skip, "prose-no-match");

  // A "; " with one comma is a narrative to both. Contrast: the same body without its commas and semicolon is one
  // title to both, and fails at build — which holds only once the build shares the linter's rule.
  const semicolon = "W1-T14715: the loop backs off; then it waits, and stops";
  assert.equal(filingRefuses(semicolon), true);
  assert.equal(judge(semicolon).proof_skip, "prose-no-match");
  const single = "W1-T14715: the loop backs off then it waits and stops";
  assert.equal(filingRefuses(single), false);
  assert.equal(judge(single).proof_exec, "executed_fail");
});
