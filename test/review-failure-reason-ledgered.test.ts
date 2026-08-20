import assert from "node:assert/strict";
import { test } from "node:test";
import type { AcceptanceCriterion } from "../src/lib/plan.js";
import { judgeReview, reviewFailureClass, reviewLedgerLegibilityFields, reviewLedgerReasons } from "../src/lib/review.js";

// ── W1-T304 ──────────────────────────────────────────────────────────────────
//
// MEASURED 2026-08-03: PR #1193 (W1-T298) was posted `failure` by
// `bodyContradictsDiff`. Its `review.posted` ledger row read `state: failure`,
// every criterion substantiated (`proof_exec` all `executed_pass`), yet
// `unmet_criteria: []` and `reasons: []` — the ONLY place the actual reason
// existed was the posted commit-status description, a field GitHub truncates
// to 140 characters. `grep -a 'body contradicts its own diff'` over the ledger
// returned ZERO: the failure class was uncountable, unauditable, untunable.
//
// These fixtures prove the fix at the exact seam the bug lived in:
// `reviewLedgerLegibilityFields` is the SAME pure function run-task.ts's
// `log("review.posted", …)` call spreads verbatim (`...reviewLedgerLegibilityFields(verdict)`,
// src/run-task.ts:1747) — so an assertion against its return value here is an
// assertion about what the real ledger row actually carries, not a
// hand-copied guess (the same discipline `capped_reason`/`degraded_reason`
// already established for this exact ledger line).

// A single-keyword proof so every fixture below isolates ONE structural
// failure trigger at a time — the named criterion is trivially satisfied by
// any REPORT-headed body, exactly like test/body-contradicts-diff.test.ts's
// own CRITERIA fixture.
const ONE_CRITERION: AcceptanceCriterion[] = [{ claim: "a report was filed", proof: "report" }];
const RESPONSIVE_REPORT = "REPORT\nThe fix lands in the diff below.\nPR_URL: https://github.com/o/r/pull/1";

// ── acceptance criterion 1 + 2: EVERY failure-state path carries a failure_class + failure_reason ──

test("ACCEPTANCE 1+2: the measured #1193 shape — every criterion met, every proof substantiated, but the body contradicts its own diff — still writes a failure_class + failure_reason, not reasons: []", () => {
  const threeFileDiff = `
diff --git a/MASTER-PLAN.md b/MASTER-PLAN.md
+++ b/MASTER-PLAN.md
@@
+updated plan text
diff --git a/plan/tasks.yaml b/plan/tasks.yaml
+++ b/plan/tasks.yaml
@@
+- id: W1-T999
diff --git a/docs/ORIENTATION.md b/docs/ORIENTATION.md
+++ b/docs/ORIENTATION.md
@@
-old orientation text
+new orientation text
`.trim();
  const body = `${RESPONSIVE_REPORT}\n\nexactly one file: MASTER-PLAN.md. No src/, no test/, no docs/ORIENTATION.md.`;
  const v = judgeReview(ONE_CRITERION, { diff: threeFileDiff, report: body });
  // Reproduces the measured ledger row exactly: every NAMED criterion met.
  assert.ok(v.criteria.every((c) => c.met), "every criterion substantiated — the #1193 shape");
  assert.equal(v.state, "failure");

  const fields = reviewLedgerLegibilityFields(v);
  assert.equal(fields.failure_class, "changeset_contradiction");
  assert.ok(fields.failure_reason && fields.failure_reason.length > 0, "reasons: [] is no longer the whole story");
  assert.equal(fields.failure_reason, v.summary, "the ledger's reason is the SAME text the verdict actually rendered");
  assert.match(fields.failure_reason!, /body contradicts its own diff/i);
});

// ── W1-T1016: the `reasons` array itself, not just failure_class/failure_reason ──────────────
//
// `reviewLedgerLegibilityFields` above proves the reason is COMPUTED (`failure_class`/
// `failure_reason`); it never touches `reasons`, which run-task.ts's `log("review.posted", …)`
// call populates separately and which `actionableGateFailuresFromReasons` (lib/sweep.ts) —
// the fix rung's own routing gate — actually reads. Before this task `reasons` stayed `[]` for
// this exact #1193 shape, so the gate's `length === 1` bound could never fire and the PR fell to
// `blocked-ambiguous` (a human) instead of the `blocked-fixable` row that already exists for it.

/** The #1193 fixture from the test above, factored out so both the positive and negative-control
 *  tests below build the SAME contradiction verdict rather than a hand-copied variant. */
function contradictionVerdict() {
  const threeFileDiff = `
diff --git a/MASTER-PLAN.md b/MASTER-PLAN.md
+++ b/MASTER-PLAN.md
@@
+updated plan text
diff --git a/plan/tasks.yaml b/plan/tasks.yaml
+++ b/plan/tasks.yaml
@@
+- id: W1-T999
diff --git a/docs/ORIENTATION.md b/docs/ORIENTATION.md
+++ b/docs/ORIENTATION.md
@@
-old orientation text
+new orientation text
`.trim();
  const body = `${RESPONSIVE_REPORT}\n\nexactly one file: MASTER-PLAN.md. No src/, no test/, no docs/ORIENTATION.md.`;
  return judgeReview(ONE_CRITERION, { diff: threeFileDiff, report: body });
}

test("W1-T1016: a changeset contradiction failure ledgers exactly one reason instead of an empty array", () => {
  const v = contradictionVerdict();
  assert.ok(v.criteria.every((c) => c.met), "every criterion substantiated — reasons would stay [] without the fix");
  assert.equal(v.state, "failure");

  const reasons = reviewLedgerReasons(v);
  assert.equal(reasons.length, 1, "exactly one reason, never an empty array and never more than one (design note ii)");
  assert.equal(reasons[0], v.summary, "the single reason is the SAME text already computed as failure_reason — never re-derived");
});

test("W1-T1016: an unmet criteria failure keeps its own reasons unchanged", () => {
  // The negative control, run beside the positive case above (design note iv): editing the field
  // an ORDINARY failing review also writes must not corrupt that ordinary path. Fully
  // non-responsive report so the named criterion reads unmet, with NO changeset contradiction in
  // play at all.
  const criteria: AcceptanceCriterion[] = [{ claim: "the widget renders correctly", proof: "widget renders correctly on load" }];
  const v = judgeReview(criteria, { diff: "", report: "REPORT\nAn unrelated refactor of the plan loader.\nPR_URL: https://github.com/o/r/pull/1" });
  assert.equal(v.state, "failure", v.summary);
  assert.equal(v.changesetContradictions?.length ?? 0, 0, "this fixture carries no changeset contradiction at all");

  const reasons = reviewLedgerReasons(v);
  assert.deepEqual(
    reasons,
    v.criteria.filter((c) => !c.met).map((c) => c.reason),
    "byte-identical to the pre-W1-T1016 per-criterion rule — untouched by the contradiction fallback",
  );
  assert.notEqual(reasons[0], v.summary, "an ordinary unmet criterion's own reason, never the verdict summary");
});

test("ACCEPTANCE 2: Standing rule 15 tampering (no unmet named criterion) carries failure_class=criteria_tampered", () => {
  const mixedDiff = `
diff --git a/plan/tasks.yaml b/plan/tasks.yaml
+++ b/plan/tasks.yaml
@@
-      proof: "the old proof"
+      proof: "the new proof, rewritten to match the diff"
diff --git a/src/lib/widget.ts b/src/lib/widget.ts
+++ b/src/lib/widget.ts
@@
+export function frobnicate() {}
`.trim();
  const v = judgeReview(ONE_CRITERION, { diff: mixedDiff, report: RESPONSIVE_REPORT });
  assert.ok(v.criteria.every((c) => c.met));
  assert.equal(v.criteriaTampered, true);
  assert.equal(v.state, "failure");
  const fields = reviewLedgerLegibilityFields(v);
  assert.equal(fields.failure_class, "criteria_tampered");
  assert.equal(fields.failure_reason, v.summary);
  assert.match(fields.failure_reason!, /standing rule 15/i);
});

test("ACCEPTANCE 2: instrument entanglement (Standing rule 25, no unmet named criterion) carries failure_class=instrument_entangled", () => {
  const entangledDiff = `
diff --git a/scripts/coverage-ratchet.mjs b/scripts/coverage-ratchet.mjs
+++ b/scripts/coverage-ratchet.mjs
@@
-const FLOOR = 89.64;
+const FLOOR = 82.75;
diff --git a/src/lib/widget.ts b/src/lib/widget.ts
+++ b/src/lib/widget.ts
@@
+export function frobnicate() {}
`.trim();
  const v = judgeReview(ONE_CRITERION, { diff: entangledDiff, report: RESPONSIVE_REPORT });
  assert.ok(v.criteria.every((c) => c.met));
  assert.equal(v.instrumentEntangled, true);
  assert.equal(v.state, "failure");
  const fields = reviewLedgerLegibilityFields(v);
  assert.equal(fields.failure_class, "instrument_entangled");
  assert.equal(fields.failure_reason, v.summary);
  assert.match(fields.failure_reason!, /entangled/i);
});

test("ACCEPTANCE 2: a visible-pass + holdout-fail verdict (W1-T166) carries failure_class=holdout_unmet", () => {
  const criteria: AcceptanceCriterion[] = [
    { claim: "the widget renders correctly", proof: "widget renders correctly on load" },
    { claim: "HOLDOUT-SECRET-CRITERION-never-shown", proof: "HOLDOUT-SECRET-PROOF-never-shown", holdout: true },
  ];
  const report = "REPORT: the widget renders correctly on load.\nPR_URL: https://github.com/o/r/pull/1";
  const v = judgeReview(criteria, { diff: "", report });
  assert.equal(v.state, "failure");
  const fields = reviewLedgerLegibilityFields(v);
  assert.equal(fields.failure_class, "holdout_unmet");
  assert.equal(fields.failure_reason, v.summary);
  // The reason names the redacted holdout count without leaking the holdout claim (W1-T166).
  assert.doesNotMatch(fields.failure_reason!, /HOLDOUT-SECRET/);
  assert.match(fields.failure_reason!, /holdout criterion unmet/i);
});

test("ACCEPTANCE 2: test theater with every named criterion met carries failure_class=test_theater", () => {
  const theaterDiff = `
diff --git a/test/foo.test.ts b/test/foo.test.ts
+++ b/test/foo.test.ts
@@
+import { test } from "node:test";
+test("does something", () => {
+  const x = compute();
+  // looks tested, asserts nothing
+});
`.trim();
  const v = judgeReview(ONE_CRITERION, { diff: theaterDiff, report: RESPONSIVE_REPORT });
  assert.ok(v.criteria.every((c) => c.met));
  assert.equal(v.testTheater, true);
  assert.equal(v.state, "failure");
  const fields = reviewLedgerLegibilityFields(v);
  assert.equal(fields.failure_class, "test_theater");
  assert.equal(fields.failure_reason, v.summary);
  assert.match(fields.failure_reason!, /test theater/i);
});

test("ACCEPTANCE 2: an ordinary unmet named criterion carries failure_class=unmet_criteria (the pre-existing unmet_criteria/reasons arrays are untouched, this rides alongside them)", () => {
  const criteria: AcceptanceCriterion[] = [
    { claim: "the widget renders correctly", proof: "widget renders correctly on load" },
  ];
  // Fully non-responsive: the report never echoes the proof's distinctive keywords.
  const v = judgeReview(criteria, { diff: "", report: "REPORT\nAn unrelated refactor of the plan loader.\nPR_URL: https://github.com/o/r/pull/1" });
  assert.equal(v.state, "failure", v.summary);
  const fields = reviewLedgerLegibilityFields(v);
  assert.equal(fields.failure_class, "unmet_criteria");
  assert.equal(fields.failure_reason, v.summary);
});

test("ACCEPTANCE 2: empty acceptance criteria (fail closed) carries failure_class=no_criteria", () => {
  const v = judgeReview([], { diff: "", report: RESPONSIVE_REPORT });
  assert.equal(v.state, "failure");
  const fields = reviewLedgerLegibilityFields(v);
  assert.equal(fields.failure_class, "no_criteria");
  assert.equal(fields.failure_reason, v.summary);
});

test("ACCEPTANCE 2: reviewFailureClass mirrors failSummary's own precedence — criteriaTampered still wins when a changeset contradiction is ALSO present", () => {
  const cls = reviewFailureClass({
    criteria: [{ met: true, holdout: false }],
    criteriaTampered: true,
    changesetContradictions: [{ claim: "x", files: ["y"] } as never],
    instrumentEntangled: false,
  });
  assert.equal(cls, "criteria_tampered");
});

test("a PASSING verdict never carries failure_class/failure_reason — absent, never null/empty, exactly like capped_reason's existing discipline", () => {
  const v = judgeReview(ONE_CRITERION, { diff: "", report: RESPONSIVE_REPORT });
  assert.equal(v.state, "success", v.summary);
  const fields = reviewLedgerLegibilityFields(v);
  assert.equal(fields.failure_class, undefined);
  assert.equal(fields.failure_reason, undefined);
});

// ── acceptance criterion 3: the FULL reason, not the 140-char status description ──

test("ACCEPTANCE 3: the ledgered failure_reason is the FULL text — the instrument-entanglement message alone exceeds GitHub's 140-char status-description limit and is NOT truncated", () => {
  // W1-T297's own instrument-entanglement message names the offending paths AND
  // states the resolution in full prose — comfortably over 140 characters on its
  // own, with no budget-slicing applied anywhere in failSummary's branch for it
  // (unlike the ordinary unmet-criterion branch, which DOES slice its first claim
  // to fit the posted status). This is exactly the #1193 rationale's shape: "the
  // status description is a 140-character field that truncates the reason anyway."
  const entangledDiff = `
diff --git a/scripts/coverage-ratchet.mjs b/scripts/coverage-ratchet.mjs
+++ b/scripts/coverage-ratchet.mjs
@@
-const FLOOR = 89.64;
+const FLOOR = 82.75;
diff --git a/src/lib/widget.ts b/src/lib/widget.ts
+++ b/src/lib/widget.ts
@@
+export function frobnicate() {}
`.trim();
  const v = judgeReview(ONE_CRITERION, { diff: entangledDiff, report: RESPONSIVE_REPORT });
  assert.equal(v.state, "failure");
  const fields = reviewLedgerLegibilityFields(v);
  // The SAME 140-char cap `postReviewStatus` applies to the posted GitHub
  // description (STATUS_DESC_MAX in src/lib/review.ts) would have silently
  // dropped the tail of this reason — the ledgered field must not.
  const GITHUB_STATUS_DESC_MAX = 140;
  assert.ok(fields.failure_reason!.length > GITHUB_STATUS_DESC_MAX, "the ledgered reason exceeds the status-description limit");
  assert.notEqual(
    fields.failure_reason,
    fields.failure_reason!.slice(0, GITHUB_STATUS_DESC_MAX),
    "the ledgered reason is not what a 140-char-truncated description would have kept",
  );
  assert.match(fields.failure_reason!, /revert the instrument hunk here/, "the tail that a 140-char slice would have dropped survives in the ledgered field");
});
