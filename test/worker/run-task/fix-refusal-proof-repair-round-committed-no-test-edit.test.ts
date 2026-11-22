import assert from "node:assert/strict";
import test from "node:test";
import { proofRepairRefusal } from "#src/run-task.js";

test("W1-T11334: fix_refusal:proof-repair-round-committed-no-test-edit is prevented, not retried", () => {
  const base = { stageable: ["test/a.test.ts"], changedFiles: [] as string[], proofs: ["unit test: a"] };
  // Stale evidence: the proof already discriminates at head — no edit owed, so not the no-test-edit failure.
  const healed = proofRepairRefusal({ ...base, checkProofStatus: () => 0 });
  assert.match(healed?.reason ?? "", /not needed/);
  assert.doesNotMatch(healed?.reason ?? "", /committed no test edit/);
  // A genuinely empty round on a proof that still needs repair stays refused.
  const empty = proofRepairRefusal({ ...base, checkProofStatus: () => 5 });
  assert.match(empty?.reason ?? "", /committed no test edit/);
  // No proofs: an empty edit stays refused.
  assert.match(proofRepairRefusal({ ...base, proofs: [], checkProofStatus: () => 0 })?.reason ?? "", /committed no test edit/);
});
