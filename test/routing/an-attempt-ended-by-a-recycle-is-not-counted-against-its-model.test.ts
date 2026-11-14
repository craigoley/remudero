import assert from "node:assert/strict";
import test from "node:test";
import { attributeAttemptOutcome } from "#src/lib/attempt-outcome-attribution.js";
import { evaluateRoutingExperiment, ROUTING_EXPERIMENTS, routingAbCommand } from "#src/lib/routing-experiments.js";
import { fixArmEvidence } from "#src/lib/fix-routing-learner.js";

const epoch = { ...ROUTING_EXPERIMENTS[0]!, minTasksPerArm: 1 };
const today = "2026-11-10";
const ts = `${today}T12:00:00Z`;
const now = Date.parse(ts);
type Row = Record<string, unknown>;

function assignment(id: string, task: string, provider = "codex"): Row {
  return { step: "worker.assignment", ts, task_id: task, worker_assignment: {
    id, selected: { provider }, routing: { decision: { ab: epoch.id,
      considered: [{ provider: "claude", model: "claude-sonnet-5" }] } },
  } };
}

function attempt(id: string, extra: Row = {}): Row {
  return { step: "worker.attempt", ts, selection_assignment_id: id, success: false,
    worker_failure: "orphaned-by-process-exit", worker_duration_ms: 60_000_000,
    tokens: { input: 99_999 }, billing_mode: "api", total_cost_usd: 999, ...extra };
}

function done(id: string, extra: Row = {}): Row {
  return { step: "fix.done", ts, selection_assignment_id: id, task_id: "W1-T1",
    provider: "codex", selected_model: "gpt-6-sol", subtype: "commit_refused", ...extra };
}

function report(rows: Row[]) {
  return evaluateRoutingExperiment(rows, epoch, today, attributeAttemptOutcome);
}

test("W1-T12149 criterion 1: infrastructure attempts are separate from both arms' cost means", async () => {
  const rows = [
    assignment("c1", "T1"), attempt("c1"), assignment("c2", "T1"),
    attempt("c2", { success: true, worker_duration_ms: 120_000, tokens: { output: 10 }, total_cost_usd: 2 }),
    assignment("s1", "T2", "claude"), attempt("s1", { billing_mode: "subscription", notional_cost_usd: 999 }),
    assignment("s2", "T2", "claude"), attempt("s2", { success: true, billing_mode: "subscription",
      notional_cost_usd: 4, worker_duration_ms: 240_000, tokens: { input: 20 } }),
    { step: "verdict", selection_assignment_id: "c1", success: true },
  ];
  const classified: Readonly<Row>[] = [];
  const result = evaluateRoutingExperiment(rows, epoch, today, row => {
    classified.push(row);
    return attributeAttemptOutcome(row);
  });
  assert.deepEqual(classified, rows.filter(row => row.step === "worker.attempt"));
  for (const arm of result.arms) {
    assert.equal(arm.infrastructureAttempts, 1);
    assert.equal(arm.infrastructureOnlyTasks, 0);
    assert.equal(arm.tasks, 1);
    assert.equal(arm.medianWorkerMinutes, arm.provider === "codex" ? 2 : 4);
    assert.equal(arm.meanTokens, arm.provider === "codex" ? 10 : 20);
    assert.equal(arm.meanCashCostUsd, arm.provider === "codex" ? 2 : null);
    assert.equal(arm.meanNotionalCostUsd, arm.provider === "codex" ? null : 4);
    assert.equal(arm.receiptCoverage.assignments, 2);
  }
  const output: string[] = [];
  await routingAbCommand(["--json"], { classifyAttempt: attributeAttemptOutcome, readRows: async () => rows, stateDir: "/unused", today, print: line => output.push(line) });
  assert.equal(JSON.parse(output[0]!).reports[0].arms[1].infrastructureAttempts, 1);
});

test("W1-T12149 criterion 2: infrastructure-only tasks leave the merge-rate denominator", () => {
  const rows = [assignment("orphan", "T1"), attempt("orphan"),
    { step: "verdict.merged", task_id: "T1", ts }, assignment("pending", "T2"),
    assignment("failed", "T3"), attempt("failed", { worker_failure: undefined, served_model: "gpt-6-sol" })];
  const arm = report(rows).arms[1]!;
  assert.equal(arm.infrastructureOnlyTasks, 1);
  assert.equal(arm.infrastructureAttempts, 1);
  assert.equal(arm.tasks, 2, "pending assignments remain visible");
  assert.equal(arm.merged, 0);
  assert.equal(arm.mergeRate, 0);
  const only = report(rows.slice(0, 3)).arms[1]!;
  assert.equal(only.infrastructureOnlyTasks, 1);
  assert.equal(only.tasks, 0);
  assert.equal(only.mergeRate, null);
  assert.equal(only.meanTokens, null);
  assert.equal(only.meanCashCostUsd, null);
});

test("W1-T12149 criterion 3: orphaned fix receipts join by assignment and teach nothing", () => {
  const control = [done("kept", { pushed_head_sha: "head", subtype: "success" })];
  const rows = [...control, done("orphan"), done("signal", { worker_exit: "signal" }),
    attempt("orphan"), attempt("unrelated"),
    { ...attempt("kept"), step: "verdict" }];
  for (const ordered of [rows, [...rows].reverse()]) {
    const evidence = fixArmEvidence(ordered, now);
    assert.deepEqual(evidence.arms, fixArmEvidence(control, now).arms);
    assert.equal(evidence.infrastructureExcluded, 1);
    assert.equal(evidence.signalExcluded, 1);
  }
});

test("W1-T12149 criterion 4: provider-reply failures still count against the model", () => {
  const rows = [assignment("reply", "T1"), attempt("reply", {
    worker_failure: "draft-contract", served_model: "gpt-6-sol", tokens: { output: 8 }, total_cost_usd: 3,
  }), assignment("orphan", "T2"), attempt("orphan")];
  const arm = report(rows).arms[1]!;
  assert.equal(arm.infrastructureAttempts, 1);
  assert.equal(arm.infrastructureOnlyTasks, 1);
  assert.equal(arm.tasks, 1);
  assert.equal(arm.mergeRate, 0);
  assert.equal(arm.meanCashCostUsd, 3);
  assert.equal(arm.meanTokens, 8);
  const evidence = fixArmEvidence([done("reply"), rows[1]!, done("orphan"), rows[3]!], now);
  assert.equal(evidence.infrastructureExcluded, 1);
  assert.equal(evidence.arms[0]!.rounds, 1);
  assert.equal(evidence.arms[0]!.refusedWeight, 1);
});
