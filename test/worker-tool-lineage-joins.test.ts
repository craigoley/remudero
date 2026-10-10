import assert from "node:assert/strict";
import test from "node:test";
import { createWorkerToolLineage, observeWorkerToolLineage, type WorkerToolReceipt } from "../src/lib/worker-tool-lineage.js";

test("test/worker-tool-lineage-joins.test.ts real IDs join multiple tools and shared message fragments", () => {
  const receipts: WorkerToolReceipt[] = [];
  const observer = createWorkerToolLineage({ provider: "claude", runId: "run-a", sink: r => receipts.push(r) });
  for (const [id, name] of [["a", "Bash"], ["b", "Read"], ["c", "Bash"]]) {
    observeWorkerToolLineage(observer, { type: "assistant", message: { id: "turn-1", content: [{ type: "tool_use", id, name }] } });
  }
  observeWorkerToolLineage(observer, { type: "user", message: { content: [
    { type: "tool_result", tool_use_id: "c", is_error: true },
    { type: "tool_result", tool_use_id: "a" },
    { type: "tool_result", tool_use_id: "b" },
  ] } });
  const results = receipts.filter(r => r.state === "joined");
  assert.deepEqual(results.map(r => [r.tool, r.result]), [["Bash", "error"], ["Bash", "success"], ["Read", "success"]]);
  assert.equal(results[0].callId, receipts[2].callId);
  assert.equal(results[1].callId, receipts[0].callId);
  assert.equal(results[2].callId, receipts[1].callId);
  assert.equal(new Set(receipts.map(r => r.turnId)).size, 1);
});

test("test/worker-tool-lineage-joins.test.ts calls cannot join across runs or turns", () => {
  const a: WorkerToolReceipt[] = [], b: WorkerToolReceipt[] = [];
  const first = createWorkerToolLineage({ provider: "claude", runId: "first", sink: r => a.push(r) });
  const second = createWorkerToolLineage({ provider: "claude", runId: "second", sink: r => b.push(r) });
  const use = { type: "assistant", message: { id: "turn-a", content: [{ type: "tool_use", id: "same", name: "Read" }] } };
  observeWorkerToolLineage(first, use);
  observeWorkerToolLineage(second, { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "same" }] } });
  assert.equal(b[0].state, "orphan-result");
  assert.equal(b[0].runId, null);
  observeWorkerToolLineage(second, use);
  assert.notEqual(a[0].runId, b[1].runId);
  observeWorkerToolLineage(first, { ...use, message: { ...use.message, id: "turn-b" } });
  observeWorkerToolLineage(first, { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "same" }] } });
  assert.equal(a.at(-1)?.reason, "ambiguous-call-id");
  assert.equal(a.at(-1)?.result, "unknown");
});

test("test/worker-tool-lineage-joins.test.ts codex item IDs and cash call IDs retain observed turn scope", () => {
  for (const provider of ["codex", "cash-chat", "cash-responses", "cash-claude"] as const) {
    const rows: WorkerToolReceipt[] = [];
    const observer = createWorkerToolLineage({ provider, runId: "r", sink: r => rows.push(r) });
    if (provider === "codex") {
      observeWorkerToolLineage(observer, { type: "turn.started" });
      observeWorkerToolLineage(observer, { type: "item.started", item: { id: "item-1", type: "command_execution", status: "in_progress" } });
      observeWorkerToolLineage(observer, { type: "item.completed", item: { id: "item-1", type: "command_execution", status: "completed", exit_code: 0 } });
    } else {
      observeWorkerToolLineage(observer, { type: "tool_use", turnId: "request-1", id: "call-1", name: "read_file" });
      observeWorkerToolLineage(observer, { type: "tool_result", turnId: "request-1", tool_use_id: "call-1", is_error: false });
    }
    assert.equal(rows[1].state, "joined", provider);
    assert.equal(rows[1].result, "success", provider);
    assert.equal(rows[1].callId, rows[0].callId);
    assert.equal(rows[1].turnId, rows[0].turnId);
    assert.equal(rows[1].provider, provider);
  }
});

test("test/worker-tool-lineage-joins.test.ts separate spawns in one run never share pending calls", () => {
  const rows: WorkerToolReceipt[] = [];
  const options = { provider: "claude", runId: "same-run", sink: (r: WorkerToolReceipt) => rows.push(r) };
  const first = createWorkerToolLineage(options), second = createWorkerToolLineage(options);
  observeWorkerToolLineage(first, { type: "assistant", message: { id: "t", content: [{ type: "tool_use", id: "a", name: "Read" }] } });
  observeWorkerToolLineage(second, { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "a" }] } });
  assert.equal(rows[1].state, "orphan-result");
  assert.notEqual(rows[0].streamId, rows[1].streamId);
  first.finish("stream-ended");
  assert.equal(rows[2].state, "unfinished");
});

test("test/worker-tool-lineage-joins.test.ts an ID reused in explicit provider turns joins only that turn", () => {
  const rows: WorkerToolReceipt[] = [];
  const observer = createWorkerToolLineage({ provider: "cash-chat", runId: "r", sink: r => rows.push(r) });
  for (const turnId of ["first", "second"]) {
    observeWorkerToolLineage(observer, { type: "tool_use", id: "same-call", turnId, name: "read_file" });
  }
  for (const turnId of ["second", "first"]) {
    observeWorkerToolLineage(observer, { type: "tool_result", tool_use_id: "same-call", turnId, is_error: false });
  }
  assert.equal(rows[2].state, "joined");
  assert.equal(rows[3].state, "joined");
  assert.equal(rows[2].turnId, rows[1].turnId);
  assert.equal(rows[3].turnId, rows[0].turnId);
  assert.notEqual(rows[2].turnId, rows[3].turnId);
});
