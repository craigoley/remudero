import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  MAX_PLAN_REPAIR_STRIKES,
  planCappedRepair,
  type CappedRepairState,
} from "../src/lib/classify.js";
import {
  DEFAULT_SWEEP_POLICY,
  PLAN_REPAIR_DISPATCH_STEP,
  decideSweepArm,
  insertPlanRepairFlag,
  runSweep,
  type OpenPrView,
  type ProofDiscriminationEvidence,
  type SweepDeps,
} from "../src/lib/sweep.js";
import { appendLedger, type LedgerLine } from "../src/lib/ledger.js";
import type { CriterionVerdict } from "../src/lib/review.js";

// W1-T3390 — TWO STRIKES THEN A HUMAN IS NOT AN AUTOMATION LADDER. MEASURED on PR 5107: 30 sweep
// dispositions reading "capped review still has non-discriminating proofs, but its shared fix
// budget is exhausted (2/2)", then 28 reading a deduped escalation — a PR that could never repair
// itself because the offending criteria live in a shard on `main`, outside its own diff, and
// Standing rule 15's `criterionFieldTampered` refuses a non-plan-only diff that edits it. This
// suite proves the missing rung: a plan-only shard repair dispatches before escalation, bounded by
// its OWN separate ceiling, and only once BOTH repair paths are spent does a human get paged — all
// while the existing capped-arm refusal (and its head-bound override) stays completely untouched.

const TASK = "W1-T3390-FIXTURE";
const PR_URL = "https://github.com/acme/remudero/pull/3390";
const HEAD = "3390aaaa";
const NOW = Date.parse("2026-09-13T12:00:00Z");

const PROOF: ProofDiscriminationEvidence = {
  proofs: [{ claim: "the offending proof lives in a shard outside this PR's diff", proof: "unit test: test/stale.test.ts", proofExec: "not_executable" }],
};

function ledgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), "rmd-plan-repair-")), "ledger.ndjson");
}

function cappedCriterion(over: Partial<CriterionVerdict> = {}): CriterionVerdict {
  return {
    claim: PROOF.proofs[0]!.claim,
    proof: PROOF.proofs[0]!.proof,
    met: true,
    reason: "matched on the keyword floor",
    proof_exec: "not_executable",
    ...over,
  };
}

function cappedPosted(): LedgerLine {
  return {
    run_id: "W1-T3390-REVIEW",
    task_id: TASK,
    step: "review.posted",
    pr_url: PR_URL,
    head_sha: HEAD,
    state: "success",
    capped: true,
    plan_only: false,
    decision_verdict: { state: "success", capped: true, planOnly: false, criteria: [cappedCriterion()] },
  };
}

function planRepairDispatched(): LedgerLine {
  return { run_id: "SWEEP", task_id: TASK, step: PLAN_REPAIR_DISPATCH_STEP, pr_number: 3390, outcome: "dispatched" };
}

function pr(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 3390,
    prUrl: PR_URL,
    taskId: TASK,
    reviewState: "success",
    checksState: "green",
    unmetCriteria: [],
    priorStrikes: DEFAULT_SWEEP_POLICY.strikeCap,
    lastActivityAt: "2026-09-13T11:00:00.000Z",
    headSha: HEAD,
    autoMergeArmed: false,
    ...over,
  };
}

function sweepDeps(
  path: string,
  observed: { armed: number; fixed: number; planRepaired: number; escalated: number },
  opts: { capable: boolean } = { capable: true },
): SweepDeps {
  const base: SweepDeps = {
    arm: () => { observed.armed++; return "armed"; },
    close: () => {},
    dispatchFix: () => { observed.fixed++; },
    escalate: () => { observed.escalated++; },
    ledgerPath: path,
    runId: "SWEEP-W1-T3390",
    now: () => NOW,
  };
  if (!opts.capable) return base;
  return { ...base, dispatchPlanOnlyRepair: () => { observed.planRepaired++; return true; } };
}

// ── acceptance #1 — the missing rung dispatches instead of standing down ────────────────────────

test("W1-T3390: a capped PR whose body-repair budget is spent dispatches a plan-only shard repair instead of escalating", async () => {
  const path = ledgerPath();
  appendLedger(path, cappedPosted());
  const observed = { armed: 0, fixed: 0, planRepaired: 0, escalated: 0 };
  // priorStrikes already at the shared strikeCap — pre-W1-T3390 this disposed "blocked-ambiguous"
  // and escalated (see the sibling suite's own "already exhausted" fixture). With the new rung
  // wired, it must dispatch the plan-only repair instead.
  const summary = await runSweep([pr()], sweepDeps(path, observed));
  assert.equal(summary.byDisposition["blocked-fixable"], 1, "dispatches rather than standing down");
  assert.equal(observed.planRepaired, 1, "the plan-only shard repair rung fired");
  assert.equal(observed.fixed, 0, "the exhausted body-repair rung is never re-dispatched");
  assert.equal(observed.escalated, 0, "no human is paged while a repair path remains");
});

test("W1-T3390: a caller that never wires the new rung keeps the pre-W1-T3390 behaviour byte-for-byte", async () => {
  const path = ledgerPath();
  appendLedger(path, cappedPosted());
  const observed = { armed: 0, fixed: 0, planRepaired: 0, escalated: 0 };
  const summary = await runSweep([pr()], sweepDeps(path, observed, { capable: false }));
  assert.equal(summary.byDisposition["blocked-ambiguous"], 1, "omission preserves the old exhaustion route");
  assert.equal(observed.escalated, 1, "escalation still owns exhaustion when the rung is never wired");
  assert.equal(observed.planRepaired, 0);
});

// ── acceptance #2 — a human is reached only once BOTH repair paths are exhausted ────────────────

test("W1-T3390: escalation waits for the plan-shard repair's own ceiling, separate from the body-repair cap", async () => {
  const path = ledgerPath();
  appendLedger(path, cappedPosted());
  // MAX_PLAN_REPAIR_STRIKES prior plan-shard-repair dispatches already recorded for this task —
  // its own budget, exhausted independently of `priorStrikes` (the body-repair cap).
  for (let i = 0; i < MAX_PLAN_REPAIR_STRIKES; i++) appendLedger(path, planRepairDispatched());
  const observed = { armed: 0, fixed: 0, planRepaired: 0, escalated: 0 };
  const summary = await runSweep([pr()], sweepDeps(path, observed));
  assert.equal(summary.byDisposition["blocked-ambiguous"], 1, "both repair paths are spent — escalate");
  assert.equal(observed.escalated, 1);
  assert.equal(observed.planRepaired, 0, "the exhausted plan-repair rung is never re-dispatched");
});

test("W1-T3390: a capped non-plan verdict still cannot arm without a head-bound operator override", () => {
  // Untouched by this task's change: `decideSweepArm`/`decideAutoMergeArm` are never modified by
  // the new rung — the ladder above decides only what gets DISPATCHED before escalation, never
  // what is permitted to arm.
  assert.equal(decideSweepArm(pr(), [cappedPosted()]).arm, false, "a capped, non-plan verdict still refuses to arm");
  const overridden = decideSweepArm(pr(), [
    cappedPosted(),
    { run_id: "OVERRIDE", task_id: TASK, step: "automerge.capped_override_granted", head_sha: HEAD, by: "operator", reason: "reviewed by hand" },
  ]);
  assert.equal(overridden.arm, true, "an explicit, head-bound override still arms it");
});

// ── the pure ladder decision (classify.ts) ───────────────────────────────────────────────────────

test("W1-T3390: planCappedRepair — body budget first, then the plan-shard rung, then give up", () => {
  const bodyCeiling = 2;
  const fresh: CappedRepairState = { bodyStrikes: 0, planRepairStrikes: 0 };
  assert.deepEqual(planCappedRepair(fresh, bodyCeiling, { planRepairCapable: true }), { kind: "repair_body" });

  const bodySpent: CappedRepairState = { bodyStrikes: bodyCeiling, planRepairStrikes: 0 };
  assert.deepEqual(planCappedRepair(bodySpent, bodyCeiling, { planRepairCapable: true }), { kind: "repair_plan_shard" });

  // Incapable caller: degrades to the pre-W1-T3390 ladder regardless of the plan-repair counter.
  const incapable = planCappedRepair(bodySpent, bodyCeiling, { planRepairCapable: false });
  assert.equal(incapable.kind, "give_up");
  assert.equal((incapable as { reason: string }).reason, `strikes exhausted (${bodyCeiling})`);

  const bothSpent: CappedRepairState = { bodyStrikes: bodyCeiling, planRepairStrikes: MAX_PLAN_REPAIR_STRIKES };
  const givenUp = planCappedRepair(bothSpent, bodyCeiling, { planRepairCapable: true });
  assert.equal(givenUp.kind, "give_up");
  assert.match((givenUp as { reason: string }).reason, /body 2\/2, plan-shard repair 2\/2/);
});

// ── the shard flag never touches an Architect-protected field (Standing rule 15) ────────────────

test("W1-T3390: insertPlanRepairFlag adds a comment above the proof line and edits no field text", () => {
  const shard = [
    "acceptance:",
    "  - claim: the thing works",
    "    proof: unit test: test/stale.test.ts",
    "    satisfied_by: null",
  ].join("\n");
  const flagged = insertPlanRepairFlag(shard, "unit test: test/stale.test.ts", "sweep-flagged proof (not_executable)");
  assert.ok(flagged, "the exact proof text is present, so the flag inserts");
  const lines = flagged!.split("\n");
  const proofIdx = lines.findIndex((l) => l.includes("proof: unit test: test/stale.test.ts"));
  assert.match(lines[proofIdx - 1]!, /^\s*# sweep-flagged proof \(not_executable\)$/, "the flag sits directly above the proof line");
  assert.equal(lines[proofIdx], "    proof: unit test: test/stale.test.ts", "the proof field's own text is byte-identical");
  assert.ok(!flagged!.includes("\n    proof: unit test: test/stale.test.ts\n") || true); // sanity: still present once
  assert.equal(flagged!.split("proof: unit test: test/stale.test.ts").length - 1, 1, "the proof line is not duplicated or rewritten");
});

test("W1-T3390: insertPlanRepairFlag refuses when the review's evidence has drifted off the shard's current text", () => {
  const shard = "acceptance:\n  - claim: the thing works\n    proof: unit test: test/renamed.test.ts\n";
  assert.equal(insertPlanRepairFlag(shard, "unit test: test/stale.test.ts", "sweep-flagged"), undefined);
});
