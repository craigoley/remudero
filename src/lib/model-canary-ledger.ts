/** Append bounded coding-control evidence to the existing application ledger. */
import { appendLedger, type LedgerLine } from "./ledger.js";
import { isQualifiedCodingPair, type CodingGrade, type CodingRunnerResult } from "./model-canary-coding.js";
import type { CanaryRun } from "./model-canary-metrics.js";
import type { CanaryExecutionOutcome } from "./model-canary-runner.js";

export interface CodingLedgerOutcome {
  run: CanaryRun;
  trace: CanaryExecutionOutcome["trace"];
  codingResult?: CodingRunnerResult;
  codingGrade?: CodingGrade;
}

export type CodingLedgerWriter = (path: string, row: LedgerLine) => void;

/**
 * Persist only an app-issued result/grade pair. Callers must first persist the same outcome in
 * the existing slot owner; this function adds no receipt store and never promotes configured
 * caps to observed resource measurements.
 */
export function codingLedgerSave(path: string, outcome: CodingLedgerOutcome,
  writer: CodingLedgerWriter = appendLedger): void {
  const { run, codingResult: result, codingGrade: grade } = outcome;
  if (!path || run.family !== "coding" || !result || !grade || !isQualifiedCodingPair(result, grade)
    || run.attempts.length > 1 || (grade.state === "scored"
      ? result.state !== "complete" || run.verified !== grade.passed
      : run.verified !== null)) throw new Error("canary-coding-ledger-evidence-invalid");

  const attempt = run.attempts[0];
  const binding = result.binding;
  if (binding && (binding.runId !== run.id || binding.caseId !== run.caseId
    || binding.suiteHash !== run.suiteHash || binding.canaryAttemptId !== attempt?.id
    || binding.workerSpawnAttemptId !== attempt?.workerExecutionJoin?.workerSpawnAttemptId
    || binding.sourceDigest !== attempt?.codingExecution?.sourceDigest))
    throw new Error("canary-coding-ledger-binding-invalid");
  if (grade.state === "scored" && (!attempt || !binding || result.execution.closure !== "proven"
    || result.execution.hostStarted !== "yes" || !result.execution.hostExecutionId))
    throw new Error("canary-coding-ledger-score-unqualified");

  const configured = "configured" in result ? result.configured : null;
  const observed = "observed" in result ? result.observed : null;
  const candidateOutput = result.state === "unavailable" ? result.candidateOutput : undefined;
  const stdoutBytes = result.state === "complete" ? Buffer.byteLength(result.stdout, "utf8")
    : candidateOutput ? Buffer.byteLength(candidateOutput.stdout, "utf8") : null;
  const stderrBytes = candidateOutput ? Buffer.byteLength(candidateOutput.stderr, "utf8") : null;
  const unauthorized = outcome.trace.some(event => event.denied);
  const actionTraceComplete = attempt?.terminal === "complete";
  const row: LedgerLine = {
    run_id: run.id,
    task_id: "MODEL-CANARY-CODING",
    step: "model_canary.coding_execution",
    execution_source: run.executionSource ?? "unclassified",
    source_activity: run.sourceActivity ?? null,
    case_id: run.caseId,
    suite_hash: run.suiteHash,
    model: run.model,
    route: run.route,
    effort: run.effort,
    coding_execution_state: result.state,
    coding_execution_reason: result.state === "complete" ? "native-execution-complete" : result.reason,
    grade_state: grade.state,
    passed: grade.state === "scored" ? grade.passed : null,
    observed_correctness: grade.observedCorrectness,
    grade_reason: grade.reason,
    canary_attempt_id: attempt?.id ?? null,
    worker_spawn_attempt_id: attempt?.workerExecutionJoin?.workerSpawnAttemptId ?? null,
    coding_execution_attempt_id: binding?.codingExecutionAttemptId ?? null,
    host_execution_id: result.execution.hostExecutionId,
    candidate_source_digest: result.state === "complete" ? result.sourceDigest
      : candidateOutput?.sourceDigest ?? attempt?.codingExecution?.sourceDigest ?? null,
    fixture_digest: grade.fixtureDigest,
    host_started: result.execution.hostStarted,
    descendant_closure: result.execution.closure,
    configured_bounds: configured,
    observed_resources: observed,
    exit_code: result.state === "complete" ? result.exitCode : candidateOutput?.exitCode ?? null,
    stdout_bytes: stdoutBytes,
    stderr_bytes: stderrBytes,
    observed_unauthorized_action: unauthorized ? true : actionTraceComplete ? false : null,
  };
  writer(path, row);
}
