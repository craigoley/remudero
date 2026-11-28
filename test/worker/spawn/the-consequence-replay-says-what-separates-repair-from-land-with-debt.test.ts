import assert from "node:assert/strict";
import { test } from "node:test";
import { loadJudgeReplayCorpus } from "#src/lib/judge-replay-batch.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

/** The gate-consequence cases of the risk-judge dispositions, as the replay sends them. */
function consequenceCases() {
  const loaded = loadJudgeReplayCorpus(REPO_ROOT, "risk-judge-dispositions");
  assert.ok(loaded, "the risk-judge dispositions corpus loads");
  assert.equal(loaded.refused.length, 0, "no consequence case is refused by the scrub");
  const cases = loaded.cases.filter((c) => c.question === "gate_consequence");
  assert.ok(cases.length > 0, "the corpus has gate-consequence cases");
  return cases;
}

test("W1-T14843 criterion 1: the consequence task states when REPAIR and when LAND+DEBT applies", () => {
  for (const c of consequenceCases()) {
    assert.match(c.task, /REPAIR only when the finding names a repair the automation can compute and apply in this run/,
      `${c.caseId}: the task says when REPAIR is the answer`);
    assert.match(c.task, /LAND\+DEBT when the change is safe and reversible and the remaining work is bounded follow-up/,
      `${c.caseId}: the task says when LAND+DEBT is the answer`);
    assert.ok(c.prompt.startsWith(c.task), `${c.caseId}: the prompt sent carries the task text`);
    assert.deepEqual(c.options, ["LAND", "REPAIR", "LAND+DEBT", "STOP"], `${c.caseId}: the options are unchanged`);
  }
});

test("W1-T14843 criterion 2: the consequence task says currentConsequence is the gate's default", () => {
  for (const c of consequenceCases()) {
    assert.match(c.task, /currentConsequence in the input is the gate's default before judgment, not the answer/,
      `${c.caseId}: the task names currentConsequence as the gate's default`);
  }
});
