// W1-T14977. OBSERVED 2026-11-26: about 47 asks in the operator's Waiting folder were for queued verify:human tasks with
// no Architect draft ("not-drafted") or a failed one. The only draft such an ask can take is `RELEASE: <task>`, which
// `rmd approve <task>` does directly, yet Approve stayed disabled. Failed draft attempts are never retried, so these asks
// had no way to be approved. Operator ruling 2026-11-26 15:10Z: "Yes, both changes".
import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyProposal, releasedHumanTaskPredicate, type Proposal, type ReadinessContext } from "#src/lib/inbox.js";
import { loadPlanFromYaml } from "#src/lib/plan.js";

const ID = "W1-T9950";
const ask = (id = `verify-human:${ID}`, extra: Partial<Proposal> = {}): Proposal =>
  ({ id, summary: "A high-risk release still needs human verification", evidenceAnchors: [], ...extra });

function context(fields = "", verify = "human", status = "queued"): ReadinessContext {
  const plan = loadPlanFromYaml(`
- id: ${ID}
  title: "A parked record that needs a person"
  repo: remudero
  depends_on: []
  type: implement
  verify: ${verify}
  status: ${status}
  attempts: 0
  ${fields}
`, "parked-release-fixture");
  return { plan, isMerged: () => false, grepAnchorTrue: () => true, openProposalIds: new Set(), isRatified: () => false, isReleasedHumanTask: () => false };
}

test("W1-T14977 criterion 1: a parked verify:human task's ask with no draft is ready to approve as its release", () => {
  for (const id of [`verify-human:${ID}`, `machine-judge:${ID}`]) {
    const result = classifyProposal(ask(id), undefined, context());
    assert.equal(result.state, "ready", id);
    assert.equal(result.releaseTaskId, ID, id);
  }
});

test("W1-T14977 criterion 1: a parked verify:human task's ask with no draft is ready to approve as its release — the ledger predicate every terminal caller builds", () => {
  const plan = context().plan;
  const heldPlan = context("dispatch_hold: true").plan;
  const release = { step: "ratify.approved", released: "verify-human", task_id: ID };
  assert.equal(releasedHumanTaskPredicate(plan, [])(ID), false, "no release row: not released");
  assert.equal(releasedHumanTaskPredicate(plan, [{ ...release, task_id: "W1-T1" }])(ID), false, "another task's release");
  assert.equal(releasedHumanTaskPredicate(plan, [{ ...release, released: undefined }])(ID), false, "a ratify row that released nothing");
  assert.equal(releasedHumanTaskPredicate(plan, [release])(ID), true, "its own release row");
  assert.equal(releasedHumanTaskPredicate(heldPlan, [release])(ID), false, "a held task's old release does not count");
  assert.equal(classifyProposal(ask(), undefined, { ...context(), isReleasedHumanTask: releasedHumanTaskPredicate(plan, []) }).state, "ready");
});

test("W1-T14977 criterion 2: invariant:release-only — no draft-free release for a held, unparked, missing or already-released task, another ask kind, a reframed ask, drifted evidence or an open conflict", () => {
  const notReleased = (proposal: Proposal, ctx: ReadinessContext, why: string) => {
    const result = classifyProposal(proposal, undefined, ctx);
    assert.notEqual(result.state, "ready", why);
    assert.equal(result.releaseTaskId, undefined, why);
  };
  // Contrast: the same ask in the same context is ready, so each case below is refused only for its own reason.
  assert.equal(classifyProposal(ask(), undefined, context()).state, "ready", "the plain parked ask is ready");
  notReleased(ask(), context("dispatch_hold: true"), "a held task");
  notReleased(ask(), context("", "auto"), "a task that no longer needs a person");
  notReleased(ask(), context("", "human", "blocked"), "a task that is not queued");
  notReleased(ask(`verify-human:W1-T9951`), context(), "a task the plan does not hold");
  notReleased(ask(`verify-human-automate:${ID}`), context(), "an automate ask is not a release ask");
  notReleased(ask(undefined, { reframeHistory: [{ feedback: "Split this first" }] }), context(), "a reframed ask waits for its redraft");
  notReleased(ask(undefined, { evidenceAnchors: [{ description: "x still names gone", pattern: "gone", path: "src/x.ts" }] }), { ...context(), grepAnchorTrue: () => false }, "drifted evidence");
  notReleased(ask(undefined, { conflictsWith: ["other:1"] }), { ...context(), openProposalIds: new Set(["other:1"]) }, "an open conflict");
  notReleased(ask(), { ...context(), isReleasedHumanTask: (id) => id === ID }, "a task already released to the fleet");
  notReleased(ask(), { ...context(), isReleasedHumanTask: undefined }, "a caller that cannot say whether the task was released");
});

test("W1-T14977 criterion 3: an ask with a draft is still judged by that draft", () => {
  const result = classifyProposal(ask(), { releaseTaskId: "W1-T9999", fragmentYaml: "", stampLine: "", anchorFingerprint: "" } as never, context());
  assert.equal(result.state, "not_ready");
  assert.match(result.reasons.map((r) => r.detail).join("\n"), /RELEASE must name this proposal's parked task/);
  // Contrast: the same ask with no draft is ready, so only the draft keeps it not ready.
  assert.equal(classifyProposal(ask(), undefined, context()).releaseTaskId, ID, "without a draft the ask is its release");
});
