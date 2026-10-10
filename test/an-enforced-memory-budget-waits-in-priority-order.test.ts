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
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import { childGardenPassSpawn } from "../src/lib/garden-registry.js";
import { resetShadowMemoryStateForTests, type HostMemoryBudgetPolicy } from "../src/lib/host-memory-shadow.js";
import type { LedgerLine } from "../src/lib/ledger.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { createClaudeExecutableCache, spawnWorker, type SpawnWorkerArgs } from "../src/lib/worker.js";
import { gitWorkTreeAncestor } from "../src/lib/worker-home.js";

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
  assert.deepEqual(outcome, { kind: "admitted", tier: "fits", waitedMs: 0, attempts: 0 });
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
  assert.deepEqual(outcome, { kind: "admitted", tier: "fits", waitedMs: 35_000, attempts: 3 });
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
  assert.deepEqual(outcome, { kind: "admitted", tier: "nothing-to-wait-for", waitedMs: 0, attempts: 0 });
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
  assert.deepEqual(outcome, { kind: "admitted", tier: "uncertain", waitedMs: 5_000, attempts: 1 });
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
        return {
          id: "g1", workerClass: "garden", estimateMib: 900, estimateSource: { kind: "measured", samples: 4 },
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
