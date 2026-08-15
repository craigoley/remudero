import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  anchorFingerprint,
  approveProposal,
  classifyProposal,
  refusalReason,
  type DraftedCandidate,
  type EvidenceAnchor,
  type Proposal,
  type ReadinessContext,
  type RatifyGateway,
} from "../src/lib/inbox.js";
import { loadPlanFromYaml, type MergedResolver, type Plan } from "../src/lib/plan.js";

/**
 * W1-T510: `ReadinessContext.isMerged` (`MergedResolver`) is a plain boolean, so a
 * dependency whose GitHub read genuinely FAILED (throttled/auth/transport/truncated —
 * W1-T119's `indeterminate`) reports the same `false` as a dependency that was actually
 * read and found unmerged. Pre-fix, `classifyProposal` folded both into one `dep-unmet:
 * ... not merged` claim — a POSITIVE FACTUAL CLAIM about a dependency nobody read. This
 * file proves `ctx.depsUnobservable` splits the two apart into a distinct `deps_observable`
 * predicate, without changing polarity (an unobservable dep still blocks READY) and without
 * disturbing the ordinary dep-unmet / merged paths for ids `depsUnobservable` never names.
 */

// ── Fixtures ─────────────────────────────────────────────────────────────────

const PLAN_YAML = `
- id: W1-T1
  title: "merged foundation task"
  repo: remudero
  depends_on: []
  type: implement
  verify: auto
  risk: medium
  status: merged
  attempts: 1
  origin: architect
- id: W1-T2
  title: "genuinely queued dependency (never merged, never throttled)"
  repo: remudero
  depends_on: []
  type: implement
  verify: auto
  risk: medium
  status: queued
  attempts: 0
  origin: architect
- id: W1-T197
  title: "dependency whose GitHub read is currently throttled — merge state unknown"
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
  return loadPlanFromYaml(PLAN_YAML, "fixture");
}

/** Only W1-T1 is actually OBSERVED merged — W1-T2 and W1-T197 both report `false`, exactly
 *  the ambiguity `depsUnobservable` exists to resolve. */
const isMerged: MergedResolver = (t) => t.id === "W1-T1";

/** W1-T197 is the ONLY id whose read is indeterminate — classified `rate_limit`, mirroring
 *  the reported incident's own throttled dependency. W1-T2's read genuinely succeeded and
 *  concluded not-merged, so it must never be reported unobservable. */
const depsUnobservable = (taskId: string): "rate_limit" | undefined => (taskId === "W1-T197" ? "rate_limit" : undefined);

function baseCtx(overrides: Partial<ReadinessContext> = {}): ReadinessContext {
  return {
    plan: basePlan(),
    isMerged,
    grepAnchorTrue: () => true,
    openProposalIds: new Set(),
    isRatified: () => false,
    ...overrides,
  };
}

function fragmentDependingOn(taskId: string, depId: string): string {
  return `
- id: ${taskId}
  title: "candidate depending on ${depId}"
  repo: remudero
  depends_on: [${depId}]
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
}

const READY_FRAGMENT = fragmentDependingOn("W1-T900", "W1-T1");
const DEP_UNMET_FRAGMENT = fragmentDependingOn("W1-T901", "W1-T2");
const UNOBSERVABLE_FRAGMENT = fragmentDependingOn("W1-T902", "W1-T197");
const MIXED_FRAGMENT = `
- id: W1-T903
  title: "candidate depending on both a genuinely-unmet dep and an unobservable one"
  repo: remudero
  depends_on: [W1-T2, W1-T197]
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

const ANCHOR: EvidenceAnchor = { description: "x", pattern: "landed", path: "MASTER-PLAN.md" };

function draftFor(proposalId: string, fragmentYaml: string): DraftedCandidate {
  return {
    proposalId,
    fragmentYaml,
    stampLine: `- ${proposalId} (plan) — RATIFIED 2026-08-15 -> NEW-1.`,
    anchorFingerprint: anchorFingerprint([ANCHOR]),
  };
}

function proposal(id: string): Proposal {
  return { id, summary: "s", evidenceAnchors: [ANCHOR] };
}

// ── Acceptance #1: unobservable dep is NEVER folded into dep-unmet ─────────────────────────

test("an indeterminate dep read is reported unobservable with its classified reason, and never appears in dep-unmet", () => {
  const p = proposal("P-UNOBSERVABLE");
  const draft = draftFor(p.id, UNOBSERVABLE_FRAGMENT);
  const result = classifyProposal(p, draft, baseCtx({ depsUnobservable }));

  assert.equal(result.state, "not_ready");

  const observableFailure = result.reasons.find((r) => r.predicate === "deps_observable");
  assert.ok(observableFailure, "a deps_observable predicate failure is present");
  assert.match(observableFailure!.detail, /deps-unobservable/);
  assert.match(observableFailure!.detail, /W1-T197/);
  assert.match(observableFailure!.detail, /rate_limit/);

  // The whole point: no dep-unmet claim was made about a dependency nobody actually read.
  const depUnmetFailure = result.reasons.find((r) => r.predicate === "deps_merged");
  assert.equal(depUnmetFailure, undefined, "W1-T197 must never surface as dep-unmet");
});

// ── Acceptance #2: the discrimination holds in BOTH directions ─────────────────────────────

test("a genuinely absent (never-throttled) dep still reads dep-unmet exactly as today", () => {
  const p = proposal("P-DEP-UNMET");
  const draft = draftFor(p.id, DEP_UNMET_FRAGMENT);
  const result = classifyProposal(p, draft, baseCtx({ depsUnobservable }));

  assert.equal(result.state, "not_ready");
  assert.ok(result.reasons.some((r) => r.predicate === "deps_merged" && /dep-unmet: W1-T901->W1-T2 not merged/.test(r.detail)));
  assert.equal(
    result.reasons.some((r) => r.predicate === "deps_observable"),
    false,
    "W1-T2's read genuinely concluded not-merged — it must never be reported unobservable",
  );
});

test("a merged dep still classifies READY — deferring everything is not the fix", () => {
  const p = proposal("P-READY");
  const draft = draftFor(p.id, READY_FRAGMENT);
  const result = classifyProposal(p, draft, baseCtx({ depsUnobservable }));

  assert.equal(result.state, "ready");
  assert.deepEqual(result.reasons, []);
});

test("a genuinely-unmet dep and an unobservable dep on the SAME proposal surface as two distinct, uncollapsed predicates", () => {
  const p = proposal("P-MIXED");
  const draft = draftFor(p.id, MIXED_FRAGMENT);
  const result = classifyProposal(p, draft, baseCtx({ depsUnobservable }));

  assert.equal(result.state, "not_ready");
  const depUnmet = result.reasons.find((r) => r.predicate === "deps_merged");
  const unobservable = result.reasons.find((r) => r.predicate === "deps_observable");
  assert.ok(depUnmet, "W1-T2 still names dep-unmet");
  assert.match(depUnmet!.detail, /W1-T2/);
  assert.doesNotMatch(depUnmet!.detail, /W1-T197/, "the unobservable dep must not leak into the dep-unmet list");
  assert.ok(unobservable, "W1-T197 names deps_observable, separately");
  assert.match(unobservable!.detail, /W1-T197/);
  assert.doesNotMatch(unobservable!.detail, /W1-T2\b/, "the genuinely-unmet dep must not leak into the unobservable list");
});

test("omitting ctx.depsUnobservable (every pre-W1-T510 fixture/caller) behaves exactly as before — no deps_observable predicate ever appears", () => {
  const p = proposal("P-NO-SIGNAL");
  const draft = draftFor(p.id, UNOBSERVABLE_FRAGMENT);
  // No depsUnobservable supplied at all — baseCtx()'s default (undefined).
  const result = classifyProposal(p, draft, baseCtx());

  assert.equal(result.state, "not_ready");
  assert.ok(result.reasons.some((r) => r.predicate === "deps_merged" && /W1-T197/.test(r.detail)));
  assert.equal(result.reasons.some((r) => r.predicate === "deps_observable"), false);
});

// ── Acceptance #3: polarity does NOT flip — unobservable still blocks READY + approve refuses,
// and the refusal names the throttle, not a false "not merged" claim ────────────────────────

function fakeGateway(): RatifyGateway & { branchCalls: number; prCalls: number } {
  let branchCalls = 0;
  let prCalls = 0;
  return {
    get branchCalls() {
      return branchCalls;
    },
    get prCalls() {
      return prCalls;
    },
    createRatificationBranch() {
      branchCalls++;
      return "run-should-never-be-called";
    },
    openPlanPr() {
      prCalls++;
      return "https://github.com/craigoley/remudero/pull/0";
    },
  };
}

function ledgerPath(): string {
  return join(mktempDir(), "ledger.ndjson");
}

function mktempDir(): string {
  return mkdtempSync(join(tmpdir(), "rmd-inbox-deps-unobservable-"));
}

function readLedger(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

test("an unobservable dep keeps the proposal out of READY, and rmd approve refuses it — naming the throttle, not a false not-merged claim", () => {
  const p = proposal("P-UNOBSERVABLE-APPROVE");
  const draft = draftFor(p.id, UNOBSERVABLE_FRAGMENT);
  const classification = classifyProposal(p, draft, baseCtx({ depsUnobservable }));

  assert.notEqual(classification.state, "ready", "cannot-observe means WAIT, never READY on an unread dependency (W1-T130)");

  const gateway = fakeGateway();
  const path = ledgerPath();
  const result = approveProposal(classification, gateway, { ledgerPath: path, runId: "RUN-W1-T510" });

  assert.equal(result.ok, false, "rmd approve refuses an unobservable-dep proposal exactly like any other not-ready one");
  assert.equal(gateway.branchCalls, 0, "zero gateway side effects on a refusal");
  assert.equal(gateway.prCalls, 0);

  if (!result.ok) {
    assert.match(result.refusal, /rate_limit/, "the refusal names the classified throttle reason");
    assert.doesNotMatch(result.refusal, /W1-T197 not merged/, "never a false positive not-merged claim about an unread dependency");
  }

  const lines = readLedger(path);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].step, "ratify.approve_refused");
  assert.match(String(lines[0].reason), /rate_limit/);

  // refusalReason (also what renderInbox/status-board's headNotReadyReason ride) carries the
  // same classified-throttle detail, not a bare "not ready".
  assert.match(refusalReason(classification), /deps-unobservable/);
  assert.match(refusalReason(classification), /rate_limit/);
});
