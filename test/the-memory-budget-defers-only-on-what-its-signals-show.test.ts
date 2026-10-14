/**
 * The container-ceiling arm judges the projected working set against memory.high, and defers outright while the
 * container is at its ceiling now (a crossing of its memory.high within the minute, with its own tasks stalled). It
 * learns no onset below memory.high from a crossing, and the host swap-in arm counts only while the instance's own
 * history shows swap-in followed by stall.
 *
 * MEASURED 2026-10-11 18:15Z-10-12 02:57Z on the core instance (1,283 memory_budget.shadow rows, after #10907):
 * - the 12 crossings were stamped at SAMPLED working sets of 2379-3589 MiB although a crossing means usage reached the
 *   8379 MiB memory.high between two verdicts; learning the lowest of them put the container arm on 77% of the night's
 *   rows (15% before the first). The projection at those sightings (median 6790 MiB) was spread like every row's (6705 MiB).
 * - verdicts with host swap-in past 256 pages/s were followed by host stall within 5 min at 0.95-1.02x the rate of all
 *   verdicts; swap-in alone deferred 371 starts. Replayed, the two changes take would-defer from 84% to 35% with every
 *   stalled row still deferred.
 * Each case asserts a field or reason only the new rules produce.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { fixedClock } from "../src/lib/clock.js";
import type { HostMemoryReading } from "../src/lib/host-memory-ledger.js";
import {
  CONTAINER_PRESSURE_FILE,
  SWAP_STALL_HISTORY_MS,
  SWAP_STALL_MIN_SAMPLES,
  SWAP_STALL_WINDOW_MS,
  evaluateShadowMemory,
  recordShadowMemoryVerdict,
  resetShadowMemoryStateForTests,
  swapStallRelationOf,
  type ContainerPressureInput,
  type HostMemoryBudgetPolicy,
  type ShadowEntryInput,
  type ShadowInputs,
  type ShadowMemoryPorts,
  type SwapStallSample,
} from "../src/lib/host-memory-shadow.js";
import type { LedgerLine } from "../src/lib/ledger.js";

const NOW = Date.parse("2026-10-11T19:44:00.000Z");
const MIB = 1024 * 1024;
const ROOT = "/home/node/Remudero";
const STORE = `${ROOT}/state/${CONTAINER_PRESSURE_FILE}`;
const MINUTE = 60_000;

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

const CALM: ContainerPressureInput = { swapIn: { pagesPerSec: 14.8 }, psi: { someAvg10: 0, fullAvg10: 0 }, ceilingCrossings: 0 };

// Working set 4800, projected 4800 + (295 typical + 729 tail) + 2544 daemon growth = 8368 against memory.high 8379.
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

test("the container arm judges the projection against memory.high, and the static reserve only when pressure is unread", () => {
  const calm = evaluateShadowMemory(inputs(CALM), POLICY);
  assert.equal(calm.numbers.containerProjectedMib, 4800 + 295 + 729 + 2544);
  assert.equal(calm.numbers.containerOnsetMib, 8379);
  assert.equal(calm.numbers.containerOnsetBasis, "memory.high");
  assert.deepEqual(calm.reasons, []);

  const over = evaluateShadowMemory(inputs(CALM, { container: { currentMib: 6500, maxMib: 8820, highMib: 8379, reclaimableMib: 1583 } }), POLICY);
  assert.deepEqual(over.reasons, ["container-ceiling"], "a projection past memory.high defers");

  const unread = evaluateShadowMemory(inputs({ unread: "EACCES" }), POLICY);
  assert.deepEqual(unread.reasons, ["container-ceiling"]);
  assert.equal(unread.numbers.containerOnsetMib, 8379 - 1024);
  assert.equal(unread.numbers.containerOnsetBasis, "static reserve 1024 MiB: pressure unread");
  assert.ok(unread.uncertainty.some((u) => u.kind === "container-pressure-unread"), "named");
  assert.deepEqual(evaluateShadowMemory(inputs(undefined), POLICY).reasons, ["container-ceiling"]);
  const neither = evaluateShadowMemory(inputs({ swapIn: { unmeasured: "no prior sample in this instance" },
    psi: { unread: "ENOENT" }, ceilingCrossings: null }), POLICY);
  assert.deepEqual(neither.reasons, ["container-ceiling"], "neither signal measured: nothing says it is calm");
});

test("a crossing sampled far below memory.high defers while it lasts but never lowers the container's onset", () => {
  // The 19:44:00Z row: a crossing within the minute, the container's own PSI at 5.15/4.31, sampled at 3539 MiB.
  const small = { currentMib: 4849, maxMib: 8820, highMib: 8379, reclaimableMib: 1310 };
  const atCeiling = evaluateShadowMemory(inputs({ ...CALM, psi: { someAvg10: 5.15, fullAvg10: 4.31 }, ceilingCrossings: 41 },
    { container: small, entries: [], start: { workerClass: "review", estimateMib: 1024 }, daemonGrowth: [] }), POLICY);
  assert.equal(atCeiling.numbers.containerSighted, true);
  assert.equal(atCeiling.numbers.containerOnsetMib, 8379, "the crossing proves usage reached memory.high, not 3539 MiB");
  assert.equal(atCeiling.numbers.containerOnsetBasis, "at its ceiling now: memory.high crossed within the minute while its tasks stall");
  assert.ok(atCeiling.numbers.containerProjectedMib! < 8379, "its projection fits");
  assert.ok(atCeiling.reasons.includes("container-ceiling"), "and it still defers while the container is at its ceiling");

  // A minute on, with no new crossing, the same container is judged against memory.high again.
  const after = evaluateShadowMemory(inputs(CALM, { container: small, entries: [], start: { workerClass: "review", estimateMib: 1024 }, daemonGrowth: [] }), POLICY);
  assert.equal(after.numbers.containerOnsetMib, 8379);
  assert.deepEqual(after.reasons, []);

  // The container's own swap-in with no crossing is the host's reclaim; a crossing with no stall is page cache.
  const hostReclaim = evaluateShadowMemory(inputs({ ...CALM, swapIn: { pagesPerSec: 1295.9 }, ceilingCrossings: 0 }), POLICY);
  assert.equal(hostReclaim.numbers.containerPressed, true);
  assert.equal(hostReclaim.numbers.containerSighted, false);
  assert.ok(!hostReclaim.reasons.includes("container-ceiling"));
  const cacheOnly = evaluateShadowMemory(inputs({ ...CALM, ceilingCrossings: 300 }), POLICY);
  assert.equal(cacheOnly.numbers.containerSighted, false);
  assert.deepEqual(cacheOnly.reasons, []);
});

/** A verdict every 20 s from `from` for `count` verdicts, at `rate` pages/s, stalled where `stalled(i)` says. */
function history(from: number, count: number, rate: (i: number) => number | null, stalled: (i: number) => boolean): SwapStallSample[] {
  return Array.from({ length: count }, (_, i) => ({ at: from + i * 20_000, pagesPerSec: rate(i), stalled: stalled(i) }));
}

test("the swap-in relation compares stall after swap-in with stall after any verdict, over closed windows only", () => {
  const start = NOW - 2 * 60 * MINUTE;
  // Churn: swap-in on every other verdict, a stall every 30th verdict regardless of it.
  const churn = history(start, 360, (i) => (i % 2 ? 1200 : 40), (i) => i % 30 === 0);
  const r = swapStallRelationOf(churn, NOW, POLICY);
  assert.ok("samples" in r);
  assert.ok(Math.abs(r.afterSwapIn - r.afterAny) <= r.noise, `no lift beyond noise: ${JSON.stringify(r)}`);
  // Windows not yet closed are left out: verdicts in the last 5 min do not count.
  assert.equal(r.samples, churn.filter((s) => s.pagesPerSec! > 256 && NOW - s.at >= SWAP_STALL_WINDOW_MS).length);

  // Predictive: a burst of five swap-in verdicts every 30 min, then a stall; nothing else stalls.
  const predictive = history(NOW - 1000 * 20_000, 1000, (i) => (i % 90 < 5 ? 1200 : 40), (i) => i % 90 === 6);
  const p = swapStallRelationOf(predictive, NOW, POLICY);
  assert.ok("samples" in p && p.afterSwapIn - p.afterAny > p.noise, JSON.stringify(p));

  // Too few swap-in verdicts with a closed window: unlearned, and it says how many it has.
  const few = swapStallRelationOf(history(start, 40, (i) => (i < SWAP_STALL_MIN_SAMPLES - 1 ? 1200 : 40), () => false), NOW, POLICY);
  assert.deepEqual(few, { unlearned: `${SWAP_STALL_MIN_SAMPLES - 1} of ${SWAP_STALL_MIN_SAMPLES} verdicts with swap-in past 256 pages/s and a closed window` });
  // Older than the history: forgotten.
  const old = swapStallRelationOf(history(NOW - SWAP_STALL_HISTORY_MS - 3 * 60 * MINUTE, 360, () => 1200, () => true), NOW, POLICY);
  assert.ok("unlearned" in old);
});

test("swap-in past its threshold defers only while it predicts stall, and on the rate alone until that is learned", () => {
  const swapping = { swapIn: { pagesPerSec: 1245 } };
  const unlearned = evaluateShadowMemory(inputs(CALM, swapping), POLICY);
  assert.deepEqual(unlearned.reasons, ["swap-in"], "no history: the rate alone, as before");
  assert.equal(unlearned.numbers.swapInBasis, "the rate alone: no swap-in history read");

  const churn = { samples: 600, afterSwapIn: 0.48, afterAny: 0.5, noise: 0.04 };
  const quiet = evaluateShadowMemory(inputs(CALM, { ...swapping, swapStall: churn }), POLICY);
  assert.deepEqual(quiet.reasons, [], "1245 pages/s that has not been followed by stall defers nothing");
  assert.equal(quiet.numbers.swapInPagesPerSec, 1245, "and is still reported");
  assert.equal(quiet.numbers.swapInBasis,
    "swap-in does not predict stall: 48% of 600 swap-in verdicts were followed by one, against 50% of all (noise 4%)");

  const predicts = evaluateShadowMemory(inputs(CALM, { ...swapping, swapStall: { samples: 600, afterSwapIn: 0.8, afterAny: 0.5, noise: 0.04 } }), POLICY);
  assert.deepEqual(predicts.reasons, ["swap-in"]);
  assert.match(String(predicts.numbers.swapInBasis), /^swap-in predicts stall: 80% of 600/);

  // The PSI arm is untouched: a stall now defers whatever swap-in has predicted.
  const stalled = evaluateShadowMemory(inputs(CALM, { ...swapping, swapStall: churn,
    psi: { someAvg10: 17.29, someAvg60: 5, fullAvg10: 14.29, fullAvg60: 4 } }), POLICY);
  assert.deepEqual(stalled.reasons, ["psi"]);
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
type Stored = { prior: Numbers; swap: Array<[number, number | null, number]>; sightings?: unknown };

test("a recorded verdict drops a pre-existing store's low sightings and appends its host reading to the swap-in history", () => {
  resetShadowMemoryStateForTests();
  const rows: LedgerLine[] = [];
  const written: Array<{ path: string; content: string }> = [];
  // The store as #10907 left it overnight: a sighting stamped at 2379 MiB, and the previous verdict 20 s ago.
  const files = cgroup({
    "/sys/fs/cgroup/memory.pressure": "some avg10=0.00 avg60=0.00 avg300=0.00 total=9\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=9\n",
    [STORE]: JSON.stringify({ prior: { at: NOW - 20_000, pswpin: 417049, high: 22368 },
      sightings: [{ at: NOW - 10 * MINUTE, workingSetMib: 2379 }],
      swap: [[NOW - 30 * MINUTE, 900, 0], [NOW - 29 * MINUTE, null, 1], ["torn", 1, 0], [NOW - 7 * 60 * MINUTE, 50, 0]] }),
  });
  recordShadowMemoryVerdict({ workerClass: "review", reservationId: "start", root: ROOT }, ports(rows, files, written));
  const n = rows.find((r) => r.step === "memory_budget.shadow")!.numbers as Numbers;
  assert.equal(n.containerSwapInPagesPerSec, 200, "4000 pages over 20 s, measured across processes");
  assert.equal(n.containerOnsetMib, 8379, "the stored 2379 MiB sighting no longer holds the onset down");
  assert.equal(n.containerOnsetBasis, "memory.high");
  assert.equal(n.swapInBasis, null, "the host rate is unmeasured on a process's first verdict, so no basis is recorded");
  const stored = JSON.parse(written.at(-1)!.content) as Stored;
  assert.equal(written.at(-1)!.path, STORE);
  assert.deepEqual(stored.prior, { at: NOW, pswpin: 421049, high: 22368 });
  assert.equal(stored.sightings, undefined, "the legacy sightings are dropped");
  assert.deepEqual(stored.swap, [[NOW - 30 * MINUTE, 900, 0], [NOW - 29 * MINUTE, null, 1], [NOW, null, 0]],
    "the torn entry and the one past the history are gone; this verdict is appended (host rate unmeasured, no stall)");

  // The next verdict in the same process measures the host rate and records the stall it reads.
  const later = NOW + 20_000;
  Object.assign(files, {
    "/proc/vmstat": "pswpin 25000100\n",
    "/proc/pressure/memory": "some avg10=17.29 avg60=6.00 avg300=1.00 total=9\nfull avg10=14.29 avg60=4.00 avg300=1.00 total=9\n",
  });
  const next: LedgerLine[] = [];
  recordShadowMemoryVerdict({ workerClass: "review", reservationId: "start", root: ROOT }, ports(next, files, written, later));
  const m = next.find((r) => r.step === "memory_budget.shadow")!.numbers as Numbers;
  assert.equal(m.swapInPagesPerSec, 1_250_000);
  assert.match(String(m.swapInBasis), /^the rate alone: 1 of 30 verdicts with swap-in past 256 pages\/s/);
  const again = JSON.parse(written.at(-1)!.content) as Stored;
  assert.deepEqual(again.swap.at(-1), [later, 1_250_000, 1]);
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
  assert.equal(stale.containerSighted, false, "a stale prior shows no crossing, so the container is not at its ceiling");
  const minuteOld = verdict(cgroup({ [STORE]: JSON.stringify({ prior: { at: NOW - 90_000, pswpin: 1, high: 1 } }) }));
  assert.equal(minuteOld.containerSighted, false, "a crossing older than the PSI window is not tied to this stall");
  assert.ok((minuteOld.containerSwapInPagesPerSec as number) > 0, "while the swap-in rate is still measured over it");

  // Recreated container: its counter restarted below the stored one, so its whole count is new.
  const recreated = verdict(cgroup({ "/sys/fs/cgroup/memory.events": "high 7\n",
    [STORE]: JSON.stringify({ prior: { at: NOW - 20_000, pswpin: 1, high: 22368 }, swap: "x" }) }));
  assert.equal(recreated.containerSighted, true);

  const unwritable = verdict(cgroup({}), () => {
    throw Object.assign(new Error("read-only"), { code: "EROFS" });
  });
  assert.equal(unwritable.containerPressed, true, "the reading stands though nothing could be stored");

  const unread = verdict(cgroup({ "/sys/fs/cgroup/memory.pressure": "garbage", "/sys/fs/cgroup/memory.stat": "anon 1\n",
    "/sys/fs/cgroup/memory.events": "low 0\n" }));
  assert.equal(unread.containerOnsetMib, 8379 - 1024, "nothing of the container's own pressure readable: the static reserve");
});
