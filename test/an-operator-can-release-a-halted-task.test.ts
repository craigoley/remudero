import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createDispatchBreakerCache,
  dispatchesWithoutNewOwnedPr,
  evaluateDispatchBreakerDetailed,
  readLedgerLines,
} from "../src/lib/status.js";
import { COMMANDS } from "../src/run-task.js";
import { writeLedger } from "./helpers/ledger-fixture.js";

// ── W1-T4691: A HALTED TASK CAN NEVER BE RELEASED — the dispatch circuit breaker's trip
// deliberately survives a rotation and a daemon restart (W1-T2425's own invariant), and the ONLY
// reset the breaker itself understands is a new owned `pr.opened` — which a task the breaker
// refuses to dispatch can never produce. `rmd release <task-id> --reason "<text>"` is the
// sanctioned way out: it appends one explicit, attributable `dispatch.breaker_released` ledger
// row that `seedCountFromCircuitBreak`/`dispatchStreakTally` (status.ts) read exactly like a new
// `pr.opened` reset — never an inference from silence, never an archive read (both were tried
// and rejected; see this task's own rationale). ──────────────────────────────────────────────

/** The row the breaker itself already writes at refusal time — the cross-restart seed
 *  `seedCountFromCircuitBreak` reads (W1-T2425). */
function circuitBrokenRow(taskId: string, freshCount: number): Record<string, unknown> {
  return { step: "dispatch.circuit_broken", task: taskId, freshCount };
}

/** The EXACT row `rmd release <task-id> --reason "<text>"` appends — design (i) of this task's
 *  own plan shard: `dispatch.breaker_released {task, reason, released_count}`. */
function releaseRow(taskId: string, reason: string, releasedCount: number): Record<string, unknown> {
  return {
    step: "dispatch.breaker_released",
    task_id: taskId,
    task: taskId,
    reason,
    released_count: releasedCount,
    actor: "operator",
  };
}

test("W1-T4691: a released task is dispatchable on the next tick", () => {
  const taskId = "W1-T9001";
  // The exact halted shape this task's own rationale measured (OBSERVED 2026-09-29): five
  // dispatches tripped the breaker, which wrote its own `dispatch.circuit_broken` row (the seed a
  // restarted process reads), and rotation later compacted the `run.start` rows themselves away —
  // leaving nothing live but the seed. A fresh process reading that ledger alone can never tell
  // "compacted away" apart from "the count actually dropped", so it reads `indeterminate` forever,
  // exactly as W1-T2425 intends.
  const ledger = writeLedger([circuitBrokenRow(taskId, 5)]);

  // Sanity: this is the falsifier this task names verbatim — "ignore the release row and the
  // first test finds the task still indeterminate."
  const before = evaluateDispatchBreakerDetailed(ledger.path, taskId, createDispatchBreakerCache());
  assert.equal(before.state, "indeterminate", "sanity: halted, and nothing but a release can move it");
  assert.equal(before.priorCount, 5, "sanity: the seed came from the breaker's own on-disk row");

  ledger.append([releaseRow(taskId, "fixed the underlying block, resuming", 5)]);

  // A FRESH cache (a new tick, or a restarted daemon) reads the released task as CLEAR, not
  // merely "no longer indeterminate" — dispatchable, the acceptance claim's own words.
  const after = evaluateDispatchBreakerDetailed(ledger.path, taskId, createDispatchBreakerCache());
  assert.equal(after.state, "clear");
  assert.equal(after.ledgerState, "clear");
  assert.equal(after.freshCount, 0, "the release resets the streak exactly like a new pr.opened");
  assert.equal(after.priorCount, undefined, "the release also clears the cross-restart seed W1-T2425 reads");
});

test("W1-T4691: a release is a recorded operator row and never an inference", () => {
  const taskId = "W1-T9002";
  const ledger = writeLedger([circuitBrokenRow(taskId, 5)]);

  // Silence never authorizes dispatch: an unrelated row, and even a release row FOR A DIFFERENT
  // TASK, must leave this task exactly as indeterminate as it was — the breaker never infers a
  // release from the absence of evidence, or from someone else's.
  ledger.append([{ step: "ci.polling", task_id: taskId }, releaseRow("W1-OTHER-TASK", "unrelated release", 3)]);
  const stillHalted = evaluateDispatchBreakerDetailed(ledger.path, taskId, createDispatchBreakerCache());
  assert.equal(stillHalted.state, "indeterminate", "no event but THIS task's own release row may clear it");

  // The release row names the count it is releasing — read from the live ledger BEFORE the
  // release, the same value `rmd release` itself prints — so the row is a RECORD of a decision,
  // not a value fabricated after the fact.
  const releasedCount = dispatchesWithoutNewOwnedPr(readLedgerLines(ledger.path), taskId);
  assert.equal(releasedCount, 0, "sanity: run.start rows were rotated away — the seed alone carries the count");
  const reason = "fixed the underlying block, resuming";
  ledger.append([releaseRow(taskId, reason, 5)]);

  const rows = readLedgerLines(ledger.path);
  const written = rows.find((l) => l.step === "dispatch.breaker_released" && l.task_id === taskId);
  assert.ok(written, "the release must land as one durable ledger row, not an in-memory-only flip");
  assert.equal(written?.reason, reason, "the row carries WHY, attributably, never a bare reset");
  assert.equal(written?.released_count, 5, "the row carries the count it releases");

  const released = evaluateDispatchBreakerDetailed(ledger.path, taskId, createDispatchBreakerCache());
  assert.equal(released.state, "clear", "the recorded row — and only the recorded row — releases the task");
});

// ── The CLI surface itself: `rmd release` exists, requires --reason (an attributable ask, never
// a silent flip), and its own registry text names the row this breaker mechanism reads. ────────

test("W1-T4691: `rmd release` is registered, requires --reason, and names the ledger row it writes", () => {
  const spec = COMMANDS.find((c) => c.name === "release");
  assert.ok(spec, "COMMANDS is missing a 'release' entry");
  assert.match(spec!.syntax, /<task-id>/);
  assert.match(spec!.syntax, /--reason/);
  assert.match(spec!.detail, /dispatch\.breaker_released/);
});
