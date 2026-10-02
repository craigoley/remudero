import assert from "node:assert/strict";
import { test } from "node:test";
import { claimHumanHandoff, createHumanHandoff, reassignHumanHandoff, type HandoffResult, type HumanHandoff } from "../src/lib/human-handoff.js";

// W1-T3897 criterion 2: claim and reassign are idempotent, scoped, and receipt-backed.

const NOW = Date.parse("2026-10-01T12:00:00.000Z");
const MINUTE = 60_000;
const inScope = { principals: ["craig"], repositories: ["remudero"] };
const otherRepo = { principals: ["craig"], repositories: ["someone-else"] };

function open(): HumanHandoff {
  const result = createHumanHandoff(
    {
      handoffId: "handoff:claim-1",
      reason: "a refund needs a human decision",
      sourceReceipt: "receipt:refund-9",
      requiredDecision: "approve or refuse the refund",
      scope: { principal: "craig", repository: "remudero" },
      priority: "normal",
      responseDeadline: "2026-10-01T20:00:00.000Z",
      escalationPolicy: { afterMs: 60 * MINUTE, chain: ["lead@example.test"] },
      freshness: "verified",
      actionProfile: { level: "approve", capabilities: ["refund.approve"] },
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

const claimBy = (claimant: string, idempotencyKey: string, scope = inScope) => ({ claimant, claimantScope: scope, idempotencyKey, leaseMs: 30 * MINUTE });

test("a claim is receipt-backed and repeating it is idempotent — no second receipt, same claim", () => {
  const first = ok(claimHumanHandoff(open(), claimBy("alice", "k-1"), NOW));
  assert.equal(first.changed, true);
  assert.equal(first.receipt.kind, "claimed");
  assert.equal(first.receipt.actor, "alice");
  assert.equal(first.receipt.idempotencyKey, "k-1");
  assert.equal(first.handoff.claim?.owner, "alice");
  assert.equal(first.handoff.claim?.leaseExpiresAt, "2026-10-01T12:30:00.000Z");
  const again = ok(claimHumanHandoff(first.handoff, claimBy("alice", "k-1"), NOW + MINUTE));
  assert.equal(again.changed, false);
  assert.equal(again.receipt.receiptId, first.receipt.receiptId);
  assert.equal(again.handoff.receipts.length, first.handoff.receipts.length);
  assert.deepEqual(again.handoff.claim, first.handoff.claim);
});

test("a claim is scoped: out-of-scope claimants and a second live claimant are refused", () => {
  refused(claimHumanHandoff(open(), claimBy("mallory", "k-x", otherRepo), NOW), "out_of_scope");
  refused(claimHumanHandoff(open(), claimBy("mallory", "k-x", { principals: ["someone"], repositories: ["remudero"] }), NOW), "out_of_scope");
  const held = ok(claimHumanHandoff(open(), claimBy("alice", "k-1"), NOW)).handoff;
  refused(claimHumanHandoff(held, claimBy("bob", "k-2"), NOW + MINUTE), "claimed_by_other");
  refused(claimHumanHandoff(held, claimBy("bob", "k-1"), NOW + MINUTE), "idempotency_conflict");
  refused(claimHumanHandoff(held, claimBy("alice", "k-1"), NOW + 31 * MINUTE), "idempotency_conflict");
  refused(claimHumanHandoff(open(), { ...claimBy("alice", "k-1"), leaseMs: 1 }, NOW), "invalid");
  refused(claimHumanHandoff(open(), claimBy("", "k-1"), NOW), "invalid");
});

test("reassignment needs a linked receipt, stays in scope, never widens authority, and is idempotent", () => {
  const held = ok(claimHumanHandoff(open(), claimBy("alice", "k-1"), NOW)).handoff;
  const base = { actor: "alice", actorScope: inScope, to: "bob", toScope: inScope, linkedReceipt: "receipt:standup-note-3" };
  refused(reassignHumanHandoff(held, { ...base, linkedReceipt: "" }, NOW), "receipt_required");
  refused(reassignHumanHandoff(held, { ...base, actor: "carol" }, NOW), "claimed_by_other");
  refused(reassignHumanHandoff(held, { ...base, toScope: otherRepo }, NOW), "out_of_scope");
  refused(reassignHumanHandoff(held, { ...base, actorScope: otherRepo }, NOW), "out_of_scope");
  refused(reassignHumanHandoff(held, { ...base, grant: { level: "act", capabilities: ["refund.approve"] } }, NOW), "authority_widening");
  refused(reassignHumanHandoff(held, { ...base, grant: { level: "approve", capabilities: ["refund.approve", "payments.send"] } }, NOW), "authority_widening");
  refused(reassignHumanHandoff(held, { ...base, to: "" }, NOW), "invalid");

  const moved = ok(reassignHumanHandoff(held, { ...base, grant: { level: "advise", capabilities: [] } }, NOW + MINUTE));
  assert.equal(moved.receipt.kind, "reassigned");
  assert.equal(moved.receipt.linkedReceipt, "receipt:standup-note-3");
  assert.equal(moved.handoff.assignee, "bob");
  assert.equal(moved.handoff.claim, null);
  assert.deepEqual(moved.handoff.grantedAuthority, { level: "advise", capabilities: [] });
  const repeat = ok(reassignHumanHandoff(moved.handoff, base, NOW + 2 * MINUTE));
  assert.equal(repeat.changed, false);
  assert.equal(repeat.receipt.receiptId, moved.receipt.receiptId);

  refused(claimHumanHandoff(moved.handoff, claimBy("carol", "k-3"), NOW + 2 * MINUTE), "assigned_to_other");
  const bob = ok(claimHumanHandoff(moved.handoff, claimBy("bob", "k-4"), NOW + 2 * MINUTE));
  assert.equal(bob.handoff.claim?.owner, "bob");
  assert.deepEqual(
    bob.handoff.receipts.map((receipt) => receipt.kind),
    ["created", "claimed", "reassigned", "claimed"],
  );
});
