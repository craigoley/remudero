// W1-T9358 — 2026-10-14 00:19-00:31Z, core: the WIP governor held all 3 empty lanes host-short three times
// (`dispatch_deferred_wip`, pressure_binding host, pressure_available_mib 3477, 4669 and 2678 against a 3072 MiB floor)
// and none of those rows carried a `reclaim_*` field, while W1-T8401's reclaim freed 0.18-2.24 GB each time it ran in
// the same hour. `reclaimBeforeHold` acted on container-short only. These tests pin the reclaim before a host-short
// hold (src/lib/sweep.ts `reclaimBeforeHold`), its one-per-reading rule, the memory governor's host arm, and the
// reclaimer pacing on the host's MemAvailable for a host reading (src/lib/daemon-memory-policy.ts).

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  DEFAULT_DAEMON_MEMORY_POLICY,
  createDaemonSlackReclaimer,
  type SlackReclaimRecord,
  type SlackSnapshot,
} from "../src/lib/daemon-memory-policy.js";
import type { ContainerMemoryHeadroom } from "../src/lib/host-memory-shadow.js";
import { readLedgerLines } from "../src/lib/status.js";
import {
  DEFAULT_SWEEP_POLICY,
  checkMemoryGovernor,
  checkQueueGovernor,
  createSweepFixAdmissionController,
  logQueueGovernorDeferral,
  pressureWorkers,
  readFixHostPressure,
  reclaimBeforeHold,
  type FixHostPressure,
  type SlackReclaim,
} from "../src/lib/sweep.js";
import { memoryGovernorGateFor } from "../src/run-task.js";

const MIB = 1048576;
// The 00:23:20Z row: host MemAvailable 4669 MiB against the 3072 MiB floor, short by 451 MiB of a 2048 MiB implement
// worker. MemTotal is the core host's 15988 MiB and the container ceiling 8379 MiB (container floor 1610 MiB). The
// container's working set is the 3637 MiB the 00:18:23Z reclaim left, so its own pool has room and the host binds.
const HOST_FLOOR_MIB = 3072;
const CEILING_MIB = 8379;
const WORKING_SET_MIB = 3637;
const meminfo = (availableMib: number) => `MemTotal:       ${15988 * 1024} kB\nMemAvailable:   ${availableMib * 1024} kB\n`;
const containerAt = (headroomMib: number): ContainerMemoryHeadroom =>
  ({ headroomMib, ceilingMib: CEILING_MIB, workingSetMib: CEILING_MIB - headroomMib });
const ROOMY_CONTAINER = containerAt(CEILING_MIB - WORKING_SET_MIB);

const BEFORE: SlackSnapshot = {
  rss_bytes: 6_000_000_000,
  swap_bytes: 400_000_000,
  heap_used_bytes: 2_400_000_000,
  heap_physical_bytes: 2_600_000_000,
  external_bytes: 140_000_000,
  heap_size_limit_bytes: 8_791_261_184,
};
// Heartbeat-to-heartbeat rss+swap, about 40 MiB apart: the noise a reclaim must beat.
const FOOTPRINT = [3_100, 3_140, 3_105, 3_150, 3_110].map((mib) => mib * MIB);

function afterFreeing(freedMib: number, liveBytes = 900_000_000): SlackSnapshot {
  return {
    ...BEFORE,
    rss_bytes: BEFORE.rss_bytes - freedMib * MIB,
    heap_used_bytes: liveBytes,
    heap_physical_bytes: BEFORE.heap_physical_bytes - Math.round(freedMib * MIB * 0.6),
  };
}

/** A reclaimer whose snapshots alternate before/after each collection, counting its collections. */
function fakeReclaimer(after: () => SlackSnapshot, before: () => SlackSnapshot = () => BEFORE) {
  const calls = { collect: 0 };
  let collected = false;
  const reclaimer = createDaemonSlackReclaimer({
    policy: DEFAULT_DAEMON_MEMORY_POLICY,
    collect: () => { calls.collect++; collected = true; },
    snapshot: () => {
      if (!collected) return before();
      collected = false;
      return after();
    },
    setFlags: () => {},
    inForcePercent: () => 50,
    footprintBytes: () => FOOTPRINT,
  });
  const reclaim: SlackReclaim = (figure, reread, pool) => reclaimer.reclaim(figure, reread, pool);
  return { reclaimer, reclaim, calls };
}

/** The host reads `hosts[0]` first, then each later entry on every re-read; the container reads `containers` likewise. */
function pressureWith(
  reclaim: SlackReclaim | undefined,
  hosts: readonly number[],
  containers: readonly ContainerMemoryHeadroom[] = [ROOMY_CONTAINER],
): FixHostPressure {
  let hostReads = 0;
  let containerReads = 0;
  return readFixHostPressure(HOST_FLOOR_MIB, () => meminfo(hosts[Math.min(hostReads++, hosts.length - 1)]), {
    read: () => containers[Math.min(containerReads++, containers.length - 1)],
    ownWorkLive: () => true,
    ...(reclaim ? { reclaim } : {}),
  });
}

test("W1-T9358: a host-short hold reclaims once and admits when the reclaim frees room", () => {
  // Without a reclaimer the 00:23:20Z reading holds exactly as it did: host-short, host binding, measured bound 0.
  const held = pressureWith(undefined, [4669, 5800]);
  assert.equal(held.tier, "host-short");
  assert.equal(held.binding, "host");
  assert.equal(held.availableMib - held.floorMib, 1597);
  assert.equal(held.reclaim, undefined);
  const heldVerdict = checkQueueGovernor(0, DEFAULT_SWEEP_POLICY, { pressure: held, trailingMergedCount: 1 });
  assert.equal(heldVerdict.measuredBound, 0);
  assert.equal(heldVerdict.deferred, true);

  // With one: the reclaim runs once, and the fresh host reading taken after it decides.
  const { reclaim, calls } = fakeReclaimer(() => afterFreeing(1200));
  const pressure = pressureWith(reclaim, [4669, 5800]);
  assert.equal(calls.collect, 1, "one collection before the host-short hold");
  assert.equal(pressure.tier, "fits", "decided on the fresh reading taken after the reclaim");
  assert.equal(pressure.availableMib, 5800);
  assert.equal(pressure.reclaim?.outcome, "reclaimed");
  assert.equal(pressure.reclaim?.pool, "host", "the binding pool's figure is the one the reclaim compares");
  assert.equal(pressure.reclaim?.host_before_mib, 4669);
  assert.equal(pressure.reclaim?.host_after_mib, 5800);
  assert.equal(pressureWorkers(pressure, 2048), 1);
  const verdict = checkQueueGovernor(0, DEFAULT_SWEEP_POLICY, { pressure, trailingMergedCount: 1 });
  assert.equal(verdict.deferred, false, "the reclaim freed a worker's room, so the refill is admitted");
  assert.equal(verdict.measuredBound, 1);

  // The fix admission reads the same pressure: it admits after the reclaim, and its row names the reclaim.
  const rows: Record<string, unknown>[] = [];
  const fix = fakeReclaimer(() => afterFreeing(1200));
  const admission = createSweepFixAdmissionController({
    surface: "full", queueDepth: 1, hostWorkerBudget: 3, activeWorkers: 0, reviewReservations: 0,
    readActiveWorkers: () => 0,
    readPressure: () => pressureWith(fix.reclaim, [4669, 5800]),
    log: (step, extra) => void rows.push({ step, ...extra }),
  });
  assert.equal(admission.claim({} as never).admitted, true, "the fix round is admitted after the reclaim");
  assert.ok(fix.calls.collect >= 1);
  const capacity = rows.find((r) => r.step === "sweep.fix_capacity");
  assert.equal(capacity?.pressure_tier, "fits");
  assert.equal(capacity?.reclaim_outcome, "reclaimed");
  assert.equal(capacity?.reclaim_pool, "host");
});

test("W1-T9358: a real host shortfall still defers and the row names the reclaim", () => {
  const rows: Record<string, unknown>[] = [];
  const append = (_path: string, line: Record<string, unknown>) => void rows.push(line);
  // The reclaim frees 50 MiB, above the 40 MiB noise but short of the 451 MiB the host needed.
  const { reclaim, calls } = fakeReclaimer(() => afterFreeing(50));
  const pressure = pressureWith(reclaim, [4669, 4719]);
  assert.equal(calls.collect, 1);
  assert.equal(pressure.tier, "host-short", "the fresh reading is still short");
  assert.equal(pressure.availableMib, 4719);
  const verdict = checkQueueGovernor(0, DEFAULT_SWEEP_POLICY, { pressure, trailingMergedCount: 1 });
  assert.equal(verdict.deferred, true);
  assert.equal(verdict.measuredBound, 0);
  logQueueGovernorDeferral(verdict, append, "ledger", "RUN-9358");
  const hold = rows.find((r) => r.step === "dispatch_deferred_wip");
  assert.ok(hold, "the hold row is written");
  assert.equal(hold.pressure_tier, "host-short");
  assert.equal(hold.pressure_binding, "host");
  assert.equal(hold.reclaim_outcome, "reclaimed");
  assert.equal(hold.reclaim_pool, "host");
  assert.equal(hold.reclaim_freed_bytes, 50 * MIB, "the bytes the reclaim freed");
  assert.equal(hold.reclaim_rss_before_bytes, BEFORE.rss_bytes);
  assert.equal(hold.reclaim_rss_after_bytes, BEFORE.rss_bytes - 50 * MIB);
  assert.equal(hold.reclaim_host_before_mib, 4669);
  assert.equal(hold.reclaim_host_after_mib, 4719);
  assert.equal(hold.reclaim_container_before_mib, undefined, "a host reclaim never names a container figure");
  assert.equal(hold.reclaim_measurable, true);

  // The pacing compares the host's MemAvailable for a host reading: a futile reclaim waits for it to move.
  const futile = fakeReclaimer(() => afterFreeing(5), () => ({ ...BEFORE, heap_used_bytes: 900_000_000 + MIB }));
  assert.equal(futile.reclaimer.reclaim(4669, undefined, "host").measurable, false, "5 MiB is inside the 40 MiB noise");
  const paced = futile.reclaimer.reclaim(4671, undefined, "host");
  assert.equal(paced.outcome, "paced", "the host moved 2 MiB, its own variance not yet learned");
  assert.equal(paced.pool, "host");
  assert.match(paced.reason ?? "", /host/);
  assert.equal(futile.calls.collect, 1);
  // A paced reclaim takes no second reading, and the hold stands on the first reading, named as paced.
  let hostReads = 0;
  const stands = readFixHostPressure(HOST_FLOOR_MIB, () => { hostReads++; return meminfo(4670); }, {
    read: () => ROOMY_CONTAINER, ownWorkLive: () => true, reclaim: futile.reclaim,
  });
  assert.equal(stands.tier, "host-short");
  assert.equal(stands.reclaim?.outcome, "paced");
  assert.equal(hostReads, 1);
  // The host moves well past its own learned variance (2 and 1 MiB): the reclaim runs again.
  assert.equal(futile.reclaimer.reclaim(5400, undefined, "host").outcome, "reclaimed");
  assert.equal(futile.calls.collect, 2);
});

test("W1-T9358: one reclaim per reading", () => {
  // A container-short first reading (headroom 3198 against its 1610 MiB floor, host 6655) reclaims; its re-read comes
  // back host-short (the host fell to 4669 while the container got room). The reading is not reclaimed again.
  let asked = 0;
  const { reclaim, calls } = fakeReclaimer(() => afterFreeing(600));
  const counted: SlackReclaim = (figure, reread, pool) => { asked++; return reclaim(figure, reread, pool); };
  const pressure = pressureWith(counted, [6655, 4669], [containerAt(3198), ROOMY_CONTAINER]);
  assert.equal(asked, 1, "one reclaim for the reading, not one per re-read");
  assert.equal(calls.collect, 1);
  assert.equal(pressure.tier, "host-short", "the re-read decides");
  assert.equal(pressure.reclaim?.pool, "container", "its row carries the one reclaim it had");
  assert.equal(pressure.reclaim?.container_before_mib, CEILING_MIB - 3198);

  // A reading that already carries a reclaim is never reclaimed again.
  const record = pressure.reclaim as SlackReclaimRecord;
  const already = { tier: "host-short" as const, hostAvailableMib: 4669, container: ROOMY_CONTAINER, reclaim: record };
  assert.equal(reclaimBeforeHold(already, () => { throw new Error("no re-read"); }, counted), already);
  assert.equal(asked, 1);
});

test("W1-T9358: the memory governor host arm reclaims before deferring", () => {
  const policy = { ...DEFAULT_SWEEP_POLICY, memoryFloorMib: HOST_FLOOR_MIB };
  // The host arm without a reclaim is unchanged: the 00:28:11Z host reading (2678 MiB) is under the floor and defers.
  const bare = checkMemoryGovernor(2678, policy, ROOMY_CONTAINER);
  assert.equal(bare.deferred, true);
  assert.equal(bare.tier, "host-short");

  const dir = mkdtempSync(join(tmpdir(), "rmd-w1t9358-gate-"));
  try {
    // The reclaim frees enough: the host re-reads 3500 MiB, over the floor, and the dispatch is admitted.
    const ledger = join(dir, "ledger.ndjson");
    const freed = fakeReclaimer(() => afterFreeing(900));
    let reads = 0;
    const gate = memoryGovernorGateFor(ledger, "RUN-9358", policy, () => (reads++ === 0 ? 2678 : 3500),
      () => ROOMY_CONTAINER, () => true, freed.reclaim);
    assert.equal(gate(), undefined, "admitted after the reclaim");
    assert.equal(freed.calls.collect, 1);
    const row = readLedgerLines(ledger).find((l) => l.step === "dispatch_memory_observed");
    assert.equal(row?.tier, "fits");
    assert.equal(row?.reclaim_outcome, "reclaimed");
    assert.equal(row?.reclaim_pool, "host");
    assert.equal(row?.reclaim_host_before_mib, 2678);
    assert.equal(row?.reclaim_host_after_mib, 3500);

    // Still under the floor after the reclaim: it defers, carrying the reclaim.
    const shortLedger = join(dir, "short.ndjson");
    const small = fakeReclaimer(() => afterFreeing(50));
    let shortReads = 0;
    const shortGate = memoryGovernorGateFor(shortLedger, "RUN-9358", policy, () => (shortReads++ === 0 ? 2678 : 2728),
      () => ROOMY_CONTAINER, () => true, small.reclaim);
    const deferred = shortGate();
    assert.equal(deferred?.deferred, true);
    assert.equal(deferred?.tier, "host-short");
    assert.equal(deferred?.reclaim?.outcome, "reclaimed");
    assert.equal(small.calls.collect, 1);
    const shortRow = readLedgerLines(shortLedger).find((l) => l.step === "dispatch_memory_observed");
    assert.equal(shortRow?.reclaim_host_after_mib, 2728);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
