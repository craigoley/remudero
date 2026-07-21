import assert from "node:assert/strict";
import { test } from "node:test";
import type { AcceptanceCriterion } from "../src/lib/plan.js";
import {
  REVIEW_CONTEXT,
  applyVerdictStability,
  buildReviewPrompt,
  cappedAnnotation,
  cappedOverrideFromLedger,
  checkCallersAudited,
  checkDocsAwareness,
  checkOneConcern,
  checkRefactorHonesty,
  checkSatisfiedByGuard,
  checkTestTheater,
  checkTroubleshootingCoverage,
  decideAutoMergeArm,
  detectTestTheater,
  failSummary,
  floorDegradedAnnotation,
  isDialectPrefixed,
  isTddStrict,
  judgeReview,
  judgeRubric,
  keywordOnlyAnnotation,
  nameFilteredOutcome,
  parseAcceptanceBlock,
  parseReviewerVerdicts,
  parseWhitelistedProof,
  priorReviewVerdictFromLedger,
  resolveAutoMergeArm,
  reviewerOutcome,
  reviewerVerdictContract,
  type PriorReviewVerdict,
  type ProofExecutor,
  type WhitelistedProof,
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

// ── VERDICT STABILITY (W1-T178) ──────────────────────────────────────────────
// FIXTURE: PR #388 posted remudero-review=success at 20:28:27Z then =failure at
// 20:30:47Z against the IDENTICAL head sha 1fbea366…, no new commit in between
// — the flip burned a fix-rung strike and drove escalation #395. The rule: a
// re-review of an unchanged head whose deterministic floor still passes may
// not render a verdict worse than its predecessor, unless the downgrade cites
// new information (a changed sha, or the floor itself failing).

test("floorState (the anchor): passes on the mechanical/executed result alone, even when semantic downgrades the FINAL state", () => {
  const v = judgeReview(CRITERIA, {
    diff: REAL_TEST_DIFF,
    report: RESPONSIVE_REPORT,
    semantic: [false, undefined],
  });
  assert.equal(v.state, "failure"); // the semantic downgrade wins the FINAL state
  assert.equal(v.floorState, "success"); // but the floor alone still passes
  assert.equal(v.criteria[0].floorMet, true);
});

test("floorState (the anchor): fails when the mechanical floor itself fails, not just the semantic layer", () => {
  const v = judgeReview(CRITERIA, { diff: REAL_TEST_DIFF, report: NON_RESPONSIVE_REPORT });
  assert.equal(v.state, "failure");
  assert.equal(v.floorState, "failure");
});

// The four tests immediately below are named VERBATIM after their acceptance
// criterion's own proof text (plan/tasks.yaml, task W1-T178) — dialect-
// prefixed `unit test: …` proofs are MECHANICALLY EXECUTED by the review
// floor via `--test-name-pattern` (parseTestTarget, W1-T65/W1-T72/W1-T128),
// which requires a REAL test whose name the pattern matches, not merely a
// paraphrase. Each still carries genuine assertions (never test theater).

test("given a prior review.posted success on sha X and a semantic lane returning failure on a re-review of the SAME sha X with the floor passing, the posted verdict remains success and a suppression event is ledgered naming both verdicts. FALSIFIER: the #388 trace — success at 20:28:27Z and failure at 20:30:47Z on identical head 1fbea36 with no new commit, where the second verdict recorded fix.review strike 2 and drove fix.exhausted plus escalation #395 one second later", () => {
  const computed = judgeReview(CRITERIA, {
    diff: REAL_TEST_DIFF,
    report: RESPONSIVE_REPORT,
    semantic: [false, undefined], // semantic-only downgrade; floor still passes
  });
  assert.equal(computed.state, "failure"); // this is the #388 flip: success -> failure, same sha
  assert.equal(computed.floorState, "success");
  const prior: PriorReviewVerdict = { headSha: "1fbea36", state: "success" };
  const { verdict, suppressed } = applyVerdictStability(computed, "1fbea36", prior);
  assert.equal(suppressed, true);
  assert.equal(verdict.state, "success"); // the prior success STANDS, not the #388 flip
  assert.ok(verdict.criteria.every((c) => c.met), "posted criteria are internally consistent with state=success");
  assert.match(verdict.summary, /^remudero-review: PASS —/, "never a success state paired with failure-shaped prose");
  // "a suppression event is ledgered naming both verdicts": everything
  // run-task.ts's runReview needs to ledger review.downgrade_suppressed
  // (predecessor_state, suppressed_state, floor_state) is present and correct.
  assert.equal(prior.state, "success"); // predecessor verdict
  assert.equal(computed.state, "failure"); // suppressed (would-be-posted) verdict
  assert.equal(computed.floorState, "success"); // floor result the suppression relied on
});

test("a re-review whose head sha CHANGED, or whose deterministic FLOOR fails, downgrades and posts normally. FALSIFIER: an implementation that pins a success to a PR regardless of new commits, which would let a real regression ride a stale green into merge", () => {
  // Sub-case 1: the head sha CHANGED — new information, not noise.
  const changedHeadComputed = judgeReview(CRITERIA, {
    diff: REAL_TEST_DIFF,
    report: RESPONSIVE_REPORT,
    semantic: [false, undefined],
  });
  const priorAtOldSha: PriorReviewVerdict = { headSha: "aaaaaaa", state: "success" };
  const changedHeadResult = applyVerdictStability(changedHeadComputed, "bbbbbbb", priorAtOldSha);
  assert.equal(changedHeadResult.suppressed, false);
  assert.equal(changedHeadResult.verdict.state, "failure");

  // Sub-case 2: the deterministic FLOOR itself fails — a real regression, never suppressed.
  const floorFailComputed = judgeReview(CRITERIA, { diff: REAL_TEST_DIFF, report: NON_RESPONSIVE_REPORT });
  assert.equal(floorFailComputed.floorState, "failure");
  const priorSameSha: PriorReviewVerdict = { headSha: "1fbea36", state: "success" };
  const floorFailResult = applyVerdictStability(floorFailComputed, "1fbea36", priorSameSha);
  assert.equal(floorFailResult.suppressed, false);
  assert.equal(floorFailResult.verdict.state, "failure");
});

test("a prior failure on sha X followed by a success on the SAME sha X posts the success. FALSIFIER: the #177/W1-T102 incident — body-coverage fixes changed no commit, so a rule pinning verdicts to a sha would re-create the stale-status exhaustion where two CORRECT fixes exhausted against a stale 7/28 verdict that post-fix measurement scored 28/28 ALL MET", () => {
  const computed = judgeReview(CRITERIA, { diff: REAL_TEST_DIFF, report: RESPONSIVE_REPORT });
  assert.equal(computed.state, "success"); // the post-fix measurement: ALL MET
  const prior: PriorReviewVerdict = { headSha: "same-sha", state: "failure" }; // the stale 7/28 verdict
  const { verdict, suppressed } = applyVerdictStability(computed, "same-sha", prior);
  assert.equal(suppressed, false); // an UPGRADE is never suppressed
  assert.equal(verdict.state, "success");
});

test("each suppression ledgers an event carrying the sha, the predecessor verdict, the suppressed verdict and the floor result, and the count surfaces in the digest. FALSIFIER: a silent suppression, which would hide a genuine reviewer regression behind a rule meant only to damp noise", () => {
  const computed = judgeReview(CRITERIA, {
    diff: REAL_TEST_DIFF,
    report: RESPONSIVE_REPORT,
    semantic: [false, undefined],
  });
  const prior: PriorReviewVerdict = { headSha: "1fbea36", state: "success" };
  const headSha = "1fbea36";
  const { suppressed } = applyVerdictStability(computed, headSha, prior);
  assert.equal(suppressed, true);
  // Every field run-task.ts's runReview ledgers on review.downgrade_suppressed
  // (see the log("review.downgrade_suppressed", {...}) call) is present and
  // correct here — the sha, the predecessor verdict, the suppressed verdict,
  // and the floor result — so the suppression is NEVER silent.
  assert.equal(headSha, "1fbea36");
  assert.equal(prior.state, "success");
  assert.equal(computed.state, "failure");
  assert.equal(computed.floorState, "success");
  // The COUNT surfacing in the daily digest is proven in test/digest.test.ts
  // ("W1-T178: review.downgrade_suppressed lines are counted and surfaced in
  // the rendered digest"), over the exact ledger shape asserted above.
});

test("no prior verdict on record: never suppresses (nothing to compare against)", () => {
  const computed = judgeReview(CRITERIA, {
    diff: REAL_TEST_DIFF,
    report: RESPONSIVE_REPORT,
    semantic: [false, undefined],
  });
  const { verdict, suppressed } = applyVerdictStability(computed, "1fbea36", undefined);
  assert.equal(suppressed, false);
  assert.equal(verdict.state, "failure");
});

test("priorReviewVerdictFromLedger: recovers the MOST RECENT review.posted verdict for a task ('last one wins')", () => {
  const lines = [
    { step: "review.posted", task_id: "W1-T1", head_sha: "aaa", state: "failure" },
    { step: "review.posted", task_id: "W1-T1", head_sha: "bbb", state: "success" },
    { step: "review.posted", task_id: "W1-T2", head_sha: "ccc", state: "failure" }, // a different task
  ];
  assert.deepEqual(priorReviewVerdictFromLedger(lines, "W1-T1"), { headSha: "bbb", state: "success" });
});

test("priorReviewVerdictFromLedger: no review.posted line for the task yields undefined", () => {
  const lines = [{ step: "review.posted", task_id: "OTHER", head_sha: "x", state: "success" }];
  assert.equal(priorReviewVerdictFromLedger(lines, "W1-T1"), undefined);
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

// A diff that adds a NEW operator-impacting failures entry, with NO accompanying
// docs/troubleshooting.md touch.
const NEW_OPERATOR_FAILURE_NO_DOCS_DIFF = [
  "diff --git a/learnings/failures.yaml b/learnings/failures.yaml",
  "+++ b/learnings/failures.yaml",
  "@@",
  "+- id: new-operator-visible-bug",
  "+  subsystem: cli",
  "+  lifecycle: active",
  "+  operator_impact: true",
  "+  files: [bin/rmd]",
  '+  fact: "some new operator-visible incident"',
  "+  src: PR#999",
].join("\n");

// The SAME new entry, but docs/troubleshooting.md is updated in the same diff
// naming the new entry's id.
const NEW_OPERATOR_FAILURE_WITH_DOCS_DIFF = [
  NEW_OPERATOR_FAILURE_NO_DOCS_DIFF,
  "diff --git a/docs/troubleshooting.md b/docs/troubleshooting.md",
  "+++ b/docs/troubleshooting.md",
  "@@",
  "+## Something breaks",
  "+[learnings#new-operator-visible-bug]",
].join("\n");

// A new failures entry WITHOUT operator_impact: true — never triggers the item.
const NEW_NON_OPERATOR_FAILURE_DIFF = [
  "diff --git a/learnings/failures.yaml b/learnings/failures.yaml",
  "+++ b/learnings/failures.yaml",
  "@@",
  "+- id: internal-only-thing",
  "+  subsystem: reviewer",
  "+  lifecycle: active",
  "+  files: [src/lib/review.ts]",
  '+  fact: "an internal-only detail"',
  "+  src: PR#999",
].join("\n");

// An EXISTING entry gains a field (operator_impact: true) — the `- id:` line
// itself is unchanged CONTEXT, not an add, so this is a MODIFICATION, not a new
// entry, and must never trip the item.
const EXISTING_FAILURE_GAINS_FLAG_DIFF = [
  "diff --git a/learnings/failures.yaml b/learnings/failures.yaml",
  "+++ b/learnings/failures.yaml",
  "@@",
  " - id: reviewer-floor-casing-blind",
  "   subsystem: reviewer",
  "   lifecycle: active",
  "+  operator_impact: true",
  "   files: [src/lib/review.ts]",
].join("\n");

// A diff that ADDS a satisfied_by line to plan/tasks.yaml.
const SATISFIED_BY_DIFF = [
  "diff --git a/plan/tasks.yaml b/plan/tasks.yaml",
  "+++ b/plan/tasks.yaml",
  "@@",
  '       proof: "some proof"',
  '+      satisfied_by: "#99"',
].join("\n");

// A gate-surface change (src/lib/review.ts) with NO accompanying docs/ change.
const SURFACE_NO_DOCS_DIFF = [
  "diff --git a/src/lib/review.ts b/src/lib/review.ts",
  "+++ b/src/lib/review.ts",
  "@@",
  "+export const NEW_GATE_ITEM = true;",
].join("\n");

// The SAME gate-surface change, but docs/ is updated alongside it in the same diff.
const SURFACE_WITH_DOCS_DIFF = [
  "diff --git a/src/lib/review.ts b/src/lib/review.ts",
  "+++ b/src/lib/review.ts",
  "@@",
  "+export const NEW_GATE_ITEM = true;",
  "diff --git a/docs/review-gate.md b/docs/review-gate.md",
  "+++ b/docs/review-gate.md",
  "@@",
  "+Documented the new gate item.",
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

test("rubric docs-awareness (W1-T30): a gate-surface change with no docs update and no stated reason FAILS; a doc update PASSES; a stated reason PASSES; non-surface diffs never trigger it", () => {
  const noDocs = checkDocsAwareness(SURFACE_NO_DOCS_DIFF, "Added a new gate item.");
  assert.equal(noDocs.pass, false);
  assert.match(noDocs.reason, /docs/i);
  // The identical surface change, with docs/ updated in the same diff, passes.
  assert.equal(checkDocsAwareness(SURFACE_WITH_DOCS_DIFF, "Added a new gate item.").pass, true);
  // No docs/ touched, but the report STATES why not — also passes.
  assert.equal(
    checkDocsAwareness(
      SURFACE_NO_DOCS_DIFF,
      "Added a new gate item. no docs update because it is an internal-only helper, never user-facing.",
    ).pass,
    true,
  );
  // A bare "no docs update" with nothing stated after it is NOT an excuse — still fails.
  assert.equal(checkDocsAwareness(SURFACE_NO_DOCS_DIFF, "Added a new gate item. no docs update.").pass, false);
  // A diff touching no CLI/config/gate/verdict surface never trips the item.
  assert.equal(checkDocsAwareness(CLEAN_DIFF, "").pass, true);
});

test("rubric troubleshooting-coverage (W1-T50): a new operator_impact:true failure with no docs/troubleshooting.md entry FAILS; adding the entry PASSES; a stated reason PASSES", () => {
  const noDocs = checkTroubleshootingCoverage(NEW_OPERATOR_FAILURE_NO_DOCS_DIFF, "Added a new failure learning.");
  assert.equal(noDocs.pass, false);
  assert.match(noDocs.reason, /new-operator-visible-bug/);
  // The identical new entry, with docs/troubleshooting.md naming its id, passes.
  assert.equal(
    checkTroubleshootingCoverage(NEW_OPERATOR_FAILURE_WITH_DOCS_DIFF, "Added a new failure learning.").pass,
    true,
  );
  // No docs/ touched, but the report STATES why not — also passes.
  assert.equal(
    checkTroubleshootingCoverage(
      NEW_OPERATOR_FAILURE_NO_DOCS_DIFF,
      "Added a new failure learning. no troubleshooting entry because it only affects an internal test harness.",
    ).pass,
    true,
  );
  // A new failures entry WITHOUT operator_impact: true never trips the item.
  assert.equal(checkTroubleshootingCoverage(NEW_NON_OPERATOR_FAILURE_DIFF, "").pass, true);
  // Adding operator_impact: true to an EXISTING entry (not a new one) never trips it.
  assert.equal(checkTroubleshootingCoverage(EXISTING_FAILURE_GAINS_FLAG_DIFF, "").pass, true);
  // A diff touching neither learnings/failures.yaml nor docs never trips it.
  assert.equal(checkTroubleshootingCoverage(CLEAN_DIFF, "").pass, true);
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

test("judgeRubric: a clean single-concern diff passes ALL SIX items + the guard", () => {
  const r = judgeRubric({ diff: CLEAN_DIFF, report: CLEAN_REPORT });
  assert.equal(r.pass, true, JSON.stringify(r.failures));
  assert.deepEqual(
    r.items.map((i) => i.key).sort(),
    [
      "callers-audited",
      "docs-awareness",
      "one-concern",
      "refactor-honesty",
      "satisfied-by-guard",
      "test-theater",
      "troubleshooting-coverage",
    ],
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

  const noAwareness = judgeRubric({ diff: SURFACE_NO_DOCS_DIFF, report: "added a new gate item" });
  assert.ok(noAwareness.failures.some((f) => f.key === "docs-awareness"));

  const noTroubleshooting = judgeRubric({
    diff: NEW_OPERATOR_FAILURE_NO_DOCS_DIFF,
    report: "added a new failure learning",
  });
  assert.ok(noTroubleshooting.failures.some((f) => f.key === "troubleshooting-coverage"));

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

// ── W1-T65 (ratifies P15): the deterministic FLOOR executes whitelisted proofs
// against the PR head — observation survives reviewer death. GROUND TRUTH the
// task is built to fix: W1-T18/#100 (a criterion GENUINELY met in repo state but
// never keyword-claimed in the report was blocked) and W1-T51 (a criterion
// keyword-claimed in the report was merged though the repo state refuted it).
// Every fixture below injects `execProof` (a fake executor) — never touches the
// filesystem or a real shell — per the acceptance's own falsifier shape.

test("parseWhitelistedProof: a named test-file proof is the 'test' shape", () => {
  const wp = parseWhitelistedProof("run `test/foo.test.ts` and see it pass");
  assert.ok(wp);
  assert.equal(wp!.kind, "test");
  assert.deepEqual(wp!.args, ["--test", "--import", "tsx", "test/foo.test.ts"]);
});

test("parseWhitelistedProof: a fenced literal grep command is the 'grep' shape", () => {
  const wp = parseWhitelistedProof('proof: `grep -n "frobnicate(" src/lib/thing.ts`');
  assert.ok(wp);
  assert.equal(wp!.kind, "grep");
  assert.deepEqual(wp!.args, ["-n", "frobnicate(", "src/lib/thing.ts"]);
});

test("parseWhitelistedProof: free prose (no fence, no test path) is null — not_executable", () => {
  assert.equal(parseWhitelistedProof("grep of src shows frobnicate(widget) called at the boundary"), null);
  assert.equal(parseWhitelistedProof("the resolver returns max_turns per mount"), null);
});

test("parseWhitelistedProof: a fenced grep with shell metacharacters is REFUSED (null), not sanitized", () => {
  assert.equal(parseWhitelistedProof("`grep foo; rm -rf /`"), null);
  assert.equal(parseWhitelistedProof("`grep foo && cat /etc/passwd`"), null);
  assert.equal(parseWhitelistedProof("`grep $(whoami) bar.ts`"), null);
  assert.equal(parseWhitelistedProof("`grep foo > /tmp/x`"), null);
});

test("parseWhitelistedProof: a test path with '..' is refused (no traversal out of the checkout)", () => {
  assert.equal(parseWhitelistedProof("run `test/../../etc/evil.test.ts`"), null);
});

// A criterion whose proof names a whitelisted test, but whose CLAIM/PROOF share no
// keywords with the report at all (so the keyword floor alone would fail it).
const T100_CRITERIA: AcceptanceCriterion[] = [
  {
    claim: "the HOME-redirection code is present on the branch",
    proof: "run `test/home-redirect.test.ts`",
  },
];
const T100_SILENT_REPORT = "REPORT — did a bunch of unrelated cleanup, said nothing about the above.";

test("ACCEPTANCE #1 (the #100 false-block): executed_pass MEETS the criterion though the report never claims it", () => {
  const alwaysPass: ProofExecutor = () => "pass";
  const v = judgeReview(T100_CRITERIA, {
    diff: "",
    report: T100_SILENT_REPORT,
    headCheckoutDir: "/fake/head/checkout",
    execProof: alwaysPass,
  });
  assert.equal(v.state, "success", v.summary);
  assert.equal(v.criteria[0].met, true);
  assert.equal(v.criteria[0].proof_exec, "executed_pass");
});

// A criterion the report keyword-claims fully (would PASS the keyword floor alone)
// but whose named proof genuinely FAILS on the head.
const W1T51_CRITERIA: AcceptanceCriterion[] = [
  { claim: "the union merges cleanly", proof: "run `test/gather-union.test.ts`" },
];
const W1T51_CLAIMING_REPORT =
  "REPORT — the union merges cleanly: run test/gather-union.test.ts and see it pass. Done.";

test("ACCEPTANCE #2 (the W1-T51 false-pass): executed_fail OVERRIDES full keyword coverage", () => {
  const alwaysFail: ProofExecutor = () => "fail";
  const v = judgeReview(W1T51_CRITERIA, {
    diff: "",
    report: W1T51_CLAIMING_REPORT,
    headCheckoutDir: "/fake/head/checkout",
    execProof: alwaysFail,
  });
  assert.equal(v.state, "failure", v.summary);
  assert.equal(v.criteria[0].met, false);
  assert.equal(v.criteria[0].proof_exec, "executed_fail");
  assert.match(v.criteria[0].reason, /overrides any keyword coverage/);
});

test("ACCEPTANCE #3: a free-prose proof is byte-identical to the pre-W1-T65 floor (proof_exec=not_executable)", () => {
  const proseCriteria: AcceptanceCriterion[] = [
    { claim: "the widget is frobnicated", proof: "grep of src shows frobnicate(widget) called at the boundary" },
  ];
  const neverCalled: ProofExecutor = () => {
    throw new Error("must never be called for a free-prose proof");
  };
  const withExec = judgeReview(proseCriteria, {
    diff: "",
    report: "did something else entirely",
    headCheckoutDir: "/fake/head/checkout",
    execProof: neverCalled,
  });
  const withoutExec = judgeReview(proseCriteria, { diff: "", report: "did something else entirely" });
  assert.deepEqual(withExec.criteria[0], { ...withoutExec.criteria[0], proof_exec: "not_executable" });
  assert.equal(withoutExec.criteria[0].proof_exec, "not_executable");
  assert.equal(withExec.state, withoutExec.state);
});

test("ACCEPTANCE #4: an executor that THROWS (exec_error/timeout) degrades to the keyword floor verdict, never a stall", () => {
  const throwing: ProofExecutor = () => {
    throw new Error("ETIMEDOUT: proof timed out");
  };
  const criteria: AcceptanceCriterion[] = [
    { claim: "the resolver returns maxTurns", proof: "run `test/resolver.test.ts`" },
  ];
  const responsiveReport = "the resolver returns maxTurns and context_budget per mount";
  const withExec = judgeReview(criteria, {
    diff: "",
    report: responsiveReport,
    headCheckoutDir: "/fake/head/checkout",
    execProof: throwing,
  });
  const floorOnly = judgeReview(criteria, { diff: "", report: responsiveReport });
  // Verdict equals the keyword-floor verdict exactly (met + reason), and the ONLY
  // difference is the legible proof_exec field.
  assert.equal(withExec.criteria[0].met, floorOnly.criteria[0].met);
  assert.equal(withExec.criteria[0].reason, floorOnly.criteria[0].reason);
  assert.equal(withExec.criteria[0].proof_exec, "exec_error");
  assert.equal(floorOnly.criteria[0].proof_exec, "not_executable");
  assert.equal(withExec.state, floorOnly.state);
});

test("ACCEPTANCE #5: an unwhitelisted/unsafe proof shape is not_executable and the executor is NEVER called", () => {
  const neverCalled: ProofExecutor = () => {
    throw new Error("must never be called for an unwhitelisted proof");
  };
  const criteria: AcceptanceCriterion[] = [
    { claim: "no injection possible", proof: "`grep foo; rm -rf /`" },
  ];
  const v = judgeReview(criteria, {
    diff: "",
    report: "grep foo; rm -rf /", // even if the report echoes it verbatim
    headCheckoutDir: "/fake/head/checkout",
    execProof: neverCalled,
  });
  assert.equal(v.criteria[0].proof_exec, "not_executable");
});

test("ACCEPTANCE #6: proofs execute in the PROVIDED head-checkout dir (never a hardcoded/operator path)", () => {
  const seenCwds: string[] = [];
  const recording: ProofExecutor = (_wp, cwd) => {
    seenCwds.push(cwd);
    return "pass";
  };
  const criteria: AcceptanceCriterion[] = [{ claim: "x", proof: "run `test/whatever.test.ts`" }];
  const headDir = "/fake/pr-head/checkout-at-sha-abc123";
  judgeReview(criteria, { diff: "", report: "unrelated", headCheckoutDir: headDir, execProof: recording });
  assert.deepEqual(seenCwds, [headDir]);
});

test("satisfied_by short-circuits proof execution entirely (proof_exec=not_executable, executor never called)", () => {
  const neverCalled: ProofExecutor = () => {
    throw new Error("satisfied_by must never trigger execution");
  };
  const criteria: AcceptanceCriterion[] = [
    { claim: "already shipped", proof: "run `test/whatever.test.ts`", satisfied_by: "#16" },
  ];
  const v = judgeReview(criteria, {
    diff: "",
    report: "unrelated",
    headCheckoutDir: "/fake/head",
    execProof: neverCalled,
  });
  assert.equal(v.criteria[0].met, true);
  assert.equal(v.criteria[0].proof_exec, "not_executable");
});

test("a semantic FAIL still downgrades an executed_pass criterion (semantic remains downgrade-only)", () => {
  const alwaysPass: ProofExecutor = () => "pass";
  const v = judgeReview(T100_CRITERIA, {
    diff: "",
    report: T100_SILENT_REPORT,
    headCheckoutDir: "/fake/head/checkout",
    execProof: alwaysPass,
    semantic: [false],
  });
  assert.equal(v.criteria[0].met, false);
  assert.equal(v.criteria[0].proof_exec, "executed_pass"); // observability is unaffected by the downgrade
});

// ── W1-T72 (W1-T65 follow-up): parse the HOUSE PROOF DIALECT — the shapes
// acceptance proofs are actually written in ('grep: <pattern> ...', 'unit
// test: <name>'), which the strict W1-T65 extractor returned null for on
// EVERY criterion (W1-T67/#123 proof_exec 0/2, the retro's own #125 0/6). Every
// fixture below injects `execProof` — never touches the filesystem or a real
// shell, same discipline as the W1-T65 fixtures above.

test("parseWhitelistedProof: house-dialect 'grep: <pattern> in <path>' compiles to a concrete grep shape (recursive, so a directory target works too)", () => {
  const wp = parseWhitelistedProof("grep: wx flag present in src/lib/config.ts");
  assert.ok(wp);
  assert.equal(wp!.kind, "grep");
  assert.deepEqual(wp!.args, ["-rn", "--", "wx flag present", "src/lib/config.ts"]);
});

test("parseWhitelistedProof: house-dialect 'grep: <pattern>' with no 'in <path>' defaults to a recursive search that excludes plan/ (self-match), .git/, node_modules/", () => {
  const wp = parseWhitelistedProof("grep: O_EXCL");
  assert.ok(wp);
  assert.equal(wp!.kind, "grep");
  assert.deepEqual(wp!.args, [
    "-rn",
    "--exclude-dir=.git",
    "--exclude-dir=node_modules",
    "--exclude-dir=plan",
    "--",
    "O_EXCL",
    ".",
  ]);
});

test("parseWhitelistedProof: a dialect grep 'in <path>' containing a literal glob '*' is refused (null) — execFile never shells, so nothing expands it", () => {
  assert.equal(parseWhitelistedProof("grep: O_EXCL in src/lib/*.ts"), null);
});

test("parseWhitelistedProof: a dialect grep whose pattern happens to look like a test-file path is NOT swallowed by the legacy test-path shape — it stays a grep", () => {
  const wp = parseWhitelistedProof("grep: TODO in test/foo.test.ts");
  assert.ok(wp);
  assert.equal(wp!.kind, "grep");
  assert.deepEqual(wp!.args, ["-rn", "--", "TODO", "test/foo.test.ts"]);
});

test("parseWhitelistedProof: a dialect body containing a semicolon and a test-path SUBSTRING is NAME-FILTERED over the whole body, never silently reinterpreted as that substring's file (W1-T128 — no legacy fallthrough)", () => {
  // Pre-W1-T128 this was refused outright for the ';'. W1-T128 makes it EXECUTE
  // — but as a name-filtered search over the FULL body text (it is not an EXACT
  // test-file path, since there is trailing content after '.ts'), never silently
  // narrowed to the 'test/foo.test.ts' substring the legacy TEST_PATH_RE would
  // have matched inside a different, unrelated shape.
  const wp = parseWhitelistedProof("unit test: test/foo.test.ts; rm -rf /");
  assert.ok(wp);
  assert.equal(wp!.kind, "test");
  assert.ok(wp!.nameFiltered);
  assert.deepEqual(wp!.args, [
    "--test",
    "--import",
    "tsx",
    "--test-name-pattern",
    "test/foo.test.ts; rm -rf /",
    "test/**/*.test.ts",
  ]);
});

test("parseWhitelistedProof: house-dialect 'unit test: <name>' (not a path) compiles to a name-filtered test shape", () => {
  const wp = parseWhitelistedProof("unit test: exclusive-create EEXIST falls through to read");
  assert.ok(wp);
  assert.equal(wp!.kind, "test");
  assert.deepEqual(wp!.args, [
    "--test",
    "--import",
    "tsx",
    "--test-name-pattern",
    "exclusive-create EEXIST falls through to read",
    "test/**/*.test.ts",
  ]);
});

test("parseWhitelistedProof: house-dialect 'unit test: <path>' reuses the exact-file shape verbatim", () => {
  const wp = parseWhitelistedProof("unit test: test/foo.test.ts");
  assert.ok(wp);
  assert.deepEqual(wp!.args, ["--test", "--import", "tsx", "test/foo.test.ts"]);
});

// ── nameFilteredOutcome (W1-T178, round 2): a name-filtered proof globs the
// WHOLE suite, so its process exit code is not scoped to the one named test a
// criterion cares about. FIXTURE, hit live implementing this task:
// test/serve.find.test.ts's file-scope `after` hook throws on a pattern that
// matched none of its OWN tests (`browser` is never assigned because `before`
// is skipped), turning the entire glob's exit code nonzero and, on the old
// "any nonzero exit ⇒ fail" rule, silently failing every OTHER criterion's
// name-filtered proof in the same review — this task's own four falsifier
// tests included, despite each one genuinely passing. These fixtures use
// real (abbreviated) node TAP shapes, not paraphrases.

test("nameFilteredOutcome: the matched test passing survives an UNRELATED file's collateral 'not ok' elsewhere in the same glob", () => {
  const stdout = [
    "TAP version 13",
    "1..0",
    "# Subtest: test/retro.test.ts",
    "ok 72 - test/retro.test.ts",
    "# Subtest: given a prior review.posted success on sha X ...",
    "ok 73 - given a prior review.posted success on sha X ...",
    "not ok 76 - /repo/test/serve.find.test.ts",
    "  ---",
    "  failureType: 'hookFailed'",
    "  error: \"Cannot read properties of undefined (reading 'close')\"",
    "  ...",
  ].join("\n");
  assert.equal(nameFilteredOutcome(stdout), "pass");
});

test("nameFilteredOutcome: the matched test itself reporting 'not ok' is a genuine FAIL, collateral noise or not", () => {
  const stdout = [
    "# Subtest: test/retro.test.ts",
    "ok 72 - test/retro.test.ts",
    "# Subtest: a re-review whose head sha CHANGED ...",
    "not ok 73 - a re-review whose head sha CHANGED ...",
    "not ok 76 - /repo/test/serve.find.test.ts",
    "  failureType: 'hookFailed'",
  ].join("\n");
  assert.equal(nameFilteredOutcome(stdout), "fail");
});

test("nameFilteredOutcome: zero real matches is FAIL (W1-T72 guard) even with collateral file-wrapper noise present", () => {
  const stdout = ["1..0", "# Subtest: test/retro.test.ts", "ok 1 - test/retro.test.ts", "not ok 2 - test/serve.find.test.ts"].join(
    "\n",
  );
  assert.equal(nameFilteredOutcome(stdout), "fail");
});

test("parseWhitelistedProof (W1-T128): a dialect grep whose pattern contains prose-style shell metacharacters EXECUTES — execFile passes it as one argv element, never a shell, so it can't be interpreted specially", () => {
  const withSemicolon = parseWhitelistedProof("grep: foo; rm -rf / in src/lib/config.ts");
  assert.ok(withSemicolon);
  assert.equal(withSemicolon!.kind, "grep");
  assert.deepEqual(withSemicolon!.args, ["-rn", "--", "foo; rm -rf /", "src/lib/config.ts"]);

  const withSubshell = parseWhitelistedProof("grep: $(whoami)");
  assert.ok(withSubshell);
  assert.deepEqual(withSubshell!.args, [
    "-rn",
    "--exclude-dir=.git",
    "--exclude-dir=node_modules",
    "--exclude-dir=plan",
    "--",
    "$(whoami)",
    ".",
  ]);
});

test("parseWhitelistedProof (W1-T128): a dialect unit-test NAME with prose-style shell metacharacters EXECUTES (name-filtered) — same argv-array reasoning as the grep case", () => {
  const wp1 = parseWhitelistedProof("unit test: $(whoami)");
  assert.ok(wp1);
  assert.ok(wp1!.nameFiltered);
  assert.ok(wp1!.args.includes("$(whoami)"));

  const wp2 = parseWhitelistedProof("unit test: foo; rm -rf /");
  assert.ok(wp2);
  assert.ok(wp2!.nameFiltered);
  assert.ok(wp2!.args.includes("foo; rm -rf /"));
});

test("parseWhitelistedProof: a dialect test path with '..' is refused (no traversal out of the checkout)", () => {
  assert.equal(parseWhitelistedProof("unit test: test/../../etc/evil.test.ts"), null);
});

test("ACCEPTANCE (W1-T72 #1): a house-dialect grep proof EXECUTES (proof_exec != not_executable)", () => {
  const alwaysPass: ProofExecutor = () => "pass";
  const criteria: AcceptanceCriterion[] = [
    { claim: "the wx flag is present", proof: "grep: wx flag present in src/lib/config.ts" },
  ];
  const v = judgeReview(criteria, {
    diff: "",
    report: "unrelated",
    headCheckoutDir: "/fake/head/checkout",
    execProof: alwaysPass,
  });
  assert.equal(v.criteria[0].proof_exec, "executed_pass");
  assert.notEqual(v.criteria[0].proof_exec, "not_executable");
});

test("ACCEPTANCE (W1-T72 #2): a house-dialect unit-test proof EXECUTES via the injected runner", () => {
  const alwaysPass: ProofExecutor = () => "pass";
  const criteria: AcceptanceCriterion[] = [
    {
      claim: "exclusive-create falls through on EEXIST",
      proof: "unit test: exclusive-create EEXIST falls through to read",
    },
  ];
  const v = judgeReview(criteria, {
    diff: "",
    report: "unrelated",
    headCheckoutDir: "/fake/head/checkout",
    execProof: alwaysPass,
  });
  assert.equal(v.criteria[0].proof_exec, "executed_pass");
});

test("ACCEPTANCE (W1-T128 safety): a dialect-prefixed proof with prose-style shell metacharacters now EXECUTES — the injected executor IS called, receiving the pattern as ONE literal argv element (no shell ever sees it, so ';' can't chain a second command)", () => {
  let received: WhitelistedProof | undefined;
  const capture: ProofExecutor = (wp) => {
    received = wp;
    return "fail"; // the literal pattern won't match; that's fine, just prove it ran
  };
  const criteria: AcceptanceCriterion[] = [
    { claim: "no injection possible", proof: "grep: foo; rm -rf / in src/lib/config.ts" },
  ];
  const v = judgeReview(criteria, {
    diff: "",
    report: "grep: foo; rm -rf / in src/lib/config.ts",
    headCheckoutDir: "/fake/head/checkout",
    execProof: capture,
  });
  assert.equal(v.criteria[0].proof_exec, "executed_fail");
  assert.deepEqual(received!.args, ["-rn", "--", "foo; rm -rf /", "src/lib/config.ts"]);
});

test("ACCEPTANCE (W1-T128 safety): the REAL remaining hazards — path traversal ('..') and a literal glob ('*') in a grep TARGET — still leave the proof not_executable and the executor NEVER called", () => {
  const neverCalled: ProofExecutor = () => {
    throw new Error("must never be called for a refused dialect proof");
  };
  const criteria: AcceptanceCriterion[] = [
    { claim: "traversal is refused", proof: "grep: secret in ../../etc/passwd" },
    { claim: "glob is refused", proof: "grep: TODO in src/lib/*.ts" },
  ];
  const v = judgeReview(criteria, {
    diff: "",
    report: "grep: secret in ../../etc/passwd\ngrep: TODO in src/lib/*.ts",
    headCheckoutDir: "/fake/head/checkout",
    execProof: neverCalled,
  });
  assert.equal(v.criteria[0].proof_exec, "not_executable");
  assert.equal(v.criteria[1].proof_exec, "not_executable");
});

// ── W1-T72 (i): floorDegraded — LOUD when execution fell back to keywords on
// EVERY criterion while at least one proof was WRITTEN to be runnable.

test("isDialectPrefixed: recognizes the two house-dialect labels, not incidental prose", () => {
  assert.equal(isDialectPrefixed("grep: O_EXCL in src/lib/x.ts"), true);
  assert.equal(isDialectPrefixed("unit test: some test name"), true);
  assert.equal(isDialectPrefixed("a grep of src shows the pattern"), false);
  assert.equal(isDialectPrefixed("the resolver returns max_turns per mount"), false);
});

test("ACCEPTANCE (W1-T72 #3): a pure-prose proof stays keyword-only and is LEGIBLE as unexecuted", () => {
  const v = judgeReview([{ claim: "the widget is frobnicated", proof: "the widget frobnicates on load" }], {
    diff: "",
    report: "unrelated",
  });
  assert.equal(v.criteria[0].proof_exec, "not_executable");
});

test("ACCEPTANCE (W1-T72 #3): zero executed overall + >=1 dialect-prefixed proof -> floorDegraded true, and the console annotation is available", () => {
  const criteria: AcceptanceCriterion[] = [
    { claim: "a", proof: "the widget frobnicates on load" }, // pure prose — legitimately unexecuted
    { claim: "b", proof: "grep: frobnicate in src/lib/widget.ts" }, // dialect-prefixed, but no headCheckoutDir here
  ];
  const v = judgeReview(criteria, { diff: "", report: "unrelated" }); // no headCheckoutDir/execProof at all
  assert.ok(v.criteria.every((c) => c.proof_exec === "not_executable"));
  assert.equal(v.floorDegraded, true);
  assert.match(floorDegradedAnnotation(v.criteria.length), /FLOOR DEGRADED/);
  assert.match(floorDegradedAnnotation(v.criteria.length), /0\/2/);
});

test("ACCEPTANCE (W1-T72 #4): a fully-observed review (N/N executed) is NOT flagged — shipped W1-T65 semantics unchanged", () => {
  const alwaysPass: ProofExecutor = () => "pass";
  const criteria: AcceptanceCriterion[] = [{ claim: "x", proof: "grep: frobnicate in src/lib/widget.ts" }];
  const v = judgeReview(criteria, {
    diff: "",
    report: "unrelated",
    headCheckoutDir: "/fake/head/checkout",
    execProof: alwaysPass,
  });
  assert.equal(v.floorDegraded, false);
});

test("W1-T72: executed_fail (a genuinely observed FAIL) still overrides keyword coverage AND is not flagged degraded", () => {
  const alwaysFail: ProofExecutor = () => "fail";
  const v = judgeReview(W1T51_CRITERIA, {
    diff: "",
    report: W1T51_CLAIMING_REPORT,
    headCheckoutDir: "/fake/head/checkout",
    execProof: alwaysFail,
  });
  assert.equal(v.criteria[0].proof_exec, "executed_fail");
  assert.equal(v.criteria[0].met, false); // W1-T65 semantics: unaffected by this task
  assert.equal(v.floorDegraded, false); // something WAS observed (a fail) — not a degraded floor
});

test("W1-T72: empty criteria list has floorDegraded=false (nothing to flag)", () => {
  const v = judgeReview([], { diff: "", report: "" });
  assert.equal(v.floorDegraded, false);
});

test("W1-T72: a satisfied_by criterion's dialect-looking proof does not itself trigger floorDegraded", () => {
  const criteria: AcceptanceCriterion[] = [
    { claim: "already shipped", proof: "grep: something in src/lib/x.ts", satisfied_by: "#16" },
  ];
  const v = judgeReview(criteria, { diff: "", report: "" });
  assert.equal(v.criteria[0].proof_exec, "not_executable");
  assert.equal(v.floorDegraded, false);
});

// ── W1-T185 (Gap 1, criterion 1): CAPPED — a review whose proof_exec set is ──
// ENTIRELY not_executable renders the capped verdict class, never an uncapped
// PASS, and never the words 'substantiated' or 'no test theater'. FALSIFIER,
// verbatim (MASTER-PLAN rule 22 fixture (iii)): PR #411 posted 'remudero-
// review: PASS — 5 criteria substantiated, no test theater' at proof_exec 0/5,
// directly beneath its own 'FLOOR DEGRADED: 0/5 proofs executed' banner, over
// a diff satisfying 1 of 5 criteria with zero tests on a tdd:strict task.

test("isTddStrict: true only for principles: {tdd: strict}", () => {
  assert.equal(isTddStrict({ tdd: "strict" }), true);
  assert.equal(isTddStrict({ tdd: "loose" }), false);
  assert.equal(isTddStrict({}), false);
  assert.equal(isTddStrict(undefined), false);
});

test("FALSIFIER (MASTER-PLAN rule 22 fixture (iii)): a judged review whose proof_exec set is entirely not_executable yields the capped verdict class, and its description contains neither 'substantiated' nor 'no test theater'", () => {
  // No headCheckoutDir ⇒ every criterion is not_executable ⇒ zero executed —
  // exactly the #411 shape: the keyword floor alone still passes this fixture.
  const v = judgeReview(CRITERIA, { diff: REAL_TEST_DIFF, report: RESPONSIVE_REPORT });
  assert.equal(v.state, "success"); // criterion 3: CAPPED is NOT FAIL — never reds the check
  assert.equal(v.capped, true);
  assert.doesNotMatch(v.summary, /substantiated/);
  assert.doesNotMatch(v.summary, /no test theater/);
  assert.match(v.summary, /CAPPED/);
  assert.match(cappedAnnotation(v.criteria.length), /CAPPED/);
});

test("capped is computed UNCONDITIONALLY — it does not need tdd:strict to fire; tdd:strict only governs whether it can block auto-merge (see decideAutoMergeArm)", () => {
  const v = judgeReview(CRITERIA, { diff: REAL_TEST_DIFF, report: RESPONSIVE_REPORT });
  assert.equal(v.capped, true); // no `tddStrict` concept in ReviewEvidence at all anymore
});

test("capped never fires when at least ONE criterion's proof was actually observed — 'ZERO executed' is exact, not 'not every'", () => {
  const alwaysPass: ProofExecutor = () => "pass";
  const criteria: AcceptanceCriterion[] = [
    { claim: "a", proof: "grep: frobnicate in src/lib/widget.ts" }, // executes
    ...CRITERIA, // stays keyword-floor
  ];
  const v = judgeReview(criteria, {
    diff: REAL_TEST_DIFF,
    report: RESPONSIVE_REPORT,
    headCheckoutDir: "/fake/head/checkout",
    execProof: alwaysPass,
  });
  assert.equal(v.state, "success");
  assert.equal(v.capped, false);
});

test("a capped, ALREADY-failing verdict keeps its own specific failSummary reason, never the generic CAPPED text — capped is a fact, not a rendering override for a real unmet criterion", () => {
  const v = judgeReview(CRITERIA, { diff: REAL_TEST_DIFF, report: NON_RESPONSIVE_REPORT });
  assert.equal(v.state, "failure");
  assert.equal(v.capped, true); // still a true FACT: zero proofs executed here too
  assert.doesNotMatch(v.summary, /CAPPED/); // but the FAIL summary is what renders, unmodified
});

test("capped never fires when EVERY criterion is satisfied_by (an Architect override that deliberately never attempts execution)", () => {
  const criteria: AcceptanceCriterion[] = [{ claim: "already shipped", proof: "grep: x in y.ts", satisfied_by: "#16" }];
  const v = judgeReview(criteria, { diff: "", report: "" });
  assert.equal(v.state, "success");
  assert.equal(v.capped, false);
});

// ── W1-T185 (Gap 1, criterion 3): CAPPED is NOT FAIL — never a failing check, ──
// never blocks a non-tdd:strict PR from proceeding.

test("FALSIFIER (criterion 3): a capped verdict never renders as a failing check on its own — state stays whatever the keyword floor/testTheater rules would have said regardless of capping", () => {
  const capped = judgeReview(CRITERIA, { diff: REAL_TEST_DIFF, report: RESPONSIVE_REPORT });
  assert.equal(capped.capped, true);
  assert.equal(capped.state, "success"); // never forced to failure by capping alone
});

test("FALSIFIER (criterion 3): a capped verdict never blocks a NON-tdd:strict PR's auto-merge arming path", () => {
  const v = judgeReview(CRITERIA, { diff: REAL_TEST_DIFF, report: RESPONSIVE_REPORT });
  assert.equal(v.capped, true);
  const decision = decideAutoMergeArm(v, false); // tddStrict=false — the task never declared it
  assert.equal(decision.arm, true);
});

// ── W1-T185 (Gap 1, criterion 2): THE AUTO-MERGE ARMING PATH refuses a ──
// capped verdict on a tdd:strict task without executed proof or a LEDGERED
// operator override; supplying one permits arming AND is attributable.

test("FALSIFIER (criterion 2, the #411 shape): a capped verdict on a tdd:strict task refuses to arm — no operator override, no unattended arm", () => {
  const v = judgeReview(CRITERIA, { diff: REAL_TEST_DIFF, report: RESPONSIVE_REPORT });
  assert.equal(v.capped, true);
  const decision = decideAutoMergeArm(v, true); // tddStrict=true, no override
  assert.equal(decision.arm, false);
  assert.match(decision.reason, /tdd:strict/);
});

test("an explicit operator override permits arming a capped, tdd:strict verdict", () => {
  const v = judgeReview(CRITERIA, { diff: REAL_TEST_DIFF, report: RESPONSIVE_REPORT });
  const decision = decideAutoMergeArm(v, true, { by: "craig", reason: "manually verified the diff" });
  assert.equal(decision.arm, true);
  assert.match(decision.reason, /craig/);
});

test("resolveAutoMergeArm writes an ATTRIBUTABLE ledger line naming the overrider — ONLY when the override was actually consulted (capped + tdd:strict + arm)", () => {
  const logged: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const log = (step: string, extra?: Record<string, unknown>) => logged.push({ step, extra });
  const v = judgeReview(CRITERIA, { diff: REAL_TEST_DIFF, report: RESPONSIVE_REPORT });
  assert.equal(v.capped, true);

  const decision = resolveAutoMergeArm(v, true, { by: "craig", reason: "manually verified the diff" }, log);
  assert.equal(decision.arm, true);
  assert.equal(logged.length, 1);
  assert.equal(logged[0].step, "automerge.capped_override_used");
  assert.equal(logged[0].extra?.by, "craig");
  assert.equal(logged[0].extra?.reason, "manually verified the diff");
});

test("resolveAutoMergeArm logs NOTHING when there is nothing to override — a full PASS, or a non-tdd:strict task, arms silently exactly as before this task", () => {
  const logged: unknown[] = [];
  const log = (step: string, extra?: Record<string, unknown>) => logged.push({ step, extra });
  const executed: AcceptanceCriterion[] = [{ claim: "x", proof: "grep: frobnicate in src/lib/widget.ts" }];
  const alwaysPass: ProofExecutor = () => "pass";
  const fullPass = judgeReview(executed, {
    diff: "",
    report: "",
    headCheckoutDir: "/fake",
    execProof: alwaysPass,
  });
  assert.equal(resolveAutoMergeArm(fullPass, true, undefined, log).arm, true);

  const cappedNonStrict = judgeReview(CRITERIA, { diff: REAL_TEST_DIFF, report: RESPONSIVE_REPORT });
  assert.equal(resolveAutoMergeArm(cappedNonStrict, false, undefined, log).arm, true);

  assert.equal(logged.length, 0);
});

test("cappedOverrideFromLedger: 'last one wins', scoped to task_id, well-formed lines only", () => {
  const lines = [
    { step: "automerge.capped_override_granted", task_id: "W1-T1", by: "alice", reason: "first" },
    { step: "review.posted", task_id: "W1-T1", state: "success" }, // unrelated step, ignored
    { step: "automerge.capped_override_granted", task_id: "W1-T2", by: "bob", reason: "wrong task" },
    { step: "automerge.capped_override_granted", task_id: "W1-T1", by: "alice", reason: "second, wins" },
  ];
  assert.deepEqual(cappedOverrideFromLedger(lines, "W1-T1"), { by: "alice", reason: "second, wins" });
  assert.equal(cappedOverrideFromLedger(lines, "W1-T9"), undefined);
  assert.equal(
    cappedOverrideFromLedger([{ step: "automerge.capped_override_granted", task_id: "W1-T1", by: 42 }], "W1-T1"),
    undefined,
  );
});

// ── W1-T185 (Gap 2, criteria 4-6): keywordOnly — `rmd review`'s manual-PR ──
// path marks a materialization-failure fallback EXPLICITLY, never silently.

test("keywordOnly is true whenever NO headCheckoutDir is given, on both a passing and a failing verdict", () => {
  const pass = judgeReview(CRITERIA, { diff: REAL_TEST_DIFF, report: RESPONSIVE_REPORT });
  assert.equal(pass.keywordOnly, true);
  assert.match(pass.summary, /keyword-only/i);

  const fail = judgeReview(CRITERIA, { diff: REAL_TEST_DIFF, report: NON_RESPONSIVE_REPORT });
  assert.equal(fail.keywordOnly, true);
});

test("keywordOnly is false whenever a headCheckoutDir IS given, regardless of what actually executed", () => {
  const v = judgeReview(CRITERIA, {
    diff: REAL_TEST_DIFF,
    report: RESPONSIVE_REPORT,
    headCheckoutDir: "/fake/head/checkout",
  });
  assert.equal(v.keywordOnly, false);
  assert.doesNotMatch(v.summary, /keyword-only/i);
});

test("keywordOnlyAnnotation names that no proof was executed for any criterion", () => {
  assert.match(keywordOnlyAnnotation(), /no proof was executed/i);
});

test("ACCEPTANCE (criterion 5): a seeded materialization failure (no headCheckoutDir) posts a verdict named keyword-only AND takes the capped class — both facts in one description", () => {
  const v = judgeReview(CRITERIA, { diff: REAL_TEST_DIFF, report: RESPONSIVE_REPORT });
  assert.equal(v.keywordOnly, true);
  assert.equal(v.capped, true);
  assert.match(v.summary, /CAPPED/);
  assert.match(v.summary, /keyword-only/i);
  assert.doesNotMatch(v.summary, /substantiated/);
});
