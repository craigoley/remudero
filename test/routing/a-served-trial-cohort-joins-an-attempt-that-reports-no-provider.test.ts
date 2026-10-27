/**
 * W1-T10833 — a served-trial cohort joins an attempt that reports no provider.
 *
 * servedTrialCohorts (src/lib/field-trials-cohorts.ts) paired a worker.assignment row with its
 * worker.attempt row by assignment id, then refused the pair as `attempt-identity-mismatch`
 * whenever the attempt's provider differed from the assignment's — including when the attempt
 * simply never reported one. Production worker.attempt rows never carry a `provider` field, so
 * every live pair was refused and no cohort ever qualified. The assignment is the authority for
 * the selected provider; an attempt that reports none joins on identity (host/run/task) alone,
 * and the cohort's provider comes from the assignment. An attempt that DOES report a provider,
 * and it contradicts the assignment's, still refuses as a genuine identity mismatch.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { servedTrialCohorts } from "#src/lib/field-trials-cohorts.js";
import { periodOf, projectFlowRow } from "#src/lib/field-trials-flow.js";

const T = (day: number, hour = 0) => new Date(Date.UTC(2026, 9, day, hour)).toISOString();
const ASSIGNMENT_ID = "asg-no-provider";
const TASK_ID = "task-no-provider";
const RUN_ID = "run-no-provider";
const HOST = "host-alpha";

const CONTROL_FIELDS = ["harness", "prompt", "tool", "scorer", "environment"] as const;
const stackRevisions = Object.fromEntries(CONTROL_FIELDS.map((field, i) => [`${field}Revision`, { state: "observed", value: String(i + 1).repeat(40) }]));

/** A worker.assignment row shaped like production: the assignment is the only authority for provider. */
function assignmentRow(provider = "codex"): Record<string, unknown> {
  return {
    ts: T(10), step: "worker.assignment", host: HOST, task_id: TASK_ID, run_id: RUN_ID,
    worker_assignment: { id: ASSIGNMENT_ID, selected: { provider, model: "gpt-6.1-sol", effort: "medium" } },
    benchmark_run: { work: { taskClass: { state: "observed", value: "implement" }, risk: { state: "observed", value: "medium" },
      shape: { lane: { state: "observed", value: "build" } } }, stack: stackRevisions },
  };
}

/** A worker.attempt row shaped exactly like the production writer (src/run-task.ts): no `provider`
 *  key at all — never `provider: null`, never a legacy-fixture `provider: "codex"` stamp. */
function attemptRowNoProvider(): Record<string, unknown> {
  return { ts: T(10, 1), step: "worker.attempt", host: HOST, task_id: TASK_ID, run_id: RUN_ID,
    selection_assignment_id: ASSIGNMENT_ID, served_model: "gpt-6.1-sol-snapshot", success: true };
}

function attemptRowWithProvider(provider: string): Record<string, unknown> {
  return { ...attemptRowNoProvider(), provider };
}

function fold(rows: Record<string, unknown>[], asOf = T(11)) {
  const flowRows = rows.map((raw, i) => projectFlowRow(raw, `fp-${i}`));
  return servedTrialCohorts(flowRows, asOf, periodOf);
}

test("W1-T10833: an attempt with no provider joins its assignment", () => {
  const evidence = fold([assignmentRow("codex"), attemptRowNoProvider()]);
  assert.equal(evidence.denominator, 1);
  assert.equal(evidence.excludedAssignments, 0, `expected no refusals, got ${JSON.stringify(evidence.excluded)}`);
  assert.deepEqual(evidence.excluded, {});
  assert.equal(evidence.qualifiedAssignments, 1);
  assert.equal(evidence.cohorts.length, 1);
  assert.equal(evidence.cohorts[0]!.provider, "codex", "the cohort's provider comes from the assignment, not the silent attempt");
});

test("W1-T10833: a contradicting attempt identity still refuses", () => {
  const evidence = fold([assignmentRow("codex"), attemptRowWithProvider("other-provider")]);
  assert.equal(evidence.denominator, 1);
  assert.equal(evidence.qualifiedAssignments, 0);
  assert.deepEqual(evidence.excluded, { "attempt-identity-mismatch": 1 });
});
