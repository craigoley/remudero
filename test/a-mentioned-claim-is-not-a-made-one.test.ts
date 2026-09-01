import { strict as assert } from "node:assert";
import { test } from "node:test";
import { bodyContradictsDiff, claimsChangesetContext } from "../src/lib/review.js";

/**
 * W1-T2534 — a quotation is not an assertion, and W1-T308 already established that for BLOCK-level
 * quotation: `stripQuotedRegions` blanks fenced blocks and blockquote lines. It does NOT touch an
 * INLINE span, so a body REPORTING another PR's count read identically to one making that count.
 *
 * MEASURED — the exact sentence that refused #3388, and again #3408 whose entire subject is this
 * detector. `claimsChangesetContext` scans BACKWARD to the sentence start, finds "changes the
 * diff", and reads the quoted count as this body's own. Three PR bodies in one session were
 * refused this way, including the one documenting the trap.
 */

const DIFF = ["scripts/source-size-ratchet.mjs", "test/a-source-file-cannot-outgrow-its-baseline.test.ts"];
const body = (line: string) => ["Intro.", "", line, "", "Acceptance:", "- c | unit test: test/x.test.ts", ""].join("\n");
const refused = (line: string, d = DIFF) => bodyContradictsDiff(body(line), d).length > 0;

test("W1-T2534 criterion 1: a body reporting another PR's count is not refused as having made it", () => {
  for (const line of [
    'The three PRs each claimed "exactly 4 files" while the diff carried 5.',
    "#3365 asserted `exactly 4 files` in a diff that held five.",
    'PR #3378 said "exactly 4 files" but the changeset was larger.',
  ]) {
    assert.equal(refused(line), false, `reporting is not asserting: ${line}`);
  }
});

test("W1-T2534 criterion 5: #3388's VERBATIM trigger sentence is a fixture and passes", () => {
  // The observation this task is anchored to — reproduced exactly, and REFUSED before this change.
  const real = 'Adding the baseline line changes the diff — so a body that said "exactly 4 files" is now false.';
  assert.equal(refused(real), false, "the sentence that refused #3388 and #3408 must now pass");
  // The mechanism, asserted directly rather than only through the end-to-end verdict: the count
  // sits inside an inline span, so the backward context scan must not claim it.
  const i = real.indexOf("exactly 4 files");
  assert.ok(i > 0);
  assert.equal(claimsChangesetContext(real, i), false, "a quoted count is never this body's own context");
});

test("W1-T2534 criterion 2: a genuine UNQUOTED count claim in changeset context is still refused", () => {
  // THE FLOOR. If this ever goes silent, the exemption has become a general escape hatch.
  assert.equal(refused("This changeset is exactly 4 files."), true);
  assert.equal(refused("The diff is exactly 4 files."), true);
  assert.equal(refused("This PR changes exactly 4 files."), true);
});

test("W1-T2534 criterion 3 (superseded by W1-T2549): the BARE label arm is untouched by the count-arm fix", () => {
  // W1-T2534 touched only the COUNT arm's context scan, so at the time this pinned that the label
  // arm's bare (unquoted) form was byte-for-byte as it was. That remains true; see the QUOTED forms
  // below for what W1-T2549 changed.
  const d = ["src/lib/a.ts"];
  assert.equal(refused("Plan-only: no source touched.", d), true, "the bare form still fires");
});

// W1-T2549 — the label, copular and attributive arms now share {@link isInsideInlineQuote} with the
// count arm above, so a quoted label is a MENTION rather than this body's own claim, the same as a
// quoted count. This is the exact shape that refused #3422's second body (rationale point 2).
test("W1-T2549: the label arm is silent on a quoted label, matching the count arm's own inline-quote guard", () => {
  const d = ["src/lib/a.ts"];
  assert.equal(refused('"Plan-only": no source touched.', d), false, "a quoted label is a mention, not a claim");
  assert.equal(refused("`Plan-only`: one file.", d), false, "backticked — same reasoning");
});

test("W1-T2549 criterion 5 (#3422's second body): the verbatim quoted-label body that was wrongly refused now passes", () => {
  // rationale point (2): #3422's second body quoted the LABEL form it was documenting and was
  // refused for it, after its first (count-arm) body had already been fixed per W1-T2534.
  assert.equal(refused('"Plan-only": one file added.', ["src/lib/a.ts"]), false);
});

test("W1-T2534: the span is bounded to the match's OWN LINE", () => {
  // A stray unmatched quote earlier in a long body must not silence every claim after it.
  const stray = ['A sentence with one " unmatched quote.', "", "This changeset is exactly 4 files."].join("\n");
  assert.ok(
    bodyContradictsDiff(["Intro.", "", stray, "", "Acceptance:", "- c | unit test: test/x.test.ts", ""].join("\n"), DIFF).length > 0,
    "an unmatched quote on an EARLIER line must not exempt a later real claim",
  );
});

test("W1-T2534: an apostrophe is not a quote delimiter", () => {
  // Counting `'` would silence half of any body that uses contractions.
  assert.equal(refused("It isn't complicated: this changeset is exactly 4 files."), true);
});

test("W1-T2534: block-level quotation still works, so W1-T308 is not regressed", () => {
  assert.equal(refused("> This changeset is exactly 4 files."), false, "a blockquote is still a quotation");
});
