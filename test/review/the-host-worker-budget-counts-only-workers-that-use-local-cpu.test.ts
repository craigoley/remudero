import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  initialReviewCapacityState,
  selectAdaptiveReviewWidth,
  type ReviewCapacityBounds,
  type ReviewCapacityDecision,
  type ReviewCapacityObservation,
  type ReviewCapacityPolicy,
  type ReviewCapacityState,
} from "#src/lib/review-capacity.js";
import {
  buildSweepEffects, DEFAULT_SWEEP_POLICY, registerChildWork, resetChildWork, resetReviewProviderBound,
} from "#src/lib/sweep.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

// W1-T2989 — the host worker budget counts only workers that use local CPU. A review waiting on the model provider
// holds a worker but uses no local CPU. MEASURED 2026-11-13 13:05-19:05Z: 28 of 70 review.capacity samples had reason
// host-worker-budget with 5-7 active workers against the budget of 8.

const POLICY = {
  hostWorkerBudget: 8,
  workerMemoryReserveMib: 1536,
  healthyWindowSamples: 3,
  sampleCadenceMs: 60_000,
  telemetryCadenceMs: 300_000,
  cpuPsiLowPct: 5,
  memoryPsiLowPct: 5,
  memoryPsiHighPct: 15,
  providerAllowancePct: 2,
  settlementWindowMs: 1_800_000,
  latencyExpansionRatio: 2,
  unhealthySettlementThreshold: 2,
  minHealthySettlements: 1,
} as unknown as ReviewCapacityPolicy;

const BOUNDS: ReviewCapacityBounds = { minWidth: 1, baseWidth: 4, maxWidth: 8 };

/** A calm host with a backlog: only the host worker budget can hold the width down. */
function calm(over: Partial<ReviewCapacityObservation> = {}): ReviewCapacityObservation {
  return {
    nowMs: 1_000_000,
    queueDepth: 6,
    activeWorkers: 8,
    memAvailableMib: 20_000,
    cpuPsiSomeAvg10Pct: 1,
    cpuPsiFullAvg10Pct: 0,
    cpuWeightShare: 0.5,
    memoryPsiSomeAvg10Pct: 0,
    hostLoad1: 4,
    hostCpuCount: 8,
    reviewCpuChildren: 0,
    settlements: { failures: 0, timeouts: 0, successes: 5 },
    provider: { fresh: true, readable: true, refused: false, headroomPct: 80, reservePct: 5 },
    ...over,
  } as ReviewCapacityObservation;
}

function decide(
  over: Partial<ReviewCapacityObservation>,
  prior: ReviewCapacityState = initialReviewCapacityState(1),
): ReviewCapacityDecision {
  return selectAdaptiveReviewWidth(prior, POLICY, calm(over), BOUNDS).decision;
}

test("W1-T2989 criterion 1: 8 active workers with 3 waiting on the provider are judged as 5 local CPU workers", () => {
  const all = decide({ activeWorkers: 8 });
  assert.equal(all.reason, "host-worker-budget", "every worker counted: the budget arm fires");
  assert.equal(all.effectiveWidth, 1);

  const local = decide({ activeWorkers: 8, providerPhaseWorkers: 3 });
  assert.notEqual(local.reason, "host-worker-budget", "5 local workers plus width 1 fit the budget of 8");
  assert.equal(local.reason, "healthy-window");
  assert.equal(local.effectiveWidth, 3, "restoreBase leaves room for 8 - 5 = 3 lanes");
  assert.equal(local.evidence.activeWorkers, 8);
  assert.equal(local.evidence.localCpuWorkers, 5);

  // A width already at base: 5 + 4 > 8 still sheds one lane, so the budget stays a bound on local CPU.
  const atBase = decide({ activeWorkers: 8, providerPhaseWorkers: 3 }, initialReviewCapacityState(4));
  assert.equal(atBase.reason, "host-worker-budget");
  assert.equal(atBase.effectiveWidth, 3);
});

test("W1-T2989 criterion 2: with no provider-phase count, or a count of 0, every decision equals the one before", () => {
  // The decisions origin/main makes for these samples.
  const pinned: Array<[Partial<ReviewCapacityObservation>, number, string, number]> = [
    [{ activeWorkers: 8 }, 1, "host-worker-budget", 1],
    [{ activeWorkers: 5 }, 1, "healthy-window", 3],
    [{ activeWorkers: 7 }, 4, "host-worker-budget", 3],
    [{ activeWorkers: 2 }, 1, "healthy-window", 4],
  ];
  for (const [over, width, reason, expected] of pinned) {
    for (const count of [undefined, 0]) {
      const decision = decide({ ...over, providerPhaseWorkers: count }, initialReviewCapacityState(width));
      assert.equal(decision.reason, reason, `${JSON.stringify(over)} count ${count}`);
      assert.equal(decision.effectiveWidth, expected, `${JSON.stringify(over)} count ${count}`);
    }
  }
  // Absent and 0 agree on every field, across workers, widths and pressure.
  const pressures: Array<Partial<ReviewCapacityObservation>> = [
    {},
    { cpuPsiFullAvg10Pct: 60, cpuPsiSomeAvg10Pct: 70 },
    { memoryPsiSomeAvg10Pct: 20 },
    { hostLoad1: 30, cpuPsiFullAvg10Pct: 12, cpuPsiSomeAvg10Pct: 40 },
    { laneCpuBound: 6, cpuPsiFullAvg10Pct: 8, cpuPsiSomeAvg10Pct: 20 },
  ];
  for (const pressure of pressures) {
    for (let active = 0; active <= 10; active += 1) {
      for (let width = 1; width <= 5; width += 1) {
        const absent = selectAdaptiveReviewWidth(initialReviewCapacityState(width), POLICY, calm({ ...pressure, activeWorkers: active }), BOUNDS);
        const zero = selectAdaptiveReviewWidth(
          initialReviewCapacityState(width), POLICY, calm({ ...pressure, activeWorkers: active, providerPhaseWorkers: 0 }), BOUNDS,
        );
        assert.deepEqual(zero, absent, `${JSON.stringify(pressure)} active ${active} width ${width}`);
        assert.equal(absent.decision.evidence.localCpuWorkers, active);
      }
    }
  }
});

test("W1-T2989 criterion 4: a provider-phase count above the active workers, or a negative one, keeps the local count in range", () => {
  const over = decide({ activeWorkers: 8, providerPhaseWorkers: 12 });
  assert.equal(over.evidence.localCpuWorkers, 0, "never below 0");
  assert.equal(over.effectiveWidth, 4, "room for the whole base, never above it");
  for (const count of [-3, Number.NaN, Number.POSITIVE_INFINITY]) {
    const odd = decide({ activeWorkers: 8, providerPhaseWorkers: count });
    assert.ok(odd.evidence.localCpuWorkers >= 0 && odd.evidence.localCpuWorkers <= 8, `count ${count}`);
  }
  const negative = decide({ activeWorkers: 8, providerPhaseWorkers: -3 });
  assert.equal(negative.evidence.localCpuWorkers, 8, "a negative count removes no worker");
  assert.equal(negative.reason, "host-worker-budget");
});

test("W1-T2989 criterion 3: the sweep adapter passes reviewPhaseSplit's provider-phase count and the row records both counts", (t) => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}local-cpu-workers-`));
  resetChildWork();
  resetReviewProviderBound();
  t.after(() => {
    resetChildWork();
    resetReviewProviderBound();
    rmSync(root, { recursive: true, force: true });
  });
  for (const head of ["a", "b", "c"]) {
    registerChildWork({ runId: `judge-${head}`, taskId: "W1-T2989", kind: "review", headSha: head, reviewKey: head, readPhase: () => "review:judge" });
  }
  registerChildWork({ runId: "proofs", taskId: "W1-T2989", kind: "review", headSha: "d", reviewKey: "d", readPhase: () => "review:proofs" });
  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const effects = buildSweepEffects({
    owner: "acme", repo: "local-cpu-workers", config: { root } as never,
    ledgerPath: join(root, "state", "ledger.ndjson"), runId: "W1-T2989", plan: { tasks: [] } as never,
    log: (step, extra) => logs.push({ step, extra }), policy: DEFAULT_SWEEP_POLICY,
  });
  effects.selectAdaptiveReviewWidth!({ queueDepth: 6, nowMs: Date.parse("2026-11-14T12:00:00Z"), ledgerLines: [], activeWorkers: 8 });
  const row = logs.find((entry) => entry.step === "review.capacity")?.extra;
  assert.ok(row, "the sample writes its review.capacity row");
  assert.equal(row.active_workers, 8, "active_workers keeps every worker");
  assert.equal(row.judge_phase_in_flight, 3);
  assert.equal(row.local_cpu_workers, 5, "the budget judged the workers less the 3 reviews waiting on the provider");
});
