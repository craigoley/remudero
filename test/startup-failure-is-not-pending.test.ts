import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_SWEEP_POLICY,
  absentChecksRepushDecision,
  cancelledRequiredCheckNames,
  checksStateFromRollup,
  deriveDisposition,
  observedBlockerState,
  runSweep,
  stalledRunReason,
  type ClarificationQuestion,
  type FixDispatchEvidence,
  type OpenPrView,
  type RollupCheckEntry,
  type SweepDeps,
  type SweepPolicy,
  type WorkflowRunObservation,
} from "../src/lib/sweep.js";
import { readLedgerLines } from "../src/lib/status.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// W1-T2327 — "a run that never started reads as one still running": a workflow run whose
// conclusion is a startup failure schedules jobs that then sit non-terminal FOREVER, because a
// completed run schedules nothing further. `checksStateFromRollup` reads that as "pending" —
// structurally indistinguishable from ordinary in-flight CI — because the check-runs rollup never
// exposes the RUN's own conclusion. `stalledRunReason` is the join that makes it visible; this
// file locks its 11 acceptance criteria.

const NOW = Date.parse("2026-08-26T12:00:00Z");
const RECENT = "2026-08-26T11:59:00Z"; // 1 minute ago

function ledgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), "rmd-stalled-")), "ledger.ndjson");
}

function pr(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 2974,
    prUrl: "https://github.com/o/r/pull/2974",
    taskId: "W1-TX",
    reviewState: "pending",
    checksState: "pending",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: RECENT,
    headSha: "7ca8ba51",
    autoMergeArmed: false,
    ...over,
  };
}

/** A single job pinned "queued" inside a run whose conclusion is already terminal — the
 *  corrected discriminator's own shape (measured on #2974: four startup-failure runs left six
 *  jobs non-terminal between them). */
function terminalRunWithStuckJob(over: Partial<WorkflowRunObservation> = {}): WorkflowRunObservation {
  return {
    status: "completed",
    conclusion: "startup_failure",
    createdAt: RECENT,
    jobs: [{ status: "completed" }, { status: "queued" }],
    ...over,
  };
}

function stalledPr(over: Partial<OpenPrView> = {}): OpenPrView {
  return pr({ checksState: "pending", workflowRuns: [terminalRunWithStuckJob()], ...over });
}

/** A minimal, faithful `SweepDeps` fake — mirrors test/sweep.test.ts's own `fakeDeps`, just
 *  narrowed to what this file's runSweep-level tests (acceptance 7/8) need. */
function fakeDeps(overrides: Partial<SweepDeps> = {}): SweepDeps & {
  escalated: Array<{ pr: OpenPrView; reason: string; question: ClarificationQuestion }>;
} {
  const escalated: Array<{ pr: OpenPrView; reason: string; question: ClarificationQuestion }> = [];
  return {
    escalated,
    arm: () => {},
    close: () => {},
    dispatchFix: (_pr: OpenPrView, _evidence: FixDispatchEvidence) => {},
    escalate: (p, reason, question) => {
      escalated.push({ pr: p, reason, question });
    },
    ledgerPath: overrides.ledgerPath ?? ledgerPath(),
    runId: overrides.runId ?? "SWEEP-2327",
    now: () => NOW,
    ...overrides,
  };
}

// ── acceptance 1 — the corrected discriminator itself ────────────────────────────────────────

test("acceptance 1: a job left non-terminal inside a run whose conclusion is terminal is reported as STALLED, not pending", () => {
  const reason = stalledRunReason([terminalRunWithStuckJob()], DEFAULT_SWEEP_POLICY, NOW);
  assert.notEqual(reason, undefined);
  assert.match(reason!, /queued.*run already concluded.*startup_failure/s);

  const r = deriveDisposition(stalledPr(), DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(r.disposition, "blocked-ambiguous");
  assert.match(r.reason, /stalled, not pending/);
  assert.doesNotMatch(r.reason, /^not positively mergeable/, "must not read as the generic pending catch-all");
});

test("acceptance 1: the shape fires whatever the terminal run's OWN conclusion is — success, failure, or startup_failure alike (a job can be pinned by any of them)", () => {
  for (const conclusion of ["success", "failure", "startup_failure", "cancelled"]) {
    const reason = stalledRunReason([terminalRunWithStuckJob({ conclusion })], DEFAULT_SWEEP_POLICY, NOW);
    assert.notEqual(reason, undefined, conclusion);
  }
});

// ── acceptance 2 — no regression on ordinary in-flight CI ────────────────────────────────────

test("acceptance 2: a head whose runs are all progressing normally keeps the reading it has today", () => {
  const inProgress: WorkflowRunObservation[] = [{ status: "in_progress", createdAt: RECENT, jobs: [{ status: "in_progress" }] }];
  assert.equal(stalledRunReason(inProgress, DEFAULT_SWEEP_POLICY, NOW), undefined);

  const withRuns = pr({ checksState: "pending", workflowRuns: inProgress });
  const withoutRuns = pr({ checksState: "pending", workflowRuns: undefined });
  const a = deriveDisposition(withRuns, DEFAULT_SWEEP_POLICY, NOW);
  const b = deriveDisposition(withoutRuns, DEFAULT_SWEEP_POLICY, NOW);
  assert.deepEqual(a, b, "normal in-flight runs must not change the disposition/reason at all");
});

test("acceptance 2: a completed run whose every job also completed is not stalled, whatever its conclusion", () => {
  const clean: WorkflowRunObservation[] = [{ status: "completed", conclusion: "success", jobs: [{ status: "completed" }] }];
  assert.equal(stalledRunReason(clean, DEFAULT_SWEEP_POLICY, NOW), undefined);
});

// ── acceptance 3/4 — the queued-past-a-bound shape, and the bound is configuration ────────────

test("acceptance 3: a run still waiting to begin is only called stalled once it passes the configured bound", () => {
  const justCreated: WorkflowRunObservation[] = [{ status: "queued", createdAt: new Date(NOW - 60_000).toISOString() }]; // 1m old
  assert.equal(
    stalledRunReason(justCreated, DEFAULT_SWEEP_POLICY, NOW),
    undefined,
    "1 minute is far inside the default 15m ceiling — normal start is seconds",
  );

  const wayPastCeiling: WorkflowRunObservation[] = [
    { status: "queued", createdAt: new Date(NOW - DEFAULT_SWEEP_POLICY.runQueuedCeilingMinutes * 60_000 - 60_000).toISOString() },
  ];
  const reason = stalledRunReason(wayPastCeiling, DEFAULT_SWEEP_POLICY, NOW);
  assert.notEqual(reason, undefined);
  assert.match(reason!, /queued/);
});

test("acceptance 4: the bound is read from configuration rather than written into the predicate — lowering it flips the verdict with zero code change", () => {
  const fiveMinutesOld: WorkflowRunObservation[] = [{ status: "queued", createdAt: new Date(NOW - 5 * 60_000).toISOString() }];
  assert.equal(stalledRunReason(fiveMinutesOld, DEFAULT_SWEEP_POLICY, NOW), undefined, "under the default 15m ceiling");

  const lowered: SweepPolicy = { ...DEFAULT_SWEEP_POLICY, runQueuedCeilingMinutes: 1 };
  const reason = stalledRunReason(fiveMinutesOld, lowered, NOW);
  assert.notEqual(reason, undefined, "the SAME 5-minute-old run reads stalled once the configured ceiling drops below it");
  assert.match(reason!, /1m ceiling/);
});

// ── acceptance 5 — a partial rollup still reads pending; the ABSENT re-push arm is untouched ──

const REQUIRED = ["ci-gate", "remudero-review", "semgrep"];

function rollupCheck(over: Partial<RollupCheckEntry> = {}): RollupCheckEntry {
  return { name: "check", conclusion: "SUCCESS", ...over };
}

test("acceptance 5: a partially registered rollup (the #2974 shape — 23 check-runs, one still queued) still reads pending, so the ABSENT re-push arm is never reached", () => {
  const rollup: RollupCheckEntry[] = [
    rollupCheck({ name: "ci-gate", conclusion: "SUCCESS" }),
    rollupCheck({ name: "remudero-review", conclusion: "SUCCESS" }),
    rollupCheck({ name: "semgrep", conclusion: undefined, status: "queued" }),
  ];
  const checksState = checksStateFromRollup(rollup, REQUIRED);
  assert.equal(checksState, "pending", "a non-empty rollup with one unresolved required context is pending, never none");

  const stalled = pr({ checksState, workflowRuns: [terminalRunWithStuckJob()] });
  const decision = absentChecksRepushDecision(stalled, DEFAULT_SWEEP_POLICY, NOW, { count: 0, shas: new Set() });
  assert.equal(decision.repush, false);
  assert.match(decision.reason, /not the ABSENT state/);
  assert.equal(observedBlockerState(stalled), "PENDING", "never routed through the ABSENT/CONFLICTED/FAILING lanes");
});

// ── acceptance 6 — never routed into the cancelled-check lane, which has no entry to name ─────

test("acceptance 6: a stalled head is never routed into the cancelled-check lane — a queued job that never concluded CANCELLED has no entry to name", () => {
  const rollup: RollupCheckEntry[] = [
    rollupCheck({ name: "ci-gate", conclusion: "SUCCESS" }),
    rollupCheck({ name: "remudero-review", conclusion: "SUCCESS" }),
    // The stuck job's own check-run entry, if it registered one at all, sits QUEUED — never
    // CANCELLED. A run that fails to start does not cancel the jobs it never got to; it simply
    // never moves them again.
    rollupCheck({ name: "semgrep", conclusion: undefined, status: "queued" }),
  ];
  assert.deepEqual(cancelledRequiredCheckNames(rollup, REQUIRED), [], "nothing here carries a CANCELLED conclusion to name");
});

// ── acceptance 7/8 — escalate once, never retry, never re-record on an unchanged head ─────────

test("acceptance 7: the arm records the condition once and takes no retry action of any kind (the fresh head's first pass)", async () => {
  const deps = fakeDeps();
  await runSweep([stalledPr()], deps, DEFAULT_SWEEP_POLICY);
  assert.equal(deps.escalated.length, 1, "exactly one escalation — no repushed head, no re-run, no second call of any kind");
  assert.match(deps.escalated[0].reason, /stalled, not pending/);
  const disposed = readLedgerLines(deps.ledgerPath).filter((l) => l.step === "sweep.disposed");
  assert.equal(disposed.length, 1);
  assert.equal(disposed[0].disposition, "blocked-ambiguous");
});

test("acceptance 8: a second pass over the same unchanged head does not record the condition a second time", async () => {
  const first = fakeDeps();
  await runSweep([stalledPr()], first, DEFAULT_SWEEP_POLICY);
  assert.equal(first.escalated.length, 1);

  const second = fakeDeps({ ledgerPath: first.ledgerPath });
  await runSweep([stalledPr()], second, DEFAULT_SWEEP_POLICY);
  assert.equal(second.escalated.length, 0, "same pr@head already escalated — the existing sha-keyed dedup suppresses a repeat");

  // A genuinely NEW head (the operator's own remedy, or any other push) re-earns the escalation —
  // this is a dedup on the UNCHANGED head, never a permanent silence on the PR.
  const third = fakeDeps({ ledgerPath: first.ledgerPath });
  await runSweep([stalledPr({ headSha: "freshhead1" })], third, DEFAULT_SWEEP_POLICY);
  assert.equal(third.escalated.length, 1, "a new head must re-earn its own escalation, never be deduped by a stale head's line");
});

// ── acceptance 9 — a required check that never ran still leaves the merge blocked ─────────────

test("acceptance 9: a required check that never ran still leaves the merge blocked — never disposed mergeable", () => {
  const r = deriveDisposition(stalledPr(), DEFAULT_SWEEP_POLICY, NOW);
  assert.notEqual(r.disposition, "mergeable");
  assert.equal(r.disposition, "blocked-ambiguous");
});

// ── acceptance 10 — no waiting, no repeated fetching within a single pass ─────────────────────

test("acceptance 10: the detector performs no waiting and no repeated fetching within a single pass — one synchronous read, each run's jobs list touched once", () => {
  let jobsAccessCount = 0;
  const runs: WorkflowRunObservation[] = Array.from({ length: 5 }, (_, i) => ({
    status: "completed",
    conclusion: "success",
    get jobs() {
      jobsAccessCount += 1;
      return [{ status: "completed" }];
    },
  })) as unknown as WorkflowRunObservation[];
  // Add one genuinely stalled run last, so the loop must walk every prior entry first.
  runs.push(terminalRunWithStuckJob());

  // The signature itself is the proof of synchrony: `stalledRunReason` returns `string |
  // undefined`, never a `Promise` — there is no `await` anywhere in its body for a caller to
  // wait on. `typeof` pins that at runtime too, so a future edit widening the return type would
  // fail this assertion rather than fail silently.
  const result = stalledRunReason(runs, DEFAULT_SWEEP_POLICY, NOW);
  assert.notEqual(result, undefined, "still finds the stalled run at the end");
  assert.equal(typeof result, "string", "synchronous — no await, no polling loop of its own");
  assert.ok(jobsAccessCount <= runs.length, `each run's jobs list is read at most once per run (got ${jobsAccessCount} for ${runs.length} runs)`);
});

// ── acceptance 11 — an unreadable run listing invents no stall ────────────────────────────────

test("acceptance 11: an unreadable run listing (undefined) leaves the reading exactly as it is today rather than inventing a stall", () => {
  assert.equal(stalledRunReason(undefined, DEFAULT_SWEEP_POLICY, NOW), undefined);

  const unreadable = pr({ checksState: "pending", workflowRuns: undefined });
  const baseline = pr({ checksState: "pending" });
  delete (baseline as { workflowRuns?: unknown }).workflowRuns;
  assert.deepEqual(deriveDisposition(unreadable, DEFAULT_SWEEP_POLICY, NOW), deriveDisposition(baseline, DEFAULT_SWEEP_POLICY, NOW));
});

test("acceptance 11: a single run with an unparseable createdAt is skipped, never treated as an instant stall", () => {
  const bad: WorkflowRunObservation[] = [{ status: "queued", createdAt: "not-a-date" }];
  assert.equal(stalledRunReason(bad, DEFAULT_SWEEP_POLICY, NOW), undefined);
});
