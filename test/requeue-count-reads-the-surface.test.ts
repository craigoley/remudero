import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  ABSENT_REPUSH_CAP,
  CHECK_REQUEUE_STEP,
  DEFAULT_SWEEP_POLICY,
  cancelledCheckAlreadyRequeuedFromSurface,
  cancelledCheckRequeueDecision,
  requeuedCheckKeysFromLedger,
  runSweep,
  type CancelledRequiredCheck,
  type ClarificationQuestion,
  type FixDispatchEvidence,
  type OpenPrView,
  type SweepDeps,
} from "../src/lib/sweep.js";
import { readLedgerLines } from "../src/lib/status.js";

/**
 * W1-T2431 — A COUNTER CANNOT SEE AN ACTION IT DID NOT WRITE. `sweep.check_requeued` is keyed on
 * a ledger row the fleet writes about its OWN re-queue action, so an equivalent operator act (a
 * hand-run `gh run rerun --job`) is invisible to it: rationale (4) measured 3 of 7 GitHub-recorded
 * re-runs with no `sweep.check_requeued` row anywhere in the union, and #3160 was cancelled TWICE
 * on one head with `escalateCancelledCheck` unable to fire because the key it checks was never
 * written.
 *
 * The remedy (Option A, rationale (10)) widens the "already requeued" reading with GitHub's own
 * `run_attempt` surface, carried on {@link CancelledRequiredCheck.runAttempt} — read fresh off the
 * rollup every pass, never a ledger row, so it counts a re-run whichever actor fired it and cannot
 * be archived away by a ledger rotation. It is OR'd with the existing ledger-derived reading
 * (`requeuedCheckKeysFromLedger`), never a replacement — every acceptance criterion below is
 * checked in one file, per the task's own acceptance list.
 */

const NOW = Date.parse("2026-08-28T00:56:15Z"); // #3160's own second-cancellation timestamp

function ledgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), "rmd-requeue-surface-")), "ledger.ndjson");
}

function pr(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 3160,
    prUrl: "https://github.com/craigoley/remudero/pull/3160",
    taskId: "W1-TX",
    reviewState: "none",
    checksState: "red",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: new Date(NOW).toISOString(),
    headSha: "3160head",
    headRefName: "run-W1-TX-1785378652634",
    autoMergeArmed: false,
    ...over,
  };
}

function fakeDeps(overrides: Partial<SweepDeps> = {}): SweepDeps & {
  fixed: Array<{ pr: OpenPrView; evidence: FixDispatchEvidence }>;
  escalated: Array<{ pr: OpenPrView; reason: string; question: ClarificationQuestion }>;
  requeued: Array<{ pr: OpenPrView; check: CancelledRequiredCheck }>;
  cancelledEscalated: Array<{ pr: OpenPrView; check: CancelledRequiredCheck; reason: string }>;
} {
  const fixed: Array<{ pr: OpenPrView; evidence: FixDispatchEvidence }> = [];
  const escalated: Array<{ pr: OpenPrView; reason: string; question: ClarificationQuestion }> = [];
  const requeued: Array<{ pr: OpenPrView; check: CancelledRequiredCheck }> = [];
  const cancelledEscalated: Array<{ pr: OpenPrView; check: CancelledRequiredCheck; reason: string }> = [];
  return {
    fixed,
    escalated,
    requeued,
    cancelledEscalated,
    arm: () => {},
    close: () => {},
    dispatchFix: (p, evidence) => {
      fixed.push({ pr: p, evidence });
    },
    escalate: (p, reason, question) => {
      escalated.push({ pr: p, reason, question });
    },
    requeueCheck: async (p, check) => {
      requeued.push({ pr: p, check });
    },
    escalateCancelledCheck: async (p, check, reason) => {
      cancelledEscalated.push({ pr: p, check, reason });
    },
    ledgerPath: ledgerPath(),
    runId: "SWEEP-REQUEUE-SURFACE-1",
    now: () => NOW,
    ...overrides,
  };
}

// ── acceptance: "the re-queue count is derived from the surface rather than from a row the
//    fleet wrote about itself" ────────────────────────────────────────────────────────────────

test("cancelledCheckAlreadyRequeuedFromSurface reads GitHub's own run_attempt, with no ledger involved at all", () => {
  assert.equal(cancelledCheckAlreadyRequeuedFromSurface(1), false, "attempt 1 — nothing re-run yet");
  assert.equal(cancelledCheckAlreadyRequeuedFromSurface(2), true, "attempt 2 — already re-run once");
  assert.equal(cancelledCheckAlreadyRequeuedFromSurface(3), true, "attempt 3 — re-run more than once");
});

test("runSweep: an operator's re-run — NO sweep.check_requeued row anywhere in the ledger, but GitHub's run_attempt already shows 2 — is COUNTED, not read as a fresh cancellation", async () => {
  const deps = fakeDeps();
  const subject = pr({
    ciFailures: [{ name: "coverage-ratchet", logTail: "" }],
    // #3160's own shape: an operator ran `gh run rerun --job` by hand — the fleet never wrote a
    // sweep.check_requeued row for this pair (the ledger is empty) — but GitHub's OWN run_attempt
    // already reads 2, because the re-run genuinely happened on GitHub's side.
    cancelledRequiredChecks: [{ name: "coverage-ratchet", jobId: "98714534929", runAttempt: 2 }],
  });
  assert.equal(readLedgerLines(deps.ledgerPath).length, 0, "precondition: the ledger carries no row for this pair at all");

  await runSweep([subject], deps, DEFAULT_SWEEP_POLICY);

  assert.equal(deps.requeued.length, 0, "the operator's re-run is COUNTED — no second re-queue is spent");
  assert.equal(deps.cancelledEscalated.length, 1, "an equivalent operator act is counted the same as a fleet re-queue would be");
  assert.match(deps.cancelledEscalated[0].reason, /already re-queued once/);
});

// ── acceptance: "a re-run taken outside the fleet is counted, so a second cancellation on one
//    head escalates" ─────────────────────────────────────────────────────────────────────────

test("runSweep: #3160's own shape — cancelled a second time on one head after an operator's out-of-band re-run — escalates to a human, never a third re-queue", async () => {
  const deps = fakeDeps();
  const subject = pr({
    ciFailures: [{ name: "coverage-ratchet", logTail: "" }],
    cancelledRequiredChecks: [{ name: "coverage-ratchet", jobId: "98714534929", runAttempt: 2 }],
  });

  await runSweep([subject], deps, DEFAULT_SWEEP_POLICY);

  assert.equal(deps.requeued.length, 0, "re-queueing cannot reach a second cancellation — same rule as a fleet-driven one");
  assert.equal(deps.cancelledEscalated.length, 1, "escalateCancelledCheck fires — this is exactly what could not fire before this fix");
  assert.equal(deps.cancelledEscalated[0].check.name, "coverage-ratchet");
  assert.equal(deps.fixed.length, 0, "still never the fix rung's job — no diff defect here");
});

// ── acceptance: "a first cancellation on a head with no prior attempt still re-queues exactly
//    as it does today" ───────────────────────────────────────────────────────────────────────

test("runSweep: a first cancellation, run_attempt 1 and no ledger row, still re-queues exactly once — unchanged", async () => {
  const deps = fakeDeps();
  const subject = pr({
    ciFailures: [{ name: "coverage-ratchet", logTail: "" }],
    cancelledRequiredChecks: [{ name: "coverage-ratchet", jobId: "98703339653", runAttempt: 1 }],
  });

  await runSweep([subject], deps, DEFAULT_SWEEP_POLICY);

  assert.equal(deps.requeued.length, 1, "the re-queue still fires exactly once, as it does today");
  assert.equal(deps.requeued[0].check.name, "coverage-ratchet");
  assert.equal(deps.cancelledEscalated.length, 0, "a first cancellation never escalates");

  const line = readLedgerLines(deps.ledgerPath).find((l) => l.step === CHECK_REQUEUE_STEP);
  assert.ok(line, "the ledger row is still written, exactly as before this task");
  assert.equal(line!.head_sha, "3160head");
  assert.equal(line!.check_name, "coverage-ratchet");
});

// ── acceptance: "the count survives a rotation because it is not read from an archived ledger
//    step" ────────────────────────────────────────────────────────────────────────────────────

test("the surface reading needs no ledger row at all — an EMPTY ledger (as a rotation would leave behind) still reads 'already requeued' off run_attempt alone", () => {
  // rationale (6): sweep.check_requeued is NOT in DECISION_RELEVANT_LEDGER_STEPS, so rotateLedger
  // archives every one of its lines — an empty ledger here stands in for "the row existed once
  // but a rotation already carried it off". cancelledCheckAlreadyRequeuedFromSurface never reads
  // the ledger at all, so that archival cannot touch its answer.
  const emptyLedgerKeys = requeuedCheckKeysFromLedger([]);
  assert.equal(emptyLedgerKeys.has("3160head@coverage-ratchet"), false, "the ledger-derived half reads NOTHING post-rotation");
  assert.equal(
    cancelledCheckAlreadyRequeuedFromSurface(2),
    true,
    "the surface-derived half is unaffected — it was never a ledger row to begin with",
  );
});

test("runSweep: an empty ledger (post-rotation) plus run_attempt 2 still escalates — the count survived what the ledger alone could not", async () => {
  const deps = fakeDeps();
  const subject = pr({
    ciFailures: [{ name: "coverage-ratchet", logTail: "" }],
    cancelledRequiredChecks: [{ name: "coverage-ratchet", jobId: "98714534929", runAttempt: 2 }],
  });
  assert.equal(readLedgerLines(deps.ledgerPath).length, 0, "precondition: nothing survives in the ledger for this pair");

  await runSweep([subject], deps, DEFAULT_SWEEP_POLICY);

  assert.equal(deps.cancelledEscalated.length, 1, "escalation still fires with zero ledger evidence for this pair");
  assert.equal(deps.requeued.length, 0);
});

// ── acceptance: "an unreadable surface read fails toward the existing behaviour and never
//    invents an attempt" ─────────────────────────────────────────────────────────────────────

test("cancelledCheckAlreadyRequeuedFromSurface(undefined) reads false — an unread run_attempt never invents a prior re-queue", () => {
  assert.equal(cancelledCheckAlreadyRequeuedFromSurface(undefined), false);
});

test("runSweep: cancelledRequiredChecks with no runAttempt at all (the real gateway's current, not-yet-wired shape) behaves EXACTLY as before this task — a first cancellation re-queues", async () => {
  const deps = fakeDeps();
  const subject = pr({
    ciFailures: [{ name: "coverage-ratchet", logTail: "" }],
    // No `runAttempt` field at all — the real gateway's shape until its producer wiring lands
    // (see CancelledRequiredCheck.runAttempt's own doc). Must fail toward the pre-existing
    // ledger-only behaviour, never toward inventing an "already requeued" reading out of nothing.
    cancelledRequiredChecks: [{ name: "coverage-ratchet", jobId: "12345" }],
  });

  await runSweep([subject], deps, DEFAULT_SWEEP_POLICY);

  assert.equal(deps.requeued.length, 1, "unreadable run_attempt never blocks the normal first re-queue");
  assert.equal(deps.cancelledEscalated.length, 0);
});

// ── acceptance: "no cap moves and nothing auto-resets or paces" ────────────────────────────────

test("ABSENT_REPUSH_CAP is untouched by this change", () => {
  assert.equal(ABSENT_REPUSH_CAP, 1, "this task's files: is sweep.ts's dedup construction — no cap moves");
});

test("runSweep: three consecutive passes over the SAME head — nothing auto-resets back to re-queuing once escalation has fired", async () => {
  const subject = pr({
    ciFailures: [{ name: "coverage-ratchet", logTail: "" }],
    cancelledRequiredChecks: [{ name: "coverage-ratchet", jobId: "98714534929", runAttempt: 2 }],
  });
  const shared = ledgerPath();

  const first = fakeDeps({ ledgerPath: shared });
  await runSweep([subject], first, DEFAULT_SWEEP_POLICY);
  assert.equal(first.cancelledEscalated.length, 1, "pass 1 escalates (surface already shows a prior re-run)");

  const second = fakeDeps({ ledgerPath: shared });
  await runSweep([subject], second, DEFAULT_SWEEP_POLICY);
  assert.equal(second.requeued.length, 0, "pass 2 does not re-queue — no auto-reset");
  assert.equal(second.cancelledEscalated.length, 1, "pass 2 escalates again — no pacing, no cooldown");

  const third = fakeDeps({ ledgerPath: shared });
  await runSweep([subject], third, DEFAULT_SWEEP_POLICY);
  assert.equal(third.requeued.length, 0, "pass 3 still does not re-queue");
  assert.equal(third.cancelledEscalated.length, 1, "pass 3 still escalates — the decision is stable across arbitrarily many passes");
});

// ── acceptance: "the other dedup sets are untouched and keep reading exactly what they read
//    today" ───────────────────────────────────────────────────────────────────────────────────

test("requeuedCheckKeysFromLedger — the ledger-only reading this task widens rather than replaces — still reads back the SAME row shape it always has", () => {
  const lines = [
    { step: CHECK_REQUEUE_STEP, head_sha: "abc123", check_name: "coverage-ratchet" },
    { step: "automerge.armed", head_sha: "abc123", pr_number: 1 }, // an unrelated dedup step's row
    { step: "sweep.disposed", head_sha: "abc123", disposition: "blocked-fixable" }, // another unrelated one
  ];
  const keys = requeuedCheckKeysFromLedger(lines);
  assert.equal(keys.size, 1, "only sweep.check_requeued rows are read — unrelated steps are ignored, exactly as before");
  assert.ok(keys.has("abc123@coverage-ratchet"));
});

test("cancelledCheckRequeueDecision's own contract (ledger-boolean in, requeue/escalate out) is unchanged by the surface addition", () => {
  const first = cancelledCheckRequeueDecision(false);
  assert.equal(first.requeue, true);
  assert.equal(first.escalate, false);

  const second = cancelledCheckRequeueDecision(true);
  assert.equal(second.requeue, false);
  assert.equal(second.escalate, true);
});

test("runSweep: a genuinely FAILING (never cancelled) required check is untouched — still dispatches the fix rung, run_attempt never consulted", async () => {
  const deps = fakeDeps();
  const subject = pr({
    ciFailures: [{ name: "ci-gate", logTail: "line one\nline two\nassertion failed at line 42\n" }],
    cancelledRequiredChecks: [],
  });

  await runSweep([subject], deps, DEFAULT_SWEEP_POLICY);

  assert.equal(deps.requeued.length, 0, "nothing cancelled — nothing to re-queue, unchanged");
  assert.equal(deps.fixed.length, 1, "a genuine failure still routes to the fix rung, exactly as before this task");
  assert.equal(deps.cancelledEscalated.length, 0);
});
