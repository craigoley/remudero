import assert from "node:assert/strict";
import { test } from "node:test";
import { workerErrorVerdict } from "../src/run-task.js";
import type { WorkerResult } from "../src/lib/worker.js";

/** Build a minimal WorkerResult for the verdict-mapping tests. */
function result(over: Partial<WorkerResult>): WorkerResult {
  return {
    sessionId: "s",
    costUsd: 0,
    numTurns: 0,
    text: "",
    blocks: [],
    stderr: "",
    subtype: "success",
    isError: false,
    permissionDenials: [],
    childEnvKeys: [],
    ...over,
  };
}

test("workerErrorVerdict: a non-error result maps to null (caller proceeds)", () => {
  assert.equal(workerErrorVerdict(result({ isError: false, subtype: "success" }), 1.2, "implement"), null);
});

test("workerErrorVerdict: error_max_budget_usd → blocked_budget, NOT retried, subtype recorded", () => {
  const r = result({ isError: true, subtype: "error_max_budget_usd", numTurns: 3, costUsd: 0.011 });
  const v = workerErrorVerdict(r, 0.011, "implement");
  assert.ok(v, "must produce a verdict");
  assert.equal(v.verdict, "blocked_budget");
  assert.equal(v.budgetBreach, true);
  assert.equal(v.ledger.subtype, "error_max_budget_usd");
  assert.match(v.ledger.reason, /not retried/i);
  // The ledger line must carry turns + cost — a failed run is never free.
  assert.equal(v.ledger.num_turns, 3);
  assert.equal(v.ledger.cost_usd, 0.011);
  assert.equal(v.ledger.billing_mode, "subscription");
});

test("workerErrorVerdict: error_max_turns → failed, still ledgers num_turns AND cost_usd", () => {
  const r = result({ isError: true, subtype: "error_max_turns", numTurns: 60, costUsd: 1.73 });
  const v = workerErrorVerdict(r, 1.73, "implement");
  assert.ok(v);
  assert.equal(v.verdict, "failed");
  assert.equal(v.budgetBreach, false);
  assert.equal(v.ledger.num_turns, 60, "a max-turns run's turn count must be ledgered");
  assert.equal(v.ledger.cost_usd, 1.73, "a max-turns run's spend must be ledgered");
});

test("workerErrorVerdict: cost passed by the caller (accumulated) wins over the single-worker cost", () => {
  // costUsd is the RUN's accumulated notional cost (recon + implement), not just
  // this worker's — the caller threads the running total in.
  const r = result({ isError: true, subtype: "error_during_execution", numTurns: 5, costUsd: 0.5 });
  const v = workerErrorVerdict(r, 0.9, "implement");
  assert.ok(v);
  assert.equal(v.verdict, "failed");
  assert.equal(v.ledger.cost_usd, 0.9);
});
