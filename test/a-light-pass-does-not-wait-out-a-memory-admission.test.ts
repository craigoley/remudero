/**
 * W1-T9780 — a light pass does not wait out a memory admission.
 *
 * The in-flight ticker awaits the light pass, and the light pass awaits every per-PR action. On
 * 2026-10-16 one pass held the ticker 06:12:54 → 06:57:11Z: its #12267 fix rung asked the progress
 * judge, whose advisory worker waited 42 min in the enforced memory admission. These tests drive a
 * real `awaitMemoryAdmission` held at a measured shortfall, behind the production progress judge.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { awaitMemoryAdmission, resetMemoryAdmissionStateForTests, type AdmissionPorts } from "../src/lib/host-memory-admission.js";
import type { HostMemoryReading, ReadingEntry } from "../src/lib/host-memory-ledger.js";
import { resetShadowMemoryStateForTests, type HostMemoryBudgetPolicy } from "../src/lib/host-memory-shadow.js";
import { readLedgerLines } from "../src/lib/status.js";
import * as sweep from "../src/lib/sweep.js";
import {
  detachedSweepActionCount, drainDetachedSweepActions, productionFixProgressJudge, runSweepLightPass,
  type FixDispatchEvidence, type OpenPrView, type SweepDeps,
} from "../src/lib/sweep.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import type { SpawnWorkerArgs, WorkerResult } from "../src/lib/worker.js";

const NOW = Date.now();
const MIB = 1024 * 1024;
const POLICY: HostMemoryBudgetPolicy = {
  mode: "enforce", hostReserveMib: 2048, containerReserveMib: 1024, swapInPagesPerSecMax: 256, psiSomeAvg10Max: 10,
  psiFullAvg10Max: 2, serveColdStartReserveMib: 7680, uncertaintyMarginMib: 256, daemonGrowthUnmeasuredMib: 1024,
  daemonGrowthMinSamples: 6, staleReadingMs: 600_000,
};

/** A host the test moves: 2.5 GiB available beside one busy reservation is a shortfall; 9 GiB fits. */
function admissionPorts(host: { availableMib: number }): Partial<AdmissionPorts> {
  const files: Record<string, string> = {
    "/proc/vmstat": "pswpin 100\n",
    "/proc/pressure/memory": "some avg10=0.00 avg60=0.00 avg300=0.00 total=1\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=1\n",
    "/sys/fs/cgroup/memory.current": `${2000 * MIB}\n`,
    "/sys/fs/cgroup/memory.max": `${12_000 * MIB}\n`,
    "/sys/fs/cgroup/memory.swap.current": "0\n",
    "/sys/fs/cgroup/memory.stat": "anon 1\nfile 1\n",
    "/sys/fs/cgroup/memory.events": "low 0\nhigh 0\nmax 0\noom 0\noom_kill 0\n",
    "/proc/777/status": "VmHWM:\t 1048576 kB\nVmRSS:\t 1048576 kB\n",
  };
  const busy: ReadingEntry = {
    id: "busy", owner: "state2@c1", workerClass: "implement", estimateMib: 1024,
    estimateSource: { kind: "measured", samples: 30 }, status: "owned", ageMs: 1000, sinceVerifiedMs: 1000,
    walkComplete: true, path: "/ledger/busy.json",
  };
  const entries: ReadingEntry[] = [busy];
  const reading = (): HostMemoryReading => ({
    state: "present", scope: "host", dir: "/ledger", entries,
    counts: { live: entries.length, uncertain: 0, incompleteWalk: 0, localScope: 0, unreadable: 0 },
    reservedMib: entries.reduce((sum, e) => sum + e.estimateMib, 0),
  });
  return {
    readFile: (path) => {
      if (path === "/proc/meminfo") return `MemAvailable: ${host.availableMib * 1024} kB\n`;
      const text = files[path];
      if (text === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
      return text;
    },
    readTail: () => `${JSON.stringify({ ts: new Date(NOW - 3_600_000).toISOString(), step: "x" })}\n`,
    readLedger: reading,
    policy: () => POLICY,
    write: () => undefined,
    writeFile: () => undefined,
    stderr: () => undefined,
    instance: () => "state2",
    daemonPid: () => 777,
    listStateDir: () => [],
    estimate: () => 900,
    readReviewDemand: () => ({ state: "present", rows: [], unreadableRows: 0 }),
    enforceHere: () => true,
    withLock: (action) => action(),
    openReservation: (input) => {
      const id = `grant-${entries.length}`;
      entries.push({ ...busy, id, workerClass: input.workerClass, estimateMib: 900, path: `/ledger/${id}.json` });
      return { id, published: true, workerClass: input.workerClass, estimateMib: 900,
        estimateSource: { kind: "measured", samples: 30 }, bindRoot: () => undefined, releaseOccupancy: () => undefined };
    },
    random: () => 0.5,
  };
}

function ownRed(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 12267, prUrl: "https://github.com/o/r/pull/12267", taskId: "W1-T8879",
    headSha: "own-red-head", checksState: "red", reviewState: "pending", unmetCriteria: [],
    priorStrikes: 1, autoMergeArmed: false, lastActivityAt: new Date(NOW).toISOString(),
    redRequiredChecks: ["ci"], ciFailures: [{ name: "ci", logTail: "assertion failed in this diff" }],
    ...over,
  };
}

function reviewPr(): OpenPrView {
  return {
    prNumber: 12271, prUrl: "https://github.com/o/r/pull/12271", taskId: "W1-T9753",
    headSha: "review-head", checksState: "green", reviewState: "none", unmetCriteria: [],
    priorStrikes: 0, autoMergeArmed: false, lastActivityAt: new Date(NOW - 60_000).toISOString(),
  };
}

/** The production progress judge, its worker spawn replaced by the admission spawnWorker makes first. */
function fixture(t: TestContext) {
  resetShadowMemoryStateForTests();
  resetMemoryAdmissionStateForTests();
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t9780-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = { availableMib: 2500 };
  const judgeSpawns: SpawnWorkerArgs[] = [];
  const dispatched: FixDispatchEvidence[] = [];
  const spawn = async (args: SpawnWorkerArgs): Promise<WorkerResult> => {
    judgeSpawns.push(args);
    // spawnWorker's own call: the caller's `memoryShadow` ports override the defaults.
    const signal = args.memoryShadow?.sleep;
    await awaitMemoryAdmission({ workerClass: "advisory", root: dir }, {
      ...admissionPorts(host), ...args.memoryShadow,
      sleep: async () => { await signal?.(0); await delay(5); },
    });
    return { text: 'FIX_PROGRESS: {"verdict":"continue","reason":"first round"}' } as never;
  };
  const deps: SweepDeps = {
    ledgerPath: join(dir, "ledger.ndjson"), runId: "SWEEP-T9780", now: () => NOW,
    arm: () => { assert.fail("nothing here arms"); },
    close: () => { assert.fail("nothing here closes"); },
    escalate: () => { assert.fail("a continuing fix cannot escalate"); },
    actionable: (d) => d === "blocked-fixable" || d === "post-review",
    dispatchFix: (_pr, evidence) => { dispatched.push(evidence); },
    claimFixAdmission: () => ({ admitted: true }),
    readActiveWorkerCount: () => 0,
    readFixPressure: () => ({ availableMib: 8192, floorMib: 1024 }),
    fixProgressJudge: productionFixProgressJudge({ cwd: ".", settingsFile: "settings/worker.json",
      mount: { model: "test-model", effort: "low", maxTurns: 1, contextBudget: 10000 }, spawn }),
  };
  const disposed = (prNumber: number) =>
    readLedgerLines(deps.ledgerPath).filter((row) => row.step === "sweep.disposed" && row.pr_number === prNumber);
  return { deps, host, judgeSpawns, dispatched, disposed };
}

/** Whether `pass` settles while the admission is still held; never waits it out. */
async function returnsWhileHeld(pass: Promise<unknown>): Promise<boolean> {
  return Promise.race([pass.then(() => true), delay(2_000).then(() => false)]);
}

test("W1-T9780: a light pass returns while its admitted review waits for memory", async (t) => {
  const f = fixture(t);
  let releaseReview!: () => void;
  const reviewHeld = new Promise<void>((resolve) => { releaseReview = resolve; });
  f.deps.postReview = () => reviewHeld;
  const pass = runSweepLightPass([reviewPr(), ownRed()], f.deps);
  try {
    assert.equal(await returnsWhileHeld(pass), true, "the pass returns while both actions wait for memory");
    assert.equal(f.judgeSpawns.length, 1, "the fix rung's judge was admitted and is waiting");
    assert.equal(f.dispatched.length, 0, "no round is dispatched before its judgment");
    assert.equal(f.disposed(12271)[0]?.acted, true, "the review's admission is recorded inside the pass");
    assert.equal(f.disposed(12267).length, 0, "the waiting fix rung has not disposed yet");
    assert.equal(detachedSweepActionCount(), 1, "the waiting fix rung is a detached sweep action");
    let drained = false;
    const drain = drainDetachedSweepActions().then(() => { drained = true; });
    await delay(50);
    assert.equal(drained, false, "a drain waits for the detached action");
    f.host.availableMib = 9000;
    await drain;
    assert.equal(f.dispatched.length, 1, "once admitted, the judged round dispatches");
    assert.equal(f.disposed(12267).at(-1)?.acted, true);
  } finally {
    f.host.availableMib = 9000;
    releaseReview();
    await pass;
    await drainDetachedSweepActions();
  }
});

test("W1-T9780: a later pass does not re-admit a head whose action is still waiting", async (t) => {
  const f = fixture(t);
  const first = runSweepLightPass([ownRed()], f.deps);
  try {
    assert.equal(await returnsWhileHeld(first), true);
    assert.equal(await returnsWhileHeld(runSweepLightPass([ownRed()], f.deps)), true);
    assert.equal(f.judgeSpawns.length, 1, "the later pass never asks a second judge for the waiting head");
    const later = f.disposed(12267);
    assert.equal(later.length, 1, "only the later pass has disposed it");
    assert.equal(later[0]!.disposition, "wait");
    assert.equal(later[0]!.acted, false);
    assert.match(String(later[0]!.reason), /light-pass action .* waiting for memory admission/);
    assert.equal(later[0]!.in_flight_action, "light-pass-action");
    // A new head is a different action and is admitted.
    assert.equal(await returnsWhileHeld(runSweepLightPass([ownRed({ headSha: "pushed-since" })], f.deps)), true);
    assert.equal(f.judgeSpawns.length, 2, "a moved head is judged on its own");
    f.host.availableMib = 9000;
    await drainDetachedSweepActions();
    assert.equal(detachedSweepActionCount(), 0);
    await runSweepLightPass([ownRed()], f.deps);
    assert.doesNotMatch(String(f.disposed(12267).at(-1)?.reason), /waiting for memory admission/,
      "the hold ends when the detached action settles");
  } finally {
    f.host.availableMib = 9000;
    await first;
    await drainDetachedSweepActions();
  }
});

test("W1-T9780: outside a light pass the memory-wait port only sleeps", async () => {
  const started = Date.now();
  // A namespace read, so the base this file proves against still loads and fails here, not at import.
  await sweep.lightPassMemoryWaitPorts().sleep(5);
  assert.ok(Date.now() - started >= 4, "the port still waits out the admission's back-off");
});
