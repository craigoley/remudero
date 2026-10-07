import assert from "node:assert/strict";
import { test } from "node:test";
import * as capacity from "../src/lib/review-capacity.js";
import type {
  ReviewCapacityObservation,
  ReviewCapacityPolicy,
  ReviewCapacityState,
  ReviewSettlementObservation,
} from "../src/lib/review-capacity.js";

// 2026-10-06 — ONE SLOW REVIEW, OR A NOISY NEIGHBOUR, COLLAPSED REVIEW WIDTH.
//
// MEASURED on the Azure host (base 4, max 5, min 1), `review.capacity` rows:
//   21:34:56 review-latency-expanded  width 3  baseline 92 s  recent 211 s    cpu full 2.18  mem 0
//   21:43:43 review-latency-expanded  width 2  baseline 90 s  recent 226 s    cpu full 0.31  mem 11.84
//   22:00:29 review-latency-expanded  width 1  baseline 223 s recent 1,276 s  cpu full 0     mem 0
//   22:09:25 healthy-window           width 1  queue 9, healthy_samples 1     cpu full 3.72  mem 0
// Three defects of one shape: the latency statistic was a median of as few as TWO samples (so one
// 21-minute review WAS the recent value), its baseline was the other half of the same 30-minute
// window (so it drifted 92 -> 223 s in 26 min), and recovery was one lane per multi-sample healthy
// window. Host load was ~33 on 8 cores from an operator coverage run, so SOME shedding was right —
// but cpu `full` PSI never left the calm band, and width sat at 1 for 30+ minutes after it.

/** The production rows in plan/policy.yaml `sweep.reviewCapacity` on 2026-10-06. */
const POLICY: ReviewCapacityPolicy = {
  hostWorkerBudget: 8,
  workerMemoryReserveMib: 1536,
  healthyWindowSamples: 3,
  sampleCadenceMs: 60_000,
  telemetryCadenceMs: 300_000,
  cpuPsiLowPct: 5,
  cpuPsiHighPct: 20,
  memoryPsiLowPct: 5,
  memoryPsiHighPct: 15,
  providerAllowancePct: 2,
  settlementWindowMs: 1_800_000,
  unhealthySettlementThreshold: 2,
  minHealthySettlements: 1,
  latencyExpansionRatio: 2,
};
const BOUNDS = { baseWidth: 4, minWidth: 1, maxWidth: 5 };
const T0 = Date.parse("2026-10-06T12:00:00Z");
const MIN = 60_000;

function observation(nowMs: number, over: Partial<ReviewCapacityObservation> = {}): ReviewCapacityObservation {
  return {
    nowMs,
    queueDepth: 9,
    activeWorkers: 0,
    memAvailableMib: 6_500,
    cpuPsiSomeAvg10Pct: 1,
    cpuPsiFullAvg10Pct: 0.5,
    memoryPsiSomeAvg10Pct: 0,
    provider: { fresh: true, readable: true, headroomPct: 40, reservePct: 5, ageMs: 100_000 },
    settlements: { successes: 5, failures: 0, timeouts: 0 },
    ...over,
  };
}

function decide(state: ReviewCapacityState, obs: ReviewCapacityObservation) {
  return capacity.selectAdaptiveReviewWidth(state, POLICY, obs, BOUNDS);
}

/** Completed reviews ending at the given minute offsets (from T0) with the given wall times. */
function reviews(
  spec: ReadonlyArray<[endMin: number, seconds: number, proofs?: number]>,
): Array<Record<string, unknown>> {
  const lines: Array<Record<string, unknown>> = [];
  spec.forEach(([endMin, seconds, proofs], i) => {
    const end = T0 + endMin * MIN;
    const sha = `sha${i}`;
    lines.push({ step: "sweep.post_review.attempt", pr_number: 100 + i, head_sha: sha, ts: new Date(end - seconds * 1000).toISOString() });
    if (proofs !== undefined) {
      const proofExec = Array.from({ length: proofs }, () => "executed_pass");
      lines.push({ step: "review.posted", head_sha: sha, proof_exec: proofExec, ts: new Date(end - 1).toISOString() });
    }
    lines.push({ step: "sweep.post_review.done", pr_number: 100 + i, head_sha: sha, ts: new Date(end).toISOString() });
  });
  return lines;
}

function settle(lines: ReadonlyArray<Record<string, unknown>>, nowMs: number): ReviewSettlementObservation {
  return capacity.summarizeReviewSettlements(lines, nowMs, POLICY.settlementWindowMs);
}

const BASE: ReviewCapacityState = { effectiveWidth: 4, healthySamples: 0 };
/** Memory PSI inside the hysteresis band: above the 5 % low watermark, below the 15 % shed. */
const BAND = { memoryPsiSomeAvg10Pct: 8 };

test("a single 21-minute review among normal reviews does not shed review width below base", () => {
  // The 22:00:29 shape: ~4-minute reviews, one of 1,276 s. The old fold split the in-window
  // latencies in half and took each half's median — with four samples, the mean of two.
  const nowMs = T0 + 240 * MIN;
  const lines = reviews([
    [80, 180], [110, 220], [140, 260], [170, 240], // the long baseline window
    [215, 200], [220, 246], [228, 300], [236, 1276], // the 30-minute settlement window
  ]);
  const settlements = settle(lines, nowMs);
  // PSI deliberately in the band, so the latency verdict alone decides: corroboration is not
  // what keeps this at base.
  const { decision } = decide(BASE, observation(nowMs, { ...BAND, settlements }));
  assert.ok(
    decision.effectiveWidth >= BOUNDS.baseWidth,
    `one slow review must not shed (width ${decision.effectiveWidth}, reason ${decision.reason}, ` +
      `ratio ${decision.evidence.reviewLatencyRatio})`,
  );
  assert.equal(decision.evidence.reviewRecentLatencyMaxMs, 1_276_000, "the outlier is still ledgered");
});

test("sustained review latency sheds proportionally and holds instead of ratcheting to the floor", () => {
  const nowMs = T0 + 240 * MIN;
  const lines = reviews([
    [60, 100], [90, 100], [120, 100], [150, 100], [180, 100],
    [212, 300], [218, 300], [224, 300], [230, 300], [236, 300],
  ]);
  const obs = observation(nowMs, { ...BAND, settlements: settle(lines, nowMs) });
  const first = decide(BASE, obs);
  // ratio 3 against an expansion ratio of 2: base 4 * 2 / 3 = 2.67 -> 2 lanes.
  assert.equal(first.decision.reason, "review-latency-expanded");
  assert.equal(first.decision.effectiveWidth, 2, "a 3x sustained expansion sheds to two lanes in one sample");
  const second = decide(first.state, { ...obs, nowMs: nowMs + 10 * MIN });
  assert.equal(second.decision.effectiveWidth, 2, "the same expansion holds there; it does not step to 1");
});

test("sustained review latency that review size explains does not shed", () => {
  const nowMs = T0 + 240 * MIN;
  // Recent reviews run 3x longer, and execute 5 proofs each against the baseline's 1: the same
  // 50 s per size unit (1 + executed proofs).
  const sized = reviews([
    [60, 100, 1], [90, 100, 1], [120, 100, 1], [150, 100, 1],
    [218, 300, 5], [224, 300, 5], [230, 300, 5],
  ]);
  const excused = decide(BASE, observation(nowMs, { ...BAND, settlements: settle(sized, nowMs) }));
  assert.equal(excused.decision.effectiveWidth, BOUNDS.baseWidth);
  assert.equal(excused.decision.evidence.reviewRecentLatencyPerUnitMs, 50_000);
  // Control: the same wall times with no size on record DO shed, so the size is what excused it.
  const unsized = reviews([[60, 100], [90, 100], [120, 100], [150, 100], [218, 300], [224, 300], [230, 300]]);
  const shed = decide(BASE, observation(nowMs, { ...BAND, settlements: settle(unsized, nowMs) }));
  assert.ok(shed.decision.effectiveWidth < BOUNDS.baseWidth, "unsized, the same slowdown sheds");
});

test("after pressure clears width returns to base within one capacity evaluation", () => {
  const floored: ReviewCapacityState = { effectiveWidth: 1, healthySamples: 0 };
  const { decision, state } = decide(floored, observation(T0));
  assert.equal(decision.effectiveWidth, BOUNDS.baseWidth, "calm PSI restores base in one sample");
  assert.equal(state.healthySamples, 1, "the lane ABOVE base is still earned by the sustained window");
  // Restoration never spends host-worker budget the fleet is already using: 6 of 8 leave room for 2.
  const crowded = decide(floored, observation(T0, { activeWorkers: 6 }));
  assert.equal(crowded.decision.effectiveWidth, 2);
  // Hysteresis: PSI in the band between its low and high watermarks holds a shed width.
  const band = decide(floored, observation(T0, BAND));
  assert.equal(band.decision.effectiveWidth, 1, "the band neither sheds further nor recovers");
});

test("memory and CPU PSI pressure still shed review width below base", () => {
  const cases: Array<[Partial<ReviewCapacityObservation>, string]> = [
    [{ cpuPsiFullAvg10Pct: 25 }, "cpu-pressure"],
    [{ memoryPsiSomeAvg10Pct: 25.24 }, "memory-pressure"], // measured 21:01:52 on 2026-10-06
    [{ memAvailableMib: 1000 }, "memory-reserve"],
    [{ settlements: { successes: 0, failures: 2, timeouts: 0 } }, "review-unhealthy"],
  ];
  for (const [over, reason] of cases) {
    const { decision } = decide(BASE, observation(T0, over));
    assert.equal(decision.reason, reason);
    assert.equal(decision.effectiveWidth, BOUNDS.baseWidth - 1, `${reason} sheds a lane`);
  }
});

// The Azure rows above, each observation exactly as its `review.capacity` row recorded it
// (including the OLD fold's baseline/recent latency), fed through the controller in order.
const RECORDED: Array<[string, Partial<ReviewCapacityObservation>]> = [
  ["21:34:56.671", { queueDepth: 6, activeWorkers: 0, memAvailableMib: 7193.8, cpuPsiFullAvg10Pct: 2.18, memoryPsiSomeAvg10Pct: 0, settlements: { successes: 9, failures: 0, timeouts: 0, baselineLatencyMs: 92230, recentLatencyMs: 210989.5 } }],
  ["21:43:43.932", { queueDepth: 7, activeWorkers: 7, memAvailableMib: 5516.9, cpuPsiFullAvg10Pct: 0.31, memoryPsiSomeAvg10Pct: 11.84, settlements: { successes: 9, failures: 0, timeouts: 0, baselineLatencyMs: 90393, recentLatencyMs: 226151 } }],
  ["22:00:29.168", { queueDepth: 7, activeWorkers: 1, memAvailableMib: 6761.0, cpuPsiFullAvg10Pct: 0, memoryPsiSomeAvg10Pct: 0, settlements: { successes: 9, failures: 0, timeouts: 0, baselineLatencyMs: 222646, recentLatencyMs: 1276184 } }],
  ["22:09:25.128", { queueDepth: 9, activeWorkers: 0, memAvailableMib: 6373.7, cpuPsiFullAvg10Pct: 3.72, memoryPsiSomeAvg10Pct: 0, settlements: { successes: 7, failures: 0, timeouts: 0 } }],
];
/** The state the 21:29:36 row left: width 4, one healthy sample. */
const PRIOR_2129: ReviewCapacityState = {
  effectiveWidth: 4,
  healthySamples: 1,
  lastHealthySampleAtMs: Date.parse("2026-10-06T21:29:36.000Z"),
};

test("a replay of the Azure 21:34-22:09 sequence returns review width to base by 22:09", () => {
  let state = PRIOR_2129;
  const widths: Record<string, number> = {};
  for (const [clock, over] of RECORDED) {
    const nowMs = Date.parse(`2026-10-06T${clock}Z`);
    const result = decide(state, observation(nowMs, over));
    widths[clock.slice(0, 5)] = result.decision.effectiveWidth;
    state = result.state;
  }
  // Before this change the same rows replay as 3, 2, 1, 1.
  assert.ok(widths["22:09"]! >= BOUNDS.baseWidth, `widths ${JSON.stringify(widths)}`);
  assert.ok(widths["22:00"]! >= BOUNDS.baseWidth, `calm PSI at 22:00 restores base: ${JSON.stringify(widths)}`);
  assert.equal(widths["21:34"], 4, "cpu full 2.18 and memory 0 do not corroborate the latency shed");
  assert.equal(widths["21:43"], 3, "memory PSI 11.84 does corroborate it: some shedding was right");
});

// The same window end to end: the real `sweep.post_review` rows the host ledgered from 18:55 to
// 22:27 (head shas shortened), folded by the new statistic. Note 21:37-22:00: THREE reviews
// (9700, 9701, 9702) ran ~21-23 minutes under the operator's coverage run.
const HOST_ROWS: ReadonlyArray<[kind: "A" | "D", clock: string, pr: number, sha: string]> = [
  ["D", "19:06:21.670", 9579, "9972f7a"],
  ["D", "19:09:03.885", 9631, "dfa1b6a"],
  ["D", "19:12:22.029", 9616, "6c06e79"],
  ["D", "19:30:58.997", 9671, "6beb04c"],
  ["D", "19:31:06.675", 9635, "201d09d"],
  ["D", "19:32:15.750", 9645, "59203d9"],
  ["D", "19:43:29.021", 9635, "d695358"],
  ["D", "19:44:03.866", 9678, "d3d802a"],
  ["D", "19:46:09.464", 9648, "ee09ddb"],
  ["D", "19:50:03.191", 9653, "c88cb74"],
  ["D", "19:50:16.984", 9641, "62f3abf"],
  ["D", "19:51:56.826", 9659, "eb6693b"],
  ["D", "19:58:52.510", 9662, "7a9cf74"],
  ["D", "20:18:10.403", 9664, "2e6c81f"],
  ["D", "20:19:18.386", 9667, "e4aa9ea"],
  ["D", "20:20:12.854", 9668, "0999278"],
  ["D", "20:21:04.769", 9669, "3ede6d7"],
  ["D", "20:21:40.983", 9667, "3713ddb"],
  ["A", "20:28:59.988", 9676, "a86a43c"],
  ["D", "20:29:31.658", 9675, "2506f20"],
  ["A", "20:35:01.816", 9682, "3f2f285"],
  ["D", "20:35:37.787", 9676, "a86a43c"],
  ["D", "20:35:53.176", 9674, "d26f0bf"],
  ["A", "20:37:09.887", 9689, "eceff1a"],
  ["A", "20:37:11.007", 9687, "61cbfd7"],
  ["D", "20:38:18.793", 9689, "eceff1a"],
  ["D", "20:39:49.541", 9682, "3f2f285"],
  ["D", "20:43:55.339", 9687, "61cbfd7"],
  ["A", "20:45:48.797", 9649, "e6b9d26"],
  ["A", "20:46:44.439", 9690, "8333c00"],
  ["D", "20:47:19.824", 9690, "8333c00"],
  ["A", "20:49:36.100", 9666, "d68db00"],
  ["D", "20:50:27.256", 9649, "e6b9d26"],
  ["D", "20:54:23.507", 9666, "d68db00"],
  ["A", "20:59:52.188", 9693, "0e1de07"],
  ["A", "21:03:23.902", 9649, "ba3c489"],
  ["D", "21:04:13.478", 9693, "0e1de07"],
  ["A", "21:06:02.493", 9694, "dea6379"],
  ["D", "21:07:00.076", 9694, "dea6379"],
  ["D", "21:07:39.104", 9649, "ba3c489"],
  ["A", "21:17:40.740", 9695, "1db46bb"],
  ["D", "21:19:47.617", 9695, "1db46bb"],
  ["A", "21:27:20.768", 9699, "b658931"],
  ["A", "21:27:20.833", 9698, "5aedc70"],
  ["A", "21:27:20.916", 9696, "a442106"],
  ["A", "21:27:21.057", 9657, "78a8dbe"],
  ["D", "21:28:14.966", 9657, "78a8dbe"],
  ["A", "21:29:40.455", 9697, "9d125ee"],
  ["D", "21:30:23.544", 9698, "5aedc70"],
  ["A", "21:30:28.480", 9698, "5aedc70"],
  ["D", "21:30:40.666", 9698, "5aedc70"],
  ["D", "21:31:46.061", 9696, "a442106"],
  ["D", "21:31:57.644", 9699, "b658931"],
  ["D", "21:32:17.289", 9697, "9d125ee"],
  ["A", "21:37:21.925", 9707, "0607656"],
  ["A", "21:37:21.926", 9706, "27e6e17"],
  ["A", "21:37:27.336", 9702, "eaf9925"],
  ["A", "21:37:27.428", 9701, "cd2b619"],
  ["A", "21:37:27.548", 9700, "8d23b9f"],
  ["D", "21:41:01.067", 9706, "27e6e17"],
  ["D", "21:41:08.076", 9707, "0607656"],
  ["A", "21:43:47.687", 9709, "3e815f7"],
  ["D", "21:44:40.729", 9709, "3e815f7"],
  ["D", "21:58:43.520", 9702, "eaf9925"],
  ["D", "21:58:56.973", 9700, "8d23b9f"],
  ["A", "22:00:31.815", 9711, "9a5c723"],
  ["D", "22:00:40.108", 9701, "cd2b619"],
  ["D", "22:02:15.231", 9711, "9a5c723"],
  ["A", "22:09:49.592", 9657, "c10128f"],
  ["D", "22:12:21.369", 9657, "c10128f"],
  ["A", "22:14:25.301", 9701, "efe9f7a"],
  ["A", "22:19:41.287", 9703, "b344c4d"],
  ["A", "22:22:54.115", 9704, "639a90c"],
  ["D", "22:22:55.847", 9701, "efe9f7a"],
  ["D", "22:24:42.988", 9703, "b344c4d"],
];

function hostLines(): Array<Record<string, unknown>> {
  const step = { A: "sweep.post_review.attempt", D: "sweep.post_review.done" } as const;
  return HOST_ROWS.map(([kind, clock, pr, sha]) => ({
    step: step[kind],
    pr_number: pr,
    head_sha: sha,
    ts: `2026-10-06T${clock}Z`,
  }));
}

test("the host's own 2026-10-06 review rows replay at base width from 21:34 through 22:27", () => {
  const lines = hostLines();
  const timeline: Array<[string, Partial<ReviewCapacityObservation>]> = [
    ...RECORDED,
    ["22:27:18.312", { queueDepth: 7, activeWorkers: 0, memAvailableMib: 5111.2, cpuPsiFullAvg10Pct: 1.22, memoryPsiSomeAvg10Pct: 0.28 }],
  ];
  let state = PRIOR_2129;
  const rows: Array<{ at: string; width: number; reason: string; ratio?: number; source?: string }> = [];
  for (const [clock, over] of timeline) {
    const nowMs = Date.parse(`2026-10-06T${clock}Z`);
    const settlements = settle(lines, nowMs);
    const result = decide(state, observation(nowMs, { ...over, settlements, hostLoad1: 33, hostCpuCount: 8 }));
    state = result.state;
    rows.push({
      at: clock.slice(0, 5),
      width: result.decision.effectiveWidth,
      reason: result.decision.reason,
      ...(result.decision.evidence.reviewLatencyRatio !== undefined ? { ratio: result.decision.evidence.reviewLatencyRatio } : {}),
      ...(result.decision.evidence.pressureSource ? { source: result.decision.evidence.pressureSource } : {}),
    });
  }
  const by = Object.fromEntries(rows.map((row) => [row.at, row]));
  const shown = JSON.stringify(rows);
  // The robust fold sees no expansion while the three long reviews are a minority of the recent
  // five; once they are the majority (22:09) PSI is calm, so it holds base rather than shedding.
  assert.ok(by["22:00"]!.ratio! < POLICY.latencyExpansionRatio, shown);
  assert.equal(by["22:09"]!.reason, "review-latency-uncorroborated", shown);
  for (const at of ["21:34", "22:00", "22:09", "22:27"]) assert.equal(by[at]!.width, BOUNDS.baseWidth, `${at}: ${shown}`);
  // 21:43 had 7 fleet workers: the host worker budget sheds, and the row names whose load it was.
  assert.equal(by["21:43"]!.reason, "host-worker-budget", shown);
  assert.equal(by["21:43"]!.source, "host-load", "load 33 on 8 cores is more than 7 fleet workers explain");
});

test("a pressure decision names the class of load it is attributed to", () => {
  assert.equal(capacity.reviewPressureSource({ activeWorkers: 8, hostLoad1: 9, hostCpuCount: 8 }, 8), "fleet-budget");
  assert.equal(capacity.reviewPressureSource({ activeWorkers: 7, hostLoad1: 33, hostCpuCount: 8 }, 8), "host-load");
  assert.equal(capacity.reviewPressureSource({ activeWorkers: 4, hostLoad1: 10, hostCpuCount: 8 }, 8), "fleet-load");
  assert.equal(capacity.reviewPressureSource({ activeWorkers: 1 }, 8), "unknown");
  const shed = decide(BASE, observation(T0, { cpuPsiFullAvg10Pct: 25, activeWorkers: 1, hostLoad1: 33, hostCpuCount: 8 }));
  assert.equal(shed.decision.evidence.pressureSource, "host-load", "the host is still shed whoever loads it");
  assert.equal(shed.decision.effectiveWidth, 3);
  const calm = decide(BASE, observation(T0, { hostLoad1: 33, hostCpuCount: 8 }));
  assert.equal(calm.decision.evidence.pressureSource, undefined, "no pressure decision, no attribution");
});
