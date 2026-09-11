/**
 * test/a-proposal-outlives-its-own-task.test.ts — W1-T3382.
 *
 * A proposal minted AGAINST A PLAN TASK stayed READY forever once that task merged. The producer's
 * own population already excludes merged tasks (`defaultProofDebtCadenceInput` intersects open with
 * unmerged), so nothing re-mints such a proposal — and nothing retired it either. It simply
 * outlived its own subject and kept occupying an operator decision.
 *
 * MEASURED 2026-09-11: of 207 ready proposals, 36 named a task the live projection already credited
 * merged. Every one proposed repairing a proof on finished work.
 *
 * `resolveBoardReferent` already retires the BOARD-item version of this (an escalation issue that
 * closed). This is the plan-task analogue, checked at the same seam in `classifyProposal` — not in
 * the draft rung, because these proposals already have drafts.
 *
 * THE POLARITY IS THE CAREFUL PART, and three of the five tests below are about it: a task the plan
 * does not hold, and an id carrying no task at all, must both mean NO OPINION. Reading either as
 * "finished" would retire live findings, which is the expensive direction.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { classifyProposal, deriveTaskReferent, type Proposal, type ReadinessContext } from "../src/lib/inbox.js";
import type { Plan, Task } from "../src/lib/plan.js";

function task(id: string): Task {
  return {
    id, title: id, repo: "remudero", depends_on: [], type: "implement",
    verify: "auto", risk: "medium", status: "queued", attempts: 0,
  } as Task;
}

function planOf(...ids: string[]): Plan {
  const tasks = ids.map(task);
  return { tasks, byId: new Map(tasks.map((t) => [t.id, t])) } as Plan;
}

function ctxWith(plan: Plan, mergedIds: string[]): ReadinessContext {
  return {
    plan,
    isMerged: (t: Task) => mergedIds.includes(t.id),
    grepAnchorTrue: () => true,
    openProposalIds: new Set<string>(),
    isRatified: () => false,
  } as ReadinessContext;
}

const proposal = (id: string): Proposal => ({ id, summary: id, evidenceAnchors: [] }) as Proposal;

test("W1-T3382: a proof-debt proposal whose task has MERGED is retired, not left READY", () => {
  const c = classifyProposal(proposal("proof-debt:W1-T201:3"), undefined, ctxWith(planOf("W1-T201"), ["W1-T201"]));
  assert.equal(c.state, "retired", "a proposal about finished work must not stay in the operator's queue");
  assert.match(c.retiredReason ?? "", /W1-T201 has merged/);
});

test("W1-T3382: a verify-human proposal whose shard has MERGED is retired too", () => {
  const c = classifyProposal(proposal("verify-human:W1-T992"), undefined, ctxWith(planOf("W1-T992"), ["W1-T992"]));
  assert.equal(c.state, "retired");
});

test("W1-T3382: an UNMERGED task's proposal is untouched — the finding is still live", () => {
  const c = classifyProposal(proposal("proof-debt:W1-T965:3"), undefined, ctxWith(planOf("W1-T965"), []));
  assert.notEqual(c.state, "retired", "retiring a live finding is the expensive direction");
});

test("W1-T3382: a task the PLAN DOES NOT HOLD is no opinion, never a retirement", () => {
  const c = classifyProposal(proposal("proof-debt:W1-T9999:0"), undefined, ctxWith(planOf("W1-T201"), ["W1-T201"]));
  assert.notEqual(c.state, "retired", "a renumbered or unfiled id must not read as finished");
});

test("W1-T3382: an id carrying NO task reference is untouched, however merged the plan is", () => {
  for (const id of ["followup:DAEMON-123:2026-09-02T09:17:34.050Z:0", "adoption:symbol-no-caller:x", "skill-draft:abc123"]) {
    const c = classifyProposal(proposal(id), undefined, ctxWith(planOf("W1-T201"), ["W1-T201"]));
    assert.notEqual(c.state, "retired", `${id} names no task and must be left alone`);
  }
});

test("W1-T3382: the id reader takes only the two shapes that structurally carry a task id", () => {
  assert.equal(deriveTaskReferent("proof-debt:W1-T1015:4"), "W1-T1015");
  assert.equal(deriveTaskReferent("verify-human:W1-T204"), "W1-T204");
  assert.equal(deriveTaskReferent("followup:DAEMON-1788338510177:2026-09-02T09:17:34.050Z:0"), undefined);
  assert.equal(deriveTaskReferent("board-review:escalation:#3039"), undefined);
  assert.equal(deriveTaskReferent("skill-draft:62aff41d7a5fd038"), undefined);
});
