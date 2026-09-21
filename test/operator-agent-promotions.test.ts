import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import { createService } from "../src/lib/service.js";
import { buildOperatorAgentRoutes, type OperatorAgentPromotionHistory } from "../src/lib/operator-agent.js";
import { EXPERIMENT_PROMOTION_VERSION, type PromotionRecord } from "../src/lib/experiment-promotion.js";

const READ_TOKEN = "promotion-read-token";
const WRITE_TOKEN = "promotion-write-token";
const NOW = "2026-09-20T10:00:00.000Z";

function fixture(id = "promotion:repo:worker-pool", policyScope = "worker-pool"): { ledgerPath: string; promotion: PromotionRecord } {
  const root = mkdtempSync(join(tmpdir(), "rmd-operator-promotion-"));
  mkdirSync(join(root, "state"), { recursive: true });
  return {
    ledgerPath: join(root, "state", "ledger.ndjson"),
    promotion: {
      version: EXPERIMENT_PROMOTION_VERSION,
      promotionId: id,
      experimentId: "experiment:repo:worker-pool",
      candidate: "worker-pool-v2",
      baseline: "worker-pool-v1",
      scope: { repo: "owner/repo", policyScope, taskType: "worker", lane: "main" },
      comparisonPopulation: "owner/repo worker tasks on main",
      denominatorFloor: 10,
      observationWindow: { start: "2026-09-18T10:00:00.000Z", end: "2026-09-22T10:00:00.000Z" },
      guardMetrics: [{ metricName: "queue_latency_p50", unit: "minutes", direction: "max", abortThreshold: 12 }],
      maxExposure: 0.1,
      owner: "operator-agent",
      expiresAt: "2026-09-27T10:00:00.000Z",
      rollback: { plan: "Restore worker-pool-v1.", reason: "Rollback on regression.", receipt: "change:worker-pool-restore" },
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

function readyObservation(overrides: Record<string, unknown> = {}) {
  return {
    metricName: "queue_latency_p50",
    value: 6,
    denominator: 20,
    freshness: "verified",
    comparisonPopulation: "owner/repo worker tasks on main",
    observedAt: "2026-09-19T10:00:00.000Z",
    ...overrides,
  };
}

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

async function list(base: string): Promise<OperatorAgentPromotionHistory[]> {
  const response = await fetch(`${base}/v1/operator-agent/promotions`, { headers: { authorization: `Bearer ${READ_TOKEN}` } });
  const body = (await response.json()) as { promotions: OperatorAgentPromotionHistory[] };
  return body.promotions;
}

async function registerReplayApprove(base: string, promotion: PromotionRecord): Promise<void> {
  assert.equal((await post(base, "/v1/operator-agent/promotions", { promotion })).status, 201);
  assert.equal((await post(base, "/v1/operator-agent/promotions/replay", { promotionId: promotion.promotionId, replay: readySummary() })).status, 200);
  assert.equal((await post(base, "/v1/operator-agent/promotions/decision", { promotionId: promotion.promotionId, decision: "approved" })).status, 200);
}

test("promotion routes carry a candidate through replay, shadow, canary, observing, and promotion", async () => {
  const { ledgerPath, promotion } = fixture();
  await withService(ledgerPath, async (base) => {
    await registerReplayApprove(base, promotion);

    const toShadow = await post(base, "/v1/operator-agent/promotions/advance", { promotionId: promotion.promotionId, target: "shadow" });
    assert.equal(toShadow.status, 200);
    assert.equal((await toShadow.json()).state, "shadow");

    const toCanary = await post(base, "/v1/operator-agent/promotions/advance", {
      promotionId: promotion.promotionId,
      target: "canary",
      observations: [readyObservation()],
      exposure: 0.05,
    });
    assert.equal(toCanary.status, 200);
    assert.equal((await toCanary.json()).state, "canary");

    const toObserving = await post(base, "/v1/operator-agent/promotions/advance", {
      promotionId: promotion.promotionId,
      target: "observing",
      observations: [readyObservation()],
    });
    assert.equal((await toObserving.json()).state, "observing");

    const toPromoted = await post(base, "/v1/operator-agent/promotions/advance", {
      promotionId: promotion.promotionId,
      target: "promoted",
      observations: [readyObservation()],
    });
    assert.equal((await toPromoted.json()).state, "promoted");

    const history = await list(base);
    assert.equal(history[0]?.state, "promoted");
    assert.deepEqual(history[0]?.events.map((event) => event.kind), ["replay", "decision", "advance", "advance", "advance", "advance"]);
  });
});

test("a guardrail breach during canary auto-aborts to regressed and rollback preserves the receipt", async () => {
  const { ledgerPath, promotion } = fixture("promotion:repo:regressing");
  await withService(ledgerPath, async (base) => {
    await registerReplayApprove(base, promotion);
    await post(base, "/v1/operator-agent/promotions/advance", { promotionId: promotion.promotionId, target: "shadow" });

    const breach = await post(base, "/v1/operator-agent/promotions/advance", {
      promotionId: promotion.promotionId,
      target: "canary",
      observations: [readyObservation({ value: 30 })],
    });
    assert.equal(breach.status, 200);
    assert.equal((await breach.json()).state, "regressed");

    const rollback = await post(base, "/v1/operator-agent/promotions/rollback", { promotionId: promotion.promotionId, rollback: promotion.rollback });
    assert.equal(rollback.status, 200);

    const history = await list(base);
    assert.equal(history[0]?.state, "rolled_back");
    assert.deepEqual(history[0]?.events.map((event) => event.kind), ["replay", "decision", "advance", "advance", "rollback"]);
    assert.equal(history[0]?.events[3]?.state, "regressed");
  });
  assert.equal(
    readFileSync(ledgerPath, "utf8").trim().split("\n").length,
    6,
    "registration, replay, approval, shadow entry, breach, and rollback remain append-only",
  );
});

test("a second promotion for the same policy scope is refused while the first is active", async () => {
  const { ledgerPath, promotion } = fixture("promotion:repo:scope-a");
  const { promotion: conflicting } = fixture("promotion:repo:scope-b");
  await withService(ledgerPath, async (base) => {
    assert.equal((await post(base, "/v1/operator-agent/promotions", { promotion })).status, 201);
    const conflict = await post(base, "/v1/operator-agent/promotions", { promotion: conflicting });
    assert.equal(conflict.status, 409);

    // A different policy scope is unaffected.
    const { promotion: free } = fixture("promotion:repo:scope-c", "a-different-scope");
    assert.equal((await post(base, "/v1/operator-agent/promotions", { promotion: free })).status, 201);
  });
});

test("promotion registration refuses a malformed record and routes refuse unknown or out-of-order transitions", async () => {
  const { ledgerPath, promotion } = fixture();
  await withService(ledgerPath, async (base) => {
    const malformed = [
      { promotion: { ...promotion, candidate: promotion.baseline } },
      { promotion: { ...promotion, guardMetrics: [] } },
      { promotion: { ...promotion, version: "experiment-promotion-v0" } },
    ];
    for (const body of malformed) assert.equal((await post(base, "/v1/operator-agent/promotions", body)).status, 400);

    assert.equal((await post(base, "/v1/operator-agent/promotions/replay", { promotionId: "promotion:repo:missing", replay: readySummary() })).status, 404);

    assert.equal((await post(base, "/v1/operator-agent/promotions", { promotion })).status, 201);
    const duplicate = await post(base, "/v1/operator-agent/promotions", { promotion });
    assert.equal(duplicate.status, 200);
    assert.equal((await duplicate.json()).existing, true);
    // Cannot advance to canary before shadow, and cannot decide before replay.
    assert.equal((await post(base, "/v1/operator-agent/promotions/decision", { promotionId: promotion.promotionId, decision: "approved" })).status, 409);
    assert.equal(
      (await post(base, "/v1/operator-agent/promotions/advance", { promotionId: promotion.promotionId, target: "canary" })).status,
      409,
    );
  });
  assert.equal(existsSync(ledgerPath), true);
});
