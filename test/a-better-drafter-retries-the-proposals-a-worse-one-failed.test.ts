import assert from "node:assert/strict";
import { test } from "node:test";
import {
  anchorFingerprint,
  draftAttemptKey,
  draftsDueOnDaemon,
  inboxDraftExampleFragmentYaml,
  lintDraftedFragment,
  resolvedInboxDraftLane,
  type DraftAttemptCache,
  type DraftCache,
  type Proposal,
} from "../src/lib/inbox.js";

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
