// W1-T407 — acceptance #1: "the no_pr verdict row carries the commit count the guard already
// computed, so a reader can tell an empty branch from an unpushed one without the worktree."
//
// The SILENT NO-OP GUARD (src/run-task.ts) computes `commitsAhead(worktreePath, "origin/main")`
// purely as a predicate and used to throw the number away once the branch was decided. This
// proves `noPrVerdict` now threads that SAME value onto the ledger row instead — appended as its
// own LAST positional parameter (after `stage`), so no existing caller shifted.
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

test("noPrVerdict: commits_ahead carries the EXACT value passed in, not a re-derived or hardcoded one", () => {
  const v = noPrVerdict(result({}), 1.1, "implement", 0);
  assert.equal(v.ledger.commits_ahead, 0);
});

test("noPrVerdict: commits_ahead is not silently clamped to 0/1 — an arbitrary count rides the row untouched", () => {
  const v = noPrVerdict(result({}), 1.1, "implement", 7);
  assert.equal(v.ledger.commits_ahead, 7);
});

test("noPrVerdict: commits_ahead is independent of every other field — changing it alone changes nothing else on the row", () => {
  const base = result({ subtype: "success", numTurns: 12, costUsd: 3 });
  const a = noPrVerdict(base, 4.2, "implement", 0);
  const b = noPrVerdict(base, 4.2, "implement", 5);
  assert.notEqual(a.ledger.commits_ahead, b.ledger.commits_ahead);
  const { commits_ahead: aCount, ...aRest } = a.ledger;
  const { commits_ahead: bCount, ...bRest } = b.ledger;
  assert.deepEqual(aRest, bRest);
});

test("noPrVerdict: commits_ahead is a real number field (never a string), so a reader can compare it without parsing", () => {
  const v = noPrVerdict(result({}), 1, "implement", 3);
  assert.equal(typeof v.ledger.commits_ahead, "number");
});
