// test/a-prless-run-beside-a-later-pr-is-an-ending.test.ts — W1-T4652: a run that opened no PR and ended
// (no_pr, failed, blocked_*) is an observed ending even when ANOTHER run's PR is the task's current PR; only
// a run that opened a DIFFERENT PR is a mismatch. Timestamps compare only against the injected asOf/cutoff.
import assert from "node:assert/strict";
import { test } from "node:test";
import { joinVerifiedTaskOutcomes, type VerifiedAssignment } from "../src/lib/benchmark-verified-outcome.js";
import type { Task } from "../src/lib/plan.js";
import type { StatusProjection } from "../src/lib/status.js";
import { buildTaskCaseFile, type CaseLedgerRead, type TaskCaseFile } from "../src/lib/task-case-file.js";

const NOW = "2026-09-28T12:10:00.000Z";
type Row = Record<string, unknown>;

const taskOf = (id: string) => ({ id, title: id, repo: "remudero", depends_on: [], type: "implement",
  verify: "auto", risk: "low", status: "queued", attempts: 0 }) as unknown as Task;
const ledger = (rows: Row[]): CaseLedgerRead => ({ state: "observed", rows, asOf: NOW,
  windowStart: "2026-08-29T12:10:00.000Z", forms: { gzip: 1, plain: 1, live: 1 }, unread: [], malformed: 0, truncated: false });

/** An earlier run: start, assignment, optionally the PR it opened, and optionally its verdict. */
function earlierRunRows(taskId: string, verdict: string | null, openedPr: number | null): Row[] {
  const row = (step: string, rest: Row) => ({ ts: "2026-09-28T09:00:00.000Z", task_id: taskId, run_id: `${taskId}-1`, step, ...rest });
  return [row("run.start", {}),
    row("worker.assignment", { worker_assignment: { id: `${taskId}-a1`, selected: { provider: "claude", model: "claude-sonnet-5" } } }),
    ...(openedPr === null ? [] : [row("pr.opened", { pr_url: `https://github.com/craigoley/remudero/pull/${openedPr}` })]),
    ...(verdict === null ? [] : [row("verdict", { selection_assignment_id: `${taskId}-a1`, verdict })])];
}

/** The task's current PR (7002, merged) belongs to a LATER run; the earlier run is the one judged. */
function caseFile(taskId: string, verdict: string | null, openedPr: number | null): TaskCaseFile {
  const file = buildTaskCaseFile({ task: taskOf(taskId),
    projection: { taskId, status: "merged", merged: true, source: "trailer", prNumber: 7002 } as StatusProjection,
    ledger: ledger(earlierRunRows(taskId, verdict, openedPr)),
    prRead: { state: "observed", value: { number: 7002, url: "https://github.com/craigoley/remudero/pull/7002", state: "MERGED",
      headSha: "b".repeat(40), body: `Remudero-Task: ${taskId}`, mergedAt: "2026-09-28T11:00:00.000Z", checks: [], readAt: NOW } },
    asOf: NOW });
  assert.equal(file.pr.state, "observed", "the fixture's current PR is observed");
  return file;
}

const assignmentOf = (taskId: string): VerifiedAssignment => ({ assignmentId: `${taskId}-a1`, taskId, runId: `${taskId}-1`,
  assignedAt: "2026-09-28T09:00:00.000Z", taskClass: "fix", selectedModel: "claude-sonnet-5", servedModel: "claude-sonnet-5",
  billingMode: "subscription", costUsd: 0.5, attempted: true });

const coverageOf = (file: TaskCaseFile) => joinVerifiedTaskOutcomes([assignmentOf(file.taskId)], [file], NOW).coverage;

test("a PR-less run that ended beside a later run's merged PR reads ended-without-completion", () => {
  for (const verdict of ["no_pr", "failed", "blocked_budget", "blocked_transient"]) {
    const coverage = coverageOf(caseFile("FX-T1", verdict, null));
    assert.equal(coverage.endedWithoutCompletion, 1, verdict);
    assert.equal(coverage.completed, 0, `${verdict}: the later run's merge is not this run's completion`);
    assert.equal(coverage.unavailable, 0, `${verdict} is observed, not missing`);
    assert.deepEqual(coverage.reasons, { [`ended-without-pr:${verdict}`]: 1 });
  }
});

test("a run that opened a different PR than the current one still reads run-pr-mismatch", () => {
  const coverage = coverageOf(caseFile("FX-T1", "failed", 7001));
  assert.equal(coverage.endedWithoutCompletion, 0);
  assert.deepEqual(coverage.reasons, { "run-pr-mismatch": 1 });
});

test("a PR-less run with no verdict, an unrecognized one or a non-ending one keeps run-pr-mismatch", () => {
  for (const verdict of [null, "passed", "already_satisfied", "pr_attribution_failed"])
    assert.deepEqual(coverageOf(caseFile("FX-T1", verdict, null)).reasons, { "run-pr-mismatch": 1 }, String(verdict));
});
