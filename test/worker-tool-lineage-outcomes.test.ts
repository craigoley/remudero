import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createWorkerToolLineage, observeWorkerToolLineage, type WorkerToolReceipt } from "#src/lib/worker-tool-lineage.js";

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

function readShadow(root: string) {
  const lines = readFileSync(join(root, "state", "ledger.ndjson"), "utf8").trim().split("\n");
  const row = JSON.parse(lines.at(-1)!);
  assert.equal(row.step, "worker.tool_lineage_shadow");
  return row.tool_lineage_shadow;
}

test("tool error episode shadow counts exclusions without inflating the streak", t => {
  const root = mkdtempSync(join(tmpdir(), "rmd-tool-exclusions-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const observer = createWorkerToolLineage({ provider: "cash-chat", runId: "run", root });
  const use = (id: string, name = "read_file") => observer.observe({ type: "tool_use", id, turnId: "turn", name });
  const error = (id: string) => observer.observe({ type: "tool_result", tool_use_id: id, turnId: "turn", is_error: true });
  use("first"); error("first");
  use("first"); error("first");
  use("second"); error("second");
  error("orphan");
  use("third"); error("third");
  use("late-conflict"); error("late-conflict");
  use("fourth"); error("fourth");
  use("late-conflict", "write_file"); error("late-conflict");
  observer.observe(null);
  use("missing-result");
  observer.finish("stream-ended");

  const shadow = readShadow(root);
  assert.equal(shadow.completeness, "incomplete");
  assert.deepEqual(shadow.excluded, {
    unknown: 0, duplicateUse: 1, duplicateResult: 1, orphan: 1, interrupted: 0,
    unfinished: 1, ambiguous: 3, unsupported: 1, capacityExceeded: 0,
  });
  assert.deepEqual(shadow.tools, [{
    tool: "read_file", eligibleResults: 4, successes: 0, errorEpisodes: [{ length: 1, count: 4 }],
  }]);
});

test("tool error episode shadow preserves healthy repeated checks", t => {
  const root = mkdtempSync(join(tmpdir(), "rmd-tool-successes-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const observer = createWorkerToolLineage({ provider: "codex", runId: "run", root });
  observer.observe({ type: "turn.started" });
  for (let index = 0; index < 5; index++) {
    const item = { id: String(index), type: "command_execution", command: "npm run typecheck" };
    observer.observe({ type: "item.started", item });
    observer.observe({ type: "item.completed", item: { ...item, status: "completed", exit_code: 0 } });
  }
  observer.observe({ type: "turn.completed" });
  observer.finish("stream-ended");
  const shadow = readShadow(root);
  assert.equal(shadow.completeness, "complete");
  assert.deepEqual(shadow.tools, [{ tool: "command_execution", eligibleResults: 5, successes: 5, errorEpisodes: [] }]);
});

test("tool error episode shadow excludes Codex results received outside a known turn", t => {
  const root = mkdtempSync(join(tmpdir(), "rmd-tool-codex-turn-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const observer = createWorkerToolLineage({ provider: "codex", runId: "run", root });
  observer.observe({ type: "turn.started" });
  const item = { id: "call", type: "command_execution" };
  observer.observe({ type: "item.started", item });
  observer.observe({ type: "turn.completed" });
  observer.observe({ type: "item.completed", item: { ...item, status: "failed" } });
  observer.finish("stream-ended");
  assert.equal(readShadow(root).excluded.unknown, 1);
  assert.deepEqual(readShadow(root).tools, []);
});

test("tool error episode shadow marks unsupported and unattributed empty streams incomplete", t => {
  const root = mkdtempSync(join(tmpdir(), "rmd-tool-empty-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const options of [{ provider: "future-adapter", runId: "run" }, { provider: "claude" }]) {
    const observer = createWorkerToolLineage({ ...options, root });
    observer.finish("stream-ended");
    const shadow = readShadow(root);
    assert.equal(shadow.completeness, "incomplete");
    assert.deepEqual(shadow.tools, []);
  }
});
