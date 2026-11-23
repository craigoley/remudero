/**
 * W1-T14155: the host memory budget counts one tail per live tree that is in or near validation, not one tail for the
 * whole host. OBSERVED 2026-11-21 on the Azure host: the one enforce_admit row of the 12:07-13:15Z window (12:22:16) had
 * tier "fits" with memAvailableMib 9234, unrealizedMib 52727, hostClaimMib 2690, hostClaimUndecayedMib 7244,
 * hostTypicalMib 845 and psi some/full avg10 0.77/0.28; by 13:15Z PSI some avg10 was 99.97 with 7 fix runs validating.
 * FIXTURES ONLY: every /proc file, recorded tree and ledger reading here is this test's own.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { fixedClock } from "#src/lib/clock.js";
import {
  awaitMemoryAdmission, ENFORCE_ADMIT_STEP, ENFORCE_WAIT_STEP, resetMemoryAdmissionStateForTests, type AdmissionPorts,
} from "#src/lib/host-memory-admission.js";
import type { HostMemoryReading, ReadingEntry, WorkerClass } from "#src/lib/host-memory-ledger.js";
import {
  evaluateShadowMemory, recordShadowMemoryVerdict, resetShadowMemoryStateForTests, type HostMemoryBudgetPolicy,
  type ShadowEntryInput, type ShadowInputs,
} from "#src/lib/host-memory-shadow.js";
import type { LedgerLine } from "#src/lib/ledger.js";

const NOW = Date.parse("2026-11-21T12:22:16.000Z");
const MIB = 1024 * 1024;
const ROOT = "/home/node/Remudero";

const POLICY: HostMemoryBudgetPolicy = {
  mode: "enforce", hostReserveMib: 2048, containerReserveMib: 1024, swapInPagesPerSecMax: 256, psiSomeAvg10Max: 10,
  psiFullAvg10Max: 2, serveColdStartReserveMib: 7680, uncertaintyMarginMib: 256, daemonGrowthUnmeasuredMib: 1024,
  daemonGrowthMinSamples: 6, staleReadingMs: 600_000,
};

/** The learned classes then: a fix start claims 2600 MiB at a 755 MiB median (its tail is 1845). */
const ESTIMATE: Partial<Record<WorkerClass, number>> = { fix: 2600, review: 1400, test: 2800 };
const TYPICAL: Partial<Record<WorkerClass, number>> = { fix: 755, review: 500, test: 900 };

interface Tree {
  id: string;
  workerClass: WorkerClass;
  estimateMib: number;
  residentMib: number;
  /** The class's survival at this tree's age. */
  factor: number;
  /** The ids of the test runs whose runners sit inside this tree. */
  holds?: string[];
  released?: true;
}

const fix = (id: string, residentMib: number, factor: number, holds?: string[]): Tree =>
  ({ id, workerClass: "fix", estimateMib: 6492, residentMib, factor, ...(holds ? { holds } : {}) });
const review = (id: string, estimateMib: number, residentMib: number, factor: number): Tree =>
  ({ id, workerClass: "review", estimateMib, residentMib, factor });
const testRun = (id: string, factor = 1, released?: true): Tree =>
  ({ id, workerClass: "test", estimateMib: 2800, residentMib: 989, factor, ...(released ? { released } : {}) });

/** The live trees beside the 12:22:16 fix start (W1-T13991): six fix runs and four reviews. */
function window1222(holds: { F1?: string[]; F3?: string[] } = {}): Tree[] {
  return [
    fix("fix-W1-T10937", 756, 0.25, holds.F1), fix("fix-W1-T12169", 35, 0.125), fix("fix-W1-T13850", 756, 0.25, holds.F3),
    fix("fix-W1-T13875", 756, 0.25), fix("fix-W1-T13944", 756, 0.25), fix("fix-W1-T13969", 756, 0.25),
    review("review-1", 1400, 468, 0), review("review-2", 5186, 500, 0.25), review("review-3", 5186, 500, 0.25),
    review("review-4", 5186, 500, 0.25),
  ];
}

/** The host as the budget reads it: /proc, the container's cgroup files, and each recorded tree. */
function host(trees: Tree[], memAvailableMib: number, psi = { some: 0.77, full: 0.28 }) {
  const pid = new Map(trees.map((tree, i) => [tree.id, 100 + i]));
  const identity = (id: string) => ({ pid: pid.get(id)!, start: `proc:${pid.get(id)! * 10}` });
  const files: Record<string, string> = {
    "/proc/meminfo": `MemTotal: 32505856 kB\nMemAvailable: ${memAvailableMib * 1024} kB\n`,
    "/proc/vmstat": "pswpin 100\n",
    "/proc/pressure/memory": `some avg10=${psi.some} avg60=0.00 avg300=0.00 total=1\nfull avg10=${psi.full} avg60=0.00 avg300=0.00 total=1\n`,
    "/sys/fs/cgroup/memory.current": `${15_462 * MIB}\n`,
    "/sys/fs/cgroup/memory.max": `${26_214 * MIB}\n`,
    "/sys/fs/cgroup/memory.stat": "anon 1\nfile 1\n",
    "/sys/fs/cgroup/memory.events": "low 0\nhigh 0\nmax 0\noom 0\noom_kill 0\n",
    "/proc/777/status": "VmHWM:\t 1048576 kB\nVmRSS:\t 1048576 kB\n",
  };
  for (const tree of trees) {
    const self = identity(tree.id);
    files[`/ledger/${tree.id}.json`] = JSON.stringify({ roots: [self], tree: [self, ...(tree.holds ?? []).map(identity)] });
    files[`/proc/${self.pid}/stat`] = `${self.pid} (node) S 1 ${"0 ".repeat(17)}${self.pid * 10} 0 0`;
    files[`/proc/${self.pid}/status`] = `Name:\tnode\nVmRSS:\t ${tree.residentMib * 1024} kB\nVmSwap:\t 0 kB\n`;
  }
  const entries = trees.map((tree, i): ReadingEntry => ({
    id: tree.id, owner: "state2@c1", workerClass: tree.workerClass, estimateMib: tree.estimateMib,
    estimateSource: { kind: "measured", samples: 30 }, status: "owned", ageMs: (i + 1) * 60_000, sinceVerifiedMs: 1000,
    walkComplete: true, path: `/ledger/${tree.id}.json`, ...(tree.released ? { occupancyReleased: true } : {}),
  }));
  const reading: HostMemoryReading = {
    state: "present", scope: "host", dir: "/ledger", entries,
    counts: { live: entries.length, uncertain: 0, incompleteWalk: 0, localScope: 0, unreadable: 0 },
    reservedMib: entries.reduce((sum, e) => sum + e.estimateMib, 0),
  };
  const factorAt = new Map(entries.map((entry, i) => [entry.ageMs, trees[i]!.factor]));
  return { files, reading, factorAt };
}

function ports(trees: Tree[], memAvailableMib: number, rows: LedgerLine[], opened: string[], onSleep: () => void,
  psi?: { some: number; full: number }): Partial<AdmissionPorts> {
  const h = host(trees, memAvailableMib, psi);
  let now = NOW;
  return {
    clock: { now: () => now, date: () => new Date(now), iso: () => new Date(now).toISOString() },
    readFile: (path) => {
      const text = h.files[path];
      if (text === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
      return text;
    },
    readTail: () => `${JSON.stringify({ ts: new Date(NOW - 3_600_000).toISOString(), step: "x" })}\n`,
    readLedger: () => h.reading,
    policy: () => POLICY,
    write: (_path, row) => void rows.push(row),
    writeFile: () => undefined,
    calibrationSamples: () => [],
    publishCalibration: () => undefined,
    stderr: () => undefined,
    instance: () => "state2",
    daemonPid: () => 777,
    listStateDir: () => [],
    estimate: (cls) => ESTIMATE[cls] ?? 1024,
    typical: (cls) => TYPICAL[cls] ?? 1024,
    survival: (_cls, ageMs) => ({ factor: h.factorAt.get(ageMs) ?? 1, samples: 30 }),
    readReviewDemand: () => ({ state: "present", rows: [], unreadableRows: 0 }),
    readHostServe: () => ({ state: "unknown", cause: "local-only", basis: "test fixture" }),
    enforceHere: () => true,
    withLock: (action) => action(),
    openReservation: (input) => {
      opened.push(input.workerClass);
      const id = `grant-${opened.length}`;
      // The admission re-reads the ledger and refuses a reservation it cannot see.
      h.reading.entries.push({ ...h.reading.entries[0] ?? { owner: "state2@c1", status: "owned", sinceVerifiedMs: 0, walkComplete: true },
        id, workerClass: input.workerClass, estimateMib: ESTIMATE[input.workerClass]!, estimateSource: { kind: "measured", samples: 30 },
        ageMs: 0, path: `/ledger/${id}.json` } as ReadingEntry);
      return { id, published: true, workerClass: input.workerClass, estimateMib: ESTIMATE[input.workerClass]!,
        estimateSource: { kind: "measured", samples: 30 }, bindRoot: () => undefined, releaseOccupancy: () => undefined };
    },
    random: () => 0.5,
    sleep: async (ms) => {
      now += ms;
      onSleep();
      await Promise.resolve();
    },
  };
}

/** One enforced fix start against `trees`, stopped at its first wait. */
async function fixStart(trees: Tree[], memAvailableMib: number, psi?: { some: number; full: number }) {
  resetShadowMemoryStateForTests();
  resetMemoryAdmissionStateForTests();
  const rows: LedgerLine[] = [];
  const opened: string[] = [];
  const stop = new AbortController();
  const outcome = await awaitMemoryAdmission({ workerClass: "fix", root: ROOT, runId: "W1-T13991-1", taskId: "W1-T13991",
    signal: stop.signal }, ports(trees, memAvailableMib, rows, opened, () => stop.abort(), psi));
  const numbers = (row: LedgerLine | undefined) => (row?.numbers ?? {}) as Record<string, number>;
  return { outcome, rows, opened, wait: rows.find((row) => row.step === ENFORCE_WAIT_STEP), numbers };
}

test("W1-T14155 criterion 1: the 12:07-13:15Z replay holds a fix start the one-tail claim admitted, on unrealized reservations", async () => {
  // 12:22:16 as the row showed it: no test runner live, so the claim is today's and the start fits.
  const quiet = await fixStart(window1222(), 9234);
  assert.equal(quiet.outcome.kind, "admitted");
  assert.equal(quiet.outcome.kind === "admitted" && quiet.outcome.tier, "fits");
  assert.deepEqual(quiet.opened, ["fix"]);
  const quietVerdict = evaluateShadowMemory(snapshot(window1222(), 9234), POLICY);
  assert.deepEqual([quietVerdict.numbers.memAvailableMib, quietVerdict.numbers.unrealizedMib, quietVerdict.numbers.hostClaimMib,
    quietVerdict.numbers.hostClaimUndecayedMib, quietVerdict.numbers.hostTypicalMib], [9234, 52727, 2690, 7244, 845],
  "the fixture carries the admit row's numbers");

  // The same trees and MemAvailable once two fix runs have reached their test runs (13:13Z: 30 node --test runners).
  const trees = [...window1222({ F1: ["test-W1-T10937"], F3: ["test-W1-T13850"] }), testRun("test-W1-T10937"), testRun("test-W1-T13850")];
  const held = await fixStart(trees, 9234);
  assert.equal(held.outcome.kind, "abandoned", "the start waited; only the test's stop ended the wait");
  assert.deepEqual(held.opened, [], "no reservation was opened for the held start");
  assert.ok(held.wait, "an enforce_wait row was written");
  assert.deepEqual(held.wait.reasons, ["unrealized-reservations"]);
  const n = held.numbers(held.wait);
  assert.equal(n.hostClaimOneTailMib, 2690, "the one-tail claim still fits: 9234 - 2690 is over the 2048 reserve");
  assert.ok(n.memAvailableMib! - n.hostClaimOneTailMib! - n.marginMib! >= POLICY.hostReserveMib, "the current claim would admit it");
  assert.equal(n.validatingTails, 4, "two test runs and the two fix trees that hold them");
  assert.equal(n.validatingTailsMib, 2 * 1434 + 2 * 1811);
  assert.equal(n.hostClaimMib, 845 + 6490 + 1845);
  assert.ok(n.memAvailableMib! - n.hostClaimMib! < POLICY.hostReserveMib);
  assert.equal(held.rows.some((row) => row.step === ENFORCE_ADMIT_STEP), false);
});

/** The same trees as pure inputs, flagged as the gather flags them. */
function snapshot(trees: Tree[], memAvailableMib: number): ShadowInputs {
  const live = (id: string) => trees.some((tree) => tree.id === id && !tree.released);
  const entries = trees.map((tree, i): ShadowEntryInput => ({
    id: tree.id, owner: "state2@c1", workerClass: tree.workerClass, estimateMib: tree.estimateMib,
    estimateSource: { kind: "measured", samples: 30 }, status: "owned", walkComplete: true,
    resident: { mib: tree.residentMib, complete: true }, ageMs: (i + 1) * 60_000,
    typicalMib: Math.min(TYPICAL[tree.workerClass]!, tree.estimateMib), survival: { factor: tree.factor, samples: 30 },
    ...(tree.released ? { occupancyReleased: true } : {}),
    ...(!tree.released && (tree.workerClass === "test" || (tree.holds ?? []).some(live)) ? { validating: true } : {}),
  }));
  return {
    memAvailable: { mib: memAvailableMib }, swapIn: { pagesPerSec: 0 },
    psi: { someAvg10: 0.77, someAvg60: 0, fullAvg10: 0.28, fullAvg60: 0 },
    container: { currentMib: 15_462, maxMib: 26_214 }, ledger: { state: "present" }, entries,
    start: { workerClass: "fix", estimateMib: 2600, typicalMib: 755 },
    daemonGrowth: [{ instance: "state2", samples: 30, growthMib: 0, own: true }],
    serve: { scenario: "serve-stopped", basis: "test" },
  };
}

test("W1-T14155 criterion 2: each validating tree claims its learned tail; other trees keep typical growth and share one tail", async () => {
  resetShadowMemoryStateForTests();
  const rows: LedgerLine[] = [];
  // F1 holds a live test run; F3 holds one that has ended, so F3 is back to typical growth only.
  const trees = [...window1222({ F1: ["test-live"], F3: ["test-ended"] }), testRun("test-live"), testRun("test-ended", 1, true)];
  const p = ports(trees, 9234, rows, [], () => undefined);
  recordShadowMemoryVerdict({ workerClass: "fix", runId: "W1-T13991-1", taskId: "W1-T13991", root: ROOT },
    { ...p, policy: () => ({ ...POLICY, mode: "shadow" }) });
  const row = rows.find((r) => r.step === "memory_budget.shadow");
  assert.ok(row, "the shadow row was written");
  const n = row.numbers as Record<string, number>;
  assert.equal(n.validatingTails, 2, "the live test run and the fix tree that holds it; not F3, whose run ended");
  assert.equal(n.validatingTailsMib, 1434 + 1811, "each validating tree's own charged tail, in full");
  assert.equal(n.hostTypicalMib, 845, "every tree's typical growth counts once, validating or not");
  assert.equal(n.hostTailMib, 1845, "the other trees and the start share the one tail: the start's 1845");
  assert.equal(n.hostClaimMib, 845 + 1434 + 1811 + 1845);
  assert.equal(n.hostClaimOneTailMib, 845 + 1845, "the one-tail claim is published for comparison");

  // The own-tail rung counts the validating tails as claims: every other tree decayed, so only they hold it.
  const decayed = [fix("fix-a", 756, 0.25, ["test-a"]), testRun("test-a", 0.5)];
  const own = await fixStart(decayed, 5000, { some: 0, full: 0 });
  assert.equal(own.outcome.kind, "abandoned", "the own-tail rung does not admit over a validating tree's tail");
  assert.equal(own.wait?.own_tail_blocked, "typical-short");
  const ownTail = own.wait?.own_tail as Record<string, number>;
  const m = own.numbers(own.wait);
  assert.equal(ownTail.typical_headroom_mib, 5000 - 755 - (1434 + 905.5) - m.marginMib!);
  assert.ok(5000 - 755 - m.marginMib! >= POLICY.hostReserveMib, "without the validating tails the rung would admit");
});

test("W1-T14155 criterion 3: with no live validating tree the claim is today's, so an idle host admits its first worker", async () => {
  const quiet = evaluateShadowMemory(snapshot(window1222(), 9234), POLICY);
  assert.equal(quiet.numbers.validatingTails, 0);
  assert.equal(quiet.numbers.validatingTailsMib, 0);
  assert.equal(quiet.numbers.hostClaimMib, quiet.numbers.hostClaimOneTailMib);
  assert.equal(quiet.numbers.hostClaimMib, quiet.numbers.hostTypicalMib + quiet.numbers.hostTailMib);
  resetShadowMemoryStateForTests();
  const rows: LedgerLine[] = [];
  const p = ports(window1222(), 9234, rows, [], () => undefined);
  recordShadowMemoryVerdict({ workerClass: "fix", root: ROOT }, { ...p, policy: () => ({ ...POLICY, mode: "shadow" }) });
  const row = rows.find((r) => r.step === "memory_budget.shadow");
  assert.ok(row, "the quiet host writes a shadow row");
  const n = row.numbers as Record<string, number>;
  assert.equal(n.validatingTails, 0);
  assert.equal(n.hostClaimMib, quiet.numbers.hostClaimMib);

  // A test run that has ended leaves its tree with today's claim.
  const ended = evaluateShadowMemory(snapshot([...window1222({ F1: ["t"] }), testRun("t", 1, true)], 9234), POLICY);
  assert.equal(ended.numbers.validatingTails, 0);
  assert.equal(ended.numbers.hostClaimMib, quiet.numbers.hostClaimMib);

  // An idle host: no live tree at all. The first fix start is admitted through the enforced path.
  const idle = await fixStart([], 9234, { some: 0, full: 0 });
  assert.equal(idle.outcome.kind, "admitted");
  assert.equal(idle.outcome.kind === "admitted" && idle.outcome.tier, "fits");
  assert.deepEqual(idle.opened, ["fix"]);
});
