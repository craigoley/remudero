import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { AcceptanceCriterion } from "../src/lib/plan.js";
import { bodyContradictsDiff, judgeCriterion, judgeReview } from "../src/lib/review.js";

// ── W1-T1100: a body detector judges the substitute it was handed ──────────────────────────────
//
// `runTaskBody` (src/run-task.ts) substitutes the worker's own chat text for the PR body when
// `fetchPrBodyFn` fails — a deliberate fallback (a `gh` outage degrades review to worker-text
// judging rather than a stall; this task does not remove it) documented at that call site. The
// DEFECT was that nothing downstream could tell a substitute from a real body, so ONE outage
// pushed two consumers of `evidence.report` in OPPOSITE directions at once:
//
//   - `bodyContradictsDiff` failed CLOSED — measured live on #2395: the worker-text substitute
//     read "No code." (never a claim the real, that-day-unreadable body made) over a diff that
//     touched `src/lib/proof-grammar.ts`, and the checker correctly-but-wrongly manufactured a
//     contradiction from prose that was never about the changeset.
//   - `judgeCriterion`'s keyword-coverage floor failed OPEN — a worker narrating its own change
//     naturally echoes a proof's own vocabulary, so a substitute scores keyword coverage HIGHER
//     than an honest body would, and used to credit that as "proof substantiated in report".
//
// `ReviewEvidence.reportIsSubstitute` (threaded through `judgeCriterion`'s matching 5th
// parameter) is the provenance flag that lets both consumers refuse to judge a substitute as
// though it were the body. Both fixtures below reuse the SAME report/diff pair with only the
// flag flipped, so each test is its own falsifier: the fixture content alone does not explain
// the difference in verdict — only the provenance flag does.

const runTaskSrc = readFileSync(fileURLToPath(new URL("../src/run-task.ts", import.meta.url)), "utf8");

// Mirrors the #2395 fixture named in the shard's own rationale: a one-file diff touching
// `src/lib/proof-grammar.ts`.
const DIFF_ONE_FILE = `
diff --git a/src/lib/proof-grammar.ts b/src/lib/proof-grammar.ts
+++ b/src/lib/proof-grammar.ts
@@
+export function normalizeWhitespace(s: string): string { return s.trim(); }
`.trim();

const CRITERION: AcceptanceCriterion = {
  claim: "the parser normalizes whitespace",
  proof: "grep: normalizeWhitespace in src/lib/proof-grammar.ts",
};

// A worker's own chat narrative, describing the change it just made IN THE PROOF'S OWN
// VOCABULARY (matches every distinctive keyword `proofKeywords` would pull from `CRITERION`'s
// proof — this is the exact fail-open shape rationale (5) measured: 5/5 coverage, met:true).
const WORKER_NARRATIVE_REPORT = [
  "REPORT",
  "I added normalizeWhitespace to src/lib/proof-grammar.ts so the grep proof would match cleanly.",
  "PR_URL: https://github.com/o/r/pull/1",
].join("\n");

test("W1-T1100 acceptance #1: the flag changes the verdict — the evidence records provenance, it is not merely accepted and ignored", () => {
  const trusted = judgeReview([CRITERION], { diff: DIFF_ONE_FILE, report: WORKER_NARRATIVE_REPORT, reportIsSubstitute: false });
  const substituted = judgeReview([CRITERION], { diff: DIFF_ONE_FILE, report: WORKER_NARRATIVE_REPORT, reportIsSubstitute: true });
  assert.notDeepEqual(
    trusted.criteria[0],
    substituted.criteria[0],
    "the SAME report/diff must be judged differently once marked as a substitute",
  );
  assert.equal(trusted.criteria[0].met, true, "control: over a trusted report the keyword floor credits this coverage");
  assert.equal(substituted.criteria[0].met, false, "the substitute must not get the same credit");
});

test("W1-T1100 acceptance #2: bodyContradictsDiff is not run at all against a substituted report", () => {
  // "No code." is not a hypothetical — it is the exact string #2395's worker-text substitute
  // contained, over a diff whose only file lives under src/. Live control (unguarded) FIRES:
  const liveControl = bodyContradictsDiff("No code.", ["src/lib/proof-grammar.ts"]);
  assert.equal(liveControl.length, 1, "control: the checker itself is not broken — a real body saying this would be caught");
  assert.equal(liveControl[0].claim, "No code.");

  const report = "No code.";
  const trusted = judgeReview([CRITERION], { diff: DIFF_ONE_FILE, report, reportIsSubstitute: false });
  assert.equal(
    trusted.changesetContradictions?.length,
    1,
    "control: judgeReview must still catch this over a genuinely fetched body",
  );

  const substituted = judgeReview([CRITERION], { diff: DIFF_ONE_FILE, report, reportIsSubstitute: true });
  assert.deepEqual(
    substituted.changesetContradictions,
    [],
    "a substituted report must never be handed to bodyContradictsDiff — no phantom contradiction",
  );
});

test("W1-T1100 acceptance #3: a substituted report never reports a criterion as substantiated on keyword coverage alone", () => {
  // Direct unit on judgeCriterion (the coverage computation itself): 5/5 keywords covered, the
  // shape that used to auto-pass.
  const tokenize = (s: string) =>
    s.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const reportTokens = new Set(tokenize(WORKER_NARRATIVE_REPORT));

  const trusted = judgeCriterion(CRITERION, reportTokens, undefined, undefined, false);
  assert.equal(trusted.met, true, "control: full keyword coverage over a trusted report substantiates the proof");
  assert.match(trusted.reason, /substantiated/);

  const substituted = judgeCriterion(CRITERION, reportTokens, undefined, undefined, true);
  assert.equal(substituted.met, false, "the SAME coverage over a substitute must not substantiate the claim");
  assert.doesNotMatch(substituted.reason, /substantiated/, "the reason must not claim substantiation");
  // Reworded 2026-08-25: this call supplies no CAUSE, and the old text asserted a failed fetch
  // that had never once occurred. The intent below is unchanged -- the reason must name the
  // missing body rather than merely saying "unmet" -- and it now does so without inventing a
  // failure. See test/substitute-cause-is-named.test.ts for both causes driven explicitly.
  assert.match(
    substituted.reason,
    /worker's own text rather than the PR body/,
    "the reason must name the missing body, not merely say 'unmet'",
  );
  assert.doesNotMatch(substituted.reason, /failed body fetch/, "and must not assert a failure that did not happen");

  // "on keyword coverage ALONE" — real, whitelisted proof EXECUTION observes repo state, not
  // report text, and must still be able to credit the SAME substituted-report criterion.
  const executed = judgeCriterion(CRITERION, reportTokens, undefined, { cwd: "/tmp/head", exec: () => "pass" }, true);
  assert.equal(executed.met, true, "an EXECUTED proof still passes even under a substituted report");
  assert.equal(executed.proof_exec, "executed_pass");
});

test("W1-T1100 acceptance #4: a genuinely fetched body still reaches every consumer exactly as it does today", () => {
  // Omitting the flag entirely (every caller/fixture that predates this task) must be
  // byte-identical to explicitly marking it false.
  const omitted = judgeReview([CRITERION], { diff: DIFF_ONE_FILE, report: WORKER_NARRATIVE_REPORT });
  const explicitFalse = judgeReview([CRITERION], {
    diff: DIFF_ONE_FILE,
    report: WORKER_NARRATIVE_REPORT,
    reportIsSubstitute: false,
  });
  assert.deepEqual(omitted, explicitFalse, "an absent flag must trust the report exactly like an explicit false");
  assert.equal(omitted.criteria[0].met, true, "the keyword floor still credits a real body's coverage");

  const omittedTokenize = (s: string) =>
    s.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const reportTokens = new Set(omittedTokenize(WORKER_NARRATIVE_REPORT));
  const withoutFlag = judgeCriterion(CRITERION, reportTokens);
  const withFalseFlag = judgeCriterion(CRITERION, reportTokens, undefined, undefined, false);
  assert.deepEqual(withoutFlag, withFalseFlag, "judgeCriterion's new 5th parameter is opt-in, never a default behavior change");
});

test("W1-T1100 wiring: runTaskBody threads the fetch outcome into the flag it just declared", () => {
  // Executing this requires a real worker spawn (same limitation the sibling W1-T256 pin
  // documents in test/impl-review-judges-body.test.ts) — pinned at the source instead.
  const at = runTaskSrc.indexOf("let reviewReport = fullText(impl);");
  assert.notEqual(at, -1, "the substitution call site must still exist");
  const window = runTaskSrc.slice(at, at + 700);

  assert.match(window, /let reviewReportIsSubstitute = true;/, "starts true — the fallback value assigned above IS the substitute");
  assert.match(
    window,
    /reviewReport = await fetchPrBodyFn\(prUrl\);\s*\n\s*reviewReportIsSubstitute = false;/,
    "flips to false ONLY once the real body is actually in hand",
  );
  assert.match(window, /catch \(e\) \{/, "a failed fetch is still caught (the fallback itself is untouched)");
  // The flag must survive the catch: it is declared with `let` OUTSIDE the try, so a throw
  // leaves it at its initial `true` rather than resetting it.
  const catchAt = window.indexOf("catch (e) {");
  assert.ok(catchAt !== -1 && catchAt > window.indexOf("reviewReportIsSubstitute = false;"));
  assert.doesNotMatch(
    window.slice(catchAt, catchAt + 200),
    /reviewReportIsSubstitute\s*=/,
    "the catch arm must not itself touch the flag — the pre-try `true` is what stands",
  );

  assert.match(
    runTaskSrc,
    /report: reviewReport,\s*\n\s*reportIsSubstitute: reviewReportIsSubstitute,/,
    "the flag must actually reach runReviewFn, not just be computed and dropped",
  );
});
