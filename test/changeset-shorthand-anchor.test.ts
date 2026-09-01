/**
 * The `plan-only`/`data-only` house shorthands need a SUBJECT before they can contradict a diff.
 *
 * MEASURED, ON A REAL PR RATHER THAN IMAGINED. `bodyContradictsDiff` tested `/\bplan-only\b/i`
 * against the whole body, with no subject — so the word fired wherever it appeared, INCLUDING
 * INSIDE A PATH. W1-T413's own acceptance criteria name `test/trailer-credit-plan-only.test.ts`,
 * and `\b` matches around `plan-only` between the `-` and the `.`; merely quoting the required
 * proof made a src-touching PR "claim" it was plan scope only, and `changesetContradictions`
 * forces `state: "failure"`. Writing ABOUT the concept did the same. That is the
 * guess-at-natural-language `bodyContradictsDiff`'s own doc forbids: "ANYTHING THIS CANNOT DECIDE
 * IS SILENCE, NOT A VERDICT".
 *
 * SILENCE AND FIRING ARE BOTH ASSERTED. An anchor that only silenced things would silence the
 * check itself — the shorthand exists to catch a body that misdescribes its own changeset, and
 * #1025's shape (`data-only: no code` over a src-reverting diff) must still fire.
 *
 * THE ARM WAS REBUILT AFTER #1562 (W1-T427). W1-T413's anchor kept two SENTENCE-SCOPED arms — a
 * backward `claimsChangesetContext` and a forward scan to the sentence end — so any changeset word
 * sharing a sentence with the shorthand fired it, in either direction and whatever the sentence was
 * about. A PR could therefore not DESCRIBE the plan-only rule without appearing to claim exemption
 * from it, which is worst for the PRs that change that rule. Those two arms are replaced by one
 * ATTRIBUTIVE test — the noun the shorthand modifies must itself be the changeset — and the label
 * and copular arms are unchanged. Every fixture below that pins a REAL claim is one of those three
 * shapes; see `shorthandIsAboutChangeset`'s doc for the measurement.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AcceptanceCriterion } from "../src/lib/plan.js";
import { bodyContradictsDiff, judgeReview } from "../src/lib/review.js";
import { writeMutantModule } from "./helpers/mutant-module.js";

/** A diff that is NOT plan scope only and NOT data only — so any true claim contradicts it. */
const SRC_DIFF = ["src/lib/status.ts", "test/trailer-credit-plan-only.test.ts"];

function fires(body: string): boolean {
  return bodyContradictsDiff(body, SRC_DIFF).length > 0;
}

// ── SILENCE WHERE THERE IS NO CLAIM ──────────────────────────────────────────────────────────

test("a path containing plan-only is not a claim about the changeset", () => {
  // The exact line every W1-T413 body must carry.
  assert.equal(fires("proof: unit test: test/trailer-credit-plan-only.test.ts"), false);
  assert.equal(fires("See `test/trailer-credit-plan-only.test.ts` for the fixtures."), false);
});

test("discussing the concept is not a claim about the changeset", () => {
  assert.equal(fires("The refusal fires when a merged PR is plan-only in the sense the predicate means."), false);
  assert.equal(fires("see fixtures/data-only-corpus.json"), false);
});

// ── AND THE CHECK STILL CATCHES A BODY THAT MISDESCRIBES ITS DIFF ────────────────────────────

test("the predicate form still fires, so the anchor did not silence the check", () => {
  assert.equal(fires("This PR is plan-only."), true);
  assert.equal(fires("The diff is data-only."), true);
  // THE BARE COPULAR SUBJECT, with no changeset word anywhere and no noun for the shorthand to
  // modify — "This is …" is the shape gate-properties.test.ts asserts, and the linking-verb arm is
  // the ONLY one that can reach it. It is why that arm cannot be folded into the other two.
  assert.equal(fires("This is plan-only."), true);
  assert.equal(fires("It was data-only."), true);
});

test("a linking verb after a GENERIC subject is explanation, not a claim about this diff", () => {
  // The distinction the arm turns on: predicating the shorthand of `this`/`the diff` claims it;
  // explaining what the predicate MEANS does not. Without this the anchor would re-create the
  // false positive it exists to remove, one grammatical step further along.
  assert.equal(fires("A merged PR is plan-only when its whole file list sits under the plan directory."), false);

  // W1-T413 ASSERTED THIS AS A RESIDUAL LIMIT AND IT IS NOW CLOSED — the assertion is kept, flipped,
  // rather than deleted, because the limit is the whole reason the arm was rebuilt. Its note read:
  // "The forward arm reads the rest of the sentence, so a GENERIC explanation that also happens to
  // use a changeset word still fires … the honest repair is to write such a sentence without the
  // word — not to widen the anchor further." The measurement that changed that calculus is in
  // `shorthandIsAboutChangeset`'s doc: #1562 could not state its own task's acceptance criterion
  // without the arm reading it as a claim of exemption, and no recorded true positive ever rode the
  // sentence-scoped arms. Reading only the MODIFIED NOUN is a narrower rule, not a wider one — this
  // sentence modifies `plan-only`→"when", and `changeset` is the subject of a subordinate clause.
  assert.equal(fires("A merged PR is plan-only when its whole changeset sits under plan/."), false);
});

// ── THE ATTRIBUTIVE FORM: the arm that replaced the two sentence-scoped ones ──────────────────

test("the ATTRIBUTIVE form fires when the noun the shorthand modifies IS the changeset", () => {
  // These are the shapes the old forward scan used to carry, and they are the reason it cannot
  // simply be deleted: in each, the modified noun is the change itself.
  assert.equal(fires("plan-only change."), true);
  assert.equal(fires("Plan-only edit. No src/ changes here."), true);
  assert.equal(fires("a data-only changeset, reverting three merged PRs."), true);
  assert.equal(fires("**Plan-only** diff, filed by the Architect."), true, "markdown emphasis must not hide the noun");

  // THE LIMIT IS THE VOCABULARY, NOT THE GRAMMAR, and it is UNCHANGED by this task rather than
  // introduced by it: `revert` is not in CHANGESET_CONTEXT_RE, so "a data-only revert" is silent —
  // MEASURED silent under the previous predicate too, by replicating it and running this string.
  // Widening that word list is a separate decision with its own false-positive surface, so it is
  // named here rather than smuggled in beside a narrowing.
  assert.equal(fires("This is a data-only revert of three merged PRs."), false);
});

test("the COPULAR arm carries the self-referential subjects the backward arm used to catch", () => {
  // RECALL, PINNED. "This change is plan-only." was reached ONLY by the removed backward arm — the
  // old copular regex required `this`/`it`/`these changes`/`the diff|change|changeset|pr` + a
  // linking verb, so "This CHANGE is" matched neither half. Deleting the backward arm without
  // widening this one would have dropped a genuine claim, which is the failure mode a narrowing
  // must not have. Each of these is a real claim of exemption and each must still fire.
  for (const body of [
    "This change is plan-only.",
    "These changes are plan-only.",
    "This commit is data-only.",
    "The changeset is plan-only.",
    "The patch is data-only.",
    "This revert is data-only.",
  ]) {
    assert.equal(fires(body), true, `a self-referential subject predicating the shorthand: ${body}`);
  }
});

test("the LABEL form survives a CLOSING DELIMITER that is markdown emphasis or a bracketing aside", () => {
  // FOUND BY THE FULL-GLOB RUN, not by the scoped one: W1-T395 pins that a CLOSING DELIMITER merely
  // ends a SPAN, not a sentence — `**Plan-only**:` and `(Plan-only):` still reach the colon and
  // read as a label. That still holds for emphasis (`*`/`_`/backtick pairs used as styling) and for
  // a parenthetical aside; neither opens an unbalanced quote span on this line.
  assert.equal(fires("Plan-only: no source touched."), true, "bare");
  assert.equal(fires("(Plan-only): one shard added."), true, "parenthesised");
});

test("W1-T2549: the LABEL form is silent when the shorthand itself sits inside an inline-quoted span", () => {
  // SUPERSEDES the prior pinning here. `"Plan-only": …` and `` `data-only`: … `` open an unbalanced
  // quote/backtick span immediately before the shorthand — the same shape {@link
  // isInsideInlineQuote} already exempted on the COUNT arm (W1-T2534). #3422's second body was
  // refused for exactly this: quoting the label form it was documenting. The label, copular and
  // attributive arms now agree with the count arm instead of disagreeing with it.
  assert.equal(fires('"Plan-only": no source touched.'), false, "quoted — read as a mention, not a claim");
  assert.equal(fires("`data-only`: one shard added."), false, "backticked — same reasoning as the quoted form");
});

test("the modified noun is read on THIS line only, and never through punctuation into a path", () => {
  assert.equal(fires("plan-only\nchanges are listed below."), false, "a word on the next line is another sentence");
  assert.equal(fires("see fixtures/data-only-corpus.json"), false, "a hyphen is not whitespace, so no noun follows");
  assert.equal(fires("test/trailer-credit-plan-only.test.ts"), false, "nor is a period — this is the W1-T413 shape");
});

// ── THE THREE RECORDED FALSE POSITIVES, EACH PINNED BY ITS OWN REAL TEXT ──────────────────────

test("W1-T413's own required proof line — the instance that earned the anchor — is still silent", () => {
  assert.equal(fires("proof: unit test: test/trailer-credit-plan-only.test.ts"), false);
});

test("W1-T427's acceptance criterion, VERBATIM, no longer reads as a claim of exemption", () => {
  // THE INSTANCE THIS CHANGE IS FOR, quoted from plan/tasks.d/W1-T427-*.yaml rather than invented.
  // It fired the BACKWARD arm: the sentence opens "a diff touching …", so a changeset word preceded
  // the shorthand and `claimsChangesetContext` reported true — on a sentence whose subject is a
  // GENERIC diff and whose modified noun is `carve-out`. #1562 was forced to reword to merge.
  const criterion =
    "a diff touching any enforcement-data path loses the plan-only carve-out with the category " +
    "named in the reason, while a pure shard filing keeps it byte-identically";
  assert.equal(fires(criterion), false);
});

test("describing the rule in either direction is silent — the shape a body cannot avoid when it CHANGES the rule", () => {
  // BACKWARD (a changeset word before the shorthand) and FORWARD (one after it, in the same
  // sentence, modifying nothing). Both used to fire; both are descriptions.
  assert.equal(fires("This PR denies the plan-only carve-out to enforcement data."), false, "backward");
  assert.equal(fires("The plan-only carve-out exempts a plan-scope diff from the proof floor."), false, "forward");
  assert.equal(fires("The refusal fires when a merged PR is plan-only in the sense the predicate means."), false);
});

test("the LABEL form still fires — the shape the house style actually writes", () => {
  // A colon makes the shorthand the subject of the line even when the elaboration carries no
  // changeset verb at all, which is why the label is recognised separately from the prose forms.
  assert.equal(fires("**Plan-only**: one shard added."), true);
  assert.equal(fires("data-only: no code. Reverts stale exports."), true);
});

test("a true claim is still silent — the contradiction is about the DIFF, not the wording", () => {
  // Same body, a genuinely plan-scope-only changeset: nothing to contradict.
  assert.equal(bodyContradictsDiff("This PR is plan-only.", ["plan/tasks.d/W1-T413-x.yaml"]).length, 0);
});

// ── THE TEETH, PROVEN WHERE THEY BITE: judgeReview, not just the predicate ────────────────────
//
// `changesetContradictions` is what forces `state: "failure"`, so a narrowing that let a real claim
// of exemption past would be worse than every false positive it removes. Proven end-to-end, and
// proven to reach THIS arm rather than the count or `no <path>` arm — a fixture that trips a
// different arm proves nothing about this one.

const CRITERIA: AcceptanceCriterion[] = [
  { claim: "the widget is wired", proof: "widget wired and verified" },
];
const RESPONSIVE_REPORT = "REPORT\n- widget wired and verified.\nPR_URL: https://github.com/o/r/pull/7";
const SRC_TOUCHING_DIFF = `diff --git a/src/lib/widget.ts b/src/lib/widget.ts
+++ b/src/lib/widget.ts
@@
+export function widget() {}`;
const PLAN_ONLY_DIFF = `diff --git a/plan/tasks.d/W1-T999-x.yaml b/plan/tasks.d/W1-T999-x.yaml
+++ b/plan/tasks.d/W1-T999-x.yaml
@@
-  status: queued
+  status: blocked`;

test("PRECONDITION: the fixture meets the keyword floor, so a FAIL below is the contradiction and not an unmet claim", () => {
  const v = judgeReview(CRITERIA, { diff: PLAN_ONLY_DIFF, report: RESPONSIVE_REPORT });
  assert.equal(v.state, "success", "no contradiction and a met claim — anything else invalidates the traps below");
  assert.deepEqual(v.changesetContradictions, []);
});

test("THE TRAP: a body claiming exemption over a src/-touching diff still FAILS, via THIS arm", () => {
  const v = judgeReview(CRITERIA, {
    diff: SRC_TOUCHING_DIFF,
    report: `${RESPONSIVE_REPORT}\n\nThis PR is plan-only.`,
  });
  assert.equal(v.state, "failure", "the arm's whole purpose — a false exemption claim must not merge");
  const hits = v.changesetContradictions ?? [];
  assert.ok(v.changesetContradictions !== undefined, "the field is populated, so `?? []` below is never the fallback");
  assert.deepEqual(
    hits.map((c) => c.claim),
    ["plan-only"],
    "REACHABILITY: the shorthand arm fired, not the count arm or the `no <path>` arm",
  );
  assert.deepEqual(hits[0]?.files, ["src/lib/widget.ts"], "and it names the refuting file");
  assert.match(v.summary, /plan-only/, "the posted status quotes the claim back");
});

test("THE TRAP, sibling shorthand: the label form over a src/-touching diff still FAILS", () => {
  const v = judgeReview(CRITERIA, {
    diff: SRC_TOUCHING_DIFF,
    report: `${RESPONSIVE_REPORT}\n\ndata-only: no widget logic changed.`,
  });
  assert.equal(v.state, "failure");
  assert.ok(
    (v.changesetContradictions ?? []).some((c) => c.claim === "data-only"),
    "REACHABILITY: #1025's own shape still rides the label arm",
  );
});

test("CONTROL: the SAME exemption claim over a genuinely plan-scope diff passes — the contradiction is about the DIFF", () => {
  const v = judgeReview(CRITERIA, {
    diff: PLAN_ONLY_DIFF,
    report: `${RESPONSIVE_REPORT}\n\nThis PR is plan-only.`,
  });
  assert.equal(v.state, "success");
  assert.deepEqual(v.changesetContradictions, []);
});

// ── FALSIFIER ────────────────────────────────────────────────────────────────────────────────

test("MUTANT: dropping the anchor makes the required proof path contradict the diff again", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/lib/review.ts", import.meta.url), "utf8");
  const target = "    if (!shorthandIsAboutChangeset(scan, m.index ?? 0, m[0].length)) continue;\n    const violators = diffFiles.filter((f) => !isInPlanScope(f));";
  assert.equal(src.split(target).length - 1, 1, "the substitution target must be UNIQUE or the mutant proves nothing");

  // The copy goes under `test/`, NOT `os.tmpdir()` — a mutant outside the project root re-enters
  // the real src/lib graph and destroys the coverage record of modules this suite never mentions.
  // The whole measurement is in test/helpers/mutant-module.ts; do not inline this back to tmpdir.
  const mutantPath = writeMutantModule(
    "review.ts",
    src.replace(target, "    const violators = diffFiles.filter((f) => !isInPlanScope(f));"),
  );
  const mutant = (await import(mutantPath)) as typeof import("../src/lib/review.js");

  const proofLine = "proof: unit test: test/trailer-credit-plan-only.test.ts";
  assert.equal(
    mutant.bodyContradictsDiff(proofLine, SRC_DIFF).length > 0,
    true,
    "the mutant must reach the bad state — the unanchored word firing on a path",
  );
  assert.equal(fires(proofLine), false, "and the real module must not");
});
