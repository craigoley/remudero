// W1-T13960: a Codex run whose stream completed is not marked incomplete because ONE spilled intermediate stdout
// line kept only its bounded tail. The spawn decides completeness through codexResultRetentionComplete, a narrow
// upgrade over origin/main's result: only error_incomplete_output can become success, and only when the spill is
// the sole loss and every spilled line rebuilt into a valid event. Every other input keeps main's result, retention
// and dropped bytes, which the criterion 2 and 3 tests pin as main's literal values. A partial line never certifies.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
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
const oversizedCommand = (outputBytes = CODEX_WORKER_STDOUT_MAX_BYTES + CODEX_WORKER_STDOUT_MAX_BYTES / 16) =>
  eventLine({ type: "command_execution", command: "/bin/bash -lc 'git diff origin/main'",
    aggregated_output: "x".repeat(outputBytes), exit_code: 0, status: "completed" });

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
    /** Wait until the spill file holds exactly `bytes`: every written piece has reached it, so a change made next
     *  lands after the line's last bytes rather than racing the pieces still in the pipe. */
    spillHolds: async (bytes: number) => {
      const file = join(childTmp!, "stdout-pending.jsonl");
      while (!(existsSync(file) && statSync(file).size === bytes)) await settle();
    },
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

/** What decides a run's fate, per variant, so one red names every variant that went wrong. */
const outcome = (result: Awaited<ReturnType<typeof spawnCodexWorker>>) => ({
  completion: result.outputRetention?.completion?.state,
  stdout: result.outputRetention?.stdout?.state,
  subtype: result.subtype,
  isError: result.isError,
});

test("W1-T13960 criterion 2: a spill removed just before its newline returns origin/main's success; one absent at EOF fails", async () => {
  const seen: Record<string, unknown> = {};
  for (const at of ["newline", "eof"] as const) {
    const child = codexRun();
    try {
      child.start();
      await child.spawned;
      const line = oversizedCommand();
      await child.write(line);
      await child.spillHolds(Buffer.byteLength(line));
      // The last stdout bytes of the line are in; the spill goes before it is read back. At the newline origin/main's
      // empty append recreates the file empty, so the line reads as nothing; at EOF the read finds no file.
      unlinkSync(child.spillFile());
      if (at === "newline") {
        await child.write("\n");
        await child.write(`${eventLine({ type: "agent_message", text: FINAL })}\n`);
        child.end();
      } else child.end("");
      const result = await child.run;
      seen[at] = { ...outcome(result), droppedBytes: result.outputTruncation?.droppedBytes };
    } finally { rmSync(child.home, { recursive: true, force: true }); }
  }
  // The literal results of origin/main (merge-base ed3d78aaa9) for these streams: the spill accounting may only veto
  // an upgrade, so it never turns main's success into error_codex.
  assert.deepEqual(seen, {
    newline: { completion: "complete", stdout: "complete", subtype: "success", isError: false, droppedBytes: 0 },
    eof: { completion: "incomplete", stdout: "absent", subtype: "error_codex", isError: true, droppedBytes: 0 },
  });
});

/** The bytes origin/main drops rebuilding a spill of `fileBytes` ASCII bytes: all but its 64 KiB head and 256 KiB tail. */
const rebuiltDrop = (fileBytes: number) => fileBytes - 64 * 1024 - 256 * 1024;
const MID_LINE_OUTPUT = 2 * CODEX_WORKER_STDOUT_MAX_BYTES;
const MID_LINE_CUT = CODEX_WORKER_STDOUT_MAX_BYTES + CODEX_WORKER_STDOUT_MAX_BYTES / 8;

/** A completed stream whose spill file goes mid-line, once the spill has begun: the next append recreates it holding
 *  only the rest of the line, more than the bounded tail, so the read is rebuilt from the line's head and a shorter
 *  file than the bytes spilled for it. */
async function spillRecreatedShorterMidLine() {
  const child = codexRun();
  child.start();
  await child.spawned;
  const line = oversizedCommand(MID_LINE_OUTPUT);
  await child.write(line.slice(0, MID_LINE_CUT));
  await child.spillHolds(MID_LINE_CUT);
  unlinkSync(child.spillFile());
  await child.write(line.slice(MID_LINE_CUT));
  await child.write("\n");
  await child.write(`${eventLine({ type: "agent_message", text: FINAL })}\n`);
  child.end();
  return { child, line, result: await child.run };
}

test("W1-T13960 criterion 2: a spill whose file no longer holds every byte spilled for its line keeps origin/main's result", async () => {
  const seen: Record<string, unknown> = {};
  const expected: Record<string, unknown> = {};
  for (const damage of ["recreated-empty-after-an-earlier-rebuild", "unlinked-mid-line"] as const) {
    let child: ReturnType<typeof codexRun> | undefined;
    try {
      let result: Awaited<ReturnType<typeof spawnCodexWorker>>;
      if (damage === "recreated-empty-after-an-earlier-rebuild") {
        // An earlier spilled line is rebuilt and parses; the later one's file is recreated empty before its read,
        // so the later line reads as nothing: no rebuilt line is rejected, yet a spill lost its bytes.
        child = codexRun();
        child.start();
        await child.spawned;
        const line = oversizedCommand();
        await child.write(`${line}\n`);
        await child.write(line);
        await child.spillHolds(Buffer.byteLength(line));
        writeFileSync(child.spillFile(), "");
        await child.write("\n");
        await child.write(`${eventLine({ type: "agent_message", text: FINAL })}\n`);
        child.end();
        result = await child.run;
        expected[damage] = rebuiltDrop(Buffer.byteLength(line));
      } else {
        const run = await spillRecreatedShorterMidLine();
        child = run.child;
        result = run.result;
        expected[damage] = rebuiltDrop(Buffer.byteLength(run.line) - MID_LINE_CUT);
      }
      seen[damage] = { ...outcome(result), droppedBytes: result.outputTruncation?.droppedBytes };
    } finally { if (child) rmSync(child.home, { recursive: true, force: true }); }
  }
  // origin/main's literal results: the run stays incomplete, stdout truncated, and the dropped bytes are main's.
  const main = (droppedBytes: unknown) => ({ completion: "complete", stdout: "truncated", subtype: "error_incomplete_output",
    isError: true, droppedBytes });
  assert.deepEqual(seen, Object.fromEntries(Object.entries(expected).map(([damage, bytes]) => [damage, main(bytes)])));
});

test("W1-T13960 criterion 3: a spill recreated shorter mid-line keeps origin/main's truncated stdout and dropped bytes", async () => {
  const { child, line, result } = await spillRecreatedShorterMidLine();
  try {
    const fileBytes = Buffer.byteLength(line) - MID_LINE_CUT;
    // origin/main reads the shorter file as truncated and counts its omitted middle; 589,992 bytes for this fixture.
    assert.equal(rebuiltDrop(fileBytes), 589_992);
    assert.equal(result.outputRetention?.stdout?.state, "truncated");
    assert.equal(result.outputRetention?.stdout?.fileBytes, fileBytes);
    assert.equal(result.outputRetention?.text.state, "truncated");
    assert.equal(result.outputRetention?.blocks.state, "truncated");
    assert.deepEqual(result.outputTruncation, { limitBytes: CODEX_WORKER_STDOUT_MAX_BYTES,
      retainedBytes: result.outputTruncation?.retainedBytes, droppedBytes: rebuiltDrop(fileBytes), spilledBytes: Buffer.byteLength(line) });
    const receipt = child.rows().find((row) => row.step === "worker.output_truncated");
    assert.deepEqual(receipt?.output_truncation, result.outputTruncation);
    assert.equal(result.subtype, "error_incomplete_output");
  } finally { rmSync(child.home, { recursive: true, force: true }); }
});

test("W1-T13960 criterion 2: a rebuilt spilled line that parses but is not a Codex event envelope does not certify", async () => {
  const filler = "x".repeat(CODEX_WORKER_STDOUT_MAX_BYTES + CODEX_WORKER_STDOUT_MAX_BYTES / 16);
  const shapes = {
    "a JSON string": JSON.stringify(filler),
    "an array": JSON.stringify([filler]),
    "an object without a type": JSON.stringify({ payload: filler }),
    "an item that is not an object": JSON.stringify({ type: "item.completed", item: filler }),
    "an item.completed with no item": JSON.stringify({ type: "item.completed", payload: filler }),
    "an item without a string type": JSON.stringify({ type: "item.completed", item: { kind: "command_execution", payload: filler } }),
    "an agent message without a string text": JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: [filler] } }),
  };
  const seen: Record<string, unknown> = {};
  for (const [shape, line] of Object.entries(shapes)) {
    const child = codexRun();
    try {
      child.start();
      await child.write(`${line}\n`);
      await child.write(`${eventLine({ type: "agent_message", text: FINAL })}\n`);
      child.end();
      const result = await child.run;
      seen[shape] = { ...outcome(result), rebuilt: (result.outputTruncation?.droppedBytes ?? 0) > 0 };
    } finally { rmSync(child.home, { recursive: true, force: true }); }
  }
  // As on origin/main: the spill was rebuilt from its head and tail, and the run stays incomplete.
  const incomplete = { completion: "complete", stdout: "truncated", subtype: "error_incomplete_output", isError: true, rebuilt: true };
  assert.deepEqual(seen, Object.fromEntries(Object.keys(shapes).map((shape) => [shape, incomplete])));
});

/** A completed stream whose sole turn.completed is the spilled, rebuilt line. */
async function soleCompletionSpilled(completion: Record<string, unknown>) {
  const child = codexRun();
  try {
    child.start();
    await child.write(`${eventLine({ type: "agent_message", text: FINAL })}\n`);
    await child.write(`${JSON.stringify(completion)}\n`);
    child.end("");
    const result = await child.run;
    return { ...outcome(result), rebuilt: (result.outputTruncation?.droppedBytes ?? 0) > 0 };
  } finally { rmSync(child.home, { recursive: true, force: true }); }
}

test("W1-T13960 criterion 2: a rebuilt turn.completed whose usage is not an object of token counts does not certify", async () => {
  const filler = "u".repeat(CODEX_WORKER_STDOUT_MAX_BYTES + CODEX_WORKER_STDOUT_MAX_BYTES / 16);
  const seen = {
    "a string usage": await soleCompletionSpilled({ type: "turn.completed", usage: filler }),
    "a string token count": await soleCompletionSpilled({ type: "turn.completed", usage: { input_tokens: filler, output_tokens: 10 } }),
  };
  // As on origin/main: the final turn completed and the spill was rebuilt, and the run stays incomplete.
  const incomplete = { completion: "complete", stdout: "truncated", subtype: "error_incomplete_output", isError: true, rebuilt: true };
  assert.deepEqual(seen, { "a string usage": incomplete, "a string token count": incomplete });
});

test("W1-T13960 criterion 1: a rebuilt sole turn.completed whose usage holds finite token counts certifies its spill", async () => {
  // The positive control for the usage check: the same stream, the omitted bytes in a field beside a valid usage.
  const filler = "u".repeat(CODEX_WORKER_STDOUT_MAX_BYTES + CODEX_WORKER_STDOUT_MAX_BYTES / 16);
  assert.deepEqual(await soleCompletionSpilled({ type: "turn.completed",
    usage: { input_tokens: 100, cached_input_tokens: 25, output_tokens: 10 }, detail: filler }),
  { completion: "complete", stdout: "truncated", subtype: "success", isError: false, rebuilt: true });
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

test("W1-T13960 criterion 2: an intermediate agent message that was the truncated line is still incomplete, as on origin/main", async () => {
  const child = codexRun();
  try {
    child.start();
    await child.write(`${eventLine({ type: "agent_message", text: "z".repeat(CODEX_WORKER_STDOUT_MAX_BYTES + CODEX_WORKER_STDOUT_MAX_BYTES / 16) })}\n`);
    await child.write(`${eventLine({ type: "agent_message", text: FINAL })}\n`);
    child.end();
    const result = await child.run;
    assert.equal(result.text, FINAL);
    // Not upgraded, so the retention is origin/main's: any dropped byte reads text and blocks truncated.
    assert.equal(result.outputRetention?.text.state, "truncated");
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
