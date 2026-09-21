import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import { createService } from "../src/lib/service.js";
import { buildOperatorAgentRoutes } from "../src/lib/operator-agent.js";
import {
  EXPERIMENT_PROMOTION_VERSION,
  evaluateAssistantTrust,
  validateAssistantTrustEvidence,
  verifyAssistantTrustControls,
  type AssistantTrustControlResult,
  type AssistantTrustEvidence,
  type PromotionRecord,
} from "../src/lib/experiment-promotion.js";

const READY_REPLAY = { deterministic: true, sideEffectFree: true };
const READY_GUARD = { state: "ready" as const, reasons: [], breachedMetrics: [] };

function passingControls(): AssistantTrustControlResult[] {
  return [
    { caseId: "positive-1", metricName: "proactivity_precision", controlType: "positive", expectedOutcome: "pass", observedOutcome: "pass" },
    { caseId: "negative-1", metricName: "unauthorized_side_effect_rate", controlType: "negative", expectedOutcome: "flagged", observedOutcome: "flagged" },
  ];
}

function cleanEvidence(overrides: Partial<AssistantTrustEvidence> = {}): AssistantTrustEvidence {
  return { unauthorizedSideEffects: 0, staleContextUses: 0, receiptsComplete: true, rollbackAttempted: false, rollbackSucceeded: true, ...overrides };
}

test("unit test: a clean, controlled, deterministic evaluation with ready guardrails reaches ready", () => {
  const result = evaluateAssistantTrust({ guard: READY_GUARD, replay: READY_REPLAY, controls: verifyAssistantTrustControls(passingControls()), evidence: cleanEvidence() });
  assert.equal(result.state, "ready");
  assert.deepEqual(result.reasons, []);
});

test("unit test: unauthorized side effects block promotion even when every other signal is clean", () => {
  const result = evaluateAssistantTrust({
    guard: READY_GUARD,
    replay: READY_REPLAY,
    controls: verifyAssistantTrustControls(passingControls()),
    evidence: cleanEvidence({ unauthorizedSideEffects: 1 }),
  });
  assert.equal(result.state, "blocked");
  assert.ok(result.reasons.some((r) => r.includes("unauthorized side effect")));
});

test("unit test: stale-context use blocks promotion", () => {
  const result = evaluateAssistantTrust({
    guard: READY_GUARD,
    replay: READY_REPLAY,
    controls: verifyAssistantTrustControls(passingControls()),
    evidence: cleanEvidence({ staleContextUses: 2 }),
  });
  assert.equal(result.state, "blocked");
  assert.ok(result.reasons.some((r) => r.includes("stale-context")));
});

test("unit test: an incomplete receipt blocks promotion", () => {
  const result = evaluateAssistantTrust({
    guard: READY_GUARD,
    replay: READY_REPLAY,
    controls: verifyAssistantTrustControls(passingControls()),
    evidence: cleanEvidence({ receiptsComplete: false }),
  });
  assert.equal(result.state, "blocked");
  assert.ok(result.reasons.some((r) => r.includes("receipts are incomplete")));
});

test("unit test: a failed rollback blocks promotion", () => {
  const result = evaluateAssistantTrust({
    guard: READY_GUARD,
    replay: READY_REPLAY,
    controls: verifyAssistantTrustControls(passingControls()),
    evidence: cleanEvidence({ rollbackAttempted: true, rollbackSucceeded: false }),
  });
  assert.equal(result.state, "blocked");
  assert.ok(result.reasons.some((r) => r.includes("did not succeed")));
});

test("unit test: a rollback that is attempted and succeeds does not itself block promotion", () => {
  const result = evaluateAssistantTrust({
    guard: READY_GUARD,
    replay: READY_REPLAY,
    controls: verifyAssistantTrustControls(passingControls()),
    evidence: cleanEvidence({ rollbackAttempted: true, rollbackSucceeded: true }),
  });
  assert.equal(result.state, "ready");
});

test("unit test: insufficient guardrail evidence reports unmeasurable rather than a false-favorable ready", () => {
  const result = evaluateAssistantTrust({
    guard: { state: "unmeasurable", reasons: ["missing guard observation for queue_latency_p50"], breachedMetrics: [] },
    replay: READY_REPLAY,
    controls: verifyAssistantTrustControls(passingControls()),
    evidence: cleanEvidence(),
  });
  assert.equal(result.state, "unmeasurable");
});

test("unit test: a guardrail regression blocks promotion even when trust-specific evidence is clean", () => {
  const result = evaluateAssistantTrust({
    guard: { state: "regressed", reasons: ["guardrail breach: queue_latency_p50"], breachedMetrics: ["queue_latency_p50"] },
    replay: READY_REPLAY,
    controls: verifyAssistantTrustControls(passingControls()),
    evidence: cleanEvidence(),
  });
  assert.equal(result.state, "blocked");
});

test("unit test: validateAssistantTrustEvidence bounds-checks shape before it is trusted", () => {
  assert.equal(validateAssistantTrustEvidence({ ...cleanEvidence(), unauthorizedSideEffects: -1 }), null);
  assert.equal(validateAssistantTrustEvidence("not-an-object"), null);
  assert.deepEqual(validateAssistantTrustEvidence(cleanEvidence()), cleanEvidence());
});

// --- Wired end-to-end: the operator-agent promotion advance path calls evaluateAssistantTrust ---

const NOW = "2026-09-20T10:00:00.000Z";

function fixture(id: string): { ledgerPath: string; promotion: PromotionRecord } {
  const root = mkdtempSync(join(tmpdir(), "rmd-assistant-trust-"));
  mkdirSync(join(root, "state"), { recursive: true });
  return {
    ledgerPath: join(root, "state", "ledger.ndjson"),
    promotion: {
      version: EXPERIMENT_PROMOTION_VERSION,
      promotionId: id,
      candidate: "assistant-trust-v2",
      baseline: "assistant-trust-v1",
      scope: { repo: "owner/repo", policyScope: id },
      comparisonPopulation: "owner/repo assistant actions",
      denominatorFloor: 5,
      observationWindow: { start: "2026-09-18T10:00:00.000Z", end: "2026-09-22T10:00:00.000Z" },
      guardMetrics: [{ metricName: "queue_latency_p50", unit: "minutes", direction: "max", abortThreshold: 12 }],
      maxExposure: 0.1,
      owner: "operator-agent",
      expiresAt: "2026-09-27T10:00:00.000Z",
      rollback: { plan: "Restore assistant-trust-v1.", reason: "Rollback on regression." },
      createdAt: NOW,
      state: "proposed",
    },
  };
}

function readySummary() {
  return {
    version: EXPERIMENT_PROMOTION_VERSION,
    corpusSize: 1,
    matched: 1,
    mismatched: 0,
    deterministic: true,
    sideEffectFree: true,
    results: [{ caseId: "case-1", candidateOutput: 1, baselineOutput: 1, matched: true }],
  };
}

function readyObservation() {
  return {
    metricName: "queue_latency_p50",
    value: 6,
    denominator: 20,
    freshness: "verified",
    comparisonPopulation: "owner/repo assistant actions",
    observedAt: "2026-09-19T10:00:00.000Z",
  };
}

const READ_TOKEN = "assistant-trust-read";
const WRITE_TOKEN = "assistant-trust-write";

async function withService<T>(ledgerPath: string, fn: (base: string) => Promise<T>): Promise<T> {
  const server = createService({
    tokens: { read: READ_TOKEN, write: WRITE_TOKEN },
    routes: buildOperatorAgentRoutes({ ledgerPath, now: () => Date.parse(NOW) }),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

function post(base: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${WRITE_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function registerReplayApproveShadow(base: string, promotion: PromotionRecord): Promise<void> {
  assert.equal((await post(base, "/v1/operator-agent/promotions", { promotion })).status, 201);
  assert.equal((await post(base, "/v1/operator-agent/promotions/replay", { promotionId: promotion.promotionId, replay: readySummary() })).status, 200);
  assert.equal((await post(base, "/v1/operator-agent/promotions/decision", { promotionId: promotion.promotionId, decision: "approved" })).status, 200);
  assert.equal((await post(base, "/v1/operator-agent/promotions/advance", { promotionId: promotion.promotionId, target: "shadow" })).status, 200);
}

test("unit test: submitted unauthorized-side-effect evidence blocks the live promotion advance path via evaluateAssistantTrust", async () => {
  const { ledgerPath, promotion } = fixture("promotion:trust:side-effect");
  await withService(ledgerPath, async (base) => {
    await registerReplayApproveShadow(base, promotion);
    const advance = await post(base, "/v1/operator-agent/promotions/advance", {
      promotionId: promotion.promotionId,
      target: "canary",
      observations: [readyObservation()],
      assistantTrust: { controls: passingControls(), evidence: cleanEvidence({ unauthorizedSideEffects: 1 }) },
    });
    assert.equal(advance.status, 200);
    const body = (await advance.json()) as { state: string; assistantTrust: { state: string; reasons: string[] } };
    assert.equal(body.state, "regressed");
    assert.equal(body.assistantTrust.state, "blocked");
    assert.ok(body.assistantTrust.reasons.some((r) => r.includes("unauthorized side effect")));
  });
});

test("unit test: submitted failed-rollback evidence blocks the live promotion advance path via evaluateAssistantTrust", async () => {
  const { ledgerPath, promotion } = fixture("promotion:trust:rollback");
  await withService(ledgerPath, async (base) => {
    await registerReplayApproveShadow(base, promotion);
    const advance = await post(base, "/v1/operator-agent/promotions/advance", {
      promotionId: promotion.promotionId,
      target: "canary",
      observations: [readyObservation()],
      assistantTrust: { controls: passingControls(), evidence: cleanEvidence({ rollbackAttempted: true, rollbackSucceeded: false }) },
    });
    assert.equal(advance.status, 200);
    const body = (await advance.json()) as { state: string; assistantTrust: { state: string; reasons: string[] } };
    assert.equal(body.state, "regressed");
    assert.equal(body.assistantTrust.state, "blocked");
    assert.ok(body.assistantTrust.reasons.some((r) => r.includes("did not succeed")));
  });
});

test("unit test: submitted clean assistant-trust evidence reaches canary exactly like a submission with no assistantTrust field", async () => {
  const { ledgerPath, promotion } = fixture("promotion:trust:clean");
  await withService(ledgerPath, async (base) => {
    await registerReplayApproveShadow(base, promotion);
    const advance = await post(base, "/v1/operator-agent/promotions/advance", {
      promotionId: promotion.promotionId,
      target: "canary",
      observations: [readyObservation()],
      exposure: 0.05,
      assistantTrust: { controls: passingControls(), evidence: cleanEvidence() },
    });
    assert.equal(advance.status, 200);
    const body = (await advance.json()) as { state: string; assistantTrust: { state: string } };
    assert.equal(body.state, "canary");
    assert.equal(body.assistantTrust.state, "ready");
  });
});

test("unit test: the promotion route accepts bounded raw assistant context and persists only redacted evidence", async () => {
  const { ledgerPath, promotion } = fixture("promotion:trust:raw-context");
  await withService(ledgerPath, async (base) => {
    await registerReplayApproveShadow(base, promotion);
    const advance = await post(base, "/v1/operator-agent/promotions/advance", {
      promotionId: promotion.promotionId,
      target: "canary",
      observations: [readyObservation()],
      assistantTrust: {
        controls: passingControls(),
        evidence: cleanEvidence(),
        rawContext: { prompts: ["private prompt"], transcripts: ["private transcript"], credentials: ["Bearer sk-secret"], note: "password=hunter2" },
      },
    });
    assert.equal(advance.status, 200);
    const body = (await advance.json()) as { state: string; assistantTrust: { evidence: Record<string, unknown> } };
    assert.equal(body.state, "canary");
    assert.deepEqual(body.assistantTrust.evidence, { promptCount: 1, transcriptCount: 1, credentialCount: 1, note: "[redacted]", redacted: true });
    assert.ok(!JSON.stringify(body).includes("private prompt"));
    assert.ok(!JSON.stringify(body).includes("hunter2"));
  });
});

test("unit test: omitting assistantTrust entirely preserves the pre-existing base-guardrail-only advance behaviour", async () => {
  const { ledgerPath, promotion } = fixture("promotion:trust:omitted");
  await withService(ledgerPath, async (base) => {
    await registerReplayApproveShadow(base, promotion);
    const advance = await post(base, "/v1/operator-agent/promotions/advance", {
      promotionId: promotion.promotionId,
      target: "canary",
      observations: [readyObservation()],
      exposure: 0.05,
    });
    assert.equal(advance.status, 200);
    const body = (await advance.json()) as { state: string; assistantTrust?: unknown };
    assert.equal(body.state, "canary");
    assert.equal(body.assistantTrust, undefined);
  });
});
