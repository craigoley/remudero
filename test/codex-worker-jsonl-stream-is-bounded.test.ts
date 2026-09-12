import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import {
  CODEX_JSONL_RECORD_MAX_BYTES,
  CODEX_JSONL_TRANSCRIPT_MAX_BYTES,
  CodexJsonlStreamLimitError,
  CodexJsonlStreamDecoder,
  parseCodexJsonl,
  spawnCodexWorker,
} from "../src/lib/worker-provider.js";
import { isRmdError } from "../src/lib/errors.js";

function jsonl(events: unknown[]): string {
  return `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
}

function splitEvery(buffer: Buffer, sizes: number[]): Buffer[] {
  const chunks: Buffer[] = [];
  let offset = 0;
  let index = 0;
  while (offset < buffer.length) {
    const size = sizes[index % sizes.length]!;
    chunks.push(buffer.subarray(offset, Math.min(offset + size, buffer.length)));
    offset += size;
    index += 1;
  }
  return chunks;
}

function runCodexWorkerWithStdout(chunks: Array<Buffer | string>) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const proc = Object.assign(new EventEmitter(), { stdin, stdout, stderr });
  let teardownCalls = 0;
  stdin.on("finish", () => {
    for (const chunk of chunks) stdout.write(chunk);
    stdout.end();
    queueMicrotask(() => proc.emit("exit", 0));
  });
  const promise = spawnCodexWorker(
    {
      workerHome: mkdtempSync(join(tmpdir(), "rmd-codex-home-")),
      cwd: process.cwd(),
      prompt: "exercise codex jsonl streaming",
      settingsFile: join(process.cwd(), "settings", "worker.json"),
      containment: {
        spawn: () => ({ process: proc as never, pid: 52_850 }),
        teardown: () => {
          teardownCalls += 1;
          queueMicrotask(() => proc.emit("exit", 0));
        },
      },
    },
    { claudeBin: "/unused", root: "/tmp", workerProviders: { enabled: ["codex"], codexBin: "/bin/sh" } },
  );
  return { promise, teardownCalls: () => teardownCalls };
}

test("W1-T3447: a bounded Codex JSONL refusal carries the worker error envelope", () => {
  const error = new CodexJsonlStreamLimitError("codex_jsonl_record_too_large", "fixture overflow");
  assert.ok(isRmdError(error));
  assert.equal(error.kind, "worker");
  assert.equal(error.exitCode, 1);
  assert.deepEqual(error.details, { code: "codex_jsonl_record_too_large" });
});

test("W1-T3447 criterion 1: Codex JSONL split at arbitrary Buffer boundaries matches the complete parser", () => {
  const raw = jsonl([
    { type: "thread.started", thread_id: "thread-split" },
    { type: "turn.started" },
    { type: "item.completed", item: { type: "agent_message", text: "first partial answer" } },
    { type: "turn.completed", usage: { input_tokens: 7, cached_input_tokens: 3, output_tokens: 11 } },
    { type: "turn.started" },
    { type: "item.completed", item: { type: "agent_message", text: "final answer with a unicode seam: café" } },
    { type: "turn.failed", error: { message: "terminal model error" } },
    { type: "turn.completed", usage: { input_tokens: 13, cached_input_tokens: 2, output_tokens: 17 } },
  ]);
  const expected = parseCodexJsonl(raw);
  const streaming = new CodexJsonlStreamDecoder();
  for (const chunk of splitEvery(Buffer.from(raw), [1, 2, 5, 3, 8])) streaming.ingest(chunk);
  const actual = streaming.finish();

  assert.equal(actual.sessionId, expected.sessionId);
  assert.equal(actual.text, expected.text);
  assert.deepEqual(actual.blocks, expected.blocks);
  assert.equal(actual.numTurns, expected.numTurns);
  assert.deepEqual(actual.tokens, expected.tokens);
  assert.equal(actual.isError, expected.isError);
  assert.equal(actual.subtype, expected.subtype);
  assert.deepEqual(actual.errors, expected.errors);
});

test("W1-T3447 criterion 2: a multi-megabyte ignored tool event is released before the terminal worker result", async () => {
  const hugeIgnoredToolOutput = "x".repeat(2 * 1024 * 1024);
  const raw = jsonl([
    { type: "thread.started", thread_id: "thread-large-tool" },
    { type: "turn.started" },
    { type: "item.completed", item: { type: "tool_output", aggregated_output: hugeIgnoredToolOutput } },
    { type: "item.completed", item: { type: "agent_message", text: "finished after the ignored tool event" } },
    { type: "turn.completed", usage: { input_tokens: 101, cached_input_tokens: 33, output_tokens: 21 } },
  ]);
  assert.ok(Buffer.byteLength(raw) < CODEX_JSONL_RECORD_MAX_BYTES, "fixture stays below the fixed record ceiling");

  const decoder = new CodexJsonlStreamDecoder();
  decoder.ingest(raw);
  const parsed = decoder.finish();
  assert.equal(parsed.text, "finished after the ignored tool event");
  assert.ok(
    decoder.retainedBytesForTest() < 4096,
    `retained ${decoder.retainedBytesForTest()} bytes after discarding a multi-megabyte tool event`,
  );

  const worker = await runCodexWorkerWithStdout(splitEvery(Buffer.from(raw), [64 * 1024, 17, 9])).promise;
  assert.equal(worker.isError, false);
  assert.equal(worker.sessionId, "thread-large-tool");
  assert.equal(worker.text, "finished after the ignored tool event");
  assert.equal(worker.numTurns, 1);
  assert.deepEqual(worker.tokens, { input: 101, output: 21, cacheRead: 33, cacheCreation: 0 });
});

test("W1-T3447 criterion 3: over-ceiling Codex JSONL produces a named error and reaps the group", async () => {
  const tooLargeIncompleteRecord = `${JSON.stringify({ type: "thread.started", thread_id: "thread-over-record" })}\n` +
    `{"type":"item.completed","item":{"type":"tool_output","aggregated_output":"${"x".repeat(CODEX_JSONL_RECORD_MAX_BYTES + 1)}`;
  const recordRun = runCodexWorkerWithStdout([Buffer.from(tooLargeIncompleteRecord)]);
  const recordResult = await recordRun.promise;
  assert.equal(recordResult.isError, true);
  assert.equal(recordResult.subtype, "codex_jsonl_record_too_large");
  assert.ok(recordRun.teardownCalls() >= 1, "the contained process group is reaped on record overflow");

  const transcriptRun = runCodexWorkerWithStdout([
    jsonl([
      { type: "thread.started", thread_id: "thread-over-transcript" },
      { type: "turn.started" },
      {
        type: "item.completed",
        item: { type: "agent_message", text: "y".repeat(CODEX_JSONL_TRANSCRIPT_MAX_BYTES + 1) },
      },
    ]),
  ]);
  const transcriptResult = await transcriptRun.promise;
  assert.equal(transcriptResult.isError, true);
  assert.equal(transcriptResult.subtype, "codex_jsonl_transcript_too_large");
  assert.ok(transcriptRun.teardownCalls() >= 1, "the contained process group is reaped on transcript overflow");
});
