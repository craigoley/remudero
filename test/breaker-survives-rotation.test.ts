import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendLedger, ledgerExceedsRotationCeiling, rotateLedger, type LedgerLine } from "../src/lib/ledger.js";
import { createDispatchBreakerCache, evaluateDispatchBreaker } from "../src/lib/status.js";

// ── W1-T206: "an ABSENT ledger does not silently report a dispatch-breaker count of zero
// for a task that has dispatch history elsewhere -- absence reads as indeterminate rather
// than as proof of no dispatches." ──────────────────────────────────────────────────────
//
// The ledger backs the per-task dispatch circuit breaker (MASTER-PLAN P29(ii)): once a
// task has been dispatched DEFAULT_MAX_TASK_DISPATCHES times with no new owned PR since,
// it must not be dispatched again without human escalation. Before this fix, the breaker
// was re-derived by a plain `readLedgerLines(ledgerPath)` -- and a MISSING or SHORTER-
// THAN-EXPECTED ledger (deleted, rotated, truncated -- "the append-only ledger writer
// itself never does this", so this is always an EXTERNAL/anomalous event) reads back as
// zero matching lines, which a naive breaker reads as "this task has never been
// dispatched" -- silently UN-TRIPPING an already-tripped breaker and allowing exactly the
// runaway redispatch storm (W1-T1: ~130 dispatches / ~$130 / ~10h) the breaker exists to
// stop. evaluateDispatchBreaker fixes this: within one long-lived process (the shape
// drain.ts/daemon.ts's dispatch loop actually runs in), it never lets a task's known
// dispatch count regress without a `pr.opened` line in the CURRENT read to explain it.

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "rmd-breaker-rotation-"));
}

function runStartLines(taskId: string, n: number): string {
  return Array.from({ length: n }, () => JSON.stringify({ step: "run.start", task_id: taskId })).join("\n") + "\n";
}

test("evaluateDispatchBreaker: a genuinely fresh project (no ledger, no prior baseline) reads clear -- never deadlocks the first-ever dispatch", () => {
  const dir = tmpDir();
  try {
    const ledgerPath = join(dir, "ledger.ndjson"); // never created
    const cache = createDispatchBreakerCache();
    const state = evaluateDispatchBreaker(ledgerPath, "W1-FRESH", cache, { maxDispatches: 3 });
    assert.equal(state, "clear", "absence with NO prior baseline is genuinely zero dispatches, not indeterminate");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("evaluateDispatchBreaker: an already-tripped task's ledger going ABSENT reads indeterminate, never silently clear", () => {
  const dir = tmpDir();
  try {
    const ledgerPath = join(dir, "ledger.ndjson");
    writeFileSync(ledgerPath, runStartLines("W1-TX", 5));
    const cache = createDispatchBreakerCache();

    const before = evaluateDispatchBreaker(ledgerPath, "W1-TX", cache, { maxDispatches: 3 });
    assert.equal(before, "tripped", "5 dispatches with no new owned PR >= maxDispatches(3)");

    unlinkSync(ledgerPath); // simulates the ledger vanishing -- deletion, rotation, disk issue

    const after = evaluateDispatchBreaker(ledgerPath, "W1-TX", cache, { maxDispatches: 3 });
    assert.equal(
      after,
      "indeterminate",
      "the ledger's absence is never proof of zero dispatches once real dispatch history is already known",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("evaluateDispatchBreaker: an in-place rotation (file replaced by a smaller one, no pr.opened) reads indeterminate, never a false reset", () => {
  const dir = tmpDir();
  try {
    const ledgerPath = join(dir, "ledger.ndjson");
    writeFileSync(ledgerPath, runStartLines("W1-TY", 5));
    const cache = createDispatchBreakerCache();

    const before = evaluateDispatchBreaker(ledgerPath, "W1-TY", cache, { maxDispatches: 3 });
    assert.equal(before, "tripped");

    // "Rotation": the path still exists throughout, but its content is now a fresh, much
    // smaller file with none of the prior history -- exactly what an external log-rotation
    // tool, a truncate, or a botched restore looks like from this process's point of view.
    writeFileSync(ledgerPath, runStartLines("W1-TY", 1));

    const after = evaluateDispatchBreaker(ledgerPath, "W1-TY", cache, { maxDispatches: 3 });
    assert.equal(
      after,
      "indeterminate",
      "count regressed (5 -> 1) with no pr.opened line to explain it -- must not be trusted as real progress",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("evaluateDispatchBreaker: GENUINE forward progress (a real pr.opened) still resets the count -- rotation-guard never blocks real progress", () => {
  const dir = tmpDir();
  try {
    const ledgerPath = join(dir, "ledger.ndjson");
    writeFileSync(ledgerPath, runStartLines("W1-TZ", 5));
    const cache = createDispatchBreakerCache();

    const before = evaluateDispatchBreaker(ledgerPath, "W1-TZ", cache, { maxDispatches: 3 });
    assert.equal(before, "tripped");

    // A real PR opens -- the ledger keeps ALL its history and gains one new line.
    writeFileSync(
      ledgerPath,
      runStartLines("W1-TZ", 5) +
        JSON.stringify({ step: "pr.opened", task_id: "W1-TZ", pr_url: "https://github.com/o/r/pull/9" }) +
        "\n",
    );

    const after = evaluateDispatchBreaker(ledgerPath, "W1-TZ", cache, { maxDispatches: 3 });
    assert.equal(after, "clear", "a real pr.opened legitimately explains the count dropping to 0 -- never indeterminate");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("evaluateDispatchBreaker: a clean, monotonically growing ledger with no anomaly just tracks tripped/clear normally", () => {
  const dir = tmpDir();
  try {
    const ledgerPath = join(dir, "ledger.ndjson");
    writeFileSync(ledgerPath, runStartLines("W1-TW", 1));
    const cache = createDispatchBreakerCache();

    assert.equal(evaluateDispatchBreaker(ledgerPath, "W1-TW", cache, { maxDispatches: 3 }), "clear");

    writeFileSync(ledgerPath, runStartLines("W1-TW", 2));
    assert.equal(evaluateDispatchBreaker(ledgerPath, "W1-TW", cache, { maxDispatches: 3 }), "clear");

    writeFileSync(ledgerPath, runStartLines("W1-TW", 3));
    assert.equal(evaluateDispatchBreaker(ledgerPath, "W1-TW", cache, { maxDispatches: 3 }), "tripped");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── W1-T209: THE BREAKER INVARIANT — for a task with prior dispatch history, the
// dispatch-breaker's verdict must be IDENTICAL before and after an ACTUAL rotation (as
// opposed to the tests above, which cover an arbitrary/adversarial external truncation and
// correctly fall back to "indeterminate"). rotateLedger (src/lib/ledger.ts) is deliberately
// held to a STRONGER bar than "never lies" — it must never even need the indeterminate
// fallback, because it preserves every decision-relevant line (run.start/pr.opened
// included) verbatim. A fresh DispatchBreakerCache is used on each side so this proves the
// invariant holds even across a process restart (the SCOPE NOTE on DispatchBreakerCache
// says the in-memory regression guard alone cannot survive that — real rotation must not
// need it to). ─────────────────────────────────────────────────────────────────────────

test("rotateLedger: the dispatch breaker reads TRIPPED, never indeterminate, before and after an actual rotation — a real rotation is a no-op for the breaker", () => {
  const dir = tmpDir();
  try {
    const ledgerPath = join(dir, "ledger.ndjson");
    const taskId = "W1-REAL-ROTATION";

    for (let i = 0; i < 5; i++) {
      appendLedger(ledgerPath, { run_id: `r${i}`, task_id: taskId, step: "run.start" } as LedgerLine, {
        ceilingBytes: Number.MAX_SAFE_INTEGER, // don't let setup itself trigger rotation early
      });
    }
    // Bulk of realistic ledger growth: high-frequency polling noise for OTHER activity,
    // interleaved, none of it decision-relevant to this task's breaker.
    for (let n = 0; n < 400; n++) {
      writeFileSync(
        ledgerPath,
        JSON.stringify({ step: "ci.polling", run_id: `noise-${n}`, detail: "x".repeat(64) }) + "\n",
        { flag: "a" },
      );
    }

    const beforeCache = createDispatchBreakerCache();
    const before = evaluateDispatchBreaker(ledgerPath, taskId, beforeCache, { maxDispatches: 3 });
    assert.equal(before, "tripped", "5 dispatches with no new owned PR >= maxDispatches(3)");

    const ceiling = 2000;
    assert.ok(ledgerExceedsRotationCeiling(ledgerPath, ceiling), "test setup sanity: padded past the ceiling");
    const result = rotateLedger(ledgerPath, { ceilingBytes: ceiling });
    assert.equal(result.rotated, true);

    // A FRESH cache, as a brand-new process (drain/daemon restart) would build — proving the
    // invariant does not depend on in-memory history surviving the rotation.
    const afterCache = createDispatchBreakerCache();
    const after = evaluateDispatchBreaker(ledgerPath, taskId, afterCache, { maxDispatches: 3 });
    assert.equal(
      after,
      "tripped",
      "a REAL rotation must read back identically tripped, not regress to clear OR fall back to indeterminate",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
