import assert from "node:assert/strict";
import { test } from "node:test";
import { gatherRuns, mineProceduralCandidates, type LedgerRecord } from "../src/lib/retro.js";
import { renderSkillDraft, type ProceduralCandidateLike } from "../src/lib/skill-workshop.js";

const proofStep = "- Execute every acceptance criterion as a real, observed proof — never let the keyword floor stand in for a run.";

function candidate(signals: string[]): ProceduralCandidateLike {
  return {
    shapeKey: `implement:${signals.join("+")}`,
    taskType: "implement",
    signals,
    runIds: ["P1", "P2"],
    taskIds: ["W1-T300", "W1-T301"],
    supportingRuns: 2,
  };
}

test("W1-T4270: a candidate whose only signal is clean_single_strike never renders a skill draft", () => {
  for (const supportingRuns of [2, 81]) {
    assert.equal(renderSkillDraft({ ...candidate(["clean_single_strike"]), supportingRuns }), undefined);
  }
});

test("W1-T4270: a candidate carrying fully_executed_proof still drafts a skill exactly as before", () => {
  assert.deepEqual(renderSkillDraft(candidate(["fully_executed_proof"])), {
    name: "implement-fully-executed-proof-84a7cc07",
    description: "A procedure shape proven across 2 merged implement run(s): fully_executed_proof.",
    markdown: [
      "---",
      "name: implement-fully-executed-proof-84a7cc07",
      "description: A procedure shape proven across 2 merged implement run(s): fully_executed_proof.",
      "applies-to: implement",
      "---",
      "",
      "<!-- DRAFTED by skill-workshop.ts (W1-T2766) from a mined procedural candidate — a Rule 15",
      "     plan write the Architect proposes and the operator ratifies, not yet ratified. -->",
      "",
      "## Procedure",
      "",
      proofStep,
      "",
      "## Evidence",
      "",
      "- [src: run#P1]",
      "- [src: run#P2]",
      "- Filed under: W1-T300, W1-T301",
    ].join("\n"),
    candidateHash: "21436526dae1fe2c",
    procedureKey: "84a7cc07e1ad07c6",
    supportingRuns: 2,
    outcomeDescriptions: ["Every acceptance criterion has an observed executed proof, without keyword-floor degradation."],
  });
  assert.equal(renderSkillDraft({ ...candidate(["fully_executed_proof"]), supportingRuns: 1 }), undefined);
});

test("W1-T4270: a mixed candidate drafts only the eligible signal step, never the outcome-only one", () => {
  const mixed = candidate(["clean_single_strike", "fully_executed_proof"]);
  const original = structuredClone(mixed);
  const draft = renderSkillDraft(mixed);
  assert.ok(draft);
  assert.equal(draft.markdown.split("## Procedure\n\n")[1].split("\n\n## Evidence")[0], proofStep);
  assert.equal(draft.markdown.split("## Evidence\n\n")[1], "- [src: run#P1]\n- [src: run#P2]\n- Filed under: W1-T300, W1-T301");
  assert.deepEqual(mixed, original);
});

test("W1-T4270: mineProceduralCandidates still reports a clean_single_strike-only candidate", () => {
  const records: LedgerRecord[] = ["P1", "P2"].flatMap((run_id, index) => {
    const task_id = `W1-T${300 + index}`;
    return [
      { run_id, task_id, step: "run.start", type: "implement", ts: "2026-04-01T00:00:00.000Z" },
      { run_id, task_id, step: "verdict", verdict: "merged", ts: "2026-04-01T00:01:00.000Z" },
    ];
  });
  const raw = mineProceduralCandidates(gatherRuns(records), records);
  assert.deepEqual(raw, [{ kind: "procedural", ...candidate(["clean_single_strike"]) }]);
  const original = structuredClone(raw);
  assert.equal(renderSkillDraft(raw[0]), undefined);
  assert.deepEqual(raw, original);
});

test("W1-T4270: uncatalogued, inherited and empty signals never draft a skill", () => {
  for (const signals of [[], ["novel_shape"], ["toString"], ["constructor"], ["__proto__"]]) {
    assert.equal(renderSkillDraft(candidate(signals)), undefined);
    const draft = renderSkillDraft(candidate([...signals, "fully_executed_proof"]));
    assert.ok(draft);
    assert.equal(draft.markdown.split("## Procedure\n\n")[1].split("\n\n## Evidence")[0], proofStep);
  }
});
