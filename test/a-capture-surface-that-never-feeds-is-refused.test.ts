/**
 * W1-T3348 — A CADENCE MARKER PROVES THE RUNG FIRED, NOT THAT ITS INPUTS ARE ALIVE.
 *
 * `state/last-feedback-docket.json` reports the feedback docket `fresh` whenever the weekly rung
 * ran, and the rung runs whether or not any human ever typed anything. Measured on the daemon host
 * over the ledger union (919 archives + live file): 5 `feedback_docket` rows exist in the whole
 * corpus — 3 `.empty`, 2 `.published` — and every `.empty` row carries the same five zeros in
 * `counts_by_source`. Four of the five capture surfaces have produced ZERO items ever, and the
 * marker has read `fresh` throughout. A rung firing weekly over permanently-empty surfaces reports
 * green forever, which is the vacuous-pass family this repo's own gates distrust.
 *
 * WHY THIS LANDS IN `doctor` AND NOT BESIDE `CADENCE_MARKERS`. The obvious home is
 * `cadenceMarkerRows` (status-board.ts, W1-T3236) — but that whole family is itself unwired:
 * `CADENCE_MARKERS`, `cadenceMarkerRows`, `CADENCE_STALE_INTERVALS`, `livenessState` and four more
 * status-board exports have NO production consumer, only tests. Adding a capture-surface row there
 * would inherit exactly the deadness this task exists to end. `buildDoctorReport` is pure over
 * injected `ledgerLines` and its worst verdict drives `exitCodeFor`, so a check placed there
 * REFUSES — non-zero exit — rather than rendering into a report nobody reads.
 *
 * IT MUST NOT FIRE ON AN UNOBSERVED POPULATION. This repo's recurring defect is a bound that
 * fires on a healthy condition, so a corpus with fewer than MIN_FIRES observed docket fires is
 * reported OK and NAMED as not-yet-judged — never FAIL.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { judgeCaptureSurfaceLiveness, buildDoctorReport, exitCodeFor } from "../src/lib/doctor.js";

const SOURCES = ["reframe", "operator_feedback", "rejected_feedback", "question_answer", "operator_note"] as const;

/** A `feedback_docket.empty` row exactly as `runFeedbackDocketRung` writes one. */
function emptyRow(ts: string, counts: Partial<Record<(typeof SOURCES)[number], number>> = {}): Record<string, unknown> {
  const full = Object.fromEntries(SOURCES.map((s) => [s, counts[s] ?? 0]));
  return { ts, step: "feedback_docket.empty", task_id: "DAEMON", counts_by_source: full };
}

test("W1-T3348: a surface silent across every observed fire is REFUSED, not reported fresh", () => {
  const rows = [emptyRow("2026-08-12T00:00:00.000Z"), emptyRow("2026-08-20T00:00:00.000Z"), emptyRow("2026-08-27T00:00:00.000Z")];
  const check = judgeCaptureSurfaceLiveness(rows);

  assert.equal(check.verdict, "FAIL", "five surfaces that have never carried an item must refuse");
  // Every dead surface is NAMED. A bare count would be the same vacuous report this replaces.
  for (const s of SOURCES) assert.match(check.detail ?? "", new RegExp(s), `${s} must be named`);
  assert.match(check.measured, /3 counted fire\(s\) of 3 observed/, "the measured side states how many fires it actually judged");
});

test("W1-T3348: the refusal reaches the exit code — this is a gate, not a rendered row", () => {
  const rows = [emptyRow("2026-08-12T00:00:00.000Z"), emptyRow("2026-08-20T00:00:00.000Z"), emptyRow("2026-08-27T00:00:00.000Z")];
  const report = buildDoctorReport({
    ledgerLines: rows,
    nowMs: Date.parse("2026-08-28T00:00:00.000Z"),
    candidateCount: 0,
    totalLocks: 0,
    deadLocks: 0,
    gitLocks: [],
    mem: { availableBytes: 8e9, totalBytes: 16e9, swapTotalBytes: 0 },
    runningNodeVersion: "22.22.3",
    nvmrcVersion: "22.22.3",
  } as never);

  const mine = report.checks.find((c) => c.name === "capture-surfaces");
  assert.ok(mine, "the check is assembled into the real doctor report, not merely exported");
  assert.equal(mine!.verdict, "FAIL");
  assert.equal(report.exitCode, 2, "a dead capture surface must make `rmd doctor` exit non-zero");
  assert.equal(exitCodeFor("FAIL"), 2);
});

test("W1-T3348: a surface that fed in the most recent fire is OK, and one that fed only long ago WARNS", () => {
  const fed = [
    emptyRow("2026-08-12T00:00:00.000Z", { reframe: 2 }),
    emptyRow("2026-08-20T00:00:00.000Z", { reframe: 1 }),
    emptyRow("2026-08-27T00:00:00.000Z", { reframe: 3 }),
  ];
  // Every surface but `reframe` is still dead here, so the overall verdict stays FAIL — but the
  // per-surface detail must not slander a channel that is demonstrably carrying items.
  const live = judgeCaptureSurfaceLiveness(fed);
  assert.doesNotMatch(live.detail ?? "", /reframe: never/, "a surface with items must not be reported never");

  const stale = judgeCaptureSurfaceLiveness([
    emptyRow("2026-08-12T00:00:00.000Z", { reframe: 2, operator_feedback: 1, rejected_feedback: 1, question_answer: 1, operator_note: 1 }),
    emptyRow("2026-08-20T00:00:00.000Z"),
    emptyRow("2026-08-27T00:00:00.000Z"),
  ]);
  assert.equal(stale.verdict, "WARN", "every surface fed once but none recently — stale, not never");
  assert.match(stale.detail ?? "", /stale/, "the stale state is named, distinct from never");
});

test("W1-T3348: too few observed fires is OK and says so — the bound never fires on an unobserved population", () => {
  const one = judgeCaptureSurfaceLiveness([emptyRow("2026-08-27T00:00:00.000Z")]);
  assert.equal(one.verdict, "OK", "one fire cannot support a never-across-three claim");
  assert.match(one.detail ?? "", /not yet judged|too few/i, "it says WHY it is OK rather than implying health");

  const none = judgeCaptureSurfaceLiveness([]);
  assert.equal(none.verdict, "OK", "no docket rows at all is nothing measured, never a failure");
});

test("W1-T3348: a publish fire cannot witness silence, and is NAMED rather than counted either way", () => {
  // MEASURED on the daemon host: `feedback_docket.published` rows carry no `counts_by_source`,
  // and BOTH publishes there came from `rejected_feedback`. Folding them in as silent fires
  // reported that demonstrably live channel as `never` — a false accusation from missing data.
  // A publish is positive evidence some surface fed; it is never evidence that one did not.
  const rows = [
    emptyRow("2026-08-12T00:00:00.000Z"),
    emptyRow("2026-08-20T00:00:00.000Z"),
    { ts: "2026-09-03T00:00:00.000Z", step: "feedback_docket.published", proposal_id: "FD-x", task_id: "DAEMON" },
  ];
  const check = judgeCaptureSurfaceLiveness(rows);
  assert.equal(check.verdict, "OK", "only TWO fires can witness silence here, under the three-fire floor");
  assert.match(check.measured, /2 counted fire\(s\) of 3 observed/, "counted and observed are reported separately");
  assert.match(check.detail ?? "", /cannot witness silence/, "the unjudgeable fire is named, not silently folded in");
});

test("W1-T3348: three counted fires still refuse even when publishes ride alongside", () => {
  const rows = [
    emptyRow("2026-08-12T00:00:00.000Z"),
    emptyRow("2026-08-20T00:00:00.000Z"),
    emptyRow("2026-08-27T00:00:00.000Z"),
    { ts: "2026-09-03T00:00:00.000Z", step: "feedback_docket.published", proposal_id: "FD-x", task_id: "DAEMON" },
  ];
  const check = judgeCaptureSurfaceLiveness(rows);
  assert.equal(check.verdict, "FAIL");
  assert.match(check.measured, /3 counted fire\(s\) of 4 observed/);
});
