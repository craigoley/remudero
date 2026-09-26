import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { deriveAnalyticsSnapshot, deriveAnalyticsSnapshotFromCheckpointedLedger } from "../src/lib/analytics-route.js";
import { fixedClock } from "../src/lib/clock.js";

const at = "2026-09-26T19:00:00.000Z";
function assignment(id: string, model: string) {
  return { ts: at, step: "worker.assignment", run_id: "r1", worker_assignment: {
    id, requested: { model, effort: "high" }, selected: { provider: "codex", model, effort: "high" },
    routing: { mode: "multi-provider" },
  } };
}

test("benchmark quality reconciles attempt and legacy verdict receipts", () => {
  const first = { ts: at, step: "worker.attempt", run_id: "r1", selection_assignment_id: "a1",
    success: true, served_model: "m1", tokens: { input: 1, output: 2 }, worker_duration_ms: 10,
    billing_mode: "api", total_cost_usd: 0.25 };
  const second = { ts: at, step: "worker.attempt", run_id: "r1", selection_assignment_id: "a2",
    success: true, served_model: "m2", tokens: { input: 3, output: 4 }, worker_duration_ms: 20,
    billing_mode: "subscription", total_cost_usd: 1.5 };
  const snapshot = deriveAnalyticsSnapshot([
    { ts: at, step: "run.start", run_id: "r1", task_class: "src", risk: "medium" },
    assignment("a1", "m1"), first, first,
    assignment("a2", "m2"), second,
    { ...second, step: "verdict", success: false },
  ], at).benchmarkEvidence;
  assert.equal(snapshot.assignments, 2);
  assert.equal(snapshot.joinedTerminalOutcomes, 2);
  assert.equal(snapshot.assignmentsWithoutTerminal, 0);
  assert.deepEqual(snapshot.outcomes, { success: 2, failure: 0, unavailable: 0 });
  assert.equal(snapshot.accounting.apiRequestCostUsd, 0.25);
  assert.equal(snapshot.accounting.subscriptionNotionalCostUsd, 1.5);
  assert.equal(snapshot.duplicates.terminalRows, 1, "replayed attempt is not a second worker call");

  const legacy = deriveAnalyticsSnapshot([
    assignment("old", "m-old"),
    { ts: at, step: "verdict", selection_assignment_id: "old", success: true,
      served_model: "m-old", billing_mode: "api", total_cost_usd: 0.5 },
  ], at).benchmarkEvidence;
  assert.equal(legacy.joinedTerminalOutcomes, 1);
  assert.equal(legacy.outcomes.success, 1);
  assert.equal(legacy.accounting.apiRequestCostUsd, 0.5);
});

test("benchmark attempt checkpoint replay keeps the worker outcome distinct from a late run verdict", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-attempt-checkpoint-"));
  const live = join(dir, "ledger.ndjson");
  const rows = [assignment("a1", "m1"), { ts: at, step: "worker.attempt", selection_assignment_id: "a1",
    success: true, served_model: "m1", billing_mode: "api", total_cost_usd: 0.25 }];
  try {
    writeFileSync(live, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
    const first = await deriveAnalyticsSnapshotFromCheckpointedLedger(dir, fixedClock(Date.parse(at)));
    appendFileSync(live, `${JSON.stringify({ ts: at, step: "verdict", selection_assignment_id: "a1", success: false })}\n`);
    const resumed = await deriveAnalyticsSnapshotFromCheckpointedLedger(dir, fixedClock(Date.parse(at)), undefined, first.checkpoint);
    assert.equal(resumed.snapshot.benchmarkEvidence.joinedTerminalOutcomes, 1);
    assert.deepEqual(resumed.snapshot.benchmarkEvidence.outcomes, { success: 1, failure: 0, unavailable: 0 });
    const full = await deriveAnalyticsSnapshotFromCheckpointedLedger(dir, fixedClock(Date.parse(at)));
    assert.deepEqual(resumed.snapshot.benchmarkEvidence, full.snapshot.benchmarkEvidence);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
