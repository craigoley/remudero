/**
 * W1-T14627: proof-discrimination honours a PR body's `kind: guard` on a PR that names its task, because Actions cannot
 * read an ops-catalog record. remudero-review reads the record, so it is the half that refuses a body guard the record
 * does not declare: `markUnbackedBodyGuards` marks it and `judgeReview` fails that criterion.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { BODY_GUARD_UNBACKED, judgeReview, markUnbackedBodyGuards, parseAcceptanceBlock } from "#src/lib/review.js";
import type { AcceptanceCriterion } from "#src/lib/plan.js";

const PROOF = "unit test: the committed registry keeps every other row";
const BODY = `## Acceptance\n\n- claim: the rows stay as they were\n  proof: ${PROOF}\n  kind: guard\n`;
const RECORD: AcceptanceCriterion = { claim: "the rows stay as they were", proof: PROOF };
const RECORD_GUARD = { ...RECORD, kind: "guard" } as AcceptanceCriterion;
const DIFF = "diff --git a/src/x.ts b/src/x.ts\n--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1 +1 @@\n-a\n+b\n";

const judge = (criteria: AcceptanceCriterion[]) =>
  judgeReview(criteria, { diff: DIFF, report: "the rows stay as they were", headCheckoutDir: "/head", execProof: () => "pass" });

test("W1-T14627: review refuses a body guard its record does not declare", () => {
  const body = parseAcceptanceBlock(BODY);
  const checked = markUnbackedBodyGuards([RECORD], body, false);
  assert.deepEqual(checked.unbacked, [PROOF]);
  const verdict = judge(checked.criteria);
  assert.equal(verdict.state, "failure");
  assert.equal(verdict.criteria[0]!.met, false);
  assert.match(verdict.criteria[0]!.reason, new RegExp(BODY_GUARD_UNBACKED));

  // A body with no task record behind it backs no guard either.
  const fromBody = markUnbackedBodyGuards(body, body, true);
  assert.deepEqual(fromBody.unbacked, [PROOF]);
});

test("a body guard whose proof differs from every record proof is refused, naming that proof", () => {
  const edited = "unit test: edited";
  const body = parseAcceptanceBlock(BODY.replace(PROOF, edited));
  const checked = markUnbackedBodyGuards([RECORD_GUARD], body, false);
  assert.deepEqual(checked.unbacked, [edited]);
  assert.equal(checked.criteria.length, 2);
  const verdict = judge(checked.criteria);
  assert.equal(verdict.state, "failure");
  const refused = verdict.criteria.find((c) => c.proof === edited)!;
  assert.equal(refused.met, false);
  assert.match(refused.reason, new RegExp(BODY_GUARD_UNBACKED));
  assert.ok(refused.reason.includes(edited));
  // A record guard backs the body guard even when a plain record criterion shares its proof.
  const plain = markUnbackedBodyGuards([RECORD, RECORD_GUARD], parseAcceptanceBlock(BODY), false);
  assert.deepEqual(plain.unbacked, []);
});

test("a body guard its record declares, and a body with no guard, pass through unmarked", () => {
  const backed = markUnbackedBodyGuards([RECORD_GUARD], parseAcceptanceBlock(BODY), false);
  assert.deepEqual(backed.unbacked, []);
  assert.deepEqual(backed.criteria, [RECORD_GUARD]);
  const plain = markUnbackedBodyGuards([RECORD], parseAcceptanceBlock(BODY.replace("  kind: guard\n", "")), false);
  assert.deepEqual(plain.unbacked, []);
  assert.notEqual(judge(plain.criteria).criteria[0]!.met, false);
});
