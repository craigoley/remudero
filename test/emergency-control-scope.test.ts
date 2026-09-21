// test/emergency-control-scope.test.ts — W1-T3900 acceptance (1):
//   "emergency stops bind an explicit scope, issuer, reason, expiry or clear policy, and
//    incident receipt"
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createEmergencyStop,
  EMERGENCY_STOP_SCHEMA_VERSION,
  isEmergencyStopActive,
  type EmergencyStopInput,
} from "../src/lib/emergency-control.js";

function baseInput(overrides: Partial<EmergencyStopInput> = {}): EmergencyStopInput {
  return {
    scope: "repository",
    scopeTarget: "acme/widgets",
    reason: "connector acme-payments is behaving unexpectedly",
    issuedBy: "operator:alice",
    clearPolicy: "explicit-clear-required",
    incidentReceiptId: "incident-42",
    ...overrides,
  };
}

test("W1-T3900 (1): a created stop binds scope, scopeTarget, reason, issuer, issuedAt, clearPolicy, and incident receipt", () => {
  const stop = createEmergencyStop(baseInput());
  assert.equal(stop.schema, EMERGENCY_STOP_SCHEMA_VERSION);
  assert.equal(stop.scope, "repository");
  assert.equal(stop.scopeTarget, "acme/widgets");
  assert.equal(stop.reason, "connector acme-payments is behaving unexpectedly");
  assert.equal(stop.issuedBy, "operator:alice");
  assert.equal(typeof stop.issuedAt, "string");
  assert.equal(stop.clearPolicy, "explicit-clear-required");
  assert.equal(stop.incidentReceiptId, "incident-42");
});

test("W1-T3900 (1): a fleet-scoped stop carries no scopeTarget", () => {
  const stop = createEmergencyStop(baseInput({ scope: "fleet", scopeTarget: undefined }));
  assert.equal(stop.scope, "fleet");
  assert.equal(stop.scopeTarget, undefined);
});

test("W1-T3900 (1): a fleet-scoped stop supplying a scopeTarget is refused at issuance", () => {
  assert.throws(() => createEmergencyStop(baseInput({ scope: "fleet", scopeTarget: "acme/widgets" })), /must not carry a scopeTarget/);
});

for (const scope of ["repository", "instance", "principal"] as const) {
  test(`W1-T3900 (1): a ${scope}-scoped stop without a scopeTarget is refused at issuance`, () => {
    assert.throws(() => createEmergencyStop(baseInput({ scope, scopeTarget: undefined })), /requires a non-empty scopeTarget/);
  });
}

test("W1-T3900 (1): an expires-policy stop requires a valid expiresAt", () => {
  assert.throws(() => createEmergencyStop(baseInput({ clearPolicy: "expires", expiresAt: undefined })), /requires a valid ISO-8601 expiresAt/);
  assert.throws(() => createEmergencyStop(baseInput({ clearPolicy: "expires", expiresAt: "not-a-date" })), /requires a valid ISO-8601 expiresAt/);
});

test("W1-T3900 (1): an expires-policy stop with a valid expiresAt is accepted", () => {
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  const stop = createEmergencyStop(baseInput({ clearPolicy: "expires", expiresAt }));
  assert.equal(stop.expiresAt, expiresAt);
});

test("W1-T3900 (1): explicit-clear-required must not carry an expiresAt", () => {
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  assert.throws(
    () => createEmergencyStop(baseInput({ clearPolicy: "explicit-clear-required", expiresAt })),
    /must not carry an expiresAt/,
  );
});

test("W1-T3900 (1): a missing reason, issuer, or incident receipt is refused at issuance", () => {
  assert.throws(() => createEmergencyStop(baseInput({ reason: "" })), /non-empty reason/);
  assert.throws(() => createEmergencyStop(baseInput({ issuedBy: "" })), /non-empty issuedBy/);
  assert.throws(() => createEmergencyStop(baseInput({ incidentReceiptId: "" })), /non-empty incidentReceiptId/);
});

test("W1-T3900 (1): affectedCapabilities/affectedDelegationClasses default to the wildcard, and can be narrowed", () => {
  const wide = createEmergencyStop(baseInput());
  assert.equal(wide.affectedCapabilities, "*");
  assert.equal(wide.affectedDelegationClasses, "*");
  const narrow = createEmergencyStop(baseInput({ affectedCapabilities: ["deploy.trigger"], affectedDelegationClasses: ["agent-handoff"] }));
  assert.deepEqual(narrow.affectedCapabilities, ["deploy.trigger"]);
  assert.deepEqual(narrow.affectedDelegationClasses, ["agent-handoff"]);
});

test("W1-T3900 (1): the stop is deep-frozen — no field is mutable after issuance", () => {
  const stop = createEmergencyStop(baseInput());
  assert.throws(() => {
    (stop as { reason: string }).reason = "something else";
  });
});

test("W1-T3900 (1): id defaults to a unique value when omitted", () => {
  const a = createEmergencyStop(baseInput());
  const b = createEmergencyStop(baseInput());
  assert.notEqual(a.id, b.id);
});

test("W1-T3900 (1): isEmergencyStopActive lifts an expires-policy stop past its expiresAt, but never an explicit-clear-required one", () => {
  const expiresAt = new Date(Date.now() + 1_000).toISOString();
  const timed = createEmergencyStop(baseInput({ clearPolicy: "expires", expiresAt }));
  assert.equal(isEmergencyStopActive(timed, new Set(), Date.parse(expiresAt) - 500), true);
  assert.equal(isEmergencyStopActive(timed, new Set(), Date.parse(expiresAt) + 500), false);

  const untimed = createEmergencyStop(baseInput());
  assert.equal(isEmergencyStopActive(untimed, new Set(), Date.now() + 365 * 24 * 60 * 60 * 1000), true);
});

test("W1-T3900 (1): isEmergencyStopActive is false once the stop's id is in clearedStopIds", () => {
  const stop = createEmergencyStop(baseInput());
  assert.equal(isEmergencyStopActive(stop, new Set([stop.id])), false);
});
