import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { buildFixRungDispatchArgs, runFixRung } from "../src/run-task.js";
import { deriveFixMode, FIX_MODE_RULES, renderFixPrompt } from "../src/lib/prompt-render.js";
import {
  cappedProofDiscriminationFromLedger,
  DEFAULT_SWEEP_POLICY,
  decideSweepArm,
  runSweep,
  type OpenPrView,
  type ProofDiscriminationEvidence,
  type SweepDeps,
} from "../src/lib/sweep.js";
import { appendLedger, type LedgerLine } from "../src/lib/ledger.js";
import type { Config } from "../src/lib/config.js";
import type { IssueGateway } from "../src/lib/escalate.js";
import type { Mount } from "../src/lib/mounts.js";
import type { CriterionVerdict, ReviewVerdict } from "../src/lib/review.js";
import type { WorkerResult } from "../src/lib/worker.js";

const TASK = "W1-T3306-FIXTURE";
const PR_URL = "https://github.com/acme/remudero/pull/3306";
const HEAD = "3306aaaa";
const NOW = Date.parse("2026-09-10T12:00:00Z");
const MOUNT: Mount = { model: "sonnet", effort: "medium", maxTurns: 20, contextBudget: 20_000 };

const PROOF: ProofDiscriminationEvidence = {
  proofs: [{ claim: "the capped proof is discriminating", proof: "unit test: test/existing.test.ts", proofExec: "executed_stale" }],
};

function ledgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), "rmd-capped-stall-")), "ledger.ndjson");
}

function cappedCriterion(over: Partial<CriterionVerdict> = {}): CriterionVerdict {
  return {
    claim: PROOF.proofs[0]!.claim,
    proof: PROOF.proofs[0]!.proof,
    met: true,
    reason: "matched on the keyword floor",
    proof_exec: "executed_stale",
    ...over,
  };
}

function cappedPosted(capped = true): LedgerLine {
  return {
    run_id: "W1-T3306-REVIEW",
    task_id: TASK,
    step: "review.posted",
    pr_url: PR_URL,
    head_sha: HEAD,
    state: "success",
    capped,
    plan_only: false,
    decision_verdict: {
      state: "success",
      capped,
      planOnly: false,
      criteria: [cappedCriterion()],
    },
  };
}

function pr(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 3306,
    prUrl: PR_URL,
    taskId: TASK,
    reviewState: "success",
    checksState: "green",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: "2026-09-10T11:00:00.000Z",
    headSha: HEAD,
    autoMergeArmed: false,
    ...over,
  };
}

function workerResult(): WorkerResult {
  return {
    sessionId: "proof-discrimination-worker",
    costUsd: 0,
    numTurns: 1,
    text: "updated the PR body",
    blocks: [],
    stderr: "",
    subtype: "success",
    isError: false,
    apiError: false,
    permissionDenials: [],
    childEnvKeys: [],
    model: "test-model",
    effort: "medium",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    modelUsage: {},
    compactionEvents: [],
    qualitySuspect: false,
  };
}

function sweepDeps(
  path: string,
  observed: { armed: number; fixed: Array<ProofDiscriminationEvidence | undefined>; escalated: number },
): SweepDeps {
  return {
    arm: () => { observed.armed++; return "armed"; },
    close: () => {},
    dispatchFix: (_pr, evidence) => { observed.fixed.push(evidence.proofDiscrimination); },
    escalate: () => { observed.escalated++; },
    ledgerPath: path,
    runId: "SWEEP-W1-T3306",
    now: () => NOW,
  };
}

test("W1-T3306: capped arm refusal remains a refusal while uncapped verdicts remain armable", () => {
  assert.equal(decideSweepArm(pr(), [cappedPosted(true)]).arm, false, "a capped verdict still cannot arm");
  assert.equal(decideSweepArm(pr(), [cappedPosted(false)]).arm, true, "an uncapped verdict remains armable");
});

test("W1-T3306: only the new table row reaches proof-discrimination and renders only its stale-proof remedy", () => {
  assert.equal(deriveFixMode({ proofDiscrimination: PROOF }), "proof-discrimination");
  assert.notEqual(
    deriveFixMode({ proofDiscrimination: PROOF }, FIX_MODE_RULES.filter((rule) => rule.mode !== "proof-discrimination")),
    "proof-discrimination",
    "the pre-existing table had no row for a capped green zero-unmet verdict",
  );
  const prompt = renderFixPrompt({ task: { id: TASK, title: "Capped proof fixture" }, round: 1, branch: "run-proof", evidence: { proofDiscrimination: PROOF } });
  assert.match(prompt, /MODE: proof-discrimination/);
  assert.match(prompt, /claim: the capped proof is discriminating/);
  assert.match(prompt, /proof: unit test: test\/existing\.test\.ts/);
  assert.match(prompt, /grade: executed_stale/);
  assert.match(prompt, /grep:` proof on a CHANGED line/);
  assert.doesNotMatch(prompt, /Required CI check/);
  assert.doesNotMatch(prompt, /Review summary:/);
});

test("W1-T3306: a capped green sweep dispatches the existing fix rung, while an override still arms", async () => {
  const path = ledgerPath();
  appendLedger(path, cappedPosted());
  const observed = { armed: 0, fixed: [] as Array<ProofDiscriminationEvidence | undefined>, escalated: 0 };
  const summary = await runSweep([pr()], sweepDeps(path, observed));
  assert.equal(summary.byDisposition["blocked-fixable"], 1);
  assert.equal(observed.armed, 0, "the capped predicate was not relaxed");
  assert.deepEqual(observed.fixed, [PROOF], "the exact stale-proof evidence reaches the existing dispatch");

  const overridePath = ledgerPath();
  appendLedger(overridePath, cappedPosted());
  appendLedger(overridePath, {
    run_id: "W1-T3306-OVERRIDE",
    task_id: TASK,
    step: "automerge.capped_override_granted",
    head_sha: HEAD,
    by: "operator",
    reason: "reviewed manually",
  });
  const overridden = { armed: 0, fixed: [] as Array<ProofDiscriminationEvidence | undefined>, escalated: 0 };
  const overrideSummary = await runSweep([pr()], sweepDeps(overridePath, overridden));
  assert.equal(overrideSummary.byDisposition.mergeable, 1, "the explicit override keeps the mergeable lane");
  assert.equal(overridden.armed, 1);
  assert.deepEqual(overridden.fixed, []);
});

test("W1-T3306: stale proof repairs use the existing body input and exhaust the shared strike cap", async () => {
  const args = buildFixRungDispatchArgs({
    task: { id: TASK, title: "Capped proof fixture" },
    runId: "W1-T3306-RUN",
    prUrl: PR_URL,
    branch: "run-W1-T3306",
    worktreePath: process.cwd(),
    mount: MOUNT,
    settingsFile: "/tmp/rmd-capped-proof-settings.json",
    config: {} as Config,
    budgetUsd: 1,
    strikeCap: 1,
    evidence: { unmetCriteria: [], proofDiscrimination: PROOF },
    pr: { headSha: HEAD },
    reviewBase: { owner: "acme", repo: "remudero", headCheckoutDir: process.cwd(), reviewerMount: MOUNT },
  });
  assert.equal(args.initialReview.capped, true, "the cold-dispatch adapter retains the capped evidence");
  assert.deepEqual(args.proofDiscrimination, PROOF, "the adapter retains the prompt-mode evidence");

  const reviewReports: string[] = [];
  const issues: IssueGateway = { create: () => "https://github.com/acme/remudero/issues/3306" };
  const outcome = await runFixRung({
    ...args,
    escalationJudge: async () => ({ decision: "deliver", reason: "still stale" }),
    deps: {
      spawn: async () => workerResult(),
      waitForCiGreen: async () => "green",
      runReview: async (input) => {
        reviewReports.push(input.report);
        return {
          state: "success",
          criteria: [cappedCriterion()],
          testTheater: false,
          summary: "still capped",
          floorDegraded: true,
          capped: true,
          keywordOnly: false,
          planOnly: false,
          headSha: "3306bbbb",
          reviewerOutcome: "success",
        };
      },
      fetchPrBody: async () => "## Acceptance\n- updated proof text",
      push: () => {},
      issues,
      ledgerPath: ledgerPath(),
      log: () => {},
      say: () => {},
      account: (result) => result,
    },
  });
  assert.equal(outcome.outcome, "escalated", "a still-stale proof after one repair reaches the existing exhaustion route");
  assert.equal(outcome.strikes, 1, "the shared cap permits exactly one repair");
  assert.deepEqual(reviewReports, ["## Acceptance\n- updated proof text"], "proof-discrimination re-reviews the actual PR body");
});

test("W1-T3306: an already exhausted capped PR escalates instead of re-dispatching", async () => {
  const path = ledgerPath();
  appendLedger(path, cappedPosted());
  const exhausted = pr({ priorStrikes: DEFAULT_SWEEP_POLICY.strikeCap });
  const observed = { armed: 0, fixed: [] as Array<ProofDiscriminationEvidence | undefined>, escalated: 0 };
  const summary = await runSweep([exhausted], sweepDeps(path, observed));
  assert.equal(summary.byDisposition["blocked-ambiguous"], 1);
  assert.deepEqual(observed.fixed, []);
  assert.equal(observed.escalated, 1, "the existing escalation path owns exhaustion");
});

test("W1-T3306: malformed current verdict evidence fails closed", () => {
  const malformed = { ...cappedPosted(), decision_verdict: { state: "success", capped: true, criteria: "not an array" } };
  assert.equal(cappedProofDiscriminationFromLedger(pr(), [malformed]), undefined);
});
