import assert from "node:assert/strict";
import { test } from "node:test";
import { gatherRuns, mineProceduralCandidates, type LedgerRecord } from "../src/lib/retro.js";
import { procedureKeyFor, renderSkillDraft, type ProceduralCandidateLike } from "../src/lib/skill-workshop.js";

const proofStep = "- Execute every acceptance criterion as a real, observed proof — never let the keyword floor stand in for a run.";
// W1-T13857: P1 and P2 (two tasks) both ran the type check and then committed, so that is the drafted Procedure.
const STEPS = ["Bash:npm run typecheck", "Bash:git commit"];
const MINED = {
  runs: ["P1", "P2"].map((runId, i) => ({ runId, taskId: `W1-T30${i}`, type: "implement", verdict: "merged" })),
  records: ["P1", "P2"].flatMap((runId) =>
    STEPS.map((tool_signature) => ({ run_id: runId, step: "worker.activity", event_kind: "tool-executing", tool_name: "Bash", tool_signature }))),
};
const minedProcedure = "- Run `npm run typecheck`.\n- Run `git commit`.";

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
    assert.equal(renderSkillDraft({ ...candidate(["clean_single_strike"]), supportingRuns }, MINED), undefined);
  }
});

test("W1-T4270: a candidate carrying fully_executed_proof drafts its runs' recurring commands, never the signal text", () => {
  const procedureKey = procedureKeyFor({ taskType: "implement", steps: STEPS });
  const name = `npm-run-typecheck-git-commit-${procedureKey.slice(0, 8)}`;
  const description = "Take the 2 actions that 2 merged implement runs of 2 tasks repeated, in the order they took them.";
  assert.deepEqual(renderSkillDraft(candidate(["fully_executed_proof"]), MINED), {
    name,
    description,
    markdown: [
      "---",
      `name: ${name}`,
      `description: ${description}`,
      "applies-to: implement",
      "---",
      "",
      "<!-- DRAFTED by skill-workshop.ts (W1-T13857) from a command sequence that recurs across runs — a Rule 15",
      "     plan write the Architect proposes and the operator ratifies, not yet ratified. -->",
      "",
      "## Procedure",
      "",
      "- Run `npm run typecheck`.",
      "- Run `git commit`.",
      "",
      "## Evidence",
      "",
      "- Recurs in 2 runs of 2 tasks: W1-T300, W1-T301.",
      "- Median tool calls from the first step to the last: 2.",
      "- tokens: not measured",
      "- Score: 4.",
      "- [src: run#P1]",
      "- [src: run#P2]",
    ].join("\n"),
    candidateHash: "21436526dae1fe2c",
    procedureKey,
    supportingRuns: 2,
    outcomeDescriptions: ["Every acceptance criterion has an observed executed proof, without keyword-floor degradation."],
  });
  assert.equal(renderSkillDraft({ ...candidate(["fully_executed_proof"]), supportingRuns: 1 }, MINED), undefined);
});

test("W1-T4270: a mixed candidate drafts only the eligible signal step, never the outcome-only one", () => {
  const mixed = candidate(["clean_single_strike", "fully_executed_proof"]);
  const original = structuredClone(mixed);
  const draft = renderSkillDraft(mixed, MINED);
  assert.ok(draft);
  assert.equal(draft.markdown.split("## Procedure\n\n")[1].split("\n\n## Evidence")[0], minedProcedure);
  assert.ok(!draft.markdown.includes(proofStep));
  assert.match(draft.markdown.split("## Evidence\n\n")[1], /- \[src: run#P1\]\n- \[src: run#P2\]$/);
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
  assert.equal(renderSkillDraft(raw[0], MINED), undefined);
  assert.deepEqual(raw, original);
});

test("W1-T4270: uncatalogued, inherited and empty signals never draft a skill", () => {
  for (const signals of [[], ["novel_shape"], ["toString"], ["constructor"], ["__proto__"]]) {
    assert.equal(renderSkillDraft(candidate(signals), MINED), undefined);
    const draft = renderSkillDraft(candidate([...signals, "fully_executed_proof"]), MINED);
    assert.ok(draft);
    assert.equal(draft.markdown.split("## Procedure\n\n")[1].split("\n\n## Evidence")[0], minedProcedure);
  }
});
