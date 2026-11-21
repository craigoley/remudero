import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createWorkerToolLineage, observeWorkerToolLineage, type WorkerToolReceipt, WORKER_TOOL_LINEAGE_MAX_CALLS } from "#src/lib/worker-tool-lineage.js";

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

test("tool error episode shadow stays bounded private and cannot stop or retry a worker", t => {
  const root = mkdtempSync(join(tmpdir(), "rmd-tool-shadow-privacy-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const secret = "sentinel credential /private/tool-argument";
  const capped = createWorkerToolLineage({ provider: "claude", runId: secret, taskId: secret, root });
  for (let index = 0; index <= WORKER_TOOL_LINEAGE_MAX_CALLS; index++) {
    const id = `${secret}-${index}`;
    capped.observe({ type: "assistant", message: { id: secret, content: [{
      type: "tool_use", id, name: secret, input: { path: secret },
    }] } });
    capped.observe({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: secret, is_error: true }] } });
  }
  capped.finish("stream-ended");
  capped.finish("interrupted");
  const ledger = join(root, "state", "ledger.ndjson");
  const text = readFileSync(ledger, "utf8");
  const shadows = text.trim().split("\n").map(line => JSON.parse(line)).filter(row => row.step === "worker.tool_lineage_shadow");
  assert.equal(shadows.length, 1);
  assert.ok(!text.includes(secret));
  const shadow = shadows[0].tool_lineage_shadow;
  assert.ok(JSON.stringify(shadow).length < 1000);
  assert.match(shadow.runId, /^[a-f0-9]{64}$/);
  assert.match(shadows[0].task_id, /^[a-f0-9]{64}$/);
  assert.equal(shadow.window, "stream");
  assert.equal(shadow.completeness, "incomplete");
  assert.equal(shadow.excluded.capacityExceeded, 1);
  assert.deepEqual(shadow.tools, [{
    tool: "other", eligibleResults: WORKER_TOOL_LINEAGE_MAX_CALLS, successes: 0,
    errorEpisodes: [{ length: WORKER_TOOL_LINEAGE_MAX_CALLS, count: 1 }],
  }]);

  const blockedRoot = join(root, "blocked");
  mkdirSync(blockedRoot);
  const state = join(blockedRoot, "state");
  writeFileSync(state, secret);
  const blocked = createWorkerToolLineage({ provider: "cash-chat", runId: "r", root: blockedRoot });
  blocked.observe({ type: "tool_use", id: "a", turnId: "t", name: "read_file" });
  assert.equal(blocked.delivery.state, "failed");
  rmSync(state);
  blocked.observe({ type: "tool_result", tool_use_id: "a", turnId: "t", is_error: false });
  blocked.finish("stream-ended");
  const recovered = readFileSync(join(state, "ledger.ndjson"), "utf8");
  const recoveredRows = recovered.trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(recoveredRows.map(row => row.step), ["worker.tool_lineage", "worker.tool_lineage_shadow"]);
  assert.equal(recoveredRows[1].tool_lineage_shadow.completeness, "incomplete");
  assert.equal(recoveredRows[1].tool_lineage_shadow.deliveryFailure, "sink-threw");
  assert.equal(blocked.delivery.state, "failed");
  assert.ok(!recovered.includes(secret));

  const malformed = createWorkerToolLineage({ provider: "claude", runId: "r", root: blockedRoot });
  malformed.observe({ get type() { throw new TypeError(secret); } });
  malformed.finish("stream-ended");
  const failedNormalization = readFileSync(join(state, "ledger.ndjson"), "utf8").trim().split("\n").at(-1)!;
  assert.ok(!failedNormalization.includes(secret));
  assert.equal(JSON.parse(failedNormalization).tool_lineage_shadow.deliveryFailure, "normalization-threw");
});
