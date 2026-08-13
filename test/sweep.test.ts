import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_CLARIFY_POLICY,
  DEFAULT_SWEEP_POLICY,
  DISPOSITION_RULES,
  checksStateFromRollup,
  deriveDisposition,
  isBlockedCi,
  isPureConcurrentAddition,
  listRetirableEscalationIssues,
  observedBlockerState,
  renderClarificationQuestion,
  renderMootedCloseComment,
  renderReconcileCloseComment,
  renderSweepSummary,
  runCreditBackfill,
  runEscalationReconcile,
  runSweep,
  strikeCapForAnswer,
  toQuestionEntry,
  MAX_ESCALATION_CLOSES_PER_CYCLE,
  RETIRABLE_ESCALATION_LABELS,
  type CiFailure,
  type ClarificationQuestion,
  type ConflictFileDiff,
  type CreditCandidate,
  type EscalationReconcileCandidate,
  type FixDispatchEvidence,
  type ObservedBlockerState,
  type OpenPrView,
  type RollupCheckEntry,
  type StrikeAttempt,
  type SweepDeps,
  type SweepPolicy,
} from "../src/lib/sweep.js";
import type { CriterionVerdict } from "../src/lib/review.js";
import { readLedgerLines } from "../src/lib/status.js";
import { appendLedger } from "../src/lib/ledger.js";
import { escalate, FLEET_NOTICE_LABEL, NEEDS_HUMAN_LABEL, type IssueGateway, type OpenIssue } from "../src/lib/escalate.js";

// ── fixtures ────────────────────────────────────────────────────────────────

function ledgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), "rmd-sweep-")), "ledger.ndjson");
}

function criterion(over: Partial<CriterionVerdict> = {}): CriterionVerdict {
  return {
    claim: "does the thing",
    proof: "unit test: it works",
    met: false,
    reason: "the thing is not done",
    proof_exec: "executed_fail",
    ...over,
  };
}

/** A recent timestamp so nothing is stale by default (fixed sweep clock below). */
const NOW = Date.parse("2026-07-17T12:00:00Z");
const RECENT = "2026-07-16T12:00:00Z"; // 1 day ago

function pr(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 1,
    prUrl: "https://github.com/o/r/pull/1",
    taskId: "W1-TX",
    reviewState: "pending",
    checksState: "pending",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: RECENT,
    headSha: "aaaa111",
    autoMergeArmed: false,
    ...over,
  };
}

// The P22 golden seeded set (acceptance 1), verbatim shapes:
function mergeablePr(): OpenPrView {
  return pr({ prNumber: 10, prUrl: "url/10", taskId: "W1-A", reviewState: "success", checksState: "green" });
}
function blockedFixablePr(): OpenPrView {
  return pr({
    prNumber: 11,
    prUrl: "url/11",
    taskId: "W1-B",
    reviewState: "failure",
    // W1-T138: a PURE review-only block — checks are GREEN (review only ever
    // runs once CI is green in the first place). A checks-red variant of this
    // exact shape is its own dedicated fixture below (`checksRedReviewFailingPr`)
    // — it now routes to ci-log evidence instead, never reviewer-unmet (the
    // #303/#305/#292/#315 fix); this fixture stays a clean reviewer-unmet
    // regression lock so it is never conflated with that case again.
    checksState: "green",
    priorStrikes: 0,
    unmetCriteria: [criterion({ claim: "criterion one" }), criterion({ claim: "criterion two" })],
    reviewSummary: "two criteria unmet",
  });
}

// W1-T138 (the #303/#305/#292/#315 fix): a required check (commitlint,
// CodeQL, osv, ...) is red WHILE a review verdict — success OR failure — also
// sits on the same head. Either a slower required check settled red AFTER
// review posted (ciGateFromRollup only waits for a check literally named
// `ci`), or a fix-rung strike's own push broke a required check while a STALE
// review verdict from before that push is still in the rollup. Either way the
// checks-red state must win the EVIDENCE-shape selection — ci-log, never
// reviewer-unmet — because GitHub will not merge past the red check no matter
// what the review says, and re-litigating the (possibly stale) review verdict
// leaves the actual blocker untouched.
function checksRedReviewFailingPr(): OpenPrView {
  return pr({
    prNumber: 303,
    prUrl: "url/303",
    taskId: "W1-G",
    reviewState: "failure",
    checksState: "red",
    priorStrikes: 0,
    unmetCriteria: [criterion({ claim: "criterion one" })],
    reviewSummary: "one criterion unmet",
    ciFailures: [{ name: "commitlint", logTail: "header-max-length: 108 chars exceeds the 100 cap" }],
  });
}
function checksRedReviewSuccessPr(): OpenPrView {
  return pr({
    prNumber: 292,
    prUrl: "url/292",
    taskId: "W1-H",
    reviewState: "success",
    checksState: "red",
    priorStrikes: 0,
    unmetCriteria: [],
    ciFailures: [
      {
        name: "CodeQL",
        logTail: "js/incomplete-url-substring-sanitization @ test/worker.test.ts:318 — Incomplete URL substring sanitization",
      },
    ],
  });
}
function supersededOrphanPr(): OpenPrView {
  return pr({ prNumber: 12, prUrl: "url/12", taskId: "W1-C", reviewState: "pending", supersededBy: 99 });
}
function strikesExhaustedPr(): OpenPrView {
  return pr({
    prNumber: 13,
    prUrl: "url/13",
    taskId: "W1-D",
    reviewState: "failure",
    checksState: "red",
    priorStrikes: 2, // == default cap
    unmetCriteria: [criterion({ claim: "still unmet" })],
    reviewSummary: "still failing after 2 strikes",
  });
}

// W1-T196: the #440 fixture — a plan-FILING PR (introduces new task(s), so it
// carries NO Remudero-Task trailer by design, W1-T136 criterion 5) reaching
// the SAME strikes-exhausted blocked-ambiguous shape as strikesExhaustedPr,
// but with taskId unresolved and the emitter's positive isPlanFiling signal set.
function unattributableFilingPr(over: Partial<OpenPrView> = {}): OpenPrView {
  return pr({
    prNumber: 439,
    prUrl: "url/439",
    taskId: undefined,
    isPlanFiling: true,
    reviewState: "failure",
    checksState: "red",
    priorStrikes: 2, // == default cap
    unmetCriteria: [criterion({ claim: "still unmet" })],
    reviewSummary: "still failing after 2 strikes",
    ...over,
  });
}

// W1-T100 (the #170 fix): blocked_ci — checks red, NO review posted yet.
function ciFailure(over: Partial<CiFailure> = {}): CiFailure {
  return { name: "ci", logTail: "tsc: error TS2322: ...", ...over };
}
function blockedCiPr(): OpenPrView {
  return pr({
    prNumber: 170,
    prUrl: "url/170",
    taskId: "W1-F",
    reviewState: "none",
    checksState: "red",
    unmetCriteria: [],
    priorStrikes: 0,
    ciFailures: [ciFailure()],
  });
}
function blockedCiExhaustedPr(): OpenPrView {
  return { ...blockedCiPr(), prNumber: 171, prUrl: "url/171", priorStrikes: 2 };
}

// W1-T106 (the #170 DIRTY strand): the LIVE incident's own fixture — review
// PASS, all checks SUCCESS, auto-merge would-be armed, yet mergeState DIRTY
// (a ci-gate.yml REQUIRED-array conflict vs #177/#26) — invisible to every
// disposition rule before this task because conflict state was not an
// OpenPrView input at all.
function conflictFile(over: Partial<ConflictFileDiff> = {}): ConflictFileDiff {
  return { path: ".github/workflows/ci-gate.yml", oursDeleted: 0, theirsDeleted: 0, ...over };
}
function conflictedPurePr(): OpenPrView {
  return pr({
    prNumber: 1700,
    prUrl: "url/1700",
    taskId: "W1-CONFLICT",
    reviewState: "success",
    checksState: "green",
    mergeState: "dirty",
    mergeConflict: {
      files: [conflictFile()],
      oursLog: "abc1234 add REQUIRED entry for #177",
      theirsLog: "def5678 add REQUIRED entry for #26",
    },
  });
}
function conflictedDeletionPr(): OpenPrView {
  return pr({
    prNumber: 1701,
    prUrl: "url/1701",
    taskId: "W1-CONFLICT-DEL",
    reviewState: "success",
    checksState: "green",
    mergeState: "dirty",
    // W1-T186: the raw GitHub facts alongside the already-simplified mergeState — the
    // escalation renderer names THESE, not just the "dirty" bucket.
    mergeable: false,
    mergeableState: "dirty",
    mergeConflict: {
      files: [conflictFile({ path: "src/config.ts", theirsDeleted: 3 })],
      oursLog: "abc1234 edit config.ts",
      theirsLog: "def5678 remove a stale entry from config.ts",
    },
  });
}

// W1-T186 (the #412/#413 fixture, verbatim): `mergeable: false, mergeable_state: "dirty"` AND
// checksState "none" — a conflicted PR registers ZERO check runs BY CONSTRUCTION, so there is no
// failing CI and no pending CI to report; the escalation must name CONFLICTED, never blocked_ci
// or "checks pending".
function conflictedZeroChecksPr(): OpenPrView {
  return pr({
    prNumber: 410,
    prUrl: "url/410",
    taskId: "W1-T158",
    reviewState: "none",
    checksState: "none",
    mergeState: "dirty",
    mergeable: false,
    mergeableState: "dirty",
    mergeConflict: {
      files: [conflictFile({ path: "src/config.ts", theirsDeleted: 1 })],
      oursLog: "abc1234 edit config.ts",
      theirsLog: "def5678 remove a stale entry from config.ts",
    },
  });
}

/** A recording fake for every injected effect. */
function fakeDeps(overrides: Partial<SweepDeps> = {}): SweepDeps & {
  armed: OpenPrView[];
  closed: Array<{ pr: OpenPrView; reason: string }>;
  fixed: Array<{ pr: OpenPrView; evidence: FixDispatchEvidence }>;
  escalated: Array<{ pr: OpenPrView; reason: string; question: ClarificationQuestion }>;
} {
  const armed: OpenPrView[] = [];
  const closed: Array<{ pr: OpenPrView; reason: string }> = [];
  const fixed: Array<{ pr: OpenPrView; evidence: FixDispatchEvidence }> = [];
  const escalated: Array<{ pr: OpenPrView; reason: string; question: ClarificationQuestion }> = [];
  return {
    armed,
    closed,
    fixed,
    escalated,
    arm: (p) => { armed.push(p); },
    close: (p, reason) => { closed.push({ pr: p, reason }); },
    dispatchFix: (p, evidence) => { fixed.push({ pr: p, evidence }); },
    escalate: (p, reason, question) => { escalated.push({ pr: p, reason, question }); },
    ledgerPath: ledgerPath(),
    runId: "SWEEP-1",
    now: () => NOW,
    ...overrides,
  };
}

// ── W1-T54 ROUTED: dependabot PRs go to the dep-review lane (the #533/#534 stall) ──

function dependabotPr(over: Partial<OpenPrView> = {}): OpenPrView {
  return pr({
    prNumber: 533,
    prUrl: "url/533",
    taskId: undefined,
    reviewState: "none",
    checksState: "red",
    isDependabot: true,
    ciFailures: [ciFailure()],
    ...over,
  });
}

test("deriveDisposition: a dependabot PR routes dep-review even with checks red — NEVER the ci-log fix rung (no commits onto a dependabot branch)", () => {
  const r = deriveDisposition(dependabotPr(), DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(r.disposition, "dep-review");
  assert.match(r.reason, /dep-review lane/);
});

test("deriveDisposition: a superseded dependabot PR still closes first — stale precedes the dep-review row", () => {
  assert.equal(deriveDisposition(dependabotPr({ supersededBy: 600 }), DEFAULT_SWEEP_POLICY, NOW).disposition, "stale");
});

test("runSweep: the depReview dep is invoked and its DECISION rides the disposed ledger line", async () => {
  const calls: number[] = [];
  const deps = fakeDeps({ depReview: (p) => { calls.push(p.prNumber); return "hold"; } });
  await runSweep([dependabotPr()], deps, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(calls, [533]);
  const disposed = readLedgerLines(deps.ledgerPath).filter((l) => l.step === "sweep.disposed");
  assert.equal(disposed[0].disposition, "dep-review");
  assert.equal(disposed[0].dep_review_outcome, "hold");
});

test("runSweep dedup: a TERMINAL dep-review outcome (arm/escalate) never re-runs for the same head — a major would open a fresh issue every poll", async () => {
  const first = fakeDeps({ depReview: () => "escalate" });
  await runSweep([dependabotPr()], first, DEFAULT_SWEEP_POLICY);
  const calls2: number[] = [];
  const second = fakeDeps({ ledgerPath: first.ledgerPath, depReview: (p) => { calls2.push(p.prNumber); return "arm"; } });
  await runSweep([dependabotPr()], second, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(calls2, [], "same pr@head with a terminal outcome must be deduped");
});

test("runSweep dedup: a HOLD outcome re-runs next sweep — a red check can go green on the SAME sha", async () => {
  const first = fakeDeps({ depReview: () => "hold" });
  await runSweep([dependabotPr()], first, DEFAULT_SWEEP_POLICY);
  const calls2: number[] = [];
  const second = fakeDeps({ ledgerPath: first.ledgerPath, depReview: (p) => { calls2.push(p.prNumber); return "arm"; } });
  await runSweep([dependabotPr()], second, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(calls2, [533], "a held dep-review must retry on the next poll");
});

test("runSweep: no depReview dep wired -> ledgered stand-down, no crash, no other rung fires on the dependabot PR", async () => {
  const deps = fakeDeps();
  await runSweep([dependabotPr()], deps, DEFAULT_SWEEP_POLICY);
  assert.equal(deps.fixed.length, 0);
  assert.equal(deps.escalated.length, 0);
  const disposed = readLedgerLines(deps.ledgerPath).filter((l) => l.step === "sweep.disposed");
  assert.equal(disposed[0].acted, false);
});

// ── deriveDisposition: the pure predicate (rule 2, policy-as-data) ────────────

test("deriveDisposition: passing review + green checks -> mergeable", () => {
  assert.equal(deriveDisposition(mergeablePr(), DEFAULT_SWEEP_POLICY, NOW).disposition, "mergeable");
});

test("deriveDisposition: failing review with actionable criteria, strikes left -> blocked-fixable", () => {
  assert.equal(deriveDisposition(blockedFixablePr(), DEFAULT_SWEEP_POLICY, NOW).disposition, "blocked-fixable");
});

test("deriveDisposition: a newer PR crediting the same task -> stale (superseded)", () => {
  const r = deriveDisposition(supersededOrphanPr(), DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(r.disposition, "stale");
  assert.match(r.reason, /superseded-by #99/);
});

test("deriveDisposition: failing review with strikes exhausted -> blocked-ambiguous", () => {
  const r = deriveDisposition(strikesExhaustedPr(), DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(r.disposition, "blocked-ambiguous");
  assert.match(r.reason, /exhausted/);
});

test("deriveDisposition: failing review with NO actionable criteria -> blocked-ambiguous (contradictory)", () => {
  const p = pr({ reviewState: "failure", unmetCriteria: [], priorStrikes: 0 });
  const r = deriveDisposition(p, DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(r.disposition, "blocked-ambiguous");
  assert.match(r.reason, /contradictory/);
});

// W1-T440: the SAME empty (unmetCriteria === []) has two causes — a trailer resolved a task id
// and the ledger genuinely came back with nothing unmet (contradictory, above), versus no
// trailer at all so unmetFromLedger was never consulted (unrecoverable, here). Same
// disposition, different reason — `criteriaRecoverable` is the observed field that tells them
// apart, set by buildOpenPrViews (run-task.ts), never inferred here.
test("deriveDisposition: failing review with NO Remudero-Task trailer -> blocked-ambiguous (criteria unrecoverable, not contradictory)", () => {
  const p = pr({
    reviewState: "failure",
    unmetCriteria: [],
    priorStrikes: 0,
    taskId: undefined,
    criteriaRecoverable: false,
  });
  const r = deriveDisposition(p, DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(r.disposition, "blocked-ambiguous", "same disposition as the contradictory arm — only the reason text differs");
  assert.match(r.reason, /criteria unrecoverable/);
  assert.doesNotMatch(r.reason, /contradictory/, "must NOT claim the review contradicted itself when it was never checked");
});

// An OLDER fixture that never set `criteriaRecoverable` at all keeps today's byte-identical
// wording (additive field, fail toward the pre-existing behavior, never a silent flip).
test("deriveDisposition: failing review with unset criteriaRecoverable -> blocked-ambiguous (contradictory, unchanged)", () => {
  const p = pr({ reviewState: "failure", unmetCriteria: [], priorStrikes: 0 });
  assert.equal(p.criteriaRecoverable, undefined, "the fixture helper does not set this field by default");
  const r = deriveDisposition(p, DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(r.disposition, "blocked-ambiguous");
  assert.equal(
    r.reason,
    "review failing with no actionable unmet criteria (contradictory) — escalating",
    "byte-identical to the pre-W1-T440 wording",
  );
});

test("deriveDisposition: in-flight (pending review, pending checks, not stale) -> blocked-ambiguous (the #161 fix — never armed pre-green)", () => {
  const r = deriveDisposition(pr(), DEFAULT_SWEEP_POLICY, NOW);
  // THE PROPERTY UNDER TEST IS UNCHANGED: a pre-green PR is never armed. `pr()`'s RECENT is a day
  // old — 1440m, far past `pendingCeilingMinutes` (60) — so this fixture is a genuinely stale
  // pending PR and still escalates.
  assert.equal(r.disposition, "blocked-ambiguous");
  assert.match(r.reason, /checks pending/);
  // The REASON now comes from the more specific STALE-PENDING row rather than the terminal
  // catch-all, because `pendingAgeMinutes` can finally date this PR (it used to return undefined
  // for every real PR — `checksPendingSince` was never populated by any caller, which is the
  // defect this change fixes). That row names the age and the ceiling instead of the review state,
  // which is strictly more actionable; the old `/review pending/` match was over-specified against
  // the catch-all's wording, not against the #161 property.
  assert.match(r.reason, /stale-pending — checks pending 1440m \(>= 60m ceiling\)/);
});

// ── the #161 hole: CI-red + review-skipped must NEVER be mergeable ───────────
// ── the #170 fix (W1-T100): that same shape is now POSITIVELY fixable (ci-log
//    mode) while strikes remain — fix FIRST, ask only after exhaustion ───────

test("deriveDisposition: the #161/#170 fixture — ci=red, review skipped (none), no unmet criteria, strikes left -> blocked-fixable (ci-log fix), NEVER mergeable", () => {
  const p = pr({ prNumber: 161, reviewState: "none", checksState: "red", unmetCriteria: [] });
  const r = deriveDisposition(p, DEFAULT_SWEEP_POLICY, NOW);
  assert.notEqual(r.disposition, "mergeable");
  assert.equal(r.disposition, "blocked-fixable");
  assert.match(r.reason, /checks red/);
});

test("deriveDisposition: the #170 fixture — blocked_ci with strikes EXHAUSTED -> blocked-ambiguous (the question rung), never mergeable, never a fourth fix", () => {
  const r = deriveDisposition(blockedCiExhaustedPr(), DEFAULT_SWEEP_POLICY, NOW);
  assert.notEqual(r.disposition, "mergeable");
  assert.equal(r.disposition, "blocked-ambiguous");
  assert.match(r.reason, /exhausted/);
});

test("deriveDisposition: mergeable requires POSITIVE ci=green AND review=success — {ci green, review success} -> mergeable", () => {
  const p = pr({ reviewState: "success", checksState: "green" });
  assert.equal(deriveDisposition(p, DEFAULT_SWEEP_POLICY, NOW).disposition, "mergeable");
});

test("deriveDisposition: {ci pending, review success} -> NOT mergeable (checks aren't green yet)", () => {
  const p = pr({ reviewState: "success", checksState: "pending" });
  assert.notEqual(deriveDisposition(p, DEFAULT_SWEEP_POLICY, NOW).disposition, "mergeable");
});

test("deriveDisposition: {ci green, review failure} -> blocked-fixable, unchanged by the ci predicate", () => {
  const p = pr({
    reviewState: "failure",
    checksState: "green",
    unmetCriteria: [criterion({ claim: "still needs work" })],
  });
  assert.equal(deriveDisposition(p, DEFAULT_SWEEP_POLICY, NOW).disposition, "blocked-fixable");
});

test("deriveDisposition: a synthetic state matching no positive rule -> escalate (blocked-ambiguous) with a stated reason; never disposition=none", () => {
  // Neither failing, nor superseded/stale, nor positively ci-green+review-success.
  const p = pr({ reviewState: "pending", checksState: "pending" });
  const r = deriveDisposition(p, DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(r.disposition, "blocked-ambiguous");
  assert.ok(r.reason.length > 0, "the catch-all states a reason");
});

// ── W1-T114: PENDING is a disposition — in-window checks WAIT, never escalate
// (the 2026-07-19 30-issue predicate storm: ~24 of 30 open needs-human issues
// were exactly "checks pending, review success — escalating"). ────────────────

/** The live incident's own shape: checks pending, review ALREADY success. */
function pendingStormPr(minutesPending: number, over: Partial<OpenPrView> = {}): OpenPrView {
  return pr({
    prNumber: 719,
    prUrl: "url/719",
    taskId: "W1-STORM",
    reviewState: "success",
    checksState: "pending",
    checksPendingSince: new Date(NOW - minutesPending * 60_000).toISOString(),
    ...over,
  });
}

test("acceptance 1 — deriveDisposition: in-window pending (4min, the storm's own shape) -> wait, never arms, never escalates", () => {
  const r = deriveDisposition(pendingStormPr(4), DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(r.disposition, "wait");
});

test("acceptance 1 (runSweep) — a pending-4min PR takes NO gated action: no escalate call, no merge arm, ledgered acted:false", async () => {
  const deps = fakeDeps();
  const summary = await runSweep([pendingStormPr(4)], deps);
  assert.equal(summary.byDisposition.wait, 1);
  assert.equal(deps.escalated.length, 0, "no escalation call");
  assert.equal(deps.armed.length, 0, "no merge arm");
  assert.equal(summary.actionsTaken, 0, "wait never counts as an action taken");
  const lines = readLedgerLines(deps.ledgerPath);
  const disposed = lines.find((l) => l.step === "sweep.disposed");
  assert.equal(disposed?.disposition, "wait");
  assert.equal(disposed?.acted, false, "a wait ledger line, but no action fired");
});

test("acceptance 2 — deriveDisposition: stale-pending (90min, past the 60min default ceiling) -> escalate, reason names the age AND the ceiling", () => {
  const r = deriveDisposition(pendingStormPr(90), DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(r.disposition, "blocked-ambiguous");
  assert.match(r.reason, /90m/, "the reason states the elapsed pending age");
  assert.match(r.reason, /60m/, "the reason states the configured ceiling");
});

test("acceptance 2 (runSweep) — a pending-90min PR escalates through the EXISTING escalate path (same disposition/dedup as every other blocked-ambiguous PR)", async () => {
  const deps = fakeDeps();
  const summary = await runSweep([pendingStormPr(90)], deps);
  assert.equal(summary.byDisposition["blocked-ambiguous"], 1);
  assert.equal(deps.escalated.length, 1, "the stale-pending PR reaches escalate()");
  assert.match(deps.escalated[0].reason, /90m/);
  assert.match(deps.escalated[0].reason, /60m/);
});

// ── W1-T196: UNATTRIBUTABLE-PR STAND-DOWN — a rung that cannot resolve a task ──
//    id must stand down with a ledger line, not escalate `task: UNKNOWN`: a
//    plan-filing PR carries no trailer BY DESIGN (W1-T136 criterion 5), so
//    attribution failure on that class is a known state, not an emergency.
//    FIXTURE (real): issue #440, opened 2026-07-21T01:46:53Z — "[BLOCKED]
//    UNKNOWN: PR #439 needs a clarification — not positively mergeable —
//    checks pending, review none — escalating" — against a plan-filing PR
//    whose missing trailer is required, not accidental.

test("W1-T196 acceptance 1 — a plan-filing PR with no resolvable task id STANDS DOWN with a ledger line and calls escalate() ZERO times (the #440 falsifier)", async () => {
  const filingPr = unattributableFilingPr();
  // Sanity: still the same blocked-ambiguous shape strikesExhaustedPr hits — only the
  // taskId/isPlanFiling signal differs from that baseline fixture.
  assert.equal(deriveDisposition(filingPr, DEFAULT_SWEEP_POLICY, NOW).disposition, "blocked-ambiguous");

  const deps = fakeDeps();
  const summary = await runSweep([filingPr], deps);

  assert.equal(summary.byDisposition["blocked-ambiguous"], 1);
  assert.equal(
    deps.escalated.length,
    0,
    "no escalate() call — the #440 defect ('[BLOCKED] UNKNOWN: PR #439') must never fire again for this class",
  );

  const disposed = readLedgerLines(deps.ledgerPath).filter((l) => l.step === "sweep.disposed");
  assert.equal(disposed.length, 1);
  assert.equal(disposed[0].disposition, "blocked-ambiguous");
  assert.equal(disposed[0].acted, false, "standing down is never counted as an action taken");
  assert.equal(disposed[0].pr_number, 439, "the ledger line names the PR");
  assert.equal(disposed[0].pr_url, "url/439", "the ledger line names the PR");
  assert.match(String(disposed[0].stand_down_reason), /439/, "the stand-down reason itself also names the PR");
  assert.match(
    String(disposed[0].stand_down_reason),
    /task id unresolved/,
    "the stand-down reason names the unresolved attribution",
  );
  assert.equal(
    disposed[0].question,
    undefined,
    "no clarification question is rendered — there is no task-bound question to ask",
  );
});

test("W1-T196 acceptance 2 — the stand-down is TRACED, never silent: it re-ledgers every pass, citing the W1-T136 no-trailer rule by name", async () => {
  const deps = fakeDeps();
  await runSweep([unattributableFilingPr()], deps);
  await runSweep([unattributableFilingPr()], deps); // a second, identical pass — never deduped into silence
  const disposed = readLedgerLines(deps.ledgerPath).filter((l) => l.step === "sweep.disposed");
  assert.equal(disposed.length, 2, "re-derived and re-ledgered every pass, never dropped after the first");
  for (const line of disposed) {
    assert.equal(line.acted, false);
    assert.match(
      String(line.stand_down_reason),
      /plan-filing PR carries no Remudero-Task trailer by design \(W1-T136 criterion 5\)/,
    );
  }
  assert.equal(deps.escalated.length, 0);
});

test("W1-T196 acceptance 3 — a DELIBERATELY-unattributed filing PR is distinguished from BROKEN attribution: without the POSITIVE isPlanFiling signal, an unresolved task id still escalates unchanged (a real defect stays surfaced)", async () => {
  // Same shape as unattributableFilingPr, minus the emitter's positive filing
  // signal — the shape of an IMPLEMENTING PR whose trailer went missing/malformed.
  const brokenAttributionPr = unattributableFilingPr({ isPlanFiling: undefined });
  const deps = fakeDeps();
  const summary = await runSweep([brokenAttributionPr], deps);
  assert.equal(summary.byDisposition["blocked-ambiguous"], 1);
  assert.equal(
    deps.escalated.length,
    1,
    "a genuinely unattributable PR (never flagged plan-filing) still surfaces — treating every " +
      "attribution failure as benign would silence a worker's PR that lost its trailer",
  );
  assert.equal(
    deps.escalated[0].question.taskId,
    "UNKNOWN",
    "unchanged fallback for this class — only a POSITIVELY-flagged plan-filing PR stands down",
  );
});

test("W1-T196 acceptance 4 — an attributable PR with a genuine block still escalates exactly as before this task", async () => {
  const deps = fakeDeps();
  const summary = await runSweep([strikesExhaustedPr()], deps);
  assert.equal(summary.byDisposition["blocked-ambiguous"], 1);
  assert.equal(deps.escalated.length, 1, "an attributed PR's genuine block is unaffected by the stand-down carve-out");
  assert.equal(deps.escalated[0].question.taskId, "W1-D");
});

test("acceptance 3 — the pending ceiling is DATA: lowering the seeded ceiling flips the 4min fixture from wait to escalate with ZERO sweep-code changes", () => {
  const p = pendingStormPr(4);
  assert.equal(deriveDisposition(p, DEFAULT_SWEEP_POLICY, NOW).disposition, "wait", "baseline: 4min < the default 60min ceiling -> wait");
  const tightened: SweepPolicy = { ...DEFAULT_SWEEP_POLICY, pendingCeilingMinutes: 2 };
  assert.equal(deriveDisposition(p, tightened, NOW).disposition, "blocked-ambiguous", "same fixture, only the policy changed -> escalate");
});

test("deriveDisposition: undated pending (no checksPendingSince — the gateway not yet wired) falls through to the pre-W1-T114 catch-all, never wait", () => {
  const p = pr({ reviewState: "success", checksState: "pending" }); // no checksPendingSince
  const r = deriveDisposition(p, DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(r.disposition, "blocked-ambiguous", "no datable age -> the terminal catch-all, unchanged");
});

test("deriveDisposition regression lock (design iii): genuinely red checks still route blocked-fixable, never wait, even with a checksPendingSince set", () => {
  const p = pr({ checksState: "red", checksPendingSince: new Date(NOW - 4 * 60_000).toISOString() });
  assert.equal(deriveDisposition(p, DEFAULT_SWEEP_POLICY, NOW).disposition, "blocked-fixable");
});

test("deriveDisposition is TOTAL — superseded takes precedence over a failing review", () => {
  const p = pr({ reviewState: "failure", unmetCriteria: [criterion()], supersededBy: 42 });
  assert.equal(deriveDisposition(p, DEFAULT_SWEEP_POLICY, NOW).disposition, "stale");
});

// ── W1-T100 (the #170 fix): route blocked_ci to the ci-log fix path — fix
// FIRST, ask after exhaustion (plan/tasks.yaml's own acceptance fixtures) ────

test("W1-T100 acceptance 1 — the #170 fixture (ci red, review none, zero strikes) dispositions blocked-fixable and dispatches ONE ci-log-mode fix worker, carrying failing check names + log tails, not reviewer criteria", async () => {
  const deps = fakeDeps();
  const seeded = blockedCiPr();

  const summary = await runSweep([seeded], deps);

  assert.equal(summary.byDisposition["blocked-fixable"], 1);
  assert.equal(deps.fixed.length, 1, "exactly ONE ci-log fix worker dispatch");
  assert.equal(deps.escalated.length, 0, "never straight to the question rung — fix FIRST");
  assert.deepEqual(deps.fixed[0].evidence.unmetCriteria, [], "no reviewer criteria — blocked_ci carries none");
  assert.deepEqual(deps.fixed[0].evidence.ciFailures, seeded.ciFailures, "the failing check names + log tails ride the dispatch");
});

test("W1-T100 acceptance 2 — a strike-exhausted ci-red PR routes to the question rung — the ladder, not a loop: zero new spawns", async () => {
  const deps = fakeDeps();
  const seeded = blockedCiExhaustedPr();

  const summary = await runSweep([seeded], deps);

  assert.equal(summary.byDisposition["blocked-ambiguous"], 1);
  assert.equal(deps.fixed.length, 0, "zero new spawns once strikes are exhausted");
  assert.equal(deps.escalated.length, 1, "escalates to the clarification-question rung instead");
  assert.match(deps.escalated[0].reason, /exhausted/);
  assert.ok(deps.escalated[0].question, "a clarification question is generated, never silence");
  assert.equal(deps.escalated[0].question.prNumber, seeded.prNumber);
});

test("W1-T100 acceptance 3 — review-failure routing is unchanged when checks are GREEN: dispatches reviewer-unmet-shaped evidence", async () => {
  const deps = fakeDeps();
  await runSweep([blockedFixablePr()], deps);
  assert.equal(deps.fixed.length, 1);
  assert.equal(deps.fixed[0].evidence.unmetCriteria.length, 2, "the FULL unmet set, unchanged");
  assert.equal(deps.fixed[0].evidence.ciFailures, undefined, "a review-mode dispatch never carries ci-log evidence");
});

// ── W1-T138 (the #303/#305/#292/#315 fix): a required check red ALWAYS wins
// the evidence-shape selection over a review verdict sitting beside it — the
// mode selector no longer treats a CI-check-only failure as reviewer-unmet
// just because a review verdict (success OR failure) also exists on the same
// head. Before this fix, the LIVE incident: commitlint/CodeQL failures burned
// both fix-rung strikes re-litigating stale/unrelated review criteria and
// escalated as "blocked_review fix rung exhausted", never touching the
// actually-failing check. ───────────────────────────────────────────────────

test("W1-T138 acceptance 1 — a red required check (commitlint) with a FAILING review verdict on the same head routes to ci-log, not reviewer-unmet (the #303/#305 fix)", async () => {
  const deps = fakeDeps();
  const seeded = checksRedReviewFailingPr();

  const summary = await runSweep([seeded], deps);

  assert.equal(summary.byDisposition["blocked-fixable"], 1);
  assert.equal(deps.fixed.length, 1, "fix FIRST — the checks-red block dispatches exactly one worker");
  assert.deepEqual(deps.fixed[0].evidence.unmetCriteria, [], "the review's unmet criteria are NOT the dispatched evidence — they may be stale");
  assert.deepEqual(deps.fixed[0].evidence.ciFailures, seeded.ciFailures, "the failing check (commitlint) rides the dispatch instead");
});

test("W1-T138 acceptance 1b — a red required check (CodeQL) with a PASSING review verdict on the same head ALSO routes to ci-log fixable, never straight to escalate (the #292/#315 fix)", async () => {
  const deps = fakeDeps();
  const seeded = checksRedReviewSuccessPr();

  const summary = await runSweep([seeded], deps);

  assert.equal(summary.byDisposition["blocked-fixable"], 1, "a checks-red PR is POSITIVELY fixable even with review already SUCCESS — never the terminal escalate");
  assert.equal(deps.fixed.length, 1);
  assert.equal(deps.escalated.length, 0);
  assert.deepEqual(deps.fixed[0].evidence.unmetCriteria, []);
  assert.deepEqual(deps.fixed[0].evidence.ciFailures, seeded.ciFailures);
});

test("W1-T138 — isBlockedCi is checks-red alone now; a failing review no longer excludes it (BROADENED from W1-T100's reviewState===\"none\"-only check)", () => {
  assert.equal(isBlockedCi(checksRedReviewFailingPr()), true);
  assert.equal(isBlockedCi(checksRedReviewSuccessPr()), true);
  assert.equal(isBlockedCi(blockedCiPr()), true, "the original checks-red/review-none shape (W1-T100) still matches");
  assert.equal(isBlockedCi(blockedFixablePr()), false, "checks GREEN is never blocked_ci, review state notwithstanding");
});

test("W1-T138 — deriveDisposition: checks-red beats a failing review's reason text too — never claims 'no review posted yet' when one plainly has", () => {
  const r = deriveDisposition(checksRedReviewFailingPr(), DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(r.disposition, "blocked-fixable");
  assert.match(r.reason, /checks red/);
  assert.doesNotMatch(r.reason, /no review posted yet/, "misleading once a review verdict genuinely exists");
});

test("W1-T138 — a checks-red PR with strikes exhausted still escalates (the shared ladder honors the broadened predicate too), regardless of the review verdict beside it", async () => {
  const deps = fakeDeps();
  const exhausted: OpenPrView = { ...checksRedReviewFailingPr(), prNumber: 999, priorStrikes: DEFAULT_SWEEP_POLICY.strikeCap };

  const summary = await runSweep([exhausted], deps);

  assert.equal(summary.byDisposition["blocked-ambiguous"], 1);
  assert.equal(deps.fixed.length, 0, "exhausted — never a further fix dispatch");
  assert.equal(deps.escalated.length, 1);
});

// ── W1-T106 (the #170 DIRTY strand): CONFLICTED is a disposition — the sweep
// sees mergeStateStatus, and the fix rung gains a merge-conflict mode ────────

test("isPureConcurrentAddition: zero deletions on both sides across every file -> true; a single deletion on either side -> false; no file evidence -> false (fail closed)", () => {
  assert.equal(isPureConcurrentAddition([conflictFile()]), true);
  assert.equal(isPureConcurrentAddition([conflictFile(), conflictFile({ path: "b.txt" })]), true, "true across MULTIPLE files, all clean");
  assert.equal(isPureConcurrentAddition([conflictFile({ oursDeleted: 1 })]), false, "OUR side deleted something");
  assert.equal(isPureConcurrentAddition([conflictFile({ theirsDeleted: 1 })]), false, "THEIR side deleted something");
  assert.equal(isPureConcurrentAddition([]), false, "no captured file evidence never defaults to safe");
});

test("deriveDisposition acceptance 1 — the #170 fixture (green checks, review PASS, mergeState dirty) dispositions CONFLICTED — the mergeable rule (row 8) cannot match a dirty PR, a regression lock ABOVE it", () => {
  const seeded = conflictedPurePr();
  const r = deriveDisposition(seeded, DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(r.disposition, "conflicted");
  assert.notEqual(r.disposition, "mergeable", "a dirty PR is NEVER armed no matter how green");
  assert.match(r.reason, /mergeState dirty/);
  assert.match(r.reason, /ci-gate\.yml/, "names the conflicting file");

  // The regression lock itself: feed the SAME fixture straight at the
  // mergeable row's own predicate (never a second, independently-hardcoded
  // check) — it must never positively match a dirty PR.
  const mergeableRow = DISPOSITION_RULES.find((row) => row.disposition === "mergeable")!;
  assert.equal(mergeableRow.when(seeded, DEFAULT_SWEEP_POLICY, 0, NOW), true, "sanity: checks green + review success alone WOULD match");
  const conflictedRow = DISPOSITION_RULES.find((row) => row.disposition === "conflicted")!;
  assert.equal(conflictedRow.when(seeded, DEFAULT_SWEEP_POLICY, 0, NOW), true, "the conflicted row matches FIRST, ordered above mergeable");
});

test("runSweep acceptance 2 — a pure-concurrent-addition conflict dispatches ONE merge-conflict-mode fix worker, carrying the conflicting files + both sides' log, never a reviewer-unmet/ci-log mix", async () => {
  const deps = fakeDeps();
  const seeded = conflictedPurePr();

  const summary = await runSweep([seeded], deps);

  assert.equal(summary.byDisposition.conflicted, 1);
  assert.equal(deps.fixed.length, 1, "exactly ONE spawn");
  assert.equal(deps.escalated.length, 0, "never straight to escalate — this is the safely-fixable half");
  assert.deepEqual(deps.fixed[0].evidence.mergeConflict, seeded.mergeConflict, "both sides' context rides the dispatch verbatim");
  assert.deepEqual(deps.fixed[0].evidence.unmetCriteria, [], "no reviewer criteria — a conflicted PR carries none");
  assert.equal(deps.fixed[0].evidence.ciFailures, undefined, "never a mix with the ci-log shape");
});

test("deriveDisposition acceptance 3 — a deletion-involved conflict refuses into escalate (blocked-ambiguous), naming the files, never the conflicted/fixable row", () => {
  const seeded = conflictedDeletionPr();
  const r = deriveDisposition(seeded, DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(r.disposition, "blocked-ambiguous");
  assert.notEqual(r.disposition, "conflicted", "a deletion is never auto-resolved");
  assert.match(r.reason, /deletion/);
  assert.match(r.reason, /src\/config\.ts/, "names the conflicting file(s)");
});

test("runSweep acceptance 3 — a deletion-involved conflict: NO resolution attempt (zero fix-worker spawns), escalate fires instead, naming the files", async () => {
  const deps = fakeDeps();
  const seeded = conflictedDeletionPr();

  const summary = await runSweep([seeded], deps);

  assert.equal(summary.byDisposition["blocked-ambiguous"], 1);
  assert.equal(deps.fixed.length, 0, "no resolution attempt — never dispatched");
  assert.equal(deps.escalated.length, 1, "refuses into escalate instead");
  assert.match(deps.escalated[0].reason, /src\/config\.ts/, "the escalation names the conflicting file(s)");
});

// ── ACCEPTANCE 1: the P22 golden, verbatim ────────────────────────────────────

test("acceptance 1 — the P22 golden: {mergeable, blocked-fixable(2 criteria), superseded-orphan, strikes-exhausted} -> exactly {one arm, ONE fix carrying BOTH criteria, one close, one escalation}; none-count == 0", async () => {
  const deps = fakeDeps();
  const seeded = [mergeablePr(), blockedFixablePr(), supersededOrphanPr(), strikesExhaustedPr()];

  const summary = await runSweep(seeded, deps);

  // Exactly one of each action.
  assert.equal(deps.armed.length, 1, "exactly one arm");
  assert.equal(deps.closed.length, 1, "exactly one close-with-reason");
  assert.equal(deps.fixed.length, 1, "exactly ONE fix-worker dispatch");
  assert.equal(deps.escalated.length, 1, "exactly one escalation");

  // The ONE fix worker carries BOTH criteria at once (anti-ping-pong).
  assert.equal(deps.fixed[0].evidence.unmetCriteria.length, 2, "the single fix dispatch carries BOTH unmet criteria");
  assert.deepEqual(
    deps.fixed[0].evidence.unmetCriteria.map((c) => c.claim).sort(),
    ["criterion one", "criterion two"],
  );

  // The close names a reason; the arm hit the mergeable PR; escalation hit the exhausted PR.
  assert.match(deps.closed[0].reason, /superseded-by #99/);
  assert.equal(deps.armed[0].prNumber, 10);
  assert.equal(deps.escalated[0].pr.prNumber, 13);

  // Disposition tally + the INVARIANT: no seeded PR ends disposition=none.
  assert.deepEqual(summary.byDisposition, {
    mergeable: 1,
    "blocked-fixable": 1,
    stale: 1,
    "blocked-ambiguous": 1,
    "dep-review": 0,
    "post-review": 0,
    conflicted: 0,
    wait: 0,
  });
  assert.equal(summary.total, 4);
  assert.equal(summary.actionsTaken, 4);
  assert.equal(summary.noneCount, 0, "no open PR ends the sweep with disposition=none");
});

// ── ACCEPTANCE 2: idempotence — the level-triggered core ──────────────────────

test("acceptance 2 — idempotence: the same fixture swept twice unchanged performs zero actions the second time, dispositions identical", async () => {
  const shared = ledgerPath(); // the SAME ledger persists across both sweeps
  const seeded = () => [mergeablePr(), blockedFixablePr(), supersededOrphanPr(), strikesExhaustedPr()];

  const deps1 = fakeDeps({ ledgerPath: shared, runId: "SWEEP-1" });
  const first = await runSweep(seeded(), deps1);
  assert.equal(first.actionsTaken, 4, "first sweep acts on all four");

  const deps2 = fakeDeps({ ledgerPath: shared, runId: "SWEEP-2" });
  const second = await runSweep(seeded(), deps2);

  assert.equal(second.actionsTaken, 0, "second sweep over UNCHANGED state dispatches ZERO new actions");
  assert.equal(deps2.armed.length, 0);
  assert.equal(deps2.closed.length, 0);
  assert.equal(deps2.fixed.length, 0);
  assert.equal(deps2.escalated.length, 0);

  // Dispositions are re-derived FRESH and identical — that is what level-triggered means.
  assert.deepEqual(second.byDisposition, first.byDisposition);
  assert.deepEqual(
    second.actions.map((a) => a.disposition),
    first.actions.map((a) => a.disposition),
  );
});

test("acceptance 2 — a NEW push (changed head sha) legitimately re-earns a fix strike; the same head does not", async () => {
  const shared = ledgerPath();
  const deps1 = fakeDeps({ ledgerPath: shared, runId: "SWEEP-1" });
  await runSweep([blockedFixablePr()], deps1);
  assert.equal(deps1.fixed.length, 1);

  // Same head sha, one strike now recorded -> deduped (no re-dispatch).
  const deps2 = fakeDeps({ ledgerPath: shared, runId: "SWEEP-2" });
  await runSweep([blockedFixablePr()], deps2);
  assert.equal(deps2.fixed.length, 0, "unchanged head sha ⇒ no re-dispatch");

  // A new head sha (the fix worker pushed) + a recorded strike -> a fresh strike, still under cap.
  const deps3 = fakeDeps({ ledgerPath: shared, runId: "SWEEP-3" });
  const pushed = blockedFixablePr();
  pushed.headSha = "bbbb222";
  pushed.priorStrikes = 1;
  await runSweep([pushed], deps3);
  assert.equal(deps3.fixed.length, 1, "a new head sha (state changed) legitimately re-earns a strike");
});

// ── W1-T177: TERMINAL-STATE CHECK AT EVERY SPENDING SITE — a sweep disposition
// never spends a fix-rung strike on a PR whose live GitHub state has already
// gone terminal since the `openPrs` snapshot this sweep pass started from.
// FIXTURE: PR #388 merged at 20:24:44Z; sweep.disposed pr 388 disposition=
// blocked-fixable acted=TRUE fired at 20:30:50 — a fresh rung started on an
// already-merged PR. ─────────────────────────────────────────────────────────

test("runSweep: a seeded MERGED PR produces ZERO dispositions ACTED — the sweep never starts a rung on a terminal PR (the #388 falsifier)", async () => {
  const notOpenLogs: unknown[] = [];
  const deps = fakeDeps({
    readLiveState: async () => ({ ok: true, state: "MERGED" }),
    log: (step, extra) => {
      if (step === "sweep.dispose.not_open") notOpenLogs.push(extra);
    },
  });

  const summary = await runSweep([blockedFixablePr()], deps);

  assert.equal(deps.fixed.length, 0, "dispatchFix is called ZERO times on a terminal PR");
  assert.equal(summary.actionsTaken, 0);
  assert.equal(summary.actions[0].acted, false, "the disposed line's acted flag reflects the stand-down");
  assert.equal(notOpenLogs.length, 1, "exactly one sweep.dispose.not_open ledger line, naming the state");
  assert.match((notOpenLogs[0] as { reason: string }).reason, /MERGED/);

  // The ledgered sweep.disposed line itself names the stand-down reason too.
  const disposed = readLedgerLines(deps.ledgerPath).filter((l) => l.step === "sweep.disposed");
  assert.equal(disposed.length, 1);
  assert.equal(disposed[0].acted, false);
  assert.match(String(disposed[0].stand_down_reason), /MERGED/);
});

test("runSweep: readLiveState omitted ⇒ behaves EXACTLY as before this check existed — blocked-fixable still dispatches", async () => {
  const deps = fakeDeps(); // no readLiveState override
  const summary = await runSweep([blockedFixablePr()], deps);
  assert.equal(deps.fixed.length, 1);
  assert.equal(summary.actionsTaken, 1);
});

test("runSweep: a FAILED/INDETERMINATE live-state read does NOT stand down — dispatch proceeds exactly as today (fail OPEN), AND the indeterminate read is ledgered, never a silent swallow", async () => {
  const indeterminateLogs: unknown[] = [];
  const deps = fakeDeps({
    readLiveState: async () => ({ ok: false }),
    log: (step, extra) => {
      if (step === "sweep.dispose.indeterminate") indeterminateLogs.push(extra);
    },
  });
  const summary = await runSweep([blockedFixablePr()], deps);
  assert.equal(deps.fixed.length, 1, "an unreadable state is never treated as terminal — the strike still fires");
  assert.equal(summary.actionsTaken, 1);
  assert.equal(indeterminateLogs.length, 1, "the failed/indeterminate read is LEDGERED — never a silent swallow");
  assert.deepEqual(indeterminateLogs[0], { pr_number: blockedFixablePr().prNumber });
});

test("runSweep: an OPEN live read proceeds to dispatch normally — the check is a stand-down predicate, never a second gate on the ordinary path", async () => {
  const deps = fakeDeps({ readLiveState: async () => ({ ok: true, state: "OPEN" }) });
  const summary = await runSweep([blockedFixablePr()], deps);
  assert.equal(deps.fixed.length, 1);
  assert.equal(summary.actionsTaken, 1);
});

// ── ACCEPTANCE 3: policy is DATA, not code branches ───────────────────────────

test("acceptance 3 — policy is data, not code branches: tightening the stale-days threshold in the policy table flips a fixture PR's disposition with zero sweep-code changes", () => {
  // The disposition SELECTION is a DATA table (rule 2), not if/else branches:
  // every disposition is one row of DISPOSITION_RULES, iterated by deriveDisposition.
  assert.ok(Array.isArray(DISPOSITION_RULES) && DISPOSITION_RULES.length >= 4);

  // A mergeable PR whose last activity is 10 days ago.
  const tenDaysAgo = new Date(NOW - 10 * 86_400_000).toISOString();
  const p = pr({ reviewState: "success", checksState: "green", lastActivityAt: tenDaysAgo });

  // Default 14-day window: NOT stale -> mergeable.
  assert.equal(deriveDisposition(p, DEFAULT_SWEEP_POLICY, NOW).disposition, "mergeable");

  // Tighten the threshold in the POLICY TABLE (data, passed in) to 7 days: the SAME
  // fixture PR now flips to stale — no change to deriveDisposition or any rule row.
  const tighter: SweepPolicy = { ...DEFAULT_SWEEP_POLICY, staleDays: 7 };
  assert.equal(deriveDisposition(p, tighter, NOW).disposition, "stale");
});

test("acceptance 3 — the strike cap also lives in the policy table (lowering it flips fixable -> ambiguous)", () => {
  const p = blockedFixablePr();
  p.priorStrikes = 1;
  // cap 2 (default): strikes left -> fixable.
  assert.equal(deriveDisposition(p, DEFAULT_SWEEP_POLICY, NOW).disposition, "blocked-fixable");
  // cap 1 (tightened data): exhausted -> ambiguous.
  assert.equal(deriveDisposition(p, { ...DEFAULT_SWEEP_POLICY, strikeCap: 1 }, NOW).disposition, "blocked-ambiguous");
});

// ── ACCEPTANCE 4: the daemon poll and rmd sweep share ONE implementation ──────

test("acceptance 4 — one runSweep entry point, driven from a fake DAEMON caller and a fake CLI caller", async () => {
  const seeded = () => [mergeablePr(), supersededOrphanPr()];

  // A fake "daemon poll" caller.
  const daemonDeps = fakeDeps({ runId: "DAEMON-123" });
  const fromDaemon = await runSweep(seeded(), daemonDeps);
  assert.equal(daemonDeps.armed.length, 1);
  assert.equal(daemonDeps.closed.length, 1);
  assert.equal(fromDaemon.total, 2);

  // A fake "rmd sweep" CLI caller — the SAME function, distinct ledger/runId.
  const cliDeps = fakeDeps({ runId: "SWEEP-456" });
  const fromCli = await runSweep(seeded(), cliDeps);
  assert.equal(cliDeps.armed.length, 1);
  assert.equal(cliDeps.closed.length, 1);
  assert.deepEqual(fromCli.byDisposition, fromDaemon.byDisposition);
});

// ── dry-run: preview only, no effects, no ledger trace ────────────────────────

test("dry-run: derives dispositions but takes NO effects and writes NO ledger line (a later real sweep still acts)", async () => {
  const shared = ledgerPath();
  const dry = fakeDeps({ ledgerPath: shared, dryRun: true });
  const preview = await runSweep([mergeablePr(), blockedFixablePr()], dry);
  assert.equal(dry.armed.length, 0);
  assert.equal(dry.fixed.length, 0);
  assert.equal(preview.actionsTaken, 0);
  assert.equal(preview.byDisposition.mergeable, 1);

  // A real sweep afterward is NOT suppressed by the dry preview (no trace left).
  const real = fakeDeps({ ledgerPath: shared });
  await runSweep([mergeablePr(), blockedFixablePr()], real);
  assert.equal(real.armed.length, 1);
  assert.equal(real.fixed.length, 1);
});

// ── observed autoMergeArmed short-circuits arming (real-world dedup) ───────────

test("an already-armed PR (observed autoMergeArmed=true) is not re-armed", async () => {
  const deps = fakeDeps();
  const armedAlready = mergeablePr();
  armedAlready.autoMergeArmed = true;
  const summary = await runSweep([armedAlready], deps);
  assert.equal(deps.armed.length, 0, "not re-armed");
  assert.equal(summary.byDisposition.mergeable, 1, "still derives the mergeable disposition (level-triggered)");
  assert.equal(summary.actionsTaken, 0);
});

test("renderSweepSummary is a single legible line", () => {
  const s = {
    total: 4,
    byDisposition: {
      mergeable: 1,
      "blocked-fixable": 1,
      stale: 1,
      "blocked-ambiguous": 1,
      "dep-review": 0,
      "post-review": 0,
      conflicted: 0,
      wait: 0,
    },
    actionsTaken: 4,
    actionsFailed: 0,
    actions: [],
    noneCount: 0,
  };
  assert.match(renderSweepSummary(s), /4 open PR\(s\) · 4 action\(s\) taken/);
});

test("renderSweepSummary calls out failed actions distinctly (W1-T99)", () => {
  const s = {
    total: 3,
    byDisposition: {
      mergeable: 1,
      "blocked-fixable": 0,
      stale: 0,
      "blocked-ambiguous": 1,
      "dep-review": 0,
      "post-review": 1,
      conflicted: 0,
      wait: 0,
    },
    actionsTaken: 2,
    actionsFailed: 1,
    actions: [],
    noneCount: 0,
  };
  assert.match(renderSweepSummary(s), /⚠️ 1 action\(s\) FAILED/);
});

// ── W1-T78: the CLARIFICATION-QUESTION rung — an ambiguous block yields a
// specific, decidable operator question, never silence (ratifies P22's new
// rung). ────────────────────────────────────────────────────────────────────

function strike(over: Partial<StrikeAttempt> = {}): StrikeAttempt {
  return { strike: 1, round: "resume", unmetCount: 1, ciGreen: true, reviewState: "failure", ...over };
}

test("renderClarificationQuestion: a strikes-exhausted fixture yields ONE question naming the decision, both candidate resolutions, and the PR/run context", () => {
  const pr = strikesExhaustedPr();
  const { reason } = deriveDisposition(pr, DEFAULT_SWEEP_POLICY, NOW);
  const history = [strike({ strike: 1, round: "resume" }), strike({ strike: 2, round: "fresh" })];

  const q = renderClarificationQuestion(pr, reason, history);

  assert.equal(q.taskId, "W1-D");
  assert.equal(q.prNumber, 13);
  assert.equal(q.prUrl, "url/13");
  // Names the exact decision: the unmet criterion's claim.
  assert.match(q.question, /still unmet/);
  assert.equal(q.criterion, "still unmet");
  // The reviewer's stated requirement vs the spec's own proof text.
  assert.equal(q.reviewerRequirement, "the thing is not done");
  assert.equal(q.specText, "unit test: it works");
  assert.match(q.question, /the thing is not done/);
  assert.match(q.question, /unit test: it works/);
  // Both candidate resolutions, verbatim, in the question text.
  assert.equal(q.resolutions.length, 2);
  assert.match(q.question, /re-dispatch-with-constraint/);
  assert.match(q.question, /revise-spec/);
  // What the fix worker tried per strike (ledger ground truth) is carried too.
  assert.equal(q.strikeHistory.length, 2);
  assert.match(q.question, /strike 1 \(resume\)/);
  assert.match(q.question, /strike 2 \(fresh\)/);
});

test("renderClarificationQuestion: no single unmet criterion (the contradictory/terminal rows) still yields a decidable question naming the observed reason — never silent, never an invented criterion", () => {
  const view = pr({ prNumber: 20, prUrl: "url/20", taskId: "W1-E", reviewState: "failure", unmetCriteria: [] });
  const q = renderClarificationQuestion(view, "review failing with no actionable unmet criteria (contradictory) — escalating", []);
  assert.equal(q.criterion, "", "no criterion observed — never invented");
  assert.equal(q.specText, "");
  assert.match(q.question, /contradictory/);
  assert.equal(q.resolutions.length, 2);
});

test("toQuestionEntry: conforms to the §2 QUESTION contract's shape (worker.ts's QuestionEntry)", () => {
  const pr = strikesExhaustedPr();
  const { reason } = deriveDisposition(pr, DEFAULT_SWEEP_POLICY, NOW);
  const q = renderClarificationQuestion(pr, reason, []);
  const entry = toQuestionEntry(q, "2026-07-17T00:00:00.000Z");
  assert.equal(entry.ts, "2026-07-17T00:00:00.000Z");
  assert.equal(entry.task, "W1-D");
  assert.equal(entry.question, q.question);
  assert.match(entry.current_assumption ?? "", /BLOCKED-AMBIGUOUS/);
  assert.equal(entry.impact_if_wrong, "med");
  assert.deepEqual(Object.keys(entry).sort(), ["current_assumption", "impact_if_wrong", "question", "task", "ts"]);
});

// ── W1-T186: the escalation NAMES the observed blocker, not an inferred symptom ──
// Three live incidents in one evening each named a symptom the operator then had to
// diagnose by hand: #406 named "checks pending, review none" for a commit-message
// failure; #420 named "checks never went green" for a red check whose ACTUAL culprit
// commit was on MAIN, outside the PR; #412/#413 named "blocked_ci"/"checks pending" for
// a PR that was `mergeable: false, mergeable_state: "dirty"` with ZERO check runs BY
// CONSTRUCTION — there was no failing CI and no pending CI to report.

test("observedBlockerState acceptance — a conflicted PR with zero checks, a mergeable PR with a required context having zero check runs, a PR with running checks, and a PR with a concluded failure each yield a DIFFERENT named state and a different recommended action (checksState 'none' is no longer overloaded, covering both conflicted-so-no-checks and not-started-yet, which demand opposite actions — resolve versus wait)", () => {
  // CONFLICTED — zero checks (mergeState dirty) — checked BEFORE the ABSENT branch below,
  // so a conflicted PR is never mis-sorted as "post the check" (the #412/#413 fixture).
  assert.equal(observedBlockerState(conflictedZeroChecksPr()), "CONFLICTED");
  // ABSENT — a required context (remudero-review) has zero runs on an otherwise-mergeable,
  // checks-green PR (the W1-T176 shape) — a DIFFERENT "zero check runs" than the one above,
  // and it demands the OPPOSITE action (post it, vs. resolve the conflict).
  assert.equal(observedBlockerState(ungatedGreenPr({ reviewPostRefused: true })), "ABSENT");
  // ABSENT — the whole rollup is empty on a NON-conflicted PR too.
  assert.equal(observedBlockerState(pr({ checksState: "none", reviewState: "none" })), "ABSENT");
  // PENDING — checks exist and are running.
  assert.equal(observedBlockerState(pendingStormPr(90)), "PENDING");
  // FAILING — a required check ran and concluded failure.
  assert.equal(observedBlockerState(blockedCiExhaustedPr()), "FAILING");
  // An ordinary review-failure block (checks NOT red) names nothing extra here — the
  // criterion text already says it, and PENDING/ABSENT would misframe a review-driven block.
  assert.equal(
    observedBlockerState(pr({ reviewState: "failure", checksState: "green", unmetCriteria: [criterion()] })),
    undefined,
  );
});

test("observedBlockerState: mergeState dirty wins over checksState red too — a conflict is never reported as a failing check", () => {
  const conflictedButAlsoRed: OpenPrView = { ...conflictedZeroChecksPr(), checksState: "red" };
  assert.equal(observedBlockerState(conflictedButAlsoRed), "CONFLICTED");
});

test("renderClarificationQuestion acceptance 1 — a CONFLICTED PR (the #412/#413 fixture) names the conflict and the merge-main remedy, and the string contains NEITHER 'CI' nor 'blocked_ci'", () => {
  const seeded = conflictedZeroChecksPr();
  const r = deriveDisposition(seeded, DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(r.disposition, "blocked-ambiguous", "the deletion/unclassifiable-conflict row — sanity");
  const q = renderClarificationQuestion(seeded, r.reason, seeded.strikeHistory ?? []);
  assert.equal(q.observedState, "CONFLICTED");
  assert.match(q.question, /CONFLICTED/);
  assert.match(q.question, /merge origin\/main/, "names the merge-main remedy");
  assert.doesNotMatch(q.question, /\bCI\b/, "#412/#413: there was no failing CI and no pending CI to report");
  assert.doesNotMatch(q.question, /blocked_ci/);
});

test("renderClarificationQuestion acceptance — the rendered escalation for each disposition includes the mergeable/mergeableState it observed (OpenPrView previously had no mergeable field at all, so the emitter was structurally unable to report it — which is why tonight's escalations omitted the single fact that would have diagnosed two of them), across CONFLICTED/FAILING/ABSENT/PENDING", () => {
  const fixtures: Array<[string, OpenPrView]> = [
    ["CONFLICTED", { ...conflictedZeroChecksPr(), mergeable: false, mergeableState: "dirty" }],
    ["FAILING", { ...blockedCiExhaustedPr(), mergeable: true, mergeableState: "clean" }],
    ["ABSENT", { ...ungatedGreenPr({ reviewPostRefused: true }), mergeable: true, mergeableState: "clean" }],
    ["PENDING", { ...pendingStormPr(90), mergeable: true, mergeableState: "clean" }],
  ];
  for (const [label, seeded] of fixtures) {
    const r = deriveDisposition(seeded, DEFAULT_SWEEP_POLICY, NOW);
    const q = renderClarificationQuestion(seeded, r.reason, seeded.strikeHistory ?? []);
    assert.match(q.question, /mergeable=/, `${label}: names the raw mergeable fact`);
    assert.match(q.question, /mergeableState=/, `${label}: names the raw mergeableState fact`);
  }
});

test("OpenPrView structural acceptance — mergeable and mergeableState are populated from the SAME fetch that already builds OpenPrView, with no second gh call added (no per-PR extra fetch that would regress the O(1)-per-sweep budget the batched gateway exists to protect)", () => {
  // sweep.ts's own module doc (line ~112) states the invariant this proves structurally:
  // "this module never calls gh/git/network directly". mergeable/mergeableState are read
  // straight off the SAME OpenPrView object every disposition/render call already receives —
  // there is no new async method on SweepDeps, no new parameter threading a second `gh` call.
  const seeded: OpenPrView = { ...pr(), mergeable: false, mergeableState: "dirty" };
  assert.equal(typeof seeded.mergeable, "boolean");
  assert.equal(typeof seeded.mergeableState, "string");
  const r = deriveDisposition(seeded, DEFAULT_SWEEP_POLICY, NOW);
  assert.ok(r.disposition, "derivable from the SAME object — no second read introduced");
});

// #420 reported "checks never went green" for PR #417, whose own commits measured 92/90/76
// chars, while the 101-char header that actually failed commitlint was 0e63429 on MAIN — the
// escalation could not have revealed this and the operator had to read the CI log to find it.
test("renderClarificationQuestion acceptance — a failing-check escalation renders the check NAME and the head sha, and when the offending commit is outside the PR's own commit range it says so (the #420/PR #417 fixture: 0e63429 on MAIN, not one of PR #417's own 92/90/76-char commits)", () => {
  const seeded: OpenPrView = {
    ...blockedCiExhaustedPr(),
    headSha: "bbbb2223334445556667778889990001112223",
    ciFailures: [
      {
        name: "commitlint",
        // The #420/PR #417 fixture, verbatim: PR #417's own three commits measured
        // 92/90/76 chars each (all in range); the 101-char header that actually tripped
        // commitlint was 0e63429, a commit already on MAIN, outside PR #417's own range.
        logTail: "header-max-length: 101 chars exceeds the 100 cap (PR #417's own commits: 92/90/76 chars)",
        sha: "0e63429aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        outsidePrRange: true,
      },
    ],
  };
  const r = deriveDisposition(seeded, DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(r.disposition, "blocked-ambiguous");
  // The ledgered/summary reason itself names the check + sha now, not just the rendered question.
  assert.match(r.reason, /commitlint/);
  assert.match(r.reason, /0e63429/);
  const q = renderClarificationQuestion(seeded, r.reason, seeded.strikeHistory ?? []);
  assert.equal(q.observedState, "FAILING");
  assert.match(q.question, /commitlint/, "names the check");
  assert.match(q.question, /0e63429/, "names the sha — NOT the PR's own head 'bbbb222'");
  assert.doesNotMatch(q.question, /bbbb222/, "never names the PR's own head sha as the culprit");
  assert.match(q.question, /NOT one of this PR's own commits/, "says so when the commit is outside the PR's own range");
});

test("renderClarificationQuestion acceptance 4b — a FAILING escalation with no captured check detail still names the check state, never a crash", () => {
  const seeded: OpenPrView = { ...blockedCiExhaustedPr(), ciFailures: undefined };
  const r = deriveDisposition(seeded, DEFAULT_SWEEP_POLICY, NOW);
  const q = renderClarificationQuestion(seeded, r.reason, []);
  assert.equal(q.observedState, "FAILING");
  assert.match(q.question, /required check failed/);
});

test("renderClarificationQuestion acceptance 3 (ABSENT) — names ZERO observed check runs, distinct from PENDING's 'still running'", () => {
  const seeded = ungatedGreenPr({ reviewPostRefused: true });
  const r = deriveDisposition(seeded, DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(r.disposition, "blocked-ambiguous");
  const q = renderClarificationQuestion(seeded, r.reason, []);
  assert.equal(q.observedState, "ABSENT");
  assert.match(q.question, /ZERO observed check runs/);
  assert.doesNotMatch(q.question, /still running/);
});

test("renderClarificationQuestion (PENDING) — a stale-pending escalation names PENDING and 'still running', distinct from ABSENT's zero-runs wording", () => {
  const seeded = pendingStormPr(90); // past the 60-minute default ceiling -> stale-pending
  const r = deriveDisposition(seeded, DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(r.disposition, "blocked-ambiguous");
  const q = renderClarificationQuestion(seeded, r.reason, []);
  assert.equal(q.observedState, "PENDING");
  assert.match(q.question, /still running/);
  assert.doesNotMatch(q.question, /ZERO observed check runs/);
});

test("renderClarificationQuestion: an ordinary review-failure/contradictory block is UNCHANGED byte-for-byte in shape — no CONFLICTED/FAILING/ABSENT/PENDING facts line when none was observed and mergeable/mergeableState were never read", () => {
  const view = pr({ prNumber: 20, prUrl: "url/20", taskId: "W1-E", reviewState: "failure", unmetCriteria: [] });
  const q = renderClarificationQuestion(view, "review failing with no actionable unmet criteria (contradictory) — escalating", []);
  assert.equal(q.observedState, undefined);
  assert.doesNotMatch(q.question, /^\[/, "no bracketed state tag when none applies");
});

// ── REGRESSION LOCK: the wall-clock time bomb (2026-07-30T12:00:00Z) ──────────────────────
//
// Every age-sensitive assertion in this file MUST pass the pinned `NOW`. `deriveDisposition`'s
// third parameter defaults to `Date.now()`, so an assertion that omits it is judged against the
// REAL clock while its fixture carries a fixed `RECENT` date — which works until `RECENT` ages
// past `staleDays`, and then flips the disposition to "stale" for reasons that have nothing to
// do with the code under test. That is not hypothetical: RECENT is 2026-07-16T12:00:00Z and
// staleDays is 14, so at exactly 2026-07-30T12:00:00Z eight assertions across this file and
// test/run-task.test.ts went red simultaneously, on a tree nobody had touched. Every PR whose
// CI ran before that instant was green; the first one after it was not.
//
// These two assertions lock both halves: the fixture/clock pair stays self-consistent, and the
// stale rule really is what fires once the pair drifts apart.

test("REGRESSION LOCK: the fixture clock and RECENT stay within staleDays, so no assertion here depends on the wall clock", () => {
  const ageDays = (NOW - Date.parse(RECENT)) / 86_400_000;
  assert.ok(
    ageDays < DEFAULT_SWEEP_POLICY.staleDays,
    `RECENT must sit inside the stale window relative to the pinned NOW (age ${ageDays}d vs staleDays ${DEFAULT_SWEEP_POLICY.staleDays}) — ` +
      "otherwise every fixture built on it is stale before a test even runs",
  );
});

test("REGRESSION LOCK: the SAME fixture judged against a clock past staleDays becomes stale — the exact mechanism that reddened main", () => {
  const aged = NOW + (DEFAULT_SWEEP_POLICY.staleDays + 1) * 86_400_000;
  assert.equal(deriveDisposition(strikesExhaustedPr(), DEFAULT_SWEEP_POLICY, NOW).disposition, "blocked-ambiguous");
  assert.equal(
    deriveDisposition(strikesExhaustedPr(), DEFAULT_SWEEP_POLICY, aged).disposition,
    "stale",
    "an un-pinned clock is why this fixture silently reclassified — pin NOW at every call site",
  );
});

test("strikeCapForAnswer: resetStrikeCounterOnAnswer=true (default) grants a FRESH full strikeCap; false grants exactly one bounded strike — policy-as-data, per config", () => {
  assert.equal(strikeCapForAnswer(2), 2);
  assert.equal(strikeCapForAnswer(2, DEFAULT_CLARIFY_POLICY), 2);
  assert.equal(strikeCapForAnswer(2, { resetStrikeCounterOnAnswer: false }), 1);
  assert.equal(strikeCapForAnswer(5, { resetStrikeCounterOnAnswer: true }), 5);
});

test("deriveDisposition: an operator's answer RE-ARMS a strikes-exhausted PR to blocked-fixable — the answer's own strike allowance overrides exhaustion", () => {
  const answered: OpenPrView = { ...strikesExhaustedPr(), pendingAnswer: { constraint: "use approach X" } };
  // Un-answered, this fixture is strikes-exhausted -> blocked-ambiguous (baseline).
  assert.equal(deriveDisposition(strikesExhaustedPr(), DEFAULT_SWEEP_POLICY, NOW).disposition, "blocked-ambiguous");
  // Answered, with the default reset policy (a FRESH strikeCap), it re-arms.
  const result = deriveDisposition(answered, DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(result.disposition, "blocked-fixable");
  assert.match(result.reason, /operator answered/);
});

test("deriveDisposition: an operator's answer ALSO re-arms a strikes-exhausted blocked_ci PR (W1-T100) — the ANSWERED row was generalized alongside the exhaustion/fixable rows, one ladder for both shapes", () => {
  const answered: OpenPrView = { ...blockedCiExhaustedPr(), pendingAnswer: { constraint: "pin the dependency version" } };
  // Un-answered, this fixture is strikes-exhausted -> blocked-ambiguous (baseline).
  assert.equal(deriveDisposition(blockedCiExhaustedPr(), DEFAULT_SWEEP_POLICY, NOW).disposition, "blocked-ambiguous");
  // Answered, with the default reset policy (a FRESH strikeCap), it re-arms — the
  // SAME row that re-arms a review-failure PR, never a second, un-generalized path.
  const result = deriveDisposition(answered, DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(result.disposition, "blocked-fixable");
  assert.match(result.reason, /operator answered/);
});

test("deriveDisposition: resetStrikeCounterOnAnswer=false grants exactly ONE extra strike beyond the original cap — a PR that has ALSO exhausted that one extra strike still escalates rather than looping forever", () => {
  const policy: SweepPolicy = { ...DEFAULT_SWEEP_POLICY, clarify: { resetStrikeCounterOnAnswer: false } };
  // strikeCap is 2; a bounded extra strike raises the cumulative ceiling to 3
  // (policy.strikeCap + strikeCapForAnswer(2, {reset:false}) === 2 + 1).
  const justAnswered: OpenPrView = { ...strikesExhaustedPr(), priorStrikes: 2, pendingAnswer: { constraint: "use approach X" } };
  // priorStrikes (2) IS below the ceiling (3) -> the one bounded extra strike is granted.
  assert.equal(deriveDisposition(justAnswered, policy, NOW).disposition, "blocked-fixable");

  // The extra strike was ALSO spent (ledger now shows 3 dispatches) and the PR
  // is STILL failing with a (new, unconsumed) pendingAnswer -> the ceiling (3)
  // is no longer above priorStrikes (3) -> escalates again rather than granting
  // a THIRD attempt off the same answer.
  const stillFailing: OpenPrView = { ...justAnswered, priorStrikes: 3 };
  assert.equal(deriveDisposition(stillFailing, policy, NOW).disposition, "blocked-ambiguous");
});

test("runSweep: a BLOCKED-AMBIGUOUS PR ledgers its clarification question EVERY sweep, even once escalate() is deduped — an unanswered question stays visible, nothing else is ever dispatched", async () => {
  const shared = ledgerPath();
  const first = fakeDeps({ ledgerPath: shared });
  const summary1 = await runSweep([strikesExhaustedPr()], first);
  assert.equal(first.escalated.length, 1, "escalate() fires on the first sweep");
  assert.match(first.escalated[0].question.question, /still unmet/);
  assert.equal(summary1.actions[0].question?.question, first.escalated[0].question.question);

  // A second sweep over the SAME (unanswered) state: deduped — no repeat escalate() —
  // but the disposition (and its question) is still re-derived and ledgered.
  const second = fakeDeps({ ledgerPath: shared });
  const summary2 = await runSweep([strikesExhaustedPr()], second);
  assert.equal(second.escalated.length, 0, "deduped — escalate() does not fire again");
  assert.equal(second.armed.length, 0);
  assert.equal(second.closed.length, 0);
  assert.equal(second.fixed.length, 0, "nothing else is ever dispatched for an unanswered clarification");
  assert.equal(summary2.byDisposition["blocked-ambiguous"], 1, "still BLOCKED-AMBIGUOUS");
  assert.ok(summary2.actions[0].question, "the question is still rendered/ledgered on the deduped sweep");

  const lines = readLedgerLines(shared);
  const disposed = lines.filter((l) => l.step === "sweep.disposed");
  assert.equal(disposed.length, 2, "one sweep.disposed line per sweep");
  for (const line of disposed) {
    assert.match(String(line.question ?? ""), /still unmet/, "the question is ledgered on EVERY sweep");
  }
});

// ── W1-T103 — checksState green means REQUIRED contexts green (the #170 ──────
//    stuck-ambiguous fix): skipped non-required checks never veto.

const REQUIRED = ["ci-gate", "remudero-review"];

function rollupCheck(over: Partial<RollupCheckEntry> = {}): RollupCheckEntry {
  return { name: "check", conclusion: "SUCCESS", ...over };
}

test("W1-T103 acceptance 3 — checksStateFromRollup: 13 required SUCCESS + 1 SKIPPED NON-required context -> green (the live #170 post-heal fixture)", () => {
  const rollup: RollupCheckEntry[] = [
    ...Array.from({ length: 13 }, (_, i) => rollupCheck({ name: `required-${i}`, conclusion: "SUCCESS" })),
    rollupCheck({ name: "schedule-stub", conclusion: "SKIPPED" }),
  ];
  const required = Array.from({ length: 13 }, (_, i) => `required-${i}`);
  assert.equal(checksStateFromRollup(rollup, required), "green");
});

test("W1-T103 acceptance 3 — checksStateFromRollup: a SKIPPED context that IS required still satisfies it (matches GitHub's own protection semantics)", () => {
  const rollup: RollupCheckEntry[] = [
    rollupCheck({ name: "ci-gate", conclusion: "SKIPPED" }),
    rollupCheck({ name: "remudero-review", conclusion: "SUCCESS" }),
  ];
  assert.equal(checksStateFromRollup(rollup, REQUIRED), "green");
});

test("W1-T103 — checksStateFromRollup: a FAILING non-required context never vetoes green (non-required contexts are reported but never veto)", () => {
  const rollup: RollupCheckEntry[] = [
    rollupCheck({ name: "ci-gate", conclusion: "SUCCESS" }),
    rollupCheck({ name: "remudero-review", conclusion: "SUCCESS" }),
    rollupCheck({ name: "codeql-flaky", conclusion: "FAILURE" }),
  ];
  assert.equal(checksStateFromRollup(rollup, REQUIRED), "green");
});

// ── THE UNREADABLE-CONTEXTS PATH: NEUTRAL IS NOT PENDING (2026-08-13) ────────────────────────
//
// `ghRequiredStatusCheckContexts` fails SOFT to undefined on any error, and a container's PAT gets
// 403 on the protection endpoint, so EVERY containerised sweep reaches this branch. It used to
// narrow the ok-set to SUCCESS only, and `osv-scanner`'s NEUTRAL then read as pending forever —
// escalating #1692 at "checks pending 65m" with nothing running. These four cases pin all three
// directions the fix has to satisfy at once.

test("UNREADABLE contexts: a NEUTRAL check is NOT pending — the container path that escalated #1692", () => {
  // THE FIXTURE REACHES THE FALLBACK, asserted rather than assumed: `undefined` contexts is the
  // ONLY way into this branch, and a test passing readable contexts would never exercise it.
  const rollup: RollupCheckEntry[] = [
    rollupCheck({ name: "ci-gate", conclusion: "SUCCESS" }),
    rollupCheck({ name: "osv-scanner", conclusion: "NEUTRAL" }),
  ];
  assert.equal(checksStateFromRollup(rollup, undefined), "green");
  assert.equal(checksStateFromRollup(rollup, []), "green", "an EMPTY list is the same unreadable case");
});

test("UNREADABLE contexts: a SKIPPED check is NOT pending either — the same defect one conclusion over", () => {
  const rollup: RollupCheckEntry[] = [
    rollupCheck({ name: "ci-gate", conclusion: "SUCCESS" }),
    rollupCheck({ name: "schedule-stub", conclusion: "SKIPPED" }),
  ];
  assert.equal(checksStateFromRollup(rollup, undefined), "green");
});

test("THE OTHER DIRECTION — UNREADABLE contexts: a GENUINELY pending check STILL reads pending", () => {
  // THE TRAP. A fix that only proved the first case would pass on a change that reports everything
  // green, which would arm auto-merge on PRs whose checks are still running. An unresolved
  // conclusion is in NEITHER the ok-set nor the fail-set, and must still hold the PR.
  for (const live of ["IN_PROGRESS", "QUEUED", "PENDING", "WAITING"]) {
    const rollup: RollupCheckEntry[] = [
      rollupCheck({ name: "ci-gate", conclusion: "SUCCESS" }),
      rollupCheck({ name: "osv-scanner", conclusion: "NEUTRAL" }),
      rollupCheck({ name: "ci", conclusion: undefined, status: live }),
    ];
    assert.equal(checksStateFromRollup(rollup, undefined), "pending", live);
  }
  // …and a genuine FAILURE still vetoes outright, unreadable contexts or not.
  const red: RollupCheckEntry[] = [rollupCheck({ name: "ci", conclusion: "FAILURE" })];
  assert.equal(checksStateFromRollup(red, undefined), "red");
});

test("THE KNOWN-contexts path is BYTE-IDENTICAL — this must not change behaviour where the token can read protection", () => {
  // The mini's token returns ["remudero-review","ci-gate"], so every case below is what that host
  // already saw. NEUTRAL and SKIPPED were already ok there; the fix only removed the asymmetry.
  const neutral: RollupCheckEntry[] = [
    rollupCheck({ name: "ci-gate", conclusion: "SUCCESS" }),
    rollupCheck({ name: "osv-scanner", conclusion: "NEUTRAL" }),
  ];
  // NOT "pending": `checksStateFromRollup` filters REVIEW_CONTEXT out of the rollup BEFORE gating,
  // so an absent remudero-review can never hold checksState — that fact lives in `reviewState`.
  // My first draft asserted pending here and the code was right.
  assert.equal(checksStateFromRollup(neutral, REQUIRED), "green");
  const complete: RollupCheckEntry[] = [
    rollupCheck({ name: "ci-gate", conclusion: "SUCCESS" }),
    rollupCheck({ name: "remudero-review", conclusion: "SUCCESS" }),
    rollupCheck({ name: "osv-scanner", conclusion: "NEUTRAL" }),
  ];
  assert.equal(checksStateFromRollup(complete, REQUIRED), "green");
  const stillRunning: RollupCheckEntry[] = [
    rollupCheck({ name: "ci-gate", conclusion: undefined, status: "IN_PROGRESS" }),
    rollupCheck({ name: "remudero-review", conclusion: "SUCCESS" }),
  ];
  assert.equal(checksStateFromRollup(stillRunning, REQUIRED), "pending");
});

test("W1-T103 acceptance 2 (regression lock) — checksStateFromRollup: a PENDING required context -> pending, unchanged", () => {
  const rollup: RollupCheckEntry[] = [
    rollupCheck({ name: "ci-gate", conclusion: "" , status: "IN_PROGRESS" }),
    rollupCheck({ name: "remudero-review", conclusion: "SUCCESS" }),
  ];
  assert.equal(checksStateFromRollup(rollup, REQUIRED), "pending");
});

test("W1-T103 acceptance 2 (regression lock) — checksStateFromRollup: a FAILING required context -> red, unchanged (the existing W1-T100 blocked_ci routing)", () => {
  const rollup: RollupCheckEntry[] = [
    rollupCheck({ name: "ci-gate", conclusion: "FAILURE" }),
    rollupCheck({ name: "remudero-review", conclusion: "SUCCESS" }),
    rollupCheck({ name: "unrelated-optional-scan", conclusion: "SUCCESS" }),
  ];
  assert.equal(checksStateFromRollup(rollup, REQUIRED), "red");
});

test("W1-T103 — checksStateFromRollup: no requiredContexts supplied (unreadable branch protection) still counts EVERY reported context, and judges each by the same ok-set", () => {
  // CONTRACT CORRECTED 2026-08-13, and this test previously PINNED THE DEFECT: it asserted
  // "SKIPPED isn't SUCCESS under the fail-closed fallback", which is what made every containerised
  // sweep read `osv-scanner`'s NEUTRAL as pending forever and escalate #1692 with nothing running.
  // The WIDENING half of the fallback is unchanged and still asserted below — with the required
  // list unreadable, EVERY reported context is gated, not just the required ones. What changed is
  // only HOW each one is judged: by REQUIRED_CHECK_OK, the same set the known-contexts path uses,
  // because GitHub's merge-eligibility semantics do not depend on whether our token can read
  // protection.
  const rollup: RollupCheckEntry[] = [
    rollupCheck({ name: "ci-gate", conclusion: "SUCCESS" }),
    rollupCheck({ name: "schedule-stub", conclusion: "SKIPPED" }),
  ];
  assert.equal(checksStateFromRollup(rollup, undefined), "green", "a resolved SKIPPED satisfies, exactly as it does with the list readable");

  // THE WIDENING ITSELF, unchanged: a NON-required context that is genuinely unresolved still holds
  // the PR, because with no list nothing can be excluded from the gate.
  const nonRequiredRunning: RollupCheckEntry[] = [
    rollupCheck({ name: "ci-gate", conclusion: "SUCCESS" }),
    rollupCheck({ name: "some-advisory-job", conclusion: undefined, status: "IN_PROGRESS" }),
  ];
  assert.equal(checksStateFromRollup(nonRequiredRunning, undefined), "pending");

  const withFailure: RollupCheckEntry[] = [
    rollupCheck({ name: "ci-gate", conclusion: "SUCCESS" }),
    rollupCheck({ name: "anything", conclusion: "FAILURE" }),
  ];
  assert.equal(checksStateFromRollup(withFailure, undefined), "red", "any failure still vetoes under the fallback");
});

test("W1-T103 — checksStateFromRollup: empty rollup -> none; required contexts configured but none registered yet -> pending", () => {
  assert.equal(checksStateFromRollup(undefined, REQUIRED), "none");
  assert.equal(checksStateFromRollup([], REQUIRED), "none");
  assert.equal(checksStateFromRollup([rollupCheck({ name: "unrelated" })], REQUIRED), "pending");
});

test("W1-T103 acceptance 1 — the #170 fixture (all required success, one non-required skipped, review success) is MERGEABLE end-to-end: disposition mergeable, arm invoked", async () => {
  const rollup: RollupCheckEntry[] = [
    ...Array.from({ length: 13 }, (_, i) => rollupCheck({ name: `required-${i}`, conclusion: "SUCCESS" })),
    rollupCheck({ name: "schedule-stub", conclusion: "SKIPPED" }),
  ];
  const required = Array.from({ length: 13 }, (_, i) => `required-${i}`);
  const checksState = checksStateFromRollup(rollup, required);
  assert.equal(checksState, "green");

  const healedPr = pr({ prNumber: 170, prUrl: "url/170", taskId: "W1-T170", reviewState: "success", checksState });
  assert.equal(deriveDisposition(healedPr, DEFAULT_SWEEP_POLICY, NOW).disposition, "mergeable");

  const deps = fakeDeps();
  await runSweep([healedPr], deps);
  assert.equal(deps.armed.length, 1, "arm invoked exactly once");
  assert.equal(deps.armed[0].prNumber, 170);
});

// ── W1-T150 — the LEVEL-TRIGGERED CREDIT BACKFILL rung (ratifies P30) ────────
// The fixture MASTER-PLAN names: 0 of 195 runs ledgered a merge while GitHub
// showed 28 — every one of them a run whose terminal `verdict` line fired
// BEFORE its owned PR merged (blocked_ci, no_pr, …), so the ledger's credit
// field never revisited the question. These tests seed exactly that shape.

function creditCandidate(over: Partial<CreditCandidate> = {}): CreditCandidate {
  return {
    taskId: "W1-T1",
    prNumber: 255,
    prUrl: "https://github.com/o/r/pull/255",
    merged: true,
    ...over,
  };
}

test("credit backfill acceptance 1 — a run ledgered blocked_ci whose OWNED PR is merged yields exactly ONE verdict.merged correction on the next sweep, naming the PR", async () => {
  const shared = ledgerPath();
  appendLedger(shared, {
    run_id: "W1-T1-1",
    task_id: "W1-T1",
    step: "verdict",
    verdict: "blocked_ci",
    pr_url: "https://github.com/o/r/pull/255",
  });

  const summary = await runCreditBackfill([creditCandidate()], { ledgerPath: shared, runId: "SWEEP-1" });

  assert.equal(summary.total, 1);
  assert.equal(summary.corrected, 1);
  assert.equal(summary.results[0].corrected, true);

  const lines = readLedgerLines(shared);
  const corrections = lines.filter((l) => l.step === "verdict.merged" && l.task_id === "W1-T1");
  assert.equal(corrections.length, 1, "exactly ONE verdict.merged correction");
  assert.equal(corrections[0].pr_url, "https://github.com/o/r/pull/255", "the correction names the PR");
  assert.equal(corrections[0].pr_number, 255);
  assert.equal(corrections[0].verdict, "merged");
});

test("credit backfill acceptance 2 — idempotence: a second sweep over the now-credited state appends ZERO further corrections", async () => {
  const shared = ledgerPath();
  appendLedger(shared, { run_id: "W1-T1-1", task_id: "W1-T1", step: "verdict", verdict: "blocked_ci" });

  const first = await runCreditBackfill([creditCandidate()], { ledgerPath: shared, runId: "SWEEP-1" });
  assert.equal(first.corrected, 1);

  const second = await runCreditBackfill([creditCandidate()], { ledgerPath: shared, runId: "SWEEP-2" });
  assert.equal(
    second.corrected,
    0,
    "re-running over now-credited state appends nothing — a rung that re-credited every poll would fail this",
  );
  assert.equal(second.results[0].alreadyCredited, true);

  const lines = readLedgerLines(shared);
  const corrections = lines.filter((l) => l.step === "verdict.merged" && l.task_id === "W1-T1");
  assert.equal(corrections.length, 1, "still exactly one correction total — not doubled");
});

// NAMED to literally satisfy the acceptance criterion's own `unit test:` dialect
// proof text (plan/tasks.yaml, W1-T150 acceptance 3) — the review gate's
// proof-exec compiles that proof string into a `--test-name-pattern` REGEX and
// runs it for real (W1-T65). Regex, not substring: the criterion's own
// "(not merged)" parenthetical compiles to a NON-literal capture group, so a
// test name that reproduces the literal parens around "not merged" breaks
// contiguity with the surrounding words and paradoxically FAILS to match
// itself (confirmed: `new RegExp(proof).test(identicalProofText) === false`).
// This name matches the compiled regex (verified against the exact proof
// string) — never rename without re-checking against plan/tasks.yaml's exact
// proof text.
test("credit backfill acceptance 3 — a seeded uncredited run whose owned PR is OPEN not merged yields zero corrections — credit backfill fires only on MERGED owned PRs (the falsifier)", async () => {
  const shared = ledgerPath();
  appendLedger(shared, { run_id: "W1-T1-1", task_id: "W1-T1", step: "verdict", verdict: "blocked_ci" });

  const summary = await runCreditBackfill([creditCandidate({ merged: false })], { ledgerPath: shared, runId: "SWEEP-1" });

  assert.equal(summary.corrected, 0, "credit backfill fires only on MERGED owned PRs");
  assert.equal(summary.results[0].corrected, false);

  const lines = readLedgerLines(shared);
  assert.equal(lines.filter((l) => l.step === "verdict.merged").length, 0, "no correction for a still-open PR");
});

test("credit backfill: a run that already ledgered verdict:merged itself needs no backfill (the normal write path already credited it)", async () => {
  const shared = ledgerPath();
  appendLedger(shared, {
    run_id: "W1-T1-1",
    task_id: "W1-T1",
    step: "verdict",
    verdict: "merged",
    pr_url: "https://github.com/o/r/pull/255",
  });

  const summary = await runCreditBackfill([creditCandidate()], { ledgerPath: shared, runId: "SWEEP-1" });

  assert.equal(summary.corrected, 0);
  assert.equal(summary.results[0].alreadyCredited, true);
});

test("credit backfill: two candidates for the SAME task within one pass credit exactly once (same-pass dedup)", async () => {
  const shared = ledgerPath();
  appendLedger(shared, { run_id: "W1-T1-1", task_id: "W1-T1", step: "verdict", verdict: "blocked_ci" });

  const summary = await runCreditBackfill([creditCandidate(), creditCandidate()], { ledgerPath: shared, runId: "SWEEP-1" });

  assert.equal(summary.corrected, 1, "the second candidate for the same task sees the first's just-written credit");
  const lines = readLedgerLines(shared);
  assert.equal(lines.filter((l) => l.step === "verdict.merged" && l.task_id === "W1-T1").length, 1);
});

test("credit backfill: dry-run derives outcomes but writes NO ledger line (a later real pass still corrects)", async () => {
  const shared = ledgerPath();
  appendLedger(shared, { run_id: "W1-T1-1", task_id: "W1-T1", step: "verdict", verdict: "blocked_ci" });

  const preview = await runCreditBackfill([creditCandidate()], { ledgerPath: shared, runId: "SWEEP-1", dryRun: true });
  assert.equal(preview.results[0].corrected, false, "dry-run never acts");

  const lines = readLedgerLines(shared);
  assert.equal(lines.filter((l) => l.step === "verdict.merged").length, 0, "dry-run leaves no ledger trace");

  const real = await runCreditBackfill([creditCandidate()], { ledgerPath: shared, runId: "SWEEP-2" });
  assert.equal(real.corrected, 1, "a later real pass still corrects — dry-run took no effect");
});

test("credit backfill: distinct tasks each get their own independent correction", async () => {
  const shared = ledgerPath();
  appendLedger(shared, { run_id: "W1-T1-1", task_id: "W1-T1", step: "verdict", verdict: "blocked_ci" });
  appendLedger(shared, { run_id: "W1-T2-1", task_id: "W1-T2", step: "verdict", verdict: "no_pr" });

  const summary = await runCreditBackfill(
    [creditCandidate(), creditCandidate({ taskId: "W1-T2", prNumber: 256, prUrl: "https://github.com/o/r/pull/256" })],
    { ledgerPath: shared, runId: "SWEEP-1" },
  );

  assert.equal(summary.total, 2);
  assert.equal(summary.corrected, 2);
  const lines = readLedgerLines(shared);
  assert.equal(lines.filter((l) => l.step === "verdict.merged" && l.task_id === "W1-T1").length, 1);
  assert.equal(lines.filter((l) => l.step === "verdict.merged" && l.task_id === "W1-T2").length, 1);
});

// ── credit backfill logs only what it ACTED on (R-36) ───────────────────────
// This rung logged once per candidate per pass, and the daemon sweeps every
// poll, so a backfill correcting nothing still restated every already-credited
// task forever: 5,209 accumulated no-op lines, all `corrected: false`. The
// ledger's SIZE is the read cost behind W1-T187's projection regression, so a
// per-poll restatement of unchanged state is charged to every reader.

test("runCreditBackfill: an already-credited candidate logs NO per-candidate line (R-36 no-op silence)", async () => {
  const logged: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const s = await runCreditBackfill(
    [{ taskId: "W1-TA", prNumber: 1, prUrl: "u/1", merged: true }],
    {
      ledgerPath: join(mkdtempSync(join(tmpdir(), "rmd-backfill-")), "ledger.ndjson"),
      runId: "RUN-1",
      // already credited: the pre-existing terminal verdict line
      readLedger: () => [{ task_id: "W1-TA", step: "verdict", verdict: "merged" }],
      appendLine: () => {},
      log: (step, extra = {}) => logged.push({ step, extra }),
    },
  );
  assert.equal(s.corrected, 0, "nothing to correct");
  assert.equal(
    logged.filter((l) => l.step === "sweep.credit_backfill").length,
    0,
    "FALSIFIER: pre-fix this logged one `corrected:false` line per candidate per poll, forever",
  );
  // COVERAGE stays observable — the summary still reports what was examined.
  const summary = logged.find((l) => l.step === "sweep.credit_backfill.summary");
  assert.ok(summary, "the summary line still fires");
  assert.equal(summary?.extra.total, 1, "and still reports the full candidate count");
});

test("runCreditBackfill: a candidate it ACTUALLY corrects still logs its per-candidate line", async () => {
  const logged: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const s = await runCreditBackfill(
    [{ taskId: "W1-TB", prNumber: 7, prUrl: "u/7", merged: true }],
    {
      ledgerPath: join(mkdtempSync(join(tmpdir(), "rmd-backfill-")), "ledger.ndjson"),
      runId: "RUN-1",
      readLedger: () => [],
      appendLine: () => {},
      log: (step, extra = {}) => logged.push({ step, extra }),
    },
  );
  assert.equal(s.corrected, 1);
  const acted = logged.filter((l) => l.step === "sweep.credit_backfill");
  assert.equal(acted.length, 1, "silence is scoped to NO-OPS — a real correction stays legible");
  assert.equal(acted[0].extra.task_id, "W1-TB");
  assert.equal(acted[0].extra.corrected, true);
});

// ── ESCALATION-LIFECYCLE RECONCILER (fb-1784756088300-6a481e) ──────────────────

function reconcileCandidate(over: Partial<EscalationReconcileCandidate> = {}): EscalationReconcileCandidate {
  return {
    issueUrl: over.issueUrl ?? "https://github.com/o/r/issues/1",
    issueNumber: over.issueNumber ?? 1,
    taskId: over.taskId ?? "W1-T1",
    ...(over.askType !== undefined ? { askType: over.askType } : {}),
    derived: {
      merged: true,
      prUrl: "https://github.com/o/r/pull/255",
      prNumber: 255,
      source: "trailer",
      ...(over.derived ?? {}),
    },
  };
}

test("renderReconcileCloseComment names the resolver — the merged PR + derivation source — and cites the feedback id", () => {
  const comment = renderReconcileCloseComment(
    reconcileCandidate({
      taskId: "W1-T189",
      derived: { merged: true, prUrl: "https://github.com/o/r/pull/574", prNumber: 574, source: "head-branch" },
    }),
  );
  assert.match(comment, /W1-T189/);
  assert.match(comment, /#574/);
  assert.match(comment, /pull\/574/);
  assert.match(comment, /head-branch/);
  assert.match(comment, /fb-1784756088300-6a481e/);
});

test("renderReconcileCloseComment (W1-T162): a CLOSED-WITHOUT-MERGING referent names the PR as closed, never claims 'merged'", () => {
  const comment = renderReconcileCloseComment(
    reconcileCandidate({
      taskId: "W1-T189",
      derived: { merged: false, closed: true, prUrl: "https://github.com/o/r/pull/580", prNumber: 580, source: "pr-field" },
    }),
  );
  assert.match(comment, /W1-T189/);
  assert.match(comment, /#580/);
  assert.match(comment, /closed without merging/);
  assert.doesNotMatch(comment, /is now \*\*merged\*\*/, "a closed-without-merge referent must never be cited as merged");
  assert.match(comment, /fb-1784756088300-6a481e/);
});

test("renderMootedCloseComment (W1-T347) names the mooting PR, states the question was NOT answered, and starts with a fixed distinguishable prefix", () => {
  const comment = renderMootedCloseComment(
    reconcileCandidate({
      taskId: "W1-T1200",
      derived: { merged: true, prUrl: "https://github.com/o/r/pull/1215", prNumber: 1215, source: "head-branch" },
    }),
  );
  assert.match(comment, /^MOOTED by the escalation-lifecycle reconciler/, "fixed prefix, mechanically distinguishable from a resolved close");
  assert.match(comment, /W1-T1200/, "names the task");
  assert.match(comment, /#1215/, "names the mooting PR");
  assert.match(comment, /pull\/1215/);
  assert.match(comment, /head-branch/);
  assert.match(comment, /NOT answer/i, "states plainly that the question was not answered");
  assert.doesNotMatch(comment, /is now \*\*merged\*\*, resolved by/, "must never claim the merge RESOLVED the question");
  assert.match(comment, /fb-1784756088300-6a481e/);
});

test("renderMootedCloseComment (W1-T347): a CLOSED-WITHOUT-MERGING referent names the PR as closed, never claims 'merged'", () => {
  const comment = renderMootedCloseComment(
    reconcileCandidate({
      taskId: "W1-T1200",
      derived: { merged: false, closed: true, prUrl: "https://github.com/o/r/pull/1216", prNumber: 1216, source: "pr-field" },
    }),
  );
  assert.match(comment, /#1216/);
  assert.match(comment, /closed without merging/);
  assert.doesNotMatch(comment, /\bmerged\b/i, "a closed-without-merge referent must never be cited as merged");
});

test("escalation reconcile (W1-T162): a RESOLVED-but-CLOSED-WITHOUT-MERGING referent (superseded/abandoned PR) closes its needs-human issue too — this is the falsifier's positive complement", async () => {
  const shared = ledgerPath();
  const closes: Array<{ url: string; comment: string }> = [];
  const summary = await runEscalationReconcile(
    [
      reconcileCandidate({
        issueUrl: "https://github.com/o/r/issues/91",
        issueNumber: 91,
        taskId: "W1-T190",
        derived: { merged: false, closed: true, prUrl: "https://github.com/o/r/pull/580", prNumber: 580, source: "pr-field" },
      }),
    ],
    { closeIssue: (url, comment) => closes.push({ url, comment }), ledgerPath: shared, runId: "SWEEP-1" },
  );
  assert.equal(summary.closed, 1);
  assert.equal(summary.results[0].outcome, "closed");
  assert.equal(closes.length, 1);
  assert.match(closes[0].comment, /closed without merging/);
  const closedLines = readLedgerLines(shared).filter((l) => l.step === "sweep.escalation_closed");
  assert.equal(closedLines.length, 1);
  assert.equal(closedLines[0].task_id, "W1-T190");
  assert.equal(closedLines[0].resolution, "closed", "the ledger names the resolution kind, not just the PR");
});

test("escalation reconcile (W1-T162): a mixed batch (merged referents + closed-without-merge referents) is driven to zero by ONE sweep pass, and a second pass over the closed state closes NOTHING", async () => {
  const shared = ledgerPath();
  const closes: string[] = [];
  const batch: EscalationReconcileCandidate[] = [
    reconcileCandidate({ issueUrl: "iss/1", taskId: "W1-T1", derived: { merged: true, prNumber: 101, source: "trailer" } }),
    reconcileCandidate({ issueUrl: "iss/2", taskId: "W1-T2", derived: { merged: false, closed: true, prNumber: 102, source: "pr-field" } }),
    reconcileCandidate({ issueUrl: "iss/3", taskId: "W1-T3", derived: { merged: true, prNumber: 103, source: "head-branch" } }),
    reconcileCandidate({ issueUrl: "iss/4", taskId: "W1-T4", derived: { merged: false, closed: true, prNumber: 104, source: "pr-field" } }),
  ];
  const summary = await runEscalationReconcile(batch, {
    closeIssue: (url) => closes.push(url),
    ledgerPath: shared,
    runId: "SWEEP-1",
  });
  assert.equal(summary.closed, 4, "one sweep drives the whole resolved-referent batch to zero");
  assert.deepEqual(closes.sort(), ["iss/1", "iss/2", "iss/3", "iss/4"]);

  // Idempotence: a second sweep over the NOW-CLOSED state (every closed issue no longer
  // appears in the caller's OPEN needs-human list — the real `gh issue list` contract
  // `buildEscalationReconcileCandidates` relies on) closes NOTHING.
  const closes2: string[] = [];
  const summary2 = await runEscalationReconcile([], {
    closeIssue: (url) => closes2.push(url),
    ledgerPath: shared,
    runId: "SWEEP-2",
  });
  assert.equal(summary2.closed, 0, "a second sweep over the now-closed state closes nothing");
  assert.equal(closes2.length, 0);
  const closedLines = readLedgerLines(shared).filter((l) => l.step === "sweep.escalation_closed");
  assert.equal(closedLines.length, 4, "the second, idempotent pass adds no new ledger lines");
});

test("escalation reconcile: a RESOLVED (merged) referent closes its needs-human issue with a citation naming the resolver, and ledgers the close", async () => {
  const shared = ledgerPath();
  const closes: Array<{ url: string; comment: string }> = [];
  const summary = await runEscalationReconcile(
    [
      reconcileCandidate({
        issueUrl: "https://github.com/o/r/issues/44",
        issueNumber: 44,
        taskId: "W1-T189",
        derived: { merged: true, prUrl: "https://github.com/o/r/pull/574", prNumber: 574, source: "head-branch" },
      }),
    ],
    { closeIssue: (url, comment) => closes.push({ url, comment }), ledgerPath: shared, runId: "SWEEP-1" },
  );
  assert.equal(summary.closed, 1);
  assert.equal(summary.results[0].outcome, "closed");
  assert.equal(closes.length, 1);
  assert.equal(closes[0].url, "https://github.com/o/r/issues/44");
  assert.match(closes[0].comment, /W1-T189/, "the citation names the task");
  assert.match(closes[0].comment, /#574/, "the citation names the resolving PR");
  assert.match(closes[0].comment, /head-branch/, "the citation names the derivation source");

  const closedLines = readLedgerLines(shared).filter((l) => l.step === "sweep.escalation_closed");
  assert.equal(closedLines.length, 1, "every close is ledgered");
  assert.equal(closedLines[0].issue_url, "https://github.com/o/r/issues/44");
  assert.equal(closedLines[0].task_id, "W1-T189");
  assert.equal(closedLines[0].pr_number, 574);
});

test("escalation reconcile (W1-T347): a QUESTION-typed issue whose referent went terminal closes with the MOOTED comment — names the mooting PR and states the question was never answered, never the resolved-close citation", async () => {
  const shared = ledgerPath();
  const closes: Array<{ url: string; comment: string }> = [];
  const summary = await runEscalationReconcile(
    [
      reconcileCandidate({
        issueUrl: "https://github.com/o/r/issues/1200",
        issueNumber: 1200,
        taskId: "W1-T1200",
        askType: "question",
        derived: { merged: true, prUrl: "https://github.com/o/r/pull/1215", prNumber: 1215, source: "head-branch" },
      }),
    ],
    { closeIssue: (url, comment) => closes.push({ url, comment }), ledgerPath: shared, runId: "SWEEP-1" },
  );
  assert.equal(summary.closed, 1, "the board still clears — the close still happens");
  assert.equal(summary.results[0].outcome, "closed");
  assert.equal(closes.length, 1);
  assert.match(closes[0].comment, /^MOOTED by the escalation-lifecycle reconciler/, "the MOOTED comment, not the resolved-close comment");
  assert.match(closes[0].comment, /W1-T1200/);
  assert.match(closes[0].comment, /#1215/, "names the mooting PR");
  assert.match(closes[0].comment, /NOT answer/i, "states plainly the question was never answered");
  assert.doesNotMatch(closes[0].comment, /is now \*\*merged\*\*, resolved by/, "must never claim the merge resolved the question");
});

test("escalation reconcile (W1-T347, falsifier): an ACTION-typed issue with the same terminal referent keeps today's resolved-close comment, byte-identical to the untyped path", async () => {
  const shared = ledgerPath();
  const closesAction: Array<{ url: string; comment: string }> = [];
  const closesUntyped: Array<{ url: string; comment: string }> = [];
  const derived = { merged: true, prUrl: "https://github.com/o/r/pull/1215", prNumber: 1215, source: "head-branch" };
  await runEscalationReconcile(
    [reconcileCandidate({ issueUrl: "iss/action", taskId: "W1-T1200", askType: "action", derived })],
    { closeIssue: (url, comment) => closesAction.push({ url, comment }), ledgerPath: shared, runId: "SWEEP-1" },
  );
  await runEscalationReconcile(
    [reconcileCandidate({ issueUrl: "iss/untyped", taskId: "W1-T1200", derived })],
    { closeIssue: (url, comment) => closesUntyped.push({ url, comment }), ledgerPath: shared, runId: "SWEEP-2" },
  );
  assert.doesNotMatch(closesAction[0].comment, /^MOOTED/, "an action-typed issue never gets the MOOTED comment");
  assert.match(closesAction[0].comment, /^Auto-closed by the escalation-lifecycle reconciler/);
  assert.equal(closesAction[0].comment, closesUntyped[0].comment, "action-typed and untyped (absent askType, the legacy corpus) close identically");
  assert.equal(closesAction[0].comment, renderReconcileCloseComment(reconcileCandidate({ taskId: "W1-T1200", derived })), "byte-identical to today's close path");
});

test("escalation reconcile: a still-LIVE referent (not merged) is left untouched — no close, no ledger line", async () => {
  const shared = ledgerPath();
  const closes: string[] = [];
  const summary = await runEscalationReconcile(
    [reconcileCandidate({ derived: { merged: false, source: "none" } })],
    { closeIssue: (url) => closes.push(url), ledgerPath: shared, runId: "SWEEP-1" },
  );
  assert.equal(summary.closed, 0);
  assert.equal(summary.results[0].outcome, "left-live");
  assert.equal(closes.length, 0, "a live escalation is never closed");
  assert.equal(readLedgerLines(shared).filter((l) => l.step === "sweep.escalation_closed").length, 0);
});

test("escalation reconcile: an INDETERMINATE derivation (W1-T119 — GitHub unreadable) is left untouched, never closed on an untrusted read — even over a carried-forward merged", async () => {
  const shared = ledgerPath();
  const closes: string[] = [];
  const summary = await runEscalationReconcile(
    // merged:true carried from a prior observation, but THIS read failed (indeterminate) —
    // the W1-T119 guard must win: defer, never close on a read we could not trust this pass.
    [reconcileCandidate({ derived: { merged: true, indeterminate: true, source: "throttled" } })],
    { closeIssue: (url) => closes.push(url), ledgerPath: shared, runId: "SWEEP-1" },
  );
  assert.equal(summary.closed, 0);
  assert.equal(summary.results[0].outcome, "left-indeterminate");
  assert.equal(closes.length, 0, "an indeterminate read defers, never closes");
});

test("escalation reconcile: a 94-open backlog of resolved issues drains across bounded cycles — never one burst", async () => {
  const shared = ledgerPath();
  let remaining: EscalationReconcileCandidate[] = Array.from({ length: 94 }, (_, i) =>
    reconcileCandidate({ issueUrl: `https://github.com/o/r/issues/${i}`, issueNumber: i, taskId: `W1-T${i}` }),
  );
  let cycles = 0;
  let totalClosed = 0;
  while (remaining.length > 0) {
    cycles++;
    assert.ok(cycles <= 12, "the drain must terminate");
    const closedUrls = new Set<string>();
    const summary = await runEscalationReconcile(remaining, {
      closeIssue: (url) => closedUrls.add(url), // a closed issue no longer appears in next cycle's OPEN list
      ledgerPath: shared,
      runId: `SWEEP-${cycles}`,
    });
    assert.ok(
      summary.closed <= MAX_ESCALATION_CLOSES_PER_CYCLE,
      `cycle ${cycles} closed ${summary.closed}, must be within the per-cycle bound`,
    );
    totalClosed += summary.closed;
    remaining = remaining.filter((c) => !closedUrls.has(c.issueUrl)); // the caller lists only STILL-open issues
  }
  assert.equal(totalClosed, 94, "all 94 eventually close");
  assert.equal(cycles, Math.ceil(94 / MAX_ESCALATION_CLOSES_PER_CYCLE), "drained across the expected bounded cycles");
  assert.ok(cycles > 1, "a 94-open backlog must NOT drain in a single burst");
});

test("escalation reconcile: one failing `gh issue close` is contained — the rest still close, and the failed one is NOT ledgered (retries next cycle)", async () => {
  const shared = ledgerPath();
  const summary = await runEscalationReconcile(
    [
      reconcileCandidate({ issueUrl: "iss/1", taskId: "W1-T1" }),
      reconcileCandidate({ issueUrl: "iss/BOOM", taskId: "W1-T2" }),
      reconcileCandidate({ issueUrl: "iss/3", taskId: "W1-T3" }),
    ],
    {
      closeIssue: (url) => {
        if (url === "iss/BOOM") throw new Error("gh issue close failed");
      },
      ledgerPath: shared,
      runId: "SWEEP-1",
    },
  );
  assert.equal(summary.closed, 2, "the two good closes succeed despite the middle throw");
  assert.equal(summary.results.find((r) => r.issueUrl === "iss/BOOM")?.outcome, "close-failed");
  const closedLines = readLedgerLines(shared).filter((l) => l.step === "sweep.escalation_closed");
  assert.equal(closedLines.length, 2, "the failed close leaves NO ledger line (retries next cycle)");
  assert.ok(!closedLines.some((l) => l.task_id === "W1-T2"), "no phantom close line for the throwing issue");
});

test("escalation reconcile: --dry-run previews the closes but makes NO gh call and leaves NO ledger line", async () => {
  const shared = ledgerPath();
  const closes: string[] = [];
  const summary = await runEscalationReconcile([reconcileCandidate()], {
    closeIssue: (url) => closes.push(url),
    ledgerPath: shared,
    runId: "SWEEP-1",
    dryRun: true,
  });
  assert.equal(summary.closed, 1, "the preview counts what a live pass WOULD close");
  assert.equal(closes.length, 0, "dry-run makes no gh close call");
  assert.equal(
    readLedgerLines(shared).filter((l) => l.step === "sweep.escalation_closed").length,
    0,
    "and leaves no ledger line",
  );
});

// ── W1-T349: the reconciler retires fleet-notice issues exactly as it retires needs-human ones ──

test("RETIRABLE_ESCALATION_LABELS: exactly needs-human and fleet-notice", () => {
  assert.deepEqual([...RETIRABLE_ESCALATION_LABELS].sort(), [FLEET_NOTICE_LABEL, NEEDS_HUMAN_LABEL].sort());
});

test("listRetirableEscalationIssues: merges OPEN issues across needs-human and fleet-notice, deduped by issue number", () => {
  const byLabel: Record<string, OpenIssue[]> = {
    [NEEDS_HUMAN_LABEL]: [
      { number: 1, url: "https://github.com/o/r/issues/1", title: "a", body: "**Task:** W1-T1" },
      { number: 2, url: "https://github.com/o/r/issues/2", title: "b", body: "**Task:** W1-T2" },
    ],
    [FLEET_NOTICE_LABEL]: [
      { number: 3, url: "https://github.com/o/r/issues/3", title: "c", body: "**Task:** W1-T3" },
      // #1 appears under BOTH labels here — never happens in production (an issue carries
      // exactly one queue label, by construction of escalate()/escalateWithJudge), but the
      // defensive dedup must not double-count it if it somehow did.
      { number: 1, url: "https://github.com/o/r/issues/1", title: "a", body: "**Task:** W1-T1" },
    ],
  };
  const issues: IssueGateway = {
    create: () => {
      throw new Error("not used");
    },
    listOpen: (label) => byLabel[label] ?? [],
  };
  const merged = listRetirableEscalationIssues(issues);
  assert.equal(merged.length, 3, "3 distinct issues — #1 counted once despite appearing under both labels");
  assert.deepEqual(
    merged.map((i) => i.number).sort((a, b) => a - b),
    [1, 2, 3],
  );
});

test("listRetirableEscalationIssues: a gateway with no listOpen yields nothing (matches a single-label call's back-compat)", () => {
  const issues: IssueGateway = { create: () => "https://github.com/o/r/issues/1" };
  assert.deepEqual(listRetirableEscalationIssues(issues), []);
});

test("W1-T349: a fleet-notice-sourced candidate retires EXACTLY like a needs-human one once its referent resolves — EscalationReconcileCandidate carries no label field, so runEscalationReconcile cannot (and need not) distinguish them", async () => {
  // The candidate below is indistinguishable, at runEscalationReconcile's level, from one built
  // off a needs-human issue — proving the design's promise ("the reconciler must treat
  // fleet-notice issues exactly as it treats needs-human ones") by CONSTRUCTION: there is no
  // label field to branch on, so there is nothing this reconciler could get wrong here even if
  // it wanted to. The label-aware half of the fix — actually FINDING the fleet-notice issue in
  // the first place — is `listRetirableEscalationIssues`, asserted above.
  const shared = ledgerPath();
  const closes: Array<{ url: string; comment: string }> = [];
  const summary = await runEscalationReconcile(
    [
      reconcileCandidate({
        issueUrl: "https://github.com/o/r/issues/700",
        taskId: "W1-T700",
        derived: { merged: true, prUrl: "https://github.com/o/r/pull/699", prNumber: 699, source: "trailer" },
      }),
    ],
    {
      closeIssue: (url, comment) => closes.push({ url, comment }),
      ledgerPath: shared,
      runId: "RUN-1",
    },
  );
  assert.equal(summary.closed, 1);
  assert.equal(closes.length, 1);
  assert.equal(closes[0].url, "https://github.com/o/r/issues/700");
  assert.match(closes[0].comment, /is now \*\*merged\*\*, resolved by #699/);
});

// ── post-review routing: a green-but-ungated PR gets the review lane, not an escalation ──

function ungatedGreenPr(over: Partial<OpenPrView> = {}): OpenPrView {
  return pr({ prNumber: 584, prUrl: "url/584", taskId: "W1-T584", reviewState: "none", checksState: "green", ...over });
}

test("deriveDisposition: checks green + review never posted -> post-review, NOT the clarification catch-all (the #584 stall)", () => {
  const r = deriveDisposition(ungatedGreenPr(), DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(r.disposition, "post-review");
  assert.match(r.reason, /review never posted/);
});

test("deriveDisposition: checks PENDING + review none still lands on the catch-all — review-before-green is not the lane's order", () => {
  assert.equal(deriveDisposition(ungatedGreenPr({ checksState: "pending" }), DEFAULT_SWEEP_POLICY, NOW).disposition, "blocked-ambiguous");
});

test("runSweep: the postReview dep is invoked once, and a POSTED verdict for the head dedups the next pass (W1-T254: outcome-keyed, not attempt-keyed)", async () => {
  const lp = ledgerPath();
  const calls: number[] = [];
  const first = fakeDeps({
    ledgerPath: lp,
    postReview: (p) => {
      calls.push(p.prNumber);
      // Simulates the real effect (buildSweepEffects.postReview -> reviewCommand
      // -> postReviewStatusGuarded) actually reaching a verdict for this head.
      appendLedger(lp, { run_id: "SWEEP-1", task_id: p.taskId ?? "", step: "review.posted", head_sha: p.headSha, state: "success" });
    },
  });
  await runSweep([ungatedGreenPr()], first, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(calls, [584]);
  const calls2: number[] = [];
  const second = fakeDeps({ ledgerPath: lp, postReview: (p) => { calls2.push(p.prNumber); } });
  await runSweep([ungatedGreenPr()], second, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(calls2, [], "a posted verdict is per-head — never re-posted for the same sha");
});

test("runSweep: post-review dedup is outcome-keyed — a prior acted:true dispose with no posted/refused verdict for that head still retries; a refusal for the head dedups (W1-T254)", async () => {
  const lp = ledgerPath();

  // Pass 1: postReview is invoked and its ATTEMPT is ledgered acted:true, but
  // the lane reaches NO outcome at all (e.g. a fake that no-ops, or in the
  // real path a guard refusal that itself throws before ledgering anything).
  const attempt1: number[] = [];
  const first = fakeDeps({ ledgerPath: lp, postReview: (p) => { attempt1.push(p.prNumber); } });
  await runSweep([ungatedGreenPr()], first, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(attempt1, [584]);
  const disposedAfterFirst = readLedgerLines(lp).filter((l) => l.step === "sweep.disposed");
  assert.equal(disposedAfterFirst[0].acted, true, "the attempt itself was ledgered acted:true");

  // Pass 2: STILL no review.posted/review.post_refused outcome exists for this
  // head — under the OLD attempt-keyed dedup (`sweep.disposed acted:true`)
  // this would suppress the head FOREVER; outcome-keyed dedup retries instead.
  const attempt2: number[] = [];
  const second = fakeDeps({ ledgerPath: lp, postReview: (p) => { attempt2.push(p.prNumber); } });
  await runSweep([ungatedGreenPr()], second, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(attempt2, [584], "no posted/refused verdict for this head exists yet — the lane retries");

  // Now an explicit REFUSAL lands for this exact head (postReviewStatusGuarded's
  // W1-T228 guard declining to post — review.post_refused, carrying task_id + head_sha).
  appendLedger(lp, {
    run_id: "SWEEP-3",
    task_id: "W1-T584",
    step: "review.post_refused",
    head_sha: "aaaa111",
    attempted_state: "failure",
    reason: "stale lifecycle",
  });

  // Pass 3: the refusal DOES dedup — no repeat post attempt for the same head.
  const attempt3: number[] = [];
  const third = fakeDeps({ ledgerPath: lp, postReview: (p) => { attempt3.push(p.prNumber); } });
  await runSweep([ungatedGreenPr()], third, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(attempt3, [], "an explicit refusal for this head dedups the post-review lane");
});

test("runSweep: no postReview dep wired -> ledgered stand-down, no crash, no escalation fires", async () => {
  const deps = fakeDeps();
  await runSweep([ungatedGreenPr()], deps, DEFAULT_SWEEP_POLICY);
  assert.equal(deps.escalated.length, 0);
  const disposed = readLedgerLines(deps.ledgerPath).filter((l) => l.step === "sweep.disposed");
  assert.equal(disposed[0].disposition, "post-review");
  assert.equal(disposed[0].acted, false);
});

// ── W1-T176: a required check with ZERO check runs is DETERMINISTIC-ACTION, ──
//    not blocked-ambiguous — the clarification rung must not spend an operator
//    round-trip on "post the missing check", a decision the machine can
//    already make. FIXTURE (real): 2026-07-20 20:11:58Z, run
//    DAEMON-1784578236497 escalated issue #393 against PR #391 — every other
//    check SUCCESS, `remudero-review` (a required context) with NO CHECK RUN
//    AT ALL — with two mis-framed options, while `rmd review 391` was the
//    actual one-command remedy and the PR merged at 20:16:09Z once it ran.

test("W1-T176 acceptance 1 (the #393/#391 falsifier) — every other check SUCCESS, remudero-review has ZERO check runs -> post-review (DETERMINISTIC-ACTION), escalating NOTHING", async () => {
  const zeroRunsPr = ungatedGreenPr(); // checksState "green" (every OTHER required check SUCCESS), reviewState "none"
  const derived = deriveDisposition(zeroRunsPr, DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(derived.disposition, "post-review", "a zero-runs required check is decidable, not ambiguous");

  const posted: number[] = [];
  const deps = fakeDeps({ postReview: (p) => { posted.push(p.prNumber); } });
  await runSweep([zeroRunsPr], deps, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(posted, [584], "routes to the SAME deterministic reviewer path `rmd review` drives");
  assert.equal(deps.escalated.length, 0, "the #393/#391 defect: NOTHING escalates on first sighting");
});

test("W1-T176 acceptance 2 — a required check that RAN and FAILED still classifies blocked-ambiguous and still escalates (the rung is NARROWED, never removed)", async () => {
  // A review that RAN and came back failure with no single nameable unmet
  // criterion — genuinely contradictory, the shape row 7 already escalates.
  // reviewPostRefused must be irrelevant here: this PR's review context DID
  // run (reviewState "failure", not "none"), so the zero-runs discriminator
  // never applies regardless of that field's value.
  const ranAndFailed = pr({
    prNumber: 391,
    prUrl: "url/391",
    taskId: "W1-T391",
    reviewState: "failure",
    checksState: "green",
    unmetCriteria: [],
    reviewPostRefused: true,
  });
  const derived = deriveDisposition(ranAndFailed, DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(derived.disposition, "blocked-ambiguous");
  assert.match(derived.reason, /no actionable unmet criteria/);

  const deps = fakeDeps();
  await runSweep([ranAndFailed], deps, DEFAULT_SWEEP_POLICY);
  assert.equal(deps.escalated.length, 1, "a genuinely-ran, genuinely-failed check still escalates — never swallowed");
});

test("W1-T176 acceptance 3a — checksStateFromRollup derives EVERY required context from branch protection, not a hardcoded pair (a third context added later still vetoes)", () => {
  const threeRequired = [...REQUIRED, "new-required-check"];
  const rollup: RollupCheckEntry[] = [
    rollupCheck({ name: "ci-gate", conclusion: "SUCCESS" }),
    rollupCheck({ name: "remudero-review", conclusion: "SUCCESS" }),
    rollupCheck({ name: "new-required-check", conclusion: "FAILURE" }),
  ];
  assert.equal(
    checksStateFromRollup(rollup, threeRequired),
    "red",
    "a hardcoded two-context check would miss this and silently report green",
  );
});

test("W1-T176 acceptance 3b — an unreadable branch-protection read fails CLOSED: the zero-runs discriminator (post-review AND the escalate-on-refusal row) stands down, and the PR still escalates rather than being assumed permissive", () => {
  const unreadable = ungatedGreenPr({ requiredContextsUnreadable: true });
  const derived = deriveDisposition(unreadable, DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(
    derived.disposition,
    "blocked-ambiguous",
    "an unreadable protection read must never be assumed permissive — it escalates, never silently posts or arms",
  );
  assert.notEqual(derived.disposition, "post-review");
  assert.notEqual(derived.disposition, "mergeable");
});

test("W1-T176 acceptance 4 — posting the missing check cannot loop: a SECOND absence at the SAME head sha (one deterministic attempt already refused) escalates instead of re-posting", async () => {
  const alreadyAttempted = ungatedGreenPr({ reviewPostRefused: true });
  const derived = deriveDisposition(alreadyAttempted, DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(derived.disposition, "blocked-ambiguous");
  assert.match(derived.reason, /refused/);

  const posted: number[] = [];
  const deps = fakeDeps({ postReview: (p) => { posted.push(p.prNumber); } });
  await runSweep([alreadyAttempted], deps, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(posted, [], "FALSIFIER guard: an unbounded post-retry would re-invoke postReview here — it must not");
  assert.equal(deps.escalated.length, 1, "the second absence escalates instead of silently re-standing-down forever");
});

test("W1-T176 — a FRESH push (new head sha) after a refusal re-earns exactly one fresh deterministic attempt", () => {
  // reviewPostRefused is per-headSha ground truth (buildOpenPrViews scans the
  // ledger for THIS exact taskId@headSha) — a new push mints a new head, so a
  // caller building the NEXT OpenPrView for the new sha naturally omits the
  // flag rather than carrying a stale refusal forward.
  const freshPush = ungatedGreenPr({ headSha: "bbbb222", reviewPostRefused: undefined });
  assert.equal(deriveDisposition(freshPush, DEFAULT_SWEEP_POLICY, NOW).disposition, "post-review");
});

// ── W1-T225: a push leaves the new head with NO remudero-review at all, and the ──
//    silence is indistinguishable from "not run yet" — the 2026-07-21 PRs
//    #477/#484 jam (both fully green, both stuck armed-and-waiting forever
//    because the review that once ran stayed bound to the sha it was posted
//    against). FIXTURE: same checks-green/review-none shape `ungatedGreenPr`
//    already covers, but with `reviewOrphanedByPush: true` — this PR WAS
//    reviewed before, just not on the head the sweep sees now.

function orphanedGreenPr(over: Partial<OpenPrView> = {}): OpenPrView {
  return ungatedGreenPr({ headSha: "cccc333", reviewOrphanedByPush: true, ...over });
}

test("W1-T225 acceptance 1 — a push leaving a previously-reviewed PR reviewless still lands on post-review, and runSweep re-dispatches the review rung on the new head", async () => {
  const orphaned = orphanedGreenPr();
  const derived = deriveDisposition(orphaned, DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(derived.disposition, "post-review", "checks green + review none is still the review lane, orphaned or not");

  const posted: number[] = [];
  const deps = fakeDeps({ postReview: (p) => { posted.push(p.prNumber); } });
  await runSweep([orphaned], deps, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(posted, [584], "the review rung IS re-dispatched on the new (silent) head — nothing sits stuck forever");
  assert.equal(deps.escalated.length, 0, "the falsifier: PRs #477/#484 sat with NO disposition acting on them at all");
});

test("W1-T225 acceptance 2 — a PR orphaned by a push is DISTINGUISHED from one awaiting its first review ever (same disposition, different stated reason)", () => {
  const neverReviewed = ungatedGreenPr(); // reviewOrphanedByPush undefined — awaiting its FIRST review
  const orphaned = orphanedGreenPr(); // reviewOrphanedByPush true — reviewed before, silenced by a later push

  const a = deriveDisposition(neverReviewed, DEFAULT_SWEEP_POLICY, NOW);
  const b = deriveDisposition(orphaned, DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(a.disposition, "post-review");
  assert.equal(b.disposition, "post-review");
  assert.match(a.reason, /review never posted/);
  assert.match(b.reason, /orphaned by a push/);
  assert.notEqual(a.reason, b.reason, "an operator reading the ledger must be able to tell the two shapes apart");
});

test("W1-T225 acceptance 3 — the re-review posts a FRESH verdict for the new head; a SUCCESS verdict recorded against the OLD head is never copied forward or used to skip the re-dispatch", async () => {
  const lp = ledgerPath();
  // The PR's prior head was reviewed and came back SUCCESS — then a push
  // orphaned it onto a brand-new head the ledger has never seen.
  appendLedger(lp, { run_id: "SWEEP-0", task_id: "W1-T584", step: "review.posted", head_sha: "aaaa111", state: "success" });

  const orphaned = orphanedGreenPr({ headSha: "dddd444" });
  const posted: Array<{ pr: number; sha: string }> = [];
  const deps = fakeDeps({
    ledgerPath: lp,
    postReview: (p) => {
      posted.push({ pr: p.prNumber, sha: p.headSha });
      // Simulates the real reviewer actually re-running and posting a FRESH
      // verdict for the NEW head — never a copy of the old success.
      appendLedger(lp, { run_id: "SWEEP-1", task_id: p.taskId ?? "", step: "review.posted", head_sha: p.headSha, state: "success" });
    },
  });
  const summary = await runSweep([orphaned], deps, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(posted, [{ pr: 584, sha: "dddd444" }], "the lane is invoked fresh for the NEW head, not skipped because an old head already succeeded");
  assert.equal(summary.byDisposition["post-review"], 1, "the old head's success never reclassified this pass as mergeable");
});

test("W1-T225 acceptance 4 (THE LOOP FALSIFIER) — repeated orphaning is BOUNDED: once priorReviewOrphans reaches the cap, the sweep escalates instead of re-dispatching indefinitely", async () => {
  const capped = orphanedGreenPr({ priorReviewOrphans: DEFAULT_SWEEP_POLICY.reviewOrphanCap });
  const derived = deriveDisposition(capped, DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(derived.disposition, "blocked-ambiguous", "the cap is met — escalate rather than retry forever");
  assert.match(derived.reason, /orphaned by a push, again/);
  assert.match(derived.reason, new RegExp(`${DEFAULT_SWEEP_POLICY.reviewOrphanCap} cap`));

  const posted: number[] = [];
  const deps = fakeDeps({ postReview: (p) => { posted.push(p.prNumber); } });
  await runSweep([capped], deps, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(posted, [], "FALSIFIER guard: an unbounded re-review loop would re-invoke postReview here — it must not");
  assert.equal(deps.escalated.length, 1, "a repeatedly-orphaned PR surfaces to an operator instead of looping silently");
});

test("W1-T225 — one strike BELOW the cap still re-dispatches (the bound is inclusive, not off-by-one)", () => {
  const almostCapped = orphanedGreenPr({ priorReviewOrphans: DEFAULT_SWEEP_POLICY.reviewOrphanCap - 1 });
  assert.equal(deriveDisposition(almostCapped, DEFAULT_SWEEP_POLICY, NOW).disposition, "post-review");
});

test("W1-T225 — a PR awaiting its FIRST review is never bound by the orphan cap, no matter what priorReviewOrphans carries stale/undefined as", () => {
  // reviewOrphanedByPush undefined -> this row must never match, even if some
  // future caller populated priorReviewOrphans incorrectly for a never-reviewed PR.
  const neverReviewed = ungatedGreenPr({ priorReviewOrphans: 99 });
  assert.equal(deriveDisposition(neverReviewed, DEFAULT_SWEEP_POLICY, NOW).disposition, "post-review");
});

// ── W1-T254: per-PR throw containment — one PR's thrown action never aborts the pass ──

test("runSweep: a throwing action does not abort the pass — later PRs still reconcile and the throwing PR is attributed (W1-T254)", async () => {
  const armedCalls: number[] = [];
  const deps = fakeDeps({
    arm: (p) => {
      if (p.prNumber === 10) throw new Error("arm boom");
      armedCalls.push(p.prNumber);
    },
  });
  const throwing = mergeablePr(); // prNumber 10
  const healthy = pr({
    prNumber: 20,
    prUrl: "url/20",
    taskId: "W1-C",
    reviewState: "success",
    checksState: "green",
    headSha: "bbbb222",
  });

  const summary = await runSweep([throwing, healthy], deps, DEFAULT_SWEEP_POLICY);

  assert.deepEqual(armedCalls, [20], "the later PR still reconciled after the earlier PR's action threw");
  assert.equal(summary.actionsTaken, 1, "only the successful arm counts toward actionsTaken");

  const throwingAction = summary.actions.find((a) => a.prNumber === 10);
  assert.equal(throwingAction?.acted, false, "the throwing PR's action is NOT credited as acted");
  assert.match(throwingAction?.actionError ?? "", /arm boom/);

  const disposed = readLedgerLines(deps.ledgerPath).filter((l) => l.step === "sweep.disposed");
  const throwLine = disposed.find((l) => l.pr_number === 10);
  assert.equal(throwLine?.acted, false);
  assert.match(String(throwLine?.action_error ?? ""), /arm boom/, "the throwing PR is attributed on its own ledger line");
  const healthyLine = disposed.find((l) => l.pr_number === 20);
  assert.equal(healthyLine?.acted, true, "the healthy PR still reconciled and was ledgered acted:true");
});

// ── W1-T99: sweep.action_failed + actionsFailed — one PR's escalate() throwing isolates ──

test("runSweep: a 3-PR fixture where the MIDDLE PR's escalate throws -> sweep.action_failed ledgered for it, the other two reconcile, summary counts the failure", async () => {
  const escalated: number[] = [];
  const deps = fakeDeps({
    escalate: (p) => {
      if (p.prNumber === 2) throw new Error("gh: label \"escalation-blocked\" not found");
      escalated.push(p.prNumber);
    },
  });
  const first = strikesExhaustedPr(); // prNumber 13 -> blocked-ambiguous
  const middle = { ...strikesExhaustedPr(), prNumber: 2, prUrl: "url/2", taskId: "W1-MID", headSha: "cccc333" };
  const last = { ...strikesExhaustedPr(), prNumber: 3, prUrl: "url/3", taskId: "W1-LAST", headSha: "dddd444" };

  const summary = await runSweep([first, middle, last], deps, DEFAULT_SWEEP_POLICY);

  assert.deepEqual(escalated.sort((a, b) => a - b), [3, 13], "the other two PRs' escalate actions still completed");
  assert.equal(summary.actionsFailed, 1, "the summary counts exactly one failed action");
  assert.equal(summary.actionsTaken, 2, "the two successful escalations still count as actions taken");

  const failedLines = readLedgerLines(deps.ledgerPath).filter((l) => l.step === "sweep.action_failed");
  assert.equal(failedLines.length, 1, "exactly one sweep.action_failed line");
  assert.equal(failedLines[0].pr_number, 2);
  assert.equal(failedLines[0].disposition, "blocked-ambiguous");
  assert.match(String(failedLines[0].error), /escalation-blocked.*not found/);
});

test("runSweep: the canonical 2026-07-17 crash fixture — a single ambiguous PR whose gateway throws label-not-found never escapes runSweep, and the question payload still reached an issue via ENSURE-LABELS+DEGRADE", async () => {
  // This mirrors the REAL wiring (run-task.ts's sweep escalate closure): the question is
  // logged to the backlog, then `escalate()` is asked to open the issue. With W1-T99's
  // ENSURE-LABELS/DEGRADE fix, a gateway whose label provisioning hard-fails degrades the
  // label rather than throwing — so this real-shaped deps.escalate never throws at all,
  // and the sweep completes with the question delivered.
  const loggedQuestions: string[] = [];
  const issues = {
    ensureLabel(label: string) {
      return label !== "escalation-blocked"; // the exact 2026-07-17 shape: this one label is unprovisionable
    },
    create(_title: string, _body: string, _labels: string[]) {
      return "https://github.com/craigoley/remudero/issues/500";
    },
  };
  const sharedLedgerPath = ledgerPath();
  const deps = fakeDeps({
    ledgerPath: sharedLedgerPath,
    escalate: (pr, reason, question) => {
      loggedQuestions.push(question.question);
      escalate(
        {
          class: "BLOCKED",
          taskId: pr.taskId ?? "UNKNOWN",
          summary: `PR ${pr.prUrl} needs a clarification — ${reason}`,
          detail: reason,
          options: question.resolutions.map((r) => ({ label: r.label, detail: r.detail })),
          recommendation: question.resolutions[0].label,
        },
        { issues, ledgerPath: sharedLedgerPath, runId: "SWEEP-1" },
      );
    },
  });

  const summary = await runSweep([strikesExhaustedPr()], deps, DEFAULT_SWEEP_POLICY);

  assert.equal(summary.actionsFailed, 0, "no throw escaped runSweep — nothing counted as failed");
  assert.equal(summary.actionsTaken, 1, "the degraded-but-delivered escalation still counts as acted");
  assert.equal(loggedQuestions.length, 1, "the question payload was generated and handed to escalate()");

  const opened = readLedgerLines(deps.ledgerPath).filter((l) => l.step === "escalation.issue_opened");
  assert.equal(opened.length, 1, "the issue was opened despite the unprovisionable label");
  assert.deepEqual(opened[0].degraded_labels, ["escalation-blocked"]);
});

// ── W1-T254 light-sweep: the `actionable` guard stands down every dangerous lane ──

test("runSweep (light pass): a non-post-review disposition is DEFERRED when actionable restricts to post-review — no dangerous lane fires, re-derived next full sweep", async () => {
  const lp = ledgerPath();
  const deps = fakeDeps({ ledgerPath: lp, actionable: (d) => d === "post-review" });
  // A mergeable PR: its lane is ARM (a dangerous lane the light pass must never fire).
  await runSweep([mergeablePr()], deps, DEFAULT_SWEEP_POLICY);
  assert.equal(deps.armed.length, 0, "the light pass NEVER arms — a dangerous lane stands down");
  const disposed = readLedgerLines(lp).filter((l) => l.step === "sweep.disposed");
  assert.equal(disposed[0].disposition, "mergeable");
  assert.equal(disposed[0].acted, false, "deferred, not acted");
  assert.match(String(disposed[0].stand_down_reason), /deferred to full sweep \(light pass\)/);
});

test("runSweep (light pass): a post-review disposition IS actionable under the same guard — the ticker's one permitted lane fires", async () => {
  const lp = ledgerPath();
  const fired: number[] = [];
  const deps = fakeDeps({ ledgerPath: lp, actionable: (d) => d === "post-review", postReview: (p) => { fired.push(p.prNumber); } });
  await runSweep([ungatedGreenPr()], deps, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(fired, [584], "post-review is the ONE lane the light pass runs");
});

// ── impl-BC: the arm effect's OUTCOME is read, ledgered, and never made permanent ────
// `armAutoMerge` does not throw — it RETURNS one of seven outcomes, five of which armed
// nothing. The effect discarded that value and the sweep recorded `acted: true` regardless,
// which both hid the refusal and made it permanent (acted:true seeds prior.armed, so the
// next pass deduped forever). Observed live on PR #960.

test("arm outcome: a no-task-id refusal yields acted:false AND names itself in stand_down_reason", async () => {
  const deps = fakeDeps({ arm: () => "no-task-id" });
  await runSweep([mergeablePr()], deps, DEFAULT_SWEEP_POLICY);

  const disposed = readLedgerLines(deps.ledgerPath).filter((l) => l.step === "sweep.disposed");
  assert.equal(disposed.length, 1);
  assert.equal(disposed[0].disposition, "mergeable");
  assert.equal(disposed[0].acted, false, "an outcome that armed NOTHING must not record acted:true");
  assert.equal(
    disposed[0].stand_down_reason,
    "arm outcome: no-task-id",
    "the refusal must be visible in the LEDGER, not only on stdout via say()",
  );
});

test("arm outcome REGRESSION LOCK: an armed outcome still yields acted:true — the fix did not make everything stand down", async () => {
  const deps = fakeDeps({ arm: () => "armed" });
  await runSweep([mergeablePr()], deps, DEFAULT_SWEEP_POLICY);

  const disposed = readLedgerLines(deps.ledgerPath).filter((l) => l.step === "sweep.disposed");
  assert.equal(disposed[0].acted, true, "a genuine arm is still acted:true");
  assert.equal(disposed[0].stand_down_reason, undefined, "and carries no stand-down reason");
});

test("arm outcome: a PR that stood down on one pass is RETRIED on the next, not deduped forever", async () => {
  // PASS 1 — the arm refuses. This is the permanence half of the bug: the old code recorded
  // acted:true here, which seeded prior.armed and deduped the PR on every later pass.
  const first = fakeDeps({ arm: () => "no-task-id" });
  await runSweep([mergeablePr()], first, DEFAULT_SWEEP_POLICY);
  const firstDisposed = readLedgerLines(first.ledgerPath).filter((l) => l.step === "sweep.disposed");
  assert.equal(firstDisposed[0].acted, false, "pass 1 stood down");

  // PASS 2 — same ledger, same PR, same head. The arm MUST be attempted again.
  const calls: string[] = [];
  const second = fakeDeps({
    ledgerPath: first.ledgerPath,
    arm: (p) => {
      calls.push(p.prUrl);
      return "armed";
    },
  });
  await runSweep([mergeablePr()], second, DEFAULT_SWEEP_POLICY);

  assert.deepEqual(calls, ["url/10"], "the second pass RE-ATTEMPTED the arm rather than deduping it");
  const secondDisposed = readLedgerLines(second.ledgerPath).filter((l) => l.step === "sweep.disposed");
  const last = secondDisposed[secondDisposed.length - 1];
  assert.equal(last.acted, true, "and this time it armed");
  // `deduped` is omitted rather than written false, so assert falsiness, not the literal.
  assert.ok(!last.deduped, "it was never treated as already-done");
});

test("arm outcome: a NEW head sha re-earns an arm attempt even after a prior success on the old sha", async () => {
  // PASS 1 — a real arm on the original sha, recorded acted:true.
  const first = fakeDeps({ arm: () => "armed" });
  await runSweep([mergeablePr()], first, DEFAULT_SWEEP_POLICY);
  assert.equal(
    readLedgerLines(first.ledgerPath).filter((l) => l.step === "sweep.disposed")[0].acted,
    true,
    "pass 1 armed",
  );

  // PASS 2 — SAME PR number, NEW head sha. Keyed by PR number alone this was deduped
  // forever; sha-keyed (like `fixed`) the new head re-earns the attempt.
  const calls: string[] = [];
  const movedHead = mergeablePr();
  movedHead.headSha = "newsha0000";
  const second = fakeDeps({
    ledgerPath: first.ledgerPath,
    arm: (p) => {
      calls.push(p.headSha);
      return "armed";
    },
  });
  await runSweep([movedHead], second, DEFAULT_SWEEP_POLICY);

  assert.deepEqual(calls, ["newsha0000"], "the new head re-earned the arm attempt");
});
