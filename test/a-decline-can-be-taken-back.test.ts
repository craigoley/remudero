/**
 * test/a-decline-can-be-taken-back.test.ts — W1-T3407.
 *
 * A DECLINE WAS IRREVERSIBLE. `declinedReasonInLedger` knew exactly one step, so any
 * `panel.proposal_declined` row meant declined forever — and a decline entered on reasoning that
 * later proved WRONG could not be taken back by any means short of editing an append-only ledger.
 *
 * MEASURED 2026-09-11: 16 proposals were declined on a claim about `proofQueueAudit` that the
 * source refuted (`review.ts:2156` gates the forward-reference carve-out on `!nameFiltered`
 * DELIBERATELY, and `:2255` grades a title matching nothing as test theater). The only remedy
 * available was to append a SECOND decline whose reason said the first was wrong, which left all
 * sixteen declined.
 *
 * THE SHAPE IS `automergeHoldFromLedger`'s (lib/review.ts), deliberately: one pass over the same
 * lines, an engage row setting state and a release row clearing it, latest wins. Both steps are
 * registered in `DECISION_RELEVANT_LEDGER_STEPS` for the SAME reason — rotating either half away
 * inverts the answer, in one direction or the other.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { declinedReasonInLedger } from "../src/lib/inbox.js";
import { DECISION_RELEVANT_LEDGER_STEPS } from "../src/lib/ledger.js";

const ID = "proof-debt:W1-T965";
const decline = (reason: string, task_id = ID) => ({ step: "panel.proposal_declined", task_id, reason });
const restore = (reason: string, task_id = ID) => ({ step: "panel.proposal_restored", task_id, reason });

test("W1-T3407: a restore CLEARS a decline, so a proposal wrongly refused can be taken back", () => {
  const reason = declinedReasonInLedger([decline("declined on reasoning the source refuted"), restore("that reasoning was wrong")], ID);
  assert.equal(reason, undefined, "a restored proposal must read as not-declined");
});

test("W1-T3407: LATEST WINS in both directions — a decline after a restore refuses it again", () => {
  assert.equal(
    declinedReasonInLedger([decline("first"), restore("reopened"), decline("refused again, on better evidence")], ID),
    "refused again, on better evidence",
    "an operator must be able to change their mind twice",
  );
});

test("W1-T3407: the two can alternate as many times as an operator needs", () => {
  const lines = [decline("a"), restore("b"), decline("c"), restore("d"), decline("e"), restore("f")];
  assert.equal(declinedReasonInLedger(lines, ID), undefined);
});

test("W1-T3407: a restore is SCOPED to its own proposal and never clears a sibling's decline", () => {
  const lines = [decline("sibling stays declined", "proof-debt:W1-T968"), restore("only this one", ID), decline("mine", ID)];
  assert.equal(declinedReasonInLedger(lines, "proof-debt:W1-T968"), "sibling stays declined");
  assert.equal(declinedReasonInLedger(lines, ID), "mine");
});

test("W1-T3407: a restore with no prior decline is simply not-declined, never a crash", () => {
  assert.equal(declinedReasonInLedger([restore("nothing to undo")], ID), undefined);
});

test("W1-T3407: an ordinary decline still reads exactly as before — the reader is not weakened", () => {
  assert.equal(declinedReasonInLedger([decline("a real refusal")], ID), "a real refusal");
  assert.equal(
    declinedReasonInLedger([{ step: "panel.proposal_declined", task_id: ID }], ID),
    "declined by an operator",
    "a reasonless decline still falls back to the standing phrase",
  );
});

test("W1-T3407: BOTH halves are retention-protected — rotating either away would invert the answer", () => {
  assert.ok(DECISION_RELEVANT_LEDGER_STEPS.has("panel.proposal_declined"));
  assert.ok(
    DECISION_RELEVANT_LEDGER_STEPS.has("panel.proposal_restored"),
    "losing a restore silently RE-DECLINES a proposal an operator deliberately re-opened",
  );
});
