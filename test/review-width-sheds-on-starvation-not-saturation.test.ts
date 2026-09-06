import assert from "node:assert/strict";
import { test } from "node:test";
import {
  readReviewHostObservation,
  selectAdaptiveReviewWidth,
  type ReviewCapacityObservation,
  type ReviewCapacityPolicy,
  type ReviewCapacityState,
} from "../src/lib/review-capacity.js";

// W1-T2985 — REVIEW WIDTH MUST SHED ON STARVATION, NOT ON SATURATION.
//
// PSI `some` means "at least one task waited for the resource"; PSI `full` means "every non-idle
// task was stalled". On a box with more runnable threads than cores `some` is high by construction
// and says nothing about whether throughput is impaired. MEASURED on the fleet 2026-09-06, while two
// builds and a retro were running healthily on 8 cores:
//     /proc/pressure/cpu   some avg10=80.57   full avg10=0.00
// Against `cpuPsiHighPct: 20` (shed) and `cpuPsiLowPct: 5` (recover), the `some` reading pinned
// review width at the floor of 1 permanently and reset `healthySamples` to 0 on every sample, so it
// could never recover — with 23 GiB free and `active_workers: 0`.

const POLICY: ReviewCapacityPolicy = {
  hostWorkerBudget: 4,
  workerMemoryReserveMib: 1536,
  healthyWindowSamples: 3,
  sampleCadenceMs: 60_000,
  telemetryCadenceMs: 300_000,
  cpuPsiLowPct: 5,
  cpuPsiHighPct: 20,
  memoryPsiLowPct: 5,
  memoryPsiHighPct: 15,
  providerAllowancePct: 2,
  latencyExpansionRatio: 2,
  unhealthySettlementThreshold: 2,
} as unknown as ReviewCapacityPolicy;

const BOUNDS = { minWidth: 1, baseWidth: 2, maxWidth: 3 };

/** The measured fleet condition: heavy saturation, zero starvation, plenty of memory. */
function healthyBusyObservation(): ReviewCapacityObservation {
  return {
    cpuPsiSomeAvg10Pct: 80.57,
    cpuPsiFullAvg10Pct: 0,
    memoryPsiSomeAvg10Pct: 0,
    memAvailableMib: 23812,
    activeWorkers: 0,
    settlements: { failures: 0, timeouts: 0, baselineLatencyMs: 1000, recentLatencyMs: 1000 },
    provider: { fresh: true, readable: true, refused: false, headroomPct: 80, reservePct: 2 },
  } as unknown as ReviewCapacityObservation;
}

test("W1-T2985: heavy cpu saturation with no starvation does not shed review width", () => {
  const prior: ReviewCapacityState = { effectiveWidth: 2, healthySamples: 0 };
  const { decision } = selectAdaptiveReviewWidth(prior, POLICY, healthyBusyObservation(), BOUNDS);
  assert.notEqual(
    decision.reason,
    "cpu-pressure",
    "cpu `some` at 80.57% with `full` at 0.00% is a SATURATED box, not a starved one — " +
      "throughput is unimpaired and admission must not shed on it",
  );
  assert.ok(decision.effectiveWidth >= 2, `width must not fall below base on this reading (got ${decision.effectiveWidth})`);
});

test("W1-T2985: real cpu starvation still sheds review width", () => {
  const starved = { ...healthyBusyObservation(), cpuPsiFullAvg10Pct: 55 } as ReviewCapacityObservation;
  const prior: ReviewCapacityState = { effectiveWidth: 2, healthySamples: 0 };
  const { decision } = selectAdaptiveReviewWidth(prior, POLICY, starved, BOUNDS);
  assert.equal(decision.reason, "cpu-pressure", "full PSI above the shed threshold is genuine starvation");
  assert.equal(decision.effectiveWidth, 1, "and it sheds exactly one lane, as before");
});

test("W1-T2985: the host observation reads the full line as well as the some line", () => {
  const cpu = "some avg10=80.57 avg60=68.60 avg300=55.34 total=10616850287\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n";
  const obs = readReviewHostObservation((path: string) => {
    if (path.endsWith("cpu.pressure") || path.endsWith("pressure/cpu")) return cpu;
    throw new Error("absent");
  });
  assert.equal(obs.cpuPsiSomeAvg10Pct, 80.57, "the some reading is still carried, for diagnosis");
  assert.equal(obs.cpuPsiFullAvg10Pct, 0, "and the full reading — the one the shed decides on — is parsed");
});
