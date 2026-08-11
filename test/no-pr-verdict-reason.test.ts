// W1-T407 — acceptance #2: "the no_pr reason distinguishes a worker that declined from one that
// produced nothing, instead of one fixed sentence for both."
//
// `noPrVerdict` used to set `reason` to the identical sentence on every `no_pr` it ever wrote,
// regardless of whether the worker left any account of itself. This proves the sentence now
// varies with whether the worker's own report (`text`/`blocks`) had anything in it — the same
// signal `report_excerpt` is built from — while the genuinely silent case (nothing said, nothing
// committed) keeps the EXACT original sentence, so the W1-T12a regression coverage elsewhere
// stays valid unchanged.
import assert from "node:assert/strict";
import { test } from "node:test";
import { noPrVerdict } from "../src/run-task.js";
import type { WorkerResult } from "../src/lib/worker.js";

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

test("noPrVerdict: a worker that said NOTHING (empty text, empty blocks) keeps the original, fixed sentence", () => {
  const v = noPrVerdict(result({ text: "", blocks: [] }), 1, "implement", 0);
  assert.equal(v.ledger.reason, "worker completed without opening a PR");
});

test("noPrVerdict: a worker that left its own account (non-empty REPORT text) gets a DIFFERENT reason", () => {
  const silent = noPrVerdict(result({ text: "", blocks: [] }), 1, "implement", 0);
  const declined = noPrVerdict(
    result({ text: "REPORT\nI could not find a safe way to make this change.\n", blocks: [] }),
    1,
    "implement",
    0,
  );
  assert.notEqual(declined.ledger.reason, silent.ledger.reason);
});

test("noPrVerdict: the declined reason still names the outcome (no PR) — it is a richer sentence, not an unrelated one", () => {
  const v = noPrVerdict(result({ text: "REPORT\nnothing to do here.\n", blocks: [] }), 1, "implement", 0);
  assert.match(v.ledger.reason, /without opening a PR/);
});

test("noPrVerdict: non-empty BLOCKS alone (no text) also count as the worker having said something", () => {
  const v = noPrVerdict(result({ text: "", blocks: ["I looked but found nothing to change."] }), 1, "implement", 0);
  assert.notEqual(v.ledger.reason, "worker completed without opening a PR");
});

test("noPrVerdict: whitespace-only text is treated as saying NOTHING, not as a decline", () => {
  const v = noPrVerdict(result({ text: "   \n\t  ", blocks: [] }), 1, "implement", 0);
  assert.equal(v.ledger.reason, "worker completed without opening a PR");
});
