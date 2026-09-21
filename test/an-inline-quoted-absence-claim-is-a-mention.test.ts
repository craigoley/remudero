import assert from "node:assert/strict";
import test from "node:test";
import { recognizeChangesetClaims } from "../src/lib/review.js";

const CODE_DIFF = ["src/lib/review.ts", "test/foo.test.ts", ".remudero/mounts.yaml"];
const BT = String.fromCharCode(96);

test("an inline-quoted absence claim is a mention, not a contradiction", () => {
  const body = "Earlier refusal: " + BT + "no code" + BT + ".";
  const result = recognizeChangesetClaims(body, CODE_DIFF);
  assert.deepEqual(result.contradictions, []);
});

test("a double-quoted absence mention is silent too", () => {
  const body = "The earlier refusal said \\\"no code\\\" — this diff does change code.";
  assert.deepEqual(recognizeChangesetClaims(body, CODE_DIFF).contradictions, []);
});

test("a quoted mention is not counted as a recognised claim", () => {
  const quoted = recognizeChangesetClaims("Prior verdict: " + BT + "no code" + BT + ".", CODE_DIFF);
  const none = recognizeChangesetClaims("Nothing claim-shaped here at all.", CODE_DIFF);
  assert.equal(quoted.recognisedCount, none.recognisedCount);
});

test("an unquoted absence claim still contradicts the changeset", () => {
  const result = recognizeChangesetClaims("This is data-only: no code.", CODE_DIFF);
  assert.equal(result.contradictions.length, 2);
  assert.match(result.contradictions[0].claim, /no code/i);
});

test("an unquoted absence claim that is true stays silent", () => {
  const result = recognizeChangesetClaims("This is data-only: no code.", [".remudero/mounts.yaml"]);
  assert.deepEqual(result.contradictions, []);
});

test("an unbalanced delimiter does not silence a claim before it", () => {
  const body = "no code changes in this PR, and then a stray " + BT + " backtick";
  assert.equal(recognizeChangesetClaims(body, CODE_DIFF).contradictions.length, 1);
});

test("a span closed before the claim leaves it exposed", () => {
  const body = BT + "quoted bit" + BT + " and then no code changes in this diff.";
  assert.equal(recognizeChangesetClaims(body, CODE_DIFF).contradictions.length, 1);
});

test("the count and absence arms agree about a quoted body", () => {
  const body = "The refusal read: " + BT + "exactly one file" + BT + " and " + BT + "no code" + BT + ".";
  assert.deepEqual(recognizeChangesetClaims(body, CODE_DIFF).contradictions, []);
});

test("a quoted plan-only mention is silent while an unquoted one is judged", () => {
  const quoted = recognizeChangesetClaims("It said " + BT + "plan-only" + BT + " about a different PR.", CODE_DIFF);
  assert.deepEqual(quoted.contradictions, []);
  const asserted = recognizeChangesetClaims("This changeset is plan-only.", CODE_DIFF);
  assert.equal(asserted.contradictions.length, 1);
});

