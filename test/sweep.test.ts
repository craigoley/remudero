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
  renderClarificationQuestion,
  renderSweepSummary,
  runSweep,
  strikeCapForAnswer,
  toQuestionEntry,
  type CiFailure,
  type ClarificationQuestion,
  type FixDispatchEvidence,
  type OpenPrView,
  type RollupCheckEntry,
  type StrikeAttempt,
  type SweepDeps,
  type SweepPolicy,
} from "../src/lib/sweep.js";
import type { CriterionVerdict } from "../src/lib/review.js";
import { readLedgerLines } from "../src/lib/status.js";

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
    checksState: "red",
    priorStrikes: 0,
    unmetCriteria: [criterion({ claim: "criterion one" }), criterion({ claim: "criterion two" })],
    reviewSummary: "two criteria unmet",
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

test("deriveDisposition: in-flight (pending review, pending checks, not stale) -> blocked-ambiguous (the #161 fix — never armed pre-green)", () => {
  const r = deriveDisposition(pr(), DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(r.disposition, "blocked-ambiguous");
  assert.match(r.reason, /checks pending/);
  assert.match(r.reason, /review pending/);
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

test("W1-T100 acceptance 3 — review-failure routing is unchanged: a review-failure fixture still dispatches reviewer-unmet-shaped evidence", async () => {
  const deps = fakeDeps();
  await runSweep([blockedFixablePr()], deps);
  assert.equal(deps.fixed.length, 1);
  assert.equal(deps.fixed[0].evidence.unmetCriteria.length, 2, "the FULL unmet set, unchanged");
  assert.equal(deps.fixed[0].evidence.ciFailures, undefined, "a review-mode dispatch never carries ci-log evidence");
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
    byDisposition: { mergeable: 1, "blocked-fixable": 1, stale: 1, "blocked-ambiguous": 1 },
    actionsTaken: 4,
    actions: [],
    noneCount: 0,
  };
  assert.match(renderSweepSummary(s), /4 open PR\(s\) · 4 action\(s\) taken/);
});

// ── W1-T78: the CLARIFICATION-QUESTION rung — an ambiguous block yields a
// specific, decidable operator question, never silence (ratifies P22's new
// rung). ────────────────────────────────────────────────────────────────────

function strike(over: Partial<StrikeAttempt> = {}): StrikeAttempt {
  return { strike: 1, round: "resume", unmetCount: 1, ciGreen: true, reviewState: "failure", ...over };
}

test("renderClarificationQuestion: a strikes-exhausted fixture yields ONE question naming the decision, both candidate resolutions, and the PR/run context", () => {
  const pr = strikesExhaustedPr();
  const { reason } = deriveDisposition(pr);
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
  const { reason } = deriveDisposition(pr);
  const q = renderClarificationQuestion(pr, reason, []);
  const entry = toQuestionEntry(q, "2026-07-17T00:00:00.000Z");
  assert.equal(entry.ts, "2026-07-17T00:00:00.000Z");
  assert.equal(entry.task, "W1-D");
  assert.equal(entry.question, q.question);
  assert.match(entry.current_assumption ?? "", /BLOCKED-AMBIGUOUS/);
  assert.equal(entry.impact_if_wrong, "med");
  assert.deepEqual(Object.keys(entry).sort(), ["current_assumption", "impact_if_wrong", "question", "task", "ts"]);
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
  assert.equal(deriveDisposition(strikesExhaustedPr()).disposition, "blocked-ambiguous");
  // Answered, with the default reset policy (a FRESH strikeCap), it re-arms.
  const result = deriveDisposition(answered);
  assert.equal(result.disposition, "blocked-fixable");
  assert.match(result.reason, /operator answered/);
});

test("deriveDisposition: an operator's answer ALSO re-arms a strikes-exhausted blocked_ci PR (W1-T100) — the ANSWERED row was generalized alongside the exhaustion/fixable rows, one ladder for both shapes", () => {
  const answered: OpenPrView = { ...blockedCiExhaustedPr(), pendingAnswer: { constraint: "pin the dependency version" } };
  // Un-answered, this fixture is strikes-exhausted -> blocked-ambiguous (baseline).
  assert.equal(deriveDisposition(blockedCiExhaustedPr()).disposition, "blocked-ambiguous");
  // Answered, with the default reset policy (a FRESH strikeCap), it re-arms — the
  // SAME row that re-arms a review-failure PR, never a second, un-generalized path.
  const result = deriveDisposition(answered);
  assert.equal(result.disposition, "blocked-fixable");
  assert.match(result.reason, /operator answered/);
});

test("deriveDisposition: resetStrikeCounterOnAnswer=false grants exactly ONE extra strike beyond the original cap — a PR that has ALSO exhausted that one extra strike still escalates rather than looping forever", () => {
  const policy: SweepPolicy = { ...DEFAULT_SWEEP_POLICY, clarify: { resetStrikeCounterOnAnswer: false } };
  // strikeCap is 2; a bounded extra strike raises the cumulative ceiling to 3
  // (policy.strikeCap + strikeCapForAnswer(2, {reset:false}) === 2 + 1).
  const justAnswered: OpenPrView = { ...strikesExhaustedPr(), priorStrikes: 2, pendingAnswer: { constraint: "use approach X" } };
  // priorStrikes (2) IS below the ceiling (3) -> the one bounded extra strike is granted.
  assert.equal(deriveDisposition(justAnswered, policy).disposition, "blocked-fixable");

  // The extra strike was ALSO spent (ledger now shows 3 dispatches) and the PR
  // is STILL failing with a (new, unconsumed) pendingAnswer -> the ceiling (3)
  // is no longer above priorStrikes (3) -> escalates again rather than granting
  // a THIRD attempt off the same answer.
  const stillFailing: OpenPrView = { ...justAnswered, priorStrikes: 3 };
  assert.equal(deriveDisposition(stillFailing, policy).disposition, "blocked-ambiguous");
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

test("W1-T103 — checksStateFromRollup: no requiredContexts supplied (unreadable branch protection) degrades to the pre-fix conservative fallback — every reported context counts", () => {
  const rollup: RollupCheckEntry[] = [
    rollupCheck({ name: "ci-gate", conclusion: "SUCCESS" }),
    rollupCheck({ name: "schedule-stub", conclusion: "SKIPPED" }),
  ];
  assert.equal(checksStateFromRollup(rollup, undefined), "pending", "SKIPPED isn't SUCCESS under the fail-closed fallback");

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
  assert.equal(deriveDisposition(healedPr, DEFAULT_SWEEP_POLICY).disposition, "mergeable");

  const deps = fakeDeps();
  await runSweep([healedPr], deps);
  assert.equal(deps.armed.length, 1, "arm invoked exactly once");
  assert.equal(deps.armed[0].prNumber, 170);
});
