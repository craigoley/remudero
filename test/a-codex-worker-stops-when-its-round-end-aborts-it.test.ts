import assert from "node:assert/strict";
import { EventEmitter, getEventListeners } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { spawnCodexWorker } from "#src/lib/worker-provider.js";

// W1-T9245: `end_round` pushes the checkpoint and then aborts the spawn's signal. The Claude path chains that signal into the
// SDK's abort; these drive the REAL Codex adapter with a fake contained process and a counting teardown, so the only thing
// that can stop the fake is the adapter reading `args.signal`. The fake never exits on its own while a turn is running.
function codexWorker(signal: AbortSignal) {
  const home = mkdtempSync(join(tmpdir(), "rmd-w1t9245-"));
  const stdout = new PassThrough();
  const proc = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout });
  let exited = false;
  let teardownsWhileRunning = 0;
  let teardowns = 0;
  const exit = (code: number | null, sig: NodeJS.Signals | null = null) => {
    if (exited) return;
    exited = true;
    proc.emit("exit", code, sig);
  };
  let settled = false;
  const run = spawnCodexWorker({
    workerHome: home, cwd: process.cwd(), prompt: "round-end abort", tools: ["Read"],
    settingsFile: join(process.cwd(), "settings/worker.json"),
    runId: "W1-T9001-1791904881258", taskId: "W1-T9245",
    signal,
    containment: {
      spawn: () => ({ process: proc as never, pid: 9245 }),
      // A group kill: the contained process exits on the signal, as `teardownProcessGroup` makes a real one do.
      teardown: () => {
        teardowns++;
        if (!exited) teardownsWhileRunning++;
        exit(null, "SIGTERM");
      },
    },
  }, { claudeBin: "/unused", root: home, workerProviders: { codexBin: "/bin/sh", codexModel: "gpt-6.1-sol" } });
  void run.then(() => { settled = true; }, () => { settled = true; });
  stdout.write('{"type":"thread.started","thread_id":"round-end"}\n{"type":"turn.started"}\n');
  return {
    home, run, exit,
    teardowns: () => teardowns,
    teardownsWhileRunning: () => teardownsWhileRunning,
    settled: () => settled,
    // The worker keeps streaming activity after the checkpoint, as W1-T9001's Codex rounds did for 353-798 s.
    activity: (text: string) => stdout.write(`${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } })}\n`),
    finishTurn: () => {
      stdout.end('{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":0,"output_tokens":5}}\n');
      exit(0);
    },
  };
}

const abortListeners = (signal: AbortSignal) => getEventListeners(signal, "abort").length;
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("W1-T9245: an abort mid-turn tears the codex process group down once", async () => {
  const abort = new AbortController();
  const child = codexWorker(abort.signal);
  try {
    child.activity("editing after the checkpoint");
    await tick();
    assert.equal(child.teardowns(), 0, "a running turn is left alone until the round end aborts it");
    assert.equal(child.settled(), false);

    abort.abort();
    assert.equal(child.teardownsWhileRunning(), 1, "the abort tears the running group down in the same tick");
    child.activity("still streaming as the group dies");
    abort.abort();

    const result = await child.run;
    assert.equal(child.teardowns(), 1, "the abort, a repeated abort and the post-exit cleanup tear down ONCE");
    assert.deepEqual(result.exit, { kind: "signal", signal: "SIGTERM" });
    assert.equal(result.isError, true, "a torn-down worker is never a clean exit");
    assert.equal(abortListeners(abort.signal), 0, "the settled spawn leaves no abort listener");
  } finally { rmSync(child.home, { recursive: true, force: true }); }
});

test("W1-T9245: a signal aborted before spawn tears the codex worker down at once", async () => {
  const child = codexWorker(AbortSignal.abort());
  try {
    assert.equal(child.teardownsWhileRunning(), 1, "an already-aborted signal tears down as soon as the process exists");
    const result = await child.run;
    assert.equal(child.teardowns(), 1);
    assert.deepEqual(result.exit, { kind: "signal", signal: "SIGTERM" });
    assert.equal(result.isError, true);
  } finally { rmSync(child.home, { recursive: true, force: true }); }
});

test("W1-T9245: an unaborted codex worker is never torn down and leaves no listener", async () => {
  const abort = new AbortController();
  const child = codexWorker(abort.signal);
  try {
    child.activity("working");
    await tick();
    assert.equal(abortListeners(abort.signal), 1, "positive control: the running spawn listens for the round end");
    assert.equal(child.teardowns(), 0);

    child.activity("REPORT\nCOMMIT_MESSAGE: fix(worker): done");
    child.finishTurn();
    const result = await child.run;
    assert.equal(child.teardownsWhileRunning(), 0, "a spawn whose signal never aborts is never torn down mid-turn");
    assert.deepEqual(result.exit, { kind: "exit", code: 0 });
    assert.equal(result.isError, false);
    assert.equal(abortListeners(abort.signal), 0, "the exited spawn removed its abort listener");

    const before = child.teardowns();
    abort.abort();
    assert.equal(child.teardowns(), before, "an abort after exit reaches no teardown");
  } finally { rmSync(child.home, { recursive: true, force: true }); }
});
