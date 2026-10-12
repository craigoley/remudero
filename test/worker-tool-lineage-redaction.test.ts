import assert from "node:assert/strict";
import test from "node:test";
import { createWorkerToolLineage, observeWorkerToolLineage, type WorkerToolReceipt, WORKER_TOOL_LINEAGE_MAX_CALLS } from "../src/lib/worker-tool-lineage.js";

test("test/worker-tool-lineage-redaction.test.ts identifiers are encoded and only bounded metadata reaches the sink", () => {
  const rows: WorkerToolReceipt[] = [];
  const secret = "credential /private/filename echo secret";
  const observer = createWorkerToolLineage({ provider: "claude", runId: secret, taskId: secret, sink: r => rows.push(r) });
  observeWorkerToolLineage(observer, { type: "assistant", message: { id: secret, content: [{
    type: "tool_use", id: secret, name: secret, input: { command: secret, path: secret }, text: secret,
  }] } });
  observeWorkerToolLineage(observer, { type: "user", message: { content: [{ type: "tool_result", tool_use_id: secret, content: secret }] } });
  assert.equal(rows[1].state, "joined");
  assert.equal(rows[0].tool, "other");
  assert.ok(rows.every(r => JSON.stringify(r).length < 1000));
  assert.ok(!JSON.stringify(rows).includes(secret));
  assert.match(rows[1].callId!, /^[a-f0-9]{64}$/);
  assert.match(rows[1].turnId!, /^[a-f0-9]{64}$/);
  observeWorkerToolLineage(observer, { type: "assistant", message: { id: "t", content: [{ type: "tool_use", id: "x".repeat(4097), name: "Read" }] } });
  assert.equal(rows.at(-1)?.reason, "missing-call-id");
});

test("test/worker-tool-lineage-redaction.test.ts capacity exhaustion reports unknown without evicting joins", () => {
  const rows: WorkerToolReceipt[] = [];
  const observer = createWorkerToolLineage({ provider: "cash-chat", runId: "r", sink: r => rows.push(r) });
  for (let i = 0; i <= WORKER_TOOL_LINEAGE_MAX_CALLS; i++) {
    observeWorkerToolLineage(observer, { type: "tool_use", id: "reused-id", turnId: String(i), name: "read_file" });
  }
  assert.equal(rows.at(-1)?.reason, "capacity-exceeded");
  observeWorkerToolLineage(observer, { type: "tool_result", tool_use_id: "reused-id", turnId: "0", is_error: false });
  assert.equal(rows.at(-1)?.state, "joined");
  assert.equal(rows.at(-1)?.callId, rows[0].callId);
});
