/**
 * The dispatch memory floor reads the container's own headroom, not only the host's MemAvailable.
 *
 * The floor (`checkMemoryGovernor`, consulted through `memoryGovernorGateFor`) read only /proc/meminfo, on the stated
 * ground that "this fleet's containers carry no memory limit". That has been false since #10371 and #10486: core runs
 * under memory.max 8820 MiB with memory.high 8379 MiB. MEASURED 2026-10-10/11 across 395 core `memory_budget.shadow`
 * rows: host MemAvailable never fell below the 3072 MiB floor (p10 8518-10578 MiB), while the container's own headroom
 * to its ceiling did in 29 of them (p10 3055-3522 MiB). So the floor could not see the pool a new worker actually draws on.
 * Each case asserts a field only the container reading, its tiers, or the named ledger row produces.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";

import type { HostMemoryReading, ReadingEntry } from "../src/lib/host-memory-ledger.js";
import { ownContainerWorkLive, readContainerMemoryHeadroom } from "../src/lib/host-memory-shadow.js";
import { readLedgerLines } from "../src/lib/status.js";
import { DEFAULT_SWEEP_POLICY, checkMemoryGovernor, type SweepPolicy } from "../src/lib/sweep.js";
import { makeTempDir } from "../src/lib/tmp.js";
import { memoryGovernorGateFor } from "../src/run-task.js";

const MIB = 1024 * 1024;
const POLICY: SweepPolicy = { ...DEFAULT_SWEEP_POLICY, memoryFloorMib: 3072 };
/** Core at 04:53:07Z on 2026-10-11: memory.high 8379 MiB, a 5216 MiB working set; the host had 10748 MiB available. */
const CORE = { headroomMib: 8379 - 5216, ceilingMib: 8379, workingSetMib: 5216 };
const TIGHT = { headroomMib: 2500, ceilingMib: 8379, workingSetMib: 5879 };

test("the floor defers on the container's own headroom when the host figure alone would admit", () => {
  let asked = 0;
  const live = () => { asked += 1; return true; };
  const held = checkMemoryGovernor(10_748, POLICY, TIGHT, live);
  assert.equal(held.deferred, true, "2500 MiB under the container's ceiling is below the 3072 MiB floor");
  assert.equal(held.observedAvailableMib, 2500, "the smaller pool is the observation");
  assert.equal(held.hostAvailableMib, 10_748);
  assert.equal(held.binding, "container");
  assert.equal(held.tier, "container-short");
  assert.equal(asked, 1, "live work is asked about only when the container is short");

  const fits = checkMemoryGovernor(10_748, POLICY, CORE, live);
  assert.deepEqual([fits.deferred, fits.tier, fits.binding, fits.observedAvailableMib], [false, "fits", "container", 3163]);
  assert.equal(asked, 1, "a container that fits never asks");

  const host = checkMemoryGovernor(2000, POLICY, CORE, live);
  assert.deepEqual([host.deferred, host.tier, host.binding], [true, "host-short", "host"]);
});

test("a short container with no live work to wait for admits and names it, never wedging dispatch", () => {
  const verdict = checkMemoryGovernor(10_748, POLICY, TIGHT, () => false);
  assert.equal(verdict.deferred, false, "nothing running here can free memory: waiting cannot help");
  assert.equal(verdict.tier, "nothing-to-wait-for");
  assert.equal(verdict.binding, "container");

  const unbounded = checkMemoryGovernor(10_748, POLICY, { unbounded: true }, () => true);
  assert.deepEqual([unbounded.deferred, unbounded.tier, unbounded.binding, unbounded.observedAvailableMib], [false, "fits", "host", 10_748]);
  const unread = checkMemoryGovernor(2000, POLICY, { unread: "memory.current:ENOENT" }, () => true);
  assert.deepEqual([unread.deferred, unread.tier, unread.binding], [true, "host-short", "host"], "the host arm still decides alone");
});

test("the container headroom is min(memory.high, memory.max) less memory.current less inactive_file", () => {
  const files = (over: Record<string, string> = {}) => {
    const table: Record<string, string> = {
      "/sys/fs/cgroup/memory.current": `${6000 * MIB}\n`,
      "/sys/fs/cgroup/memory.max": `${8820 * MIB}\n`,
      "/sys/fs/cgroup/memory.high": `${8379 * MIB}\n`,
      "/sys/fs/cgroup/memory.stat": `anon ${4000 * MIB}\nfile ${1800 * MIB}\ninactive_file ${784 * MIB}\n`,
      ...over,
    };
    return (path: string): string => {
      const text = table[path];
      if (text === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
      return text;
    };
  };
  assert.deepEqual(readContainerMemoryHeadroom(files()), { headroomMib: 8379 - (6000 - 784), ceilingMib: 8379, workingSetMib: 5216 });
  assert.deepEqual(readContainerMemoryHeadroom(files({ "/sys/fs/cgroup/memory.high": "max\n" })),
    { headroomMib: 8820 - 5216, ceilingMib: 8820, workingSetMib: 5216 }, "no memory.high: memory.max is the ceiling");
  assert.deepEqual(readContainerMemoryHeadroom(files({ "/sys/fs/cgroup/memory.high": "max\n", "/sys/fs/cgroup/memory.max": "max\n" })),
    { unbounded: true });
  const gone = readContainerMemoryHeadroom(files({ "/sys/fs/cgroup/memory.current": undefined as unknown as string }));
  assert.ok("unread" in gone, `no memory.current is unread, never a headroom: ${JSON.stringify(gone)}`);
});

function reading(entries: Array<Partial<ReadingEntry>>): HostMemoryReading {
  const full = entries.map((e, i): ReadingEntry => ({
    id: `r${i}`, owner: "state2@c1", workerClass: "implement", estimateMib: 2048,
    estimateSource: { kind: "measured", samples: 30 }, status: "owned", ageMs: 1000, sinceVerifiedMs: 1000,
    walkComplete: true, path: `/ledger/r${i}.json`, ...e,
  }));
  return {
    state: "present", scope: "host", dir: "/ledger", entries: full,
    counts: { live: full.length, uncertain: 0, incompleteWalk: 0, localScope: 0, unreadable: 0 },
    reservedMib: full.reduce((sum, e) => sum + e.estimateMib, 0),
  };
}

test("live work is this container's own unreleased reservations, and an unreadable ledger shows none", () => {
  assert.equal(ownContainerWorkLive("/root", () => reading([{}])), true);
  assert.equal(ownContainerWorkLive("/root", () => reading([{ occupancyReleased: true }])), false, "a finished tree frees nothing more");
  assert.equal(ownContainerWorkLive("/root", () => reading([{ status: "owner-verified", owner: "state3@c9" }])), false,
    "another container's work cannot free this container's memory");
  assert.equal(ownContainerWorkLive("/root", () => { throw new Error("EIO"); }), false);
  assert.equal(ownContainerWorkLive("/root", () => undefined), false);
});

test("the floor's ledger row names the container headroom, the binding pool and the tier", () => {
  const dir = makeTempDir("memory-floor");
  const path = join(dir, "ledger.ndjson");
  const gate = memoryGovernorGateFor(path, "RUN-C", POLICY, () => 10_748, () => TIGHT, () => true);
  const held = gate();
  assert.equal(held?.deferred, true);
  const row = readLedgerLines(path).find((l) => l.step === "dispatch_memory_observed")!;
  assert.equal(row.observed_available_mib, 2500);
  assert.equal(row.host_available_mib, 10_748);
  assert.equal(row.container_headroom_mib, 2500);
  assert.equal(row.container_ceiling_mib, 8379);
  assert.equal(row.container_working_set_mib, 5879);
  assert.equal(row.binding, "container");
  assert.equal(row.tier, "container-short");

  const unbounded = join(dir, "unbounded.ndjson");
  memoryGovernorGateFor(unbounded, "RUN-U", POLICY, () => 10_748, () => ({ unbounded: true }))();
  assert.equal(readLedgerLines(unbounded)[0]!.container_headroom, "unbounded");

  // A host reading injected alone (every older fixture) reads no container: the row is the old row, byte for byte.
  const plain = join(dir, "plain.ndjson");
  assert.equal(memoryGovernorGateFor(plain, "RUN-P", POLICY, () => 10_748)(), undefined);
  assert.deepEqual(Object.keys(readLedgerLines(plain)[0]!).filter((k) => /container|binding|tier|host_/.test(k)), []);
});
