import assert from "node:assert/strict";
import { test } from "node:test";
import type { AcceptanceCriterion } from "../src/lib/plan.js";
import {
  REVIEW_CONTEXT,
  buildReviewPrompt,
  checkCallersAudited,
  checkOneConcern,
  checkRefactorHonesty,
  checkSatisfiedByGuard,
  checkTestTheater,
  detectTestTheater,
  failSummary,
  judgeReview,
  judgeRubric,
  parseAcceptanceBlock,
  parseReviewerVerdicts,
  reviewerOutcome,
  reviewerVerdictContract,
} from "../src/lib/review.js";

// ── Recorded fixtures (acceptance #2, the FALSIFIER) ────────────────────────
// The verdict LOGIC is a PURE function so the falsifier is a unit fixture: a
// diff that passes tests while ignoring a stated acceptance criterion — or one
// whose tests assert nothing — must yield state=failure; a responsive+proven
// criterion must yield state=success. These fixtures are (criterion, diff,
// report) tuples, exactly as the design specifies.

const CRITERIA: AcceptanceCriterion[] = [
  {
    claim: "a REVIEW worker posts remudero-review to the PR head commit",
    proof: "gh api .../statuses/<sha> shows context=remudero-review with a state on a real PR",
  },
  {
    claim: "the reviewer never edits code",
    proof: "worker settings/transcript show no write tool used; the PR head sha is unchanged",
  },
];

// A REPORT that PASTES responsive evidence for both criteria.
const RESPONSIVE_REPORT = `
REPORT
- Posted the remudero-review status to the head commit:
  gh api repos/o/r/statuses/abc123 -f context=remudero-review -f state=success
- Reviewer used only read-only tools; the worker settings show no write tool and the
  PR head sha is unchanged after review (transcript attached).
PR_URL: https://github.com/o/r/pull/7
`.trim();

// A REPORT that PASSES CI but is NON-RESPONSIVE: it ignores the stated proofs
// entirely (talks about an unrelated refactor).
const NON_RESPONSIVE_REPORT = `
REPORT
- Refactored the plan loader and tidied the dependency-gating helpers.
- All existing unit tests pass; typecheck is clean.
PR_URL: https://github.com/o/r/pull/7
`.trim();

// A diff whose added test asserts NOTHING (test theater).
const THEATER_DIFF = `
diff --git a/test/foo.test.ts b/test/foo.test.ts
+++ b/test/foo.test.ts
@@
+import { test } from "node:test";
+test("does something", () => {
+  const x = compute();
+  // looks tested, asserts nothing
+});
`.trim();

// A diff with a REAL assertion.
const REAL_TEST_DIFF = `
diff --git a/test/foo.test.ts b/test/foo.test.ts
+++ b/test/foo.test.ts
@@
+import assert from "node:assert/strict";
+import { test } from "node:test";
+test("computes", () => {
+  assert.equal(compute(), 42);
+});
`.trim();

test("REVIEW_CONTEXT is the exact commit-status context the gate keys on", () => {
  assert.equal(REVIEW_CONTEXT, "remudero-review");
});

test("FALSIFIER: a non-responsive report (proof unpasted) yields state=failure", () => {
  const v = judgeReview(CRITERIA, { diff: REAL_TEST_DIFF, report: NON_RESPONSIVE_REPORT });
  assert.equal(v.state, "failure");
  assert.ok(v.criteria.some((c) => !c.met), "at least one criterion is judged unmet");
});

test("a responsive + proven report over the SAME criteria yields state=success", () => {
  const v = judgeReview(CRITERIA, { diff: REAL_TEST_DIFF, report: RESPONSIVE_REPORT });
  assert.equal(v.state, "success", v.summary);
  assert.ok(v.criteria.every((c) => c.met));
  assert.equal(v.testTheater, false);
});

test("FALSIFIER: test theater (assertions that assert nothing) yields state=failure", () => {
  // The report is fully responsive, so ONLY the test theater can fail this.
  const v = judgeReview(CRITERIA, { diff: THEATER_DIFF, report: RESPONSIVE_REPORT });
  assert.equal(v.state, "failure");
  assert.equal(v.testTheater, true);
});

test("detectTestTheater: a real assertion in a test file is NOT theater", () => {
  assert.equal(detectTestTheater(REAL_TEST_DIFF), false);
});

test("detectTestTheater: a literal no-op assertion assert(true) IS theater", () => {
  const diff = [
    "+++ b/test/x.test.ts",
    '+test("noop", () => {',
    "+  assert.ok(true);",
    "+});",
  ].join("\n");
  assert.equal(detectTestTheater(diff), true);
});

test("detectTestTheater: a diff that touches no test file is not theater", () => {
  const diff = ["+++ b/src/lib/thing.ts", "+export const x = 1;"].join("\n");
  assert.equal(detectTestTheater(diff), false);
});

test("empty acceptance criteria fail closed (nothing to judge is never a pass)", () => {
  const v = judgeReview([], { diff: REAL_TEST_DIFF, report: RESPONSIVE_REPORT });
  assert.equal(v.state, "failure");
});

test("NORMALIZE: `maxTurns` in a criterion matches `max_turns` in the report (case/separator-insensitive)", () => {
  // The knob is the SAME (maxTurns ≡ max_turns ≡ max-turns); only spelling differs.
  // This is the weakness that false-blocked PR #42 (W1-T5).
  const criteria = [
    { claim: "the mount resolves maxTurns", proof: "resolver returns maxTurns and context_budget per mount" },
  ];
  const met = judgeReview(criteria, {
    diff: "",
    report: "the resolver returns max_turns and context-budget per mount", // snake + kebab spellings
  });
  assert.equal(met.state, "success", met.summary);
  // A genuinely-absent term still FAILS — normalization must not manufacture a false PASS.
  const absent = judgeReview(criteria, { diff: "", report: "an unrelated change to the plan loader" });
  assert.equal(absent.state, "failure");
});

test("satisfied_by (Architect-only): a criterion already met by an earlier PR is MET, cited to that PR", () => {
  const criteria: AcceptanceCriterion[] = [
    // A proof the report does NOT substantiate — it would fail on keyword coverage —
    // but it was already shipped in an earlier PR, so the Architect marks it satisfied.
    {
      claim: "the PR #12 dead-doc golden fixture yields state=failure",
      proof: "golden test over PR #12 single-doc diff in test/review.test.ts",
      satisfied_by: "#16",
    },
  ];
  const v = judgeReview(criteria, { diff: "", report: "an unrelated report about something else entirely" });
  assert.equal(v.state, "success", v.summary);
  assert.equal(v.criteria[0].met, true);
  assert.match(v.criteria[0].reason, /satisfied by #16/);
});

test("a semantic verdict can only DOWNGRADE: reviewer 'not satisfied' forces failure", () => {
  // Mechanically substantiated, but the LLM reviewer judged the proof non-responsive.
  const v = judgeReview(CRITERIA, {
    diff: REAL_TEST_DIFF,
    report: RESPONSIVE_REPORT,
    semantic: [false, undefined],
  });
  assert.equal(v.state, "failure");
  assert.equal(v.criteria[0].met, false);
});

test("a semantic PASS cannot rescue an unpasted proof (proof must be pasted, not vibed)", () => {
  const v = judgeReview(CRITERIA, {
    diff: REAL_TEST_DIFF,
    report: NON_RESPONSIVE_REPORT,
    semantic: [true, true],
  });
  assert.equal(v.state, "failure");
});

test("parseReviewerVerdicts: FAIL downgrades that index; PASS/absent stay undefined (advisory floor)", () => {
  const text = [
    "REPORT",
    "REVIEW_VERDICT 1: PASS — proof pasted",
    "REVIEW_VERDICT 2: FAIL — proof never substantiated",
    "posted remudero-review=failure",
  ].join("\n");
  const s = parseReviewerVerdicts(text, 3);
  assert.deepEqual(s, [undefined, false, undefined]);
});

test("parseReviewerVerdicts: unparseable reviewer output leaves the floor untouched (all undefined)", () => {
  const s = parseReviewerVerdicts("the reviewer wandered off and emitted prose only", 2);
  assert.deepEqual(s, [undefined, undefined]);
});

test("parseReviewerVerdicts: an out-of-range index is ignored, is case-insensitive", () => {
  const s = parseReviewerVerdicts("review_verdict 1: fail\nREVIEW_VERDICT 9: FAIL", 2);
  assert.deepEqual(s, [false, undefined]);
});

test("a parsed FAIL, folded through judgeReview, downgrades an otherwise-substantiated criterion", () => {
  const semantic = parseReviewerVerdicts("REVIEW_VERDICT 1: FAIL", CRITERIA.length);
  const v = judgeReview(CRITERIA, { diff: REAL_TEST_DIFF, report: RESPONSIVE_REPORT, semantic });
  assert.equal(v.state, "failure");
  assert.equal(v.criteria[0].met, false);
});

test("reviewerVerdictContract: names the machine-readable line for each criterion", () => {
  const c = reviewerVerdictContract(2);
  assert.match(c, /REVIEW_VERDICT <n>: PASS/);
  assert.match(c, /REVIEW_VERDICT <n>: FAIL/);
  assert.match(c, /1\.\.2/);
});

// ── parseAcceptanceBlock: criteria for manual plan/doc PRs (from the PR body) ──

test("parseAcceptanceBlock: parses `- claim | proof` bullets under an Acceptance: header", () => {
  const body = [
    "## Summary",
    "Does a thing.",
    "",
    "Acceptance:",
    "- rmd review posts a status | gh api statuses shows context=remudero-review",
    "- fails closed with no criteria | a body with no Acceptance block yields failure",
    "",
    "Remudero-Task: none",
  ].join("\n");
  const c = parseAcceptanceBlock(body);
  assert.equal(c.length, 2);
  assert.equal(c[0].claim, "rmd review posts a status");
  assert.equal(c[0].proof, "gh api statuses shows context=remudero-review");
  assert.equal(c[1].claim, "fails closed with no criteria");
});

test("parseAcceptanceBlock: tolerates markdown header (**Acceptance:**, ## Acceptance criteria)", () => {
  assert.equal(parseAcceptanceBlock("**Acceptance:**\n- a | b").length, 1);
  assert.equal(parseAcceptanceBlock("## Acceptance criteria\n1. a | b\n2. c | d").length, 2);
});

test("parseAcceptanceBlock: a body with NO Acceptance block yields [] (which fails closed)", () => {
  const c = parseAcceptanceBlock("## Summary\nJust a docs tweak.\n\nRemudero-Task: none");
  assert.deepEqual(c, []);
  // And an empty criteria list is a FAILURE in judgeReview — nothing to judge is never a pass.
  assert.equal(judgeReview(c, { diff: "", report: "anything" }).state, "failure");
});

test("parseAcceptanceBlock: a bullet with no `|` keeps the whole line as the claim (proof empty)", () => {
  const c = parseAcceptanceBlock("Acceptance:\n- a claim with no explicit proof separator");
  assert.equal(c.length, 1);
  assert.equal(c[0].claim, "a claim with no explicit proof separator");
  assert.equal(c[0].proof, "");
});

// ── GOLDEN FIXTURE: PR #12 — a CI-green single-doc PR that satisfies zero criteria.
// PR #12 shipped ONLY docs/review-gate.md, passed CI, reported verdict=merged, and
// did none of W1-T1D's actual work. It is the canonical reviewer test case: if the
// reviewer cannot fail THAT, it cannot fail anything.
const PR12_SINGLE_DOC_DIFF = [
  "diff --git a/docs/review-gate.md b/docs/review-gate.md",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/docs/review-gate.md",
  "@@ -0,0 +1,3 @@",
  "+# Review-enforced merge gate (W1-T1D)",
  "+",
  "+`remudero-review` is a REQUIRED status check on `main`, alongside `ci`.",
].join("\n");

// PR #12's actual body — prose that DESCRIBES the mechanism but pastes no gh api
// output, no status object, no ledger. Describing is not proving.
const PR12_BODY = [
  "## W1-T1D — the gate enforces the reviewer",
  "Makes `remudero-review` a REQUIRED status check on `main`, alongside `ci`.",
  "This makes BOTH checks a GitHub-enforced contract; auto-merge is safe to leave armed.",
  "`required_status_checks.contexts` is updated to `[ci, remudero-review]` after this PR merges.",
  "Remudero-Task: W1-T1D",
].join("\n");

// W1-T1D's real acceptance criteria (plan/tasks.yaml) — the proofs demand OBSERVABLE
// SYSTEM STATE (gh api output, a planted-probe status, a ledger), which a doc lacks.
const W1T1D_CRITERIA: AcceptanceCriterion[] = [
  {
    claim: "protection requires exactly [ci, remudero-review]",
    proof:
      "gh api repos/craigoley/remudero/branches/main/protection --jq .required_status_checks.contexts",
  },
  {
    claim: "a PR that is CI-GREEN but FAILS acceptance is NOT merged (verified LIVE)",
    proof:
      "planted probe: an implement worker that passes tests but ignores a stated acceptance criterion remudero-review failure PR stays OPEN paste the status and PR state then close",
  },
  {
    claim: "a PR green on BOTH checks auto-merges with no runner-side merge call (verified LIVE)",
    proof: "ledger shows automerge.armed then pr.merged with no explicit merge command",
  },
];

test("GOLDEN (PR #12): a CI-green single-doc PR that satisfies zero criteria yields failure", () => {
  const v = judgeReview(W1T1D_CRITERIA, { diff: PR12_SINGLE_DOC_DIFF, report: PR12_BODY });
  assert.equal(v.state, "failure", v.summary);
  // Note: criterion 1's PROSE keyword-matches (the body names required_status_checks.contexts)
  // — exactly why a doc that DESCRIBES a mechanism is not proof it EXISTS. Criteria 2 & 3
  // (which demand a planted-probe status and a ledger) are unmet, so the verdict fails.
  assert.ok(v.criteria.some((c) => !c.met), "at least one criterion is unmet");
  // The gate TEACHES: the status description NAMES the first unmet criterion (criterion 2,
  // the first one the doc did not substantiate), not merely "N criteria unmet". Assert WHICH.
  const firstUnmet = v.criteria.find((c) => !c.met)!;
  assert.equal(firstUnmet.claim, W1T1D_CRITERIA[1].claim, "criterion 2 is the first unmet");
  assert.ok(
    v.summary.includes("a PR that is CI-GREEN but FAILS acceptance is NOT merged"),
    `summary must NAME the unmet criterion, got: ${v.summary}`,
  );
  assert.match(v.summary, /\(\+1 more\)/); // criterion 3 is also unmet
});

test("failure summary NAMES the first unmet criterion (not just a count)", () => {
  const criteria: AcceptanceCriterion[] = [
    { claim: "the widget is frobnicated", proof: "grep of src shows frobnicate(widget) called at the boundary" },
  ];
  // A report that does not substantiate the proof ⇒ the one criterion is unmet.
  const v = judgeReview(criteria, { diff: "", report: "did something else entirely" });
  assert.equal(v.state, "failure");
  assert.ok(v.summary.includes("the widget is frobnicated"), `got: ${v.summary}`);
  assert.doesNotMatch(v.summary, /more\)/); // only one unmet ⇒ no "(+N more)"
});

test("failSummary: names the first unmet, appends (+N more), and truncates a long claim within the limit", () => {
  const long = "x".repeat(300);
  const s = failSummary([long, "second", "third"], false, false);
  assert.ok(s.length <= 140, `status description must fit 140 chars, got ${s.length}`);
  assert.match(s, /…/); // the long claim is ellipsis-truncated
  assert.match(s, /\(\+2 more\)/);
  // empty-criteria and theater-only branches keep their explicit messages.
  assert.match(failSummary([], false, true), /no acceptance criteria to judge/);
  assert.match(failSummary([], true, false), /test theater/);
});

test("buildReviewPrompt: fresh, read-only, gh-only, posts remudero-review, never edits", () => {
  const prompt = buildReviewPrompt({
    task: { id: "W1-T9Z", acceptance: CRITERIA },
    prUrl: "https://github.com/o/r/pull/7",
    owner: "o",
    repo: "r",
    headSha: "abc123",
  });
  assert.match(prompt, /REVIEW worker/i);
  assert.match(prompt, /read-only/i);
  assert.match(prompt, /remudero-review/);
  assert.match(prompt, /statuses\/abc123/);
  // The reviewer must be told never to edit code.
  assert.match(prompt, /never (edit|modify)/i);
  // The stated proofs must be carried into the reviewer's prompt.
  assert.match(prompt, /context=remudero-review/);
  // The reviewer verifies against REPO STATE: check out the PR head and RUN the
  // proof's test/grep, not verdict on diff+report alone.
  assert.match(prompt, /repo state/i);
  assert.match(prompt, /checkout|check out/i);
  assert.match(prompt, /statuses\/abc123/); // still posts to the head sha
  // The checkout target is the head sha, and running tests/greps is allowed.
  assert.match(prompt, /gh pr checkout|git fetch origin abc123/);
});

// ── The reviewer RUBRIC (§5 layer 2): four judgment items + the satisfied_by guard ──
// Recorded (diff, report) tuples, exactly as the design specifies (W1-T3E). The rubric
// ADVISES (Standing rule 3B — the GitHub-enforced gate decides); each item is a
// deterministic, pure predicate so its falsifier is a unit fixture.

// A clean, single-concern feature diff: one product stem (`greet`), a real assertion,
// no signature drift, not labelled a refactor, no satisfied_by. All four items + the
// guard must pass — the positive control for the whole rubric.
const CLEAN_DIFF = [
  "diff --git a/src/lib/greet.ts b/src/lib/greet.ts",
  "+++ b/src/lib/greet.ts",
  "@@",
  "+export function greet(name) {",
  '+  return "hi " + name;',
  "+}",
  "diff --git a/test/greet.test.ts b/test/greet.test.ts",
  "+++ b/test/greet.test.ts",
  "@@",
  '+import assert from "node:assert/strict";',
  '+test("greet", () => {',
  '+  assert.equal(greet("x"), "hi x");',
  "+});",
].join("\n");
const CLEAN_REPORT = "REPORT — added greet(); red→green proof attached; one concern.";

// Two distinct product concerns (review + plan) in one PR.
const TWO_CONCERN_DIFF = [
  "diff --git a/src/lib/review.ts b/src/lib/review.ts",
  "+++ b/src/lib/review.ts",
  "@@",
  "+export const A = 1;",
  "diff --git a/src/lib/plan.ts b/src/lib/plan.ts",
  "+++ b/src/lib/plan.ts",
  "@@",
  "+export const B = 2;",
].join("\n");

// render() gains a required `opts` param; ONE call site is updated (the `+` line)
// but a sibling caller `render(z)` is left stale on an unchanged context line.
const CALLER_DRIFT_DIFF = [
  "diff --git a/src/lib/render.ts b/src/lib/render.ts",
  "+++ b/src/lib/render.ts",
  "@@",
  "-export function render(x) {",
  "+export function render(x, opts) {",
  "   return draw(x, opts);",
  " }",
  "@@",
  "-  render(a);",
  "+  render(a, defaults);",
  "@@",
  " function footer() {",
  "   render(z);",
  " }",
].join("\n");

// Same signature change, but every caller is updated — no stale sibling remains.
const CALLERS_AUDITED_DIFF = [
  "diff --git a/src/lib/render.ts b/src/lib/render.ts",
  "+++ b/src/lib/render.ts",
  "@@",
  "-export function render(x) {",
  "+export function render(x, opts) {",
  "   return draw(x, opts);",
  " }",
  "@@",
  "-  render(a);",
  "+  render(a, defaults);",
].join("\n");

// A behavior change (`+` → `-` on the returned expression) presented as a refactor.
const BEHAVIOR_REFACTOR_DIFF = [
  "diff --git a/src/lib/calc.ts b/src/lib/calc.ts",
  "+++ b/src/lib/calc.ts",
  "@@",
  "-  return a + b;",
  "+  return a - b;",
].join("\n");

// A genuine, behavior-preserving refactor: a function expression becomes an arrow;
// the one behavior-bearing line (`return a + b;`) is moved verbatim, not changed.
const PURE_REFACTOR_DIFF = [
  "diff --git a/src/lib/calc.ts b/src/lib/calc.ts",
  "+++ b/src/lib/calc.ts",
  "@@",
  "-function calc(a, b) {",
  "-  return a + b;",
  "-}",
  "+const calc = (a, b) => {",
  "+  return a + b;",
  "+};",
].join("\n");

// A diff that ADDS a satisfied_by line to plan/tasks.yaml.
const SATISFIED_BY_DIFF = [
  "diff --git a/plan/tasks.yaml b/plan/tasks.yaml",
  "+++ b/plan/tasks.yaml",
  "@@",
  '       proof: "some proof"',
  '+      satisfied_by: "#99"',
].join("\n");

test("rubric one-concern: a two-concern diff FAILS; a single-concern diff PASSES", () => {
  const two = checkOneConcern(TWO_CONCERN_DIFF);
  assert.equal(two.pass, false);
  assert.match(two.reason, /concern/i);
  assert.equal(checkOneConcern(CLEAN_DIFF).pass, true);
});

test("rubric callers-audited: an orphaned sibling caller FAILS; all-updated PASSES", () => {
  const drift = checkCallersAudited(CALLER_DRIFT_DIFF);
  assert.equal(drift.pass, false);
  assert.match(drift.reason, /render/);
  assert.equal(checkCallersAudited(CALLERS_AUDITED_DIFF).pass, true);
  assert.equal(checkCallersAudited(CLEAN_DIFF).pass, true);
});

test("rubric test-theater: an assert-nothing test FAILS; a real assertion PASSES", () => {
  assert.equal(checkTestTheater(THEATER_DIFF).pass, false);
  assert.equal(checkTestTheater(REAL_TEST_DIFF).pass, true);
});

test("rubric refactor-honesty: behavior change labelled 'refactor' FAILS; a pure move PASSES", () => {
  assert.equal(checkRefactorHonesty(BEHAVIOR_REFACTOR_DIFF, "Refactored calc for clarity").pass, false);
  // The SAME behavior-changing diff, NOT labelled a refactor, is not the rubric's business here.
  assert.equal(checkRefactorHonesty(BEHAVIOR_REFACTOR_DIFF, "Fixed the sign bug in calc").pass, true);
  // A genuine behavior-preserving refactor passes even when labelled one.
  assert.equal(checkRefactorHonesty(PURE_REFACTOR_DIFF, "Refactor: calc becomes an arrow fn").pass, true);
});

test("rubric satisfied_by guard: a worker-authored satisfied_by FAILS; a plan-only human PR PASSES", () => {
  // A worker (non-plan-only) adding satisfied_by to its own criterion = editing the criteria.
  const worker = checkSatisfiedByGuard(SATISFIED_BY_DIFF, { planOnly: false, humanAuthored: false });
  assert.equal(worker.pass, false);
  assert.match(worker.reason, /satisfied_by/);
  // The SAME addition in a plan-only, human-authored (Architect) PR is allowed.
  assert.equal(checkSatisfiedByGuard(SATISFIED_BY_DIFF, { planOnly: true, humanAuthored: true }).pass, true);
  // A diff that adds no satisfied_by never triggers the guard.
  assert.equal(checkSatisfiedByGuard(CLEAN_DIFF).pass, true);
});

test("judgeRubric: a clean single-concern diff passes ALL FOUR items + the guard", () => {
  const r = judgeRubric({ diff: CLEAN_DIFF, report: CLEAN_REPORT });
  assert.equal(r.pass, true, JSON.stringify(r.failures));
  assert.deepEqual(
    r.items.map((i) => i.key).sort(),
    ["callers-audited", "one-concern", "refactor-honesty", "satisfied-by-guard", "test-theater"],
  );
  assert.ok(r.items.every((i) => i.pass));
});

test("judgeRubric: each falsifier trips its own item and fails the whole rubric", () => {
  const twoConcern = judgeRubric({ diff: TWO_CONCERN_DIFF, report: "two things at once" });
  assert.equal(twoConcern.pass, false);
  assert.ok(twoConcern.failures.some((f) => f.key === "one-concern"));

  const drift = judgeRubric({ diff: CALLER_DRIFT_DIFF, report: "updated render" });
  assert.ok(drift.failures.some((f) => f.key === "callers-audited"));

  const theater = judgeRubric({ diff: THEATER_DIFF, report: "added a test" });
  assert.ok(theater.failures.some((f) => f.key === "test-theater"));

  const dishonest = judgeRubric({ diff: BEHAVIOR_REFACTOR_DIFF, report: "just a refactor" });
  assert.ok(dishonest.failures.some((f) => f.key === "refactor-honesty"));

  const sneaky = judgeRubric({ diff: SATISFIED_BY_DIFF, report: "unblock myself" });
  assert.ok(sneaky.failures.some((f) => f.key === "satisfied-by-guard"));
});

// ── reviewer_outcome (W1-T63/P10-a — the reviewer stops walling silently) ───
// A floor-only PASS must never be byte-identical, in the ledger or console, to a
// review the LLM reviewer actually completed. reviewerOutcome() is the pure seam
// review.posted (run-task.ts) reads to make that distinction legible.

test("reviewerOutcome: a reviewer that walled error_max_turns carries reviewer_outcome=error_max_turns", () => {
  assert.equal(
    reviewerOutcome({ attempted: true, subtype: "error_max_turns" }),
    "error_max_turns",
  );
});

test("reviewerOutcome: a reviewer that completed carries reviewer_outcome=success", () => {
  assert.equal(reviewerOutcome({ attempted: true, subtype: "success" }), "success");
});

test("reviewerOutcome: never attempted (spawnReviewer=false or no criteria) is distinct from either", () => {
  const outcome = reviewerOutcome({ attempted: false });
  assert.equal(outcome, "not_attempted");
  assert.notEqual(outcome, "success");
  assert.notEqual(outcome, "error_max_turns");
});

test("reviewerOutcome: a spawn that THREW (no subtype to report) is distinct from a subtype outcome", () => {
  const outcome = reviewerOutcome({ attempted: true, spawnError: true, subtype: undefined });
  assert.equal(outcome, "spawn_error");
});
