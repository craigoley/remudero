// W1-T3708 — THE REFUSAL NAMED A REMEDY THAT DID NOT WORK.
//
// `recognizeChangesetClaims` has three claim arms. The count arm reaches `isInsideInlineQuote`
// through `claimsChangesetContext`; the plan-only/data-only shorthands through
// `shorthandIsAboutChangeset`. The `no <path>` arm had only a FORWARD anchor, so a body that did
// exactly what the status text instructs — "backtick a mention to quote it" — was refused again.
//
// MEASURED 2026-09-16: #5792 looped twice with its body edited to `no code changed` in between,
// and #5785 the same. This suite pins BOTH directions: a quoted mention is silent, an unquoted
// claim still refuses.
import assert from "node:assert/strict";
import test from "node:test";
import { recognizeChangesetClaims } from "../src/lib/review.js";

/** A diff that a "no code" claim is FALSE about — it touches src/ and test/. */
const CODE_DIFF = ["src/lib/review.ts", "test/foo.test.ts", ".remudero/mounts.yaml"];

// ── The mention: quoted, therefore reporting rather than asserting ───────────────────────────────

test("an absence claim inside an inline code span is a mention, not a contradiction", () => {
  // #5792's real shape, reduced: the phrase sits inside a backtick span on its own line.
  const body = "Reverted — for that dead branch specifically, `no code changed`; the diff this PR ships is elsewhere.";
  const r = recognizeChangesetClaims(body, CODE_DIFF);
  assert.deepEqual(r.contradictions, [], "a backticked mention must not contradict the diff");
});

test("a double-quoted mention is silenced too, the other delimiter the escape counts", () => {
  const body = 'The earlier refusal said "no code" — this diff does change code.';
  assert.deepEqual(recognizeChangesetClaims(body, CODE_DIFF).contradictions, []);
});

test("a quoted mention is not counted as a recognised claim", () => {
  // The counter separates "read a claim and it agreed" from "never read a claim". A quotation is
  // the second, so it must not inflate the first.
  const quoted = recognizeChangesetClaims("Prior verdict: `no code`.", CODE_DIFF);
  const none = recognizeChangesetClaims("Nothing claim-shaped here at all.", CODE_DIFF);
  assert.equal(quoted.recognisedCount, none.recognisedCount, "a mention is not a recognised claim");
});

// ── The assertion: unquoted, therefore still refused. This is the half that must not weaken. ─────

test("an UNQUOTED absence claim about the changeset still contradicts the diff", () => {
  // MEASURED: this phrasing trips BOTH the absence arm and the data-only shorthand, so the
  // house shorthand yields TWO contradictions. Asserting 1 would pin a number the code never had.
  const body = "This is data-only: no code.";
  const r = recognizeChangesetClaims(body, CODE_DIFF);
  assert.equal(r.contradictions.length, 2, "an unquoted claim is an assertion and must still refuse");
  assert.match(r.contradictions[0].claim, /no code/i);
  assert.ok(r.contradictions[0].files.includes("src/lib/review.ts"), "the violators name the code it touched");
});

test("an unquoted claim that is TRUE about its diff stays silent", () => {
  assert.deepEqual(recognizeChangesetClaims("This is data-only: no code.", [".remudero/mounts.yaml"]).contradictions, []);
});

// ── A half-open span must not hand out a blanket exemption for the rest of the line ──────────────

test("an unbalanced delimiter does not silence everything after it", () => {
  // One backtick opens a span; the claim BEFORE it is outside and must still be judged.
  const body = "no code changes in this PR, and then a stray ` backtick";
  assert.equal(recognizeChangesetClaims(body, CODE_DIFF).contradictions.length, 1);
});

test("a span that closes before the claim leaves it exposed", () => {
  const body = "`quoted bit` and then no code changes in this diff.";
  assert.equal(recognizeChangesetClaims(body, CODE_DIFF).contradictions.length, 1, "even delimiter count = outside the span");
});

// ── The three arms must agree about the same quoted body ─────────────────────────────────────────

test("the count arm and the absence arm agree that a quoted body asserts nothing", () => {
  const body = "The refusal read: `exactly one file` and `no code`.";
  assert.deepEqual(recognizeChangesetClaims(body, CODE_DIFF).contradictions, [],
    "neither arm may refuse what the other would silence");
});

test("a quoted plan-only mention is silent while an unquoted one is judged", () => {
  const quoted = recognizeChangesetClaims("It said `plan-only` about a different PR.", CODE_DIFF);
  assert.deepEqual(quoted.contradictions, []);
  const asserted = recognizeChangesetClaims("This changeset is plan-only.", CODE_DIFF);
  assert.equal(asserted.contradictions.length, 1);
});
