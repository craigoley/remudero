// W1-T407 — acceptance #4: "every new field is appended so no existing positional caller
// shifts, and the row stays within the never-rotated retention class."
//
// Two independent claims, two kinds of proof:
//   1. `commits_ahead`/`report_excerpt` are the LAST parameter and the LAST-inserted keys —
//      every field `noPrVerdict` already wrote before this task keeps its exact value, so a
//      caller that only reads the pre-existing keys sees no change at all.
//   2. This task deliberately writes the new facts onto the `verdict` ledger step rather than
//      `implement.done` (see the task's own `note:`) BECAUSE `verdict` is already in
//      `DECISION_RELEVANT_LEDGER_STEPS`, the set rotation never archives. Proven directly
//      against the real export, not re-asserted as a string literal.
import assert from "node:assert/strict";
import { test } from "node:test";
import { noPrVerdict } from "../src/run-task.js";
import type { WorkerResult } from "../src/lib/worker.js";
import { DECISION_RELEVANT_LEDGER_STEPS } from "../src/lib/ledger.js";

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
    apiError: false,
    permissionDenials: [],
    childEnvKeys: [],
    model: "default",
    effort: "default",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    modelUsage: {},
    compactionEvents: [],
    qualitySuspect: false,
    ...over,
  };
}

const PRE_EXISTING_KEYS = [
  "verdict",
  "stage",
  "subtype",
  "num_turns",
  "cost_usd",
  "billing_mode",
  "account_label",
  "reason",
  "model",
  "effort",
  "tokens",
  "cache_read_input_tokens",
  "cache_creation_input_tokens",
] as const;

test("noPrVerdict: every field this task predates keeps its exact value — appending new fields changed nothing already there", () => {
  const r = result({
    subtype: "success",
    numTurns: 9,
    accountLabel: "acct-x",
    childEnvKeys: [],
    model: "claude-x",
    effort: "medium",
    tokens: { input: 10, output: 20, cacheRead: 30, cacheCreation: 40 },
  });
  const v = noPrVerdict(r, 2.5, "implement", 3);
  for (const key of PRE_EXISTING_KEYS) {
    assert.ok(key in v.ledger, `pre-existing key ${key} must still be present`);
  }
  assert.equal(v.ledger.stage, "implement");
  assert.equal(v.ledger.subtype, "success");
  assert.equal(v.ledger.num_turns, 9);
  assert.equal(v.ledger.cost_usd, 2.5);
  assert.equal(v.ledger.account_label, "acct-x");
  assert.equal(v.ledger.model, "claude-x");
  assert.equal(v.ledger.effort, "medium");
  assert.deepEqual(v.ledger.tokens, { input: 10, output: 20, cacheRead: 30, cacheCreation: 40 });
  assert.equal(v.ledger.cache_read_input_tokens, 30);
  assert.equal(v.ledger.cache_creation_input_tokens, 40);
});

test("noPrVerdict: the new fields (commits_ahead, report_excerpt) are inserted AFTER every pre-existing key", () => {
  const v = noPrVerdict(result({ text: "REPORT\nsome account" }), 1, "implement", 4);
  const keys = Object.keys(v.ledger);
  const lastPreExistingIndex = Math.max(...PRE_EXISTING_KEYS.map((k) => keys.indexOf(k)));
  const commitsAheadIndex = keys.indexOf("commits_ahead");
  const reportExcerptIndex = keys.indexOf("report_excerpt");
  assert.ok(commitsAheadIndex > lastPreExistingIndex, "commits_ahead must be appended after every pre-existing key");
  assert.ok(reportExcerptIndex > lastPreExistingIndex, "report_excerpt must be appended after every pre-existing key");
});

test("noPrVerdict: the new 4th parameter is APPENDED — calling with the same (r, costUsd, stage) triple as before still yields the same pre-existing fields regardless of what commitsAheadCount is", () => {
  const r = result({ subtype: "success", numTurns: 1 });
  const a = noPrVerdict(r, 1, "implement", 0);
  const b = noPrVerdict(r, 1, "implement", 99);
  assert.equal(a.ledger.subtype, b.ledger.subtype);
  assert.equal(a.ledger.stage, b.ledger.stage);
  assert.equal(a.ledger.cost_usd, b.ledger.cost_usd);
  assert.notEqual(a.ledger.commits_ahead, b.ledger.commits_ahead);
});

test("the verdict ledger step (which every no_pr row is logged under) is in the never-rotated retention class", () => {
  assert.equal(DECISION_RELEVANT_LEDGER_STEPS.has("verdict"), true);
});

test("the verdict step is NOT the cosmetic implement.done step that rotation DOES archive — the new fields deliberately did not go there", () => {
  assert.equal(DECISION_RELEVANT_LEDGER_STEPS.has("implement.done"), false);
});
