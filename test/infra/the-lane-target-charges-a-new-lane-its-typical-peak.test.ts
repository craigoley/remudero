// THE LANE TARGET CHARGES A NEW LANE ITS TYPICAL PEAK, AND ONLY ONE TAIL. The shadow budget (host-memory-shadow.ts)
// counts every tree's typical growth and allows ONE tail above it; the lane governor charged every new lane the whole
// p90 estimate instead, so it held the Azure host to one build lane while the shadow budget itself would admit more.
//
// OBSERVED 2026-11-19 00:32Z, Azure core daemon, `dispatch.lane_target`: target 1, binding container, projection_mib
// 18737, onset_mib 23585, host_base_available_mib 11377, host_reserve_mib 2048, per_lane_mib 5043, in_flight 0.
// The same minute's `memory_budget.shadow`: implement typical 1767 MiB, container tail ~3276 MiB already reserved.

import assert from "node:assert/strict";
import { test } from "node:test";

import { laneTarget, laneTargetPayload, readLaneMemory, type LaneMemoryReading } from "#src/lib/lane-governor.js";

const CONTAINER_BASE = 18_737 - 5_043; // the row's projection at target 1 from 0 in flight, less one lane
const LIVE: LaneMemoryReading = {
  containerBaseMib: CONTAINER_BASE, containerOnsetMib: 23_585, containerArmCounts: true, containerBasis: "memory.high",
  hostBaseAvailableMib: 11_377, hostReserveMib: 2048, perLaneMib: 5043, containerPressed: false, highEvents: 0,
};

test("a new lane is charged its typical peak with one tail shared against the reserved tail", () => {
  // Without a typical reading the old charge holds: every new lane at the whole estimate, so the 2026-11-19 row's 1.
  const whole = laneTarget({ inFlight: 0, cpuCount: 8, memory: LIVE });
  assert.deepEqual([whole.target, whole.binding], [1, "container"]);

  // With the class median and the tail the base already reserves, room 9891 MiB fits five typical lanes.
  const shared = laneTarget({
    inFlight: 0, cpuCount: 8,
    memory: { ...LIVE, perLaneTypicalMib: 1767, containerTailMib: 3276, hostTailMib: 3276 },
  });
  assert.deepEqual([shared.target, shared.binding], [5, "container"]);
  assert.equal(shared.projectionMib, CONTAINER_BASE + 5 * 1767);
  assert.ok(shared.projectionMib! <= LIVE.containerOnsetMib!, "the projection at the target stays under memory.high");
  assert.equal(laneTargetPayload(shared, { mode: "enforce", fixed: 3, inFlight: 0 }).per_lane_typical_mib, 1767);
});

test("a new lane's tail above the reserved one is charged once, not per lane", () => {
  // Nothing reserved yet: k lanes cost k x 1767 plus one 3276 tail. Room 9891: (9891 - 3276) / 1767 = 3.7, so 3.
  const r = laneTarget({
    inFlight: 0, cpuCount: 8,
    memory: { ...LIVE, hostBaseAvailableMib: 50_000, perLaneTypicalMib: 1767, containerTailMib: 0, hostTailMib: 0 },
  });
  assert.deepEqual([r.target, r.binding], [3, "container"]);
  assert.equal(r.projectionMib, CONTAINER_BASE + 3 * 1767 + (5043 - 1767));
});

test("room for one typical lane but not its unreserved tail admits no new lane", () => {
  const r = laneTarget({
    inFlight: 2, cpuCount: 8,
    memory: {
      ...LIVE, containerBaseMib: 23_585 - 3000, perLaneTypicalMib: 1767, containerTailMib: 0, hostTailMib: 3276,
    },
  });
  // 3000 MiB of room is over one typical 1767 but under 1767 + the 3276 tail: the target stays at the lanes in flight.
  assert.deepEqual([r.target, r.binding], [2, "container"]);
});

test("a typical above the estimate is clamped to it, never charging less than nothing", () => {
  const r = laneTarget({ inFlight: 0, cpuCount: 8, memory: { ...LIVE, perLaneTypicalMib: 9000, containerTailMib: 0, hostTailMib: 0 } });
  assert.deepEqual([r.target, r.binding, r.perLaneTypicalMib], [1, "container", 5043]);
});

test("readLaneMemory carries the class typical and both reserved tails from the shadow budget", () => {
  const unreadable = (): never => { throw new Error("unreadable in this fixture"); };
  const reading = readLaneMemory("/nonexistent-lane-typical-root", {
    estimate: () => 5043, typical: () => 1767, readFile: unreadable, listStateDir: () => [],
  });
  assert.equal(reading.perLaneMib, 5043);
  assert.equal(reading.perLaneTypicalMib, 1767);
  assert.equal(typeof reading.containerTailMib, "number");
  assert.equal(typeof reading.hostTailMib, "number");

  const noTypical = readLaneMemory("/nonexistent-lane-typical-root", {
    estimate: () => 5043, typical: unreadable, readFile: unreadable, listStateDir: () => [],
  });
  assert.equal(noTypical.perLaneTypicalMib, undefined, "an unreadable median charges the whole estimate");
});

// OBSERVED 2026-11-19 04:07Z-04:24Z, Azure core daemon after this file's fix: the target grew one lane a reading to 6
// over a fixed pool of 3, so a pressure shed (the previous target less one) would have read 5, 4, 3 before it held a
// single admission back.
test("the lane target never grows past the lane pool, so a pressure shed bites on its first reading", () => {
  const roomy = { ...LIVE, containerBaseMib: 2000, hostBaseAvailableMib: 50_000, perLaneTypicalMib: 816, containerTailMib: 4275, hostTailMib: 4275 };
  let previous = laneTarget({ inFlight: 2, cpuCount: 8, maxLanes: 3, memory: roomy }).next;
  for (let tick = 0; tick < 5; tick++) previous = laneTarget({ previous, inFlight: 2, cpuCount: 8, maxLanes: 3, memory: roomy }).next;
  const capped = laneTarget({ previous, inFlight: 2, cpuCount: 8, maxLanes: 3, memory: roomy });
  assert.deepEqual([capped.target, capped.binding], [3, "fixed"]);

  const shed = laneTarget({ previous: capped.next, inFlight: 2, cpuCount: 8, maxLanes: 3, memory: { ...roomy, containerPressed: true } });
  assert.deepEqual([shed.target, shed.binding], [2, "pressure"], "the first pressed reading admits no new lane over the two running");
});
