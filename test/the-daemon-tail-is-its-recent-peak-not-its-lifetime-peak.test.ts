/**
 * W1-T9972: the daemon's tail is its last-hour peak rss+swap less its current rss+swap, not its lifetime VmHWM - VmRSS.
 *
 * MEASURED 2026-10-17 01:50:30Z on core: hostClaim 2,608 = worker typical 308 + daemon tail 2,300, the tail being
 * "proc 123: VmHWM 4058 MiB - VmRSS 1758 MiB" from a boot spike that never recurred. The daemon's footprint over the
 * hour before was 1,920-2,648 MiB. Replayed on the last-hour series, 22 of 36 unrealized-reservations rows fit.
 * The fixture below is that row: MemAvailable 4,300 MiB, a worker typical of 256, reserve 2,048.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { fixedClock } from "../src/lib/clock.js";
import { DAEMON_FOOTPRINT_FILE } from "../src/lib/daemon-footprint.js";
import type { HostMemoryReading } from "../src/lib/host-memory-ledger.js";
import {
  evaluateShadowMemory,
  recordShadowMemoryVerdict,
  resetShadowMemoryStateForTests,
  type HostMemoryBudgetPolicy,
  type ShadowEntryInput,
  type ShadowInputs,
  type ShadowMemoryPorts,
} from "../src/lib/host-memory-shadow.js";
import type { LedgerLine } from "../src/lib/ledger.js";

const NOW = Date.parse("2026-10-17T01:50:30.000Z");
const MIB = 1024 * 1024;
const ROOT = "/home/node/Remudero";

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

/** 29 samples spread over 1,920-2,648 MiB across the hour, then the latest at 2,358 (VmRSS 1,758 + VmSwap 600). */
function hour(spikeMib?: number): Array<{ at: number; bytes: number; pid: number }> {
  const out = Array.from({ length: 29 }, (_, i) => ({
    at: NOW - (29 - i) * 120_000, bytes: (1920 + ((i * 7) % 29) * 26) * MIB, pid: 123,
  }));
  if (spikeMib !== undefined) out[24] = { ...out[24]!, bytes: spikeMib * MIB };
  return [...out, { at: NOW, bytes: 2358 * MIB, pid: 123 }];
}

const status = (rssMib: number, swapMib: number): string =>
  `Name:\tnode\nVmHWM:\t ${4058 * 1024} kB\nVmRSS:\t ${rssMib * 1024} kB\nVmSwap:\t ${swapMib * 1024} kB\n`;

function reading(): HostMemoryReading {
  return {
    state: "present", scope: "host", dir: "/ledger",
    entries: [{ id: "start", owner: "state2@c1", workerClass: "fix", estimateMib: 600,
      estimateSource: { kind: "measured", samples: 40 }, status: "owned", ageMs: 1000, sinceVerifiedMs: 1000,
      walkComplete: true, path: "/ledger/start.json" }],
    counts: { live: 1, uncertain: 0, incompleteWalk: 0, localScope: 0, unreadable: 0 },
    reservedMib: 600,
  };
}

function ports(rows: LedgerLine[], samples: unknown[], proc = status(1758, 600)): Partial<ShadowMemoryPorts> {
  const files: Record<string, string> = {
    "/proc/meminfo": `MemTotal: 16371712 kB\nMemAvailable: ${4300 * 1024} kB\n`,
    "/proc/vmstat": "pswpin 100\n",
    "/proc/pressure/memory": "some avg10=0.00 avg60=0.00 avg300=0.00 total=1\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=1\n",
    "/sys/fs/cgroup/memory.current": `${5000 * MIB}\n`,
    "/sys/fs/cgroup/memory.max": `${8820 * MIB}\n`,
    "/sys/fs/cgroup/memory.high": `${8379 * MIB}\n`,
    "/sys/fs/cgroup/memory.stat": "anon 1\ninactive_file 0\n",
    "/proc/123/status": proc,
    [`${ROOT}/state/${DAEMON_FOOTPRINT_FILE}`]: JSON.stringify({ samples }),
    "/ledger/start.json": JSON.stringify({ roots: [], tree: [] }),
  };
  return {
    clock: fixedClock(NOW),
    readFile: (path) => {
      const text = files[path];
      if (text === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
      return text;
    },
    readTail: () => "",
    readLedger: () => reading(),
    policy: () => POLICY,
    write: (_path, row) => void rows.push(row),
    stderr: () => undefined,
    instance: () => "state2",
    daemonPid: () => 123,
    listStateDir: () => [],
    estimate: (cls) => (cls === "fix" ? 600 : 1024),
    typical: (cls) => (cls === "fix" ? 256 : 295),
    readReviewDemand: () => ({ state: "present", rows: [], unreadableRows: 0 }),
  };
}

type Growth = {
  growthMib?: number; typicalMib?: number; basis?: string; typicalBasis?: string; currentBasis?: string;
  lifetimePeakGrowthMib?: number; lifetimePeakBasis?: string;
};

function verdict(samples: unknown[], proc?: string): { row: LedgerLine; growth: Growth; numbers: Record<string, unknown> } {
  resetShadowMemoryStateForTests();
  const rows: LedgerLine[] = [];
  recordShadowMemoryVerdict({ workerClass: "fix", reservationId: "start", root: ROOT }, ports(rows, samples, proc));
  const row = rows.find((r) => r.step === "memory_budget.shadow")!;
  return { row, growth: (row.daemon_growth as Growth[])[0]!, numbers: row.numbers as Record<string, unknown> };
}

test("W1-T9972: a lifetime peak outside the last hour is not charged as the daemon tail", () => {
  const { row, growth, numbers } = verdict(hour());
  assert.equal(growth.growthMib, 2648 - 2358, "the hour's peak less the current rss+swap, not VmHWM - VmRSS");
  assert.equal(growth.typicalMib, 0, "the hour's median (2,297) is below the current 2,358");
  assert.equal(growth.basis, "daemon footprint");
  assert.equal(numbers.hostTailMib, 600 - 256, "the fix's own tail (344) now outranks the daemon's 290");
  assert.equal(numbers.hostClaimMib, 600);
  // The lifetime rule charged 256 + 2,300, leaving 4,300 - 2,556 = 1,744 under the 2,048 reserve.
  assert.ok(4300 - (256 + 2300) < POLICY.hostReserveMib);
  assert.ok(!(row.reasons as string[]).includes("unrealized-reservations"), `reasons: ${String(row.reasons)}`);
  assert.equal(row.would_admit, true);
});

test("W1-T9972: a spike inside the last hour is still charged as the daemon tail", () => {
  const { growth, numbers } = verdict(hour(4058));
  assert.equal(growth.growthMib, 4058 - 2358, "a spike 10 minutes ago is charged in full");
  assert.equal(growth.typicalMib, 0);
  assert.equal(numbers.daemonGrowthTailMib, 1700);
  assert.equal(numbers.hostTailMib, 1700);
  assert.equal(numbers.hostTailOwner, "daemon:state2");
});

test("W1-T9972: too few samples charge the lifetime peak and say so", () => {
  const { growth, numbers } = verdict(hour().slice(-3));
  assert.equal(growth.growthMib, 4058 - 1758, "the proc's VmHWM - VmRSS");
  assert.equal(growth.typicalMib, undefined, "all of it typical");
  assert.equal(growth.basis, "proc 123: VmHWM 4058 MiB - VmRSS 1758 MiB (the lifetime peak: 3 daemon footprint sample(s) in the last hour)");
  assert.equal(growth.typicalBasis, "all typical: 3 daemon footprint sample(s) in the last hour");
  assert.equal(numbers.daemonGrowthTypicalMib, 2300);
  assert.equal(numbers.daemonGrowthTailMib, 0);
});

test("W1-T9972: swapped-out daemon pages do not raise the daemon tail", () => {
  const resident = verdict(hour(), status(1758, 600));
  const swapped = verdict(hour(), status(1158, 1200)); // The same 2,358 MiB, half of it in swap.
  assert.equal(resident.growth.growthMib, 290);
  assert.equal(swapped.growth.growthMib, 290, "VmRSS alone would read 2,648 - 1,158 = 1,490");
  assert.equal(swapped.growth.currentBasis, "proc 123: VmRSS 1158 MiB + VmSwap 1200 MiB");
  assert.equal(swapped.growth.lifetimePeakGrowthMib, 4058 - 1158, "the lifetime figure swap inflates, kept for comparison");
});

function tree(id: string, over: Partial<ShadowEntryInput> = {}): ShadowEntryInput {
  return {
    id, owner: "state2@c1", workerClass: "implement", estimateMib: 1000, typicalMib: 400,
    estimateSource: { kind: "measured", samples: 40 }, status: "owned", walkComplete: true,
    resident: { mib: 0, complete: true }, ...over,
  };
}

function inputs(entries: ShadowEntryInput[], daemonGrowth: ShadowInputs["daemonGrowth"]): ShadowInputs {
  return {
    memAvailable: { mib: 12_000 }, swapIn: { pagesPerSec: 0 }, psi: { someAvg10: 0, someAvg60: 0 },
    container: { currentMib: 3000, maxMib: 8820 }, ledger: { state: "present" }, entries,
    start: { reservationId: "s", workerClass: "fix", estimateMib: 600, typicalMib: 256 }, daemonGrowth,
    serve: { scenario: "serve-stopped", basis: "test" },
  };
}

test("W1-T9972: a verdict names its host tail owner and the lifetime peak growth", () => {
  const { numbers } = verdict(hour());
  assert.equal(numbers.hostTailOwner, "start");
  assert.equal(numbers.daemonGrowthLifetimePeakMib, 2300);

  const daemon = { instance: "state2", samples: 30, growthMib: 290, typicalMib: 0, own: true, lifetimePeakGrowthMib: 2300 };
  const other = { instance: "rmd-site-state", samples: 30, growthMib: 100, lifetimePeakGrowthMib: 50 };
  const byTree = evaluateShadowMemory(inputs([tree("s"), tree("g", { workerClass: "garden", estimateMib: 1200 })], [daemon, other]), POLICY);
  assert.equal(byTree.numbers.hostTailOwner, "garden", "the garden's 800 outranks the start's 600 and the daemon's 290");
  assert.equal(byTree.numbers.daemonGrowthLifetimePeakMib, 2350, "summed over every daemon that read one");
  const byDaemon = evaluateShadowMemory(inputs([tree("s", { estimateMib: 300, typicalMib: 300 })], [daemon]), POLICY);
  assert.equal(byDaemon.numbers.hostTailOwner, "daemon:state2");
  const none = evaluateShadowMemory(inputs([tree("s", { estimateMib: 300, typicalMib: 300 })], [{ instance: "state2", samples: 1, growthMib: 0 }]), POLICY);
  assert.equal(none.numbers.hostTailOwner, null, "no tail: no owner");
  assert.equal(none.numbers.daemonGrowthLifetimePeakMib, null, "none read: not a zero");
});
