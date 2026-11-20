// W1-T13960: a Codex run whose stream completed is not marked incomplete because ONE spilled intermediate stdout
// line kept only its bounded tail. The spawn decides completeness through codexResultRetentionComplete: the
// final message, the retained blocks and the final turn.completed decide it, and a partial line never certifies.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { CODEX_WORKER_STDOUT_MAX_BYTES, spawnCodexWorker } from "#src/lib/worker-provider.js";
import type { ContainedSpawnOptions } from "#src/lib/worker-containment.js";
import { workerLedgerFields } from "#src/lib/worker.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const FINAL = "Reviewed the diff.\nREVIEW_VERDICT 1: PASS — the spawn decides through one predicate\nREVIEW_VERDICT 2: PASS — a partial line never certifies";
const TURN_COMPLETED = '{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":25,"output_tokens":10}}\n';

/** One Codex event line, newline excluded. */
const eventLine = (item: Record<string, unknown>) => JSON.stringify({ type: "item.completed", item });
/** A command item over the stdout retention bound: its spill keeps a bounded head and tail, so the omitted bytes
 *  fall inside the aggregated_output string. */
const oversizedCommand = () => eventLine({ type: "command_execution", command: "/bin/bash -lc 'git diff origin/main'",
  aggregated_output: "x".repeat(CODEX_WORKER_STDOUT_MAX_BYTES + CODEX_WORKER_STDOUT_MAX_BYTES / 16), exit_code: 0, status: "completed" });

function codexRun() {
  const home = mkdtempSync(join(tmpdir(), "rmd-w1t13960-"));
  const stdout = new PassThrough();
  const proc = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout });
  let childTmp: string | undefined;
  let resolveSpawned!: () => void;
  const spawned = new Promise<void>((resolve) => { resolveSpawned = resolve; });
  const run = spawnCodexWorker({
    workerHome: home, cwd: REPO_ROOT, prompt: "review", tools: ["Read"],
    settingsFile: join(REPO_ROOT, "settings/worker.json"),
    runId: "W1-T13960-test", taskId: "W1-T13960",
    containment: {
      spawn: (options: ContainedSpawnOptions) => {
        childTmp = options.env?.TMPDIR;
        resolveSpawned();
        return { process: proc as never, pid: 13960 };
      },
      teardown: () => { proc.emit("exit", null); },
    },
  }, { claudeBin: "/unused", root: home, workerProviders: { codexBin: "/bin/sh", codexModel: "gpt-6.2-sol" } });
  void run.catch(() => undefined);
  const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
  return {
    home, run, spawned,
    spillFile: () => join(childTmp!, "stdout-pending.jsonl"),
    /** Write in 8 KiB pieces, as a pipe delivers a long line. */
    write: async (text: string) => {
      for (let offset = 0; offset < text.length; offset += 8192) stdout.write(text.slice(offset, offset + 8192));
      await settle();
    },
    writeBytes: async (bytes: Buffer) => { stdout.write(bytes); await settle(); },
    start: () => stdout.write('{"type":"thread.started","thread_id":"spilled-run"}\n{"type":"turn.started"}\n'),
    end: (tail = TURN_COMPLETED, code = 0) => { stdout.end(tail); proc.emit("exit", code); },
    rows: () => readFileSync(join(home, "state/ledger.ndjson"), "utf8").trim().split("\n").map((line) => JSON.parse(line)),
  };
}

/** A completed stream whose one spilled line is an intermediate command item. */
async function completedButSpilled() {
  const child = codexRun();
  const line = oversizedCommand();
  child.start();
  await child.write(`${line}\n`);
  await child.write(`${eventLine({ type: "agent_message", text: FINAL })}\n`);
  child.end();
  return { child, line, result: await child.run };
}

test("W1-T13960 criterion 1: a completed Codex run whose one spilled line is an intermediate event returns success with its final message", async () => {
  const { child, result } = await completedButSpilled();
  try {
    // The spill really happened and really lost bytes inside the line (the measured shape).
    assert.ok((result.outputTruncation?.droppedBytes ?? 0) > 0, "the oversized line lost its middle");
    assert.equal(result.outputRetention?.stdout?.state, "truncated");
    assert.equal(result.outputRetention?.completion?.state, "complete");
    assert.equal(result.outputRetention?.originalSubtype, "success");
    assert.deepEqual(result.exit, { kind: "exit", code: 0 });
    assert.equal(result.text, FINAL, "the final message is intact");
    assert.equal(result.outputRetention?.text.state, "complete", "the final message's own line lost nothing");
    assert.equal(result.outputRetention?.blocks.state, "complete", "no retained block came from the cut line");
    assert.equal(result.subtype, "success");
    assert.equal(result.isError, false);
    // review.ts's reviewerOutcome is this subtype for an attempted, exited run, so the verdict lines are judged, not withheld.
    assert.equal(result.text.split("\n").filter((l) => /^REVIEW_VERDICT \d+: PASS/.test(l)).length, 2);
  } finally { rmSync(child.home, { recursive: true, force: true }); }
});

test("W1-T13960 criterion 2: a stream that ends without turn.completed for its final turn is still incomplete", async () => {
  const child = codexRun();
  try {
    child.start();
    await child.write(`${oversizedCommand()}\n`);
    await child.write(`${eventLine({ type: "agent_message", text: FINAL })}\n`);
    child.end("");
    const result = await child.run;
    assert.equal(result.outputRetention?.completion?.state, "incomplete");
    assert.equal(result.subtype, "error_incomplete_output");
    assert.equal(result.isError, true);
  } finally { rmSync(child.home, { recursive: true, force: true }); }
});

test("W1-T13960 criterion 2: a spilled line whose omitted bytes cut the JSON envelope fails the run", async () => {
  const child = codexRun();
  try {
    child.start();
    // The omitted middle lies between array numbers, not inside a string: the rebuilt line cannot parse.
    const numbers = Array.from({ length: (CODEX_WORKER_STDOUT_MAX_BYTES + CODEX_WORKER_STDOUT_MAX_BYTES / 16) / 2 }, () => 1);
    await child.write(`${eventLine({ type: "command_execution", command: "seq", aggregated_output: numbers })}\n`);
    await child.write(`${eventLine({ type: "agent_message", text: FINAL })}\n`);
    child.end();
    const result = await child.run;
    assert.ok((result.outputTruncation?.droppedBytes ?? 0) > 0, "the spill was rebuilt from its head and tail");
    assert.equal(result.subtype, "error_codex");
    assert.equal(result.isError, true);
    assert.match(result.permissionDenials.join("\n") + JSON.stringify(result.outputRetention), /truncated/);
  } finally { rmSync(child.home, { recursive: true, force: true }); }
});

test("W1-T13960 criterion 2: a spill read malformed or unreadable fails the run", async () => {
  for (const damage of ["malformed", "unreadable"] as const) {
    const child = codexRun();
    try {
      child.start();
      await child.spawned;
      const line = oversizedCommand();
      await child.write(line);
      assert.ok(existsSync(child.spillFile()), "the oversized line is spilling to its private file");
      if (damage === "malformed") writeFileSync(child.spillFile(), Buffer.concat([Buffer.from(line.slice(0, 1024)), Buffer.from([0xc3, 0x28])]));
      else {
        const target = `${child.spillFile()}.target`;
        writeFileSync(target, line);
        unlinkSync(child.spillFile());
        symlinkSync(target, child.spillFile());
      }
      await child.write("\n");
      await child.write(`${eventLine({ type: "agent_message", text: FINAL })}\n`);
      child.end();
      const result = await child.run;
      assert.equal(result.subtype, "error_codex", damage);
      assert.equal(result.isError, true, damage);
      assert.equal(result.outputRetention?.stdout?.state, damage, damage);
    } finally { rmSync(child.home, { recursive: true, force: true }); }
  }
});

test("W1-T13960 criterion 2: stdout that is not valid UTF-8 is still incomplete", async () => {
  const child = codexRun();
  try {
    child.start();
    const line = oversizedCommand();
    const cut = line.length / 2;
    await child.write(line.slice(0, cut));
    await child.writeBytes(Buffer.from([0xff]));
    await child.write(`${line.slice(cut)}\n`);
    await child.write(`${eventLine({ type: "agent_message", text: FINAL })}\n`);
    child.end();
    const result = await child.run;
    assert.equal(result.outputRetention?.stdout?.state, "malformed");
    assert.equal(result.subtype, "error_incomplete_output");
    assert.equal(result.isError, true);
  } finally { rmSync(child.home, { recursive: true, force: true }); }
});

test("W1-T13960 criterion 2: a final agent message that was itself the truncated line is still incomplete", async () => {
  const child = codexRun();
  try {
    child.start();
    await child.write(`${eventLine({ type: "agent_message", text: "first" })}\n`);
    const text = `${FINAL}\n${"y".repeat(CODEX_WORKER_STDOUT_MAX_BYTES + CODEX_WORKER_STDOUT_MAX_BYTES / 16)}\nEND`;
    await child.write(`${eventLine({ type: "agent_message", text })}\n`);
    child.end();
    const result = await child.run;
    assert.equal(result.outputRetention?.completion?.state, "complete");
    assert.equal(result.outputRetention?.text.state, "truncated");
    assert.match(result.text, /truncated.*\d+ bytes/);
    assert.equal(result.subtype, "error_incomplete_output");
    assert.equal(result.isError, true);
  } finally { rmSync(child.home, { recursive: true, force: true }); }
});

test("W1-T13960 step 2: an intermediate agent message that was the truncated line leaves only the blocks truncated", async () => {
  const child = codexRun();
  try {
    child.start();
    await child.write(`${eventLine({ type: "agent_message", text: "z".repeat(CODEX_WORKER_STDOUT_MAX_BYTES + CODEX_WORKER_STDOUT_MAX_BYTES / 16) })}\n`);
    await child.write(`${eventLine({ type: "agent_message", text: FINAL })}\n`);
    child.end();
    const result = await child.run;
    assert.equal(result.text, FINAL);
    assert.equal(result.outputRetention?.text.state, "complete");
    assert.equal(result.outputRetention?.blocks.state, "truncated");
    assert.equal(result.subtype, "error_incomplete_output");
    assert.equal(result.isError, true);
  } finally { rmSync(child.home, { recursive: true, force: true }); }
});

test("W1-T13960 criterion 3: the completed-but-spilled run still records its truncation", async () => {
  const { child, line, result } = await completedButSpilled();
  try {
    const stdout = result.outputRetention?.stdout;
    assert.equal(stdout?.state, "truncated");
    assert.equal(stdout?.fileBytes, Buffer.byteLength(line), "the spill evidence names the whole spilled line");
    assert.ok((stdout?.bytesRead ?? 0) > 0 && stdout!.bytesRead < stdout!.fileBytes!, "only a bounded tail was read");
    assert.ok(result.outputTruncation, "outputTruncation is reported");
    assert.equal(result.outputTruncation.limitBytes, CODEX_WORKER_STDOUT_MAX_BYTES);
    assert.equal(result.outputTruncation.spilledBytes, Buffer.byteLength(line));
    assert.ok(result.outputTruncation.droppedBytes > 0);
    const receipt = child.rows().find((row) => row.step === "worker.output_truncated");
    assert.ok(receipt, "the worker.output_truncated row is written");
    assert.equal(receipt.run_id, "W1-T13960-test");
    assert.deepEqual(receipt.output_truncation, result.outputTruncation);
    // The review.reviewer row spreads workerLedgerFields(reviewer): its output_retention still shows the spill.
    const fields = workerLedgerFields(result as Parameters<typeof workerLedgerFields>[0]);
    assert.deepEqual(fields.output_retention, result.outputRetention);
    assert.equal(fields.output_retention?.stdout?.state, "truncated");
  } finally { rmSync(child.home, { recursive: true, force: true }); }
});
