import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  diagnoseCappedRoutingBlock,
  runSweep,
  type OpenPrView,
  type ProofDiscriminationEvidence,
  type SweepDeps,
} from "./helpers/sweep-test.js";
import { appendLedger, type LedgerLine } from "../src/lib/ledger.js";

// #10298 (2026-10-09): a green, reviewed PR whose verdict was CAPPED on a comment-only grep sat for hours on
// "Escalating once" — the capped-repair route (W1-T3306) reads only a `mergeable` disposition, and the
// CAPPED-ARM-ESCALATION row (#5960) claims every capped head first, because production always sets
// `armRefusalIsTerminal` on one. The escalation is for a capped head with NOTHING to repair.

const TASK = "W1-T6884-FIXTURE";
const PR_URL = "https://github.com/acme/remudero/pull/10298";
const HEAD = "bec6e7a5";
const NOW = Date.parse("2026-10-09T12:00:00Z");
const STALE: ProofDiscriminationEvidence = {
  proofs: [{ claim: "the flake is fixed and recorded by this task id", proof: "grep: W1-T6884 in test/roster.test.ts", proofExec: "executed_stale" }],
};

function ledger(proofExec: "executed_stale" | "executed_pass"): string {
  const path = join(mkdtempSync(join(tmpdir(), "rmd-capped-repairable-")), "ledger.ndjson");
  const criterion = { claim: STALE.proofs[0]!.claim, proof: STALE.proofs[0]!.proof, met: true, reason: "every matching line is a comment", proof_exec: proofExec };
  const posted: LedgerLine = {
    run_id: "REVIEW-10298", task_id: TASK, step: "review.posted", pr_url: PR_URL, head_sha: HEAD,
    state: "success", capped: true, plan_only: false,
    decision_verdict: { state: "success", capped: true, planOnly: false, criteria: [criterion] },
  };
  appendLedger(path, posted);
  return path;
}

function cappedGreenPr(): OpenPrView {
  return {
    prNumber: 10298, prUrl: PR_URL, taskId: TASK, reviewState: "success", checksState: "green",
    unmetCriteria: [], priorStrikes: 0,
    lastActivityAt: "2026-10-09T11:00:00.000Z", // expiring-fixture: exempt -- compared only against this suite's INJECTED now (NOW), never the wall clock
    headSha: HEAD, autoMergeArmed: false,
    // What run-task's `terminalArmRefusal` sets on EVERY capped, unoverridden head.
    armRefusalIsTerminal: true,
  };
}

function deps(path: string, seen: { fixed: Array<ProofDiscriminationEvidence | undefined>; escalated: number }): SweepDeps {
  return {
    arm: () => "armed",
    close: () => {},
    dispatchFix: (_pr, evidence) => { seen.fixed.push(evidence.proofDiscrimination); },
    escalate: () => { seen.escalated++; },
    ledgerPath: path,
    runId: "SWEEP-10298",
    now: () => NOW,
  };
}

test("a capped green PR whose proofs are repairable dispatches the proof repair instead of escalating", async () => {
  const seen = { fixed: [] as Array<ProofDiscriminationEvidence | undefined>, escalated: 0 };
  const summary = await runSweep([cappedGreenPr()], deps(ledger("executed_stale"), seen));
  assert.equal(summary.byDisposition["blocked-fixable"], 1, JSON.stringify(summary.byDisposition));
  assert.deepEqual(seen.fixed, [STALE], "the stale proof reaches the existing capped repair rung");
  assert.equal(seen.escalated, 0, "a repairable capped head is not a question for a person");
});

test("a capped green PR with nothing repairable still escalates once", async () => {
  const seen = { fixed: [] as Array<ProofDiscriminationEvidence | undefined>, escalated: 0 };
  const summary = await runSweep([cappedGreenPr()], deps(ledger("executed_pass"), seen));
  assert.equal(summary.byDisposition["blocked-ambiguous"], 1, JSON.stringify(summary.byDisposition));
  assert.deepEqual(seen.fixed, []);
});

test("the capped-routing diagnosis reads the capped-escalation disposition as routable", () => {
  const lines = [{
    run_id: "REVIEW-10298", task_id: TASK, step: "review.posted", pr_url: PR_URL, head_sha: HEAD, state: "success", capped: true,
    plan_only: false,
    decision_verdict: { state: "success", capped: true, planOnly: false, criteria: [{ claim: STALE.proofs[0]!.claim, proof: STALE.proofs[0]!.proof, met: true, reason: "", proof_exec: "executed_stale" }] },
  }];
  const diagnosis = diagnoseCappedRoutingBlock(cappedGreenPr(), "blocked-ambiguous", lines);
  assert.equal(diagnosis.blocked, false, diagnosis.detail);
});
