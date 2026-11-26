// W1-T14976. OBSERVED 2026-11-26: machine-judge:W1-T9939 was filed 2026-10-16 23:37Z, before stampVerificationAsk shipped
// (#12507, 2026-10-17 05:25Z), so it carries no verificationAsk. Its task was released (ratify.approved, released
// verify-human) on 2026-11-02 22:01Z, yet the ask stayed in the operator's Waiting folder with an Approve that could
// never work. 283 of the host's 760 parked asks lack the stamp. Operator ruling 2026-11-26 15:10Z: "Yes, both changes".
import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyProposal, type Proposal, type ReadinessContext } from "#src/lib/inbox.js";
import { stampVerificationAsk } from "#src/lib/inbox-retirement.js";
import { loadPlanFromYaml } from "#src/lib/plan.js";

const ID = "W1-T9939";
const untyped = (family: "machine-judge" | "verify-human", taskId = ID): Proposal =>
  ({ id: `${family}:${taskId}`, summary: "The risk judge escalated this record", evidenceAnchors: [] });

function context(fields = "", released: ReadonlySet<string> = new Set([ID])): ReadinessContext {
  const plan = loadPlanFromYaml(`
- id: ${ID}
  title: "A parked record the judge escalated"
  repo: remudero
  depends_on: []
  type: implement
  verify: human
  status: queued
  attempts: 0
  ${fields}
`, "untyped-release-fixture");
  return { plan, isMerged: () => false, grepAnchorTrue: () => true, openProposalIds: new Set(), isRatified: () => false,
    isReleasedHumanTask: (taskId) => released.has(taskId) };
}

test("W1-T14976 criterion 1: an untyped verify-human or machine-judge ask retires when its own task was released", () => {
  for (const family of ["machine-judge", "verify-human"] as const) {
    const proposal = untyped(family), before = JSON.stringify(proposal);
    const result = classifyProposal(proposal, undefined, context());
    assert.equal(result.state, "retired", family);
    assert.match(result.retiredReason ?? "", new RegExp(`${family}:${ID}'s task ${ID} was released to the fleet`));
    assert.equal(JSON.stringify(proposal), before, "the ask itself is never rewritten");
  }
});

test("W1-T14976 criterion 2: invariant:own-release-only — an untyped ask stays open with no release, another task's release, a held task or a task the plan no longer holds", () => {
  assert.notEqual(classifyProposal(untyped("machine-judge"), undefined, context("", new Set())).state, "retired", "no release");
  assert.notEqual(classifyProposal(untyped("machine-judge"), undefined, context("", new Set(["W1-T9940"]))).state, "retired", "another task's release");
  assert.notEqual(classifyProposal(untyped("machine-judge"), undefined, context("dispatch_hold: true")).state, "retired", "a held task");
  assert.notEqual(classifyProposal(untyped("machine-judge", "W1-T9941"), undefined, context("", new Set(["W1-T9941"]))).state, "retired", "a task the plan does not hold");
  assert.notEqual(classifyProposal({ id: `verify-human-automate:${ID}`, summary: "Automate this check", evidenceAnchors: [] }, undefined, context()).state, "retired",
    "another ask kind is not a release ask");
});

test("W1-T14976 criterion 3: a typed ask whose stamp no longer matches stays open despite the release", () => {
  const typed = stampVerificationAsk(untyped("machine-judge"), ID);
  assert.ok(typed.verificationAsk, "positive control: the ask is typed");
  const changed = { ...typed, summary: "A newly unanswered budget decision" };
  assert.equal(classifyProposal(changed, undefined, context()).state, "not_ready");
});
