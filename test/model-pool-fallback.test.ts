import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ROUTING_POOL_VERSION,
  parseRoutingPoolSnapshot,
  selectFromRoutingPool,
  unavailableRoutingPool,
  type RoutingPoolRequest,
} from "../src/lib/model-pool.js";

const NOW = Date.parse("2026-10-02T12:00:00.000Z");
const BASELINE = { provider: "claude", model: "claude-sonnet-5", effort: "medium", reviewedBy: "review#7" };

function candidate(id: string, readiness: string, overrides: Record<string, unknown> = {}) {
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
    capabilities: ["edit"],
    aggregates: { samples: 20, joinedSamples: 20, successRate: 0.8, quality: 0.8, costUsdPerTask: 1, latencyMsP50: 90_000 },
    readiness,
    ...overrides,
  };
}

function pool(candidates: unknown[], generatedAt = "2026-10-02T00:00:00.000Z") {
  return parseRoutingPoolSnapshot({
    version: ROUTING_POOL_VERSION,
    revision: "pool-rev-1",
    generatedAt,
    pools: [{
      taskClass: "implement",
      capabilityTier: "balanced",
      corpus: { id: "rmd-implement", version: "2026-09" },
      baseline: BASELINE,
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

function assertBaseline(decision: ReturnType<typeof selectFromRoutingPool>, reason: string) {
  assert.equal(decision.outcome, "baseline");
  assert.equal(decision.reason, reason);
  assert.deepEqual(decision.chosen, { provider: "claude", model: "claude-sonnet-5", effort: "medium" });
  assert.equal(decision.fallback.used, true);
  assert.deepEqual(decision.fallback.baseline, BASELINE, "the baseline is named, never hidden");
  assert.deepEqual(decision.evidence, { quality: "unavailable", costUsdPerTask: "unavailable" }, "no quality or cost is invented");
}

test("W1-T3958 criterion 3: a failed or unavailable pool selects the fixed reviewed baseline", () => {
  assertBaseline(selectFromRoutingPool(pool([candidate("f", "failed"), candidate("u", "unavailable")]), request()), "no-ready-candidate");
});

test("W1-T3958 criterion 3: a stale pool selects the baseline", () => {
  assertBaseline(selectFromRoutingPool(pool([candidate("r", "ready")], "2026-08-01T00:00:00.000Z"), request()), "pool-stale");
  const staleCandidate = selectFromRoutingPool(pool([candidate("r", "ready", { lastProbeAt: "2026-08-01T00:00:00.000Z" })]), request());
  assertBaseline(staleCandidate, "no-ready-candidate");
  assert.equal(staleCandidate.candidates[0].reason, "stale-evidence");
});

test("W1-T3958 criterion 3: an over-budget pool selects the baseline", () => {
  const decision = selectFromRoutingPool(pool([candidate("r", "ready")]), request({ budgetUsd: 0.5 }));
  assertBaseline(decision, "no-ready-candidate");
  assert.equal(decision.candidates[0].reason, "over-budget");
});

test("W1-T3958 criterion 3: an unjoined pool selects the baseline", () => {
  const decision = selectFromRoutingPool(pool([candidate("r", "ready", {
    aggregates: { samples: 20, joinedSamples: 0, successRate: 0.8, quality: 0.8, costUsdPerTask: 1, latencyMsP50: 1 },
  })]), request());
  assertBaseline(decision, "no-ready-candidate");
  assert.equal(decision.candidates[0].reason, "unjoined-evidence");
});

test("W1-T3958 criterion 3: missing cost or quality is never imputed as zero", () => {
  const decision = selectFromRoutingPool(pool([candidate("r", "ready", {
    aggregates: { samples: 20, joinedSamples: 20, successRate: 0.8 },
  })]), request({ budgetUsd: 0 }));
  assertBaseline(decision, "no-ready-candidate");
  assert.equal(decision.candidates[0].reason, "evidence-missing");
  assert.equal(decision.candidates[0].quality, null);
  assert.equal(decision.candidates[0].costUsdPerTask, null);
});

test("W1-T3958 criterion 3: an unavailable snapshot or unknown class refuses explicitly", () => {
  const unavailable = selectFromRoutingPool(unavailableRoutingPool("routing-pool-not-configured"), request());
  assert.equal(unavailable.outcome, "refused");
  assert.equal(unavailable.reason, "pool-unavailable:routing-pool-not-configured");
  assert.equal(unavailable.chosen, null);
  assert.equal(unavailable.poolRevision, null);
  assert.deepEqual(unavailable.fallback, { used: false, baseline: null });
  assert.deepEqual(unavailable.evidence, { quality: "unavailable", costUsdPerTask: "unavailable" });

  const unknownClass = selectFromRoutingPool(pool([candidate("r", "ready")]), request({ taskClass: "review" }));
  assert.equal(unknownClass.outcome, "refused");
  assert.equal(unknownClass.reason, "no-pool-for-class");
  assert.equal(unknownClass.chosen, null);
});

test("W1-T3958 criterion 3: only a declared capacity or safety refusal moves a pinned session, and only to the baseline", () => {
  const snapshot = pool([candidate("r", "ready")]);
  const pin = { poolRevision: "pool-rev-1", candidateId: "r", provider: "codex", model: "model-r", effort: "high" };
  assert.equal(selectFromRoutingPool(snapshot, request({ pinned: pin })).outcome, "pinned");
  const capacity = selectFromRoutingPool(snapshot, request({ pinned: pin, refusal: { kind: "capacity", detail: "codex full" } }));
  assertBaseline(capacity, "refusal:capacity");
  const safety = selectFromRoutingPool(snapshot, request({ refusal: { kind: "safety", detail: "policy" } }));
  assertBaseline(safety, "refusal:safety");

  const baselinePin = { poolRevision: "pool-rev-1", provider: "claude", model: "claude-sonnet-5", effort: "medium" };
  const exhausted = selectFromRoutingPool(snapshot, request({ pinned: baselinePin, refusal: { kind: "capacity", detail: "claude full" } }));
  assert.equal(exhausted.outcome, "refused");
  assert.equal(exhausted.reason, "baseline-refused:capacity");
  assert.equal(exhausted.chosen, null);
  assert.deepEqual(exhausted.fallback, { used: true, baseline: BASELINE });
});
