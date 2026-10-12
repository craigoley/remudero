import assert from "node:assert/strict";
import test from "node:test";
import { createWorkerToolLineage, observeWorkerToolLineage, type WorkerToolReceipt } from "../src/lib/worker-tool-lineage.js";

test("test/worker-tool-lineage-unknown.test.ts missing IDs, malformed evidence and unsupported adapters are named", () => {
  const rows: WorkerToolReceipt[] = [];
  const observer = createWorkerToolLineage({ provider: "claude", runId: "r", sink: r => rows.push(r) });
  observeWorkerToolLineage(observer, { type: "assistant", message: { id: "t", content: [{ type: "tool_use", name: "Bash" }] } });
  observeWorkerToolLineage(observer, { type: "assistant", message: { content: [{ type: "tool_use", id: "a", name: "Read" }] } });
  observeWorkerToolLineage(observer, { type: "user", message: { content: [{ type: "tool_result" }] } });
  observeWorkerToolLineage(observer, { type: "assistant", message: { content: {} } });
  observeWorkerToolLineage(observer, null);
  assert.deepEqual(rows.map(r => r.reason), ["missing-call-id", "missing-turn-id", "missing-call-id", "malformed-payload", "malformed-payload"]);
  assert.ok(rows.every(r => r.result === "unknown"));
  const unsupported = createWorkerToolLineage({ provider: "future-adapter", runId: "r", sink: r => rows.push(r) });
  observeWorkerToolLineage(unsupported, { type: "tool_use", id: "a" });
  assert.equal(rows.at(-1)?.state, "unsupported");
  assert.equal(rows.at(-1)?.provider, "unsupported");
  assert.equal(rows.at(-1)?.reason, "unsupported-adapter");
});

test("test/worker-tool-lineage-unknown.test.ts orphans stay orphaned and unfinished calls survive interruption", () => {
  const rows: WorkerToolReceipt[] = [];
  const observer = createWorkerToolLineage({ provider: "claude", runId: "r", sink: r => rows.push(r) });
  const result = { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "a" }] } };
  observeWorkerToolLineage(observer, result);
  observeWorkerToolLineage(observer, { type: "assistant", message: { id: "t", content: [{ type: "tool_use", id: "a", name: "Read" }] } });
  observer.finish("interrupted");
  observer.finish("stream-ended");
  assert.deepEqual(rows.map(r => r.state), ["orphan-result", "attempt", "unfinished"]);
  assert.equal(rows[0].runId, null);
  assert.equal(rows[0].turnId, null);
  assert.equal(rows[2].reason, "interrupted");
  assert.equal(rows[2].result, "unknown");
});

test("test/worker-tool-lineage-unknown.test.ts codex needs a turn start and results never borrow a foreign turn", () => {
  const rows: WorkerToolReceipt[] = [];
  const codex = createWorkerToolLineage({ provider: "codex", runId: "r", sink: r => rows.push(r) });
  observeWorkerToolLineage(codex, { type: "item.started", item: { id: "a", type: "command_execution" } });
  assert.equal(rows[0].reason, "missing-turn-id");
  const cash = createWorkerToolLineage({ provider: "cash-chat", runId: "r", sink: r => rows.push(r) });
  observeWorkerToolLineage(cash, { type: "tool_use", id: "a", name: "read_file", turnId: "one" });
  observeWorkerToolLineage(cash, { type: "tool_result", tool_use_id: "a", turnId: "two" });
  assert.equal(rows.at(-1)?.state, "orphan-result");
  cash.finish("stream-ended");
  assert.equal(rows.at(-1)?.state, "unfinished");
});

test("test/worker-tool-lineage-unknown.test.ts no run identity means unsupported and malformed access stays unknown", () => {
  const rows: WorkerToolReceipt[] = [];
  const missingRun = createWorkerToolLineage({ provider: "claude", sink: r => rows.push(r) });
  observeWorkerToolLineage(missingRun, { type: "assistant", message: { id: "t", content: [{ type: "tool_use", id: "a", name: "Read" }] } });
  assert.equal(rows[0].reason, "missing-run-id");
  assert.equal(rows[0].runId, null);
  const observer = createWorkerToolLineage({ provider: "claude", runId: "r", sink: r => rows.push(r) });
  observeWorkerToolLineage(observer, { get type() { throw new Error("private payload error"); } });
  assert.equal(rows[1].reason, "malformed-payload");
  assert.deepEqual(observer.delivery, { state: "failed", reason: "normalization-threw", errorClass: "Error" });
  assert.ok(!JSON.stringify(rows).includes("private payload error"));
});

test("test/worker-tool-lineage-unknown.test.ts malformed blocks and codex items remain unknown without fabricating tools", () => {
  const rows: WorkerToolReceipt[] = [];
  const claude = createWorkerToolLineage({ provider: "claude", runId: "r", sink: r => rows.push(r) });
  observeWorkerToolLineage(claude, { type: "user", message: { content: "ordinary prompt" } });
  observeWorkerToolLineage(claude, { type: "assistant", message: { id: "t", content: [null, { type: "text", text: "private text" }] } });
  const codex = createWorkerToolLineage({ provider: "codex", runId: "r", sink: r => rows.push(r) });
  observeWorkerToolLineage(codex, { type: "item.completed" });
  observeWorkerToolLineage(codex, { type: "item.completed", item: { type: "reasoning", text: "private text" } });
  observeWorkerToolLineage(codex, { type: "turn.failed" });
  assert.equal(rows.length, 2);
  assert.ok(rows.every(r => r.reason === "malformed-payload" && r.result === "unknown"));
  claude.finish("stream-ended");
  observeWorkerToolLineage(claude, null);
  assert.equal(rows.length, 2, "a closed stream cannot append new observations");
});
