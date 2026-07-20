import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  applyFragmentToPlanYaml,
  applyStampToMasterPlan,
  approveCommitMessage,
  approveProposal,
  inboxDraftPrompt,
  invalidateDraft,
  ratifyTelemetry,
  refusalReason,
  reframeProposal,
  renderRatifyTelemetry,
  type DraftCache,
  type DraftedCandidate,
  type InboxClassification,
  type Proposal,
  type RatifyGateway,
} from "../src/lib/inbox.js";

// ── Fixtures ─────────────────────────────────────────────────────────────────

function ledgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), "rmd-inbox-approve-")), "ledger.ndjson");
}

function readLedger(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

const CACHED_DRAFT: DraftedCandidate = {
  proposalId: "P-READY",
  fragmentYaml: "- id: W1-T900\n  title: candidate task\n  repo: remudero\n",
  stampLine: "- P-READY (plan) — RATIFIED 2026-07-20 -> W1-T900.",
  anchorFingerprint: "landed::MASTER-PLAN.md",
};

function readyClassification(): InboxClassification {
  return { proposalId: "P-READY", state: "ready", reasons: [], draft: CACHED_DRAFT, draftStale: false };
}

function depUnmetClassification(): InboxClassification {
  return {
    proposalId: "P-DEP-UNMET",
    state: "not_ready",
    reasons: [{ predicate: "deps_merged", detail: "dep-unmet: W1-T2 not merged" }],
    draftStale: false,
  };
}

function deferredClassification(): InboxClassification {
  return {
    proposalId: "P-DEFER",
    state: "deferred_with_trigger",
    reasons: [],
    trigger: { description: "ratify after the unbuilt consumer ships", fired: false },
  };
}

function fakeGateway(prUrl = "https://github.com/craigoley/remudero/pull/500"): RatifyGateway & {
  branchCalls: Array<{ proposalId: string; fragmentYaml: string; stampLine: string }>;
  prCalls: Array<{ branch: string; proposalId: string }>;
} {
  const branchCalls: Array<{ proposalId: string; fragmentYaml: string; stampLine: string }> = [];
  const prCalls: Array<{ branch: string; proposalId: string }> = [];
  return {
    branchCalls,
    prCalls,
    createRatificationBranch(payload) {
      branchCalls.push(payload);
      return `run-APPROVE-${payload.proposalId}`;
    },
    openPlanPr(branch, proposalId) {
      prCalls.push({ branch, proposalId });
      return prUrl;
    },
  };
}

// ── Acceptance #1: approve — one PR payload on READY, zero on refusal ──────────────────────

test("approveProposal: a READY classification produces exactly ONE branch call and ONE PR call, payload deepEquals the cached draft + stamp, plus a ledger line", () => {
  const gateway = fakeGateway();
  const path = ledgerPath();
  const result = approveProposal(readyClassification(), gateway, { ledgerPath: path, runId: "RUN-1" });

  assert.equal(gateway.branchCalls.length, 1);
  assert.equal(gateway.prCalls.length, 1);
  assert.deepEqual(gateway.branchCalls[0], {
    proposalId: "P-READY",
    fragmentYaml: CACHED_DRAFT.fragmentYaml,
    stampLine: CACHED_DRAFT.stampLine,
  });
  assert.equal(gateway.prCalls[0].branch, "run-APPROVE-P-READY");
  assert.equal(gateway.prCalls[0].proposalId, "P-READY");

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.prUrl, "https://github.com/craigoley/remudero/pull/500");
    assert.deepEqual(result.payload, {
      proposalId: "P-READY",
      fragmentYaml: CACHED_DRAFT.fragmentYaml,
      stampLine: CACHED_DRAFT.stampLine,
    });
  }

  const lines = readLedger(path);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].step, "ratify.approved");
  assert.equal(lines[0].task_id, "P-READY");
  assert.equal(lines[0].pr_url, "https://github.com/craigoley/remudero/pull/500");
});

test("approveProposal: a NOT-READY (dep-unmet) classification refuses, naming the state — ZERO gateway calls", () => {
  const gateway = fakeGateway();
  const path = ledgerPath();
  const result = approveProposal(depUnmetClassification(), gateway, { ledgerPath: path, runId: "RUN-1" });

  assert.equal(gateway.branchCalls.length, 0);
  assert.equal(gateway.prCalls.length, 0);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.state, "not_ready");
    assert.match(result.refusal, /NOT READY/);
    assert.match(result.refusal, /dep-unmet: W1-T2 not merged/);
  }

  const lines = readLedger(path);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].step, "ratify.approve_refused");
  assert.equal(lines[0].state, "not_ready");
});

test("approveProposal: a DEFERRED-WITH-TRIGGER classification refuses naming the unfired trigger — never approvable", () => {
  const gateway = fakeGateway();
  const result = approveProposal(deferredClassification(), gateway, { ledgerPath: ledgerPath(), runId: "RUN-1" });
  assert.equal(gateway.branchCalls.length, 0);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.refusal, /DEFERRED-WITH-TRIGGER/);
    assert.match(result.refusal, /ratify after the unbuilt consumer ships/);
  }
});

test("refusalReason names every failing predicate for a not_ready classification with multiple reasons", () => {
  const c: InboxClassification = {
    proposalId: "P-MULTI",
    state: "not_ready",
    reasons: [
      { predicate: "deps_merged", detail: "dep-unmet: W1-T2 not merged" },
      { predicate: "lint_clean", detail: "draft-unclean: violation X" },
    ],
  };
  const reason = refusalReason(c);
  assert.match(reason, /dep-unmet: W1-T2 not merged/);
  assert.match(reason, /draft-unclean: violation X/);
});

test("approveCommitMessage carries the stamp verbatim and a Remudero-Task trailer naming the proposal", () => {
  const msg = approveCommitMessage({ proposalId: "P25", fragmentYaml: "- id: W1-T900\n", stampLine: CACHED_DRAFT.stampLine });
  assert.match(msg, /rmd approve/);
  assert.ok(msg.includes(CACHED_DRAFT.stampLine));
  assert.match(msg, /Remudero-Task: P25/);
});

// ── Acceptance #2: reframe — feedback ledgers verbatim, invalidates the draft, rides the redraft ──

test("reframeProposal: ledgers ratify.reframed with the feedback verbatim, invalidates the draft, appends to reframeHistory — never opens a PR", () => {
  const proposal: Proposal = { id: "P25", summary: "the ratification inbox", evidenceAnchors: [] };
  const drafts: DraftCache = { P25: CACHED_DRAFT };
  const path = ledgerPath();

  const result = reframeProposal(proposal, "the drafted tasks miss the escalation transport — redo with W1-T8 wired in", drafts, {
    ledgerPath: path,
    runId: "RUN-1",
  });

  assert.deepEqual(result.proposal.reframeHistory, [
    { feedback: "the drafted tasks miss the escalation transport — redo with W1-T8 wired in" },
  ]);
  assert.equal(result.drafts.P25, undefined, "the cached draft for P25 is invalidated");

  const lines = readLedger(path);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].step, "ratify.reframed");
  assert.equal(lines[0].task_id, "P25");
  assert.equal(lines[0].feedback, "the drafted tasks miss the escalation transport — redo with W1-T8 wired in");
});

test("reframeProposal accumulates a SECOND round onto an existing reframe history, oldest first", () => {
  const proposal: Proposal = {
    id: "P25",
    summary: "s",
    evidenceAnchors: [],
    reframeHistory: [{ feedback: "first objection" }],
  };
  const result = reframeProposal(proposal, "second objection", {}, { ledgerPath: ledgerPath(), runId: "RUN-1" });
  assert.deepEqual(result.proposal.reframeHistory, [{ feedback: "first objection" }, { feedback: "second objection" }]);
});

test("invalidateDraft drops only the named proposal's cached draft, leaving others untouched; a no-op when nothing is cached", () => {
  const drafts: DraftCache = { P1: CACHED_DRAFT, P2: { ...CACHED_DRAFT, proposalId: "P2" } };
  const next = invalidateDraft(drafts, "P1");
  assert.equal(next.P1, undefined);
  assert.deepEqual(next.P2, drafts.P2);
  assert.deepEqual(invalidateDraft({}, "P-NONE"), {});
});

test("inboxDraftPrompt: a proposal with NO reframe history renders no operator-feedback section", () => {
  const proposal: Proposal = { id: "P1", summary: "s", evidenceAnchors: [] };
  const prompt = inboxDraftPrompt(proposal, "- id: W1-T1\n", "run-1");
  assert.doesNotMatch(prompt, /OPERATOR FEEDBACK/);
});

test("inboxDraftPrompt: the NEXT draft-rung invocation's rendered prompt carries the reframe feedback verbatim, every round in order", () => {
  const proposal: Proposal = {
    id: "P25",
    summary: "the ratification inbox",
    evidenceAnchors: [],
    reframeHistory: [{ feedback: "first: missing the escalation transport" }, { feedback: "second: also wire the retro telemetry" }],
  };
  const prompt = inboxDraftPrompt(proposal, "- id: W1-T1\n", "run-2");
  assert.match(prompt, /OPERATOR FEEDBACK/);
  assert.match(prompt, /1\. first: missing the escalation transport/);
  assert.match(prompt, /2\. second: also wire the retro telemetry/);
});

// ── Acceptance #3: approval-rate telemetry lands in the retro ──────────────────────────────

test("ratifyTelemetry: 3 approvals + 1 reframe yields a 75% approval rate with both counts", () => {
  const records = [
    { step: "ratify.approved" },
    { step: "ratify.approved" },
    { step: "ratify.approved" },
    { step: "ratify.reframed" },
    { step: "run.start" }, // unrelated ledger noise is ignored
  ];
  const t = ratifyTelemetry(records);
  assert.equal(t.approved, 3);
  assert.equal(t.reframed, 1);
  assert.equal(t.rate, 0.75);

  const rendered = renderRatifyTelemetry(t);
  assert.match(rendered, /Approved: 3/);
  assert.match(rendered, /Reframed: 1/);
  assert.match(rendered, /75%/);
});

test("ratifyTelemetry: no ratify activity yet is a named zero, not a bare 0%", () => {
  const t = ratifyTelemetry([]);
  assert.equal(t.approved, 0);
  assert.equal(t.reframed, 0);
  assert.equal(t.rate, 0);
  assert.match(renderRatifyTelemetry(t), /no ratify activity yet/);
});

// ── Real-world ratification writers (plain string composition) ─────────────────────────────

test("applyFragmentToPlanYaml appends the fragment to the end of the existing tasks.yaml text", () => {
  const base = "- id: W1-T1\n  title: existing\n";
  const out = applyFragmentToPlanYaml(base, "- id: W1-T900\n  title: new\n");
  assert.ok(out.startsWith(base.trimEnd()));
  assert.match(out, /- id: W1-T900\n  title: new/);
});

test("applyStampToMasterPlan replaces an existing proposal bullet in place", () => {
  const md = "# MASTER-PLAN\n\n- P25 (plan -> §7) — CAPTURED 2026-07-01.\n- P26 (plan) — CAPTURED 2026-07-02.\n";
  const out = applyStampToMasterPlan(md, "P25", "- P25 (plan -> §7) — RATIFIED 2026-07-20 -> W1-T900.");
  assert.match(out, /- P25 \(plan -> §7\) — RATIFIED 2026-07-20 -> W1-T900\./);
  assert.doesNotMatch(out, /CAPTURED 2026-07-01/);
  assert.match(out, /- P26 \(plan\) — CAPTURED 2026-07-02\./, "the unrelated P26 bullet is untouched");
});

test("applyStampToMasterPlan appends the stamp when no existing bullet matches the proposal id", () => {
  const md = "# MASTER-PLAN\n\n- P26 (plan) — CAPTURED 2026-07-02.\n";
  const out = applyStampToMasterPlan(md, "P25", "- P25 (plan) — RATIFIED 2026-07-20 -> W1-T900.");
  assert.match(out, /- P26 \(plan\) — CAPTURED 2026-07-02\./);
  assert.match(out, /- P25 \(plan\) — RATIFIED 2026-07-20 -> W1-T900\.\s*$/);
});
