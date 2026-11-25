// W1-T14838: a Microsoft-shape choice spreads one unit of mass over the declared options and cannot_tell together.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CANNOT_TELL_OPTION, readDecisionAnswers, type DecisionQuestion } from "#src/lib/decision-model.js";

const QUESTION: DecisionQuestion[] = [{ type: "choice", name: "escalate_or_proceed", instructions: "Escalate or proceed?",
  options: [{ value: "escalate" }, { value: "proceed" }] }];

/** One Microsoft reply for the question: `choice` and the wire probabilities, cannot_tell included. */
function read(choice: string, escalate: number, proceed: number, cannotTell: number) {
  return readDecisionAnswers("microsoft-systemone", QUESTION, { answers: { escalate_or_proceed: { type: "choice", choice,
    probabilities: { "string:escalate": escalate, "string:proceed": proceed, [CANNOT_TELL_OPTION]: cannotTell } } } })[0]!;
}

// The three decision-1 answers the 2026-11-18 judge replay rejected had declared sums 0.974, 0.916 and 0.983 with
// escalate on top; the rest of each unit was cannot_tell. The ledger kept only the sums, so the split is rebuilt.
const REPLAY_REJECTED = [[0.96, 0.014, 0.026], [0.9, 0.016, 0.084], [0.975, 0.008, 0.017]] as const;
// An answer the same replay accepted, as recorded: 0.9905 + 0.0076 + 0.0019 cannot_tell = 1.
const REPLAY_ACCEPTED = [0.9905250825726414, 0.007562753810692319, 0.0019121636166662523] as const;

test("W1-T14838 criterion 1: a choice whose declared options and cannot_tell sum to 1 is a distribution", () => {
  for (const [escalate, proceed, cannotTell] of [...REPLAY_REJECTED, REPLAY_ACCEPTED]) {
    const answer = read("string:escalate", escalate, proceed, cannotTell);
    assert.equal(answer.outcome, "distribution", `${escalate} + ${proceed} + ${cannotTell} cannot_tell`);
    assert.ok(answer.outcome === "distribution");
    assert.equal(answer.cannotTell, cannotTell);
    const top = [...answer.distribution].sort((a, b) => b.probability - a.probability)[0]!;
    assert.equal(top.option, "escalate");
  }
});

test("W1-T14838 criterion 2: the declared options are rescaled to sum to 1 and the joint mass is the mass the model gave", () => {
  for (const [escalate, proceed, cannotTell] of REPLAY_REJECTED) {
    const answer = read("string:escalate", escalate, proceed, cannotTell);
    assert.ok(answer.outcome === "distribution");
    const sum = answer.distribution.reduce((total, entry) => total + entry.probability, 0);
    assert.ok(Math.abs(sum - 1) < 1e-9, `declared distribution sums to ${sum}`);
    const joint = Object.fromEntries(answer.distribution.map((entry) => [entry.option, entry.probability * (1 - cannotTell)]));
    const declared = escalate + proceed;
    assert.ok(Math.abs(joint.escalate! - escalate * (1 - cannotTell) / declared) < 1e-12);
    assert.ok(Math.abs(joint.escalate! + joint.proceed! + cannotTell - 1) <= 0.01, "joint mass and cannot_tell make one unit");
  }
});

test("W1-T14838 criterion 3: a whole that is not 1 is still rejected and a choice with no declared mass abstains", () => {
  for (const [escalate, proceed, cannotTell, sum] of [[0.974, 0.0, 0.1, "1.074"], [0.5, 0.2, 0.1, "0.800"], [1.0, 0.05, 0.05, "1.100"]] as const) {
    const answer = read("string:escalate", escalate, proceed, cannotTell);
    assert.equal(answer.outcome, "rejected");
    assert.ok(answer.outcome === "rejected");
    assert.equal(answer.reason, `escalate_or_proceed summed to ${sum} with ${CANNOT_TELL_OPTION}, not 1`);
  }
  assert.deepEqual(read("string:escalate", 0.004, 0.001, 0.995), { name: "escalate_or_proceed", outcome: "abstained", reason: "cannot-tell" });
});

test("W1-T14838 criterion 4: a choice rejected for its sum keeps the reply's own choice and probabilities", () => {
  const answer = read("string:escalate", 0.974, 0.0, 0.1);
  assert.deepEqual(answer, { name: "escalate_or_proceed", outcome: "rejected",
    reason: `escalate_or_proceed summed to 1.074 with ${CANNOT_TELL_OPTION}, not 1`,
    wire: { choice: "string:escalate", probabilities: { "string:escalate": 0.974, "string:proceed": 0, [CANNOT_TELL_OPTION]: 0.1 } } });
  assert.deepEqual(JSON.parse(JSON.stringify(answer)), answer, "the kept reply survives the ledger's JSON row");
});
