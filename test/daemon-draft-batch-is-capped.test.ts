// W1-T2561: the daemon's inbox-draft rung drafted EVERY due proposal in one awaited batch, at an
// `inbox.draft_synthesized` mean of $8.52 per spawn, with nothing bounding how many that could be.
//
// THE THROTTLE BESIDE IT BOUNDS REPETITION, NOT VOLUME. `DraftAttemptCache` already guarantees one
// attempt per cause; it says nothing about how many DISTINCT proposals may be drafted at once.
// That was harmless while the registry was small and hand-fed, and stopped being harmless when
// `routeFollowupsToRegistry` (lib/retro.ts) began appending every routable harvested follow-up
// with no cap and no expiry. MEASURED 2026-09-01: 317 proposals in the registry, all
// `followup:`-prefixed, 285 still needing a draft — roughly $2,400 of latent spend behind a
// throttle key any reframe round invalidates.
//
// AND THE OBVIOUS FIX WAS THE WRONG ONE, WHICH IS WHY THE CAP IS THE SHAPE IT IS. Classifying every
// retained `inbox.draft_synthesized` row by the `daemon.headroom` state in force at that instant:
// 998 spawns / $1,991.95 while `over_ceiling` was FALSE, against 24 spawns / $0.00 while TRUE. The
// rung does not spend THROUGH exhaustion — it DRIVES the account there while the governor still
// reads healthy, so a gate on the exhausted state would have bounded $0 of the $1,992 spent.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DAEMON_DRAFT_BATCH_CAP,
  draftsDueOnDaemon,
  draftAttemptKey,
  proposalsNeedingDraft,
  type DraftAttemptCache,
  type DraftCache,
  type Proposal,
} from "../src/lib/inbox.js";

/** N never-drafted proposals shaped like the ones the follow-up router mints: free-prose summary,
 *  `evidenceAnchors: []` stated rather than synthesized. */
function followupProposals(n: number): Proposal[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `followup:DAEMON-1788192519316:2026-08-31T16:${String(i).padStart(2, "0")}:00.000Z:0`,
    summary: `follow-up harvest [task]: something a worker named as out of its own scope (${i})`,
    evidenceAnchors: [],
  }));
}

test("a large registry is PACED, not stampeded — one poll drafts at most the cap however many are due", () => {
  const proposals = followupProposals(317); // the measured registry size
  const drafts: DraftCache = {};
  const attempts: DraftAttemptCache = {};

  const eligible = proposalsNeedingDraft(proposals, drafts);
  assert.equal(eligible.length, 317, "every one genuinely needs a draft — the cap is not hiding a smaller set");

  const due = draftsDueOnDaemon(proposals, drafts, attempts);
  assert.equal(
    due.length,
    DAEMON_DRAFT_BATCH_CAP,
    `one poll must spawn at most ${DAEMON_DRAFT_BATCH_CAP} Architects, got ${due.length} — at the measured $8.52/spawn that is the difference between ~$26 and ~$2,700 on a single tick`,
  );
});

test("the cap DELAYS work and never drops it — successive polls drain the whole queue", () => {
  const proposals = followupProposals(10);
  const drafts: DraftCache = {};
  const attempts: DraftAttemptCache = {};

  const seen = new Set<string>();
  let polls = 0;
  for (; polls < 50; polls++) {
    const due = draftsDueOnDaemon(proposals, drafts, attempts);
    if (due.length === 0) break;
    assert.ok(due.length <= DAEMON_DRAFT_BATCH_CAP, "no poll may exceed the cap");
    // Exactly what buildInboxDraftHook records per attempted proposal, win or lose.
    for (const p of due) {
      seen.add(p.id);
      attempts[p.id] = draftAttemptKey(p);
    }
  }
  assert.equal(seen.size, 10, "every proposal must eventually be attempted — a cap that starved one would be a drop");
  assert.equal(polls, Math.ceil(10 / DAEMON_DRAFT_BATCH_CAP), "and it drains at the bounded rate, not slower");
});

test("a proposal deferred by the cap is NOT recorded as attempted, so it stays due", () => {
  const proposals = followupProposals(5);
  const attempts: DraftAttemptCache = {};
  const due = draftsDueOnDaemon(proposals, {}, attempts);
  const deferred = proposals.filter((p) => !due.some((d) => d.id === p.id));
  assert.equal(deferred.length, 5 - DAEMON_DRAFT_BATCH_CAP);
  for (const p of deferred) {
    assert.equal(attempts[p.id], undefined, "the cap must not write an attempt key for work it did not do");
  }
  // The next poll picks them up precisely because no key was written for them.
  for (const p of due) attempts[p.id] = draftAttemptKey(p);
  const next = draftsDueOnDaemon(proposals, {}, attempts);
  assert.deepEqual(
    next.map((p) => p.id).sort(),
    deferred.slice(0, DAEMON_DRAFT_BATCH_CAP).map((p) => p.id).sort(),
    "the next poll must take the deferred ones",
  );
});

test("the idempotence throttle is UNCHANGED — the cap is layered on top, it does not replace it", () => {
  const proposals = followupProposals(2);
  const attempts: DraftAttemptCache = Object.fromEntries(proposals.map((p) => [p.id, draftAttemptKey(p)]));
  assert.deepEqual(
    draftsDueOnDaemon(proposals, {}, attempts),
    [],
    "an already-attempted cause stays throttled — the cap must not resurrect it",
  );
});

test("cap 0 means UNCAPPED, so the hook can count what it deferred without a second predicate", () => {
  const proposals = followupProposals(317);
  assert.equal(draftsDueOnDaemon(proposals, {}, {}, 0).length, 317, "0 is the escape hatch the deferral row reads");
  assert.equal(draftsDueOnDaemon(proposals, {}, {}, 1).length, 1, "and an explicit cap still binds");
});
