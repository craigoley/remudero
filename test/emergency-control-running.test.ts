// test/emergency-control-running.test.ts — W1-T3900 acceptance (3):
//   "running effects distinguish cancellation requested, unsupported, applied, and
//    unobservable states"
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createEmergencyStop,
  requestRunningEffectCancellation,
  type RunningEffectConnector,
} from "../src/lib/emergency-control.js";

function issuedStop() {
  return createEmergencyStop({
    scope: "instance",
    scopeTarget: "prod-1",
    reason: "runaway spend on the checkout connector",
    issuedBy: "operator:alice",
    clearPolicy: "explicit-clear-required",
    incidentReceiptId: "incident-9",
  });
}

test("W1-T3900 (3): an unsupported connector reports cancellation-unsupported and never claims success", () => {
  const stop = issuedStop();
  const connector: RunningEffectConnector = {
    supportsCancellation: false,
    requestCancellation: () => {
      throw new Error("must not be called when unsupported");
    },
  };
  const { state, receipt } = requestRunningEffectCancellation(connector, { stop, effectRef: "eff-1", effectKind: "browser-session" });
  assert.equal(state, "cancellation-unsupported");
  assert.equal(receipt.kind, "cancellation");
  assert.match(receipt.reason, /does not support cancellation/);
  assert.doesNotMatch(receipt.reason, /confirmed cancellation/);
});

test("W1-T3900 (3): a supported connector that confirms the effect stopped reports cancellation-applied", () => {
  const stop = issuedStop();
  const connector: RunningEffectConnector = { supportsCancellation: true, requestCancellation: () => "applied" };
  const { state, receipt } = requestRunningEffectCancellation(connector, { stop, effectRef: "eff-2", effectKind: "deploy" });
  assert.equal(state, "cancellation-applied");
  assert.match(receipt.reason, /confirmed cancellation/);
});

test("W1-T3900 (3): a supported connector that accepts but has not confirmed reports cancellation-requested", () => {
  const stop = issuedStop();
  const connector: RunningEffectConnector = { supportsCancellation: true, requestCancellation: () => "requested" };
  const { state, receipt } = requestRunningEffectCancellation(connector, { stop, effectRef: "eff-3", effectKind: "payment" });
  assert.equal(state, "cancellation-requested");
  assert.match(receipt.reason, /has not yet confirmed/);
});

test("W1-T3900 (3): a supported connector with no confirmable status reports cancellation-unobservable, never applied", () => {
  const stop = issuedStop();
  const connector: RunningEffectConnector = { supportsCancellation: true, requestCancellation: () => "unobservable" };
  const { state, receipt } = requestRunningEffectCancellation(connector, { stop, effectRef: "eff-4", effectKind: "email" });
  assert.equal(state, "cancellation-unobservable");
  assert.match(receipt.reason, /never claimed cancelled/);
});

test("W1-T3900 (3): every cancellation receipt links back to the stop's own incident receipt", () => {
  const stop = issuedStop();
  const connector: RunningEffectConnector = { supportsCancellation: true, requestCancellation: () => "applied" };
  const { receipt } = requestRunningEffectCancellation(connector, { stop, effectRef: "eff-5", effectKind: "deploy" });
  assert.equal(receipt.parentReceiptId, stop.incidentReceiptId);
  assert.equal(receipt.stopId, stop.id);
});
