import assert from "node:assert/strict";
import test from "node:test";
import { benchmarkRunAssignmentReceipt, benchmarkRunTerminalReceipt } from "../src/lib/benchmark-run.js";

const assignment = {
  id: "private-assignment-id",
  requested: { model: "requested-model", effort: "high" },
  selected: { provider: "codex", model: "selected-model", effort: "medium", accountLabel: "secret-account" },
};

test("benchmark run assignment records private stack provenance and explicit unavailable revisions", () => {
  const receipt = benchmarkRunAssignmentReceipt(assignment, { taskClass: "src", risk: "high" });
  assert.equal(receipt.version, "benchmark-run-v1");
  assert.equal(receipt.phase, "assignment");
  assert.deepEqual(receipt.work.taskClass, { state: "observed", value: "src" });
  assert.deepEqual(receipt.work.risk, { state: "observed", value: "high" });
  assert.deepEqual(receipt.stack.selectedModel, { state: "observed", value: "selected-model" });
  assert.deepEqual(receipt.stack.harnessRevision, { state: "unavailable", reason: "not-pinned-by-harness" });
  assert.equal(receipt.rights.state, "private");
  assert.equal(receipt.allocation.method, "observational");
  assert.doesNotMatch(JSON.stringify(receipt), /secret-account|private-assignment-id|repository_name|prompt_content/);
  const withoutWork = benchmarkRunAssignmentReceipt(assignment, {});
  assert.deepEqual(withoutWork.work.taskClass, { state: "unavailable", reason: "not-recorded-at-assignment" });
});

test("benchmark run terminal preserves missingness and separate accounting modes", () => {
  const base = { step: "verdict", selection_assignment_id: assignment.id, success: true, served_model: null,
    tokens: { input: 0, output: 0 }, worker_duration_ms: 0, total_cost_usd: 0 };
  const api = benchmarkRunTerminalReceipt({ ...base, billing_mode: "api" }, true);
  assert.equal(api?.workerCall.state, "observed");
  assert.deepEqual(api?.tokens, { state: "observed", value: { input: 0, output: 0 } });
  assert.deepEqual(api?.durationMs, { state: "observed", value: 0 });
  assert.deepEqual(api?.servedModel, { state: "unavailable", reason: "provider-did-not-report-served-model" });
  assert.deepEqual(api?.accounting.apiCostUsd, { state: "observed", value: 0 });
  assert.equal(api?.accounting.subscriptionNotionalUsd.state, "unavailable");
  const subscription = benchmarkRunTerminalReceipt({ ...base, billing_mode: "subscription", total_cost_usd: 2.5 }, true);
  assert.deepEqual(subscription?.accounting.subscriptionNotionalUsd, { state: "observed", value: 2.5 });
  assert.equal(subscription?.accounting.apiCostUsd.state, "unavailable");
  const missing = benchmarkRunTerminalReceipt({ step: "verdict", selection_assignment_id: assignment.id, billing_mode: "api" }, true);
  assert.equal(missing?.workerCall.state, "unavailable");
  assert.equal(missing?.tokens.state, "unavailable");
  assert.equal(missing?.durationMs.state, "unavailable");
  assert.equal(missing?.accounting.apiCostUsd.state, "unavailable");
});

test("benchmark run refuses intermediate and unjoined terminal claims", () => {
  const row = { step: "implement.done", selection_assignment_id: assignment.id, success: true, total_cost_usd: 1 };
  assert.equal(benchmarkRunTerminalReceipt(row, true), undefined);
  assert.equal(benchmarkRunTerminalReceipt({ ...row, step: "verdict" }, false), undefined);
  assert.equal(benchmarkRunTerminalReceipt({ ...row, step: "verdict", selection_assignment_id: "" }, true), undefined);
  const failure = benchmarkRunTerminalReceipt({ ...row, step: "verdict", success: false }, true);
  assert.deepEqual(failure?.workerCall, { state: "failed", value: false });
});
