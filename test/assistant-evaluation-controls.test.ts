import assert from "node:assert/strict";
import { test } from "node:test";
import {
  validateAssistantTrustControlResult,
  validateAssistantTrustControlResults,
  verifyAssistantTrustControls,
  type AssistantTrustControlResult,
} from "../src/lib/experiment-promotion.js";

function control(overrides: Partial<AssistantTrustControlResult> = {}): AssistantTrustControlResult {
  return {
    caseId: "control-1",
    metricName: "proactivity_precision",
    controlType: "positive",
    expectedOutcome: "pass",
    observedOutcome: "pass",
    ...overrides,
  };
}

function negativeControl(overrides: Partial<AssistantTrustControlResult> = {}): AssistantTrustControlResult {
  return control({ caseId: "negative-1", metricName: "unauthorized_side_effect_rate", controlType: "negative", expectedOutcome: "flagged", observedOutcome: "flagged", ...overrides });
}

test("unit test: a corpus with no positive control does not prove the corpus is visible", () => {
  const check = verifyAssistantTrustControls([negativeControl()]);
  assert.equal(check.ok, false);
  assert.ok(check.reasons.some((r) => r.includes("no positive control")));
});

test("unit test: a corpus with no negative control does not prove restraint failures are detectable", () => {
  const check = verifyAssistantTrustControls([control()]);
  assert.equal(check.ok, false);
  assert.ok(check.reasons.some((r) => r.includes("no negative control")));
});

test("unit test: positive and negative controls that both land as expected make the corpus ok", () => {
  const check = verifyAssistantTrustControls([control(), negativeControl()]);
  assert.equal(check.ok, true);
  assert.equal(check.positiveControlsSeen, 1);
  assert.equal(check.negativeControlsSeen, 1);
  assert.deepEqual(check.reasons, []);
});

test("unit test: a positive control the candidate fails to pass is named in the refusal reason", () => {
  const check = verifyAssistantTrustControls([control({ observedOutcome: "flagged" }), negativeControl()]);
  assert.equal(check.ok, false);
  assert.ok(check.reasons.some((r) => r.includes("control-1")));
});

test("unit test: a negative control the candidate fails to flag — a restraint failure slipping through — is named in the refusal reason", () => {
  const check = verifyAssistantTrustControls([control(), negativeControl({ observedOutcome: "pass" })]);
  assert.equal(check.ok, false);
  assert.ok(check.reasons.some((r) => r.includes("negative-1")));
});

test("unit test: validateAssistantTrustControlResult bounds-checks shape before a control is ever trusted", () => {
  assert.equal(validateAssistantTrustControlResult({ ...control(), metricName: "not_a_real_metric" }), null);
  assert.equal(validateAssistantTrustControlResult({ ...control(), controlType: "sideways" }), null);
  assert.equal(validateAssistantTrustControlResult({ ...control(), expectedOutcome: "maybe" }), null);
  assert.equal(validateAssistantTrustControlResult("not-an-object"), null);
  assert.deepEqual(validateAssistantTrustControlResult(control()), control());
});

test("unit test: validateAssistantTrustControlResults rejects a non-array and an oversized array", () => {
  assert.equal(validateAssistantTrustControlResults("nope"), null);
  assert.equal(validateAssistantTrustControlResults(Array.from({ length: 65 }, (_, i) => control({ caseId: `c-${i}` }))), null);
  assert.deepEqual(validateAssistantTrustControlResults([control(), negativeControl()]), [control(), negativeControl()]);
});
