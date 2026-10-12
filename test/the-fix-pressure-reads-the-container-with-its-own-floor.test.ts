/**
 * The measured WIP bound and the fix admission read the CONTAINER as well as the host, with a container-sized floor.
 *
 * `readFixHostPressure` read only /proc/meminfo, so neither could see the pool a new worker draws on once core ran
 * under memory.high 8379 MiB (#10371/#10486). The dispatch floor learned that in #10860; this is the same reading for
 * the queue governor's bound and the fix admission controller. MEASURED over 452 core memory_budget.shadow rows
 * (2026-10-11 04:48Z-14:35Z): container headroom p10 3191, median 4674 MiB. Against the host's 3072 MiB floor and a
 * 2048 MiB worker, 72% of those readings bound to zero workers; against the floor scaled to the container
 * (3072 x 8379 / 15988 = 1610 MiB), 19%. A short container holds only while its own live work can free memory.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { ContainerMemoryHeadroom } from "../src/lib/host-memory-shadow.js";
import {
  DEFAULT_SWEEP_POLICY,
  checkQueueGovernor,
  createSweepFixAdmissionController,
  pressureWorkers,
  readFixHostPressure,
  type SweepPolicy,
} from "../src/lib/sweep.js";

const FLOOR = 3072;
// The core host: MemTotal 15988 MiB, MemAvailable 9765 MiB.
const MEMINFO = `MemTotal:       ${15_988 * 1024} kB\nMemFree:          100000 kB\nMemAvailable:   ${9_765 * 1024} kB\n`;
const read = (path: string): string => {
  if (path === "/proc/meminfo") return MEMINFO;
  throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
};
const headroom = (mib: number): ContainerMemoryHeadroom => ({ headroomMib: mib, ceilingMib: 8379, workingSetMib: 8379 - mib });
const container = (reading: ContainerMemoryHeadroom, live = true) => ({ read: () => reading, ownWorkLive: () => live });
const POLICY: SweepPolicy = { ...DEFAULT_SWEEP_POLICY, memoryFloorMib: FLOOR };

test("the fix pressure binds on the container's headroom less a container-sized floor", () => {
  const host = readFixHostPressure(FLOOR, read);
  assert.deepEqual(host, { availableMib: 9765, floorMib: FLOOR }, "the host alone, as before, when no container is read");
  assert.equal(pressureWorkers(host, 2048), 3);

  const median = readFixHostPressure(FLOOR, read, container(headroom(4674)));
  assert.equal(median.binding, "container");
  assert.equal(median.containerFloorMib, Math.round(3072 * 8379 / 15_988), "the host floor scaled to the container: 1610");
  assert.equal(median.availableMib, 4674);
  assert.equal(median.floorMib, 1610);
  assert.equal(median.hostAvailableMib, 9765);
  assert.equal(median.tier, "fits");
  assert.equal(pressureWorkers(median, 2048), 1, "(4674 - 1610) / 2048: one worker, where the host floor gave none");

  const roomy = readFixHostPressure(FLOOR, read, container(headroom(8379)));
  assert.equal(roomy.binding, "host", "a container with more room than the host defers to the host");
  assert.equal(roomy.availableMib, 9765);
  assert.equal(pressureWorkers(roomy, 2048), 3);
});

test("a short container holds only while its own live work can free memory, and otherwise admits one", () => {
  const short = readFixHostPressure(FLOOR, read, container(headroom(3191)));
  assert.equal(short.tier, "container-short");
  assert.equal(pressureWorkers(short, 2048), 0);
  const held = checkQueueGovernor(0, POLICY, { pressure: short, trailingMergedCount: 3 });
  assert.equal(held.deferred, true, "live work in the container: waiting for it can free memory");
  assert.equal(held.measuredBound, 0);

  let asked = 0;
  const idle = readFixHostPressure(FLOOR, read, { read: () => headroom(3191), ownWorkLive: () => { asked++; return false; } });
  assert.equal(idle.tier, "nothing-to-wait-for");
  assert.equal(asked, 1);
  assert.equal(pressureWorkers(idle, 2048), 1, "nothing to wait for: one is admitted, never wedged");
  const admitted = checkQueueGovernor(0, POLICY, { pressure: idle, trailingMergedCount: 3 });
  assert.equal(admitted.deferred, false);
  assert.equal(admitted.measuredBound, 1);

  // The fix admission controller divides the same reading, and its capacity row names the binding pool and tier.
  const rows: Array<Record<string, unknown>> = [];
  const controller = createSweepFixAdmissionController({
    surface: "light", queueDepth: 2, hostWorkerBudget: 4, activeWorkers: 0, reviewReservations: 0,
    readActiveWorkers: () => 0, readPressure: () => idle, log: (_step, extra) => void rows.push(extra ?? {}),
  });
  assert.equal(controller.claim({} as never).admitted, true);
  assert.equal(controller.claim({} as never).admitted, false, "one, not more");
  assert.equal(rows[0]!.pressure_binding, "container");
  assert.equal(rows[0]!.pressure_tier, "nothing-to-wait-for");
  assert.equal(rows[0]!.pressure_host_available_mib, 9765);

  // A short HOST is the host's arm, unchanged: no tier admits past it, and the container's work is never asked.
  const hostShort = readFixHostPressure(FLOOR, (path) => path === "/proc/meminfo"
    ? `MemTotal: ${15_988 * 1024} kB\nMemAvailable: ${4000 * 1024} kB\n` : read(path),
  { read: () => headroom(6000), ownWorkLive: () => assert.fail("not asked for a short host") });
  assert.equal(hostShort.tier, "host-short");
  assert.equal(hostShort.binding, "host");
  assert.equal(pressureWorkers(hostShort, 2048), 0);
});

test("an unbounded or unread container, or no MemTotal, keeps the host reading and names the container", () => {
  const unbounded = readFixHostPressure(FLOOR, read, container({ unbounded: true }));
  assert.equal(unbounded.availableMib, 9765);
  assert.equal(unbounded.floorMib, FLOOR);
  assert.deepEqual(unbounded.container, { unbounded: true });
  assert.equal(unbounded.binding, "host");
  assert.equal(unbounded.tier, "fits");
  const unread = readFixHostPressure(FLOOR, read, container({ unread: "EACCES" }));
  assert.equal(unread.availableMib, 9765);
  assert.deepEqual(unread.container, { unread: "EACCES" });
  const noTotal = readFixHostPressure(FLOOR, () => `MemAvailable: ${9_765 * 1024} kB\n`, container(headroom(3191)));
  assert.equal(noTotal.binding, "host", "no MemTotal to size the container's floor by");
  const unreadable = readFixHostPressure(FLOOR, () => "nothing", container(headroom(3191)));
  assert.match(unreadable.reason ?? "", /^host pressure unreadable/);
  assert.equal(pressureWorkers(unreadable, 2048), 0, "an unreadable host still admits nothing, as before");
});
