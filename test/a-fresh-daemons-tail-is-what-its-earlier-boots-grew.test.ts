/**
 * W1-T9982: a fresh daemon's tail is what its earlier boots grew.
 *
 * MEASURED 2026-10-17 02:33-02:36Z on core: the budget charged the daemon VmHWM - VmRSS of a process that had not grown
 * yet (6 MiB at uptime ~10 s), admitted two implements, and the daemon grew 2.1 GB. Each of the three boots before it
 * grew 2.2-2.7 GB within 230-430 s. The fixture below is those boots and that row: MemAvailable 6,637 MiB, an implement
 * start (estimate 3,196, typical 447), reserve 2,048.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { fixedClock } from "#src/lib/clock.js";
import { HEAP_SAMPLE_RETAIN_MS } from "#src/lib/daemon-memory-policy.js";
import {
  BOOT_GROWTH_RETAIN_MS,
  createDaemonFootprint,
  DAEMON_FOOTPRINT_FILE,
  parseBootGrowth,
  readDaemonFootprint,
  type BootGrowth,
  type DaemonFootprintIo,
  type FootprintSample,
} from "#src/lib/daemon-footprint.js";
import type { HostMemoryReading } from "#src/lib/host-memory-ledger.js";
import {
  footprintGrowthOf,
  recordShadowMemoryVerdict,
  resetShadowMemoryStateForTests,
  type HostMemoryBudgetPolicy,
  type ShadowMemoryPorts,
} from "#src/lib/host-memory-shadow.js";
import type { LedgerLine } from "#src/lib/ledger.js";

const NOW = Date.parse("2026-10-17T02:34:25.000Z");
const MIB = 1024 * 1024;
const ROOT = "/home/node/Remudero";

const POLICY: HostMemoryBudgetPolicy = {
  mode: "shadow", hostReserveMib: 2048, containerReserveMib: 1024, swapInPagesPerSecMax: 256, psiSomeAvg10Max: 10,
  psiFullAvg10Max: 2, serveColdStartReserveMib: 7680, uncertaintyMarginMib: 256, daemonGrowthUnmeasuredMib: 1024,
  daemonGrowthMinSamples: 6, staleReadingMs: 600_000,
};

/** The three boots before 02:33Z: first reading, peak, and the uptime they peaked by. */
const EARLIER: BootGrowth[] = [
  { boot: Date.parse("2026-10-16T22:27:09Z"), first_bytes: 1515 * MIB, peak_bytes: 3679 * MIB, peak_uptime_ms: 421_000 },
  { boot: Date.parse("2026-10-17T00:25:18Z"), first_bytes: 1785 * MIB, peak_bytes: 4058 * MIB, peak_uptime_ms: 429_000 },
  { boot: Date.parse("2026-10-17T02:03:15Z"), first_bytes: 985 * MIB, peak_bytes: 3107 * MIB, peak_uptime_ms: 232_000 },
];

const status = (hwmMib: number, rssMib: number): string =>
  `Name:\tnode\nVmHWM:\t ${hwmMib * 1024} kB\nVmRSS:\t ${rssMib * 1024} kB\nVmSwap:\t 0 kB\n`;

function reading(): HostMemoryReading {
  return {
    state: "present", scope: "host", dir: "/ledger",
    entries: [{ id: "start", owner: "state2@c1", workerClass: "implement", estimateMib: 3196,
      estimateSource: { kind: "measured", samples: 40 }, status: "owned", ageMs: 1000, sinceVerifiedMs: 1000,
      walkComplete: true, path: "/ledger/start.json" }],
    counts: { live: 1, uncertain: 0, incompleteWalk: 0, localScope: 0, unreadable: 0 },
    reservedMib: 3196,
  };
}

function ports(rows: LedgerLine[], footprint: string | undefined): Partial<ShadowMemoryPorts> {
  const files: Record<string, string> = {
    "/proc/meminfo": `MemTotal: 16371712 kB\nMemAvailable: ${6637 * 1024} kB\n`,
    "/proc/vmstat": "pswpin 100\n",
    "/proc/pressure/memory": "some avg10=0.00 avg60=0.00 avg300=0.00 total=1\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=1\n",
    "/sys/fs/cgroup/memory.current": `${1500 * MIB}\n`,
    "/sys/fs/cgroup/memory.max": `${12_000 * MIB}\n`,
    "/sys/fs/cgroup/memory.high": `${11_000 * MIB}\n`,
    "/sys/fs/cgroup/memory.stat": "anon 1\ninactive_file 0\n",
    "/proc/123/status": status(985, 979),
    "/ledger/start.json": JSON.stringify({ roots: [], tree: [] }),
  };
  if (footprint !== undefined) files[`${ROOT}/state/${DAEMON_FOOTPRINT_FILE}`] = footprint;
  return {
    clock: fixedClock(NOW),
    readFile: (path) => {
      const text = files[path];
      if (text === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
      return text;
    },
    readTail: () => "", readLedger: () => reading(), policy: () => POLICY,
    write: (_path, row) => void rows.push(row), stderr: () => undefined, instance: () => "state2", daemonPid: () => 123,
    listStateDir: () => [], estimate: () => 3196, typical: () => 447,
    readReviewDemand: () => ({ state: "present", rows: [], unreadableRows: 0 }),
  };
}

type Growth = {
  growthMib?: number; typicalMib?: number; basis?: string; typicalBasis?: string; phase?: string; phaseBasis?: string;
  lifetimePeakGrowthMib?: number;
};

function verdict(uptimeMs: number, boots: BootGrowth[]): { row: LedgerLine; growth: Growth } {
  resetShadowMemoryStateForTests();
  const boot = NOW - uptimeMs;
  const current: FootprintSample = { at: NOW, bytes: 985 * MIB, pid: 123, boot };
  const file = JSON.stringify({
    samples: [current],
    boots: [...boots, { boot, first_bytes: 985 * MIB, peak_bytes: 985 * MIB, peak_uptime_ms: uptimeMs }],
  });
  const rows: LedgerLine[] = [];
  recordShadowMemoryVerdict({ workerClass: "implement", reservationId: "start", root: ROOT }, ports(rows, file));
  const row = rows.find((r) => r.step === "memory_budget.shadow")!;
  return { row, growth: (row.daemon_growth as Growth[])[0]! };
}

test("W1-T9982: inside the boot phase the daemon is charged what earlier boots grew", () => {
  const { row, growth } = verdict(60_000, EARLIER);
  assert.equal(growth.phase, "boot");
  assert.equal(growth.growthMib, 4058 - 1785, "the largest earlier growth, nothing grown yet (VmRSS 979 is under its first 985)");
  assert.equal(growth.typicalMib, 3679 - 1515, "the median of the three earlier boots' growth");
  assert.equal(growth.basis, "boot-phase: 3 earlier boots, +2273 MiB by uptime 429 s");
  assert.equal(growth.lifetimePeakGrowthMib, 6, "the proc's VmHWM - VmRSS, the old charge, kept for comparison");
  assert.ok((row.reasons as string[]).includes("unrealized-reservations"), `reasons: ${String(row.reasons)}`);
  assert.equal(row.would_admit, false);
  // Today's charge of 6 MiB leaves the same start fitting: 6,637 - 6 - (447 + 2,749) = 3,435 >= 2,048.
  assert.ok(6637 - 6 - 3196 >= POLICY.hostReserveMib);

  // What it has grown since boot comes off: 1,000 MiB grown leaves 1,273 of the 2,273.
  resetShadowMemoryStateForTests();
  const boot = NOW - 60_000;
  const grown = JSON.stringify({
    samples: [{ at: NOW, bytes: 1985 * MIB, pid: 123, boot }],
    boots: [...EARLIER, { boot, first_bytes: 985 * MIB, peak_bytes: 1985 * MIB, peak_uptime_ms: 60_000 }],
  });
  const rows: LedgerLine[] = [];
  const p = ports(rows, grown);
  const files = p.readFile!;
  p.readFile = (path) => (path === "/proc/123/status" ? status(1985, 1985) : files(path));
  recordShadowMemoryVerdict({ workerClass: "implement", reservationId: "start", root: ROOT }, p);
  const later = (rows.find((r) => r.step === "memory_budget.shadow")!.daemon_growth as Growth[])[0]!;
  assert.equal(later.growthMib, 2273 - 1000);
});

test("W1-T9982: the phase is learned from when earlier boots peaked, not fixed", () => {
  const slow = EARLIER.map((b) => ({ ...b, peak_uptime_ms: 20 * 60_000 }));
  assert.equal(verdict(12 * 60_000, slow).growth.phase, "boot", "minute 12 is inside a phase earlier boots took 20 minutes to finish");
  assert.equal(verdict(12 * 60_000, EARLIER).growth.phase, "steady", "minute 12 is past boots that peaked by 429 s");
});

test("W1-T9982: past the boot phase or with no earlier boot the steady rule applies", () => {
  const past = verdict(500_000, EARLIER).growth;
  assert.equal(past.phase, "steady");
  assert.equal(past.phaseBasis, "steady: uptime 500 s is past the 429 s its 3 earlier boot(s) peaked by");
  assert.equal(past.growthMib, 6, "too few samples: the proc's VmHWM - VmRSS, as W1-T9972 leaves it");
  assert.ok(!String(past.basis).startsWith("boot-phase"));

  const none = verdict(60_000, []).growth;
  assert.equal(none.phase, "steady");
  assert.equal(none.phaseBasis, "steady: no earlier boot recorded");
  assert.equal(none.growthMib, 6);

  resetShadowMemoryStateForTests();
  const rows: LedgerLine[] = [];
  recordShadowMemoryVerdict({ workerClass: "implement", reservationId: "start", root: ROOT }, ports(rows, "{torn"));
  const unread = (rows.find((r) => r.step === "memory_budget.shadow")!.daemon_growth as Growth[])[0]!;
  assert.equal(unread.phase, "steady");
  assert.equal(unread.phaseBasis, "steady: the boot record is unread (unparseable)", "an unreadable store is named, never read as no boots");
});

test("W1-T9982: a sample names its generation and an earlier one never sizes the steady growth", () => {
  const files = new Map<string, string>();
  const io: DaemonFootprintIo = {
    readFile: (path) => {
      const text = files.get(path);
      if (text === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return text;
    },
    writeFile: (path, content) => void files.set(path, content),
  };
  const store = createDaemonFootprint("/s/f.json", io, { boot: 5_000 });
  store.record({ at: 6_000, bytes: 10, pid: 123 });
  store.record({ at: 7_000, bytes: 20, pid: 123, boot: 1_000 });
  assert.equal(store.samples()[0]!.boot, 5_000, "a sample recorded without one takes the store's generation");
  assert.equal(store.samples()[1]!.boot, 1_000, "one that names a generation keeps it");
  assert.equal(JSON.parse(files.get("/s/f.json")!).samples[0].boot, 5_000);

  const old = Array.from({ length: 20 }, (_, i): FootprintSample => ({ at: NOW - (40 - i) * 60_000, bytes: 4000 * MIB, pid: 123, boot: 111 }));
  const own = Array.from({ length: 6 }, (_, i): FootprintSample => ({ at: NOW - (5 - i) * 60_000, bytes: (2000 + i) * MIB, pid: 123, boot: 222 }));
  const legacy: FootprintSample = { at: NOW - 30 * 60_000, bytes: 4100 * MIB, pid: 123 };
  const sized = footprintGrowthOf([...old, legacy, ...own], NOW, 6, 222);
  assert.equal(sized.peakMib, 2005, "only the current generation's six samples");
  assert.equal(footprintGrowthOf([...old, legacy, ...own], NOW, 6).peakMib, 4100, "without a generation the hour is mixed, as before");
  const few = footprintGrowthOf([...old, ...own.slice(0, 3)], NOW, 6, 222);
  assert.equal(few.peakMib, 4000, "under the minimum the hour stays whole: today's behaviour");
});

test("W1-T9982: each generation records its first and peak footprint and when it peaked", () => {
  const files = new Map<string, string>();
  let failWrite = false;
  const io: DaemonFootprintIo = {
    readFile: (path) => {
      const text = files.get(path);
      if (text === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return text;
    },
    writeFile: (path, content) => {
      if (failWrite) throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
      files.set(path, content);
    },
  };
  const first = createDaemonFootprint("/s/daemon-footprint.json", io, { boot: 1_000 });
  first.record({ at: 11_000, bytes: 100, pid: 123 });
  first.record({ at: 101_000, bytes: 900, pid: 123 });
  first.record({ at: 201_000, bytes: 500, pid: 123 });
  assert.deepEqual(first.boots(), [{ boot: 1_000, first_bytes: 100, peak_bytes: 900, peak_uptime_ms: 100_000 }]);

  // The next container generation is pid 123 as well: the store reloaded from the file tells them apart.
  const second = createDaemonFootprint("/s/daemon-footprint.json", io, { boot: 400_000 });
  second.record({ at: 410_000, bytes: 300, pid: 123 });
  assert.deepEqual(second.boots(), [
    { boot: 1_000, first_bytes: 100, peak_bytes: 900, peak_uptime_ms: 100_000 },
    { boot: 400_000, first_bytes: 300, peak_bytes: 300, peak_uptime_ms: 10_000 },
  ]);
  const read = readDaemonFootprint("/s", io.readFile) as { boots: BootGrowth[] };
  assert.equal(read.boots.length, 2, "a reader in another process sees both");

  assert.equal(BOOT_GROWTH_RETAIN_MS, HEAP_SAMPLE_RETAIN_MS, "the window the heap-ceiling learning already uses");
  // Past the heap-ceiling learning's window, an old generation is dropped and the current one never.
  const week = 7 * 24 * 60 * 60_000;
  second.record({ at: 1_000 + week + 1, bytes: 400, pid: 123 });
  assert.deepEqual(second.boots().map((b) => b.boot), [400_000]);

  failWrite = true;
  assert.deepEqual(second.record({ at: 1_000 + week + 2, bytes: 400, pid: 123 }), { persisted: false, reason: "ENOSPC" });

  assert.deepEqual(parseBootGrowth("{torn"), { unread: "unparseable" });
  assert.deepEqual(parseBootGrowth(JSON.stringify({ samples: [], boots: "x" })), { unread: "boots is not an array" });
  assert.deepEqual(parseBootGrowth(JSON.stringify({ samples: [] })), [], "a file from before the record holds none");
  files.set("/s/daemon-footprint.json", JSON.stringify({ samples: [], boots: {} }));
  assert.deepEqual(readDaemonFootprint("/s", io.readFile), { unread: "boots is not an array" });
});
