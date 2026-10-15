/**
 * W1-T9557: the zero-worker capacity decision charges the daemons' TYPICAL growth, not their lifetime peak.
 *
 * MEASURED 2026-10-14 (#11519): shortfall samples appeared only in the hours the core daemon's VmHWM - VmRSS spiked to
 * 3.3-5.2 GB, while its typical growth (the median of its footprint samples less its latest) was about 342 MiB. Each
 * fixture leaves the host short only when the 5,200 MiB lifetime-peak growth is charged, and fitting when the 342 MiB
 * typical part is, so every case below reads a field only the typical charge (or its recorded basis) produces.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { fixedClock } from "../src/lib/clock.js";
import { DAEMON_FOOTPRINT_FILE } from "../src/lib/daemon-footprint.js";
import type { HostMemoryReading } from "../src/lib/host-memory-ledger.js";
import {
  HOST_MEMORY_PRIORITY_PROPOSAL,
  capacityDecisionText,
  resetHostMemoryPriorityStateForTests,
  takeCapacityDecisions,
} from "../src/lib/host-memory-priority.js";
import {
  recordShadowMemoryVerdict,
  resetShadowMemoryStateForTests,
  type HostMemoryBudgetPolicy,
  type ShadowMemoryPorts,
} from "../src/lib/host-memory-shadow.js";
import type { LedgerLine } from "../src/lib/ledger.js";

const NOW = Date.parse("2026-10-14T12:00:00.000Z");
const MIN = 60_000;
const MIB = 1024 * 1024;
const ROOT = "/w1-t9557/Remudero";
const DECISION = "memory_budget.capacity_decision";
const SUSTAINED = HOST_MEMORY_PRIORITY_PROPOSAL.zeroWorkerShortfallSamples;

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

// The daemon now resides at 2000 MiB; its lifetime peak was 7200 MiB, so VmHWM - VmRSS is 5200 MiB.
const STATUS = `Name:\tnode\nVmHWM:\t ${7200 * 1024} kB\nVmRSS:\t ${2000 * 1024} kB\nVmSwap:\t 0 kB\n`;
// Its footprint over the last hour: median 2342 MiB, latest 2000 MiB, so the typical growth is 342 MiB.
const FOOTPRINT_MIB = [2342, 2100, 2342, 2500, 2342, 2342, 2000];

function footprint(mibs: readonly number[]): string {
  const samples = mibs.map((mib, i) => ({ at: NOW - (mibs.length - 1 - i) * 5 * MIN, bytes: mib * MIB, pid: 111 }));
  return JSON.stringify({ samples });
}

function reading(): HostMemoryReading {
  return {
    state: "present", scope: "host", dir: "/ledger",
    entries: [{ id: "start", owner: "here@c1", workerClass: "garden", estimateMib: 820,
      estimateSource: { kind: "measured", samples: 40 }, status: "owned", ageMs: 1000, sinceVerifiedMs: 1000,
      walkComplete: true, path: "/ledger/start.json" }],
    counts: { live: 1, uncertain: 0, incompleteWalk: 0, localScope: 0, unreadable: 0 },
    reservedMib: 820,
  };
}

function ports(
  at: number, rows: LedgerLine[], memAvailableMib: number, footprintMib: readonly number[], pid: number | null = 111,
): Partial<ShadowMemoryPorts> {
  const files: Record<string, string> = {
    "/proc/meminfo": `MemTotal: 16371712 kB\nMemAvailable: ${memAvailableMib * 1024} kB\n`,
    "/proc/vmstat": "pswpin 100\n",
    "/proc/pressure/memory": "some avg10=0.00 avg60=0.00 avg300=0.00 total=1\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=1\n",
    "/sys/fs/cgroup/memory.current": `${3000 * MIB}\n`,
    "/sys/fs/cgroup/memory.max": `${12_000 * MIB}\n`,
    "/sys/fs/cgroup/memory.stat": "anon 1\ninactive_file 0\n",
    "/proc/111/status": STATUS,
    "/ledger/start.json": JSON.stringify({ roots: [], tree: [] }),
    [`${ROOT}/state/${DAEMON_FOOTPRINT_FILE}`]: footprint(footprintMib),
  };
  const serveRow = JSON.stringify({ ts: new Date(at - 30_000).toISOString(), step: "serve.memory" });
  return {
    clock: fixedClock(at),
    readFile: (path) => {
      const text = files[path];
      if (text === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
      return text;
    },
    readTail: () => serveRow,
    readLedger: () => reading(),
    readHostServe: () => ({ state: "unknown", cause: "local-only", basis: "test" }),
    policy: () => POLICY,
    priorityPolicy: () => HOST_MEMORY_PRIORITY_PROPOSAL,
    write: (_path, row) => void rows.push(row),
    writeFile: () => undefined,
    stderr: () => undefined,
    instance: () => "here",
    daemonPid: () => pid ?? undefined,
    listStateDir: () => [],
    estimate: (cls) => (cls === "garden" ? 820 : 1024),
    typical: (cls) => (cls === "garden" ? 90 : 295),
    readReviewDemand: () => ({ state: "present", rows: [], unreadableRows: 0 }),
  };
}

/** Records `count` verdicts a minute apart; returns every ledger row they wrote. */
function record(count: number, memAvailableMib: number, footprintMib: readonly number[], pid?: number | null): LedgerLine[] {
  const rows: LedgerLine[] = [];
  for (let i = 0; i < count; i += 1) {
    const outcome = recordShadowMemoryVerdict({ workerClass: "garden", reservationId: "start", root: ROOT },
      ports(NOW + i * MIN, rows, memAvailableMib, footprintMib, pid));
    assert.equal(outcome.kind, "recorded", JSON.stringify(outcome));
  }
  return rows;
}

function fresh(): void {
  resetShadowMemoryStateForTests();
  resetHostMemoryPriorityStateForTests();
}

test("W1-T9557: a lifetime-peak spike with a small typical growth raises no capacity decision", () => {
  fresh();
  try {
    // 3000 MiB available: charging the 5200 MiB peak leaves -2200, short of the 2048 reserve; charging 342 leaves 2658.
    const rows = record(SUSTAINED * 3, 3000, FOOTPRINT_MIB);
    const shadow = rows.find((r) => r.step === "memory_budget.shadow")!;
    const numbers = shadow.numbers as Record<string, number>;
    assert.equal(numbers.daemonGrowthMib, 5200, "the fixture's lifetime-peak growth");
    assert.equal(numbers.daemonGrowthTypicalMib, 342, "the fixture's typical growth");
    assert.equal(rows.filter((r) => r.step === DECISION).length, 0, "the lifetime peak is a transient, not standing demand");
    assert.deepEqual(takeCapacityDecisions(), [], "nothing is queued for the escalation path");
  } finally {
    fresh();
  }
});

test("W1-T9557: a sustained typical shortfall still raises one decision naming its basis", () => {
  fresh();
  try {
    // 1800 MiB available: even the 342 MiB typical charge leaves 1458, short of the 2048 reserve by 590.
    const rows = record(SUSTAINED * 3, 1800, FOOTPRINT_MIB);
    const raised = rows.filter((r) => r.step === DECISION);
    assert.equal(raised.length, 1, "one decision for the sustained shortfall");
    const row = raised[0]!;
    assert.equal(row.daemonGrowthChargedMib, 342, "the typical growth is what was charged");
    assert.equal(row.daemonGrowthBasis, "here: median of 7 footprint sample(s)");
    assert.equal(row.daemonGrowthPeakMib, 5200, "the lifetime peak is recorded beside it for comparison");
    assert.equal(row.shortfallMib, 2048 - (1800 - 342));
    const [decision] = takeCapacityDecisions();
    assert.ok(decision, "the decision is queued for the sweep");
    const text = capacityDecisionText(decision);
    assert.equal(text.summary, "host memory cannot fit zero workers in scenario serve-steady", "the dedup title is stable");
    assert.match(text.detail, /charges 342 MiB of daemon growth \(here: median of 7 footprint sample\(s\)\)/);
    assert.match(text.detail, /not their 5200 MiB growth back to their lifetime peak/);
  } finally {
    fresh();
  }
});

test("W1-T9557: too few footprint samples charge the whole growth and say so", () => {
  fresh();
  try {
    // Two samples cannot split a typical part off, so the whole 5200 MiB is charged, as before this task.
    const rows = record(SUSTAINED, 3000, FOOTPRINT_MIB.slice(-2));
    const raised = rows.filter((r) => r.step === DECISION);
    assert.equal(raised.length, 1, "the full charge leaves the host short");
    const row = raised[0]!;
    assert.equal(row.daemonGrowthChargedMib, 5200, "with no typical split the whole growth is charged");
    assert.equal(row.daemonGrowthBasis, "here: all typical: 2 daemon footprint sample(s) in the last hour");
    assert.match(capacityDecisionText(takeCapacityDecisions()[0]!).detail,
      /charges 5200 MiB of daemon growth \(here: all typical: 2 daemon footprint sample\(s\) in the last hour\)/);
  } finally {
    fresh();
  }
});

test("W1-T9557: with no daemon pid the basis names the footprint series, or that no growth was measured", () => {
  fresh();
  try {
    // No /proc status: the footprint itself measures the growth (500 MiB back to its hour's peak) and its median split.
    const series = record(SUSTAINED, 1200, FOOTPRINT_MIB, null).find((r) => r.step === DECISION)!;
    assert.equal(series.daemonGrowthBasis, "here: median of 7 samples from the daemon footprint");
    assert.equal(series.daemonGrowthChargedMib, 342);
    assert.equal(series.daemonGrowthPeakMib, 500);
    fresh();
    // Too few samples and no pid: nothing is charged as growth (the verdict widens its margin instead), and it says so.
    const none = record(SUSTAINED, 1200, FOOTPRINT_MIB.slice(-2), null).find((r) => r.step === DECISION)!;
    assert.equal(none.daemonGrowthBasis, "no daemon growth measured");
    assert.equal(none.daemonGrowthChargedMib, 0);
  } finally {
    fresh();
  }
});
