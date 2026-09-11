import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { DECISION_RELEVANT_LEDGER_STEPS, MAX_RETAINED_LINES_PER_STEP } from "../src/lib/ledger.js";
import {
  DEFAULT_SWEEP_POLICY,
  repeatDispositionStreaksFromLedger,
  runSweep,
  type OpenPrView,
  type SweepDeps,
} from "../src/lib/sweep.js";
import { readLedgerLines } from "../src/lib/status.js";

// ── W1-T3359: the repeat-disposition bound could not reach its own threshold ─────────────────────
//
// WHAT WAS FILED, AND WHY IT WAS WRONG. This task was filed as "the sweep writes 189 copies of every
// fact and then reads them all back" — 1,138,942 `sweep.disposed` rows carrying 6,017 distinct
// (pr, disposition) pairs — with a design that SUPPRESSED the repeats. Building it turned up the
// reason that is unsafe: `repeatDispositionStreaksFromLedger` COUNTS those rows to decide whether one
// PR's verdict has been repeating for `repeatDispositionBound` passes, and its own doc is emphatic —
// "EVERY ROW COUNTS REGARDLESS OF `acted` — gating on it would exempt exactly the shapes this bound
// exists for". The repetition is a live detector's input, and 53 rows carry `repeat_escalated: true`,
// so it has fired. Suppression would have blinded a working escalation.
//
// WHAT THE MEASUREMENT SHOWED INSTEAD, and it is worse than waste:
//   repeatDispositionBound                                    50
//   max rows for one (pr, disposition) inside the live file    12
//   sweep.disposed share of the live file                      41%  (3,225 of 7,774 lines)
//   live-file rotations                                       ~1 every 6 minutes
//   sweep.disposed in DECISION_RELEVANT_LEDGER_STEPS?          YES, already — 200 newest kept
//   => live PRs above which a recount cannot reach the bound     4  (200 retained / bound 50)
//
// Retention keeps 200 newest rows for this step ACROSS ALL PRs, so a recount can attribute only about
// 200/N to any one of N live PRs — above four, it can never reach 50 at all, and the fleet routinely
// carries ten or more. The bound fired in quieter periods and nothing reported the decay. (A first
// draft of this change claimed rotation archived the step wholesale and added a duplicate retention
// entry; both were wrong and were corrected before shipping.)
//
// THE REPAIR IS THE FIELD THAT WAS ALREADY THERE. The emitter has always written `repeat_streak` on
// every row, with a comment saying it exists "so the next pass's fold never has to guess it back out
// of row order" — and the fold guessed anyway. Reading it makes ONE surviving row carry the true
// count, which removes the 200/N ceiling entirely — no retention change is needed or made.

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The REAL fold, driven directly — never a mirror. An earlier draft of this suite MIRRORED it
 *  (the function was module-private then) and the mirror made every behavioural mutation of the
 *  committed fold survive: MEASURED, "escalated becomes durable" and "a head change no longer
 *  resets the run" both passed a full run against a deliberately broken fold. A test that models
 *  the code under test is testing itself. The fold is exported for exactly this, the same
 *  precedent `renderRepeatEscalationQuestion` already sets in that module — every assertion below
 *  therefore exercises the committed implementation directly, with no separate source-shape check
 *  needed to keep it honest. */
const foldStreaks = (lines: Array<Record<string, unknown>>): Map<number, { streak: number; escalated: boolean }> =>
  repeatDispositionStreaksFromLedger(lines);

const row = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  step: "sweep.disposed",
  pr_number: 4522,
  head_sha: "c93b421ec55799d01b1de0cc8b76d25a1cce96be",
  disposition: "blocked-fixable",
  acted: false,
  ...over,
});

// ── the repair: the count survives a rotation that keeps one row ─────────────────────────────────

test("W1-T3359: ONE surviving row carries the true streak — the rotation reset is gone", () => {
  // Exactly what a post-rotation live file looks like once the step is retained: the newest row, and
  // nothing before it. Before this change the fold recounted and read 1.
  const afterRotation = [row({ repeat_streak: 47 })];
  assert.equal(foldStreaks(afterRotation).get(4522)?.streak, 47);
});

test("W1-T3359 (falsifier): with the recorded streak ABSENT, one row reads 1 — the defect, reproduced", () => {
  // This is the state every rotation used to produce, and why a bound of 50 could not trip.
  const legacy = [row()];
  assert.equal(foldStreaks(legacy).get(4522)?.streak, 1);
  const bound = DEFAULT_SWEEP_POLICY.repeatDispositionBound;
  assert.ok(bound > 1, `positive control: the bound must be above 1 for this to matter; got ${bound}`);
  assert.ok(
    foldStreaks(legacy).get(4522)!.streak < bound,
    "one row must read below the bound — otherwise the reset was never the problem",
  );
  // …and with the field, the same single row clears it.
  assert.ok(foldStreaks([row({ repeat_streak: bound })]).get(4522)!.streak >= bound);
});

test("W1-T3359: the recount SURVIVES as the fallback, so a mid-migration corpus is not misread", () => {
  // Rows written before the field could be trusted must still fold to a real run, not to 1.
  const legacyRun = [row(), row(), row(), row()];
  assert.equal(foldStreaks(legacyRun).get(4522)?.streak, 4);
});

test("W1-T3359: a recorded streak is preferred over the recount when the two disagree", () => {
  // The writing pass knew its own position in the run; whatever rows happen to have survived do not.
  const mixed = [row(), row(), row({ repeat_streak: 91 })];
  assert.equal(foldStreaks(mixed).get(4522)?.streak, 91);
});

test("W1-T3359: a NEW run still resets — a head change is not a continuing streak", () => {
  const moved = [row({ repeat_streak: 47 }), row({ head_sha: "deadbeef", repeat_streak: 1 })];
  assert.equal(foldStreaks(moved).get(4522)?.streak, 1);
  // and a disposition change likewise
  const flipped = [row({ repeat_streak: 47 }), row({ disposition: "wait", repeat_streak: 1 })];
  assert.equal(foldStreaks(flipped).get(4522)?.streak, 1);
});

test("W1-T3359: a junk recorded value is NOT a reading — it falls back to the recount", () => {
  for (const bad of [0, -3, 2.5, "47", null, undefined, Number.NaN]) {
    const r = foldStreaks([row(), row({ repeat_streak: bad })]);
    assert.equal(r.get(4522)?.streak, 2, `repeat_streak=${String(bad)} must not be trusted`);
  }
});

// ── what must NOT change ────────────────────────────────────────────────────────────────────────

test("W1-T3359: `escalated` still derives from SURVIVING rows — W1-T2382's per-rotation re-arm is intact", () => {
  // Making the escalation durable would silently convert "once per head per rotation window" into
  // once-per-head-forever. The streak is now durable; the escalation deliberately is not.
  assert.equal(foldStreaks([row({ repeat_streak: 60 })]).get(4522)?.escalated, false);
  assert.equal(foldStreaks([row({ repeat_streak: 60, repeat_escalated: true })]).get(4522)?.escalated, true);
  // and it does NOT carry across a head change
  const moved = [row({ repeat_escalated: true }), row({ head_sha: "deadbeef" })];
  assert.equal(foldStreaks(moved).get(4522)?.escalated, false);
});

test("W1-T3359: EVERY row still counts regardless of `acted` — the fold's own invariant", () => {
  const acted = [row({ acted: true, repeat_streak: 12 })];
  assert.equal(foldStreaks(acted).get(4522)?.streak, 12, "an acted row must not be skipped");
});

// ── retention: a surviving row has to exist for the field to be read ────────────────────────────

test("W1-T3359: the step is RETAINED, so a rotation leaves a row carrying the count", () => {
  assert.ok(
    DECISION_RELEVANT_LEDGER_STEPS.has("sweep.disposed"),
    "sweep.disposed is archived wholesale, so no row survives to carry repeat_streak and the fix is inert",
  );
  // The retention budget must exceed the bound, or a retained horizon still cannot express a trip.
  assert.ok(
    MAX_RETAINED_LINES_PER_STEP > DEFAULT_SWEEP_POLICY.repeatDispositionBound,
    `retention keeps ${MAX_RETAINED_LINES_PER_STEP} rows against a bound of ${DEFAULT_SWEEP_POLICY.repeatDispositionBound}`,
  );
});

// @source-text-subject: the next test's SUBJECT genuinely is ledger.ts's own text, not its runtime
// behaviour — `DECISION_RELEVANT_LEDGER_STEPS` is a `Set`, so a literal listed twice in the array
// that builds it and a literal listed once are BEHAVIOURALLY IDENTICAL (`.has(...)` reads true
// either way); only counting the source literal can see the duplicate a first draft of this change
// introduced. See docs/comment-standard.md / test/source-text-assertion-census.test.ts for why this
// declaration, not a baseline bump, is the reviewable move.
test("W1-T3359: the retention set is UNTOUCHED — the entry was already there and must not be doubled", () => {
  // A first draft of this change added `sweep.disposed` to DECISION_RELEVANT_LEDGER_STEPS a SECOND
  // time, on a rationale that rotation archived it wholesale. Both were wrong. This pins the
  // correction so the duplicate cannot come back.
  const ledger = readFileSync(join(REPO_ROOT, "src", "lib", "ledger.ts"), "utf8");
  const occurrences = ledger.split('"sweep.disposed",').length - 1;
  assert.equal(occurrences, 1, `sweep.disposed is listed ${occurrences} times in ledger.ts — exactly one is correct`);
});

test("W1-T3359: the RECOUNT's ceiling is what the bound could not see past, and it is arithmetic", () => {
  // The defect is not that rows are archived — they are retained. It is that retention keeps 200
  // newest PER STEP shared across every PR, so a recount can attribute only ~200/N to any one of N
  // live PRs. Above N = 200/bound the recount can never reach the bound at all.
  const bound = DEFAULT_SWEEP_POLICY.repeatDispositionBound;
  const prsAtWhichRecountFails = Math.floor(MAX_RETAINED_LINES_PER_STEP / bound);
  assert.ok(bound > 0 && MAX_RETAINED_LINES_PER_STEP > 0, "positive control on both operands");
  assert.ok(
    prsAtWhichRecountFails <= 8,
    `a recount stops reaching the bound above ${prsAtWhichRecountFails} live PRs — if that is large, ` +
      "the ceiling is not the defect and this task's premise has moved",
  );
  // And the repair is independent of N: ONE row carrying the value clears the bound regardless.
  assert.ok(foldStreaks([row({ repeat_streak: bound })]).get(4522)!.streak >= bound);
});

// ── the emitter really writes the field this fold now depends on ────────────────────────────────

/** Minimal `SweepDeps`, local to this suite: only the required members, wired to a throwaway
 *  ledger file. `arm`/`close`/`dispatchFix`/`escalate` are never invoked by the mergeable-PR path
 *  exercised below, so each is a bare no-op. */
function minimalSweepDeps(): SweepDeps {
  return {
    arm: () => {},
    close: () => {},
    dispatchFix: () => {},
    escalate: () => {},
    ledgerPath: join(mkdtempSync(join(tmpdir(), "rmd-w1-t3359-")), "ledger.ndjson"),
    runId: "SWEEP-1",
  };
}

function mergeablePr(headSha: string): OpenPrView {
  return {
    prNumber: 4522,
    prUrl: "url/4522",
    taskId: "W1-A",
    reviewState: "success",
    checksState: "green",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: "2026-07-16T12:00:00Z",
    headSha,
    autoMergeArmed: false,
  };
}

test("W1-T3359: the REAL emitter writes `repeat_streak`, end to end through runSweep — not a mirror", async () => {
  // Drives the actual dispose path three times on an unchanged head, then reads the row it wrote —
  // no regex over sweep.ts stands in for the emitter here, and no fold internals are inspected.
  const deps = minimalSweepDeps();
  const target = mergeablePr("bbbb222");
  await runSweep([target], deps, DEFAULT_SWEEP_POLICY);
  await runSweep([target], deps, DEFAULT_SWEEP_POLICY);
  await runSweep([target], deps, DEFAULT_SWEEP_POLICY);
  const disposed = readLedgerLines(deps.ledgerPath).filter((l) => l.step === "sweep.disposed");
  assert.equal(disposed.length, 3, "one row per pass");
  assert.equal(disposed[2].repeat_streak, 3, "the third pass's own row must carry the streak the fold now reads");
});
