/**
 * W1-T9975: a deferred garden ages against its own DUE INTERVAL (completion to the first ask of the next pass), carried
 * across restarts, not the 60 s loop tick. Fixture: an injected clock, a due probe that says yes once its interval has
 * passed, and a pass that defers twice before admitting.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { mock, test } from "node:test";

import { ENFORCE_ADMIT_STEP, ENFORCE_DEFER_STEP, resetMemoryAdmissionStateForTests, type AdmissionPorts, type AdmissionRequest } from "../src/lib/host-memory-admission.js";
import type { HostMemoryReading, ReadingEntry } from "../src/lib/host-memory-ledger.js";
import { childGardenPassSpawn, gardenCadenceWithCarried, startGardenOffLoop, type GardenDeferral, type GardenPassOutcome } from "../src/lib/garden-registry.js";
import { createGardenerRuntimeWriter, readGardenerRuntime, type GardenerRuntimeEvent } from "../src/lib/gardener-runtime.js";
import { resetShadowMemoryStateForTests, type HostMemoryBudgetPolicy } from "../src/lib/host-memory-shadow.js";
import type { LedgerLine } from "../src/lib/ledger.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { gitWorkTreeAncestor } from "../src/lib/worker-home.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const NOW = Date.parse("2026-10-16T16:00:00.000Z");
const MIB = 1024 * 1024;
const TICK_MS = 60_000;
const COVERAGE_MS = 57 * 60_000; // evidence-coverage's measured natural gap
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


const GATE = "evidence-coverage";
const clockOf = (ms: () => number) => ({ now: ms, date: () => new Date(ms()), iso: () => new Date(ms()).toISOString() });

function event(name: string, phase: GardenerRuntimeEvent["phase"], at: number, extra: Partial<GardenerRuntimeEvent> = {}): GardenerRuntimeEvent {
  return { name, phase, observedAt: new Date(at).toISOString(), passId: "p", nextDueAt: null, queueMs: null, executionMs: null,
    exit: phase === "completed" ? 0 : null, reason: phase === "completed" ? "process-completed" : null, ...extra };
}

/** One daemon generation: a runtime writer over `stateDir`, fed completed passes whose due intervals are given. */
async function generation(stateDir: string, id: string, at: number, intervalsMs: readonly number[]): Promise<void> {
  const clock = clockOf(() => at);
  const writer = createGardenerRuntimeWriter({ stateDir, repository: "craigoley/remudero", daemonRunId: id, clock, log: () => undefined,
    gardens: [{ name: GATE, enabled: true, cadenceMs: TICK_MS, scope: "repository" }] });
  let t = at;
  for (const dueIntervalMs of intervalsMs) {
    writer.record(event(GATE, "queued", t));
    t += 1_000;
    writer.record(event(GATE, "completed", t, { dueIntervalMs }));
  }
  await writer.flush();
}

function spawnIn(stateRoot: string, w: World): ReturnType<typeof childGardenPassSpawn> {
  const entry = join(stateRoot, "garden-pass.cjs");
  writeFileSync(entry, "process.exitCode = 0;\n");
  return childGardenPassSpawn({ execPath: process.execPath, execArgv: [], entry, ionice: "/nonexistent-ionice", setPriority: () => undefined,
    log: () => undefined, root: stateRoot, admission: ports(w), reserve: () => ports(w).openReservation!({ workerClass: "garden", root: stateRoot }) });
}
const scheduled: GardenDeferral = { cadenceMs: TICK_MS, cadenceBasis: "scheduled", samples: 0, firstAsk: true };

test("W1-T9975: a garden ages against its due interval, not its gap between completions", async () => {
  mock.timers.enable({ apis: ["setInterval"] });
  let nowMs = NOW;
  const clock = clockOf(() => nowMs);
  const seen: GardenDeferral[] = [];
  const events: GardenerRuntimeEvent[] = [];
  let nextDue = NOW; // due once its interval has passed, and until a pass completes
  let asksThisPeriod = 0;
  const loop = startGardenOffLoop("gate", TICK_MS, { clock, log: () => undefined, observe: (e) => void events.push(e), due: () => nowMs >= nextDue,
    spawnPass: async (_name, _args, signal) => {
      seen.push(signal.deferral!);
      if (++asksThisPeriod <= 2) return { kind: "deferred", reason: "memory-budget-shortfall" } as GardenPassOutcome; // defers twice
      asksThisPeriod = 0;
      nextDue = nowMs + 4 * TICK_MS; // the due probe next says yes four ticks after the completion
      return 0;
    } });
  try {
    await new Promise((resolve) => setImmediate(resolve));
    for (let i = 0; i < 20; i++) {
      nowMs += TICK_MS;
      mock.timers.tick(TICK_MS);
      await new Promise((resolve) => setImmediate(resolve));
    }
  } finally {
    loop.stop();
    mock.timers.reset();
  }
  // Completions land at 2, 8, 14 and 20 ticks (gaps of 6 ticks, which include two deferred asks each), but each
  // period's first ask is four ticks after the completion before it.
  const last = seen.at(-1)!;
  assert.equal(last.cadenceBasis, "measured");
  assert.equal(last.cadenceMs, 4 * TICK_MS, "the due interval, not the 6-tick gap between completions");
  assert.deepEqual(events.filter((e) => e.dueIntervalMs !== undefined).map((e) => e.dueIntervalMs), [4 * TICK_MS, 4 * TICK_MS, 4 * TICK_MS],
    "every completed pass after the first reports the interval its due period waited");
});

test("W1-T9975: a restart carries the measured due interval forward", async () => {
  const root = scratchDir("garden-carried-");
  try {
    const stateDir = join(root, "state");
    const lastCompletion = NOW - 120 * 60_000;
    await generation(stateDir, "DAEMON-1", lastCompletion, [COVERAGE_MS, COVERAGE_MS + 60_000, COVERAGE_MS - 60_000]);
    const saved = (await readGardenerRuntime(stateDir)).gardens[0]!;
    assert.deepEqual([saved.dueIntervalMedianMs, saved.dueIntervalSamples], [COVERAGE_MS, 3], "the writer persists the median and its samples");

    const restarted = fresh();
    const spawn = spawnIn(root, restarted);
    const first = await spawn(GATE, [], { stopped: false, deferral: scheduled });
    assert.deepEqual(first, { kind: "deferred", reason: "memory-budget-shortfall" }, "a restart seed alone admits no first ask");
    const [deferRow] = rowsOf(restarted, ENFORCE_DEFER_STEP, GATE);
    assert.equal(deferRow!.cadence_ms, COVERAGE_MS, "the garden is held to its own interval, not the 60 s tick");
    assert.equal(deferRow!.cadence_basis, "carried");
    assert.equal(deferRow!.cadence_samples, 3);
    restarted.now.ms += TICK_MS;
    const second = await spawn(GATE, [], { stopped: false, deferral: { ...scheduled, firstAsk: false } });
    assert.equal(second, 0, "the garden has been due longer than its interval, so it is aged in");
    const [admitRow] = rowsOf(restarted, ENFORCE_ADMIT_STEP, GATE);
    assert.deepEqual([admitRow!.tier, admitRow!.cadence_ms, admitRow!.cadence_basis, admitRow!.cadence_samples], ["aged", COVERAGE_MS, "carried", 3]);

    // Control: due only ten minutes ago, a garden with a 57 minute interval is not yet aged one tick later.
    await generation(stateDir, "DAEMON-2", NOW - 10 * 60_000 - 1_000, [COVERAGE_MS, COVERAGE_MS, COVERAGE_MS]);
    const recent = fresh();
    const young = spawnIn(root, recent);
    await young(GATE, [], { stopped: false, deferral: scheduled });
    recent.now.ms += TICK_MS;
    const stillDeferred = await young(GATE, [], { stopped: false, deferral: { ...scheduled, firstAsk: false } });
    assert.deepEqual(stillDeferred, { kind: "deferred", reason: "memory-budget-shortfall" }, "ten minutes into a 57 minute interval is not aged");

    // Its own two intervals stand once measured, joined to the carried one by sample count.
    const own: GardenDeferral = { cadenceMs: 100, cadenceBasis: "measured", samples: 2, firstAsk: false };
    assert.deepEqual(gardenCadenceWithCarried(own, { medianMs: 200, samples: 2 }), { cadenceMs: 150, cadenceBasis: "measured", samples: 4 });
    assert.deepEqual(gardenCadenceWithCarried({ ...own, cadenceBasis: "scheduled", samples: 1 }, { medianMs: 200, samples: 2 }),
      { cadenceMs: 200, cadenceBasis: "carried", samples: 2 }, "below two own intervals the carried median stands");
  } finally {
    resetShadowMemoryStateForTests();
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T9975: a short-lived generation keeps the carried completion and interval", async () => {
  const root = scratchDir("garden-short-");
  try {
    const stateDir = join(root, "state");
    const lastCompletion = NOW - 90 * 60_000;
    await generation(stateDir, "DAEMON-1", lastCompletion, [COVERAGE_MS, COVERAGE_MS]);
    const before = (await readGardenerRuntime(stateDir)).gardens[0]!;
    // The next generation boots, asks once (queued), and is replaced before any pass completes.
    const clock = clockOf(() => NOW);
    const writer = createGardenerRuntimeWriter({ stateDir, repository: "craigoley/remudero", daemonRunId: "DAEMON-2", clock, log: () => undefined,
      gardens: [{ name: GATE, enabled: true, cadenceMs: TICK_MS, scope: "repository" }] });
    writer.record(event(GATE, "queued", NOW));
    await writer.flush();
    const after = (await readGardenerRuntime(stateDir)).gardens[0]!;
    assert.equal(after.lastCompletedAt, before.lastCompletedAt, "the last completion survives a generation that completed nothing");
    assert.deepEqual([after.dueIntervalMedianMs, after.dueIntervalSamples], [COVERAGE_MS, 2]);
    assert.equal(after.completions, 0, "the carried completion is not counted as this generation's");
    // And a generation that measures its own intervals joins them to the carried ones by sample count.
    for (const at of [NOW + 1_000, NOW + 2_000]) {
      writer.record(event(GATE, "completed", at, { dueIntervalMs: 3 * 60_000 }));
      writer.record(event(GATE, "queued", at + 1));
    }
    await writer.flush();
    const joined = (await readGardenerRuntime(stateDir)).gardens[0]!;
    assert.deepEqual([joined.dueIntervalMedianMs, joined.dueIntervalSamples], [(3 * 60_000 * 2 + COVERAGE_MS * 2) / 4, 4]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T9975: with nothing measured or carried the scheduled interval stands in", async () => {
  const root = scratchDir("garden-scheduled-");
  try {
    const w = fresh();
    const spawn = spawnIn(root, w); // no runtime file: nothing carried
    const outcome = await spawn(GATE, [], { stopped: false, deferral: scheduled });
    assert.deepEqual(outcome, { kind: "deferred", reason: "memory-budget-shortfall" });
    const [row] = rowsOf(w, ENFORCE_DEFER_STEP, GATE);
    assert.deepEqual([row!.cadence_ms, row!.cadence_basis, row!.cadence_samples], [TICK_MS, "scheduled", 0], "the row says the interval is the scheduled one");
    assert.deepEqual(gardenCadenceWithCarried(scheduled, undefined), { cadenceMs: TICK_MS, cadenceBasis: "scheduled", samples: 0 });
    assert.equal(rowsOf(w, ENFORCE_ADMIT_STEP, GATE).length, 0);
  } finally {
    resetShadowMemoryStateForTests();
    rmSync(root, { recursive: true, force: true });
  }
});
