import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { CODEX_WORKER_STDOUT_MAX_BYTES, spawnCodexWorker } from "../src/lib/worker-provider.js";

function worker() {
  const home = mkdtempSync(join(tmpdir(), "rmd-w1t6352-"));
  const stdout = new PassThrough();
  const proc = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout });
  let teardownCalls = 0;
  const run = spawnCodexWorker({
    workerHome: home, cwd: process.cwd(), prompt: "bounded output", tools: ["Read"],
    settingsFile: join(process.cwd(), "settings/worker.json"),
    runId: "W1-T6352-test", taskId: "W1-T6352",
    containment: {
      spawn: () => ({ process: proc as never, pid: 6352 }),
      teardown: () => { teardownCalls++; proc.emit("exit", null); },
    },
  }, { claudeBin: "/unused", root: home, workerProviders: { codexBin: "/bin/sh", codexModel: "gpt-6-luna" } });
  // Attach the rejection handler before the deliberately unhealthy baseline can reject.
  void run.catch(() => undefined);
  stdout.write('{"type":"thread.started","thread_id":"budget-run"}\n{"type":"turn.started"}\n');
  return {
    home, stdout, run, teardowns: () => teardownCalls,
    message: (text: string) => stdout.write(`${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } })}\n`),
    end: (code = 0) => {
      stdout.end('{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":25,"output_tokens":10}}\n');
      proc.emit("exit", code);
    },
  };
}

test("W1-T6352: output past the retention budget is truncated, not fatal", async () => {
  const child = worker();
  try {
    child.message("HEAD\n" + "x".repeat(CODEX_WORKER_STDOUT_MAX_BYTES + 1));
    child.message("REPORT\nCOMMIT_MESSAGE: fix(worker): preserve the result");
    assert.equal(child.teardowns(), 0, "retention pressure must leave the child running");
    child.end();
    const result = await child.run;
    assert.equal(result.text, "REPORT\nCOMMIT_MESSAGE: fix(worker): preserve the result");
    assert.equal(result.sessionId, "budget-run");
    assert.equal(result.isError, false);
    assert.deepEqual(result.exit, { kind: "exit", code: 0 });
    assert.deepEqual(result.tokens, { input: 100, output: 10, cacheRead: 25, cacheCreation: 0 });
    assert.equal(child.teardowns(), 1, "only normal exit cleans up the group");
    assert.ok(result.outputTruncation);
    assert.ok(result.outputTruncation.droppedBytes > 0);
    assert.match(result.blocks.join(""), /HEAD/);
    assert.match(result.blocks.join(""), /truncated.*\d+ bytes/);
    const rows = readFileSync(join(child.home, "state/ledger.ndjson"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const receipt = rows.find((row) => row.step === "worker.output_truncated");
    assert.equal(receipt.run_id, "W1-T6352-test");
    assert.equal(receipt.task_id, "W1-T6352");
    assert.deepEqual(receipt.output_truncation, result.outputTruncation);
  } finally { rmSync(child.home, { recursive: true, force: true }); }
});

test("W1-T6352: retained output never exceeds the budget", async () => {
  const child = worker();
  try {
    for (let i = 0; i < 40; i++) child.message(`message-${i}:` + "🦊".repeat(16_384));
    const final = Buffer.from(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "done 🦊" } }) + "\n");
    for (const byte of final) child.stdout.write(Buffer.from([byte]));
    child.end();
    const result = await child.run;
    assert.equal(result.text, "done 🦊");
    assert.equal(result.isError, false);
    assert.ok(result.outputTruncation);
    const bytes = [...result.blocks, ...result.permissionDenials as string[]].reduce((sum, text) => sum + Buffer.byteLength(text), 0);
    assert.ok(bytes <= CODEX_WORKER_STDOUT_MAX_BYTES);
    assert.equal(result.outputTruncation.limitBytes, CODEX_WORKER_STDOUT_MAX_BYTES);
    assert.ok(result.outputTruncation.retainedBytes <= CODEX_WORKER_STDOUT_MAX_BYTES);
    assert.equal(result.outputTruncation.retainedBytes, bytes);
    assert.ok(result.outputTruncation.droppedBytes > 0);
    assert.ok(!result.blocks.join("").includes("�"), "byte cuts preserve Unicode boundaries");
  } finally { rmSync(child.home, { recursive: true, force: true }); }
});

test("W1-T6352: an oversized fragmented result preserves its head and tail", async () => {
  const child = worker();
  try {
    const line = JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "HEAD" + "x".repeat(CODEX_WORKER_STDOUT_MAX_BYTES + 1) + "TAIL" } });
    for (let offset = 0; offset < line.length; offset += 8192) child.stdout.write(line.slice(offset, offset + 8192));
    child.stdout.write("\n");
    child.end();
    const result = await child.run;
    assert.equal(result.isError, false);
    assert.match(result.text, /^HEAD/);
    assert.match(result.text, /TAIL$/);
    assert.match(result.text, /truncated.*\d+ bytes/);
    assert.ok(Buffer.byteLength(result.blocks.join("")) <= CODEX_WORKER_STDOUT_MAX_BYTES);
  } finally { rmSync(child.home, { recursive: true, force: true }); }
});

test("W1-T6352: truncation preserves worker errors and nonzero exits", async () => {
  for (const code of [0, 7]) {
    const child = worker();
    try {
      child.message("x".repeat(CODEX_WORKER_STDOUT_MAX_BYTES + 1));
      if (code === 0) child.stdout.write('{"type":"turn.failed","error":{"message":"network failure"}}\n');
      child.end(code);
      const result = await child.run;
      assert.equal(result.isError, true);
      assert.equal(result.subtype, code === 0 ? "error_codex" : "error_exit_7");
      assert.ok(result.outputTruncation);
    } finally { rmSync(child.home, { recursive: true, force: true }); }
  }
});

test("W1-T6352: oversized malformed output without a result fails", async () => {
  const child = worker();
  try {
    child.stdout.write("x".repeat(CODEX_WORKER_STDOUT_MAX_BYTES + 1));
    child.end();
    const result = await child.run;
    assert.equal(result.isError, true);
    assert.equal(result.text, "");
  } finally { rmSync(child.home, { recursive: true, force: true }); }
});

test("W1-T6352: repeated errors remain bounded and keep their failure classification", async () => {
  const child = worker();
  try {
    for (let i = 0; i < 20; i++) child.stdout.write(JSON.stringify({ type: "error", error: { message: "network permission denied: " + "🦊".repeat(16_384) } }) + "\n");
    child.message("done");
    child.end();
    const result = await child.run;
    assert.equal(result.isError, true);
    assert.equal(result.apiError, true);
    assert.ok(result.permissionDenials.length > 0);
    assert.ok(result.outputTruncation);
    assert.ok(result.outputTruncation.retainedBytes <= CODEX_WORKER_STDOUT_MAX_BYTES);
    assert.equal(result.text, "done");
  } finally { rmSync(child.home, { recursive: true, force: true }); }
});

test("W1-T6352: output within budget keeps the ordinary envelope", async () => {
  const child = worker();
  try {
    child.message("done");
    child.end();
    const result = await child.run;
    assert.deepEqual(result.blocks, ["done"]);
    assert.equal(result.isError, false);
    assert.equal(result.outputTruncation, undefined);
  } finally { rmSync(child.home, { recursive: true, force: true }); }
});
