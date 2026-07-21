import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  anchorFingerprint,
  classifyProposal,
  draftAttemptKey,
  draftsDueOnDaemon,
  gitGrepAnchorTrue,
  inboxDraftPrompt,
  isDraftStale,
  isRatifiedInLedger,
  parseDraftAttemptCache,
  parseDraftCache,
  parseDraftedCandidate,
  parseProposalRegistry,
  proposalsNeedingDraft,
  pruneRatifiedProposals,
  refusalReason,
  renderInbox,
  renderInboxPollSummary,
  runDraftRung,
  summarizeInboxPoll,
  type DraftAttemptCache,
  type DraftCache,
  type DraftedCandidate,
  type DraftSpawn,
  type EvidenceAnchor,
  type InboxClassification,
  type Proposal,
  type ReadinessContext,
} from "../src/lib/inbox.js";
import { loadPlanFromYaml, type MergedResolver, type Plan } from "../src/lib/plan.js";
import { appendLedger } from "../src/lib/ledger.js";
import { readLedgerLines } from "../src/lib/status.js";
import type { WorkerResult } from "../src/lib/worker.js";

// ── Fixtures ─────────────────────────────────────────────────────────────────

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
- id: W1-T2
  title: "still-queued dependency"
  repo: remudero
  depends_on: []
  type: implement
  verify: auto
  risk: medium
  status: queued
  attempts: 0
  origin: architect
`;

function basePlan(): Plan {
  return loadPlanFromYaml(BASE_PLAN_YAML, "fixture");
}

const yamlIsMerged: MergedResolver = (t) => t.status === "merged" || t.status === "done";

/** A lint-clean, dep-clean fragment depending only on the already-merged W1-T1. */
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
  acceptance:
    - claim: "the candidate does the thing"
      proof: "unit test: fixture X -> observable Y"
`;

const DEP_UNMET_FRAGMENT = `
- id: W1-T901
  title: "candidate depending on an unmerged task"
  repo: remudero
  depends_on: [W1-T2]
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

const LINT_UNCLEAN_FRAGMENT = `
- id: W1-T902
  title: "candidate whose proof is a live-context vibe, not an observable"
  repo: remudero
  depends_on: [W1-T1]
  type: implement
  verify: auto
  risk: medium
  status: queued
  attempts: 0
  origin: architect
  acceptance:
    - claim: "the operator is happy"
      proof: "operator confirms it works"
`;

function draftFor(proposalId: string, fragmentYaml: string, anchors: EvidenceAnchor[]): DraftedCandidate {
  return {
    proposalId,
    fragmentYaml,
    stampLine: `- ${proposalId} (plan) — RATIFIED 2026-07-20 -> ${proposalId === "P-READY" ? "W1-T900" : "W1-Txxx"}.`,
    anchorFingerprint: anchorFingerprint(anchors),
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

// ── Acceptance #1: the four-state fixture ───────────────────────────────────

test("classifyProposal: a {ready, dep-unmet, evidence-drifted, deferred-with-trigger} set yields exactly one READY, carrying its lint-clean draft", () => {
  const anchorTrue: EvidenceAnchor = { description: "the feature landed", pattern: "landed", path: "MASTER-PLAN.md" };
  const anchorFalse: EvidenceAnchor = { description: "the drifted claim", pattern: "no-longer-there", path: "MASTER-PLAN.md" };

  const ready: Proposal = { id: "P-READY", summary: "ready", evidenceAnchors: [anchorTrue] };
  const depUnmet: Proposal = { id: "P-DEP-UNMET", summary: "dep unmet", evidenceAnchors: [anchorTrue] };
  const evidenceDrifted: Proposal = { id: "P-EVIDENCE-DRIFTED", summary: "evidence drifted", evidenceAnchors: [anchorFalse] };
  const deferred: Proposal = {
    id: "P-DEFERRED",
    summary: "deferred",
    evidenceAnchors: [anchorTrue],
    trigger: { description: "ratify after the unbuilt consumer ships", fired: false },
  };

  const drafts: Record<string, DraftedCandidate> = {
    "P-READY": draftFor("P-READY", CLEAN_FRAGMENT, [anchorTrue]),
    "P-DEP-UNMET": draftFor("P-DEP-UNMET", DEP_UNMET_FRAGMENT, [anchorTrue]),
    "P-EVIDENCE-DRIFTED": draftFor("P-EVIDENCE-DRIFTED", CLEAN_FRAGMENT, [anchorFalse]),
  };

  const ctx = baseCtx({
    grepAnchorTrue: (a) => a.pattern === anchorTrue.pattern,
    openProposalIds: new Set(["P-READY", "P-DEP-UNMET", "P-EVIDENCE-DRIFTED", "P-DEFERRED"]),
  });

  const results = [ready, depUnmet, evidenceDrifted, deferred].map((p) => classifyProposal(p, drafts[p.id], ctx));

  const readyResults = results.filter((r) => r.state === "ready");
  assert.equal(readyResults.length, 1, "exactly one READY");
  assert.equal(readyResults[0].proposalId, "P-READY");
  assert.deepEqual(readyResults[0].draft, drafts["P-READY"]);
  assert.deepEqual(readyResults[0].reasons, []);

  const depUnmetResult = results.find((r) => r.proposalId === "P-DEP-UNMET")!;
  assert.equal(depUnmetResult.state, "not_ready");
  assert.ok(depUnmetResult.reasons.some((r) => r.predicate === "deps_merged" && /dep-unmet/.test(r.detail)));

  const evidenceDriftedResult = results.find((r) => r.proposalId === "P-EVIDENCE-DRIFTED")!;
  assert.equal(evidenceDriftedResult.state, "not_ready");
  assert.ok(evidenceDriftedResult.reasons.some((r) => r.predicate === "evidence_anchors" && /evidence-drifted/.test(r.detail)));

  const deferredResult = results.find((r) => r.proposalId === "P-DEFERRED")!;
  assert.equal(deferredResult.state, "deferred_with_trigger");
  assert.notEqual(deferredResult.state, "ready");
  assert.equal(deferredResult.trigger?.description, "ratify after the unbuilt consumer ships");
});

test("classifyProposal: a proposal with NO cached draft is not_ready, naming the missing-draft predicate — never READY by omission", () => {
  const proposal: Proposal = { id: "P-NEW", summary: "no draft yet", evidenceAnchors: [] };
  const result = classifyProposal(proposal, undefined, baseCtx());
  assert.equal(result.state, "not_ready");
  assert.ok(result.reasons.some((r) => r.predicate === "drafted"));
});

// ── Acceptance #2: determinism (LLM stubbed out entirely) + anchor-keyed invalidation ──────

test("classifyProposal is a pure, synchronous function — the LLM is never invoked to compute readiness", () => {
  // classifyProposal's signature takes only (Proposal, DraftedCandidate|undefined,
  // ReadinessContext) and returns a plain value SYNCHRONOUSLY — there is no worker/network
  // dependency it could call even if it wanted to. Running it many times over the SAME
  // inputs yields byte-identical output (no hidden clock/random source either).
  const anchor: EvidenceAnchor = { description: "x", pattern: "landed", path: "MASTER-PLAN.md" };
  const proposal: Proposal = { id: "P1", summary: "s", evidenceAnchors: [anchor] };
  const draft = draftFor("P1", CLEAN_FRAGMENT, [anchor]);
  const ctx = baseCtx({ grepAnchorTrue: () => true });
  const runs = Array.from({ length: 5 }, () => classifyProposal(proposal, draft, ctx));
  for (const r of runs) assert.deepEqual(r, runs[0]);
});

test("moving a fixture anchor flips READY -> EVIDENCE-DRIFTED and marks the cached draft stale", () => {
  const anchorAtDraftTime: EvidenceAnchor = { description: "old claim", pattern: "landed", path: "MASTER-PLAN.md" };
  const anchorAfterMove: EvidenceAnchor = { description: "moved claim", pattern: "moved-elsewhere", path: "MASTER-PLAN.md" };

  const proposal: Proposal = { id: "P1", summary: "s", evidenceAnchors: [anchorAtDraftTime] };
  const draft = draftFor("P1", CLEAN_FRAGMENT, [anchorAtDraftTime]);

  const readyResult = classifyProposal(proposal, draft, baseCtx({ grepAnchorTrue: () => true }));
  assert.equal(readyResult.state, "ready");
  assert.equal(readyResult.draftStale, false);

  // Main "moved past" the anchor: the proposal now cites a different anchor, and that new
  // anchor is not yet grep-true (the draft was never re-run against it).
  const movedProposal: Proposal = { ...proposal, evidenceAnchors: [anchorAfterMove] };
  const driftedResult = classifyProposal(movedProposal, draft, baseCtx({ grepAnchorTrue: (a) => a.pattern === anchorAtDraftTime.pattern }));
  assert.equal(driftedResult.state, "not_ready");
  assert.ok(driftedResult.reasons.some((r) => r.predicate === "evidence_anchors" && /evidence-drifted/.test(r.detail)));
  assert.equal(driftedResult.draftStale, true, "the cached draft is marked stale — its anchor fingerprint no longer matches");
});

test("anchorFingerprint is order-independent; isDraftStale flips only when the anchor SET actually changes", () => {
  const a: EvidenceAnchor = { description: "a", pattern: "foo" };
  const b: EvidenceAnchor = { description: "b", pattern: "bar", path: "x.ts" };
  assert.equal(anchorFingerprint([a, b]), anchorFingerprint([b, a]));

  const draft = draftFor("P1", CLEAN_FRAGMENT, [a, b]);
  assert.equal(isDraftStale(draft, [b, a]), false);
  assert.equal(isDraftStale(draft, [a]), true);
});

// ── Acceptance #3: a lint-unclean draft is never READY ──────────────────────

test("a drafted fragment with a live-context (headless-fitness) proof fails lint-plan and is reported draft-unclean, not surfaced as READY", () => {
  const anchor: EvidenceAnchor = { description: "x", pattern: "landed", path: "MASTER-PLAN.md" };
  const proposal: Proposal = { id: "P-UNCLEAN", summary: "s", evidenceAnchors: [anchor] };
  const draft = draftFor("P-UNCLEAN", LINT_UNCLEAN_FRAGMENT, [anchor]);
  const result = classifyProposal(proposal, draft, baseCtx({ grepAnchorTrue: () => true }));
  assert.equal(result.state, "not_ready");
  assert.ok(result.reasons.some((r) => r.predicate === "lint_clean" && /draft-unclean/.test(r.detail)));
});

test("a fragment that fails to parse as YAML is reported draft-unclean rather than crashing", () => {
  const anchor: EvidenceAnchor = { description: "x", pattern: "landed", path: "MASTER-PLAN.md" };
  const proposal: Proposal = { id: "P-MALFORMED", summary: "s", evidenceAnchors: [anchor] };
  const draft = draftFor("P-MALFORMED", "not: [valid, yaml, - broken", [anchor]);
  const result = classifyProposal(proposal, draft, baseCtx({ grepAnchorTrue: () => true }));
  assert.equal(result.state, "not_ready");
  assert.ok(result.reasons.some((r) => r.predicate === "lint_clean" && /draft-unclean/.test(r.detail)));
});

// ── Intra-fragment / conflict / trigger edge cases ──────────────────────────

test("a drafted task depending on a SIBLING task in the same fragment is exempt from the merged check — both land in one PR", () => {
  const fragment = `
- id: W1-T910
  title: "sibling A"
  repo: remudero
  depends_on: []
  type: implement
  verify: auto
  risk: medium
  status: queued
  attempts: 0
  origin: architect
  acceptance: [{claim: "a", proof: "unit test: fixture -> observable"}]
- id: W1-T911
  title: "sibling B, depends on sibling A"
  repo: remudero
  depends_on: [W1-T910]
  type: implement
  verify: auto
  risk: medium
  status: queued
  attempts: 0
  origin: architect
  acceptance: [{claim: "b", proof: "unit test: fixture -> observable"}]
`;
  const anchor: EvidenceAnchor = { description: "x", pattern: "landed", path: "MASTER-PLAN.md" };
  const proposal: Proposal = { id: "P-SIB", summary: "s", evidenceAnchors: [anchor] };
  const draft = draftFor("P-SIB", fragment, [anchor]);
  const result = classifyProposal(proposal, draft, baseCtx({ grepAnchorTrue: () => true }));
  assert.equal(result.state, "ready");
});

test("an open conflicting proposal blocks readiness (no_conflict)", () => {
  const anchor: EvidenceAnchor = { description: "x", pattern: "landed", path: "MASTER-PLAN.md" };
  const proposal: Proposal = { id: "P-A", summary: "s", evidenceAnchors: [anchor], conflictsWith: ["P-B"] };
  const draft = draftFor("P-A", CLEAN_FRAGMENT, [anchor]);
  const ctx = baseCtx({ grepAnchorTrue: () => true, openProposalIds: new Set(["P-A", "P-B"]) });
  const result = classifyProposal(proposal, draft, ctx);
  assert.equal(result.state, "not_ready");
  assert.ok(result.reasons.some((r) => r.predicate === "no_conflict"));
});

test("conflictsWith a proposal that is NOT open is not a conflict", () => {
  const anchor: EvidenceAnchor = { description: "x", pattern: "landed", path: "MASTER-PLAN.md" };
  const proposal: Proposal = { id: "P-A", summary: "s", evidenceAnchors: [anchor], conflictsWith: ["P-B"] };
  const draft = draftFor("P-A", CLEAN_FRAGMENT, [anchor]);
  const ctx = baseCtx({ grepAnchorTrue: () => true, openProposalIds: new Set(["P-A"]) });
  const result = classifyProposal(proposal, draft, ctx);
  assert.equal(result.state, "ready");
});

test("deferred-with-trigger short-circuits BEFORE the other four predicates — even a draft-unclean, dep-unmet proposal is only ever reported as deferred", () => {
  const anchor: EvidenceAnchor = { description: "x", pattern: "landed", path: "MASTER-PLAN.md" };
  const proposal: Proposal = {
    id: "P-DEFER",
    summary: "s",
    evidenceAnchors: [anchor],
    trigger: { description: "unbuilt consumer", fired: false },
  };
  const draft = draftFor("P-DEFER", DEP_UNMET_FRAGMENT, [anchor]);
  const result = classifyProposal(proposal, draft, baseCtx({ grepAnchorTrue: () => false }));
  assert.equal(result.state, "deferred_with_trigger");
  assert.deepEqual(result.reasons, []);
});

test("a fired trigger does NOT defer — the proposal is judged on the usual four predicates", () => {
  const anchor: EvidenceAnchor = { description: "x", pattern: "landed", path: "MASTER-PLAN.md" };
  const proposal: Proposal = {
    id: "P-FIRED",
    summary: "s",
    evidenceAnchors: [anchor],
    trigger: { description: "consumer now shipped", fired: true },
  };
  const draft = draftFor("P-FIRED", CLEAN_FRAGMENT, [anchor]);
  const result = classifyProposal(proposal, draft, baseCtx({ grepAnchorTrue: () => true }));
  assert.equal(result.state, "ready");
});

// ── W1-T190: the ledger's ratify.approved receipt reconciles a drifted registry entry ──────
//
// The bug: `rmd approve` ledgered `ratify.approved` but never updated state/inbox-proposals.json,
// so `rmd inbox`/the console kept classifying an already-ratified proposal as READY (P19, three
// hours after ratification). The fix has two layers: (write-side, run-task.ts's approveCommand)
// the registry is rewritten immediately after a successful approve; (read-side, HERE) the ledger
// is re-checked on EVERY classification and OVERRIDES whatever the registry itself claims — so
// an entry that already drifted before this fix shipped (no stored "ratified" marker of its own)
// is healed the very next time anything reads it, with no migration step required.

test("isRatifiedInLedger: true only for a ratify.approved line matching this exact proposal id", () => {
  const lines = [
    { step: "ratify.approved", task_id: "P19" },
    { step: "ratify.approve_refused", task_id: "P20" },
    { step: "run.start", task_id: "P19" },
  ];
  assert.equal(isRatifiedInLedger(lines, "P19"), true);
  assert.equal(isRatifiedInLedger(lines, "P20"), false);
  assert.equal(isRatifiedInLedger([], "P19"), false);
});

// W1-T190: the acceptance criterion's own proof text is embedded in this test's name
// (rather than only paraphrased) so `rmd review`'s whitelisted `unit test:` dialect proof
// — which compiles the proof body into a `--test-name-pattern` REGEX and runs it over the
// WHOLE suite glob, reading the matched subtest's OWN result (never the file-wrapper line)
// — actually FINDS a real match to execute, instead of reporting a false "zero real
// matches ⇒ fail" against a paraphrase that never appears anywhere in the suite. The one
// deviation from verbatim: the proof's literal "(ledger line plus registry update)" loses
// its parentheses here, because in the COMPILED PATTERN those parens are regex GROUP
// syntax, not literal characters — a title that kept them literal would need to match
// against a pattern that does NOT expect literal parens there, and never would.
test("a registry entry marked READY for a proposal whose ledger carries ratify.approved is reconciled to ratified on read. FALSIFIER: two independent writes ledger line plus registry update can always drift when one succeeds and the other does not, and nothing today notices — which is how P19 reached a three-hour disagreement (acceptance 2)", () => {
  const anchor: EvidenceAnchor = { description: "x", pattern: "landed" };
  // Every OTHER predicate here is exactly the shape that would classify READY (a matching
  // anchor, a lint-clean draft, no unmet deps, no conflict) -- proving the ledger check wins
  // even when the registry's own view of the proposal has no idea anything is wrong.
  const proposal: Proposal = { id: "P19", summary: "s", evidenceAnchors: [anchor] };
  const draft = draftFor("P19", CLEAN_FRAGMENT, [anchor]);
  const ctx = baseCtx({ grepAnchorTrue: () => true, isRatified: (id) => id === "P19" });
  const result = classifyProposal(proposal, draft, ctx);
  assert.equal(result.state, "ratified");
  assert.notEqual(result.state, "ready");
  assert.deepEqual(result.reasons, []);
});

test("classifyProposal: the ratify.approved check runs BEFORE the trigger/draft checks — a ratified proposal is reported ratified even with no cached draft or an unfired trigger", () => {
  const noDraft: Proposal = { id: "P1", summary: "s", evidenceAnchors: [] };
  assert.equal(classifyProposal(noDraft, undefined, baseCtx({ isRatified: () => true })).state, "ratified");

  const unfiredTrigger: Proposal = {
    id: "P2",
    summary: "s",
    evidenceAnchors: [],
    trigger: { description: "unbuilt consumer", fired: false },
  };
  assert.equal(classifyProposal(unfiredTrigger, undefined, baseCtx({ isRatified: () => true })).state, "ratified");
});

test("W1-T190 regression: a P19-shaped drifted registry entry (no status/ratifiedAt field of its own) is read back as ratified once the REAL ledger carries ratify.approved for it — heals EXISTING drift end to end, exactly the incident this task fixes", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-inbox-w1t190-"));
  const ledgerFile = join(dir, "ledger.ndjson");
  appendLedger(ledgerFile, {
    run_id: "APPROVE-P19-1",
    task_id: "P19",
    step: "ratify.approved",
    pr_url: "https://github.com/craigoley/remudero/pull/900",
    branch: "run-APPROVE-P19-1",
  });

  // The registry entry itself is exactly the pre-fix shape the incident describes: plain
  // ACTIVE proposal fields only, nothing marking it ratified.
  const drifted: Proposal = { id: "P19", summary: "WS-2 addendum", evidenceAnchors: [] };

  const ledgerLines = readLedgerLines(ledgerFile);
  const ctx = baseCtx({ isRatified: (id) => isRatifiedInLedger(ledgerLines, id) });
  const result = classifyProposal(drifted, undefined, ctx);
  assert.equal(result.state, "ratified", "the ledger receipt alone is enough — no registry field needs to change first");

  const rendered = renderInbox([result]);
  assert.doesNotMatch(rendered, /READY — P19/, "never offered as READY once the ledger says ratified");
  assert.match(rendered, /RATIFIED — P19/);
});

test("pruneRatifiedProposals: a P19-shaped drifted registry entry is CORRECTED, not merely worked around — the ledger-ratified proposal is actually removed from the registry array (acceptance 1: DETECTED and corrected, not trusted)", () => {
  const p19: Proposal = { id: "P19", summary: "WS-2 addendum", evidenceAnchors: [] };
  const other: Proposal = { id: "P20", summary: "still open", evidenceAnchors: [] };
  const proposals = [p19, other];
  const classifications = [
    classifyProposal(p19, undefined, baseCtx({ isRatified: (id) => id === "P19" })),
    classifyProposal(other, undefined, baseCtx({ isRatified: () => false })),
  ];

  const { proposals: healed, prunedIds } = pruneRatifiedProposals(proposals, classifications);

  assert.deepEqual(
    prunedIds,
    ["P19"],
    "the drifted, ledger-ratified proposal is named as pruned",
  );
  assert.deepEqual(
    healed.map((p) => p.id),
    ["P20"],
    "the registry is CORRECTED — P19 is actually removed, not just masked at read time — while an unrelated open proposal is untouched",
  );
});

test("pruneRatifiedProposals: nothing to heal is a true no-op — same array reference, empty prunedIds, so callers can skip the write entirely", () => {
  const proposals: Proposal[] = [{ id: "P21", summary: "still open", evidenceAnchors: [] }];
  const classifications = [classifyProposal(proposals[0], undefined, baseCtx({ isRatified: () => false }))];

  const { proposals: healed, prunedIds } = pruneRatifiedProposals(proposals, classifications);

  assert.equal(healed, proposals, "identical reference when nothing needed healing");
  assert.deepEqual(prunedIds, []);
});

test("refusalReason: a ratified classification names the ratified state, not a generic NOT READY", () => {
  const c = classifyProposal({ id: "P19", summary: "s", evidenceAnchors: [] }, undefined, baseCtx({ isRatified: () => true }));
  const reason = refusalReason(c);
  assert.match(reason, /already RATIFIED/);
  assert.doesNotMatch(reason, /NOT READY/);
});

// W1-T190: same reasoning as the acceptance-2 test above — this test's name embeds
// acceptance criterion 4's proof text VERBATIM so the `unit test:` dialect proof executor
// finds a real, name-matched subtest to run rather than falling through to a false fail.
test("the inbox offers the ratify affordance ONLY for a proposal that is genuinely READY, matching what `rmd approve` will accept. FALSIFIER: offering RATIFY on an already-ratified proposal invites an operator into an action that fails — the same wrong-affordance shape W1-T182 removes from NEEDS ME, where an Approve control renders on escalations that have no approve verb (acceptance 4)", () => {
  const rendered = renderInbox([
    { proposalId: "P19", state: "ratified", reasons: [] },
    { proposalId: "P-OTHER", state: "ready", reasons: [], draft: draftFor("P-OTHER", CLEAN_FRAGMENT, []) },
  ]);
  assert.doesNotMatch(rendered, /READY — P19/);
  assert.match(rendered, /RATIFIED — P19/);
  assert.match(rendered, /READY — P-OTHER/, "a genuinely ready proposal is unaffected");
});

// ── The draft rung: prompt + parser (pure) ──────────────────────────────────

test("inboxDraftPrompt embeds the proposal id/summary and the current plan text, and instructs the FRAGMENT/STAMP output shape", () => {
  const proposal: Proposal = { id: "P42", summary: "do the thing", evidenceAnchors: [] };
  const prompt = inboxDraftPrompt(proposal, "- id: W1-T1\n", "run-1");
  assert.match(prompt, /id: P42/);
  assert.match(prompt, /do the thing/);
  assert.match(prompt, /=== FRAGMENT START ===/);
  assert.match(prompt, /STAMP:/);
  assert.match(prompt, /- id: W1-T1/);
  assert.doesNotMatch(prompt, /\bWrite\b tool|\bEdit\b tool/);
});

test("parseDraftedCandidate extracts the fragment + stamp; last marker wins over scratch reasoning", () => {
  const text = [
    "some scratch reasoning first",
    "=== FRAGMENT START ===",
    "- id: SCRATCH",
    "=== FRAGMENT END ===",
    "STAMP: scratch stamp",
    "actually let me redo this",
    "=== FRAGMENT START ===",
    "- id: W1-T900",
    "  title: real",
    "=== FRAGMENT END ===",
    "STAMP: - P1 (plan) — RATIFIED 2026-07-20 -> W1-T900.",
  ].join("\n");
  const parsed = parseDraftedCandidate(text);
  assert.ok(parsed);
  assert.match(parsed!.fragmentYaml, /W1-T900/);
  assert.equal(parsed!.stampLine, "- P1 (plan) — RATIFIED 2026-07-20 -> W1-T900.");
});

test("parseDraftedCandidate returns null when either marker is missing — a malformed draft is never silently accepted", () => {
  assert.equal(parseDraftedCandidate("no markers here at all"), null);
  assert.equal(parseDraftedCandidate("=== FRAGMENT START ===\n- id: X\n=== FRAGMENT END ===\n(no stamp)"), null);
  assert.equal(parseDraftedCandidate("STAMP: only a stamp, no fragment"), null);
});

// ── Real-world evidence-anchor adapter (git grep against a real throwaway repo) ────────────

function seedGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-inbox-"));
  const git = (args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  git(["init", "--quiet", "-b", "main"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Test"]);
  mkdirSync(join(dir, "sub"), { recursive: true });
  writeFileSync(join(dir, "sub", "note.md"), "the feature has LANDED for real\n", "utf8");
  git(["add", "-A"]);
  git(["commit", "--quiet", "-m", "base"]);
  return dir;
}

test("gitGrepAnchorTrue: a matching pattern on the given ref is true, a non-matching one is false", () => {
  const dir = seedGitRepo();
  assert.equal(gitGrepAnchorTrue(dir, "main", { description: "x", pattern: "LANDED", path: "sub/note.md" }), true);
  assert.equal(gitGrepAnchorTrue(dir, "main", { description: "x", pattern: "NEVER-THERE", path: "sub/note.md" }), false);
  assert.equal(gitGrepAnchorTrue(dir, "main", { description: "x", pattern: "LANDED" }), true, "repo-wide grep (no path) also matches");
});

test("gitGrepAnchorTrue: an unresolvable ref is a real error, never silently 'not grep-true'", () => {
  const dir = seedGitRepo();
  assert.throws(() => gitGrepAnchorTrue(dir, "no-such-ref-at-all", { description: "x", pattern: "LANDED" }));
});

// ── Registry parsing (fail-soft to empty, never a throw) ───────────────────

test("parseProposalRegistry: missing/malformed input yields [] rather than throwing", () => {
  assert.deepEqual(parseProposalRegistry(undefined), []);
  assert.deepEqual(parseProposalRegistry("not json"), []);
  assert.deepEqual(parseProposalRegistry("{}"), []);
  assert.deepEqual(parseProposalRegistry('{"proposals": "not an array"}'), []);
});

test("parseProposalRegistry: valid input round-trips", () => {
  const proposals: Proposal[] = [{ id: "P1", summary: "s", evidenceAnchors: [] }];
  const parsed = parseProposalRegistry(JSON.stringify({ proposals }));
  assert.deepEqual(parsed, proposals);
});

test("parseDraftCache: missing/malformed input yields {} rather than throwing", () => {
  assert.deepEqual(parseDraftCache(undefined), {});
  assert.deepEqual(parseDraftCache("not json"), {});
  assert.deepEqual(parseDraftCache("[]"), {});
});

test("parseDraftCache: valid input round-trips, keyed by proposal id", () => {
  const draft = draftFor("P1", CLEAN_FRAGMENT, []);
  const parsed = parseDraftCache(JSON.stringify({ P1: draft }));
  assert.deepEqual(parsed.P1, draft);
});

// ── Rendering ─────────────────────────────────────────────────────────────

test("renderInbox: empty classification list renders a clear 'no active proposals' line", () => {
  assert.match(renderInbox([]), /no active proposals/);
});

test("renderInbox: a READY item's rendering carries its drafted tasks and stamp; a not-ready item names its predicate; a deferred item names its trigger and is never labeled READY", () => {
  const anchor: EvidenceAnchor = { description: "x", pattern: "landed" };
  const readyDraft = draftFor("P-READY", CLEAN_FRAGMENT, [anchor]);
  const rendered = renderInbox([
    { proposalId: "P-READY", state: "ready", reasons: [], draft: readyDraft },
    { proposalId: "P-BLOCKED", state: "not_ready", reasons: [{ predicate: "deps_merged", detail: "dep-unmet: W1-T2 not merged" }] },
    {
      proposalId: "P-DEFER",
      state: "deferred_with_trigger",
      reasons: [],
      trigger: { description: "unbuilt consumer", fired: false },
    },
  ]);
  assert.match(rendered, /READY — P-READY/);
  assert.match(rendered, /W1-T900/);
  assert.match(rendered, /NOT READY — P-BLOCKED/);
  assert.match(rendered, /dep-unmet: W1-T2 not merged/);
  assert.match(rendered, /DEFERRED-WITH-TRIGGER — P-DEFER \(never recommended\)/);
  assert.match(rendered, /unbuilt consumer/);
  assert.doesNotMatch(rendered, /READY — P-DEFER/);
});

// ── The digest's ready-count block (W1-T112 — the morning pulse) ──────────────────────────

test("summarizeInboxPoll: counts only READY classifications, ignoring not_ready and deferred", () => {
  const classifications: InboxClassification[] = [
    { proposalId: "P-1", state: "ready", reasons: [] },
    { proposalId: "P-2", state: "ready", reasons: [] },
    { proposalId: "P-3", state: "not_ready", reasons: [{ predicate: "deps_merged", detail: "x" }] },
    { proposalId: "P-4", state: "deferred_with_trigger", reasons: [], trigger: { description: "y", fired: false } },
  ];
  assert.deepEqual(summarizeInboxPoll(classifications), { ready: 2 });
});

test("summarizeInboxPoll: an empty batch is zero ready, not an error", () => {
  assert.deepEqual(summarizeInboxPoll([]), { ready: 0 });
});

test("renderInboxPollSummary: renders the digest's one-line 'N ready'", () => {
  assert.equal(renderInboxPollSummary({ ready: 3 }), "3 ready");
  assert.equal(renderInboxPollSummary({ ready: 0 }), "0 ready");
});

// ── The draft rung runs DAEMON-SIDE, not CLI-pull (W1-T192) ────────────────────────────────
//
// The daemon's per-poll draft rung (run-task.ts's `buildInboxDraftHook`) and `rmd inbox`
// share ONE predicate (`proposalsNeedingDraft`) and ONE drafting loop (`runDraftRung`) — the
// design's "REUSE it rather than re-deriving, so the daemon and the CLI can never disagree"
// requirement. Everything below is provable with a FAKE spawn — no real worktree, gh, or LLM
// call anywhere, the same discipline the rest of this file already holds `classifyProposal`
// to.

const VALID_DRAFT_TEXT = [
  "=== FRAGMENT START ===",
  "- id: W1-T900",
  "  title: drafted candidate",
  "=== FRAGMENT END ===",
  "STAMP: - P1 (plan) — RATIFIED 2026-07-21 -> W1-T900.",
].join("\n");

function fakeWorkerResult(text: string): WorkerResult {
  return {
    sessionId: "s",
    costUsd: 0.01,
    numTurns: 1,
    text,
    blocks: [],
    stderr: "",
    subtype: "success",
    isError: false,
    apiError: false,
    permissionDenials: [],
    childEnvKeys: [],
    model: "default",
    effort: "default",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    modelUsage: {},
    compactionEvents: [],
    qualitySuspect: false,
  };
}

test("proposalsNeedingDraft: excludes an unfired-trigger proposal, includes missing/stale drafts, excludes a fresh cached draft", () => {
  const anchor: EvidenceAnchor = { description: "x", pattern: "landed" };
  const deferred: Proposal = { id: "P-DEFER", summary: "s", evidenceAnchors: [anchor], trigger: { description: "t", fired: false } };
  const noDraft: Proposal = { id: "P-NEW", summary: "s", evidenceAnchors: [anchor] };
  const staleDraft: Proposal = { id: "P-STALE", summary: "s", evidenceAnchors: [anchor] };
  const freshDraft: Proposal = { id: "P-FRESH", summary: "s", evidenceAnchors: [anchor] };
  const drafts: DraftCache = {
    "P-STALE": draftFor("P-STALE", CLEAN_FRAGMENT, [{ description: "old", pattern: "old-pattern" }]),
    "P-FRESH": draftFor("P-FRESH", CLEAN_FRAGMENT, [anchor]),
  };
  const due = proposalsNeedingDraft([deferred, noDraft, staleDraft, freshDraft], drafts);
  assert.deepEqual(
    due.map((p) => p.id).sort(),
    ["P-NEW", "P-STALE"],
  );
});

test("draftAttemptKey changes when the reframe round advances or the anchor set moves; stable across everything else", () => {
  const anchor: EvidenceAnchor = { description: "x", pattern: "landed" };
  const p1: Proposal = { id: "P1", summary: "s", evidenceAnchors: [anchor] };
  const p1DifferentSummary: Proposal = { ...p1, summary: "an entirely different summary" };
  assert.equal(draftAttemptKey(p1), draftAttemptKey(p1DifferentSummary), "summary text is irrelevant to the cause fingerprint");

  const p1Reframed: Proposal = { ...p1, reframeHistory: [{ feedback: "operator objection" }] };
  assert.notEqual(draftAttemptKey(p1), draftAttemptKey(p1Reframed), "a new reframe round is a NEW cause");

  const p1MovedAnchor: Proposal = { ...p1, evidenceAnchors: [{ description: "y", pattern: "moved" }] };
  assert.notEqual(draftAttemptKey(p1), draftAttemptKey(p1MovedAnchor), "a moved evidence anchor is a NEW cause");
});

test("parseDraftAttemptCache: missing/malformed input yields {} rather than throwing; valid input round-trips", () => {
  assert.deepEqual(parseDraftAttemptCache(undefined), {});
  assert.deepEqual(parseDraftAttemptCache("not json"), {});
  assert.deepEqual(parseDraftAttemptCache("[]"), {});
  const cache: DraftAttemptCache = { P1: "fingerprint::0" };
  assert.deepEqual(parseDraftAttemptCache(JSON.stringify(cache)), cache);
});

test("draftsDueOnDaemon layers the attempt throttle on top of proposalsNeedingDraft — `rmd inbox` itself stays UNTHROTTLED (the manual-force contract)", () => {
  const anchor: EvidenceAnchor = { description: "x", pattern: "landed" };
  const proposal: Proposal = { id: "P1", summary: "s", evidenceAnchors: [anchor] };
  const drafts: DraftCache = {}; // still needs a draft
  const attempts: DraftAttemptCache = { P1: draftAttemptKey(proposal) }; // daemon already attempted THIS cause

  assert.deepEqual(draftsDueOnDaemon([proposal], drafts, attempts), [], "the daemon must not re-attempt the SAME cause");

  const reframed: Proposal = { ...proposal, reframeHistory: [{ feedback: "operator objection" }] };
  assert.deepEqual(
    draftsDueOnDaemon([reframed], drafts, attempts).map((p) => p.id),
    ["P1"],
    "a NEW reframe round is a NEW cause — due again",
  );

  // `rmd inbox`'s own predicate never consults the daemon's attempt cache at all — a human
  // asking for a redraft is a genuine FORCE, not subject to the daemon's throttle.
  assert.deepEqual(
    proposalsNeedingDraft([proposal], drafts).map((p) => p.id),
    ["P1"],
  );
});

test("runDraftRung: a successful spawn produces a cached-shape DraftedCandidate and ledgers draft_synthesized + drafted", async () => {
  const anchor: EvidenceAnchor = { description: "x", pattern: "landed" };
  const proposal: Proposal = { id: "P1", summary: "s", evidenceAnchors: [anchor] };
  const logLines: { step: string; extra?: Record<string, unknown> }[] = [];
  const spawn: DraftSpawn = async () => fakeWorkerResult(VALID_DRAFT_TEXT);

  const outcomes = await runDraftRung([proposal], "- id: W1-T1\n", { spawn, log: (step, extra) => logLines.push({ step, extra }) }, "run-1");

  assert.equal(outcomes.length, 1);
  const outcome = outcomes[0];
  assert.equal(outcome.ok, true);
  if (outcome.ok) {
    assert.match(outcome.candidate.fragmentYaml, /W1-T900/);
    assert.equal(outcome.candidate.anchorFingerprint, anchorFingerprint([anchor]));
  }
  assert.ok(logLines.some((l) => l.step === "inbox.draft_synthesized"));
  assert.ok(logLines.some((l) => l.step === "inbox.drafted" && l.extra?.proposal_id === "P1"));
});

test("runDraftRung: malformed worker output (no FRAGMENT/STAMP markers) is logged and skipped — never a throw", async () => {
  const proposal: Proposal = { id: "P1", summary: "s", evidenceAnchors: [] };
  const spawn: DraftSpawn = async () => fakeWorkerResult("no markers in this output at all");

  const outcomes = await runDraftRung([proposal], "plan text", { spawn, log: () => {} }, "run-1");

  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].ok, false);
});

test("runDraftRung: one proposal's spawn THROWING never strands the rest of the batch — per-proposal isolation (W1-T192 fail-soft)", async () => {
  const anchor: EvidenceAnchor = { description: "x", pattern: "landed" };
  const bad: Proposal = { id: "P-BAD", summary: "s", evidenceAnchors: [anchor] };
  const good: Proposal = { id: "P-GOOD", summary: "s", evidenceAnchors: [anchor] };
  const logLines: { step: string; extra?: Record<string, unknown> }[] = [];
  const spawn: DraftSpawn = async (proposal) => {
    if (proposal.id === "P-BAD") throw new Error("transport error");
    return fakeWorkerResult(VALID_DRAFT_TEXT);
  };

  const outcomes = await runDraftRung([bad, good], "plan text", { spawn, log: (step, extra) => logLines.push({ step, extra }) }, "run-1");

  assert.equal(outcomes.length, 2, "BOTH proposals were attempted — one throwing did not abort the batch");
  const badOutcome = outcomes.find((o) => o.proposalId === "P-BAD")!;
  assert.equal(badOutcome.ok, false);
  if (!badOutcome.ok) assert.match(badOutcome.error, /transport error/);
  const goodOutcome = outcomes.find((o) => o.proposalId === "P-GOOD")!;
  assert.equal(goodOutcome.ok, true, "the OTHER proposal in the same batch still succeeded");
  assert.ok(logLines.some((l) => l.step === "inbox.draft_error" && l.extra?.proposal_id === "P-BAD"));
});

test("W1-T192 acceptance fixture: a proposal with a fired trigger and an invalidated (reframed) draft is redrafted by the DAEMON path within two polls — `rmd inbox` is never referenced", async () => {
  // Mirrors the live fixture at filing: P34's reframe invalidated its cached draft
  // (state/inbox-drafts.json held zero P34 entries) and its trigger had already fired; the
  // daemon polled since and had nothing to make it redraft. This test drives ONLY the
  // daemon-shaped functions (draftsDueOnDaemon + runDraftRung) — it never imports or calls
  // inboxCommand/`rmd inbox` at all, so a pass here is proof the daemon path alone suffices.
  const anchor: EvidenceAnchor = { description: "x", pattern: "landed" };
  const proposal: Proposal = {
    id: "P34",
    summary: "s",
    evidenceAnchors: [anchor],
    trigger: { description: "consumer shipped", fired: true },
    reframeHistory: [{ feedback: "third reframe round" }],
  };
  let drafts: DraftCache = {}; // the reframe invalidated the cache — nothing cached for P34
  let attempts: DraftAttemptCache = {};
  let spawnCalls = 0;
  const spawn: DraftSpawn = async () => {
    spawnCalls++;
    return fakeWorkerResult(VALID_DRAFT_TEXT);
  };

  for (let poll = 0; poll < 2; poll++) {
    const due = draftsDueOnDaemon([proposal], drafts, attempts);
    if (due.length === 0) continue;
    const outcomes = await runDraftRung(due, "- id: W1-T1\n", { spawn, log: () => {} }, `POLL-${poll}`);
    for (const outcome of outcomes) {
      attempts = { ...attempts, [outcome.proposalId]: draftAttemptKey(due.find((p) => p.id === outcome.proposalId)!) };
      if (outcome.ok) drafts = { ...drafts, [outcome.proposalId]: outcome.candidate };
    }
  }

  assert.equal(spawnCalls, 1, "a draft was spawned within the two simulated polls");
  assert.ok(drafts["P34"], "P34 now has a cached draft, with no CLI invocation anywhere in this test");
});

test("three consecutive daemon polls over the SAME invalidated proposal spawn the Architect exactly once — idempotence is keyed to the cause, not poll count (W1-T192)", async () => {
  const anchor: EvidenceAnchor = { description: "x", pattern: "landed" };
  const proposal: Proposal = { id: "P1", summary: "s", evidenceAnchors: [anchor], reframeHistory: [{ feedback: "fb" }] };
  let drafts: DraftCache = {};
  let attempts: DraftAttemptCache = {};
  let spawnCalls = 0;
  const spawn: DraftSpawn = async () => {
    spawnCalls++;
    return fakeWorkerResult(VALID_DRAFT_TEXT);
  };

  for (let poll = 0; poll < 3; poll++) {
    const due = draftsDueOnDaemon([proposal], drafts, attempts);
    if (due.length === 0) continue;
    const outcomes = await runDraftRung(due, "plan text", { spawn, log: () => {} }, `POLL-${poll}`);
    for (const outcome of outcomes) {
      attempts = { ...attempts, [outcome.proposalId]: draftAttemptKey(due.find((p) => p.id === outcome.proposalId)!) };
      if (outcome.ok) drafts = { ...drafts, [outcome.proposalId]: outcome.candidate };
    }
  }

  assert.equal(spawnCalls, 1, "ONE invalidation must produce ONE draft attempt across three polls");
});

test("a FAILED daemon draft attempt is throttled too — a stuck cause does not re-spawn every poll", async () => {
  const anchor: EvidenceAnchor = { description: "x", pattern: "landed" };
  const proposal: Proposal = { id: "P1", summary: "s", evidenceAnchors: [anchor], reframeHistory: [{ feedback: "fb" }] };
  let drafts: DraftCache = {};
  let attempts: DraftAttemptCache = {};
  let spawnCalls = 0;
  const spawn: DraftSpawn = async () => {
    spawnCalls++;
    throw new Error("architect worker crashed");
  };

  for (let poll = 0; poll < 3; poll++) {
    const due = draftsDueOnDaemon([proposal], drafts, attempts);
    if (due.length === 0) continue;
    const outcomes = await runDraftRung(due, "plan text", { spawn, log: () => {} }, `POLL-${poll}`);
    for (const outcome of outcomes) {
      attempts = { ...attempts, [outcome.proposalId]: draftAttemptKey(due.find((p) => p.id === outcome.proposalId)!) };
      if (outcome.ok) drafts = { ...drafts, [outcome.proposalId]: outcome.candidate };
    }
  }

  assert.equal(spawnCalls, 1, "a failing cause is attempted once, not re-spawned every subsequent poll");
  assert.equal(drafts["P1"], undefined, "the proposal remains genuinely un-drafted — the status quo, not a regression");
});

// ── W1-T192 acceptance-proof-text fixtures ──────────────────────────────────────────────────
//
// The review floor's `unit test:` dialect (lib/review.ts's parseTestTarget) runs a criterion's
// proof body as a `--test-name-pattern` search across the WHOLE suite when it names no exact
// file path — so the criterion is only mechanically provable by a REAL test whose name IS that
// proof text, verbatim. These are additive composites alongside the granular tests above (same
// convention W1-T185's review round 3 established for this exact class of proof) — they do not
// replace the more narrowly-named tests already covering the same behavior.

// NOTE: the review floor's `unit test:` dialect runs this criterion's proof body as a raw
// `--test-name-pattern` REGEX (lib/review.ts's parseTestTarget), not a literal string match.
// The proof's own parenthesized aside "(reframe round)" therefore parses as a REGEX CAPTURE
// GROUP — grouping parens are zero-width and never literally matched — so a test name
// containing the literal characters "(reframe round)" (with parens) does NOT match the
// pattern; a name containing the bare words "reframe round" (no parens) at that position
// does. This test's name is the criterion's proof text with only that one pair of parens
// dropped, so the SAME regex quirk that would otherwise false-fail this criterion instead
// lets it match — the underlying assertions are unchanged from the fully-verbatim name.
test("three consecutive polls over the same invalidated proposal spawn the Architect exactly once, keyed to the invalidation reframe round rather than to poll count. FALSIFIER: an unkeyed rung spawns a bounded Architect worker every 300s against the same proposal — a repeating spend leak of the class W1-T177 exists to prevent", async () => {
  const anchor: EvidenceAnchor = { description: "x", pattern: "landed" };
  const proposal: Proposal = { id: "P1", summary: "s", evidenceAnchors: [anchor], reframeHistory: [{ feedback: "fb" }] };
  let drafts: DraftCache = {};
  let attempts: DraftAttemptCache = {};
  let spawnCalls = 0;
  const spawn: DraftSpawn = async () => {
    spawnCalls++;
    return fakeWorkerResult(VALID_DRAFT_TEXT);
  };

  for (let poll = 0; poll < 3; poll++) {
    const due = draftsDueOnDaemon([proposal], drafts, attempts);
    if (due.length === 0) continue;
    const outcomes = await runDraftRung(due, "plan text", { spawn, log: () => {} }, `POLL-${poll}`);
    for (const outcome of outcomes) {
      attempts = { ...attempts, [outcome.proposalId]: draftAttemptKey(due.find((p) => p.id === outcome.proposalId)!) };
      if (outcome.ok) drafts = { ...drafts, [outcome.proposalId]: outcome.candidate };
    }
  }

  assert.equal(spawnCalls, 1, "ONE invalidation (one reframe round, keyed by draftAttemptKey) must produce ONE draft attempt across three 300s-cadence polls, never one per poll");
});

test("a seeded draft-spawn failure leaves the sweep and daemon loop running and the proposal un-drafted, with the failure logged. FALSIFIER: a throw that halts the daemon trades a missing draft for a stopped fleet, when an un-drafted proposal is merely the status quo", async () => {
  const anchor: EvidenceAnchor = { description: "x", pattern: "landed" };
  const bad: Proposal = { id: "P-BAD", summary: "s", evidenceAnchors: [anchor] };
  const good: Proposal = { id: "P-GOOD", summary: "s", evidenceAnchors: [anchor] };
  const logLines: { step: string; extra?: Record<string, unknown> }[] = [];
  const spawn: DraftSpawn = async (proposal) => {
    if (proposal.id === "P-BAD") throw new Error("architect worker crashed"); // the SEEDED draft-spawn failure
    return fakeWorkerResult(VALID_DRAFT_TEXT);
  };

  // The sweep/daemon LOOP is simulated by the surrounding try/catch here: runDraftRung must
  // return NORMALLY (never throw) for a seeded spawn failure, or the caller (buildInboxDraftHook,
  // riding the daemon's own deps.sweep() seam) would propagate the throw and halt the daemon.
  let threw = false;
  let outcomes: Awaited<ReturnType<typeof runDraftRung>> = [];
  try {
    outcomes = await runDraftRung([bad, good], "plan text", { spawn, log: (step, extra) => logLines.push({ step, extra }) }, "run-1");
  } catch {
    threw = true;
  }
  assert.equal(threw, false, "a seeded draft-spawn failure must never propagate a throw — the sweep and daemon loop keeps running");

  const badOutcome = outcomes.find((o) => o.proposalId === "P-BAD")!;
  assert.equal(badOutcome.ok, false, "the proposal remains un-drafted — the status quo, not a regression");
  assert.ok(
    logLines.some((l) => l.step === "inbox.draft_error" && l.extra?.proposal_id === "P-BAD"),
    "the failure is LOGGED, never silently swallowed",
  );

  const goodOutcome = outcomes.find((o) => o.proposalId === "P-GOOD")!;
  assert.equal(goodOutcome.ok, true, "a sibling proposal in the same batch still drafted — the batch was never halted by the seeded failure");

  // A LATER poll after the failure must still run normally — the daemon loop is not stuck.
  const anotherProposal: Proposal = { id: "P-ANOTHER", summary: "s", evidenceAnchors: [anchor] };
  const secondPollOutcomes = await runDraftRung([anotherProposal], "plan text", { spawn, log: () => {} }, "run-2");
  assert.equal(secondPollOutcomes[0].ok, true, "a subsequent poll still runs normally — the daemon loop was never halted by the earlier seeded failure");
});
