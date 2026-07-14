import assert from "node:assert/strict";
import { test } from "node:test";
import { collectWorkerResult } from "../src/lib/worker.js";

// ── Synthetic SDK message streams ──────────────────────────────────────────
// The real SDK yields a `type:"result"` envelope (even for an error subtype)
// and, on an error, THEN throws from the iterator. These generators reproduce
// exactly that shape so the ledger-on-error guarantee is tested without a spawn.

/** A clean success stream: an assistant text block, then a success result. */
async function* successStream(): AsyncGenerator<unknown> {
  yield { type: "assistant", message: { content: [{ type: "text", text: "hello" }] } };
  yield {
    type: "result",
    subtype: "success",
    is_error: false,
    result: "PR_URL: https://github.com/x/y/pull/1",
    session_id: "sess-ok",
    total_cost_usd: 0.42,
    num_turns: 12,
    permission_denials: [],
  };
}

/**
 * The WS-1 failure shape: the SDK yields the error result envelope (WITH
 * num_turns + total_cost_usd) and THEN throws from the iterator.
 */
function errorResultStream(subtype: string, costUsd: number, numTurns: number) {
  return (async function* (): AsyncGenerator<unknown> {
    yield { type: "assistant", message: { content: [{ type: "text", text: "working…" }] } };
    yield {
      type: "result",
      subtype,
      is_error: true,
      session_id: "sess-err",
      total_cost_usd: costUsd,
      num_turns: numTurns,
      permission_denials: [],
    };
    throw new Error(`Claude Code returned an error result: ${subtype}`);
  })();
}

/** A genuine transport failure: the iterator throws with NO result envelope. */
async function* transportFailureStream(): AsyncGenerator<unknown> {
  yield { type: "assistant", message: { content: [{ type: "text", text: "spawning…" }] } };
  throw new Error("spawn ENOENT: bad claude binary");
}

test("collectWorkerResult: success stream captures cost, turns, and text", async () => {
  const r = await collectWorkerResult(successStream(), { childEnvKeys: ["PATH"] });
  assert.equal(r.isError, false);
  assert.equal(r.subtype, "success");
  assert.equal(r.costUsd, 0.42);
  assert.equal(r.numTurns, 12);
  assert.match(r.text, /pull\/1/);
  assert.deepEqual(r.blocks, ["hello"]);
});

test("collectWorkerResult: a max-turns error does NOT throw — it returns the envelope with cost + turns", async () => {
  // This is the honest-ledger guarantee: a failed run must never be free.
  const r = await collectWorkerResult(errorResultStream("error_max_turns", 1.73, 60), {
    childEnvKeys: [],
  });
  assert.equal(r.isError, true);
  assert.equal(r.subtype, "error_max_turns");
  assert.equal(r.costUsd, 1.73, "cost_usd must survive the error-result throw");
  assert.equal(r.numTurns, 60, "num_turns must survive the error-result throw");
});

test("collectWorkerResult: a budget breach returns subtype error_max_budget_usd with its cost", async () => {
  const r = await collectWorkerResult(errorResultStream("error_max_budget_usd", 0.011, 3), {
    childEnvKeys: [],
  });
  assert.equal(r.isError, true);
  assert.equal(r.subtype, "error_max_budget_usd");
  assert.equal(r.costUsd, 0.011);
  assert.equal(r.numTurns, 3);
});

test("collectWorkerResult: a throw with NO result envelope is RE-RAISED (real transport failure)", async () => {
  await assert.rejects(
    () => collectWorkerResult(transportFailureStream(), { childEnvKeys: [] }),
    /spawn ENOENT/,
    "a genuine spawn failure must not be silently swallowed",
  );
});
