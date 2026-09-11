/**
 * test/one-procedure-is-one-skill-proposal.test.ts — W1-T3385c.
 *
 * `skillDraftProposalId` keyed on `proceduralCandidateHash`, which hashes the shape AND THE RUN
 * SET. That rule is right for its original purpose — two candidates sharing a shapeKey must not
 * collide — but a procedure's run set GROWS, so every cadence pass that mined the same procedure
 * with one more supporting run produced a different hash and another operator decision.
 *
 * MEASURED 2026-09-11: all SEVEN open skill-draft proposals staged the SAME mined procedure,
 * `implement-clean-single-strike`, at 26/27/78/79/81/82/84 supporting runs. Two real procedures
 * (the plain shape and its `fully_executed_proof` variant) were wearing seven decisions.
 *
 * The draft's NAME follows the procedure too, so the `.claude/skills/<name>/SKILL.md` path a
 * ratification would write stays stable as evidence accrues, instead of minting a new directory
 * per cadence pass.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  procedureKeyFor,
  proceduralCandidateHash,
  renderSkillDraft,
  skillDraftProposalId,
} from "../src/lib/skill-workshop.js";

function candidate(over: Record<string, unknown> = {}) {
  return {
    shapeKey: "clean_single_strike",
    taskType: "implement",
    signals: ["clean_single_strike"],
    runIds: ["R1", "R2"],
    taskIds: ["W1-T1"],
    supportingRuns: 2,
    ...over,
  } as Parameters<typeof renderSkillDraft>[0];
}

test("W1-T3385c: the SAME procedure with MORE supporting runs is ONE proposal, not another", () => {
  const early = renderSkillDraft(candidate({ runIds: ["R1", "R2"], supportingRuns: 2 }))!;
  const later = renderSkillDraft(candidate({ runIds: ["R1", "R2", "R3", "R4"], supportingRuns: 4 }))!;
  assert.notEqual(early.candidateHash, later.candidateHash, "the run-set hash still moves — that is its job");
  assert.equal(
    skillDraftProposalId(early.procedureKey),
    skillDraftProposalId(later.procedureKey),
    "but the operator decision is the same one: one procedure, one ask",
  );
});

test("W1-T3385c: a DIFFERENT procedure shape is still its own proposal", () => {
  const a = renderSkillDraft(candidate({ shapeKey: "clean_single_strike" }))!;
  const b = renderSkillDraft(candidate({ shapeKey: "fully_executed_proof" }))!;
  assert.notEqual(skillDraftProposalId(a.procedureKey), skillDraftProposalId(b.procedureKey));
});

test("W1-T3385c: the same shape for a DIFFERENT task type is its own proposal", () => {
  const a = renderSkillDraft(candidate({ taskType: "implement" }))!;
  const b = renderSkillDraft(candidate({ taskType: "diagnose" }))!;
  assert.notEqual(skillDraftProposalId(a.procedureKey), skillDraftProposalId(b.procedureKey));
});

test("W1-T3385c: the written skill NAME is stable as evidence accrues", () => {
  const early = renderSkillDraft(candidate({ runIds: ["R1", "R2"], supportingRuns: 2 }))!;
  const later = renderSkillDraft(candidate({ runIds: ["R1", "R2", "R3"], supportingRuns: 3 }))!;
  assert.equal(early.name, later.name, "a new directory per cadence pass is the same defect wearing a path");
});

test("W1-T3385c: the run-set hash is UNCHANGED — this repoints the id, it does not weaken the hash", () => {
  assert.equal(proceduralCandidateHash(candidate()), proceduralCandidateHash(candidate()));
  assert.notEqual(
    proceduralCandidateHash(candidate({ runIds: ["R1", "R2"] })),
    proceduralCandidateHash(candidate({ runIds: ["R1", "R2", "R3"] })),
  );
});

test("W1-T3385c: the draft carries its supporting-run count, so a stager can compare evidence", () => {
  const d = renderSkillDraft(candidate({ supportingRuns: 9, runIds: ["A", "B", "C"] }))!;
  assert.equal(d.supportingRuns, 9);
  assert.equal(procedureKeyFor({ shapeKey: "clean_single_strike", taskType: "implement" }), d.procedureKey);
});

test("W1-T3385c: a single-run candidate is still refused outright — the floor is untouched", () => {
  assert.equal(renderSkillDraft(candidate({ supportingRuns: 1 })), undefined);
});
