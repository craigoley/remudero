// W1-T4675 — A QUESTION NOBODY ANSWERS BLOCKS FOREVER. Each escalation already names one
// default from its fixed options (`Escalation.recommendation`, §4); this proves the fleet now
// ACTS on it: once the operator has SEEN a question and an adaptive window passes without
// objection, the default is taken as the answer, ledgered with origin "default", and a single
// action undoes it — MANUAL and HARD_STOP never auto-default, no matter how long they sit.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  applyDefaultAnswer,
  classifyAsk,
  shouldApplyDefault,
  undoDefaultAnswer,
  DEFAULT_ANSWER_APPLIED_STEP,
  DEFAULT_ANSWER_ORIGIN,
  DEFAULT_ANSWER_UNDONE_STEP,
  type Escalation,
  type EscalationClass,
} from "../src/lib/escalate.js";

function ledgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), "rmd-default-answer-")), "ledger.ndjson");
}

function readLedgerLines(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

/** A question-shaped escalation: two machine-executed options naming no operator-only act, so
 *  {@link classifyAsk} reads "question" for whatever class the caller overrides. */
function questionEscalation(over: Partial<Escalation> = {}): Escalation {
  return {
    class: "BLOCKED",
    taskId: "W1-TX",
    summary: "a question with a named default",
    detail: "the fixture escalation this suite drives.",
    options: [
      { label: "retry", detail: "resume the run with a fresh worker" },
      { label: "abandon", detail: "drop the task and re-plan" },
    ],
    recommendation: "retry",
    ...over,
  };
}

test("W1-T4675: an unanswered question takes its default only after it was seen and the window passed", () => {
  const e = questionEscalation();
  assert.equal(classifyAsk(e), "question", "fixture must be question-shaped for this claim to mean anything");

  const windowMs = 1000;
  const nowMs = 10_000;

  // Unseen: no read mark at all — refused, and nothing lands on the ledger.
  const unseenPath = ledgerPath();
  const unseen = applyDefaultAnswer(e, { nowMs, windowMs }, { issues: undefined as never, ledgerPath: unseenPath, runId: "RUN-1" });
  assert.deepEqual(unseen, { applied: false, reason: "not-seen" });
  assert.equal(readLedgerLines(unseenPath).length, 0);

  // Seen, but the window has not yet elapsed — still refused, still no ledger line.
  const tooSoonPath = ledgerPath();
  const tooSoon = applyDefaultAnswer(
    e,
    { seenAtMs: nowMs - windowMs + 1, nowMs, windowMs },
    { issues: undefined as never, ledgerPath: tooSoonPath, runId: "RUN-1" },
  );
  assert.deepEqual(tooSoon, { applied: false, reason: "window-not-passed" });
  assert.equal(readLedgerLines(tooSoonPath).length, 0);

  // Seen, and the window has fully elapsed — the default is taken, ledgered with origin "default".
  const appliedPath = ledgerPath();
  const applied = applyDefaultAnswer(
    e,
    { seenAtMs: nowMs - windowMs, nowMs, windowMs },
    { issues: undefined as never, ledgerPath: appliedPath, runId: "RUN-1" },
  );
  assert.equal(applied.applied, true);
  assert.equal((applied as { option: string }).option, e.recommendation);
  const answer = (applied as { answer?: { origin: string; appliedAtMs: number } }).answer;
  assert.ok(answer, "a successful default carries the applied-answer record back to the caller");
  assert.equal(answer?.origin, DEFAULT_ANSWER_ORIGIN);
  assert.equal(answer?.appliedAtMs, nowMs);

  const lines = readLedgerLines(appliedPath);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].step, DEFAULT_ANSWER_APPLIED_STEP);
  assert.equal(lines[0].task_id, "W1-TX");
  assert.equal(lines[0].option, "retry");
  assert.equal(lines[0].origin, DEFAULT_ANSWER_ORIGIN);

  // Same facts, decided directly by the pure core (no ledger involved) — the same verdict.
  assert.deepEqual(shouldApplyDefault(e, { seenAtMs: nowMs - windowMs, nowMs, windowMs }), {
    applied: true,
    option: "retry",
  });
});

test("W1-T4675: a hard-stop question never takes a default", () => {
  const e = questionEscalation({ class: "HARD_STOP" });
  // Confirm this really is a QUESTION by shape, not an action misfiled as one — the refusal below
  // must come from the class check, not from classifyAsk quietly reading "action" instead.
  assert.equal(classifyAsk(e), "question");

  const windowMs = 1000;
  const nowMs = 1_000_000;
  const longSeen = nowMs - windowMs * 100; // seen long, long ago — every other condition says "yes"

  assert.deepEqual(shouldApplyDefault(e, { seenAtMs: longSeen, nowMs, windowMs }), {
    applied: false,
    reason: "never-auto-defaults",
  });

  const path = ledgerPath();
  const result = applyDefaultAnswer(e, { seenAtMs: longSeen, nowMs, windowMs }, { issues: undefined as never, ledgerPath: path, runId: "RUN-1" });
  assert.deepEqual(result, { applied: false, reason: "never-auto-defaults" });
  assert.equal(readLedgerLines(path).length, 0, "a refused default must leave no trace of having been taken");

  // MANUAL is refused on the identical ground — an act only a hand can do never auto-defaults
  // either, no matter how the class happens to be dressed up (design clause iii).
  const manual = questionEscalation({ class: "MANUAL" as EscalationClass });
  assert.deepEqual(shouldApplyDefault(manual, { seenAtMs: longSeen, nowMs, windowMs }), {
    applied: false,
    reason: "never-auto-defaults",
  });
});

test("W1-T4675: a single action undoes an applied default, ledgered", () => {
  const e = questionEscalation();
  const windowMs = 1000;
  const nowMs = 10_000;
  const path = ledgerPath();
  const applied = applyDefaultAnswer(
    e,
    { seenAtMs: nowMs - windowMs, nowMs, windowMs },
    { issues: undefined as never, ledgerPath: path, runId: "RUN-1" },
  );
  assert.equal(applied.applied, true);
  const answer = (applied as { answer: { taskId: string; class: EscalationClass; option: string; origin: "default"; appliedAtMs: number } }).answer;

  undoDefaultAnswer(answer, { issues: undefined as never, ledgerPath: path, runId: "RUN-1" });

  const lines = readLedgerLines(path);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].step, DEFAULT_ANSWER_APPLIED_STEP);
  assert.equal(lines[1].step, DEFAULT_ANSWER_UNDONE_STEP);
  assert.equal(lines[1].task_id, "W1-TX");
  assert.equal(lines[1].option, "retry");
  assert.equal(lines[1].undoes_applied_at_ms, nowMs);
});
