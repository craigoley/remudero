import assert from "node:assert/strict";
import { test } from "node:test";
import {
  anchorFingerprint,
  classifyProposal,
  type BoardReferentRead,
  type BoardReferentState,
  type DraftedCandidate,
  type Proposal,
  type ReadinessContext,
} from "../src/lib/inbox.js";
import { loadPlanFromYaml, type MergedResolver, type Plan } from "../src/lib/plan.js";

/**
 * test/legacy-board-review-proposals-can-retire.test.ts — W1-T2460.
 *
 * THE FALSIFIER THIS FILE PROVES: every board-review proposal minted BEFORE W1-T2451 (#3255)
 * added {@link Proposal.originatingItemId} carries no such field. `resolveBoardReferent`
 * (src/lib/inbox.ts) opened with `if (!proposal.originatingItemId) return { kind: "live" };` —
 * PRE-FIX, that line alone classified every legacy row `live` by construction, without the
 * batched {@link BoardReferentRead} ever being consulted, so a legacy proposal naming an
 * ALREADY-MERGED PR (e.g. `board-review:escalation:#3059`, PR #3059, merged 2026-08-27) could
 * never reach `retired`. Every test below runs against the CURRENT `classifyProposal` — the
 * first one (RESOLVED) is the one that would have FAILED before this task's parse-at-read fix
 * landed, because pre-fix the identical proposal/draft/ctx triple classifies "not_ready" (or
 * "ready"), never "retired".
 */

// ── Fixtures (mirrors test/board-review-proposal-lifecycle.test.ts's own shapes) ───────────────

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

function draftFor(proposalId: string, fragmentYaml: string): DraftedCandidate {
  return {
    proposalId,
    fragmentYaml,
    stampLine: `- ${proposalId} (plan) — RATIFIED 2026-08-29 -> W1-T900.`,
    anchorFingerprint: anchorFingerprint([]),
  };
}

/** A LEGACY board-review-shaped proposal — exactly as board-review.ts minted one BEFORE
 *  W1-T2451/#3255 added `originatingItemId`: evidenceAnchors permanently [], and NO referent
 *  field at all, only the id string. */
function legacyProposal(overrides: Partial<Proposal> & { id: string }): Proposal {
  return {
    summary: `board-review: ${overrides.id} carries an unhandled escalation`,
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

// ── Acceptance 1: a legacy proposal whose referent has already resolved retires ────────────────

test("a legacy board-review proposal (no originatingItemId) whose referent PR has already merged retires instead of rendering live forever", () => {
  const proposal = legacyProposal({ id: "board-review:escalation:#3059" });
  const draft = draftFor(proposal.id, CLEAN_FRAGMENT);
  const ctx = baseCtx({ boardReferents: referentRead({ "#3059": { status: "merged", unhandledEscalations: 0 } }) });

  const classification = classifyProposal(proposal, draft, ctx);

  assert.equal(classification.state, "retired");
  assert.equal(classification.reasons.length, 0);
  assert.match(classification.retiredReason ?? "", /#3059/);
  assert.match(classification.retiredReason ?? "", /resolved/);
});

test("a legacy board-review 'stale' proposal whose referent PR has died also retires", () => {
  const proposal = legacyProposal({ id: "board-review:stale:#4001" });
  const draft = draftFor(proposal.id, CLEAN_FRAGMENT);
  const ctx = baseCtx({ boardReferents: referentRead({ "#4001": { status: "dead", unhandledEscalations: 0 } }) });

  assert.equal(classifyProposal(proposal, draft, ctx).state, "retired");
});

// ── Acceptance 2: an open referent never retires; unhandled escalations block escalation-kind ──

test("a legacy board-review proposal whose referent PR is still open does not retire", () => {
  const proposal = legacyProposal({ id: "board-review:stale:#3060" });
  const draft = draftFor(proposal.id, CLEAN_FRAGMENT);
  const ctx = baseCtx({ boardReferents: referentRead({ "#3060": { status: "open", unhandledEscalations: 0 } }) });

  assert.notEqual(classifyProposal(proposal, draft, ctx).state, "retired");
});

test("a legacy escalation-kind proposal with unhandled escalations on an open referent does not retire", () => {
  const proposal = legacyProposal({ id: "board-review:escalation:#3061" });
  const draft = draftFor(proposal.id, CLEAN_FRAGMENT);
  const ctx = baseCtx({ boardReferents: referentRead({ "#3061": { status: "open", unhandledEscalations: 2 } }) });

  const classification = classifyProposal(proposal, draft, ctx);
  assert.notEqual(classification.state, "retired");
  assert.equal(classification.state, "ready");
});

test("a legacy stale-kind proposal does NOT retire just because escalations read zero on an open referent", () => {
  const proposal = legacyProposal({ id: "board-review:stale:#3062" });
  const draft = draftFor(proposal.id, CLEAN_FRAGMENT);
  const ctx = baseCtx({ boardReferents: referentRead({ "#3062": { status: "open", unhandledEscalations: 0 } }) });

  assert.equal(classifyProposal(proposal, draft, ctx).state, "ready");
});

// ── Acceptance 3: an id the referent cannot be derived from is treated exactly as today ─────────

test("a proposal whose id is not a board-review stale/escalation shape is unaffected by the parse-at-read fallback — classifies exactly as before (live, no referent tracking)", () => {
  const handAuthored: Proposal = { id: "P25", summary: "a hand-authored proposal", evidenceAnchors: [] };
  const draft = draftFor(handAuthored.id, CLEAN_FRAGMENT);
  // Even with a batched read present, nothing in it should ever be consulted for this id: no
  // referent can be derived from "P25", so it must never be looked up, let alone retire it.
  const ctx = baseCtx({ boardReferents: referentRead({ P25: { status: "merged", unhandledEscalations: 0 } }) });

  const classification = classifyProposal(handAuthored, draft, ctx);

  assert.notEqual(classification.state, "retired");
  assert.equal(classification.state, "ready");
  assert.equal(classification.referentUnverified, undefined, "a proposal with no derivable referent is never marked unverified either");
});

test("a malformed board-review-prefixed id that does not match either minted shape is left exactly as it is treated today", () => {
  // Not `board-review:stale:` or `board-review:escalation:` — an id shape board-review.ts never
  // actually mints. The fallback must not guess a referent from it.
  const proposal = legacyProposal({ id: "board-review:unknown-kind:#9999" });
  const draft = draftFor(proposal.id, CLEAN_FRAGMENT);
  const ctx = baseCtx({ boardReferents: referentRead({ "#9999": { status: "merged", unhandledEscalations: 0 } }) });

  const classification = classifyProposal(proposal, draft, ctx);
  assert.notEqual(classification.state, "retired");
  assert.equal(classification.state, "ready");
});

// ── Acceptance 4: a proposal that already carries originatingItemId is unaffected ───────────────

test("a post-#3255 proposal that already carries originatingItemId keeps retiring exactly as before — the legacy fallback never overrides an explicit field", () => {
  const proposal = legacyProposal({ id: "board-review:escalation:#3059", originatingItemId: "#3059" });
  const draft = draftFor(proposal.id, CLEAN_FRAGMENT);
  const ctx = baseCtx({ boardReferents: referentRead({ "#3059": { status: "merged", unhandledEscalations: 0 } }) });

  assert.equal(classifyProposal(proposal, draft, ctx).state, "retired");
});

test("a post-#3255 proposal whose explicit originatingItemId differs from its own id's trailing segment is resolved by the FIELD, never by the id string", () => {
  // Constructed to prove the fallback is truly a fallback: if the id's own trailing segment
  // ("#3059") were ever consulted instead of the explicit field ("#7777"), this would retire
  // against the wrong referent's (merged) state instead of staying live against #7777's (open).
  const proposal = legacyProposal({ id: "board-review:escalation:#3059", originatingItemId: "#7777" });
  const draft = draftFor(proposal.id, CLEAN_FRAGMENT);
  const ctx = baseCtx({
    boardReferents: referentRead({
      "#3059": { status: "merged", unhandledEscalations: 0 },
      "#7777": { status: "open", unhandledEscalations: 1 },
    }),
  });

  const classification = classifyProposal(proposal, draft, ctx);
  assert.notEqual(classification.state, "retired");
  assert.equal(classification.state, "ready");
});
