/**
 * #8429: a board worker that CRASHES emits 'error' and then 'exit'. The exit used to overwrite
 * `worker_crashed: <message>` with `worker_exited: 1`, so the readiness report lost the one
 * diagnostic that said why `board_computed` is false. An exit with no crash before it still names
 * its own code, so the fix cannot pass by dropping the exit reason.
 */
import assert from "node:assert/strict";
import { subscribe, unsubscribe } from "node:diagnostics_channel";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Worker } from "node:worker_threads";
import { createBoardProjectionWorker, type BoardProjectionWorker } from "#src/lib/board-worker.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { fakeGitHub } from "#test/helpers/fake-github.js";

function boardPaths() {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}board-crash-`));
  return { planPath: join(root, "tasks.yaml"), ledgerPath: join(root, "ledger.ndjson"), inflightDir: join(root, "inflight") };
}

/**
 * Starts a board on `workerUrl` and resolves once its thread has exited. Node publishes each new
 * thread on the `worker_threads` diagnostics channel INSIDE its constructor, so a subscription held
 * only across `start()` sees the board's thread and no other; `process`'s 'worker' event fires a
 * tick later and, on a cold tsx cache, handed over an earlier thread that never exits. The exit
 * listener is attached after `start()` attached the board's own, so it runs second: the board has
 * handled the exit when this resolves.
 */
async function startUntilExit(workerUrl: URL): Promise<{ board: BoardProjectionWorker; code: number }> {
  const board = createBoardProjectionWorker(fakeGitHub(), boardPaths(), { workerUrl, intervalMs: 60_000 });
  let thread: Worker | undefined;
  const capture = (message: unknown): void => {
    thread = (message as { worker: Worker }).worker;
  };
  subscribe("worker_threads", capture);
  try {
    board.start();
  } finally {
    unsubscribe("worker_threads", capture);
  }
  assert.ok(thread, "the board spawned its thread");
  const code = await new Promise<number>((resolve) => thread!.once("exit", resolve));
  return { board, code };
}

test("a crashed board worker keeps its crash message after its exit follows", { timeout: 30_000 }, async () => {
  const { board, code } = await startUntilExit(new URL('data:text/javascript,throw new Error("forced board worker crash")'));
  try {
    assert.equal(code, 1, "the crash is followed by an exit, the sequence that used to erase it");
    const current = board.current();
    assert.equal(current.state, "unavailable", "a crashed projection never reads as ready");
    assert.equal(current.state === "unavailable" && current.reason, "worker_crashed: forced board worker crash");
  } finally {
    board.stop();
  }
});

test("a board worker that exits without crashing still names its exit code", { timeout: 30_000 }, async () => {
  const { board, code } = await startUntilExit(new URL("data:text/javascript,process.exit(3)"));
  try {
    assert.equal(code, 3);
    const current = board.current();
    assert.equal(current.state, "unavailable");
    assert.equal(current.state === "unavailable" && current.reason, "worker_exited: 3");
  } finally {
    board.stop();
  }
});
