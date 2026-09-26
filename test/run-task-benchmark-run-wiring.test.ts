import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { benchmarkRunLedgerLogger } from "../src/run-task.js";

test("run task wires benchmark run receipts at assignment and terminal", () => {
  const source = readFileSync(new URL("../src/run-task.ts", import.meta.url), "utf8");
  assert.match(source, /const log = benchmarkRunLedgerLogger\(\(step, fields\) =>\s*appendLedger\(ledgerPath,/);
  assert.match(source, /onSelectionAssignment: \(assignment\) => \{[\s\S]*?log\("worker\.assignment",/);

  const rows: Array<{ step: string; fields: Record<string, unknown> }> = [];
  const log = benchmarkRunLedgerLogger((step, fields) => rows.push({ step, fields }));
  const assignment = {
    id: "private-assignment", requested: { model: "m-requested", effort: "high" },
    selected: { provider: "codex", model: "m-selected", effort: "medium", accountLabel: "secret" },
  };
  log("run.start", { task_class: "src", risk: "medium" });
  log("worker.assignment", { worker_assignment: assignment });
  log("implement.done", { selection_assignment_id: assignment.id, success: true, total_cost_usd: 3 });
  log("verdict", { selection_assignment_id: "unseen", success: true, total_cost_usd: 4 });
  log("verdict", { selection_assignment_id: assignment.id, success: true, served_model: "m-served",
    tokens: { input: 1, output: 2 }, worker_duration_ms: 11, billing_mode: "api", total_cost_usd: 1.25 });

  const assigned = rows[1]!.fields.benchmark_run as Record<string, unknown>;
  assert.equal(assigned.phase, "assignment");
  assert.deepEqual((assigned.work as Record<string, unknown>).taskClass, { state: "observed", value: "src" });
  assert.equal(rows[2]!.fields.benchmark_run, undefined, "intermediate receipt is not terminal");
  assert.equal(rows[3]!.fields.benchmark_run, undefined, "orphan is not joined to this run's assignment");
  const terminal = rows[4]!.fields.benchmark_run as Record<string, unknown>;
  assert.equal(terminal.phase, "terminal");
  assert.deepEqual((terminal.accounting as Record<string, unknown>).apiCostUsd, { state: "observed", value: 1.25 });
  assert.doesNotMatch(JSON.stringify(rows.map((row) => row.fields.benchmark_run)), /secret|private-assignment/);

  const badAssignment = { id: "bad", requested: { model: "m", effort: "high" },
    get selected(): never { throw new Error("instrumentation field unavailable"); } };
  assert.doesNotThrow(() => log("worker.assignment", { worker_assignment: badAssignment }));
  assert.equal(rows.at(-1)?.fields.benchmark_run_unavailable_reason, "receipt-build-failed");
});
