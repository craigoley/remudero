import assert from "node:assert/strict";
import { test } from "node:test";
import {
  REPLAY_CORPUS_BOUND,
  boundedCorpus,
  harnessRunnerOver,
  replayOptIn,
} from "../src/lib/replay-harness.js";
import {
  REPLAY_RESULT_STEP,
  SEEDED_GOLDENS,
  recordReplayResults,
  replayGoldens,
  replayResultLine,
  type GoldenTask,
  type ReplayOutcome,
} from "../src/lib/replay.js";
import { replayPassRateForCycle, renderReplayCalibration } from "../src/lib/retro.js";
import { COMMANDS, replayGoldensCommand } from "../src/run-task.js";

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

test("the verb is registered in the real CLI catalog, so it is reachable as a command and not just an export", () => {
  // Asserted over the LIVE registry rather than over run-task.ts's text. A source-text match would
  // pass on a `name:` that no dispatch reaches (W1-T2905's whole point: prose right, behaviour
  // wrong); reading the exported object cannot.
  const entry = COMMANDS.find((c) => c.name === "replay-goldens");
  assert.ok(entry, `an unregistered command is an export nothing can invoke; registry holds ${COMMANDS.length} verbs`);
  assert.match(entry!.syntax, /--confirm-spend/, "the syntax must show the opt-in, or an operator cannot discover it");
  assert.ok(entry!.summary.length > 0 && entry!.summary.length <= 100, "summary present and within the registry cap");
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

  // The property that matters: no ENVIRONMENT can enable it. Driven rather than grepped — a source
  // scan for `process.env` proves the spelling absent today and nothing about behaviour, while
  // this fails the moment any env var gates the decision, however it is written.
  const planted = ["RMD_REPLAY", "RMD_REPLAY_GOLDENS", "RMD_CONFIRM_SPEND", "REPLAY_GOLDENS", "CONFIRM_SPEND", "CI"];
  const saved = planted.map((k) => [k, process.env[k]] as const);
  try {
    for (const k of planted) process.env[k] = "1";
    assert.equal(replayOptIn([]).enabled, false, "no environment may authorise a spend — only the flag");
    assert.equal(replayOptIn(["--limit", "3"]).enabled, false, "nor any other flag");
    assert.equal(replayOptIn(["--confirm-spend"]).enabled, true, "control: the flag still works, so the check above is not vacuous");
  } finally {
    for (const [k, v] of saved) v === undefined ? delete process.env[k] : (process.env[k] = v);
  }
});

test("the retro module exposes no spend-bearing symbol — a reporting pass cannot reach the runner", async () => {
  // Structural, over the module's own export surface, rather than a text scan of retro.ts: what
  // matters is what a caller holding `retro` can actually invoke.
  const retro = await import("../src/lib/retro.js");
  for (const symbol of ["replayGoldensCommand", "harnessRunnerOver", "replayOptIn", "boundedCorpus"]) {
    assert.equal((retro as Record<string, unknown>)[symbol], undefined, `retro must not re-export ${symbol}: a reporting pass may never spawn workers`);
  }
  // Vacuity guard: retro really is the consumer of this leg, or the absences above are over an
  // unrelated module and prove nothing.
  assert.equal(typeof retro.replayPassRateForCycle, "function", "control: retro really is the replay consumer");
  assert.equal(typeof retro.renderReplayCalibration, "function");
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
  // Read as VALUES, not as source text: the step name is a contract with retro.ts, and comparing
  // the constant both sides actually import is what proves they still agree.
  assert.equal(REPLAY_RESULT_STEP, "replay.result", "the step name is the contract with retro.ts");
  assert.equal(typeof recordReplayResults, "function", "the emitter is reused, not replaced");
  // And the two ends genuinely agree: a line built by the shipped builder is COUNTED by retro's
  // own reducer. If either side renamed the step, this folds to zero.
  const roundTrip = replayPassRateForCycle([replayResultLine("r", "t", { goldenId: "g", class: "src-fix", passed: true, mismatches: [] })] as never);
  assert.equal(roundTrip.total, 1, "retro reads back exactly the step this writes");
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
