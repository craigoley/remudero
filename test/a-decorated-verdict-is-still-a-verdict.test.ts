/**
 * A PARSE FAILURE WAS BEING RECORDED AS AN OPERATOR DECISION.
 *
 * `parseVerifyHumanVerdict` matched `/VERIFY_HUMAN_DECISION:\s*(\w+)/i`, which requires a word
 * character IMMEDIATELY after the colon. Every markdown-emphasised rendering therefore failed
 * open to `needs_operator` — the one bucket that costs a person's attention.
 *
 * MEASURED against the formats this judge actually produces, 5 of 6 realistic shapes failed:
 *
 *     plain              VERIFY_HUMAN_DECISION: automate        ok
 *     bold label       **VERIFY_HUMAN_DECISION:** automate      FAILED OPEN
 *     bold value         VERIFY_HUMAN_DECISION: **automate**    FAILED OPEN
 *     backticked         VERIFY_HUMAN_DECISION: `automate`      FAILED OPEN
 *     quoted             VERIFY_HUMAN_DECISION: "automate"      FAILED OPEN
 *     bullet + bold    - **VERIFY_HUMAN_DECISION:** backlog     FAILED OPEN
 *
 * And the same model's prose, in the very same reply, writes bold headings (`**Asymmetry
 * check:**`) — so the emphasised rendering is not hypothetical, it is this judge's own register.
 * On the fleet it surfaced as verdicts reading "judge output carried no parseable
 * VERIFY_HUMAN_DECISION": the judge answered, and the answer was dropped.
 *
 * TOLERANT OF DECORATION, STRICT ABOUT MEANING — that split is the whole design, and the second
 * half is what the refusal tests below pin. Widening what the decoration may look like must never
 * widen what a decision may SAY, and an unreadable verdict must still fail open, because failing
 * open was never the defect.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseVerifyHumanVerdict } from "../src/lib/verify-human-judge.js";

const R = "VERIFY_HUMAN_REASON: a concrete reason";

test("a decorated verdict is still a verdict — every emphasis this judge writes", () => {
  const shapes: Array<[string, string]> = [
    ["plain", "VERIFY_HUMAN_DECISION: automate"],
    ["bold label", "**VERIFY_HUMAN_DECISION:** automate"],
    ["bold value", "VERIFY_HUMAN_DECISION: **automate**"],
    ["backticked value", "VERIFY_HUMAN_DECISION: `automate`"],
    ["quoted value", 'VERIFY_HUMAN_DECISION: "automate"'],
    ["bullet and bold", "- **VERIFY_HUMAN_DECISION:** automate"],
    ["underscore emphasis", "_VERIFY_HUMAN_DECISION_: automate"],
    ["no space after colon", "VERIFY_HUMAN_DECISION:automate"],
  ];
  for (const [name, line] of shapes) {
    const v = parseVerifyHumanVerdict(`${line}\n${R}`);
    assert.equal(v.decision, "automate", `${name} must parse, not fail open`);
  }
});

test("the reason survives its own decoration", () => {
  const v = parseVerifyHumanVerdict("**VERIFY_HUMAN_DECISION:** backlog\n**VERIFY_HUMAN_REASON:** deps have not merged**");
  assert.equal(v.decision, "backlog");
  assert.equal(v.reason, "deps have not merged");
});

test("STRICT ABOUT MEANING — an invented decision is still refused", () => {
  // The decoration got looser; the vocabulary did not. `VALID_DECISIONS` is the gate, and a value
  // that is merely well-formatted must not pass it.
  for (const bad of ["**approve**", "yes", "release_it", "AUTOMATE_NOW", "proceed"]) {
    const v = parseVerifyHumanVerdict(`VERIFY_HUMAN_DECISION: ${bad}\n${R}`);
    assert.equal(v.decision, "needs_operator", `${bad} must fail open, not be accepted`);
  }
});

test("FAILING OPEN IS UNTOUCHED — absent, empty and prose-only verdicts still reach an operator", () => {
  // This is the safety property the change must not have bought its tolerance with.
  for (const text of [
    "the judge rambled and never emitted the line",
    "",
    "VERIFY_HUMAN_DECISION:",
    "VERIFY_HUMAN_DECISION: \nVERIFY_HUMAN_REASON: nothing",
    "I think this one should probably be automated, honestly",
  ]) {
    const v = parseVerifyHumanVerdict(text);
    assert.equal(v.decision, "needs_operator", "an unreadable verdict must never auto-release");
  }
});

test("a decision is read from the LABELLED line, not from prose mentioning the word", () => {
  // Prose that merely contains "automate" must not be mistaken for a verdict — the label is what
  // carries authority here, which is why the whole thing is a labelled contract.
  const v = parseVerifyHumanVerdict("I considered whether to automate this, but it needs a person.");
  assert.equal(v.decision, "needs_operator");
});
