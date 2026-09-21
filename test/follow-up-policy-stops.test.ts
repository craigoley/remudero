import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fixedClock } from "../src/lib/clock.js";
import {
  FOLLOW_UP_POLICY_VERSION,
  appendFollowUpCandidate,
  appendFollowUpControl,
  applyFollowUpControl,
  evaluateFollowUpPolicy,
  readFollowUpHistory,
  type FollowUpCandidate,
} from "../src/lib/follow-up-policy.js";

const candidate: FollowUpCandidate = {
  version: FOLLOW_UP_POLICY_VERSION,
  candidateId: "follow-up:stops",
  sourceEvent: "thread.dropped",
  workstream: "repo/workstream",
  reason: "The owner has not answered the next-step question.",
  freshness: "verified",
  deadline: "2026-09-22T00:00:00.000Z",
  quietHours: { timezone: "UTC", start: "22:00", end: "07:00" },
  deduplicationKey: "repo/workstream:question",
  maxAttempts: 1,
  owner: "operator",
  nextQuestion: "Should the workstream continue?",
  createdAt: "2026-09-21T10:00:00.000Z",
};

test("snooze, reject, revoke, quiet hours, and attempts are durable stop controls", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-follow-up-stops-"));
  try {
    const ledgerPath = join(root, "state", "ledger.ndjson");
    const deps = { ledgerPath, now: fixedClock(Date.parse("2026-09-21T11:00:00.000Z")) };
    appendFollowUpCandidate(deps, candidate);
    const initial = readFollowUpHistory(ledgerPath, deps.now.now());
    const snoozed = applyFollowUpControl(initial[0]!, "snooze", { until: "2026-09-21T13:00:00.000Z", at: deps.now.now() });
    assert.ok(!("error" in snoozed));
    appendFollowUpControl(deps, snoozed);
    const afterSnooze = readFollowUpHistory(ledgerPath, deps.now.now());
    assert.equal(evaluateFollowUpPolicy(candidate, { now: deps.now.now(), existing: afterSnooze }).state, "snoozed");

    const policy = applyFollowUpControl(afterSnooze[0]!, "policy", { notificationPolicy: { enabled: false }, at: deps.now.now() });
    assert.ok(!("error" in policy));
    appendFollowUpControl(deps, policy);
    const stopped = readFollowUpHistory(ledgerPath, deps.now.now());
    assert.equal(stopped[0]?.notificationPolicy?.enabled, false);
    assert.equal(evaluateFollowUpPolicy(candidate, { now: deps.now.now(), existing: stopped }).state, "suppressed");

    const rejected = applyFollowUpControl(stopped[0]!, "revoke", { at: deps.now.now() });
    assert.ok(!("error" in rejected));
    appendFollowUpControl(deps, rejected);
    const restarted = readFollowUpHistory(ledgerPath, deps.now.now());
    assert.equal(restarted[0]?.state, "rejected");
    assert.equal(evaluateFollowUpPolicy(candidate, { now: deps.now.now(), existing: restarted }).state, "suppressed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("quiet hours and maximum attempts are not treated as eligible", () => {
  assert.equal(evaluateFollowUpPolicy(candidate, { now: "2026-09-21T23:00:00.000Z" }).state, "snoozed");
  assert.equal(evaluateFollowUpPolicy(candidate, {
    now: "2026-09-21T11:00:00.000Z",
    existing: [{ ...candidate, state: "asked", attempts: 1, events: [] }],
  }).state, "suppressed");
});
