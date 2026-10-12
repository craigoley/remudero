// W1-T8401 — 2026-10-11T22:59:05Z, core: `dispatch_deferred_wip` held refills container-short (headroom 3198 MiB, the
// container-sized floor 1610 MiB, so 1588 MiB against a 2048 MiB implement worker; host MemAvailable 6655 MiB) while the
// daemon sat at 2.79 GB RSS + 0.44 GB swap on a 0.81 GB main-heap live set. The governors read the daemon's own
// footprint as a fixed cost. These tests pin the reclaim before the hold (src/lib/sweep.ts `reclaimBeforeHold`), its
// evidence pacing and its shadow heap ceiling (src/lib/daemon-memory-policy.ts), and the daemon's wiring of both.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { DaemonSummary } from "../src/lib/daemon.js";
import {
  DEFAULT_DAEMON_MEMORY_POLICY,
  createDaemonMemoryGovernor,
  createDaemonSlackReclaimer,
  deriveHeapCeiling,
  fullCollection,
  installDaemonSlackReclaimer,
  installedDaemonSlackReclaimer,
  readSlackSnapshot,
  reclaimLedgerFields,
  successiveSpread,
  type DaemonSlackReclaimer,
  type SlackReclaimRecord,
  type SlackSnapshot,
} from "../src/lib/daemon-memory-policy.js";
import type { ContainerMemoryHeadroom } from "../src/lib/host-memory-shadow.js";
import { readLedgerLines } from "../src/lib/status.js";
import {
  DEFAULT_SWEEP_POLICY,
  checkMemoryGovernor,
  checkQueueGovernor,
  installedSlackReclaim,
  logMemoryObservation,
  logQueueGovernorDeferral,
  pressureWorkers,
  readFixHostPressure,
  reclaimBeforeHold,
  type FixHostPressure,
} from "../src/lib/sweep.js";
import { daemonCommand, memoryGovernorGateFor } from "../src/run-task.js";

const MIB = 1048576;
// The 22:59Z row. MemTotal is the core host's 15988 MiB; the ceiling is the memory.high the 1610 MiB container floor
// implies (3072 MiB host floor x 8379 / 15988 = 1610).
const HOST_FLOOR_MIB = 3072;
const MEMINFO = `MemTotal:       ${15988 * 1024} kB\nMemAvailable:   ${6655 * 1024} kB\n`;
const CEILING_MIB = 8379;
const containerAt = (headroomMib: number): ContainerMemoryHeadroom =>
  ({ headroomMib, ceilingMib: CEILING_MIB, workingSetMib: CEILING_MIB - headroomMib });
// daemon.alive at 23:00:11Z: rss 2,786,250,752; swap 441,225,216; main heap_used 809,478,184 (total 935,182,336);
// heap_size_limit 8,791,261,184 (max_old_space_mb 8192).
const BEFORE: SlackSnapshot = {
  rss_bytes: 2_786_250_752,
  swap_bytes: 441_225_216,
  heap_used_bytes: 1_500_000_000,
  heap_physical_bytes: 1_600_000_000,
  external_bytes: 140_000_000,
  heap_size_limit_bytes: 8_791_261_184,
};
// Heartbeat-to-heartbeat rss+swap, about 40 MiB apart: the noise a reclaim must beat.
const FOOTPRINT = [3_100, 3_140, 3_105, 3_150, 3_110].map((mib) => mib * MIB);

function afterFreeing(freedMib: number, liveBytes = 809_478_184): SlackSnapshot {
  return {
    ...BEFORE,
    rss_bytes: BEFORE.rss_bytes - freedMib * MIB,
    heap_used_bytes: liveBytes,
    heap_physical_bytes: BEFORE.heap_physical_bytes - Math.round(freedMib * MIB * 0.6),
  };
}

/** A reclaimer whose snapshots alternate before/after each collection, recording its collections and flags. */
function fakeReclaimer(after: () => SlackSnapshot, before: () => SlackSnapshot = () => BEFORE, extra: { log?: (r: SlackReclaimRecord) => void } = {}) {
  const calls = { collect: 0, flags: [] as string[] };
  let collected = false;
  const reclaimer = createDaemonSlackReclaimer({
    policy: DEFAULT_DAEMON_MEMORY_POLICY,
    collect: () => { calls.collect++; collected = true; },
    snapshot: () => {
      if (!collected) return before();
      collected = false;
      return after();
    },
    setFlags: (flags) => calls.flags.push(flags),
    inForcePercent: () => 50,
    footprintBytes: () => FOOTPRINT,
    ...extra,
  });
  return { reclaimer, calls };
}

/** The 22:59Z pressure: the container reads `first`, then `fresh` once the reclaim has run. */
function pressureWith(reclaimer: DaemonSlackReclaimer | undefined, first: number, fresh: number): FixHostPressure {
  let reads = 0;
  return readFixHostPressure(HOST_FLOOR_MIB, () => MEMINFO, {
    read: () => containerAt(reads++ === 0 ? first : fresh),
    ownWorkLive: () => true,
    ...(reclaimer ? { reclaim: (ws: number | undefined, reread: () => number | undefined) => reclaimer.reclaim(ws, reread) } : {}),
  });
}

test("W1-T8401: a container-short hold reclaims first and admits when the reclaim frees room", () => {
  // Without a reclaimer the 22:59Z reading holds exactly as it did: container-short, measured bound 0.
  const held = pressureWith(undefined, 3198, 3798);
  assert.equal(held.tier, "container-short");
  assert.equal(held.containerFloorMib, 1610);
  assert.equal(held.availableMib - held.floorMib, 1588);
  const heldVerdict = checkQueueGovernor(3, DEFAULT_SWEEP_POLICY, { pressure: held, trailingMergedCount: 1 });
  assert.equal(heldVerdict.measuredBound, 0);
  assert.equal(heldVerdict.deferred, true);

  // With one: the reclaim runs once, under the tightest growth factor restored after, and the fresh reading decides.
  const { reclaimer, calls } = fakeReclaimer(() => afterFreeing(600));
  const pressure = pressureWith(reclaimer, 3198, 3798);
  assert.equal(calls.collect, 1, "one collection before the hold");
  assert.deepEqual(calls.flags, ["--heap-growing-percent=10", "--heap-growing-percent=50"]);
  assert.equal(pressure.tier, "fits", "decided on the fresh reading taken after the reclaim");
  assert.equal(pressure.availableMib, 3798);
  assert.equal(pressure.reclaim?.outcome, "reclaimed");
  assert.equal(pressureWorkers(pressure, 2048), 1);
  const verdict = checkQueueGovernor(3, DEFAULT_SWEEP_POLICY, { pressure, trailingMergedCount: 1 });
  assert.equal(verdict.deferred, false, "the reclaim freed a worker's room, so the refill is admitted");
  assert.equal(verdict.measuredBound, 1);

  // The memory floor's gate takes the same path: container-short, reclaim, fresh reading, admitted.
  const dir = mkdtempSync(join(tmpdir(), "rmd-w1t8401-gate-"));
  try {
    const ledger = join(dir, "ledger.ndjson");
    const second = fakeReclaimer(() => afterFreeing(600));
    let reads = 0;
    const gate = memoryGovernorGateFor(ledger, "RUN-8401", { ...DEFAULT_SWEEP_POLICY, memoryFloorMib: HOST_FLOOR_MIB }, () => 6655,
      () => containerAt(reads++ === 0 ? 2900 : 3500), () => true, (ws, reread) => second.reclaimer.reclaim(ws, reread));
    assert.equal(gate(), undefined, "admitted after the reclaim");
    assert.equal(second.calls.collect, 1);
    const row = readLedgerLines(ledger).find((l) => l.step === "dispatch_memory_observed");
    assert.equal(row?.tier, "fits");
    assert.equal(row?.reclaim_outcome, "reclaimed");
    assert.equal(row?.reclaim_container_before_mib, CEILING_MIB - 2900);
    assert.equal(row?.reclaim_container_after_mib, CEILING_MIB - 3500);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  // Any other tier never reclaims, and a process with no reclaimer (the default seam) reads as before.
  let asked = 0;
  const fits = { tier: "fits" as const, container: containerAt(5000) };
  assert.equal(reclaimBeforeHold(fits, () => fits, () => { asked++; return undefined; }), fits);
  assert.equal(asked, 0);
  const short = { tier: "container-short" as const, container: { unbounded: true as const } };
  assert.equal(reclaimBeforeHold(short, () => short, installedSlackReclaim), short, "nothing installed: the first reading stands");
});

test("W1-T8401: the hold row names what the reclaim freed and a real shortfall still defers", () => {
  const rows: Record<string, unknown>[] = [];
  const append = (_path: string, line: Record<string, unknown>) => void rows.push(line);
  // The reclaim frees 50 MiB, above the 40 MiB noise but short of the 460 MiB the container needed.
  const { reclaimer, calls } = fakeReclaimer(() => afterFreeing(50));
  const pressure = pressureWith(reclaimer, 3198, 3248);
  assert.equal(calls.collect, 1);
  assert.equal(pressure.tier, "container-short", "the fresh reading is still short");
  const verdict = checkQueueGovernor(3, DEFAULT_SWEEP_POLICY, { pressure, trailingMergedCount: 1 });
  assert.equal(verdict.deferred, true);
  assert.equal(verdict.measuredBound, 0);
  logQueueGovernorDeferral(verdict, append, "ledger", "RUN-8401");
  const hold = rows.find((r) => r.step === "dispatch_deferred_wip");
  assert.ok(hold, "the hold row is written");
  assert.equal(hold.pressure_tier, "container-short");
  assert.equal(hold.reclaim_outcome, "reclaimed");
  assert.equal(hold.reclaim_freed_bytes, 50 * MIB, "the bytes the reclaim freed");
  assert.equal(hold.reclaim_rss_before_bytes, BEFORE.rss_bytes);
  assert.equal(hold.reclaim_rss_after_bytes, BEFORE.rss_bytes - 50 * MIB);
  assert.equal(hold.reclaim_container_before_mib, CEILING_MIB - 3198);
  assert.equal(hold.reclaim_container_after_mib, CEILING_MIB - 3248);
  assert.equal(hold.reclaim_measurable, true);
  const record = pressure.reclaim!;
  assert.equal(record.freed_external_bytes, 0);
  assert.equal(record.freed_heap_bytes! + record.freed_outside_heaps_bytes!, 50 * MIB, "freed splits into heap and outside-the-heaps bytes");

  // The memory floor's own row carries the same fields, and an absent reclaim adds none.
  const memory = { ...checkMemoryGovernor(6655, { ...DEFAULT_SWEEP_POLICY, memoryFloorMib: HOST_FLOOR_MIB }, containerAt(2900)), reclaim: record };
  assert.equal(memory.deferred, true);
  logMemoryObservation(memory, append, "ledger", "RUN-8401");
  assert.equal(rows.find((r) => r.step === "dispatch_memory_observed")?.reclaim_freed_bytes, 50 * MIB);
  assert.deepEqual(reclaimLedgerFields(undefined), {});
});

test("W1-T8401: a reclaim that freed nothing waits for the reading to move", () => {
  // Each collection frees 5 MiB, inside the footprint's 40 MiB noise. The heap after it is the 0.81 GB live set.
  let heapBefore = 809_478_184 + 1 * MIB;
  const { reclaimer, calls } = fakeReclaimer(() => afterFreeing(5), () => ({ ...BEFORE, heap_used_bytes: heapBefore }));
  const first = reclaimer.reclaim(5181);
  assert.equal(first.outcome, "reclaimed");
  assert.equal(first.measurable, false, "5 MiB freed is inside the 40 MiB noise");
  assert.equal(first.noise_bytes, 40 * MIB);

  // Unmoved: the heap 1 MiB above the live set it left, the container 2 MiB off (its own noise not yet learned).
  const second = reclaimer.reclaim(5183);
  assert.equal(second.outcome, "paced");
  assert.equal(calls.collect, 1, "no second collection on an unmoved reading");
  assert.match(second.reason ?? "", /inside the noise/);

  // Through the governor's reading: the hold stands on the first reading, named as paced.
  let reads = 0;
  const held = readFixHostPressure(HOST_FLOOR_MIB, () => MEMINFO, {
    read: () => { reads++; return containerAt(3196); }, ownWorkLive: () => true, reclaim: (ws, reread) => reclaimer.reclaim(ws, reread),
  });
  assert.equal(held.tier, "container-short");
  assert.equal(held.reclaim?.outcome, "paced");
  assert.equal(reads, 1, "a paced reclaim takes no second reading");
  assert.equal(calls.collect, 1);

  // The container moves well past its own learned variance: the reclaim runs again.
  const moved = reclaimer.reclaim(5600);
  assert.equal(moved.outcome, "reclaimed");
  assert.equal(calls.collect, 2);
  assert.ok((moved.container_noise_bytes ?? Infinity) < 419 * MIB);

  // Futile again; then the heap grows by 200 MiB, past the noise: the reclaim runs again.
  assert.equal(reclaimer.reclaim(5600).outcome, "paced");
  heapBefore = 809_478_184 + 200 * MIB;
  assert.equal(reclaimer.reclaim(5600).outcome, "reclaimed");
  assert.equal(calls.collect, 3);

  // A reclaim that freed above the noise is not paced.
  const productive = fakeReclaimer(() => afterFreeing(300));
  productive.reclaimer.reclaim(5181);
  assert.equal(productive.reclaimer.reclaim(5181).outcome, "reclaimed");
  assert.equal(productive.calls.collect, 2);

  // The noise is the reading's own variance, not a constant.
  assert.equal(successiveSpread([1]), undefined);
  assert.equal(successiveSpread([10, 30, 25]), 12.5);
  assert.equal(successiveSpread([10, 30, 25, 26]), 5);
});

test("W1-T8401: the derived heap ceiling follows the live set and is ledgered in shadow", () => {
  const IN_FORCE = BEFORE.heap_size_limit_bytes;
  assert.deepEqual(deriveHeapCeiling([], 50, IN_FORCE), {
    shadow: true, ceiling_in_force_bytes: IN_FORCE, live_samples: 0, growth_percent: 50,
    derived_unlearned: "no measured collection yet", live_outgrew_prior_ceiling_count: 0, heap_over_ceiling_count: 0,
  });

  const rows: SlackReclaimRecord[] = [];
  const live = [800, 850].map((mib) => mib * MIB);
  let i = 0;
  const { reclaimer } = fakeReclaimer(() => afterFreeing(300, live[i++]), undefined, { log: (r) => rows.push(r) });
  reclaimer.reclaim(5181);
  reclaimer.reclaim(5181);
  const ceiling = reclaimer.derivedCeiling();
  // (peak 850 + spread 50) x (1 + 50/100) = 1350 MiB.
  assert.equal(ceiling.derived_ceiling_bytes, Math.round(900 * MIB * 1.5));
  assert.equal(ceiling.ceiling_in_force_bytes, IN_FORCE, "beside the ceiling in force");
  assert.notEqual(ceiling.derived_ceiling_bytes, 8192 * MIB, "never the registry's 8192");
  assert.equal(ceiling.shadow, true);
  assert.equal(ceiling.live_samples, 2);
  assert.equal(ceiling.heap_over_ceiling_count, 2, "the 1430 MiB heap before collecting exceeded the 1350 MiB derived ceiling");
  assert.equal(ceiling.live_outgrew_prior_ceiling_count, 1, "850 x 1.5 outgrew the 1200 MiB derived from 800 alone");
  assert.equal(rows.length, 2, "every reclaim is ledgered");
  assert.equal(rows[1].ceiling.derived_ceiling_bytes, ceiling.derived_ceiling_bytes, "with the ceiling it would derive");

  // A smaller live set derives a smaller ceiling: it follows the observation.
  const smaller = deriveHeapCeiling([400, 420].map((mib, n) => ({ at: n, live_bytes: mib * MIB, heap_before_bytes: mib * MIB })), 50, IN_FORCE);
  assert.equal(smaller.derived_ceiling_bytes, Math.round(440 * MIB * 1.5));
  assert.equal(smaller.live_spread_bytes, 20 * MIB);
});

test("W1-T8401: a collection that throws is named unavailable and restores the growth factor", () => {
  const flags: string[] = [];
  const reclaimer = createDaemonSlackReclaimer({
    collect: () => { throw new Error("gc is not defined"); },
    snapshot: () => BEFORE,
    setFlags: (f) => flags.push(f),
  });
  const record = reclaimer.reclaim();
  assert.equal(record.outcome, "unavailable");
  assert.match(record.reason ?? "", /gc is not defined/);
  assert.deepEqual(flags, ["--heap-growing-percent=10", "--heap-growing-percent=50"]);
  // No reread after a failed collection: the first reading stands.
  const short = { tier: "container-short" as const, container: containerAt(3198) };
  const kept = reclaimBeforeHold(short, () => { throw new Error("no reread"); }, (ws, reread) => reclaimer.reclaim(ws, reread));
  assert.equal(kept.reclaim?.outcome, "unavailable");
  assert.equal(kept.container, short.container);
});

test("W1-T8401: the default reclaimer runs a real collection and reads the daemon's own memory", () => {
  const flags: string[] = [];
  // The real collector and snapshot; only the growth flag is recorded, so the test runner's V8 keeps its own.
  const reclaimer = createDaemonSlackReclaimer({ setFlags: (f) => flags.push(f) });
  let garbage: unknown[] | undefined = Array.from({ length: 200_000 }, (_, n) => ({ n, s: `x${n}` }));
  assert.ok(garbage.length > 0);
  garbage = undefined;
  const record = reclaimer.reclaim(1234, () => 1200);
  assert.equal(record.outcome, "reclaimed", record.reason);
  assert.equal(typeof record.freed_bytes, "number");
  assert.ok((record.collect_ms ?? -1) >= 0);
  assert.equal(record.container_after_mib, 1200);
  assert.ok(record.ceiling.ceiling_in_force_bytes > 0);
  assert.equal(flags.length, 2);
  fullCollection(); // exposed once, reused
  const snap = readSlackSnapshot();
  assert.ok(snap.heap_used_bytes > 0 && snap.rss_bytes > 0);
  assert.equal(createDaemonMemoryGovernor({ setFlags: () => {} }).inForcePercent?.(), 50);
});

test("W1-T8401: the daemon installs its reclaimer and ledgers the shadow ceiling at boot", async () => {
  const home = mkdtempSync(join(tmpdir(), "rmd-w1t8401-boot-"));
  const root = join(home, "Remudero");
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ claudeBin: "/bin/true", root }));
  const planPath = join(home, "tasks.yaml");
  writeFileSync(planPath, "[]\n");
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  let installed: DaemonSlackReclaimer | undefined;
  try {
    const code = await daemonCommand(["--allow-self-target", "--plan", planPath, "--max", "0"], {
      applyMemoryPolicy: (policy) => ({ heap_growing_percent: policy.heapGrowingPercent }),
      runDaemon: async (): Promise<DaemonSummary> => {
        installed = installedDaemonSlackReclaimer();
        return { attempted: [], merged: [], stopReason: "stopped", costUsd: 0, ticks: 0 };
      },
    });
    assert.equal(code, 0);
    assert.ok(installed, "the governors' readings in the daemon's process reclaim through it");
    const rows = readFileSync(join(root, "state", "ledger.ndjson"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const boot = rows.find((r) => r.step === "daemon.heap_ceiling_shadow");
    assert.ok(boot, `a daemon.heap_ceiling_shadow row, saw ${rows.map((r) => r.step).join(",")}`);
    assert.equal(boot.basis, "boot");
    assert.equal(boot.shadow, true);
    assert.ok(boot.ceiling_in_force_bytes > 0);
  } finally {
    installDaemonSlackReclaimer(undefined);
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
  }
});
