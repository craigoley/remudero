/**
 * W1-T10069: the enforced memory admission held three fix starts 27-39 min on 2026-10-17 because the one tail it charged
 * was the start's OWN (3,788 MiB learned = 1,169 typical + 2,619 tail) while every other claim had decayed to nothing.
 * A shortfall that is the start's own tail alone is admitted on "own-tail" when its typical peak clears the reserve,
 * one such start at a time; psi and memory-available still refuse. Each test drives `awaitMemoryAdmission` with fake
 * ports and asserts the outcome and the rows only the admission writes.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ENFORCE_ADMIT_STEP,
  ENFORCE_WAIT_STEP,
  awaitMemoryAdmission,
  resetMemoryAdmissionStateForTests,
  type AdmissionPorts,
} from "#src/lib/host-memory-admission.js";
import type { HostMemoryReading, ReadingEntry } from "#src/lib/host-memory-ledger.js";
import type { Survival } from "#src/lib/host-memory-learning.js";
import { resetShadowMemoryStateForTests, type HostMemoryBudgetPolicy } from "#src/lib/host-memory-shadow.js";
import type { LedgerLine } from "#src/lib/ledger.js";

const NOW = Date.parse("2026-10-17T16:55:05.000Z");
const MIB = 1024 * 1024;
const FIX_ESTIMATE = 3788;
const FIX_TYPICAL = 1169;

const POLICY: HostMemoryBudgetPolicy = {
  mode: "enforce", hostReserveMib: 2048, containerReserveMib: 1024, swapInPagesPerSecMax: 256, psiSomeAvg10Max: 10,
  psiFullAvg10Max: 2, serveColdStartReserveMib: 7680, uncertaintyMarginMib: 256, daemonGrowthUnmeasuredMib: 1024,
  daemonGrowthMinSamples: 6, staleReadingMs: 600_000,
};

interface World {
  rows: LedgerLine[];
  sleeps: number[];
  now: { ms: number };
  host: { availableMib: number; psiFull: number };
  entries: Array<Partial<ReadingEntry>>;
  /** Each live tree's survival by id; a tree not named here decays to nothing (past its time-to-peak). */
  survival: Map<string, number>;
  onSleep: (w: World) => void;
  /** Aborted past a bound on sleeps, so a start that would wait forever ends as "abandoned" rather than hanging. */
  stop: AbortController;
}

function world(): World {
  return {
    rows: [], sleeps: [], now: { ms: NOW }, host: { availableMib: 4028, psiFull: 0 },
    // The 16:55Z shape: an advisory reservation aged 2,398 s, past its time-to-peak, so it is charged 0.
    entries: [{ id: "advisory-1", workerClass: "advisory", estimateMib: 1500, ageMs: 2_398_000 }],
    survival: new Map(), onSleep: () => undefined, stop: new AbortController(),
  };
}

function reading(w: World): HostMemoryReading {
  const full = w.entries.map((e, i): ReadingEntry => ({
    id: `r${i}`, owner: "state2@c1", workerClass: "fix", estimateMib: 1024, estimateSource: { kind: "measured", samples: 24 },
    status: "owned", ageMs: 1000, sinceVerifiedMs: 1000, walkComplete: true, path: `/ledger/r${i}.json`, ...e,
  }));
  return {
    state: "present", scope: "host", dir: "/ledger", entries: full,
    counts: { live: full.length, uncertain: 0, incompleteWalk: 0, localScope: 0, unreadable: 0 },
    reservedMib: full.reduce((sum, e) => sum + e.estimateMib, 0),
  };
}

function readFile(w: World): (path: string) => string {
  return (path) => {
    const psi = w.host.psiFull.toFixed(2);
    const table: Record<string, string> = {
      "/proc/meminfo": `MemAvailable: ${w.host.availableMib * 1024} kB\n`,
      "/proc/vmstat": "pswpin 100\n",
      "/proc/pressure/memory": `some avg10=${psi} avg60=0.00 avg300=0.00 total=1\nfull avg10=${psi} avg60=0.00 avg300=0.00 total=1\n`,
      "/sys/fs/cgroup/memory.current": `${2000 * MIB}\n`,
      "/sys/fs/cgroup/memory.max": `${12_000 * MIB}\n`,
      "/sys/fs/cgroup/memory.swap.current": "0\n",
      "/sys/fs/cgroup/memory.stat": "anon 1\nfile 1\n",
      "/sys/fs/cgroup/memory.events": "low 0\nhigh 0\nmax 0\noom 0\noom_kill 0\n",
      "/proc/777/status": "VmHWM:\t 1048576 kB\nVmRSS:\t 1048576 kB\n",
    };
    const text = table[path];
    if (text === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
    return text;
  };
}

function ports(w: World): Partial<AdmissionPorts> {
  return {
    clock: { now: () => w.now.ms, date: () => new Date(w.now.ms), iso: () => new Date(w.now.ms).toISOString() },
    readFile: readFile(w),
    readTail: () => `${JSON.stringify({ ts: new Date(NOW - 3_600_000).toISOString(), step: "x" })}\n`,
    readLedger: () => reading(w),
    policy: () => POLICY,
    write: (_path, row) => void w.rows.push(row),
    stderr: () => undefined,
    instance: () => "state2",
    daemonPid: () => 777,
    listStateDir: () => [],
    estimate: (workerClass) => workerClass === "fix" ? FIX_ESTIMATE : 1500,
    typical: (workerClass) => workerClass === "fix" ? FIX_TYPICAL : 600,
    survival: (_workerClass, ageMs): Survival => {
      const entry = w.entries.find((e) => e.ageMs === ageMs);
      return { factor: (entry?.id !== undefined ? w.survival.get(entry.id) : undefined) ?? 0, samples: 24 };
    },
    readReviewDemand: () => ({ state: "present", rows: [], unreadableRows: 0 }),
    enforceHere: () => true,
    withLock: (action) => action(),
    openReservation: (input) => {
      const id = `grant-${w.entries.length}`;
      w.entries.push({ id, workerClass: input.workerClass, estimateMib: FIX_ESTIMATE, ageMs: 5_000 + w.entries.length });
      return { id, published: true, workerClass: input.workerClass, estimateMib: FIX_ESTIMATE,
        estimateSource: { kind: "measured", samples: 24 }, bindRoot: () => undefined, releaseOccupancy: () => undefined };
    },
    random: () => 0.5,
    sleep: async (ms) => {
      w.sleeps.push(ms);
      w.now.ms += ms;
      w.onSleep(w);
      if (w.sleeps.length >= 12) w.stop.abort();
      await Promise.resolve();
    },
  };
}

const fixStart = (w: World, n: number) => ({ workerClass: "fix" as const, root: "/home/node/Remudero", runId: `W1-T1002${n}-fix`,
  taskId: `W1-T1002${n}`, signal: w.stop.signal });

function reset(): void {
  resetShadowMemoryStateForTests();
  resetMemoryAdmissionStateForTests();
}

test("W1-T10069: a start short only by its own tail is admitted on the own-tail tier", async () => {
  reset();
  const w = world();
  const outcome = await awaitMemoryAdmission(fixStart(w, 5), ports(w));
  assert.equal(outcome.kind, "admitted");
  assert.equal(outcome.kind === "admitted" && outcome.tier, "own-tail", "4,028 MiB less the start's 1,169 typical clears the 2,048 reserve");
  assert.equal(outcome.kind === "admitted" && outcome.attempts, 0, "admitted at its first ask, not after a 37-minute wait");
  const admit = w.rows.find((row) => row.step === ENFORCE_ADMIT_STEP);
  assert.equal(admit?.tier, "own-tail");
  assert.deepEqual(admit?.reasons, ["unrealized-reservations"], "the full learned claim still did not fit");
  const numbers = admit?.numbers as { hostTailOwner: string; hostTailMib: number; hostClaimMib: number };
  assert.equal(numbers.hostTailOwner, "start");
  assert.equal(numbers.hostClaimMib, FIX_ESTIMATE, "the advisory reservation is charged 0: the claim is the start's alone");
  const ownTail = admit?.own_tail as Record<string, number>;
  assert.equal(ownTail.start_typical_mib, FIX_TYPICAL);
  assert.equal(ownTail.start_tail_mib, FIX_ESTIMATE - FIX_TYPICAL);
  assert.equal(ownTail.other_claims_charged_mib, 0);
  assert.ok(ownTail.typical_headroom_mib >= POLICY.hostReserveMib, `typical headroom ${ownTail.typical_headroom_mib}`);
});

test("W1-T10069: a second own-tail start waits while the first is inside its time-to-peak", async () => {
  reset();
  const w = world();
  w.host.availableMib = 5000;
  const first = await awaitMemoryAdmission(fixStart(w, 5), ports(w));
  assert.equal(first.kind === "admitted" && first.tier, "own-tail");
  const firstId = first.kind === "admitted" ? first.reservation!.id! : "";
  // The first is decayed (so it is not undecayed work) but still has growth ahead: survival 0.5 at its age.
  w.survival.set(firstId, 0.5);
  w.onSleep = (world) => { if (world.sleeps.length === 2) world.survival.set(firstId, 0); };
  w.rows.length = 0;
  const second = await awaitMemoryAdmission(fixStart(w, 6), ports(w));
  const waits = w.rows.filter((row) => row.step === ENFORCE_WAIT_STEP);
  assert.equal(waits[0]?.own_tail_blocked, "own-tail-start-running", "the full claim is short and the typical clears, yet it waits");
  assert.deepEqual(w.sleeps, [5_000, 10_000], "it waited until the first was past its time-to-peak");
  assert.equal(second.kind === "admitted" && second.tier, "own-tail", "then the next one may run");
  assert.equal(second.kind === "admitted" && second.attempts, 2);
});

test("W1-T10069: psi or memory-available still refuse an own-tail start", async () => {
  for (const [label, shape, refused] of [
    ["psi", (w: World) => { w.host.psiFull = 12.07; }, "psi"],
    ["memory-available", (w: World) => { w.host.availableMib = 2000; }, "memory-available"],
  ] as const) {
    reset();
    const w = world();
    shape(w);
    w.onSleep = (world) => { if (world.sleeps.length === 3) world.stop.abort(); };
    const outcome = await awaitMemoryAdmission(fixStart(w, 7), ports(w));
    assert.equal(outcome.kind, "abandoned", `${label}: never admitted while it holds`);
    const waits = w.rows.filter((row) => row.step === ENFORCE_WAIT_STEP);
    assert.ok((waits[0]?.reasons as string[]).includes(refused), `${label}: the wait names it`);
    assert.equal(waits[0]?.own_tail_blocked, refused, `${label}: the own-tail rung names what refused it`);
    assert.equal(w.rows.some((row) => row.step === ENFORCE_ADMIT_STEP), false, `${label}: no admission row`);
  }
});

test("W1-T10069: a wait ledgers every change of its reasons and splits its waiting time by reason", async () => {
  reset();
  const w = world();
  // The W1-T10025 wait: psi and the start's own tail, then psi clears on a host still short of the typical peak.
  w.host.psiFull = 12.07;
  w.onSleep = (world) => {
    if (world.sleeps.length === 3) { world.host.psiFull = 0; world.host.availableMib = 3000; }
    if (world.sleeps.length === 5) world.host.availableMib = 4028;
  };
  const outcome = await awaitMemoryAdmission(fixStart(w, 5), ports(w));
  assert.equal(outcome.kind === "admitted" && outcome.tier, "own-tail");
  const waits = w.rows.filter((row) => row.step === ENFORCE_WAIT_STEP);
  assert.deepEqual(waits.map((row) => [row.attempt, row.reasons, row.own_tail_blocked]), [
    [0, ["psi", "unrealized-reservations"], "psi"],
    [3, ["unrealized-reservations"], "typical-short"],
  ], "one row when it began waiting, one when its reasons changed, none for a repeated reading");
  const admit = w.rows.find((row) => row.step === ENFORCE_ADMIT_STEP);
  assert.deepEqual(admit?.waited_ms_by_reason, { "psi+unrealized-reservations": 35_000, "unrealized-reservations": 100_000 });
  assert.equal(admit?.waited_ms, 135_000);
});

test("W1-T10069: another claim with its growth all ahead of it keeps an own-tail start waiting", async () => {
  reset();
  const w = world();
  // A review that has just started: survival 1, younger than every measured time to peak, though its tail is below the start's.
  w.entries.push({ id: "review-1", workerClass: "review", estimateMib: 600, ageMs: 30_000 });
  w.survival.set("review-1", 1);
  w.host.availableMib = 5000;
  w.onSleep = (world) => { if (world.sleeps.length === 2) world.survival.set("review-1", 0.4); };
  const outcome = await awaitMemoryAdmission(fixStart(w, 8), ports(w));
  const waits = w.rows.filter((row) => row.step === ENFORCE_WAIT_STEP);
  assert.equal(waits[0]?.own_tail_blocked, "other-claim-undecayed");
  assert.equal(outcome.kind === "admitted" && outcome.tier, "own-tail", "admitted once the review has begun to decay");
  assert.equal(outcome.kind === "admitted" && outcome.attempts, 2);
});
