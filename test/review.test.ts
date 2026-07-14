import assert from "node:assert/strict";
import { test } from "node:test";
import type { AcceptanceCriterion } from "../src/lib/plan.js";
import {
  REVIEW_CONTEXT,
  buildReviewPrompt,
  detectTestTheater,
  judgeReview,
  parseAcceptanceBlock,
  parseReviewerVerdicts,
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
});
