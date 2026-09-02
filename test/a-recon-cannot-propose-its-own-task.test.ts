// test/a-recon-cannot-propose-its-own-task.test.ts — W1-T2617.
//
// THE DEFECT THIS CLOSES, MEASURED 2026-09-01 (this task's own rationale): `routeFollowupsToRegistry`
// (src/lib/retro.ts) had TWO refusal arms — `harvest.deduped` (title-shingle overlap) and
// `FOLLOWUP_TYPE_ROUTES` (declines only "action") — and NEITHER asked whether a candidate's own
// text names the SAME task that declared it. Of 317 live registry proposals, 23 read
// `[task]: Implement W1-T…`, 21 verified self-referential by direct inspection; three name work
// MASTER-PLAN already records SHIPPED (W1-T2442/#3263, W1-T2458/#3275, W1-T2460/#3286), the rest
// name tasks the plan already holds. `retireSettledFollowups` (W1-T2563) cannot reach the
// still-queued majority of these — its ONE signal is "the originating task has merged", and
// retirement runs AFTER the draft spend an admitted duplicate was minted to cause anyway.
//
// This file proves, in order:
//   (1) a follow-up whose text names its own declaring task as the work to do is refused at the
//       routing gate, named on its own outcome ("self-referential"), and no proposal is minted;
//   (2) the refusal is bounded in the direction that matters — a follow-up that merely CITES its
//       own task id while asking for DIFFERENT work is still routed, so a genuine discovery is
//       never silently dropped;
//   (3) the entries already in the registry are pruned by the SAME predicate through the SAME
//       single writer in one write, the pass states how many it removed, and a second pass
//       removes nothing;
//   (4) the refusal holds with no merged-state read available at all — unlike
//       `retireSettledFollowups`, neither `routeFollowupsToRegistry` nor
//       `pruneSelfReferentialFollowups` takes (or needs) a batched merge-state read, so both cover
//       the still-queued originating-task case the merged-signal retirement cannot reach.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  followupOriginatingTaskId,
  followupProposalId,
  isSelfReferentialFollowup,
  mineFollowups,
  pruneSelfReferentialFollowups,
  routeFollowupsToRegistry,
  type FollowupCandidate,
  type LedgerRecord,
} from "../src/lib/retro.js";
import type { Proposal } from "../src/lib/inbox.js";

/** Same in-memory `updateProposalRegistry`-shaped fake test/routed-followups-retire.test.ts and
 *  test/followup-routing-has-a-consumer.test.ts already use — read-current/apply-update/
 *  return-next-or-null, never touching disk. */
function fakeRegistry(initial: Proposal[] = []) {
  let state: Proposal[] = initial;
  let calls = 0;
  return {
    calls: () => calls,
    state: () => state,
    updateRegistry: (_path: string, update: (current: Proposal[]) => Proposal[] | null) => {
      calls += 1;
      const next = update(state);
      if (next !== null) state = next;
      return next;
    },
  };
}

/** A routed follow-up proposal, minted in EXACTLY the shape `routeFollowupsToRegistry` produces
 *  (retro.ts) — the summary carries the `follow-up harvest [type]: <text> — from <taskId>
 *  (run <runId>[, <prUrl>])` referent this whole followup family parses back out. */
function followupProposal(candidate: FollowupCandidate): Proposal {
  return {
    id: followupProposalId(candidate),
    summary:
      `follow-up harvest [${candidate.type}]: ${candidate.text} — from ${candidate.taskId} (run ${candidate.runId}` +
      `${candidate.prUrl ? `, ${candidate.prUrl}` : ""})`,
    evidenceAnchors: [],
  };
}

// The rationale's OWN verbatim example: a recon run declares W1-T2458 and files a follow-up
// whose entire ask is "implement the task that declared me" — the exact shape 21-of-23 measured
// registry rows carried, and the shape the ORIGIN of this very task record documents as its own
// fixture (`state/inbox-proposals.json`'s `followup:W1-T2458-...` row).
const SELF_REFERENTIAL_CANDIDATE: FollowupCandidate = {
  entryId: "run-a:2026-08-29T20:33:15.794Z:0",
  type: "task",
  text:
    "Implement W1-T2458 per its acceptance criteria (...) — this recon confirms the repo is " +
    "clean and ready; that's the actual queued work.",
  runId: "W1-T2458-1788035402626",
  taskId: "W1-T2458",
};

// The rationale's second measured shape: still self-referential even though it carries MORE
// prose after the task id — "itself" plus a paraphrase of the declaring task's own design, never
// a genuinely different ask.
const SELF_REFERENTIAL_WITH_TRAILING_PROSE: FollowupCandidate = {
  entryId: "run-b:2026-08-30T00:00:00Z:0",
  type: "task",
  text: "Implement W1-T2530 itself — add a planOnly-gated exception to the retirement predicate.",
  runId: "run-b",
  taskId: "W1-T2530",
};

// A follow-up that CITES its own declaring task's id but asks for DIFFERENT, additional work —
// the direction the refusal must NOT touch (this task's own design note: "when in doubt let it
// through", because the harvest is the only channel a genuine out-of-scope discovery has).
const CITES_OWN_ID_DIFFERENT_WORK: FollowupCandidate = {
  entryId: "run-c:2026-08-30T00:01:00Z:0",
  type: "task",
  text: "W1-T2530's fix should also cover the planOnly-gated exception for feedback-docket.ts",
  runId: "run-c",
  taskId: "W1-T2530",
};

// An ordinary follow-up naming a DIFFERENT task entirely — the routing baseline this refusal must
// leave untouched.
const ORDINARY_CANDIDATE: FollowupCandidate = {
  entryId: "run-d:2026-08-30T00:02:00Z:0",
  type: "research",
  text: "why does the flaky test fail only under load",
  runId: "run-d",
  taskId: "W1-T9003",
};

// ── acceptance 1: a self-referential follow-up is refused at the routing gate, named, unminted ──

test("isSelfReferentialFollowup is true for a follow-up whose ask IS the task that declared it", () => {
  assert.equal(isSelfReferentialFollowup(SELF_REFERENTIAL_CANDIDATE), true);
  assert.equal(isSelfReferentialFollowup(SELF_REFERENTIAL_WITH_TRAILING_PROSE), true);
});

test("routeFollowupsToRegistry refuses a self-referential candidate, names the arm, and never calls the writer for it alone", () => {
  const reg = fakeRegistry();
  const harvest = { candidates: [SELF_REFERENTIAL_CANDIDATE], deduped: [], harvestLines: [] };

  const outcomes = routeFollowupsToRegistry(harvest, {
    registryPath: "/state/inbox-proposals.json",
    updateRegistry: reg.updateRegistry,
  });

  assert.equal(outcomes.length, 1);
  const outcome = outcomes[0]!;
  assert.equal(outcome.routed, false);
  assert.ok(!outcome.routed);
  assert.equal(outcome.arm, "self-referential");
  assert.match(outcome.reason, /W1-T2458/);

  assert.equal(reg.calls(), 0, "no routable candidate at all — the writer is never even invoked");
  assert.equal(reg.state().length, 0, "no proposal minted for a self-referential entry");
});

test("a self-referential entry with trailing prose past the task id is refused the same way", () => {
  const reg = fakeRegistry();
  const harvest = { candidates: [SELF_REFERENTIAL_WITH_TRAILING_PROSE], deduped: [], harvestLines: [] };

  const outcomes = routeFollowupsToRegistry(harvest, {
    registryPath: "/state/inbox-proposals.json",
    updateRegistry: reg.updateRegistry,
  });

  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0]!.routed, false);
  assert.ok(!outcomes[0]!.routed);
  assert.equal(outcomes[0]!.arm, "self-referential");
  assert.equal(reg.state().length, 0);
});

test("the self-referential arm fires ahead of FOLLOWUP_TYPE_ROUTES — a routable \"task\" type does not save it", () => {
  // Sanity: were the self-referential check skipped, FOLLOWUP_TYPE_ROUTES would route this
  // ("task" -> "propose") — the defect this whole task closes.
  const reg = fakeRegistry();
  const outcomes = routeFollowupsToRegistry(
    { candidates: [SELF_REFERENTIAL_CANDIDATE], deduped: [], harvestLines: [] },
    { registryPath: "/state/inbox-proposals.json", updateRegistry: reg.updateRegistry },
  );
  assert.equal(outcomes[0]!.routed, false);
  assert.ok(!outcomes[0]!.routed);
  assert.notEqual(outcomes[0]!.arm, "type-not-plan-shaped", "must be caught as self-referential, not mistaken for the type arm");
});

// ── acceptance 2: bounded — citing the own id for DIFFERENT work still routes ───────────────────

test("isSelfReferentialFollowup is false for a follow-up that cites its own task id but asks for different work", () => {
  assert.equal(isSelfReferentialFollowup(CITES_OWN_ID_DIFFERENT_WORK), false);
});

test("routeFollowupsToRegistry still routes a follow-up that merely cites its own declaring task's id", () => {
  const reg = fakeRegistry();
  const harvest = { candidates: [CITES_OWN_ID_DIFFERENT_WORK], deduped: [], harvestLines: [] };

  const outcomes = routeFollowupsToRegistry(harvest, {
    registryPath: "/state/inbox-proposals.json",
    updateRegistry: reg.updateRegistry,
  });

  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0]!.routed, true);
  assert.ok(outcomes[0]!.routed);
  assert.equal(reg.calls(), 1);
  assert.equal(reg.state().length, 1, "a genuine discovery that happens to cite its own task id is never dropped");
  assert.equal(reg.state()[0]!.id, followupProposalId(CITES_OWN_ID_DIFFERENT_WORK));
});

test("a mixed harvest routes the ordinary and cites-but-different candidates while refusing only the self-referential one", () => {
  const reg = fakeRegistry();
  const harvest = {
    candidates: [SELF_REFERENTIAL_CANDIDATE, CITES_OWN_ID_DIFFERENT_WORK, ORDINARY_CANDIDATE],
    deduped: [],
    harvestLines: [],
  };

  const outcomes = routeFollowupsToRegistry(harvest, {
    registryPath: "/state/inbox-proposals.json",
    updateRegistry: reg.updateRegistry,
  });

  assert.equal(reg.calls(), 1, "exactly one registry write for the whole pass");
  assert.equal(reg.state().length, 2, "cites-different + ordinary route; self-referential does not");

  const refused = outcomes.filter((o) => !o.routed);
  assert.equal(refused.length, 1);
  assert.ok(!refused[0]!.routed);
  assert.equal(refused[0]!.arm, "self-referential");
  assert.equal(refused[0]!.candidate.taskId, "W1-T2458");
});

test("mineFollowups' own title-dedup and type arms are untouched — the new arm is additive, not a replacement", () => {
  const records: LedgerRecord[] = [
    {
      run_id: "run-e",
      ts: "2026-08-30T00:03:00Z",
      task_id: "W1-T9010",
      step: "report.followups",
      entries: [{ type: "action", text: "an operator should flip the canary flag once merged" }],
    },
  ];
  const harvest = mineFollowups(records, []);
  const reg = fakeRegistry();
  const outcomes = routeFollowupsToRegistry(harvest, {
    registryPath: "/state/inbox-proposals.json",
    updateRegistry: reg.updateRegistry,
  });
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0]!.routed, false);
  assert.ok(!outcomes[0]!.routed);
  assert.equal(outcomes[0]!.arm, "type-not-plan-shaped", "an action entry still declines via the existing type arm");
});

// ── acceptance 3: the SAME predicate prunes the existing registry, one write, states its count ──

test("pruneSelfReferentialFollowups removes every self-referential proposal already in the registry, in one write, and states the count", () => {
  const reg = fakeRegistry([
    followupProposal(SELF_REFERENTIAL_CANDIDATE),
    followupProposal(SELF_REFERENTIAL_WITH_TRAILING_PROSE),
    followupProposal(CITES_OWN_ID_DIFFERENT_WORK),
    followupProposal(ORDINARY_CANDIDATE),
  ]);

  const outcomes = pruneSelfReferentialFollowups({
    registryPath: "/state/inbox-proposals.json",
    updateRegistry: reg.updateRegistry,
  });

  assert.equal(reg.calls(), 1, "exactly one registry write for the whole prune pass");
  assert.equal(outcomes.length, 2, "the pass states exactly how many it removed");
  assert.deepEqual(
    new Set(outcomes.map((o) => o.taskId)),
    new Set(["W1-T2458", "W1-T2530"]),
  );
  for (const o of outcomes) assert.match(o.reason, /implement/i);

  assert.equal(reg.state().length, 2, "the cites-different and ordinary proposals survive the prune");
  const survivingIds = new Set(reg.state().map((p) => p.id));
  assert.ok(survivingIds.has(followupProposalId(CITES_OWN_ID_DIFFERENT_WORK)));
  assert.ok(survivingIds.has(followupProposalId(ORDINARY_CANDIDATE)));
});

test("a second pruneSelfReferentialFollowups pass over an already-pruned registry removes nothing", () => {
  const reg = fakeRegistry([
    followupProposal(SELF_REFERENTIAL_CANDIDATE),
    followupProposal(ORDINARY_CANDIDATE),
  ]);

  const first = pruneSelfReferentialFollowups({
    registryPath: "/state/inbox-proposals.json",
    updateRegistry: reg.updateRegistry,
  });
  assert.equal(first.length, 1);
  assert.equal(reg.state().length, 1);

  const second = pruneSelfReferentialFollowups({
    registryPath: "/state/inbox-proposals.json",
    updateRegistry: reg.updateRegistry,
  });
  assert.equal(second.length, 0, "idempotent — nothing left to prune");
  assert.equal(reg.state().length, 1, "the surviving proposal is untouched");
});

test("pruneSelfReferentialFollowups goes through the SAME single writer routeFollowupsToRegistry and retireSettledFollowups both use", () => {
  const reg = fakeRegistry([followupProposal(SELF_REFERENTIAL_CANDIDATE)]);
  pruneSelfReferentialFollowups({ registryPath: "/state/inbox-proposals.json", updateRegistry: reg.updateRegistry });
  assert.equal(reg.calls(), 1, "the injected updateRegistry-shaped writer is the ONLY mutation path");
});

test("pruneSelfReferentialFollowups never touches a hand-authored / foreign proposal, even one naming a self-referential-looking task", () => {
  const foreign: Proposal = { id: "P9002", summary: "unrelated hand-authored proposal about W1-T2458", evidenceAnchors: [] };
  const reg = fakeRegistry([foreign]);

  const outcomes = pruneSelfReferentialFollowups({
    registryPath: "/state/inbox-proposals.json",
    updateRegistry: reg.updateRegistry,
  });

  assert.equal(outcomes.length, 0);
  assert.equal(reg.state().length, 1, "a proposal outside the followup: family is never pruned by this mechanism");
});

// ── acceptance 4: holds with no merged-state read at all — reaches the still-queued case ────────

test("routeFollowupsToRegistry refuses a self-referential candidate whose declaring task is still QUEUED, with no merge-state read involved anywhere in the call", () => {
  // SELF_REFERENTIAL_CANDIDATE's declaring task (W1-T2458) is, in the live registry this task's
  // rationale measured, ALREADY SHIPPED — but the refusal must not depend on knowing that. Prove
  // it holds for a task explicitly modeled as still queued, and note the call takes no read arg
  // of any kind (unlike `retireSettledFollowups`, whose FIRST parameter is a FollowupReferentRead
  // that can be "unreadable").
  const stillQueuedTask: FollowupCandidate = { ...SELF_REFERENTIAL_CANDIDATE, taskId: "W1-T9999-STILL-QUEUED", text: "Implement W1-T9999-STILL-QUEUED per its acceptance criteria" };
  const reg = fakeRegistry();

  // Note: no merge-state / referent-read argument exists in this call at all — the function
  // signature is `(harvest, deps)`, full stop.
  const outcomes = routeFollowupsToRegistry(
    { candidates: [stillQueuedTask], deduped: [], harvestLines: [] },
    { registryPath: "/state/inbox-proposals.json", updateRegistry: reg.updateRegistry },
  );

  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0]!.routed, false);
  assert.ok(!outcomes[0]!.routed);
  assert.equal(outcomes[0]!.arm, "self-referential");
  assert.equal(reg.state().length, 0);
});

test("pruneSelfReferentialFollowups likewise takes no merge-state read — it prunes a still-queued-task's proposal exactly like a shipped one's", () => {
  const stillQueued = followupProposal({ ...SELF_REFERENTIAL_CANDIDATE, taskId: "W1-T9999-STILL-QUEUED", text: "Implement W1-T9999-STILL-QUEUED per its acceptance criteria" });
  const reg = fakeRegistry([stillQueued]);

  // PruneFollowupsDeps carries only { registryPath, updateRegistry? } — no referent-read field.
  const outcomes = pruneSelfReferentialFollowups({
    registryPath: "/state/inbox-proposals.json",
    updateRegistry: reg.updateRegistry,
  });

  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0]!.taskId, "W1-T9999-STILL-QUEUED");
  assert.equal(reg.state().length, 0, "pruned even though its declaring task was never observed as merged");
});

test("followupOriginatingTaskId still resolves the referent this prune pass keys on, unchanged by this task", () => {
  assert.equal(followupOriginatingTaskId(followupProposal(SELF_REFERENTIAL_CANDIDATE)), "W1-T2458");
});
