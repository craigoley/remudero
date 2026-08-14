import assert from "node:assert/strict";
import { test } from "node:test";
import type { AcceptanceCriterion } from "../src/lib/plan.js";
import { judgeReview } from "../src/lib/review.js";
import { scopeGuardOutOfScopeFiles } from "../src/run-task.js";

// W1-T401 — `scopeGuardOutOfScopeFiles` (src/run-task.ts) is wired at exactly ONE of
// `gitPushRunBranch`'s nine call sites (the orchestrator's fallback push, taken only when the
// worker's own branch is absent from origin) and nowhere at review time, so the ordinary path —
// the worker pushing its own branch, in its own sandbox, in another process — never runs the
// guard at all. `judgeReview` already holds both the diff and the task's declared `files:`
// (`ReviewEvidence.taskDeclaredFiles`) but, until this task, spent them ONLY on the inverse
// direction (`inverse_scope`: a declared file the diff never touched). This adds the forward
// direction — `scope_violation`: a diff file outside the declared scope — as an ADVISORY beside
// `inverse_scope`, folded into NEITHER `state` NOR `floorState` (design (ii)/(iii): a measured
// majority of recent declared-scope "violations" are legitimate — generator-gate artifacts, a
// task's own plan shard, operator-instructed or review-ratified widenings — so this ships as an
// escalation, not a refusal).

const SIMPLE_CRITERIA: AcceptanceCriterion[] = [
  { claim: "the change is safe", proof: "widget frobnicate implemented" },
];
const SIMPLE_REPORT = `
REPORT
- widget frobnicate implemented and verified.
PR_URL: https://github.com/o/r/pull/1
`.trim();

// ── ACCEPTANCE #1 ────────────────────────────────────────────────────────────────────────
// "a diff touching a file outside the task's declared scope is reported at review time rather
// than only on the fallback push path"

test("ACCEPTANCE #1: a diff touching an undeclared file yields a scope_violation advisory at review time — the path that actually runs", () => {
  const diff = `
diff --git a/src/lib/a.ts b/src/lib/a.ts
+++ b/src/lib/a.ts
@@
-const x = 1;
+const x = 2;
diff --git a/src/lib/rogue.ts b/src/lib/rogue.ts
+++ b/src/lib/rogue.ts
@@
+export const rogue = true;
`.trim();
  const declaredFiles = ["src/lib/a.ts"]; // rogue.ts touched but never declared

  const v = judgeReview(SIMPLE_CRITERIA, { diff, report: SIMPLE_REPORT, taskDeclaredFiles: declaredFiles });

  assert.equal(v.state, "success", "scope_violation is ADVISORY ONLY — it must never fail the review");
  assert.equal(v.floorState, "success", "scope_violation must never fold into floorState either");
  const advisory = v.unwiredAdvisories?.find((a) => a.reasonCode === "scope_violation");
  assert.ok(advisory, "a scope_violation advisory must be present");
  assert.deepEqual(advisory?.symbols, ["src/lib/rogue.ts"]);

  // THE CONTRAST: this is the review path — no checkout, no push, no orchestrator process. The
  // push-side guard (src/run-task.ts) makes the SAME comparison but only runs behind
  // `if (!branchOnOrigin)`, one of nine `gitPushRunBranch` call sites, on the fallback path a
  // worker's own successful push never takes. `judgeReview` sees every PR.
  assert.deepEqual(scopeGuardOutOfScopeFiles(["src/lib/a.ts", "src/lib/rogue.ts"], declaredFiles), ["src/lib/rogue.ts"]);
});

// ── ACCEPTANCE #2 ────────────────────────────────────────────────────────────────────────
// "a diff confined to the declared scope is unaffected, and a task declaring nothing is not
// treated as declaring everything"

test("ACCEPTANCE #2: a diff confined to declared scope is unaffected; an undeclared task is not treated as declaring everything", () => {
  const diff = `
diff --git a/src/lib/a.ts b/src/lib/a.ts
+++ b/src/lib/a.ts
@@
-const x = 1;
+const x = 2;
diff --git a/test/a.test.ts b/test/a.test.ts
+++ b/test/a.test.ts
@@
+test("a", () => {});
`.trim();
  const declaredFiles = ["src/lib/a.ts", "test/a.test.ts"];

  const inScope = judgeReview(SIMPLE_CRITERIA, { diff, report: SIMPLE_REPORT, taskDeclaredFiles: declaredFiles });
  assert.equal(inScope.unwiredAdvisories?.filter((a) => a.reasonCode === "scope_violation").length ?? 0, 0);

  // Control: no declared scope at all (undefined) ⇒ nothing to compare against, so the advisory
  // never fires — deliberately DIFFERENT from {@link scopeGuardOutOfScopeFiles}'s own posture
  // (which treats "no declared files" as "everything is out of scope" for its narrower, blocking
  // purpose). A task declaring nothing is not treated here as declaring everything.
  const undeclared = judgeReview(SIMPLE_CRITERIA, { diff, report: SIMPLE_REPORT });
  assert.equal(undeclared.unwiredAdvisories?.filter((a) => a.reasonCode === "scope_violation").length ?? 0, 0);

  // Same control with an EXPLICIT empty array, matching the push-side guard's own opposite choice.
  const emptyDeclared = judgeReview(SIMPLE_CRITERIA, { diff, report: SIMPLE_REPORT, taskDeclaredFiles: [] });
  assert.equal(emptyDeclared.unwiredAdvisories?.filter((a) => a.reasonCode === "scope_violation").length ?? 0, 0);
  assert.deepEqual(
    scopeGuardOutOfScopeFiles(["src/lib/a.ts", "test/a.test.ts"], undefined),
    ["src/lib/a.ts", "test/a.test.ts"],
    "the push-side guard treats no declared scope as everything out of scope — the review advisory deliberately does not",
  );
});

// ── ACCEPTANCE #3 ────────────────────────────────────────────────────────────────────────
// "the offending paths are named in the verdict rather than reported as an unattributed count"

test("ACCEPTANCE #3: every offending path is named on the advisory, grouped into one entry, never an unattributed count", () => {
  const diff = `
diff --git a/src/lib/a.ts b/src/lib/a.ts
+++ b/src/lib/a.ts
@@
-const x = 1;
+const x = 2;
diff --git a/src/lib/rogue-one.ts b/src/lib/rogue-one.ts
+++ b/src/lib/rogue-one.ts
@@
+export const rogueOne = true;
diff --git a/src/lib/rogue-two.ts b/src/lib/rogue-two.ts
+++ b/src/lib/rogue-two.ts
@@
+export const rogueTwo = true;
`.trim();
  const declaredFiles = ["src/lib/a.ts"];

  const v = judgeReview(SIMPLE_CRITERIA, { diff, report: SIMPLE_REPORT, taskDeclaredFiles: declaredFiles });

  const advisories = v.unwiredAdvisories?.filter((a) => a.reasonCode === "scope_violation") ?? [];
  assert.equal(advisories.length, 1, "one grouped advisory entry, not one line per offending file");
  assert.deepEqual([...advisories[0].symbols].sort(), ["src/lib/rogue-one.ts", "src/lib/rogue-two.ts"]);
  assert.match(advisories[0].detail, /src\/lib\/rogue-one\.ts/);
  assert.match(advisories[0].detail, /src\/lib\/rogue-two\.ts/);

  // Both directions can fire together, each naming its OWN paths — never merged into one another.
  const declaredButUntouched = ["src/lib/a.ts", "src/lib/never-touched.ts"];
  const both = judgeReview(SIMPLE_CRITERIA, { diff, report: SIMPLE_REPORT, taskDeclaredFiles: declaredButUntouched });
  const inverse = both.unwiredAdvisories?.find((a) => a.reasonCode === "inverse_scope");
  const violation = both.unwiredAdvisories?.find((a) => a.reasonCode === "scope_violation");
  assert.deepEqual(inverse?.symbols, ["src/lib/never-touched.ts"]);
  assert.deepEqual([...(violation?.symbols ?? [])].sort(), ["src/lib/rogue-one.ts", "src/lib/rogue-two.ts"]);
});

// ── ACCEPTANCE #4 (W1-T458) ──────────────────────────────────────────────────────────────
// "the two existing scope comparisons keep their current behaviour in both directions" — proven
// by running them BESIDE the new unresolved_task_scope advisory (ReviewEvidence.
// openTaskDeclaredFiles) and showing every count above is unchanged.

test("ACCEPTANCE #4 (W1-T458): inverse_scope and scope_violation are unaffected by openTaskDeclaredFiles / unresolved_task_scope sharing the same unwiredAdvisories array", () => {
  const diff = `
diff --git a/src/lib/a.ts b/src/lib/a.ts
+++ b/src/lib/a.ts
@@
-const x = 1;
+const x = 2;
diff --git a/src/lib/rogue.ts b/src/lib/rogue.ts
+++ b/src/lib/rogue.ts
@@
+export const rogue = true;
`.trim();
  const declaredFiles = ["src/lib/a.ts"]; // this PR's OWN task IS resolved

  // An unrelated open task also happens to declare rogue.ts — if unresolved_task_scope's
  // "resolved" check were wrong (e.g. keyed off something other than taskDeclaredFiles), this
  // could smuggle a THIRD advisory in and change counts a reader keys off unwiredAdvisories.length
  // for. It must not: scope_violation still names exactly rogue.ts, and unresolved_task_scope
  // stays silent because the task IS resolved.
  const openTaskDeclaredFiles = new Map([["W1-T999", ["src/lib/rogue.ts"]]]);

  const v = judgeReview(SIMPLE_CRITERIA, { diff, report: SIMPLE_REPORT, taskDeclaredFiles: declaredFiles, openTaskDeclaredFiles });

  const scopeViolation = v.unwiredAdvisories?.find((a) => a.reasonCode === "scope_violation");
  assert.ok(scopeViolation, "scope_violation still fires exactly as before");
  assert.deepEqual(scopeViolation?.symbols, ["src/lib/rogue.ts"]);
  assert.equal(v.unwiredAdvisories?.filter((a) => a.reasonCode === "inverse_scope").length, 0);
  assert.equal(
    v.unwiredAdvisories?.filter((a) => a.reasonCode === "unresolved_task_scope").length,
    0,
    "a resolved task's PR never trips the new unresolved-task advisory",
  );
  assert.equal(v.unwiredAdvisories?.length, 1, "exactly one advisory total — the two checks stayed disjoint");
});
