// W1-T8203: stderr is diagnostic evidence. Past its retention bound it is truncated (head + tail), never a
// teardown. W1-T10962 preserves the exit and result while denying complete-success credit to a partial report.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { CODEX_WORKER_STDERR_MAX_BYTES, spawnCodexWorker } from "../src/lib/worker-provider.js";

function worker() {
  const home = mkdtempSync(join(tmpdir(), "rmd-w1t8203-"));
  const stdout = new PassThrough();
  const proc = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout });
  let teardownCalls = 0;
  let onStderr: ((chunk: string) => void) | undefined;
  const run = spawnCodexWorker({
    workerHome: home, cwd: process.cwd(), prompt: "bounded stderr", tools: ["Read"],
    settingsFile: join(process.cwd(), "settings/worker.json"),
    runId: "W1-T8203-test", taskId: "W1-T8203",
    containment: {
      spawn: (_options, stderrSink) => { onStderr = stderrSink; return { process: proc as never, pid: 8203 }; },
      teardown: () => { teardownCalls++; proc.emit("exit", null); },
    },
  }, { claudeBin: "/unused", root: home, workerProviders: { codexBin: "/bin/sh", codexModel: "gpt-6-luna" } });
  void run.catch(() => undefined);
  stdout.write('{"type":"thread.started","thread_id":"stderr-run"}\n{"type":"turn.started"}\n');
  return {
    home, run, teardowns: () => teardownCalls,
    stderr: (text: string) => onStderr?.(text),
    finish: (code = 0) => {
      stdout.write(`${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "REPORT" } })}\n`);
      stdout.end('{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":25,"output_tokens":10}}\n');
      proc.emit("exit", code);
    },
  };
}

/** The 277,986-byte shape of the W1-T7806 failure: over the bound, with a recognisable first and last line. */
function overBound(child: ReturnType<typeof worker>): number {
  const lines = ["FIRST-STDERR-LINE\n"];
  for (let i = 0; i < 4; i++) lines.push(`${"e".repeat(CODEX_WORKER_STDERR_MAX_BYTES / 4)}\n`);
  lines.push("FINAL-STDERR-ERROR: boom\n");
  let total = 0;
  for (const line of lines) { child.stderr(line); total += Buffer.byteLength(line); }
  return total;
}

test("W1-T8203: stderr over the bound keeps the worker result", async () => {
  const child = worker();
  try {
    const total = overBound(child);
    assert.ok(total > CODEX_WORKER_STDERR_MAX_BYTES);
    child.finish();
    const result = await child.run;
    assert.equal(result.text, "REPORT");
    assert.equal(result.sessionId, "stderr-run");
    assert.equal(result.isError, true);
    assert.equal(result.subtype, "error_incomplete_output");
    assert.equal(result.outputRetention?.stderr.state, "truncated");
    assert.deepEqual(result.exit, { kind: "exit", code: 0 });
    assert.ok(result.stderrTruncation, "the truncation is recorded on the result");
  } finally { rmSync(child.home, { recursive: true, force: true }); }
});

test("W1-T8203: retained stderr keeps head and tail with the dropped count", async () => {
  const child = worker();
  try {
    const total = overBound(child);
    child.finish();
    const result = await child.run;
    assert.match(result.stderr, /^FIRST-STDERR-LINE/);
    assert.match(result.stderr, /FINAL-STDERR-ERROR: boom\n$/);
    const truncation = result.stderrTruncation;
    assert.ok(truncation);
    assert.equal(truncation.limitBytes, CODEX_WORKER_STDERR_MAX_BYTES);
    assert.ok(truncation.retainedBytes <= CODEX_WORKER_STDERR_MAX_BYTES);
    assert.ok(truncation.droppedBytes > 0);
    assert.equal(truncation.retainedBytes + truncation.droppedBytes, total);
    assert.ok(result.stderr.includes(`[... ${truncation.droppedBytes} bytes of stderr dropped ...]`));
  } finally { rmSync(child.home, { recursive: true, force: true }); }
});

test("W1-T8203: the stderr truncation is ledgered", async () => {
  const child = worker();
  try {
    overBound(child);
    child.finish();
    const result = await child.run;
    const rows = readFileSync(join(child.home, "state/ledger.ndjson"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const receipt = rows.find((row) => row.step === "worker.stderr_truncated");
    assert.ok(receipt, "a worker.stderr_truncated row exists");
    assert.equal(receipt.run_id, "W1-T8203-test");
    assert.equal(receipt.task_id, "W1-T8203");
    assert.deepEqual(receipt.stderr_truncation, result.stderrTruncation);
  } finally { rmSync(child.home, { recursive: true, force: true }); }
});

test("W1-T8203: stderr volume never tears the worker down", async () => {
  const child = worker();
  try {
    overBound(child);
    for (let i = 0; i < 64; i++) child.stderr("y".repeat(64 * 1024));
    assert.equal(child.teardowns(), 0, "stderr volume must leave the child running");
    child.finish();
    const result = await child.run;
    assert.equal(child.teardowns(), 1, "only the normal exit cleans up the group");
    assert.equal(result.isError, true);
    assert.equal(result.subtype, "error_incomplete_output");
    assert.equal(result.outputRetention?.stderr.state, "truncated");
    assert.equal(result.text, "REPORT");
    assert.ok(Buffer.byteLength(result.stderr) < 2 * CODEX_WORKER_STDERR_MAX_BYTES);
  } finally { rmSync(child.home, { recursive: true, force: true }); }
});

test("W1-T8203: stderr within the bound is kept whole and unrecorded", async () => {
  const child = worker();
  try {
    child.stderr("small diagnostic\n");
    child.finish();
    const result = await child.run;
    assert.equal(result.stderr, "small diagnostic\n");
    assert.equal(result.stderrTruncation, undefined);
  } finally { rmSync(child.home, { recursive: true, force: true }); }
});
