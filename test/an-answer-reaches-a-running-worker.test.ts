// test/an-answer-reaches-a-running-worker.test.ts — W1-T4673: "an answer or note for task X lands while X's worker
// runs" is fed in at the next turn boundary (Buzz's "mention it to steer it") instead of waiting for the next fix
// round; an answer with NO running worker still takes the existing fix-round path, unchanged.
//
// Drives spawnWorker() for real, mirroring test/worker-clock-bound.test.ts's own Group-1 fixture: a fake `queryFn`
// stands in for the SDK's `query()`, so no real `claude` binary and no real containment spawn are ever reached
// (`options.spawnClaudeCodeProcess` is never called, so `withWorkerGroupTeardown`'s own teardown is a no-op — that
// guarantee is proven elsewhere, in test/worker.test.ts's own e2e pair, and is not re-proven here).

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  __resetRunningWorkersForTest,
  appendQuestionAnswer,
  CLAUDE_BIN_ENV_OVERRIDE,
  createClaudeExecutableCache,
  deliverOperatorAnswerToRunningWorker,
  spawnWorker,
  type SpawnWorkerArgs,
} from "../src/lib/worker.js";

/** Bounds a promise so a defect that would otherwise wait FOREVER (a callback deep inside `spawnWorker`'s own
 * control flow — `started()` — never firing because some earlier step threw or a different code path was taken)
 * fails in `ms`, not at this repo's own coverage-shard `timeout-minutes` ceiling. `node --test` sets no per-test
 * timeout of its own, so an unbounded `await` on a signal the code under test might never send is exactly the
 * "SHARD HANG" shape .github/workflows/ci.yml's coverage-ratchet job calls out by name: a real defect here would
 * otherwise cost a whole job's ceiling instead of a normal, fast, diagnosable test failure. */
function withHangGuard<T>(label: string, promise: Promise<T>, ms = 10_000): Promise<T> {
  let timer: NodeJS.Timeout;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not settle within ${ms}ms`)), ms);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer)) as Promise<T>;
}

function spawnArgs(dir: string, extra: Record<string, unknown> = {}) {
  const settingsFile = join(dir, "worker.json");
  writeFileSync(settingsFile, JSON.stringify({ sandbox: { enabled: true, failIfUnavailable: true } }));
  return {
    cwd: dir,
    permissionMode: "bypassPermissions" as const,
    settingsFile,
    prompt: "W1-T4673 mid-run steering fixture",
    config: { claudeBin: "/unused", root: dir },
    claudeExecutable: {
      cache: createClaudeExecutableCache(),
      deps: { env: { [CLAUDE_BIN_ENV_OVERRIDE]: "/fake/claude" }, home: dir, exists: () => true, canExecute: () => true, locations: [] },
    },
    // Force past the darwin-only keychain gate without touching the real `security(1)` binary — the same escape
    // hatch every other spawnWorker fixture in this repo uses (test/worker.test.ts, test/worker-clock-bound.test.ts).
    keychain: {
      platform: "linux" as NodeJS.Platform,
      readCredentialFile: () => JSON.stringify({ claudeAiOauth: { accessToken: "stub", expiresAt: 4102444800000 } }),
    },
    ...extra,
  };
}

/** A fake SDK `Query`: an async generator holding open until `release()` is called, with a `streamInput` spy
 * recording every message pushed onto it — the exact method {@link deliverOperatorAnswerToRunningWorker} calls.
 * `started()` fires SYNCHRONOUSLY, on the generator's very first `.next()` pull, before its own first `await` — so a
 * caller that awaits it knows registration has already happened (spawnWorker registers the handle before handing the
 * query to its message loop), without guessing at a tick count. */
function midRunQueryFn(
  streamInputCalls: unknown[][],
  started: () => void,
  streamInputError?: Error,
): { queryFn: SpawnWorkerArgs["queryFn"]; release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const queryFn = (() => {
    const gen = (async function* () {
      started();
      await gate;
      yield {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "done",
        session_id: "s-midrun",
        total_cost_usd: 0.01,
        num_turns: 1,
      };
    })();
    (gen as unknown as { streamInput: (stream: AsyncIterable<unknown>) => Promise<void> }).streamInput = async (stream) => {
      const collected: unknown[] = [];
      for await (const message of stream) collected.push(message);
      streamInputCalls.push(collected);
      if (streamInputError) throw streamInputError;
    };
    return gen;
  }) as unknown as SpawnWorkerArgs["queryFn"];
  return { queryFn, release };
}

test("W1-T4673: an answer that lands during a run is delivered at the next turn boundary", async () => {
  __resetRunningWorkersForTest();
  const dir = mkdtempSync(join(tmpdir(), "rmd-answer-midrun-"));
  const streamInputCalls: unknown[][] = [];
  let started!: () => void;
  const startedPromise = new Promise<void>((r) => (started = r));
  const { queryFn, release } = midRunQueryFn(streamInputCalls, () => started());

  const spawnPromise = spawnWorker({
    ...spawnArgs(dir),
    taskId: "W1-T4673-fixture",
    queryFn,
  } as Parameters<typeof spawnWorker>[0]);

  // Guarded: if spawnWorker ever settles (resolves OR rejects) without pulling the fixture's generator first, plain
  // `await startedPromise` would hang forever with nothing left pending to notice — the exact "SHARD HANG" shape.
  await withHangGuard(
    "the fixture's generator pull (spawnWorker must register the running session before continuing)",
    Promise.race([startedPromise, spawnPromise]),
  ); // the fake session is open; spawnWorker has registered it as "running" by now

  const outcome = deliverOperatorAnswerToRunningWorker("W1-T4673-fixture", "use the b) option");
  assert.equal(
    outcome,
    "delivered",
    "a registered running worker must be found and the answer routed straight to it, not to the fix-round queue",
  );

  release();
  const result = await withHangGuard("spawnWorker's own completion after being released", spawnPromise);
  assert.equal(result.isError, false, "the fixture's own worker must still complete cleanly after being steered");

  assert.equal(streamInputCalls.length, 1, "the SDK's own streamInput must have been called exactly once");
  const [[message]] = streamInputCalls as [[{ type: string; message: { content: string }; priority?: string }]];
  assert.equal(message.type, "user", "the delivered message must be a real SDK user-role message");
  assert.equal(message.message.content, "use the b) option", "the answer's own text must reach the running session verbatim");
  assert.equal(message.priority, "next", "delivered at the NEXT turn boundary — never mid-tool-call, never replacing a live turn");
});

test("W1-T4673: a rejected mid-run answer is reported as a steering failure", async () => {
  __resetRunningWorkersForTest();
  const dir = mkdtempSync(join(tmpdir(), "rmd-answer-steer-failure-"));
  const streamInputCalls: unknown[][] = [];
  let started!: () => void;
  const startedPromise = new Promise<void>((resolve) => (started = resolve));
  const { queryFn, release } = midRunQueryFn(streamInputCalls, () => started(), new Error("stream closed"));
  const rows: Array<{ event: string; fields?: Record<string, unknown> }> = [];
  const spawnPromise = spawnWorker({
    ...spawnArgs(dir),
    taskId: "W1-T4673-steer-failure",
    queryFn,
  } as Parameters<typeof spawnWorker>[0]);

  try {
    await withHangGuard("failed-steer worker start", startedPromise);
    let settled!: () => void;
    // Deterministic, not timing-based: `onSteerSettled` fires from inside the SAME `.catch(...).finally(...)`
    // chain deliverOperatorAnswerToRunningWorker's own steer_failed ledger call lives in, so awaiting it (rather
    // than guessing at a tick count with a bare `setImmediate`) proves that exact line ran before this test reads
    // `rows`.
    const settledPromise = new Promise<void>((resolve) => (settled = resolve));
    assert.equal(
      deliverOperatorAnswerToRunningWorker("W1-T4673-steer-failure", "answer", {
        ledger: (event, fields) => rows.push({ event, fields }),
        onSteerSettled: () => settled(),
      }),
      "delivered",
    );
    await withHangGuard("failed-steer settle notification", settledPromise);
    assert.equal(streamInputCalls.length, 1, "the rejected SDK call must actually have been attempted");
    assert.ok(
      rows.some((row) => row.event === "worker.steer_failed" && row.fields?.reason === "stream closed"),
      "a rejected streamInput must be visible to the caller's ledger",
    );
  } finally {
    release();
    await withHangGuard("failed-steer worker completion", spawnPromise);
  }
});

test("W1-T4673: an answer with no running worker still waits for the fix round", () => {
  __resetRunningWorkersForTest();
  const dir = mkdtempSync(join(tmpdir(), "rmd-answer-no-worker-"));

  const outcome = deliverOperatorAnswerToRunningWorker("W1-T4673-no-such-task", "any answer");
  assert.equal(outcome, "no-running-worker", "no session is registered for this task id, so there is nothing to steer");

  // The existing fix-round path is untouched: the SAME durable store this task's design (iii) leaves alone still
  // accepts the answer, exactly as it did before this change.
  const ok = appendQuestionAnswer(dir, {
    ts: new Date().toISOString(),
    task: "W1-T4673-no-such-task",
    answer: "any answer",
    origin: "test",
  });
  assert.equal(ok, true, "with no running worker to steer, the answer must still land in the fix-round's own durable store");
});
