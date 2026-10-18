/**
 * The memory budget splits the daemon's growth at the median of the daemon's OWN rolling footprint, which survives a
 * ledger rotation and a daemon restart.
 *
 * MEASURED 2026-10-11 13:07-14:35Z on the core instance (274 memory_budget.shadow rows, after #10855): the split
 * applied on 6 rows. The rest read "all typical: 1-4 daemon sample row(s)": the live ledger rotated every 35-60 min,
 * the daemon restarted about hourly (a new pid filters out the old samples), and daemon.alive came every 3-10 min.
 * The same heartbeats, read across rotations and restarts, numbered at least 8 in the hour before each of the 274.
 * Each verdict case below asserts a field only the footprint produces: the tail it is given holds too few rows.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { fixedClock } from "../src/lib/clock.js";
import {
  DAEMON_FOOTPRINT_FILE,
  FOOTPRINT_MAX_SAMPLES,
  FOOTPRINT_RETAIN_MS,
  createDaemonFootprint,
  daemonFootprintPath,
  installDaemonFootprint,
  parseDaemonFootprint,
  readDaemonFootprint,
} from "../src/lib/daemon-footprint.js";
import type { HostMemoryReading } from "../src/lib/host-memory-ledger.js";
import {
  footprintGrowthOf,
  recordShadowMemoryVerdict,
  resetShadowMemoryStateForTests,
  type HostMemoryBudgetPolicy,
  type ShadowMemoryPorts,
} from "../src/lib/host-memory-shadow.js";
import type { LedgerLine } from "../src/lib/ledger.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const NOW = Date.parse("2026-10-11T14:25:25.688Z");
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

const sample = (agoMs: number, mib: number, pid: number) => ({ at: NOW - agoMs, bytes: mib * MIB, pid });

// The core daemon's rss+swap, MiB, 13:27-14:25Z: pid 1248718 until its 14:01 restart, pid 111 after it.
const FOOTPRINT = [
  sample(3_502_000, 2603, 1248718), sample(3_028_000, 2265, 1248718), sample(2_542_000, 2441, 1248718),
  sample(2_227_000, 2752, 1248718), sample(1_960_000, 2613, 1248718), sample(1_597_000, 2255, 1248718),
  sample(1_215_000, 2142, 111), sample(1_080_000, 2107, 111), sample(757_000, 1834, 111),
  sample(412_000, 2180, 111), sample(223_000, 2206, 111), sample(0, 2039, 111),
];

test("the daemon footprint persists its samples and a restarted daemon reloads the last hour", () => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}footprint-`));
  try {
    const path = daemonFootprintPath(dir);
    assert.equal(path, join(dir, DAEMON_FOOTPRINT_FILE));
    const first = createDaemonFootprint(path); // no file yet: starts empty
    assert.equal(first.samples().length, 0);
    for (const s of FOOTPRINT.slice(0, 6)) assert.deepEqual(first.record(s), { persisted: true });

    // The restart: a new process, a new pid, the same state directory.
    const restarted = createDaemonFootprint(path);
    // W1-T9982: each sample now also names its generation; the readings themselves are what must survive.
    assert.deepEqual(restarted.samples().map(({ boot: _boot, ...reading }) => reading), FOOTPRINT.slice(0, 6), "the previous process's samples survive the restart");
    for (const s of FOOTPRINT.slice(6)) restarted.record(s);
    assert.equal(restarted.samples().length, 12);
    const onDisk = parseDaemonFootprint(readFileSync(path, "utf8"));
    assert.ok(Array.isArray(onDisk) && onDisk.length === 12, "every sample is persisted");

    // A sample past the hour is dropped on the next write; the count is backstopped.
    restarted.record({ at: NOW + FOOTPRINT_RETAIN_MS - 1_000_000, bytes: 2000 * MIB, pid: 111 });
    assert.ok(restarted.samples().every((s) => NOW + FOOTPRINT_RETAIN_MS - 1_000_000 - s.at <= FOOTPRINT_RETAIN_MS));
    assert.ok(restarted.samples().length < 13, "the oldest samples aged out");
    const many = createDaemonFootprint(join(dir, "many.json"));
    for (let i = 0; i < FOOTPRINT_MAX_SAMPLES + 10; i++) many.record({ at: NOW + i * 1000, bytes: MIB, pid: 1 });
    assert.equal(many.samples().length, FOOTPRINT_MAX_SAMPLES);

    // The reader: from the file in another process, from memory in the daemon's own.
    const fromFile = readDaemonFootprint(dir);
    assert.ok("samples" in fromFile && fromFile.source === "file" && fromFile.samples.length === restarted.samples().length);
    installDaemonFootprint(restarted);
    try {
      const fromMemory = readDaemonFootprint(dir, () => {
        throw new Error("the daemon's own process never reads its file");
      });
      assert.ok("samples" in fromMemory && fromMemory.source === "memory");
    } finally {
      installDaemonFootprint(undefined);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a footprint that cannot be loaded, parsed or persisted is named, never read as a flat series", () => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}footprint-`));
  try {
    assert.deepEqual(readDaemonFootprint(dir), { unread: "ENOENT" });
    writeFileSync(daemonFootprintPath(dir), "{\"samples\":");
    assert.deepEqual(readDaemonFootprint(dir), { unread: "unparseable" });
    writeFileSync(daemonFootprintPath(dir), "{\"other\":[]}");
    assert.deepEqual(readDaemonFootprint(dir), { unread: "no samples array" });
    assert.deepEqual(parseDaemonFootprint(JSON.stringify({ samples: [{ at: 1, bytes: 2, pid: 3 }, { at: "x" }, null] })),
      [{ at: 1, bytes: 2, pid: 3 }], "a malformed sample is skipped, the rest kept");

    // An unparseable file starts the daemon empty; a failed persist keeps the sample in memory and says why.
    const store = createDaemonFootprint(daemonFootprintPath(dir), {
      readFile: () => "not json",
      writeFile: () => {
        throw Object.assign(new Error("no space"), { code: "ENOSPC" });
      },
    });
    assert.equal(store.samples().length, 0);
    assert.deepEqual(store.record(FOOTPRINT[0]!), { persisted: false, reason: "ENOSPC" });
    assert.equal(store.samples().length, 1);
    const unwritable = createDaemonFootprint("unused", { readFile: () => "{}", writeFile: () => { throw new Error("disk gone"); } });
    assert.deepEqual(unwritable.record(FOOTPRINT[0]!), { persisted: false, reason: "disk gone" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the footprint split is the median of every sample in the hour, across the restart's two pids", () => {
  const out = footprintGrowthOf([...FOOTPRINT, sample(3_700_000, 9000, 1248718)], NOW, 6);
  assert.equal(out.samples, 12, "the sample older than the hour is left out");
  assert.equal(out.growthMib, 2752 - 2039, "back to the hour's peak");
  // Sorted: 1834 2039 2107 2142 2180 2206 | 2255 2265 2441 2603 2613 2752; median (2206 + 2255) / 2.
  assert.equal(out.typicalMib, (2206 + 2255) / 2 - 2039);
  assert.match(footprintGrowthOf(FOOTPRINT.slice(-3), NOW, 6).reason ?? "", /^3 daemon footprint sample\(s\) in the last hour$/);
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

function ports(rows: LedgerLine[], files: Record<string, string>, tail: string): Partial<ShadowMemoryPorts> {
  const all: Record<string, string> = {
    "/proc/meminfo": "MemTotal: 16371712 kB\nMemAvailable: 10000000 kB\n",
    "/proc/vmstat": "pswpin 100\n",
    "/proc/pressure/memory": "some avg10=0.00 avg60=0.00 avg300=0.00 total=1\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=1\n",
    "/sys/fs/cgroup/memory.current": `${5000 * MIB}\n`,
    "/sys/fs/cgroup/memory.max": `${8820 * MIB}\n`,
    "/sys/fs/cgroup/memory.high": `${8379 * MIB}\n`,
    "/sys/fs/cgroup/memory.stat": "anon 1\ninactive_file 0\n",
    // A fixture status: VmHWM 2752, VmRSS 1700, so 1052 MiB of growth.
    "/proc/111/status": `Name:\tnode\nVmHWM:\t ${2752 * 1024} kB\nVmRSS:\t ${1700 * 1024} kB\nVmSwap:\t 0 kB\n`,
    "/ledger/start.json": JSON.stringify({ roots: [], tree: [] }),
    ...files,
  };
  return {
    clock: fixedClock(NOW),
    readFile: (path) => {
      const text = all[path];
      if (text === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
      return text;
    },
    readTail: () => tail,
    readLedger: () => reading(),
    policy: () => POLICY,
    write: (_path, row) => void rows.push(row),
    stderr: () => undefined,
    instance: () => "state2",
    daemonPid: () => 111,
    listStateDir: () => [],
    estimate: (cls) => (cls === "garden" ? 820 : 1024),
    typical: (cls) => (cls === "garden" ? 90 : 295),
    readReviewDemand: () => ({ state: "present", rows: [], unreadableRows: 0 }),
  };
}

// What the live ledger showed after the 13:41 rotation and the 14:01 restart: two of pid 111's heartbeats.
const SHORT_TAIL = [[223_000, 2206], [0, 2039]].map(([ago, mib]) => JSON.stringify({
  ts: new Date(NOW - ago!).toISOString(), actor_pid: 111, step: "daemon.alive", rss_bytes: mib! * MIB, vm_swap_bytes: 0,
})).join("\n");

type Growth = { growthMib: number; typicalMib?: number; typicalBasis?: string; footprint?: string };

test("a verdict splits the daemon's growth at its footprint's median when the ledger tail holds too few rows", () => {
  resetShadowMemoryStateForTests();
  const rows: LedgerLine[] = [];
  const footprint = { [`${ROOT}/state/${DAEMON_FOOTPRINT_FILE}`]: JSON.stringify({ samples: FOOTPRINT }) };
  recordShadowMemoryVerdict({ workerClass: "garden", reservationId: "start", root: ROOT }, ports(rows, footprint, SHORT_TAIL));
  const row = rows.find((r) => r.step === "memory_budget.shadow")!;
  const growth = (row.daemon_growth as Growth[])[0]!;
  assert.equal(growth.growthMib, 2752 - 1700, "W1-T9972: the footprint's peak less the proc's VmRSS + VmSwap");
  assert.equal(growth.typicalMib, (2206 + 2255) / 2 - 1700, "split at the footprint's median, not left whole");
  assert.equal(growth.typicalBasis, "median of 12 footprint sample(s)");
  assert.equal(growth.footprint, "file: 12 sample(s) in the last hour");
  const numbers = row.numbers as Record<string, number>;
  assert.equal(numbers.daemonGrowthTypicalMib, 530.5);
  assert.equal(numbers.daemonGrowthTailMib, 1052 - 530.5);
  // The garden's tail (730) outranks the daemon's spike (521.5): it is the container's one tail.
  assert.equal(numbers.containerHeadroomMib, 8379 - 5000 - (90 + 730) - 530.5);

  // No footprint yet (the first hour after this ships): the tail is read as before, and the store's absence is named.
  resetShadowMemoryStateForTests();
  const none: LedgerLine[] = [];
  recordShadowMemoryVerdict({ workerClass: "garden", reservationId: "start", root: ROOT }, ports(none, {}, SHORT_TAIL));
  const whole = (none[0]!.daemon_growth as Growth[])[0]!;
  assert.equal(whole.typicalMib, undefined);
  assert.equal(whole.typicalBasis, "all typical: 2 daemon sample row(s) in the last hour");
  assert.equal(whole.footprint, "unread: ENOENT");
});

test("with no daemon pid, the daemon's growth itself comes from the footprint", () => {
  resetShadowMemoryStateForTests();
  const rows: LedgerLine[] = [];
  const footprint = { [`${ROOT}/state/${DAEMON_FOOTPRINT_FILE}`]: JSON.stringify({ samples: FOOTPRINT }) };
  recordShadowMemoryVerdict({ workerClass: "garden", reservationId: "start", root: ROOT },
    { ...ports(rows, footprint, ""), daemonPid: () => undefined });
  const growth = (rows[0]!.daemon_growth as Array<Growth & { basis?: string; samples: number }>)[0]!;
  assert.equal(growth.basis, "daemon footprint");
  assert.equal(growth.samples, 12);
  assert.equal(growth.growthMib, 2752 - 2039);
});
