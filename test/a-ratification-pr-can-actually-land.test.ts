/**
 * test/a-ratification-pr-can-actually-land.test.ts — W1-T3383b.
 *
 * `rmd approve` is the operator's ONE BIT: it turns a ratified proposal into a plan PR. That PR was
 * structurally incapable of landing. `filingAcceptanceCriteria` emitted a single criterion whose
 * proof was PROSE — "this diff's only files are …; commitlint and plan-index-check both pass" —
 * which carries no runnable dialect prefix, so `acceptance-author-gate` REFUSED it with
 * `proof-shape`: the verdict caps at `proof_exec 0/1` and cannot arm.
 *
 * MEASURED 2026-09-11: every open ratification PR on the board was refused this way — #5122, #5123,
 * #5124, #5125 — and each had to have its body repaired by hand before it could be reviewed.
 *
 * A `grep:` on the filed shard resolves where the old objection said it could not. That objection —
 * "a filing PR cannot cite the filed task's own acceptance criteria, because the task does not exist
 * in the checkout `remudero-review` resolves against" — is about citing the task's OWN criteria.
 * This cites the shard FILE, which exists on the PR head the reviewer reads.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { filingAcceptanceCriteria } from "../src/lib/plan-pr-emitter.js";

const SHARDS = [
  "plan/tasks.d/W1-T3392-submit-the-attrition-ruling.yaml",
  "plan/tasks.d/W1-T3393-plan-only-closure.yaml",
];

test("W1-T3383b: every filing criterion carries an EXECUTABLE dialect prefix, so the gate cannot cap the verdict", () => {
  const criteria = filingAcceptanceCriteria(["W1-T3392", "W1-T3393"], [...SHARDS, "MASTER-PLAN.md"]);
  assert.equal(criteria.length, 2, "one criterion per filed shard, so each filing is separately provable");
  for (const c of criteria) {
    assert.match(c.proof, /^(grep:|unit test:)/, `proof must be runnable, got: ${c.proof}`);
  }
});

test("W1-T3383b: the proof greps the shard's own RECORD, never merely its filename", () => {
  const [first] = filingAcceptanceCriteria(["W1-T3392"], SHARDS);
  assert.equal(first.proof, `grep: id: W1-T3392 in ${SHARDS[0]}`);
  assert.ok(
    !first.proof.includes("grep: W1-T3392 in"),
    "a bare id also matches the FILENAME, so it would pass against a file holding no such record",
  );
});

test("W1-T3383b: each id is paired with ITS OWN shard, never with a sibling's", () => {
  const criteria = filingAcceptanceCriteria(["W1-T3393", "W1-T3392"], SHARDS);
  assert.equal(criteria[0].proof, `grep: id: W1-T3393 in ${SHARDS[1]}`);
  assert.equal(criteria[1].proof, `grep: id: W1-T3392 in ${SHARDS[0]}`);
});

test("W1-T3383b: a non-shard file never becomes a proof target", () => {
  const criteria = filingAcceptanceCriteria(["W1-T3392"], ["MASTER-PLAN.md", ...SHARDS]);
  assert.equal(criteria.length, 1);
  assert.ok(!criteria[0].proof.includes("MASTER-PLAN.md"));
});

test("W1-T3383b: an unpairable filing CAPS rather than pointing at the wrong file", () => {
  const criteria = filingAcceptanceCriteria(["W1-T9999"], ["MASTER-PLAN.md"]);
  assert.equal(criteria.length, 1, "the caller still gets a criterion");
  assert.ok(
    !criteria[0].proof.startsWith("grep:"),
    "inventing a path would FAIL the verdict; capping on ignorance is the direction this repo takes",
  );
});

test("W1-T3383b: an empty id list is still refused outright", () => {
  assert.throws(() => filingAcceptanceCriteria([], SHARDS), /at least one filed task id/);
});
