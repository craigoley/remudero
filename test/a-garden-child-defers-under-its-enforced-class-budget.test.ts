/**
 * Operator 2026-10-14 introduced per-class garden admission. Operator 2026-10-15 extends the shipped ruling to
 * build, fix, review and advisory after W1-T8472 landed. The isolated garden-only fixture below retains that seam.
 * A garden child that would not fit is deferred to its next pass, with one
 * memory_budget.enforce_defer row, and never dropped: the next pass asks again and runs once memory frees.
 * Each case asserts a state only the per-class mode produces: the shipped mode per class, a deferral row, a child that
 * never started, or a later pass that did.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { parse as parseYaml } from "yaml";

import {
  ENFORCE_DEFER_STEP,
  ENFORCE_WAIT_STEP,
  awaitMemoryAdmission,
  resetMemoryAdmissionStateForTests,
  type AdmissionPorts,
} from "../src/lib/host-memory-admission.js";
import type { HostMemoryReading, ReadingEntry } from "../src/lib/host-memory-ledger.js";
import { childGardenPassSpawn } from "../src/lib/garden-registry.js";
import {
  hostMemoryBudgetModeFor,
  parseHostMemoryBudgetPolicy,
  resetShadowMemoryStateForTests,
  type HostMemoryBudgetPolicy,
} from "../src/lib/host-memory-shadow.js";
import type { LedgerLine } from "../src/lib/ledger.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { gitWorkTreeAncestor } from "../src/lib/worker-home.js";

const REPO_ROOT = join(import.meta.dirname, "..");
const NOW = Date.parse("2026-10-14T16:00:00.000Z");
const MIB = 1024 * 1024;

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

/** A host whose MemAvailable the test moves: 9 GiB fits a 900 MiB start, 2.5 GiB does not. */
function host(state: { availableMib: number }): (path: string) => string {
  return (path) => {
    const table: Record<string, string> = {
      "/proc/meminfo": `MemAvailable: ${state.availableMib * 1024} kB\n`,
      "/proc/vmstat": "pswpin 100\n",
      "/proc/pressure/memory": "some avg10=0.00 avg60=0.00 avg300=0.00 total=1\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=1\n",
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
  sleeps: number[];
  now: { ms: number };
  state: { availableMib: number };
  running: { entries: Array<Partial<ReadingEntry>> };
}

function world(): World {
  return { rows: [], sleeps: [], now: { ms: NOW }, state: { availableMib: 9000 }, running: { entries: [] } };
}

function ports(w: World, over: Partial<AdmissionPorts> = {}): Partial<AdmissionPorts> {
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
      const id = `fixture-grant-${w.running.entries.length}`;
      w.running.entries.push({ id, workerClass: input.workerClass, estimateMib: 900 });
      return { id, published: true, workerClass: input.workerClass, estimateMib: 900,
        estimateSource: { kind: "measured", samples: 30 }, bindRoot: () => undefined,
        releaseOccupancy: () => { const entry = w.running.entries.find((e) => e.id === id); if (entry) entry.occupancyReleased = true; } };
    },
    random: () => 0.5,
    sleep: async (ms) => {
      w.sleeps.push(ms);
      w.now.ms += ms;
      // A start that waits out a shortfall here would back off forever: stop it, so the case fails instead of hanging.
      if (w.sleeps.length > 3) throw new Error("waited instead of deferring");
      await Promise.resolve();
    },
    ...over,
  };
}

function scratchDir(prefix: string): string {
  const parent = [tmpdir(), dirname(REPO_ROOT)].find((candidate) => gitWorkTreeAncestor(candidate) === undefined);
  assert.ok(parent, "the test host must provide a scratch parent outside every Git work tree");
  return mkdtempSync(join(parent, `${RMD_TMP_PREFIX}${prefix}`));
}

test("the operator-ratified budget enforces builds fixes reviews advisory and garden without promoting other classes", () => {
  const block = (parseYaml(readFileSync(join(REPO_ROOT, "plan", "policy.yaml"), "utf8")) as { sweep: { hostMemoryBudget: unknown } })
    .sweep.hostMemoryBudget;
  const shipped = parseHostMemoryBudgetPolicy(block);
  assert.equal(shipped.mode, "shadow", "the block's own mode stays shadow");
  assert.equal(hostMemoryBudgetModeFor(shipped, "garden"), "enforce", "operator 2026-10-14: garden children enforce");
  for (const workerClass of ["implement", "fix", "review", "advisory"] as const) {
    assert.equal(hostMemoryBudgetModeFor(shipped, workerClass), "enforce", `${workerClass} enforces the operator's 2026-10-15 ruling`);
  }
  for (const workerClass of ["check-proof", "test", "push-gate", "unclassified", "run-child-probe"] as const) {
    assert.equal(hostMemoryBudgetModeFor(shipped, workerClass), "shadow", `${workerClass} is outside the approved promotion`);
  }
  const row = (value: unknown) => ({ value, origin: "proposal" });
  const base = block as Record<string, unknown>;
  assert.throws(() => parseHostMemoryBudgetPolicy({ ...base, classModes: { gardener: row("enforce") } }), /unknown worker class/);
  assert.throws(() => parseHostMemoryBudgetPolicy({ ...base, classModes: { garden: row("block") } }), /accepts only/);
  assert.throws(() => parseHostMemoryBudgetPolicy({ ...base, classModes: { garden: { value: "enforce", origin: "ruling" } } }), /origin/);
  const { classModes: _dropped, ...withoutOverrides } = base;
  void _dropped;
  assert.equal(parseHostMemoryBudgetPolicy(withoutOverrides).classModes, undefined, "a block with no classModes has no override");
});

test("the shipped worker budget waits through pressure and admits after headroom recovers without changing thresholds", async () => {
  const block = (parseYaml(readFileSync(join(REPO_ROOT, "plan", "policy.yaml"), "utf8")) as { sweep: { hostMemoryBudget: unknown } })
    .sweep.hostMemoryBudget;
  const shipped = parseHostMemoryBudgetPolicy(block);
  const { mode: _mode, classModes: _classModes, ...thresholds } = shipped;
  void _mode; void _classModes;
  const { mode: _fixtureMode, classModes: _fixtureClasses, ...expectedThresholds } = POLICY;
  void _fixtureMode; void _fixtureClasses;
  // Operator ruling 2026-10-19: the shipped swap-in bound is 8192 pages/s; the fixture keeps 256.
  assert.deepEqual(thresholds, { ...expectedThresholds, serveColdStartReserveMib: 6144, swapInPagesPerSecMax: 8192 });
  for (const workerClass of ["implement", "fix", "review", "advisory"] as const) {
    resetShadowMemoryStateForTests();
    resetMemoryAdmissionStateForTests();
    const w = world();
    w.state.availableMib = 2500;
    w.running.entries = [{ id: "already-running", workerClass: "implement" }];
    const outcome = await awaitMemoryAdmission({ workerClass, root: "/home/node/Remudero" }, ports(w, {
      policy: () => shipped,
      sleep: async (ms) => {
        w.sleeps.push(ms);
        w.now.ms += ms;
        w.state.availableMib = 9000;
      },
    }));
    assert.equal(outcome.kind, "admitted", `${workerClass} eventually resumes`);
    assert.equal(w.sleeps.length, 1, `${workerClass} waits, rather than starting under the measured shortfall`);
    assert.equal(w.rows[0]!.step, ENFORCE_WAIT_STEP);
    assert.equal(w.rows[0]!.worker_class, workerClass);
    assert.equal(w.running.entries[0]!.id, "already-running", "the existing worker is not removed");
    assert.equal(w.running.entries.length, 2, "only the recovered admission publishes a new reservation");
  }
});

test("under the per-class budget a build start stays in shadow while a short garden start is deferred, not waited for", async () => {
  resetShadowMemoryStateForTests();
  resetMemoryAdmissionStateForTests();
  const w = world();
  w.state.availableMib = 2500;
  w.running.entries = [{ id: "busy" }];
  const build = await awaitMemoryAdmission({ workerClass: "implement", root: "/home/node/Remudero", runId: "W1-T1-1", taskId: "W1-T1" }, ports(w));
  assert.deepEqual(build, { kind: "not-enforced", why: "mode shadow" }, "a build is never held by the garden ruling");
  const garden = await awaitMemoryAdmission({ workerClass: "garden", root: "/home/node/Remudero", runId: "garden-flow", taskId: "GARDEN",
    onShortfall: "defer" }, ports(w));
  assert.deepEqual(garden, { kind: "deferred", reasons: ["unrealized-reservations"] });
  assert.deepEqual(w.sleeps, [], "a deferral returns at once instead of backing off");
  assert.deepEqual(w.rows.map((row) => row.step), [ENFORCE_DEFER_STEP], "one row names the deferral");
  assert.equal(w.rows[0]!.worker_class, "garden");
  assert.equal(w.rows[0]!.run_id, "garden-flow");
  assert.equal(w.rows[0]!.tier, "shortfall");

  const waiter = world();
  waiter.state.availableMib = 2500;
  waiter.running.entries = [{ id: "busy" }];
  let reads = 0;
  const waited = await awaitMemoryAdmission({ workerClass: "garden", root: "/home/node/Remudero" }, ports(waiter, {
    sleep: async (ms) => {
      waiter.sleeps.push(ms);
      reads += 1;
      if (reads === 1) waiter.state.availableMib = 9000;
      await Promise.resolve();
    },
  }));
  assert.equal(waited.kind, "admitted", "a caller that did not ask to defer still waits, as before");
  assert.equal(waiter.rows[0]!.step, ENFORCE_WAIT_STEP);
});

test("a garden child that would not fit is deferred to its next pass with one ledger row, never started, and runs on the next pass", async () => {
  resetShadowMemoryStateForTests();
  resetMemoryAdmissionStateForTests();
  const root = scratchDir("garden-defer-");
  try {
    const w = world();
    w.state.availableMib = 2500;
    w.running.entries = [{ id: "busy", workerClass: "implement" }];
    const started = join(root, "started");
    const script = join(root, "garden-pass.cjs");
    writeFileSync(script, `require("node:fs").writeFileSync(${JSON.stringify(started)}, "1");\n`);
    let reserved = 0;
    const spawnGarden = childGardenPassSpawn({
      execPath: process.execPath, execArgv: [], entry: script, ionice: "/nonexistent-ionice", setPriority: () => undefined,
      log: () => undefined, root, admission: ports(w),
      reserve: () => {
        reserved += 1;
        w.running.entries.push({ id: `g${reserved}`, estimateMib: 900, workerClass: "garden" });
        return { id: `g${reserved}`, published: true, workerClass: "garden", estimateMib: 900,
          estimateSource: { kind: "measured", samples: 4 }, bindRoot: () => undefined, releaseOccupancy: () => undefined };
      },
    });

    const deferred = await spawnGarden("flow" as never, [], { stopped: false });
    assert.deepEqual(deferred, { kind: "deferred", reason: "memory-budget-shortfall" },
      "the deferred pass retains its admission disposition without a child");
    assert.equal(reserved, 0, "a deferred child holds no reservation");
    assert.throws(() => readFileSync(started), /ENOENT/, "no garden child started");
    const defers = w.rows.filter((row) => row.step === ENFORCE_DEFER_STEP);
    assert.equal(defers.length, 1, "exactly one deferral row");
    assert.equal(defers[0]!.run_id, "garden-flow");

    w.state.availableMib = 9000; // the busy build finished
    const next = await spawnGarden("flow" as never, [], { stopped: false });
    assert.equal(next, 0, "the next pass is admitted and its child runs");
    assert.equal(readFileSync(started, "utf8"), "1");
    assert.equal(reserved, 1);
    assert.equal(w.rows.filter((row) => row.step === ENFORCE_DEFER_STEP).length, 1, "the admitted pass writes no second deferral");
  } finally {
    resetShadowMemoryStateForTests();
    rmSync(root, { recursive: true, force: true });
  }
});
