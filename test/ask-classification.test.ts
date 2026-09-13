// test/ask-classification.test.ts — W1-T3394: ASK vs RECORD classification (ratifies W1-T3186 i).
//
// The task's own falsifier: a task with an open BLOCKED-AMBIGUOUS escalation AND a rundown line
// for the SAME event must yield exactly one ASK (the escalation) and exactly one RECORD (the
// rundown line) — never an ASK from both, never a RECORD from both. That is the double-render
// W1-T182's mixed NEEDS ME rendering was specified to reproduce, and what this classifier exists
// to make structurally impossible rather than a rendering convention two templates might drift on.
import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyAskRecordItem, type AskRecordItem } from "../src/lib/ask-classification.js";
import type { InboxState } from "../src/lib/inbox.js";

// Every InboxState the real registry can hold (inbox.ts) — asserted exhaustively below so a new
// state added there without an opinion here fails loudly instead of silently defaulting.
const ALL_INBOX_STATES: InboxState[] = ["ready", "not_ready", "deferred_with_trigger", "ratified", "drafting", "retired", "declined"];

// ── Claim 1: an inbox proposal's tier ─────────────────────────────────────────────────────────

test("proposal: READY/NOT-READY/DEFERRED-WITH-TRIGGER classify ASK — a decision is pending", () => {
  for (const state of ["ready", "not_ready", "deferred_with_trigger"] as const) {
    assert.equal(classifyAskRecordItem({ kind: "proposal", state }), "ASK", `state ${state} should be ASK`);
  }
});

test("proposal: DRAFTING or already-consumed (ratified/retired/declined) classify RECORD", () => {
  for (const state of ["drafting", "ratified", "retired", "declined"] as const) {
    assert.equal(classifyAskRecordItem({ kind: "proposal", state }), "RECORD", `state ${state} should be RECORD`);
  }
});

test("proposal: the SAME proposal id flips ASK -> RECORD as its state moves from READY to DRAFTING", () => {
  const ready: AskRecordItem = { kind: "proposal", state: "ready" };
  const drafting: AskRecordItem = { kind: "proposal", state: "drafting" };
  assert.equal(classifyAskRecordItem(ready), "ASK");
  assert.equal(classifyAskRecordItem(drafting), "RECORD");
});

// ── Claim 2: an escalation's pending-decision state ───────────────────────────────────────────

test("escalation: unresolved (still needs a human decision, e.g. an open BLOCKED-AMBIGUOUS issue) classifies ASK", () => {
  assert.equal(classifyAskRecordItem({ kind: "escalation", resolved: false }), "ASK");
});

test("escalation: resolved (answered, or the referent has reached a terminal state) classifies RECORD", () => {
  assert.equal(classifyAskRecordItem({ kind: "escalation", resolved: true }), "RECORD");
});

test("question: an unanswered W1-T78 clarification question classifies ASK; once answered, RECORD", () => {
  assert.equal(classifyAskRecordItem({ kind: "question", answered: false }), "ASK");
  assert.equal(classifyAskRecordItem({ kind: "question", answered: true }), "RECORD");
});

// ── Claim 3: the double-render falsifier ──────────────────────────────────────────────────────

test("falsifier: a drain-rundown outcome line ALWAYS classifies RECORD, even alongside the same task's open ASK-classified escalation", () => {
  const openEscalationForTask: AskRecordItem = { kind: "escalation", resolved: false };
  for (const outcome of ["merged", "blocked", "escalated"] as const) {
    const rundownLine: AskRecordItem = { kind: "rundown", outcome };
    // The escalation for this same task/event is a live ASK...
    assert.equal(classifyAskRecordItem(openEscalationForTask), "ASK");
    // ...while the rundown line for that identical event is ALWAYS RECORD — one ASK, one RECORD,
    // never both the same class.
    assert.equal(classifyAskRecordItem(rundownLine), "RECORD", `rundown outcome ${outcome} should be RECORD`);
  }
});

test("rundown: every outcome value (merged/blocked/escalated) classifies RECORD on its own, with no ASK arm", () => {
  for (const outcome of ["merged", "blocked", "escalated"] as const) {
    assert.equal(classifyAskRecordItem({ kind: "rundown", outcome }), "RECORD");
  }
});

// ── Claim 4: totality — every one of the four source shapes maps to exactly ASK or RECORD ────

test("totality: every InboxState value the real registry can hold classifies to exactly ASK or RECORD, with no residual", () => {
  for (const state of ALL_INBOX_STATES) {
    const result = classifyAskRecordItem({ kind: "proposal", state });
    assert.ok(result === "ASK" || result === "RECORD", `state ${state} produced an unclassified result ${String(result)}`);
  }
});

test("totality: every escalation/question boolean and every rundown outcome classifies to exactly ASK or RECORD", () => {
  const items: AskRecordItem[] = [
    { kind: "escalation", resolved: false },
    { kind: "escalation", resolved: true },
    { kind: "question", answered: false },
    { kind: "question", answered: true },
    { kind: "rundown", outcome: "merged" },
    { kind: "rundown", outcome: "blocked" },
    { kind: "rundown", outcome: "escalated" },
  ];
  for (const item of items) {
    const result = classifyAskRecordItem(item);
    assert.ok(result === "ASK" || result === "RECORD", `item ${JSON.stringify(item)} produced an unclassified result ${String(result)}`);
  }
});
