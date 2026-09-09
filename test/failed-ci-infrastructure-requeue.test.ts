import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readLedgerLines } from "../src/lib/status.js";
import { buildSweepEffects } from "../src/run-task.js";
import type { IssueGateway } from "../src/lib/escalate.js";
import {
  ARTIFACT_FINALIZE_INTERMEDIARY_403,
  DEFAULT_SWEEP_POLICY,
  classifyCiInfrastructureFailure,
  runSweep,
  type CiFailure,
  type FixDispatchEvidence,
  type OpenPrView,
  type SweepDeps,
} from "../src/lib/sweep.js";

const TRANSCRIPT = [
  "Artifact upload completed successfully!",
  "Finalizing artifact upload",
  "Failed to FinalizeArtifact: (403) Forbidden: Error from intermediary",
].join("\n");

function infra(name = "ci-shard (2/4)"): CiFailure {
  return { name, conclusion: "FAILURE", jobId: "34249290033", logTail: TRANSCRIPT };
}

function subject(overrides: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 4671,
    prUrl: "https://github.com/craigoley/remudero/pull/4671",
    taskId: "W1-T3140",
    reviewState: "none",
    checksState: "red",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: "2026-09-08T15:30:00Z",
    headSha: "e0838eb6e0702ff1a35bd5d9c240e8c7bbf6fd25",
    headRefName: "run-W1-T3140-1788886671767",
    autoMergeArmed: false,
    ciFailures: [infra()],
    ...overrides,
  };
}

function deps(ledgerPath: string) {
  const requeued: CiFailure[] = [];
  const escalated: CiFailure[] = [];
  const fixed: FixDispatchEvidence[] = [];
  const d: SweepDeps = {
    arm: () => {},
    close: () => {},
    dispatchFix: (_pr, evidence) => {
      fixed.push(evidence);
    },
    escalate: () => {},
    requeueCheck: (_pr, failure) => {
      const preCall = readLedgerLines(ledgerPath).find(
        (line) =>
          line.step === "sweep.check_requeued" &&
          line.head_sha === subject().headSha &&
          line.check_name === failure.name,
      );
      assert.ok(preCall, "the durable bound is written before the GitHub mutation");
      requeued.push(failure as CiFailure);
      return true;
    },
    escalateInfrastructureCheck: (_pr, failure) => {
      escalated.push(failure);
    },
    ledgerPath,
    runId: "SWEEP-INFRA-TEST",
    now: () => Date.parse("2026-09-08T15:40:00Z"),
  };
  return { d, escalated, fixed, requeued };
}

test("only the complete upload-then-FinalizeArtifact intermediary 403 classifies as retryable infrastructure", () => {
  assert.equal(
    classifyCiInfrastructureFailure({ conclusion: "FAILURE", logTail: TRANSCRIPT }),
    ARTIFACT_FINALIZE_INTERMEDIARY_403,
  );
  for (const text of [
    "403 Forbidden",
    "permission denied: 403 Forbidden",
    "AssertionError: expected 1 to equal 2\n403 Forbidden",
    "error TS2322: Type 'string' is not assignable to type 'number'\n403 Forbidden",
    "Finalizing artifact upload\nFailed to FinalizeArtifact: (403) Forbidden: Error from intermediary",
    "Artifact upload completed successfully!\nFailed to FinalizeArtifact: (403) Forbidden: Error from intermediary",
    "Artifact upload completed successfully!\nFinalizing artifact upload",
    "",
    `${TRANSCRIPT}\nPermission denied while writing artifact`,
    `${TRANSCRIPT}\nAssertionError: expected 1 to equal 2`,
    `${TRANSCRIPT}\nerror TS2322: Type 'string' is not assignable to type 'number'`,
    [
      "Failed to FinalizeArtifact: (403) Forbidden: Error from intermediary",
      "Finalizing artifact upload",
      "Artifact upload completed successfully!",
    ].join("\n"),
  ]) {
    assert.equal(
      classifyCiInfrastructureFailure({ conclusion: "FAILURE", logTail: text }),
      undefined,
      `fail closed for ${JSON.stringify(text)}`,
    );
  }
  assert.equal(
    classifyCiInfrastructureFailure({ conclusion: "ERROR", logTail: TRANSCRIPT }),
    undefined,
    "the exact FAILURE conclusion is part of the signature",
  );
});

test("a matching PR job is rerun once before any worker strike and records bounded, log-free telemetry", async () => {
  const ledgerPath = join(mkdtempSync(join(tmpdir(), "rmd-ci-infra-")), "ledger.ndjson");
  const f = deps(ledgerPath);
  await runSweep([subject()], f.d, DEFAULT_SWEEP_POLICY);

  assert.equal(f.requeued.length, 1);
  assert.equal(f.fixed.length, 0, "the infrastructure-only result spends no worker strike");
  assert.equal(f.escalated.length, 0);
  const rows = readLedgerLines(ledgerPath);
  const bound = rows.find((line) => line.step === "sweep.check_requeued");
  assert.equal(bound?.surface, "pr");
  assert.equal(bound?.signature, ARTIFACT_FINALIZE_INTERMEDIARY_403);
  assert.equal(bound?.job_id, "34249290033");
  assert.equal(bound?.worker_strike_avoided, true);
  assert.ok(!("logTail" in (bound ?? {})) && !("log" in (bound ?? {})), "unbounded log evidence is never copied");
  const outcome = rows.find((line) => line.step === "sweep.ci_infrastructure_requeue");
  assert.equal(outcome?.outcome, "dispatched");
  assert.equal(outcome?.head_sha, subject().headSha);
});

test("the same PR head escalates after one rerun, while a new head gets a fresh allowance", async () => {
  const ledgerPath = join(mkdtempSync(join(tmpdir(), "rmd-ci-infra-repeat-")), "ledger.ndjson");
  const first = deps(ledgerPath);
  await runSweep([subject()], first.d, DEFAULT_SWEEP_POLICY);
  assert.equal(first.requeued.length, 1);

  const second = deps(ledgerPath);
  await runSweep([subject()], second.d, DEFAULT_SWEEP_POLICY);
  assert.equal(second.requeued.length, 0);
  assert.equal(second.escalated.length, 1);
  assert.equal(second.fixed.length, 0);

  const third = deps(ledgerPath);
  await runSweep([subject({ headSha: "new-head", ciFailures: [infra()] })], third.d, DEFAULT_SWEEP_POLICY);
  assert.equal(third.requeued.length, 1, "the bound is exact-head scoped");
});

test("mixed PR evidence reruns only the proven infrastructure job and keeps genuine failures on the normal fix route", async () => {
  const ledgerPath = join(mkdtempSync(join(tmpdir(), "rmd-ci-infra-mixed-")), "ledger.ndjson");
  const f = deps(ledgerPath);
  const genuine: CiFailure = {
    name: "test-slow (4/4)",
    conclusion: "FAILURE",
    jobId: "444",
    logTail: "AssertionError: expected true but got false",
  };
  await runSweep([subject({ ciFailures: [infra(), genuine] })], f.d, DEFAULT_SWEEP_POLICY);

  assert.deepEqual(f.requeued.map((failure) => failure.name), ["ci-shard (2/4)"]);
  assert.equal(f.fixed.length, 1);
  assert.deepEqual(f.fixed[0]?.ciFailures?.map((failure) => failure.name), ["test-slow (4/4)"]);
});

// W1-T3194 — the `missing-job-id` arm. A failure can classify as proven infrastructure and still
// carry no resolvable Actions job id (the rollup entry had no `databaseId`), and there is then
// nothing to rerun. diff-coverage flagged src/lib/sweep.ts:4623-4624 because every test above
// supplies a job id. The outcome must be RECORDED rather than silently dropped: a rerun that
// never happened for a reason nobody can see is the failure mode this rung exists to end.
test("a proven infrastructure failure with no resolvable job id is recorded, never silently dropped", async () => {
  const ledgerPath = join(mkdtempSync(join(tmpdir(), "rmd-ci-infra-nojob-")), "ledger.ndjson");
  const f = deps(ledgerPath);
  const withoutJobId = { ...infra(), jobId: undefined } as CiFailure;

  await runSweep([subject({ ciFailures: [withoutJobId] })], f.d, DEFAULT_SWEEP_POLICY);

  assert.equal(f.requeued.length, 0, "nothing can be rerun without a job id");
  assert.equal(f.fixed.length, 0, "and it still spends no worker strike — the classification stands");
  const rows = readLedgerLines(ledgerPath);
  const outcome = rows.find((line) => line.step === "sweep.ci_infrastructure_requeue");
  assert.equal(outcome?.outcome, "missing-job-id", "the arm names itself on the ledger");
  assert.equal(
    rows.filter((line) => line.step === "sweep.check_requeued").length,
    0,
    "and no bounded-retry record is written for a retry that never happened",
  );
  // The REASON rides the escalation, not the ledger row — so the arm is not merely recorded, it
  // reaches a human with the sentence that explains why nothing was rerun.
  assert.equal(f.escalated.length, 1, "a classified failure nobody can rerun is escalated, not dropped");
  assert.equal(f.escalated[0].name, withoutJobId.name);
});

test("MUTANT: the same failure WITH a job id still reruns — the missing-id arm is narrow", async () => {
  // The falsifier for the test above: identical fixture, only `jobId` differs.
  const ledgerPath = join(mkdtempSync(join(tmpdir(), "rmd-ci-infra-nojob-control-")), "ledger.ndjson");
  const f = deps(ledgerPath);
  await runSweep([subject({ ciFailures: [infra()] })], f.d, DEFAULT_SWEEP_POLICY);
  assert.equal(f.requeued.length, 1, "a resolvable job id still takes the dispatch arm");
  const outcome = readLedgerLines(ledgerPath).find((l) => l.step === "sweep.ci_infrastructure_requeue");
  assert.equal(outcome?.outcome, "dispatched");
});

test("the production sweep escalation adapter carries the check, signature, and refusal reason to the issue gateway", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-ci-infra-escalation-root-"));
  const ledgerPath = join(root, "ledger.ndjson");
  const created: Array<{ title: string; body: string; labels: string[] }> = [];
  const issues: IssueGateway = {
    create: (title, body, labels) => {
      created.push({ title, body, labels });
      return "https://github.com/craigoley/remudero/issues/9999";
    },
  };
  const effects = buildSweepEffects({
    owner: "craigoley",
    repo: "remudero",
    config: { root, claudeBin: "/usr/bin/true" } as never,
    ledgerPath: ledgerPath,
    runId: "SWEEP-INFRA-ESCALATION",
    plan: { tasks: [] } as never,
    log: () => {},
    policy: undefined,
    reviewRunner: undefined,
    spawnImpl: undefined,
    pushEmptyCommit: undefined,
    issuesImpl: issues,
  });

  await effects.escalateInfrastructureCheck?.(
    subject(),
    infra("coverage-ratchet"),
    "the single-job rerun API call failed",
    ARTIFACT_FINALIZE_INTERMEDIARY_403,
  );

  assert.equal(created.length, 1, "the production adapter reaches the configured issue gateway");
  assert.match(created[0]?.title ?? "", /coverage-ratchet/);
  assert.match(created[0]?.body ?? "", new RegExp(ARTIFACT_FINALIZE_INTERMEDIARY_403));
  assert.match(created[0]?.body ?? "", /single-job rerun API call failed/);
  assert.match(created[0]?.body ?? "", /No code worker or fix strike was spent/);
  assert.deepEqual(created[0]?.labels.slice(0, 1), ["needs-human"]);
});
