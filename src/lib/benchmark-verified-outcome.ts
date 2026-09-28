import type { TaskCaseFile, TaskCaseRun } from "./task-case-file.js";

/** Private checkpoint keys are used only for the join; public groups contain no task or run ID. */
export interface VerifiedAssignment {
  assignmentId: string;
  taskId: string | null;
  runId: string | null;
  assignedAt: string | null;
  taskClass: string | null;
  selectedModel: string | null;
  servedModel: string | null;
  billingMode: "api" | "subscription" | null;
  costUsd: number | null;
  attempted: boolean;
}

export interface VerifiedOutcomeGroup {
  taskClass: string | null;
  selectedModel: string | null;
  assignments: number;
  completed: number;
  censored: number;
  unavailable: number;
  repairRunsObserved: number;
  latency: { observed: number; totalMs: number; meanMs: number | null };
  cost: { apiUsd: number; subscriptionNotionalUsd: number; observed: number; missing: number; noAttempt: number };
}

export interface BenchmarkVerifiedOutcome {
  state: "observed" | "observed-partial" | "unavailable";
  source: "task-case-file-v1";
  asOf: string;
  cutoff: string;
  coverage: { assignments: number; completed: number; censored: number; unavailable: number;
    reasons: Record<string, number> };
  groups: VerifiedOutcomeGroup[];
  experimentEffect: "unavailable-no-randomized-allocation";
}

const timestamp = (value: unknown): value is string => typeof value === "string"
  && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value)
  && Number.isFinite(Date.parse(value));

/** A run's outcome is shared by EVERY assignment it wrote (W1-T4646); a case file from before
 * `assignmentIds` existed falls back to the single last `assignmentId` it recorded. */
function runWroteAssignment(run: TaskCaseRun, assignmentId: string): boolean {
  const written = Array.isArray(run.assignmentIds) ? run.assignmentIds : [run.assignmentId];
  return written.includes(assignmentId);
}

/** No worker-call result, ledger verdict, or closed PR can independently award completion. */
export function joinVerifiedTaskOutcomes(
  assignments: readonly VerifiedAssignment[], caseFiles: readonly TaskCaseFile[], cutoff: string,
): BenchmarkVerifiedOutcome {
  if (!timestamp(cutoff)) throw new TypeError("verified outcome cutoff must be an ISO timestamp");
  const byTask = new Map<string, TaskCaseFile[]>();
  for (const file of caseFiles) {
    if (file?.version !== "task-case-file-v1" || typeof file.taskId !== "string") continue;
    byTask.set(file.taskId, [...(byTask.get(file.taskId) ?? []), file]);
  }
  const groups = new Map<string, VerifiedOutcomeGroup>();
  const reasons: Record<string, number> = {};
  let completed = 0; let censored = 0; let unavailable = 0;
  for (const assignment of assignments) {
    const key = JSON.stringify([assignment.taskClass, assignment.selectedModel]);
    const group = groups.get(key) ?? {
      taskClass: assignment.taskClass, selectedModel: assignment.selectedModel,
      assignments: 0, completed: 0, censored: 0, unavailable: 0, repairRunsObserved: 0,
      latency: { observed: 0, totalMs: 0, meanMs: null },
      cost: { apiUsd: 0, subscriptionNotionalUsd: 0, observed: 0, missing: 0, noAttempt: 0 },
    };
    group.assignments += 1;
    if (!assignment.attempted) group.cost.noAttempt += 1;
    else if (assignment.costUsd === null || assignment.billingMode === null) group.cost.missing += 1;
    else {
      group.cost.observed += 1;
      if (assignment.billingMode === "api") group.cost.apiUsd += assignment.costUsd;
      else group.cost.subscriptionNotionalUsd += assignment.costUsd;
    }
    let disposition: "completed" | "censored" | "unavailable" = "unavailable";
    let reason = "";
    const files = assignment.taskId ? byTask.get(assignment.taskId) ?? [] : [];
    if (!assignment.taskId || !assignment.runId) reason = "pre-instrumentation-keys-missing";
    else if (files.length === 0) reason = "case-file-missing";
    else if (files.length !== 1) reason = "case-file-conflict";
    else {
      const file = files[0];
      const age = Date.parse(cutoff) - Date.parse(file.asOf);
      if (!timestamp(file.asOf) || age < 0 || age > 15 * 60_000) reason = "case-file-stale";
      else if (file.ledger?.state !== "observed") reason = "case-file-ledger-unavailable";
      else {
        const run = file.runs?.find((entry) => entry.runId === assignment.runId);
        const pr = file.pr?.state === "observed" ? file.pr.value : null;
        const merged = file.mergedSource?.state === "observed" ? file.mergedSource.value : null;
        if (!run) reason = "run-not-in-case-file";
        else if (!runWroteAssignment(run, assignment.assignmentId)) reason = "assignment-run-mismatch";
        else if (!pr) reason = "current-pr-unavailable";
        else if (run.prNumber !== pr.number) reason = "run-pr-mismatch";
        else if (pr.state === "OPEN") { disposition = "censored"; reason = "open-at-cutoff"; }
        else if (pr.state === "CLOSED") reason = "closed-unmerged-unadjudicated";
        else if (!pr.taskCredit || !merged || merged.prNumber !== pr.number) reason = "merge-credit-unavailable";
        else if ([file.review, file.acceptance, file.ci].some((check) => check?.state !== "observed"
          || check.value.headSha !== pr.headSha || check.value.status !== "success")) {
          reason = "head-gates-unverified";
        } else if (!timestamp(merged.mergedAt)
          || merged.mergedAt > cutoff) reason = "merge-after-cutoff-or-invalid";
        else {
          disposition = "completed";
          const samePrRuns = file.runs.filter((entry) => entry.prNumber === pr.number
            && entry.startedAt && entry.startedAt <= merged.mergedAt);
          if (samePrRuns.findIndex((entry) => entry.runId === assignment.runId) > 0) group.repairRunsObserved += 1;
          if (timestamp(assignment.assignedAt)) {
            const latency = Date.parse(merged.mergedAt) - Date.parse(assignment.assignedAt);
            if (latency >= 0) { group.latency.observed += 1; group.latency.totalMs += latency; }
          }
        }
      }
    }
    if (disposition === "completed") { completed += 1; group.completed += 1; }
    else if (disposition === "censored") { censored += 1; group.censored += 1; }
    else { unavailable += 1; group.unavailable += 1; reasons[reason] = (reasons[reason] ?? 0) + 1; }
    groups.set(key, group);
  }
  const values = [...groups.values()].sort((a, b) => JSON.stringify([a.taskClass, a.selectedModel])
    .localeCompare(JSON.stringify([b.taskClass, b.selectedModel])));
  for (const group of values) group.latency.meanMs = group.latency.observed
    ? group.latency.totalMs / group.latency.observed : null;
  return { state: completed + censored === 0 ? "unavailable" : unavailable ? "observed-partial" : "observed",
    source: "task-case-file-v1", asOf: cutoff, cutoff,
    coverage: { assignments: assignments.length, completed, censored, unavailable, reasons },
    groups: values, experimentEffect: "unavailable-no-randomized-allocation" };
}
