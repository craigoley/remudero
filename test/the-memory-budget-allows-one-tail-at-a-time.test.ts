/**
 * The container check counts each live tree's TYPICAL remaining growth and ONE tail above it, not every tree's p90 at once.
 *
 * MEASURED 2026-10-10 22:04-22:51Z on the core instance, after #10730: 121 of 138 shadow verdicts (88%) would have
 * deferred, 120 of them on the container ceiling, at a median headroom of -759 MiB against the 1024 MiB reserve, while
 * swap-in or PSI showed real pressure in only 19 rows. The check summed every live tree's not-yet-reached p90 claim (a
 * median 4.0 GB across about five reservations) as if all of them peaked together. Learned peaks then: implement p90
 * 1367 / median 296 MiB, garden 562-687 / 75-87, advisory 287 / 272.
 * Each case asserts a verdict field only the one-tail rule, the learned median, or the nested-tree count produces.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { fixedClock } from "../src/lib/clock.js";
import { DEFAULT_ESTIMATE_MIB, type HostMemoryReading, type ReadingEntry } from "../src/lib/host-memory-ledger.js";
import { classEstimate, classTypical, resetLearnedEstimateCacheForTests } from "../src/lib/host-memory-learning.js";
import {
  evaluateShadowMemory,
  recordShadowMemoryVerdict,
  resetShadowMemoryStateForTests,
  residentsOf,
  type HostMemoryBudgetPolicy,
  type ShadowEntryInput,
  type ShadowInputs,
  type ShadowMemoryPorts,
} from "../src/lib/host-memory-shadow.js";
import type { LedgerLine } from "../src/lib/ledger.js";

const NOW = Date.parse("2026-10-10T22:30:00.000Z");
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

function entry(id: string, over: Partial<ShadowEntryInput> = {}): ShadowEntryInput {
  return {
    id, owner: "state2@c1", workerClass: "garden", estimateMib: 687, typicalMib: 87,
    estimateSource: { kind: "measured", samples: 73 }, status: "owned", walkComplete: true,
    resident: { mib: 0, complete: true }, ...over,
  };
}

/** The core container's shape at 22:2xZ: memory.high 8379 MiB, a 4500 MiB working set, an implement start beside two
 *  gardens and an advisory worker, every tree just started. */
function inputs(entries: ShadowEntryInput[], over: Partial<ShadowInputs> = {}): ShadowInputs {
  return {
    memAvailable: { mib: 9200 },
    swapIn: { pagesPerSec: 0 },
    psi: { someAvg10: 0, someAvg60: 0, fullAvg10: 0, fullAvg60: 0 },
    container: { currentMib: 4500, maxMib: 8820, highMib: 8379 },
    ledger: { state: "present" },
    entries,
    start: { reservationId: "impl", workerClass: "implement", estimateMib: 1367 },
    daemonGrowth: [{ instance: "state2", samples: 1, growthMib: 0, own: true }],
    serve: { scenario: "serve-stopped", basis: "test" },
    ...over,
  };
}

const FOUR = (): ShadowEntryInput[] => [
  entry("impl", { workerClass: "implement", estimateMib: 1367, typicalMib: 296, estimateSource: { kind: "measured", samples: 15 } }),
  entry("g1"),
  entry("g2"),
  entry("adv", { workerClass: "advisory", estimateMib: 295, typicalMib: 272, estimateSource: { kind: "measured", samples: 16 } }),
];

test("the container claim sums each tree's typical growth and allows only the largest tail above it", () => {
  const verdict = evaluateShadowMemory(inputs(FOUR()), POLICY);
  // Every p90 at once: 1367 + 687 + 687 + 295 = 3036, headroom 8379 - 4500 - 3036 = 843 < 1024.
  assert.equal(verdict.numbers.unrealizedOwnContainerMib, 3036, "the p90 sum is still reported");
  assert.equal(verdict.numbers.containerHeadroomAllPeaksMib, 843, "every tree at its p90 together would not fit");
  // Typical: 296 + 87 + 87 + 272 = 742; the largest single tail is the implement's 1367 - 296 = 1071.
  assert.equal(verdict.numbers.containerTypicalMib, 742);
  assert.equal(verdict.numbers.containerTailMib, 1071, "ONE tail: the implement's, not the gardens' 600 each as well");
  assert.equal(verdict.numbers.containerClaimMib, 1813);
  assert.equal(verdict.numbers.containerHeadroomMib, 8379 - 4500 - 1813);
  assert.ok(!verdict.reasons.includes("container-ceiling"), `typical growth plus one spike fits: ${verdict.reasons.join(",")}`);
  assert.equal(verdict.wouldAdmit, true);

  // The host check is unchanged: it still sums the p90 claims (9200 - 3036 = 6164 is above the 2048 reserve anyway).
  assert.equal(verdict.numbers.unrealizedMib, 3036);
  assert.deepEqual(verdict.claims.map((c) => [c.workerClass, c.estimateMib, c.typicalMib, c.residentMib, c.own]), [
    ["implement", 1367, 296, 0, true], ["garden", 687, 87, 0, true], ["garden", 687, 87, 0, true], ["advisory", 295, 272, 0, true],
  ], "each claim is in the row, so a later rule can be replayed over it");
});

test("a tree past its typical keeps only the rest of its tail, and an unmeasured class claims its whole estimate", () => {
  const verdict = evaluateShadowMemory(inputs([
    // 800 MiB resident: past its 296 median, so it has no typical growth left and only 1367 - 800 = 567 of tail.
    entry("impl", { workerClass: "implement", estimateMib: 1367, typicalMib: 296, resident: { mib: 800, complete: true } }),
    // Past its p90 already: nothing more to claim.
    entry("g1", { resident: { mib: 900, complete: true } }),
    // No learned median: its whole estimate is typical, and it adds no tail.
    entry("u1", { workerClass: "unclassified", estimateMib: 2048, typicalMib: undefined, estimateSource: { kind: "default-unmeasured" } }),
    // Finished: claims nothing.
    entry("g2", { occupancyReleased: true }),
  ], { container: { currentMib: 3000, maxMib: 8820, highMib: 8379 } }), POLICY);
  assert.equal(verdict.numbers.containerTypicalMib, 2048);
  assert.equal(verdict.numbers.containerTailMib, 567);
  assert.equal(verdict.numbers.containerClaimMib, 2615);
  assert.equal(verdict.numbers.unrealizedOwnContainerMib, 567 + 2048);
});

test("only this container's trees count against its ceiling, and a start the ledger cannot show still claims", () => {
  const verdict = evaluateShadowMemory(inputs([
    entry("g1"),
    // Another container's implement: its tail is not this container's to hold.
    entry("other", { workerClass: "implement", estimateMib: 1367, typicalMib: 296, status: "owner-verified", owner: "state3@c9" }),
  ], { start: { reservationId: "missing", workerClass: "review", estimateMib: 484, typicalMib: 288 } }), POLICY);
  // garden 87 typical + review start 288 typical; one tail: max(600, 196) = 600.
  assert.equal(verdict.numbers.containerTypicalMib, 87 + 288);
  assert.equal(verdict.numbers.containerTailMib, 600);
  assert.equal(verdict.numbers.unrealizedMib, 687 + 1367 + 484, "the host check counts every tree's p90, the other container's too");
  assert.equal(verdict.claims.at(-1)!.workerClass, "review", "the unrecorded start is listed last");
});

test("the typical peak is the learned median of the same samples the estimate is drawn from", () => {
  resetLearnedEstimateCacheForTests();
  // 15 implement trees: 12 at about 300 MiB, three test-heavy ones near 1.4-4.2 GB.
  const peaks = [290, 292, 294, 295, 296, 297, 298, 299, 300, 310, 320, 330, 1367, 1761, 4244];
  const lines = peaks.map((p) => `{"c":"implement","p":${p},"at":"${new Date(NOW - 60_000).toISOString()}"}\n`).join("");
  const store = { list: () => ["state2.ndjson"], readTail: () => lines, clock: fixedClock(NOW) };
  const estimate = classEstimate("implement", store);
  const typical = classTypical("implement", store);
  assert.equal(estimate.samples, 15);
  assert.equal(typical.samples, 15);
  assert.ok(estimate.estimateMib >= 1367, `the p90 reaches the spikes: ${estimate.estimateMib}`);
  assert.ok(typical.estimateMib >= 296 && typical.estimateMib <= 310, `the median is a typical tree: ${typical.estimateMib}`);

  resetLearnedEstimateCacheForTests();
  const empty = { list: () => [] as string[], clock: fixedClock(NOW) };
  assert.deepEqual(classTypical("garden", empty), { estimateMib: DEFAULT_ESTIMATE_MIB.garden, samples: 0 },
    "with no samples the typical IS the prior, so an unmeasured class has no tail");
});

function reading(entries: Array<Partial<ReadingEntry>>): HostMemoryReading {
  const full = entries.map((e, i): ReadingEntry => ({
    id: `r${i}`, owner: "state2@c1", workerClass: "garden", estimateMib: 687,
    estimateSource: { kind: "measured", samples: 73 }, status: "owned", ageMs: 1000, sinceVerifiedMs: 1000,
    walkComplete: true, path: `/ledger/r${i}.json`, ...e,
  }));
  return {
    state: "present", scope: "host", dir: "/ledger", entries: full,
    counts: { live: full.length, uncertain: 0, incompleteWalk: 0, localScope: 0, unreadable: 0 },
    reservedMib: full.reduce((sum, e) => sum + e.estimateMib, 0),
  };
}

function status(rssKb: number): string {
  return `Name:\tnode\nVmRSS:\t ${rssKb} kB\nVmSwap:\t 0 kB\n`;
}

function stat(pid: number, start: number): string {
  return `${pid} (node) S 1 ${"0 ".repeat(17)}${start} 0 0`;
}

/** A worker tree (pids 10-12) holding a nested test run (12 is its runner, 13 a file child). */
function nestedFiles(): Record<string, string> {
  return {
    "/ledger/outer.json": JSON.stringify({ roots: [{ pid: 10, start: "proc:100" }], tree: [10, 11, 12, 13].map((pid) => ({ pid, start: `proc:${pid * 10}` })) }),
    "/ledger/inner.json": JSON.stringify({ roots: [{ pid: 12, start: "proc:120" }], tree: [{ pid: 12, start: "proc:120" }, { pid: 13, start: "proc:130" }] }),
    "/proc/10/stat": stat(10, 100), "/proc/10/status": status(100 * 1024),
    "/proc/11/stat": stat(11, 110), "/proc/11/status": status(200 * 1024),
    "/proc/12/stat": stat(12, 120), "/proc/12/status": status(400 * 1024),
    "/proc/13/stat": stat(13, 130), "/proc/13/status": status(500 * 1024),
  };
}

test("a process inside a nested test run is resident in the test run only, never in both trees", () => {
  const files = nestedFiles();
  const read = (path: string): string => {
    const text = files[path];
    if (text === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
    return text;
  };
  const [outer, inner] = residentsOf(read, ["/ledger/outer.json", "/ledger/inner.json"]);
  assert.deepEqual(outer, { mib: 300, complete: true }, "the worker's own processes, 100 + 200 MiB");
  assert.deepEqual(inner, { mib: 900, complete: true }, "the runner and its file child, 400 + 500 MiB");
  const [innerFirst, outerSecond] = residentsOf(read, ["/ledger/inner.json", "/ledger/outer.json"]);
  assert.deepEqual([innerFirst, outerSecond], [inner, outer], "listing order does not move a process between trees");
  const [unread] = residentsOf(read, ["/ledger/absent.json"]);
  assert.ok("unread" in unread!, "an unreadable entry file is named, never resident-zero");
});

test("a recorded verdict reads each measured class's learned median and lists every claim in its row", () => {
  resetShadowMemoryStateForTests();
  const rows: LedgerLine[] = [];
  const files: Record<string, string> = {
    "/proc/meminfo": "MemTotal: 16371712 kB\nMemAvailable: 9420800 kB\n",
    "/proc/vmstat": "pswpin 100\n",
    "/proc/pressure/memory": "some avg10=0.00 avg60=0.00 avg300=0.00 total=1\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=1\n",
    "/sys/fs/cgroup/memory.current": `${4500 * MIB}\n`,
    "/sys/fs/cgroup/memory.max": `${8820 * MIB}\n`,
    "/sys/fs/cgroup/memory.high": `${8379 * MIB}\n`,
    "/sys/fs/cgroup/memory.stat": "anon 1\ninactive_file 0\n",
    "/proc/777/status": "Name:\tnode\nVmHWM:\t 2097152 kB\nVmRSS:\t 2097152 kB\nVmSwap:\t 0 kB\n",
    ...Object.fromEntries(["/ledger/r0.json", "/ledger/r1.json", "/ledger/r2.json", "/ledger/r3.json"].map((p) => [p, JSON.stringify({ roots: [], tree: [] })])),
  };
  const ports: Partial<ShadowMemoryPorts> = {
    clock: fixedClock(NOW),
    readFile: (path) => {
      const text = files[path];
      if (text === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
      return text;
    },
    readTail: () => "",
    readLedger: () => reading([
      { id: "impl", workerClass: "implement", estimateMib: 1367 },
      { id: "g1" }, { id: "g2" },
      { id: "u1", workerClass: "unclassified", estimateMib: 2048, estimateSource: { kind: "default-unmeasured" } },
    ]),
    policy: () => POLICY,
    write: (_path, row) => void rows.push(row),
    stderr: () => undefined,
    instance: () => "state2",
    daemonPid: () => 777,
    listStateDir: () => [],
    estimate: (cls) => ({ implement: 1367, garden: 687, review: 484 } as Record<string, number>)[cls] ?? 2048,
    typical: (cls) => ({ implement: 296, garden: 87, review: 288, unclassified: 900 } as Record<string, number>)[cls] ?? 2048,
    readReviewDemand: () => ({ state: "present", rows: [], unreadableRows: 0 }),
  };
  recordShadowMemoryVerdict({ workerClass: "implement", reservationId: "impl", root: "/home/node/Remudero" }, ports);
  const row = rows.find((r) => r.step === "memory_budget.shadow")!;
  const numbers = row.numbers as Record<string, number>;
  // implement 296 + garden 87 + 87 + unclassified 2048 (unmeasured: whole estimate, the class median is not applied).
  assert.equal(numbers.containerTypicalMib, 296 + 87 + 87 + 2048);
  assert.equal(numbers.containerTailMib, 1367 - 296);
  const claims = row.claims as Array<{ workerClass: string; typicalMib: number }>;
  assert.deepEqual(claims.map((c) => [c.workerClass, c.typicalMib]), [["implement", 296], ["garden", 87], ["garden", 87], ["unclassified", 2048]]);

  resetShadowMemoryStateForTests();
  const failing: LedgerLine[] = [];
  recordShadowMemoryVerdict({ workerClass: "implement", reservationId: "impl", root: "/home/node/Remudero" }, {
    ...ports, write: (_p, r) => void failing.push(r), typical: () => { throw new Error("store unreadable"); },
  });
  const unreadable = failing.find((r) => r.step === "memory_budget.shadow")!.numbers as Record<string, number>;
  assert.equal(unreadable.containerTailMib, 0, "an unreadable median splits no tail off: every estimate counts whole");
  assert.equal(unreadable.containerClaimMib, unreadable.unrealizedOwnContainerMib);
});
