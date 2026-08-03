import assert from "node:assert/strict";
import { test } from "node:test";
import { bodyContradictsDiff } from "../src/lib/review.js";

// ── W1-T308 ──────────────────────────────────────────────────────────────────
//
// THREE INSTANCES IN ONE DAY, all TRUE positives by `bodyContradictsDiff`'s
// reading and all wrong in intent. PR #1194 (the backtick fix) quoted the
// failing fixture from #1192 verbatim inside a blockquote; the predicate read
// that quotation as #1194's own claim and failed it over a two-file diff. PR
// #1206 (filing W1-T307) cited #1202's body the same way and was failed over
// a one-file plan shard. Both passed once the quotation was paraphrased, with
// no change to any code or to the diff.
//
// THE PREDICATE HAD NO NOTION OF QUOTED OR ILLUSTRATIVE TEXT — it scanned the
// whole body for the claim shape, so a blockquote, a fenced block, or a
// sentence reporting what ANOTHER PR said was indistinguishable from an
// assertion about this changeset. A quotation is not an assertion.

const TWO_FILE_DIFF = ["src/lib/review.ts", "test/quoted-changeset-claim.test.ts"];
const ONE_FILE_DIFF = ["plan/tasks.d/W1-T307-example.yaml"];

test("bodyContradictsDiff: a false count claim inside a blockquote is not read as the PR's own assertion", () => {
  const body = [
    "This fix addresses the false failure reported below:",
    "",
    "> This PR touches exactly 3 files: `a.ts`, `b.ts`, `c.ts`.",
    "",
    "Only the backtick handling changed.",
  ].join("\n");
  assert.deepEqual(
    bodyContradictsDiff(body, TWO_FILE_DIFF),
    [],
    "a quoted claim about ANOTHER PR's changeset must not be read as this PR's own",
  );
});

test("bodyContradictsDiff: a false 'no <path>' claim inside a blockquote is not read as the PR's own assertion", () => {
  const body = ["Quoting the earlier incident write-up:", "", "> plan-only, no src/ changes here."].join("\n");
  assert.deepEqual(bodyContradictsDiff(body, TWO_FILE_DIFF), [], "a quoted absence claim must stay silent");
});

test("bodyContradictsDiff: a false count claim inside a fenced code block is not read as the PR's own assertion", () => {
  const body = [
    "Reproduction of the fixture that triggered the false failure:",
    "",
    "```",
    "This PR touches exactly 1 file: MASTER-PLAN.md.",
    "```",
    "",
    "Filed as W1-T307.",
  ].join("\n");
  assert.deepEqual(
    bodyContradictsDiff(body, ONE_FILE_DIFF),
    [],
    "a claim inside a fenced code block is illustrative, not asserted",
  );
});

test("bodyContradictsDiff: an UNQUOTED claim that contradicts the diff still fails", () => {
  const body = "This PR touches exactly 3 files: `a.ts`, `b.ts`, `c.ts`.";
  const hits = bodyContradictsDiff(body, TWO_FILE_DIFF);
  assert.equal(hits.length, 1, "an unquoted contradiction must still be caught");
  assert.match(hits[0].claim, /exactly 3 files/i);
});

test("bodyContradictsDiff: a real (unquoted) claim following a quoted one in the same body is still read", () => {
  const body = [
    "Quoting the earlier false failure for the record:",
    "",
    "> This PR touches exactly 1 file: MASTER-PLAN.md.",
    "",
    "In reality this PR touches exactly 3 files.",
  ].join("\n");
  const hits = bodyContradictsDiff(body, TWO_FILE_DIFF);
  assert.equal(hits.length, 1, "the quoted claim is silent but the real, unquoted claim after it must still fire");
  assert.match(hits[0].claim, /exactly 3 files/i);
});
