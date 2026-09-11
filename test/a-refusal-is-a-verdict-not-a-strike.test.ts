import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildOpenPrViews, IMPLEMENT_REFUSAL_REPORT_CONTRACT } from "../src/run-task.js";
import {
  decideAutoMergeArm,
  judgeReview,
  reviewLedgerReasons,
  type CriterionVerdict,
} from "../src/lib/review.js";
import {
  DEFAULT_SWEEP_POLICY,
  deriveDisposition,
  onlyRefusedUnmetCriteria,
  runSweep,
  type OpenPrView,
  type SweepDeps,
} from "../src/lib/sweep.js";

const NOW = Date.parse("2026-09-11T12:00:00.000Z");

function refusalReport(): string {
  return [
    "REPORT",
    "REFUSED:",
    "1. [premise-rotted] The required API was removed from the current branch.",
    "PR_URL: https://github.com/o/r/pull/77",
  ].join("\n");
}

function refusedVerdict(body = "The work cannot be completed as written.") {
  return judgeReview(
    [{ claim: "The API is available", proof: "grep: src/api.ts -> oldApi" }],
    { diff: "", report: body, implementationReport: refusalReport() },
  );
}

function refusalCriterion(): CriterionVerdict {
  const verdict = refusedVerdict();
  assert.equal(verdict.criteria.length, 1);
  return verdict.criteria[0];
}

function refusalPr(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 77,
    prUrl: "https://github.com/o/r/pull/77",
    taskId: "W1-T3078",
    reviewState: "failure",
    checksState: "green",
    unmetCriteria: [refusalCriterion()],
    priorStrikes: 1,
    lastActivityAt: "2026-09-11T11:00:00.000Z",
    headSha: "refusal-head",
    autoMergeArmed: false,
    ...over,
  };
}

test("a structured worker refusal is a deterministic failed criterion and cannot arm", () => {
  const verdict = refusedVerdict();
  assert.equal(verdict.state, "failure");
  assert.deepEqual(verdict.criteria[0].refusal, {
    class: "premise-rotted",
    detail: "The required API was removed from the current branch.",
  });
  assert.equal(verdict.criteria[0].met, false);
  assert.equal(verdict.criteria[0].floorMet, false);
  assert.match(verdict.criteria[0].reason, /worker refused \[premise-rotted\]/);
  assert.deepEqual(reviewLedgerReasons(verdict), [verdict.criteria[0].reason]);
  assert.equal(decideAutoMergeArm(verdict, false).arm, false);
});

test("a body may not explicitly claim a worker-refused criterion complete", () => {
  const verdict = refusedVerdict("Criterion 1: COMPLETE");
  assert.deepEqual(verdict.refusalContradictions, [{ criterionIndex: 0, refusalClass: "premise-rotted" }]);
  assert.match(verdict.summary, /claims criterion 1 complete after worker refused it \[premise-rotted\]/);
});

test("only structured refusals route to escalation without dispatching a fix strike", async () => {
  const pr = refusalPr();
  const disposition = deriveDisposition(pr, DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(onlyRefusedUnmetCriteria(pr.unmetCriteria), true);
  assert.equal(disposition.disposition, "refused-escalate");
  assert.match(disposition.reason, /premise-rotted/);

  let dispatched = 0;
  const escalations: string[] = [];
  const ledger: Array<Record<string, unknown>> = [];
  const deps: SweepDeps = {
    ledgerPath: "/unused/refusal-ledger.ndjson",
    runId: "REFUSAL-TEST",
    now: () => NOW,
    readLedger: () => ledger,
    appendLine: (_path, line) => { ledger.push(line); },
    arm: () => undefined,
    close: () => undefined,
    dispatchFix: () => { dispatched++; },
    escalate: (_pr, reason, question) => { escalations.push(`${reason}\n${question.question}`); },
  };

  const summary = await runSweep([pr], deps, DEFAULT_SWEEP_POLICY);
  assert.equal(dispatched, 0, "a refusal must not enter the strike-spending fix rung");
  assert.equal(escalations.length, 1);
  assert.match(escalations[0], /premise-rotted/);
  assert.equal(summary.actions[0].disposition, "refused-escalate");
  assert.equal(summary.actions[0].acted, true);
});

test("a red required check still takes precedence over a refusal", () => {
  const disposition = deriveDisposition(
    refusalPr({ checksState: "red", redRequiredChecks: ["ci"] }),
    DEFAULT_SWEEP_POLICY,
    NOW,
  );
  assert.equal(disposition.disposition, "blocked-fixable");
});

test("the cold sweep reconstructs a refusal only from the structured review verdict", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-w1-t3078-"));
  const ledgerPath = join(dir, "ledger.ndjson");
  const body = "Remudero-Task: W1-T3078";
  writeFileSync(
    ledgerPath,
    `${JSON.stringify({
      ts: "2026-09-11T11:00:00.000Z",
      step: "review.posted",
      task_id: "W1-T3078",
      pr_url: "https://github.com/o/r/pull/77",
      state: "failure",
      unmet_criteria: ["The API is available"],
      reasons: ["worker refused [premise-rotted]: The required API was removed from the current branch."],
      decision_verdict: {
        criteria: [{
          claim: "The API is available",
          proof: "grep: src/api.ts -> oldApi",
          met: false,
          reason: "worker refused [premise-rotted]: The required API was removed from the current branch.",
          proof_exec: "not_executable",
          refusal: { class: "premise-rotted", detail: "The required API was removed from the current branch." },
        }],
      },
    })}\n`,
  );
  const fetch = (args: string[]): unknown => {
    const path = args.at(-1) ?? "";
    if (/pulls\?state=open/.test(path)) {
      return [{
        number: 77,
        html_url: "https://github.com/o/r/pull/77",
        head: { ref: "run-W1-T3078-1", sha: "refusal-head" },
        updated_at: "2026-09-11T11:00:00.000Z",
        body,
        auto_merge: null,
        state: "open",
      }];
    }
    if (/check-runs/.test(path)) {
      return { check_runs: [{ name: "ci-gate", status: "completed", conclusion: "success" }] };
    }
    if (/commits\/.+\/status/.test(path)) {
      return { statuses: [{ context: "remudero-review", state: "failure", created_at: "2026-09-11T11:00:00.000Z" }] };
    }
    if (/\/pulls\/77$/.test(path)) return { mergeable: true, mergeable_state: "clean" };
    return [];
  };
  try {
    const [view] = buildOpenPrViews("o", "r", ledgerPath, {
      fetch,
      requiredContexts: () => ["ci-gate"],
      readCiGateRequired: () => ["ci-gate"],
      fetchCiFailureEvidence: () => [],
    });
    assert.equal(view.unmetCriteria[0]?.refusal?.class, "premise-rotted");
    assert.equal(deriveDisposition(view, DEFAULT_SWEEP_POLICY, NOW).disposition, "refused-escalate");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the implement prompt teaches the exact closed refusal grammar", () => {
  assert.match(IMPLEMENT_REFUSAL_REPORT_CONTRACT, /REFUSED:/);
  assert.match(IMPLEMENT_REFUSAL_REPORT_CONTRACT, /<criterion index>\. \[premise-rotted\|outside-declared-files/);
  assert.match(IMPLEMENT_REFUSAL_REPORT_CONTRACT, /never approves work/);
});
