import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  anchorFingerprint,
  classifyProposal,
  gitGrepAnchorTrue,
  inboxDraftPrompt,
  isDraftStale,
  parseDraftCache,
  parseDraftedCandidate,
  parseProposalRegistry,
  renderInbox,
  type DraftedCandidate,
  type EvidenceAnchor,
  type Proposal,
  type ReadinessContext,
} from "../src/lib/inbox.js";
import { loadPlanFromYaml, type MergedResolver, type Plan } from "../src/lib/plan.js";

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
