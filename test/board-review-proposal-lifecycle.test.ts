import assert from "node:assert/strict";
import { test } from "node:test";
import { buildBoardReview, type BoardItem, type BoardReviewPolicy } from "../src/lib/board-review.js";
import {
  anchorFingerprint,
  classifyProposal,
  refusalReason,
  renderInbox,
  type BoardReferentRead,
  type BoardReferentState,
  type DraftedCandidate,
  type Proposal,
  type ReadinessContext,
} from "../src/lib/inbox.js";
import { loadPlanFromYaml, type MergedResolver, type Plan } from "../src/lib/plan.js";

/**
 * test/board-review-proposal-lifecycle.test.ts — W1-T2451.
 *
 * THE FALSIFIER THIS FILE PROVES: `board-review:escalation:#3039` carried `evidenceAnchors: []`
 * (board-review.ts:383, PRE-FIX) — over an empty set `driftedAnchors` is always `[]`, so the
 * `evidence_anchors` predicate at inbox.ts's own drift check is MECHANICALLY UNREACHABLE for this
 * whole proposal family. `#3039` had already burned its fix-rung strikes days before the proposal
 * was ever read (fb-repair-blocked-fixable-2956.yaml), yet nothing in the readiness predicate
 * could ever move it off READY. Every test below runs against the CURRENT `classifyProposal` —
 * the first one (RESOLVED) is the one that would have FAILED before this task's fix landed,
 * because pre-fix the very same proposal/draft/ctx triple classifies "ready", never "retired".
 */

// ── Fixtures (mirrors test/inbox.test.ts's own base plan/fragment shapes) ─────────────────────

const BASE_PLAN_YAML = `
- id: W1-T1
  title: "already-merged foundation task"
  repo: remudero
  depends_on: []
  type: implement
  verify: auto
  risk: medium
  status: merged
  attempts: 1
  origin: architect
`;

function basePlan(): Plan {
  return loadPlanFromYaml(BASE_PLAN_YAML, "fixture");
}

const yamlIsMerged: MergedResolver = (t) => t.status === "merged" || t.status === "done";

const CLEAN_FRAGMENT = `
- id: W1-T900
  title: "candidate task drafted from a ready proposal"
  repo: remudero
  depends_on: [W1-T1]
  type: implement
  verify: auto
  risk: medium
  status: queued
  attempts: 0
  origin: architect
  files: [src/lib/example.ts]
  acceptance:
    - claim: "the candidate does the thing"
      proof: "unit test: fixture X -> observable Y"
`;

const DEP_UNMET_FRAGMENT = `
- id: W1-T901
  title: "candidate depending on an unmerged task"
  repo: remudero
  depends_on: [W1-T2-NEVER-MERGED]
  type: implement
  verify: auto
  risk: medium
  status: queued
  attempts: 0
  origin: architect
  acceptance:
    - claim: "the candidate does the thing"
      proof: "unit test: fixture X -> observable Y"
`;

function draftFor(proposalId: string, fragmentYaml: string): DraftedCandidate {
  return {
    proposalId,
    fragmentYaml,
    stampLine: `- ${proposalId} (plan) — RATIFIED 2026-08-29 -> W1-T900.`,
    // Board-review proposals mint with evidenceAnchors: [] — anchorFingerprint([]) is "" — so a
    // draft cached against that empty set is never stale on that account alone.
    anchorFingerprint: anchorFingerprint([]),
  };
}

/** A board-review-shaped proposal, exactly as board-review.ts mints one (post-fix):
 *  evidenceAnchors permanently [], plus the structured originatingItemId this task adds. */
function boardReviewProposal(overrides: Partial<Proposal> & { id: string; originatingItemId: string }): Proposal {
  return {
    summary: `board-review: ${overrides.originatingItemId} carries 1 unhandled escalation(s)`,
    evidenceAnchors: [],
    ...overrides,
  };
}

function baseCtx(overrides: Partial<ReadinessContext> = {}): ReadinessContext {
  return {
    plan: basePlan(),
    isMerged: yamlIsMerged,
    grepAnchorTrue: () => true,
    openProposalIds: new Set(),
    isRatified: () => false,
    ...overrides,
  };
}

function referentRead(states: Record<string, BoardReferentState>): BoardReferentRead {
  return { kind: "ok", states: new Map(Object.entries(states)) };
}

// ── Acceptance 1: a RESOLVED referent never classifies READY — the #3039 falsifier ─────────────

test("a board-review proposal whose referent has MERGED does not classify READY, even though evidenceAnchors: [] makes evidence-drift mechanically unreachable", () => {
  const proposal = boardReviewProposal({ id: "board-review:escalation:pr-3039", originatingItemId: "pr-3039" });
  const draft = draftFor(proposal.id, CLEAN_FRAGMENT);
  const ctx = baseCtx({ boardReferents: referentRead({ "pr-3039": { status: "merged", unhandledEscalations: 1 } }) });

  const classification = classifyProposal(proposal, draft, ctx);

  assert.notEqual(classification.state, "ready", "a merged referent must never render READY");
  assert.equal(classification.state, "retired");
  assert.equal(classification.reasons.length, 0);
  assert.match(classification.retiredReason ?? "", /pr-3039/);
  assert.match(classification.retiredReason ?? "", /resolved/);
});

test("a board-review proposal whose referent DIED does not classify READY", () => {
  const proposal = boardReviewProposal({ id: "board-review:stale:pr-4001", originatingItemId: "pr-4001" });
  const draft = draftFor(proposal.id, CLEAN_FRAGMENT);
  const ctx = baseCtx({ boardReferents: referentRead({ "pr-4001": { status: "dead", unhandledEscalations: 0 } }) });

  assert.equal(classifyProposal(proposal, draft, ctx).state, "retired");
});

test("an escalation-kind proposal retires once its escalation is handled, even while its PR stays open", () => {
  const proposal = boardReviewProposal({ id: "board-review:escalation:pr-5002", originatingItemId: "pr-5002" });
  const draft = draftFor(proposal.id, CLEAN_FRAGMENT);
  const ctx = baseCtx({ boardReferents: referentRead({ "pr-5002": { status: "open", unhandledEscalations: 0 } }) });

  assert.equal(classifyProposal(proposal, draft, ctx).state, "retired");
});

test("a stale-kind proposal does NOT retire just because escalations read zero — staleness is a property of the item leaving open, not of escalation count", () => {
  const proposal = boardReviewProposal({ id: "board-review:stale:pr-6003", originatingItemId: "pr-6003" });
  const draft = draftFor(proposal.id, CLEAN_FRAGMENT);
  const ctx = baseCtx({ boardReferents: referentRead({ "pr-6003": { status: "open", unhandledEscalations: 0 } }) });

  assert.equal(classifyProposal(proposal, draft, ctx).state, "ready");
});

// ── Acceptance 2: a STILL LIVE referent classifies exactly as it does today ────────────────────

test("a board-review proposal whose referent is STILL LIVE classifies identically whether bound by an explicit originatingItemId or resolved through W1-T2460's id-derived fallback", () => {
  // Pre-W1-T2460, a proposal missing `originatingItemId` (every row minted before W1-T2451, or a
  // fixture standing in for one) short-circuited straight to "live" without ever consulting the
  // batched read — this test used to compare THAT against a tracked proposal wired to a live
  // referent to prove wiring the field changed nothing. W1-T2460 closes exactly that gap: such a
  // proposal is no longer exempt from the batched read, it is resolved through the SAME id,
  // parsed from its own string. So the meaningful comparison now is the two RESOLUTION PATHS
  // (explicit field vs. parsed-from-id) against the identical live referent, which must still
  // agree — see test/legacy-board-review-proposals-can-retire.test.ts for that fix's own coverage
  // of the previously-unreachable "no field at all, batched read absent" case.
  const trackedId = "board-review:escalation:pr-7004";
  const tracked = boardReviewProposal({ id: trackedId, originatingItemId: "pr-7004" });
  const legacy: Proposal = { id: trackedId, summary: tracked.summary, evidenceAnchors: [] }; // no field — id-derived
  const draft = draftFor(trackedId, CLEAN_FRAGMENT);

  const liveCtx = baseCtx({ boardReferents: referentRead({ "pr-7004": { status: "open", unhandledEscalations: 1 } }) });

  const trackedClassification = classifyProposal(tracked, draft, liveCtx);
  const legacyClassification = classifyProposal(legacy, draft, liveCtx);

  assert.deepEqual(
    trackedClassification,
    legacyClassification,
    "an explicit originatingItemId and W1-T2460's id-derived fallback must resolve a live referent identically",
  );
  assert.equal(trackedClassification.state, "ready");
  assert.equal(trackedClassification.referentUnverified, undefined, "a live referent is never marked unverified");
});

test("a board-review proposal whose referent is still OPEN and past nothing stays NOT READY exactly as before, when the drafted fragment itself is unmet", () => {
  const proposal = boardReviewProposal({ id: "board-review:stale:pr-8005", originatingItemId: "pr-8005" });
  const draft = draftFor(proposal.id, DEP_UNMET_FRAGMENT);
  const ctx = baseCtx({ boardReferents: referentRead({ "pr-8005": { status: "open", unhandledEscalations: 0 } }) });

  const c = classifyProposal(proposal, draft, ctx);
  assert.equal(c.state, "not_ready");
  assert.equal(c.reasons.some((r) => r.predicate === "deps_merged"), true);
});

// ── Acceptance 3: an UNREADABLE referent keeps the proposal's current state, marked unverified ──

test("a wholly unreadable batched read keeps a would-be-READY board-review proposal READY, marked unverified — never silently retired", () => {
  const proposal = boardReviewProposal({ id: "board-review:escalation:pr-9006", originatingItemId: "pr-9006" });
  const draft = draftFor(proposal.id, CLEAN_FRAGMENT);
  const ctx = baseCtx({ boardReferents: { kind: "unreadable" } });

  const c = classifyProposal(proposal, draft, ctx);
  assert.equal(c.state, "ready", "cannot-observe means WAIT — never a guessed retirement");
  assert.equal(c.referentUnverified, true);
});

test("an id absent from an otherwise-OK batched read (unparseable/unknown referent) is treated as unreadable too, never silently retired", () => {
  const proposal = boardReviewProposal({ id: "board-review:escalation:pr-9999", originatingItemId: "pr-9999" });
  const draft = draftFor(proposal.id, CLEAN_FRAGMENT);
  const ctx = baseCtx({ boardReferents: referentRead({}) }); // read succeeded, but this id was never in it

  const c = classifyProposal(proposal, draft, ctx);
  assert.equal(c.state, "ready");
  assert.equal(c.referentUnverified, true);
});

test("an unreadable referent keeps a NOT-READY board-review proposal NOT READY (its current state), not READY and not RETIRED", () => {
  const proposal = boardReviewProposal({ id: "board-review:stale:pr-1007", originatingItemId: "pr-1007" });
  const draft = draftFor(proposal.id, DEP_UNMET_FRAGMENT);
  const ctx = baseCtx({ boardReferents: { kind: "unreadable" } });

  const c = classifyProposal(proposal, draft, ctx);
  assert.equal(c.state, "not_ready");
  assert.equal(c.referentUnverified, true);
});

test("omitting boardReferents entirely (a caller that forgot to wire it) fails toward unverified-and-kept, never toward a false retirement", () => {
  const proposal = boardReviewProposal({ id: "board-review:escalation:pr-1108", originatingItemId: "pr-1108" });
  const draft = draftFor(proposal.id, CLEAN_FRAGMENT);
  const ctx = baseCtx(); // boardReferents entirely absent

  const c = classifyProposal(proposal, draft, ctx);
  assert.equal(c.state, "ready");
  assert.equal(c.referentUnverified, true);
});

// ── Acceptance 4: retirement is a STATE, never a deletion; reconciliation is idempotent ────────

test("classifying an already-retired proposal a second pass produces the identical retired classification — idempotent reconciliation", () => {
  const proposal = boardReviewProposal({ id: "board-review:escalation:pr-1209", originatingItemId: "pr-1209" });
  const draft = draftFor(proposal.id, CLEAN_FRAGMENT);
  const ctx = baseCtx({ boardReferents: referentRead({ "pr-1209": { status: "merged", unhandledEscalations: 0 } }) });

  const first = classifyProposal(proposal, draft, ctx);
  const second = classifyProposal(proposal, draft, ctx);

  assert.deepEqual(first, second, "a second reconciliation pass over an already-retired proposal changes nothing");
  assert.equal(first.state, "retired");
});

test("a retired proposal's registry record survives untouched — classifyProposal never mutates or strips the proposal it was given", () => {
  const proposal = boardReviewProposal({ id: "board-review:escalation:pr-1310", originatingItemId: "pr-1310" });
  const snapshot: Proposal = JSON.parse(JSON.stringify(proposal));
  const draft = draftFor(proposal.id, CLEAN_FRAGMENT);
  const ctx = baseCtx({ boardReferents: referentRead({ "pr-1310": { status: "merged", unhandledEscalations: 0 } }) });

  const classification = classifyProposal(proposal, draft, ctx);

  assert.equal(classification.state, "retired");
  assert.deepEqual(proposal, snapshot, "retirement is a computed classification, never a write against the proposal — the registry entry and its provenance are untouched");
});

test("renderInbox and refusalReason both name a retired proposal — provenance stays visible, never silently dropped", () => {
  const proposal = boardReviewProposal({ id: "board-review:escalation:pr-1411", originatingItemId: "pr-1411" });
  const draft = draftFor(proposal.id, CLEAN_FRAGMENT);
  const ctx = baseCtx({ boardReferents: referentRead({ "pr-1411": { status: "merged", unhandledEscalations: 0 } }) });
  const classification = classifyProposal(proposal, draft, ctx);

  const rendered = renderInbox([classification]);
  assert.match(rendered, /RETIRED — board-review:escalation:pr-1411/);
  assert.match(rendered, /1 retired/);
  assert.doesNotMatch(rendered, /READY — board-review:escalation:pr-1411/);

  const refusal = refusalReason(classification);
  assert.match(refusal, /RETIRED/);
  assert.match(refusal, /never approvable/);
});

// ── Acceptance 5: the minter binds each finding to the board item that produced it ─────────────

const ON: BoardReviewPolicy = { enabled: true, minIntervalMinutes: 0, maxPerDay: 10 };
const NOW = new Date("2026-08-29T12:00:00.000Z");

function item(overrides: Partial<BoardItem> & { id: string }): BoardItem {
  return { isDraft: false, status: "open", ageHours: 1, redCheckCount: 0, unhandledEscalations: 0, ...overrides };
}

test("diagnoseBoardFindings (via buildBoardReview) mints a staleness proposal with originatingItemId bound to the item that produced it", () => {
  const items = [item({ id: "pr-2001", ageHours: 100 })]; // well past BOARD_REVIEW_OLDEST_OPEN_AGE_HOURS
  let registryState: Proposal[] = [];

  buildBoardReview({
    policy: ON,
    marker: { kind: "absent" },
    items,
    now: NOW,
    reportPath: "/state/report.json",
    registryPath: "/state/inbox-proposals.json",
    writeReport: () => {},
    updateRegistry: (_p, update) => {
      const next = update(registryState);
      if (next !== null) registryState = next;
      return next;
    },
  });

  assert.equal(registryState.length, 1);
  assert.equal(registryState[0].id, "board-review:stale:pr-2001");
  assert.equal(registryState[0].originatingItemId, "pr-2001");
});

test("diagnoseBoardFindings (via buildBoardReview) mints an escalation proposal with originatingItemId bound to the item that produced it", () => {
  const items = [item({ id: "pr-3039", unhandledEscalations: 1 })];
  let registryState: Proposal[] = [];

  buildBoardReview({
    policy: ON,
    marker: { kind: "absent" },
    items,
    now: NOW,
    reportPath: "/state/report.json",
    registryPath: "/state/inbox-proposals.json",
    writeReport: () => {},
    updateRegistry: (_p, update) => {
      const next = update(registryState);
      if (next !== null) registryState = next;
      return next;
    },
  });

  assert.equal(registryState.length, 1);
  assert.equal(registryState[0].id, "board-review:escalation:pr-3039");
  assert.equal(registryState[0].originatingItemId, "pr-3039");
});

test("two items open in the same tick each bind their OWN originatingItemId — never one item's referent read for another's proposal", () => {
  const items = [item({ id: "pr-4100", ageHours: 100 }), item({ id: "pr-4200", ageHours: 100 })];
  let registryState: Proposal[] = [];

  buildBoardReview({
    policy: ON,
    marker: { kind: "absent" },
    items,
    now: NOW,
    reportPath: "/state/report.json",
    registryPath: "/state/inbox-proposals.json",
    writeReport: () => {},
    updateRegistry: (_p, update) => {
      const next = update(registryState);
      if (next !== null) registryState = next;
      return next;
    },
  });

  assert.equal(registryState.length, 2);
  const byId = new Map(registryState.map((p) => [p.id, p.originatingItemId]));
  assert.equal(byId.get("board-review:stale:pr-4100"), "pr-4100");
  assert.equal(byId.get("board-review:stale:pr-4200"), "pr-4200");
});
