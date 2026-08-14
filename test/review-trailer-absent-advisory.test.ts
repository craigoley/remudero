import assert from "node:assert/strict";
import { test } from "node:test";
import type { AcceptanceCriterion } from "../src/lib/plan.js";
import { judgeReview } from "../src/lib/review.js";

// W1-T458 (the #1731 near-miss) — PR #1731 implemented W1-T452 and merged with no
// `Remudero-Task:` trailer. NEITHER credit path resolved (`findMergedByTrailer`/
// `findMergedByHeadBranch`), so the daemon RE-DISPATCHED the task it had just merged, and a
// worker landing inside that nine-minute window would have been told its already-satisfied claim
// was FALSE. `git grep -c 'Remudero-Task' -- src/lib/review.ts` measured 0 real trailer-parsing
// hits (its only 3 occurrences are comments) — the reviewer never looked at credit resolution at
// all, even though it already holds the diff and (via `taskDeclaredFiles`/`openTaskDeclaredFiles`)
// the plan's declared scopes. This adds `unresolved_task_scope`: an ADVISORY, never a refusal,
// naming the open task(s) whose declared scope an unresolved-task diff overlaps.
//
// THE TRIGGER IS "NO TASK RESOLVED" (taskDeclaredFiles absent/empty), NEVER "NO TRAILER IN THE
// BODY" — see ACCEPTANCE #2 below for why that distinction is load-bearing, not stylistic.

const SIMPLE_CRITERIA: AcceptanceCriterion[] = [
  { claim: "the change is safe", proof: "widget frobnicate implemented" },
];
const SIMPLE_REPORT = `
REPORT
- widget frobnicate implemented and verified.
PR_URL: https://github.com/o/r/pull/1
`.trim();

/** No `Remudero-Task:` trailer anywhere — matches PR #1731's actual body shape. */
const UNTRAILERED_REPORT = SIMPLE_REPORT;

const IMPLEMENTATION_DIFF = `
diff --git a/src/lib/widget.ts b/src/lib/widget.ts
+++ b/src/lib/widget.ts
@@
-const x = 1;
+const x = 2;
`.trim();

// ── ACCEPTANCE #1 ────────────────────────────────────────────────────────────────────────
// "an implementation-shaped diff with no resolved task and an intersecting declared files list
// produces an advisory"

test("ACCEPTANCE #1: no task resolved + diff intersects an open task's declared src/ scope ⇒ unresolved_task_scope advisory, naming the task and the overlap", () => {
  const openTaskDeclaredFiles = new Map([["W1-T452", ["src/lib/widget.ts", "test/widget.test.ts"]]]);

  const v = judgeReview(SIMPLE_CRITERIA, {
    diff: IMPLEMENTATION_DIFF,
    report: UNTRAILERED_REPORT,
    // no taskDeclaredFiles at all ⇒ no task resolved for this PR
    openTaskDeclaredFiles,
  });

  const advisory = v.unwiredAdvisories?.find((a) => a.reasonCode === "unresolved_task_scope");
  assert.ok(advisory, "an unresolved_task_scope advisory must be present");
  assert.deepEqual(advisory?.symbols, ["src/lib/widget.ts"]);
  assert.match(advisory?.detail ?? "", /W1-T452/, "the suspected task must be NAMED, not left as a bare count");
  assert.match(advisory?.detail ?? "", /src\/lib\/widget\.ts/);
  // A QUESTION the author answers, never a claim the gate makes (design note) — it is reporting
  // an overlap it cannot verify, not asserting this PR IS W1-T452.
  assert.match(advisory?.detail ?? "", /\?/, "the wording must read as a question, not an assertion");
});

test("no intersection with any open task's declared scope ⇒ no advisory, even with no task resolved", () => {
  const openTaskDeclaredFiles = new Map([["W1-T999", ["src/lib/unrelated.ts"]]]);

  const v = judgeReview(SIMPLE_CRITERIA, {
    diff: IMPLEMENTATION_DIFF,
    report: UNTRAILERED_REPORT,
    openTaskDeclaredFiles,
  });

  assert.equal(v.unwiredAdvisories?.filter((a) => a.reasonCode === "unresolved_task_scope").length ?? 0, 0);
});

test("no openTaskDeclaredFiles supplied at all ⇒ nothing to compare, the advisory never fires (fail-closed, matches every caller/fixture that predates this task)", () => {
  const v = judgeReview(SIMPLE_CRITERIA, { diff: IMPLEMENTATION_DIFF, report: UNTRAILERED_REPORT });
  assert.equal(v.unwiredAdvisories?.filter((a) => a.reasonCode === "unresolved_task_scope").length ?? 0, 0);
});

test("a diff touching only NON-implementation paths (declared, but outside src/ and test/) never fires — design (ii)'s ~11% figure, not the raw 52%", () => {
  const diff = `
diff --git a/plan/tasks.d/W1-T452-widget.yaml b/plan/tasks.d/W1-T452-widget.yaml
+++ b/plan/tasks.d/W1-T452-widget.yaml
@@
-status: queued
+status: in_progress
`.trim();
  const openTaskDeclaredFiles = new Map([["W1-T452", ["plan/tasks.d/W1-T452-widget.yaml"]]]);

  const v = judgeReview(SIMPLE_CRITERIA, { diff, report: UNTRAILERED_REPORT, openTaskDeclaredFiles });

  assert.equal(
    v.unwiredAdvisories?.filter((a) => a.reasonCode === "unresolved_task_scope").length ?? 0,
    0,
    "a plan-shard-only overlap is not implementation-shaped — the gate's own predicate excludes it",
  );
});

test("multiple overlapping open tasks are each named, grouped into one advisory entry", () => {
  const diff = `
${IMPLEMENTATION_DIFF}
diff --git a/test/other.test.ts b/test/other.test.ts
+++ b/test/other.test.ts
@@
+test("other", () => {});
`.trim();
  const openTaskDeclaredFiles = new Map([
    ["W1-T452", ["src/lib/widget.ts"]],
    ["W1-T999", ["test/other.test.ts"]],
  ]);

  const v = judgeReview(SIMPLE_CRITERIA, { diff, report: UNTRAILERED_REPORT, openTaskDeclaredFiles });

  const advisories = v.unwiredAdvisories?.filter((a) => a.reasonCode === "unresolved_task_scope") ?? [];
  assert.equal(advisories.length, 1, "one grouped advisory entry, not one line per candidate task");
  assert.deepEqual([...advisories[0].symbols].sort(), ["src/lib/widget.ts", "test/other.test.ts"]);
  assert.match(advisories[0].detail, /W1-T452/);
  assert.match(advisories[0].detail, /W1-T999/);
});

// ── ACCEPTANCE #2 ────────────────────────────────────────────────────────────────────────
// "the advisory is ADVISORY — it never forces state or floorState to failure"

test("ACCEPTANCE #2: the advisory never forces state or floorState to failure, whatever the criteria outcome", () => {
  const openTaskDeclaredFiles = new Map([["W1-T452", ["src/lib/widget.ts"]]]);

  // Otherwise-passing criteria: state stays success WITH the advisory present.
  const passing = judgeReview(SIMPLE_CRITERIA, {
    diff: IMPLEMENTATION_DIFF,
    report: UNTRAILERED_REPORT,
    openTaskDeclaredFiles,
  });
  assert.ok(passing.unwiredAdvisories?.some((a) => a.reasonCode === "unresolved_task_scope"));
  assert.equal(passing.state, "success", "unresolved_task_scope must never flip a passing verdict to failure");
  assert.equal(passing.floorState, "success", "unresolved_task_scope must never fold into floorState either");

  // Otherwise-failing criteria (unmet claim): still fails for its OWN reason, not because of the
  // advisory — proves the field is genuinely inert with respect to the rollup either way.
  const failingCriteria: AcceptanceCriterion[] = [{ claim: "the change is safe", proof: "nothing in the report matches" }];
  const failing = judgeReview(failingCriteria, {
    diff: IMPLEMENTATION_DIFF,
    report: UNTRAILERED_REPORT,
    openTaskDeclaredFiles,
  });
  assert.ok(failing.unwiredAdvisories?.some((a) => a.reasonCode === "unresolved_task_scope"));
  assert.equal(failing.state, "failure", "the unmet criterion still fails the review on its own merits");
});

// ── THE WRONG TRIGGER WOULD MISFIRE HERE (design (iii)) ─────────────────────────────────────
// "a gate keyed on the body's trailer would fire on that fixture and shift golden.yaml; a gate
// keyed on 'no task was resolved' leaves it untouched" — reproduced directly (not via the
// fixture file) to pin the exact predicate this task must use.

test("a resolved task (taskDeclaredFiles present) never fires the advisory even with NO trailer text anywhere and an overlapping open task — resolution, not trailer text, is the trigger", () => {
  const openTaskDeclaredFiles = new Map([["W1-T452", ["src/lib/widget.ts"]]]);

  const v = judgeReview(SIMPLE_CRITERIA, {
    diff: IMPLEMENTATION_DIFF,
    report: UNTRAILERED_REPORT, // no "Remudero-Task:" trailer anywhere in this report
    taskDeclaredFiles: ["src/lib/widget.ts"], // yet the task IS resolved (e.g. harness-injected)
    openTaskDeclaredFiles,
  });

  assert.equal(
    v.unwiredAdvisories?.filter((a) => a.reasonCode === "unresolved_task_scope").length ?? 0,
    0,
    "the golden scope-creep fixture shape: resolved via taskDeclaredFiles, trailer-free report — must stay silent",
  );
});

test("an explicit empty taskDeclaredFiles array behaves like absent — fail-closed the same direction as inverse_scope/scope_violation", () => {
  const openTaskDeclaredFiles = new Map([["W1-T452", ["src/lib/widget.ts"]]]);

  const v = judgeReview(SIMPLE_CRITERIA, {
    diff: IMPLEMENTATION_DIFF,
    report: UNTRAILERED_REPORT,
    taskDeclaredFiles: [],
    openTaskDeclaredFiles,
  });

  assert.ok(v.unwiredAdvisories?.some((a) => a.reasonCode === "unresolved_task_scope"));
});
