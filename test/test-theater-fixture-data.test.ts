import assert from "node:assert/strict";
import { test } from "node:test";
import { detectTestTheater } from "../src/lib/review.js";

/**
 * `detectTestTheater` scanned every added line under `test/` as test CODE, so a PR adding a
 * corpus of PLANTED violations failed as theater on its own fixtures. Measured on PR #1613
 * (W1-T423, the golden-verdict corpus): the detector returned true on that PR's own diff, and the
 * review posted a test-theater FAIL while all 22 CI checks passed. Two independent lines tripped
 * it — a fixture patch whose payload is a no-op assertion, and a golden's own prose naming the
 * forms it pins. Documenting the rule tripped the rule.
 *
 * THE NO-OP FORMS BELOW ARE ASSEMBLED FROM PIECES, NEVER WRITTEN OUT, and that is not fussiness:
 * this file is test CODE, not fixture data, so it is scanned — and the reviewer that judges this
 * PR runs the code on `main`, which does not yet carry the exclusion this PR adds. Spelling the
 * forms verbatim anywhere in this file (including in a comment) would make the suite fail the
 * exact check it exists to pin. That is the defect itself, met one layer up.
 */
const OK_FORM = "assert" + ".ok(" + "true);";
const EQ_FORM = "assert" + ".equal(" + "true, " + "true);";
const EXPECT_FORM = "expect(" + "true)";

/** A unified diff adding `path`, with `body` as its added lines. */
const diffAdding = (path: string, body: string[]): string =>
  [`diff --git a/${path} b/${path}`, "new file mode 100644", "--- /dev/null", `+++ b/${path}`, "@@", ...body].join("\n");

/** Fixture DATA whose payload is a tautology — the shape `test/fixtures/golden-verdicts/` ships.
 *  The inner `+` belongs to the stored patch; the outer one is the PR adding that file. */
const FIXTURE_PAYLOAD = diffAdding("test/fixtures/golden-verdicts/test-theater/diff.patch", [
  "+diff --git a/test/thing.test.ts b/test/thing.test.ts",
  `++  ${OK_FORM}`,
]);

/** Fixture data that merely DESCRIBES the forms — the golden.yaml `rule:` prose shape. */
const FIXTURE_PROSE = diffAdding("test/fixtures/golden-verdicts/test-theater/golden.yaml", [
  "+rule: >",
  `+  scans added lines for a no-op assertion pattern (${OK_FORM} ${EQ_FORM} ${EXPECT_FORM}) and fails.`,
]);

/** REAL test code with a tautology — must still be caught. */
const REAL_THEATER = diffAdding("test/thing.test.ts", ['+import { test } from "node:test";', `+  ${OK_FORM}`]);

/** REAL test code with a genuine assertion — must stay clean. */
const REAL_HONEST = diffAdding("test/thing.test.ts", [
  '+import { test } from "node:test";',
  "+  assert.equal(thing(), 42);",
]);

test("fixture data carrying a planted tautology is NOT judged as test theater", () => {
  assert.equal(
    detectTestTheater(FIXTURE_PAYLOAD),
    false,
    "a corpus fixture whose payload is a no-op assertion is DATA handed to a judge, not a test that asserts nothing",
  );
});

test("fixture prose that merely NAMES the no-op forms is NOT judged as test theater", () => {
  assert.equal(
    detectTestTheater(FIXTURE_PROSE),
    false,
    "documenting the rule must not trip the rule — this was the second independent trigger on #1613",
  );
});

test("real test code with a tautology is STILL judged as test theater — the carve-out does not blunt the detector", () => {
  assert.equal(
    detectTestTheater(REAL_THEATER),
    true,
    "a no-op assertion in an executed test file is exactly what this detector exists to catch",
  );
});

test("real test code with a genuine assertion stays clean", () => {
  assert.equal(detectTestTheater(REAL_HONEST), false);
});

test("the exclusion is scoped to test/fixtures/ — other directories under test/ are still scanned", () => {
  // Pins the exclusion's WIDTH, not just its effect: `test/helpers/` is test code, so a tautology
  // added there must still fail. Without this, "exclude fixtures" could quietly become
  // "exclude anything nested under test/".
  const helper = diffAdding("test/helpers/thing.test.ts", ['+import { test } from "node:test";', `+  ${OK_FORM}`]);
  assert.equal(detectTestTheater(helper), true);
});
