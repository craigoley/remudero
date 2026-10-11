/**
 * The container-ceiling arm judges the projected working set against the LEARNED PRESSURE ONSET: the working set at
 * which this container last hit pressure at its own ceiling, decaying back to memory.high. It no longer defers on a
 * fixed 1024 MiB reserve below memory.high whenever the container's pressure can be read.
 *
 * MEASURED 2026-10-11 13:07-14:35Z on the core instance (274 memory_budget.shadow rows): 186 would have deferred (68%),
 * 127 of them on container-ceiling, and only 49 of those 127 came with real pressure (the row's own swap-in or PSI past
 * the policy thresholds). In the same rows the projected working set never came true above memory.high: the kernel
 * reclaims there. In a 30 s cgroup sampler (14:54-15:00Z) the container swapped in at 3.5-4.6 GiB of working set with no
 * crossing of its 8379 MiB memory.high: the host's reclaim, not its ceiling.
 * Each case asserts a field or reason only the learned onset produces.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { fixedClock } from "../src/lib/clock.js";
import type { HostMemoryReading } from "../src/lib/host-memory-ledger.js";
import {
  CONTAINER_PRESSURE_FILE,
  ONSET_HALF_LIFE_MS,
  evaluateShadowMemory,
  recordShadowMemoryVerdict,
  resetShadowMemoryStateForTests,
  type ContainerPressureInput,
  type HostMemoryBudgetPolicy,
  type ShadowEntryInput,
  type ShadowInputs,
  type ShadowMemoryPorts,
} from "../src/lib/host-memory-shadow.js";
import type { LedgerLine } from "../src/lib/ledger.js";

const NOW = Date.parse("2026-10-11T13:33:42.000Z");
const MIB = 1024 * 1024;
const ROOT = "/home/node/Remudero";
const STORE = `${ROOT}/state/${CONTAINER_PRESSURE_FILE}`;

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
    id, owner: "state2@c1", workerClass: "review", estimateMib: 1024, typicalMib: 295,
    estimateSource: { kind: "measured", samples: 40 }, status: "owned", walkComplete: true,
    resident: { mib: 0, complete: true }, ...over,
  };
}

const CALM: ContainerPressureInput = { swapIn: { pagesPerSec: 14.8 }, psi: { someAvg10: 0, fullAvg10: 0 }, ceilingCrossings: 0, onsets: [] };

// The 13:33:42Z review row: working set 4800, projected 8368 against memory.high 8379, recorded as container-ceiling
// with no swap-in or PSI past its threshold.
function inputs(containerPressure: ContainerPressureInput | undefined, over: Partial<ShadowInputs> = {}): ShadowInputs {
  return {
    memAvailable: { mib: 10_886 },
    swapIn: { pagesPerSec: 14.8 },
    psi: { someAvg10: 0, someAvg60: 0, fullAvg10: 0, fullAvg60: 0 },
    container: { currentMib: 6383, maxMib: 8820, highMib: 8379, reclaimableMib: 1583 },
    ledger: { state: "present" },
    entries: [tree("start")],
    start: { reservationId: "start", workerClass: "review", estimateMib: 1024 },
    daemonGrowth: [{ instance: "state2", samples: 1, growthMib: 2544, own: true }],
    serve: { scenario: "serve-stopped", basis: "test" },
    ...(containerPressure ? { containerPressure } : {}),
    ...over,
  };
}

test("with no pressure seen at its ceiling, the container arm defers only past memory.high", () => {
  const calm = evaluateShadowMemory(inputs(CALM), POLICY);
  // Projected: 4800 working set + (295 typical + 729 tail) + 2544 daemon growth = 8368.
  assert.equal(calm.numbers.containerProjectedMib, 4800 + 295 + 729 + 2544);
  assert.equal(calm.numbers.containerOnsetMib, 8379, "the onset is memory.high itself");
  assert.equal(calm.numbers.containerOnsetBasis, "no pressure seen: the ceiling");
  assert.deepEqual(calm.reasons, [], "8368 sits under 8379: no longer read against 8379 - 1024");

  const over = evaluateShadowMemory(inputs(CALM, { container: { currentMib: 6500, maxMib: 8820, highMib: 8379, reclaimableMib: 1583 } }), POLICY);
  assert.deepEqual(over.reasons, ["container-ceiling"], "a projection past memory.high still defers");

  // The static reserve is the tier for a container whose pressure cannot be read, and for a pure caller.
  const unread = evaluateShadowMemory(inputs({ unread: "EACCES" }), POLICY);
  assert.deepEqual(unread.reasons, ["container-ceiling"]);
  assert.equal(unread.numbers.containerOnsetMib, 8379 - 1024);
  assert.equal(unread.numbers.containerOnsetBasis, "static reserve 1024 MiB: pressure unread");
  assert.ok(unread.uncertainty.some((u) => u.kind === "container-pressure-unread"), "named");
  assert.deepEqual(evaluateShadowMemory(inputs(undefined), POLICY).reasons, ["container-ceiling"]);
  const neither = evaluateShadowMemory(inputs({ swapIn: { unmeasured: "no prior sample in this instance" },
    psi: { unread: "ENOENT" }, ceilingCrossings: null, onsets: [] }), POLICY);
  assert.deepEqual(neither.reasons, ["container-ceiling"], "neither signal measured: nothing says it is calm");
});

test("a sighting at the ceiling lowers the onset to its working set, and the onset decays back to memory.high", () => {
  const fresh = evaluateShadowMemory(inputs({ ...CALM, onsets: [{ workingSetMib: 6188, ageMs: 0 }] }), POLICY);
  assert.equal(fresh.numbers.containerOnsetMib, 6188);
  assert.deepEqual(fresh.reasons, ["container-ceiling"], "8368 projected is past the 6188 MiB where it stalled");
  assert.equal(fresh.numbers.containerOnsetBasis, "learned from 1 sighting(s); lowest: 6188 MiB, 0 min ago");

  const hourOld = evaluateShadowMemory(inputs({ ...CALM, onsets: [{ workingSetMib: 6188, ageMs: ONSET_HALF_LIFE_MS }] }), POLICY);
  assert.equal(hourOld.numbers.containerOnsetMib, 8379 - (8379 - 6188) / 2, "the gap halves each half-life");
  const old = evaluateShadowMemory(inputs({ ...CALM, onsets: [{ workingSetMib: 6188, ageMs: 8 * ONSET_HALF_LIFE_MS }] }), POLICY);
  assert.ok(old.numbers.containerOnsetMib! > 8368, `eight half-lives on, 8368 fits again: ${old.numbers.containerOnsetMib}`);
  assert.deepEqual(old.reasons, []);

  // The lowest of several sightings decides; a sighting above the ceiling sits at it.
  const several = evaluateShadowMemory(inputs({ ...CALM, onsets: [
    { workingSetMib: 9000, ageMs: 0 }, { workingSetMib: 7000, ageMs: 0 }, { workingSetMib: 6000, ageMs: 2 * ONSET_HALF_LIFE_MS },
  ] }), POLICY);
  assert.equal(several.numbers.containerOnsetMib, 7000);
});

test("pressure counts as a sighting only with a crossing of the container's own memory.high", () => {
  // The container's own swap-in at 1295 pages/s, as at 14:57:06Z, with no crossing: the host's reclaim, not the ceiling.
  const hostReclaim = evaluateShadowMemory(inputs({ ...CALM, swapIn: { pagesPerSec: 1295.9 }, ceilingCrossings: 0 }), POLICY);
  assert.equal(hostReclaim.numbers.containerPressed, true);
  assert.equal(hostReclaim.numbers.containerSighted, false);
  assert.equal(hostReclaim.numbers.containerOnsetMib, 8379);
  assert.ok(!hostReclaim.reasons.includes("container-ceiling"));

  // The same pressure with the cgroup crossing memory.high: this snapshot's working set is the onset, at age zero.
  const atCeiling = evaluateShadowMemory(inputs({ ...CALM, psi: { someAvg10: 17.37, fullAvg10: 12.95 }, ceilingCrossings: 41 }), POLICY);
  assert.equal(atCeiling.numbers.containerSighted, true);
  assert.equal(atCeiling.numbers.containerOnsetMib, 4800);
  assert.deepEqual(atCeiling.reasons, ["container-ceiling"]);
  assert.deepEqual(atCeiling.numbers.containerPsi, { someAvg10: 17.37, fullAvg10: 12.95 });

  // A crossing with no stall is page cache reclaimed at the ceiling: no sighting.
  const cacheOnly = evaluateShadowMemory(inputs({ ...CALM, ceilingCrossings: 300 }), POLICY);
  assert.equal(cacheOnly.numbers.containerSighted, false);
  assert.deepEqual(cacheOnly.reasons, []);
});

function reading(): HostMemoryReading {
  return {
    state: "present", scope: "host", dir: "/ledger",
    entries: [{ id: "start", owner: "state2@c1", workerClass: "review", estimateMib: 1024,
      estimateSource: { kind: "measured", samples: 40 }, status: "owned", ageMs: 1000, sinceVerifiedMs: 1000,
      walkComplete: true, path: "/ledger/start.json" }],
    counts: { live: 1, uncertain: 0, incompleteWalk: 0, localScope: 0, unreadable: 0 },
    reservedMib: 1024,
  };
}

function ports(rows: LedgerLine[], files: Record<string, string>, written: Array<{ path: string; content: string }>, now = NOW): Partial<ShadowMemoryPorts> {
  return {
    clock: fixedClock(now),
    readFile: (path) => {
      const text = files[path];
      if (text === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
      return text;
    },
    readTail: () => "",
    readLedger: () => reading(),
    policy: () => POLICY,
    write: (_path, row) => void rows.push(row),
    writeFile: (path, content) => {
      written.push({ path, content });
      files[path] = content;
    },
    stderr: () => undefined,
    instance: () => "state2",
    daemonPid: () => undefined,
    listStateDir: () => [],
    estimate: () => 1024,
    typical: () => 295,
    readReviewDemand: () => ({ state: "present", rows: [], unreadableRows: 0 }),
  };
}

function cgroup(over: Record<string, string>): Record<string, string> {
  return {
    "/proc/meminfo": "MemTotal: 16371712 kB\nMemAvailable: 10000000 kB\n",
    "/proc/vmstat": "pswpin 100\n",
    "/proc/pressure/memory": "some avg10=0.00 avg60=0.00 avg300=0.00 total=1\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=1\n",
    "/sys/fs/cgroup/memory.current": `${6383 * MIB}\n`,
    "/sys/fs/cgroup/memory.max": `${8820 * MIB}\n`,
    "/sys/fs/cgroup/memory.high": `${8379 * MIB}\n`,
    "/sys/fs/cgroup/memory.stat": `anon 1\ninactive_file ${1583 * MIB}\npswpin 421049\n`,
    "/sys/fs/cgroup/memory.events": "low 0\nhigh 22368\nmax 0\noom 0\noom_kill 0\n",
    "/sys/fs/cgroup/memory.pressure": "some avg10=17.37 avg60=6.00 avg300=1.00 total=9\nfull avg10=12.95 avg60=4.00 avg300=1.00 total=9\n",
    "/ledger/start.json": JSON.stringify({ roots: [], tree: [] }),
    ...over,
  };
}

type Numbers = Record<string, unknown>;

test("a recorded verdict reads the container's own pressure and stores a ceiling sighting for the next verdict", () => {
  resetShadowMemoryStateForTests();
  const rows: LedgerLine[] = [];
  const written: Array<{ path: string; content: string }> = [];
  // The previous verdict, 20 s ago in another process of the instance: 1094 crossings and 4000 pages swapped in since.
  const files = cgroup({ [STORE]: JSON.stringify({ prior: { at: NOW - 20_000, pswpin: 417049, high: 21274 }, sightings: [] }) });
  recordShadowMemoryVerdict({ workerClass: "review", reservationId: "start", root: ROOT }, ports(rows, files, written));
  const n = rows.find((r) => r.step === "memory_budget.shadow")!.numbers as Numbers;
  assert.equal(n.containerSwapInPagesPerSec, 200, "4000 pages over 20 s, measured across processes");
  assert.equal(n.containerSighted, true);
  assert.equal(n.containerOnsetMib, 4800, "the sighting in this snapshot is its own onset");
  const stored = JSON.parse(written.at(-1)!.content) as { prior: Numbers; sightings: Array<{ at: number; workingSetMib: number }> };
  assert.equal(written.at(-1)!.path, STORE);
  assert.deepEqual(stored.prior, { at: NOW, pswpin: 421049, high: 22368 });
  assert.deepEqual(stored.sightings, [{ at: NOW, workingSetMib: 4800 }]);

  // Half an hour later, calm and with no new crossing: the stored sighting still holds the onset down, decayed.
  const later = NOW + ONSET_HALF_LIFE_MS / 2;
  Object.assign(files, {
    "/sys/fs/cgroup/memory.pressure": "some avg10=0.00 avg60=0.00 avg300=0.00 total=9\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=9\n",
    [STORE]: JSON.stringify({ ...stored, prior: { at: later - 20_000, pswpin: 421049, high: 22368 } }),
  });
  const next: LedgerLine[] = [];
  recordShadowMemoryVerdict({ workerClass: "review", reservationId: "start", root: ROOT }, ports(next, files, written, later));
  const m = next.find((r) => r.step === "memory_budget.shadow")!.numbers as Numbers;
  assert.equal(m.containerSighted, false);
  assert.equal(m.containerOnsetMib, 8379 - (8379 - 4800) * 2 ** -0.5);
  assert.match(String(m.containerOnsetBasis), /^learned from 1 sighting\(s\); lowest: 4800 MiB, 30 min ago$/);
});

test("a missing, torn or stale store measures no rate and no crossing, and an unwritable one still judges", () => {
  resetShadowMemoryStateForTests();
  const verdict = (files: Record<string, string>, writeFile?: ShadowMemoryPorts["writeFile"]): Numbers => {
    const rows: LedgerLine[] = [];
    const written: Array<{ path: string; content: string }> = [];
    recordShadowMemoryVerdict({ workerClass: "review", reservationId: "start", root: ROOT },
      { ...ports(rows, files, written), ...(writeFile ? { writeFile } : {}) });
    return rows.find((r) => r.step === "memory_budget.shadow")!.numbers as Numbers;
  };
  const calmPsi = { "/sys/fs/cgroup/memory.pressure": "some avg10=0.00 avg60=0.00 avg300=0.00 total=9\n" };
  const first = verdict(cgroup({ ...calmPsi }));
  assert.equal(first.containerSwapInPagesPerSec, null, "no prior sample: no rate");
  assert.equal(first.containerOnsetMib, 8379, "memory.pressure read and calm: the ceiling");

  const torn = verdict(cgroup({ ...calmPsi, [STORE]: "{\"prior\":" }));
  assert.equal(torn.containerSwapInPagesPerSec, null);
  const stale = verdict(cgroup({ [STORE]: JSON.stringify({ prior: { at: NOW - 3_600_000, pswpin: 1, high: 1 } }) }));
  assert.equal(stale.containerSighted, false, "a stale prior shows no crossing, so the pressure is not placed");

  // Recreated container: its counter restarted below the stored one, so its whole count is new.
  const recreated = verdict(cgroup({ "/sys/fs/cgroup/memory.events": "high 7\n",
    [STORE]: JSON.stringify({ prior: { at: NOW - 20_000, pswpin: 1, high: 22368 }, sightings: [{ at: "x" }] }) }));
  assert.equal(recreated.containerSighted, true);

  const unwritable = verdict(cgroup({}), () => {
    throw Object.assign(new Error("read-only"), { code: "EROFS" });
  });
  assert.equal(unwritable.containerPressed, true, "the reading stands though nothing could be stored");

  const unread = verdict(cgroup({ "/sys/fs/cgroup/memory.pressure": "garbage", "/sys/fs/cgroup/memory.stat": "anon 1\n",
    "/sys/fs/cgroup/memory.events": "low 0\n" }));
  assert.equal(unread.containerOnsetMib, 8379 - 1024, "nothing of the container's own pressure readable: the static reserve");
});
