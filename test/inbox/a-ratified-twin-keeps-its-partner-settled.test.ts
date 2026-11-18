// W1-T13693: verify-human:<id> and machine-judge:<id> ask one question. Ratifying either settles the other, even
// after the ratified row is pruned from the registry, so the survivor never resurfaces as a fresh ask (W1-T12032).
import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyProposal, parkedTaskTwinAsk, pruneRatifiedProposals, type Proposal, type ReadinessContext } from "#src/lib/inbox.js";
import type { Plan } from "#src/lib/plan.js";

const emptyPlan: Plan = { tasks: [], byId: new Map() };
const ctx = (ratified: readonly string[]): ReadinessContext => ({
  plan: emptyPlan, isMerged: () => true, grepAnchorTrue: () => true, openProposalIds: new Set(), isRatified: (id) => ratified.includes(id),
});
const proposal = (id: string): Proposal => ({ id, summary: `${id} asks whether to release the task`, evidenceAnchors: [] }) as Proposal;

test("W1-T13693 criterion 1: a machine-judge ask whose verify-human twin is ratified is settled and pruned", () => {
  const survivor = proposal("machine-judge:W1-T9");
  const classification = classifyProposal(survivor, undefined, ctx(["verify-human:W1-T9"]));
  assert.equal(classification.state, "ratified");
  assert.deepEqual(pruneRatifiedProposals([survivor], [classification]).prunedIds, ["machine-judge:W1-T9"]);
  assert.equal(classifyProposal(proposal("verify-human:W1-T9"), undefined, ctx(["machine-judge:W1-T9"])).state, "ratified");
});

test("W1-T13693 criterion 2: an unrelated ask or a different task's twin is not settled", () => {
  assert.notEqual(classifyProposal(proposal("machine-judge:W1-T9"), undefined, ctx(["verify-human:W1-T8"])).state, "ratified");
  assert.notEqual(classifyProposal(proposal("board-review:W1-T9"), undefined, ctx(["verify-human:W1-T9"])).state, "ratified");
  assert.equal(parkedTaskTwinAsk("board-review:W1-T9"), undefined);
  assert.equal(parkedTaskTwinAsk("machine-judge:W1-T9"), "verify-human:W1-T9");
});
