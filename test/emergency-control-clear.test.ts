// test/emergency-control-clear.test.ts — W1-T3900 acceptance (4):
//   "a stop cannot be cleared without explicit human confirmation and fresh authoritative
//    health evidence"
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  clearEmergencyStop,
  createEmergencyStop,
  EMERGENCY_CLEAR_HEALTH_MAX_AGE_MS,
  type EmergencyClearRequest,
} from "../src/lib/emergency-control.js";

function issuedStop() {
  return createEmergencyStop({
    scope: "principal",
    scopeTarget: "operator:bob",
    reason: "suspicious agent-to-agent handoff volume",
    issuedBy: "operator:alice",
    clearPolicy: "explicit-clear-required",
    incidentReceiptId: "incident-7",
  });
}

const NOW = Date.now();

function goodRequest(overrides: Partial<EmergencyClearRequest> = {}): EmergencyClearRequest {
  return {
    stopId: "unused-by-the-pure-function",
    confirmation: { confirmedBy: "operator:alice", confirmedAt: new Date(NOW).toISOString() },
    health: { source: "daemon-health", status: "healthy", checkedAt: new Date(NOW).toISOString() },
    revocation: { coverage: "complete" },
    ...overrides,
  };
}

test("W1-T3900 (4): a fully evidenced clear succeeds and produces a cleared receipt", () => {
  const stop = issuedStop();
  const result = clearEmergencyStop(stop, false, goodRequest(), { now: NOW });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.receipt.kind, "clear");
  assert.equal(result.receipt.outcome, "cleared");
  assert.equal(result.receipt.parentReceiptId, stop.incidentReceiptId);
});

test("W1-T3900 (4): clearing without an explicit human confirmation is refused", () => {
  const stop = issuedStop();
  const missing = clearEmergencyStop(
    stop,
    false,
    goodRequest({ confirmation: undefined as unknown as EmergencyClearRequest["confirmation"] }),
    { now: NOW },
  );
  assert.equal(missing.ok, false);
  if (missing.ok) return;
  assert.equal(missing.code, "confirmation-required");
});

test("W1-T3900 (4): a confirmation missing confirmedBy or a valid confirmedAt is refused", () => {
  const stop = issuedStop();
  const noBy = clearEmergencyStop(stop, false, goodRequest({ confirmation: { confirmedBy: "", confirmedAt: new Date(NOW).toISOString() } }), { now: NOW });
  assert.equal(noBy.ok, false);
  const badAt = clearEmergencyStop(stop, false, goodRequest({ confirmation: { confirmedBy: "operator:alice", confirmedAt: "not-a-date" } }), { now: NOW });
  assert.equal(badAt.ok, false);
});

test("W1-T3900 (4): stale health evidence blocks clearing", () => {
  const stop = issuedStop();
  const staleAt = new Date(NOW - EMERGENCY_CLEAR_HEALTH_MAX_AGE_MS - 1_000).toISOString();
  const result = clearEmergencyStop(stop, false, goodRequest({ health: { source: "daemon-health", status: "healthy", checkedAt: staleAt } }), { now: NOW });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "health-stale");
});

test("W1-T3900 (4): a health read from the future is refused as stale, never trusted", () => {
  const stop = issuedStop();
  const futureAt = new Date(NOW + 60_000).toISOString();
  const result = clearEmergencyStop(stop, false, goodRequest({ health: { source: "daemon-health", status: "healthy", checkedAt: futureAt } }), { now: NOW });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "health-stale");
});

test("W1-T3900 (4): a fresh but non-healthy read blocks clearing", () => {
  const stop = issuedStop();
  for (const status of ["degraded", "unavailable"] as const) {
    const result = clearEmergencyStop(stop, false, goodRequest({ health: { source: "daemon-health", status, checkedAt: new Date(NOW).toISOString() } }), { now: NOW });
    assert.equal(result.ok, false);
    if (result.ok) continue;
    assert.equal(result.code, "health-not-healthy");
  }
});

test("W1-T3900 (4): partial or unavailable revocation-source coverage blocks clearing", () => {
  const stop = issuedStop();
  const partial = clearEmergencyStop(stop, false, goodRequest({ revocation: { coverage: "partial" } }), { now: NOW });
  assert.equal(partial.ok, false);
  if (!partial.ok) assert.equal(partial.code, "revocation-source-partial");

  const unavailable = clearEmergencyStop(stop, false, goodRequest({ revocation: { coverage: "unavailable" } }), { now: NOW });
  assert.equal(unavailable.ok, false);
  if (!unavailable.ok) assert.equal(unavailable.code, "revocation-source-unavailable");
});

test("W1-T3900 (4): clearing an already-cleared stop is refused", () => {
  const stop = issuedStop();
  const result = clearEmergencyStop(stop, true, goodRequest(), { now: NOW });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "already-cleared");
});
