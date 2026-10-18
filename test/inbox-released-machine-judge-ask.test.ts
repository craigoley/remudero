import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyProposal, type Proposal, type ReadinessContext } from "#src/lib/inbox.js";
import { stampVerificationAsk } from "#src/lib/inbox-retirement.js";
import { proposalFromJudgedShard } from "#src/lib/verify-human-judge.js";
import { machineJudgeProposal } from "#src/lib/machine-filing-judge.js";
import { loadPlanFromYaml } from "#src/lib/plan.js";

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

function judgedAsk(ctx: ReadinessContext, taskId = ID): Proposal {
  return machineJudgeProposal({ kind: "ruled", task: { ...ctx.plan.byId.get(ID)!, id: taskId }, bar: 0.9,
    record: { family: "ci-friction", merged: 2, declined: 1, alpha: 3, beta: 2, mean: 0.6 },
    ruling: { verdict: "high", action: "escalate", confidence: 0.95, reasons: ["operator release required"], judgedAt: "2026-10-13T11:55:00Z" } });
}

test("a released task's machine-judge ask leaves Needs your decision", () => {
  const ctx = context(), proposal = judgedAsk(ctx);
  const before = JSON.stringify(proposal);
  const result = classifyProposal(proposal, undefined, ctx);
  assert.equal(result.state, "retired");
  assert.equal(result.proposalId, proposal.id);
  assert.match(result.retiredReason ?? "", /machine-judge:W1-T9101's task W1-T9101 was released to the fleet/);
  assert.equal(JSON.stringify(proposal), before, "retirement never rewrites the ask; it stays in history");
});

test("a machine-judge ask stays open without a release receipt for its own present task", () => {
  const unreleased = context("", false);
  assert.notEqual(classifyProposal(judgedAsk(unreleased), undefined, unreleased).state, "retired", "no release, no retirement");
  assert.notEqual(classifyProposal(judgedAsk(context(), "W1-T9102"), undefined, context()).state, "retired",
    "another task's release does not answer this ask");
  const absent = context();
  const missingTaskAsk = judgedAsk(absent);
  absent.plan.byId.delete(ID);
  assert.notEqual(classifyProposal(missingTaskAsk, undefined, absent).state, "retired", "a task the plan no longer holds is not released");
  for (const id of [`machine-judge:${ID}:3`, `machine-judge-x:${ID}`]) {
    assert.notEqual(classifyProposal(ask(id), undefined, context()).state, "retired", id);
  }
});

test("a release does not retire a generic machine ID or a mismatched producer family", () => {
  assert.equal(classifyProposal(ask(), undefined, context()).state, "not_ready");
  const wrongFamily = stampVerificationAsk(ask(), ID);
  assert.equal(classifyProposal(wrongFamily, undefined, context()).state, "not_ready");
});

test("a current dispatch hold preserves a typed machine-judge ask despite its release receipt", () => {
  const ctx = context("dispatch_hold: true"), proposal = judgedAsk(ctx), before = JSON.stringify(proposal);
  const result = classifyProposal(proposal, undefined, ctx);
  assert.equal(result.state, "not_ready");
  assert.equal(result.proposalId, proposal.id);
  assert.equal(JSON.stringify(proposal), before);
});

test("a generic summary reframe cannot reuse unchanged machine-judge release metadata", () => {
  const ctx = context(), original = judgedAsk(ctx);
  assert.equal(classifyProposal(original, undefined, ctx).state, "retired", "unchanged owned producer is the positive control");
  const reframed = { ...original, summary: "An operator question about a new unresolved finding" };
  assert.deepEqual(reframed.verificationAsk, original.verificationAsk);
  const before = JSON.stringify(reframed), result = classifyProposal(reframed, undefined, ctx);
  assert.equal(result.state, "not_ready");
  assert.equal(result.proposalId, original.id);
  assert.equal(JSON.stringify(reframed), before);
});


test("an exact producer-owned release stays retired when the same task later merges", () => {
  for (const family of ["machine", "verification"] as const) {
    const ctx = context(), proposal = family === "machine" ? judgedAsk(ctx)
      : proposalFromJudgedShard({ id: ID, title: "Operator release is required", rationale: "A scoped release decision",
        acceptance: ["operator releases this task"], ageDays: 1, depsAllMerged: true, citedInSrc: false },
      { decision: "needs_operator", reason: "The operator must choose whether to release this exact task" });
    const before = JSON.stringify(proposal);
    assert.equal(classifyProposal(proposal, undefined, ctx).state, "retired", family + ": before merge");
    ctx.isMerged = task => task.id === ID;
    assert.equal(classifyProposal(proposal, undefined, ctx).state, "retired", family + ": after merge");
    const changed = { ...proposal, summary: "A newly unanswered budget decision" };
    assert.equal(classifyProposal(changed, undefined, ctx).state, "not_ready", family + ": changed ask");
    const copied = { ...proposal, id: family === "machine" ? `verify-human:${ID}` : `machine-judge:${ID}` };
    assert.equal(classifyProposal(copied, undefined, ctx).state, "not_ready", family + ": copied purpose");
    ctx.plan.byId.get(ID)!.dispatch_hold = true;
    assert.equal(classifyProposal(proposal, undefined, ctx).state, "not_ready", family + ": current hold");
    assert.equal(JSON.stringify(proposal), before, family + ": immutable history");
  }
});
