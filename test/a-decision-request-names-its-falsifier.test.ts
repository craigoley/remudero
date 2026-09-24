import assert from "node:assert/strict";
import { test } from "node:test";

import { outputContractLines } from "../src/lib/compaction.js";
import { decisionRecordContent } from "../src/lib/feedback-landing.js";
import { parseDecisionRequest } from "../src/lib/worker.js";

// A DECISION_REQUEST is always auto-chosen, so the only record of whether the RECOMMENDED option
// was right is what the worker said would prove it wrong. These pin that the contract asks for it,
// the parser keeps it, and the durable record carries it.

test("the implement output contract asks every DECISION_REQUEST for a FALSIFIER line", () => {
  const contract = outputContractLines("T-1").join("\n");
  assert.match(contract, /DECISION_REQUEST/);
  assert.match(contract, /FALSIFIER: <what you would observe if RECOMMENDED is the wrong choice>/);
});

test("parseDecisionRequest keeps the worker's FALSIFIER line, and leaves it absent when none was given", () => {
  const withFalsifier = parseDecisionRequest(
    "DECISION_REQUEST\n- Put it in src/lib/a.ts (RECOMMENDED)\n- Put it in src/lib/b.ts\nFALSIFIER: b.ts already imports a.ts\n",
  );
  assert.equal(withFalsifier?.falsifier, "b.ts already imports a.ts");
  assert.deepEqual(withFalsifier?.options, ["Put it in src/lib/a.ts", "Put it in src/lib/b.ts"]);

  const without = parseDecisionRequest("DECISION_REQUEST\n- a (RECOMMENDED)\n- b\n");
  assert.equal(without && "falsifier" in without, false);
});

test("a decision record carries the falsifier as a Wrong if line, and omits the line when there is none", () => {
  const base = { taskId: "T-1", runId: "T-1-1", options: ["a", "b"], chosen: "a", band: "medium", reason: "schema", ts: "2026-09-24T00:00:00.000Z" };
  assert.match(decisionRecordContent({ ...base, falsifier: "b.ts already imports a.ts" }), /^- Wrong if: b\.ts already imports a\.ts$/m);
  assert.doesNotMatch(decisionRecordContent(base), /Wrong if/);
});
