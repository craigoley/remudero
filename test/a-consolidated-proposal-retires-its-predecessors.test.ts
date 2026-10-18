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
import { appendFileSync } from "node:fs";
import { world } from "#test/helpers/why-me-world.js";
import { loadPlan } from "#src/lib/plan.js";
import { defaultInboxGardenerPorts, runInboxGardener } from "#src/lib/inbox-gardener.js";
import { proofDebtPopulationPermit, stampMechanicalAsk } from "#src/lib/inbox-retirement.js";
import { readPersistedInbox } from "#src/lib/fleet-lane.js";
import { test } from "node:test";

import { classifyProposal, updateProposalRegistry, supersedingProposalId, type Proposal, type ReadinessContext } from "#src/lib/inbox.js";
import type { Plan } from "#src/lib/plan.js";

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

test("W1-T3511: a per-criterion proposal RETIRES once its per-task successor is open", async t => {
  const f = await world(t);
  appendFileSync(f.planPath, "- id: W1-T965\n  title: Mechanical proof repair\n  repo: core\n  depends_on: []\n  type: implement\n  verify: auto\n  status: queued\n");
  const task = loadPlan(f.planPath).byId.get("W1-T965")!, permit = proofDebtPopulationPermit([task]);
  const anchors = [{ description: "unresolved criterion3", path: "plan/tasks.yaml", pattern: "grep: missing in src/missing.ts" }];
  const typed = (id: string) => stampMechanicalAsk({ id, summary: id, evidenceAnchors: anchors }, task.id, permit);
  updateProposalRegistry(f.registry, all => [...all, typed(PRED), typed(SUCC)]);
  await f.refresh();
  const scope = { repository: f.repository, instance: f.instance, root: f.root };
  const ports = defaultInboxGardenerPorts({ stateDir: f.state, scope, planPath: f.planPath, codeSha: "a".repeat(40), githubJson: async () => [] });
  const result = await runInboxGardener({ stateDir: f.state, scope, ports, mode: "act" });
  assert.equal("retired" in result && result.retired, 1);
  await f.refresh(); const c = readPersistedInbox(f.state)!.classifications.find(c => c.proposalId === PRED)!;
  assert.equal(c.state, "retired"); assert.equal(c.retirement?.proofKind, "successor");
  assert.match(c.retiredReason ?? "", /successor positively resolves/);
  const legacy = classifyProposal(proposal(PRED), undefined, ctxWith([SUCC]));
  assert.notEqual(legacy.state, "retired", "an untyped legacy ID alone is no longer positive successor authority");
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
