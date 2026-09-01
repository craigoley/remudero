import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { bodyContradictsDiff } from "../src/lib/review.js";
import { writeMutantModule } from "./helpers/mutant-module.js";

/**
 * W1-T2549 — THE INLINE-QUOTATION GUARD COVERED ONE OF `bodyContradictsDiff`'S FOUR ARMS.
 *
 * W1-T308 established that quotation is not assertion for BLOCK-level quotation
 * (`stripQuotedRegions` blanks fenced blocks and blockquote lines). W1-T2534 extended that to
 * INLINE spans, but only for the COUNT arm, via `isInsideInlineQuote` called first inside
 * `claimsChangesetContext`. The label arm (`shorthandIsAboutChangeset`'s colon check), the
 * copular arm (`SELF_REFERENTIAL_CLAIM_RE`) and the attributive arm (`SHORTHAND_HEAD_NOUN_RE`)
 * had no such guard, so an inline-quoted scope label was still read as this body's own claim.
 *
 * MEASURED, one operator session, 2026-08-31: six PR bodies were refused for quoting a phrase
 * they were documenting. Three of the six were the PR fixing this very detector: #3422's first
 * body (count arm, fixed by W1-T2534), #3422's second body (LABEL arm, still broken after the
 * count-arm fix — see its own merged text: "That the label arm still fires on a quoted label is
 * exactly what refused this PR's second body"), and #3421, whose measurement table was made to
 * pass only by moving it into a FENCED block — the block-level escape hatch W1-T308 built. The
 * literals were byte-identical to an inline quotation; only the wrapper changed.
 *
 * THE FIX hoists the existing `isInsideInlineQuote` call (W1-T2534) into `shorthandIsAboutChangeset`
 * — the ONE function that already implements the label, copular and attributive arms — rather than
 * reimplementing it three times, which is exactly how the count arm and this one drifted apart the
 * first time.
 */

/** Not plan scope and not data-only-shaped: any true plan-only/data-only claim contradicts it. */
const SRC_DIFF = ["src/lib/widget.ts"];
const TWO_FILE_DIFF = ["src/lib/a.ts", "src/lib/b.ts"];

function fires(body: string, diff: string[] = SRC_DIFF): boolean {
  return bodyContradictsDiff(body, diff).length > 0;
}

// ── Criterion 1: an inline-quoted scope label is not read as this body's own claim ────────────

test("criterion 1: an inline-quoted LABEL claim is a mention, not this body's own claim", () => {
  // The elaboration deliberately avoids "no <path>" — that shape rides the DENIAL arms (W1-T2533),
  // out of scope here (rationale point 5c), and firing on IT would prove nothing about this guard.
  assert.equal(fires('"Plan-only": one shard added.'), false, "double-quoted label");
  assert.equal(fires("`data-only`: one shard added."), false, "backticked label");
});

// ── Criterion 2: the copular and attributive arms share the same guard, so all four agree ─────

test("criterion 2: an inline-quoted COPULAR claim is a mention, not this body's own claim", () => {
  const body = 'The earlier body said "This is plan-only." — wrongly, and was refused for exactly that.';
  assert.equal(fires(body), false);
});

test("criterion 2: an inline-quoted ATTRIBUTIVE claim is a mention, not this body's own claim", () => {
  const body = 'The trigger sentence read "a plan-only change" verbatim in the incident log.';
  assert.equal(fires(body), false);
});

test("criterion 2: the COUNT arm (W1-T2534) agrees with the other three, so all four arms are consistent", () => {
  const body = 'The table listed "exactly 1 file" among the trigger strings under review.';
  assert.equal(fires(body, TWO_FILE_DIFF), false, "the count arm was already guarded — unchanged by this task");
});

// ── Criterion 3: the floor is unmoved — a genuine unquoted claim still fires in every arm ─────

test("criterion 3: an unquoted claim still fires in every one of the four arms", () => {
  assert.equal(fires("Plan-only: one file added."), true, "LABEL");
  assert.equal(fires("This PR is plan-only."), true, "COPULAR");
  assert.equal(fires("plan-only change."), true, "ATTRIBUTIVE");
  assert.equal(fires("This PR changes exactly 1 file.", TWO_FILE_DIFF), true, "COUNT");
});

// ── Criterion 4: one predicate, shared, not a copy per arm ─────────────────────────────────────

test("criterion 4: isInsideInlineQuote is defined exactly once and called from both claimsChangesetContext and shorthandIsAboutChangeset", () => {
  const src = readFileSync(new URL("../src/lib/review.ts", import.meta.url), "utf8");
  const definitions = src.match(/function isInsideInlineQuote\(/g) ?? [];
  assert.equal(definitions.length, 1, "there must be exactly one implementation to hoist a call to");

  const calls = src.match(/isInsideInlineQuote\(report, index\)/g) ?? [];
  assert.equal(
    calls.length,
    2,
    "the same call must appear once in claimsChangesetContext (count) and once in shorthandIsAboutChangeset " +
      "(label/copular/attributive) — a third or a differently-shaped call would mean a copy, not a hoist",
  );
});

test("criterion 4 (falsified): removing the hoisted guard from shorthandIsAboutChangeset breaks LABEL, COPULAR and ATTRIBUTIVE together — proving it is ONE shared guard", async () => {
  const src = readFileSync(new URL("../src/lib/review.ts", import.meta.url), "utf8");
  const target =
    "function shorthandIsAboutChangeset(report: string, index: number, length: number): boolean {\n" +
    "  if (isInsideInlineQuote(report, index)) return false;\n" +
    "  const rest = report.slice(index + length);";
  assert.equal(src.split(target).length - 1, 1, "the substitution target must be UNIQUE or the mutant proves nothing");

  const mutatedSrc = src.replace(
    target,
    "function shorthandIsAboutChangeset(report: string, index: number, length: number): boolean {\n" +
      "  const rest = report.slice(index + length);",
  );
  const mutantPath = writeMutantModule("review.ts", mutatedSrc);
  const mutant = (await import(mutantPath)) as typeof import("../src/lib/review.js");

  // A single line removed restores the OLD (buggy) behaviour on all three sub-arms at once —
  // that simultaneity is what proves the guard is shared rather than copied per arm.
  assert.equal(mutant.bodyContradictsDiff('"Plan-only": no source touched.', SRC_DIFF).length > 0, true, "LABEL regresses");
  assert.equal(
    mutant.bodyContradictsDiff('The earlier body said "This is plan-only." — wrongly.', SRC_DIFF).length > 0,
    true,
    "COPULAR regresses",
  );
  assert.equal(
    mutant.bodyContradictsDiff('The trigger sentence read "a plan-only change" verbatim.', SRC_DIFF).length > 0,
    true,
    "ATTRIBUTIVE regresses",
  );

  // And the real module must not.
  assert.equal(fires('"Plan-only": no source touched.'), false, "the real module stays fixed");
});

// ── Criterion 5: #3422's own second body — refused for quoting the label form it documented ───

test("criterion 5: the quoted-label shape that refused #3422's second body now passes", () => {
  // #3422's merged text records the shape without reproducing it verbatim (deliberately, to avoid
  // tripping the very detector it was fixing): a double-quoted `"Plan-only" …the label form…`
  // elaboration, measured "REFUSED" both before and after W1-T2534 (which fixed only the count
  // arm). Reconstructed to that shape, matching the fixtures this repo already carries for the
  // same incident (test/a-mentioned-claim-is-not-a-made-one.test.ts).
  const body = ['Reproducing the incident under discussion:', "", '"Plan-only": one file added.'].join("\n");
  assert.deepEqual(bodyContradictsDiff(body, ["src/lib/a.ts"]), [], "the quoted label must not be read as this body's own claim");
});

// ── Regression: the shared guard keeps the count arm's own bounds, on the shorthand arms too ──

test("the inline-quote span is bounded to the match's own line, on the shorthand arms too", () => {
  const stray = ['A sentence with one " unmatched quote.', "", "Plan-only: one file added."].join("\n");
  assert.equal(fires(stray), true, "an unmatched quote on an earlier line must not exempt a later real claim");
});

test("an apostrophe is not a quote delimiter, on the shorthand arms too", () => {
  assert.equal(fires("It isn't complicated: this is plan-only."), true);
});
