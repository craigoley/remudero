import assert from "node:assert/strict";
import { test } from "node:test";
import type { AcceptanceCriterion } from "../src/lib/plan.js";
import { inverseScopeAdvisorySection, judgeReview } from "../src/lib/review.js";
import { subsystemsOf } from "../src/lib/task-linter.js";
import type { Task } from "../src/lib/plan.js";

// W1-T3645 — W1-T3621 declared `files: [src/lib/inbox.ts, src/run-task.ts, test/...]`. #5689's
// merged diff never touched `src/run-task.ts`: `planProjectionForDependsOn` was built and called
// entirely inside `inbox.ts`. That phantom path made the shard read as spanning two subsystems
// (`subsystemsOf` counts a task's DECLARED `files:`, never the diff), which tripped Rule 19
// sizing and reddened `every-shard-on-main-is-lintable` on a clean checkout — four PRs chased a
// gate message instead of the code. `inverseScopeAdvisorySection` (src/lib/review.ts, wired into
// `runReview` in src/run-task.ts, per test/inverse-scope-advisory-section.test.ts) already reports
// the untouched path; this task's remaining gap is that the report named only the FACT, never the
// CONSEQUENCE — so this pins the message that says what the phantom path bought.

const SIMPLE_CRITERIA: AcceptanceCriterion[] = [
  { claim: "the change is safe", proof: "widget frobnicate implemented" },
];
const SIMPLE_REPORT = `
REPORT
- widget frobnicate implemented and verified.
PR_URL: https://github.com/o/r/pull/1
`.trim();

const W1_T3621_DIFF = `
diff --git a/src/lib/inbox.ts b/src/lib/inbox.ts
+++ b/src/lib/inbox.ts
@@
-const x = 1;
+const x = 2;
diff --git a/test/inbox.test.ts b/test/inbox.test.ts
+++ b/test/inbox.test.ts
@@
+test("inbox", () => { assert.equal(1, 1); });
`.trim();

// ── ACCEPTANCE #1 ──────────────────────────────────────────────────────────────────────────
// "a PR whose task declares a file the diff never touches is reported in the reviewer's
// declared-scope block, the direction that is silent today"

test("ACCEPTANCE #1: reconstructing W1-T3621's declaration against #5689's diff names src/run-task.ts, and narrowing files: falls silent", () => {
  const declaredFiles = ["src/lib/inbox.ts", "src/run-task.ts", "test/inbox.test.ts"];
  const v = judgeReview(SIMPLE_CRITERIA, { diff: W1_T3621_DIFF, report: SIMPLE_REPORT, taskDeclaredFiles: declaredFiles });
  const section = inverseScopeAdvisorySection(v.unwiredAdvisories);
  assert.ok(section, "expected a rendered untouched-declared-scope section");
  assert.match(section, /- `src\/run-task\.ts`/, "the untouched declared path must be named");

  // The falsifier's second half: remove the phantom path and the report falls silent.
  const narrowed = judgeReview(SIMPLE_CRITERIA, {
    diff: W1_T3621_DIFF,
    report: SIMPLE_REPORT,
    taskDeclaredFiles: ["src/lib/inbox.ts", "test/inbox.test.ts"],
  });
  assert.equal(inverseScopeAdvisorySection(narrowed.unwiredAdvisories), undefined);
});

// ── ACCEPTANCE #2 ──────────────────────────────────────────────────────────────────────────
// "the report names the consequence, so a reader sees that the phantom path is what supplies
// the task's extra concern rather than merely that it is unused"

test("ACCEPTANCE #2: the over-declaration report names the concern it inflates, not merely that the path is unused", () => {
  const task: Task = {
    id: "W1-T3621",
    title: "t",
    repo: "remudero",
    depends_on: [],
    type: "implement",
    verify: "auto",
    risk: "medium",
    status: "queued",
    attempts: 0,
    files: ["src/lib/inbox.ts", "src/run-task.ts"],
  };
  // The declared-but-untouched path is what pushes the declared span to two subsystems — the
  // exact mechanism the message must name, not just the bare fact that it is unused.
  assert.ok(subsystemsOf(task).size >= 2, "precondition: the phantom path spans a second subsystem");

  const v = judgeReview(SIMPLE_CRITERIA, {
    diff: W1_T3621_DIFF,
    report: SIMPLE_REPORT,
    taskDeclaredFiles: task.files,
  });
  const section = inverseScopeAdvisorySection(v.unwiredAdvisories) ?? "";
  assert.match(section, /concern/i, "the message must name the concern the phantom path supplies");
  assert.match(section, /risk/i, "the message must name the risk/sizing band the phantom path can force");
  assert.match(section, /subsystemsOf|Rule 19/, "the message must name the actual mechanism, not a vague warning");
});

// ── ACCEPTANCE #3 ──────────────────────────────────────────────────────────────────────────
// "it stays advisory and never blocks, because a legitimate widening and a phantom path are
// indistinguishable from the diff alone"

test("ACCEPTANCE #3: an over-declared file never changes the review verdict", () => {
  const declaredFiles = ["src/lib/inbox.ts", "src/run-task.ts", "test/inbox.test.ts"];
  const v = judgeReview(SIMPLE_CRITERIA, { diff: W1_T3621_DIFF, report: SIMPLE_REPORT, taskDeclaredFiles: declaredFiles });

  assert.ok(v.unwiredAdvisories?.some((a) => a.reasonCode === "inverse_scope"), "precondition: the advisory fired");
  assert.equal(v.state, "success", "inverse_scope must never fail the review");
  assert.equal(v.floorState, "success", "inverse_scope must never fold into floorState either");

  // Control: a task declaring nothing extra never fires the advisory, and the verdict is identical.
  const noPhantom = judgeReview(SIMPLE_CRITERIA, {
    diff: W1_T3621_DIFF,
    report: SIMPLE_REPORT,
    taskDeclaredFiles: ["src/lib/inbox.ts", "test/inbox.test.ts"],
  });
  assert.equal(noPhantom.state, v.state);
  assert.equal(noPhantom.floorState, v.floorState);
});
