import assert from "node:assert/strict";
import { test } from "node:test";
import type { AcceptanceCriterion } from "../src/lib/plan.js";
import { bodyContradictsDiff, failSummary, judgeReview } from "../src/lib/review.js";

// ── W1-T274 ──────────────────────────────────────────────────────────────────
//
// TWO MERGED INSTANCES, both the same week: #974 claimed "exactly one file:
// MASTER-PLAN.md. No src/, no test/, no docs/ORIENTATION.md" over a diff that
// carried THREE files including docs/ORIENTATION.md; #1025 claimed "data-only:
// no code" while reverting 6 src/ + 2 test/ files. `judgeReview` already held
// the parsed changeset (`diffFiles`) and the body (`evidence.report`) in the
// same function and compared neither against the other — this is that
// comparison. See {@link bodyContradictsDiff}'s own doc comment in
// src/lib/review.ts for the exact, deliberately narrow set of claim shapes
// recognised (a stated file count, a "no <path>"/"plan-only"/"data-only"
// absence claim, a named file in an "exactly N files: …" enumeration) and why
// anything else is silence, never a verdict.

// A single-keyword proof ("report") so the criterion is trivially, always
// satisfied by any REPORT-headed body below — every fixture in this file
// isolates the changeset-claim check as the ONLY thing that can flip `state`.
const CRITERIA: AcceptanceCriterion[] = [{ claim: "a report was filed", proof: "report" }];

const RESPONSIVE_REPORT = `
REPORT
The fix lands in the diff below.
PR_URL: https://github.com/o/r/pull/1
`.trim();

// Reproduces #974's actual shape: a 3-file diff (MASTER-PLAN.md, plan/tasks.yaml,
// docs/ORIENTATION.md).
const THREE_FILE_DIFF = `
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
const THREE_FILE_DIFF_FILES = ["MASTER-PLAN.md", "plan/tasks.yaml", "docs/ORIENTATION.md"];

// Reproduces #1025's actual shape: 6 src/ + 2 test/ files reverted.
const EIGHT_FILE_REVERT_DIFF = `
diff --git a/src/lib/a.ts b/src/lib/a.ts
+++ b/src/lib/a.ts
@@
-export function a() {}
diff --git a/src/lib/b.ts b/src/lib/b.ts
+++ b/src/lib/b.ts
@@
-export function b() {}
diff --git a/src/lib/c.ts b/src/lib/c.ts
+++ b/src/lib/c.ts
@@
-export function c() {}
diff --git a/src/lib/d.ts b/src/lib/d.ts
+++ b/src/lib/d.ts
@@
-export function d() {}
diff --git a/src/lib/e.ts b/src/lib/e.ts
+++ b/src/lib/e.ts
@@
-export function e() {}
diff --git a/src/lib/f.ts b/src/lib/f.ts
+++ b/src/lib/f.ts
@@
-export function f() {}
diff --git a/test/a.test.ts b/test/a.test.ts
+++ b/test/a.test.ts
@@
-test("a", () => {});
diff --git a/test/b.test.ts b/test/b.test.ts
+++ b/test/b.test.ts
@@
-test("b", () => {});
`.trim();
const EIGHT_FILE_REVERT_DIFF_FILES = [
  "src/lib/a.ts",
  "src/lib/b.ts",
  "src/lib/c.ts",
  "src/lib/d.ts",
  "src/lib/e.ts",
  "src/lib/f.ts",
  "test/a.test.ts",
  "test/b.test.ts",
];

// A single-file, plan-only-shaped diff — used for the "no claim contradicted"
// (silent) and "plan-only, and it's TRUE" fixtures.
const PLAN_ONLY_DIFF = `
diff --git a/plan/tasks.yaml b/plan/tasks.yaml
+++ b/plan/tasks.yaml
@@
+- id: W1-T999
+  title: "a filed task, not yet implemented"
`.trim();

// A single src/ file diff, for the "no src/" contradiction fixture.
const SRC_FILE_DIFF = `
diff --git a/src/lib/widget.ts b/src/lib/widget.ts
+++ b/src/lib/widget.ts
@@
+export function frobnicate() {}
`.trim();

// ── bodyContradictsDiff: unit fixtures ──────────────────────────────────────

test("bodyContradictsDiff: #974's own shape — 'exactly one file: MASTER-PLAN.md' over a 3-file diff is a count contradiction AND 'no docs/ORIENTATION.md' is a named-absence contradiction (docs/ORIENTATION.md IS in the diff)", () => {
  const body = "exactly one file: MASTER-PLAN.md. No src/, no test/, no docs/ORIENTATION.md.";
  const contradictions = bodyContradictsDiff(body, THREE_FILE_DIFF_FILES);
  assert.ok(contradictions.length >= 2, `expected at least 2 contradictions, got ${JSON.stringify(contradictions)}`);
  const countHit = contradictions.find((c) => /exactly one file/i.test(c.claim));
  assert.ok(countHit, "the file-count claim ('exactly one file') must be flagged");
  assert.deepEqual(new Set(countHit.files), new Set(THREE_FILE_DIFF_FILES), "the count claim's refuting files are the ACTUAL changeset");
  const namedFileHit = contradictions.find((c) => /docs\/ORIENTATION\.md/.test(c.claim));
  assert.ok(namedFileHit, "the 'no docs/ORIENTATION.md' claim must be flagged — that file IS in the diff");
  assert.deepEqual(namedFileHit.files, ["docs/ORIENTATION.md"]);
});

test("bodyContradictsDiff: #1025's own shape — 'data-only: no code' over a diff reverting src/+test/ files is flagged, naming the reverted files", () => {
  const body = "data-only: no code. Reverts stale exports.";
  const contradictions = bodyContradictsDiff(body, EIGHT_FILE_REVERT_DIFF_FILES);
  assert.ok(contradictions.length > 0);
  for (const c of contradictions) {
    assert.deepEqual(new Set(c.files), new Set(EIGHT_FILE_REVERT_DIFF_FILES), "every src/+test/ file refutes the data-only/no-code claim");
  }
});

test("bodyContradictsDiff: acceptance criterion 1 — a bare file-count claim that disagrees with the diff is flagged even with no absence language at all", () => {
  const contradictions = bodyContradictsDiff("This PR touches exactly two files.", ["a.ts", "b.ts", "c.ts"]);
  assert.equal(contradictions.length, 1);
  assert.match(contradictions[0].claim, /exactly two files/i);
});

test("bodyContradictsDiff: a file-count claim that MATCHES the diff is not flagged", () => {
  const contradictions = bodyContradictsDiff("This PR touches exactly two files.", ["a.ts", "b.ts"]);
  assert.deepEqual(contradictions, []);
});

test("bodyContradictsDiff: acceptance criterion 2 — 'no src/' over a diff that DOES touch src/ is flagged, naming the offending src file(s)", () => {
  const contradictions = bodyContradictsDiff("Plan-only edit. No src/ changes here.", ["src/lib/widget.ts", "plan/tasks.yaml"]);
  const hit = contradictions.find((c) => /no src\//i.test(c.claim));
  assert.ok(hit, `expected a 'no src/' contradiction, got ${JSON.stringify(contradictions)}`);
  assert.deepEqual(hit.files, ["src/lib/widget.ts"]);
});

test("bodyContradictsDiff: 'no src/' is TRUE and not flagged when the diff genuinely touches no src/ file", () => {
  const contradictions = bodyContradictsDiff("No src/ changes here.", ["plan/tasks.yaml", "MASTER-PLAN.md"]);
  assert.deepEqual(contradictions, []);
});

test("bodyContradictsDiff: 'plan-only' is flagged when the diff touches a non-plan-scope file", () => {
  const contradictions = bodyContradictsDiff("plan-only change.", ["src/lib/widget.ts"]);
  const hit = contradictions.find((c) => c.claim === "plan-only");
  assert.ok(hit);
  assert.deepEqual(hit.files, ["src/lib/widget.ts"]);
});

test("bodyContradictsDiff: 'plan-only' is TRUE and not flagged when every changed file is in plan scope", () => {
  const contradictions = bodyContradictsDiff("plan-only change.", ["plan/tasks.yaml", "MASTER-PLAN.md"]);
  assert.deepEqual(contradictions, []);
});

test("bodyContradictsDiff acceptance criterion 3 — a report making NO changeset claim at all is silent ([]), regardless of what the diff actually contains", () => {
  const prose = "Refactored the plan loader and tidied the dependency-gating helpers. All tests pass.";
  assert.deepEqual(bodyContradictsDiff(prose, ["src/lib/a.ts", "test/a.test.ts"]), []);
  assert.deepEqual(bodyContradictsDiff(prose, []), []);
});

test("bodyContradictsDiff: prose this check cannot decide ('no bugs', 'no issues', 'no regressions') stays silent — a bare English word after 'no' is never treated as a path claim", () => {
  const body = "No bugs found. No issues. No regressions expected.";
  assert.deepEqual(bodyContradictsDiff(body, ["src/lib/widget.ts"]), []);
});

test("bodyContradictsDiff acceptance criterion 4 — the returned contradiction NAMES the contradicted claim text AND the actual files that refute it", () => {
  const contradictions = bodyContradictsDiff("exactly one file: MASTER-PLAN.md.", THREE_FILE_DIFF_FILES);
  assert.equal(contradictions.length, 1);
  assert.match(contradictions[0].claim, /exactly one file/i);
  assert.deepEqual(new Set(contradictions[0].files), new Set(THREE_FILE_DIFF_FILES));
});

// ── judgeReview integration: the check is BINDING (a genuine block, not a downgrade) ──

test("judgeReview: a body contradicting its own diff FORCES state=failure and floorState=failure, even though the criterion itself is otherwise fully met", () => {
  const body = `${RESPONSIVE_REPORT}\n\nexactly one file: MASTER-PLAN.md. No src/, no test/, no docs/ORIENTATION.md.`;
  const v = judgeReview(CRITERIA, { diff: THREE_FILE_DIFF, report: body });
  assert.ok(v.criteria.every((c) => c.met), "the named criterion is unaffected — this is a SEPARATE, binding gate");
  assert.equal(v.state, "failure");
  assert.equal(v.floorState, "failure", "structural (diff+report-derived), never suppressible by verdict stability (W1-T178)");
  assert.ok(v.changesetContradictions && v.changesetContradictions.length > 0);
});

test("judgeReview acceptance criterion 4 (posted summary): the FAIL summary names the contradicted claim and the actual changed files", () => {
  const body = "exactly one file: MASTER-PLAN.md.";
  const v = judgeReview(CRITERIA, { diff: THREE_FILE_DIFF, report: body });
  assert.equal(v.state, "failure");
  assert.match(v.summary, /body contradicts its own diff/i);
  assert.match(v.summary, /exactly one file/i);
  assert.match(v.summary, /MASTER-PLAN\.md/);
});

test("judgeReview: '#1025 shape' — 'data-only: no code' over a diff that reverts src/+test/ files fails the review", () => {
  const body = "data-only: no code.";
  const v = judgeReview(CRITERIA, { diff: EIGHT_FILE_REVERT_DIFF, report: body });
  assert.equal(v.state, "failure");
  assert.ok(v.changesetContradictions && v.changesetContradictions.length > 0);
});

test("judgeReview acceptance criterion 3: a body making no changeset claim is neither passed nor failed BY THIS CHECK — state is driven only by the named criteria/testTheater/etc., unaffected by changesetContradictions", () => {
  const v = judgeReview(CRITERIA, { diff: SRC_FILE_DIFF, report: RESPONSIVE_REPORT });
  assert.deepEqual(v.changesetContradictions, []);
  assert.equal(v.state, "success", v.summary);
});

test("judgeReview: a genuinely plan-only PR that TRUTHFULLY says 'plan-only' is not flagged", () => {
  const v = judgeReview(CRITERIA, { diff: PLAN_ONLY_DIFF, report: `${RESPONSIVE_REPORT}\n\nThis is a plan-only change.` });
  assert.deepEqual(v.changesetContradictions, []);
});

test("judgeReview: 'no src/' claimed over a diff that DOES touch src/ fails the review even when headCheckoutDir/execCtx is absent (the keyword-only path)", () => {
  const v = judgeReview(CRITERIA, {
    diff: SRC_FILE_DIFF,
    report: `${RESPONSIVE_REPORT}\n\nNo src/ changes in this PR.`,
  });
  assert.equal(v.state, "failure");
  assert.match(v.summary, /no src\//i);
});

// ── failSummary: the naming contract, isolated from judgeReview's rollup ───

test("failSummary: changesetContradictions takes priority right after criteriaTampered and names the claim + up to 3 refuting files, with an overflow count", () => {
  const s = failSummary(
    [],
    false,
    false,
    false,
    0,
    [{ claim: "exactly one file: MASTER-PLAN.md", files: ["MASTER-PLAN.md", "plan/tasks.yaml", "docs/ORIENTATION.md", "extra.ts"] }],
  );
  assert.match(s, /body contradicts its own diff/i);
  assert.match(s, /exactly one file: MASTER-PLAN\.md/);
  assert.match(s, /\+1 more/);
});

test("failSummary: criteriaTampered still takes priority over a changeset contradiction (Standing rule 15 is the more severe violation)", () => {
  const s = failSummary([], false, false, true, 0, [{ claim: "plan-only", files: ["src/x.ts"] }]);
  assert.match(s, /Standing rule 15/i);
  assert.doesNotMatch(s, /body contradicts its own diff/i);
});

// ── SUBJECT ANCHORING (the PR #1077 false positive) ──────────────────────────
//
// The count pattern had no SUBJECT: "exactly one file" reads identically whether the sentence is
// about the diff or about anything else. PR #1077 said "Each unit-test proof resolves to exactly
// one file" — about PROOF CANDIDATE RESOLUTION — over a 7-file diff, and was posted `failure`
// while its own verdict recorded 5/5 executed_pass and zero unmet criteria. Nothing retried it.

test("bodyContradictsDiff: a count claim about something OTHER than the changeset is SILENT (the #1077 false positive)", () => {
  const body =
    "Each unit-test proof resolves to exactly one file and matches exactly 1 test; the zero-match control returns 0.";
  assert.deepEqual(
    bodyContradictsDiff(body, ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.md", "g.md"]),
    [],
    "a sentence about proof resolution is not a claim about the changeset — silence, not a verdict",
  );
});

test("bodyContradictsDiff: an ENUMERATED count claim is still caught without any changeset word (the #974 shape)", () => {
  const hits = bodyContradictsDiff("exactly one file: MASTER-PLAN.md", ["MASTER-PLAN.md", "docs/ORIENTATION.md"]);
  assert.equal(hits.length, 1, "the enumeration is unambiguous on its own — this is what the check was built for");
  assert.match(hits[0].claim, /exactly one file: MASTER-PLAN\.md/);
});

test("bodyContradictsDiff: a PROSE count claim in changeset context is still caught", () => {
  for (const body of [
    "This PR changes exactly one file.",
    "git show --stat listed exactly one file.",
    "The diff touches exactly two files.",
  ]) {
    assert.equal(bodyContradictsDiff(body, ["a.ts", "b.ts", "c.ts"]).length, 1, `must still catch: ${body}`);
  }
});

test("bodyContradictsDiff: changeset context does not leak across a sentence boundary", () => {
  // The changeset word belongs to the PREVIOUS sentence; the claim itself is about tests.
  const body = "This PR changes seven files. Each proof resolves to exactly one file.";
  assert.deepEqual(
    bodyContradictsDiff(body, ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts", "g.ts"]),
    [],
    "scanning the whole body would re-create the unanchored match — every PR body says 'changes' somewhere",
  );
});

test("bodyContradictsDiff: BACKTICKED paths in an enumeration are not a contradiction (PR #1192)", () => {
  // The live fixture, verbatim. W1-T288's PR enumerated exactly its three changed files in this
  // repo's own house style — in backticks — and was posted `failure` for a claim that was TRUE.
  // The items arrived as "`src/lib/serve.ts`" while diffFiles holds bare paths, so `includes`
  // missed every one of them.
  const body =
    "This PR touches exactly 3 files: `src/lib/panel-actions.ts`, `src/lib/serve.ts`, " +
    "`test/control-status-daemon-liveness.test.ts`.";
  const diff = ["src/lib/panel-actions.ts", "src/lib/serve.ts", "test/control-status-daemon-liveness.test.ts"];

  assert.deepEqual(bodyContradictsDiff(body, diff), [], "a true enumeration must be silence, whatever the quoting");
});

test("bodyContradictsDiff: stripping backticks does NOT blind the check to a genuinely wrong file", () => {
  // The other half — the strip must not become a way to smuggle a false claim past the gate.
  const body = "This PR touches exactly 2 files: `src/lib/serve.ts`, `src/lib/NOT-IN-DIFF.ts`.";
  const hits = bodyContradictsDiff(body, ["src/lib/serve.ts", "src/lib/panel-actions.ts"]);
  assert.equal(hits.length, 1, "a backticked file that is not in the diff is still a contradiction");
});

test("bodyContradictsDiff: the sentence's full stop sits OUTSIDE the closing backtick", () => {
  // Order-of-operations guard: stripping backticks before trailing punctuation would leave the
  // dot stranded on the final item ("serve.ts`." -> "serve.ts`" -> ... -> "serve.ts.") and
  // re-introduce the false positive for one-item and last-item enumerations only.
  assert.deepEqual(bodyContradictsDiff("This PR touches exactly 1 file: `src/lib/serve.ts`.", ["src/lib/serve.ts"]), []);
});
