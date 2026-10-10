/**
 * The shadow memory verdict reads what the host CAN show instead of widening for what it cannot.
 *
 * MEASURED 2026-10-10 on the core instance, 349 of 368 verdicts (95%) would have deferred, and 81% still did after the
 * daemon's own memory was halved (#10695). Four inputs were mis-read:
 *   - daemon growth needed 6 daemon.alive rows an hour; the live ledger keeps 1-3 between rotations, so it always read
 *     "unmeasured" and added 1024 MiB, and the instance's OWN entries read as another instance's (+1024 MiB more),
 *     because the verdict named its instance by the root's basename while the ledger names it by the host mount;
 *   - every row's serve scenario was "unknown" (+256 MiB) although serve, which shares the state root, was stopped;
 *   - the container ceiling counted page cache the kernel reclaims first, against memory.max although reclaim starts at
 *     memory.high, and left out the daemon's own growth;
 *   - a finished reservation still claimed its whole unrealized estimate.
 * Each case below asserts a verdict field that only the corrected reading produces.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { fixedClock } from "../src/lib/clock.js";
import type { HostMemoryReading, ReadingEntry } from "../src/lib/host-memory-ledger.js";
import {
  counterfactualReviewVerdict,
  daemonGrowthFromStatus,
  evaluateShadowMemory,
  newestRotationMs,
  recordShadowMemoryVerdict,
  resetShadowMemoryStateForTests,
  serveScenarioOf,
  tailCoverageMs,
  type HostMemoryBudgetPolicy,
  type ShadowEntryInput,
  type ShadowInputs,
  type ShadowMemoryPorts,
} from "../src/lib/host-memory-shadow.js";
import { DAEMON_PID_ENV, markDaemonProcessActor, type LedgerLine } from "../src/lib/ledger.js";

const NOW = Date.parse("2026-10-10T20:00:00.000Z");
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

function entry(over: Partial<ShadowEntryInput> = {}): ShadowEntryInput {
  return {
    id: "start", owner: "state2@c1", workerClass: "implement", estimateMib: 2048,
    estimateSource: { kind: "measured", samples: 12 }, status: "owned", walkComplete: true,
    resident: { mib: 0, complete: true }, ...over,
  };
}

function inputs(over: Partial<ShadowInputs> = {}): ShadowInputs {
  return {
    memAvailable: { mib: 9000 },
    swapIn: { pagesPerSec: 0 },
    psi: { someAvg10: 0, someAvg60: 0, fullAvg10: 0, fullAvg60: 0 },
    container: { currentMib: 3000, maxMib: 12_000 },
    ledger: { state: "present" },
    entries: [entry()],
    start: { reservationId: "start", workerClass: "implement", estimateMib: 2048 },
    daemonGrowth: [{ instance: "state2", samples: 1, growthMib: 0, own: true }],
    serve: { scenario: "serve-stopped", basis: "test" },
    ...over,
  };
}

function enoent(path: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
}

/** /proc and cgroup bytes for one container: 7371 MiB current with 1381 MiB inactive page cache, memory.high 8379 MiB
 *  under an 8820 MiB max (the core container's own reading at 18:4xZ on 2026-10-10). */
function hostFiles(extra: Record<string, string> = {}): (path: string) => string {
  const table: Record<string, string> = {
    "/proc/meminfo": "MemTotal: 16371712 kB\nMemAvailable: 9437184 kB\n",
    "/proc/vmstat": "pswpin 100\n",
    "/proc/pressure/memory": "some avg10=0.00 avg60=0.00 avg300=0.00 total=1\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=1\n",
    "/sys/fs/cgroup/memory.current": `${7371 * MIB}\n`,
    "/sys/fs/cgroup/memory.max": `${8820 * MIB}\n`,
    "/sys/fs/cgroup/memory.high": `${8379 * MIB}\n`,
    "/sys/fs/cgroup/memory.swap.current": "0\n",
    "/sys/fs/cgroup/memory.stat": `anon ${5302 * MIB}\nfile ${1507 * MIB}\ninactive_file ${1381 * MIB}\n`,
    "/sys/fs/cgroup/memory.events": "low 0\nhigh 0\nmax 0\noom 0\noom_kill 0\n",
    "/proc/777/status": "Name:\tnode\nVmHWM:\t 2936012 kB\nVmRSS:\t 2097152 kB\nVmSwap:\t 0 kB\n",
    ...extra,
  };
  return (path) => {
    const text = table[path];
    if (text === undefined) throw enoent(path);
    return text;
  };
}

function reading(entries: Array<Partial<ReadingEntry>>): HostMemoryReading {
  const full = entries.map((e, i): ReadingEntry => ({
    id: `r${i}`, owner: "state2@c1", workerClass: "implement", estimateMib: 1024,
    estimateSource: { kind: "measured", samples: 30 }, status: "owned", ageMs: 1000, sinceVerifiedMs: 1000,
    walkComplete: true, path: `/ledger/r${i}.json`, ...e,
  }));
  return {
    state: "present", scope: "host", dir: "/ledger", entries: full,
    counts: { live: full.length, uncertain: 0, incompleteWalk: 0, localScope: 0, unreadable: 0 },
    reservedMib: full.reduce((sum, e) => sum + e.estimateMib, 0),
  };
}

/** A live ledger tail as the core instance had it: rows carried over a rotation, then ONE daemon.alive since. */
function tail(rotationAgoMs: number, aliveAgoMs = 60_000): string {
  return [
    JSON.stringify({ ts: "2026-09-28T19:33:21.706Z", step: "followup.deduped" }),
    JSON.stringify({ ts: new Date(NOW - rotationAgoMs - 5_000).toISOString(), step: "automerge.armed" }),
    JSON.stringify({ ts: new Date(NOW - aliveAgoMs).toISOString(), step: "daemon.alive", rss_bytes: 2000 * MIB, vm_swap_bytes: 0 }),
  ].join("\n");
}

function rotationName(agoMs: number): string {
  return `ledger.${new Date(NOW - agoMs).toISOString().replace(/[:.]/g, "-")}.ndjson.gz`;
}

function ports(rows: LedgerLine[], over: Partial<ShadowMemoryPorts> = {}): Partial<ShadowMemoryPorts> {
  return {
    clock: fixedClock(NOW),
    readFile: hostFiles(),
    readTail: () => tail(90 * 60_000),
    readLedger: () => reading([{ id: "start" }, { id: "other" }]),
    policy: () => POLICY,
    write: (_path, row) => void rows.push(row),
    stderr: () => undefined,
    instance: () => "state2",
    daemonPid: () => 777,
    listStateDir: () => ["ledger.ndjson", rotationName(90 * 60_000), rotationName(3 * 60 * 60_000), "ledger-superseded"],
    estimate: (cls) => (cls === "review" ? 700 : 900),
    readReviewDemand: () => ({ state: "present", rows: [], unreadableRows: 0 }),
    ...over,
  };
}

type Uncertainty = Array<{ kind: string; marginMib: number }>;

test("the daemon's growth is measured from its own /proc status, with no daemon.alive history at all", () => {
  assert.deepEqual(daemonGrowthFromStatus("VmHWM:\t 3000 kB\nVmRSS:\t 1000 kB\n"), { growthMib: 2000 / 1024, peakMib: 3000 / 1024, residentMib: 1000 / 1024 });
  assert.equal(daemonGrowthFromStatus("VmRSS:\t 1000 kB\n"), undefined, "no VmHWM is no measurement, never zero");

  resetShadowMemoryStateForTests();
  const rows: LedgerLine[] = [];
  const outcome = recordShadowMemoryVerdict({ workerClass: "implement", reservationId: "start", root: "/home/node/Remudero" }, ports(rows));
  assert.equal(outcome.kind, "recorded");
  const growth = rows[0]!.daemon_growth as Array<{ instance: string; growthMib?: number; basis?: string; own?: boolean }>;
  assert.equal(growth.length, 1, "the instance's own entries are its own: no 'not readable' second instance");
  assert.equal(growth[0]!.instance, "state2", "named as the ledger names it, not by the root's basename");
  assert.equal(growth[0]!.growthMib, (2936012 - 2097152) / 1024, "VmHWM - VmRSS of the daemon pid");
  assert.match(growth[0]!.basis ?? "", /^proc 777: VmHWM 2867 MiB - VmRSS 2048 MiB$/);
  const kinds = (rows[0]!.uncertainty as Uncertainty).map((u) => u.kind);
  assert.ok(!kinds.includes("daemon-growth-unmeasured"), `no growth margin is added: ${kinds.join(", ")}`);
  assert.equal(rows[0]!.instance, "state2");

  // Without a daemon pid the row series is still the fallback, and its reason now names both readings.
  resetShadowMemoryStateForTests();
  const fallback: LedgerLine[] = [];
  recordShadowMemoryVerdict({ workerClass: "implement", reservationId: "start", root: "/home/node/Remudero" },
    ports(fallback, { daemonPid: () => undefined }));
  const unmeasured = (fallback[0]!.uncertainty as Uncertainty).find((u) => u.kind === "daemon-growth-unmeasured");
  assert.equal(unmeasured?.marginMib, POLICY.daemonGrowthUnmeasuredMib);
  assert.match(JSON.stringify(fallback[0]!.daemon_growth), /no daemon pid in this process; 1 daemon.alive row/);
  resetShadowMemoryStateForTests();
  const unreadable: LedgerLine[] = [];
  recordShadowMemoryVerdict({ workerClass: "implement", reservationId: "start", root: "/home/node/Remudero" },
    ports(unreadable, { daemonPid: () => 4040, readTail: () => { throw enoent("tail"); } }));
  assert.match(JSON.stringify(unreadable[0]!.daemon_growth), /proc 4040: ENOENT; ledger tail unreadable: ENOENT/);
  resetShadowMemoryStateForTests();
  const partial: LedgerLine[] = [];
  recordShadowMemoryVerdict({ workerClass: "implement", reservationId: "start", root: "/home/node/Remudero" },
    ports(partial, { readFile: hostFiles({ "/proc/777/status": "VmRSS:\t 1 kB\n" }) }));
  assert.match(JSON.stringify(partial[0]!.daemon_growth), /proc 777: no VmHWM\/VmRSS; 1 daemon.alive row/);
});

test("the daemon process publishes its pid, so every process it starts can read the daemon's growth", () => {
  const saved = { pid: process.env[DAEMON_PID_ENV], actor: process.env.REMUDERO_PROCESS_ACTOR, daemon: process.env.REMUDERO_DAEMON_PROCESS };
  try {
    markDaemonProcessActor();
    assert.equal(process.env[DAEMON_PID_ENV], String(process.pid));
  } finally {
    for (const [key, value] of [[DAEMON_PID_ENV, saved.pid], ["REMUDERO_PROCESS_ACTOR", saved.actor], ["REMUDERO_DAEMON_PROCESS", saved.daemon]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("serve with no row in a ledger window longer than three serve.memory periods is stopped; a fresh rotation is unknown", () => {
  assert.equal(newestRotationMs([rotationName(3_600_000), rotationName(60_000), "ledger.ndjson", "ledger.bogus.ndjson.gz"]), NOW - 60_000);
  assert.equal(newestRotationMs(["ledger.ndjson"]), undefined);
  assert.equal(tailCoverageMs(Date.parse("2026-09-28T19:33:21.706Z"), NOW - 120_000, NOW), 120_000,
    "rows carried over the rotation do not stretch the window");
  assert.equal(tailCoverageMs(undefined, NOW, NOW), undefined);

  assert.deepEqual(serveScenarioOf([], NOW, 90 * 60_000), { scenario: "serve-stopped", basis: "no serve rows in 5400s of ledger" });
  assert.deepEqual(serveScenarioOf([], NOW, 120_000), { scenario: "unknown", basis: "no serve rows in the ledger tail (it covers 120s)" });
  assert.equal(serveScenarioOf([{ step: "serve.memory", at: NOW - 60_000 }], NOW, 90 * 60_000).scenario, "serve-steady",
    "a serve row still wins over the window");

  resetShadowMemoryStateForTests();
  const rows: LedgerLine[] = [];
  recordShadowMemoryVerdict({ workerClass: "review", reservationId: "start", root: "/home/node/Remudero" }, ports(rows));
  assert.equal(rows[0]!.scenario, "serve-stopped");
  assert.ok(!(rows[0]!.uncertainty as Uncertainty).some((u) => u.kind === "serve-scenario-unknown"));

  resetShadowMemoryStateForTests();
  const fresh: LedgerLine[] = [];
  recordShadowMemoryVerdict({ workerClass: "review", reservationId: "start", root: "/home/node/Remudero" },
    ports(fresh, { readTail: () => tail(120_000), listStateDir: () => [rotationName(120_000)] }));
  assert.equal(fresh[0]!.scenario, "unknown", "two minutes since a rotation cannot tell stopped from not yet written");
  resetShadowMemoryStateForTests();
  const unlisted: LedgerLine[] = [];
  recordShadowMemoryVerdict({ workerClass: "review", reservationId: "start", root: "/home/node/Remudero" },
    ports(unlisted, { listStateDir: () => { throw enoent("state"); } }));
  assert.equal(unlisted[0]!.scenario, "serve-stopped", "an unlistable state dir leaves the tail's own first row as the bound");
});

test("the container ceiling is memory.high when lower, page cache is not counted as used, and the daemon's growth is", () => {
  const read = evaluateShadowMemory(inputs({
    container: { currentMib: 7371, maxMib: 8820, highMib: 8379, reclaimableMib: 1381 },
    daemonGrowth: [{ instance: "state2", samples: 1, growthMib: 819, own: true }],
    entries: [entry({ estimateMib: 900, resident: { mib: 400, complete: true } })],
  }), POLICY);
  assert.equal(read.numbers.containerCeilingMib, 8379);
  assert.equal(read.numbers.containerWorkingSetMib, 7371 - 1381);
  assert.equal(read.numbers.containerHeadroomMib, 8379 - (7371 - 1381) - 500 - 819);
  assert.deepEqual(read.reasons, [], "1070 MiB of headroom clears the 1024 MiB reserve");

  const old = evaluateShadowMemory(inputs({ container: { currentMib: 7371, maxMib: 8820 },
    entries: [entry({ estimateMib: 2048, estimateSource: { kind: "default-unmeasured" } })] }), POLICY);
  assert.deepEqual(old.reasons, ["container-ceiling"], "the same container read the old way defers");

  const unbounded = evaluateShadowMemory(inputs({ container: { currentMib: 7000, maxMib: null, highMib: null } }), POLICY);
  assert.equal(unbounded.numbers.containerCeilingMib, null, "no limit at all: no ceiling, no container reason");
  assert.deepEqual(unbounded.reasons, []);
  const foreignGrowth = evaluateShadowMemory(inputs({ container: { currentMib: 9000, maxMib: 12_000 },
    daemonGrowth: [{ instance: "rmd-site-state", samples: 1, growthMib: 4000 }] }), POLICY);
  assert.equal(foreignGrowth.numbers.containerHeadroomMib, 12_000 - 9000 - 2048, "another container's daemon is not ours");

  // The same reading end to end from cgroup files.
  resetShadowMemoryStateForTests();
  const rows: LedgerLine[] = [];
  recordShadowMemoryVerdict({ workerClass: "implement", reservationId: "start", root: "/home/node/Remudero" },
    ports(rows, { readLedger: () => reading([{ id: "start", estimateMib: 900 }]) }));
  const numbers = rows[0]!.numbers as Record<string, number>;
  assert.equal(numbers.containerCeilingMib, 8379);
  assert.equal(numbers.containerWorkingSetMib, 7371 - 1381);
  assert.equal(numbers.daemonGrowthMib, (2936012 - 2097152) / 1024);
  resetShadowMemoryStateForTests();
  const bare: LedgerLine[] = [];
  recordShadowMemoryVerdict({ workerClass: "implement", reservationId: "start", root: "/home/node/Remudero" },
    ports(bare, { readFile: hostFiles({ "/sys/fs/cgroup/memory.high": "max\n", "/sys/fs/cgroup/memory.stat": "anon 1\nfile 1\n" }) }));
  const plain = bare[0]!.numbers as Record<string, number>;
  assert.equal(plain.containerCeilingMib, 8820, "memory.high 'max' leaves memory.max as the ceiling");
  assert.equal(plain.containerWorkingSetMib, 7371, "no inactive_file line: nothing is subtracted on a guess");
  resetShadowMemoryStateForTests();
  const gone: LedgerLine[] = [];
  const noHigh = hostFiles();
  recordShadowMemoryVerdict({ workerClass: "implement", reservationId: "start", root: "/home/node/Remudero" },
    ports(gone, { readFile: (path) => (path.endsWith("memory.high") ? (() => { throw enoent(path); })() : noHigh(path)) }));
  assert.equal((gone[0]!.numbers as Record<string, number>).containerCeilingMib, 8820);
  resetShadowMemoryStateForTests();
  const noStat: LedgerLine[] = [];
  recordShadowMemoryVerdict({ workerClass: "implement", reservationId: "start", root: "/home/node/Remudero" },
    ports(noStat, { readFile: (path) => (path.endsWith("memory.stat") ? (() => { throw enoent(path); })() : noHigh(path)) }));
  assert.equal((noStat[0]!.numbers as Record<string, number>).containerWorkingSetMib, 7371, "an unreadable memory.stat subtracts nothing");
});

test("a finished reservation claims nothing more than it holds, and its default estimate adds no margin", () => {
  const live = evaluateShadowMemory(inputs({ entries: [entry(), entry({ id: "done", estimateSource: { kind: "default-unmeasured" }, resident: { mib: 100, complete: true } })] }), POLICY);
  const done = evaluateShadowMemory(inputs({ entries: [entry(), entry({ id: "done", occupancyReleased: true, estimateSource: { kind: "default-unmeasured" }, resident: { mib: 100, complete: true } })] }), POLICY);
  assert.equal(live.numbers.unrealizedMib, 2048 + 1948);
  assert.equal(done.numbers.unrealizedMib, 2048, "a released occupancy's tree can only shrink");
  assert.ok(live.uncertainty.some((u) => u.kind === "unmeasured-estimate"));
  assert.ok(!done.uncertainty.some((u) => u.kind === "unmeasured-estimate"));

  resetShadowMemoryStateForTests();
  const rows: LedgerLine[] = [];
  recordShadowMemoryVerdict({ workerClass: "implement", reservationId: "start", root: "/home/node/Remudero" },
    ports(rows, { readLedger: () => reading([{ id: "start" }, { id: "finished", occupancyReleased: true }]) }));
  assert.equal((rows[0]!.numbers as Record<string, number>).unrealizedMib, 1024, "end to end, the finished entry adds nothing");
});

test("a start and the counterfactual review claim their LEARNED class estimates", () => {
  resetShadowMemoryStateForTests();
  const rows: LedgerLine[] = [];
  recordShadowMemoryVerdict({ workerClass: "implement", root: "/home/node/Remudero" }, ports(rows, { readLedger: () => reading([]) }));
  assert.equal((rows[0]!.numbers as Record<string, number>).unrealizedMib, 900, "the start's own claim is the learned 900, not 2048");
  const review = counterfactualReviewVerdict(inputs({ reviewEstimateMib: 700, entries: [] }), POLICY, false);
  assert.equal(review.numbers.unrealizedMib, 700);
  const prior = counterfactualReviewVerdict(inputs({ entries: [] }), POLICY, false);
  assert.equal(prior.numbers.unrealizedMib, 1024, "with no learned estimate, the review default");

  resetShadowMemoryStateForTests();
  const failing: LedgerLine[] = [];
  recordShadowMemoryVerdict({ workerClass: "garden", root: "/home/node/Remudero" }, ports(failing, {
    readLedger: () => reading([]),
    estimate: () => { throw new Error("store unreadable"); },
    instance: () => { throw new Error("no mountinfo"); },
  }));
  assert.equal((failing[0]!.numbers as Record<string, number>).unrealizedMib, 1024, "an unreadable store is the class default");
  assert.equal(failing[0]!.instance, "Remudero", "an unreadable mount table falls back to the root's own name");
});
