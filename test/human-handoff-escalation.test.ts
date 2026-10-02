import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assessHumanHandoff,
  claimHumanHandoff,
  createHumanHandoff,
  escalateHumanHandoff,
  humanHandoffQueue,
  inHandoffQuietHours,
  refreshHumanHandoffFreshness,
  type HandoffResult,
  type HumanHandoff,
  type HumanHandoffInput,
} from "../src/lib/human-handoff.js";

// W1-T3897 criterion 3: unclaimed, aging, quiet-hour, escalated, expired, and unavailable states stay
// distinct — and no state label can hide an overdue unclaimed item.

const NOW = Date.parse("2026-10-01T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const input: HumanHandoffInput = {
  handoffId: "handoff:escalate-1",
  reason: "a credential rotation needs a human",
  sourceReceipt: "receipt:rotation-4",
  requiredDecision: "approve the rotation window",
  scope: { principal: "craig", repository: "remudero" },
  priority: "high",
  responseDeadline: "2026-10-02T10:00:00.000Z",
  escalationPolicy: { afterMs: HOUR, chain: ["lead@example.test", "oncall@example.test"] },
  quietHours: { timezone: "UTC", start: "22:00", end: "06:00" },
  freshness: "verified",
  actionProfile: { level: "approve", capabilities: ["credential.rotate"] },
  createdBy: "operator-agent",
};

function open(patch: Partial<HumanHandoffInput> = {}): HumanHandoff {
  const result = createHumanHandoff({ ...input, ...patch }, NOW);
  assert.ok(result.ok, JSON.stringify(result));
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

test("the six supervision states are each reachable and pairwise distinct", () => {
  const handoff = open();
  const unclaimed = assessHumanHandoff(handoff, NOW + 10 * 60_000);
  const aging = assessHumanHandoff(handoff, NOW + 2 * HOUR);
  const quiet = assessHumanHandoff(handoff, Date.parse("2026-10-01T23:00:00.000Z"));
  const escalated = assessHumanHandoff(ok(escalateHumanHandoff(handoff, { actor: "sweeper", linkedReceipt: "receipt:sweep-1" }, NOW + 2 * HOUR)).handoff, NOW + 2 * HOUR + 1);
  const expired = assessHumanHandoff(handoff, Date.parse("2026-10-02T10:00:00.000Z"));
  const unavailable = assessHumanHandoff(
    ok(refreshHumanHandoffFreshness(handoff, { freshness: "unavailable", actor: "probe", linkedReceipt: "receipt:probe-2" }, NOW + 60_000)).handoff,
    NOW + 2 * 60_000,
  );
  const states = [unclaimed, aging, quiet, escalated, expired, unavailable].map((item) => item.state);
  assert.deepEqual(states, ["unclaimed", "aging", "quiet_hours", "escalated", "expired", "unavailable"]);
  assert.equal(new Set(states).size, 6);
  assert.equal(unclaimed.overdue, false);
  assert.equal(aging.overdue, true);
  assert.equal(quiet.overdue, true, "quiet hours must not hide an overdue unclaimed item");
  assert.equal(quiet.inQuietHours, true);
  assert.equal(expired.overdue, true);
  assert.equal(escalated.assignee, "lead@example.test");
  assert.equal(escalated.escalationLevel, 1);
  const claimed = ok(claimHumanHandoff(handoff, { claimant: "alice", claimantScope: { principals: ["craig"], repositories: ["remudero"] }, idempotencyKey: "k", leaseMs: HOUR }, NOW));
  assert.equal(assessHumanHandoff(claimed.handoff, NOW + 2 * 60_000).state, "claimed");
  assert.equal(assessHumanHandoff(claimed.handoff, NOW + 2 * 60_000).overdue, false);
});

test("escalation needs a linked receipt, must be due, respects quiet hours, and never widens authority", () => {
  const handoff = open();
  refused(escalateHumanHandoff(handoff, { actor: "sweeper", linkedReceipt: "" }, NOW + 2 * HOUR), "receipt_required");
  refused(escalateHumanHandoff(handoff, { actor: "sweeper", linkedReceipt: "receipt:sweep-1" }, NOW + 30 * 60_000), "not_due");
  refused(escalateHumanHandoff(handoff, { actor: "sweeper", linkedReceipt: "receipt:sweep-1" }, Date.parse("2026-10-01T23:00:00.000Z")), "quiet_hours");
  refused(escalateHumanHandoff(handoff, { actor: "sweeper", linkedReceipt: "receipt:sweep-1", grant: { level: "act", capabilities: ["credential.rotate"] } }, NOW + 2 * HOUR), "authority_widening");
  refused(escalateHumanHandoff(handoff, { actor: "sweeper", linkedReceipt: "receipt:sweep-1", grant: { level: "approve", capabilities: ["credential.read"] } }, NOW + 2 * HOUR), "authority_widening");

  const urgent = open({ priority: "urgent" });
  assert.equal(ok(escalateHumanHandoff(urgent, { actor: "sweeper", linkedReceipt: "receipt:sweep-1" }, Date.parse("2026-10-01T23:00:00.000Z"))).handoff.escalationLevel, 1);

  const first = ok(escalateHumanHandoff(handoff, { actor: "sweeper", linkedReceipt: "receipt:sweep-1" }, NOW + 2 * HOUR));
  assert.equal(first.receipt.kind, "escalated");
  assert.equal(first.receipt.linkedReceipt, "receipt:sweep-1");
  assert.deepEqual(first.handoff.grantedAuthority, input.actionProfile);
  const repeat = ok(escalateHumanHandoff(first.handoff, { actor: "sweeper", linkedReceipt: "receipt:sweep-1" }, NOW + 2 * HOUR + 1));
  assert.equal(repeat.changed, false);
  refused(escalateHumanHandoff(first.handoff, { actor: "sweeper", linkedReceipt: "receipt:sweep-2" }, NOW + 2 * HOUR + 1), "not_due");
  const second = ok(escalateHumanHandoff(first.handoff, { actor: "sweeper", linkedReceipt: "receipt:sweep-2", grant: { level: "advise", capabilities: [] } }, NOW + 3 * HOUR));
  assert.equal(second.handoff.assignee, "oncall@example.test");
  assert.deepEqual(second.handoff.grantedAuthority, { level: "advise", capabilities: [] });
  refused(escalateHumanHandoff(second.handoff, { actor: "sweeper", linkedReceipt: "receipt:sweep-3" }, NOW + 5 * HOUR), "escalation_exhausted");
});

test("the queue lists an overdue unclaimed item above a fresh urgent one and omits closed items", () => {
  const overdueLow = open({ handoffId: "handoff:old-low", priority: "low" });
  const freshUrgent = createHumanHandoff({ ...input, handoffId: "handoff:new-urgent", priority: "urgent" }, NOW + 90 * 60_000);
  assert.ok(freshUrgent.ok);
  const queue = humanHandoffQueue([freshUrgent.handoff, overdueLow], NOW + 2 * HOUR);
  assert.deepEqual(queue.map((item) => item.handoffId), ["handoff:old-low", "handoff:new-urgent"]);
  assert.deepEqual(queue.map((item) => item.overdue), [true, false]);
  const closed = { ...overdueLow, closure: { outcome: "superseded" as const, decidedBy: "x", supersededBy: "r", closedAt: input.responseDeadline, receiptId: "r" } };
  assert.equal(assessHumanHandoff(closed, NOW).state, "closed");
  assert.deepEqual(humanHandoffQueue([closed], NOW + 2 * HOUR), []);
});

test("quiet hours wrap midnight, honour the window timezone, and treat an equal start/end as all day", () => {
  const window = { timezone: "America/New_York", start: "22:00", end: "06:00" };
  assert.equal(inHandoffQuietHours(Date.parse("2026-10-02T03:00:00.000Z"), window), true);
  assert.equal(inHandoffQuietHours(Date.parse("2026-10-01T15:00:00.000Z"), window), false);
  assert.equal(inHandoffQuietHours(Date.parse("2026-10-01T15:00:00.000Z"), { timezone: "UTC", start: "09:00", end: "17:00" }), true);
  assert.equal(inHandoffQuietHours(Date.parse("2026-10-01T15:00:00.000Z"), { timezone: "UTC", start: "00:00", end: "00:00" }), true);
  assert.equal(inHandoffQuietHours(NOW, undefined), false);
});
