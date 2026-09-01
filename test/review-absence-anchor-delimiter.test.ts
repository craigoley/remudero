/**
 * test/review-absence-anchor-delimiter.test.ts — W1-T395.
 *
 * THE BUG. `noClaimIsAboutChangeset`'s forward anchor treats "the next thing after the token is
 * punctuation" as "the token IS the claim" — right for punctuation that genuinely ENDS a sentence
 * (comma, period, semicolon, end of line, end of input), wrong for a CLOSING DELIMITER (backtick,
 * paren, quote) that merely ends a SPAN. Before the fix, a `no <path>` claim immediately followed
 * by a backtick, paren, or straight quote hit the "punctuation ends it" branch and fired unanchored
 * — even though the identical claim followed by an ordinary (non-changeset) word is correctly
 * suppressed as a compound-noun modifier ("no code DUPLICATION"). The absence arm's behaviour was
 * turning on punctuation rather than meaning.
 *
 * WHAT THIS SUITE PROVES (both directions, per the shard's design (iii) — one direction alone is
 * satisfied by a predicate that never fires at all):
 *   - a delimited claim in a sentence NOT about the changeset stays SILENT, exactly like the bare
 *     (undelimited) form already does;
 *   - a delimited claim in a sentence that IS about the changeset still FIRES, exactly like the
 *     bare form — the anchor is narrowed, not weakened;
 *   - the count arm and the house-shorthand arms (which never call `noClaimIsAboutChangeset` at
 *     all — see the doc comment on that function) return identical verdicts with and without a
 *     NON-QUOTE delimiter present, so the change is confined to the absence anchor and nothing
 *     else moved. (W1-T2549: a QUOTE-shaped delimiter around the shorthand label is a SEPARATE,
 *     later change — see the dedicated test below — because it also means an inline quotation.)
 *
 * All assertions run against the real `bodyContradictsDiff` / `noClaimIsAboutChangeset`, never a
 * reimplementation, per the shard's reproduction note: "hand `bodyContradictsDiff` a body claiming
 * a path is absent, once with a closing delimiter immediately after the claim and once with an
 * ordinary word after it, against a diff that touches that path."
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { bodyContradictsDiff, noClaimIsAboutChangeset } from "../src/lib/review.js";

/** A diff that touches src/, so any "no code"/"no src/…" claim over it is a real contradiction. */
const DIFF = ["src/lib/review.ts", "test/review-absence-anchor-delimiter.test.ts"];

// ── the unit-level anchor: a closing delimiter must not defeat the forward-word test ────────────

test("noClaimIsAboutChangeset: a closing delimiter is skipped, not read as end-of-sentence", () => {
  // The three delimiters the shard measured firing on, each followed by an ORDINARY word — the
  // sentence is not about the changeset ("was ever generated automatically" names nothing
  // changeset-related), so this must stay SILENT, exactly like the undelimited sibling
  // `noClaimIsAboutChangeset(" duplication anywhere")` already asserted false in
  // test/body-vs-diff-contract.test.ts.
  assert.equal(
    noClaimIsAboutChangeset("` was ever generated automatically."),
    false,
    "backtick then an ordinary word — not about the changeset, must stay silent",
  );
  assert.equal(
    noClaimIsAboutChangeset(") was ever generated automatically."),
    false,
    "paren then an ordinary word — not about the changeset, must stay silent",
  );
  assert.equal(
    noClaimIsAboutChangeset('" was ever generated automatically.'),
    false,
    "double quote then an ordinary word — not about the changeset, must stay silent",
  );
  assert.equal(
    noClaimIsAboutChangeset("' was ever generated automatically."),
    false,
    "single quote then an ordinary word — not about the changeset, must stay silent",
  );

  // Same three delimiters, now followed by a genuine changeset word — must still FIRE, so the fix
  // narrows the anchor without weakening it.
  assert.equal(
    noClaimIsAboutChangeset("` changes were made anyway."),
    true,
    "backtick then a changeset word — still about the changeset, must still fire",
  );
  assert.equal(
    noClaimIsAboutChangeset(") changes were made anyway."),
    true,
    "paren then a changeset word — still about the changeset, must still fire",
  );
  assert.equal(
    noClaimIsAboutChangeset('" changes were made anyway.'),
    true,
    "double quote then a changeset word — still about the changeset, must still fire",
  );

  // A delimiter immediately followed by real sentence-end punctuation (not a word at all) is
  // unchanged: still "the token IS the claim", the same as the bare end-of-line/end-of-input cases
  // already pinned in test/body-vs-diff-contract.test.ts.
  assert.equal(
    noClaimIsAboutChangeset("`."),
    true,
    "delimiter immediately followed by a full stop — no word ever appears, token IS the claim",
  );
  assert.equal(noClaimIsAboutChangeset("`"), true, "delimiter at end of input — token IS the claim");

  // A bracket/brace is deliberately NOT in the skipped set (unmeasured — see the code comment on
  // NEXT_WORD_RE) — it still reads as "no word found", so this is unchanged pre- and post-fix.
  assert.equal(
    noClaimIsAboutChangeset("] was ever generated automatically."),
    true,
    "bracket is not an enumerated closing delimiter — token IS the claim, same as before the fix",
  );
});

// ── end-to-end: bodyContradictsDiff's (b) arm over a real diff ──────────────────────────────────

test("bodyContradictsDiff: a delimited absence claim NOT about the changeset stays silent", () => {
  // The live shape from the shard's rationale: the whole claim is inline-quoted, and ordinary
  // prose about something else follows the closing backtick.
  assert.deepEqual(
    bodyContradictsDiff("The docs say `no code` was ever generated automatically.", DIFF),
    [],
    "backtick-delimited claim followed by unrelated prose — silent, same as the bare form",
  );
  assert.deepEqual(
    bodyContradictsDiff("(see `no code`) was ever generated automatically.", DIFF),
    [],
  );
  assert.deepEqual(
    bodyContradictsDiff('The reviewer wrote "no code" was ever generated automatically.', DIFF),
    [],
    "double-quote-delimited claim followed by unrelated prose — silent",
  );
  // The parenthetical form of the same shape.
  assert.deepEqual(
    bodyContradictsDiff("It says (no code) was ever generated automatically.", DIFF),
    [],
    "paren-delimited claim followed by unrelated prose — silent",
  );
});

test("bodyContradictsDiff: a delimited absence claim ABOUT the changeset still fires", () => {
  // Same delimiters, same DIFF, but the word right after the delimiter is a real changeset word —
  // this is the direction the shard's design (iii) calls load-bearing: a predicate that never
  // fires would pass the silent-case tests above vacuously.
  const backtick = bodyContradictsDiff("The docs say `no code` changes were made this PR.", DIFF);
  assert.equal(backtick.length, 1, "backtick-delimited claim followed by a changeset word fires");
  assert.equal(backtick[0]?.claim, "no code");

  const paren = bodyContradictsDiff("It says (no code) changes were made this PR.", DIFF);
  assert.equal(paren.length, 1, "paren-delimited claim followed by a changeset word fires");

  const quote = bodyContradictsDiff('The reviewer wrote "no code" changes were made this PR.', DIFF);
  assert.equal(quote.length, 1, "quote-delimited claim followed by a changeset word fires");

  // Sanity check the fired claims actually resolve against the real diff — `src/lib/review.ts`
  // starts with `src/`, which `no code` matches via the `code` token's src/-or-test/ special case.
  assert.deepEqual(backtick[0]?.files, DIFF);
});

test("bodyContradictsDiff: undelimited claims are completely unaffected by the fix", () => {
  // Re-pin the exact bare-form fixtures from test/body-vs-diff-contract.test.ts against this same
  // DIFF, so a regression in the shared NEXT_WORD_RE would show up here too, not only there.
  assert.deepEqual(
    bodyContradictsDiff("This change introduces no code duplication anywhere.", DIFF),
    [],
    "bare form, ordinary word after the token — still silent",
  );
  assert.deepEqual(
    bodyContradictsDiff("This PR is small.\nIt touches no src/\nMore prose.", DIFF),
    [{ claim: "no src/", files: ["src/lib/review.ts"] }],
    "bare form, end of line — still fires, unchanged",
  );
});

// ── design (v): the count arm and the house-shorthand arms are confirmed UNMOVED ────────────────

test("bodyContradictsDiff: the count arm ('exactly N files') is unaffected by delimiters", () => {
  // The count arm is anchored by claimsChangesetContext (BACKWARD-looking) and never consults
  // noClaimIsAboutChangeset at all, so a delimiter around the count must make no difference before
  // or after this fix. Assert both the undelimited and the delimited phrasing produce the SAME
  // verdict against a diff whose file count actually disagrees.
  const bare = bodyContradictsDiff("This PR changes exactly one file.", DIFF);
  const delimited = bodyContradictsDiff("This PR changes exactly one file` — see the stat.", DIFF);
  assert.equal(bare.length, 1, "bare count claim over a 2-file diff still contradicts");
  assert.equal(
    delimited.length,
    bare.length,
    "a delimiter trailing the count claim does not change the verdict — the count arm is backward-anchored and never consults noClaimIsAboutChangeset",
  );
});

test("bodyContradictsDiff: the house-shorthand arms ('plan-only'/'data-only') are unaffected by a NON-QUOTE delimiter", () => {
  // Same confirmation for the shorthand arms, narrowed to delimiters that are NOT themselves a
  // quote character: a bracketing aside must not change whether the label fires over a
  // src-touching diff. See the QUOTE-shaped case below — W1-T2549 gave that shape its own rule.
  const bare = bodyContradictsDiff("Plan-only: no source touched.", DIFF);
  const parenthesised = bodyContradictsDiff("(Plan-only): no source touched.", DIFF);
  assert.equal(bare.length, parenthesised.length, "a bracketing aside does not change the verdict");
});

// W1-T2549 — a QUOTE-shaped delimiter (`"`, a lone backtick) is no longer "just a delimiter" for
// the shorthand arms: it also means the shorthand sits inside an inline-quoted span, the same
// shape the count arm was already exempting (W1-T2534). Split out from the test above rather than
// folded back in, because the two delimiter classes now produce DIFFERENT verdicts on purpose.
test("bodyContradictsDiff: a QUOTE-shaped delimiter around the shorthand label now silences it (W1-T2549)", () => {
  const bare = bodyContradictsDiff("Plan-only: no source touched.", DIFF);
  const quoted = bodyContradictsDiff('"Plan-only": no source touched.', DIFF);
  assert.equal(bare.length, 1, "the bare form is still a real claim, refused over a src-touching diff");
  assert.deepEqual(quoted, [], "the quoted form is now read as a mention, not this body's own claim");
});
