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
  diagnoseCappedRoutingBlock,
  proofDiscriminationEvidenceFromCriteria,
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

test("W1-T3306: every declared proof_exec outcome PARSES, so a stored verdict is not silently dropped", () => {
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
  // test: asserting "evidence exists" for a LONE non-executed outcome conflates the PARSER
  // (criteriaFromLedgerValue, which must accept every declared outcome) with the FILTER
  // (proofDiscriminationEvidenceFromCriteria, which W1-T3669 widened to every outcome except the
  // two that mean "this DID execute" plus the always-unmet `stale_self_path`) and fails for the
  // wrong reason — it did, on the first version of this test. With a stale sibling present,
  // PARSING succeeded iff evidence is defined at all; a rejected outcome makes
  // criteriaFromLedgerValue return undefined and takes the sibling's evidence down with it.
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

test("W1-T3669: exec_error/base_unreadable/not_yet_built are CAPPED-REPAIRABLE, not silently dropped by the filter", () => {
  // THE BUG THIS TASK DIAGNOSES: `capped` (review.ts) is `executedCount === 0` over ONLY
  // `executed_pass`/`executed_fail`, so every OTHER proof_exec grade on a capped verdict means
  // exactly the same thing — "never executed" — yet the pre-fix filter recognised only two of the
  // six such grades (`executed_stale`, `not_executable`). #5683 (W1-T3610) posted `CAPPED — 0/2
  // proofs executed; not certified` and never reached the fix rung because its two criteria
  // carried a grade OUTSIDE that narrow pair. Unlike the sibling-paired test above, this one
  // asserts the PROOFS LIST ITSELF names every criterion — a lone stale sibling can no longer mask
  // a silently dropped one.
  const nonExecuted: CriterionVerdict["proof_exec"][] = [
    "executed_stale",
    "not_executable",
    "exec_error",
    "base_unreadable",
    "not_yet_built",
  ];
  for (const proof_exec of nonExecuted) {
    const line = cappedPosted();
    (line.decision_verdict as Record<string, unknown>).criteria = [cappedCriterion({ proof_exec })];
    const evidence = cappedProofDiscriminationFromLedger({ taskId: TASK, prUrl: PR_URL, headSha: HEAD }, [line]);
    assert.deepEqual(
      evidence?.proofs.map((p) => p.proofExec),
      [proof_exec],
      `a lone criterion carrying proof_exec "${proof_exec}" must reach the proofs list — capped means ` +
        "this outcome never executed, exactly like executed_stale/not_executable",
    );
  }
  // The two outcomes that mean "this DID execute" and the always-unmet `stale_self_path` remain
  // excluded — this filter must never launder a genuinely observed result into a body-text repair.
  // Driven directly at proofDiscriminationEvidenceFromCriteria (never through the ledger reader),
  // so `met` — irrelevant to this function — cannot mask the exclusion behind the reader's own
  // separate met-bail (see the malformed-criterion test below).
  for (const proof_exec of ["executed_pass", "executed_fail", "stale_self_path"] as const) {
    const evidence = proofDiscriminationEvidenceFromCriteria([cappedCriterion({ proof_exec })]);
    assert.equal(evidence, undefined, `proof_exec "${proof_exec}" must never surface as capped-repairable evidence`);
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

// ── W1-T3669: the capped route shipped and had never once fired ────────────────────────────────
// `runSweep`'s capped-routing block (the W1-T3306 fix above) has four preconditions, and until now
// standing down on ANY of them looked identical to standing down on ALL of them: a `mergeable`
// disposition and silence. `diagnoseCappedRoutingBlock` mirrors the block's own four reads, in the
// same order, so a capped-green PR can be probed directly for WHICH gate refuses it — the
// diagnosis this task's rationale calls "the deliverable". The live instance, #5683 (W1-T3610),
// posted `CAPPED — 0/2 proofs executed; not certified` and was never dispatched a fix: MEASURED
// above, its two criteria carried a proof_exec grade (`exec_error`/`base_unreadable`/
// `not_yet_built`) the pre-fix filter silently dropped, so precondition 3
// (cappedProofDiscriminationFromLedger) came back with no evidence to route on.

const TASK_5683 = "W1-T3610";
const PR_URL_5683 = "https://github.com/acme/remudero/pull/5683";
const HEAD_5683 = "5683deadbeefcafefeed";

function pr5683(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 5683,
    prUrl: PR_URL_5683,
    taskId: TASK_5683,
    reviewState: "success",
    checksState: "green",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: "2026-09-16T10:00:00.000Z",
    headSha: HEAD_5683,
    autoMergeArmed: false,
    ...over,
  };
}

/** The EXACT shape #5683's own posted verdict carried: `CAPPED — 0/2 proofs executed; not
 *  certified`, both criteria met (a `state: "success"` capped verdict requires it), neither
 *  criterion `executed_pass`/`executed_fail` — the excluded-until-this-task proof_exec grades. */
function cappedPosted5683(proofExec: CriterionVerdict["proof_exec"] = "exec_error"): LedgerLine {
  return {
    run_id: "REVIEW-5683",
    task_id: TASK_5683,
    step: "review.posted",
    pr_url: PR_URL_5683,
    head_sha: HEAD_5683,
    state: "success",
    capped: true,
    plan_only: false,
    decision_verdict: {
      state: "success",
      capped: true,
      planOnly: false,
      criteria: [
        { claim: "a", proof: "unit test: a title no test carries", met: true, reason: "matched on the keyword floor", proof_exec: proofExec },
        { claim: "b", proof: "unit test: another such title", met: true, reason: "matched on the keyword floor", proof_exec: proofExec },
      ],
    },
  };
}

test("W1-T3669: the capped routing block names WHICH precondition blocked #5683's real shape, and confirms it now fires", () => {
  // Precondition 1 — disposition. A refused-escalate PR never reads the capped route at all.
  const notMergeable = diagnoseCappedRoutingBlock(pr5683(), "blocked-ambiguous", [cappedPosted5683()]);
  assert.equal(notMergeable.blocked, true);
  assert.equal(notMergeable.precondition, "not-mergeable");

  // Precondition 2 — an operator hold. Engaged by a confirmed human authority, PR-scoped.
  const held = diagnoseCappedRoutingBlock(pr5683(), "mergeable", [
    cappedPosted5683(),
    { step: "automerge.hold_engaged", pr_number: 5683, by: "operator", reason: "reviewing manually", authority: "console-confirmed" },
  ]);
  assert.equal(held.blocked, true);
  assert.equal(held.precondition, "held");

  // Precondition 3 — proof discrimination. No review.posted row binds to this exact head at all.
  const noEvidence = diagnoseCappedRoutingBlock(pr5683(), "mergeable", []);
  assert.equal(noEvidence.blocked, true);
  assert.equal(noEvidence.precondition, "no-proof-discrimination");

  // Precondition 4 — the arm predicate. An operator override makes decideSweepArm report arm:true,
  // so the capped route correctly stands down (the override IS the human sign-off).
  const armNotRefused = diagnoseCappedRoutingBlock(pr5683(), "mergeable", [
    cappedPosted5683(),
    { step: "automerge.capped_override_granted", task_id: TASK_5683, head_sha: HEAD_5683, by: "operator", reason: "reviewed manually" },
  ]);
  assert.equal(armNotRefused.blocked, true);
  assert.equal(armNotRefused.precondition, "arm-not-refused");

  // #5683's OWN shape, un-doctored: every precondition now holds, and the route fires. Before
  // W1-T3669's fix to proofDiscriminationEvidenceFromCriteria, this fixture diagnosed exactly like
  // `noEvidence` above (precondition 3, "no-proof-discrimination") for every one of the three
  // excluded proof_exec grades — the 98-refusals/0-dispatches gap this task measured.
  for (const proofExec of ["exec_error", "base_unreadable", "not_yet_built"] as const) {
    const fires = diagnoseCappedRoutingBlock(pr5683(), "mergeable", [cappedPosted5683(proofExec)]);
    assert.equal(fires.blocked, false, `proof_exec "${proofExec}" must no longer diagnose as blocked`);
  }
});

test("W1-T3669: a capped-green PR shaped exactly like #5683 reaches the fix rung instead of standing down", async () => {
  // ACCEPTANCE 3 — the count that was zero becomes non-zero: `runSweep` dispatches the existing fix
  // rung for #5683's exact captured shape, never leaving it parked on `mergeable`.
  for (const proofExec of ["exec_error", "base_unreadable", "not_yet_built"] as const) {
    const path = ledgerPath();
    appendLedger(path, cappedPosted5683(proofExec));
    const observed = { armed: 0, fixed: [] as Array<ProofDiscriminationEvidence | undefined>, escalated: 0 };
    const summary = await runSweep([pr5683()], sweepDeps(path, observed));
    assert.equal(summary.byDisposition["blocked-fixable"], 1, `proof_exec "${proofExec}" must reach blocked-fixable`);
    assert.equal(summary.byDisposition.mergeable, 0, `proof_exec "${proofExec}" must not stand parked on mergeable`);
    assert.equal(observed.fixed.length, 1, `proof_exec "${proofExec}" must actually dispatch the fix rung`);
    assert.equal(observed.fixed[0]?.proofs.length, 2, "both of #5683's criteria reach the dispatch, not just one");
  }
});

test("W1-T3669: the arm refusal is unmoved — a capped verdict shaped like #5683 still refuses to arm after the route fires", async () => {
  // ACCEPTANCE 2 — the control. A fixture that would redden if the capped-route fix ever relaxed
  // the arm gate itself: `decideSweepArm` must still refuse, `deps.arm` must never be called, and
  // disposition must never resolve to the armable `mergeable` lane.
  const path = ledgerPath();
  appendLedger(path, cappedPosted5683("exec_error"));
  assert.equal(decideSweepArm(pr5683(), [cappedPosted5683("exec_error")]).arm, false, "the arm predicate itself is untouched by this task's fix");
  const observed = { armed: 0, fixed: [] as Array<ProofDiscriminationEvidence | undefined>, escalated: 0 };
  const summary = await runSweep([pr5683()], sweepDeps(path, observed));
  assert.equal(observed.armed, 0, "auto-merge is never armed for a capped verdict, before or after this fix");
  assert.equal(summary.byDisposition.mergeable, 0, "a capped-green PR never resolves to the armable mergeable lane");
});
