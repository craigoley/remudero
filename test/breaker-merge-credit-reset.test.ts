/**
 * THE DISPATCH BREAKER RESETS ON A CREDITED MERGE, NOT ONLY ON `pr.opened`.
 *
 * THE DEFECT. `dispatchesWithoutNewOwnedPr` (status.ts) reset on exactly one step:
 * `pr.opened`. That line is written only after a worker pushes its OWN
 * `run-<taskId>-<epochMs>` branch, so it was a sound PROXY for "this task produced work"
 * — until the branch convention broke it. A PR landing on a slug-named branch
 * (`run-W1-T377-open-pr-corroboration`) fails `ownsBranch`'s `run-<taskId>-\d+$`, so no
 * `pr.opened` is ever logged, and the task is recorded as MERGED by the credit-backfill
 * and as MAKING NO PROGRESS by the breaker at the same time — two mechanisms holding the
 * same fact and never comparing notes.
 *
 * MEASURED on the live ledger union: W1-T377 and W1-T378 both shipped (#1386, #1391), both
 * carry `verdict.merged` ×2 from `sweep.credit_backfill` and `pr.opened` ×0, and both ran
 * to exactly 5 dispatches against `DEFAULT_MAX_TASK_DISPATCHES = 5` before tripping — 10
 * dispatches re-running finished work.
 *
 * BOTH DIRECTIONS ARE PROVEN HERE, and the pairing is the point: a change that simply
 * never tripped would satisfy the first test and would remove the only thing that bounded
 * that waste at five dispatches each instead of more.
 *   (i)   a back-credited task CLEARS;
 *   (ii)  a genuinely stalled task — `run.start` rows, no merge of any kind — STILL TRIPS;
 *   (iii) ORDERING: the fold is sequential, so a merge followed by three dispatches counts
 *         3, not 0. Presence alone is not the claim.
 *
 * THE FIXTURES ARE REAL LEDGER ROWS DRIVEN THROUGH THE EXPORTED FOLD — never a replica of
 * it. Several tests write a real NDJSON file and read it back through `readLedgerLines`,
 * so the row SHAPE the daemon actually persists is what the counter sees.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_MAX_TASK_DISPATCHES,
  dispatchesWithoutNewOwnedPr,
  isDispatchBreakerTripped,
  isMergeCreditLine,
  readLedgerLines,
} from "../src/lib/status.js";

const T = "W1-T377";

const runStart = (task = T) => ({ task_id: task, step: "run.start" });
/** What `sweep.credit_backfill` actually appends (sweep.ts's `runCreditBackfill`). */
const backfilled = (task = T) => ({
  task_id: task,
  step: "verdict.merged",
  verdict: "merged",
  pr_number: 1386,
  pr_url: "https://github.com/craigoley/remudero/pull/1386",
  source: "sweep.credit_backfill",
});
/** What a live run writes when it merges its own PR. */
const ownMerge = (task = T) => ({ task_id: task, step: "verdict", verdict: "merged" });

/** Round-trip through the REAL reader, so the fold sees the persisted row shape. */
function throughLedger(rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const dir = mkdtempSync(join(tmpdir(), "breaker-merge-credit-"));
  const path = join(dir, "ledger.ndjson");
  writeFileSync(path, rows.map((r) => JSON.stringify({ ts: "2026-08-12T00:00:00.000Z", ...r })).join("\n") + "\n");
  return readLedgerLines(path);
}

// ── (i) the back-credited task CLEARS ──────────────────────────────────────────────────

test("W1-T377's real shape — 5 run.start, pr.opened x0, verdict.merged from the backfill — no longer trips", () => {
  // The exact ledger shape measured for W1-T377/W1-T378: dispatched to the cap, credited by
  // the backfill, never a `pr.opened` because the branch was slug-named.
  const rows = throughLedger([
    ...Array.from({ length: 5 }, () => runStart()),
    backfilled(),
  ]);
  assert.equal(dispatchesWithoutNewOwnedPr(rows, T), 0, "a credited merge is forward progress");
  assert.equal(isDispatchBreakerTripped(rows, T, DEFAULT_MAX_TASK_DISPATCHES), false);
});

test("a live run's own terminal `verdict: merged` resets too — the other spelling of the same fact", () => {
  const rows = throughLedger([...Array.from({ length: 5 }, () => runStart()), ownMerge()]);
  assert.equal(dispatchesWithoutNewOwnedPr(rows, T), 0);
  assert.equal(isDispatchBreakerTripped(rows, T, DEFAULT_MAX_TASK_DISPATCHES), false);
});

// ── (ii) THE OTHER DIRECTION: a genuinely stalled task STILL TRIPS ─────────────────────

test("THE OTHER DIRECTION: run.start x5 with NO merge of any kind still trips — the bound is not removed", () => {
  // FALSIFIER for "the breaker never fires now". This is the W1-T1 storm shape: dispatch
  // after dispatch producing nothing. If this ever passes as `false`, the change has deleted
  // the only thing that bounded the waste rather than fixing what failed to clear it.
  const rows = throughLedger(Array.from({ length: 5 }, () => runStart()));
  assert.equal(dispatchesWithoutNewOwnedPr(rows, T), 5);
  assert.equal(isDispatchBreakerTripped(rows, T, DEFAULT_MAX_TASK_DISPATCHES), true);
});

test("a NON-merged terminal verdict does not reset — `no_pr` is exactly the anomaly being counted", () => {
  const rows = throughLedger([
    runStart(),
    { task_id: T, step: "verdict", verdict: "no_pr" },
    runStart(),
    { task_id: T, step: "verdict", verdict: "blocked_ci" },
    runStart(),
  ]);
  assert.equal(dispatchesWithoutNewOwnedPr(rows, T), 3, "only a MERGED verdict is forward progress");
});

test("another task's merge cannot clear this one — the fold stays task-scoped", () => {
  const rows = throughLedger([...Array.from({ length: 5 }, () => runStart(T)), backfilled("W1-T999")]);
  assert.equal(dispatchesWithoutNewOwnedPr(rows, T), 5);
  assert.equal(isDispatchBreakerTripped(rows, T, DEFAULT_MAX_TASK_DISPATCHES), true);
});

// ── (iii) ORDERING: the fold is sequential, not a presence test ────────────────────────

test("ORDERING: a merge followed by three more dispatches counts 3, not 0", () => {
  // Presence alone is not the claim. If the reset were implemented as "does a merge line
  // exist anywhere", this reads 0 and the task could never trip again after its first merge.
  const rows = throughLedger([runStart(), runStart(), backfilled(), runStart(), runStart(), runStart()]);
  assert.equal(dispatchesWithoutNewOwnedPr(rows, T), 3);
  assert.equal(isDispatchBreakerTripped(rows, T, DEFAULT_MAX_TASK_DISPATCHES), false, "3 < 5");
});

test("ORDERING: dispatches resuming after a merge can trip the breaker again", () => {
  const rows = throughLedger([backfilled(), ...Array.from({ length: 5 }, () => runStart())]);
  assert.equal(dispatchesWithoutNewOwnedPr(rows, T), 5);
  assert.equal(isDispatchBreakerTripped(rows, T, DEFAULT_MAX_TASK_DISPATCHES), true, "the bound still binds after a merge");
});

test("ORDERING: the LAST forward-progress line wins, whichever kind it is", () => {
  const rows = throughLedger([
    runStart(),
    { task_id: T, step: "pr.opened", pr_url: "https://github.com/craigoley/remudero/pull/1" },
    runStart(),
    backfilled(),
    runStart(),
  ]);
  assert.equal(dispatchesWithoutNewOwnedPr(rows, T), 1);
});

// ── the shared predicate itself ────────────────────────────────────────────────────────

test("isMergeCreditLine accepts both credited spellings and nothing else", () => {
  assert.equal(isMergeCreditLine({ step: "verdict.merged" }), true);
  assert.equal(isMergeCreditLine({ step: "verdict", verdict: "merged" }), true);
  // A bare `verdict` row is NOT a merge — this is the discrimination the reset depends on.
  assert.equal(isMergeCreditLine({ step: "verdict", verdict: "no_pr" }), false);
  assert.equal(isMergeCreditLine({ step: "verdict" }), false);
  assert.equal(isMergeCreditLine({ step: "pr.merged", state: "MERGED" }), false);
  assert.equal(isMergeCreditLine({ step: "run.start" }), false);
});
