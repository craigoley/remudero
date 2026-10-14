/**
 * The daemon's growth is one more tail, and the host check gets the same typical-plus-one-tail rule as the container's.
 *
 * MEASURED 2026-10-11 04:48-05:11Z on the core instance, after #10763: 36 of 91 shadow verdicts (40%) would have
 * deferred. Replaying the saved rows (their `claims` reproduce all 91 recorded verdicts exactly) with the daemon's
 * growth split at its median footprint and the host check counting typical growth plus one tail: 32 of 91 (35%); the
 * four `unrealized-reservations` and two `uncertainty` reasons all went, and no row with swap-in or PSI past its
 * threshold was admitted. The daemon's growth back to its VmHWM was a median 756 MiB, added in full to both checks
 * beside the trees' own tail allowance.
 * Each case asserts a verdict field only the daemon split, the host one-tail rule, or the tick-row series produces.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { fixedClock } from "../src/lib/clock.js";
import type { HostMemoryReading } from "../src/lib/host-memory-ledger.js";
import {
  daemonGrowthOf,
  evaluateShadowMemory,
  recordShadowMemoryVerdict,
  resetShadowMemoryStateForTests,
  type HostMemoryBudgetPolicy,
  type ShadowEntryInput,
  type ShadowInputs,
  type ShadowMemoryPorts,
} from "../src/lib/host-memory-shadow.js";
import type { LedgerLine } from "../src/lib/ledger.js";

const NOW = Date.parse("2026-10-11T05:06:44.495Z");
const MIB = 1024 * 1024;

const POLICY: HostMemoryBudgetPolicy = {
  mode: "shadow",
  hostReserveMib: 2048,
  containerReserveMib: 1024,
  swapInPagesPerSecMax: 256,
  psiSomeAvg10Max: 10,
  psiFullAvg10Max: 2,
  serveColdStartReserveMib: 7680,
  uncertaintyMarginMib: 256,
  daemonGrowthUnmeasuredMib: 1024,
  daemonGrowthMinSamples: 6,
  staleReadingMs: 600_000,
};

function tree(id: string, over: Partial<ShadowEntryInput> = {}): ShadowEntryInput {
  return {
    id, owner: "state2@c1", workerClass: "implement", estimateMib: 3672, typicalMib: 1459,
    estimateSource: { kind: "measured", samples: 40 }, status: "owned", walkComplete: true,
    resident: { mib: 0, complete: true }, ...over,
  };
}

function inputs(entries: ShadowEntryInput[], over: Partial<ShadowInputs> = {}): ShadowInputs {
  return {
    memAvailable: { mib: 10_886 },
    swapIn: { pagesPerSec: 0 },
    psi: { someAvg10: 0, someAvg60: 0, fullAvg10: 0, fullAvg60: 0 },
    container: { currentMib: 4561, maxMib: 8820, highMib: 8379 },
    ledger: { state: "present" },
    entries,
    start: { reservationId: entries[0]?.id ?? "start", workerClass: "implement", estimateMib: 3672 },
    daemonGrowth: [{ instance: "state2", samples: 1, growthMib: 0, own: true }],
    serve: { scenario: "serve-stopped", basis: "test" },
    ...over,
  };
}

test("the daemon's growth counts its typical part and its spike competes for the one tail allowance", () => {
  // A garden (tail 730) and a review (tail 729) beside a daemon 900 MiB under its VmHWM, 100 MiB under its median.
  const entries = [
    tree("g1", { workerClass: "garden", estimateMib: 820, typicalMib: 90 }),
    tree("r1", { workerClass: "review", estimateMib: 1024, typicalMib: 295 }),
  ];
  const verdict = evaluateShadowMemory(inputs(entries, {
    container: { currentMib: 5200, maxMib: 8820, highMib: 8379 },
    daemonGrowth: [{ instance: "state2", samples: 1, growthMib: 900, typicalMib: 100, own: true }],
  }), POLICY);
  // Before: 8379 - 5200 - (385 typical + 730 tail) - 900 growth = 1164; now the daemon's 800 spike IS the one tail.
  assert.equal(verdict.numbers.containerTailMib, 800, "the daemon's spike outranks the garden's 730 and replaces it");
  assert.equal(verdict.numbers.containerClaimMib, 90 + 295 + 800);
  assert.equal(verdict.numbers.containerHeadroomMib, 8379 - 5200 - (90 + 295 + 800) - 100);
  assert.equal(verdict.numbers.containerHeadroomAllPeaksMib, 8379 - 5200 - (820 + 1024) - 900, "every peak at once, for comparison");
  assert.equal(verdict.numbers.daemonGrowthTypicalMib, 100);
  assert.equal(verdict.numbers.daemonGrowthTailMib, 800);
  assert.equal(verdict.numbers.daemonGrowthMib, 900, "the full growth is still reported");

  // A daemon whose spike is SMALLER than a tree's tail adds only its typical part: the tree's tail already covers it.
  const small = evaluateShadowMemory(inputs(entries, {
    container: { currentMib: 5900, maxMib: 8820, highMib: 8379 },
    daemonGrowth: [{ instance: "state2", samples: 1, growthMib: 600, typicalMib: 150, own: true }],
  }), POLICY);
  assert.equal(small.numbers.containerTailMib, 730);
  assert.equal(small.numbers.containerHeadroomMib, 8379 - 5900 - (385 + 730) - 150);
  assert.ok(!small.reasons.includes("container-ceiling"),
    `1214 MiB clears the 1024 MiB reserve; the old sum (385 + 730 + 600) left 764: ${small.reasons.join(",")}`);

  // No typical given (too few samples): the whole growth is typical, exactly the rule before.
  const whole = evaluateShadowMemory(inputs(entries, {
    container: { currentMib: 5900, maxMib: 8820, highMib: 8379 },
    daemonGrowth: [{ instance: "state2", samples: 1, growthMib: 600, own: true }],
  }), POLICY);
  assert.equal(whole.numbers.containerHeadroomMib, 8379 - 5900 - (385 + 730) - 600);
  assert.deepEqual(whole.reasons, ["container-ceiling"]);
  assert.equal(whole.numbers.daemonGrowthTailMib, 0);
});

test("the host check counts every tree's typical growth plus one tail, not every p90 at once", () => {
  // The core instance's 04:48:52.791Z row: five trees, memAvailable 10886, daemon growth 481, recorded as
  // ['container-ceiling', 'unrealized-reservations'] with 8528 MiB of p90 claims summed.
  const entries = [
    tree("i1", { resident: { mib: 732, complete: true } }),
    tree("g1", { workerClass: "garden", estimateMib: 820, typicalMib: 90 }),
    tree("i2", { resident: { mib: 287, complete: true } }),
    tree("t1", { workerClass: "test", estimateMib: 794, typicalMib: 313, resident: { mib: 152, complete: true } }),
    tree("g2", { workerClass: "garden", estimateMib: 820, typicalMib: 90, resident: { mib: 80, complete: true } }),
  ];
  const verdict = evaluateShadowMemory(inputs(entries, {
    daemonGrowth: [{ instance: "state2", samples: 1, growthMib: 481, own: true }],
  }), POLICY);
  assert.equal(verdict.numbers.unrealizedMib, 2940 + 820 + 3385 + 642 + 740, "the p90 sum is still reported");
  // Typical: 727 + 90 + 1172 + 161 + 10 = 2160; one tail, the implement's 2940 - 727 = 2213.
  assert.equal(verdict.numbers.hostTypicalMib, 2160);
  assert.equal(verdict.numbers.hostTailMib, 2213);
  assert.equal(verdict.numbers.hostClaimMib, 2160 + 2213);
  assert.equal(verdict.numbers.projectedAvailableMib, 10_886 - 481 - (2160 + 2213) - 0);
  assert.equal(verdict.numbers.projectedAvailableAllPeaksMib, 10_886 - 481 - 8527 - 0,
    "the old projection, 1878 MiB, under the 2048 MiB reserve: it read unrealized-reservations");
  assert.ok(!verdict.reasons.includes("unrealized-reservations"), `the host fits: ${verdict.reasons.join(",")}`);
  assert.deepEqual(verdict.reasons, ["container-ceiling"], "the container check still holds this start");
});

test("the host's one tail is the largest across every container's trees and every measured daemon", () => {
  const entries = [
    tree("own", { workerClass: "garden", estimateMib: 820, typicalMib: 90 }),
    // Another container's implement: not this container's tail, but the host's.
    tree("other", { owner: "state3@c9", status: "owner-verified" }),
  ];
  const verdict = evaluateShadowMemory(inputs(entries, {
    daemonGrowth: [
      { instance: "state2", samples: 1, growthMib: 700, typicalMib: 200, own: true },
      { instance: "state3", samples: 1, growthMib: 2600, typicalMib: 100 },
    ],
  }), POLICY);
  assert.equal(verdict.numbers.containerTailMib, 730, "this container: its garden's 730 beats its daemon's 500");
  assert.equal(verdict.numbers.hostTailMib, 2500, "the host: the other daemon's 2500 beats the implement's 2213");
  assert.equal(verdict.numbers.hostTypicalMib, 90 + 1459);
  assert.equal(verdict.numbers.daemonGrowthTypicalMib, 300);
  assert.equal(verdict.numbers.projectedAvailableMib, 10_886 - 300 - (90 + 1459 + 2500));

  // Memory available after the typical parts but not after the tail: named as the claims, not as measured headroom.
  const tight = evaluateShadowMemory(inputs(entries, {
    memAvailable: { mib: 5000 },
    daemonGrowth: [{ instance: "state2", samples: 1, growthMib: 700, typicalMib: 200, own: true }],
  }), POLICY);
  assert.ok(tight.reasons.includes("unrealized-reservations"), tight.reasons.join(","));
  assert.ok(!tight.reasons.includes("memory-available"), "5000 - 200 typical daemon growth clears the reserve");
});

const tick = (agoMs: number, mib: number, pid = 777, step = "daemon.tick") =>
  ({ step, at: NOW - agoMs, bytes: mib * MIB, pid });

test("the daemon's typical growth is its median sample less its latest, from daemon.tick rows as well as daemon.alive", () => {
  // The core daemon's rss+swap at 04:48-05:06Z, MiB: idle ticks and working heartbeats are the same sample.
  const rows = [
    tick(1_097_000, 2435, 777, "daemon.alive"), tick(913_000, 2498), tick(775_000, 2625), tick(626_000, 2529),
    tick(532_000, 2485, 777, "daemon.alive"), tick(439_000, 2494), tick(0, 2026),
    // Another pid's rows (the daemon before a restart) and a sample older than the hour are not this daemon's.
    tick(300_000, 6000, 4242), tick(3_700_000, 9000),
  ];
  const out = daemonGrowthOf(rows, NOW, 6, 777);
  assert.equal(out.samples, 7);
  assert.equal(out.growthMib, 2625 - 2026, "back to the peak");
  assert.equal(out.typicalMib, 2494 - 2026, "back to the median: 2494 of 2026, 2435, 2485, 2494, 2498, 2529, 2625");
  assert.equal(daemonGrowthOf(rows, NOW, 6).samples, 8, "with no pid given, every pid in the hour counts");
  const few = daemonGrowthOf(rows.slice(0, 5), NOW, 6, 777);
  assert.equal(few.typicalMib, undefined, "too few samples: no split");
  assert.match(few.reason ?? "", /^5 daemon sample row\(s\) in the last hour$/);
});

function reading(): HostMemoryReading {
  return {
    state: "present", scope: "host", dir: "/ledger",
    entries: [{ id: "start", owner: "state2@c1", workerClass: "garden", estimateMib: 820,
      estimateSource: { kind: "measured", samples: 40 }, status: "owned", ageMs: 1000, sinceVerifiedMs: 1000,
      walkComplete: true, path: "/ledger/start.json" }],
    counts: { live: 1, uncertain: 0, incompleteWalk: 0, localScope: 0, unreadable: 0 },
    reservedMib: 820,
  };
}

function ports(rows: LedgerLine[], tail: string): Partial<ShadowMemoryPorts> {
  const files: Record<string, string> = {
    "/proc/meminfo": "MemTotal: 16371712 kB\nMemAvailable: 10000000 kB\n",
    "/proc/vmstat": "pswpin 100\n",
    "/proc/pressure/memory": "some avg10=0.00 avg60=0.00 avg300=0.00 total=1\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=1\n",
    "/sys/fs/cgroup/memory.current": `${5000 * MIB}\n`,
    "/sys/fs/cgroup/memory.max": `${8820 * MIB}\n`,
    "/sys/fs/cgroup/memory.high": `${8379 * MIB}\n`,
    "/sys/fs/cgroup/memory.stat": "anon 1\ninactive_file 0\n",
    // VmHWM 2518 MiB, VmRSS 2038 MiB: the core daemon's 480 MiB of growth at 04:48:52Z.
    "/proc/777/status": `Name:\tnode\nVmHWM:\t ${2518 * 1024} kB\nVmRSS:\t ${2038 * 1024} kB\nVmSwap:\t 0 kB\n`,
    "/ledger/start.json": JSON.stringify({ roots: [], tree: [] }),
  };
  return {
    clock: fixedClock(NOW),
    readFile: (path) => {
      const text = files[path];
      if (text === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
      return text;
    },
    readTail: () => tail,
    readLedger: () => reading(),
    policy: () => POLICY,
    write: (_path, row) => void rows.push(row),
    stderr: () => undefined,
    instance: () => "state2",
    daemonPid: () => 777,
    listStateDir: () => [],
    estimate: (cls) => (cls === "garden" ? 820 : 1024),
    typical: (cls) => (cls === "garden" ? 90 : 295),
    readReviewDemand: () => ({ state: "present", rows: [], unreadableRows: 0 }),
  };
}

const tickLine = (agoMs: number, mib: number): string =>
  JSON.stringify({ ts: new Date(NOW - agoMs).toISOString(), actor_pid: 777, step: "daemon.tick", rss_bytes: (mib - 100) * MIB, vm_swap_bytes: 100 * MIB });

test("a recorded verdict splits the proc-measured daemon growth at the median of the daemon's own sample rows", () => {
  resetShadowMemoryStateForTests();
  const rows: LedgerLine[] = [];
  const series = [[600_000, 2300], [500_000, 2400], [400_000, 2350], [300_000, 2450], [200_000, 2380], [100_000, 2420], [0, 2100]];
  const tail = [
    JSON.stringify({ ts: new Date(NOW - 700_000).toISOString(), step: "daemon.tick", actor_pid: 777 }), // no sample on it
    ...series.map(([ago, mib]) => tickLine(ago!, mib!)),
  ].join("\n");
  recordShadowMemoryVerdict({ workerClass: "garden", reservationId: "start", root: "/home/node/Remudero" }, ports(rows, tail));
  const row = rows.find((r) => r.step === "memory_budget.shadow")!;
  const growth = (row.daemon_growth as Array<{ growthMib: number; typicalMib?: number; typicalBasis?: string }>)[0]!;
  assert.equal(growth.growthMib, 480, "the peak is still the proc's VmHWM - VmRSS");
  assert.equal(growth.typicalMib, 2380 - 2100, "median 2380 of the seven samples, less the latest 2100");
  assert.equal(growth.typicalBasis, "median of 7 sample row(s)");
  const numbers = row.numbers as Record<string, number>;
  assert.equal(numbers.daemonGrowthTypicalMib, 280);
  assert.equal(numbers.daemonGrowthTailMib, 200);
  // The garden's tail (730) is the container's one tail; the daemon adds only its typical 280.
  assert.equal(numbers.containerHeadroomMib, 8379 - 5000 - (90 + 730) - 280);

  resetShadowMemoryStateForTests();
  const short: LedgerLine[] = [];
  recordShadowMemoryVerdict({ workerClass: "garden", reservationId: "start", root: "/home/node/Remudero" },
    ports(short, series.slice(0, 3).map(([ago, mib]) => tickLine(ago!, mib!)).join("\n")));
  const whole = (short[0]!.daemon_growth as Array<{ typicalMib?: number; typicalBasis?: string }>)[0]!;
  assert.equal(whole.typicalMib, undefined, "three samples since the rotation: no split");
  assert.equal(whole.typicalBasis, "all typical: 3 daemon sample row(s) in the last hour");
  assert.equal((short[0]!.numbers as Record<string, number>).containerHeadroomMib, 8379 - 5000 - (90 + 730) - 480);
});
