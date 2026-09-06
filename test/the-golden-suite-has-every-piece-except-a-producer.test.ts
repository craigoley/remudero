import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  REPLAY_CORPUS_BOUND,
  boundedCorpus,
  harnessRunnerOver,
  replayOptIn,
} from "../src/lib/replay-harness.js";
import {
  REPLAY_RESULT_STEP,
  SEEDED_GOLDENS,
  replayGoldens,
  replayResultLine,
  type GoldenTask,
  type ReplayOutcome,
} from "../src/lib/replay.js";
import { replayPassRateForCycle, renderReplayCalibration } from "../src/lib/retro.js";
import { replayGoldensCommand } from "../src/run-task.js";

// ── W1-T2689 ──────────────────────────────────────────────────────────────────────────────────
//
// MEASURED: `replayGoldens` had ZERO production callers. The corpus, the seam, the driver, the
// emitter and retro.ts's consumer all shipped and were correct; only a producer was missing, so the
// Self-Harness leg reported "no replay run recorded" BY CONSTRUCTION. It went unnoticed because the
// consumer degrades honestly -- "NOT a confirmed 0% (P48: no naked zero)" reads as normal forever.
//
// The producer SPENDS REAL MONEY, unlike every other retro rung, so the two safety properties are
// asserted here as hard behaviour rather than left to a caller's discipline: opt-in per invocation,
// and a declared bound that clamps.

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** A dispatch that RECORDS what it was asked to run and returns the golden's own expectation, so a
 *  replay through it PASSES. The recorder is the point: "how many goldens did this cost" is the
 *  question the bound exists to answer, and a stub that returned a fixed outcome could not answer it. */
function recordingDispatch(seen: string[]): (g: GoldenTask) => ReplayOutcome {
  return (g) => {
    seen.push(g.id);
    return {
      verdict: g.expected.verdict,
      filesTouched: [...g.expected.filesTouched],
      prTrailerTaskId: g.expected.prTrailerTaskId,
      ...(g.expected.fixDispatches === undefined ? {} : { fixDispatches: g.expected.fixDispatches }),
    };
  };
}

function ledgerRecorder(): { lines: Record<string, unknown>[]; write: (p: string, l: Record<string, unknown>) => void } {
  const lines: Record<string, unknown>[] = [];
  return { lines, write: (_p, l) => void lines.push(l) };
}

// ── criterion 1: a PRODUCTION caller drives the replay through the existing seam ───────────────

test("run-task.ts drives replayGoldens through the HarnessRunner seam — the driver is no longer test-only", () => {
  const src = readFileSync(join(REPO_ROOT, "src/run-task.ts"), "utf8");
  assert.match(src, /replayGoldens\(/, "the production caller must invoke the shipped driver, not reimplement it");
  assert.match(src, /harnessRunnerOver\(/, "and it must go through the HarnessRunner seam rather than around it");

  // Vacuity guard: this file is also the one the assertion reads, so prove the recognizer can FAIL.
  assert.doesNotMatch(src, /replayGoldensNeverDefinedAnywhere\(/, "control: the matcher discriminates rather than matching anything");
});

test("the verb is registered in the CLI catalog, so it is reachable as a command and not just an export", () => {
  const src = readFileSync(join(REPO_ROOT, "src/run-task.ts"), "utf8");
  assert.match(src, /name: "replay-goldens"/, "an unregistered command is an export nothing can invoke");
  assert.match(src, /cmd === "replay-goldens"/, "and it must be dispatched, not merely catalogued");
});

// ── criterion 2: a real replay writes one line per golden, and the retro reports the rate ──────

test("a replay writes exactly one REPLAY_RESULT_STEP line per golden, and retro's own reducer reports the cycle's rate", async () => {
  const seen: string[] = [];
  const rec = ledgerRecorder();
  const code = await replayGoldensCommand(["--confirm-spend", "--ledger", "/tmp/unused-by-the-recorder"], {
    dispatch: recordingDispatch(seen),
    writeLedger: rec.write as never,
    now: () => 1700000000000,
    log: () => {},
  });

  assert.equal(code, 0, "every golden reproduced its expectation, so the run passed");
  assert.equal(seen.length, SEEDED_GOLDENS.length, "every selected golden was actually dispatched");
  assert.equal(rec.lines.length, SEEDED_GOLDENS.length, "ONE line per golden — not one per run, not one per class");
  assert.ok(
    rec.lines.every((l) => l.step === REPLAY_RESULT_STEP),
    "written under the step retro.ts reads back",
  );

  // Drive the REAL consumer over what actually landed, rather than asserting the shape and stopping:
  // this is the proof the leg reports a rate, not merely that JSON was appended.
  const cal = replayPassRateForCycle(rec.lines as never);
  assert.equal(cal.total, SEEDED_GOLDENS.length);
  assert.equal(cal.passed, SEEDED_GOLDENS.length);
  const rendered = renderReplayCalibration(cal);
  assert.doesNotMatch(rendered, /No replay run recorded/, "with a real run recorded, the honest-degradation text must be GONE");
});

test("a regressed golden is recorded as a FAILURE and the verb's exit code says so", async () => {
  const rec = ledgerRecorder();
  const code = await replayGoldensCommand(["--confirm-spend", "--ledger", "/tmp/unused", "--limit", "1"], {
    dispatch: (g) => ({ verdict: "blocked", filesTouched: [...g.expected.filesTouched], prTrailerTaskId: g.expected.prTrailerTaskId }),
    writeLedger: rec.write as never,
    log: () => {},
  });
  assert.equal(code, 1, "a harness that no longer reproduces the golden is a regression, not a pass");
  assert.equal(rec.lines.length, 1);
  assert.equal(rec.lines[0]!.passed, false, "and it is recorded as failed, so the retro's rate reflects it");
});

// ── criterion 3: an invocation that runs NO golden writes NO line ──────────────────────────────

test("a zero-golden invocation dispatches nothing, writes NO line, and leaves the no-naked-zero path reachable", async () => {
  const seen: string[] = [];
  const rec = ledgerRecorder();
  const code = await replayGoldensCommand(["--confirm-spend", "--ledger", "/tmp/unused", "--limit", "0"], {
    dispatch: recordingDispatch(seen),
    writeLedger: rec.write as never,
    log: () => {},
  });

  assert.equal(code, 0, "running nothing is not a failure");
  assert.deepEqual(seen, [], "nothing dispatched — so nothing spent");
  assert.deepEqual(rec.lines, [], "and NOTHING written: an empty-but-present run would fabricate a zero");

  // The consumer's honest degradation must still be reachable — that is what the silence protects.
  const rendered = renderReplayCalibration(replayPassRateForCycle([]));
  assert.match(rendered, /No replay run recorded/, "P48: a cycle with no run is not a confirmed 0%");
});

test("--ledger is REQUIRED: without it the verb refuses before dispatching, rather than spending and recording nowhere", async () => {
  // A spend that records nothing is worse than one that never ran: the money is gone and the
  // Self-Harness leg still reports "no run recorded". The refusal must therefore precede the
  // dispatch, not follow it.
  const seen: string[] = [];
  const rec = ledgerRecorder();
  const code = await replayGoldensCommand(["--confirm-spend"], {
    dispatch: recordingDispatch(seen),
    writeLedger: rec.write as never,
    log: () => {},
  });
  assert.equal(code, 2, "a refusal, not a run that writes nowhere");
  assert.deepEqual(seen, [], "nothing dispatched — the refusal is before the spend");
  assert.deepEqual(rec.lines, []);
});

// ── criterion 4: opt-in, and never fires on a retro tick ───────────────────────────────────────

test("without --confirm-spend the verb refuses, dispatches nothing and writes nothing", async () => {
  const seen: string[] = [];
  const rec = ledgerRecorder();
  const code = await replayGoldensCommand(["--ledger", "/tmp/unused"], {
    dispatch: recordingDispatch(seen),
    writeLedger: rec.write as never,
    log: () => {},
  });
  assert.equal(code, 2, "a refusal, not a silent no-op");
  assert.deepEqual(seen, [], "the refusal comes BEFORE any dispatch — otherwise the gate is decoration");
  assert.deepEqual(rec.lines, []);
});

test("the opt-in is a FLAG, with no env-var or config fallback a retro tick could inherit", () => {
  assert.equal(replayOptIn(["--confirm-spend"]).enabled, true);
  assert.equal(replayOptIn([]).enabled, false);
  assert.match(replayOptIn([]).reason, /SPENDS REAL MONEY/, "the refusal says why, so an operator need not read the source");

  // The property that matters: no environment can enable it. If this ever reads an env var, a test
  // spawn or a CI job could inherit a spend — the exact shape of the mutation gate's ambient-ledger
  // defect, which wrote 35 junk lines into an operator's real ledger from ordinary test spawns.
  const src = readFileSync(join(REPO_ROOT, "src/lib/replay-harness.ts"), "utf8");
  assert.doesNotMatch(src, /process\.env/, "no env var may gate a spend");
  assert.doesNotMatch(src, /loadConfig/, "and no config default either");
});

test("the retro path cannot fire this runner — the reporting rung names none of its spend-bearing symbols", () => {
  const retro = readFileSync(join(REPO_ROOT, "src/lib/retro.ts"), "utf8");
  for (const symbol of ["replayGoldensCommand", "harnessRunnerOver", "replayOptIn", "boundedCorpus", "ReplayDispatch"]) {
    assert.doesNotMatch(retro, new RegExp(symbol), `retro.ts must not reach ${symbol}: a reporting pass may never spawn workers`);
  }
  // Vacuity guard: retro.ts must genuinely be the file that READS this leg, or the silence above is
  // over an unrelated module and proves nothing.
  assert.match(retro, /replayPassRateForCycle/, "control: retro.ts really is the replay consumer");
});

// ── criterion 5: the corpus is bounded, and the bound is DECLARED ──────────────────────────────

test("the per-invocation bound is a declared constant and boundedCorpus clamps to it", () => {
  assert.equal(typeof REPLAY_CORPUS_BOUND, "number");
  assert.ok(REPLAY_CORPUS_BOUND > 0, "a bound of zero would disable the leg rather than bound it");

  const many: GoldenTask[] = Array.from({ length: REPLAY_CORPUS_BOUND + 5 }, (_, i) => ({
    ...SEEDED_GOLDENS[0]!,
    id: `synthetic-${i}`,
  }));
  assert.equal(boundedCorpus(many).length, REPLAY_CORPUS_BOUND, "the default selection is the declared ceiling");
  assert.equal(
    boundedCorpus(many, REPLAY_CORPUS_BOUND + 100).length,
    REPLAY_CORPUS_BOUND,
    "an explicit LARGER ask is clamped — the bound is a ceiling, not a default",
  );
  assert.equal(boundedCorpus(many, 1).length, 1, "a smaller ask is honoured");
});

test("a nonsensical limit THROWS rather than being coerced into a different corpus than the operator asked for", () => {
  assert.throws(() => boundedCorpus(SEEDED_GOLDENS, -1), /non-negative integer/);
  assert.throws(() => boundedCorpus(SEEDED_GOLDENS, 2.5), /non-negative integer/);
  assert.throws(() => boundedCorpus(SEEDED_GOLDENS, Number.NaN), /non-negative integer/);
});

test("the verb refuses a nonsensical --limit before dispatching anything", async () => {
  const seen: string[] = [];
  const code = await replayGoldensCommand(["--confirm-spend", "--ledger", "/tmp/unused", "--limit", "-3"], {
    dispatch: recordingDispatch(seen),
    log: () => {},
  });
  assert.equal(code, 2);
  assert.deepEqual(seen, [], "refused before the spend, not after");
});

// ── criterion 6: the ledger shape and the retro reducer are UNCHANGED ──────────────────────────

test("the recorded line is replayResultLine's own shape, field for field — the consumer reads new lines untouched", async () => {
  const rec = ledgerRecorder();
  await replayGoldensCommand(["--confirm-spend", "--ledger", "/tmp/unused", "--limit", "1"], {
    dispatch: recordingDispatch([]),
    writeLedger: rec.write as never,
    now: () => 1700000000000,
    log: () => {},
  });

  const golden = SEEDED_GOLDENS[0]!;
  const expected = replayResultLine("replay-1700000000000", "W1-T2689", {
    goldenId: golden.id,
    class: golden.class,
    passed: true,
    mismatches: [],
  });
  assert.deepEqual(rec.lines[0], expected, "produced by the shipped builder, not by a second hand-rolled shape");
});

test("this task changes neither replay.ts's emitter nor retro.ts's reducer — the pieces that already worked are untouched", () => {
  // The shard names these OUT of scope by name. Asserted rather than trusted: a producer that
  // quietly reshaped the ledger line would break the consumer that has been correct all along.
  const replaySrc = readFileSync(join(REPO_ROOT, "src/lib/replay.ts"), "utf8");
  assert.match(replaySrc, /export const REPLAY_RESULT_STEP = "replay\.result";/, "the step name is the contract with retro.ts");
  assert.match(replaySrc, /export function recordReplayResults\(/, "the emitter is reused, not replaced");
});

// ── the seam itself ────────────────────────────────────────────────────────────────────────────

test("harnessRunnerOver does NOT swallow a dispatch failure — a broken dispatch is not a failed replay", async () => {
  // Merging the two would report a harness regression that did not happen: the golden never ran.
  const runner = harnessRunnerOver({
    dispatch: () => {
      throw new Error("sandbox unreachable");
    },
  });
  await assert.rejects(() => Promise.resolve(runner(SEEDED_GOLDENS[0]!)), /sandbox unreachable/);
});

test("replayGoldens over the real seam returns one result per golden, in order", async () => {
  const seen: string[] = [];
  const results = await replayGoldens([...SEEDED_GOLDENS], harnessRunnerOver({ dispatch: recordingDispatch(seen) }));
  assert.deepEqual(
    results.map((r) => r.goldenId),
    SEEDED_GOLDENS.map((g) => g.id),
  );
  assert.ok(results.every((r) => r.passed), "an unchanged harness reproduces every golden");
});
