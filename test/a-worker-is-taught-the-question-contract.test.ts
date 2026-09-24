import assert from "node:assert/strict";
import { test } from "node:test";

import { outputContractLines } from "../src/lib/compaction.js";
import { parseQuestion } from "../src/lib/worker.js";

// parseQuestion and run-task.ts's non-blocking `question.logged` existed with no prompt teaching the
// format, so the channel had no input. These pin that the implement contract teaches it, and that
// the example it teaches is exactly what the parser reads.

test("the implement output contract teaches the QUESTION, CURRENT_ASSUMPTION and IMPACT_IF_WRONG lines", () => {
  const contract = outputContractLines("T-1").join("\n");
  assert.match(contract, /`QUESTION: <what you do not know>`/);
  assert.match(contract, /`CURRENT_ASSUMPTION: <what you proceed on>`/);
  assert.match(contract, /`IMPACT_IF_WRONG: low\|med`/);
  assert.match(contract, /look it up\s+first/);
});

test("a question written the way the contract teaches it is parsed field for field", () => {
  const report = [
    "REPORT",
    "QUESTION: does the daemon read this flag at startup or per tick?",
    "CURRENT_ASSUMPTION: per tick, so no restart is needed",
    "IMPACT_IF_WRONG: med",
  ].join("\n");
  assert.deepEqual(parseQuestion(report), {
    raw: report,
    question: "does the daemon read this flag at startup or per tick?",
    currentAssumption: "per tick, so no restart is needed",
    impactIfWrong: "med",
  });
});
