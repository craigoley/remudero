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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
} from "../src/lib/host-memory-admission.js";
import type { HostMemoryReading, ReadingEntry } from "../src/lib/host-memory-ledger.js";
import * as memoryLedger from "../src/lib/host-memory-ledger.js";
import { childGardenPassSpawn } from "../src/lib/garden-registry.js";
import { resetShadowMemoryStateForTests, type HostMemoryBudgetPolicy } from "../src/lib/host-memory-shadow.js";
import type { LedgerLine } from "../src/lib/ledger.js";
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
