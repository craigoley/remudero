import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyProposal, type Proposal, type ReadinessContext } from "../src/lib/inbox.js";
import { loadPlanFromYaml } from "../src/lib/plan.js";

// Operator report 2026-10-13: W1-T7271 and W1-T6372 were released with `rmd approve` at 11:55Z, as their
// machine-judge asks instruct, yet both asks stayed READY under Needs your decision for hours.
const ID = "W1-T9101";
const ask = (id = `machine-judge:${ID}`): Proposal => ({ id, summary: "The risk judge escalated this record", evidenceAnchors: [] });

function context(fields = "", released = true): ReadinessContext {
  const plan = loadPlanFromYaml(`
- id: ${ID}
  title: "A machine-filed record the risk judge parked"
  repo: remudero
  depends_on: []
  type: implement
  verify: human
  author_class: machine
  status: queued
  attempts: 0
  ${fields}
`, "released-machine-judge-fixture");
  return { plan, isMerged: () => false, grepAnchorTrue: () => true, openProposalIds: new Set(),
    isRatified: () => false, isReleasedHumanTask: (taskId) => released && taskId === ID };
}

test("a released task's machine-judge ask leaves Needs your decision", () => {
  const proposal = ask();
  const before = JSON.stringify(proposal);
  const result = classifyProposal(proposal, undefined, context());
  assert.equal(result.state, "retired");
  assert.equal(result.proposalId, proposal.id);
  assert.match(result.retiredReason ?? "", /machine-judge:W1-T9101's task W1-T9101 was released to the fleet/);
  assert.equal(JSON.stringify(proposal), before, "retirement never rewrites the ask; it stays in history");
});

test("a machine-judge ask stays open without a release receipt for its own present task", () => {
  assert.notEqual(classifyProposal(ask(), undefined, context("", false)).state, "retired", "no release, no retirement");
  assert.notEqual(classifyProposal(ask("machine-judge:W1-T9102"), undefined, context()).state, "retired",
    "another task's release does not answer this ask");
  const absent = context();
  absent.plan.byId.delete(ID);
  assert.notEqual(classifyProposal(ask(), undefined, absent).state, "retired", "a task the plan no longer holds is not released");
  for (const id of [`machine-judge:${ID}:3`, `machine-judge-x:${ID}`]) {
    assert.notEqual(classifyProposal(ask(id), undefined, context()).state, "retired", id);
  }
});
