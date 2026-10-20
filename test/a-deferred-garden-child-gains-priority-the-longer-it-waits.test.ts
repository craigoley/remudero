/**
 * W1-T9761: a garden child deferred for memory gains priority the longer it waits, so it eventually runs. MEASURED
 * 2026-10-15 02:00-22:01Z: 5,984 garden deferrals against 90 admits, because each re-ask started its wait at zero.
 * Fixture (the design's): an enforced garden policy, a verdict short for unrealized-reservations and psi with 5,000 MiB
 * MemAvailable while one build reservation runs, and an injected clock.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { mock, test } from "node:test";

// Namespace imports for what the fix adds, so at the base the file still loads and each case fails on its own claim.
import * as admission from "../src/lib/host-memory-admission.js";
import {
  ENFORCE_ADMIT_STEP,
  ENFORCE_DEFER_STEP,
  awaitMemoryAdmission,
  resetMemoryAdmissionStateForTests,
  type AdmissionPorts,
  type AdmissionRequest,
} from "../src/lib/host-memory-admission.js";
import type { HostMemoryReading, ReadingEntry } from "../src/lib/host-memory-ledger.js";
import * as registry from "../src/lib/garden-registry.js";
import { childGardenPassSpawn, startGardenOffLoop, type GardenDeferral, type GardenPassOutcome } from "../src/lib/garden-registry.js";
import { resetShadowMemoryStateForTests, type HostMemoryBudgetPolicy } from "../src/lib/host-memory-shadow.js";
import type { LedgerLine } from "../src/lib/ledger.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { gitWorkTreeAncestor } from "../src/lib/worker-home.js";

const REPO_ROOT = join(import.meta.dirname, "..");
const NOW = Date.parse("2026-10-16T16:00:00.000Z");
const MIB = 1024 * 1024;
const CADENCE_MS = 4 * 60_000;
/** The one live build's learned estimate. */
const BUILD_MIB = 3072;

const POLICY: HostMemoryBudgetPolicy = {
  mode: "shadow",
  classModes: { garden: "enforce" },
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

/** A host under memory pressure (PSI some avg10 20) whose MemAvailable the test moves. */
function host(state: { availableMib: number }): (path: string) => string {
  return (path) => {
    const table: Record<string, string> = {
      "/proc/meminfo": `MemAvailable: ${state.availableMib * 1024} kB\n`,
      "/proc/vmstat": "pswpin 100\n",
      "/proc/pressure/memory": "some avg10=20.00 avg60=0.00 avg300=0.00 total=1\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=1\n",
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

interface World {
  rows: LedgerLine[];
  now: { ms: number };
  state: { availableMib: number };
  running: { entries: Array<Partial<ReadingEntry>> };
}

function world(): World {
  return { rows: [], now: { ms: NOW }, state: { availableMib: 5000 }, running: { entries: [{ id: "build", workerClass: "implement", estimateMib: BUILD_MIB }] } };
}

function ports(w: World): Partial<AdmissionPorts> {
  return {
    clock: { now: () => w.now.ms, date: () => new Date(w.now.ms), iso: () => new Date(w.now.ms).toISOString() },
    readFile: host(w.state),
    readTail: () => `${JSON.stringify({ ts: new Date(NOW - 3_600_000).toISOString(), step: "x" })}\n`,
    readLedger: () => reading(w.running.entries),
    policy: () => POLICY,
    write: (_path, row) => void w.rows.push(row),
    stderr: () => undefined,
    instance: () => "state2",
    daemonPid: () => 777,
    listStateDir: () => [],
    estimate: () => 900,
    readReviewDemand: () => ({ state: "present", rows: [], unreadableRows: 0 }),
    enforceHere: () => true,
    withLock: (action) => action(),
    openReservation: (input) => {
      const id = `grant-${w.running.entries.length}`;
      w.running.entries.push({ id, workerClass: input.workerClass, estimateMib: 900 });
      return { id, published: true, workerClass: input.workerClass, estimateMib: 900,
        estimateSource: { kind: "measured", samples: 30 }, bindRoot: () => undefined,
        releaseOccupancy: () => { const entry = w.running.entries.find((e) => e.id === id); if (entry) entry.occupancyReleased = true; } };
    },
    random: () => 0.5,
    sleep: async () => { throw new Error("a deferred garden waited instead of returning"); },
  };
}

function ask(w: World, garden: string, deferral: AdmissionRequest["deferral"] | null = { cadenceMs: CADENCE_MS, cadenceBasis: "measured" }) {
  return awaitMemoryAdmission({ workerClass: "garden", root: "/home/node/Remudero", taskId: "GARDEN", runId: `garden-${garden}`,
    onShortfall: "defer", ...(deferral === null ? {} : { deferral }) }, ports(w));
}

const rowsOf = (w: World, step: string, garden: string) => w.rows.filter((row) => row.step === step && row.run_id === `garden-${garden}`);

function fresh(): World {
  resetShadowMemoryStateForTests();
  resetMemoryAdmissionStateForTests();
  return world();
}

function scratchDir(prefix: string): string {
  const parent = [tmpdir(), dirname(REPO_ROOT)].find((candidate) => gitWorkTreeAncestor(candidate) === undefined);
  assert.ok(parent, "the test host must provide a scratch parent outside every Git work tree");
  return mkdtempSync(join(parent, `${RMD_TMP_PREFIX}${prefix}`));
}

test("W1-T9761: a garden deferred for its own pass cadence is admitted on the aged rung", async () => {
  const w = fresh();
  const outcomes = [];
  // The falsifier's schedule: one ask per half cadence, over five cadences, while the build runs.
  for (let i = 0; i < 10; i++) {
    const outcome = await ask(w, "gate");
    outcomes.push(outcome);
    if (outcome.kind === "admitted") break;
    w.now.ms += CADENCE_MS / 2;
  }
  const defers = rowsOf(w, ENFORCE_DEFER_STEP, "gate");
  assert.deepEqual(defers[0]!.reasons, ["psi", "unrealized-reservations"], "the fixture is short for the design's projected reasons");
  assert.equal(defers.length, 2, "deferred while younger than its cadence");
  const admitted = outcomes.at(-1)!;
  assert.equal(admitted.kind, "admitted");
  assert.equal(admitted.kind === "admitted" && admitted.tier, "aged", "admitted on the aged rung, not deferred again");
  assert.ok(w.running.entries.some((e) => e.id === "build" && !e.occupancyReleased), "the build still runs");
  const [row] = rowsOf(w, ENFORCE_ADMIT_STEP, "gate");
  assert.equal(row!.tier, "aged");
  assert.equal(row!.waited_ms, CADENCE_MS, "the streak's wait, not this call's");
  assert.equal(row!.deferrals, 2);
  assert.equal(row!.cadence_ms, CADENCE_MS);
  assert.equal(row!.cadence_basis, "measured");
  assert.deepEqual(row!.overrode, ["psi", "unrealized-reservations"]);
  assert.deepEqual(admission.openDeferralStreaks?.(), [], "the admission clears the streak");
});

test("W1-T9761: a garden younger than its cadence is still deferred and the row names its streak", async () => {
  const w = fresh();
  assert.equal((await ask(w, "config")).kind, "deferred");
  w.now.ms += CADENCE_MS - 1;
  assert.equal((await ask(w, "config")).kind, "deferred", "one millisecond short of its cadence");
  const row = rowsOf(w, ENFORCE_DEFER_STEP, "config")[1]!;
  assert.equal(row.deferred_since, new Date(NOW).toISOString(), "the streak began at the first deferral");
  assert.equal(row.deferrals, 2);
  assert.equal(row.cadence_ms, CADENCE_MS);
  assert.equal(row.cadence_basis, "measured");
  assert.equal(row.aged_blocked, "younger-than-cadence");
  assert.equal(rowsOf(w, ENFORCE_ADMIT_STEP, "config").length, 0);
  assert.equal((await ask(w, "config", null)).kind, "deferred", "a caller that names no cadence is never aged");
  assert.equal(rowsOf(w, ENFORCE_DEFER_STEP, "config")[2]!.aged_blocked, "no-cadence");
});

test("W1-T9761: a restart does not reset the wait of a deferred garden", async () => {
  const root = scratchDir("garden-aged-");
  try {
    const script = join(root, "garden-pass.cjs");
    writeFileSync(script, "process.exitCode = 0;\n");
    const spawnIn = (stateRoot: string, w: World) => childGardenPassSpawn({ execPath: process.execPath, execArgv: [], entry: script,
      ionice: "/nonexistent-ionice", setPriority: () => undefined, log: () => undefined, root: stateRoot, admission: ports(w),
      reserve: () => ports(w).openReservation!({ workerClass: "garden", root: stateRoot }) });
    const deferral: GardenDeferral = { cadenceMs: CADENCE_MS, cadenceBasis: "scheduled", samples: 0, firstAsk: true };
    // The previous daemon generation's runtime file: gate last completed ten cadences ago.
    const lastCompletedAt = new Date(NOW - 10 * CADENCE_MS).toISOString();
    mkdirSync(join(root, "state"));
    writeFileSync(join(root, "state", "gardener-runtime.json"), JSON.stringify({ version: 1, repository: "craigoley/remudero",
      daemonRunId: "DAEMON-1", codeSha: null, configuredAt: lastCompletedAt, observedAt: lastCompletedAt, gardens: [{
        name: "gate", enabled: true, cadenceMs: CADENCE_MS, scope: "repository", phase: "completed", observedAt: lastCompletedAt,
        passId: null, nextDueAt: null, queueMs: null, executionMs: null, exit: 0, reason: "process-completed", attempts: 1,
        completions: 1, failures: 0, lastCompletedAt, lastSuccessAt: lastCompletedAt, lastFailureAt: null }] }));

    const restarted = fresh(); // a new process: no streak survives in memory
    const spawn = spawnIn(root, restarted);
    const first: GardenPassOutcome = await spawn("gate", [], { stopped: false, deferral });
    assert.deepEqual(first, { kind: "deferred", reason: "memory-budget-shortfall" }, "the seed alone admits no first ask");
    restarted.now.ms += 1_000;
    const outcome: GardenPassOutcome = await spawn("gate", [], { stopped: false, deferral: { ...deferral, firstAsk: false } });
    assert.equal(outcome, 0, "one observed deferral later, the seeded wait runs the starved garden");
    const [row] = rowsOf(restarted, ENFORCE_ADMIT_STEP, "gate");
    assert.equal(row!.tier, "aged");
    assert.equal(row!.seeded_ms, 9 * CADENCE_MS, "the age carried in since it was last due: its last completed pass plus its cadence");
    assert.equal(row!.cadence_basis, "scheduled");

    const control = fresh();
    const unseeded = await spawnIn(join(root, "no-runtime"), control)("gate", [], { stopped: false, deferral });
    assert.deepEqual(unseeded, { kind: "deferred", reason: "memory-budget-shortfall" }, "with no earlier pass recorded, the wait starts now");
  } finally {
    resetShadowMemoryStateForTests();
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T9761: only one aged garden child runs at a time", async () => {
  const w = fresh();
  assert.equal((await ask(w, "gate")).kind, "deferred");
  w.now.ms += CADENCE_MS / 2;
  assert.equal((await ask(w, "config")).kind, "deferred");
  w.now.ms += CADENCE_MS;
  assert.equal((await ask(w, "config")).kind, "deferred", "config is past its cadence but gate has waited longer");
  assert.equal(rowsOf(w, ENFORCE_DEFER_STEP, "config")[1]!.aged_blocked, "outranked");
  const gate = await ask(w, "gate");
  assert.equal(gate.kind === "admitted" && gate.tier, "aged");
  const held = await ask(w, "config");
  assert.equal(held.kind, "deferred", "a second starved garden waits while the first aged child runs");
  assert.equal(rowsOf(w, ENFORCE_DEFER_STEP, "config")[2]!.aged_blocked, "aged-child-running");
  if (gate.kind === "admitted") gate.endAged?.();
  const next = await ask(w, "config");
  assert.equal(next.kind === "admitted" && next.tier, "aged", "once the first aged child ends, the next may start");
});

test("W1-T9761: measured headroom below the reserve still defers an aged garden", async () => {
  const w = fresh();
  w.state.availableMib = 1500;
  assert.equal((await ask(w, "backlog")).kind, "deferred");
  w.now.ms += 5 * CADENCE_MS;
  const outcome = await ask(w, "backlog");
  assert.equal(outcome.kind, "deferred", "the memory is short now, not only projected short");
  const row = rowsOf(w, ENFORCE_DEFER_STEP, "backlog")[1]!;
  assert.ok((row.reasons as string[]).includes("memory-available"));
  assert.equal(row.aged_blocked, "memory-available");
  assert.equal(row.deferrals, 2);
  assert.equal(rowsOf(w, ENFORCE_ADMIT_STEP, "backlog").length, 0);
});

test("W1-T9761: the garden loop hands its spawn its measured cadence and ends a streak when not due", async () => {
  mock.timers.enable({ apis: ["setInterval"] });
  const w = fresh();
  try {
    assert.equal(registry.gardenCadence?.([10], 5).cadenceBasis, "scheduled", "one interval is not a measurement");
    assert.equal(registry.gardenCadence?.([10, 30, 20], 5).cadenceMs, 20, "the median of an odd count of intervals");
    const seen: GardenDeferral[] = [];
    const outcomes: GardenPassOutcome[] = [0, 0, 0, { kind: "deferred", reason: "memory-budget-shortfall" }, 0];
    const due = [true, false, true, true, true];
    const clock = { now: () => w.now.ms, date: () => new Date(w.now.ms), iso: () => new Date(w.now.ms).toISOString() };
    const loop = startGardenOffLoop("gate", 60_000, { clock, log: () => undefined, due: () => due.shift() ?? true,
      spawnPass: async (_name, _args, signal) => { seen.push(signal.deferral!); return outcomes.shift() ?? 0; } });
    const step = async (): Promise<void> => {
      w.now.ms += 60_000;
      mock.timers.tick(60_000);
      await new Promise((resolve) => setImmediate(resolve));
    };
    await new Promise((resolve) => setImmediate(resolve));
    await ask(w, "gate");
    assert.equal(admission.openDeferralStreaks?.().length, 1);
    await step(); // not due: the garden no longer asks
    assert.equal(admission.openDeferralStreaks?.().length, 0, "a garden that is not due ends its streak");
    for (let i = 0; i < 4; i++) await step();
    loop.stop();
    assert.deepEqual(seen.map((d) => d.firstAsk), [true, false, false, false, false]);
    assert.deepEqual(seen.slice(0, 3).map((d) => d.cadenceBasis), ["scheduled", "scheduled", "scheduled"]);
    // Completed at 0, 120 s and 180 s: gaps 120 s and 60 s. The deferred pass at 240 s is not a completion.
    assert.deepEqual(seen.slice(3).map((d) => [d.cadenceBasis, d.cadenceMs]), [["measured", 90_000], ["measured", 90_000]]);
  } finally {
    mock.timers.reset();
  }
});

/** The design's fixture after a restart: the garden was last due ten cadences ago, by the previous generation's file. */
const SEEDED = (w: World): AdmissionRequest["deferral"] => ({ cadenceMs: CADENCE_MS, cadenceBasis: "scheduled", dueSinceMs: w.now.ms - 10 * CADENCE_MS });

test("W1-T9761: a restart seed alone never admits a first ask on the aged rung", async () => {
  const w = fresh(); // a restarted process: no streak, only the seed
  const first = await ask(w, "selector-shadow", SEEDED(w));
  assert.equal(first.kind, "deferred", "the first ask after a restart is judged on its verdict, not on the seed");
  const [row] = rowsOf(w, ENFORCE_DEFER_STEP, "selector-shadow");
  assert.equal(row!.aged_blocked, "unobserved-seed", "the row names why the seed did not admit it");
  assert.equal(row!.deferred_since, new Date(NOW - 10 * CADENCE_MS).toISOString(), "the seed joins the streak at its first deferral");
  assert.equal(rowsOf(w, ENFORCE_ADMIT_STEP, "selector-shadow").length, 0);
  w.now.ms += 1_000;
  const second = await ask(w, "selector-shadow", { cadenceMs: CADENCE_MS, cadenceBasis: "scheduled" });
  assert.equal(second.kind === "admitted" && second.tier, "aged", "after one observed deferral the seeded wait counts, so a restart does not reset it");
});

test("W1-T9761: an aged row reports its queueing wait apart from its seeded age", async () => {
  const w = fresh();
  w.state.availableMib = 1500; // measured short at the first ask, so it is deferred whatever the seed says
  assert.equal((await ask(w, "evidence-coverage", SEEDED(w))).kind, "deferred");
  w.state.availableMib = 5000;
  w.now.ms += 30_000;
  const outcome = await ask(w, "evidence-coverage", { cadenceMs: CADENCE_MS, cadenceBasis: "scheduled" });
  assert.equal(outcome.kind === "admitted" && outcome.tier, "aged");
  assert.equal(outcome.kind === "admitted" && outcome.waitedMs, 30_000);
  const [row] = rowsOf(w, ENFORCE_ADMIT_STEP, "evidence-coverage");
  assert.equal(row!.waited_ms, 30_000, "waited_ms is the queueing this process observed, from its first ask");
  assert.equal(row!.seeded_ms, 10 * CADENCE_MS, "seeded_ms is the age the restart seed carried in before that ask");
  assert.equal(row!.deferred_since, new Date(NOW - 10 * CADENCE_MS).toISOString());
  assert.equal(row!.deferrals, 1);
  assert.deepEqual(row!.reasons, ["psi", "unrealized-reservations"], "the aged row names its verdict's reasons like every admit row");
});
