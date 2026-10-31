// W1-T4595: CODEX_WORKER_STDOUT_MAX_BYTES (1 MiB) capped the TOTAL stdout stream, although
// CodexJsonlAccumulator (W1-T3490) already parses it incrementally and keeps only the session id,
// token totals, agent-message blocks, errors and one unterminated line. MEASURED 2026-09-27: 98
// fleet builds died at 1.07-1.11 MB streamed — ordinary command output the heap never held. The
// budget now bounds what is RETAINED; a large backstop bounds the stream against a runaway process.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { fixWorkerReceipt, WORKER_TAIL_MAX_BYTES } from "#src/run-task.js";
import type { WorkerResult } from "#src/lib/worker.js";
import {
  CODEX_WORKER_STDOUT_MAX_BYTES,
  CODEX_WORKER_STDOUT_STREAM_BACKSTOP_BYTES,
  isCodexWorkerOutputLimitError,
  spawnCodexWorker,
} from "#src/lib/worker-provider.js";

function fakeCodex(streamObserver?: Parameters<typeof spawnCodexWorker>[0]["streamObserver"]): { stdout: PassThrough; proc: EventEmitter; run: Promise<unknown>; home: string; teardowns: () => number; spawned: Promise<void> } {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const proc = Object.assign(new EventEmitter(), { stdin, stdout, stderr });
  const home = mkdtempSync(join(tmpdir(), "rmd-w1t4595-home-"));
  let teardowns = 0;
  let exited = false;
  // This call omits `tools`, which `codexReadOnly` treats as a writer, so `spawnCodexWorker` now
  // awaits the async Git-worktree probe BEFORE calling `containment.spawn`. An `exit` emitted
  // before that callback runs has no listener yet and is lost, hanging `await run` forever —
  // `spawned` lets every call site wait for the real attach point first.
  let markSpawned!: () => void;
  const spawned = new Promise<void>((resolve) => { markSpawned = resolve; });
  const run = spawnCodexWorker(
    {
      workerHome: home,
      streamObserver,
      cwd: process.cwd(),
      prompt: "retention budget",
      settingsFile: join(process.cwd(), "settings", "worker.json"),
      containment: {
        spawn: () => { markSpawned(); return { process: proc as never, pid: 45_950 }; },
        teardown: () => {
          teardowns += 1;
          if (!exited) {
            exited = true;
            proc.emit("exit", null);
          }
        },
      },
    },
    { claudeBin: "/unused", root: "/tmp", workerProviders: { enabled: ["codex"], codexBin: "/bin/sh", codexModel: "gpt-6-luna" } },
  );
  return { stdout, proc, run, home, teardowns: () => teardowns, spawned };
}

test("W1-T4595: a Codex worker streaming several MiB of ordinary events completes with its normal result", async () => {
  const codex = fakeCodex();
  try {
    await codex.spawned;
    codex.stdout.write('{"type":"thread.started","thread_id":"long-run"}\n{"type":"turn.started"}\n');
    // 3 MiB of ordinary completed command output: parsed and discarded, never retained.
    const output = "x".repeat(64 * 1024);
    for (let i = 0; i < 48; i++) {
      codex.stdout.write(`${JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "npm test", aggregated_output: output } })}\n`);
    }
    codex.stdout.write('{"type":"item.completed","item":{"type":"agent_message","text":"done"}}\n');
    codex.stdout.write('{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":25,"output_tokens":10}}\n');
    codex.stdout.end();
    codex.proc.emit("exit", 0);

    const result = (await codex.run) as { text: string; sessionId: string; isError: boolean };
    assert.equal(result.sessionId, "long-run");
    assert.equal(result.text, "done", "the ordinary result shape survives a stream past the old 1 MiB total cap");
    assert.equal(result.isError, false);
  } finally {
    rmSync(codex.home, { recursive: true, force: true });
  }
});

test("W1-T4595: an oversized unfinished line spills and fails on exit, and the stream keeps a large backstop", { timeout: 5000 }, async () => {
  assert.ok(CODEX_WORKER_STDOUT_STREAM_BACKSTOP_BYTES >= 32 * CODEX_WORKER_STDOUT_MAX_BYTES, "the stream backstop sits far above the retention budget");
  const codex = fakeCodex();
  try {
    await codex.spawned;
    codex.stdout.write('{"type":"turn.started"');
    codex.stdout.write("x".repeat(CODEX_WORKER_STDOUT_MAX_BYTES + 1));
    assert.equal(codex.teardowns(), 0, "retention pressure does not terminate the worker");
    codex.stdout.end();
    codex.proc.emit("exit", 0);
    const result = (await codex.run) as {
      text: string; isError: boolean; subtype: string;
      outputTruncation?: { limitBytes: number; retainedBytes: number; spilledBytes: number };
    };
    assert.equal(result.isError, true, "malformed output without a result still fails");
    assert.equal(result.subtype, "error_codex");
    assert.equal(result.text, "");
    assert.ok(result.outputTruncation);
    assert.equal(result.outputTruncation.limitBytes, CODEX_WORKER_STDOUT_MAX_BYTES);
    assert.ok(result.outputTruncation.retainedBytes <= CODEX_WORKER_STDOUT_MAX_BYTES);
    assert.equal(result.outputTruncation.spilledBytes,
      Buffer.byteLength('{"type":"turn.started"') + CODEX_WORKER_STDOUT_MAX_BYTES + 1);
    assert.equal(codex.teardowns(), 1);
  } finally {
    rmSync(codex.home, { recursive: true, force: true });
  }
});

test("W1-T4595: the stream backstop refuses runaway ordinary events after they are discarded", async () => {
  const codex = fakeCodex();
  try {
    await codex.spawned;
    const event = `${JSON.stringify({
      type: "item.completed",
      item: { type: "command_execution", command: "npm test", aggregated_output: "x".repeat(256 * 1024) },
    })}\n`;
    const eventBytes = Buffer.byteLength(event, "utf8");
    const eventsToExceed = Math.floor(CODEX_WORKER_STDOUT_STREAM_BACKSTOP_BYTES / eventBytes) + 1;
    for (let i = 0; i < eventsToExceed; i++) codex.stdout.write(event);

    await assert.rejects(codex.run, (error: unknown) => {
      assert.ok(isCodexWorkerOutputLimitError(error));
      assert.equal(error.stream, "stdout");
      assert.equal(error.limitBytes, CODEX_WORKER_STDOUT_STREAM_BACKSTOP_BYTES);
      assert.equal(error.observedBytes, eventsToExceed * eventBytes);
      assert.equal(error.pendingLineBytes, 0, "every accepted event was a complete line");
      assert.equal(error.eventBytesByKind["item.completed:command_execution"], (eventsToExceed - 1) * eventBytes);
      return true;
    });
    assert.equal(codex.teardowns(), 1);
  } finally {
    rmSync(codex.home, { recursive: true, force: true });
  }
});


test("completed Codex messages reach the retained native fix tail without raw command output", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-codex-tail-"));
  let start!: (f: ReturnType<typeof fakeCodex>) => void;
  const started = new Promise<ReturnType<typeof fakeCodex>>(resolve => { start = resolve; });
  const receipt = fixWorkerReceipt(async args => {
    const f = fakeCodex(args.streamObserver);
    start(f);
    const parsed = await f.run as Awaited<ReturnType<typeof spawnCodexWorker>>;
    return { ...parsed, costUsd: 0, stderr: "", apiError: false, permissionDenials: [], childEnvKeys: [],
      model: "fixture", effort: "default", modelUsage: {}, compactionEvents: [], qualitySuspect: false } as WorkerResult;
  }, () => {}, "fixture-worker", {}, undefined, { root });
  const pending = receipt.spawn({ cwd: root, prompt: "fixture", settingsFile: join(root, "settings.json"), permissionMode: "default" });
  const f = await started;
  try {
    await f.spawned;
    f.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "command_execution", aggregated_output: "DO_NOT_RETAIN_RAW_COMMAND_OUTPUT" } }) + "\n");
    const wire = JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "SWC validation remains unmeasured" } }) + "\n";
    f.stdout.write(wire.slice(0, 19));
    f.stdout.write(wire.slice(19));
    f.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Final diagnosis requires retained evidence" } }) + "\n");
    f.stdout.end(); f.proc.emit("exit", 0);
    const result = await pending;
    const path = join(root, "state", "runs", "fixture-worker.tail");
    assert.ok(existsSync(path), "the actual fix receipt writes the provider's completed message text");
    const tail = readFileSync(path, "utf8");
    assert.match(tail, /SWC validation remains unmeasured/);
    assert.match(tail, /Final diagnosis requires retained evidence/);
    assert.doesNotMatch(tail, /DO_NOT_RETAIN_RAW_COMMAND_OUTPUT/);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.ok(statSync(path).size <= WORKER_TAIL_MAX_BYTES);
    assert.equal(result.text, "Final diagnosis requires retained evidence");
    assert.equal(result.isError, false);
  } finally { rmSync(f.home, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true }); }
});
