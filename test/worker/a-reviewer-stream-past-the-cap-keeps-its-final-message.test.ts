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
