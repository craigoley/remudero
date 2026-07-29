import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_SWEEP_POLICY,
  checkCostGovernor,
  deriveDayCostUsd,
  logCostGovernorDeferral,
  runSweep,
  type FixDispatchEvidence,
  type OpenPrView,
  type SweepDeps,
  type SweepPolicy,
} from "../src/lib/sweep.js";
import { readLedgerLines } from "../src/lib/status.js";
import { appendLedger } from "../src/lib/ledger.js";

// ── W1-T148 COST GOVERNOR — a daily spend ceiling as policy data; new
// DISPATCH waits (ledgered dispatch_deferred_budget) when the day's ledgered
// cost exceeds it; drainage (sweep/heal/merge) never throttles. ─────────────
//
// FIXTURE: the $206/60-run W1-T1 incident — a spin loop burned ~$206 over ~60
// runs with no daily ceiling anywhere, each run safely under its OWN per-run
// budget_usd cap, so that per-run backstop never fired. These tests hold the
// SAME shape the queue-governor's did: a synthetic dispatch decision is gated
// by the governor while a REAL runSweep pass, in the SAME test, proves
// sweep/heal/arm/merge are untouched.

function ledgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), "rmd-cost-governor-")), "ledger.ndjson");
}

const TODAY = Date.parse("2026-07-29T18:00:00Z");
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

// The SAME four-disposition golden seeded set sweep.test.ts's / the queue
// governor's acceptance 1 uses — one PR per disposition, so a single
// `runSweep` pass exercises mergeable/blocked-fixable/stale/blocked-ambiguous
// all at once.
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
    now: () => TODAY,
    ...overrides,
  };
}

/** Seeds a real ledger file with `count` runs each costing `eachUsd`, verdict-lined today. */
function seedRuns(path: string, count: number, eachUsd: number): void {
  for (let i = 0; i < count; i++) {
    const runId = `RUN-${i}`;
    appendLedger(path, { run_id: runId, task_id: "W1-T1", step: "run.start" });
    appendLedger(path, { run_id: runId, task_id: "W1-T1", step: "verdict", verdict: "failed", cost_usd: eachUsd });
  }
}

// ── acceptance 1: at/over the ceiling defers, seeded with the $206/60-run shape ──

test("acceptance 1 — over the ceiling (the $206/60-run W1-T1 shape): checkCostGovernor defers, a dispatch_deferred_budget ledger line carries day-cost + ceiling, and sweep/heal/arm/merge in the SAME pass are unaffected", async () => {
  const path = ledgerPath();
  seedRuns(path, 60, 206 / 60); // ~$206 across 60 runs, today

  const lines = readLedgerLines(path);
  const dayCostUsd = deriveDayCostUsd(lines, TODAY);
  assert.ok(Math.abs(dayCostUsd - 206) < 0.01, `expected ~$206 day-cost, got ${dayCostUsd}`);

  const policy: SweepPolicy = { ...DEFAULT_SWEEP_POLICY, dailyCostCeilingUsd: 150 };
  const result = checkCostGovernor(dayCostUsd, policy);
  assert.equal(result.deferred, true, "over the $150 ceiling, dispatch is deferred");
  assert.ok(Math.abs(result.observedDayCostUsd - 206) < 0.01);
  assert.equal(result.ceilingUsd, 150);

  logCostGovernorDeferral(result, appendLedger, path, "DAEMON-1");
  const afterLog = readLedgerLines(path);
  const deferLine = afterLog.find((l) => l.step === "dispatch_deferred_budget");
  assert.ok(deferLine, "a dispatch_deferred_budget ledger line was written");
  assert.ok(Math.abs((deferLine!.observed_day_cost_usd as number) - 206) < 0.01, "the throttled ledger line carries the observed day-cost");
  assert.equal(deferLine!.daily_cost_ceiling_usd, 150);

  // SAME PASS: a real runSweep over the four-disposition golden set — the
  // governor above must not have touched it. sweep/heal/arm/merge fire at
  // full depth, exactly as if the governor did not exist — no worker spawn
  // for a NEW task, but drainage of already-open PRs is untouched.
  const deps = fakeDeps();
  const summary = await runSweep(
    [mergeablePr(), blockedFixablePr(), supersededPr(), blockedAmbiguousPr()],
    deps,
  );
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
  assert.equal(summary.actionsTaken, 4, "all four dispositions acted — drainage is ungated at any day-cost");
  assert.equal(deps.armed.length, 1, "merge-eligible PR still armed");
  assert.equal(deps.fixed.length, 1, "fixable PR still dispatched a fix worker");
  assert.equal(deps.closed.length, 1, "stale PR still closed");
  assert.equal(deps.escalated.length, 1, "ambiguous PR still escalated");
});

test("acceptance 1b — exactly AT the ceiling also defers (the boundary is inclusive on the deferred side)", () => {
  const policy: SweepPolicy = { ...DEFAULT_SWEEP_POLICY, dailyCostCeilingUsd: 100 };
  const result = checkCostGovernor(100, policy);
  assert.equal(result.deferred, true);
  assert.equal(result.observedDayCostUsd, 100);
});

// ── acceptance 2: below the ceiling — dispatch proceeds ────────────────────

test("acceptance 2 — below the ceiling: dispatch proceeds normally (the falsifier proving the governor is not simply off or always-on)", () => {
  const path = ledgerPath();
  seedRuns(path, 3, 5); // $15 today, well under a $150 ceiling

  const dayCostUsd = deriveDayCostUsd(readLedgerLines(path), TODAY);
  assert.ok(Math.abs(dayCostUsd - 15) < 0.01);

  const policy: SweepPolicy = { ...DEFAULT_SWEEP_POLICY, dailyCostCeilingUsd: 150 };
  const result = checkCostGovernor(dayCostUsd, policy);
  assert.equal(result.deferred, false, "well below the ceiling, dispatch is NOT deferred");
  assert.equal(result.ceilingUsd, 150);
});

test("acceptance 2b — one dollar below the ceiling (boundary) also proceeds", () => {
  const policy: SweepPolicy = { ...DEFAULT_SWEEP_POLICY, dailyCostCeilingUsd: 100 };
  const result = checkCostGovernor(99, policy);
  assert.equal(result.deferred, false);
});

// ── acceptance 3: the ceiling is policy DATA, not a hardcoded constant ─────

test("acceptance 3 — changing the ceiling is a policy-data row edit with zero code change: the SAME day-cost flips disposition purely from a policy override", () => {
  const dayCostUsd = 120;

  const loose: SweepPolicy = { ...DEFAULT_SWEEP_POLICY, dailyCostCeilingUsd: 200 };
  assert.equal(checkCostGovernor(dayCostUsd, loose).deferred, false, "$120 spent, $200 ceiling -> not deferred");

  const tight: SweepPolicy = { ...DEFAULT_SWEEP_POLICY, dailyCostCeilingUsd: 120 };
  assert.equal(checkCostGovernor(dayCostUsd, tight).deferred, true, "the SAME $120 spent, ceiling tightened to $120 -> deferred");

  const tighter: SweepPolicy = { ...DEFAULT_SWEEP_POLICY, dailyCostCeilingUsd: 50 };
  assert.equal(checkCostGovernor(dayCostUsd, tighter).deferred, true, "ceiling tightened further -> still deferred");
});

test("acceptance 3b — DEFAULT_SWEEP_POLICY carries dailyCostCeilingUsd as a table row (policy-as-data, not an inlined constant), and an absent policy value falls back to a SAFE bounded default (never unbounded)", () => {
  assert.equal(typeof DEFAULT_SWEEP_POLICY.dailyCostCeilingUsd, "number");
  assert.ok(DEFAULT_SWEEP_POLICY.dailyCostCeilingUsd > 0);
  assert.ok(
    DEFAULT_SWEEP_POLICY.dailyCostCeilingUsd < 206,
    "the fail-safe default must be well under the $206/60-run incident it exists to catch",
  );
});

// ── day-cost derivation: per-run, not per-line (no double counting) ────────

test("deriveDayCostUsd sums exactly ONE figure per run (the verdict line), not every cost_usd-bearing line for that run — avoids double counting a run's own running total against its incremental contributors", () => {
  const lines = [
    { ts: "2026-07-29T10:00:00.000Z", run_id: "R1", task_id: "W1-T1", step: "run.start" },
    { ts: "2026-07-29T10:01:00.000Z", run_id: "R1", task_id: "W1-T1", step: "implement.done", cost_usd: 2 },
    { ts: "2026-07-29T10:02:00.000Z", run_id: "R1", task_id: "W1-T1", step: "fix.done", cost_usd: 1 },
    // The verdict line's cost_usd is R1's RUNNING TOTAL ($3), already covering the two lines above.
    { ts: "2026-07-29T10:03:00.000Z", run_id: "R1", task_id: "W1-T1", step: "verdict", cost_usd: 3 },
    // A second run, same day, no verdict yet (still in flight) — falls back to its first cost_usd line.
    { ts: "2026-07-29T11:00:00.000Z", run_id: "R2", task_id: "W1-T2", step: "run.start" },
    { ts: "2026-07-29T11:01:00.000Z", run_id: "R2", task_id: "W1-T2", step: "implement.done", cost_usd: 4 },
  ];
  const total = deriveDayCostUsd(lines, TODAY);
  assert.equal(total, 7, "R1 contributes $3 (its verdict total, not $3+2+1=$6) and R2 contributes $4 -> $7");
});

test("deriveDayCostUsd excludes lines outside today's UTC calendar day", () => {
  const lines = [
    { ts: "2026-07-28T23:59:00.000Z", run_id: "YDAY", task_id: "W1-TY", step: "verdict", cost_usd: 999 },
    { ts: "2026-07-29T00:00:01.000Z", run_id: "TODAY1", task_id: "W1-TX", step: "verdict", cost_usd: 5 },
  ];
  const total = deriveDayCostUsd(lines, TODAY);
  assert.equal(total, 5, "yesterday's $999 run must not bleed into today's total");
});

test("zero ledgered cost today never defers — a quiet/fresh day is always dispatch-eligible", () => {
  const result = checkCostGovernor(0, DEFAULT_SWEEP_POLICY);
  assert.equal(result.deferred, false);
});
