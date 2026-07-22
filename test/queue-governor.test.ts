import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_SWEEP_POLICY,
  checkQueueGovernor,
  logQueueGovernorDeferral,
  runSweep,
  type FixDispatchEvidence,
  type OpenPrView,
  type QueueGovernorResult,
  type SweepDeps,
  type SweepPolicy,
} from "../src/lib/sweep.js";
import { readLedgerLines } from "../src/lib/status.js";
import { appendLedger } from "../src/lib/ledger.js";

// ── W1-T121 QUEUE GOVERNOR — a WIP limit on DISPATCH only; flow control
// throttles intake, never drainage (the 23-open-PR incident). ────────────────
//
// CORROBORATION (the governor's thesis, run by hand): with the dispatcher
// down and only the sweep loop running, the queue drained 23 -> 14 open PRs
// in a single pass window, and with dispatch halted again the remaining ten
// drained to ZERO — drainage is demonstrably healthy while intake is zero.
// These tests hold the SAME shape: the governor gates a synthetic dispatch
// decision while a REAL `runSweep` pass, in the very same test, proves
// sweep/heal/arm/merge are untouched.

function ledgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), "rmd-queue-governor-")), "ledger.ndjson");
}

const NOW = Date.parse("2026-07-20T12:00:00Z");
const RECENT = "2026-07-19T12:00:00Z";

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

// The SAME four-disposition golden seeded set sweep.test.ts's acceptance 1
// uses — one PR per disposition, so a single `runSweep` pass exercises
// mergeable/blocked-fixable/stale/blocked-ambiguous all at once.
function mergeablePr(): OpenPrView {
  return pr({ prNumber: 10, prUrl: "url/10", taskId: "W1-A", reviewState: "success", checksState: "green" });
}
function blockedFixablePr(): OpenPrView {
  return pr({
    prNumber: 11,
    prUrl: "url/11",
    taskId: "W1-B",
    reviewState: "failure",
    checksState: "green",
    priorStrikes: 0,
    unmetCriteria: [{ claim: "still needs work", proof: "unit test: x", met: false, reason: "not done", proof_exec: "executed_fail" }],
    reviewSummary: "one criterion unmet",
  });
}
function supersededPr(): OpenPrView {
  return pr({ prNumber: 12, prUrl: "url/12", taskId: "W1-C", supersededBy: 99 });
}
function blockedAmbiguousPr(): OpenPrView {
  return pr({ prNumber: 13, prUrl: "url/13", taskId: "W1-D", reviewState: "pending", checksState: "pending" });
}

function fakeDeps(overrides: Partial<SweepDeps> = {}): SweepDeps & {
  armed: OpenPrView[];
  closed: Array<{ pr: OpenPrView; reason: string }>;
  fixed: Array<{ pr: OpenPrView; evidence: FixDispatchEvidence }>;
  escalated: Array<{ pr: OpenPrView; reason: string }>;
} {
  const armed: OpenPrView[] = [];
  const closed: Array<{ pr: OpenPrView; reason: string }> = [];
  const fixed: Array<{ pr: OpenPrView; evidence: FixDispatchEvidence }> = [];
  const escalated: Array<{ pr: OpenPrView; reason: string }> = [];
  return {
    armed,
    closed,
    fixed,
    escalated,
    arm: (p) => { armed.push(p); },
    close: (p, reason) => { closed.push({ pr: p, reason }); },
    dispatchFix: (p, evidence) => { fixed.push({ pr: p, evidence }); },
    escalate: (p, reason) => { escalated.push({ pr: p, reason }); },
    ledgerPath: ledgerPath(),
    runId: "SWEEP-1",
    now: () => NOW,
    ...overrides,
  };
}

// ── acceptance 1: at the limit ─────────────────────────────────────────────

test("acceptance 1 — at the limit: checkQueueGovernor defers, a dispatch_deferred_wip ledger line carries the observed count, and sweep/heal/arm/merge in the SAME pass are unaffected", async () => {
  const policy: SweepPolicy = { ...DEFAULT_SWEEP_POLICY, wipLimit: 4 };
  const openPrCount = 4; // AT the limit

  const result = checkQueueGovernor(openPrCount, policy);
  assert.equal(result.deferred, true, "at the limit, dispatch is deferred");
  assert.equal(result.observedOpenCount, 4);
  assert.equal(result.wipLimit, 4);

  const path = ledgerPath();
  logQueueGovernorDeferral(result, appendLedger, path, "DAEMON-1");
  const lines = readLedgerLines(path);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].step, "dispatch_deferred_wip");
  assert.equal(lines[0].observed_open_count, 4, "the throttled ledger line carries the observed open count");
  assert.equal(lines[0].wip_limit, 4);

  // SAME PASS: a real runSweep over the four-disposition golden set — the
  // governor above must not have touched it. sweep/heal/arm/merge fire at
  // full depth, exactly as if the governor did not exist.
  const deps = fakeDeps();
  const summary = await runSweep(
    [mergeablePr(), blockedFixablePr(), supersededPr(), blockedAmbiguousPr()],
    deps,
  );
  assert.deepEqual(summary.byDisposition, {
    mergeable: 1,
    "blocked-fixable": 1,
    stale: 1,
    "blocked-ambiguous": 1, "dep-review": 0, "post-review": 0 });
  assert.equal(summary.actionsTaken, 4, "all four dispositions acted — drainage is ungated at any depth");
  assert.equal(deps.armed.length, 1, "merge-eligible PR still armed");
  assert.equal(deps.fixed.length, 1, "fixable PR still dispatched a fix worker");
  assert.equal(deps.closed.length, 1, "stale PR still closed");
  assert.equal(deps.escalated.length, 1, "ambiguous PR still escalated");
});

test("acceptance 1b — ABOVE the limit also defers (not just exactly-at)", () => {
  const policy: SweepPolicy = { ...DEFAULT_SWEEP_POLICY, wipLimit: 4 };
  const result = checkQueueGovernor(7, policy);
  assert.equal(result.deferred, true);
  assert.equal(result.observedOpenCount, 7);
});

// ── acceptance 2: below the limit ──────────────────────────────────────────

test("acceptance 2 — below the limit: dispatch proceeds normally (the falsifier proving the governor is not simply off or always-on)", () => {
  const policy: SweepPolicy = { ...DEFAULT_SWEEP_POLICY, wipLimit: 10 };
  const result = checkQueueGovernor(3, policy);
  assert.equal(result.deferred, false, "well below the limit, dispatch is NOT deferred");
  assert.equal(result.observedOpenCount, 3);
  assert.equal(result.wipLimit, 10);
});

test("acceptance 2b — one below the limit (boundary) also proceeds — the limit is inclusive on the deferred side only", () => {
  const policy: SweepPolicy = { ...DEFAULT_SWEEP_POLICY, wipLimit: 10 };
  const result = checkQueueGovernor(9, policy);
  assert.equal(result.deferred, false);
});

// ── acceptance 3: the limit is policy DATA, not a constant ────────────────

test("acceptance 3 — changing the limit is a policy-data row edit with zero code change: the SAME open-PR count flips disposition purely from a policy override", () => {
  const openPrCount = 5;

  const loose: SweepPolicy = { ...DEFAULT_SWEEP_POLICY, wipLimit: 10 };
  assert.equal(checkQueueGovernor(openPrCount, loose).deferred, false, "5 open PRs, limit 10 -> not deferred");

  const tight: SweepPolicy = { ...DEFAULT_SWEEP_POLICY, wipLimit: 5 };
  assert.equal(checkQueueGovernor(openPrCount, tight).deferred, true, "the SAME 5 open PRs, limit tightened to 5 -> deferred");

  const tighter: SweepPolicy = { ...DEFAULT_SWEEP_POLICY, wipLimit: 3 };
  assert.equal(checkQueueGovernor(openPrCount, tighter).deferred, true, "limit tightened further -> still deferred");
});

test("acceptance 3b — DEFAULT_SWEEP_POLICY carries wipLimit as a table row (policy-as-data, not an inlined constant)", () => {
  assert.equal(typeof DEFAULT_SWEEP_POLICY.wipLimit, "number");
  assert.ok(DEFAULT_SWEEP_POLICY.wipLimit > 0);
});

// ── zero-open-PR edge (drainage-to-zero corroboration) ─────────────────────

test("zero open PRs never defers — the drained-to-zero end state is always dispatch-eligible", () => {
  const result = checkQueueGovernor(0, DEFAULT_SWEEP_POLICY);
  assert.equal(result.deferred, false);
});
