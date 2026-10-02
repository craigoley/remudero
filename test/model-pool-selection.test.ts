import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ROUTING_POOL_VERSION,
  parseRoutingPoolSnapshot,
  selectFromRoutingPool,
  type RoutingPoolRequest,
} from "../src/lib/model-pool.js";

const NOW = Date.parse("2026-10-02T12:00:00.000Z");

function candidate(id: string, readiness: string, quality: number, cost: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    provider: "codex",
    model: `model-${id}`,
    effort: "high",
    adapter: "codex-exec",
    toolProfile: "implement-default",
    corpus: { id: "rmd-implement", version: "2026-09" },
    lastProbeAt: "2026-10-01T12:00:00.000Z",
    promotedBy: "review#42",
    capabilities: ["edit", "shell"],
    aggregates: { samples: 20, joinedSamples: 20, successRate: 0.8, quality, costUsdPerTask: cost, latencyMsP50: 90_000 },
    readiness,
    ...overrides,
  };
}

function pool(candidates: unknown[], revision = "pool-rev-1") {
  return parseRoutingPoolSnapshot({
    version: ROUTING_POOL_VERSION,
    revision,
    generatedAt: "2026-10-02T00:00:00.000Z",
    pools: [{
      taskClass: "implement",
      capabilityTier: "balanced",
      corpus: { id: "rmd-implement", version: "2026-09" },
      baseline: { provider: "claude", model: "claude-sonnet-5", effort: "medium", reviewedBy: "review#7" },
      candidates,
    }],
  });
}

function request(overrides: Partial<RoutingPoolRequest> = {}): RoutingPoolRequest {
  return {
    sessionId: "session-1",
    taskClass: "implement",
    capabilityTier: "balanced",
    budgetUsd: 5,
    requiredCapabilities: ["edit"],
    nowMs: NOW,
    terminalJoinKey: "assignment-123",
    ...overrides,
  };
}

test("W1-T3958 criterion 2: selection admits only Ready candidates, even when a non-ready one scores higher", () => {
  const snapshot = pool([
    candidate("failed-best", "failed", 0.99, 0.1),
    candidate("benchmarking-best", "benchmarking", 0.98, 0.1),
    candidate("unavailable-best", "unavailable", 0.97, 0.1),
    candidate("ready-ok", "ready", 0.6, 2),
    candidate("ready-better", "ready", 0.7, 3),
  ]);
  const decision = selectFromRoutingPool(snapshot, request());
  assert.equal(decision.outcome, "pool");
  assert.equal(decision.chosen?.candidateId, "ready-better");
  assert.deepEqual(decision.chosen && { model: decision.chosen.model, effort: decision.chosen.effort }, { model: "model-ready-better", effort: "high" });
  for (const id of ["failed-best", "benchmarking-best", "unavailable-best"]) {
    const entry = decision.candidates.find((row) => row.id === id);
    assert.equal(entry?.eligible, false, `${id} is never admitted`);
  }
});

test("W1-T3958 criterion 2: selection is deterministic for an identical session, task class, pool revision, budget and capability profile", () => {
  const rows = [
    candidate("tie-a", "ready", 0.7, 2),
    candidate("tie-b", "ready", 0.7, 2),
    candidate("tie-c", "ready", 0.7, 2),
  ];
  const first = selectFromRoutingPool(pool(rows), request());
  for (let i = 0; i < 5; i++) {
    assert.deepEqual(selectFromRoutingPool(pool(rows), request()), first, "same inputs reproduce the same receipt");
  }
  assert.deepEqual(selectFromRoutingPool(pool([...rows].reverse()), request()).chosen, first.chosen, "input order does not move the pick");
  const sessions = new Set(Array.from({ length: 24 }, (_, i) => selectFromRoutingPool(pool(rows), request({ sessionId: `s-${i}` })).chosen?.candidateId));
  assert.ok(sessions.size > 1, "an exact tie is broken per session, not always toward one id");
});

test("W1-T3958 criterion 2: budget and capability profile gate admission", () => {
  const snapshot = pool([
    candidate("expensive", "ready", 0.95, 9),
    candidate("no-shell", "ready", 0.9, 1, { capabilities: ["edit"] }),
    candidate("fits", "ready", 0.5, 1),
  ]);
  const decision = selectFromRoutingPool(snapshot, request({ requiredCapabilities: ["edit", "shell"] }));
  assert.equal(decision.chosen?.candidateId, "fits");
  assert.equal(decision.candidates.find((row) => row.id === "expensive")?.reason, "over-budget");
  assert.equal(decision.candidates.find((row) => row.id === "no-shell")?.reason, "capability-missing");
});

test("W1-T3958 criterion 4: the route receipt preserves pool revision, candidate set, chosen model and effort, reason, fallback and join key", () => {
  const snapshot = pool([candidate("winner", "ready", 0.8, 1), candidate("loser", "failed", 0.9, 1)], "pool-rev-9");
  const receipt = selectFromRoutingPool(snapshot, request({ terminalJoinKey: "assignment-xyz" }));
  assert.equal(receipt.version, "routing-pool-v1");
  assert.equal(receipt.poolRevision, "pool-rev-9");
  assert.equal(receipt.sessionId, "session-1");
  assert.equal(receipt.taskClass, "implement");
  assert.deepEqual(receipt.candidates.map((row) => [row.id, row.readiness, row.eligible]), [
    ["winner", "ready", true],
    ["loser", "failed", false],
  ]);
  assert.deepEqual(receipt.chosen, { candidateId: "winner", provider: "codex", model: "model-winner", effort: "high" });
  assert.equal(receipt.reason, "ready-candidate");
  assert.deepEqual(receipt.fallback, {
    used: false,
    baseline: { provider: "claude", model: "claude-sonnet-5", effort: "medium", reviewedBy: "review#7" },
  });
  assert.equal(receipt.terminalJoinKey, "assignment-xyz");
  assert.deepEqual(receipt.evidence, { quality: 0.8, costUsdPerTask: 1 });
  assert.deepEqual(JSON.parse(JSON.stringify(receipt)), receipt, "the receipt round-trips as a ledger row");
});

test("W1-T3958 criterion 4: a pinned session keeps its route across a pool revision without a declared refusal", () => {
  const before = selectFromRoutingPool(pool([candidate("first", "ready", 0.8, 1)]), request());
  assert.equal(before.chosen?.candidateId, "first");
  const pin = { poolRevision: before.poolRevision!, ...before.chosen! };
  const after = selectFromRoutingPool(
    pool([candidate("first", "ready", 0.5, 1), candidate("newer", "ready", 0.99, 1)], "pool-rev-2"),
    request({ pinned: pin }),
  );
  assert.equal(after.outcome, "pinned");
  assert.equal(after.reason, "session-pinned");
  assert.equal(after.chosen?.candidateId, "first");
  assert.equal(after.poolRevision, "pool-rev-2");
  assert.equal(after.pinnedFromRevision, "pool-rev-1");
});
