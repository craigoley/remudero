/**
 * W1-T9762: an unrealized reservation is charged its measured typical growth plus one tail, and decays as its tree ages.
 *
 * MEASURED 2026-10-15 (1,402 memory_budget.shadow rows): unrealized-reservations tipped 719 of 948 would-defer verdicts
 * at 56% precision. gatherShadowInputs gave the start no typicalMib, and an enforced admission is evaluated before its
 * reservation exists, so every enforced start was charged its whole learned p90 as typical growth. A live tree's claim
 * never decayed with age, because the peak store did not record when a tree peaked.
 * Fixture: the 10-12 class peaks (p50/p90 MiB: implement 723/2,904, garden 226/1,100), 5,000 MiB MemAvailable, a
 * 2,048 MiB host reserve, one live build reservation and an unseen garden start.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { fixedClock } from "../src/lib/clock.js";
import { type HostMemoryLedgerOptions, type HostMemoryReading, type ReadingEntry } from "../src/lib/host-memory-ledger.js";
// A namespace import, so a run at a base without the new exports still loads and each subtest fails on its own.
import * as learning from "../src/lib/host-memory-learning.js";
import {
  evaluateShadowMemory,
  gatherShadowInputs,
  resetShadowMemoryStateForTests,
  type HostMemoryBudgetPolicy,
  type ShadowMemoryPorts,
} from "../src/lib/host-memory-shadow.js";

const NOW = Date.parse("2026-10-16T10:00:00.000Z");
const MIN = 60_000;
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

const P90: Record<string, number> = { implement: 2904, garden: 1100, review: 1008 };
const P50: Record<string, number> = { implement: 723, garden: 226, review: 319 };

function status(rssMib: number): string {
  return `Name:\tnode\nVmRSS:\t ${rssMib * 1024} kB\nVmSwap:\t 0 kB\nVmHWM:\t ${rssMib * 1024} kB\n`;
}

/** One live build reservation (pid 10) at `residentMib` and `ageMs`, on an otherwise idle host. */
function ports(build: { residentMib: number; ageMs: number }, over: Partial<ShadowMemoryPorts> = {}): ShadowMemoryPorts {
  const files: Record<string, string> = {
    "/proc/meminfo": `MemTotal: 16371712 kB\nMemAvailable: ${5000 * 1024} kB\n`,
    "/proc/vmstat": "pswpin 0\n",
    "/proc/pressure/memory": "some avg10=0.00 avg60=0.00 avg300=0.00 total=1\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=1\n",
    "/sys/fs/cgroup/memory.current": `${3000 * MIB}\n`,
    "/sys/fs/cgroup/memory.max": `${8820 * MIB}\n`,
    "/sys/fs/cgroup/memory.high": `${8379 * MIB}\n`,
    "/sys/fs/cgroup/memory.stat": "anon 1\ninactive_file 0\n",
    "/ledger/build.json": JSON.stringify({ roots: [{ pid: 10, start: "proc:100" }], tree: [{ pid: 10, start: "proc:100" }] }),
    "/proc/10/stat": `10 (node) S 1 ${"0 ".repeat(17)}100 0 0`,
    "/proc/10/status": status(build.residentMib),
  };
  const entry: ReadingEntry = {
    id: "build", owner: "state2@c1", workerClass: "implement", estimateMib: P90.implement!,
    estimateSource: { kind: "measured", samples: 40 }, status: "owned", ageMs: build.ageMs, sinceVerifiedMs: 1000,
    walkComplete: true, path: "/ledger/build.json",
  };
  const reading: HostMemoryReading = {
    state: "present", scope: "host", dir: "/ledger", entries: [entry],
    counts: { live: 1, uncertain: 0, incompleteWalk: 0, localScope: 0, unreadable: 0 }, reservedMib: entry.estimateMib,
  };
  return {
    clock: fixedClock(NOW),
    nowNs: () => 0n,
    readFile: (path) => {
      const text = files[path];
      if (text === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
      return text;
    },
    readTail: () => "",
    readLedger: () => reading,
    policy: () => POLICY,
    write: undefined,
    readReviewDemand: () => ({ state: "present", rows: [], unreadableRows: 0 }),
    priorityPolicy: () => { throw new Error("not read"); },
    stderr: () => undefined,
    instance: () => "state2",
    daemonPid: () => undefined,
    listStateDir: () => [],
    estimate: (cls) => P90[cls] ?? 2048,
    typical: (cls) => P50[cls] ?? 2048,
    writeFile: () => undefined,
    ...over,
  };
}

/** The garden start an enforced admission evaluates: it has no reservation yet. */
const GARDEN_START = { workerClass: "garden" as const, root: "/home/node/Remudero" };

/** A peak store of implement trees whose concurrent-RSS peaks came at `ttpMin` minutes. */
function storeWith(ttpMin: number[] | null) {
  const lines = (ttpMin ?? [5, 8, 12, 20, 30]).map((m) => JSON.stringify({
    c: "implement", p: 700, at: new Date(NOW - 10 * MIN).toISOString(), basis: "concurrent-rss", legacy_p: 700,
    ...(ttpMin === null ? {} : { ttp_ms: m * MIN }),
  })).join("\n") + "\n";
  return { list: () => ["state2.ndjson"], readTail: () => lines, clock: fixedClock(NOW) };
}

test("W1-T9762: an unseen start is charged its class typical, not its learned p90", () => {
  resetShadowMemoryStateForTests();
  // A build 2 minutes in, 600 MiB resident: 123 MiB of typical growth left, and 2,181 MiB of tail above it.
  const inputs = gatherShadowInputs(GARDEN_START, ports({ residentMib: 600, ageMs: 2 * MIN }), POLICY);
  assert.equal(inputs.start.estimateMib, 1100);
  assert.equal(inputs.start.typicalMib, 226, "the start carries its class median, as every measured ledger entry does");

  const verdict = evaluateShadowMemory(inputs, POLICY);
  const start = verdict.claims.at(-1)!;
  assert.deepEqual([start.workerClass, start.typicalMib, start.chargedMib, start.ageMs], ["garden", 226, 226, 0]);
  assert.equal(verdict.numbers.hostTypicalMib, (723 - 600) + 226, "the start adds its median, not its 1,100 MiB p90");
  assert.equal(verdict.numbers.hostTailMib, 2904 - 723, "ONE tail: the build's 2,181, the garden's 874 competes for it");
  assert.equal(verdict.numbers.hostClaimMib, 123 + 226 + 2181);
  // The fixture's unread daemon and serve rows widen the margin ("uncertainty"); the claim itself fits.
  assert.ok(!verdict.reasons.includes("unrealized-reservations"),
    `the host truly has room: 5,000 - 2,530 leaves 2,470 above the 2,048 reserve: ${verdict.reasons.join(",")}`);
});

test("W1-T9762: a tree past its measured time to peak claims nothing above its resident", () => {
  resetShadowMemoryStateForTests();
  learning.resetLearnedEstimateCacheForTests();
  const store = storeWith([5, 8, 12, 20, 30]);
  const survival: ShadowMemoryPorts["survival"] = (cls, ageMs) => learning.classSurvival(cls, ageMs, store);
  // 40 minutes in and still under its median: every measured build had peaked by 30 minutes.
  const old = evaluateShadowMemory(gatherShadowInputs(GARDEN_START, ports({ residentMib: 300, ageMs: 40 * MIN }, { survival }), POLICY), POLICY);
  const build = old.claims[0]!;
  assert.equal(build.decay.factor, 0);
  assert.match(build.decay.basis, /survival at 2400s over 5 time-to-peak sample/);
  assert.equal(build.chargedMib, 0, "its remaining median is not charged");
  assert.equal(build.ageMs, 40 * MIN);
  assert.equal(old.numbers.hostTypicalMib, 226, "only the start's typical growth remains");
  assert.equal(old.numbers.hostTailMib, 1100 - 226, "the build's tail decayed too: the garden's is the one allowance");
  assert.equal(old.numbers.hostClaimUndecayedMib, (723 - 300) + 226 + (2904 - 723), "the undecayed claim is reported beside it");
  assert.ok(old.numbers.hostClaimMib < old.numbers.hostClaimUndecayedMib);

  // 10 minutes in: two of five measured builds had peaked; the prior sits at the longest, 30 minutes.
  learning.resetLearnedEstimateCacheForTests();
  const mid = evaluateShadowMemory(gatherShadowInputs(GARDEN_START, ports({ residentMib: 300, ageMs: 10 * MIN }, { survival }), POLICY), POLICY);
  const factor = mid.claims[0]!.decay.factor!;
  assert.ok(factor > 0.5 && factor < 1, `three of five samples and the prior are still ahead: ${factor}`);
  assert.equal(mid.claims[0]!.chargedMib, (723 - 300) * factor);

  assert.deepEqual(learning.survivalAt([{ peakAgeMs: 5 * MIN, at: NOW }], 0, NOW), { factor: 1, samples: 1 }, "a new tree has it all ahead");
});

test("W1-T9762: a class with no time-to-peak samples is charged undecayed and says so", () => {
  resetShadowMemoryStateForTests();
  learning.resetLearnedEstimateCacheForTests();
  const store = storeWith(null);
  const survival: ShadowMemoryPorts["survival"] = (cls, ageMs) => learning.classSurvival(cls, ageMs, store);
  const verdict = evaluateShadowMemory(gatherShadowInputs(GARDEN_START, ports({ residentMib: 300, ageMs: 40 * MIN }, { survival }), POLICY), POLICY);
  const build = verdict.claims[0]!;
  assert.deepEqual(build.decay, { factor: null, basis: "not decayed: no time-to-peak samples" });
  assert.equal(build.chargedMib, 723 - 300, "its whole remaining median is charged");
  assert.equal(verdict.numbers.hostClaimMib, verdict.numbers.hostClaimUndecayedMib);

  const unreadable = evaluateShadowMemory(gatherShadowInputs(GARDEN_START, ports({ residentMib: 300, ageMs: 40 * MIN }, {
    survival: () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); },
  }), POLICY), POLICY);
  assert.deepEqual(unreadable.claims[0]!.decay, { factor: null, basis: "not decayed: time-to-peak store unreadable: EACCES" });
  const unread = evaluateShadowMemory(gatherShadowInputs(GARDEN_START, ports({ residentMib: 300, ageMs: 40 * MIN }, { survival: undefined }), POLICY), POLICY);
  assert.equal(unread.claims[0]!.decay.basis, "not decayed: no time-to-peak reader");
});

function reservationSpace(): HostMemoryLedgerOptions {
  const files = new Map<string, string>();
  const dir = `/ledger/${Math.random().toString(36).slice(2)}`;
  return {
    location: () => ({ dir, scope: "host" }),
    instance: () => ({ name: "state2", hostUnique: true }),
    generation: () => ({ containerId: "c1", initStart: "proc:1" }),
    probe: () => ({ state: "alive", start: "proc:10" }),
    listProcesses: () => ({ rows: [], complete: true }),
    write: (path, content) => void files.set(path, content),
    read: (path) => {
      const content = files.get(path);
      if (content === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
      return content;
    },
    list: (d) => [...files.keys()].filter((k) => k.startsWith(`${d}/`)).map((k) => k.slice(d.length + 1)),
    remove: (path) => void files.delete(path),
    createSentinel: (path, content) => void files.set(path, content),
    clock: fixedClock(NOW),
    log: () => undefined,
    ownerPid: 4242,
  };
}

test("W1-T9762: a recorded peak carries the age the tree reached it", () => {
  learning.resetLearnedEstimateCacheForTests();
  let now = NOW;
  let rssMib = 200;
  const sampler = learning.createTreePeakSampler({
    listProcesses: () => ({ complete: true, rows: [{ pid: 10, parent: 1, start: "proc:5" }] }),
    readFile: (path) => path.endsWith("/stat") ? `10 (node) S 1 ${"0 ".repeat(17)}5 0 0` : status(rssMib),
    setTimer: () => undefined, clearTimer: () => undefined, now: () => now,
  });
  const appended: string[] = [];
  const store = { list: () => [] as string[], append: (_p: string, line: string) => void appended.push(line), size: () => 0, clock: fixedClock(NOW) };
  const reservation = learning.openLearnedReservation({ workerClass: "implement" }, { ledger: reservationSpace(), store, sampler });
  now = NOW + 1 * MIN;
  reservation.bindRoot(10);
  for (const [atMin, mib] of [[4, 900], [9, 1400], [15, 1100], [25, 1400]] as const) {
    now = NOW + atMin * MIN;
    rssMib = mib;
    sampler.sampleNow();
  }
  now = NOW + 30 * MIN;
  rssMib = 300;
  reservation.releaseOccupancy();
  assert.equal(appended.length, 1);
  const row = JSON.parse(appended[0]!) as Record<string, unknown>;
  assert.equal(row.p, 1400);
  assert.equal(row.ttp_ms, 9 * MIN, "the peak was last RAISED 9 minutes after the reservation opened; 25 only matched it");

  const samples = learning.readPeakSamples("implement", { list: () => ["state2.ndjson"], readTail: () => appended.join("") });
  assert.equal(samples[0]!.peakAgeMs, 9 * MIN, "the store reads the age back");
  assert.equal(learning.readPeakSamples("implement", { list: () => ["s.ndjson"], readTail: () => `{"c":"implement","p":5,"at":"${new Date(NOW).toISOString()}"}\n` })[0]!.peakAgeMs,
    undefined, "an old sample is still a peak sample, never a time-to-peak one");

  // A tree tracked without its reservation's open time has no age to report.
  const bare = learning.createTreePeakSampler({
    listProcesses: () => ({ complete: true, rows: [{ pid: 10, parent: 1, start: "proc:5" }] }),
    readFile: (path) => path.endsWith("/stat") ? `10 (node) S 1 ${"0 ".repeat(17)}5 0 0` : status(400),
    setTimer: () => undefined, clearTimer: () => undefined, now: () => NOW,
  });
  bare.track("bare", 10);
  assert.equal(bare.finishMeasurement!("bare").peakAgeMs, undefined);
});
