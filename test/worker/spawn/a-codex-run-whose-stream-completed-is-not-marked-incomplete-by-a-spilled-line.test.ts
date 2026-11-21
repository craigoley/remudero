// W1-T13960: a Codex run whose stream completed is not marked incomplete because ONE spilled intermediate stdout
// line kept only its bounded tail. The spawn decides completeness through codexResultRetentionComplete, a narrow
// upgrade over origin/main's result: only error_incomplete_output can become success, and only when the spill is
// the sole loss and the final turn's last agent message arrived on an intact line after every spilled line, then
// its turn.completed intact. A rebuilt line is never classified: whatever it parses as, a spill before the final
// verdict cannot hide it, and a spill after it could be it. Every other input keeps main's result, retention and
// dropped bytes, which the criterion 2 and 3 tests pin as main's literal values. A partial line never certifies.
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
    // Design step 2: the lost bytes fell in the command line, so the final text and the blocks read complete, while
    // the unaccounted spill keeps the run incomplete.
    assert.equal(result.outputRetention?.text.state, "complete");
    assert.equal(result.outputRetention?.blocks.state, "complete");
    assert.deepEqual(result.outputTruncation, { limitBytes: CODEX_WORKER_STDOUT_MAX_BYTES,
      retainedBytes: result.outputTruncation?.retainedBytes, droppedBytes: rebuiltDrop(fileBytes), spilledBytes: Buffer.byteLength(line) });
    const receipt = child.rows().find((row) => row.step === "worker.output_truncated");
    assert.deepEqual(receipt?.output_truncation, result.outputTruncation);
    assert.equal(result.subtype, "error_incomplete_output");
  } finally { rmSync(child.home, { recursive: true, force: true }); }
});

test("W1-T13960 criterion 1: a rebuilt spilled line before the final intact verdict certifies, whatever it parses as", async () => {
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
  // Round 5: the rebuilt line's shape is never read. It came before the final verdict's intact line, so it cannot
  // be that verdict, and the intact turn.completed follows: the run certifies.
  const certified = { completion: "complete", stdout: "truncated", subtype: "success", isError: false, rebuilt: true };
  assert.deepEqual(seen, Object.fromEntries(Object.keys(shapes).map((shape) => [shape, certified])));
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

test("W1-T13960 criterion 2: a rebuilt sole turn.completed never certifies, even with finite token counts", async () => {
  // Round 5: the final turn.completed must arrive intact. This one is the spill after the final message, so the
  // run keeps origin/main's result however valid the rebuilt line looks.
  const filler = "u".repeat(CODEX_WORKER_STDOUT_MAX_BYTES + CODEX_WORKER_STDOUT_MAX_BYTES / 16);
  assert.deepEqual(await soleCompletionSpilled({ type: "turn.completed",
    usage: { input_tokens: 100, cached_input_tokens: 25, output_tokens: 10 }, detail: filler }),
  { completion: "complete", stdout: "truncated", subtype: "error_incomplete_output", isError: true, rebuilt: true });
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

test("W1-T13960 criterion 1: an intermediate agent message that was the truncated line certifies the final verdict, and only its blocks read truncated", async () => {
  const child = codexRun();
  try {
    child.start();
    await child.write(`${eventLine({ type: "agent_message", text: "z".repeat(CODEX_WORKER_STDOUT_MAX_BYTES + CODEX_WORKER_STDOUT_MAX_BYTES / 16) })}\n`);
    await child.write(`${eventLine({ type: "agent_message", text: FINAL })}\n`);
    child.end();
    const result = await child.run;
    assert.equal(result.text, FINAL);
    // Design step 2: each label follows its own lines. The final text's line arrived whole, so text is complete; a
    // retained block came from the cut line, so blocks is truncated. Round 5: the cut line came before the final
    // verdict's intact line, so it cannot hide that verdict, and the run certifies.
    assert.equal(result.outputRetention?.text.state, "complete");
    assert.equal(result.outputRetention?.blocks.state, "truncated");
    assert.equal(result.subtype, "success");
    assert.equal(result.isError, false);
  } finally { rmSync(child.home, { recursive: true, force: true }); }
});

/** The head a spill keeps: the first 64 KiB of the line. */
const SPILL_HEAD_BYTES = 64 * 1024;
const LOST_FINAL = "REVIEW_VERDICT 1: FAIL — the final message was the spilled line";

/** A final agent message laid out so its spill's 64 KiB head ends inside its item type: the rebuild joins the type
 *  to the message's tail, which parses as an item of a type no Codex event has. */
function finalMessageCutInsideItsType(): string {
  const prefix = '{"type":"item.completed","item":{"id":"';
  const typeCut = '","type":"agent_mes';
  const id = "i".repeat(SPILL_HEAD_BYTES - prefix.length - typeCut.length);
  const line = eventLine({ id, type: "agent_message", text: `${"y".repeat(CODEX_WORKER_STDOUT_MAX_BYTES + CODEX_WORKER_STDOUT_MAX_BYTES / 16)}\n${LOST_FINAL}` });
  assert.equal(line.slice(SPILL_HEAD_BYTES - "agent_mes".length, SPILL_HEAD_BYTES), "agent_mes", "the head ends inside the item type");
  return line;
}

test("W1-T13960 criterion 2: a spilled line that could be the final agent message never certifies an earlier verdict", async () => {
  const filler = "c".repeat(CODEX_WORKER_STDOUT_MAX_BYTES + CODEX_WORKER_STDOUT_MAX_BYTES / 16);
  const lines = {
    "a final message whose head ends inside its item type": finalMessageCutInsideItsType(),
    "an item of a type this file does not read": eventLine({ type: "future_item", text: filler }),
    "a command item that also names agent_message": `{"type":"item.completed","item":{"type":"agent_message","text":"${filler}","type":"command_execution"}}`,
  };
  const seen: Record<string, unknown> = {};
  for (const [shape, line] of Object.entries(lines)) {
    const child = codexRun();
    try {
      child.start();
      await child.write(`${eventLine({ type: "agent_message", text: FINAL })}\n`);
      await child.write(`${line}\n`);
      child.end();
      const result = await child.run;
      seen[shape] = { ...outcome(result), rebuilt: (result.outputTruncation?.droppedBytes ?? 0) > 0,
        text: result.outputRetention?.text.state, blocks: result.outputRetention?.blocks.state };
    } finally { rmSync(child.home, { recursive: true, force: true }); }
  }
  // origin/main's literal result: the rebuilt line drops bytes, so the run is incomplete and its text truncated. The
  // earlier PASS is not the final message once a later line could have been one.
  const main = { completion: "complete", stdout: "truncated", subtype: "error_incomplete_output", isError: true, rebuilt: true,
    text: "truncated", blocks: "truncated" };
  assert.deepEqual(seen, Object.fromEntries(Object.keys(lines).map((shape) => [shape, main])));
});

test("W1-T13960 criterion 2: a final turn with no agent message of its own does not certify an earlier turn's verdict", async () => {
  const child = codexRun();
  try {
    child.start();
    await child.write(`${eventLine({ type: "agent_message", text: FINAL })}\n${TURN_COMPLETED}{"type":"turn.started"}\n`);
    await child.write(`${oversizedCommand()}\n`);
    child.end();
    const result = await child.run;
    assert.equal(result.outputRetention?.completion?.state, "complete");
    assert.ok((result.outputTruncation?.droppedBytes ?? 0) > 0, "the final turn's spill was rebuilt");
    assert.equal(result.text, FINAL, "the text is the earlier turn's message");
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

/** Run `before`, the intact verdict, then `after`, and close with `end`'s tail; the outcome, labels and drop. */
async function aroundTheVerdict(before: string[], after: string[] = [], tail = TURN_COMPLETED, verdict = FINAL) {
  const child = codexRun();
  try {
    child.start();
    for (const line of before) await child.write(`${line}\n`);
    await child.write(`${eventLine({ type: "agent_message", text: verdict })}\n`);
    for (const line of after) await child.write(`${line}\n`);
    child.end(tail);
    const result = await child.run;
    return { ...outcome(result), rebuilt: (result.outputTruncation?.droppedBytes ?? 0) > 0, text: result.text === verdict,
      textState: result.outputRetention?.text.state, blocksState: result.outputRetention?.blocks.state };
  } finally { rmSync(child.home, { recursive: true, force: true }); }
}

const CERTIFIED = { completion: "complete", stdout: "truncated", subtype: "success", isError: false, rebuilt: true, text: true,
  textState: "complete", blocksState: "complete" };

test("W1-T13960 criterion 1: an oversized mcp_tool_call spilled mid-turn, then an intact verdict and turn.completed, returns success", async () => {
  // Round 5 finding 1: Round 4's allowlist of item types left out mcp_tool_call, so this run was refused.
  const mcp = eventLine({ id: "item_3", type: "mcp_tool_call", server: "github", tool: "get_file_contents", arguments: { path: "src" },
    result: { content: [{ type: "text", text: "m".repeat(CODEX_WORKER_STDOUT_MAX_BYTES + CODEX_WORKER_STDOUT_MAX_BYTES / 16) }] },
    status: "completed" });
  assert.deepEqual(await aroundTheVerdict([mcp]), CERTIFIED);
});

test("W1-T13960 criterion 1: a command item whose command is agent_message, spilled before the verdict, returns success", async () => {
  // Round 5 finding 1: Round 4 scanned every string of a rebuilt line for the agent_message token.
  const command = eventLine({ type: "command_execution", command: "agent_message",
    aggregated_output: "x".repeat(CODEX_WORKER_STDOUT_MAX_BYTES + CODEX_WORKER_STDOUT_MAX_BYTES / 16), exit_code: 0, status: "completed" });
  assert.match(command.slice(0, SPILL_HEAD_BYTES), /"command":"agent_message"/, "the token is in the kept head");
  assert.deepEqual(await aroundTheVerdict([command]), CERTIFIED);
});

/** A final agent message whose spill rebuilds into a valid command_execution item: the kept head ends inside its
 *  text, the item type sits in the omitted middle, and the kept tail starts inside a second string whose object
 *  names a command. The original line is a genuine agent message whose text is a FAIL verdict. */
function finalMessageRebuiltAsCommand(): string {
  const text = `${LOST_FINAL}\n${"y".repeat(CODEX_WORKER_STDOUT_MAX_BYTES)}`;
  const line = `{"type":"item.completed","item":{"text":${JSON.stringify(text)},"type":"agent_message"},`
    + `"x":{"y":"${"q".repeat(256 * 1024)}","type":"command_execution","command":"ls","status":"completed"}}`;
  const original = JSON.parse(line);
  assert.equal(original.item.type, "agent_message", "the original line is the final agent message");
  assert.equal(original.item.text, text);
  assert.ok(!line.slice(0, SPILL_HEAD_BYTES).includes("agent_message") && !line.slice(-256 * 1024).includes("agent_message"),
    "neither kept end names agent_message");
  return line;
}

test("W1-T13960 criterion 2: a final message spilled and rebuilt into a valid command_execution never certifies an earlier PASS", async () => {
  // Round 5 finding 2: the rebuilt line parses as a command item, and the earlier PASS was returned as success.
  assert.deepEqual(await aroundTheVerdict([], [finalMessageRebuiltAsCommand()]), {
    completion: "complete", stdout: "truncated", subtype: "error_incomplete_output", isError: true, rebuilt: true, text: true,
    textState: "truncated", blocksState: "truncated" });
});

test("W1-T13960 criterion 2: a spill after the last intact agent message, in the final turn, never certifies", async () => {
  // A plain command item: nothing in its rebuilt bytes looks like a message, yet a spill after the last intact
  // message could have been a later one, so origin/main's result stands.
  assert.deepEqual(await aroundTheVerdict([], [oversizedCommand()]), {
    completion: "complete", stdout: "truncated", subtype: "error_incomplete_output", isError: true, rebuilt: true, text: true,
    textState: "truncated", blocksState: "truncated" });
});

test("W1-T13960 criterion 2: a final message after its turn's turn.completed does not certify a spill", async () => {
  // The final turn's turn.completed must arrive intact AFTER its last message. Here it precedes the message.
  assert.deepEqual(await aroundTheVerdict([oversizedCommand(), TURN_COMPLETED.trimEnd()], [], ""), {
    completion: "complete", stdout: "truncated", subtype: "error_incomplete_output", isError: true, rebuilt: true, text: true,
    textState: "complete", blocksState: "complete" });
});
