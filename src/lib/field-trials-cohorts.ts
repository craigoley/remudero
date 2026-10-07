import type { FlowRow } from "./field-trials-flow.js";

const PIN_FIELDS = ["harness", "prompt", "tool", "scorer", "environment"] as const;
export type TrialRevisionPins = Record<typeof PIN_FIELDS[number], string | null>;
const REVISION_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

/** Retain only immutable observed IDs, never a boolean claim or a guessed checkout revision. */
export function trialRevisionPins(stack: Record<string, unknown> | undefined): TrialRevisionPins {
  return Object.fromEntries(PIN_FIELDS.map((field) => {
    const pin = stack?.[`${field}Revision`] as { state?: unknown; value?: unknown } | undefined;
    const value = pin?.state === "observed" && typeof pin.value === "string" && REVISION_RE.test(pin.value)
      ? pin.value.toLowerCase() : null;
    return [field, value];
  })) as TrialRevisionPins;
}

/** BACKSTOP: cap private output cardinality; excess eligible assignments are counted as omitted. */
export const TRIAL_COHORT_MAX = 256;

export interface ServedTrialCohort {
  host: string; period: string; provider: string; selectedModel: string; servedModel: string; selectedEffort: string;
  taskClass: string; risk: string; workLane: string; revisions: TrialRevisionPins;
  assignments: number; workerSucceeded: number; workerFailed: number;
}

function assignmentIdentity(row: FlowRow): string {
  return JSON.stringify([row.host, row.runId, row.taskId, row.ts, row.provider, row.selectedModel, row.selectedEffort,
    row.taskClass, row.risk, row.workLane, row.stackRevisions]);
}

function terminalIdentity(row: FlowRow): string {
  return JSON.stringify([row.host, row.runId, row.taskId, row.ts, row.provider, row.servedModel, row.success]);
}

/** Private observational partitions. A worker outcome is not a merged/accepted task or a causal effect. */
export function servedTrialCohorts(rows: readonly FlowRow[], asOf: string, periodOf: (ts: string | null) => string) {
  const assignments = new Map<string, { row: FlowRow; conflict: boolean }>();
  const terminals = new Map<string, { row: FlowRow; conflict: boolean }>();
  let unkeyedAssignments = 0;
  let duplicateAssignments = 0;
  for (const row of rows) {
    if (row.step !== "worker.assignment" && row.step !== "worker.attempt") continue;
    if (row.assignmentId === null) {
      if (row.step === "worker.assignment") unkeyedAssignments += 1;
      continue;
    }
    const map = row.step === "worker.assignment" ? assignments : terminals;
    const prior = map.get(row.assignmentId);
    if (prior === undefined) map.set(row.assignmentId, { row, conflict: false });
    else {
      const identity = row.step === "worker.assignment" ? assignmentIdentity : terminalIdentity;
      if (identity(prior.row) !== identity(row)) prior.conflict = true;
      else if (row.step === "worker.assignment") duplicateAssignments += 1;
    }
  }
  const excluded: Record<string, number> = {};
  const refuse = (reason: string) => { excluded[reason] = (excluded[reason] ?? 0) + 1; };
  if (unkeyedAssignments > 0) excluded["assignment-id-unavailable"] = unkeyedAssignments;
  const cohorts = new Map<string, ServedTrialCohort>();
  let qualifiedAssignments = 0;
  for (const [id, assignment] of assignments) {
    const row = assignment.row;
    const terminal = terminals.get(id);
    if (assignment.conflict || terminal?.conflict) { refuse("conflicting-assignment-or-attempt"); continue; }
    if (terminal === undefined) { refuse("terminal-attempt-unavailable"); continue; }
    const attempt = terminal.row;
    if ([row.host, row.runId, row.taskId].some((value) => value === null)
      || row.host !== attempt.host || row.runId !== attempt.runId || row.taskId !== attempt.taskId
      || row.provider === null || row.provider !== attempt.provider) { refuse("attempt-identity-mismatch"); continue; }
    if (row.ts === null || attempt.ts === null || ![row.ts, attempt.ts, asOf].every((ts) => Number.isFinite(Date.parse(ts)))
      || Date.parse(attempt.ts) < Date.parse(row.ts) || Date.parse(attempt.ts) > Date.parse(asOf)) {
      refuse("attempt-time-unavailable-or-outside-window"); continue;
    }
    if (attempt.servedModel === null) { refuse("served-model-unavailable"); continue; }
    if (attempt.success === null) { refuse("worker-outcome-unavailable"); continue; }
    if ([row.selectedModel, row.selectedEffort, row.taskClass, row.risk, row.workLane].some((value) => value == null)) {
      refuse("assignment-context-unavailable"); continue;
    }
    const pins = row.stackRevisions;
    if (pins === undefined || PIN_FIELDS.some((field) => pins[field] === null || !REVISION_RE.test(pins[field]!))) {
      refuse("immutable-stack-pins-unavailable"); continue;
    }
    const dimensions = { host: row.host!, period: periodOf(row.ts), provider: row.provider,
      selectedModel: row.selectedModel!, servedModel: attempt.servedModel, selectedEffort: row.selectedEffort!,
      taskClass: row.taskClass!, risk: row.risk!, workLane: row.workLane!, revisions: pins };
    const key = JSON.stringify(dimensions);
    let cohort = cohorts.get(key);
    if (cohort === undefined) {
      if (cohorts.size >= TRIAL_COHORT_MAX) { refuse("cohort-output-bound"); continue; }
      cohort = { ...dimensions, assignments: 0, workerSucceeded: 0, workerFailed: 0 };
      cohorts.set(key, cohort);
    }
    cohort.assignments += 1;
    cohort.workerSucceeded += Number(attempt.success);
    cohort.workerFailed += Number(!attempt.success);
    qualifiedAssignments += 1;
  }
  return { version: "served-trial-cohorts-v1" as const, observational: true as const, causalClaims: "none" as const,
    outcomeBasis: "terminal-worker-attempt" as const, denominator: assignments.size + unkeyedAssignments,
    duplicateAssignments, qualifiedAssignments, excludedAssignments: Object.values(excluded).reduce((sum, n) => sum + n, 0),
    excluded, cohorts: [...cohorts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, value]) => value) };
}
