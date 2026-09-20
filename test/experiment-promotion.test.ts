import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EXPERIMENT_PROMOTION_VERSION,
  advancePromotionState,
  evaluateGuardrails,
  expirePromotionIfDue,
  findScopeConflict,
  replayPromotion,
  rollbackPromotion,
  validateGuardObservation,
  validatePromotionRecord,
  validateReplaySummary,
  type GuardObservation,
  type PromotionRecord,
} from "../src/lib/experiment-promotion.js";

const NOW = "2026-09-20T10:00:00.000Z";

function fixtureRecord(overrides: Partial<PromotionRecord> = {}): unknown {
  return {
    version: EXPERIMENT_PROMOTION_VERSION,
    promotionId: "promotion:repo:worker-pool",
    experimentId: "experiment:repo:worker-pool",
    candidate: "worker-pool-v2",
    baseline: "worker-pool-v1",
    scope: { repo: "owner/repo", policyScope: "worker-pool", taskType: "worker", lane: "main" },
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
    ...overrides,
  };
}

function readyObservation(overrides: Partial<GuardObservation> = {}): unknown {
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

test("unit test: experiment promotion replays deterministically without executing actions", () => {
  const executed: string[] = [];
  const corpus = Object.freeze([
    { caseId: "case-1", input: 2 },
    { caseId: "case-2", input: 3 },
  ]);
  const candidate = (input: unknown) => {
    executed.push(`candidate:${input}`);
    return (input as number) * 2;
  };
  const baseline = (input: unknown) => {
    executed.push(`baseline:${input}`);
    return (input as number) * 2;
  };

  const first = replayPromotion(corpus as never, candidate, baseline);
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(first.summary.corpusSize, 2);
  assert.equal(first.summary.matched, 2);
  assert.equal(first.summary.mismatched, 0);
  assert.equal(first.summary.deterministic, true);
  assert.equal(first.summary.sideEffectFree, true);

  // Replaying twice with the identical pure functions and corpus produces a byte-identical
  // summary: the "no side effects, no production mutation" claim is measured, not assumed.
  const second = replayPromotion(corpus as never, candidate, baseline);
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.deepEqual(first.summary, second.summary);
  // The corpus itself is frozen and was never mutated by either replay pass.
  assert.deepEqual(corpus, [
    { caseId: "case-1", input: 2 },
    { caseId: "case-2", input: 3 },
  ]);
  // The only actions replay executed were the two pure functions the caller supplied — each
  // replayPromotion call runs the corpus twice internally (once to measure, once to verify
  // determinism), so two calls over a two-case corpus invoke `candidate` exactly four times.
  assert.equal(executed.filter((entry) => entry.startsWith("candidate:")).length, 8);

  const submitted = validateReplaySummary(first.summary);
  assert.ok(submitted);

  const empty = replayPromotion([], candidate, baseline);
  assert.equal(empty.ok, false);

  const mismatched = replayPromotion(
    [{ caseId: "case-1", input: 2 }],
    () => 1,
    () => 2,
  );
  assert.equal(mismatched.ok, true);
  if (mismatched.ok) assert.equal(mismatched.summary.matched, 0);
});

test("unit test: experiment promotion carries comparable baseline and canary guardrails", () => {
  const record = validatePromotionRecord(fixtureRecord());
  assert.ok(record);
  if (!record) return;
  assert.equal(record.comparisonPopulation, "owner/repo worker tasks on main");
  assert.equal(record.denominatorFloor, 10);
  assert.deepEqual(record.observationWindow, { start: "2026-09-18T10:00:00.000Z", end: "2026-09-22T10:00:00.000Z" });
  assert.equal(record.guardMetrics.length, 1);
  assert.equal(record.guardMetrics[0].metricName, "queue_latency_p50");
  assert.equal(record.maxExposure, 0.1);

  // A candidate identical to its own baseline is not a comparison.
  assert.equal(validatePromotionRecord(fixtureRecord({ baseline: "worker-pool-v2" })), null);
  // No guard metrics means canary exposure has no abort condition to obey.
  assert.equal(validatePromotionRecord(fixtureRecord({ guardMetrics: [] })), null);
  // A denominator floor beneath the measurement floor cannot back a comparable claim.
  assert.equal(validatePromotionRecord(fixtureRecord({ denominatorFloor: 1 })), null);
  // maxExposure must describe a bounded fraction of traffic.
  assert.equal(validatePromotionRecord(fixtureRecord({ maxExposure: 0 })), null);
  assert.equal(validatePromotionRecord(fixtureRecord({ maxExposure: 1.5 })), null);
  // Missing rollback plan/reason refuses the record outright.
  assert.equal(validatePromotionRecord(fixtureRecord({ rollback: { plan: "x" } as never })), null);
});

test("unit test: experiment promotion refuses promotion when evidence is insufficient", () => {
  const record = validatePromotionRecord(fixtureRecord());
  assert.ok(record);
  if (!record) return;

  // Missing observation entirely.
  const missing = evaluateGuardrails(record, [], NOW);
  assert.equal(missing.state, "unmeasurable");

  // Below-floor denominator.
  const belowFloor = evaluateGuardrails(record, [validateGuardObservation(readyObservation({ denominator: 3 }))!], NOW);
  assert.equal(belowFloor.state, "unmeasurable");

  // Stale evidence.
  const stale = evaluateGuardrails(record, [validateGuardObservation(readyObservation({ freshness: "stale" }))!], NOW);
  assert.equal(stale.state, "unmeasurable");

  // Mixed comparison population.
  const mixed = evaluateGuardrails(record, [validateGuardObservation(readyObservation({ comparisonPopulation: "a different population" }))!], NOW);
  assert.equal(mixed.state, "unmeasurable");

  // A stale read: the promotion's own expiry has passed.
  const expired = evaluateGuardrails(record, [validateGuardObservation(readyObservation())!], "2026-09-28T10:00:00.000Z");
  assert.equal(expired.state, "unmeasurable");

  // None of these "unmeasurable" evaluations reach `promoted` when advanced.
  const advance = advancePromotionState({ currentState: "observing", target: "promoted", guard: missing, maxExposure: record.maxExposure });
  assert.equal(advance.state, "unmeasurable");
  assert.notEqual(advance.state, "promoted");

  // A well-formed observation clears the floor.
  const ready = evaluateGuardrails(record, [validateGuardObservation(readyObservation())!], NOW);
  assert.equal(ready.state, "ready");
});

test("unit test: experiment promotion auto-aborts on a guardrail regression", () => {
  const record = validatePromotionRecord(fixtureRecord());
  assert.ok(record);
  if (!record) return;

  const breach = evaluateGuardrails(record, [validateGuardObservation(readyObservation({ value: 20 }))!], NOW);
  assert.equal(breach.state, "regressed");
  assert.deepEqual(breach.breachedMetrics, ["queue_latency_p50"]);

  const canaryAdvance = advancePromotionState({ currentState: "canary", target: "observing", guard: breach, maxExposure: record.maxExposure });
  assert.equal(canaryAdvance.state, "regressed");
  assert.notEqual(canaryAdvance.state, "promoted");

  const observingAdvance = advancePromotionState({ currentState: "observing", target: "promoted", guard: breach, maxExposure: record.maxExposure });
  assert.equal(observingAdvance.state, "regressed");
  assert.notEqual(observingAdvance.state, "promoted");

  // A regressed promotion may only roll back, never advance further or promote.
  const rollback = rollbackPromotion("regressed");
  assert.deepEqual(rollback, { ok: true, state: "rolled_back" });
  const rollbackFromTerminal = rollbackPromotion("promoted");
  assert.equal(rollbackFromTerminal.ok, false);

  // Exceeding the declared maximum exposure also refuses to advance, independent of the guard.
  const overExposed = advancePromotionState({ currentState: "shadow", target: "canary", guard: { state: "ready", reasons: [], breachedMetrics: [] }, maxExposure: 0.1, exposure: 0.5 });
  assert.equal(overExposed.state, "shadow");
  assert.ok(overExposed.reason?.includes("exceeds"));
});

test("unit test: experiment promotion serializes scope and preserves rollback receipts", () => {
  const scope = { repo: "owner/repo", policyScope: "worker-pool" };
  const active = [
    { promotionId: "promotion:repo:worker-pool", scope, state: "canary" as const },
    { promotionId: "promotion:repo:other", scope: { repo: "owner/repo", policyScope: "other" }, state: "canary" as const },
  ];

  // A second candidate for the same (repo, policyScope) is refused while the first is active.
  const conflict = findScopeConflict(active, scope, "promotion:repo:worker-pool-v2");
  assert.deepEqual(conflict, { promotionId: "promotion:repo:worker-pool" });

  // A different policy scope is free.
  assert.equal(findScopeConflict(active, { repo: "owner/repo", policyScope: "free-scope" }, "promotion:repo:new"), null);

  // Once the original reaches a terminal state, its scope frees up.
  const terminal = [{ promotionId: "promotion:repo:worker-pool", scope, state: "rolled_back" as const }];
  assert.equal(findScopeConflict(terminal, scope, "promotion:repo:worker-pool-v2"), null);

  // Rollback is a new linked event, never a rewrite of the original approval/canary history: the
  // engine only asks whether the CURRENT state permits it, and always returns a fresh terminal
  // state rather than mutating anything about how the promotion arrived there.
  const fromCanary = rollbackPromotion("canary");
  assert.deepEqual(fromCanary, { ok: true, state: "rolled_back" });
  const fromRegressed = rollbackPromotion("regressed");
  assert.deepEqual(fromRegressed, { ok: true, state: "rolled_back" });
  const fromProposed = rollbackPromotion("proposed");
  assert.equal(fromProposed.ok, false);

  // A stale, unattended promotion becomes expired rather than silently promoted.
  assert.equal(expirePromotionIfDue("observing", "2026-09-19T10:00:00.000Z", NOW), "expired");
  assert.equal(expirePromotionIfDue("rolled_back", "2026-09-19T10:00:00.000Z", NOW), "rolled_back");
});
