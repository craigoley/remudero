import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DECISION_RELEVANT_LEDGER_STEPS,
  LedgerLine,
  MAX_RETAINED_LINES_PER_STEP,
  appendLedger,
  ledgerExceedsRotationCeiling,
  rotateLedger,
} from "../src/lib/ledger.js";
import { dispatchesWithoutNewOwnedPr, isDispatchBreakerTripped, readLedgerLines } from "../src/lib/status.js";
import { DEFAULT_SWEEP_POLICY, runCreditBackfill, runSweep, type OpenPrView } from "../src/lib/sweep.js";
import { escalateCircuitBreak, deriveStrikeHistory } from "../src/run-task.js";
import type { Task } from "../src/lib/plan.js";
import type { IssueGateway } from "../src/lib/escalate.js";
import { isRatifiedInLedger } from "../src/lib/inbox.js";
import { priorEscalatedAlertIds } from "../src/lib/ops.js";
import { alreadyFiledForSignature } from "../src/lib/coverage-improvement.js";
import { parseWhitelistedProof, narrowNameFilteredArgs } from "../src/lib/review.js";

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

// ── "DERIVED FROM ITS CONSUMERS RATHER THAN HARDCODED TO A STALE LIST" (this task's own
// acceptance claim, plan/tasks.yaml). A hand-maintained comment asserting "this is every
// deciding read, verified at the time this task was implemented" is exactly the stale-list
// failure mode the claim warns against — and it already happened once: "review.posted" (read
// by run-task.ts's currentStrikeRegimeFor and review.ts's priorReviewVerdictFromLedger /
// lastPostedReviewStatusFromLedger) and "automerge.capped_override_granted" (review.ts's
// cappedOverrideFromLedger) were both real deciding reads the original hardcoded set omitted.
// This test re-derives the expected step set from the ACTUAL SOURCE of every file this
// module's own doc names as a deciding reader, on every run — not from a copy of the
// constant, and not from the doc comment above it — so a future consumer that reads a new
// `.step === "..."` (or a new `case "...":` in a `switch (line.step)`) without updating
// DECISION_RELEVANT_LEDGER_STEPS fails HERE, rather than shipping a breaker/dedup that
// silently resets on the next rotation. ───────────────────────────────────────────────────
test("DECISION_RELEVANT_LEDGER_STEPS: derived from consumers, not hardcoded — every step a real deciding reader consults is present", () => {
  // Every file this module's own doc names as reading a ledger `step` to decide something
  // (the dispatch breaker, escalation/credit/ratify/sweep dedup, the fix-strike amnesty
  // regime, and the review verdict-stability / capped-override reads).
  const consumerFiles = [
    "../src/lib/status.ts",
    "../src/run-task.ts",
    "../src/lib/sweep.ts",
    "../src/lib/inbox.ts",
    "../src/lib/ops.ts",
    "../src/lib/drain.ts",
    "../src/lib/review.ts",
  ];

  // VERIFIED non-deciding despite living in a deciding-reader file: status.ts's
  // deriveRunState reads these only to label a cosmetic phase/elapsedMs for the
  // board/status display. daemon.ts's reconstructOrphan proves they never gate a real
  // decision on their own — its `&& projection.prUrl` guard is a no-op for any case a
  // run.start/pr.opened line (both already decision-relevant, independently) did not
  // already establish. See DECISION_RELEVANT_LEDGER_STEPS's own doc comment for the proof.
  // W1-T1110: "fix.resolved" used to sit here too — status.ts's own read of it is still
  // cosmetic, but sweep.ts's fixRungStalledWithoutNewHead now reads it too, and THAT read
  // decides whether a stalled fix dispatch re-arms — a real decision, so it moved to
  // DECISION_RELEVANT_LEDGER_STEPS instead (see that Set's own doc for the citation).
  const verifiedDisplayOnly = new Set(["recon.done", "implement.resumed", "implement.done"]);

  const equalityRead = /\.step\s*(?:===|!==)\s*["']([^"']+)["']/g;
  const switchOnStep = /switch\s*\(\s*(?:line|l|record)\.step\s*\)\s*\{([\s\S]*?)\n\}/g;
  const caseLiteral = /case\s*["']([^"']+)["']\s*:/g;

  const discovered = new Set<string>();
  for (const rel of consumerFiles) {
    const src = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
    for (const m of src.matchAll(equalityRead)) discovered.add(m[1]);
    for (const sw of src.matchAll(switchOnStep)) {
      for (const m of sw[1].matchAll(caseLiteral)) discovered.add(m[1]);
    }
  }
  assert.ok(discovered.size > 10, "sanity: the scan actually found reads, not an empty/broken pattern");

  const expectedDecisionRelevant = [...discovered].filter((step) => !verifiedDisplayOnly.has(step));
  const missing = expectedDecisionRelevant.filter((step) => !DECISION_RELEVANT_LEDGER_STEPS.has(step));
  assert.deepEqual(
    missing,
    [],
    `DECISION_RELEVANT_LEDGER_STEPS is missing step(s) a real consumer reads to decide ` +
      `something (derived from source, not from the hardcoded list itself): ${missing.join(", ")}`,
  );
});

// ── W1-T1017: `review.unwired_advisory` (W1-T322's SHIPS-UNWIRED advisory floor) was absent
// from DECISION_RELEVANT_LEDGER_STEPS, so rotation dropped it like any other analytical-only
// step — measured live 4 rows against 83 rotations, 4.6% survival, against a `review.posted`
// control of live 219 / rotations 390. UNLIKE the derived-from-consumers test above, this step's
// deciding reader is a HUMAN (the operator adjudicating W1-T323's advisory-versus-blocking flip
// against this exact corpus), so it can never appear in that test's source-scanned consumer set
// — it has to be proven directly, here. ─────────────────────────────────────────────────────
test("W1-T1017: an advisory row survives a rotation that would have evicted it", () => {
  const dir = tmpDir();
  try {
    const ledgerPath = join(dir, "ledger.ndjson");
    const taskId = "W1-ADVISORY-SURVIVES";

    appendLedger(
      ledgerPath,
      { run_id: "r0", task_id: taskId, step: "review.unwired_advisory", reason_code: "scope_violation" } as LedgerLine,
      { ceilingBytes: Number.MAX_SAFE_INTEGER },
    );
    // The counterfactual: an ANALOGOUS step of identical shape, minted only for this test, that
    // is NOT in DECISION_RELEVANT_LEDGER_STEPS — exactly what review.unwired_advisory itself
    // looked like before this task. Proves registration, not the line's shape or size, is what
    // preserves the real advisory row.
    appendLedger(
      ledgerPath,
      { run_id: "r1", task_id: taskId, step: "review.still_unregistered_test_step", reason_code: "scope_violation" } as LedgerLine,
      { ceilingBytes: Number.MAX_SAFE_INTEGER },
    );
    for (let n = 0; n < 250; n++) {
      writeFileSync(ledgerPath, noiseLine(n) + "\n", { flag: "a" });
    }

    const ceiling = 2000;
    assert.ok(ledgerExceedsRotationCeiling(ledgerPath, ceiling), "test setup sanity: padded past the ceiling");
    const result = rotateLedger(ledgerPath, { ceilingBytes: ceiling });
    assert.equal(result.rotated, true);

    const linesAfter = readLedgerLines(ledgerPath);
    assert.ok(
      linesAfter.some((l) => l.task_id === taskId && l.step === "review.unwired_advisory"),
      "review.unwired_advisory must survive rotation now that it is decision-relevant",
    );
    assert.ok(
      !linesAfter.some((l) => l.task_id === taskId && l.step === "review.still_unregistered_test_step"),
      "FALSIFIER: an unregistered step of the identical shape is evicted by the same rotation — " +
        "proving registration, not the line's shape, is what kept the advisory row alive",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T1017: the registered advisory step is still bounded by the per step cap", () => {
  const dir = tmpDir();
  try {
    const ledgerPath = join(dir, "ledger.ndjson");
    const taskId = "W1-ADVISORY-CAPPED";
    const total = MAX_RETAINED_LINES_PER_STEP + 50;

    // Measure the byte size right at the cap boundary (the first MAX_RETAINED_LINES_PER_STEP
    // rows) and at the full uncapped count, then pick a ceiling strictly between the two —
    // derived from measurement, not a hardcoded guess (this file's own doctrine, see the
    // "rotateLedger: every decision-relevant step survives" test above) — so the capped-to-200
    // core comfortably fits under the ceiling (no further shedding by the convergence invariant)
    // while the full 250-row core does not (a real rotation is actually forced).
    let cappedCoreBytes = 0;
    for (let i = 0; i < total; i++) {
      appendLedger(
        ledgerPath,
        { run_id: `r${i}`, task_id: taskId, step: "review.unwired_advisory", marker: i } as LedgerLine,
        { ceilingBytes: Number.MAX_SAFE_INTEGER },
      );
      if (i === MAX_RETAINED_LINES_PER_STEP - 1) cappedCoreBytes = statSync(ledgerPath).size;
    }
    const fullCoreBytes = statSync(ledgerPath).size;
    const ceiling = cappedCoreBytes + Math.floor((fullCoreBytes - cappedCoreBytes) / 2);

    assert.ok(ledgerExceedsRotationCeiling(ledgerPath, ceiling), "test setup sanity: padded past the ceiling");
    const result = rotateLedger(ledgerPath, { ceilingBytes: ceiling });
    assert.equal(result.rotated, true);

    const linesAfter = readLedgerLines(ledgerPath);
    const advisoryLines = linesAfter.filter((l) => l.task_id === taskId && l.step === "review.unwired_advisory");
    assert.equal(
      advisoryLines.length,
      MAX_RETAINED_LINES_PER_STEP,
      `registration must not create an unbounded core — the per-step cap (${MAX_RETAINED_LINES_PER_STEP}) still bites`,
    );

    const markers = advisoryLines.map((l) => l.marker as number).sort((a, b) => a - b);
    assert.equal(markers[0], total - MAX_RETAINED_LINES_PER_STEP, "the cap drops the OLDEST excess rows, not the newest");
    assert.equal(markers[markers.length - 1], total - 1, "the newest row must always survive the cap");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T1017: previously decision relevant steps keep their retention unchanged", () => {
  const dir = tmpDir();
  try {
    const ledgerPath = join(dir, "ledger.ndjson");
    const taskId = "W1-PRIOR-STEP-UNCHANGED";
    const priorStep = "run.start";
    assert.ok(
      DECISION_RELEVANT_LEDGER_STEPS.has(priorStep),
      "sanity: run.start was already decision-relevant before this task",
    );

    const priorCount = 30;
    for (let i = 0; i < priorCount; i++) {
      appendLedger(
        ledgerPath,
        { run_id: `p${i}`, task_id: taskId, step: priorStep, marker: i } as LedgerLine,
        { ceilingBytes: Number.MAX_SAFE_INTEGER },
      );
    }
    const advisoryCount = 30;
    for (let i = 0; i < advisoryCount; i++) {
      appendLedger(
        ledgerPath,
        { run_id: `a${i}`, task_id: taskId, step: "review.unwired_advisory", marker: i } as LedgerLine,
        { ceilingBytes: Number.MAX_SAFE_INTEGER },
      );
    }

    // Same derived-ceiling discipline as the sibling test above: comfortably larger than this
    // core's own measured size so padding past it forces a real rotation without the
    // convergence invariant shedding any of this core's own (well-under-cap) rows.
    const coreBytes = statSync(ledgerPath).size;
    const ceiling = coreBytes * 4;
    for (let n = 0; n < 250; n++) {
      writeFileSync(ledgerPath, noiseLine(n) + "\n", { flag: "a" });
    }

    assert.ok(ledgerExceedsRotationCeiling(ledgerPath, ceiling), "test setup sanity: padded past the ceiling");
    const result = rotateLedger(ledgerPath, { ceilingBytes: ceiling });
    assert.equal(result.rotated, true);

    const linesAfter = readLedgerLines(ledgerPath);
    const priorLines = linesAfter.filter((l) => l.task_id === taskId && l.step === priorStep);
    const advisoryLines = linesAfter.filter((l) => l.task_id === taskId && l.step === "review.unwired_advisory");

    assert.equal(
      priorLines.length,
      priorCount,
      "run.start (already decision-relevant before this task) retains every row exactly as before — " +
        "registering review.unwired_advisory changes nothing about its retention",
    );
    assert.equal(
      advisoryLines.length,
      advisoryCount,
      "review.unwired_advisory now survives too, in the very same rotation, without displacing run.start's rows",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

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

    // The ceiling must comfortably exceed the decision-relevant core's OWN byte size, or the
    // shed-to-converge pass (rotateLedger's "THE CONVERGENCE INVARIANT" below) starts evicting
    // the oldest decision-relevant lines to make room — exactly the bug this test exists to
    // catch, just self-inflicted by the test instead of by a consumer. A hardcoded byte number
    // here is the SAME "stale hardcoded list" trap this file's own doctrine warns against for
    // the steps themselves (a future step added to DECISION_RELEVANT_LEDGER_STEPS grows this
    // core and silently starts failing this test) — so it's derived from the core's measured
    // size, with a generous multiple of headroom, rather than a fixed guess.
    const coreBytes = statSync(ledgerPath).size;
    const ceiling = coreBytes * 4;

    // Pad with enough noise to force a real rotation.
    for (let n = 0; n < 200; n++) {
      writeFileSync(ledgerPath, noiseLine(n) + "\n", { flag: "a" });
    }

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

test("rotateLedger: a malformed (non-JSON) line is archived, never retained live and never thrown on", () => {
  const dir = tmpDir();
  try {
    const ledgerPath = join(dir, "ledger.ndjson");
    const taskId = "W1-MALFORMED";

    // A genuinely unparseable line -- e.g. a torn append this or a prior crash mid-write left
    // behind (see appendLedger's own doc). isDecisionRelevantRawLine must treat this as
    // non-decision-relevant (JSON.parse throws, caught, false) rather than letting the parse
    // error escape and abort the whole rotation.
    writeFileSync(ledgerPath, "{not valid json at all\n", { flag: "a" });
    appendLedger(ledgerPath, { run_id: "r0", task_id: taskId, step: "run.start" } as LedgerLine, {
      ceilingBytes: Number.MAX_SAFE_INTEGER,
    });
    for (let n = 0; n < 250; n++) {
      writeFileSync(ledgerPath, noiseLine(n) + "\n", { flag: "a" });
    }

    const ceiling = 2000;
    assert.ok(ledgerExceedsRotationCeiling(ledgerPath, ceiling), "test setup sanity: padded past the ceiling");
    const result = rotateLedger(ledgerPath, { ceilingBytes: ceiling });
    assert.equal(result.rotated, true);

    const archiveContent = readFileSync(result.archivePath as string, "utf8");
    assert.ok(archiveContent.includes("{not valid json at all"), "the malformed line survives verbatim in the archive");

    const liveContent = readFileSync(ledgerPath, "utf8");
    assert.ok(!liveContent.includes("{not valid json at all"), "a malformed line is never retained in the live view");

    const linesAfter = readLedgerLines(ledgerPath);
    assert.ok(
      linesAfter.some((l) => l.task_id === taskId && l.step === "run.start"),
      "the decision-relevant line right next to the malformed one still survives",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── THE FALSIFIER (review round 1's unmet criterion): the tests above prove rotateLedger's
// OUTPUT matches a self-referential expectation, which is non-responsive to "a rotation that
// drops a decision-relevant line FAILS" — that claim needs an observed FAILURE when a line is
// dropped, not merely a survival check against the same constant the code already filters by.
//
// Each test below runs the SAME real production consumer three times against three ledgers
// built from ONE original (decision line + realistic noise, exceeding the ceiling):
//   1. GROUND TRUTH  — the untouched original: what the consumer should answer.
//   2. LINE DROPPED  — the original with ONLY the one decision-relevant line under test
//      removed (everything else, including all noise, identical) — simulating exactly what
//      "a rotation that drops a decision-relevant line" looks like from the consumer's side.
//      Asserts the consumer's answer is WRONG (differs from ground truth) — the FAILURE the
//      claim names, observed for real, not merely asserted never to happen.
//   3. REAL ROTATION — rotateLedger's actual output on the SAME original. Asserts the
//      consumer's answer MATCHES ground truth — proving THIS specific step is retained
//      because a real consumer needs it (derived from consumers), not because it happens to
//      appear in a list this test could not have caught being wrong. ─────────────────────────

function noiseBlock(count: number, offset = 0): string {
  return Array.from({ length: count }, (_, i) => noiseLine(offset + i)).join("\n") + "\n";
}

/** Raw (unparsed) trimmed, non-empty lines of a ledger file — the shape
 *  `alreadyFiledForSignature` consumes (a `resolveLedgerUnion` match set is raw text, never
 *  pre-parsed objects), matching the discipline every FALSIFIER below already applies. */
function rawLines(path: string): string[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

/** The counterfactual ledger content: `original` with every line whose `step` is
 *  `droppedStep` removed, all else byte-identical — "a rotation that drops a
 *  decision-relevant line from the reader's view", isolated to exactly one step. */
function withoutStep(original: string, droppedStep: string): string {
  return original
    .split("\n")
    .filter((raw) => {
      const t = raw.trim();
      if (!t) return true;
      try {
        return (JSON.parse(t) as { step?: unknown }).step !== droppedStep;
      } catch {
        return true;
      }
    })
    .join("\n");
}

test("FALSIFIER — dispatch breaker: dropping run.start lines un-trips an actually-tripped breaker; a real rotation never does", () => {
  const dir = tmpDir();
  try {
    const taskId = "W1-FALSIFY-BREAKER";
    const original =
      Array.from({ length: 6 }, (_, i) => JSON.stringify({ run_id: `r${i}`, task_id: taskId, step: "run.start" })).join(
        "\n",
      ) +
      "\n" +
      noiseBlock(300);

    const groundTruthPath = join(dir, "ground-truth.ndjson");
    writeFileSync(groundTruthPath, original);
    const groundTruth = readLedgerLines(groundTruthPath);
    const trippedGroundTruth = isDispatchBreakerTripped(groundTruth, taskId, 5);
    assert.equal(trippedGroundTruth, true, "sanity: 6 dispatches >= maxDispatches(5) really is tripped");

    const droppedPath = join(dir, "line-dropped.ndjson");
    writeFileSync(droppedPath, withoutStep(original, "run.start"));
    const dropped = readLedgerLines(droppedPath);
    const trippedAfterDrop = isDispatchBreakerTripped(dropped, taskId, 5);
    assert.equal(
      trippedAfterDrop,
      false,
      "FALSIFIER: dropping run.start lines silently un-trips the breaker — this is the exact bug this task fixes",
    );

    const rotatedPath = join(dir, "real-rotation.ndjson");
    writeFileSync(rotatedPath, original);
    const ceiling = 2000;
    assert.ok(ledgerExceedsRotationCeiling(rotatedPath, ceiling));
    const result = rotateLedger(rotatedPath, { ceilingBytes: ceiling });
    assert.equal(result.rotated, true);
    const rotated = readLedgerLines(rotatedPath);
    const trippedAfterRealRotation = isDispatchBreakerTripped(rotated, taskId, 5);
    assert.equal(
      trippedAfterRealRotation,
      trippedGroundTruth,
      "the REAL rotation retains run.start — it must read identically to ground truth, unlike the naive drop above",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("FALSIFIER — escalation dedup: dropping the dispatch.circuit_broken.escalated line re-opens a duplicate escalation issue; a real rotation never does", () => {
  const dir = tmpDir();
  try {
    const taskId = "W1-FALSIFY-ESCALATION";
    const task: Task = {
      id: taskId,
      title: "falsifier fixture",
      repo: "acme/widgets",
      depends_on: [],
      type: "implement",
      verify: "auto",
      risk: "medium",
      status: "blocked",
      attempts: 5,
    };
    const original =
      JSON.stringify({ run_id: "r0", task_id: taskId, step: "dispatch.circuit_broken.escalated", issue_url: "https://github.com/acme/widgets/issues/1", delivered: true }) +
      "\n" +
      noiseBlock(300);

    function issuesCreatingFake(): { calls: number; issues: IssueGateway } {
      const fake = {
        calls: 0,
        issues: {
          create: (_title: string, _body: string, _labels: string[]) => {
            fake.calls++;
            return `https://github.com/acme/widgets/issues/${100 + fake.calls}`;
          },
        },
      };
      return fake;
    }

    // Ground truth: the dedup line is present -> escalateCircuitBreak must be a no-op.
    const groundTruthPath = join(dir, "ground-truth.ndjson");
    writeFileSync(groundTruthPath, original);
    const gtFake = issuesCreatingFake();
    escalateCircuitBreak(task, { owner: "acme", repo: "widgets", ledgerPath: groundTruthPath, runId: "run-gt", issues: gtFake.issues });
    assert.equal(gtFake.calls, 0, "sanity: already-escalated must not create a second issue");

    // Line dropped: the SAME dedup line removed -> escalateCircuitBreak (wrongly) fires again.
    const droppedPath = join(dir, "line-dropped.ndjson");
    writeFileSync(droppedPath, withoutStep(original, "dispatch.circuit_broken.escalated"));
    const dropFake = issuesCreatingFake();
    escalateCircuitBreak(task, { owner: "acme", repo: "widgets", ledgerPath: droppedPath, runId: "run-drop", issues: dropFake.issues });
    assert.equal(
      dropFake.calls,
      1,
      "FALSIFIER: dropping the escalation-dedup line causes a DUPLICATE escalation issue to be opened",
    );

    // Real rotation retains the dedup line -> still a no-op.
    const rotatedPath = join(dir, "real-rotation.ndjson");
    writeFileSync(rotatedPath, original);
    const ceiling = 2000;
    assert.ok(ledgerExceedsRotationCeiling(rotatedPath, ceiling));
    const result = rotateLedger(rotatedPath, { ceilingBytes: ceiling });
    assert.equal(result.rotated, true);
    const rotFake = issuesCreatingFake();
    escalateCircuitBreak(task, { owner: "acme", repo: "widgets", ledgerPath: rotatedPath, runId: "run-rot", issues: rotFake.issues });
    assert.equal(rotFake.calls, 0, "the REAL rotation retains the dedup line — no duplicate escalation");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("FALSIFIER — credit-backfill dedup: dropping the verdict.merged line re-credits an already-credited merge; a real rotation never does", async () => {
  const dir = tmpDir();
  try {
    const taskId = "W1-FALSIFY-CREDIT";
    const prUrl = "https://github.com/acme/widgets/pull/42";
    const original =
      JSON.stringify({ run_id: "r0", task_id: taskId, step: "verdict.merged", pr_url: prUrl }) + "\n" + noiseBlock(300);
    const candidate = [{ taskId, prNumber: 42, prUrl, merged: true }];

    const groundTruthPath = join(dir, "ground-truth.ndjson");
    writeFileSync(groundTruthPath, original);
    const gtSummary = await runCreditBackfill(candidate, { ledgerPath: groundTruthPath, runId: "run-gt", dryRun: false });
    assert.equal(gtSummary.results[0]?.corrected, false, "sanity: already-credited must not re-correct");

    const droppedPath = join(dir, "line-dropped.ndjson");
    writeFileSync(droppedPath, withoutStep(original, "verdict.merged"));
    const dropSummary = await runCreditBackfill(candidate, { ledgerPath: droppedPath, runId: "run-drop", dryRun: false });
    assert.equal(
      dropSummary.results[0]?.corrected,
      true,
      "FALSIFIER: dropping the verdict.merged line causes a DUPLICATE verdict.merged correction to be appended",
    );

    const rotatedPath = join(dir, "real-rotation.ndjson");
    writeFileSync(rotatedPath, original);
    const ceiling = 2000;
    assert.ok(ledgerExceedsRotationCeiling(rotatedPath, ceiling));
    const result = rotateLedger(rotatedPath, { ceilingBytes: ceiling });
    assert.equal(result.rotated, true);
    const rotSummary = await runCreditBackfill(candidate, { ledgerPath: rotatedPath, runId: "run-rot", dryRun: false });
    assert.equal(rotSummary.results[0]?.corrected, false, "the REAL rotation retains verdict.merged — no re-credit");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("FALSIFIER — sweep dedup: dropping the sweep.disposed(armed) line re-arms an already-armed PR; a real rotation never does", async () => {
  const dir = tmpDir();
  try {
    const prNumber = 7;
    const pr: OpenPrView = {
      prNumber,
      prUrl: "https://github.com/acme/widgets/pull/7",
      taskId: "W1-FALSIFY-SWEEP",
      reviewState: "success",
      checksState: "green",
      unmetCriteria: [],
      priorStrikes: 0,
      lastActivityAt: new Date().toISOString(),
      headSha: "deadbeef",
      autoMergeArmed: false,
    };
    const original =
      // `head_sha` mirrors what the sweep really writes on a disposed line (impl-BC made
      // `prior.armed` sha-keyed, matching `prior.fixed` which always was). This fixture
      // predates that field; without it the dedup key is `7@` and never matches `7@deadbeef`.
      // The test's subject is ROTATION RETENTION, which is unchanged either way.
      JSON.stringify({ run_id: "r0", task_id: pr.taskId, step: "sweep.disposed", disposition: "mergeable", pr_number: prNumber, head_sha: pr.headSha, acted: true }) +
      "\n" +
      noiseBlock(300);

    async function armCount(ledgerPath: string): Promise<number> {
      let arms = 0;
      await runSweep(
        [pr],
        {
          arm: () => {
            arms++;
          },
          close: () => {},
          dispatchFix: () => {},
          escalate: () => {},
          ledgerPath,
          runId: "run-armcount",
        },
        DEFAULT_SWEEP_POLICY,
      );
      return arms;
    }

    const groundTruthPath = join(dir, "ground-truth.ndjson");
    writeFileSync(groundTruthPath, original);
    assert.equal(await armCount(groundTruthPath), 0, "sanity: already-armed must not re-arm");

    const droppedPath = join(dir, "line-dropped.ndjson");
    writeFileSync(droppedPath, withoutStep(original, "sweep.disposed"));
    assert.equal(
      await armCount(droppedPath),
      1,
      "FALSIFIER: dropping the sweep.disposed(armed) line causes a DUPLICATE arm() call",
    );

    const rotatedPath = join(dir, "real-rotation.ndjson");
    writeFileSync(rotatedPath, original);
    const ceiling = 2000;
    assert.ok(ledgerExceedsRotationCeiling(rotatedPath, ceiling));
    const result = rotateLedger(rotatedPath, { ceilingBytes: ceiling });
    assert.equal(result.rotated, true);
    assert.equal(await armCount(rotatedPath), 0, "the REAL rotation retains sweep.disposed — no duplicate arm");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("FALSIFIER — ratify dedup: dropping the ratify.approved line makes an already-ratified proposal look un-ratified; a real rotation never does", () => {
  const dir = tmpDir();
  try {
    const proposalId = "W1-FALSIFY-RATIFY";
    const original =
      JSON.stringify({ run_id: "r0", task_id: proposalId, step: "ratify.approved" }) + "\n" + noiseBlock(300);

    const groundTruthPath = join(dir, "ground-truth.ndjson");
    writeFileSync(groundTruthPath, original);
    assert.equal(isRatifiedInLedger(readLedgerLines(groundTruthPath), proposalId), true, "sanity: recorded as ratified");

    const droppedPath = join(dir, "line-dropped.ndjson");
    writeFileSync(droppedPath, withoutStep(original, "ratify.approved"));
    assert.equal(
      isRatifiedInLedger(readLedgerLines(droppedPath), proposalId),
      false,
      "FALSIFIER: dropping ratify.approved makes an already-ratified proposal look un-ratified — re-offering it",
    );

    const rotatedPath = join(dir, "real-rotation.ndjson");
    writeFileSync(rotatedPath, original);
    const ceiling = 2000;
    assert.ok(ledgerExceedsRotationCeiling(rotatedPath, ceiling));
    const result = rotateLedger(rotatedPath, { ceilingBytes: ceiling });
    assert.equal(result.rotated, true);
    assert.equal(
      isRatifiedInLedger(readLedgerLines(rotatedPath), proposalId),
      true,
      "the REAL rotation retains ratify.approved — still reads ratified",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("FALSIFIER — alert-escalation dedup: dropping the escalation.issue_opened line forgets a prior alert escalation; a real rotation never does", () => {
  const dir = tmpDir();
  try {
    const alertTaskId = "W1-FALSIFY-ALERT";
    const original =
      JSON.stringify({ run_id: "r0", task_id: alertTaskId, step: "escalation.issue_opened", class: "MANUAL" }) +
      "\n" +
      noiseBlock(300);

    const groundTruthPath = join(dir, "ground-truth.ndjson");
    writeFileSync(groundTruthPath, original);
    assert.ok(priorEscalatedAlertIds(readLedgerLines(groundTruthPath)).has(alertTaskId), "sanity: recorded as escalated");

    const droppedPath = join(dir, "line-dropped.ndjson");
    writeFileSync(droppedPath, withoutStep(original, "escalation.issue_opened"));
    assert.equal(
      priorEscalatedAlertIds(readLedgerLines(droppedPath)).has(alertTaskId),
      false,
      "FALSIFIER: dropping escalation.issue_opened forgets a prior alert escalation — it would re-fire",
    );

    const rotatedPath = join(dir, "real-rotation.ndjson");
    writeFileSync(rotatedPath, original);
    const ceiling = 2000;
    assert.ok(ledgerExceedsRotationCeiling(rotatedPath, ceiling));
    const result = rotateLedger(rotatedPath, { ceilingBytes: ceiling });
    assert.equal(result.rotated, true);
    assert.ok(
      priorEscalatedAlertIds(readLedgerLines(rotatedPath)).has(alertTaskId),
      "the REAL rotation retains escalation.issue_opened — still remembered",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("FALSIFIER — fix-strike history: dropping a fix.review line hides that a strike already reached CI-green; a real rotation never does", () => {
  const dir = tmpDir();
  try {
    const taskId = "W1-FALSIFY-STRIKE";
    const original =
      JSON.stringify({ run_id: "r0", task_id: taskId, step: "fix.dispatch", strike: 1, round: "fresh", unmet_count: 2 }) +
      "\n" +
      JSON.stringify({ run_id: "r1", task_id: taskId, step: "fix.review", strike: 1, state: "success" }) +
      "\n" +
      noiseBlock(300);

    const groundTruthPath = join(dir, "ground-truth.ndjson");
    writeFileSync(groundTruthPath, original);
    const gtHistory = deriveStrikeHistory(readLedgerLines(groundTruthPath), taskId);
    assert.equal(gtHistory[0]?.ciGreen, true, "sanity: strike 1 reached CI green");

    const droppedPath = join(dir, "line-dropped.ndjson");
    writeFileSync(droppedPath, withoutStep(original, "fix.review"));
    const dropHistory = deriveStrikeHistory(readLedgerLines(droppedPath), taskId);
    assert.equal(
      dropHistory[0]?.ciGreen,
      false,
      "FALSIFIER: dropping fix.review hides that strike 1 ever reached CI green — history now looks incomplete",
    );

    const rotatedPath = join(dir, "real-rotation.ndjson");
    writeFileSync(rotatedPath, original);
    const ceiling = 2000;
    assert.ok(ledgerExceedsRotationCeiling(rotatedPath, ceiling));
    const result = rotateLedger(rotatedPath, { ceilingBytes: ceiling });
    assert.equal(result.rotated, true);
    const rotHistory = deriveStrikeHistory(readLedgerLines(rotatedPath), taskId);
    assert.equal(rotHistory[0]?.ciGreen, true, "the REAL rotation retains fix.review — history still complete");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("FALSIFIER — W1-T470 coverage-improvement dedupe: dropping the coverage.improvement.filed line makes an unchanged debt signature look un-filed; a real rotation never does", () => {
  const dir = tmpDir();
  try {
    const signature = "src/run-task.ts";
    const original =
      JSON.stringify({ run_id: "r0", task_id: "coverage-improve", step: "coverage.improvement.filed", signature }) +
      "\n" +
      noiseBlock(300);

    const groundTruthPath = join(dir, "ground-truth.ndjson");
    writeFileSync(groundTruthPath, original);
    assert.equal(alreadyFiledForSignature(rawLines(groundTruthPath), signature), true, "sanity: recorded as already filed");

    const droppedPath = join(dir, "line-dropped.ndjson");
    writeFileSync(droppedPath, withoutStep(original, "coverage.improvement.filed"));
    assert.equal(
      alreadyFiledForSignature(rawLines(droppedPath), signature),
      false,
      "FALSIFIER: dropping coverage.improvement.filed makes an unchanged debt signature look un-filed — injectCoverageImprovementTask would refile identical content, the unbounded loop design clause (4) exists to prevent",
    );

    const rotatedPath = join(dir, "real-rotation.ndjson");
    writeFileSync(rotatedPath, original);
    const ceiling = 2000;
    assert.ok(ledgerExceedsRotationCeiling(rotatedPath, ceiling));
    const result = rotateLedger(rotatedPath, { ceilingBytes: ceiling });
    assert.equal(result.rotated, true);
    assert.equal(
      alreadyFiledForSignature(rawLines(rotatedPath), signature),
      true,
      "the REAL rotation retains coverage.improvement.filed — still reads as already filed",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── W1-T964 DESIGN (vi): THE FILE-SHA-BRACKETED MUTATION CHECK ──────────────────────────────
//
// "Read the sha256 of the edited file, remove the pinning, read it again and require it to
// DIFFER, run the suite and require the idempotency test to FAIL, restore, and require the sha
// to return to the original." (design note (vi), verbatim.) A positive test alone proves
// nothing: test/followup-rotation-idempotency.test.ts's "a re-mine after rotation yields the
// same candidate set" could in principle pass for reasons that have nothing to do with the
// three follow-up steps actually being pinned in DECISION_RELEVANT_LEDGER_STEPS — this test
// mutates the REAL, checked-out `src/lib/ledger.ts` on disk (restored in a `finally`, verified
// byte-identical by its own sha256 afterward) to remove exactly the three added lines, and
// spawns a REAL child `node --test` process, narrowed to ONLY that one positive test — the SAME
// house-dialect proof-execution shape `remudero-review`'s own `parseWhitelistedProof`/
// `narrowNameFilteredArgs` build for a bare `unit test: <name>` acceptance proof, and the SAME
// mutate/spawn/restore shape test/dispatch-lifetime-breaker.test.ts's own W1-T951 mutation
// check already established.
//
// Deliberately spawned from THIS file, targeting a DIFFERENT one:
// test/followup-rotation-idempotency.test.ts. Spawning that file from inside itself would
// re-enter this very mutation test recursively (the target file would spawn itself spawning
// itself...) — the same reason W1-T951's check lives in dispatch-lifetime-breaker.test.ts
// rather than inside open-pr-corroboration.test.ts, the file it actually mutates a consumer of.
test("W1-T964: removing the pinning fails the idempotency test", () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const ledgerTsPath = join(repoRoot, "src", "lib", "ledger.ts");
  const targetTestFile = "test/followup-rotation-idempotency.test.ts";
  const positiveTestName = "W1-T964: a re-mine after rotation yields the same candidate set";

  const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

  const original = readFileSync(ledgerTsPath, "utf8");
  const originalSha = sha256(original);

  const needle = '  "report.followups",\n  "followup.harvested",\n  "followup.deduped",\n]);';
  const occurrences = original.split(needle).length - 1;
  assert.equal(
    occurrences,
    1,
    "sanity: the three pinned follow-up steps must appear EXACTLY once, immediately before the " +
      "Set literal's close, or this mutation is not targeting the real pin",
  );
  const mutated = original.replace(needle, "]); // W1-T964 MUTATION: follow-up step pinning removed");

  const whitelisted = parseWhitelistedProof(`unit test: ${positiveTestName}`);
  assert.ok(whitelisted, "sanity: the proof text must parse as a name-filtered `unit test:` dialect proof");
  assert.ok(whitelisted!.nameFiltered, "sanity: it must be the name-filtered shape (carries --test-name-pattern)");
  const args = narrowNameFilteredArgs(whitelisted!.args, [targetTestFile]);

  let childResult: ReturnType<typeof spawnSync> | undefined;
  try {
    writeFileSync(ledgerTsPath, mutated);
    const mutatedSha = sha256(readFileSync(ledgerTsPath, "utf8"));
    assert.notEqual(mutatedSha, originalSha, "the mutation must actually change ledger.ts's bytes");

    // `NODE_TEST_CONTEXT` (set by node's OWN test runner on the process running THIS test) is
    // inherited by a plain `spawnSync` env by default — and node's test runner treats its
    // presence as "this is a recursive `run()` call" and SKIPS running any files at all, exiting
    // 0 having executed nothing. Strip it so the child is a genuinely independent `node --test`
    // invocation, not a no-op that would make this check pass for the wrong reason (a silently-
    // skipped child looks identical to a clean exit).
    const childEnv = { ...process.env };
    delete childEnv.NODE_TEST_CONTEXT;
    childResult = spawnSync(process.execPath, args, { cwd: repoRoot, encoding: "utf8", timeout: 90_000, env: childEnv });
  } finally {
    // RESTORED REGARDLESS of what the child run did — a throw, a timeout, or a pass must never
    // leave the real checked-out source mutated.
    writeFileSync(ledgerTsPath, original);
    const restoredSha = sha256(readFileSync(ledgerTsPath, "utf8"));
    assert.equal(restoredSha, originalSha, "ledger.ts must be restored byte-for-byte after the mutation check");
  }

  assert.ok(childResult, "sanity: the child process must actually have been spawned");
  assert.notEqual(
    childResult!.status,
    0,
    `removing the follow-up step pinning must fail the idempotency test — child exited ${childResult!.status}\n` +
      `stdout:\n${childResult!.stdout}\nstderr:\n${childResult!.stderr}`,
  );
});
