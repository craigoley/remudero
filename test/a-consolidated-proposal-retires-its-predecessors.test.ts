/**
 * test/a-consolidated-proposal-retires-its-predecessors.test.ts — W1-T3511.
 *
 * W1-T3385b regrouped proof-debt from one proposal per CRITERION to one per TASK. It changed what
 * gets MINTED and nothing else — the predecessors it supersedes stayed open, carrying different
 * ids, with nothing to retire them.
 *
 * MEASURED 2026-09-13, two days after that rule shipped: 22 per-criterion proposals still open
 * against 1 per-task successor, and the operator inbox had GROWN, 139 -> 143. A consolidation rule
 * that only filters new mints cannot shrink an existing backlog; it can only slow the growth.
 *
 * THE GUARDS ARE THE INTERESTING HALF. `openProposalIds` is every registry id, declined ones
 * included, so a declined successor must never retire the finding it was supposed to carry — that
 * would silently delete a live finding via a proposal an operator had already refused.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { classifyProposal, supersedingProposalId, type Proposal, type ReadinessContext } from "../src/lib/inbox.js";
import type { Plan } from "../src/lib/plan.js";

const PRED = "proof-debt:W1-T965:3";
const SUCC = "proof-debt:W1-T965";

function ctxWith(openIds: string[], declined: string[] = []): ReadinessContext {
  return {
    plan: { tasks: [], byId: new Map() } as unknown as Plan,
    isMerged: () => false,
    grepAnchorTrue: () => true,
    openProposalIds: new Set(openIds),
    isRatified: () => false,
    isDeclined: (id: string) => (declined.includes(id) ? "declined by an operator" : undefined),
  } as ReadinessContext;
}
const proposal = (id: string): Proposal => ({ id, summary: id, evidenceAnchors: [] }) as Proposal;

test("W1-T3511: a per-criterion proposal RETIRES once its per-task successor is open", () => {
  const c = classifyProposal(proposal(PRED), undefined, ctxWith([SUCC]));
  assert.equal(c.state, "retired");
  assert.match(c.retiredReason ?? "", /superseded by proof-debt:W1-T965/);
});

test("W1-T3511: with NO successor open, the predecessor is untouched — the finding is not dropped on a promise", () => {
  const c = classifyProposal(proposal(PRED), undefined, ctxWith([]));
  assert.notEqual(c.state, "retired", "retiring before the successor exists would lose the finding outright");
});

test("W1-T3511: a DECLINED successor never retires its predecessor", () => {
  const c = classifyProposal(proposal(PRED), undefined, ctxWith([SUCC], [SUCC]));
  assert.notEqual(
    c.state,
    "retired",
    "openProposalIds carries declined ids too; honouring one would delete a live finding via a proposal already refused",
  );
});

test("W1-T3511: a per-TASK proposal is never its own predecessor", () => {
  assert.equal(supersedingProposalId(SUCC), undefined);
  const c = classifyProposal(proposal(SUCC), undefined, ctxWith([SUCC, PRED]));
  assert.notEqual(c.state, "retired");
});

test("W1-T3511: only proof-debt ids have a derivable successor — no similarity score, no guess", () => {
  assert.equal(supersedingProposalId("proof-debt:W1-T1015:4"), "proof-debt:W1-T1015");
  for (const id of [
    "skill-draft:62aff41d7a5fd038",
    "followup:DAEMON-123:2026-09-02T09:17:34.050Z:0",
    "verify-human:W1-T204",
    "board-review:escalation:#3039",
  ]) {
    assert.equal(supersedingProposalId(id), undefined, `${id} has no derivable consolidated successor`);
  }
});

test("W1-T3511: another TASK's successor does not retire this task's predecessor", () => {
  const c = classifyProposal(proposal(PRED), undefined, ctxWith(["proof-debt:W1-T968"]));
  assert.notEqual(c.state, "retired", "supersession is per task, never across tasks");
});
