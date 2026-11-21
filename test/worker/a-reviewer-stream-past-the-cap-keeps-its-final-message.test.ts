import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { CODEX_WORKER_STDOUT_MAX_BYTES, CodexJsonlAccumulator, spawnCodexWorker } from "#src/lib/worker-provider.js";
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
    home, run, raw: write, chunk: (text: string) => { stdout.write(text); },
    message: (text: string) => write(`${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } })}\n`),
    command: (output: string) => write(`${JSON.stringify({ type: "item.completed", item: {
      id: "item_7", type: "command_execution", command: "/bin/bash -lc 'cat src/lib/worker-provider.ts'",
      aggregated_output: output, exit_code: 0, status: "completed" } })}\n`),
    close: () => { stdout.end(); proc.emit("exit", 0); },
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
    // The 2 MiB message spills and is cut; a final message that fits the limit alone reclaims it and "B", and
    // "first" still fits the room left beside it.
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
    assert.equal(result.blocks[0], "first");
    const expected = outputs.reduce((sum, output) => sum + commandLine(output) - spillKept, 0) + Buffer.byteLength(evicted)
      + 400 * 1024;
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


/** The reviewer's stream: an earlier message and a 2 MiB error fill the budget, then 2 MiB of command output. */
async function filledBudget(final: string, splits: number[]) {
  const child = reviewer();
  try {
    child.message("e".repeat(786_490));
    child.raw(`${JSON.stringify({ type: "error", error: { message: "r".repeat(2 * 1024 * 1024) } })}\n`);
    child.command("c".repeat(2 * 1024 * 1024));
    let at = 0;
    for (const split of splits) { child.chunk(final.slice(at, split)); at = split; }
    child.raw(final.slice(at) + "\n");
    child.end();
    const result = await child.run;
    return { text: result.text, blocks: result.blocks, retention: result.outputRetention?.text.state,
      truncation: result.outputTruncation };
  } finally { rmSync(child.home, { recursive: true, force: true }); }
}

test("W1-T13951 criterion 1: a final message that fits the limit is retained the same however stdout splits its line", async () => {
  // The reviewer's counterexample: an 819,281-byte final line split at byte 16 started a lossy spill before its
  // header could be classified, returning 327,647 of 819,200 text bytes.
  const text = "f".repeat(819_200);
  const final = JSON.stringify({ type: "item.completed", item: { id: "item_9", type: "agent_message", text } });
  assert.equal(Buffer.byteLength(final), 819_281);
  const whole = await filledBudget(final, []);
  assert.ok(whole.text === text, "one chunk keeps the final message whole");
  assert.equal(whole.retention, "complete");
  for (const split of [16, ...Array.from({ length: 24 }, (_, i) => i + 1), 1024, 65_536]) {
    const cut = await filledBudget(final, [split]);
    assert.ok(cut.text === text, `a split at byte ${split} keeps the final message whole`);
    assert.deepEqual(cut, whole, `a split at byte ${split} retains exactly what one chunk does`);
  }
  assert.deepEqual(await filledBudget(final, [16, 17, 40, 900, 70_000]), whole, "several splits retain the same");
});

test("W1-T13951 criterion 2: an evicted spilled error counts its source bytes only, never its own spill marker", async () => {
  // The reviewer's counterexample: a 2 MiB Codex error message spills, is later evicted, and its 51-byte encoded
  // spill marker was counted as dropped source output (2,097,203 for 2,097,152 source bytes).
  const child = reviewer();
  try {
    const message = "r".repeat(2 * 1024 * 1024);
    child.raw(`${JSON.stringify({ type: "error", error: { message } })}\n`);
    const final = "F".repeat(CODEX_WORKER_STDOUT_MAX_BYTES - 100);
    child.message(final);
    child.end();
    const result = await child.run;
    assert.ok(result.text === final, "the final message is retained whole");
    // Every source byte of the error is dropped; none of the accumulator's own marker bytes is counted.
    assert.equal(result.outputTruncation!.droppedBytes, Buffer.byteLength(message));
    const receipt = child.ledger().find(row => row.step === "worker.output_truncated");
    assert.equal(receipt.output_truncation.droppedBytes, Buffer.byteLength(message));
  } finally { rmSync(child.home, { recursive: true, force: true }); }
});

test("W1-T13951 criterion 2: dropped bytes never exceed the source bytes and equal them when every payload is evicted", async () => {
  const child = reviewer();
  try {
    const payloads = ["\\/".repeat(300_000), "\\n".repeat(400_000), "r".repeat(1_500_000)];
    child.raw(`{"type":"error","error":{"message":"${payloads[2]}"}}\n`);
    child.raw(`{"type":"item.completed","item":{"type":"agent_message","text":"${payloads[0]}"}}\n`);
    child.raw(`{"type":"item.completed","item":{"type":"agent_message","text":"${payloads[1]}"}}\n`);
    const final = "F".repeat(CODEX_WORKER_STDOUT_MAX_BYTES - 100);
    child.message(final);
    child.end();
    const result = await child.run;
    assert.ok(result.text === final);
    // The messages were held whole, so each counts its decoded bytes, as an eviction always has.
    const source = payloads.reduce((sum, payload) => sum + Buffer.byteLength(JSON.parse(`"${payload}"`) as string), 0);
    assert.equal(result.outputTruncation!.droppedBytes, source);
  } finally { rmSync(child.home, { recursive: true, force: true }); }
});

test("W1-T13951 criterion 3: the accumulator never holds more than the limit and reports what it holds", () => {
  // The reviewer's counterexample: one final message of 614,400 decoded bytes held beside its raw payload,
  // 1,536,000 bytes live, while worker.output_truncated reported 614,400.
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t13951-held-`));
  try {
    const accumulator = new CodexJsonlAccumulator(0, join(dir, "stdout-pending.jsonl"));
    // Every string the accumulator holds, whatever its field, except its session id and spill path.
    const held = () => Object.entries(accumulator).reduce((sum, [key, value]) => ["sessionId", "pendingFile"].includes(key) ? sum
      : sum + [value].flat(2).reduce((n: number, item) => n + (typeof item === "string" ? Buffer.byteLength(item) : 0), 0), 0);
    const text = "a\n".repeat(307_200);
    assert.equal(Buffer.byteLength(text), 614_400);
    const lines = [
      `${JSON.stringify({ type: "thread.started", thread_id: "review-run" })}\n{"type":"turn.started"}\n`,
      `${JSON.stringify({ type: "item.completed", item: { type: "command_execution", aggregated_output: "c".repeat(2 * 1024 * 1024) } })}\n`,
      `${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } })}\n`,
      '{"type":"turn.completed","usage":{"input_tokens":1,"cached_input_tokens":0,"output_tokens":1}}\n',
    ];
    for (const line of lines) {
      for (let offset = 0; offset < line.length; offset += 65_536) {
        accumulator.push(line.slice(offset, offset + 65_536));
        assert.ok(held() <= CODEX_WORKER_STDOUT_MAX_BYTES, `held ${held()} bytes, past the limit`);
        assert.equal(accumulator.retainedBytes(), held(), "retainedBytes() counts everything held");
      }
    }
    const parsed = accumulator.finish();
    assert.ok(parsed.text === text, "the final message is retained whole");
    const blocks = parsed.blocks.reduce((sum, block) => sum + Buffer.byteLength(block), 0);
    assert.equal(parsed.outputTruncation!.retainedBytes, blocks);
    assert.equal(parsed.outputTruncation!.retainedBytes, held(), "what is reported is what is held");
    assert.ok(held() <= CODEX_WORKER_STDOUT_MAX_BYTES);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("W1-T13951 criterion 1: an agent_message is classified from its whole line in any key order, and a decoy never is", async () => {
  // The reviewer's counterexample: the `type` fields written after an 819,200-byte `text` hid the item from a
  // 1 KiB head scan, and the line was cut to 327,647 bytes.
  const text = "f".repeat(819_200);
  const body = JSON.stringify(text);
  const lines = [
    `{"item":{"id":"item_9","text":${body},"type":"agent_message"},"type":"item.completed"}`,
    `{"type":"item.completed","item":{"text":${body},"id":"item_9","type":"agent_message"}}`,
    `{"item":{"type":"agent_message","text":${body}},"type":"item.completed"}`,
    `{ "item" : { "text" : ${body} , "type" : "agent_message" } , "type" : "item.completed" }`,
    `{"\\u0074ype":"item.completed","item":{"text":${body},"typ\\u0065":"agent_message"}}`,
  ];
  for (const line of lines) {
    const kept = await filledBudget(line, [16]);
    assert.ok(kept.text === text, `kept whole: ${line.slice(0, 40)}…${line.slice(-60)}`);
    assert.equal(kept.retention, "complete");
  }
  const decoys = [
    `{"type":"item.completed","item":{"meta":{"type":"agent_message"},"type":"command_execution","aggregated_output":${body}}}`,
    `{"type":"item.started","item":{"type":"agent_message","text":${body}}}`,
    `{"type":"item.completed","item":{"type":"command_execution","aggregated_output":${JSON.stringify(`"type":"agent_message"${text}`)}}}`,
  ];
  for (const decoy of decoys) {
    const result = await filledBudget(decoy, [16]);
    assert.ok(result.blocks[0] === "e".repeat(786_490), `a decoy reclaims nothing: ${decoy.slice(0, 60)}`);
  }
});

test("W1-T13951 criterion 2: a spilled error whose head and tail would overlap counts each source byte once", async () => {
  // The reviewer's counterexample: a 300,039-byte error event spilled under retention pressure joined a 64 KiB
  // head and a 256 KiB tail that shared bytes, and its eviction counted them twice.
  for (const size of [262_200, 300_039, 327_679, 327_680, 327_700, 400_000]) {
    const child = reviewer();
    try {
      const earlier = "m".repeat(1_000_000);
      child.message(earlier);
      const envelope = Buffer.byteLength(JSON.stringify({ type: "error", error: { message: "" } }));
      const message = "r".repeat(size - envelope);
      child.raw(`${JSON.stringify({ type: "error", error: { message } })}\n`);
      const final = "F".repeat(CODEX_WORKER_STDOUT_MAX_BYTES - 100);
      child.message(final);
      child.end();
      const result = await child.run;
      assert.ok(result.text === final, `size ${size}: the final message is retained whole`);
      assert.equal(result.outputTruncation!.droppedBytes, earlier.length + message.length, `size ${size}: each source byte once`);
    } finally { rmSync(child.home, { recursive: true, force: true }); }
  }
});

test("W1-T13951 criterion 3: retainedBytes() stays within the limit after every push, mid-line spills included", () => {
  // The reviewer's counterexample: a 65,536-byte spill head held beside 1,020,000 retained bytes read 1,085,536.
  const big = "x".repeat(2 * 1024 * 1024);
  const spilled = [
    JSON.stringify({ type: "item.completed", item: { type: "command_execution", aggregated_output: big } }),
    JSON.stringify({ type: "error", error: { message: big } }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: big } }),
    JSON.stringify({ type: "item.completed", item: { text: "a".repeat(900_000), type: "agent_message" } }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "b".repeat(300_000) } }),
  ];
  for (const line of spilled) {
    for (const lead of [1, 16, 65_536]) {
      const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t13951-push-`));
      try {
        const accumulator = new CodexJsonlAccumulator(0, join(dir, "stdout-pending.jsonl"));
        const held = () => Object.entries(accumulator).reduce((sum, [key, value]) => ["sessionId", "pendingFile"].includes(key) ? sum
          : sum + [value].flat(2).reduce((n: number, item) => n + (typeof item === "string" ? Buffer.byteLength(item) : 0), 0), 0);
        const check = (at: string) => {
          assert.ok(accumulator.retainedBytes() <= CODEX_WORKER_STDOUT_MAX_BYTES, `${at}: ${accumulator.retainedBytes()} retained`);
          assert.equal(accumulator.retainedBytes(), held(), `${at}: retainedBytes() counts everything held`);
        };
        accumulator.push(`${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "k".repeat(1_020_000) } })}\n`);
        check("before the line");
        const stream = line + "\n";
        for (let offset = 0; offset < Math.min(lead, 64); offset++) { accumulator.push(stream[offset]!); check(`byte ${offset}`); }
        for (let offset = Math.min(lead, 64); offset < stream.length; offset += 65_536) {
          accumulator.push(stream.slice(offset, offset + 65_536));
          check(`offset ${offset} of ${line.slice(0, 40)}`);
        }
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }
  }
});

test("W1-T13951 criterion 1: a final message whose payload fits the limit is kept whole though its JSONL event does not", async () => {
  // The reviewer's counterexample: an item of 1,048,564 serialized bytes in a 1,048,597-byte event; the cap
  // was applied to the event and only 327,661 of the 1,048,530 text bytes were kept.
  const child = reviewer();
  try {
    const itemOf = (text: string) => ({ type: "agent_message", text });
    const text = "f".repeat(1_048_564 - Buffer.byteLength(JSON.stringify(itemOf(""))));
    assert.equal(Buffer.byteLength(text), 1_048_530);
    assert.equal(Buffer.byteLength(JSON.stringify(itemOf(text))), 1_048_564);
    const line = JSON.stringify({ type: "item.completed", item: itemOf(text) });
    assert.equal(Buffer.byteLength(line), 1_048_597);
    child.command("c".repeat(2 * 1024 * 1024));
    child.raw(line + "\n");
    child.end();
    const result = await child.run;
    assert.ok(result.text === text, "the final message is retained byte for byte");
    assert.equal(result.outputRetention?.text.state, "complete");
    assert.ok(result.outputTruncation!.retainedBytes <= CODEX_WORKER_STDOUT_MAX_BYTES);
  } finally { rmSync(child.home, { recursive: true, force: true }); }
});

test("W1-T13951 criterion 2: evicting a diagnostic that never spilled counts its decoded bytes", async () => {
  // The reviewer's counterexample: a diagnostic of 20,000 newlines was counted as its 40,000 escaped bytes.
  const child = reviewer();
  try {
    const message = "\n".repeat(20_000);
    child.raw(`${JSON.stringify({ type: "error", error: { message } })}\n`);
    const final = "F".repeat(CODEX_WORKER_STDOUT_MAX_BYTES - 100);
    child.message(final);
    child.end();
    const result = await child.run;
    assert.ok(result.text === final);
    assert.equal(result.outputTruncation!.droppedBytes, 20_000);
    const receipt = child.ledger().find(row => row.step === "worker.output_truncated");
    assert.equal(receipt.output_truncation.droppedBytes, 20_000);
  } finally { rmSync(child.home, { recursive: true, force: true }); }
});

test("W1-T13951 criterion 3: unterminated whitespace at EOF is released, and the retained total stays within the limit", async () => {
  // The reviewer's counterexample: a near-cap message, then 100 unterminated spaces left pending beside a 61-byte
  // spill notice, reported 1,048,637 retained bytes.
  const child = reviewer();
  try {
    const near = "n".repeat(CODEX_WORKER_STDOUT_MAX_BYTES - 100);
    child.message(near);
    // A short command line spills behind it and is read back whole: nothing is dropped, so the notice is added.
    child.command("c".repeat(1000));
    child.raw('{"type":"turn.completed","usage":{"input_tokens":1,"cached_input_tokens":0,"output_tokens":1}}\n');
    child.raw(" ".repeat(100));
    child.close();
    const result = await child.run;
    assert.ok(result.text === near);
    assert.equal(result.outputTruncation!.droppedBytes, 0);
    assert.ok(result.blocks.some(block => block.includes("bytes spilled to disk")), "the spill notice is kept");
    const blocks = result.blocks.reduce((sum, block) => sum + Buffer.byteLength(block), 0);
    assert.ok(result.outputTruncation!.retainedBytes <= CODEX_WORKER_STDOUT_MAX_BYTES, `${result.outputTruncation!.retainedBytes} retained`);
    assert.equal(result.outputTruncation!.retainedBytes, blocks);
  } finally { rmSync(child.home, { recursive: true, force: true }); }
});
