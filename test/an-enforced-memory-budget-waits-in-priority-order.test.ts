/**
 * The host memory budget's ENFORCE mode: built so the operator can promote it, shipped OFF (mode "shadow").
 *
 * Under "shadow" a start never waits. Under "enforce" a start that would not fit waits, TIERED rather than refused:
 * an uncertainty-only verdict gets one re-read and is then admitted; a measured shortfall waits with back-off while
 * reserved work that can free memory still runs, and is admitted once nothing is left to wait for; waiting starts are
 * evaluated in priority order; an error admits. Every case asserts a state only the admission produces: its outcome,
 * the waits it slept, the rows it wrote, or the order starts were let through.
 */
import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import {
  ADMISSION_BACKOFF,
  ENFORCE_ADMIT_STEP,
  ENFORCE_ERROR_STEP,
  ENFORCE_WAIT_STEP,
  admissionTier,
  awaitMemoryAdmission,
  backoffMs,
  reservedWorkRunning,
  resetMemoryAdmissionStateForTests,
  waitingStarts,
  type AdmissionPorts,
  type AdmissionRequest,
} from "../src/lib/host-memory-admission.js";
import type { HostMemoryReading, ReadingEntry } from "../src/lib/host-memory-ledger.js";
import * as memoryLedger from "../src/lib/host-memory-ledger.js";
import * as memoryAdmission from "../src/lib/host-memory-admission.js";
import * as memoryLearning from "../src/lib/host-memory-learning.js";
import * as memoryShadow from "../src/lib/host-memory-shadow.js";
import { childGardenPassSpawn } from "../src/lib/garden-registry.js";
import { defaultShadowMemoryPorts, gatherShadowInputs, installShadowMemorySink, markPsiStartAdmitted, resetShadowMemoryStateForTests,
  type HostMemoryBudgetPolicy, type StrictPsiTarget } from "../src/lib/host-memory-shadow.js";
import { appendLedger, type LedgerLine } from "../src/lib/ledger.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { createClaudeExecutableCache, spawnWorker, type SpawnWorkerArgs } from "../src/lib/worker.js";
import { gitWorkTreeAncestor } from "../src/lib/worker-home.js";
import { ghShim } from "./helpers/gh-shim.js";

const REPO_ROOT = join(import.meta.dirname, "..");
const NOW = Date.parse("2026-10-10T20:00:00.000Z");
const MIB = 1024 * 1024;

const POLICY: HostMemoryBudgetPolicy = {
  mode: "enforce",
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
  onSleep: (ms: number) => void;
}

function world(): World {
  return { rows: [], sleeps: [], now: { ms: NOW }, state: { availableMib: 9000 }, running: { entries: [] }, onSleep: () => undefined };
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
    withLock: action => action(),
    openReservation: input => {
      const id = `fixture-grant-${w.running.entries.length}`;
      w.running.entries.push({ id, workerClass: input.workerClass, estimateMib: 900 });
      return { id, published: true, workerClass: input.workerClass, estimateMib: 900,
        estimateSource: { kind: "measured", samples: 30 }, bindRoot: () => undefined,
        releaseOccupancy: () => { const entry = w.running.entries.find(e => e.id === id); if (entry) entry.occupancyReleased = true; } };
    },
    random: () => 0.5,
    sleep: async (ms) => {
      w.sleeps.push(ms);
      w.now.ms += ms;
      w.onSleep(ms);
      await Promise.resolve();
    },
    ...over,
  };
}

const request = { workerClass: "implement" as const, root: "/home/node/Remudero", runId: "W1-T1-1", taskId: "W1-T1" };

function decision(outcome: Awaited<ReturnType<typeof awaitMemoryAdmission>>) {
  if (!("reservation" in outcome)) return outcome;
  const { reservation, ...rest } = outcome;
  void reservation; // The original tier/timing controls stay exact; the new grant controls assert the handle separately.
  return rest;
}

test("the back-off doubles from 5 s to one re-read a minute, spread by jitter", () => {
  assert.equal(backoffMs(0, 0.5), 5_000);
  assert.equal(backoffMs(1, 0.5), 10_000);
  assert.equal(backoffMs(10, 0.5), ADMISSION_BACKOFF.maxMs);
  assert.equal(backoffMs(0, 0), 4_000);
  assert.equal(backoffMs(0, 1), 6_000);
  assert.equal(admissionTier({ wouldAdmit: true, reasons: [] }), "fits");
  assert.equal(admissionTier({ wouldAdmit: false, reasons: ["uncertainty"] }), "uncertain");
  assert.equal(admissionTier({ wouldAdmit: false, reasons: ["uncertainty", "psi"] }), "shortfall");
  assert.equal(reservedWorkRunning({ entries: [] }), false);
  assert.equal(reservedWorkRunning({ entries: [{ occupancyReleased: true, status: "owned" } as never] }), false);
  assert.equal(reservedWorkRunning({ entries: [{ status: "uncertain" } as never] }), false, "an unverifiable entry is nothing to wait for");
  assert.equal(reservedWorkRunning({ entries: [{ status: "owner-verified" } as never] }), true, "another container's live work is");
});

test("the shipped shadow mode never waits, reads nothing and writes nothing", async () => {
  const w = world();
  let read = 0;
  const outcome = await awaitMemoryAdmission({ ...request, root: () => { read += 1; return "/x"; } },
    ports(w, { policy: () => ({ ...POLICY, mode: "shadow" }) }));
  assert.deepEqual(outcome, { kind: "not-enforced", why: "mode shadow" });
  assert.deepEqual(w.sleeps, []);
  assert.deepEqual(w.rows, []);
  assert.equal(read, 0, "the state root is not even resolved");
  const elsewhere = await awaitMemoryAdmission(request, ports(w, { enforceHere: () => false }));
  assert.deepEqual(elsewhere, { kind: "not-enforced", why: "not a daemon-owned process" });
  const { enforceHere: _ignored, ...withoutEnforceHere } = ports(w);
  void _ignored;
  assert.deepEqual(await awaitMemoryAdmission(request, withoutEnforceHere), { kind: "not-enforced", why: "not a daemon-owned process" },
    "by default a test (or an operator's shell) is never held: only daemon-owned processes are");
});

test("under enforce a start that fits is admitted at once and silently", async () => {
  resetShadowMemoryStateForTests();
  const w = world();
  const outcome = await awaitMemoryAdmission(request, ports(w));
  assert.deepEqual(decision(outcome), { kind: "admitted", tier: "fits", waitedMs: 0, attempts: 0 });
  assert.deepEqual(w.sleeps, []);
  assert.deepEqual(w.rows, [], "a start that never waited writes no admission row");
});

test("a measured shortfall waits with back-off while reserved work runs, and is admitted once memory frees", async () => {
  resetShadowMemoryStateForTests();
  resetMemoryAdmissionStateForTests();
  const w = world();
  w.state.availableMib = 2500;
  w.running.entries = [{ id: "busy" }];
  w.onSleep = () => {
    if (w.sleeps.length === 3) w.state.availableMib = 9000; // the busy tree finished its tsc
  };
  const outcome = await awaitMemoryAdmission(request, ports(w));
  assert.deepEqual(w.sleeps, [5_000, 10_000, 20_000]);
  assert.deepEqual(decision(outcome), { kind: "admitted", tier: "fits", waitedMs: 35_000, attempts: 3 });
  const steps = w.rows.map((row) => row.step);
  assert.deepEqual(steps, [ENFORCE_WAIT_STEP, ENFORCE_ADMIT_STEP], "one row when it began waiting, one when it was let through");
  assert.equal(w.rows[0]!.tier, "shortfall");
  assert.deepEqual(w.rows[0]!.reasons, ["unrealized-reservations"], "2.5 GiB available, less the busy tree's and this start's claims");
  assert.equal(w.rows[0]!.task_id, "W1-T1");
  assert.equal(w.rows[1]!.waited_ms, 35_000);
  assert.deepEqual(waitingStarts(), [], "the start leaves the queue once admitted");
});

test("a shortfall with no reserved work left to wait for is admitted at once and named", async () => {
  resetShadowMemoryStateForTests();
  const w = world();
  w.state.availableMib = 2500;
  w.running.entries = [{ id: "finished", occupancyReleased: true }];
  const outcome = await awaitMemoryAdmission(request, ports(w));
  assert.deepEqual(decision(outcome), { kind: "admitted", tier: "nothing-to-wait-for", waitedMs: 0, attempts: 0 });
  assert.deepEqual(w.rows.map((row) => row.step), [ENFORCE_ADMIT_STEP], "the admission past a shortfall is on the record");
  assert.equal(w.rows[0]!.tier, "nothing-to-wait-for");
});

test("an uncertainty-only verdict gets one fresher reading and is then admitted", async () => {
  resetShadowMemoryStateForTests();
  const w = world();
  // 4.3 GiB available: 900 MiB fits the 2 GiB reserve on measurements, but the unmeasured-growth margin tips it.
  w.state.availableMib = 4300;
  w.running.entries = [{ id: "busy" }];
  const outcome = await awaitMemoryAdmission(request, ports(w, { daemonPid: () => undefined }));
  assert.deepEqual(decision(outcome), { kind: "admitted", tier: "uncertain", waitedMs: 5_000, attempts: 1 });
  assert.equal(w.rows[0]!.tier, "uncertain");
  assert.deepEqual(w.rows.map((row) => row.step), [ENFORCE_WAIT_STEP, ENFORCE_ADMIT_STEP]);
});

test("waiting starts are let through in priority order: a review before an older build, an old build before a new review", async () => {
  resetShadowMemoryStateForTests();
  resetMemoryAdmissionStateForTests();
  const w = world();
  w.state.availableMib = 2500;
  w.running.entries = [{ id: "busy" }];
  const order: string[] = [];
  let freeAfter = 2;
  w.onSleep = () => {
    if (w.sleeps.length >= freeAfter) w.state.availableMib = 9000;
  };
  // One fit at a time: each admission is followed by the snapshot filling up again until the next release.
  const admitOne = (label: string, cls: "implement" | "review") =>
    awaitMemoryAdmission({ ...request, workerClass: cls }, ports(w)).then((outcome) => {
      order.push(label);
      w.state.availableMib = 2500;
      freeAfter = w.sleeps.length + 2;
      return outcome;
    });
  const build = admitOne("build", "implement");
  w.now.ms += 1_000;
  const review = admitOne("review", "review");
  await Promise.all([build, review]);
  assert.deepEqual(order, ["review", "build"], "class weight 3 beats weight 1 at a near-equal wait");

  // Aging: a build waiting 60 minutes (score 1 x 4) outranks a review that just arrived (score 3 x 1).
  resetMemoryAdmissionStateForTests();
  const aged = world();
  aged.state.availableMib = 2500;
  aged.running.entries = [{ id: "busy" }];
  const agedOrder: string[] = [];
  const agedBuild = awaitMemoryAdmission(request, ports(aged)).then(() => {
    agedOrder.push("build");
    aged.state.availableMib = 2500;
  });
  await Promise.resolve();
  aged.now.ms += 60 * 60_000;
  aged.onSleep = () => {
    if (aged.sleeps.length >= 3) aged.state.availableMib = 9000;
  };
  const freshReview = awaitMemoryAdmission({ ...request, workerClass: "review" }, ports(aged)).then(() => {
    agedOrder.push("review");
    aged.state.availableMib = 2500;
    aged.onSleep = () => {
      aged.state.availableMib = 9000;
    };
  });
  await Promise.all([agedBuild, freshReview]);
  assert.equal(agedOrder[0], "build", "aging lets an old build outrank a new review: nothing starves");
});

test("an error admits the start and is named", async () => {
  const w = world();
  const outcome = await awaitMemoryAdmission(request, ports(w, { readLedger: () => { throw new Error("boom"); }, readFile: () => { throw new Error("no proc"); },
    clock: { now: () => { throw new Error("clock gone"); }, date: () => new Date(), iso: () => "" } }));
  assert.deepEqual(outcome, { kind: "error", reason: "clock gone" });
  assert.deepEqual(w.rows.map((row) => row.step), [ENFORCE_ERROR_STEP]);
  assert.equal(w.rows[0]!.admitted, true);
  const quiet = world();
  const lines: string[] = [];
  const policyGone = await awaitMemoryAdmission(request, ports(quiet, { policy: () => { throw new Error("policy unreadable"); }, stderr: (line) => void lines.push(line) }));
  assert.deepEqual(policyGone, { kind: "error", reason: "policy unreadable" });
  assert.match(lines[0] ?? "", /memory_budget\.enforce_error/, "before a root is known the error goes to stderr");
  const sinkGone = world();
  const failingSink = await awaitMemoryAdmission(request, ports(sinkGone, {
    clock: { now: () => { throw new Error("clock gone"); }, date: () => new Date(), iso: () => "" },
    write: () => { throw new Error("EROFS"); }, stderr: (line) => void lines.push(line) }));
  assert.equal(failingSink.kind, "error");
  assert.match(lines.at(-1) ?? "", /EROFS/, "a failing sink is reported on stderr, never thrown");
});

function fixtureRoot(prefix: string): string {
  const parent = [tmpdir(), dirname(REPO_ROOT)].find((candidate) => gitWorkTreeAncestor(candidate) === undefined);
  assert.ok(parent, "the test host must provide a scratch parent outside every Git work tree");
  return mkdtempSync(join(parent, `${RMD_TMP_PREFIX}${prefix}`));
}

test("an enforced worker start waits for memory BEFORE its worker is queried", async () => {
  resetShadowMemoryStateForTests();
  resetMemoryAdmissionStateForTests();
  const root = fixtureRoot("enforced-start-");
  try {
    const w = world();
    w.state.availableMib = 2500;
    w.running.entries = [{ id: "busy" }];
    let queried = 0;
    const queriedAtSleep: number[] = [];
    w.onSleep = () => {
      queriedAtSleep.push(queried);
      if (w.sleeps.length === 2) w.state.availableMib = 9000;
    };
    const result = await spawnWorker({
      cwd: root,
      permissionMode: "bypassPermissions" as const,
      settingsFile: join(REPO_ROOT, "settings", "worker.json"),
      prompt: "work",
      model: "claude-sonnet-4-6",
      effort: "high",
      runId: "run-enforced",
      taskId: "W1-T7094",
      config: { claudeBin: "/unused", root, dailyCapUsd: 20 } as never,
      providerRouting: {
        readClaudeHealth: async () => ({ degradedModels: [], source: "unknown", detail: "unread" }),
        readClaude: async () => ({ provider: "claude", readable: true, windows: [{ name: "claude weekly", usedPercent: 10, resetsAt: NOW / 1000 + 3600 }] }),
        writeStatus: () => {},
        now: () => NOW,
      },
      claudeExecutable: {
        cache: createClaudeExecutableCache(),
        deps: { env: { RMD_CLAUDE_BIN: "/fake/claude" }, home: root, exists: () => true, which: () => "/fake/claude", canExecute: () => true, locations: [] },
      },
      keychain: {
        platform: "linux" as const,
        readCredentialFile: () => JSON.stringify({ claudeAiOauth: { accessToken: "stub", expiresAt: 4_102_444_800_000 } }),
      },
      memoryShadow: ports(w),
      queryFn: (() => {
        queried += 1;
        return (async function* () {
          yield { type: "result", subtype: "success", is_error: false, result: "done", session_id: "s", total_cost_usd: 0.25, num_turns: 3 };
        })();
      }) as never,
    } as SpawnWorkerArgs);
    assert.deepEqual(queriedAtSleep, [0, 0], "no worker was queried while the start waited");
    assert.equal(queried, 1, "then it started exactly once");
    assert.equal(result.text, "done");
    const steps = w.rows.map((row) => row.step);
    assert.deepEqual(steps.slice(0, 2), [ENFORCE_WAIT_STEP, ENFORCE_ADMIT_STEP]);
    const shadow = w.rows.find((row) => row.step === "memory_budget.shadow");
    assert.equal(shadow?.mode, "enforce", "the start's own verdict row still follows, naming the mode");
  } finally {
    resetShadowMemoryStateForTests();
    rmSync(root, { recursive: true, force: true });
  }
});

test("an enforced garden deferral retains its admission disposition without starting a child", async () => {
  resetShadowMemoryStateForTests();
  const root = fixtureRoot("garden-deferred-disposition-");
  try {
    const w = world();
    w.state.availableMib = 2500;
    w.running.entries = [{ id: "existing-live-work" }];
    let reservations = 0;
    const garden = childGardenPassSpawn({ root, execPath: "/must-not-spawn", execArgv: [], entry: "/must-not-run",
      admission: ports(w), reserve: () => { reservations++; throw new Error("must not reserve a deferred child"); } });
    assert.deepEqual(await garden("plan", [], { stopped: false }), { kind: "deferred", reason: "memory-budget-shortfall" });
    assert.equal(reservations, 0);
    assert.deepEqual(w.sleeps, []);
    assert.ok(w.rows.some(row => row.step === "memory_budget.enforce_defer" && row.worker_class === "garden"));
  } finally {
    resetShadowMemoryStateForTests();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a garden child waits its turn under enforce, holds a garden reservation for its life, and releases it at exit", async () => {
  resetShadowMemoryStateForTests();
  const root = fixtureRoot("garden-reserve-");
  try {
    const w = world();
    const events: string[] = [];
    const script = join(root, "garden-pass.cjs");
    writeFileSync(script, "process.exit(0);\n");
    const spawnGarden = childGardenPassSpawn({
      execPath: process.execPath,
      execArgv: [],
      entry: script,
      ionice: "/nonexistent-ionice",
      setPriority: () => undefined,
      log: () => undefined,
      root,
      admission: ports(w, { policy: () => { events.push("admission"); return POLICY; } }),
      reserve: () => {
        events.push("reserve");
        w.running.entries.push({ id: "g1", estimateMib: 900, workerClass: "garden" });
        return {
          id: "g1", published: true, workerClass: "garden", estimateMib: 900, estimateSource: { kind: "measured", samples: 4 },
          bindRoot: (pid: number) => void events.push(`bind:${typeof pid}`),
          releaseOccupancy: () => void events.push("release"),
        };
      },
    });
    const code = await spawnGarden("flow" as never, [], { stopped: false });
    assert.equal(code, 0);
    assert.deepEqual(events.slice(0, 4), ["admission", "reserve", "admission", "bind:number"],
      "admitted before the child exists, reserved, its verdict recorded, then bound to the child's pid");
    assert.equal(events.at(-1), "release");
    assert.equal(events.filter((e) => e === "release").length, 1);
    const shadow = w.rows.find((row) => row.step === "memory_budget.shadow");
    assert.equal(shadow?.worker_class, "garden", "a garden start writes the same counterfactual row a worker start does");

    const failed = childGardenPassSpawn({ execPath: "/nonexistent-node", execArgv: [], entry: "x", setPriority: () => undefined,
      ionice: "/nonexistent-ionice", log: () => undefined, root, admission: ports(world(), { policy: () => ({ ...POLICY, mode: "shadow" }) }),
      reserve: () => ({ id: undefined, workerClass: "garden", estimateMib: 1, estimateSource: { kind: "default-unmeasured" },
        bindRoot: () => undefined, releaseOccupancy: () => void events.push("release-on-error") }) });
    await assert.rejects(failed("flow" as never, [], { stopped: false }));
    assert.ok(events.includes("release-on-error"), "a child that never started releases its reservation");
  } finally {
    resetShadowMemoryStateForTests();
    rmSync(root, { recursive: true, force: true });
  }
});

test("the real back-off sleeps between re-reads", async () => {
  resetShadowMemoryStateForTests();
  const w = world();
  w.state.availableMib = 4300;
  w.running.entries = [{ id: "busy" }];
  const { sleep: _sleep, random: _random, ...real } = ports(w, { daemonPid: () => undefined });
  void _sleep;
  void _random;
  const started = Date.now();
  const outcome = await awaitMemoryAdmission(request, real);
  assert.equal(outcome.kind, "admitted");
  assert.ok(Date.now() - started >= ADMISSION_BACKOFF.baseMs * (1 - ADMISSION_BACKOFF.jitter) - 50, "one real back-off step elapsed");
});

test("memory admission publishes one reservation before a concurrent start can report fits", async () => {
  resetShadowMemoryStateForTests();
  resetMemoryAdmissionStateForTests();
  const w = world();
  w.state.availableMib = 3748;
  const handles: string[] = [];
  const snapshots: number[] = [];
  const open = () => {
    const id = `grant-${handles.length}`;
    handles.push(id);
    w.running.entries.push({ id, estimateMib: 900 });
    return { id, published: true, workerClass: "implement" as const, estimateMib: 900,
      estimateSource: { kind: "measured" as const, samples: 30 }, bindRoot: () => undefined,
      releaseOccupancy: () => { const entry = w.running.entries.find(e => e.id === id); if (entry) entry.occupancyReleased = true; } };
  };
  w.onSleep = () => { w.running.entries[0]!.occupancyReleased = true; };
  const shared = ports(w, {
    policy: () => ({ ...POLICY, uncertaintyMarginMib: 0 }),
    readLedger: () => { snapshots.push(w.running.entries.filter(e => !e.occupancyReleased).length); return reading(w.running.entries); },
    withLock: action => action(),
  });
  const first = awaitMemoryAdmission({ ...request, reserve: open }, shared);
  assert.equal(handles.length, 1, "first admission returned without publishing its reservation");
  const second = awaitMemoryAdmission({ ...request, reserve: open }, shared);
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.kind, "admitted"); assert.equal(b.kind, "admitted");
  if (a.kind !== "admitted" || b.kind !== "admitted") return;
  assert.equal(a.reservation?.id, handles[0]); assert.equal(b.reservation?.id, handles[1]);
  assert.deepEqual(w.sleeps, [5000], "the second start re-evaluates only after the first claim settles");
  assert.deepEqual(snapshots, [0, 1, 1, 0, 1], "both fitting outcomes verify that their committed claim is visible");
  assert.equal(handles.length, 2);
  assert.deepEqual(waitingStarts(), []);
  b.reservation?.releaseOccupancy();
  await nativeAdmissionBoundary();
});

async function nativeAdmissionBoundary() {
  const root = fixtureRoot("admission-processes-");
  const blockedGitHub = ghShim([{ when: "", exit: 77, stderr: "disposable admission control refuses live GitHub" }]);
  const dir = join(root, "host-memory");
  mkdirSync(dir);
  const fixtureLedger = {
    location: () => ({ dir, scope: "host" as const }),
    instance: () => ({ name: "fixture", hostUnique: true }),
    generation: () => ({ containerId: "boundary", initStart: "known" }),
    probe: (pid: number) => ({ state: "alive" as const, start: String(pid) }),
    listProcesses: () => ({ rows: [], complete: true }),
    log: () => undefined,
  };
  const bootstrap = memoryLedger.openMemoryReservation({ workerClass: "implement", measured: { estimateMib: 900, samples: 30 } }, fixtureLedger);
  bootstrap.releaseOccupancy(); memoryLedger.sweepMemoryReservations(fixtureLedger);
  assert.equal(memoryLedger.readMemoryLedger(fixtureLedger)?.state, "present");
  assert.equal(memoryLedger.readMemoryLedger(fixtureLedger)?.entries.length, 0, "positive sentinel plus a completed bootstrap, not missing storage");
  const entry = join(root, "admission-child.mjs");
  const admissionUrl = new URL("../src/lib/host-memory-admission.ts", import.meta.url).href;
  const ledgerUrl = new URL("../src/lib/host-memory-ledger.ts", import.meta.url).href;
  writeFileSync(entry, `
    import {awaitMemoryAdmission} from ${JSON.stringify(admissionUrl)};
    import * as ledger from ${JSON.stringify(ledgerUrl)};
    const MIB=1024*1024, NOW=${NOW}, role=process.argv[2], dir=${JSON.stringify(dir)};
    const policy=${JSON.stringify({ ...POLICY, uncertaintyMarginMib: 0 })};
    const readFile=(${host.toString()})({availableMib:3748});
    const deps={location:()=>({dir,scope:'host'}),instance:()=>({name:'fixture',hostUnique:true}),
      generation:()=>({containerId:'boundary',initStart:'known'}),probe:pid=>({state:'alive',start:String(pid)}),
      listProcesses:()=>({rows:[],complete:true}),log:()=>{}};
    let firstRead=true, now=NOW, handle;
    const waitFor=kind=>new Promise(resolve=>{const receive=m=>{if(m.kind===kind){process.off('message',receive);resolve();}};process.on('message',receive);});
    process.send({kind:'ready',role});
    await waitFor('go');
    if(role==='holder') {
      ledger.withMemoryAdmissionLock(()=>{process.send({kind:'held',role});Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);},{dir,scope:'host'});
      process.exit(0);
    }
    const result=await awaitMemoryAdmission({workerClass:'implement',root:${JSON.stringify(root)}}, {
      policy:()=>policy,enforceHere:()=>true,readFile,readTail:()=>JSON.stringify({ts:new Date(NOW-3600000).toISOString(),step:'x'})+'\\n',
      clock:{now:()=>now,date:()=>new Date(now),iso:()=>new Date(now).toISOString()},
      readLedger:()=>{const r=ledger.readMemoryLedger(deps);if(firstRead){firstRead=false;Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,75);}return r;},
      withLock:action=>ledger.withMemoryAdmissionLock(action,{dir,scope:'host'}),
      openReservation:input=>{const raw=ledger.openMemoryReservation({...input,measured:{estimateMib:900,samples:30}},deps);
        return {get id(){return raw.id},get published(){return raw.published},workerClass:'implement',estimateMib:900,
          estimateSource:{kind:'measured',samples:30},bindRoot:pid=>raw.bindRoot(pid),releaseOccupancy:()=>raw.releaseOccupancy()};},
      write:()=>{},stderr:()=>{},instance:()=> 'fixture',daemonPid:()=>777,listStateDir:()=>[],estimate:()=>900,
      readReviewDemand:()=>({state:'present',rows:[],unreadableRows:0}),random:()=>0.5,
      sleep:async ms=>{now+=ms;process.send({kind:'waiting',role});await waitFor('continue');}
    });
    handle=result.reservation;
    process.send({kind:'result',role,tier:result.tier??result.reason,id:handle?.id});
    await waitFor('release');handle?.releaseOccupancy();process.send({kind:'released',role});process.disconnect();
  `);
  const children: ChildProcess[] = [];
  const events: Array<{ kind: string; role: string; tier?: string; id?: string }> = [];
  const changed: Array<() => void> = [];
  const awaitEvent = (predicate: () => boolean) => new Promise<void>((resolve, reject) => {
    // BACKSTOP for a disposable child that never answers; no production process is involved.
    const timer = setTimeout(() => reject(new Error(`native admission boundary stalled: ${JSON.stringify(events)}`)), 10_000);
    const check = () => { if (predicate()) { clearTimeout(timer); resolve(); } };
    changed.push(check); check();
  });
  try {
    for (const role of ["a", "b"]) {
      const child = fork(entry, [role], {
        execPath: process.execPath,
        execArgv: ["--import", join(REPO_ROOT, "node_modules", "tsx", "dist", "loader.mjs")],
        env: { PATH: `${blockedGitHub.dir}:${process.env.PATH}`, HOME: root, TMPDIR: root, GH_CONFIG_DIR: root, GIT_TERMINAL_PROMPT: "0" },
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      });
      children.push(child); child.stderr?.resume();
      child.on("message", m => { events.push(m as typeof events[number]); changed.forEach(fn => fn()); });
      child.on("error", e => { events.push({ kind: "error", role, tier: e.message }); changed.forEach(fn => fn()); });
    }
    await awaitEvent(() => events.filter(e => e.kind === "ready").length === 2);
    children.forEach(c => c.send({ kind: "go" }));
    await awaitEvent(() => events.some(e => e.kind === "result"));
    const first = events.find(e => e.kind === "result")!;
    assert.equal(first.tier, "fits"); assert.ok(first.id);
    await awaitEvent(() => events.some(e => e.kind === "waiting" && e.role !== first.role) || events.filter(e => e.kind === "result").length === 2);
    assert.equal(events.filter(e => e.kind === "result").length, 1, "two independent starts reported fits before either claim settled");
    assert.equal(memoryLedger.readMemoryLedger(fixtureLedger)?.entries.length, 1, "the first fitting claim is actually published");
    assert.equal(memoryLedger.withMemoryAdmissionLock(() => "free", { dir, scope: "host" }), "free", "no admission critical section survives the waiting child");
    children[first.role === "a" ? 0 : 1].send({ kind: "release" });
    await awaitEvent(() => events.some(e => e.kind === "released" && e.role === first.role));
    children[first.role === "a" ? 1 : 0].send({ kind: "continue" });
    await awaitEvent(() => events.filter(e => e.kind === "result").length === 2);
    const second = events.filter(e => e.kind === "result")[1]; assert.equal(second.tier, "fits"); assert.ok(second.id);
    assert.notEqual(second.id, first.id);
    children[first.role === "a" ? 1 : 0].send({ kind: "release" });
    await awaitEvent(() => events.filter(e => e.kind === "released").length === 2);
    const holder = fork(entry, ["holder"], {
      execPath: process.execPath, execArgv: ["--import", join(REPO_ROOT, "node_modules", "tsx", "dist", "loader.mjs")],
      env: { PATH: `${blockedGitHub.dir}:${process.env.PATH}`, HOME: root, TMPDIR: root, GH_CONFIG_DIR: root, GIT_TERMINAL_PROMPT: "0" },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    children.push(holder); holder.stderr?.resume();
    holder.on("message", m => { events.push(m as typeof events[number]); changed.forEach(fn => fn()); });
    await awaitEvent(() => events.some(e => e.kind === "ready" && e.role === "holder"));
    holder.send({ kind: "go" });
    await awaitEvent(() => events.some(e => e.kind === "held" && e.role === "holder"));
    assert.throws(() => memoryLedger.withMemoryAdmissionLock(() => "wrong", { dir, scope: "host" }), { code: memoryLedger.MEMORY_ADMISSION_LOCK_BUSY },
      "a live holder is not reclaimed and the reader never waits synchronously");
    const closed = new Promise<void>(resolve => holder.once("close", () => resolve()));
    holder.kill("SIGKILL"); await closed; // Only this disposable fault-control child; no production process or foreign job.
    assert.equal(memoryLedger.withMemoryAdmissionLock(() => "recovered", { dir, scope: "host" }), "recovered", "verified process death releases the OS lock without deleting a lease");
    assert.throws(() => memoryLedger.withMemoryAdmissionLock(() => "wrong", { dir: join(root, "absent"), scope: "host" }), /admission-lock-unavailable/);
    assert.deepEqual(blockedGitHub.calls(), [], "no child attempted live GitHub");
  } finally {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
        child.kill("SIGTERM"); await closed;
      }
    }
    rmSync(root, { recursive: true, force: true });
    rmSync(blockedGitHub.dir, { recursive: true, force: true });
  }
}

test("admission serialization preserves named uncertainty and unchanged shadow starts", async () => {
  const w = world();
  const refused = await awaitMemoryAdmission(request, ports(w, { withLock: () => { throw new Error("admission-lock-unavailable"); } }));
  assert.deepEqual(refused, { kind: "error", reason: "admission-lock-unavailable" });
  assert.equal(w.rows.at(-1)?.step, ENFORCE_ERROR_STEP);
  assert.equal(w.rows.at(-1)?.admitted, true, "a lock refusal keeps the existing named fail-open behavior");
  let acquired = 0;
  for (const mode of ["shadow", "off"] as const) {
    const quiet = world();
    const result = await awaitMemoryAdmission(request, ports(quiet, {
      policy: () => ({ ...POLICY, mode }),
      withLock: () => { acquired += 1; throw new Error("must not acquire"); },
    }));
    assert.deepEqual(result, { kind: "not-enforced", why: `mode ${mode}` });
    assert.deepEqual(quiet.sleeps, []); assert.deepEqual(quiet.rows, []);
  }
  assert.equal(acquired, 0);
  for (const state of ["missing", "unreadable", "reset"] as const) {
    const unknown = world();
    const result = await awaitMemoryAdmission(request, ports(unknown, {
      policy: () => ({ ...POLICY, uncertaintyMarginMib: 0 }),
      readLedger: () => ({ ...reading([]), state }),
    }));
    assert.equal(result.kind, "error");
    if (result.kind === "error") assert.equal(result.reason, `admission-ledger-${state}`);
    assert.equal(unknown.rows.at(-1)?.step, ENFORCE_ERROR_STEP);
  }
  const unpublished = world();
  unpublished.running.entries = [{ id: "not-on-disk", estimateMib: 900, occupancyReleased: true }];
  const refusedWrite = await awaitMemoryAdmission(request, ports(unpublished, {
    openReservation: input => ({ id: "not-on-disk", published: false, workerClass: input.workerClass, estimateMib: 900,
      estimateSource: { kind: "measured", samples: 30 }, bindRoot: () => undefined, releaseOccupancy: () => undefined }),
  }));
  assert.equal(refusedWrite.kind, "error");
  if (refusedWrite.kind === "error") {
    assert.equal(refusedWrite.reason, "admission-reservation-unpublished");
    assert.equal(refusedWrite.reservation?.id, "not-on-disk", "the caller still settles the same best-effort handle once");
  }
});

test("worker and garden starts consume their admitted memory reservation exactly once", async () => {
  const root = fixtureRoot("admitted-spawn-");
  try {
    for (const kind of ["worker", "garden"] as const) {
      resetShadowMemoryStateForTests(); resetMemoryAdmissionStateForTests();
      const w = world();
      let inside = false, opens = 0, binds = 0, releases = 0;
      const reserve = () => {
        assert.equal(inside, true, "the actual caller opened its claim after admission returned");
        opens += 1;
        const id = `${kind}-grant`;
        w.running.entries.push({ id, estimateMib: 900, workerClass: kind === "garden" ? "garden" : "unclassified" });
        return { id, published: true, workerClass: kind === "garden" ? "garden" as const : "unclassified" as const,
          estimateMib: 900, estimateSource: { kind: "measured" as const, samples: 30 },
          bindRoot: (pid: number) => { assert.ok(pid > 0); binds += 1; },
          releaseOccupancy: () => { releases += 1; } };
      };
      const admission = ports(w, { withLock: action => { inside = true; try { return action(); } finally { inside = false; } }, openReservation: reserve });
      if (kind === "worker") {
        await assert.rejects(spawnWorker({ cwd: root, permissionMode: "bypassPermissions", prompt: "never queried",
          settingsFile: join(root, "absent-settings.json"), config: { root } as never, memoryShadow: admission } as SpawnWorkerArgs));
        assert.equal(binds, 0, "settings validation failed before any provider or child spawn");
      } else {
        const entry = join(root, "harmless-garden.cjs"); writeFileSync(entry, "process.exit(0);\n");
        const garden = childGardenPassSpawn({ execPath: process.execPath, execArgv: [], entry, root,
          reserve, admission, setPriority: () => undefined, ionice: "/nonexistent-ionice", log: () => undefined });
        assert.equal(await garden("flow" as never, [], { stopped: false }), 0);
        assert.equal(binds, 1, "the real harmless child was bound to the admitted handle");
      }
      assert.equal(opens, 1, `${kind} opened a duplicate claim`);
      assert.equal(releases, 1, `${kind} failed to settle its admitted handle exactly once`);
    }
    const noGrant = world(); let attempts = 0;
    const entry = join(root, "harmless-no-grant.cjs"); writeFileSync(entry, "process.exit(0);\n");
    const garden = childGardenPassSpawn({ execPath: process.execPath, execArgv: [], entry, root,
      reserve: () => { attempts += 1; return undefined; }, admission: ports(noGrant), setPriority: () => undefined,
      ionice: "/nonexistent-ionice", log: () => undefined });
    assert.equal(await garden("flow" as never, [], { stopped: false }), 0, "the named untracked start keeps its fail-open behavior");
    assert.equal(attempts, 1, "an unsuccessful reserve callback is not invoked twice");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Private evidence fixtures, not live calibration or launcher wiring. A missing new API is an assertion, not a loader failure.
const markStrictPsiStartAdmitted = (...args: Parameters<typeof memoryShadow.markStrictPsiStartAdmitted>) => {
  assert.equal(typeof memoryShadow.markStrictPsiStartAdmitted, "function", "the strict marker entry is missing");
  return memoryShadow.markStrictPsiStartAdmitted(...args);
};
const validationRequest = { ...request, workerClass: "test" as const };
function validationRefused(result: memoryAdmission.ValidationAdmissionOutcome,
  reason: "budget-unavailable" | "unsafe-without-live-work" | "admission-error" | "abandoned", detail?: string) {
  assert.equal(result.kind, "not-started", JSON.stringify(result));
  if (result.kind !== "not-started") assert.fail("expected a typed validation refusal");
  assert.equal(result.reason, reason, JSON.stringify(result));
  if (detail !== undefined) assert.ok(result.details.includes(detail), JSON.stringify(result));
  return result;
}
function validationFixture(root: string = request.root) {
  resetMemoryAdmissionStateForTests(); resetShadowMemoryStateForTests();
  const w = world();
  const files = new Map<string, string>();
  let opens = 0, releases = 0;
  const raw = host(w.state);
  const original = ports(w);
  const options: Partial<memoryAdmission.ValidationAdmissionPorts> = {
    ...original,
    readFile: path => {
      if (files.has(path)) return files.get(path)!;
      if (path === "/proc/sys/kernel/random/boot_id") return "11111111-1111-4111-8111-111111111111\n";
      if (path === "/proc/self/cgroup") return "0::/fixture\n";
      if (path === "/proc/1/stat") return `1 (init) S 0 ${"0 ".repeat(17)}100 0 0`;
      if (path === "/sys/fs/cgroup/memory.high") return "max\n";
      if (path === "/sys/fs/cgroup/memory.stat") return "anon 1\nfile 1\ninactive_file 0\npswpin 100\n";
      if (path === "/sys/fs/cgroup/memory.pressure") return raw("/proc/pressure/memory");
      if (path.startsWith("/ledger/")) return '{"roots":[],"tree":[]}';
      return raw(path);
    },
    readTail: () => Array.from({ length: POLICY.daemonGrowthMinSamples }, (_, i) => JSON.stringify({
      ts: new Date(w.now.ms - (POLICY.daemonGrowthMinSamples - i) * 1000).toISOString(),
      step: "daemon.alive", actor_pid: 777, rss_bytes: 1024 * MIB, vm_swap_bytes: 0,
    })).join("\n") + "\n",
    readHostServe: () => ({ state: "present", scenario: "serve-steady", basis: "private fixture",
      observedAt: new Date(w.now.ms).toISOString(), ageMs: 0, producer: "fixture", superseded: 0 }),
    typical: () => 900,
    survival: () => ({ factor: 1, samples: 30 }),
    writeFile: (path, content) => { files.set(path, content); },
    validationEstimate: () => ({ kind: "measured", estimateMib: 900, typicalMib: 900, samples: 30,
      basis: "legacy-compatible-tree-peaks" }),
    ownedBinding: () => ({ state: "fresh" }),
    openReservation: input => {
      opens += 1;
      const handle = original.openReservation!(input)!;
      return { ...handle, releaseOccupancy: () => { releases += 1; handle.releaseOccupancy(); } };
    },
  };
  const run = (over: Partial<memoryAdmission.ValidationAdmissionPorts> = {}, signal?: AbortSignal) => {
    assert.equal(typeof memoryAdmission.awaitValidationMemoryAdmission, "function", "the validation entry is missing");
    return memoryAdmission.awaitValidationMemoryAdmission({ ...validationRequest, root, ...(signal ? { signal } : {}) }, { ...options, ...over });
  };
  const prime = async () => {
    const first = await run();
    validationRefused(first, "budget-unavailable", "strict-observation-untagged");
    if (first.kind === "not-started") assert.ok(first.details.includes("host-swap-unavailable"));
    const observed = JSON.parse(files.get(join(root, "state", "container-pressure.json"))!);
    assert.equal(observed.prior.at, w.now.ms, "the first observation was actually written");
    assert.equal(observed.validationObservation.sampleAt, w.now.ms);
    assert.equal(opens, 0);
    w.now.ms += 1000;
  };
  const marked = () => [...files].some(([path, text]) => {
    if (!path.endsWith("/container-pressure.json")) return false;
    const value = JSON.parse(text) as { psi?: Array<[number, number | null, number]> };
    return value.psi?.some(row => row[2] === 1) === true;
  });
  return { w, files, options, run, prime, marked, opens: () => opens, releases: () => releases };
}

test("W1-T10208: new validation never promotes a legacy memory escape to ready", async () => {
  for (const workerClass of ["test", "check-proof", "push-gate"] as const) {
    const f = validationFixture(); await f.prime();
    f.w.state.availableMib = 1000;
    const refused = await memoryAdmission.awaitValidationMemoryAdmission({ ...validationRequest, workerClass }, f.options);
    validationRefused(refused, "unsafe-without-live-work");
    assert.equal(f.opens(), 0); assert.equal(f.marked(), false);
    const legacy = await awaitMemoryAdmission({ ...request, workerClass }, f.options);
    assert.equal(legacy.kind, "admitted");
    if (legacy.kind === "admitted") {
      assert.equal(legacy.tier, "nothing-to-wait-for"); legacy.reservation?.releaseOccupancy();
    }
  }
  const f = validationFixture(); await f.prime();
  const unavailable = { withLock: () => { throw new Error("private-lock-unavailable"); } };
  validationRefused(await f.run(unavailable), "admission-error", "private-lock-unavailable");
  const legacy = await awaitMemoryAdmission(request, { ...f.options, ...unavailable });
  assert.equal(legacy.kind, "error");
  assert.equal(f.w.rows.at(-1)?.admitted, true, "legacy error policy is unchanged");
  assert.equal(f.opens(), 0);
  const uncertain = validationFixture(); await uncertain.prime();
  uncertain.w.state.availableMib = 4300; uncertain.w.running.entries = [{ id: "busy", workerClass: "test" }];
  validationRefused(await uncertain.run({ daemonPid: () => undefined }), "budget-unavailable", "daemon-allowance-incomplete");
  resetShadowMemoryStateForTests();
  const legacyWorld = world();
  legacyWorld.state.availableMib = 4300; legacyWorld.running.entries = [{ id: "busy" }];
  const legacyUncertain = await awaitMemoryAdmission(request, ports(legacyWorld, { daemonPid: () => undefined }));
  assert.equal(legacyUncertain.kind, "admitted");
  if (legacyUncertain.kind === "admitted") {
    assert.equal(legacyUncertain.tier, "uncertain"); legacyUncertain.reservation?.releaseOccupancy();
  }
  assert.equal(legacyWorld.rows[0]!.tier, "uncertain");
  assert.deepEqual(legacyWorld.sleeps, [5000]);
  const tail = validationFixture(); await tail.prime();
  tail.w.state.availableMib = 3500; tail.w.running.entries = [{ id: "decayed", workerClass: "test" }];
  const stop = new AbortController(); tail.w.onSleep = () => stop.abort();
  const tailPorts: Partial<memoryAdmission.ValidationAdmissionPorts> = {
    estimate: () => 1800, typical: () => 900, survival: () => ({ factor: 0, samples: 30 }),
    validationEstimate: () => ({ kind: "measured", estimateMib: 1800, typicalMib: 900, samples: 30, basis: "legacy-compatible-tree-peaks" }),
    openReservation: input => {
      tail.w.running.entries.push({ id: "tail-grant", workerClass: input.workerClass, estimateMib: 1800 });
      return { id: "tail-grant", published: true, workerClass: input.workerClass, estimateMib: 1800,
        estimateSource: { kind: "measured", samples: 30 }, bindRoot: () => undefined, releaseOccupancy: () => undefined };
    },
  };
  validationRefused(await tail.run(tailPorts, stop.signal), "abandoned", "admission-abandoned");
  assert.deepEqual(tail.w.sleeps, [5000], "validation waits rather than taking the own-tail escape");
  assert.ok(!tail.w.running.entries.some(entry => entry.id === "tail-grant"));
  const legacyTail = await awaitMemoryAdmission(request, { ...tail.options, ...tailPorts });
  assert.equal(legacyTail.kind, "admitted");
  if (legacyTail.kind === "admitted") { assert.equal(legacyTail.tier, "own-tail"); legacyTail.reservation?.releaseOccupancy(); }
});

test("W1-T10208: new validation refuses an unsupported worker class before any policy or reservation effect", async () => {
  const f = validationFixture();
  const stderr: string[] = [];
  const refused = await memoryAdmission.awaitValidationMemoryAdmission(
    { ...validationRequest, workerClass: "build" as unknown as typeof validationRequest.workerClass },
    { ...f.options, policy: () => { throw new Error("policy must not be read for an unsupported class"); },
      stderr: line => { stderr.push(line); } },
  );
  const result = validationRefused(refused, "budget-unavailable", "unsupported-validation-class");
  assert.equal(result.cleanup, "none");
  assert.equal(result.attempts, 0);
  assert.equal(result.waitedMs, 0);
  assert.equal(f.opens(), 0);
  assert.equal(f.marked(), false);
  assert.ok(stderr.some(line => line.includes("unsupported-validation-class")), stderr.join("\n"));
});

test("W1-T10208: an incomplete fit has no validation admission effects", async () => {
  const cases: Array<[Partial<memoryAdmission.ValidationAdmissionPorts>, string]> = [
    [{ validationEstimate: () => ({ kind: "unavailable", reason: "no-measured-samples" }) }, "no-measured-samples"],
    [{ validationEstimate: () => ({ kind: "measured", estimateMib: 900, typicalMib: 900, samples: 0, basis: "legacy-compatible-tree-peaks" }) }, "class-basis-incomplete"],
    [{ readLedger: () => ({ ...reading([]), scope: "local" }) }, "ledger-incomplete"],
    [{ readLedger: () => ({ ...reading([]), state: "reset" }) }, "ledger-incomplete"],
    [{ readLedger: () => ({ ...reading([]), counts: { live: 0, uncertain: 0, incompleteWalk: 0, localScope: 0, unreadable: 1 } }) }, "ledger-incomplete"],
    [{ daemonPid: () => undefined }, "daemon-allowance-incomplete"],
    [{ readHostServe: () => ({ state: "unknown", cause: "unreadable", basis: "fixture" }) }, "serve-scenario-unknown"],
  ];
  for (const [over, detail] of cases) {
    const f = validationFixture(); await f.prime();
    const result = await f.run(over);
    validationRefused(result, "budget-unavailable", detail); assert.equal(f.opens(), 0); assert.equal(f.marked(), false);
    assert.deepEqual(f.w.sleeps, [], "unavailable evidence is a named refusal, not an unbounded wait");
  }
  const f = validationFixture(); await f.prime();
  f.files.set("/proc/pressure/memory", "some avg10=0 avg60=0\n");
  validationRefused(await f.run(), "budget-unavailable", "host-pressure-incomplete");
  assert.equal(f.opens(), 0); assert.equal(f.marked(), false);
  for (const [path, value] of [
    ["/proc/sys/kernel/random/boot_id", "22222222-2222-4222-8222-222222222222\n"],
    ["/proc/self/cgroup", "0::/foreign-generation\n"],
    ["/proc/vmstat", "pswpin 50\n"],
  ]) {
    const changed = validationFixture(); await changed.prime(); changed.files.set(path!, value!);
    validationRefused(await changed.run(), "budget-unavailable", path === "/proc/vmstat" ? "strict-observation-counter-reset" : "strict-observation-generation-mismatch");
    assert.equal(changed.opens(), 0); assert.equal(changed.marked(), false);
  }
  const generous = validationFixture(); await generous.prime();
  const numeric = gatherShadowInputs({ ...validationRequest, estimateMib: 900 }, generous.options as AdmissionPorts, POLICY);
  assert.equal(numeric.start.estimateSource, undefined, "a median or numeric estimate supplies no provenance");
  const sourced = gatherShadowInputs({ ...validationRequest, estimateMib: 900, estimateSource: { kind: "measured", samples: 30 } }, generous.options as AdmissionPorts, POLICY);
  assert.deepEqual(sourced.start.estimateSource, { kind: "measured", samples: 30 });
  assert.equal(sourced.start.estimateMib, numeric.start.estimateMib, "metadata does not change the estimator");
  const legacy = await awaitMemoryAdmission(request, { ...generous.options, daemonPid: () => undefined });
  assert.equal(legacy.kind, "admitted");
  if (legacy.kind === "admitted") { assert.equal(legacy.tier, "fits"); legacy.reservation?.releaseOccupancy(); }
});

test("W1-T10208: validation waits then publishes once without changing worker progress", async () => {
  const f = validationFixture(); await f.prime();
  f.w.state.availableMib = 2500; f.w.running.entries = [{ id: "busy", workerClass: "test" }];
  const seen: number[] = [];
  f.w.onSleep = () => { seen.push(f.opens()); f.w.state.availableMib = 9000; };
  const result = await f.run();
  assert.equal(result.kind, "ready"); assert.deepEqual(seen, [0]); assert.equal(f.opens(), 1);
  assert.equal(f.marked(), true);
  if (result.kind === "ready") {
    assert.equal(result.tier, "fits"); assert.equal(result.reservation.id, "fixture-grant-1");
    assert.equal(result.basis, "legacy-compatible-tree-peaks"); result.reservation.releaseOccupancy();
  }
  assert.equal(f.releases(), 1); assert.deepEqual(waitingStarts(), []);
  for (const mode of ["off", "shadow"] as const) {
    const quiet = validationFixture();
    assert.equal((await quiet.run({ policy: () => ({ ...POLICY, mode }), withLock: () => assert.fail("not applicable") })).kind, "not-enforced");
    assert.equal(quiet.opens(), 0);
  }
  assert.equal((await memoryAdmission.awaitValidationMemoryAdmission(validationRequest, {
    policy: () => POLICY,
    readFile: () => assert.fail("the real non-daemon default must return before I/O"),
  })).kind, "not-enforced", "real daemonOwnedProcess default: no forged test authority");
});

test("W1-T10208: validation refusal settles only its own unstarted handle", async () => {
  for (const failure of ["publication", "estimate", "visibility", "abort", "bound", "foreign"] as const) {
    const f = validationFixture(); await f.prime();
    const abort = new AbortController();
    const open = f.options.openReservation!;
    const result = await f.run({
      openReservation: input => {
        const handle = open(input)!;
        if (failure === "abort") abort.abort();
        if (failure === "visibility") f.w.running.entries = [];
        return { ...handle, published: failure !== "publication", estimateMib: failure === "estimate" ? 901 : 900 };
      },
      ownedBinding: () => failure === "foreign" ? { state: "unavailable", reason: "not-owned" }
        : failure === "bound" ? { state: "bound", roots: [{ pid: 7, start: "s7" }] } : { state: "fresh" },
    }, abort.signal);
    const detail = failure === "publication" ? "admission-reservation-unpublished"
      : failure === "estimate" ? "admission-estimate-changed" : failure === "visibility" ? "admission-reservation-not-visible"
        : failure === "abort" ? "admission-abandoned" : "admission-not-fresh-owned";
    validationRefused(result, failure === "abort" ? "abandoned" : "admission-error", detail);
    assert.equal(f.marked(), false, failure);
    assert.equal(f.releases(), failure === "foreign" || failure === "bound" ? 0 : 1, failure);
    assert.deepEqual(waitingStarts(), []);
  }
  const f = validationFixture(); const abort = new AbortController(); abort.abort();
  validationRefused(await f.run({}, abort.signal), "abandoned", "admission-abandoned"); assert.equal(f.opens(), 0);
  const waiting = validationFixture(); await waiting.prime();
  const stop = new AbortController();
  waiting.w.state.availableMib = 2500; waiting.w.running.entries = [{ id: "busy", workerClass: "test" }];
  waiting.w.onSleep = () => stop.abort();
  validationRefused(await waiting.run({}, stop.signal), "abandoned", "admission-abandoned");
  assert.equal(waiting.opens(), 0); assert.deepEqual(waitingStarts(), []);
});

test("W1-T10208: real private learning lock and publication contrast validation with legacy", async () => {
  const root = fixtureRoot("validation-defaults-");
  try {
    const f = validationFixture();
    const dir = join(root, "host-memory"); mkdirSync(dir);
    const clock = f.options.clock!;
    const ledger = { root, location: () => ({ dir, scope: "host" as const }),
      instance: () => ({ name: "fixture", hostUnique: true }),
      generation: () => ({ containerId: "private-fixture", initStart: "proc:1" }),
      probe: (pid: number): memoryLedger.ProbeResult => pid === process.pid
        ? { state: "alive", start: "fixture:learning-owner-start" } : { state: "unknown", reason: "outside private owner fixture" },
      listProcesses: () => ({ rows: [], complete: true }), log: () => undefined, clock };
    const store = { location: ledger.location, instance: ledger.instance, clock };
    for (let i = 0; i < 30; i += 1) assert.equal(memoryLearning.recordPeak("test", 900, store), true);
    memoryLearning.resetLearnedEstimateCacheForTests();
    const seed = memoryLedger.openMemoryReservation({ workerClass: "test", measured: { estimateMib: 900, samples: 30 } }, ledger);
    seed.releaseOccupancy();
    memoryLedger.sweepMemoryReservations(ledger);
    assert.equal(memoryLedger.readMemoryLedger(ledger)?.state, "present", "physical sentinel positive control");
    assert.equal(memoryLedger.readMemoryLedger(ledger)?.entries.length, 0, "the maintained sweep settled the bootstrap seed");
    const controlledRead = f.options.readFile!;
    const real: Partial<memoryAdmission.ValidationAdmissionPorts> = {
      readFile: path => path.startsWith(dir) ? readFileSync(path, "utf8") : controlledRead(path),
      readLedger: () => memoryLedger.readMemoryLedger(ledger),
      withLock: action => memoryLedger.withMemoryAdmissionLock(action, { dir, scope: "host" }),
      validationEstimate: workerClass => memoryLearning.readValidationClassEstimate(workerClass, store),
      openReservation: input => memoryLearning.openLearnedReservation(input, { ledger, store }),
      ownedBinding: id => memoryLedger.ownedMemoryRunBinding(id, ledger),
    };
    validationRefused(await f.run(real), "budget-unavailable", "strict-observation-untagged"); f.w.now.ms += 1000;
    const ready = await f.run(real);
    assert.equal(ready.kind, "ready", JSON.stringify(ready));
    if (ready.kind === "ready") {
      assert.equal(memoryLedger.readMemoryLedger(ledger)?.entries.length, 1, "exactly one physical visible claim");
      assert.equal(memoryLedger.ownedMemoryRunBinding(ready.reservation.id!, ledger).state, "fresh");
      ready.reservation.releaseOccupancy();
    }
    const lockRefusal = validationRefused(await f.run({ ...real,
      withLock: action => memoryLedger.withMemoryAdmissionLock(action, { dir: join(root, "missing"), scope: "host" }) }), "admission-error");
    assert.ok(lockRefusal.details.some(detail => detail.startsWith("admission-lock-unavailable:")), JSON.stringify(lockRefusal));
    const legacy = await awaitMemoryAdmission(request, { ...f.options, ...real,
      withLock: action => memoryLedger.withMemoryAdmissionLock(action, { dir: join(root, "missing"), scope: "host" }) });
    assert.equal(legacy.kind, "error", "actual maintained lock catch retains legacy semantics");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("W1-T10208: strict PSI marking rejects missing ambiguous malformed and failed writes", async () => {
  for (const fault of ["missing", "duplicate", "malformed", "read", "write", "write-then-throw"] as const) {
    const f = validationFixture(); await f.prime();
    const path = join(request.root, "state", "container-pressure.json");
    const read = f.options.readFile!, write = f.options.writeFile!;
    const result = await f.run({
      readFile: p => {
        if (p === path && f.opens() > 0 && fault === "read") throw new Error("private-mark-read");
        return read(p);
      },
      writeFile: (p, text) => {
        if (p !== path) return write(p, text);
        const value = JSON.parse(text);
        if (value.psi.some((row: number[]) => row[2] === 1)) {
          if (fault === "write-then-throw") write(p, text);
          if (fault === "write" || fault === "write-then-throw") throw new Error("private-mark-write");
        } else {
          if (fault === "missing") value.psi = value.psi.filter((row: number[]) => row[0] !== f.w.now.ms);
          if (fault === "duplicate") value.psi.push([...value.psi.at(-1)]);
          if (fault === "malformed") value.psi.push([f.w.now.ms, 0, 9, null, 0]);
        }
        write(p, JSON.stringify(value));
      },
    });
    const detail = fault === "read" ? "psi-mark-unavailable"
      : fault === "missing" ? "psi-mark-missing" : fault === "duplicate" ? "psi-mark-ambiguous"
        : fault === "malformed" ? "psi-mark-malformed" : "psi-mark-write-failed";
    const refused = validationRefused(result, "admission-error", detail);
    assert.equal(refused.cleanup, "release-requested");
    assert.equal(refused.psiMark.kind, fault === "write" || fault === "write-then-throw" ? "unknown" : "not-recorded");
    assert.equal(f.opens(), 1); assert.equal(f.releases(), 1);
    const current = JSON.parse(f.files.get(path)!).psi.filter((row: number[]) => row[0] === f.w.now.ms);
    if (fault === "write-then-throw") assert.equal(current[0][2], 1, "a failed write can have prior effects; do not assert rollback");
  }
  const f = validationFixture(); await f.prime();
  const ready = await f.run();
  assert.equal(ready.kind, "ready", JSON.stringify(ready));
  if (ready.kind !== "ready") assert.fail("positive strict marker control");
  assert.deepEqual(ready.psiMark, { kind: "recorded", at: f.w.now.ms,
    sampleId: JSON.parse(f.files.get(join(request.root, "state", "container-pressure.json"))!).validationObservation.sampleId });
  const rows = JSON.parse(f.files.get(join(request.root, "state", "container-pressure.json"))!).psi;
  assert.equal(rows.filter((row: number[]) => row[0] === f.w.now.ms && row[2] === 1).length, 1);
  assert.ok(rows.filter((row: number[]) => row[0] !== f.w.now.ms).every((row: number[]) => row[2] === 0));
  ready.reservation.releaseOccupancy();
});

test("W1-T10208: cancellation at mark lock and admit sink never returns ready or erases recorded effects", async () => {
  for (const phase of ["mark", "after-lock", "admit-sink"] as const) {
    const f = validationFixture(); await f.prime();
    const stop = new AbortController(), writeFile = f.options.writeFile!, write = f.options.write!;
    if (phase === "admit-sink") {
      f.w.state.availableMib = 2500; f.w.running.entries = [{ id: "busy", workerClass: "test" }];
      f.w.onSleep = () => { f.w.state.availableMib = 9000; };
    }
    const result = await f.run({
      withLock: action => { const value = action(); if (phase === "after-lock") stop.abort(); return value; },
      writeFile: (path, text) => {
        writeFile(path, text);
        if (phase === "mark" && JSON.parse(text).psi?.some((row: number[]) => row[2] === 1)) stop.abort();
      },
      write: (path, row) => { write(path, row); if (phase === "admit-sink" && row.step === ENFORCE_ADMIT_STEP) stop.abort(); },
    }, stop.signal);
    const refused = validationRefused(result, "abandoned", "admission-abandoned");
    assert.deepEqual(refused.psiMark, { kind: "recorded", at: f.w.now.ms,
      sampleId: JSON.parse(f.files.get(join(request.root, "state", "container-pressure.json"))!).validationObservation.sampleId });
    assert.equal(refused.cleanup, "release-requested");
    assert.equal(f.opens(), 1); assert.equal(f.releases(), 1);
    assert.equal(f.marked(), true, "admitted bookkeeping is not undone or reported never written");
    assert.deepEqual(waitingStarts(), []);
  }
});

test("W1-T10208: native private release persistence failure is requested not verified released", async () => {
  const root = fixtureRoot("validation-release-");
  try {
    const f = validationFixture(); await f.prime();
    const dir = join(root, "host-memory"); mkdirSync(dir);
    let recordPath = "", releaseWrites = 0, failRelease = false;
    const deps = { root, location: () => ({ dir, scope: "host" as const }),
      instance: () => ({ name: "fixture", hostUnique: true }),
      generation: () => ({ containerId: "private-fixture", initStart: "proc:1" }),
      probe: (pid: number): memoryLedger.ProbeResult => pid === process.pid
        ? { state: "alive", start: "fixture:release-owner-start" } : { state: "unknown", reason: "outside private owner fixture" },
      listProcesses: () => ({ rows: [], complete: true }), log: () => undefined, clock: f.options.clock!,
      write: (path: string, text: string) => {
        if (failRelease && JSON.parse(text).occupancyReleasedAt !== undefined) { releaseWrites += 1; throw new Error("private-release-write"); }
        recordPath = path; writeFileSync(path, text);
      } };
    const seed = memoryLedger.openMemoryReservation({ workerClass: "test", measured: { estimateMib: 900, samples: 30 } }, deps);
    seed.releaseOccupancy();
    memoryLedger.sweepMemoryReservations(deps);
    assert.equal(memoryLedger.readMemoryLedger(deps)?.state, "present", "private canonical-store positive control");
    assert.equal(memoryLedger.readMemoryLedger(deps)?.entries.length, 0, "the bootstrap seed settled before release faults are enabled");
    failRelease = true;
    const stop = new AbortController();
    const result = await f.run({
      readLedger: () => memoryLedger.readMemoryLedger(deps),
      openReservation: () => {
        const handle = memoryLedger.openMemoryReservation({ workerClass: "test", measured: { estimateMib: 900, samples: 30 } }, deps);
        stop.abort();
        return { ...handle, workerClass: "test", estimateMib: 900, estimateSource: { kind: "measured", samples: 30 } };
      },
      ownedBinding: id => memoryLedger.ownedMemoryRunBinding(id, deps),
    }, stop.signal);
    const refused = validationRefused(result, "abandoned", "admission-abandoned");
    assert.equal(refused.cleanup, "release-requested");
    assert.deepEqual(refused.psiMark, { kind: "not-attempted" });
    assert.ok(releaseWrites > 0, "actual native handle reached the faulted persistence port");
    assert.equal(JSON.parse(readFileSync(recordPath, "utf8")).occupancyReleasedAt, undefined, "stored occupancy was not proven released");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("W1-T10208: strict marker is unique while the legacy marker retains first-match behavior", () => {
  const f = validationFixture();
  const evidence = gatherShadowInputs(validationRequest, f.options as AdmissionPorts, POLICY, { strictEvidence: true }).strictEvidence;
  assert.equal(evidence?.kind, "unavailable");
  if (!evidence?.marker) assert.fail("real first observation must supply its exact marker target");
  const target = evidence.marker, path = request.root;
  const value = JSON.parse(f.files.get(join(path, "state", "container-pressure.json"))!);
  value.psi.push([...value.psi.at(-1)]);
  let current = JSON.stringify(value), writes = 0;
  const io = { readFile: () => current, writeFile: (_path: string, value: string) => { writes += 1; current = value; } };
  assert.deepEqual(markStrictPsiStartAdmitted(io, path, target), { kind: "not-recorded", reason: "ambiguous", at: target.sample.sampleAt });
  assert.equal(writes, 0);
  assert.equal(markPsiStartAdmitted(io, path, target.sample.sampleAt), true, "legacy contract still returns boolean and marks its first matching row");
  assert.deepEqual(JSON.parse(current).psi.map((row: number[]) => row[2]), [1, 0]);
});

test("W1-T10208: strict marker uses default private atomic IO without claiming atomic history", () => {
  const root = fixtureRoot("validation-mark-default-");
  try {
    mkdirSync(join(root, "state"));
    const path = join(root, "state", "container-pressure.json"), io = defaultShadowMemoryPorts();
    const f = validationFixture(), controlledRead = f.options.readFile!;
    const observed = gatherShadowInputs({ ...validationRequest, root }, { ...f.options,
      readFile: p => p.startsWith(root) ? io.readFile(p) : controlledRead(p), writeFile: io.writeFile,
    } as AdmissionPorts, POLICY, { strictEvidence: true }).strictEvidence;
    if (!observed?.marker) assert.fail("maintained reader did not publish an actual target");
    const target = observed.marker, at = target.sample.sampleAt;
    assert.deepEqual(markStrictPsiStartAdmitted(io, root, target), { kind: "recorded", at, sampleId: target.sample.sampleId });
    assert.equal(JSON.parse(readFileSync(path, "utf8")).psi[0][2], 1);
    assert.deepEqual(markStrictPsiStartAdmitted(io, root, target), { kind: "not-recorded", reason: "already-recorded", at });
    assert.equal(markPsiStartAdmitted(io, root, at), true, "unchanged legacy best-effort boolean");
    for (const text of ["null", "[]", "{bad", JSON.stringify({ psi: [[10, 0, 9, null, 0]] })]) {
      writeFileSync(path, text);
      assert.deepEqual(markStrictPsiStartAdmitted(io, root, target), { kind: "not-recorded", reason: "malformed", at });
      assert.equal(readFileSync(path, "utf8"), text, "a malformed store was not rewritten");
    }
    rmSync(path);
    assert.deepEqual(markStrictPsiStartAdmitted(io, root, target), { kind: "not-recorded", reason: "unavailable", at });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

function strictObservation(f: ReturnType<typeof validationFixture>, over: Partial<AdmissionPorts> = {}) {
  const result = gatherShadowInputs(validationRequest, { ...f.options, ...over } as AdmissionPorts, POLICY, { strictEvidence: true });
  assert.ok(result.strictEvidence, "the maintained reader must expose evidence, not a private inferred map");
  return result.strictEvidence;
}

test("W1-T10208: one reader timestamp qualifies after the outer decision clock advances", async () => {
  const f = validationFixture(); await f.prime();
  const outer = f.w.now.ms, basis = f.options.validationEstimate!;
  const ready = await f.run({ validationEstimate: cls => { f.w.now.ms += 7; return basis(cls); } });
  assert.equal(ready.kind, "ready", JSON.stringify(ready));
  if (ready.kind !== "ready") assert.fail("a real fitting tagged interval must not depend on the outer stamp");
  const stored = JSON.parse(f.files.get(join(request.root, "state", "container-pressure.json"))!);
  assert.equal(ready.psiMark.at, outer + 7);
  assert.equal(stored.validationObservation.sampleAt, outer + 7);
  assert.equal(stored.validationMarker.row[0], outer + 7);
  assert.equal(stored.prior.at, outer + 7);
  ready.reservation.releaseOccupancy();
});

test("W1-T10208: strict priors survive ordinary gathers without changing legacy rates", () => {
  const f = validationFixture(), a = strictObservation(f);
  if (a.kind !== "unavailable" || !a.current) assert.fail("expected an actual first observation");
  assert.deepEqual(a.reasons, ["strict-observation-untagged"]);
  f.w.now.ms += 200; f.files.set("/proc/vmstat", "pswpin 101\n");
  f.files.set("/sys/fs/cgroup/memory.stat", "anon 1\nfile 1\ninactive_file 0\npswpin 101\n");
  const firstLegacy = gatherShadowInputs(validationRequest, f.options as AdmissionPorts, POLICY);
  assert.deepEqual(firstLegacy.swapIn, { unmeasured: "first sample in this process" }, "strict calls did not change the legacy module prior");
  const persisted = JSON.parse(f.files.get(join(request.root, "state", "container-pressure.json"))!);
  assert.deepEqual(persisted.validationObservation, a.current, "ordinary writer preserved the actual older tag without refreshing it");
  f.w.now.ms += 200; f.files.set("/proc/vmstat", "pswpin 102\n");
  const secondLegacy = gatherShadowInputs({ ...validationRequest, root: "/private-other-fixture" }, f.options as AdmissionPorts, POLICY);
  assert.deepEqual(secondLegacy.swapIn, { pagesPerSec: 5, diskPagesPerSec: 5, zswapPagesPerSec: 0,
    zswapBasis: "no zswpin line (zswap not compiled in): 0" }, "unchanged legacy host-global interval");
  f.w.now.ms += 600; f.files.set("/proc/vmstat", "pswpin 103\n");
  f.files.set("/sys/fs/cgroup/memory.stat", "anon 1\nfile 1\ninactive_file 0\npswpin 102\n");
  resetShadowMemoryStateForTests(); resetMemoryAdmissionStateForTests();
  const b = strictObservation(f);
  assert.equal(b.kind, "paired", JSON.stringify(b));
  if (b.kind !== "paired") assert.fail("persisted evidence, not a module prior, must qualify");
  assert.deepEqual(b.prior, a.current); assert.equal(b.elapsedMs, 1000);
  assert.equal(b.hostPagesPerSec, 3); assert.equal(b.containerPagesPerSec, 2);
  assert.notEqual(b.current.sampleId, a.current.sampleId);
});

test("W1-T10208: tagged-window unavailable reasons distinguish reset stale malformed and generation changes", async () => {
  for (const fault of ["untagged", "malformed", "version", "boot", "cgroup", "init", "counter", "stale", "crossing-stale", "future", "no-elapsed", "current-unread", "generation-unread", "multiline-counter", "identity-change"] as const) {
    const f = validationFixture(); await f.prime();
    const path = join(request.root, "state", "container-pressure.json"), store = JSON.parse(f.files.get(path)!);
    const tag = store.validationObservation;
    const original = f.options.readFile!;
    let bootReads = 0;
    const over: Partial<memoryAdmission.ValidationAdmissionPorts> = {};
    let reason = "strict-observation-generation-mismatch";
    if (fault === "untagged") { delete store.validationObservation; delete store.validationMarker; reason = "strict-observation-untagged"; }
    if (fault === "malformed" || fault === "version") {
      store.validationObservation = fault === "malformed" ? null : { ...tag, version: 2 };
      reason = "strict-observation-malformed";
    }
    if (fault === "boot") f.files.set("/proc/sys/kernel/random/boot_id", "22222222-2222-4222-8222-222222222222\n");
    if (fault === "cgroup") f.files.set("/proc/self/cgroup", "0::/other\n");
    if (fault === "init") f.files.set("/proc/1/stat", `1 (init) S 0 ${"0 ".repeat(17)}101 0 0`);
    if (fault === "counter") { f.files.set("/proc/vmstat", "pswpin 99\n"); reason = "strict-observation-counter-reset"; }
    if (fault === "stale") { f.w.now.ms = tag.sampleAt + POLICY.staleReadingMs + 1; reason = "strict-observation-stale"; }
    if (fault === "crossing-stale") { f.w.now.ms = tag.sampleAt + 60_001; reason = "strict-observation-crossing-stale"; }
    if (fault === "future" || fault === "no-elapsed") { f.w.now.ms = tag.sampleAt - (fault === "future" ? 1 : 0); reason = "strict-observation-nonpositive-window"; }
    if (fault === "current-unread") {
      over.readFile = p => { if (p === "/proc/vmstat") throw new Error("private-counter-unread"); return original(p); };
      reason = "strict-observation-counter-unavailable";
    }
    if (fault === "generation-unread") {
      over.readFile = p => { if (p === "/proc/sys/kernel/random/boot_id") throw new Error("private-generation-unread"); return original(p); };
      reason = "strict-observation-generation-unavailable";
    }
    if (fault === "multiline-counter") {
      f.files.set("/proc/vmstat", "pswpin\n100\n"); reason = "strict-observation-counter-unavailable";
    }
    if (fault === "identity-change") {
      over.readFile = p => p === "/proc/sys/kernel/random/boot_id" && ++bootReads === 2
        ? "22222222-2222-4222-8222-222222222222\n" : original(p);
      reason = "strict-observation-generation-changed";
    }
    f.files.set(path, JSON.stringify(store));
    const before = f.files.get(path);
    const refused = validationRefused(await f.run(over), "budget-unavailable", reason);
    assert.deepEqual(refused.psiMark, { kind: "not-attempted" });
    assert.equal(f.opens(), 0); assert.equal(f.marked(), false); assert.deepEqual(f.w.sleeps, []);
    if (["current-unread", "generation-unread", "multiline-counter", "identity-change"].includes(fault)) {
      assert.equal(f.files.get(path), before, "an incomplete current observation was not persisted as a new sample");
    }
  }
});

test("W1-T10208: observation write failures never create a ready or known persisted window", async () => {
  for (const afterWrite of [false, true]) {
    const f = validationFixture(); await f.prime();
    const write = f.options.writeFile!;
    const refused = validationRefused(await f.run({ writeFile: (path, value) => {
      if (afterWrite) write(path, value);
      throw new Error("private-observation-write");
    } }), "budget-unavailable", "strict-observation-write-failed");
    assert.equal(f.opens(), 0); assert.deepEqual(refused.psiMark, { kind: "not-attempted" });
  }
});

test("W1-T10208: a delayed ordinary private-file writer may erase a recorded strict mark", () => {
  const root = fixtureRoot("validation-history-interleave-");
  try {
    mkdirSync(join(root, "state"));
    const f = validationFixture(), io = defaultShadowMemoryPorts(), raw = f.options.readFile!;
    const ports = { ...f.options, readFile: (p: string) => p.startsWith(root) ? io.readFile(p) : raw(p), writeFile: io.writeFile } as AdmissionPorts;
    const start = { ...validationRequest, root }, path = join(root, "state", "container-pressure.json");
    const first = gatherShadowInputs(start, ports, POLICY, { strictEvidence: true }).strictEvidence;
    if (!first?.current) assert.fail("actual first private-file observation required");
    f.w.now.ms += 200;
    const delayed: { value?: { path: string; text: string } } = {};
    gatherShadowInputs(start, { ...ports, writeFile: (p, text) => { delayed.value = { path: p, text }; } }, POLICY);
    assert.ok(delayed.value, "ordinary writer reached the pre-replace barrier");
    f.w.now.ms += 800;
    const next = gatherShadowInputs(start, ports, POLICY, { strictEvidence: true }).strictEvidence;
    if (next?.kind !== "paired") assert.fail(JSON.stringify(next));
    assert.deepEqual(markStrictPsiStartAdmitted(io, root, next.marker),
      { kind: "recorded", at: next.current.sampleAt, sampleId: next.current.sampleId });
    assert.equal(JSON.parse(readFileSync(path, "utf8")).psi.at(-1)[2], 1, "real atomic writer positive control");
    io.writeFile(delayed.value.path, delayed.value.text); // Release only this fixture's staged older writer.
    const final = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(final.validationObservation.sampleId, first.current.sampleId);
    assert.equal(final.psi.some((row: number[]) => row[2] === 1), false, "recorded was not a permanent-history promise");
    assert.deepEqual(markStrictPsiStartAdmitted(io, root, next.marker),
      { kind: "not-recorded", reason: "missing", at: next.current.sampleAt });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("W1-T10208: strict marker binds token generation counters and row without promising retained history", () => {
  const f = validationFixture(), a = strictObservation(f);
  if (!a.current || !a.marker) assert.fail("actual sample A required");
  const path = join(request.root, "state", "container-pressure.json"), savedA = f.files.get(path)!;
  f.w.now.ms += 1000;
  const b = strictObservation(f);
  if (b.kind !== "paired") assert.fail(JSON.stringify(b));
  const savedB = f.files.get(path)!;
  for (const change of ["token", "generation", "counter", "row"] as const) {
    const target = JSON.parse(JSON.stringify(b.marker)) as StrictPsiTarget;
    if (change === "token") target.sample.sampleId = a.current.sampleId;
    if (change === "generation") target.sample.generation.initStart = "proc:999";
    if (change === "counter") target.sample.counters.hostPswpin += 1;
    if (change === "row") target.row[1] = 1;
    assert.deepEqual(markStrictPsiStartAdmitted(f.options as AdmissionPorts, request.root, target),
      { kind: "not-recorded", reason: "changed", at: b.current.sampleAt });
    assert.equal(f.files.get(path), savedB);
  }
  assert.deepEqual(markStrictPsiStartAdmitted(f.options as AdmissionPorts, request.root, b.marker),
    { kind: "recorded", at: b.current.sampleAt, sampleId: b.current.sampleId });
  // A delayed ordinary writer can replace the successful mark with its older snapshot. No atomic-history claim.
  f.options.writeFile!(path, savedA);
  assert.equal(JSON.parse(f.files.get(path)!).psi.some((row: number[]) => row[2] === 1), false);
  assert.deepEqual(markStrictPsiStartAdmitted(f.options as AdmissionPorts, request.root, b.marker),
    { kind: "not-recorded", reason: "missing", at: b.current.sampleAt });
});

test("W1-T10208: a fresh child reads actual private history before its first validation ask", async () => {
  assert.equal(typeof memoryAdmission.awaitValidationMemoryAdmission, "function", "the validation entry is missing");
  const root = fixtureRoot("validation-cold-process-"), children: ChildProcess[] = [];
  const dir = join(root, "host-memory"), state = join(root, "state");
  mkdirSync(dir); mkdirSync(state);
  const clock = { now: () => NOW, iso: () => new Date(NOW).toISOString(), date: () => new Date(NOW) };
  const ledger = { root, location: () => ({ dir, scope: "host" as const }),
    instance: () => ({ name: "fixture", hostUnique: true }),
    generation: () => ({ containerId: "private-cold", initStart: "proc:1" }),
    probe: (pid: number): memoryLedger.ProbeResult => pid === process.pid
      ? { state: "alive", start: "fixture:cold-owner-start" } : { state: "unknown", reason: "outside private owner fixture" },
    listProcesses: () => ({ rows: [], complete: true }), clock, log: () => undefined };
  const store = { location: ledger.location, instance: ledger.instance, clock };
  const entry = join(root, "validation-cold-child.mjs");
  const admissionUrl = new URL("../src/lib/host-memory-admission.ts", import.meta.url).href;
  const shadowUrl = new URL("../src/lib/host-memory-shadow.ts", import.meta.url).href;
  const ledgerUrl = new URL("../src/lib/host-memory-ledger.ts", import.meta.url).href;
  const learningUrl = new URL("../src/lib/host-memory-learning.ts", import.meta.url).href;
  try {
    for (let i = 0; i < 30; i += 1) assert.equal(memoryLearning.recordPeak("test", 900, store), true);
    const seed = memoryLedger.openMemoryReservation({ workerClass: "test", measured: { estimateMib: 900, samples: 30 } }, ledger);
    seed.releaseOccupancy();
    memoryLedger.sweepMemoryReservations(ledger);
    assert.equal(memoryLedger.readMemoryLedger(ledger)?.state, "present");
    assert.equal(memoryLedger.readMemoryLedger(ledger)?.entries.length, 0, "the bootstrap seed settled before either cold child starts");
    writeFileSync(entry, `
      import {readFileSync} from 'node:fs';
      import {awaitValidationMemoryAdmission} from ${JSON.stringify(admissionUrl)};
      import {defaultShadowMemoryPorts} from ${JSON.stringify(shadowUrl)};
      import * as ledger from ${JSON.stringify(ledgerUrl)};
      import * as learning from ${JSON.stringify(learningUrl)};
      const MIB=1024*1024, root=${JSON.stringify(root)}, dir=${JSON.stringify(dir)}, now=${NOW}+Number(process.argv[2])*1000;
      const clock={now:()=>now,iso:()=>new Date(now).toISOString(),date:()=>new Date(now)};
      const deps={root,location:()=>({dir,scope:'host'}),instance:()=>({name:'fixture',hostUnique:true}),
        generation:()=>({containerId:'private-cold',initStart:'proc:1'}),
        probe:pid=>pid===process.pid?{state:'alive',start:'fixture:cold-owner-start'}:{state:'unknown',reason:'outside private owner fixture'},
        listProcesses:()=>({rows:[],complete:true}),clock,log:()=>{}};
      const store={location:deps.location,instance:deps.instance,clock}, io=defaultShadowMemoryPorts();
      const raw=(${host.toString()})({availableMib:9000});
      const readFile=p=>{
        if(p.startsWith(root+'/'))return readFileSync(p,'utf8');
        if(p==='/proc/sys/kernel/random/boot_id')return '11111111-1111-4111-8111-111111111111';
        if(p==='/proc/self/cgroup')return '0::/fixture';
        if(p==='/proc/1/stat')return '1 (init) S 0 '+'0 '.repeat(17)+'100 0 0';
        if(p==='/sys/fs/cgroup/memory.high')return 'max';
        if(p==='/sys/fs/cgroup/memory.stat')return 'anon 1\\nfile 1\\ninactive_file 0\\npswpin 100\\n';
        if(p==='/sys/fs/cgroup/memory.pressure')return raw('/proc/pressure/memory');
        return raw(p);
      };
      const result=await awaitValidationMemoryAdmission({workerClass:'test',root}, {
        ...io,clock,readFile,policy:()=>(${JSON.stringify(POLICY)}),enforceHere:()=>true,
        readTail:()=>Array.from({length:${POLICY.daemonGrowthMinSamples}},(_,i)=>JSON.stringify({
          ts:new Date(now-(${POLICY.daemonGrowthMinSamples}-i)*1000).toISOString(),step:'daemon.alive',actor_pid:777,rss_bytes:MIB*1024,vm_swap_bytes:0})).join('\\n')+'\\n',
        readHostServe:()=>({state:'present',scenario:'serve-steady',basis:'private',observedAt:new Date(now).toISOString(),ageMs:0,producer:'fixture',superseded:0}),
        readLedger:()=>ledger.readMemoryLedger(deps),withLock:action=>ledger.withMemoryAdmissionLock(action,{dir,scope:'host'}),
        validationEstimate:cls=>learning.readValidationClassEstimate(cls,store),
        estimate:cls=>learning.classEstimate(cls,store).estimateMib,typical:cls=>learning.classTypical(cls,store).estimateMib,
        survival:(cls,age)=>learning.classSurvival(cls,age,store),
        openReservation:input=>learning.openLearnedReservation(input,{ledger:deps,store}),
        ownedBinding:id=>ledger.ownedMemoryRunBinding(id,deps),instance:()=> 'fixture',daemonPid:()=>777,
        listStateDir:()=>[],write:()=>{},stderr:()=>{},random:()=>0.5,sleep:async()=>{throw new Error('unexpected private wait')}
      });
      const message={kind:result.kind,reason:result.reason,details:result.details,mark:result.psiMark,
        visible:ledger.readMemoryLedger(deps)?.entries.length,id:result.reservation?.id,
        binding:result.reservation?.id?ledger.ownedMemoryRunBinding(result.reservation.id,deps).state:undefined};
      result.reservation?.releaseOccupancy();
      process.send(message,()=>process.disconnect());
    `);
    type Result = { kind: string; reason?: string; details?: string[]; mark?: { kind: string; sampleId?: string }; visible?: number; id?: string; binding?: string };
    const run = async (offset: number): Promise<Result> => {
      const child = fork(entry, [String(offset)], {
        execPath: process.execPath, execArgv: ["--import", join(REPO_ROOT, "node_modules", "tsx", "dist", "loader.mjs")],
        env: { PATH: process.env.PATH, HOME: root, TMPDIR: root, GH_CONFIG_DIR: root, GIT_TERMINAL_PROMPT: "0" },
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      });
      children.push(child); child.stderr?.resume();
      return await new Promise<Result>((resolve, reject) => {
        let message: Result | undefined;
        // Same private-child liveness backstop as the existing native boundary, not an admission policy.
        const timer = setTimeout(() => reject(new Error("private cold child did not close")), 10_000);
        child.once("message", m => { message = m as Result; });
        child.once("error", error => { clearTimeout(timer); reject(error); });
        child.once("close", (code, signal) => {
          clearTimeout(timer);
          if (code !== 0 || signal || !message) reject(new Error(`private child incomplete: ${code}/${signal}`));
          else resolve(message);
        });
      });
    };
    const a = await run(0);
    assert.equal(a.kind, "not-started"); assert.equal(a.reason, "budget-unavailable");
    assert.ok(a.details?.includes("strict-observation-untagged")); assert.equal(a.visible, 0);
    const first = JSON.parse(readFileSync(join(state, "container-pressure.json"), "utf8")).validationObservation;
    assert.equal(first.sampleAt, NOW, "child A actually persisted the tagged observation");
    const b = await run(1);
    assert.equal(b.kind, "ready", JSON.stringify(b)); assert.equal(b.visible, 1); assert.equal(b.binding, "fresh");
    assert.ok(b.id); assert.equal(b.mark?.kind, "recorded"); assert.notEqual(b.mark?.sampleId, first.sampleId);
    memoryLedger.sweepMemoryReservations(ledger);
    assert.equal(memoryLedger.readMemoryLedger(ledger)?.entries.length, 0, "both children closed and the own unbound claim settled");
  } finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) {
      const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
      child.kill("SIGTERM"); await closed; // Only this test's disposable child, never running product work.
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T10208: validation estimates require complete compatible private-store evidence", () => {
  const root = fixtureRoot("validation-estimate-reader-");
  const dir = join(root, "host-memory"), path = join(dir, "estimates", "fixture.ndjson");
  const store: memoryLearning.PeakStoreOptions = {
    location: () => ({ dir, scope: "host" }), instance: () => ({ name: "fixture" }),
    clock: { now: () => NOW, iso: () => new Date(NOW).toISOString(), date: () => new Date(NOW) }, log: () => undefined,
  };
  const read = (options = store) => {
    assert.equal(typeof memoryLearning.readValidationClassEstimate, "function", "the validation estimate entry is missing");
    return memoryLearning.readValidationClassEstimate("test", options);
  };
  const unavailable = (reason: string, options = store) => assert.deepEqual(read(options), { kind: "unavailable", reason });
  try {
    unavailable("estimate-population-incomplete");
    mkdirSync(join(dir, "estimates"), { recursive: true });
    unavailable("no-measured-samples");
    for (let i = 0; i < 30; i += 1) assert.equal(memoryLearning.recordPeak("test", 900, store), true);
    const valid = readFileSync(path, "utf8");
    const expected = { kind: "measured", estimateMib: 900, typicalMib: 900, samples: 30, basis: "legacy-compatible-tree-peaks" };
    assert.deepEqual(read(), expected, "actual writer, directory listing, tail reader and parser see the complete private corpus");
    memoryLearning.resetLearnedEstimateCacheForTests();
    const legacy = memoryLearning.classEstimate("test", store), typical = memoryLearning.classTypical("test", store);
    assert.deepEqual(legacy, { estimateMib: 900, samples: 30 });
    assert.deepEqual(typical, legacy);
    writeFileSync(path, "{malformed-json\n", { flag: "a" });
    unavailable("estimate-population-incomplete");
    memoryLearning.resetLearnedEstimateCacheForTests();
    assert.deepEqual(memoryLearning.classEstimate("test", store), legacy, "legacy still tolerates the malformed row");
    const row = { c: "test", p: 900, at: new Date(NOW).toISOString(), basis: "legacy-hwm" };
    for (const [label, invalid] of [
      ["unsupported metric", { ...row, basis: "unsupported-metric" }],
      ["process HWM", { ...row, basis: "process-hwm" }],
      ["unpaired concurrent RSS", { ...row, basis: "concurrent-rss" }],
      ["future sample", { ...row, at: new Date(NOW + 1).toISOString() }],
      ["zero peak", { ...row, p: 0 }],
      ["negative peak", { ...row, p: -1 }],
    ] as const) {
      writeFileSync(path, valid + JSON.stringify(invalid) + "\n");
      assert.deepEqual(read(), { kind: "unavailable", reason: "estimate-basis-unavailable" }, label);
    }
    writeFileSync(path, valid);
    const unreadable = join(dir, "estimates", "unreadable.ndjson");
    mkdirSync(unreadable);
    unavailable("estimate-population-incomplete");
    rmSync(unreadable, { recursive: true });
    assert.deepEqual(read(), expected, "removing only the private invalid population entry restores the default read");
    writeFileSync(path, "");
    for (let i = 0; i < 30; i += 1) assert.equal(memoryLearning.recordPeak("test", 90,
      { ...store, measurementBasis: "concurrent-rss", legacyPeakMib: 900 }), true);
    assert.deepEqual(read(), expected, "paired concurrent RSS uses its 900 MiB legacy metric, not its 90 MiB RSS");
    memoryLearning.resetLearnedEstimateCacheForTests();
    assert.deepEqual(memoryLearning.classEstimate("test", store), legacy);
    assert.deepEqual(memoryLearning.classTypical("test", store), typical);
    unavailable("estimate-reader-unavailable", { ...store, location: () => { throw new Error("private-location-unavailable"); } });
  } finally {
    memoryLearning.resetLearnedEstimateCacheForTests();
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T10208: strict read failures distinguish safe unreadable codes from malformed generation and counters", async () => {
  const privateMessage = "PRIVATE_STRICT_READ_MESSAGE_/never-emit", privateCode = "EPRIVATE_STRICT_READ_CODE";
  const unread = (code?: string) => Object.assign(new Error(privateMessage), code === undefined ? {} : { code });
  for (const [path, response, family, detail] of [
    ["/proc/sys/kernel/random/boot_id", unread("EACCES"), "generation", "unreadable:EACCES"],
    ["/proc/self/cgroup", unread("EACCES"), "generation", "unreadable:EACCES"],
    ["/proc/sys/kernel/random/boot_id", "malformed-boot-id\n", "generation", "malformed"],
    ["/proc/self/cgroup", "malformed-cgroup\n", "generation", "malformed"],
    ["/proc/vmstat", unread("EIO"), "counter", "unreadable:EIO"],
    ["/proc/vmstat", "pswpin not-a-counter\n", "counter", "malformed"],
    ["/proc/sys/kernel/random/boot_id", unread(privateCode), "generation", "unreadable:UNKNOWN"],
    ["/proc/vmstat", unread(), "counter", "unreadable:UNKNOWN"],
  ] as const) {
    const f = validationFixture(); await f.prime();
    const pressurePath = join(request.root, "state", "container-pressure.json"), before = f.files.get(pressurePath);
    const original = f.options.readFile!;
    let faultReads = 0;
    const over: Partial<memoryAdmission.ValidationAdmissionPorts> = { readFile: p => {
      if (p !== path) return original(p);
      faultReads += 1;
      if (typeof response === "string") return response;
      throw response;
    } };
    const reason = `strict-observation-${family}-${detail}`, generic = `strict-observation-${family}-unavailable`;
    const evidence = strictObservation(f, over);
    assert.equal(evidence.kind, "unavailable");
    if (evidence.kind !== "unavailable") assert.fail("a failed current read cannot qualify a strict window");
    assert.ok(evidence.reasons.includes(reason), JSON.stringify(evidence.reasons));
    assert.ok(evidence.reasons.includes(generic), JSON.stringify(evidence.reasons));
    assert.equal(evidence.observationWrite, "not-attempted");
    assert.equal(evidence.current, undefined);
    const refused = validationRefused(await f.run(over), "budget-unavailable", reason);
    assert.ok(refused.details.includes(generic), JSON.stringify(refused));
    assert.ok([...evidence.reasons, ...refused.details].every(value =>
      !value.startsWith(`strict-observation-${family}-`) || value === reason || value === generic),
    "unreadable and malformed inputs must not acquire each other's reason");
    assert.ok([...evidence.reasons, ...refused.details].every(value =>
      !value.includes(privateMessage) && !value.includes(privateCode)), "only recognized error codes may leave the strict reader");
    assert.ok(faultReads > 0, "the intended read fault was actually reached");
    assert.equal(f.opens(), 0); assert.equal(f.releases(), 0); assert.equal(f.marked(), false);
    assert.deepEqual(refused.psiMark, { kind: "not-attempted" });
    assert.deepEqual(f.w.sleeps, []);
    assert.equal(f.files.get(pressurePath), before, "an unreadable or malformed current input never replaces the prior observation");
  }
});

test("W1-T10208: hostile error inspection stays an unavailable private strict observation", async () => {
  const privateMessage = "PRIVATE_HOSTILE_READ_MESSAGE_/never-emit";
  const trap = () => { throw new Error(privateMessage); };
  const accessor = Object.defineProperty(new Error(privateMessage), "code", { get: trap });
  const proxy = new Proxy(new Error(privateMessage), { getOwnPropertyDescriptor: trap, has: trap, get: trap });
  for (const [family, path, response] of [
    ["generation", "/proc/sys/kernel/random/boot_id", accessor],
    ["counter", "/proc/vmstat", proxy],
  ] as const) {
    const f = validationFixture(); await f.prime();
    const pressurePath = join(request.root, "state", "container-pressure.json"), before = f.files.get(pressurePath);
    const original = f.options.readFile!;
    let reads = 0;
    const over: Partial<memoryAdmission.ValidationAdmissionPorts> = { readFile: p => {
      if (p !== path) return original(p);
      reads += 1; throw response;
    } };
    let evidence!: ReturnType<typeof strictObservation>;
    assert.doesNotThrow(() => { evidence = strictObservation(f, over); }, `${family}: hostile inspection must be normalized`);
    assert.equal(evidence.kind, "unavailable");
    if (evidence.kind !== "unavailable") assert.fail("a hostile read error cannot qualify a window");
    const reason = `strict-observation-${family}-unreadable:UNKNOWN`, generic = `strict-observation-${family}-unavailable`;
    assert.ok(evidence.reasons.includes(reason)); assert.ok(evidence.reasons.includes(generic));
    assert.equal(evidence.current, undefined); assert.equal(evidence.observationWrite, "not-attempted");
    const refused = validationRefused(await f.run(over), "budget-unavailable", reason);
    assert.ok(refused.details.includes(generic));
    assert.ok([...evidence.reasons, ...refused.details].every(value => !value.includes(privateMessage)));
    assert.ok(reads > 0, "the hostile error came from the intended private read");
    assert.equal(f.opens(), 0); assert.equal(f.releases(), 0); assert.equal(f.marked(), false);
    assert.deepEqual(refused.psiMark, { kind: "not-attempted" }); assert.deepEqual(f.w.sleeps, []);
    assert.equal(f.files.get(pressurePath), before, "hostile errors never replace the prior observation");
  }
});

const QUEUE_STEP = "memory_budget.enforce_queue";

function observedQueue(
  headInput: AdmissionRequest = { ...request, workerClass: "review", runId: "head-run" },
  queuedInput: AdmissionRequest = { ...request, runId: "queued-run", taskId: "W1-T10209" },
  overrides: Partial<AdmissionPorts> = {},
  defaultSink = false,
) {
  resetShadowMemoryStateForTests(); resetMemoryAdmissionStateForTests();
  const w = world();
  w.state.availableMib = 2500; w.running.entries = [{ id: "other-owner" }];
  const headAbort = new AbortController(), queuedAbort = new AbortController();
  const ticks: Array<{ ms: number; wake: () => void }> = [];
  const head = awaitMemoryAdmission({ ...headInput, signal: headAbort.signal }, ports(w, {
    sleep: () => new Promise<void>(() => undefined),
  }));
  const selected = ports(w, { ...overrides, sleep: ms => new Promise<void>(wake => {
    w.sleeps.push(ms); ticks.push({ ms, wake });
  }) });
  if (defaultSink) delete selected.write;
  const input = { ...queuedInput, signal: queuedAbort.signal };
  const queued = awaitMemoryAdmission(input, selected);
  return { w, head, queued, input, headAbort, queuedAbort,
    async tick() {
      const next = ticks.shift(); assert.ok(next, "the actual request must be sleeping");
      w.now.ms += next.ms; next.wake();
      await new Promise<void>(resolve => setImmediate(resolve));
    },
    async stop() {
      headAbort.abort(); queuedAbort.abort(); await Promise.all([head, queued]);
      ticks.length = 0;
      assert.deepEqual(waitingStarts(), []);
    },
  };
}

test("W1-T10209: a non-head memory waiter has attributable queue evidence before assignment", async () => {
  const f = observedQueue();
  try {
    const head = f.w.rows.find(row => row.step === ENFORCE_WAIT_STEP);
    assert.equal(head?.run_id, "head-run", "positive control: the evaluating head has measured refusal telemetry");
    assert.ok(Array.isArray(head?.reasons) && head.reasons.length > 0);
    const entry = f.w.rows.find(row => row.step === QUEUE_STEP);
    assert.ok(entry, "the non-head request must expose evidence before any wake or worker assignment");
    assert.equal(entry.run_id, "queued-run"); assert.equal(entry.task_id, "W1-T10209");
    assert.equal(entry.worker_class, "implement"); assert.equal(entry.identity_state, "supplied");
    assert.equal(entry.phase, "queued-behind-rank"); assert.equal(entry.queue_position, 2);
    assert.equal(entry.queue_size, 2); assert.equal(entry.ahead_worker_class, "review");
    assert.equal(entry.worker_assignment, "not-observed");
    assert.equal(entry.wait_start_ms, NOW); assert.equal(entry.sampled_at_ms, NOW);
    assert.match(String(entry.admission_id), /^[a-f0-9-]{36}$/);
    for (const name of ["reasons", "numbers", "tier", "pid", "pr", "head_sha"]) assert.equal(entry[name], undefined);
    assert.equal(f.w.running.entries.length, 1, "queued evidence reserves nothing");
    f.input.runId = "later-relay"; f.input.taskId = "later-task";
    await f.tick(); await f.tick();
    assert.equal(f.w.rows.filter(row => row.step === QUEUE_STEP).length, 1, "backoff ticks are not new phases");
    f.headAbort.abort(); await f.head; f.w.state.availableMib = 9000; await f.tick();
    assert.equal((await f.queued).kind, "admitted");
    const observations = f.w.rows.filter(row => row.step === QUEUE_STEP);
    assert.deepEqual(observations.map(row => row.phase), ["queued-behind-rank", "evaluating-head", "settled"]);
    assert.ok(observations.every(row => row.admission_id === entry.admission_id && row.run_id === "queued-run" && row.task_id === "W1-T10209"));
    assert.equal(observations.at(-1)?.queue_position, null, "a settled row cannot pretend the stale rank is current");
    assert.equal(observations.at(-1)?.timing_basis, "existing-admission-sample");
  } finally { await f.stop(); }
});

test("W1-T10209: queue observation changes no admission decision or ordering", async () => {
  for (const [headClass, nextClass, sinceMs] of [
    // 59 min of aging outranks a fresh review (score 3.95 against 3); at 60 min the starvation rung would admit it.
    ["review", "implement", NOW], ["implement", "review", NOW - 59 * 60_000],
  ] as const) {
    const f = observedQueue({ ...request, workerClass: headClass, runId: "ranked-head", sinceMs },
      { ...request, workerClass: nextClass, runId: "ranked-next" });
    try {
      assert.equal(waitingStarts()[0]?.workerClass, headClass);
      assert.equal(f.w.rows.find(row => row.step === QUEUE_STEP)?.ahead_worker_class, headClass);
      assert.equal(f.w.running.entries.length, 1);
      f.w.state.availableMib = 9000;
      await f.tick();
      assert.equal(f.w.running.entries.length, 1, "fitting memory alone cannot move a non-head ahead of its ranked owner");
      f.headAbort.abort(); assert.equal((await f.head).kind, "abandoned");
      await f.tick();
      assert.deepEqual(decision(await f.queued), { kind: "admitted", tier: "fits", waitedMs: 15_000, attempts: 2 });
      assert.equal(f.w.running.entries.length, 2, "only the existing head evaluation opens one reservation");
      assert.deepEqual(f.w.sleeps, [5_000, 10_000]);
    } finally { await f.stop(); }
  }
  for (const mode of ["shadow", "off", "enforce"] as const) {
    const w = world(); let roots = 0;
    const result = await awaitMemoryAdmission({ ...request, root: () => { roots++; throw Error("must not read root"); } }, ports(w, {
      policy: () => ({ ...POLICY, mode }), enforceHere: () => false,
      readLedger: () => { throw Error("must not read ledger"); },
    }));
    assert.deepEqual(result, { kind: "not-enforced", why: mode === "enforce" ? "not a daemon-owned process" : `mode ${mode}` });
    assert.equal(roots, 0); assert.deepEqual(w.rows, []); assert.deepEqual(w.sleeps, []); assert.deepEqual(waitingStarts(), []);
  }
  const instant = world();
  assert.deepEqual(decision(await awaitMemoryAdmission(request, ports(instant))), { kind: "admitted", tier: "fits", waitedMs: 0, attempts: 0 });
  assert.deepEqual(instant.rows, [], "a start that never queues remains silent");
});

test("W1-T10209: queue evidence is bounded and telemetry failure cannot admit or block work", async () => {
  const bounded = observedQueue();
  try {
    for (let i = 0; i < 128; i++) await bounded.tick();
    assert.equal(bounded.w.rows.filter(row => row.step === QUEUE_STEP).length, 1);
    assert.equal(bounded.w.running.entries.length, 1); assert.equal(waitingStarts().length, 2);
  } finally { await bounded.stop(); }
  assert.equal(bounded.w.rows.filter(row => row.step === QUEUE_STEP).length, 2, "one queue phase and one own settlement, never per tick");

  const root = fixtureRoot("queue-evidence-");
  const previous = defaultShadowMemoryPorts().write;
  installShadowMemorySink(appendLedger);
  try {
    const healthyRoot = join(root, "healthy");
    const healthy = observedQueue({ ...request, workerClass: "review" }, { ...request, root: healthyRoot }, {}, true);
    try {
      const rows = readFileSync(join(healthyRoot, "state", "ledger.ndjson"), "utf8").trim().split("\n").map(line => JSON.parse(line));
      assert.equal(rows.filter(row => row.step === QUEUE_STEP).length, 1, "the maintained default installed writer really appends on private disk");
      assert.equal(healthy.w.running.entries.length, 1);
    } finally { await healthy.stop(); }
    const brokenRoot = join(root, "broken");
    mkdirSync(join(brokenRoot, "state", "ledger.ndjson"), { recursive: true });
    for (const fallbackThrows of [false, true]) {
      const errors: string[] = [];
      const broken = observedQueue({ ...request, workerClass: "review" }, { ...request, root: brokenRoot }, {
        stderr: line => { errors.push(line); if (fallbackThrows) throw Error("diagnostic fallback failed"); },
      }, true);
      try {
        assert.ok(errors.some(line => /EISDIR/.test(line)), "real default writer failure, not an injected fake sink");
        assert.equal(waitingStarts().length, 2); assert.equal(broken.w.running.entries.length, 1);
        await broken.tick(); assert.equal(broken.w.running.entries.length, 1);
        broken.headAbort.abort(); await broken.head; broken.w.state.availableMib = 9000;
        await broken.tick(); assert.equal((await broken.queued).kind, "admitted");
        assert.equal(broken.w.running.entries.length, 2);
        assert.ok(!broken.w.rows.some(row => row.step === ENFORCE_ERROR_STEP), "telemetry cannot enter the admission error/fail-open path");
      } finally { await broken.stop(); }
    }
    const absent: string[] = [];
    const noSink = observedQueue(undefined, undefined, { write: undefined, stderr: line => void absent.push(line) });
    try { assert.equal(JSON.parse(absent[0] ?? "{}").step, QUEUE_STEP); }
    finally { await noSink.stop(); }
  } finally { installShadowMemorySink(previous); rmSync(root, { recursive: true, force: true }); }
});

test("W1-T10209: queue cancellation preserves other owners and clears only its own evidence", async () => {
  const f = observedQueue();
  const thirdAbort = new AbortController(), unknownAbort = new AbortController();
  const third = awaitMemoryAdmission({ ...f.input, signal: thirdAbort.signal }, ports(f.w, { sleep: () => new Promise<void>(() => undefined) }));
  const unknown = awaitMemoryAdmission({ workerClass: "implement", root: request.root, signal: unknownAbort.signal }, ports(f.w, { sleep: () => new Promise<void>(() => undefined) }));
  try {
    const before = waitingStarts(); assert.equal(before.length, 4);
    const entries = f.w.rows.filter(row => row.step === QUEUE_STEP);
    assert.equal(entries.length, 3); assert.equal(new Set(entries.map(row => row.admission_id)).size, 3, "same run/task are still distinct invocations");
    const own = entries[0]!, missing = entries[2]!;
    assert.equal(missing.identity_state, "unknown"); assert.equal(missing.run_id, "unknown"); assert.equal(missing.task_id, "unknown");
    assert.deepEqual(missing.missing_identity, ["run_id", "task_id"]);
    f.queuedAbort.abort(); assert.equal((await f.queued).kind, "abandoned");
    assert.deepEqual(waitingStarts(), [before[0], before[2], before[3]]);
    const terminal = f.w.rows.filter(row => row.step === QUEUE_STEP && row.phase === "settled");
    assert.equal(terminal.length, 1); assert.equal(terminal[0]?.admission_id, own.admission_id); assert.equal(terminal[0]?.cancelled, true);
    assert.equal(f.w.running.entries.length, 1, "another owner's reservation is untouched");
  } finally {
    thirdAbort.abort(); unknownAbort.abort(); await Promise.all([third, unknown]); await f.stop();
  }
});

test("W1-T10208: evaluating queue telemetry cancellation precedes strict reservation effects", async () => {
  for (const cancel of [false, true]) {
    const f = validationFixture(); await f.prime(); // Resets happen before either actor exists.
    const startedAt = f.w.now.ms;
    const other = { id: "other-owner", workerClass: "implement" as const, estimateMib: 900 };
    const otherBefore = { ...other };
    f.w.state.availableMib = 2500; f.w.running.entries = [other];
    const headAbort = new AbortController(), stop = new AbortController();
    const actors: Promise<unknown>[] = [];
    const headSleeps: Array<{ ms: number; wake: () => void }> = [];
    const ticks: Array<{ ms: number; wake: () => void }> = [];
    let result: memoryAdmission.ValidationAdmissionOutcome | undefined;
    let strictEvaluations = 0, evaluatingCalls = 0, strictSettled = false;
    let effectsAtEvaluation: { opens: number; marked: boolean } | undefined;
    const write = f.options.write!;
    try {
      const head = awaitMemoryAdmission({ ...request, workerClass: "review",
        runId: "telemetry-legacy-head", signal: headAbort.signal }, {
        ...f.options, sleep: ms => new Promise<void>(wake => { headSleeps.push({ ms, wake }); }),
      });
      actors.push(head);
      assert.deepEqual(headSleeps.map(tick => tick.ms), [5000]);
      const strict = f.run({
        sleep: ms => new Promise<void>(wake => { f.w.sleeps.push(ms); ticks.push({ ms, wake }); }),
        withLock: action => { strictEvaluations++; return f.options.withLock!(action); },
        write: (path, row) => {
          write(path, row);
          if (row.step === QUEUE_STEP && row.run_id === validationRequest.runId && row.phase === "evaluating-head") {
            evaluatingCalls++;
            effectsAtEvaluation = { opens: f.opens(), marked: f.marked() };
            if (cancel) stop.abort();
          }
        },
      }, stop.signal);
      actors.push(strict);
      void strict.then(() => { strictSettled = true; }, () => { strictSettled = true; });
      const queued = f.w.rows.find(row => row.step === QUEUE_STEP && row.run_id === validationRequest.runId && row.phase === "queued-behind-rank");
      assert.ok(queued, "the real strict invocation must first queue behind the review");
      assert.equal(queued.queue_position, 2); assert.equal(queued.queue_size, 2);
      assert.equal(queued.ahead_worker_class, "review"); assert.equal(queued.worker_class, "test");
      assert.equal(queued.sampled_at_ms, startedAt);
      assert.equal(strictEvaluations, 0); assert.equal(f.opens(), 0); assert.equal(f.marked(), false);
      assert.deepEqual(f.w.sleeps, [5000]); assert.equal(ticks.length, 1);
      assert.deepEqual(waitingStarts().map(waiter => waiter.workerClass), ["review", "test"]);

      headAbort.abort();
      for (const tick of headSleeps.splice(0)) tick.wake();
      assert.equal((await head).kind, "abandoned");
      f.w.state.availableMib = 9000;
      const tick = ticks.shift(); assert.ok(tick);
      f.w.now.ms += tick.ms; tick.wake();
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(strictSettled, true, "one promoted complete-fit evaluation must settle; do not hide another wait");
      assert.equal(ticks.length, 0);
      result = await strict;
      if (result.kind === "not-enforced") assert.fail("the existing enforce fixture must exercise strict admission");
      assert.equal(evaluatingCalls, 1);
      assert.deepEqual(effectsAtEvaluation, { opens: 0, marked: false });
      assert.equal(result.waitedMs, 5000); assert.equal(result.attempts, 1);
      if (cancel) {
        const refused = validationRefused(result, "abandoned", "admission-abandoned");
        assert.deepEqual(refused.details, ["admission-abandoned"]);
        assert.equal(refused.cleanup, "none");
        assert.deepEqual(refused.psiMark, { kind: "not-attempted" });
        assert.equal(strictEvaluations, 0, "an evaluating-sink abort must precede locked evaluation");
        assert.equal(f.opens(), 0, "the later post-publication abort check cannot substitute for zero publication");
        assert.equal(f.releases(), 0); assert.equal(f.marked(), false);
      } else {
        assert.equal(result.kind, "ready", JSON.stringify(result));
        if (result.kind !== "ready") assert.fail("healthy twin must prove the otherwise complete fit");
        assert.equal(result.tier, "fits"); assert.equal(result.basis, "legacy-compatible-tree-peaks");
        assert.equal(result.samples, 30); assert.equal(result.reservation.id, "fixture-grant-1");
        assert.equal(strictEvaluations, 1); assert.equal(f.opens(), 1);
        assert.equal(f.releases(), 0); assert.equal(f.marked(), true);
      }
      const own = f.w.rows.filter(row => row.step === QUEUE_STEP && row.run_id === validationRequest.runId);
      assert.deepEqual(own.map(row => row.phase), ["queued-behind-rank", "evaluating-head", "settled"]);
      assert.ok(own.every(row => row.admission_id === queued.admission_id && row.worker_assignment === "not-observed"));
      const settled = own.filter(row => row.phase === "settled");
      assert.equal(settled.length, 1); assert.equal(settled[0]?.cancelled, cancel);
      assert.deepEqual(other, otherBefore); assert.deepEqual(waitingStarts(), []);
      assert.ok(f.w.running.entries.includes(other), "the other owner's entry must remain present");
    } finally {
      headAbort.abort(); stop.abort();
      for (const tick of headSleeps.splice(0)) tick.wake();
      for (const tick of ticks.splice(0)) tick.wake();
      await Promise.allSettled(actors);
      // Only a returned own fixture handle needs test cleanup; refusal cleanup was asserted above.
      if (result?.kind === "ready") result.reservation.releaseOccupancy();
      assert.deepEqual(other, otherBefore); assert.deepEqual(waitingStarts(), []);
      assert.ok(f.w.running.entries.includes(other), "cleanup must retain the other owner's entry");
    }
    assert.equal(f.releases(), cancel ? 0 : 1);
  }
});

test("W1-T10208: settled queue telemetry cancellation refuses readiness without erasing recorded effects", async () => {
  for (const cancel of [false, true]) {
    const f = validationFixture(); await f.prime(); // Never reset shared state after starting a waiter.
    const startedAt = f.w.now.ms;
    const other = { id: "other-owner", workerClass: "implement" as const, estimateMib: 900 };
    const otherBefore = { ...other };
    f.w.state.availableMib = 2500; f.w.running.entries = [other];
    const headAbort = new AbortController(), stop = new AbortController();
    const actors: Promise<unknown>[] = [];
    const headSleeps: Array<{ ms: number; wake: () => void }> = [];
    const ticks: Array<{ ms: number; wake: () => void }> = [];
    let result: memoryAdmission.ValidationAdmissionOutcome | undefined;
    let strictEvaluations = 0, settledCalls = 0, strictSettled = false;
    let effectsAtSettlement: { opens: number; releases: number; marked: boolean; aborted: boolean } | undefined;
    const write = f.options.write!;
    try {
      const head = awaitMemoryAdmission({ ...request, workerClass: "review",
        runId: "telemetry-legacy-head", signal: headAbort.signal }, {
        ...f.options, sleep: ms => new Promise<void>(wake => { headSleeps.push({ ms, wake }); }),
      });
      actors.push(head);
      assert.deepEqual(headSleeps.map(tick => tick.ms), [5000]);
      const strict = f.run({
        sleep: ms => new Promise<void>(wake => { f.w.sleeps.push(ms); ticks.push({ ms, wake }); }),
        withLock: action => { strictEvaluations++; return f.options.withLock!(action); },
        write: (path, row) => {
          write(path, row);
          if (row.step === QUEUE_STEP && row.run_id === validationRequest.runId && row.phase === "settled") {
            settledCalls++;
            effectsAtSettlement = { opens: f.opens(), releases: f.releases(), marked: f.marked(), aborted: stop.signal.aborted };
            if (cancel) stop.abort();
          }
        },
      }, stop.signal);
      actors.push(strict);
      void strict.then(() => { strictSettled = true; }, () => { strictSettled = true; });
      const queued = f.w.rows.find(row => row.step === QUEUE_STEP && row.run_id === validationRequest.runId && row.phase === "queued-behind-rank");
      assert.ok(queued, "settlement must belong to a genuinely queued strict invocation");
      assert.equal(queued.queue_position, 2); assert.equal(queued.queue_size, 2);
      assert.equal(queued.ahead_worker_class, "review"); assert.equal(queued.worker_class, "test");
      assert.equal(queued.sampled_at_ms, startedAt);
      assert.equal(strictEvaluations, 0); assert.equal(f.opens(), 0); assert.equal(f.marked(), false);
      assert.deepEqual(f.w.sleeps, [5000]); assert.equal(ticks.length, 1);

      headAbort.abort();
      for (const tick of headSleeps.splice(0)) tick.wake();
      assert.equal((await head).kind, "abandoned");
      f.w.state.availableMib = 9000;
      const tick = ticks.shift(); assert.ok(tick);
      f.w.now.ms += tick.ms; tick.wake();
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(strictSettled, true, "one promoted complete-fit evaluation must finish before assertions");
      assert.equal(ticks.length, 0);
      result = await strict;
      if (result.kind === "not-enforced") assert.fail("the existing enforce fixture must exercise strict admission");
      assert.equal(strictEvaluations, 1); assert.equal(f.opens(), 1);
      assert.equal(settledCalls, 1, "finally must not invoke the settled sink a second time");
      assert.deepEqual(effectsAtSettlement, { opens: 1, releases: 0, marked: true, aborted: false });
      const stored = JSON.parse(f.files.get(join(request.root, "state", "container-pressure.json"))!);
      const expectedMark = { kind: "recorded", at: f.w.now.ms, sampleId: stored.validationObservation.sampleId };
      assert.deepEqual(result.psiMark, expectedMark);
      assert.equal(stored.psi.filter((row: number[]) => row[0] === f.w.now.ms && row[2] === 1).length, 1);
      assert.equal(result.waitedMs, 5000); assert.equal(result.attempts, 1);
      if (cancel) {
        const refused = validationRefused(result, "abandoned", "admission-abandoned");
        assert.deepEqual(refused.details, ["admission-abandoned"]);
        assert.equal(refused.cleanup, "release-requested");
        assert.equal(f.releases(), 1, "only the fresh unbound own fixture handle receives a release request");
      } else {
        assert.equal(result.kind, "ready", JSON.stringify(result));
        if (result.kind !== "ready") assert.fail("healthy twin must retain the otherwise identical measured fit");
        assert.equal(result.tier, "fits"); assert.equal(result.basis, "legacy-compatible-tree-peaks");
        assert.equal(result.samples, 30); assert.equal(result.reservation.id, "fixture-grant-1");
        assert.equal(f.releases(), 0);
      }
      assert.equal(stop.signal.aborted, cancel); assert.equal(f.marked(), true);
      const own = f.w.rows.filter(row => row.step === QUEUE_STEP && row.run_id === validationRequest.runId);
      assert.deepEqual(own.map(row => row.phase), ["queued-behind-rank", "evaluating-head", "settled"]);
      assert.ok(own.every(row => row.admission_id === queued.admission_id && row.worker_assignment === "not-observed"));
      const settled = own.filter(row => row.phase === "settled");
      assert.equal(settled.length, 1);
      assert.equal(settled[0]?.cancelled, false, "a row sampled before its own sink abort is not rewritten as later evidence");
      assert.deepEqual(other, otherBefore); assert.deepEqual(waitingStarts(), []);
      assert.ok(f.w.running.entries.includes(other), "the other owner's entry must remain present");
    } finally {
      headAbort.abort(); stop.abort();
      for (const tick of headSleeps.splice(0)) tick.wake();
      for (const tick of ticks.splice(0)) tick.wake();
      await Promise.allSettled(actors);
      if (result?.kind === "ready") result.reservation.releaseOccupancy();
      assert.deepEqual(other, otherBefore); assert.deepEqual(waitingStarts(), []);
      assert.ok(f.w.running.entries.includes(other), "cleanup must retain the other owner's entry");
    }
    assert.equal(f.releases(), 1, "healthy test cleanup and abort release-requested are distinct assertions above");
  }
});

test("W1-T10208: strict queued telemetry uses the real private default writer without changing fit or progress", async () => {
  assert.equal(gitWorkTreeAncestor(tmpdir()), undefined, "default append controls require a real temporary root outside Git");
  const root = fixtureRoot("strict-queue-default-writer-");
  const previous = defaultShadowMemoryPorts().write;
  installShadowMemorySink(appendLedger);
  try {
    for (const outcome of ["fits", "unavailable"] as const) for (const mode of ["healthy", "eisdir", "eisdir-throwing-stderr"] as const) {
      const ownRoot = join(root, outcome + "-" + mode), ledgerPath = join(ownRoot, "state", "ledger.ndjson");
      const f = validationFixture(ownRoot); await f.prime(); // Initialize and seed history before actors.
      const other = { id: "other-owner", workerClass: "implement" as const, estimateMib: 900 }, otherBefore = { ...other };
      f.w.running.entries = [other]; f.w.state.availableMib = 2500;
      if (mode !== "healthy") mkdirSync(ledgerPath, { recursive: true }); // The actual appender must hit EISDIR.
      const fixtureWrite = f.options.write!;
      delete f.options.write; // Omit the override entirely: defaultAdmissionPorts must choose the installed real sink.
      assert.equal("write" in f.options, false); assert.equal(defaultShadowMemoryPorts().write, appendLedger);
      const headAbort = new AbortController(), stop = new AbortController();
      const actors: Promise<unknown>[] = [];
      const headSleeps: Array<{ ms: number; wake: () => void }> = [], ticks: Array<{ ms: number; wake: () => void }> = [];
      const errors: string[] = [];
      const observed: { errorsBeforeLock?: string[] } = {};
      let lockAttempts = 0, strictSettled = false, strictRejected = false;
      let result: memoryAdmission.ValidationAdmissionOutcome | undefined;
      try {
        const head = awaitMemoryAdmission({ ...request, root: ownRoot, workerClass: "review",
          runId: "default-writer-head", signal: headAbort.signal }, { ...f.options, write: fixtureWrite,
          sleep: ms => new Promise<void>(wake => { headSleeps.push({ ms, wake }); }) });
        actors.push(head); assert.deepEqual(headSleeps.map(tick => tick.ms), [5000]);
        const strict = f.run({
          validationEstimate: workerClass => outcome === "unavailable"
            ? { kind: "unavailable", reason: "no-measured-samples" } : f.options.validationEstimate!(workerClass),
          sleep: ms => new Promise<void>(wake => { f.w.sleeps.push(ms); ticks.push({ ms, wake }); }),
          withLock: action => {
            lockAttempts++; observed.errorsBeforeLock = [...errors];
            return f.options.withLock!(action);
          },
          stderr: line => { errors.push(line); if (mode === "eisdir-throwing-stderr") throw Error("private diagnostic fallback failed"); },
        }, stop.signal);
        actors.push(strict); void strict.then(() => { strictSettled = true; }, () => { strictSettled = true; strictRejected = true; });
        assert.equal(strictSettled, false); assert.equal(lockAttempts, 0); assert.equal(f.opens(), 0); assert.equal(f.marked(), false);
        assert.deepEqual(waitingStarts().map(waiter => waiter.workerClass), ["review", "test"]);
        assert.deepEqual(f.w.sleeps, [5000]); assert.equal(ticks.length, 1);
        const queuedErrors = [...errors];
        if (mode === "healthy") {
          assert.deepEqual(queuedErrors, []);
          const rows: LedgerLine[] = readFileSync(ledgerPath, "utf8").trim().split("\n").map(line => JSON.parse(line));
          const own = rows.filter(row => row.step === QUEUE_STEP && row.run_id === validationRequest.runId);
          assert.equal(own.length, 1, "a real private append must exist before promotion");
          assert.equal(own[0]?.phase, "queued-behind-rank");
          assert.equal(own[0]?.queue_position, 2); assert.equal(own[0]?.queue_size, 2); assert.equal(own[0]?.ahead_worker_class, "review");
        } else {
          assert.equal(queuedErrors.length, 1, "the actual queued write must fail once while the invocation remains waiting");
          const error = JSON.parse(queuedErrors[0]!); assert.equal(error.event, QUEUE_STEP); assert.match(String(error.error), /EISDIR/);
        }

        headAbort.abort(); for (const tick of headSleeps.splice(0)) tick.wake();
        assert.equal((await head).kind, "abandoned");
        f.w.state.availableMib = 9000;
        const tick = ticks.shift(); assert.ok(tick); f.w.now.ms += tick.ms; tick.wake();
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.equal(strictSettled, true, "default telemetry failure cannot add another memory wait after the promoted evaluation");
        assert.equal(strictRejected, false, "the default writer or fallback must not reject strict admission");
        assert.equal(ticks.length, 0); result = await strict;
        if (result.kind === "not-enforced") assert.fail("the existing enforce fixture must exercise strict admission");
        assert.equal(result.waitedMs, 5000); assert.equal(result.attempts, 1); assert.equal(lockAttempts, 1);
        assert.equal(f.releases(), 0);
        if (outcome === "fits") {
          assert.equal(result.kind, "ready", JSON.stringify(result));
          if (result.kind !== "ready") assert.fail("telemetry failure must preserve the same positively measured fit");
          assert.equal(result.tier, "fits"); assert.equal(result.basis, "legacy-compatible-tree-peaks"); assert.equal(result.samples, 30);
          assert.equal(result.reservation.id, "fixture-grant-1"); assert.equal(f.opens(), 1); assert.equal(f.marked(), true);
          const stored = JSON.parse(f.files.get(join(ownRoot, "state", "container-pressure.json"))!);
          assert.deepEqual(result.psiMark, { kind: "recorded", at: f.w.now.ms, sampleId: stored.validationObservation.sampleId });
          assert.equal(stored.psi.filter((row: number[]) => row[0] === f.w.now.ms && row[2] === 1).length, 1);
        } else {
          const refused = validationRefused(result, "budget-unavailable", "no-measured-samples");
          assert.equal(refused.cleanup, "none"); assert.deepEqual(refused.psiMark, { kind: "not-attempted" });
          assert.equal(f.opens(), 0); assert.equal(f.marked(), false);
        }
        const errorsBeforeLock = observed.errorsBeforeLock;
        assert.ok(errorsBeforeLock, "the real locked evaluation must be observed");
        if (mode === "healthy") {
          assert.deepEqual(errorsBeforeLock, []); assert.deepEqual(errors, []);
          const rows: LedgerLine[] = readFileSync(ledgerPath, "utf8").trim().split("\n").map(line => JSON.parse(line));
          const own = rows.filter(row => row.step === QUEUE_STEP && row.run_id === validationRequest.runId);
          assert.deepEqual(own.map(row => row.phase), ["queued-behind-rank", "evaluating-head", "settled"]);
          assert.equal(typeof own[0]?.admission_id, "string");
          assert.ok(own.every(row => row.admission_id === own[0]?.admission_id && row.worker_assignment === "not-observed"));
          assert.equal(own.filter(row => row.phase === "settled").length, 1); assert.equal(own.at(-1)?.cancelled, false);
          assert.ok(!rows.some(row => row.step === ENFORCE_ERROR_STEP));
          if (outcome === "unavailable") {
            const refused = rows.find(row => row.step === "memory_budget.validation_not_started" && row.run_id === validationRequest.runId);
            assert.ok(refused, "the real default writer must also persist the strict refusal");
            assert.equal(refused.reason, "budget-unavailable"); assert.ok(Array.isArray(refused.details) && refused.details.includes("no-measured-samples"));
            assert.equal(refused.waitedMs, 5000);
          }
        } else {
          assert.equal(errorsBeforeLock.length, 2, "queued and evaluating writes fail before entering the locked action");
          const parsed = errors.map(line => JSON.parse(line));
          assert.deepEqual(parsed.map(error => error.event), outcome === "fits"
            ? [QUEUE_STEP, QUEUE_STEP, QUEUE_STEP]
            : [QUEUE_STEP, QUEUE_STEP, "memory_budget.validation_not_started", QUEUE_STEP]);
          assert.equal(parsed.filter(error => error.event === QUEUE_STEP).length, 3, "settlement is attempted once after either real outcome");
          for (const error of parsed) assert.match(String(error.error), /EISDIR/);
        }
        assert.ok(!f.w.rows.some(row => row.step === ENFORCE_ERROR_STEP));
        assert.deepEqual(other, otherBefore); assert.ok(f.w.running.entries.includes(other)); assert.deepEqual(waitingStarts(), []);
      } finally {
        headAbort.abort(); stop.abort();
        for (const tick of headSleeps.splice(0)) tick.wake(); for (const tick of ticks.splice(0)) tick.wake();
        await Promise.allSettled(actors);
        if (result?.kind === "ready") result.reservation.releaseOccupancy();
        assert.deepEqual(other, otherBefore); assert.ok(f.w.running.entries.includes(other)); assert.deepEqual(waitingStarts(), []);
      }
      assert.equal(f.releases(), outcome === "fits" ? 1 : 0, "only returned own-handle test cleanup occurs after the preceding outcome assertions");
    }
  } finally { installShadowMemorySink(previous); rmSync(root, { recursive: true, force: true }); }
});

test("W1-T10208: strict original refusals survive late settled telemetry abort and throw", async () => {
  const root = fixtureRoot("strict-settled-refusal-");
  try {
    for (const reason of ["budget-unavailable", "admission-error"] as const) {
      let baseline: Extract<memoryAdmission.ValidationAdmissionOutcome, { kind: "not-started" }> | undefined;
      for (const effect of ["healthy", "abort", "throw", "abort-and-throw"] as const) {
        const f = validationFixture(root); await f.prime(); // Never reset the queue after starting an actor.
        const other = { id: "other-owner", workerClass: "implement" as const, estimateMib: 900 }, otherBefore = { ...other };
        f.w.running.entries = [other]; f.w.state.availableMib = 2500;
        const headAbort = new AbortController(), stop = new AbortController();
        const actors: Promise<unknown>[] = [];
        const headSleeps: Array<{ ms: number; wake: () => void }> = [], ticks: Array<{ ms: number; wake: () => void }> = [];
        const errors: string[] = [];
        let strictSettled = false, strictRejected = false, lockAttempts = 0, settledCalls = 0;
        const settledEvidence: { decision?: LedgerLine } = {};
        let effectsAtSettlement: { opens: number; marked: boolean; aborted: boolean } | undefined;
        let result: memoryAdmission.ValidationAdmissionOutcome | undefined;
        const write = f.options.write!;
        try {
          const head = awaitMemoryAdmission({ ...request, root, workerClass: "review",
            runId: "refusal-legacy-head", signal: headAbort.signal }, { ...f.options,
            sleep: ms => new Promise<void>(wake => { headSleeps.push({ ms, wake }); }) });
          actors.push(head); assert.deepEqual(headSleeps.map(tick => tick.ms), [5000]);
          const strict = f.run({
            sleep: ms => new Promise<void>(wake => { f.w.sleeps.push(ms); ticks.push({ ms, wake }); }),
            validationEstimate: workerClass => reason === "budget-unavailable"
              ? { kind: "unavailable", reason: "no-measured-samples" } : f.options.validationEstimate!(workerClass),
            withLock: action => {
              lockAttempts++;
              return reason === "admission-error"
                ? memoryLedger.withMemoryAdmissionLock(action, { dir: join(root, "missing-lock-parent"), scope: "host" })
                : f.options.withLock!(action);
            },
            write: (path, row) => {
              write(path, row);
              if (row.step === QUEUE_STEP && row.run_id === validationRequest.runId && row.phase === "settled") {
                settledCalls++; settledEvidence.decision = f.w.rows.at(-2);
                effectsAtSettlement = { opens: f.opens(), marked: f.marked(), aborted: stop.signal.aborted };
                if (effect === "abort" || effect === "abort-and-throw") stop.abort();
                if (effect === "throw" || effect === "abort-and-throw") throw Error("late settled diagnostic fixture");
              }
            },
            stderr: line => {
              errors.push(line);
              if (effect === "throw" || effect === "abort-and-throw") throw Error("late settled stderr fixture");
            },
          }, stop.signal);
          actors.push(strict); void strict.then(() => { strictSettled = true; }, () => { strictSettled = true; strictRejected = true; });
          const queued = f.w.rows.find(row => row.step === QUEUE_STEP && row.run_id === validationRequest.runId && row.phase === "queued-behind-rank");
          assert.ok(queued); assert.equal(queued.queue_position, 2); assert.equal(queued.queue_size, 2); assert.equal(queued.ahead_worker_class, "review");
          assert.equal(strictSettled, false); assert.equal(lockAttempts, 0); assert.equal(f.opens(), 0); assert.equal(f.marked(), false);
          assert.deepEqual(f.w.sleeps, [5000]); assert.equal(ticks.length, 1);

          headAbort.abort(); for (const tick of headSleeps.splice(0)) tick.wake();
          assert.equal((await head).kind, "abandoned"); f.w.state.availableMib = 9000;
          const tick = ticks.shift(); assert.ok(tick); f.w.now.ms += tick.ms; tick.wake();
          await new Promise<void>(resolve => setImmediate(resolve));
          assert.equal(strictSettled, true, "a refusal must not become another wait or an unhandled diagnostic rejection");
          assert.equal(strictRejected, false, "late diagnostic failure must not reject the original typed refusal");
          assert.equal(ticks.length, 0); result = await strict;
          const refused = validationRefused(result, reason);
          assert.equal(refused.waitedMs, 5000); assert.equal(refused.attempts, 1);
          assert.equal(refused.cleanup, "none"); assert.deepEqual(refused.psiMark, { kind: "not-attempted" });
          if (reason === "budget-unavailable") assert.ok(refused.details.includes("no-measured-samples"));
          else assert.ok(refused.details.some(detail => detail.startsWith("admission-lock-unavailable:")),
            "the maintained private missing-directory lock must produce the original error, not an injected callback throw");
          assert.equal(lockAttempts, 1); assert.equal(f.opens(), 0); assert.equal(f.releases(), 0); assert.equal(f.marked(), false);
          assert.equal(settledCalls, 1); assert.deepEqual(effectsAtSettlement, { opens: 0, marked: false, aborted: false });
          const decisionBeforeSettlement = settledEvidence.decision;
          assert.ok(decisionBeforeSettlement, "an actual refusal row must already precede the settled sink");
          assert.equal(decisionBeforeSettlement.step, "memory_budget.validation_not_started");
          assert.equal(decisionBeforeSettlement.run_id, validationRequest.runId);
          assert.equal(decisionBeforeSettlement.kind, "not-started"); assert.equal(decisionBeforeSettlement.reason, reason);
          assert.deepEqual(decisionBeforeSettlement.details, refused.details);
          assert.equal(decisionBeforeSettlement.waitedMs, 5000); assert.equal(decisionBeforeSettlement.cleanup, "none");
          assert.deepEqual(decisionBeforeSettlement.psiMark, refused.psiMark);
          const own = f.w.rows.filter(row => row.step === QUEUE_STEP && row.run_id === validationRequest.runId);
          assert.deepEqual(own.map(row => row.phase), ["queued-behind-rank", "evaluating-head", "settled"]);
          assert.ok(own.every(row => row.admission_id === queued.admission_id && row.worker_assignment === "not-observed"));
          assert.equal(own.filter(row => row.phase === "settled").length, 1); assert.equal(own.at(-1)?.cancelled, false);
          assert.equal(stop.signal.aborted, effect === "abort" || effect === "abort-and-throw");
          if (effect === "throw" || effect === "abort-and-throw") {
            assert.equal(errors.length, 1);
            const diagnostic = JSON.parse(errors[0]!); assert.equal(diagnostic.event, QUEUE_STEP);
            assert.match(String(diagnostic.error), /late settled diagnostic fixture/);
          } else assert.deepEqual(errors, []);
          if (effect === "healthy") baseline = { ...refused, details: [...refused.details], psiMark: { ...refused.psiMark } };
          else { assert.ok(baseline, "a quiet original-refusal control must exist"); assert.deepEqual(refused, baseline); }
          assert.ok(!f.w.rows.some(row => row.step === ENFORCE_ERROR_STEP));
          assert.deepEqual(other, otherBefore); assert.ok(f.w.running.entries.includes(other)); assert.deepEqual(waitingStarts(), []);
        } finally {
          headAbort.abort(); stop.abort();
          for (const tick of headSleeps.splice(0)) tick.wake(); for (const tick of ticks.splice(0)) tick.wake();
          await Promise.allSettled(actors);
          if (result?.kind === "ready") result.reservation.releaseOccupancy();
          assert.deepEqual(other, otherBefore); assert.ok(f.w.running.entries.includes(other)); assert.deepEqual(waitingStarts(), []);
        }
      }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
