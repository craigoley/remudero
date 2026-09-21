// test/emergency-control-admission.test.ts — W1-T3900 acceptance (2):
//   "active stops refuse new actions, follow-up promotion, capability use, and agent handoff
//    in scope"
import assert from "node:assert/strict";
import { test } from "node:test";

import { checkEmergencyStop, createEmergencyStop, type EmergencyStop } from "../src/lib/emergency-control.js";

function stop(overrides: Partial<Parameters<typeof createEmergencyStop>[0]> = {}): EmergencyStop {
  return createEmergencyStop({
    scope: "repository",
    scopeTarget: "acme/widgets",
    reason: "connector behaving unexpectedly",
    issuedBy: "operator:alice",
    clearPolicy: "explicit-clear-required",
    incidentReceiptId: "incident-42",
    ...overrides,
  });
}

const ACTION_KINDS = ["action-admission", "follow-up-promotion", "capability-use", "agent-handoff"] as const;

for (const actionKind of ACTION_KINDS) {
  test(`W1-T3900 (2): an active in-scope stop refuses ${actionKind} by name`, () => {
    const active = stop();
    const result = checkEmergencyStop(
      [active],
      { actionKind, repo: "acme/widgets", capability: "deploy.trigger", delegationClass: "agent-handoff" },
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "emergency-stop-active");
    assert.equal(result.stopId, active.id);
    assert.match(result.receipt.reason, new RegExp(actionKind));
    assert.match(result.receipt.reason, new RegExp(active.id));
  });
}

test("W1-T3900 (2): an out-of-scope repository is admitted", () => {
  const active = stop({ scopeTarget: "acme/widgets" });
  const result = checkEmergencyStop([active], { actionKind: "action-admission", repo: "other/repo" });
  assert.equal(result.ok, true);
});

test("W1-T3900 (2): a fleet-scoped stop refuses every repo/instance/principal", () => {
  const active = stop({ scope: "fleet", scopeTarget: undefined });
  for (const request of [
    { actionKind: "action-admission" as const, repo: "acme/widgets" },
    { actionKind: "action-admission" as const, instance: "prod-1" },
    { actionKind: "action-admission" as const, principal: "operator:bob" },
  ]) {
    const result = checkEmergencyStop([active], request);
    assert.equal(result.ok, false);
  }
});

test("W1-T3900 (2): an instance-scoped stop matches only its own instance", () => {
  const active = stop({ scope: "instance", scopeTarget: "prod-1" });
  assert.equal(checkEmergencyStop([active], { actionKind: "action-admission", instance: "prod-1" }).ok, false);
  assert.equal(checkEmergencyStop([active], { actionKind: "action-admission", instance: "prod-2" }).ok, true);
});

test("W1-T3900 (2): a principal-scoped stop matches only its own principal", () => {
  const active = stop({ scope: "principal", scopeTarget: "operator:bob" });
  assert.equal(checkEmergencyStop([active], { actionKind: "action-admission", principal: "operator:bob" }).ok, false);
  assert.equal(checkEmergencyStop([active], { actionKind: "action-admission", principal: "operator:alice" }).ok, true);
});

test("W1-T3900 (2): affectedCapabilities narrows capability-use refusal to the named capabilities only", () => {
  const active = stop({ affectedCapabilities: ["deploy.trigger"] });
  assert.equal(
    checkEmergencyStop([active], { actionKind: "capability-use", repo: "acme/widgets", capability: "deploy.trigger" }).ok,
    false,
  );
  assert.equal(
    checkEmergencyStop([active], { actionKind: "capability-use", repo: "acme/widgets", capability: "email.read" }).ok,
    true,
  );
});

test("W1-T3900 (2): affectedDelegationClasses narrows agent-handoff refusal to the named classes only", () => {
  const active = stop({ affectedDelegationClasses: ["deploy.advance"] });
  assert.equal(
    checkEmergencyStop([active], { actionKind: "agent-handoff", repo: "acme/widgets", delegationClass: "deploy.advance" }).ok,
    false,
  );
  assert.equal(
    checkEmergencyStop([active], { actionKind: "agent-handoff", repo: "acme/widgets", delegationClass: "email.send" }).ok,
    true,
  );
});

test("W1-T3900 (2): action-admission and follow-up-promotion are scope-gated only — capability/class fields do not widen or narrow them", () => {
  const active = stop({ affectedCapabilities: ["deploy.trigger"], affectedDelegationClasses: ["deploy.advance"] });
  assert.equal(checkEmergencyStop([active], { actionKind: "action-admission", repo: "acme/widgets" }).ok, false);
  assert.equal(checkEmergencyStop([active], { actionKind: "follow-up-promotion", repo: "acme/widgets" }).ok, false);
});

test("W1-T3900 (2): no active stop admits every action kind", () => {
  for (const actionKind of ACTION_KINDS) {
    assert.equal(checkEmergencyStop([], { actionKind, repo: "acme/widgets" }).ok, true);
  }
});

test("W1-T3900 (2): checkEmergencyStop only consults stops the caller supplies as active — an inactive one must be filtered out first", () => {
  // The caller pre-filters with isEmergencyStopActive; a stop the caller still passes in blocks,
  // proving this function trusts its input rather than re-deriving activity itself.
  const active = stop();
  assert.equal(checkEmergencyStop([active], { actionKind: "action-admission", repo: "acme/widgets" }).ok, false);
  assert.equal(checkEmergencyStop([], { actionKind: "action-admission", repo: "acme/widgets" }).ok, true);
});
