import assert from "node:assert/strict";
import { test } from "node:test";
import type { AcceptanceCriterion } from "../src/lib/plan.js";
import { checkSatisfiedByGuard, judgeReview } from "../src/lib/review.js";

/**
 * W1-T400 — `criterionFieldTampered` was `addedSatisfiedBy || removedField`. A pure APPEND (a
 * whole new `claim:`/`proof:` pair added after the existing criteria, deleting nothing and
 * adding no `satisfied_by:`) tripped NEITHER disjunct, so a worker could write itself a new
 * criterion its own diff already satisfied instead of editing an inconvenient one — PR #1295
 * reshaped its diff to do exactly this. Fixed by widening the ADD side from `satisfied_by`-only
 * to any criterion field (`claim:`/`proof:`/`satisfied_by:`); the `!planOnly` exemption already
 * in {@link judgeReview} (and `planOnly && humanAuthored` in {@link checkSatisfiedByGuard}) is
 * what keeps an ordinary plan-scoped task filing — itself nothing but added claim/proof lines —
 * from being newly blocked, so both directions are proven below, not assumed (design (iii)).
 */

const CRITERIA: AcceptanceCriterion[] = [
  { claim: "the widget renders", proof: "unit test: test/widget.test.ts" },
];
const REPORT = "REPORT\n- Implemented the widget.\nPR_URL: https://github.com/o/r/pull/1295";

// ── design (i): re-derive the control before trusting anything about append ────

test("control: a MODIFIED criterion field in plan/tasks.yaml, mixed with a src file, is detected (checkSatisfiedByGuard, meta {} — no exemption) — proves the fixture shape reaches the branch at all", () => {
  const modify = [
    "diff --git a/plan/tasks.yaml b/plan/tasks.yaml",
    "--- a/plan/tasks.yaml",
    "+++ b/plan/tasks.yaml",
    "@@ -1,3 +1,3 @@",
    "   acceptance:",
    '-      claim: "the widget renders red"',
    '+      claim: "the widget renders blue"',
    "diff --git a/src/lib/widget.ts b/src/lib/widget.ts",
    "--- a/src/lib/widget.ts",
    "+++ b/src/lib/widget.ts",
    "@@ -1,1 +1,2 @@",
    "   export const widget = 1;",
    "+export function frobnicate() {}",
  ].join("\n");
  assert.equal(checkSatisfiedByGuard(modify, {}).pass, false, "the control must trip, or an append result proves nothing");
});

// ── ACCEPTANCE 1: a pure append inside a source-touching PR is caught ──────────

/** Appends a WHOLE NEW `claim:`/`proof:` pair after the existing criterion — no line is
 *  deleted, and no `satisfied_by:` is added — the exact shape both pre-fix disjuncts missed.
 *  Mixed with a src file so the diff is not plan-only, matching a worker's own run PR. */
const APPEND_NEW_CRITERION_NON_PLAN_ONLY_DIFF = [
  "diff --git a/plan/tasks.yaml b/plan/tasks.yaml",
  "--- a/plan/tasks.yaml",
  "+++ b/plan/tasks.yaml",
  "@@ -1,3 +1,5 @@",
  "   acceptance:",
  '     - claim: "the widget renders"',
  '       proof: "unit test: test/widget.test.ts"',
  '+    - claim: "the diff already does this, so add a criterion it already satisfies"',
  '+      proof: "unit test: test/self-satisfying.test.ts"',
  "diff --git a/src/lib/widget.ts b/src/lib/widget.ts",
  "--- a/src/lib/widget.ts",
  "+++ b/src/lib/widget.ts",
  "@@ -1,1 +1,2 @@",
  "   export const widget = 1;",
  "+export function selfSatisfying() { return true; }",
].join("\n");

test("ACCEPTANCE 1: appending a new claim+proof pair inside a source-touching PR is detected as criteria tampering (judgeReview.criteriaTampered) rather than passing both disjuncts", () => {
  const v = judgeReview(CRITERIA, { diff: APPEND_NEW_CRITERION_NON_PLAN_ONLY_DIFF, report: REPORT });
  assert.equal(v.planOnly, false, "the diff also touches src/, so it is not plan-only");
  assert.equal(v.criteriaTampered, true, "an appended criterion in a non-plan-only PR must trip the guard");
  assert.equal(v.state, "failure");
  assert.match(v.summary, /Standing rule 15/i);
});

test("ACCEPTANCE 1: the same append fails checkSatisfiedByGuard directly, with no exemption available (not plan-only)", () => {
  const g = checkSatisfiedByGuard(APPEND_NEW_CRITERION_NON_PLAN_ONLY_DIFF, { planOnly: false, humanAuthored: true });
  assert.equal(g.pass, false);
  assert.match(g.reason, /claim\/proof|satisfied_by/);
});

// ── ACCEPTANCE 2: a plan-scoped filing appending criteria stays exempt ─────────

/** The BYTE-IDENTICAL append to plan/tasks.yaml above, but with no src/ file in the diff — a
 *  plan-scoped task filing, which is nothing but added claim/proof lines by construction. */
const APPEND_NEW_CRITERION_PLAN_ONLY_DIFF = [
  "diff --git a/plan/tasks.yaml b/plan/tasks.yaml",
  "--- a/plan/tasks.yaml",
  "+++ b/plan/tasks.yaml",
  "@@ -1,3 +1,5 @@",
  "   acceptance:",
  '     - claim: "the widget renders"',
  '       proof: "unit test: test/widget.test.ts"',
  '+    - claim: "a brand new task criterion, filed for a future worker"',
  '+      proof: "unit test: test/future.test.ts"',
].join("\n");

test("ACCEPTANCE 2: a plan-scoped filing that APPENDS a new criterion stays exempt — judgeReview.criteriaTampered is false via the planOnly carve-out, not because the append goes undetected", () => {
  const v = judgeReview(CRITERIA, { diff: APPEND_NEW_CRITERION_PLAN_ONLY_DIFF, report: REPORT });
  assert.equal(v.planOnly, true, "a diff touching only plan/tasks.yaml is plan-only (isInPlanScope: startsWith('plan/'))");
  assert.equal(v.criteriaTampered, false, "the planOnly exemption must keep an ordinary filing clean");
});

test("ACCEPTANCE 2: the same plan-only append PASSES checkSatisfiedByGuard once it is also human-authored (the Architect carve-out), even though criterionFieldTampered itself is true", () => {
  const tampered = checkSatisfiedByGuard(APPEND_NEW_CRITERION_PLAN_ONLY_DIFF, {});
  assert.equal(tampered.pass, false, "meta {} carries no exemption — the underlying predicate must still see the append");

  const exempt = checkSatisfiedByGuard(APPEND_NEW_CRITERION_PLAN_ONLY_DIFF, { planOnly: true, humanAuthored: true });
  assert.equal(exempt.pass, true, "planOnly && humanAuthored is the Architect exemption — a genuine filing is never blocked");
});

// ── ACCEPTANCE 3: modify/remove are still detected — the existing disjuncts are not withdrawn ──

test("ACCEPTANCE 3: modifying an existing criterion's proof (edited, not appended) is still detected", () => {
  const editDiff = [
    "diff --git a/plan/tasks.yaml b/plan/tasks.yaml",
    "--- a/plan/tasks.yaml",
    "+++ b/plan/tasks.yaml",
    "@@ -1,3 +1,3 @@",
    "   acceptance:",
    '-      proof: "unit test: test/old.test.ts"',
    '+      proof: "unit test: test/rewritten-to-match-the-diff.test.ts"',
    "diff --git a/src/lib/widget.ts b/src/lib/widget.ts",
    "--- a/src/lib/widget.ts",
    "+++ b/src/lib/widget.ts",
    "@@ -1,1 +1,2 @@",
    "   export const widget = 1;",
    "+export function frobnicate() {}",
  ].join("\n");
  const v = judgeReview(CRITERIA, { diff: editDiff, report: REPORT });
  assert.equal(v.planOnly, false);
  assert.equal(v.criteriaTampered, true, "editing an existing field must still trip the guard");
});

test("ACCEPTANCE 3: deleting a whole criterion (removed field lines, no matching add) is still detected", () => {
  const removeDiff = [
    "diff --git a/plan/tasks.yaml b/plan/tasks.yaml",
    "--- a/plan/tasks.yaml",
    "+++ b/plan/tasks.yaml",
    "@@ -1,4 +1,2 @@",
    "   acceptance:",
    '-    - claim: "an inconvenient criterion"',
    '-      proof: "unit test: test/inconvenient.test.ts"',
    "diff --git a/src/lib/widget.ts b/src/lib/widget.ts",
    "--- a/src/lib/widget.ts",
    "+++ b/src/lib/widget.ts",
    "@@ -1,1 +1,2 @@",
    "   export const widget = 1;",
    "+export function frobnicate() {}",
  ].join("\n");
  const v = judgeReview(CRITERIA, { diff: removeDiff, report: REPORT });
  assert.equal(v.planOnly, false);
  assert.equal(v.criteriaTampered, true, "deleting a criterion outright must still trip the guard");
});

test("ACCEPTANCE 3 (negative control): a clean diff touching neither plan/tasks.yaml nor a shard never trips criteriaTampered", () => {
  const clean = [
    "diff --git a/src/lib/widget.ts b/src/lib/widget.ts",
    "--- a/src/lib/widget.ts",
    "+++ b/src/lib/widget.ts",
    "@@ -1,1 +1,2 @@",
    "   export const widget = 1;",
    "+export function frobnicate() {}",
  ].join("\n");
  const v = judgeReview(CRITERIA, { diff: clean, report: REPORT });
  assert.equal(v.criteriaTampered, false);
});
