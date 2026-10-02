import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { HUMAN_HANDOFF_LEDGER_STEP } from "../src/lib/ledger.js";
import {
  HANDOFF_CLOSURE_OUTCOMES,
  appendHumanHandoff,
  assessHumanHandoff,
  claimHumanHandoff,
  closeHumanHandoff,
  createHumanHandoff,
  readHumanHandoffs,
  recordHumanHandoffDelivery,
  type HandoffResult,
  type HumanHandoff,
} from "../src/lib/human-handoff.js";

// W1-T3897 criterion 5: closure records the human decision and the authoritative outcome; delivery
// is a receipt and never completion.

const NOW = Date.parse("2026-10-01T12:00:00.000Z");
const MINUTE = 60_000;
const scope = { principals: ["craig"], repositories: ["remudero"] };

function open(): HumanHandoff {
  const result = createHumanHandoff(
    {
      handoffId: "handoff:close-1",
      reason: "a vendor payment needs a human",
      sourceReceipt: "receipt:invoice-5",
      requiredDecision: "pay or refuse the invoice",
      scope: { principal: "craig", repository: "remudero" },
      priority: "normal",
      responseDeadline: "2026-10-01T20:00:00.000Z",
      escalationPolicy: { afterMs: 60 * MINUTE, chain: ["lead@example.test"] },
      freshness: "verified",
      actionProfile: { level: "approve", capabilities: ["payment.approve"] },
      createdBy: "operator-agent",
    },
    NOW,
  );
  assert.ok(result.ok);
  return result.handoff;
}

function ok(result: HandoffResult): Extract<HandoffResult, { ok: true }> {
  assert.ok(result.ok, JSON.stringify(result));
  return result;
}

function refused(result: HandoffResult, error: string): void {
  assert.equal(result.ok, false, JSON.stringify(result));
  if (!result.ok) assert.equal(result.error, error);
}

const claimed = (handoff = open()): HumanHandoff =>
  ok(claimHumanHandoff(handoff, { claimant: "alice", claimantScope: scope, idempotencyKey: "k-1", leaseMs: 60 * MINUTE }, NOW + MINUTE)).handoff;

test("the closure vocabulary is exactly the six named outcomes", () => {
  assert.deepEqual([...HANDOFF_CLOSURE_OUTCOMES], ["answered", "action_accepted", "action_refused", "expired", "superseded", "unavailable"]);
});

test("delivery is a receipt that leaves the handoff open, and 'delivered' is refused as a closure outcome", () => {
  const delivered = ok(recordHumanHandoffDelivery(open(), { channel: "console", actor: "notifier" }, NOW + MINUTE));
  assert.equal(delivered.receipt.kind, "delivered");
  assert.equal(delivered.handoff.deliveries, 1);
  assert.equal(delivered.handoff.closure, null);
  assert.notEqual(assessHumanHandoff(delivered.handoff, NOW + 2 * MINUTE).state, "closed");
  for (const outcome of ["delivered", "acknowledged", "seen"]) {
    refused(closeHumanHandoff(delivered.handoff, { outcome, actor: "notifier" }, NOW + 2 * MINUTE), "delivery_is_not_closure");
  }
  refused(recordHumanHandoffDelivery(open(), { channel: "", actor: "notifier" }, NOW), "invalid");
});

test("a human outcome needs a live claim and the decision; an action outcome also needs its authoritative receipt", () => {
  refused(closeHumanHandoff(open(), { outcome: "answered", actor: "alice", decision: "pay it" }, NOW + 2 * MINUTE), "claim_required");
  const handoff = claimed();
  refused(closeHumanHandoff(handoff, { outcome: "answered", actor: "alice" }, NOW + 2 * MINUTE), "decision_required");
  refused(closeHumanHandoff(handoff, { outcome: "answered", actor: "bob", decision: "pay it" }, NOW + 2 * MINUTE), "claim_required");
  refused(closeHumanHandoff(handoff, { outcome: "action_accepted", actor: "alice", decision: "pay it" }, NOW + 2 * MINUTE), "outcome_required");
  refused(closeHumanHandoff(handoff, { outcome: "action_refused", actor: "alice", decision: "do not pay" }, NOW + 2 * MINUTE), "outcome_required");
  refused(closeHumanHandoff(handoff, { outcome: "unavailable", actor: "sweeper" }, NOW + 2 * MINUTE), "outcome_required");
  refused(closeHumanHandoff(handoff, { outcome: "superseded", actor: "sweeper" }, NOW + 2 * MINUTE), "receipt_required");

  const accepted = ok(closeHumanHandoff(handoff, { outcome: "action_accepted", actor: "alice", decision: "pay it", authoritativeOutcome: "receipt:payment-settled-7" }, NOW + 3 * MINUTE));
  assert.deepEqual(accepted.handoff.closure, {
    outcome: "action_accepted",
    decidedBy: "alice",
    decision: "pay it",
    authoritativeOutcome: "receipt:payment-settled-7",
    closedAt: "2026-10-01T12:03:00.000Z",
    receiptId: accepted.receipt.receiptId,
  });
  assert.equal(accepted.receipt.kind, "closed");
  assert.equal(accepted.receipt.linkedReceipt, "receipt:payment-settled-7");
  assert.equal(assessHumanHandoff(accepted.handoff, NOW + 4 * MINUTE).state, "closed");
});

test("closure is idempotent for the same outcome and refuses a contradicting second outcome or any later mutation", () => {
  const answered = ok(closeHumanHandoff(claimed(), { outcome: "answered", actor: "alice", decision: "defer to next week" }, NOW + 2 * MINUTE));
  assert.equal(answered.handoff.closure?.decision, "defer to next week");
  const again = ok(closeHumanHandoff(answered.handoff, { outcome: "answered", actor: "alice", decision: "defer to next week" }, NOW + 3 * MINUTE));
  assert.equal(again.changed, false);
  assert.equal(again.receipt.receiptId, answered.receipt.receiptId);
  refused(closeHumanHandoff(answered.handoff, { outcome: "action_refused", actor: "alice", decision: "no", authoritativeOutcome: "r" }, NOW + 3 * MINUTE), "closed");
  refused(claimHumanHandoff(answered.handoff, { claimant: "bob", claimantScope: scope, idempotencyKey: "k-9", leaseMs: 60 * MINUTE }, NOW + 3 * MINUTE), "closed");
  refused(recordHumanHandoffDelivery(answered.handoff, { channel: "console", actor: "notifier" }, NOW + 3 * MINUTE), "closed");

  const superseded = ok(closeHumanHandoff(open(), { outcome: "superseded", actor: "sweeper", supersededBy: "handoff:close-2" }, NOW + MINUTE));
  assert.equal(superseded.handoff.closure?.supersededBy, "handoff:close-2");
  const unavailable = ok(closeHumanHandoff(open(), { outcome: "unavailable", actor: "sweeper", authoritativeOutcome: "receipt:vendor-gone" }, NOW + MINUTE));
  assert.equal(unavailable.handoff.closure?.authoritativeOutcome, "receipt:vendor-gone");
});

test("the closure and its receipts survive a restart, and the newest snapshot wins", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-handoff-closure-"));
  try {
    const ledgerPath = join(root, "state", "ledger.ndjson");
    const ledger = { ledgerPath };
    const created = open();
    appendHumanHandoff(ledger, created, created.receipts[0]);
    const delivered = ok(recordHumanHandoffDelivery(created, { channel: "console", actor: "notifier" }, NOW + MINUTE));
    appendHumanHandoff(ledger, delivered.handoff, delivered.receipt);
    assert.equal(readHumanHandoffs(ledgerPath).handoffs[0].closure, null, "a delivered handoff is still open after restart");
    const held = ok(claimHumanHandoff(delivered.handoff, { claimant: "alice", claimantScope: scope, idempotencyKey: "k-1", leaseMs: 60 * MINUTE }, NOW + 2 * MINUTE));
    appendHumanHandoff(ledger, held.handoff, held.receipt);
    const closed = ok(closeHumanHandoff(held.handoff, { outcome: "action_refused", actor: "alice", decision: "do not pay", authoritativeOutcome: "receipt:payment-cancelled-1" }, NOW + 3 * MINUTE));
    appendHumanHandoff(ledger, closed.handoff, closed.receipt);
    appendHumanHandoff(ledger, created, created.receipts[0]);
    const [back] = readHumanHandoffs(ledgerPath).handoffs;
    assert.equal(back.closure?.outcome, "action_refused");
    assert.equal(back.closure?.decision, "do not pay");
    assert.equal(back.closure?.authoritativeOutcome, "receipt:payment-cancelled-1");
    assert.deepEqual(back.receipts.map((receipt) => receipt.kind), ["created", "delivered", "claimed", "closed"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a malformed snapshot is skipped and an unreadable rotation marks the queue incomplete, never whole", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-handoff-partial-"));
  try {
    const stateDir = join(root, "state");
    const ledgerPath = join(stateDir, "ledger.ndjson");
    mkdirSync(stateDir, { recursive: true });
    const created = open();
    appendHumanHandoff({ ledgerPath }, created, created.receipts[0]);
    appendFileSync(ledgerPath, JSON.stringify({ ts: "2026-10-01T12:00:01.000Z", step: HUMAN_HANDOFF_LEDGER_STEP, handoff: { version: "human-handoff-v0", handoffId: "handoff:legacy" } }) + "\n");
    const whole = readHumanHandoffs(ledgerPath);
    assert.equal(whole.complete, true);
    assert.deepEqual(whole.handoffs.map((item) => item.handoffId), ["handoff:close-1"]);
    writeFileSync(join(stateDir, "ledger.2026-09-30T00-00-00-000Z.ndjson.gz"), "not a gzip archive");
    const partial = readHumanHandoffs(ledgerPath);
    assert.equal(partial.complete, false, "an unread rotation may hide an open handoff, so the fold says so");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
