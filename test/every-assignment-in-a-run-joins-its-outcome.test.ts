import assert from "node:assert/strict";
import { test } from "node:test";
import { joinVerifiedTaskOutcomes, type VerifiedAssignment } from "../src/lib/benchmark-verified-outcome.js";
import { buildTaskCaseFile, type CaseLedgerRead, type CasePrRead, type TaskCaseFile } from "../src/lib/task-case-file.js";
import type { Task } from "../src/lib/plan.js";
import type { StatusProjection } from "../src/lib/status.js";

// W1-T4646: a run-task run writes one `worker.assignment` row per rung (recon, implement, diagnose,
// fix). The case file must remember every one, and every one must join the run's shared outcome.
// Every timestamp below is compared only against the injected `asOf`/cutoff, never a real clock.
const asOf = "2026-09-27T14:00:00.000Z";
const task = { id: "W1-T4646", title: "every assignment joins", repo: "remudero", depends_on: [], type: "implement",
  verify: "auto", risk: "high", status: "queued", attempts: 0 } as Task;
const prUrl = "https://github.com/craigoley/remudero/pull/7600";
const projection = { taskId: task.id, status: "merged", merged: true, source: "trailer",
  prNumber: 7600, prUrl } as StatusProjection;
const sha = "c".repeat(40);
const prRead: CasePrRead = { state: "observed", value: { number: 7600, url: prUrl, state: "MERGED", headSha: sha,
  body: `Remudero-Task: ${task.id}`, mergedAt: "2026-09-27T13:52:00.000Z", readAt: asOf,
  checks: [{ name: "remudero-review", state: "success" }, { name: "acceptance-author-gate", state: "success" },
    { name: "ci-gate", state: "success" }] } };
const runId = `${task.id}-1790514000000`;
const row = (step: string, rest: Record<string, unknown>) => ({ ts: "2026-09-27T13:00:00.000Z", task_id: task.id,
  run_id: runId, step, ...rest });
const ledger = (rows: Record<string, unknown>[]): CaseLedgerRead => ({ state: "observed", rows, asOf,
  windowStart: "2026-08-28T14:00:00.000Z", forms: { gzip: 1, plain: 1, live: 1 }, unread: [], malformed: 0, truncated: false });
const assign = (id: string, model: string) => row("worker.assignment",
  { worker_assignment: { id, selected: { provider: "cash", model } } });
const attempt = (id: string, served: string, cost: number) => row("worker.attempt",
  { selection_assignment_id: id, served_model: served, billing_mode: "api", total_cost_usd: cost });
const verified = (assignmentId: string, taskClass: string, selectedModel: string, costUsd: number): VerifiedAssignment => ({
  assignmentId, taskId: task.id, runId, assignedAt: "2026-09-27T13:00:00.000Z", taskClass, selectedModel,
  servedModel: selectedModel, billingMode: "api", costUsd, attempted: true });
const caseFileOf = (rows: Record<string, unknown>[]): TaskCaseFile =>
  buildTaskCaseFile({ task, projection, ledger: ledger(rows), prRead, asOf });

const reconImplementRows = [
  row("run.start", {}),
  assign("recon-1", "gpt-oss-120b"), attempt("recon-1", "gpt-oss-120b", 0.01),
  assign("impl-1", "claude-opus-5-5"), attempt("impl-1", "claude-opus-5-5", 1.5),
  row("pr.opened", { pr_url: prUrl }),
  row("verdict", { selection_assignment_id: "impl-1", verdict: "passed" }),
];

test("a recon + implement run's case file records both assignments and keeps the last as assignmentId", () => {
  const file = caseFileOf([...reconImplementRows, assign("impl-1", "claude-opus-5-5")]);
  assert.equal(file.runs.length, 1);
  assert.deepEqual(file.runs[0].assignmentIds, ["recon-1", "impl-1"], "every id the run wrote, once each, in ledger order");
  assert.equal(file.runs[0].assignmentId, "impl-1", "the compatibility field still names the last assignment");
});

test("the recon assignment of a merged recon + implement run joins the merged outcome", () => {
  const file = caseFileOf(reconImplementRows);
  const result = joinVerifiedTaskOutcomes([verified("recon-1", "recon", "gpt-oss-120b", 0.01),
    verified("impl-1", "implement", "claude-opus-5-5", 1.5)], [file], "2026-09-27T14:05:00.000Z");
  assert.equal(result.coverage.completed, 2, "both rungs share the run's merged outcome");
  assert.equal(result.coverage.unavailable, 0);
  assert.deepEqual(result.coverage.reasons, {}, "no assignment-run-mismatch for the earlier rung");
  const byClass = new Map(result.groups.map((group) => [group.taskClass, group]));
  assert.equal(byClass.get("recon")?.cost.apiUsd, 0.01, "cost stays with its own assignment");
  assert.equal(byClass.get("implement")?.cost.apiUsd, 1.5);
  assert.equal(byClass.get("recon")?.selectedModel, "gpt-oss-120b", "the selected model stays per assignment");
});

test("an assignment id the run never wrote is still refused as assignment-run-mismatch", () => {
  const file = caseFileOf(reconImplementRows);
  const result = joinVerifiedTaskOutcomes([verified("stranger-9", "implement", "claude-opus-5-5", 1)],
    [file], "2026-09-27T14:05:00.000Z");
  assert.equal(result.coverage.completed, 0);
  assert.deepEqual(result.coverage.reasons, { "assignment-run-mismatch": 1 });
});

test("a single-assignment run is unchanged, and a case file written before assignmentIds still joins its last id", () => {
  const single = caseFileOf([row("run.start", {}), assign("only-1", "gpt-6-luna"), attempt("only-1", "gpt-6-luna", 0.2),
    row("pr.opened", { pr_url: prUrl }), row("verdict", { selection_assignment_id: "only-1", verdict: "passed" })]);
  assert.deepEqual(single.runs[0].assignmentIds, ["only-1"]);
  assert.equal(single.runs[0].assignmentId, "only-1");
  const cutoff = "2026-09-27T14:05:00.000Z";
  const input = [verified("only-1", "implement", "gpt-6-luna", 0.2)];
  const legacy: TaskCaseFile = { ...single, runs: single.runs.map(({ assignmentIds: _dropped, ...rest }) => rest) };
  assert.equal("assignmentIds" in legacy.runs[0], false, "the legacy fixture really lacks the field");
  const now = joinVerifiedTaskOutcomes(input, [single], cutoff);
  assert.equal(now.coverage.completed, 1);
  assert.deepEqual(joinVerifiedTaskOutcomes(input, [legacy], cutoff), now, "identical output with or without the field");
  const legacyRecon = joinVerifiedTaskOutcomes([verified("recon-1", "recon", "gpt-oss-120b", 0.01)],
    [{ ...legacy, runs: [{ ...legacy.runs[0], assignmentId: "impl-1" }] }], cutoff);
  assert.deepEqual(legacyRecon.coverage.reasons, { "assignment-run-mismatch": 1 },
    "without assignmentIds only the recorded id can join; nothing is inferred");
});
