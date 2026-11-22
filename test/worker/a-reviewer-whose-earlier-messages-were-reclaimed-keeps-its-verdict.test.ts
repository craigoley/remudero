// W1-T14207: a Codex reviewer whose final message is kept whole is not failed because the cap reclaimed earlier
// messages. Blocks reading truncated never decides completeness alone; text, stdout, stderr and completion still do.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { reviewerOutcome } from "#src/lib/review.js";
import {
  CODEX_WORKER_STDERR_MAX_BYTES, CODEX_WORKER_STDOUT_MAX_BYTES, codexResultRetentionComplete, spawnCodexWorker,
} from "#src/lib/worker-provider.js";
import type { ContainedSpawnOptions } from "#src/lib/worker-containment.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const VERDICT = "CRITERION 1: MET - the proof resolves\nVERDICT: PASS";
const TURN_COMPLETED = '{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":25,"output_tokens":10}}\n';
const messageLine = (text: string) => JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } });
const commandLine = (output: string) => JSON.stringify({ type: "item.completed", item: {
  id: "item_7", type: "command_execution", command: "/bin/bash -lc 'cat src/lib/worker-provider.ts'",
  aggregated_output: output, exit_code: 0, status: "completed" } });

function reviewer() {
  const home = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t14207-`));
  const stdout = new PassThrough();
  const proc = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout });
  let childTmp: string | undefined;
  let onStderr: ((chunk: string) => void) | undefined;
  const run = spawnCodexWorker({
    workerHome: home, cwd: REPO_ROOT, prompt: "review", tools: ["Read", "Grep", "Glob"],
    settingsFile: join(REPO_ROOT, "settings/worker.json"),
    runId: "W1-T14207-test", taskId: "W1-T14207",
    containment: {
      spawn: (options: ContainedSpawnOptions, stderrSink) => {
        childTmp = options.env?.TMPDIR;
        onStderr = stderrSink;
        return { process: proc as never, pid: 14207 };
      },
      teardown: () => { proc.emit("exit", null); },
    },
  }, { claudeBin: "/unused", root: home, workerProviders: { codexBin: "/bin/sh", codexModel: "gpt-6-luna" } });
  void run.catch(() => undefined);
  const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
  stdout.write('{"type":"thread.started","thread_id":"review-run"}\n{"type":"turn.started"}\n');
  return {
    home, run,
    spillFile: () => join(childTmp!, "stdout-pending.jsonl"),
    spillHolds: async (bytes: number) => {
      const file = join(childTmp!, "stdout-pending.jsonl");
      while (!(existsSync(file) && statSync(file).size === bytes)) await settle();
    },
    write: async (line: string) => {
      for (let offset = 0; offset < line.length; offset += 65_536) stdout.write(line.slice(offset, offset + 65_536));
      await settle();
    },
    stderr: (text: string) => onStderr?.(text),
    end: (tail = TURN_COMPLETED) => { stdout.end(tail); proc.emit("exit", 0); },
    ledger: () => readFileSync(join(home, "state/ledger.ndjson"), "utf8").trim().split("\n").map(line => JSON.parse(line)),
  };
}

/** The W1-T13951 fixture before its final message: a 400 KiB earlier message, then a 2 MiB command item. */
async function earlierWork(child: ReturnType<typeof reviewer>) {
  await child.write(`${messageLine("EARLIER\n" + "e".repeat(400 * 1024))}\n`);
  await child.write(`${commandLine("c".repeat(2 * 1024 * 1024))}\n`);
}

const FINAL = "FINAL\n" + "f".repeat(800 * 1024) + "\n" + VERDICT;

/** The W1-T13951 fixture whole: the earlier work, an 800 KiB final message, turn.completed and exit 0. */
async function reclaimedRun() {
  const child = reviewer();
  await earlierWork(child);
  await child.write(`${messageLine(FINAL)}\n`);
  child.end();
  return { child, result: await child.run };
}

const whole = { state: "complete" as const, bytesRead: 10 };
const loss = { finalMessageSealed: true, rebuiltLines: 0, rebuiltDroppedBytes: 0, unaccountedSpills: 0, invalidRebuiltLines: 0 };
/** The spawn's completeness rule for a success that lost only `lost`. */
const judge = (lost: "text" | "blocks" | "stdout" | "stderr" | "completion") => codexResultRetentionComplete({
  text: whole, blocks: whole, stdout: whole, stderr: whole, completion: { state: "complete" }, originalSubtype: "success",
  ...(lost === "completion" ? { completion: { state: "absent" } } : { [lost]: { state: "truncated", bytesRead: 10 } }),
}, { retentionLoss: loss });

test("W1-T14207 criterion 1: a final message kept whole beside reclaimed earlier messages returns success and the review keeps its verdict", async () => {
  const { child, result } = await reclaimedRun();
  try {
    assert.ok(result.text === FINAL, "the final message is retained byte for byte");
    assert.equal(result.outputRetention?.text.state, "complete");
    assert.equal(result.outputRetention?.blocks.state, "truncated");
    assert.equal(result.outputRetention?.stdout?.state, "complete");
    assert.equal(result.outputRetention?.stderr.state, "complete");
    assert.equal(result.outputRetention?.completion?.state, "complete");
    assert.equal(result.subtype, "success");
    assert.equal(result.isError, false);
    assert.equal(reviewerOutcome({ attempted: true, subtype: result.subtype, exit: result.exit }), "success");
    assert.equal(judge("blocks"), true, "blocks alone never fails the run");
  } finally { rmSync(child.home, { recursive: true, force: true }); }
});

test("W1-T14207 criterion 2: a cut final message, a missing turn.completed, a damaged spill and a truncated stderr still fail the run", async () => {
  // Each case first reclaims earlier messages, so blocks reads truncated, and then breaks one other channel.
  const cutFinal = reviewer();
  try {
    await earlierWork(cutFinal);
    await cutFinal.write(`${messageLine("HEAD" + "m".repeat(CODEX_WORKER_STDOUT_MAX_BYTES + 1) + "TAIL")}\n`);
    cutFinal.end();
    const result = await cutFinal.run;
    assert.equal(result.outputRetention?.text.state, "truncated");
    assert.equal(result.outputRetention?.blocks.state, "truncated");
    assert.equal(result.subtype, "error_incomplete_output");
    assert.equal(result.isError, true);
  } finally { rmSync(cutFinal.home, { recursive: true, force: true }); }

  const unfinished = reviewer();
  try {
    await earlierWork(unfinished);
    await unfinished.write(`${messageLine(FINAL)}\n`);
    unfinished.end("");
    const result = await unfinished.run;
    assert.equal(result.outputRetention?.text.state, "complete");
    assert.equal(result.outputRetention?.blocks.state, "truncated");
    assert.notEqual(result.outputRetention?.completion?.state, "complete");
    assert.equal(result.subtype, "error_incomplete_output");
    assert.equal(result.isError, true);
  } finally { rmSync(unfinished.home, { recursive: true, force: true }); }

  for (const damage of ["malformed", "unreadable"] as const) {
    const child = reviewer();
    try {
      await child.write(`${messageLine("EARLIER\n" + "e".repeat(400 * 1024))}\n`);
      const line = commandLine("c".repeat(2 * 1024 * 1024));
      await child.write(line);
      await child.spillHolds(Buffer.byteLength(line));
      if (damage === "malformed") writeFileSync(child.spillFile(), Buffer.concat([Buffer.from(line.slice(0, 1024)), Buffer.from([0xc3, 0x28])]));
      else {
        const target = `${child.spillFile()}.target`;
        writeFileSync(target, line);
        unlinkSync(child.spillFile());
        symlinkSync(target, child.spillFile());
      }
      await child.write("\n");
      await child.write(`${messageLine(FINAL)}\n`);
      child.end();
      const result = await child.run;
      assert.equal(result.outputRetention?.stdout?.state, damage, damage);
      assert.equal(result.subtype, "error_codex", damage);
      assert.equal(result.isError, true, damage);
    } finally { rmSync(child.home, { recursive: true, force: true }); }
  }

  const noisy = reviewer();
  try {
    await earlierWork(noisy);
    for (let i = 0; i < 5; i++) noisy.stderr(`${"s".repeat(CODEX_WORKER_STDERR_MAX_BYTES / 4)}\n`);
    await noisy.write(`${messageLine(FINAL)}\n`);
    noisy.end();
    const result = await noisy.run;
    assert.equal(result.outputRetention?.text.state, "complete");
    assert.equal(result.outputRetention?.blocks.state, "truncated");
    assert.equal(result.outputRetention?.stderr.state, "truncated");
    assert.equal(result.subtype, "error_incomplete_output");
    assert.equal(result.isError, true);
  } finally { rmSync(noisy.home, { recursive: true, force: true }); }

  // A cut final message always spills, so stdout reads truncated beside it. Ask the spawn's own rule for each
  // channel alone, so a rule that stops reading text (or any other channel) is caught too.
  for (const lost of ["text", "stdout", "stderr", "completion"] as const) assert.equal(judge(lost), false, lost);
});

test("W1-T14207 criterion 3: the success still records the loss on its blocks, its truncation and the worker.output_truncated row", async () => {
  const { child, result } = await reclaimedRun();
  try {
    assert.equal(result.subtype, "success");
    const bytes = result.blocks.reduce((sum, block) => sum + Buffer.byteLength(block), 0);
    assert.deepEqual(result.outputRetention?.blocks, { state: "truncated", bytesRead: bytes });
    const truncation = result.outputTruncation!;
    assert.ok(truncation.droppedBytes > 0, "the reclaimed bytes are counted");
    assert.equal(truncation.retainedBytes, bytes);
    assert.equal(truncation.limitBytes, CODEX_WORKER_STDOUT_MAX_BYTES);
    const receipt = child.ledger().find(row => row.step === "worker.output_truncated");
    assert.equal(receipt.run_id, "W1-T14207-test");
    assert.deepEqual(receipt.output_truncation, truncation);
  } finally { rmSync(child.home, { recursive: true, force: true }); }
});
