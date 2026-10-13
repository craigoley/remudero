import assert from "node:assert/strict";
import { test } from "node:test";
import {
  anchorFingerprint,
  classifyProposal,
  draftAttemptKey,
  draftsDueOnDaemon,
  inboxDraftExampleFragmentYaml,
  lintDraftedFragment,
  resolvedInboxDraftLane,
  type DraftAttemptCache,
  type DraftCache,
  type Proposal,
} from "../src/lib/inbox.js";
import { fixedClock } from "../src/lib/clock.js";
import { loadPlanFromYaml } from "../src/lib/plan.js";

const proposal: Proposal = { id: "P1", summary: "needs a draft", evidenceAnchors: [] };
const nanoLane = { leadDeployment: "gpt-5-nano", effort: "high", escalationDeployment: "sonnet", escalationEffort: "medium" };
const ossLane = { ...nanoLane, leadDeployment: "gpt-oss-120b" };

test("W1-T4947: a lead change makes a proposal with no clean draft due again", () => {
  const configuredLane = resolvedInboxDraftLane();
  assert.equal(draftAttemptKey(proposal), draftAttemptKey(proposal, configuredLane), "the default reads the installed drafting mount");
  const attempts: DraftAttemptCache = { P1: draftAttemptKey(proposal, nanoLane) };
  assert.deepEqual(draftsDueOnDaemon([proposal], {}, attempts, 3, undefined, nanoLane), []);
  assert.deepEqual(draftsDueOnDaemon([proposal], {}, attempts, 3, undefined, ossLane), [proposal]);
  assert.deepEqual(draftsDueOnDaemon([proposal], {}, { P1: "::0" }, 3, undefined, ossLane), [proposal], "stored keys from before the lane suffix reopen once");

  attempts.P1 = draftAttemptKey(proposal, ossLane);
  assert.deepEqual(draftsDueOnDaemon([proposal], {}, attempts, 3, undefined, ossLane), [], "the new lead gets one attempt");
  assert.deepEqual(
    draftsDueOnDaemon([proposal], {}, attempts, 3, undefined, { ...ossLane, effort: "medium" }),
    [proposal],
    "an effort change also gives the proposal a new attempt",
  );
  assert.deepEqual(
    draftsDueOnDaemon([proposal], {}, attempts, 3, undefined, { ...ossLane, escalationDeployment: "opus" }),
    [proposal],
    "a changed escalation target is part of the drafting lane",
  );
});

test("W1-T4947: a proposal with a clean cached draft is not redrafted on a lead change", () => {
  const fragmentYaml = inboxDraftExampleFragmentYaml();
  const stampLine = "- P1 (plan) — RATIFIED 2026-10-01 -> NEW-1.";
  assert.deepEqual(lintDraftedFragment(fragmentYaml, proposal.id, stampLine, new Set(["remudero"])), []);
  const drafts: DraftCache = {
    P1: { proposalId: "P1", fragmentYaml, stampLine, anchorFingerprint: anchorFingerprint(proposal.evidenceAnchors) },
  };
  const attempts: DraftAttemptCache = { P1: draftAttemptKey(proposal, nanoLane) };
  assert.deepEqual(draftsDueOnDaemon([proposal], drafts, attempts, 3, undefined, ossLane), []);
});

test("a cached draft with only a model stamp defect heals without a lead-change retry", () => {
  const fragmentYaml = inboxDraftExampleFragmentYaml();
  const stampLine = "ratified P1 2023-10-10T00:00:00Z -> NEW-99";
  const drafts: DraftCache = {
    P1: { proposalId: "P1", fragmentYaml, stampLine, anchorFingerprint: anchorFingerprint([]) },
  };
  const result = classifyProposal(proposal, drafts.P1, {
    plan: loadPlanFromYaml("[]", "fixture"), isMerged: () => true,
    grepAnchorTrue: () => true, openProposalIds: new Set(), isRatified: () => false,
    clock: fixedClock(Date.parse("2026-10-13T00:30:00Z")),
  });
  assert.equal(result.state, "ready", JSON.stringify(result.reasons));
  assert.equal(result.draft?.stampLine, "- P1 (proposal) — RATIFIED 2026-10-13 -> NEW-1.");
  assert.deepEqual(draftsDueOnDaemon([proposal], drafts, {}, 3, undefined, ossLane), []);
  assert.equal(drafts.P1.stampLine, stampLine);
});
