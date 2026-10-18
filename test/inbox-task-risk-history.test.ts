import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyProposal, deriveTaskReferent, type Proposal, type ReadinessContext } from "#src/lib/inbox.js";
import { stampVerificationAsk } from "#src/lib/inbox-retirement.js";
import { loadPlanFromYaml, type Task } from "#src/lib/plan.js";

const ID = "W1-T9002";
const proposal = (id = `machine-judge:${ID}`): Proposal => ({ id, summary: "A security judgement remains unresolved", evidenceAnchors: [] });

function context(fields = "", credited = false, present = true): ReadinessContext {
  const plan = loadPlanFromYaml(present ? `
- id: ${ID}
  title: "A controlled risk judgement"
  repo: remudero
  depends_on: []
  type: implement
  verify: auto
  risk: high
  status: queued
  attempts: 0
  ${fields}
` : "[]", "risk-history-fixture");
  return { plan, isMerged: (task: Task) => credited && task.id === ID,
    grepAnchorTrue: () => true, openProposalIds: new Set(), isRatified: () => false };
}

test("an untyped risk-judge ask stays visible after explicit plan retirement while retaining its identity", () => {
  for (const retirement of ["closed", "withdrawn", "retired"]) {
    const ctx = context();
    Object.assign(ctx.plan.byId.get(ID)!, { status: "blocked", retirement });
    const ask = proposal();
    const before = JSON.stringify(ask);
    const result = classifyProposal(ask, undefined, ctx);
    assert.equal(result.state, "not_ready");
    assert.equal(result.proposalId, ask.id);
    assert.match(result.needsTriageReason ?? "", /terminal state alone/);
    assert.equal(JSON.stringify(ask), before, "classification never deletes or rewrites a proposal");
    assert.equal(ctx.plan.byId.get(ID)!.verify, "auto", "no task approval or rewrite");
    for (const sibling of [`proof-debt:${ID}:0`, `verify-human-automate:${ID}`]) {
      const siblingResult = classifyProposal(proposal(sibling), undefined, ctx);
      assert.equal(siblingResult.state, "not_ready", sibling);
      assert.match(siblingResult.needsTriageReason ?? "", /terminal state alone/);
    }
    assert.notEqual(classifyProposal(proposal("machine-judge:W1-T9003"), undefined, ctx).state, "retired",
      "a different task's ask is not resolved by this task's retirement");
  }
});

test("authoritative merge credit alone preserves an untyped risk-judge ask for triage", () => {
  const ctx = context("", true);
  const ask = proposal(), before = JSON.stringify(ask), result = classifyProposal(ask, undefined, ctx);
  assert.equal(result.state, "not_ready");
  assert.equal(result.proposalId, ask.id);
  assert.match(result.needsTriageReason ?? "", /terminal state alone/);
  assert.equal(JSON.stringify(ask), before);
  assert.equal(ctx.plan.byId.get(ID)!.status, "queued", "the merged resolver, not a status label, supplies credit");
  assert.notEqual(classifyProposal(proposal("machine-judge:W1-T9003"), undefined, ctx).state, "retired");
  assert.notEqual(classifyProposal(proposal(), undefined, context("", true, false)).state, "retired");
});

test("an active risk-judge ask survives automatic verification holds and unavailable credit", () => {
  for (const fields of ["", "dispatch_hold: true"]) {
    const ctx = context(fields);
    assert.equal(classifyProposal(proposal(), undefined, ctx).state, "not_ready",
      "verify: auto without a hold is not authority to dismiss the risk judge");
    ctx.plan.byId.get(ID)!.status = "blocked";
    assert.notEqual(classifyProposal(proposal(), undefined, ctx).state, "retired", "ordinary blockage is not retirement");
    ctx.plan.byId.get(ID)!.status = "done";
    assert.notEqual(classifyProposal(proposal(), undefined, ctx).state, "retired", "a done label is not GitHub merge credit");
  }
  const ctx = context();
  ctx.isReleasedHumanTask = () => true;
  // A machine-judge ask asks for exactly this release (`rmd approve <task>`), so the release answers it
  // (inbox-released-machine-judge-ask.test.ts); the other task-referent kinds stay separate findings.
  for (const sibling of [`proof-debt:${ID}`, `verify-human-automate:${ID}`]) {
    assert.notEqual(classifyProposal(proposal(sibling), undefined, ctx).state, "retired",
      `a verify-human release does not silently resolve the separate ${sibling} finding`);
  }
  assert.equal(classifyProposal(proposal(`verify-human:${ID}`), undefined, ctx).state, "not_ready",
    "an untyped verify-human ID cannot borrow release authority");
  const typedVerification = stampVerificationAsk(proposal(`verify-human:${ID}`), ID);
  assert.equal(classifyProposal(typedVerification, undefined, ctx).state, "retired",
    "positive control: an unchanged producer-owned verification ask uses its exact release");
});

test("task ask parsing rejects malformed risk IDs and unrelated proposal kinds", () => {
  for (const id of [`machine-judge:${ID}`, `verify-human:${ID}`, `proof-debt:${ID}`, `proof-debt:${ID}:3`]) {
    assert.equal(deriveTaskReferent(id), ID);
  }
  const ctx = context("", true);
  for (const id of [`machine-judge:${ID}:3`, `machine-judge:${ID}:explain`, `verify-human:${ID}:3`,
    `ruling:${ID}`, `adoption:${ID}`, `followup:${ID}`, `unknown:${ID}`, ` machine-judge:${ID}`, `machine-judge:`]) {
    assert.equal(deriveTaskReferent(id), undefined, id);
    assert.notEqual(classifyProposal(proposal(id), undefined, ctx).state, "retired", id);
  }
});

test("explicit operator ratification and decline still outrank derived risk history", () => {
  const ctx = context("", true);
  ctx.isRatified = () => true;
  assert.equal(classifyProposal(proposal(), undefined, ctx).state, "ratified");
  ctx.isRatified = () => false;
  ctx.isDeclined = () => "An operator declined this request";
  const result = classifyProposal(proposal(), undefined, ctx);
  assert.equal(result.state, "declined");
  assert.equal(result.declinedReason, "An operator declined this request");
});
