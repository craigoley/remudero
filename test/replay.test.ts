import assert from "node:assert/strict";
import { test } from "node:test";
import {
  compareOutcome,
  recordReplayResults,
  replayGolden,
  replayGoldens,
  replayPassRate,
  replayResultLine,
  REPLAY_RESULT_STEP,
  SEEDED_GOLDENS,
  type GoldenTask,
  type HarnessRunner,
  type ReplayOutcome,
} from "../src/lib/replay.js";

// ── W1-T165 — the golden-task regression suite, the missing Self-Harness leg ─
//
// The replay mechanism drives each golden's task spec through a CANDIDATE harness
// (the `HarnessRunner` seam) and compares the outcome to the golden's recorded
// terminal disposition/shape. This file proves both acceptance claims: (1) an
// UNCHANGED harness (one that reproduces every golden's recorded expectation)
// passes all three seeded goldens; (2) a DELIBERATELY-DEGRADED harness change
// FAILS at least one golden on replay — the falsifier a harness that always
// "passes" would defeat.

/** An "unchanged" candidate harness — reproduces every golden's own recorded
 *  expectation exactly, standing in for a harness a change has not touched. */
const unchangedHarness: HarnessRunner = (golden: GoldenTask): ReplayOutcome => ({
  verdict: golden.expected.verdict,
  filesTouched: golden.expected.filesTouched,
  prTrailerTaskId: golden.expected.prTrailerTaskId,
  ...(golden.expected.fixDispatches !== undefined ? { fixDispatches: golden.expected.fixDispatches } : {}),
});

test("SEEDED_GOLDENS: exactly 3 goldens, spanning the three workflow classes named in the task design", () => {
  assert.equal(SEEDED_GOLDENS.length, 3, "start minimal — 3 goldens, not a full curated corpus");
  const classes = new Set(SEEDED_GOLDENS.map((g) => g.class));
  assert.deepEqual([...classes].sort(), ["doc-fix-rung", "plan-filing", "src-fix"]);
});

// ── acceptance claim 1: replay passes all three goldens against an unchanged harness ─

test("replayGoldens: an unchanged harness passes all three seeded goldens", async () => {
  const results = await replayGoldens(SEEDED_GOLDENS, unchangedHarness);
  assert.equal(results.length, 3);
  for (const r of results) {
    assert.equal(r.passed, true, `golden ${r.goldenId} should pass against an unchanged harness: ${r.mismatches.join("; ")}`);
    assert.deepEqual(r.mismatches, []);
  }
  const rate = replayPassRate(results);
  assert.deepEqual(rate, { total: 3, passed: 3, rate: 1 });
});

// ── acceptance claim 2 (the falsifier): a deliberately-degraded harness FAILS replay ─

test("replayGoldens: a deliberately-degraded harness change FAILS at least one golden (the falsifier)", async () => {
  // A "degraded" harness: correct on plan-filing and doc-fix-rung, but a src-fix change now
  // lands the fix in the WRONG file (a plausible real regression shape — a worker prompt
  // change causing the diff to land on a different path than the golden's known-good run).
  const degradedHarness: HarnessRunner = (golden: GoldenTask): ReplayOutcome => {
    if (golden.class === "src-fix") {
      return {
        verdict: golden.expected.verdict,
        filesTouched: ["src/lib/wrong-file.ts"],
        prTrailerTaskId: golden.expected.prTrailerTaskId,
      };
    }
    return unchangedHarness(golden) as ReplayOutcome;
  };
  const results = await replayGoldens(SEEDED_GOLDENS, degradedHarness);
  const failed = results.filter((r) => !r.passed);
  assert.ok(failed.length >= 1, "a degraded change that passes replay FAILS this test");
  const srcFixResult = results.find((r) => r.class === "src-fix");
  assert.equal(srcFixResult?.passed, false);
  assert.match(srcFixResult!.mismatches.join("; "), /filesTouched/);
  // the OTHER two goldens are unaffected — the regression is isolated to what actually changed.
  assert.equal(results.find((r) => r.class === "plan-filing")?.passed, true);
  assert.equal(results.find((r) => r.class === "doc-fix-rung")?.passed, true);

  const rate = replayPassRate(results);
  assert.equal(rate.total, 3);
  assert.equal(rate.passed, 2);
  assert.equal(rate.rate, 2 / 3);
});

test("replayGoldens: a harness that passes visibly (correct verdict/trailer) but drops a fix-rung round still FAILS the doc-fix-rung golden", async () => {
  const noHealHarness: HarnessRunner = (golden: GoldenTask): ReplayOutcome => ({
    verdict: golden.expected.verdict,
    filesTouched: golden.expected.filesTouched,
    prTrailerTaskId: golden.expected.prTrailerTaskId,
    fixDispatches: 0,
  });
  const result = await replayGolden(SEEDED_GOLDENS.find((g) => g.class === "doc-fix-rung")!, noHealHarness);
  assert.equal(result.passed, false);
  assert.match(result.mismatches.join("; "), /fixDispatches/);
});

// ── compareOutcome (the comparison half, pure) ──────────────────────────────

test("compareOutcome: names every mismatched field, not just the first", () => {
  const golden = SEEDED_GOLDENS[0]!;
  const outcome: ReplayOutcome = { verdict: "blocked_fixable", filesTouched: [], prTrailerTaskId: "WRONG-ID" };
  const result = compareOutcome(golden, outcome);
  assert.equal(result.passed, false);
  assert.equal(result.mismatches.length, 3);
  assert.match(result.mismatches[0]!, /verdict/);
  assert.match(result.mismatches[1]!, /filesTouched/);
  assert.match(result.mismatches[2]!, /prTrailerTaskId/);
});

test("compareOutcome: filesTouched comparison is ORDER-independent — same set, different order still passes", () => {
  const golden = SEEDED_GOLDENS.find((g) => g.class === "src-fix")!;
  const outcome: ReplayOutcome = {
    verdict: golden.expected.verdict,
    filesTouched: [...golden.expected.filesTouched].reverse(),
    prTrailerTaskId: golden.expected.prTrailerTaskId,
  };
  assert.equal(compareOutcome(golden, outcome).passed, true);
});

// ── replayResultLine / recordReplayResults (the emission half) ─────────────

test("replayResultLine: builds the ledger line's shape, pure — never writes", () => {
  const result = { goldenId: "golden-src-fix-1", class: "src-fix" as const, passed: false, mismatches: ["verdict: expected x, got y"] };
  const line = replayResultLine("RUN-1", "W1-T165", result);
  assert.equal(line.step, REPLAY_RESULT_STEP);
  assert.equal(line.run_id, "RUN-1");
  assert.equal(line.task_id, "W1-T165");
  assert.equal(line.golden_id, "golden-src-fix-1");
  assert.equal(line.class, "src-fix");
  assert.equal(line.passed, false);
  assert.deepEqual(line.mismatches, ["verdict: expected x, got y"]);
});

test("replayResultLine: a PASSING result carries no mismatches field at all", () => {
  const result = { goldenId: "golden-plan-filing-1", class: "plan-filing" as const, passed: true, mismatches: [] };
  const line = replayResultLine("RUN-1", "W1-T165", result);
  assert.equal("mismatches" in line, false);
});

test("recordReplayResults: writes one ledger line per result via the injectable writer, never touching disk in a test", async () => {
  const written: unknown[] = [];
  const results = await replayGoldens(SEEDED_GOLDENS, unchangedHarness);
  recordReplayResults("RUN-1", "W1-T165", results, {
    ledgerPath: "/dev/null/unused",
    writeLedger: (_path, line) => void written.push(line),
  });
  assert.equal(written.length, 3);
  assert.ok(written.every((l) => (l as { step: string }).step === REPLAY_RESULT_STEP));
});
