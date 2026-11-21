import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { CODEX_WORKER_STDOUT_MAX_BYTES, spawnCodexWorker } from "#src/lib/worker-provider.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const VERDICT = "CRITERION 1: MET — the proof resolves\nCRITERION 2: MET — counted\nVERDICT: PASS";

function reviewer() {
  const home = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t13951-`));
  const stdout = new PassThrough();
  const proc = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout });
  const run = spawnCodexWorker({
    workerHome: home, cwd: REPO_ROOT, prompt: "review", tools: ["Read", "Grep", "Glob"],
    settingsFile: join(REPO_ROOT, "settings/worker.json"),
    runId: "W1-T13951-test", taskId: "W1-T13951",
    containment: {
      spawn: () => ({ process: proc as never, pid: 13951 }),
      teardown: () => { proc.emit("exit", null); },
    },
  }, { claudeBin: "/unused", root: home, workerProviders: { codexBin: "/bin/sh", codexModel: "gpt-6-luna" } });
  void run.catch(() => undefined);
  stdout.write('{"type":"thread.started","thread_id":"review-run"}\n{"type":"turn.started"}\n');
  const write = (line: string) => {
    for (let offset = 0; offset < line.length; offset += 65_536) stdout.write(line.slice(offset, offset + 65_536));
  };
  return {
    home, run, raw: write,
    message: (text: string) => write(`${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } })}\n`),
    command: (output: string) => write(`${JSON.stringify({ type: "item.completed", item: {
      id: "item_7", type: "command_execution", command: "/bin/bash -lc 'cat src/lib/worker-provider.ts'",
      aggregated_output: output, exit_code: 0, status: "completed" } })}\n`),
    end: () => {
      stdout.end('{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":25,"output_tokens":10}}\n');
      proc.emit("exit", 0);
    },
    ledger: () => readFileSync(join(home, "state/ledger.ndjson"), "utf8").trim().split("\n").map(line => JSON.parse(line)),
  };
}

test("W1-T13951 criterion 1: a 1.1 MiB stream whose bulk is command output keeps its final agent_message whole and its text complete", async () => {
  const child = reviewer();
  try {
    child.message("reading the diff");
    child.command("const x = 1;\n".repeat(Math.ceil((1.1 * 1024 * 1024) / 13)));
    child.message(VERDICT);
    child.end();
    const result = await child.run;
    assert.equal(result.text, VERDICT);
    assert.equal(result.outputRetention?.text.state, "complete");
    assert.equal(result.outputRetention?.blocks.state, "complete");
    assert.equal(result.outputRetention?.stdout?.state, "complete");
    assert.equal(result.subtype, "success");
    assert.equal(result.isError, false);
    assert.ok(result.outputTruncation, "the spilled command body is still recorded");
  } finally { rmSync(child.home, { recursive: true, force: true }); }
});

test("W1-T13951 criterion 2: the bytes dropped from command output are counted on worker.output_truncated", async () => {
  const child = reviewer();
  try {
    const output = "y".repeat(1.1 * 1024 * 1024);
    child.command(output);
    child.message(VERDICT);
    child.end();
    const result = await child.run;
    const truncation = result.outputTruncation!;
    assert.equal(truncation.limitBytes, CODEX_WORKER_STDOUT_MAX_BYTES);
    // The spilled line keeps a 64 KiB head and a 256 KiB tail; every byte between them is counted.
    assert.ok(truncation.spilledBytes > output.length);
    assert.equal(truncation.droppedBytes, truncation.spilledBytes - 64 * 1024 - 256 * 1024);
    const retained = result.blocks.reduce((sum, block) => sum + Buffer.byteLength(block), 0);
    assert.equal(truncation.retainedBytes, retained);
    const receipt = child.ledger().find(row => row.step === "worker.output_truncated");
    assert.equal(receipt.run_id, "W1-T13951-test");
    assert.deepEqual(receipt.output_truncation, truncation);
  } finally { rmSync(child.home, { recursive: true, force: true }); }
});

test("W1-T13951 criterion 3: the retained total stays within the limit and a final message past it alone reads truncated", async () => {
  const child = reviewer();
  try {
    child.command("z".repeat(1.1 * 1024 * 1024));
    child.message("HEAD" + "m".repeat(CODEX_WORKER_STDOUT_MAX_BYTES + 1) + "TAIL");
    child.end();
    const result = await child.run;
    assert.equal(result.outputRetention?.text.state, "truncated");
    assert.equal(result.outputRetention?.blocks.state, "truncated");
    assert.equal(result.subtype, "error_incomplete_output");
    assert.equal(result.isError, true);
    assert.ok(result.text.startsWith("HEAD"));
    assert.ok(result.text.endsWith("TAIL"));
    const bytes = result.blocks.reduce((sum, block) => sum + Buffer.byteLength(block), 0);
    assert.ok(bytes <= CODEX_WORKER_STDOUT_MAX_BYTES);
    assert.ok(result.outputTruncation!.retainedBytes <= CODEX_WORKER_STDOUT_MAX_BYTES);
  } finally { rmSync(child.home, { recursive: true, force: true }); }
});

test("W1-T13951 criterion 3: a spilled command line that does not parse still reads its stdout truncated", async () => {
  const child = reviewer();
  try {
    // A cut item: the reconstruction cannot certify the protocol, so the dropped body is not excused.
    const line = JSON.stringify({ type: "item.completed", item: { type: "command_execution", aggregated_output: "q".repeat(1.1 * 1024 * 1024) } });
    child.raw(line.slice(0, -3) + "\n");
    child.message(VERDICT);
    child.end();
    const result = await child.run;
    assert.equal(result.text, VERDICT);
    assert.equal(result.outputRetention?.stdout?.state, "truncated");
    assert.equal(result.isError, true);
  } finally { rmSync(child.home, { recursive: true, force: true }); }
});

test("W1-T13951 criterion 1: an earlier message is reclaimed before the newest one that fits the limit alone is cut", async () => {
  const child = reviewer();
  try {
    const final = "FINAL\n" + "f".repeat(800 * 1024);
    child.message("EARLIER\n" + "e".repeat(400 * 1024));
    child.command("c".repeat(2 * 1024 * 1024));
    child.message(final);
    child.end();
    const result = await child.run;
    assert.equal(Buffer.byteLength(result.text), Buffer.byteLength(final));
    assert.ok(result.text === final, "the newest message is retained byte for byte");
    assert.equal(result.outputRetention?.text.state, "complete");
    assert.equal(result.outputRetention?.blocks.state, "truncated");
    assert.ok(result.blocks[0]!.startsWith("EARLIER"), "the earlier message keeps its head");
    const bytes = result.blocks.reduce((sum, block) => sum + Buffer.byteLength(block), 0);
    assert.ok(bytes <= CODEX_WORKER_STDOUT_MAX_BYTES);
    assert.equal(result.outputTruncation!.retainedBytes, bytes);
  } finally { rmSync(child.home, { recursive: true, force: true }); }
});

test("W1-T13951 criterion 2: an evicted message that was cut once counts only its source bytes, never its marker", async () => {
  const child = reviewer();
  try {
    const commandLine = (output: string) => Buffer.byteLength(JSON.stringify({ type: "item.completed", item: {
      id: "item_7", type: "command_execution", command: "/bin/bash -lc 'cat src/lib/worker-provider.ts'",
      aggregated_output: output, exit_code: 0, status: "completed" } }));
    const spillKept = 64 * 1024 + 256 * 1024;
    const outputs = ["a".repeat(1536 * 1024), "b".repeat(1536 * 1024)];
    const evicted = "E".repeat(2 * 1024 * 1024);
    // While the 2 MiB message streams in, "first" is reclaimed for it before it spills; the cut message then
    // heads the retained blocks, and a final message that fits the limit alone reclaims it and "B" in turn.
    const final = "C".repeat(CODEX_WORKER_STDOUT_MAX_BYTES - 200);
    child.message("first");
    child.command(outputs[0]!);
    child.message(evicted);
    child.command(outputs[1]!);
    child.message("B".repeat(400 * 1024));
    child.message(final);
    child.end();
    const result = await child.run;
    assert.ok(!result.blocks.some(block => block.startsWith("EEEE")), "the cut message was evicted");
    assert.equal(result.text, final);
    const expected = outputs.reduce((sum, output) => sum + commandLine(output) - spillKept, 0) + Buffer.byteLength(evicted)
      + Buffer.byteLength("first") + 400 * 1024;
    assert.equal(result.outputTruncation!.droppedBytes, expected);
    const receipt = child.ledger().find(row => row.step === "worker.output_truncated");
    assert.equal(receipt.output_truncation.droppedBytes, expected);
  } finally { rmSync(child.home, { recursive: true, force: true }); }
});

test("W1-T13951 criterion 3: a final message with an escaped quote at the spill boundary reconstructs and reads truncated", async () => {
  const child = reviewer();
  try {
    // The spilled tail is the line's last 256 KiB; place `\"` so the tail begins on its quote.
    const text = "HEAD" + "a".repeat(1_048_000) + "\"" + "b".repeat(262_140);
    const line = JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } });
    assert.equal(line.slice(-262_144 - 1, -262_144 + 1), "\\\"");
    child.raw(line + "\n");
    child.end();
    const result = await child.run;
    assert.ok(result.text.startsWith("HEAD"), "the head survives the cut");
    assert.ok(result.text.endsWith("b".repeat(1000)), "the tail survives the cut");
    assert.equal(result.outputRetention?.text.state, "truncated");
    assert.equal(result.isError, true);
  } finally { rmSync(child.home, { recursive: true, force: true }); }
});

test("W1-T13951 criterion 3: a final message whose spilled line cannot be reconstructed never reads complete", async () => {
  const child = reviewer();
  try {
    const line = JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "m".repeat(1.2 * 1024 * 1024) } });
    child.raw(line.slice(0, -3) + "\n");
    child.end();
    const result = await child.run;
    assert.equal(result.text, "");
    assert.equal(result.outputRetention?.text.state, "truncated");
    assert.equal(result.isError, true);
  } finally { rmSync(child.home, { recursive: true, force: true }); }
});

test("W1-T13951 criterion 1: a final message that fits the limit only with every earlier message reclaimed is kept whole", async () => {
  const child = reviewer();
  try {
    // The reviewer's counterexample: 2 MiB of command output, a 400 KiB earlier message, and a final message of
    // 1,048,476 bytes whose JSONL line still fits the 1 MiB limit with its envelope.
    const final = "FINAL\n" + "f".repeat(1_048_476 - 6);
    const line = JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: final } });
    assert.ok(Buffer.byteLength(line) <= CODEX_WORKER_STDOUT_MAX_BYTES, "the final line fits the limit alone");
    child.message("EARLIER\n" + "e".repeat(400 * 1024));
    child.command("c".repeat(2 * 1024 * 1024));
    child.message(final);
    child.end();
    const result = await child.run;
    assert.equal(Buffer.byteLength(result.text), Buffer.byteLength(final));
    assert.ok(result.text === final, "the final message is retained byte for byte");
    assert.equal(result.outputRetention?.text.state, "complete");
    assert.equal(result.outputRetention?.blocks.state, "truncated");
    const bytes = result.blocks.reduce((sum, block) => sum + Buffer.byteLength(block), 0);
    assert.ok(bytes <= CODEX_WORKER_STDOUT_MAX_BYTES);
    assert.equal(result.outputTruncation!.retainedBytes, bytes);
  } finally { rmSync(child.home, { recursive: true, force: true }); }
});

test("W1-T13951 criterion 2: a message whose source opens with the marker text counts only source bytes when cut again", async () => {
  const child = reviewer();
  try {
    // The spilled line keeps its first 64 KiB and last 256 KiB; the marker it gets names the bytes between.
    // Build the source so it opens with that exact marker text, then cut the retained block a second time.
    const omitted = 1_500_000;
    const marker = (bytes: number) => `\n[Codex output truncated: ${bytes} bytes omitted]\n`;
    const envelope = (text: string) => JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } });
    const base = Buffer.byteLength(envelope(marker(omitted)));
    const source = marker(omitted) + "x".repeat(omitted + 64 * 1024 + 256 * 1024 - base);
    assert.equal(Buffer.byteLength(envelope(source)) - 64 * 1024 - 256 * 1024, omitted);
    child.message(source);
    child.message("C".repeat(1_000_000));
    child.end();
    const result = await child.run;
    const first = result.blocks[0]!;
    assert.ok(first.startsWith(marker(omitted)), "the source copy of the marker text is retained");
    const markers = [...first.matchAll(/\n\[Codex output truncated: (\d+) bytes omitted\]\n/g)];
    assert.equal(markers.length, 2, "the source copy and the one marker of the second cut");
    const synthetic = markers[1]![0];
    // Every source byte is either retained in the block or counted as dropped; no marker byte is counted.
    const retainedSource = Buffer.byteLength(first) - Buffer.byteLength(synthetic);
    assert.equal(result.outputTruncation!.droppedBytes, Buffer.byteLength(source) - retainedSource);
  } finally { rmSync(child.home, { recursive: true, force: true }); }
});

test("W1-T13951 criterion 1: a final message whose line fits the limit beside a short earlier message evicts it rather than be cut", async () => {
  const child = reviewer();
  try {
    // The reviewer's counterexample: 2 MiB of command output, a 20-byte earlier message, and a final
    // agent_message whose JSONL payload is 1,048,531 bytes. The line never spills, so boundRetained() decides.
    const envelope = (text: string) => JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } });
    const final = "FINAL\n" + "f".repeat(1_048_531 - Buffer.byteLength(envelope("FINAL\n")));
    assert.equal(Buffer.byteLength(envelope(final)), 1_048_531);
    const earlier = "an earlier message.\n";
    assert.equal(Buffer.byteLength(earlier), 20);
    child.message(earlier);
    child.command("c".repeat(2 * 1024 * 1024));
    child.message(final);
    child.end();
    const result = await child.run;
    assert.equal(Buffer.byteLength(result.text), Buffer.byteLength(final));
    assert.ok(result.text === final, "the final message is retained byte for byte");
    assert.equal(result.outputRetention?.text.state, "complete");
    const bytes = result.blocks.reduce((sum, block) => sum + Buffer.byteLength(block), 0);
    assert.ok(bytes <= CODEX_WORKER_STDOUT_MAX_BYTES);
    assert.equal(result.outputTruncation!.retainedBytes, bytes);
  } finally { rmSync(child.home, { recursive: true, force: true }); }
});

test("W1-T13951 criterion 2: an evicted spilled message with JSON whitespace after its text key counts only source bytes", async () => {
  const child = reviewer();
  try {
    // Valid JSON whitespace between `"text":` and its string; the spill marker must still be located and excluded.
    const evicted = "E".repeat(2 * 1024 * 1024);
    child.raw(`{"type":"item.completed","item":{"type":"agent_message","text": \t${JSON.stringify(evicted)}}}\n`);
    const final = "C".repeat(CODEX_WORKER_STDOUT_MAX_BYTES - 200);
    child.message(final);
    child.end();
    const result = await child.run;
    assert.ok(!result.blocks.some(block => block.startsWith("EEEE")), "the cut message was evicted");
    assert.equal(result.text, final);
    assert.equal(result.outputTruncation!.droppedBytes, Buffer.byteLength(evicted));
    const receipt = child.ledger().find(row => row.step === "worker.output_truncated");
    assert.equal(receipt.output_truncation.droppedBytes, Buffer.byteLength(evicted));
  } finally { rmSync(child.home, { recursive: true, force: true }); }
});

test("W1-T13951 criterion 1: a final agent_message with JSON whitespace around its type colon is still reclaimed for and kept whole", async () => {
  const child = reviewer();
  try {
    // The reviewer's counterexample: 2 MiB of command output, a 400 KiB earlier message, then a final event
    // written with valid whitespace around its `type` colons. Its line fits the limit alone.
    const final = "FINAL\n" + "f".repeat(800 * 1024);
    const line = `{"type" : "item.completed", "item" : {"type" : "agent_message", "text" : ${JSON.stringify(final)}}}`;
    assert.ok(Buffer.byteLength(line) <= CODEX_WORKER_STDOUT_MAX_BYTES, "the final line fits the limit alone");
    child.message("EARLIER\n" + "e".repeat(400 * 1024));
    child.command("c".repeat(2 * 1024 * 1024));
    child.raw(line + "\n");
    child.end();
    const result = await child.run;
    assert.equal(Buffer.byteLength(result.text), Buffer.byteLength(final));
    assert.ok(result.text === final, "the final message is retained byte for byte");
    assert.equal(result.outputRetention?.text.state, "complete");
    const bytes = result.blocks.reduce((sum, block) => sum + Buffer.byteLength(block), 0);
    assert.ok(bytes <= CODEX_WORKER_STDOUT_MAX_BYTES);
  } finally { rmSync(child.home, { recursive: true, force: true }); }
});

test("W1-T13951 criterion 2: an evicted spilled message of escaped newlines counts its dropped stream bytes, not decoded ones", async () => {
  const child = reviewer();
  try {
    // 2,097,152 newlines encode as 4,194,304 payload bytes. The spill drops encoded bytes; the later eviction
    // of the retained head and tail must count in the same unit, so the total is the whole payload.
    const evicted = "\n".repeat(2 * 1024 * 1024);
    const payload = Buffer.byteLength(JSON.stringify(evicted)) - 2;
    assert.equal(payload, 4_194_304);
    child.message(evicted);
    const final = "C".repeat(CODEX_WORKER_STDOUT_MAX_BYTES - 200);
    child.message(final);
    child.end();
    const result = await child.run;
    assert.equal(result.text, final);
    assert.ok(!result.blocks.some(block => block.startsWith("\n\n\n\n")), "the cut message was evicted");
    assert.equal(result.outputTruncation!.droppedBytes, payload);
    const receipt = child.ledger().find(row => row.step === "worker.output_truncated");
    assert.equal(receipt.output_truncation.droppedBytes, payload);
  } finally { rmSync(child.home, { recursive: true, force: true }); }
});

test("W1-T13951 criterion 1: backslash-heavy command output cut at the spill boundary stays a valid command event", async () => {
  const child = reviewer();
  try {
    // The reviewer's counterexample: 2 MiB of encoded backslashes. The spilled tail (the line's last 256 KiB)
    // opens on the second byte of a `\\` escape, so a cut that ignores escapes turns the valid event malformed.
    const line = JSON.stringify({ type: "item.completed", item: { id: "item_7", type: "command_execution",
      command: "/bin/bash -lc 'cat blob'", aggregated_output: "\\".repeat(1024 * 1024), exit_code: 10, status: "completed" } });
    const suffix = line.length - line.lastIndexOf("\\") - 1;
    assert.equal((262_144 - suffix) % 2, 1, "the tail opens inside an escape");
    const final = "FINAL\n" + "f".repeat(1_048_517 - Buffer.byteLength(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "FINAL\n" } })));
    const finalLine = JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: final } });
    assert.equal(Buffer.byteLength(finalLine), 1_048_517);
    child.raw(line + "\n");
    child.message(final);
    child.end();
    const result = await child.run;
    assert.ok(result.text === final, "the final message is retained byte for byte");
    assert.equal(result.outputRetention?.text.state, "complete");
    assert.equal(result.outputRetention?.stdout?.state, "complete");
    assert.equal(result.isError, false);
  } finally { rmSync(child.home, { recursive: true, force: true }); }
});

test("W1-T13951 criterion 1: a retained diagnostic gives way to a final message that fits the limit alone", async () => {
  const child = reviewer();
  try {
    // A Codex error event (a reconnect notice) is retained as a diagnostic; it must not take the room a whole
    // final message needs.
    child.raw(`${JSON.stringify({ type: "error", error: { message: "stream disconnected; retrying " + "r".repeat(2048) } })}\n`);
    child.command("c".repeat(2 * 1024 * 1024));
    const final = "FINAL\n" + "f".repeat(CODEX_WORKER_STDOUT_MAX_BYTES - 200);
    child.message(final);
    child.end();
    const result = await child.run;
    assert.ok(result.text === final, "the final message is retained byte for byte");
    assert.equal(result.outputRetention?.text.state, "complete");
    const bytes = result.blocks.reduce((sum, block) => sum + Buffer.byteLength(block), 0);
    assert.ok(bytes <= CODEX_WORKER_STDOUT_MAX_BYTES);
    assert.ok(result.outputTruncation!.retainedBytes <= CODEX_WORKER_STDOUT_MAX_BYTES);
  } finally { rmSync(child.home, { recursive: true, force: true }); }
});

test("W1-T13951 criterion 2: an evicted message of escaped slashes counts the raw payload bytes the stream delivered", async () => {
  const child = reviewer();
  try {
    // `\/` is a valid escape that JSON.stringify never writes: re-encoding the decoded text undercounts by half.
    const payload = "\\/".repeat(1024 * 1024);
    assert.equal(Buffer.byteLength(payload), 2_097_152);
    child.raw(`{"type":"item.completed","item":{"type":"agent_message","text":"${payload}"}}\n`);
    const final = "C".repeat(CODEX_WORKER_STDOUT_MAX_BYTES - 200);
    child.message(final);
    child.end();
    const result = await child.run;
    assert.equal(result.text, final);
    assert.ok(!result.blocks.some(block => block.startsWith("////")), "the cut message was evicted");
    assert.equal(result.outputTruncation!.droppedBytes, 2_097_152);
    const receipt = child.ledger().find(row => row.step === "worker.output_truncated");
    assert.equal(receipt.output_truncation.droppedBytes, 2_097_152);
  } finally { rmSync(child.home, { recursive: true, force: true }); }
});
