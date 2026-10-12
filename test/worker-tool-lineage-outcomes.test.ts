import assert from "node:assert/strict";
import test from "node:test";
import { createWorkerToolLineage, observeWorkerToolLineage, type WorkerToolReceipt } from "../src/lib/worker-tool-lineage.js";

test("test/worker-tool-lineage-outcomes.test.ts observations never claim admission or verified completion and duplicates are distinct", () => {
  const rows: WorkerToolReceipt[] = [];
  const observer = createWorkerToolLineage({ provider: "claude", runId: "r", sink: r => rows.push(r) });
  const use = { type: "assistant", message: { id: "t", content: [{ type: "tool_use", id: "a", name: "Bash" }] } };
  const result = { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "a" }] } };
  observeWorkerToolLineage(observer, use);
  observeWorkerToolLineage(observer, use);
  observeWorkerToolLineage(observer, result);
  observeWorkerToolLineage(observer, result);
  observer.finish("stream-ended");
  assert.deepEqual(rows.map(r => r.state), ["attempt", "duplicate", "joined", "duplicate"]);
  assert.deepEqual(rows.map(r => r.result), ["unknown", "unknown", "success", "unknown"]);
  assert.ok(rows.every(r => r.admission === "unknown" && r.taskOutcome === "unknown"));
  assert.equal(rows.filter(r => r.result === "success").length, 1);
});

test("test/worker-tool-lineage-outcomes.test.ts provider errors and malformed outcome flags cannot become success", () => {
  const rows: WorkerToolReceipt[] = [];
  const observer = createWorkerToolLineage({ provider: "claude", runId: "r", sink: r => rows.push(r) });
  for (const [id, is_error] of [["error", true], ["malformed", "false"]]) {
    observeWorkerToolLineage(observer, { type: "assistant", message: { id: "t", content: [{ type: "tool_use", id, name: "Read" }] } });
    observeWorkerToolLineage(observer, { type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, is_error }] } });
  }
  assert.equal(rows[1].result, "error");
  assert.equal(rows[3].result, "unknown");
  assert.equal(rows[3].reason, "malformed-outcome");
});

test("test/worker-tool-lineage-outcomes.test.ts codex reports executor failure separately from unknown status", () => {
  for (const [metadata, expected] of [
    [{ status: "completed", exit_code: 2 }, "error"],
    [{ status: "failed" }, "error"],
    [{ status: "completed", exit_code: 0 }, "success"],
    [{ status: "completed" }, "unknown"],
    [{ status: "in_progress", exit_code: 0 }, "unknown"],
  ] as const) {
    const rows: WorkerToolReceipt[] = [];
    const observer = createWorkerToolLineage({ provider: "codex", runId: "r", sink: r => rows.push(r) });
    observeWorkerToolLineage(observer, { type: "turn.started" });
    observeWorkerToolLineage(observer, { type: "item.started", item: { id: "a", type: "command_execution" } });
    observeWorkerToolLineage(observer, { type: "item.completed", item: { id: "a", type: "command_execution", ...metadata } });
    assert.equal(rows[1].result, expected);
    assert.equal(rows[1].admission, "unknown");
    assert.equal(rows[1].taskOutcome, "unknown");
  }
});

test("test/worker-tool-lineage-outcomes.test.ts a contradictory tool identity prevents a success claim", () => {
  const rows: WorkerToolReceipt[] = [];
  const observer = createWorkerToolLineage({ provider: "cash-chat", runId: "r", sink: r => rows.push(r) });
  for (const name of ["read_file", "write_file"]) {
    observeWorkerToolLineage(observer, { type: "tool_use", turnId: "t", id: "a", name });
  }
  observeWorkerToolLineage(observer, { type: "tool_result", turnId: "t", tool_use_id: "a", is_error: false });
  assert.equal(rows[1].reason, "ambiguous-call-id");
  assert.equal(rows[2].reason, "ambiguous-call-id");
  assert.equal(rows[2].result, "unknown");
});
