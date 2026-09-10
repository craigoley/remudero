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

// ── the ledger reader's two rejection surfaces ────────────────────────────────────────────────
// `cappedProofDiscriminationFromLedger` is what turns a stored review row back into evidence a
// dispatch can act on, so its parser is the boundary between "a verdict we can bind to this PR and
// head" and "prose we must not act on". Both tests below drive it through its exported entry point;
// neither reaches for an internal.

test("W1-T3306: every declared proof_exec outcome is accepted, so a stored verdict is not silently dropped", () => {
  // The guard is an alternation, and the LAST member is the one that forces every earlier
  // comparison to be evaluated — a value matching the first alternative proves nothing about the
  // rest. `stale_self_path` is that member. A verdict carrying a legitimate outcome the guard
  // forgot would be discarded here as malformed, and the rung would stand down on a PR whose
  // evidence was fine.
  const outcomes: CriterionVerdict["proof_exec"][] = [
    "executed_stale",
    "not_executable",
    "executed_pass",
    "executed_fail",
    "exec_error",
    "base_unreadable",
    "not_yet_built",
    "stale_self_path",
  ];
  // EACH OUTCOME IS PAIRED WITH A STALE CRITERION, and that pairing is the whole design of this
  // test. Evidence is derived ONLY from `executed_stale`/`not_executable` criteria
  // (proofDiscriminationEvidenceFromCriteria), so asserting "evidence exists" for a lone
  // `executed_pass` conflates the PARSER with the FILTER and fails for the wrong reason — it did,
  // on the first version of this test. With a stale sibling present, evidence appears iff the
  // parser ACCEPTED both criteria; a rejected outcome makes criteriaFromLedgerValue return
  // undefined and takes the sibling's evidence down with it.
  for (const proof_exec of outcomes) {
    const line = cappedPosted();
    (line.decision_verdict as Record<string, unknown>).criteria = [
      cappedCriterion({ proof_exec }),
      cappedCriterion({ proof_exec: "executed_stale" }),
    ];
    const evidence = cappedProofDiscriminationFromLedger({ taskId: TASK, prUrl: PR_URL, headSha: HEAD }, [line]);
    assert.ok(
      evidence,
      `a stored verdict carrying proof_exec "${proof_exec}" beside a stale criterion must parse; ` +
        "an unrecognised outcome would discard the whole row",
    );
  }
});

test("W1-T3306: a criterion missing a required field is refused, and clears the evidence rather than half-reading it", () => {
  // FAIL CLOSED IS THE POINT. A partially-read criterion is worse than none: the dispatch would act
  // on a verdict it cannot bind. Each case below breaks exactly one field, so a parser that stopped
  // checking any single one reddens here rather than passing on the strength of the others.
  const broken: Array<[string, Record<string, unknown>]> = [
    ["claim is not a string", { claim: 1 }],
    ["proof is not a string", { proof: 1 }],
    ["met is not a boolean", { met: "yes" }],
    ["reason is not a string", { reason: 1 }],
    ["proof_exec is not a declared outcome", { proof_exec: "invented_outcome" }],
  ];
  for (const [label, over] of broken) {
    // THE VALID STALE SIBLING IS WHAT MAKES EACH ARM DISCRIMINATE. Alone, a broken criterion
    // yields no evidence whether the parser REJECTED the row or merely produced nothing from it —
    // measured: dropping the proof_exec check changed nothing observable. With a sibling that WOULD
    // produce evidence, a parser that stopped checking any single field accepts the row and the
    // sibling's evidence appears, so this assertion fails for the right reason.
    const line = cappedPosted();
    (line.decision_verdict as Record<string, unknown>).criteria = [
      { ...cappedCriterion(), ...over },
      cappedCriterion({ proof_exec: "executed_stale" }),
    ];
    assert.equal(
      cappedProofDiscriminationFromLedger({ taskId: TASK, prUrl: PR_URL, headSha: HEAD }, [line]),
      undefined,
      `a criterion whose ${label} must yield NO evidence, never a partial read`,
    );
  }
});
