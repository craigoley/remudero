import assert from "node:assert/strict";
import { test } from "node:test";
import {
  evaluateAssistantTrust,
  redactAssistantTrustEvidence,
  validateRawAssistantTrustContext,
  verifyAssistantTrustControls,
  type AssistantTrustControlResult,
} from "../src/lib/experiment-promotion.js";

test("unit test: redacted evidence never carries the raw prompt, transcript, or credential text — only bounded counts", () => {
  const raw = {
    prompts: ["please wire $10,000 to this account", "here is my private diary entry"],
    transcripts: ["full call transcript with the customer"],
    credentials: ["Bearer sk-abcdef1234567890"],
  };
  const redacted = redactAssistantTrustEvidence(raw);
  const serialized = JSON.stringify(redacted);
  assert.equal(redacted.promptCount, 2);
  assert.equal(redacted.transcriptCount, 1);
  assert.equal(redacted.credentialCount, 1);
  assert.equal(redacted.redacted, true);
  for (const secret of [...raw.prompts, ...raw.transcripts, ...raw.credentials]) {
    assert.ok(!serialized.includes(secret), `raw text "${secret}" leaked into the redacted evidence record`);
  }
});

test("unit test: a note is secret-scrubbed and length-bounded, never left to grow unbounded", () => {
  const longNote = `token=abc123 ${"x".repeat(500)}`;
  const redacted = redactAssistantTrustEvidence({ note: longNote });
  assert.ok(redacted.note.length <= 240);
  assert.ok(!redacted.note.includes("token=abc123"));
  assert.ok(redacted.note.includes("[redacted]"));
});

test("unit test: an absent raw context still yields a bounded, zeroed redacted record — never undefined and never a raw passthrough", () => {
  const redacted = redactAssistantTrustEvidence(undefined);
  assert.deepEqual(redacted, { promptCount: 0, transcriptCount: 0, credentialCount: 0, note: "", redacted: true });
});

test("unit test: every assistant-trust evaluation record carries only the redacted evidence, never the raw context it was built from", () => {
  const controls: AssistantTrustControlResult[] = [
    { caseId: "positive-1", metricName: "proactivity_precision", controlType: "positive", expectedOutcome: "pass", observedOutcome: "pass" },
    { caseId: "negative-1", metricName: "unauthorized_side_effect_rate", controlType: "negative", expectedOutcome: "flagged", observedOutcome: "flagged" },
  ];
  const result = evaluateAssistantTrust({
    guard: { state: "ready", reasons: [], breachedMetrics: [] },
    replay: { deterministic: true, sideEffectFree: true },
    controls: verifyAssistantTrustControls(controls),
    evidence: { unauthorizedSideEffects: 0, staleContextUses: 0, receiptsComplete: true, rollbackAttempted: false, rollbackSucceeded: true },
    rawContext: { prompts: ["a raw prompt with secret content"], note: "password=hunter2" },
  });
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes("a raw prompt with secret content"));
  assert.ok(!serialized.includes("hunter2"));
  assert.equal(result.evidence.promptCount, 1);
});

test("unit test: validateRawAssistantTrustContext bounds-checks shape before redaction ever sees it", () => {
  assert.equal(validateRawAssistantTrustContext({ prompts: [1, 2, 3] }), null);
  assert.equal(validateRawAssistantTrustContext({ note: "x".repeat(1000) }), null);
  assert.equal(validateRawAssistantTrustContext(undefined), null);
  assert.equal(validateRawAssistantTrustContext("not-an-object"), null);
  assert.deepEqual(validateRawAssistantTrustContext({ note: "ok" }), { note: "ok" });
});
