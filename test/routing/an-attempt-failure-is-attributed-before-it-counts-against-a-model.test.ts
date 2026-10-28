/**
 * W1-T10875 — an attempt failure is attributed before it counts against a model.
 *
 * servedTrialCohorts added every unsuccessful worker.attempt to `workerFailed` for the model the
 * attempt named, so a cash ladder refusal that never reached a provider, or a worker killed by its
 * host, read as that model's failure. attributeAttemptOutcome classifies each attempt as success,
 * model, pre-request-refusal, infrastructure or unknown from named fields and the writers' own
 * exported constants, and the cohort counts `workerFailed` from "model" alone.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { attributeAttemptOutcome } from "#src/lib/attempt-outcome-attribution.js";
import { ORPHANED_BY_PROCESS_EXIT, attemptAssignmentJoin, orphanedAttemptFields } from "#src/lib/benchmark-run.js";
import { servedTrialCohorts } from "#src/lib/field-trials-cohorts.js";
import { periodOf, projectFlowRow } from "#src/lib/field-trials-flow.js";
import { QuietRoundEndedError } from "#src/lib/quiet-worker-watchdog.js";
import { SubscriptionOnlyRefusedError } from "#src/lib/worker.js";
import {
  CASH_SERVED_MODEL_REASONS, OpenWeightRequestTooLargeError, OpenWeightTruncatedReplyError,
  OpenWeightUnsupportedResponseFormatError,
} from "#src/lib/worker-provider.js";

const T = (day: number, hour = 0) => new Date(Date.UTC(2026, 9, day, hour)).toISOString();
const ZERO_TOKENS = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
const PIN_FIELDS = ["harness", "prompt", "tool", "scorer", "environment"] as const;
const stack = Object.fromEntries(PIN_FIELDS.map((field, i) => [`${field}Revision`, { state: "observed", value: String(i + 1).repeat(40) }]));

/** The shape recordBenchmarkWorkerAttempt (src/run-task.ts) writes for a cash rung that got no response. */
function cashNoResponse(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { step: "worker.attempt", selection_assignment_id: "asg-luna", success: false, served_model: null,
    served_model_reason: CASH_SERVED_MODEL_REASONS.noResponse, worker_duration_ms: 26, billing_mode: "api",
    tokens: ZERO_TOKENS, total_cost_usd: 0, ...extra };
}

function assignment(id: string): Record<string, unknown> {
  return { ts: T(10), step: "worker.assignment", host: "host-alpha", task_id: `task-${id}`, run_id: `run-${id}`,
    worker_assignment: { id, selected: { provider: "cash", model: "gpt-6-luna", effort: "medium" } },
    benchmark_run: { work: { taskClass: { state: "observed", value: "implement" }, risk: { state: "observed", value: "medium" },
      shape: { lane: { state: "observed", value: "build" } } }, stack } };
}

function attempt(id: string, fields: Record<string, unknown>): Record<string, unknown> {
  return { ts: T(10, 1), host: "host-alpha", task_id: `task-${id}`, run_id: `run-${id}`, ...fields, step: "worker.attempt",
    selection_assignment_id: id };
}

/** Fold ledger-shaped pairs through the production projection (projectFlowRow); nothing is injected past it. */
function fold(pairs: { id: string; attempt: Record<string, unknown> }[]) {
  const rows = pairs.flatMap(({ id, attempt: fields }, i) =>
    [projectFlowRow(assignment(id), `fp-s-${i}`), projectFlowRow(attempt(id, fields), `fp-a-${i}`)]);
  return servedTrialCohorts(rows, T(11), periodOf);
}

test("W1-T10875: a cash ladder refusal with no response never counts as a model failure", () => {
  assert.deepEqual(attributeAttemptOutcome(cashNoResponse()), { outcome: "pre-request-refusal", signal: "cash-no-response" });
  // The census shape exactly: no tokens and no cost key at all is the same refusal as observed zeros.
  const bare = cashNoResponse();
  delete bare.tokens; delete bare.total_cost_usd;
  assert.equal(attributeAttemptOutcome(bare).outcome, "pre-request-refusal");
  for (const reason of ["deployment-absent", "unsupported-response-format", "cash-sonnet-refused"]) {
    assert.deepEqual(attributeAttemptOutcome(cashNoResponse({ worker_failure: reason })),
      { outcome: "pre-request-refusal", signal: `fallback-${reason}` }, reason);
  }
  for (const refusal of [OpenWeightRequestTooLargeError, SubscriptionOnlyRefusedError, OpenWeightUnsupportedResponseFormatError]) {
    const thrown = { step: "worker.attempt", ...attemptAssignmentJoin("asg", true), success: false,
      worker_failure: "spawn-threw-before-result", pre_selection: false, error_class: refusal.name };
    assert.deepEqual(attributeAttemptOutcome(thrown), { outcome: "pre-request-refusal", signal: `refused-${refusal.name}` });
  }
  const admission = { step: "worker.attempt", success: false, terminal_evidence: { state: "observed",
    invocation: { state: "observed", value: "not-started", reason: "admission-abandoned" } } };
  assert.deepEqual(attributeAttemptOutcome(admission), { outcome: "pre-request-refusal", signal: "invocation-not-started" });
  const allowance = { step: "worker.attempt", success: false, served_model: null, terminal_evidence: { state: "observed",
    allowanceRefused: { state: "observed", value: true }, reservedUsd: { state: "observed", value: 0 }, settledUsd: { state: "observed", value: 0 } } };
  assert.deepEqual(attributeAttemptOutcome(allowance), { outcome: "pre-request-refusal", signal: "allowance-refused" });
  // A refusal reason beside spend is a contradiction, never a refusal: it is reported as unknown.
  assert.equal(attributeAttemptOutcome(cashNoResponse({ total_cost_usd: 0.02 })).outcome, "unknown");
  // Free text is not a signal: a reworded reason string is not the exported constant.
  assert.equal(attributeAttemptOutcome(cashNoResponse({ served_model_reason: "no cash response arrived" })).outcome, "unknown");

  const evidence = fold([{ id: "luna", attempt: cashNoResponse() }]);
  assert.deepEqual(evidence.outcomeAttribution, { success: 0, model: 0, "pre-request-refusal": 1, infrastructure: 0, unknown: 0 });
  assert.equal(evidence.cohorts.reduce((sum, cohort) => sum + cohort.workerFailed, 0), 0);
});

test("W1-T10875: an orphaned or signal-ended attempt is infrastructure, not the model", () => {
  const orphan: Record<string, unknown> = { step: "worker.attempt", ...orphanedAttemptFields("asg-orphan", "daemon-boot") };
  assert.equal(orphan.worker_failure, ORPHANED_BY_PROCESS_EXIT);
  assert.deepEqual(attributeAttemptOutcome(orphan), { outcome: "infrastructure", signal: ORPHANED_BY_PROCESS_EXIT });
  const beforeAssignment = { step: "worker.attempt", ...attemptAssignmentJoin(undefined, true), success: false,
    worker_failure: "spawn-threw-before-result", pre_selection: true, error_class: "Error" };
  assert.deepEqual(attributeAttemptOutcome(beforeAssignment), { outcome: "infrastructure", signal: "spawn-threw-before-assignment" });
  const latched = { step: "worker.attempt", ...attemptAssignmentJoin("asg", true), success: false,
    worker_failure: "spawn-threw-before-result", pre_selection: false, error_class: QuietRoundEndedError.name };
  assert.deepEqual(attributeAttemptOutcome(latched), { outcome: "infrastructure", signal: "round-ended-for-restart-or-recycle" });
  const killed = { step: "worker.attempt", success: false, served_model: "gpt-6-luna-snapshot", worker_exit: "signal",
    worker_exit_signal: "SIGKILL", tokens: { ...ZERO_TOKENS, input: 900 }, total_cost_usd: 0.01 };
  assert.deepEqual(attributeAttemptOutcome(killed), { outcome: "infrastructure", signal: "worker-exit-signal" });

  // A signal death that already named its served model qualifies for a cohort, and still is not the model's.
  const evidence = fold([{ id: "killed", attempt: { success: false, served_model: "gpt-6-luna-snapshot",
    worker_exit: "signal", worker_exit_signal: "SIGKILL" } },
  { id: "orphan", attempt: orphanedAttemptFields("orphan", "daemon-boot") }]);
  assert.equal(evidence.qualifiedAssignments, 1);
  const cohort = evidence.cohorts[0]!;
  assert.equal(cohort.workerFailed, 0, "a killed worker is never the model's failure");
  assert.equal(cohort.workerInfrastructure, 1);
  assert.equal(evidence.excluded["served-model-unavailable"], 1, "the orphan still has no served model to bucket under");
  assert.deepEqual(evidence.outcomeAttribution, { success: 0, model: 0, "pre-request-refusal": 0, infrastructure: 2, unknown: 0 },
    "the projected worker_failure places the orphan as infrastructure, never unknown or the model");
});

test("W1-T10875: a provider-invoked contract or truncation failure is the model", () => {
  const draft = { step: "worker.attempt", success: false, worker_failure: "draft-contract", served_model: "gpt-oss-120b",
    tokens: { ...ZERO_TOKENS, input: 1200, output: 300 }, total_cost_usd: 0.004 };
  assert.deepEqual(attributeAttemptOutcome(draft), { outcome: "model", signal: "draft-contract" });
  const truncated = { step: "worker.attempt", ...attemptAssignmentJoin("asg", true), success: false,
    worker_failure: "spawn-threw-before-result", pre_selection: false, error_class: OpenWeightTruncatedReplyError.name };
  assert.deepEqual(attributeAttemptOutcome(truncated), { outcome: "model", signal: `reply-${OpenWeightTruncatedReplyError.name}` });
  const unnamed = { step: "worker.attempt", success: false, served_model: null, served_model_reason: CASH_SERVED_MODEL_REASONS.unnamed,
    tokens: { ...ZERO_TOKENS, output: 40 }, total_cost_usd: 0.001 };
  assert.deepEqual(attributeAttemptOutcome(unnamed), { outcome: "model", signal: "served-model-unnamed" });
  const replied = { step: "worker.attempt", success: false, served_model: "claude-sonnet-5-5", tokens: { ...ZERO_TOKENS, output: 12 } };
  assert.deepEqual(attributeAttemptOutcome(replied), { outcome: "model", signal: "provider-invoked" });
  assert.deepEqual(attributeAttemptOutcome({ step: "worker.attempt", success: true }), { outcome: "success", signal: "success" });

  const evidence = fold([{ id: "draft", attempt: draft },
    { id: "ok", attempt: { success: true, served_model: "gpt-oss-120b" } }]);
  const cohort = evidence.cohorts.find((entry) => entry.servedModel === "gpt-oss-120b")!;
  assert.equal(cohort.workerFailed, 1); assert.equal(cohort.workerSucceeded, 1);
  assert.deepEqual(evidence.outcomeAttribution, { success: 1, model: 1, "pre-request-refusal": 0, infrastructure: 0, unknown: 0 });
});

test("W1-T10875: an attempt the signals cannot place is unknown and counted in neither", () => {
  const thrown = { step: "worker.attempt", ...attemptAssignmentJoin("asg", true), success: false,
    worker_failure: "spawn-threw-before-result", pre_selection: false, error_class: "TypeError" };
  assert.deepEqual(attributeAttemptOutcome(thrown), { outcome: "unknown", signal: "no-attribution-signal" });
  assert.deepEqual(attributeAttemptOutcome({ step: "worker.attempt" }), { outcome: "unknown", signal: "worker-outcome-unavailable" });
  // A fallback refusal that names a served model contradicts itself; it is reported, never guessed.
  const contradicted = { step: "worker.attempt", success: false, worker_failure: "deployment-absent", served_model: "gpt-6-luna-snapshot" };
  assert.deepEqual(attributeAttemptOutcome(contradicted), { outcome: "unknown", signal: "refusal-with-invocation-evidence" });

  const evidence = fold([{ id: "contradicted", attempt: { success: false, served_model: "gpt-6-luna-snapshot",
    worker_failure: "deployment-absent" } }, { id: "thrown", attempt: thrown }]);
  assert.equal(evidence.qualifiedAssignments, 1);
  const cohort = evidence.cohorts[0]!;
  assert.equal(cohort.assignments, 1);
  assert.equal(cohort.workerFailed, 0); assert.equal(cohort.workerSucceeded, 0);
  assert.equal(cohort.workerUnattributed, 1, "unknown is a counted third value, not a dropped row");
  assert.deepEqual(evidence.outcomeAttribution, { success: 0, model: 0, "pre-request-refusal": 0, infrastructure: 0, unknown: 2 });
});
