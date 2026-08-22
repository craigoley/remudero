import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { LiveWriteBlockedError, withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import { classifyUpdateBranchFailure, updateBranchViaGh } from "../src/run-task.js";
import { test } from "node:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeMutantModule } from "./helpers/mutant-module.js";
import {
  DEFAULT_CLARIFY_POLICY,
  DEFAULT_SWEEP_POLICY,
  DISPOSITION_RULES,
  actionableGateFailuresFromReasons,
  armedButStalled,
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
  runSweepLightPass,
  selectUpdateBranchTarget,
  strikeCapForAnswer,
  toQuestionEntry,
  MAX_ESCALATION_CLOSES_PER_CYCLE,
  RETIRABLE_ESCALATION_LABELS,
  type ArmedStalledPr,
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
  type SupersessionVerdict,
} from "../src/lib/sweep.js";
import { reviewLedgerReasons, type CriterionVerdict, type ReviewVerdict } from "../src/lib/review.js";
import { readLedgerLines } from "../src/lib/status.js";
import { appendLedger, type LedgerLine } from "../src/lib/ledger.js";
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

// ── W1-T920 — the supersession disposition acts on a REASON, never on a match ──────────────────

function supersededVerdict(over: Partial<SupersessionVerdict> = {}): SupersessionVerdict {
  return {
    status: "superseded",
    evidence: {
      supersedingPrNumber: 1969,
      taskId: "W1-T908",
      // The #1955 hand-diagnosis measured EXACTLY this shape: 131 raw lines, zero matched
      // hunks, four symbols already on main — the corpus control the reason must carry.
      diff: { rawLineCount: 131, matchedHunks: 0 },
    },
    detail: "trailer + diff read match #1969",
    ...over,
  };
}

test("W1-T920: the disposition is inert while its policy flag is off", () => {
  // The off path must be BYTE-FOR-BYTE today's behaviour: a verdict present on the PR, with the
  // flag at its shipped default (off), must change NOTHING — not the disposition, not the reason,
  // not even which DISPOSITION_RULES row matched.
  assert.equal(DEFAULT_SWEEP_POLICY.supersessionDisposalEnabled, false, "the flag defaults off");
  const withVerdict = pr({ supersessionVerdict: supersededVerdict() });
  const withoutVerdict = pr();
  assert.deepEqual(
    deriveDisposition(withVerdict, DEFAULT_SWEEP_POLICY, NOW),
    deriveDisposition(withoutVerdict, DEFAULT_SWEEP_POLICY, NOW),
    "a superseded verdict with the flag off must derive the identical disposition as no verdict at all",
  );
});

test("W1-T920: a superseded verdict acts only with the flag on", () => {
  const p = pr({ supersessionVerdict: supersededVerdict() });
  const off = deriveDisposition(p, DEFAULT_SWEEP_POLICY, NOW);
  assert.notEqual(off.disposition, "stale", "flag off: the verdict alone never closes anything");

  const on: SweepPolicy = { ...DEFAULT_SWEEP_POLICY, supersessionDisposalEnabled: true };
  const result = deriveDisposition(p, on, NOW);
  assert.equal(result.disposition, "stale", "flag on + a superseded verdict: closes");
  assert.match(result.reason, /#1969/);
});

test("W1-T920: an identical but unique pull request is never disposed", () => {
  // The #1873/#1874 falsifier (DECISIONS.md, W1-T919's 2026-08-16 ruling): byte-identical
  // titles, identical file lists, created 74 seconds apart — the one that merged was chosen by
  // an ARGUED difference, never a match. A detector keyed on identity would have closed the
  // better pull request. Two PRs sharing the SAME task id here (the closest this fixture shape
  // can get to "identical in trailer and title and file list") must still be disposed however
  // their OWN verdicts read, never by their resemblance to each other.
  const on: SweepPolicy = { ...DEFAULT_SWEEP_POLICY, supersessionDisposalEnabled: true };
  const uniqueTwin = pr({
    prNumber: 1873,
    taskId: "W1-T908",
    supersessionVerdict: { status: "unique", detail: "argued distinct — not the same change" },
  });
  const result = deriveDisposition(uniqueTwin, on, NOW);
  assert.notEqual(result.disposition, "stale", "a 'unique' verdict never closes, flag on or not");
  assert.doesNotMatch(result.reason, /superseded/i);
});

test("W1-T920: an indeterminate verdict never closes anything", () => {
  // Three-valued, not a falsy second value (design note iii): an unreadable answer is NOT a
  // finding of uniqueness and must not be collapsed into one.
  const on: SweepPolicy = { ...DEFAULT_SWEEP_POLICY, supersessionDisposalEnabled: true };
  const indeterminate = pr({
    supersessionVerdict: { status: "indeterminate", detail: "diff query errored — rate limited" },
  });
  assert.notEqual(deriveDisposition(indeterminate, on, NOW).disposition, "stale");

  // Absent entirely (the real gateway today, per OpenPrView.supersessionVerdict's SCOPE note)
  // behaves identically to indeterminate — the fail-open direction readLiveState's ok:false
  // already uses elsewhere in this module.
  assert.deepEqual(
    deriveDisposition(indeterminate, on, NOW),
    deriveDisposition(pr(), on, NOW),
    "no verdict at all disposes exactly like an indeterminate one",
  );
});

test("W1-T920: the disposition records its evidence and its corpus control", () => {
  const on: SweepPolicy = { ...DEFAULT_SWEEP_POLICY, supersessionDisposalEnabled: true };
  const result = deriveDisposition(pr({ supersessionVerdict: supersededVerdict() }), on, NOW);
  assert.equal(result.disposition, "stale");
  // The superseding PR + the shared task id — never a bare "superseded" label.
  assert.match(result.reason, /#1969/);
  assert.match(result.reason, /W1-T908/);
  // The corpus control travels WITH the hunk finding (design note iv) — a bare hunk count alone
  // cannot distinguish a genuinely empty diff from one whose read broke.
  assert.match(result.reason, /131 raw line/);
  assert.match(result.reason, /0 hunk/);
});

// ── W1-T932 — N concept PRs on one task must not kill each other by arithmetic ──────────────────

test("W1-T932: a sibling concept survives a higher numbered peer", () => {
  // The motivating shape: three concept PRs open one task. run-task.ts's arithmetic sets
  // `supersededBy` on every lower-numbered peer unconditionally (rationale (1)) — here, a
  // detector's OWN verdict positively asserts this PR is not actually superseded ("unique": the
  // read completed and found no supersession), and the coexistence gate is ON.
  const on: SweepPolicy = { ...DEFAULT_SWEEP_POLICY, conceptCoexistenceEnabled: true };
  const siblingConcept = pr({
    prNumber: 100,
    supersededBy: 102, // a higher-numbered sibling concept PR is also open
    supersessionVerdict: { status: "unique", detail: "argued distinct concept — not a duplicate" },
  });
  const result = deriveDisposition(siblingConcept, on, NOW);
  assert.notEqual(result.disposition, "stale", "a 'unique' verdict + the gate on must let the bare-number row yield");
  assert.doesNotMatch(result.reason, /superseded-by/);
});

test("W1-T932: an ordinary duplicate is still disposed stale", () => {
  // Design note ii, verbatim: "a guard that works for ordinary duplicate PRs must keep working."
  // An ordinary duplicate carries NO supersessionVerdict at all (no detector ever argued it is a
  // distinct concept) — so even with the coexistence gate ON, the bare-number row must still
  // fire exactly as it does today.
  const on: SweepPolicy = { ...DEFAULT_SWEEP_POLICY, conceptCoexistenceEnabled: true };
  const ordinaryDuplicate = pr({ prNumber: 100, supersededBy: 102 });
  const result = deriveDisposition(ordinaryDuplicate, on, NOW);
  assert.equal(result.disposition, "stale", "no verdict at all: the gate has nothing to act on, arithmetic still wins");
  assert.match(result.reason, /superseded-by #102/);
});

test("W1-T932: an unreadable verdict changes no disposition", () => {
  // Three-valued, not a falsy second value (mirrors W1-T920's own row 0 discipline): an
  // "indeterminate" read is NOT a finding of coexistence and must not be collapsed into "unique".
  const on: SweepPolicy = { ...DEFAULT_SWEEP_POLICY, conceptCoexistenceEnabled: true };
  const indeterminate = pr({
    prNumber: 100,
    supersededBy: 102,
    supersessionVerdict: { status: "indeterminate", detail: "diff query errored — rate limited" },
  });
  const withIndeterminate = deriveDisposition(indeterminate, on, NOW);
  assert.equal(withIndeterminate.disposition, "stale", "indeterminate never lets the bare-number row yield");

  // A malformed verdict (present but not literally "unique") behaves the same as absent — fail
  // CLOSED, never guessing a finding the read cannot support.
  const malformed = pr({ prNumber: 100, supersededBy: 102, supersessionVerdict: { status: "superseded" } as SupersessionVerdict });
  assert.equal(deriveDisposition(malformed, on, NOW).disposition, "stale");

  // And no verdict at all disposes IDENTICALLY to the indeterminate case — the same fail-open
  // direction `readLiveState`'s `ok:false` already uses elsewhere in this module.
  const absent = pr({ prNumber: 100, supersededBy: 102 });
  assert.deepEqual(
    deriveDisposition(indeterminate, on, NOW),
    deriveDisposition(absent, on, NOW),
    "an unreadable verdict disposes exactly like no verdict at all",
  );
});

test("W1-T932: concept coexistence is off by default", () => {
  assert.equal(DEFAULT_SWEEP_POLICY.conceptCoexistenceEnabled, false, "the flag defaults off");
  // Even a 'unique' verdict must not save this PR while the flag sits at its shipped default —
  // byte-for-byte today's arithmetic-only behaviour.
  const siblingConcept = pr({
    prNumber: 100,
    supersededBy: 102,
    supersessionVerdict: { status: "unique", detail: "argued distinct concept — not a duplicate" },
  });
  const withVerdict = deriveDisposition(siblingConcept, DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(withVerdict.disposition, "stale", "flag off: a verdict alone never spares anything");
  const withoutVerdict = deriveDisposition(pr({ prNumber: 100, supersededBy: 102 }), DEFAULT_SWEEP_POLICY, NOW);
  assert.deepEqual(withVerdict, withoutVerdict, "flag off: a verdict must derive the identical disposition as no verdict at all");
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

// W1-T923: a review failure that NAMES its own remedy (a GATE failure, not an unmet acceptance
// criterion) could never reach the fix rung, because the only route in was keyed on
// `unmetCriteria`, and a gate failure leaves that list empty (the #1991 motivating case: 12/12
// criteria `executed_pass`, `unmet_criteria: []`, yet the review still failed and named its own
// fix). `actionableGateFailures` is the sibling list this task adds — see its own doc on
// `OpenPrView` (lib/sweep.ts) for the full design.

test("W1-T923: a gate failure with a named remedy routes to the fix rung", () => {
  const p = pr({
    reviewState: "failure",
    checksState: "green",
    unmetCriteria: [],
    priorStrikes: 0,
    actionableGateFailures: [{ reason: "DECISIONS.md must credit the operator, not the worker" }],
  });
  const r = deriveDisposition(p, DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(r.disposition, "blocked-fixable");
  assert.match(r.reason, /1 actionable gate failure/);
  assert.match(r.reason, /named remedy/);
});

test("W1-T923: a remedy with two forms is never treated as actionable", () => {
  // #1991's own falsifier: the provenance check accepted `Chosen (RECOMMENDED, auto)` OR an
  // operator-attribution line, crediting different authors — a CHOICE between forms, which must
  // be EXCLUDED from the actionable list entirely, never included-but-flagged.
  assert.deepEqual(
    actionableGateFailuresFromReasons(["credit via Chosen (RECOMMENDED, auto)", "credit via an operator-attribution line"]),
    [],
    "a two-form remedy is excluded outright",
  );
  // Sanity: the exclusion is specific to a CHOICE, not to naming a remedy at all — a single
  // reason still produces exactly one actionable entry, carried through verbatim.
  assert.deepEqual(
    actionableGateFailuresFromReasons(["credit via Chosen (RECOMMENDED, auto)"]),
    [{ reason: "credit via Chosen (RECOMMENDED, auto)" }],
  );
  // Sanity: zero named reasons (#1991's OWN ledger shape, `reasons: []`) is also excluded —
  // nothing structured was named, so nothing is claimed to be.
  assert.deepEqual(actionableGateFailuresFromReasons([]), []);
});

test("W1-T923: the recoverable field is untouched by the new list", () => {
  // The exact combination design note (i) requires stay legible: unmetCriteria empty,
  // criteriaRecoverable false (no Remudero-Task: trailer to resolve criteria from), AND a
  // non-empty actionableGateFailures, all at once.
  const p = pr({
    taskId: undefined,
    reviewState: "failure",
    checksState: "green",
    unmetCriteria: [],
    criteriaRecoverable: false,
    priorStrikes: 0,
    actionableGateFailures: [{ reason: "credit via Chosen (RECOMMENDED, auto)" }],
  });
  const r = deriveDisposition(p, DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(r.disposition, "blocked-fixable", "the actionable gate failure still routes to the fix rung");
  assert.equal(p.criteriaRecoverable, false, "criteriaRecoverable's own VALUE is never touched by this list");
  assert.doesNotMatch(r.reason, /unrecoverable/, "row 7's unrecoverable wording never fires once row 6 claims the PR");
});

test("W1-T923: a PR without the new list keeps its existing disposition", () => {
  // Byte-identical to the pre-W1-T923 fixture/assertion at "failing review with NO actionable
  // criteria -> blocked-ambiguous (contradictory)" — a PR that carries neither list must still
  // land on row 7, unchanged, proving the new disjunct never widens what row 7 already claimed.
  const p = pr({ reviewState: "failure", unmetCriteria: [], priorStrikes: 0 });
  assert.equal(p.actionableGateFailures, undefined, "the fixture helper does not set this field by default");
  const r = deriveDisposition(p, DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(r.disposition, "blocked-ambiguous");
  assert.equal(
    r.reason,
    "review failing with no actionable unmet criteria (contradictory) — escalating",
    "byte-identical to the pre-W1-T923 wording",
  );
});

test("W1-T923: the class field alone never decides actionability", () => {
  // #1991 itself is classed `test_theater` — the class this design would otherwise treat as
  // unautomatable — while naming its own single-form remedy. `OpenPrView` carries no
  // `failure_class` field at all (design note v forbids keying on it), so this fixture proves
  // the routing predicate qualifies the PR purely off `actionableGateFailures` being populated,
  // with nothing resembling a classifier bucket anywhere in the input.
  const p = pr({
    reviewState: "failure",
    checksState: "green",
    unmetCriteria: [],
    priorStrikes: 0,
    actionableGateFailures: [{ reason: "test theater: added tests assert nothing, but the DECISIONS.md fix is X" }],
  });
  const r = deriveDisposition(p, DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(r.disposition, "blocked-fixable", "a judgement-classed row with a named single-form remedy still qualifies");
});

// ── W1-T1016 ─────────────────────────────────────────────────────────────────
//
// The reader (`actionableGateFailuresFromReasons` above), the disposition row (W1-T923's third
// `blocked-fixable` disjunct), and the repair (`deriveChangesetClaimUpdate`/`runFixRung`) all
// already existed and never met: a changeset-contradiction review failure ledgered `reasons: []`
// (the measured #1193 shape — every criterion substantiated, yet the review still failed on
// `bodyContradictsDiff`), so `actionableGateFailuresFromReasons`'s `length === 1` gate could never
// fire for it and the PR fell to `blocked-ambiguous` (a human) instead of the fix rung this exact
// shape already has a mechanical repair for. `reviewLedgerReasons` (lib/review.ts) is the fix — the
// SAME rule run-task.ts's `log("review.posted", …)` call now uses to populate `reasons` — closing
// the one-field gap between the write site and the reader below.

/** The measured #1193 shape: every criterion met, but `bodyContradictsDiff` still fails the verdict. */
function contradictionVerdict(): Pick<ReviewVerdict, "testTheater" | "summary" | "changesetContradictions"> & {
  criteria: CriterionVerdict[];
} {
  return {
    criteria: [criterion({ met: true, reason: "" })],
    testTheater: false,
    changesetContradictions: [{ claim: "exactly one file: MASTER-PLAN.md", files: ["src/lib/widget.ts"] }],
    summary:
      'remudero-review: FAIL — body contradicts its own diff: claimed "exactly one file: MASTER-PLAN.md", ' +
      "actual changed files: src/lib/widget.ts",
  };
}

test("W1-T1016: the ledger reader returns one actionable failure for that row", () => {
  // The write side (reviewLedgerReasons) and the read side (actionableGateFailuresFromReasons)
  // meeting on the SAME row — the exact seam the bug lived in.
  const reasons = reviewLedgerReasons(contradictionVerdict());
  assert.deepEqual(reasons, [contradictionVerdict().summary], "exactly one reason, never an empty array");
  assert.deepEqual(
    actionableGateFailuresFromReasons(reasons),
    [{ reason: contradictionVerdict().summary }],
    "the ledger reader now returns one actionable gate failure for this row",
  );
});

test("W1-T1016: a contradiction failure is dispositioned blocked fixable", () => {
  // Asserted at the DISPOSITION, not the field (design note v) — this is what actually stops the
  // PR from reaching a human.
  const reasons = reviewLedgerReasons(contradictionVerdict());
  const p = pr({
    reviewState: "failure",
    checksState: "green",
    unmetCriteria: [],
    priorStrikes: 0,
    actionableGateFailures: actionableGateFailuresFromReasons(reasons),
  });
  const r = deriveDisposition(p, DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(r.disposition, "blocked-fixable", "a changeset-contradiction failure now reaches the fix rung, not a human");
});

test("W1-T1016: removing the reason write fails the routing test", () => {
  const reviewUrl = new URL("../src/lib/review.ts", import.meta.url);
  const src = readFileSync(reviewUrl, "utf8");
  const target = "  if (reasons.length === 0 && (verdict.changesetContradictions?.length ?? 0) > 0) {\n    reasons.push(verdict.summary);\n  }\n";
  const occurrences = src.split(target).length - 1;
  assert.equal(occurrences, 1, "the substitution target must be UNIQUE or the mutant proves nothing");

  // File-sha bracketed (design clause vi): read the sha256 BEFORE the mutation.
  const originalSha = createHash("sha256").update(src).digest("hex");

  const mutated = "  if (reasons.length === 0 && (verdict.changesetContradictions?.length ?? 0) > 0) {\n    // reason write removed by the W1-T1016 mutation check\n  }\n";
  const mutatedSrc = src.replace(target, mutated);
  const mutatedSha = createHash("sha256").update(mutatedSrc).digest("hex");
  assert.notEqual(mutatedSha, originalSha, "the mutation must actually change the file content");

  const mutantPath = writeMutantModule("review.ts", mutatedSrc);
  return (async () => {
    const mutant = (await import(mutantPath)) as typeof import("../src/lib/review.js");

    const mutantReasons = mutant.reviewLedgerReasons(contradictionVerdict());
    assert.deepEqual(mutantReasons, [], "the mutant reverts to the pre-fix reasons: [] shape");
    assert.deepEqual(
      actionableGateFailuresFromReasons(mutantReasons),
      [],
      "with reasons: [] the reader can never produce an actionable gate failure",
    );
    const mutantPr = pr({
      reviewState: "failure",
      checksState: "green",
      unmetCriteria: [],
      priorStrikes: 0,
      actionableGateFailures: actionableGateFailuresFromReasons(mutantReasons),
    });
    const mutantDisposition = deriveDisposition(mutantPr, DEFAULT_SWEEP_POLICY, NOW);
    assert.equal(
      mutantDisposition.disposition,
      "blocked-ambiguous",
      "the routing test FAILS under the mutant — the PR falls back to reaching a human",
    );

    // The real, on-disk file was never touched by the mutant copy.
    const shaAfter = createHash("sha256").update(readFileSync(reviewUrl, "utf8")).digest("hex");
    assert.equal(shaAfter, originalSha, "the real file must read unchanged either side of the mutation check");

    // And the real, unmutated function still routes the contradiction shape to blocked-fixable.
    const realReasons = reviewLedgerReasons(contradictionVerdict());
    const realPr = pr({
      reviewState: "failure",
      checksState: "green",
      unmetCriteria: [],
      priorStrikes: 0,
      actionableGateFailures: actionableGateFailuresFromReasons(realReasons),
    });
    assert.equal(deriveDisposition(realPr, DEFAULT_SWEEP_POLICY, NOW).disposition, "blocked-fixable");
  })();
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

// ── W1-T514: the blocked-ambiguous dedup set is SHA-KEYED, exactly like every ──
//    sibling arm (`armed`/`fixed`/`depReviewed`) — PR-number-only let one
//    `acted:true` line at head A silence a genuinely NEW block at a later head
//    B forever, making `escalate()`'s own head-aware composite key (W1-T195)
//    unreachable for its intended beneficiary.

test("W1-T514: a new head re-earns its own escalation", async () => {
  const shared = ledgerPath();
  const first = fakeDeps({ ledgerPath: shared });
  await runSweep([strikesExhaustedPr()], first);
  assert.equal(first.escalated.length, 1, "escalates on the first head");

  // The SAME PR, re-dispositioned blocked-ambiguous at a DIFFERENT head sha.
  const secondHead: OpenPrView = { ...strikesExhaustedPr(), headSha: "cccc333" };
  const second = fakeDeps({ ledgerPath: shared });
  await runSweep([secondHead], second);
  assert.equal(
    second.escalated.length,
    1,
    "a new head must re-earn its own escalation — the sha-keyed sibling arms already work this way",
  );
});

test("W1-T514: the same head still escalates only once", async () => {
  const shared = ledgerPath();
  const first = fakeDeps({ ledgerPath: shared });
  await runSweep([strikesExhaustedPr()], first);
  assert.equal(first.escalated.length, 1, "escalates on the first pass");

  // The SAME PR at the SAME head, re-dispositioned blocked-ambiguous again.
  const second = fakeDeps({ ledgerPath: shared });
  await runSweep([strikesExhaustedPr()], second);
  assert.equal(
    second.escalated.length,
    0,
    "a held condition at an UNCHANGED head must not storm — same key, still deduped",
  );
});

test("W1-T514: the escalation carries the head it was raised against", async () => {
  const deps = fakeDeps();
  await runSweep([strikesExhaustedPr()], deps);
  assert.equal(deps.escalated.length, 1);
  assert.equal(
    deps.escalated[0].pr.headSha,
    strikesExhaustedPr().headSha,
    "the PR passed to escalate() carries its head sha — the real wiring (run-task.ts) reads " +
      "exactly this field into escalate()'s own headSha dedup dimension (W1-T195)",
  );
});

test("W1-T514: an unattributable filing still stands down", async () => {
  const deps = fakeDeps();
  const summary = await runSweep([unattributableFilingPr()], deps);
  assert.equal(summary.byDisposition["blocked-ambiguous"], 1);
  assert.equal(
    deps.escalated.length,
    0,
    "a plan-filing PR with no Remudero-Task trailer stands down (W1-T196) — the sha-keyed dedup " +
      "change must not disturb the unattributable-filing carve-out, which is checked BEFORE it",
  );
  const disposed = readLedgerLines(deps.ledgerPath).filter((l) => l.step === "sweep.disposed");
  assert.equal(disposed[0].acted, false);
  assert.match(String(disposed[0].stand_down_reason), /task id unresolved/);
});

// W1-T456 (DEFECT B): row 6 (`reviewState === "failure" && unmetCriteria.length > 0` ->
// blocked-fixable) ALREADY routes a task-id-less PR correctly — this task's own gap was purely
// that `buildOpenPrViews` (run-task.ts) never populated `unmetCriteria` for a filing PR at all,
// so it fell through to row 7's escalate-only "criteria unrecoverable" unconditionally. Once
// run-task.ts's new ledger read (the synthetic `PR-<n>` key `reviewCommand` already uses for
// every task-id-less review) resolves real unmet criteria, THIS row — no sweep.ts change
// needed — is what makes the failure resolvable by the fix rung without a task-id trailer.
test("W1-T456 acceptance 3 — a task-id-less PR (a plan-filing PR's shape) with REAL unmet criteria routes to blocked-fixable, never the criteria-unrecoverable escalation", async () => {
  const filingWithRealUnmet = pr({
    prNumber: 900,
    prUrl: "url/900",
    taskId: undefined,
    isPlanFiling: true,
    reviewState: "failure",
    checksState: "green",
    priorStrikes: 0,
    unmetCriteria: [criterion({ claim: "the filed shard's acceptance block is well-formed" })],
  });
  assert.equal(
    deriveDisposition(filingWithRealUnmet, DEFAULT_SWEEP_POLICY, NOW).disposition,
    "blocked-fixable",
    "resolvable by the fix rung — no Remudero-Task: trailer required",
  );

  const deps = fakeDeps();
  const summary = await runSweep([filingWithRealUnmet], deps);
  assert.equal(summary.byDisposition["blocked-fixable"], 1);
  assert.equal(deps.fixed.length, 1, "the fix rung is actually dispatched, not just routed");
  assert.deepEqual(deps.fixed[0].evidence.unmetCriteria, filingWithRealUnmet.unmetCriteria);
  assert.equal(deps.escalated.length, 0, "never reaches the criteria-unrecoverable escalation");
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

// W1-T984: the `conflicted` row now carries a `mergeConflictAdmissionEnabled` conjunct (default
// FALSE — a real evidence producer landed in that same task, and the predicate below cannot tell
// a genuine pure-concurrent-addition from an add/add collision, so admission stays an explicit
// opt-in). These two tests exercise the row's PREDICATE/DISPATCH mechanics, which W1-T106 already
// owns and this task does not change — so they opt the fixture IN via policy, the same explicit
// shape `supersessionDisposalEnabled`'s own tests already use, rather than asserting on the new
// default (that default is `deriveDisposition acceptance 3` below, and
// test/sweep-conflicted-disposition.test.ts's own suite).
const CONFLICT_ADMISSION_POLICY: SweepPolicy = { ...DEFAULT_SWEEP_POLICY, mergeConflictAdmissionEnabled: true };

test("deriveDisposition acceptance 1 — the #170 fixture (green checks, review PASS, mergeState dirty) dispositions CONFLICTED — the mergeable rule (row 8) cannot match a dirty PR, a regression lock ABOVE it", () => {
  const seeded = conflictedPurePr();
  const r = deriveDisposition(seeded, CONFLICT_ADMISSION_POLICY, NOW);
  assert.equal(r.disposition, "conflicted");
  assert.notEqual(r.disposition, "mergeable", "a dirty PR is NEVER armed no matter how green");
  assert.match(r.reason, /mergeState dirty/);
  assert.match(r.reason, /ci-gate\.yml/, "names the conflicting file");

  // The regression lock itself: feed the SAME fixture straight at the
  // mergeable row's own predicate (never a second, independently-hardcoded
  // check) — it must never positively match a dirty PR.
  const mergeableRow = DISPOSITION_RULES.find((row) => row.disposition === "mergeable")!;
  assert.equal(mergeableRow.when(seeded, CONFLICT_ADMISSION_POLICY, 0, NOW), true, "sanity: checks green + review success alone WOULD match");
  const conflictedRow = DISPOSITION_RULES.find((row) => row.disposition === "conflicted")!;
  assert.equal(conflictedRow.when(seeded, CONFLICT_ADMISSION_POLICY, 0, NOW), true, "the conflicted row matches FIRST, ordered above mergeable");
});

test("runSweep acceptance 2 — a pure-concurrent-addition conflict dispatches ONE merge-conflict-mode fix worker, carrying the conflicting files + both sides' log, never a reviewer-unmet/ci-log mix", async () => {
  const deps = fakeDeps();
  const seeded = conflictedPurePr();

  const summary = await runSweep([seeded], deps, CONFLICT_ADMISSION_POLICY);

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

// ── W1-T1110 — the dedup arm names itself, and only RE-ARMS a dispatch that ENDED without
//    landing a new head; a dispatch that DID land one keeps suppressing a second attempt, and
//    the strike ceiling/escalation at the cap is untouched throughout. ────────────────────────

test("W1-T1110 acceptance 1 — a still-deduped fix dispatch names itself on the disposed line's stand_down_reason, the light-pass arm's own shape", async () => {
  const shared = ledgerPath();
  const deps1 = fakeDeps({ ledgerPath: shared, runId: "SWEEP-1" });
  await runSweep([blockedFixablePr()], deps1);
  assert.equal(deps1.fixed.length, 1);

  // Same head sha, no ledger evidence the dispatched rung ever concluded — dedup holds, but
  // (this task's own fix) it must now NAME what it is standing down for, unlike before.
  const deps2 = fakeDeps({ ledgerPath: shared, runId: "SWEEP-2" });
  const summary = await runSweep([blockedFixablePr()], deps2);
  assert.equal(deps2.fixed.length, 0, "unchanged head sha, no conclusion evidence ⇒ still deduped");
  assert.equal(summary.actions[0].acted, false);

  const disposed = readLedgerLines(shared).filter((l) => l.step === "sweep.disposed");
  assert.equal(disposed.length, 2);
  assert.equal(disposed[1].acted, false);
  assert.match(
    String(disposed[1].stand_down_reason),
    /already dispatched.*aaaa111/,
    "the dedup row now names ITSELF — which head it already dispatched against — never silent",
  );
});

test("W1-T1110 acceptance 2 — a fix dispatch that ENDED without moving the head (CI never green) no longer suppresses the next pass", async () => {
  const shared = ledgerPath();
  const deps1 = fakeDeps({ ledgerPath: shared, runId: "SWEEP-1" });
  await runSweep([blockedFixablePr()], deps1);
  assert.equal(deps1.fixed.length, 1);

  // The dispatched fix worker's OWN rung ran a real strike and ended without ever going green —
  // ledgered under the SAME task_id `fix.dispatch`/`fix.ci_not_green` already stamp (W1-T78),
  // never a new step, never a timer (design (iii) explicitly refuses both).
  appendLedger(shared, { run_id: "SWEEP-1", task_id: "W1-B", step: "fix.dispatch", strike: 1, strike_cap: 2 });
  appendLedger(shared, { run_id: "SWEEP-1", task_id: "W1-B", step: "fix.ci_not_green", strike: 1, ci: "red" });

  const deps2 = fakeDeps({ ledgerPath: shared, runId: "SWEEP-2" });
  await runSweep([blockedFixablePr()], deps2);
  assert.equal(
    deps2.fixed.length,
    1,
    "a dispatch that ended without a new head must not dedup this PR against a head nothing will ever move again",
  );
});

test("W1-T1110 acceptance 2b — a fix dispatch that ENDED via a real (still-failing) review, never CI, ALSO re-arms — either evidence names a conclusion", async () => {
  const shared = ledgerPath();
  const deps1 = fakeDeps({ ledgerPath: shared, runId: "SWEEP-1" });
  await runSweep([blockedFixablePr()], deps1);
  assert.equal(deps1.fixed.length, 1);

  appendLedger(shared, { run_id: "SWEEP-1", task_id: "W1-B", step: "fix.dispatch", strike: 1, strike_cap: 2 });
  appendLedger(shared, { run_id: "SWEEP-1", task_id: "W1-B", step: "fix.review", strike: 1, state: "failure", unmet: 1 });

  const deps2 = fakeDeps({ ledgerPath: shared, runId: "SWEEP-2" });
  await runSweep([blockedFixablePr()], deps2);
  assert.equal(deps2.fixed.length, 1, "a still-failing review is a conclusion too — the dedup re-arms");
});

test("W1-T1110 acceptance 3 — a fix dispatch that DID resolve (landed a working push) still suppresses a second attempt on that same, now-stale head", async () => {
  const shared = ledgerPath();
  const deps1 = fakeDeps({ ledgerPath: shared, runId: "SWEEP-1" });
  await runSweep([blockedFixablePr()], deps1);
  assert.equal(deps1.fixed.length, 1);

  // The rung's strike genuinely succeeded — `fix.review` posted `state: "success"` and
  // `fix.resolved` fired (run-task.ts: only reached once `review.state === "success"`).
  appendLedger(shared, { run_id: "SWEEP-1", task_id: "W1-B", step: "fix.dispatch", strike: 1, strike_cap: 2 });
  appendLedger(shared, { run_id: "SWEEP-1", task_id: "W1-B", step: "fix.review", strike: 1, state: "success", unmet: 0 });
  appendLedger(shared, { run_id: "SWEEP-1", task_id: "W1-B", step: "fix.resolved", strikes: 1 });

  // Re-queried against the SAME head sha (in real operation this head is now stale — GitHub
  // would report the fix worker's new head instead — but the dedup for THIS exact key must
  // never re-arm on a resolved strike, so it is asserted directly here).
  const deps2 = fakeDeps({ ledgerPath: shared, runId: "SWEEP-2" });
  await runSweep([blockedFixablePr()], deps2);
  assert.equal(
    deps2.fixed.length,
    0,
    "a resolved dispatch is never read as stalled — it keeps suppressing a second attempt",
  );
});

test("W1-T1110 acceptance 4 — the strike ceiling and its escalation at the cap are unchanged by the dedup re-arm", async () => {
  const deps = fakeDeps();
  const summary = await runSweep([strikesExhaustedPr()], deps);
  assert.equal(summary.actions[0].disposition, "blocked-ambiguous", "exhaustion still routes off the disposition rule, not the dedup");
  assert.match(String(summary.actions[0].reason), /fix strikes exhausted \(2\/2\)/, "the cap itself (2) is untouched");
  assert.equal(deps.escalated.length, 1, "exhaustion still escalates loudly");
  assert.equal(deps.fixed.length, 0, "no fix dispatch fires once the cap is reached — the dedup re-arm never widens the cap");
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

// ── W1-T1116 — A SWEEP DISPOSITION NAMES THE REFUSAL THAT OVERRODE ITS INTENT, NEVER JUST THE
//    INTENT ITSELF. The `mergeable` arm's `alreadyDone` switch previously set no
//    `standDownReason` on any of its three disjuncts (`autoMergeArmed`, `prior.armed`,
//    `refused`), so a correctly-held PR read identically to a broken one. Fixed the same way
//    W1-T1110 already fixed the sibling "blocked-fixable"/"conflicted" dedup, one branch away:
//    name it on `dedupStandDownReason`, the light-pass arm's own established shape. ───────────

/** One `risk_judge.escalated` ledger line, exactly as risk-judge.ts (W1-T970) writes it. */
function riskEscalatedLine(over: Record<string, unknown> = {}): LedgerLine {
  return {
    run_id: "RISK-JUDGE",
    task_id: "W1-A",
    step: "risk_judge.escalated",
    issue_url: "https://github.com/o/r/issues/900",
    pr_number: 10, // mergeablePr()'s own prNumber
    head_sha: "aaaa111", // mergeablePr()'s own headSha
    ...over,
  };
}

test("W1-T1116: a risk-refused hold names the refusal on its own row", async () => {
  const shared = ledgerPath();
  appendLedger(shared, riskEscalatedLine());

  const deps = fakeDeps({ ledgerPath: shared });
  const summary = await runSweep([mergeablePr()], deps);
  assert.equal(deps.armed.length, 0, "the risk judge already refused this exact head — never re-armed");
  assert.equal(summary.actions[0].acted, false);

  const disposed = readLedgerLines(shared).filter((l) => l.step === "sweep.disposed");
  assert.equal(disposed.length, 1);
  assert.match(
    String(disposed[0].stand_down_reason),
    /risk judge escalated/,
    "the held row must name the refusal that overrode arming — never stay silent about it",
  );
});

test("W1-T1116: the held row names the escalation issue", async () => {
  const shared = ledgerPath();
  appendLedger(shared, riskEscalatedLine({ issue_url: "https://github.com/o/r/issues/2433" }));

  const deps = fakeDeps({ ledgerPath: shared });
  await runSweep([mergeablePr()], deps);

  const disposed = readLedgerLines(shared).filter((l) => l.step === "sweep.disposed");
  assert.match(
    String(disposed[0].stand_down_reason),
    /https:\/\/github\.com\/o\/r\/issues\/2433/,
    "the row must name the SAME escalation issue the sibling risk_judge.escalated row already points at — the pointer moved, not duplicated",
  );
});

test("W1-T1116: an already-armed hold is distinguishable from a refusal", async () => {
  const armedShared = ledgerPath();
  const armedAlready = mergeablePr();
  armedAlready.autoMergeArmed = true;
  const armedDeps = fakeDeps({ ledgerPath: armedShared });
  await runSweep([armedAlready], armedDeps);
  const armedRow = readLedgerLines(armedShared).find((l) => l.step === "sweep.disposed");

  const refusedShared = ledgerPath();
  appendLedger(refusedShared, riskEscalatedLine());
  const refusedDeps = fakeDeps({ ledgerPath: refusedShared });
  await runSweep([mergeablePr()], refusedDeps);
  const refusedRow = readLedgerLines(refusedShared).find((l) => l.step === "sweep.disposed");

  assert.notEqual(
    armedRow?.stand_down_reason,
    refusedRow?.stand_down_reason,
    "two DIFFERENT causes of acted:false must read as two different rows, never the same silence",
  );
  assert.match(String(armedRow?.stand_down_reason), /already armed/);
  assert.match(String(refusedRow?.stand_down_reason), /risk judge escalated/);
  assert.doesNotMatch(String(armedRow?.stand_down_reason), /risk judge/, "the armed row must not borrow the refusal's wording");
  assert.doesNotMatch(String(refusedRow?.stand_down_reason), /already armed/, "the refusal row must not borrow the armed wording");
});

test("W1-T1116: an armed disposition still acts unchanged", async () => {
  const deps = fakeDeps();
  const summary = await runSweep([mergeablePr()], deps);
  assert.deepEqual(deps.armed.map((p) => p.prNumber), [10], "an ordinary mergeable PR still arms exactly as before this task");
  assert.equal(summary.actions[0].acted, true);

  const disposed = readLedgerLines(deps.ledgerPath).find((l) => l.step === "sweep.disposed");
  assert.equal(
    disposed?.stand_down_reason,
    undefined,
    "an action that actually fired must never carry a stand-down reason — the field is exclusive to a non-action",
  );
});

test("W1-T1116: no disjunct clears on a timer", async () => {
  const shared = ledgerPath();
  appendLedger(shared, riskEscalatedLine());

  // The SAME head, read an enormous elapsed time later — design (iii) is explicit that no
  // disjunct here expires on a clock; only a NEW head sha or an explicit operator override
  // (already covered by test/sweep-arm-parity.test.ts's own W1-T970 cases) ever clears it.
  // `lastActivityAt` is advanced right alongside the sweep clock so the ONLY variable under
  // test is the ledger-held refusal's own age — otherwise this PR would independently go
  // "stale" from mere inactivity, which is a different rule this test must not exercise.
  const FAR_FUTURE = NOW + 1000 * 24 * 60 * 60 * 1000; // ~2.7 years later
  const stillFreshPr = { ...mergeablePr(), lastActivityAt: new Date(FAR_FUTURE - 60 * 60 * 1000).toISOString() };
  const deps = fakeDeps({ ledgerPath: shared, now: () => FAR_FUTURE });
  const summary = await runSweep([stillFreshPr], deps);
  assert.equal(deps.armed.length, 0, "still refused — no timer thawed it");
  assert.equal(summary.actions[0].acted, false);

  const disposed = readLedgerLines(shared).filter((l) => l.step === "sweep.disposed").at(-1);
  assert.match(
    String(disposed?.stand_down_reason),
    /risk judge escalated/,
    "the row still names the refusal after a huge elapsed time — the naming itself carries no expiry either",
  );
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

// ── W1-T463 — THE DIAGNOSIS: `runSweep`'s own loop over `openPrs` is sequential, and the
//    light sweep's `postReview` runs the REAL `reviewCommand` (a worktree materialize + every
//    whitelisted proof), never a cheap status flip — so a slow-to-judge PR used to block every
//    OTHER post-review-eligible PR queued behind it in the SAME restricted-light-sweep tick.
//    `runSweepLightPass` fires one `runSweep` call PER open PR, concurrently, so this file's
//    #584 fixture PR is never starved behind a slower sibling in the same pass again.
//
//    W1-T526 caps `post-review` admission at ONE PR per pass (see test/sweep-review-admission
//    .test.ts for that rule's own acceptance fixtures) — the two tests below now prove the
//    CONCURRENT-FAN-OUT property this section is actually about using a DIFFERENT disposition
//    (`blocked-fixable`) that W1-T526 leaves untouched (design (i): every disposition other
//    than post-review is unchanged), so they stay a regression lock for the #707-adjacent
//    stall without also re-asserting the now-superseded "every eligible PR reviews every pass"
//    behavior.

test("runSweepLightPass: fires runSweep once PER open PR, CONCURRENTLY — a slow action for one PR never blocks another PR's own action from completing (the #707-adjacent stall this closes)", async () => {
  const lp = ledgerPath();
  let releaseSlow: (() => void) | undefined;
  const slowGate = new Promise<void>((resolve) => {
    releaseSlow = resolve;
  });
  const order: number[] = [];
  const deps = fakeDeps({
    ledgerPath: lp,
    postReview: async (p) => {
      await slowGate; // the ONE admitted PR's "review" never resolves until released
      order.push(p.prNumber);
    },
    dispatchFix: (p) => {
      order.push(p.prNumber);
    },
  });
  // `slow` (584) is the only post-review-eligible PR here, so W1-T526 admits it into the review
  // lane above (gated on `slowGate`). `fast` (11) derives a DIFFERENT disposition
  // (blocked-fixable) this task leaves untouched — its own dispatch must still fire
  // concurrently, unblocked by the slow review, exactly as W1-T463 fixed.
  const slow = ungatedGreenPr(); // prNumber 584
  const fast = blockedFixablePr(); // prNumber 11
  const pending = runSweepLightPass([slow, fast], deps, DEFAULT_SWEEP_POLICY);
  // Flush pending microtasks WITHOUT ever releasing the slow gate. Under the pre-W1-T463 shape
  // (one `runSweep(openPrs, ...)` call over the whole array) PR 11 could never be reached —
  // let alone recorded here — until PR 584's gate released; runSweepLightPass reaches it anyway.
  await new Promise((resolve) => setImmediate(resolve));
  try {
    assert.deepEqual(order, [11], "the fast PR's fix dispatch completed while the slow PR's review was still in flight");
  } finally {
    // Always release, even if the assertion above throws — an unreleased gate would leave this
    // PR's review key claimed in the module-level mutex for the rest of THIS file's test run.
    releaseSlow?.();
  }
  await pending;
  assert.deepEqual(order, [11, 584], "the slow PR's review still completes once released");
});

test("runSweepLightPass: each PR still gets its own dedup/disposition/ledger line — the SAME per-PR path runSweep has always used, no PR shared across the concurrent calls", async () => {
  const lp = ledgerPath();
  const calls: number[] = [];
  const deps = fakeDeps({
    ledgerPath: lp,
    postReview: (p) => {
      calls.push(p.prNumber);
      appendLedger(lp, { run_id: "SWEEP-1", task_id: p.taskId ?? "", step: "review.posted", head_sha: p.headSha, state: "success" });
    },
  });
  // Both derive `post-review`; `a` carries the OLDER head, so W1-T526 admits it and `b` stands
  // down — but BOTH still get their own dedup/disposition/ledger line, never a merged/lossy
  // aggregate, which is this test's own point.
  const a = ungatedGreenPr({ headSha: "aaaa584", lastActivityAt: "2026-07-15T00:00:00Z" }); // prNumber 584, taskId W1-T584
  const b = ungatedGreenPr({ prNumber: 585, prUrl: "url/585", taskId: "W1-T585", headSha: "bbbb585", lastActivityAt: "2026-07-16T00:00:00Z" });
  const summaries = await runSweepLightPass([a, b], deps, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(calls, [584], "only the ONE admitted (oldest-head) PR's post-review action fired this pass");
  assert.equal(summaries.length, 2, "one summary per PR — no merged/lossy aggregate, even for the standing-down PR");
  const disposed = readLedgerLines(lp).filter((l) => l.step === "sweep.disposed");
  assert.equal(disposed.length, 2, "each PR still writes its own sweep.disposed line");
  const admittedLine = disposed.find((l) => l.pr_number === 584);
  const standingDownLine = disposed.find((l) => l.pr_number === 585);
  assert.equal(admittedLine?.acted, true, "the admitted PR's review really ran");
  assert.equal(standingDownLine?.acted, false, "the non-admitted PR stood down rather than sharing the lane");

  // A second pass over the SAME (stale) snapshot dedups the admitted PR's now-posted verdict —
  // proving the concurrent per-PR calls did not corrupt or drop its own dedup key.
  const calls2: number[] = [];
  const deps2 = fakeDeps({
    ledgerPath: lp,
    postReview: (p) => {
      calls2.push(p.prNumber);
    },
  });
  await runSweepLightPass([a, b], deps2, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(calls2, [], "584 is already reviewed (deduped) and its fixture is still the oldest head, so it is chosen again but does nothing; 585 stands down exactly as before");
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

// ── W1-T473: reviews get their OWN concurrency budget — originally the SAME ──
//    lane number dispatch uses (`policy.dispatchLanes`), with real mutual
//    exclusion supplying what single-threading used to give for free.
//    W1-T1049 split the review budget onto its own `policy.reviewLanes` field
//    (test/review-lane-budget.test.ts) — `dispatchLanes` no longer governs
//    review concurrency; the fixtures below are updated to match.

function greenPr(n: number): OpenPrView {
  return ungatedGreenPr({ prNumber: n, prUrl: `url/${n}`, taskId: `W1-BUDGET-${n}`, headSha: `sha${n}` });
}

test("W1-T473 — post-review PRs run CONCURRENTLY within one pass, not one at a time: two independent reviews are BOTH in flight before either resolves (the crux this task closes)", async () => {
  const started: number[] = [];
  const finished: number[] = [];
  let releaseBoth: () => void = () => {};
  const bothStarted = new Promise<void>((resolve) => {
    releaseBoth = resolve;
  });

  const deps = fakeDeps({
    postReview: async (p) => {
      started.push(p.prNumber);
      if (started.length === 2) releaseBoth();
      // A SERIAL implementation would await this whole call before ever
      // starting the second PR's — `started.length` would freeze at 1 and
      // this await would never resolve, timing out the race below. A
      // genuinely concurrent implementation starts BOTH before either
      // reaches this line.
      await bothStarted;
      finished.push(p.prNumber);
    },
  });

  const timeout = new Promise((_resolve, reject) =>
    setTimeout(() => reject(new Error("timed out — the two reviews never both started (still serial?)")), 5000),
  );
  await Promise.race([runSweep([greenPr(901), greenPr(902)], deps, DEFAULT_SWEEP_POLICY), timeout]);

  assert.deepEqual(started.sort(), [901, 902]);
  assert.deepEqual(finished.sort(), [901, 902]);
});

test("W1-T473 acceptance 2 — the review budget bounds CONCURRENCY, never ELIGIBILITY: 3 post-review PRs under a 2-lane budget run only 2 THIS pass, and the 3rd is picked up (untouched, still eligible) on the very next pass", async () => {
  const lp = ledgerPath();
  // W1-T1049: the review lane now has its OWN policy field (`reviewLanes`) — `dispatchLanes`
  // no longer governs review concurrency, so the tight budget below is set on the right field.
  const tightPolicy: SweepPolicy = { ...DEFAULT_SWEEP_POLICY, reviewLanes: 2 };
  const prs = [greenPr(801), greenPr(802), greenPr(803)];

  const attempts1: number[] = [];
  const deps1 = fakeDeps({
    ledgerPath: lp,
    postReview: (p) => {
      attempts1.push(p.prNumber);
      // Simulate the real effect reaching a verdict, exactly like the other
      // outcome-keyed dedup fixtures above — so pass 2 below can prove the
      // deferred PR (never attempted) is the one retried, not a re-roll of
      // one already handled.
      appendLedger(lp, { run_id: "SWEEP-1", task_id: p.taskId ?? "", step: "review.posted", head_sha: p.headSha, state: "success" });
    },
  });
  const summary1 = await runSweep(prs, deps1, tightPolicy);

  assert.equal(summary1.byDisposition["post-review"], 3, "ELIGIBILITY is unchanged — all 3 PRs still derive the post-review disposition");
  assert.equal(attempts1.length, 2, "the 2-lane budget bounds how many actually run THIS pass");
  const skipped = prs.map((p) => p.prNumber).filter((n) => !attempts1.includes(n));
  assert.equal(skipped.length, 1, "exactly one PR stood down on this pass, budget-exhausted, never dropped");

  const disposed1 = readLedgerLines(lp).filter((l) => l.step === "sweep.disposed");
  const skippedLine = disposed1.find((l) => l.pr_number === skipped[0]);
  assert.equal(skippedLine?.acted, false);
  assert.match(String(skippedLine?.stand_down_reason ?? ""), /review budget exhausted/);

  // The very next pass: the two ALREADY-reviewed PRs dedup (outcome-keyed,
  // W1-T254) and the deferred PR — never attempted, never ledgered an
  // outcome — is exactly the one that gets its turn.
  const attempts2: number[] = [];
  const deps2 = fakeDeps({ ledgerPath: lp, postReview: (p) => { attempts2.push(p.prNumber); } });
  const summary2 = await runSweep(prs, deps2, tightPolicy);
  assert.deepEqual(attempts2, skipped, "the deferred PR — and only it — is retried; nothing was permanently dropped");
  assert.equal(summary2.byDisposition["post-review"], 3, "eligibility is STILL unchanged on the follow-up pass");
});

test("W1-T473 acceptance 3 — a pass with NO post-review-eligible PRs starts ZERO review lanes: the budget is a ceiling on work that already exists, never a target that goes hunting for some", async () => {
  const calls: number[] = [];
  const deps = fakeDeps({ postReview: (p) => { calls.push(p.prNumber); } });

  // Every PR here derives something OTHER than post-review (mergeable / blocked-fixable).
  const summary = await runSweep([mergeablePr(), blockedFixablePr()], deps, DEFAULT_SWEEP_POLICY);
  assert.equal(summary.byDisposition["post-review"], 0);
  assert.deepEqual(calls, [], "zero eligible reviews -> postReview is never invoked, however large the lane budget is");

  // The degenerate case too: nothing open at all.
  const emptyCalls: number[] = [];
  const emptyDeps = fakeDeps({ postReview: (p) => { emptyCalls.push(p.prNumber); } });
  const emptySummary = await runSweep([], emptyDeps, DEFAULT_SWEEP_POLICY);
  assert.equal(emptySummary.total, 0);
  assert.deepEqual(emptyCalls, []);
});

test("W1-T473 — a postReview call that THROWS inside the concurrent budget batch is contained exactly like every other disposition's throw (W1-T254): acted:false, its own sweep.action_failed line, the pass still completes", async () => {
  const deps = fakeDeps({
    postReview: () => {
      throw new Error("reviewer worker boom");
    },
  });

  const summary = await runSweep([greenPr(910)], deps, DEFAULT_SWEEP_POLICY);

  const action = summary.actions.find((a) => a.prNumber === 910);
  assert.equal(action?.acted, false, "a thrown postReview call is never credited as acted");
  assert.match(action?.actionError ?? "", /reviewer worker boom/);

  const failed = readLedgerLines(deps.ledgerPath).filter((l) => l.step === "sweep.action_failed");
  assert.equal(failed.length, 1, "exactly one sweep.action_failed line, matching every other disposition's throw containment");
  assert.equal(failed[0].pr_number, 910);
  assert.equal(failed[0].disposition, "post-review");
  assert.match(String(failed[0].error), /reviewer worker boom/);

  const disposed = readLedgerLines(deps.ledgerPath).filter((l) => l.step === "sweep.disposed");
  const disposedLine = disposed.find((l) => l.pr_number === 910);
  assert.equal(disposedLine?.acted, false);
  assert.match(String(disposedLine?.action_error ?? ""), /reviewer worker boom/);
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
  // W1-T1061: the SAME outcome also rides its own field now, beside the sentence above —
  // re-derived from the prose assertion rather than dropping it, since together they are
  // what proves the outcome is recorded at all (design note (iv)).
  assert.equal(disposed[0].arm_outcome, "no-task-id", "the outcome is ALSO a field, not only prose");
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

// ── W1-T1061: the arm outcome is a FIELD on `sweep.disposed`, not only prose inside
// `stand_down_reason` — the sweep is the one lane that arms the most PRs and, until now,
// the one lane whose outcome could not be counted without splitting a sentence on a colon.
// `stand_down_reason` keeps its human sentence unchanged; `arm_outcome` is the new sibling.

test("sweep arm outcome: the disposed row carries the outcome as a field and not as prose", async () => {
  const deps = fakeDeps({ arm: () => "no-task-id" });
  await runSweep([mergeablePr()], deps, DEFAULT_SWEEP_POLICY);

  const disposed = readLedgerLines(deps.ledgerPath).filter((l) => l.step === "sweep.disposed");
  assert.equal(disposed.length, 1);
  // The FIELD carries the bare outcome name — never the "arm outcome: " prefix that only
  // ever belonged to the human sentence.
  assert.equal(disposed[0].arm_outcome, "no-task-id", "the outcome is its own field on the row");
  assert.notEqual(
    disposed[0].arm_outcome,
    "arm outcome: no-task-id",
    "the field is the bare outcome, not the prose sentence repeated onto a second key",
  );
});

test("sweep arm outcome: the field is readable without parsing a sentence", async () => {
  const deps = fakeDeps({ arm: () => "ledger-refused" });
  await runSweep([mergeablePr()], deps, DEFAULT_SWEEP_POLICY);

  const disposed = readLedgerLines(deps.ledgerPath).filter((l) => l.step === "sweep.disposed");
  // No `.split(":")`, no regex, no substring — a direct read of the field IS the outcome.
  assert.equal(disposed[0].arm_outcome, "ledger-refused");
  // Contrast: the sentence this used to be the ONLY carrier of still requires exactly that
  // parse — proving the field is a genuine escape from it, not a duplicate of the need.
  assert.equal(
    String(disposed[0].stand_down_reason).split(": ")[1],
    disposed[0].arm_outcome,
    "the sentence still needs a colon-split to yield the same value the field hands over directly",
  );
});

test("sweep arm outcome: a disposal with no arm attempt carries no outcome field", async () => {
  const deps = fakeDeps();
  await runSweep([blockedFixablePr()], deps, DEFAULT_SWEEP_POLICY);

  assert.equal(deps.armed.length, 0, "this disposition never reaches deps.arm at all");
  const disposed = readLedgerLines(deps.ledgerPath).filter((l) => l.step === "sweep.disposed");
  assert.equal(disposed.length, 1);
  assert.equal(disposed[0].disposition, "blocked-fixable");
  assert.equal("arm_outcome" in disposed[0], false, "no attempt means no field at all — not even null");
});

test("sweep arm outcome: the sentence and the field agree on what happened", async () => {
  const deps = fakeDeps({ arm: () => "head-unavailable" });
  await runSweep([mergeablePr()], deps, DEFAULT_SWEEP_POLICY);

  const disposed = readLedgerLines(deps.ledgerPath).filter((l) => l.step === "sweep.disposed");
  assert.equal(
    disposed[0].stand_down_reason,
    `arm outcome: ${disposed[0].arm_outcome}`,
    "one write site feeds both — the sentence and the field can never drift apart",
  );
});

test("sweep arm outcome: no new ledger step is added by the change", async () => {
  const deps = fakeDeps({ arm: () => "no-task-id" });
  await runSweep([mergeablePr()], deps, DEFAULT_SWEEP_POLICY);

  const steps = [...new Set(readLedgerLines(deps.ledgerPath).map((l) => l.step))];
  assert.deepEqual(steps, ["sweep.disposed"], "the field rides the EXISTING row — no new step, no new row");
});

// ── W1-T520: ARMED AND BEHIND, THE TWO FACTS NOTHING JOINED ──────────────────────────────────
// The sweep already knows a PR is armed and already knows its head is behind the base, and never
// puts them together — so a PR that armed itself and then stopped reads exactly like one still
// waiting for CI. Measured 2026-08-15 with `allow_update_branch: true`: eight of nine open PRs
// read `behind` and seven of those were armed, unchanged for hours. The flag offers the update
// button; it does not press it.

test("an armed pull request that has fallen behind is reported as needing an update", () => {
  const stalled = pr({ prNumber: 41, autoMergeArmed: true, mergeState: "behind", headSha: "beef111" });

  const found = armedButStalled([stalled]);

  assert.deepEqual(
    found,
    [{ prNumber: 41, prUrl: "https://github.com/o/r/pull/1", taskId: "W1-TX", headSha: "beef111" }],
    "both facts together are the stall, and the report carries each of them",
  );
});

test("an armed pull request that is up to date is not reported", () => {
  // THE COMMON CASE, AND IT MUST BE FREE. A detector that fired here would name every armed PR
  // every pass, which is the noise floor that makes an advisory unreadable.
  assert.deepEqual(armedButStalled([pr({ autoMergeArmed: true, mergeState: "clean" })]), []);
  // An UNREAD mergeState is not a stall either — same fail-closed default the field carries
  // everywhere else in the module.
  assert.deepEqual(armedButStalled([pr({ autoMergeArmed: true })]), []);
});

test("an unarmed stale pull request is left alone", () => {
  // The other half of the false-positive containment: behind is ordinary, and on its own says
  // nothing about whether anything is waiting on this PR.
  assert.deepEqual(armedButStalled([pr({ autoMergeArmed: false, mergeState: "behind" })]), []);
  // And the two together, over a realistic mixed pass: only the armed-and-behind one is named.
  const mixed = [
    pr({ prNumber: 1, autoMergeArmed: true, mergeState: "clean" }),
    pr({ prNumber: 2, autoMergeArmed: false, mergeState: "behind" }),
    pr({ prNumber: 3, autoMergeArmed: true, mergeState: "behind", headSha: "cafe222" }),
    pr({ prNumber: 4, autoMergeArmed: true, mergeState: "dirty" }),
  ];
  assert.deepEqual(armedButStalled(mixed).map((s) => s.prNumber), [3]);
});

test("a stalled pull request is reported on the ledger, and a quiet pass writes no row at all", async () => {
  // THE WIRING, DRIVEN THROUGH runSweep RATHER THAN THE PREDICATE ALONE. The shard's design clause
  // (ii) is that the OUTPUT is a ledger line naming the PR and both facts; a predicate nobody calls
  // would satisfy the three assertions above and report nothing in production.
  const rows: Array<Record<string, unknown>> = [];
  const stalled = pr({ prNumber: 77, autoMergeArmed: true, mergeState: "behind", headSha: "d0d0777" });
  const deps = fakeDeps({ appendLine: (_p, line) => { rows.push(line); } });

  await runSweep([stalled], deps, DEFAULT_SWEEP_POLICY);

  const reported = rows.filter((r) => r.step === "sweep.armed_stalled");
  assert.equal(reported.length, 1, `one row for the one stalled PR; saw ${JSON.stringify(rows.map((r) => r.step))}`);
  assert.equal(reported[0].pr_number, 77);
  assert.equal(reported[0].head_sha, "d0d0777", "the row pins the head the arm is bound to");
  assert.equal(reported[0].auto_merge_armed, true, "both facts travel on the row");
  assert.equal(reported[0].merge_state, "behind");

  // AND THE QUIET CASE WRITES NOTHING — not a `stalled: 0` heartbeat. A row per pass per PR is the
  // noise floor that makes an advisory unreadable.
  const quiet: Array<Record<string, unknown>> = [];
  await runSweep([pr({ autoMergeArmed: true, mergeState: "clean" })], fakeDeps({ appendLine: (_p, line) => { quiet.push(line); } }), DEFAULT_SWEEP_POLICY);
  assert.equal(quiet.filter((r) => r.step === "sweep.armed_stalled").length, 0);
});

// ── W1-T528: THE ACTION HALF — nothing presses the update button ─────────────────────────────
// W1-T520 detects the armed-and-behind set and only reports it (above). This selects AT MOST ONE
// from that set — oldest head first — and, when `deps.updateBranch` is wired, asks GitHub to
// update it. See `selectUpdateBranchTarget`'s own doc (lib/sweep.ts) for the full design.

test("W1-T528: one pull request is updated per pass and it is the oldest head", async () => {
  const older = pr({
    prNumber: 501,
    prUrl: "url/501",
    taskId: "W1-A",
    autoMergeArmed: true,
    mergeState: "behind",
    headSha: "aaa501",
    lastActivityAt: "2026-07-10T00:00:00Z",
  });
  const younger = pr({
    prNumber: 502,
    prUrl: "url/502",
    taskId: "W1-B",
    autoMergeArmed: true,
    mergeState: "behind",
    headSha: "bbb502",
    lastActivityAt: "2026-07-16T00:00:00Z",
  });

  // The pure selector picks the older head regardless of input order.
  assert.equal(selectUpdateBranchTarget([younger, older], NOW)?.prNumber, 501);
  assert.equal(selectUpdateBranchTarget([older, younger], NOW)?.prNumber, 501);

  // Wired through runSweep: exactly ONE update-branch attempt, and it names the older PR —
  // never both, however many PRs are armed-and-behind this pass.
  const calls: ArmedStalledPr[] = [];
  const rows: Array<Record<string, unknown>> = [];
  const deps = fakeDeps({
    updateBranch: (target) => {
      calls.push(target);
      return "updated";
    },
    appendLine: (_p, line) => {
      rows.push(line);
    },
  });
  await runSweep([younger, older], deps, DEFAULT_SWEEP_POLICY);

  assert.equal(calls.length, 1, "never more than one update-branch call per pass");
  assert.equal(calls[0].prNumber, 501, "the older head, not the younger one");
  const attempted = rows.filter((r) => r.step === "sweep.update_branch.attempted");
  assert.equal(attempted.length, 1);
  assert.equal(attempted[0].pr_number, 501);
  assert.equal(attempted[0].head_sha, "aaa501");
  assert.equal(rows.filter((r) => r.step === "sweep.update_branch.updated").length, 1);
});

test("W1-T528: a draft pull request is never updated", async () => {
  const draftOldest = pr({
    prNumber: 511,
    prUrl: "url/511",
    taskId: "W1-C",
    autoMergeArmed: true,
    mergeState: "behind",
    headSha: "ccc511",
    lastActivityAt: "2026-07-01T00:00:00Z",
    isDraft: true,
  });
  const notDraft = pr({
    prNumber: 512,
    prUrl: "url/512",
    taskId: "W1-D",
    autoMergeArmed: true,
    mergeState: "behind",
    headSha: "ddd512",
    lastActivityAt: "2026-07-15T00:00:00Z",
  });

  // The draft is OLDER (would win on age alone) but the operator's hold vetoes it outright.
  assert.equal(
    selectUpdateBranchTarget([draftOldest, notDraft], NOW)?.prNumber,
    512,
    "the non-draft PR is picked instead",
  );

  // And when the ONLY armed-and-behind PR is a draft, nothing is selected at all.
  assert.equal(selectUpdateBranchTarget([draftOldest], NOW), undefined);

  const calls: ArmedStalledPr[] = [];
  await runSweep(
    [draftOldest],
    fakeDeps({
      updateBranch: (t) => {
        calls.push(t);
        return "updated";
      },
    }),
    DEFAULT_SWEEP_POLICY,
  );
  assert.deepEqual(calls, [], "NEVER touch a draft, even as the sole candidate");
});

test("W1-T528: an in-flight run branch is skipped rather than raced", async () => {
  const inFlight = pr({
    prNumber: 521,
    prUrl: "url/521",
    taskId: "W1-T900",
    autoMergeArmed: true,
    mergeState: "behind",
    headSha: "eee521",
    headRefName: "run-W1-T900-1786845000000",
    lastActivityAt: "2026-07-01T00:00:00Z",
  });
  const settled = pr({
    prNumber: 522,
    prUrl: "url/522",
    taskId: "W1-E",
    autoMergeArmed: true,
    mergeState: "behind",
    headSha: "fff522",
    lastActivityAt: "2026-07-15T00:00:00Z",
  });
  const inFlightTaskIds = new Set(["W1-T900"]);

  // inFlight is OLDER (would win on age alone) but a live worker is still pushing to this exact
  // head — the #1902 shape (a mid-pass push racing its own PR's remudero-review).
  assert.equal(selectUpdateBranchTarget([inFlight, settled], NOW, inFlightTaskIds)?.prNumber, 522);

  // A head that is NOT a run-branch at all (foreign/human-authored) is never excluded by this rule.
  assert.equal(
    selectUpdateBranchTarget([{ ...inFlight, headRefName: "some-hand-authored-branch" }], NOW, inFlightTaskIds)
      ?.prNumber,
    521,
  );

  // And when EVERY armed-and-behind PR is in-flight, nothing is selected.
  assert.equal(selectUpdateBranchTarget([inFlight], NOW, inFlightTaskIds), undefined);

  const calls: ArmedStalledPr[] = [];
  await runSweep(
    [inFlight],
    fakeDeps({
      updateBranch: (t) => {
        calls.push(t);
        return "updated";
      },
      inFlightTaskIds,
    }),
    DEFAULT_SWEEP_POLICY,
  );
  assert.deepEqual(calls, [], "raced against its own worker's push — skipped, not updated");
});

test("W1-T528: a conflicting update is reported and skipped", async () => {
  const target = pr({
    prNumber: 531,
    prUrl: "url/531",
    taskId: "W1-F",
    autoMergeArmed: true,
    mergeState: "behind",
    headSha: "ggg531",
  });
  const calls: ArmedStalledPr[] = [];
  const rows: Array<Record<string, unknown>> = [];
  const deps = fakeDeps({
    updateBranch: (t) => {
      calls.push(t);
      return "conflict";
    },
    appendLine: (_p, line) => {
      rows.push(line);
    },
  });

  await runSweep([target], deps, DEFAULT_SWEEP_POLICY);

  assert.equal(calls.length, 1, "attempted exactly once — a conflict is never retried within the same pass");
  const conflictRows = rows.filter((r) => r.step === "sweep.update_branch.conflict");
  assert.equal(conflictRows.length, 1, "the conflict is reported on the ledger");
  assert.equal(conflictRows[0].pr_number, 531);
  assert.equal(rows.filter((r) => r.step === "sweep.update_branch.updated").length, 0, "never counted as updated");

  // A SECOND, wholly separate `runSweep` call (a later pass) is a fresh selection, never a retry
  // loop this call itself runs — this call above made exactly one attempt and stopped.
  await runSweep([target], deps, DEFAULT_SWEEP_POLICY);
  assert.equal(calls.length, 2, "a later PASS may try again — but this call attempted no retry on its own");
});

test("selectUpdateBranchTarget: an already-current or unarmed PR is never a candidate — armedButStalled's own filter, not re-checked here", () => {
  assert.equal(selectUpdateBranchTarget([pr({ prNumber: 541, autoMergeArmed: true, mergeState: "clean" })], NOW), undefined);
  assert.equal(selectUpdateBranchTarget([pr({ prNumber: 542, autoMergeArmed: false, mergeState: "behind" })], NOW), undefined);
  assert.equal(selectUpdateBranchTarget([], NOW), undefined);
});

test("runSweep: updateBranch omitted takes no effect — the pass still reports the stalled set exactly as W1-T520 always did", async () => {
  const stalled = pr({ prNumber: 551, autoMergeArmed: true, mergeState: "behind", headSha: "hhh551" });
  const rows: Array<Record<string, unknown>> = [];
  await runSweep([stalled], fakeDeps({ appendLine: (_p, line) => { rows.push(line); } }), DEFAULT_SWEEP_POLICY);
  assert.equal(rows.filter((r) => r.step === "sweep.armed_stalled").length, 1);
  assert.equal(rows.filter((r) => String(r.step).startsWith("sweep.update_branch")).length, 0);
});

test("runSweep: dryRun takes no update-branch effect and leaves no ledger trace", async () => {
  const stalled = pr({ prNumber: 552, autoMergeArmed: true, mergeState: "behind", headSha: "iii552" });
  const calls: ArmedStalledPr[] = [];
  const rows: Array<Record<string, unknown>> = [];
  await runSweep(
    [stalled],
    fakeDeps({
      dryRun: true,
      updateBranch: (t) => {
        calls.push(t);
        return "updated";
      },
      appendLine: (_p, line) => {
        rows.push(line);
      },
    }),
    DEFAULT_SWEEP_POLICY,
  );
  assert.deepEqual(calls, []);
  assert.equal(rows.filter((r) => String(r.step).startsWith("sweep.update_branch")).length, 0);
});

// ── W1-T528: the update-branch leaf, and why it needed its own coverage ──────────────────
//
// `updateBranchViaGh` and `classifyUpdateBranchFailure` (both run-task.ts) shipped with every
// sweep-side test injecting a fake `updateBranch` dep, so the REAL leaf — its guard, its
// `execFileSync`, and its catch arm — was reached by nothing. That is the seam-default gap
// CLAUDE.md names: when every test supplies its own fake, the default implementation and each
// catch arm are unreachable, and diff-coverage blocks on exactly those lines.
//
// These drive the real leaf through a PATH-shimmed `gh`, so "the command ran" and "the command
// did NOT run" are both evidence on disk rather than assumptions.

function shimGh(script: string): { dir: string; log: string; restore: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "rmd-t528-gh-"));
  const log = join(dir, "calls.log");
  writeFileSync(
    join(dir, "gh"),
    ["#!/bin/sh", `printf '%s\\n' "$*" >> ${JSON.stringify(log)}`, script, ""].join("\n"),
    { mode: 0o755 },
  );
  const oldPath = process.env.PATH;
  process.env.PATH = `${dir}:${oldPath}`;
  return { dir, log, restore: () => void (process.env.PATH = oldPath) };
}

const ghCalls = (log: string): string[] =>
  existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [];

const TARGET = { prNumber: 7, prUrl: "https://github.com/acme/remudero/pull/7", headSha: "d00d" };

test("W1-T528: the update-branch leaf refuses under the test runner and gh is never invoked", async () => {
  const gh = shimGh("exit 0");
  try {
    let caught: unknown;
    try {
      await updateBranchViaGh(TARGET);
    } catch (e) {
      caught = e;
    }
    assert.ok(caught instanceof LiveWriteBlockedError, "the leaf refused with LiveWriteBlockedError");
    assert.match(String((caught as Error).message), /gh-pr-merge/, "the error names the boundary it guards");
    assert.deepEqual(ghCalls(gh.log), [], "gh was never invoked — no live branch update happened");
  } finally {
    gh.restore();
  }
});

test("W1-T528: an exempted update-branch call reaches gh once and reports updated", async () => {
  const gh = shimGh("exit 0");
  try {
    const outcome = await withLiveWritesAllowed(() => updateBranchViaGh(TARGET));
    assert.equal(outcome, "updated", "a clean exit is reported as updated");
    const calls = ghCalls(gh.log);
    assert.equal(calls.length, 1, "exactly one gh call — this leaf never retries within a pass");
    assert.match(calls[0], /pr update-branch/, "and it is the update-branch call, not a merge");
  } finally {
    gh.restore();
  }
});

test("W1-T528: a failing update-branch is classified from its own stderr, never thrown at the caller", async () => {
  const gh = shimGh('echo "merge conflict between base and head" >&2; exit 1');
  try {
    const outcome = await withLiveWritesAllowed(() => updateBranchViaGh(TARGET));
    assert.equal(outcome, "conflict", "the catch arm classifies rather than propagating");
    assert.equal(ghCalls(gh.log).length, 1, "still exactly one call — a failure is not retried here");
  } finally {
    gh.restore();
  }
});

test("W1-T528: the failure classifier separates a conflict from an ordinary error", () => {
  for (const s of ["merge conflict", "branch has diverged", "divergent histories", "HTTP 422"]) {
    assert.equal(classifyUpdateBranchFailure(s), "conflict", `"${s}" names a conflict`);
  }
  for (const s of ["gh: command not found", "HTTP 500", "network unreachable", ""]) {
    assert.equal(classifyUpdateBranchFailure(s), "error", `"${s}" is an ordinary error`);
  }
});
