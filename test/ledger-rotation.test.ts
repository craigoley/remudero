import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DECISION_RELEVANT_LEDGER_STEPS,
  LedgerLine,
  appendLedger,
  ledgerExceedsRotationCeiling,
  rotateLedger,
} from "../src/lib/ledger.js";
import { dispatchesWithoutNewOwnedPr, isDispatchBreakerTripped, readLedgerLines } from "../src/lib/status.js";
import { runCreditBackfill } from "../src/lib/sweep.js";

// ── W1-T209: "the ledger grows unbounded with no archival, and any rotation that hides a
// decision-relevant line silently zeroes the dispatch breaker it also backs" (RECON R-9,
// coupled to R-16). rotateLedger (src/lib/ledger.ts) is the fix: archive the full history to
// a dated roll, verbatim, then keep ONLY the decision-relevant tail live — the lines the
// dispatch breaker, sweep dedup, and credit-backfill actually consult. THE ACCEPTANCE TEST IS
// THE BREAKER, NOT THE FILE SIZE — see test/breaker-survives-rotation.test.ts for the load-
// bearing before/after invariant; this file covers the ceiling detection, the decision-
// relevant-step survival, and sweep's own dedup surviving a rotation. ─────────────────────

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "rmd-ledger-rotation-"));
}

function noiseLine(n: number): string {
  // Realistic high-frequency, no-decision-consequence traffic (ci.polling/pr.polling —
  // exactly what plan/tasks.yaml's design note calls "everything else... archivable"),
  // padded so a handful of these alone can cross a small test ceiling.
  return JSON.stringify({ step: "ci.polling", run_id: `noise-${n}`, task_id: "W1-NOISE", detail: "x".repeat(64) });
}

test("ledgerExceedsRotationCeiling: a ledger over the ceiling with no archived roll present reports true (FAILS the check)", () => {
  const dir = tmpDir();
  try {
    const ledgerPath = join(dir, "ledger.ndjson");
    const ceiling = 500;
    writeFileSync(ledgerPath, Array.from({ length: 20 }, (_, i) => noiseLine(i)).join("\n") + "\n");

    assert.equal(
      ledgerExceedsRotationCeiling(ledgerPath, ceiling),
      true,
      "an oversized ledger with no rotation ever having run must be flagged, not silently accepted",
    );
    const archivesBefore = readdirSync(dir).filter((f) => f !== "ledger.ndjson");
    assert.deepEqual(archivesBefore, [], "no archived roll exists yet — rotation has not run");

    const result = rotateLedger(ledgerPath, { ceilingBytes: ceiling });
    assert.equal(result.rotated, true);
    assert.ok(result.archivePath, "a rotation that fires must name the archive it wrote");
    const archiveContent = readFileSync(result.archivePath as string, "utf8");
    assert.equal(archiveContent.trim().split("\n").length, 20, "the archive holds every pre-rotation line verbatim");

    assert.equal(
      ledgerExceedsRotationCeiling(ledgerPath, ceiling),
      false,
      "after archiving pure noise, the live ledger is back under the ceiling",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ledgerExceedsRotationCeiling: an absent ledger never exceeds anything — nothing to rotate", () => {
  const dir = tmpDir();
  try {
    assert.equal(ledgerExceedsRotationCeiling(join(dir, "never-created.ndjson"), 10), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rotateLedger: every decision-relevant step survives into the live view, derived from the exported consumer-sourced set (not a stale hardcoded list)", () => {
  const dir = tmpDir();
  try {
    const ledgerPath = join(dir, "ledger.ndjson");
    const taskId = "W1-DECISIONS";

    // One genuine line per decision-relevant step this task's own DECISION_RELEVANT_LEDGER_STEPS
    // constant names — built FROM the export itself, so if a future edit trims that set, this
    // test still proves whatever remains in it survives; the breaker/sweep tests below prove the
    // set is not missing anything a real consumer needs.
    let i = 0;
    for (const step of DECISION_RELEVANT_LEDGER_STEPS) {
      appendLedger(ledgerPath, { run_id: `r${i}`, task_id: taskId, step, marker: i } as LedgerLine, {
        ceilingBytes: Number.MAX_SAFE_INTEGER, // don't let appendLedger's own opportunistic rotation fire mid-setup
      });
      i++;
    }
    const expectedCount = DECISION_RELEVANT_LEDGER_STEPS.size;

    // Pad with enough noise to force a real rotation.
    for (let n = 0; n < 200; n++) {
      writeFileSync(ledgerPath, noiseLine(n) + "\n", { flag: "a" });
    }

    const ceiling = 2000;
    assert.ok(ledgerExceedsRotationCeiling(ledgerPath, ceiling), "test setup sanity: padded past the ceiling");
    const result = rotateLedger(ledgerPath, { ceilingBytes: ceiling });
    assert.equal(result.rotated, true);

    const linesAfter = readLedgerLines(ledgerPath);
    assert.equal(linesAfter.torn, 0, "rotation must not tear any surviving line");

    const survivingSteps = new Set(
      linesAfter.filter((l) => l.task_id === taskId).map((l) => l.step as string),
    );
    for (const step of DECISION_RELEVANT_LEDGER_STEPS) {
      assert.ok(survivingSteps.has(step), `decision-relevant step "${step}" was dropped by rotation`);
    }
    assert.equal(survivingSteps.size, expectedCount, "no decision-relevant line was lost or duplicated");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rotateLedger: the dispatch breaker's own predicates read identically for a task's history before and after rotation", () => {
  const dir = tmpDir();
  try {
    const ledgerPath = join(dir, "ledger.ndjson");
    const taskId = "W1-BREAKER-ROT";

    for (let i = 0; i < 6; i++) {
      appendLedger(
        ledgerPath,
        { run_id: `r${i}`, task_id: taskId, step: "run.start" } as LedgerLine,
        { ceilingBytes: Number.MAX_SAFE_INTEGER },
      );
    }
    for (let n = 0; n < 300; n++) {
      writeFileSync(ledgerPath, noiseLine(n) + "\n", { flag: "a" });
    }

    const before = readLedgerLines(ledgerPath);
    const countBefore = dispatchesWithoutNewOwnedPr(before, taskId);
    const trippedBefore = isDispatchBreakerTripped(before, taskId, 5);

    const ceiling = 2000;
    assert.ok(ledgerExceedsRotationCeiling(ledgerPath, ceiling));
    const result = rotateLedger(ledgerPath, { ceilingBytes: ceiling });
    assert.equal(result.rotated, true);

    const after = readLedgerLines(ledgerPath);
    const countAfter = dispatchesWithoutNewOwnedPr(after, taskId);
    const trippedAfter = isDispatchBreakerTripped(after, taskId, 5);

    assert.equal(countAfter, countBefore, "dispatch count must be identical across rotation");
    assert.equal(trippedAfter, trippedBefore, "breaker verdict must be identical across rotation");
    assert.equal(trippedAfter, true, "sanity: 6 dispatches >= maxDispatches(5) really was tripped");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rotateLedger: sweep's credit-backfill dedup still suppresses a duplicate correction after rotation (no re-credit of an already-credited merge)", async () => {
  const dir = tmpDir();
  try {
    const ledgerPath = join(dir, "ledger.ndjson");
    const taskId = "W1-CREDITED";
    const prUrl = "https://github.com/acme/widgets/pull/42";

    // The ledger already carries merge credit for this task — runCreditBackfill's own
    // idempotence contract (hasMergeCredit) says a repeat pass must append nothing further.
    appendLedger(
      ledgerPath,
      { run_id: "r0", task_id: taskId, step: "verdict.merged", pr_url: prUrl } as LedgerLine,
      { ceilingBytes: Number.MAX_SAFE_INTEGER },
    );
    for (let n = 0; n < 250; n++) {
      writeFileSync(ledgerPath, noiseLine(n) + "\n", { flag: "a" });
    }

    const ceiling = 2000;
    assert.ok(ledgerExceedsRotationCeiling(ledgerPath, ceiling));
    const result = rotateLedger(ledgerPath, { ceilingBytes: ceiling });
    assert.equal(result.rotated, true);

    const summary = await runCreditBackfill(
      [{ taskId, prNumber: 42, prUrl, merged: true }],
      { ledgerPath, runId: "post-rotation-run", dryRun: false },
    );

    assert.equal(summary.corrected, 0, "a rotation must not cause an already-credited merge to be re-credited");
    assert.equal(summary.results[0]?.alreadyCredited, true, "credit dedup must still see the credit after rotation");
    assert.equal(summary.results[0]?.corrected, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
