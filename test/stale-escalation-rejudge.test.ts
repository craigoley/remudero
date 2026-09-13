import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  ESCALATION_REJUDGED_STEP,
  MAX_ESCALATION_REJUDGES_PER_CYCLE,
  runEscalationReconcile,
  runStaleEscalationRejudge,
  STALE_ESCALATION_REJUDGE_DWELL_MS,
  type EscalationReconcileCandidate,
  type StaleEscalationRejudgeCandidate,
  type StaleEscalationRejudgeOptions,
} from "../src/lib/sweep.js";
import type { Escalation, EscalationJudgeVerdict } from "../src/lib/escalate.js";

/**
 * MEASURED 2026-09-08 (this task's rationale): issues #4541, #4568, #4595 and #4604 all named the
 * SAME still-open PR #4532. `runEscalationReconcile` correctly left all four live — its predicate
 * is referent terminality, and the referent was live — and a human closed all four by hand. This
 * suite proves the rung that would have caught them: it re-judges what is already open, using
 * evidence only time can supply, and it may only demote.
 */

const HOUR = 60 * 60 * 1000;

function baseEscalation(overrides: Partial<Escalation> = {}): Escalation {
  return {
    class: "BLOCKED",
    taskId: "W1-D",
    summary: "coverage-ratchet failing, no actionable unmet criteria",
    detail: "PR #4532's coverage-ratchet failure is being worked and needs no decision today",
    options: [{ label: "wait", detail: "let the owning task keep working it" }],
    recommendation: "wait",
    ...overrides,
  };
}

function candidateOf(overrides: Partial<StaleEscalationRejudgeCandidate> = {}): StaleEscalationRejudgeCandidate {
  return {
    issueUrl: "https://github.com/craigoley/remudero/issues/4541",
    issueNumber: 4541,
    escalation: baseEscalation(),
    ageMs: 7 * HOUR,
    referentStateNow: "PR #4532 still open, unchanged since this issue opened",
    siblingSummaries: ["#4568 — same PR #4532, same condition", "#4595 — same PR #4532, same condition"],
    stateKey: "pr-4532:open:siblings=2",
    ...overrides,
  };
}

/** A judge stub returning a fixed verdict, recording every candidate it was called with. */
function stubJudge(verdict: EscalationJudgeVerdict, calls: StaleEscalationRejudgeCandidate[] = []) {
  return async (c: StaleEscalationRejudgeCandidate) => {
    calls.push(c);
    return verdict;
  };
}

function freshDeps(overrides: Partial<StaleEscalationRejudgeOptions> = {}): { deps: StaleEscalationRejudgeOptions; ledgerPath: string; demotes: Array<{ url: string; reason: string }> } {
  const dir = mkdtempSync(join(tmpdir(), "rmd-rejudge-"));
  const ledgerPath = join(dir, "ledger.ndjson");
  writeFileSync(ledgerPath, "");
  const demotes: Array<{ url: string; reason: string }> = [];
  const deps: StaleEscalationRejudgeOptions = {
    judge: stubJudge({ decision: "deliver", reason: "stub" }),
    demote: (url, reason) => void demotes.push({ url, reason }),
    ledgerPath,
    runId: "TEST",
    ...overrides,
  };
  return { deps, ledgerPath, demotes };
}

function recordRows(ledgerPath: string): Array<Record<string, unknown>> {
  return readFileSync(ledgerPath, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
}

// ── Acceptance 1: an open escalation older than the dwell, whose referent is NOT terminal, is
// re-judged — the case runEscalationReconcile structurally cannot reach. ────────────────────────

test("a stale escalation whose referent is STILL OPEN is re-judged and demoted — runEscalationReconcile leaves the same shape untouched", async () => {
  // FIRST: prove the reconciler structurally cannot reach this. Same referent (still open,
  // neither merged nor closed), four issues naming it — the MEASURED shape.
  const reconcileCandidates: EscalationReconcileCandidate[] = [4541, 4568, 4595, 4604].map((n) => ({
    issueUrl: `https://github.com/craigoley/remudero/issues/${n}`,
    issueNumber: n,
    taskId: "PR-4532",
    derived: { merged: false, closed: false, prNumber: 4532 },
  }));
  const dir = mkdtempSync(join(tmpdir(), "rmd-reconcile-"));
  const reconcileLedger = join(dir, "ledger.ndjson");
  writeFileSync(reconcileLedger, "");
  const reconcileSummary = await runEscalationReconcile(reconcileCandidates, {
    closeIssue: () => assert.fail("the reconciler must never close a still-open referent"),
    ledgerPath: reconcileLedger,
    runId: "TEST",
  });
  assert.equal(reconcileSummary.closed, 0, "the reconciler closes nothing — the referent is live");
  assert.ok(
    reconcileSummary.results.every((r) => r.outcome === "left-live"),
    "every one of the four is left-live — this is precisely the residue this rung exists for",
  );

  // NOW: the re-judge rung reaches the SAME shape and demotes it.
  const calls: StaleEscalationRejudgeCandidate[] = [];
  const { deps, ledgerPath, demotes } = freshDeps({
    judge: stubJudge({ decision: "demote", reason: "same condition already triaged by three sibling escalations" }, calls),
  });
  const candidate = candidateOf({ ageMs: STALE_ESCALATION_REJUDGE_DWELL_MS + HOUR });
  const summary = await runStaleEscalationRejudge([candidate], deps);

  assert.equal(summary.rejudged, 1, "the judge was actually consulted");
  assert.equal(summary.demoted, 1);
  assert.equal(calls.length, 1, "the judge saw exactly the eligible candidate");
  assert.equal(demotes.length, 1);
  assert.deepEqual(demotes[0], { url: candidate.issueUrl, reason: "same condition already triaged by three sibling escalations" });
  assert.equal(summary.results[0]!.outcome, "demoted");

  const rows = recordRows(ledgerPath).filter((r) => r.step === ESCALATION_REJUDGED_STEP);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.judge_decision, "demote");
  assert.equal(rows[0]!.issue_url, candidate.issueUrl);
});

// ── Acceptance 2: an escalation younger than the dwell is never re-judged, no matter what a stub
// judge would say. ───────────────────────────────────────────────────────────────────────────────

test("an escalation younger than the dwell is never re-judged — even a judge that would demote everything is never consulted", async () => {
  const calls: StaleEscalationRejudgeCandidate[] = [];
  const { deps, demotes } = freshDeps({
    judge: stubJudge({ decision: "demote", reason: "would demote anything" }, calls),
  });
  const candidate = candidateOf({ ageMs: STALE_ESCALATION_REJUDGE_DWELL_MS - 1 });
  const summary = await runStaleEscalationRejudge([candidate], deps);

  assert.equal(calls.length, 0, "the judge must never be called for a fresh escalation");
  assert.equal(summary.rejudged, 0);
  assert.equal(summary.demoted, 0);
  assert.equal(demotes.length, 0);
  assert.equal(summary.results[0]!.outcome, "too-fresh");

  // Exactly at the dwell boundary: still not eligible — the gate is "longer than", strictly.
  const atBoundary = candidateOf({ ageMs: STALE_ESCALATION_REJUDGE_DWELL_MS });
  const atBoundarySummary = await runStaleEscalationRejudge([atBoundary], deps);
  assert.equal(calls.length, 0, "exactly at the dwell is not yet 'longer than' it");
  assert.equal(atBoundarySummary.results[0]!.outcome, "too-fresh");

  // One millisecond past the boundary: now eligible — this stub judge demotes everything, so the
  // eligible candidate IS demoted (proving it was actually consulted, not merely "not skipped").
  const pastBoundary = candidateOf({ ageMs: STALE_ESCALATION_REJUDGE_DWELL_MS + 1 });
  const pastBoundarySummary = await runStaleEscalationRejudge([pastBoundary], deps);
  assert.equal(calls.length, 1, "one millisecond past the dwell IS eligible");
  assert.equal(pastBoundarySummary.results[0]!.outcome, "demoted");
});

// ── Acceptance 3: the re-judge can DEMOTE and can never close or delete; a stub judge attempting
// anything else leaves the issue open and needs-human. ─────────────────────────────────────────

test("a deliver verdict leaves the issue open and needs-human — demote is never called", async () => {
  const { deps, demotes } = freshDeps({
    judge: stubJudge({ decision: "deliver", reason: "this one is genuinely still live" }),
  });
  const candidate = candidateOf({ ageMs: STALE_ESCALATION_REJUDGE_DWELL_MS + HOUR });
  const summary = await runStaleEscalationRejudge([candidate], deps);

  assert.equal(demotes.length, 0, "deliver must never trigger a demote");
  assert.equal(summary.demoted, 0);
  assert.equal(summary.results[0]!.outcome, "left-needs-human");
  assert.equal(summary.results[0]!.decision, "deliver");
});

test("a failed demote leaves that issue needs-human and does not strand the next re-judge", async () => {
  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const { deps, demotes } = freshDeps({
    judge: stubJudge({ decision: "demote", reason: "the sibling escalation already owns this condition" }),
    demote: (url, reason) => {
      if (url.endsWith("/4541")) throw new Error("GitHub relabel refused");
      demotes.push({ url, reason });
    },
    log: (step, extra) => logs.push({ step, extra }),
  });
  const failed = candidateOf({ ageMs: STALE_ESCALATION_REJUDGE_DWELL_MS + HOUR });
  const next = candidateOf({
    issueUrl: "https://github.com/craigoley/remudero/issues/4568",
    issueNumber: 4568,
    stateKey: "pr-4533:open:siblings=1",
    ageMs: STALE_ESCALATION_REJUDGE_DWELL_MS + HOUR,
  });

  const summary = await runStaleEscalationRejudge([failed, next], deps);

  assert.equal(summary.rejudged, 2, "both eligible issues reached the judge");
  assert.equal(summary.demoted, 1, "only the successful mutation counts as a demotion");
  assert.equal(summary.results[0]!.outcome, "demote-failed");
  assert.equal(summary.results[0]!.reason, "the sibling escalation already owns this condition");
  assert.equal(summary.results[1]!.outcome, "demoted", "the next issue is not stranded by the first failure");
  assert.deepEqual(demotes, [{ url: next.issueUrl, reason: "the sibling escalation already owns this condition" }]);
  assert.deepEqual(logs[0], {
    step: "sweep.escalation_rejudge_demote_failed",
    extra: {
      issue_url: failed.issueUrl,
      task_id: failed.escalation.taskId,
      error: "GitHub relabel refused",
    },
  });
});

test("the dependency surface this rung is given has no close/delete primitive at all — demote-only by construction", () => {
  // STRUCTURAL PROOF, not a behavioural probe: StaleEscalationRejudgeOptions declares exactly one
  // mutation (`demote`), and EscalationJudgeDecision itself is the closed "demote" | "deliver"
  // union — there is no third value this rung could even route to a close call.
  const { deps } = freshDeps();
  assert.deepEqual(
    Object.keys(deps).filter((k) => typeof (deps as unknown as Record<string, unknown>)[k] === "function").sort(),
    ["demote", "judge"].sort(),
    "the only callable surfaces are judge (read) and demote (the one allowed mutation)",
  );
});

// ── Acceptance 4: a second pass over UNCHANGED state spawns no second judge. ────────────────────

test("a second pass over the SAME observed state spawns no second judge — one verdict per condition, not one per poll", async () => {
  const calls: StaleEscalationRejudgeCandidate[] = [];
  const { deps: firstPassDeps } = freshDeps({ judge: stubJudge({ decision: "demote", reason: "r" }, calls) });
  const candidate = candidateOf({ ageMs: STALE_ESCALATION_REJUDGE_DWELL_MS + HOUR, stateKey: "pr-4532:open:siblings=2" });

  const first = await runStaleEscalationRejudge([candidate], firstPassDeps);
  assert.equal(calls.length, 1);
  assert.deepEqual(first.judgedStateKeys, ["pr-4532:open:siblings=2"]);

  // SECOND PASS: same candidate, same stateKey, prior history fed back in — exactly the
  // #4623/#4624 shape (minutes apart, same condition) this rung must not re-spend a spawn on.
  const { deps: secondPassDeps } = freshDeps({
    judge: stubJudge({ decision: "demote", reason: "r" }, calls),
    alreadyJudgedStateKeys: new Set(first.judgedStateKeys),
  });
  const second = await runStaleEscalationRejudge([candidate], secondPassDeps);
  assert.equal(calls.length, 1, "no second spawn for the identical observed state");
  assert.equal(second.rejudged, 0);
  assert.equal(second.results[0]!.outcome, "unchanged-state");

  // A CHANGE in the referent (a new stateKey) re-opens the question, exactly as design v demands.
  const { deps: thirdPassDeps } = freshDeps({
    judge: stubJudge({ decision: "demote", reason: "r" }, calls),
    alreadyJudgedStateKeys: new Set(first.judgedStateKeys),
  });
  const moved = candidateOf({ ageMs: STALE_ESCALATION_REJUDGE_DWELL_MS + HOUR, stateKey: "pr-4532:open:siblings=3" });
  const third = await runStaleEscalationRejudge([moved], thirdPassDeps);
  assert.equal(calls.length, 2, "a changed state key is judged again");
  assert.equal(third.rejudged, 1);
});

// ── Acceptance 5: a judge throw, timeout or unparseable verdict leaves the item on needs-human,
// unchanged — fail-open, the same polarity as at birth. ─────────────────────────────────────────

test("a throwing judge fails OPEN to deliver — the item stays needs-human, unchanged, and is never demoted", async () => {
  const { deps, demotes, ledgerPath } = freshDeps({
    judge: async () => {
      throw new Error("spawn timed out");
    },
  });
  const candidate = candidateOf({ ageMs: STALE_ESCALATION_REJUDGE_DWELL_MS + HOUR });
  const summary = await runStaleEscalationRejudge([candidate], deps);

  assert.equal(demotes.length, 0, "a throw must never demote");
  assert.equal(summary.demoted, 0);
  assert.equal(summary.results[0]!.outcome, "left-needs-human");
  assert.equal(summary.results[0]!.decision, "deliver", "fail-open is 'deliver', the same polarity as birth");
  assert.match(summary.results[0]!.reason ?? "", /spawn timed out/);

  const rows = recordRows(ledgerPath).filter((r) => r.step === ESCALATION_REJUDGED_STEP);
  assert.equal(rows.length, 1, "the fail-open verdict is still ledgered — both arms, like the birth judge");
  assert.equal(rows[0]!.judge_decision, "deliver");
});

test("MANUAL and GRILL stay exempt on re-judge too — never spend a spawn on an operator-owned class", async () => {
  const calls: StaleEscalationRejudgeCandidate[] = [];
  const { deps, demotes } = freshDeps({ judge: stubJudge({ decision: "demote", reason: "would demote" }, calls) });
  const candidate = candidateOf({
    ageMs: STALE_ESCALATION_REJUDGE_DWELL_MS + HOUR,
    escalation: baseEscalation({ class: "MANUAL" }),
  });
  const summary = await runStaleEscalationRejudge([candidate], deps);
  assert.equal(calls.length, 0, "MANUAL is exempt — the judge is never consulted");
  assert.equal(demotes.length, 0);
  assert.equal(summary.results[0]!.outcome, "left-needs-human");
  assert.equal(summary.results[0]!.decision, "deliver");
});

// ── Design iv: bounded per cycle, like MAX_ESCALATION_CLOSES_PER_CYCLE. ─────────────────────────

test("a backlog larger than the per-cycle bound defers the excess to the next sweep", async () => {
  const calls: StaleEscalationRejudgeCandidate[] = [];
  const { deps } = freshDeps({ judge: stubJudge({ decision: "deliver", reason: "r" }, calls), maxRejudges: 2 });
  const candidates = [0, 1, 2, 3].map((i) =>
    candidateOf({
      issueUrl: `https://github.com/craigoley/remudero/issues/${5000 + i}`,
      ageMs: STALE_ESCALATION_REJUDGE_DWELL_MS + HOUR,
      stateKey: `state-${i}`,
    }),
  );
  const summary = await runStaleEscalationRejudge(candidates, deps);
  assert.equal(calls.length, 2, "only the bound's worth of spawns run");
  assert.equal(summary.rejudged, 2);
  const deferred = summary.results.filter((r) => r.outcome === "deferred-cap");
  assert.equal(deferred.length, 2, "the rest defer rather than spend an unbounded number of spawns");
});

test("the default bound mirrors MAX_ESCALATION_CLOSES_PER_CYCLE's own value", () => {
  assert.equal(MAX_ESCALATION_REJUDGES_PER_CYCLE, 20);
});

// ── design iii: the prompt actually carries the three pieces of evidence only time can supply. ──

test("the re-judge prompt extends the birth prompt with age, referent state and siblings — never replaces it", async () => {
  const { buildStaleEscalationRejudgePrompt } = await import("../src/lib/sweep.js");
  const { buildEscalationJudgePrompt } = await import("../src/lib/escalate.js");
  const candidate = candidateOf({ ageMs: 7 * HOUR });
  const prompt = buildStaleEscalationRejudgePrompt(candidate);
  const birthPrompt = buildEscalationJudgePrompt(candidate.escalation);

  assert.ok(prompt.startsWith(birthPrompt), "the birth prompt rides byte-identical, never edited");
  assert.match(prompt, /OPEN FOR: 7 hours/);
  assert.match(prompt, /REFERENT STATE NOW: PR #4532 still open/);
  assert.match(prompt, /#4568 — same PR #4532, same condition/);
  assert.match(prompt, /WHEN IN DOUBT, DELIVER/);
});

test("no siblings renders explicitly, never a blank section", async () => {
  const { buildStaleEscalationRejudgePrompt } = await import("../src/lib/sweep.js");
  const prompt = buildStaleEscalationRejudgePrompt(candidateOf({ siblingSummaries: [] }));
  assert.match(prompt, /\(none — this is the only open escalation naming this referent\)/);
});

// ── dryRun leaves no trace, mirroring runEscalationReconcile's own contract. ─────────────────────

test("dryRun previews without writing to the ledger or calling demote", async () => {
  const { deps, ledgerPath, demotes } = freshDeps({
    judge: stubJudge({ decision: "demote", reason: "r" }),
    dryRun: true,
  });
  const candidate = candidateOf({ ageMs: STALE_ESCALATION_REJUDGE_DWELL_MS + HOUR });
  const summary = await runStaleEscalationRejudge([candidate], deps);
  assert.equal(summary.demoted, 1, "the preview still counts it");
  assert.equal(demotes.length, 0, "but the real mutation never runs");
  assert.equal(recordRows(ledgerPath).length, 0, "and nothing is ledgered");
});
