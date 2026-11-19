// THE LANE TARGET ROW SAYS WHAT ITS PROJECTION IS MADE OF. On 2026-11-19 00:32Z the Azure core daemon's
// `dispatch.lane_target` read target 1, binding container, projection_mib 18737 — and nothing else about the container.
// Explaining that binding took a separate host read of memory.stat and the shadow budget row. The row now carries the
// container basis and the base split: working set (memory.current less inactive_file), the in-flight trees' claim and
// the daemon's typical growth.

import assert from "node:assert/strict";
import { test } from "node:test";

import { laneTarget, laneTargetPayload, readLaneMemory, type LaneMemoryReading } from "#src/lib/lane-governor.js";

const READING: LaneMemoryReading = {
  containerBaseMib: 13_694, containerOnsetMib: 23_585, containerArmCounts: true, containerBasis: "memory.high",
  hostBaseAvailableMib: 11_377, hostReserveMib: 2048, perLaneMib: 5043, containerPressed: false, highEvents: 0,
  containerParts: { currentMib: 15_454, reclaimableMib: 3466.4, workingSetMib: 11_987.6, claimMib: 1294.6, daemonTypicalMib: 411.8 },
};

test("the lane target row names the container basis and splits its base", () => {
  const row = laneTargetPayload(laneTarget({ inFlight: 0, cpuCount: 8, memory: READING }), { mode: "enforce", fixed: 3, inFlight: 0 });
  assert.equal(row.container_basis, "memory.high");
  assert.deepEqual(
    [row.container_current_mib, row.container_reclaimable_mib, row.container_working_set_mib, row.container_claim_mib, row.container_daemon_typical_mib],
    [15_454, 3466, 11_988, 1295, 412],
  );
});

test("an unread reading writes no container split", () => {
  const row = laneTargetPayload(laneTarget({ inFlight: 0, cpuCount: 8, memory: { unread: "no cgroup" } }), { mode: "enforce", fixed: 3, inFlight: 0 });
  assert.equal("container_basis" in row, false);
  assert.equal("container_working_set_mib" in row, false);
});

test("readLaneMemory splits the base into parts that sum to it", () => {
  const files: Record<string, string> = {
    "/sys/fs/cgroup/memory.current": String(15_000 * 1024 * 1024),
    "/sys/fs/cgroup/memory.max": String(24_000 * 1024 * 1024),
    "/sys/fs/cgroup/memory.high": String(23_000 * 1024 * 1024),
    "/sys/fs/cgroup/memory.stat": `anon 1\ninactive_file ${3000 * 1024 * 1024}\n`,
  };
  const readFile = (path: string): string => {
    const hit = files[path];
    if (hit === undefined) throw new Error(`absent in this fixture: ${path}`);
    return hit;
  };
  const reading = readLaneMemory("/nonexistent-lane-parts-root", { readFile, listStateDir: () => [] });
  const parts = reading.containerParts;
  assert.ok(parts, `a read container yields its split (basis: ${reading.containerBasis})`);
  assert.equal(parts.currentMib, 15_000);
  assert.equal(parts.reclaimableMib, 3000);
  assert.equal(parts.workingSetMib, 12_000);
  assert.ok(Math.abs(parts.workingSetMib + parts.claimMib + parts.daemonTypicalMib - reading.containerBaseMib!) < 1e-6);

  const unreadContainer = readLaneMemory("/nonexistent-lane-parts-root", {
    readFile: () => { throw new Error("no cgroup in this fixture"); }, listStateDir: () => [],
  });
  assert.equal(unreadContainer.containerParts, undefined);
});
