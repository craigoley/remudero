// test/routed-followups-retire.test.ts — W1-T2563.
//
// THE DEFECT THIS CLOSES, MEASURED 2026-09-01: `routeFollowupsToRegistry` (src/lib/retro.ts)
// appends every routable harvested candidate through `updateProposalRegistry` with no expiry, no
// retirement arm and no cap. Its own idempotence check (refusing to re-add an id already
// present) is correct and is NOT the gap — nothing ANYWHERE removes a followup-prefixed
// proposal once minted. The registry held 317 proposals, EVERY ONE `followup:`-prefixed,
// against 16 two days earlier that were ALL `board-review:` — a queue that only grows.
//
// `retireSettledFollowups` is the missing removal arm. This file proves, in order:
//   (1) a routed follow-up whose originating task has merged is retired FROM THE REGISTRY
//       (acceptance 1 — the state actually shrinks, not merely a render-time reclassification);
//   (2) retirement never reads `evidenceAnchors` at all, so it works identically for the
//       permanently-empty anchor set every routed follow-up carries (acceptance 2);
//   (3) every retirement outcome NAMES the false-positive risk it carries — a merged task can
//       still leave real follow-up work undone — rather than silently claiming certainty
//       (acceptance 3);
// plus the surrounding discipline this whole codebase holds every batched-referent mechanism to:
// cannot-observe means WAIT, a foreign/hand-authored proposal is left alone, and a still-live
// referent changes nothing.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  followupOriginatingTaskId,
  followupProposalId,
  retireSettledFollowups,
  type FollowupCandidate,
  type FollowupReferentRead,
} from "../src/lib/retro.js";
import type { Proposal } from "../src/lib/inbox.js";

/** Same in-memory `updateProposalRegistry`-shaped fake test/followup-routing-has-a-consumer.test.ts
 *  already uses — read-current/apply-update/return-next-or-null, never touching disk. */
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
 *  (retro.ts) — the summary carries the `... — from <taskId> (run <runId>[, <prUrl>])` referent
 *  this whole retirement mechanism parses back out, never a structured field. */
function followupProposal(candidate: FollowupCandidate): Proposal {
  return {
    id: followupProposalId(candidate),
    summary:
      `follow-up harvest [${candidate.type}]: ${candidate.text} — from ${candidate.taskId} (run ${candidate.runId}` +
      `${candidate.prUrl ? `, ${candidate.prUrl}` : ""})`,
    evidenceAnchors: [],
  };
}

const MERGED_CANDIDATE: FollowupCandidate = {
  entryId: "run-1:2026-08-20T00:00:00Z:0",
  type: "task",
  text: "add a jittered backoff to the notification webhook sender",
  runId: "run-1",
  taskId: "W1-T9002",
  prUrl: "https://github.com/o/r/pull/4242",
};

const LIVE_CANDIDATE: FollowupCandidate = {
  entryId: "run-2:2026-08-21T00:00:00Z:0",
  type: "research",
  text: "why does the flaky test fail only under load",
  runId: "run-2",
  taskId: "W1-T9003",
};

function mergedRead(...taskIds: string[]): FollowupReferentRead {
  return { kind: "ok", merged: new Set(taskIds) };
}

// ── acceptance 1: a routed follow-up whose originating work is settled is retired ──────────────

test("a routed follow-up whose originating task has MERGED is removed from the registry", () => {
  const reg = fakeRegistry([followupProposal(MERGED_CANDIDATE), followupProposal(LIVE_CANDIDATE)]);

  const outcomes = retireSettledFollowups(mergedRead("W1-T9002"), {
    registryPath: "/state/inbox-proposals.json",
    updateRegistry: reg.updateRegistry,
  });

  assert.equal(reg.calls(), 1, "exactly one registry write for this pass — never one call per proposal");
  assert.equal(reg.state().length, 1, "the merged-task proposal is gone; the live one stays");
  assert.equal(reg.state()[0]!.id, followupProposalId(LIVE_CANDIDATE));

  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0]!.proposalId, followupProposalId(MERGED_CANDIDATE));
  assert.equal(outcomes[0]!.taskId, "W1-T9002");
});

test("a routed follow-up whose originating task is still OPEN (unmerged) is left exactly alone", () => {
  const reg = fakeRegistry([followupProposal(LIVE_CANDIDATE)]);

  const outcomes = retireSettledFollowups(mergedRead(/* nothing merged */), {
    registryPath: "/state/inbox-proposals.json",
    updateRegistry: reg.updateRegistry,
  });

  assert.equal(outcomes.length, 0);
  assert.equal(reg.calls(), 1, "the writer is still called (it must read fresh state), but writes nothing");
  assert.equal(reg.state().length, 1, "no proposal removed while its referent is still live");
});

test("a hand-authored / non-followup proposal is never touched, even if its id happens to name a merged task", () => {
  const handAuthored: Proposal = { id: "P9002", summary: "unrelated hand-authored proposal about W1-T9002", evidenceAnchors: [] };
  const reg = fakeRegistry([handAuthored]);

  const outcomes = retireSettledFollowups(mergedRead("W1-T9002"), {
    registryPath: "/state/inbox-proposals.json",
    updateRegistry: reg.updateRegistry,
  });

  assert.equal(outcomes.length, 0);
  assert.equal(reg.state().length, 1, "a proposal outside the followup: family is never removed by this mechanism");
});

test("cannot-observe means WAIT: an unreadable batched read retires nothing and never calls the writer", () => {
  const reg = fakeRegistry([followupProposal(MERGED_CANDIDATE)]);

  const outcomes = retireSettledFollowups({ kind: "unreadable" }, {
    registryPath: "/state/inbox-proposals.json",
    updateRegistry: reg.updateRegistry,
  });

  assert.equal(outcomes.length, 0);
  assert.equal(reg.calls(), 0, "a failed batched read must never guess — the registry write is skipped entirely");
  assert.equal(reg.state().length, 1, "nothing retired on an unreadable pass");
});

// ── acceptance 2: retirement never depends on an evidence anchor ───────────────────────────────

test("retirement fires identically whether the proposal's evidenceAnchors is [] (the routed-follow-up norm) or non-empty — the predicate never reads the field", () => {
  const bareAnchors = followupProposal(MERGED_CANDIDATE);
  assert.deepEqual(bareAnchors.evidenceAnchors, [], "sanity: a routed follow-up really does carry the permanently-empty set");

  const withAnchors: Proposal = { ...followupProposal(MERGED_CANDIDATE), evidenceAnchors: [{ pattern: "someFunction", path: "src/x.ts", description: "fixture anchor" }] };

  const regA = fakeRegistry([bareAnchors]);
  const outcomesA = retireSettledFollowups(mergedRead("W1-T9002"), { registryPath: "/p.json", updateRegistry: regA.updateRegistry });

  const regB = fakeRegistry([withAnchors]);
  const outcomesB = retireSettledFollowups(mergedRead("W1-T9002"), { registryPath: "/p.json", updateRegistry: regB.updateRegistry });

  assert.equal(outcomesA.length, 1);
  assert.equal(outcomesB.length, 1, "a non-empty anchor set does not change the outcome — the mechanism is anchor-blind");
  assert.equal(regA.state().length, 0);
  assert.equal(regB.state().length, 0);
});

test("followupOriginatingTaskId parses the referent purely off the summary string, with no evidenceAnchors involvement at all", () => {
  const proposal = followupProposal(MERGED_CANDIDATE);
  assert.equal(followupOriginatingTaskId(proposal), "W1-T9002");
  assert.equal(followupOriginatingTaskId({ ...proposal, evidenceAnchors: [{ pattern: "x", description: "fixture anchor" }] }), "W1-T9002");
  assert.equal(followupOriginatingTaskId({ id: "P1", summary: "unrelated", evidenceAnchors: [] }), undefined);
});

// ── acceptance 3: the retirement names which still-live candidates it wrongly removes ──────────

test("every retirement outcome's reason explicitly names the false-positive risk — a merged task can still leave real follow-up work undone — rather than claiming none", () => {
  const reg = fakeRegistry([followupProposal(MERGED_CANDIDATE)]);
  const outcomes = retireSettledFollowups(mergedRead("W1-T9002"), {
    registryPath: "/state/inbox-proposals.json",
    updateRegistry: reg.updateRegistry,
  });

  assert.equal(outcomes.length, 1);
  const { reason } = outcomes[0]!;
  assert.match(reason, /false-positive/i, "the reason must name the risk by name, not bury it");
  assert.match(
    reason,
    /merge.*while leaving real follow-up work undone|leave real follow-up work undone/i,
    "the reason must state WHY this signal can be wrong, not merely assert that it might be",
  );
  assert.doesNotMatch(
    reason,
    /no live candidates|never wrongly|always correct|no risk/i,
    "the reason must never claim certainty this mechanism has not measured",
  );
});

test("the false-positive risk is named for EVERY retirement in a batch, not just a summary line for the whole pass", () => {
  const otherMerged: FollowupCandidate = { ...LIVE_CANDIDATE, entryId: "run-3:2026-08-22T00:00:00Z:0", taskId: "W1-T9004" };
  const reg = fakeRegistry([followupProposal(MERGED_CANDIDATE), followupProposal(otherMerged)]);

  const outcomes = retireSettledFollowups(mergedRead("W1-T9002", "W1-T9004"), {
    registryPath: "/state/inbox-proposals.json",
    updateRegistry: reg.updateRegistry,
  });

  assert.equal(outcomes.length, 2);
  for (const outcome of outcomes) {
    assert.match(outcome.reason, /false-positive/i);
    assert.match(outcome.reason, new RegExp(outcome.taskId));
  }
});

// ── idempotence: re-running the same pass over an already-retired registry is a no-op ──────────

test("re-running retirement after the merged proposal is already gone finds nothing left to retire", () => {
  const reg = fakeRegistry([followupProposal(MERGED_CANDIDATE), followupProposal(LIVE_CANDIDATE)]);
  const read = mergedRead("W1-T9002");

  const first = retireSettledFollowups(read, { registryPath: "/p.json", updateRegistry: reg.updateRegistry });
  assert.equal(first.length, 1);

  const second = retireSettledFollowups(read, { registryPath: "/p.json", updateRegistry: reg.updateRegistry });
  assert.equal(second.length, 0, "nothing left to retire the second time around");
  assert.equal(reg.state().length, 1, "the still-live proposal is untouched across both passes");
});
