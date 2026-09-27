// W1-T4595: CODEX_WORKER_STDOUT_MAX_BYTES (1 MiB) capped the TOTAL stdout stream, although
// CodexJsonlAccumulator (W1-T3490) already parses it incrementally and keeps only the session id,
// token totals, agent-message blocks, errors and one unterminated line. MEASURED 2026-09-27: 98
// fleet builds died at 1.07-1.11 MB streamed — ordinary command output the heap never held. The
// budget now bounds what is RETAINED; a large backstop bounds the stream against a runaway process.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import {
  CODEX_WORKER_STDOUT_MAX_BYTES,
  CODEX_WORKER_STDOUT_STREAM_BACKSTOP_BYTES,
  isCodexWorkerOutputLimitError,
  spawnCodexWorker,
} from "../src/lib/worker-provider.js";

function fakeCodex(): { stdout: PassThrough; proc: EventEmitter; run: Promise<unknown>; home: string; teardowns: () => number } {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const proc = Object.assign(new EventEmitter(), { stdin, stdout, stderr });
  const home = mkdtempSync(join(tmpdir(), "rmd-w1t4595-home-"));
  let teardowns = 0;
  let exited = false;
  const run = spawnCodexWorker(
    {
      workerHome: home,
      cwd: process.cwd(),
      prompt: "retention budget",
      settingsFile: join(process.cwd(), "settings", "worker.json"),
      containment: {
        spawn: () => ({ process: proc as never, pid: 45_950 }),
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
  return { stdout, proc, run, home, teardowns: () => teardowns };
}

test("W1-T4595: a Codex worker streaming several MiB of ordinary events completes with its normal result", async () => {
  const codex = fakeCodex();
  try {
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

test("W1-T4595: a single unbounded line is still refused, and the stream keeps a large backstop", async () => {
  assert.ok(CODEX_WORKER_STDOUT_STREAM_BACKSTOP_BYTES >= 32 * CODEX_WORKER_STDOUT_MAX_BYTES, "the stream backstop sits far above the retention budget");
  const codex = fakeCodex();
  try {
    codex.stdout.write('{"type":"turn.started"');
    codex.stdout.write("x".repeat(CODEX_WORKER_STDOUT_MAX_BYTES + 1));
    await assert.rejects(codex.run, (error: unknown) => {
      assert.ok(isCodexWorkerOutputLimitError(error));
      assert.equal(error.stream, "stdout");
      assert.equal(error.limitBytes, CODEX_WORKER_STDOUT_MAX_BYTES, "the retention budget, not the backstop, refuses it");
      assert.ok(error.pendingLineBytes > CODEX_WORKER_STDOUT_MAX_BYTES, "what it held was one unterminated line");
      return true;
    });
    assert.equal(codex.teardowns(), 1);
  } finally {
    rmSync(codex.home, { recursive: true, force: true });
  }
});
