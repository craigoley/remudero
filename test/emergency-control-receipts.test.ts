// test/emergency-control-receipts.test.ts — W1-T3900 acceptance (5):
//   "stop, refusal, cancellation, and clear events produce linked bounded receipts"
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AddressInfo } from "node:net";

import {
  checkEmergencyStop,
  clearEmergencyStop,
  createEmergencyStop,
  EMERGENCY_RECEIPT_REASON_MAX_CHARS,
  emergencyStopIssuedReceipt,
  requestRunningEffectCancellation,
  type RunningEffectConnector,
} from "../src/lib/emergency-control.js";
import { buildOperatorAgentRoutes } from "../src/lib/operator-agent.js";
import { createService } from "../src/lib/service.js";

// Every field name a receipt could carry — no field here is a plausible home for a raw prompt,
// credential, or transcript, mirroring agent-delegation-receipts.test.ts's precedent.
const ALLOWED_RECEIPT_KEYS = new Set(["receiptId", "stopId", "parentReceiptId", "kind", "outcome", "decidedAt", "reason"]);

function assertBoundedReceipt(receiptLike: object, stopId: string, incidentReceiptId: string) {
  const receipt = receiptLike as Record<string, unknown>;
  for (const key of Object.keys(receipt)) {
    assert.ok(ALLOWED_RECEIPT_KEYS.has(key), `unexpected receipt field ${key}`);
  }
  assert.equal(receipt.stopId, stopId);
  assert.equal(receipt.parentReceiptId, incidentReceiptId);
  assert.ok((receipt.reason as string).length <= EMERGENCY_RECEIPT_REASON_MAX_CHARS + 1); // +1 for the ellipsis
  assert.equal(typeof receipt.receiptId, "string");
  assert.ok((receipt.receiptId as string).length > 0);
  assert.equal(typeof receipt.decidedAt, "string");
  assert.ok(!Number.isNaN(Date.parse(receipt.decidedAt as string)));
}

function issuedStop() {
  return createEmergencyStop({
    scope: "fleet",
    reason: "credential leak suspected on the review provider",
    issuedBy: "operator:alice",
    clearPolicy: "explicit-clear-required",
    incidentReceiptId: "incident-100",
  });
}

test("W1-T3900 (5): the issuance event produces a bounded, linked \"stop\" receipt", () => {
  const stop = issuedStop();
  const receipt = emergencyStopIssuedReceipt(stop);
  assertBoundedReceipt(receipt, stop.id, stop.incidentReceiptId);
  assert.equal(receipt.kind, "stop");
  assert.equal(receipt.outcome, "issued");
});

test("W1-T3900 (5): a blocked admission produces a bounded, linked \"refusal\" receipt", () => {
  const stop = issuedStop();
  const result = checkEmergencyStop([stop], { actionKind: "action-admission" });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assertBoundedReceipt(result.receipt, stop.id, stop.incidentReceiptId);
  assert.equal(result.receipt.kind, "refusal");
  assert.equal(result.receipt.outcome, "action-admission");
});

test("W1-T3900 (5): a cancellation attempt produces a bounded, linked \"cancellation\" receipt", () => {
  const stop = issuedStop();
  const connector: RunningEffectConnector = { supportsCancellation: true, requestCancellation: () => "applied" };
  const { receipt } = requestRunningEffectCancellation(connector, { stop, effectRef: "eff-1", effectKind: "deploy" });
  assertBoundedReceipt(receipt, stop.id, stop.incidentReceiptId);
  assert.equal(receipt.kind, "cancellation");
});

test("W1-T3900 (5): a clear event produces a bounded, linked \"clear\" receipt", () => {
  const stop = issuedStop();
  const now = Date.now();
  const result = clearEmergencyStop(stop, false, {
    stopId: stop.id,
    confirmation: { confirmedBy: "operator:alice", confirmedAt: new Date(now).toISOString() },
    health: { source: "daemon-health", status: "healthy", checkedAt: new Date(now).toISOString() },
    revocation: { coverage: "complete" },
  }, { now });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assertBoundedReceipt(result.receipt, stop.id, stop.incidentReceiptId);
  assert.equal(result.receipt.kind, "clear");
});

test("W1-T3900 (5): a long refusal reason is truncated at the named bound, never silently dropped", () => {
  const stop = createEmergencyStop({
    scope: "fleet",
    reason: "x".repeat(1000),
    issuedBy: "operator:alice",
    clearPolicy: "explicit-clear-required",
    incidentReceiptId: "incident-101",
  });
  const result = checkEmergencyStop([stop], { actionKind: "capability-use", capability: "deploy.trigger" });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.receipt.reason.length <= EMERGENCY_RECEIPT_REASON_MAX_CHARS + 1);
  assert.ok(result.receipt.reason.endsWith("…"));
});

test("W1-T3900 (5): every receipt kind for the same stop shares one parent — its incident receipt", () => {
  const stop = issuedStop();
  const now = Date.now();
  const issued = emergencyStopIssuedReceipt(stop, { now });
  const refusalResult = checkEmergencyStop([stop], { actionKind: "agent-handoff" }, now);
  const connector: RunningEffectConnector = { supportsCancellation: false, requestCancellation: () => "applied" };
  const cancellation = requestRunningEffectCancellation(connector, { stop, effectRef: "eff-2", effectKind: "email" }, { now });
  assert.equal(refusalResult.ok, false);
  if (refusalResult.ok) return;
  const parents = new Set([issued.parentReceiptId, refusalResult.receipt.parentReceiptId, cancellation.receipt.parentReceiptId]);
  assert.deepEqual([...parents], [stop.incidentReceiptId]);
});

const WIRE_TOKEN = "emergency-wire-write-token";
const WIRE_NOW = "2026-09-20T10:00:00.000Z";

async function withWireService<T>(fn: (base: string, ledgerPath: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "rmd-emergency-wire-"));
  mkdirSync(join(root, "state"), { recursive: true });
  const ledgerPath = join(root, "state", "ledger.ndjson");
  const server = createService({
    tokens: { read: WIRE_TOKEN, write: WIRE_TOKEN },
    routes: buildOperatorAgentRoutes({ ledgerPath, now: () => Date.parse(WIRE_NOW) }),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    return await fn(`http://127.0.0.1:${port}`, ledgerPath);
  } finally {
    server.close();
  }
}

function wirePost(base: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${WIRE_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function wireGet(base: string, path: string): Promise<Response> {
  return fetch(`${base}${path}`, { headers: { authorization: `Bearer ${WIRE_TOKEN}` } });
}

function emergencyIssueBody(overrides: Record<string, unknown> = {}) {
  return {
    id: "stop-wire",
    scope: "repository",
    scopeTarget: "acme/widgets",
    reason: "connector is behaving unexpectedly",
    issuedBy: "operator:alice",
    clearPolicy: "explicit-clear-required",
    affectedCapabilities: ["deploy.trigger"],
    affectedDelegationClasses: ["deploy.advance"],
    incidentReceiptId: "incident-wire",
    ...overrides,
  };
}

test("W1-T3900 (wire): routes validate, persist, expose, and clear one stop with linked receipts", async () => {
  await withWireService(async (base, ledgerPath) => {
    const malformed: unknown[] = [
      null,
      { ...emergencyIssueBody(), scope: "unknown" },
      { ...emergencyIssueBody(), scopeTarget: 42 },
      { ...emergencyIssueBody(), reason: undefined },
      { ...emergencyIssueBody(), issuedBy: undefined },
      { ...emergencyIssueBody(), clearPolicy: "unknown" },
      { ...emergencyIssueBody(), expiresAt: "not-a-date" },
      { ...emergencyIssueBody(), incidentReceiptId: undefined },
      { ...emergencyIssueBody(), affectedCapabilities: [] },
      { ...emergencyIssueBody(), affectedDelegationClasses: [] },
      { ...emergencyIssueBody(), id: "" },
      { ...emergencyIssueBody(), clearPolicy: "expires" },
    ];
    for (const body of malformed) assert.equal((await wirePost(base, "/v1/operator-agent/emergency/stop", body)).status, 400);

    assert.equal((await wireGet(base, "/v1/operator-agent/emergency/status")).status, 200);
    const issued = await wirePost(base, "/v1/operator-agent/emergency/stop", emergencyIssueBody());
    assert.equal(issued.status, 201);
    const issuedBody = (await issued.json()) as { stop: { id: string }; receipt: Record<string, unknown> };
    assert.equal(issuedBody.stop.id, "stop-wire");
    assert.equal(issuedBody.receipt.parentReceiptId, "incident-wire");

    const status = await wireGet(base, "/v1/operator-agent/emergency/status");
    assert.deepEqual((await status.json() as { active: Array<{ id: string }> }).active.map((item) => item.id), ["stop-wire"]);

    const missingClear = await wirePost(base, "/v1/operator-agent/emergency/clear", {
      stopId: "missing",
      confirmation: { confirmedBy: "operator:alice", confirmedAt: WIRE_NOW },
      health: { source: "daemon-health", status: "healthy", checkedAt: WIRE_NOW },
      revocation: { coverage: "complete" },
    });
    assert.equal(missingClear.status, 404);
    for (const body of [
      { stopId: "stop-wire", confirmation: {}, health: { source: "daemon-health", status: "healthy", checkedAt: WIRE_NOW }, revocation: { coverage: "complete" } },
      { stopId: "stop-wire", confirmation: { confirmedBy: "operator:alice", confirmedAt: WIRE_NOW }, health: {}, revocation: { coverage: "complete" } },
      { stopId: "stop-wire", confirmation: { confirmedBy: "operator:alice", confirmedAt: WIRE_NOW }, health: { source: "daemon-health", checkedAt: WIRE_NOW }, revocation: { coverage: "complete" } },
      { stopId: "stop-wire", confirmation: { confirmedBy: "operator:alice", confirmedAt: WIRE_NOW }, health: { source: "daemon-health", status: "unknown", checkedAt: WIRE_NOW }, revocation: { coverage: "complete" } },
      { stopId: "stop-wire", confirmation: { confirmedBy: "operator:alice", confirmedAt: WIRE_NOW }, health: { source: "daemon-health", status: "healthy", checkedAt: WIRE_NOW }, revocation: {} },
    ]) assert.equal((await wirePost(base, "/v1/operator-agent/emergency/clear", body)).status, 400);
    const refused = await wirePost(base, "/v1/operator-agent/emergency/clear", {
      stopId: "stop-wire",
      confirmation: { confirmedBy: "operator:alice", confirmedAt: WIRE_NOW },
      health: { source: "daemon-health", status: "degraded", checkedAt: WIRE_NOW },
      revocation: { coverage: "complete" },
    });
    assert.equal(refused.status, 409);
    assert.equal((await refused.json() as { code: string }).code, "health-not-healthy");

    const cleared = await wirePost(base, "/v1/operator-agent/emergency/clear", {
      stopId: "stop-wire",
      confirmation: { confirmedBy: "operator:alice", confirmedAt: WIRE_NOW },
      health: { source: "daemon-health", status: "healthy", checkedAt: WIRE_NOW },
      revocation: { coverage: "complete" },
    });
    assert.equal(cleared.status, 200);
    assert.equal((await cleared.json() as { receipt: Record<string, unknown> }).receipt.parentReceiptId, "incident-wire");
    assert.deepEqual((await (await wireGet(base, "/v1/operator-agent/emergency/status")).json() as { active: unknown[] }).active, []);

    const steps = readFileSync(ledgerPath, "utf8").trim().split("\n").map((line) => JSON.parse(line).step);
    assert.deepEqual(steps, ["panel.emergency_stop_issued", "panel.emergency_stop_cleared"]);
  });
});

test("W1-T3900 (wire): active stops refuse proposal, promotion, and delegation admission before execution", async () => {
  await withWireService(async (base) => {
    assert.equal((await wirePost(base, "/v1/operator-agent/emergency/stop", emergencyIssueBody())).status, 201);

    const proposal = {
      proposalId: "operator-agent:repo:emergency",
      repo: "acme/widgets",
      proposalText: "Increase worker capacity.",
      confidence: 0.96,
      reasoning: "Queue pressure is sustained.",
      category: "scale",
      status: "pending",
      createdAt: "2026-09-19T10:00:00.000Z",
      expiresAt: "2026-09-21T10:00:00.000Z",
      evidence: [{ label: "Queue", value: "8", source: "run-ledger", observedAt: WIRE_NOW, freshness: "verified" }],
    };
    const proposalResponse = await wirePost(base, "/v1/operator-agent/proposals", { proposal });
    assert.equal(proposalResponse.status, 423);
    assert.equal((await proposalResponse.json() as { error: string }).error, "emergency_stop_active");

    const promotion = {
      version: "experiment-promotion-v1",
      promotionId: "promotion:repo:emergency",
      experimentId: "experiment:repo:emergency",
      candidate: "worker-pool-v2",
      baseline: "worker-pool-v1",
      scope: { repo: "acme/widgets", policyScope: "worker-pool", taskType: "worker", lane: "main" },
      comparisonPopulation: "acme/widgets worker tasks on main",
      denominatorFloor: 10,
      observationWindow: { start: "2026-09-18T10:00:00.000Z", end: "2026-09-22T10:00:00.000Z" },
      guardMetrics: [{ metricName: "queue_latency_p50", unit: "minutes", direction: "max", abortThreshold: 12 }],
      maxExposure: 0.1,
      owner: "operator-agent",
      expiresAt: "2026-09-27T10:00:00.000Z",
      rollback: { plan: "Restore worker-pool-v1.", reason: "Rollback on regression.", receipt: "change:worker-pool-restore" },
      createdAt: WIRE_NOW,
      state: "proposed",
    };
    assert.equal((await wirePost(base, "/v1/operator-agent/promotions", { promotion })).status, 201);
    assert.equal((await wirePost(base, "/v1/operator-agent/promotions/replay", {
      promotionId: promotion.promotionId,
      replay: { version: "experiment-promotion-v1", corpusSize: 1, matched: 1, mismatched: 0, deterministic: true, sideEffectFree: true, results: [{ caseId: "case-1", candidateOutput: 1, baselineOutput: 1, matched: true }] },
    })).status, 200);
    assert.equal((await wirePost(base, "/v1/operator-agent/promotions/decision", { promotionId: promotion.promotionId, decision: "approved" })).status, 200);
    const promotionResponse = await wirePost(base, "/v1/operator-agent/promotions/advance", { promotionId: promotion.promotionId, target: "shadow" });
    assert.equal(promotionResponse.status, 423);

    const handoffResponse = await wirePost(base, "/v1/operator-agent/delegation/handoff", {
      envelope: {
        id: "dlg-wire-emergency",
        sender: "agent:scheduler",
        recipient: "agent:deployer",
        principal: "operator:alice",
        purpose: "roll the production canary forward",
        capabilities: ["deploy.advance"],
        scope: { repo: "acme/widgets", instance: "prod-1" },
        audience: "provider:cash",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
      acceptedCapabilities: ["deploy.advance"],
      action: { capability: "deploy.advance", nonce: "n1", risk: "low" },
    });
    assert.equal(handoffResponse.status, 423);
    assert.equal((await handoffResponse.json() as { error: string }).error, "emergency_stop_active");
  });
});
