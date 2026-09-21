import assert from "node:assert/strict";
import { test } from "node:test";
import {
  evaluateAssistantTrust,
  replayPromotion,
  verifyAssistantTrustControls,
  type AssistantTrustControlResult,
  type AssistantTrustEvidence,
} from "../src/lib/experiment-promotion.js";

function cleanEvidence(overrides: Partial<AssistantTrustEvidence> = {}): AssistantTrustEvidence {
  return { unauthorizedSideEffects: 0, staleContextUses: 0, receiptsComplete: true, rollbackAttempted: false, rollbackSucceeded: true, ...overrides };
}

function passingControls(): AssistantTrustControlResult[] {
  return [
    { caseId: "control-positive-1", metricName: "proactivity_precision", controlType: "positive", expectedOutcome: "pass", observedOutcome: "pass" },
    { caseId: "control-negative-1", metricName: "unauthorized_side_effect_rate", controlType: "negative", expectedOutcome: "flagged", observedOutcome: "flagged" },
  ];
}

test("unit test: replay over an assistant-trust corpus is deterministic and never mutates the corpus or calls anything but the supplied pure functions", () => {
  const corpus = Object.freeze([
    { caseId: "trust-case-1", input: { unsolicited: true } },
    { caseId: "trust-case-2", input: { unsolicited: false } },
  ]);
  const candidate = (input: unknown) => (input as { unsolicited: boolean }).unsolicited;
  const baseline = (input: unknown) => (input as { unsolicited: boolean }).unsolicited;

  const outcome = replayPromotion(corpus as never, candidate, baseline);
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.summary.deterministic, true);
  assert.equal(outcome.summary.sideEffectFree, true);
  // Never assumed: the corpus passed in must still read back byte-identical after the pass.
  assert.deepEqual(corpus, [
    { caseId: "trust-case-1", input: { unsolicited: true } },
    { caseId: "trust-case-2", input: { unsolicited: false } },
  ]);

  const trust = evaluateAssistantTrust({
    guard: { state: "ready", reasons: [], breachedMetrics: [] },
    replay: outcome.summary,
    controls: verifyAssistantTrustControls(passingControls()),
    evidence: cleanEvidence(),
  });
  assert.equal(trust.state, "ready");
});

test("unit test: shadow evaluation reuses the same deterministic engine — a non-deterministic candidate is caught, never silently trusted", () => {
  const corpus = [{ caseId: "shadow-case-1", input: 1 }];
  let calls = 0;
  const nonDeterministicCandidate = () => {
    calls += 1;
    return calls; // differs across replayPromotion's own two identical passes
  };
  const baseline = () => 1;

  const outcome = replayPromotion(corpus, nonDeterministicCandidate, baseline);
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.summary.deterministic, false);

  const trust = evaluateAssistantTrust({
    guard: { state: "ready", reasons: [], breachedMetrics: [] },
    replay: outcome.summary,
    controls: verifyAssistantTrustControls(passingControls()),
    evidence: cleanEvidence(),
  });
  assert.equal(trust.state, "blocked");
  assert.ok(trust.reasons.some((r) => r.includes("deterministic")));
});

test("unit test: a replay pass reported as not side-effect-free blocks the trust evaluation outright, never just a lower score", () => {
  const trust = evaluateAssistantTrust({
    guard: { state: "ready", reasons: [], breachedMetrics: [] },
    replay: { deterministic: true, sideEffectFree: false },
    controls: verifyAssistantTrustControls(passingControls()),
    evidence: cleanEvidence(),
  });
  assert.equal(trust.state, "blocked");
  assert.ok(trust.reasons.some((r) => r.includes("side-effect-free")));
});

test("unit test: a duplicate caseId in the trust corpus is refused by the shared replay engine before any comparison is trusted", () => {
  const corpus = [
    { caseId: "dup", input: 1 },
    { caseId: "dup", input: 2 },
  ];
  const outcome = replayPromotion(corpus, (i) => i, (i) => i);
  assert.equal(outcome.ok, false);
});
