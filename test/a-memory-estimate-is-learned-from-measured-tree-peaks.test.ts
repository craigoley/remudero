/**
 * A reservation claims what its class has MEASURED, not a fixed default. Before this, every reservation used
 * DEFAULT_ESTIMATE_MIB because nothing passed a measured estimate (2026-10-10 core census: 368 of 368 verdicts), and
 * 283 of 368 starts were "unclassified" because no lane named its class. Each case drives a state only the learning code
 * produces: an estimate, a stored sample, a recorded peak, or the class a lane's worker reserves under.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { benchmarkNonDispatchSpawn } from "../src/lib/benchmark-run.js";
import { fixedClock } from "../src/lib/clock.js";
import {
  DEFAULT_ESTIMATE_MIB,
  readMemoryLedger,
  type HostMemoryLedgerOptions,
  type ProcessListing,
} from "../src/lib/host-memory-ledger.js";
import {
  ESTIMATE_LEARNING,
  TREE_SAMPLE_MS,
  classEstimate,
  compactSamples,
  createTreePeakSampler,
  daemonOwnedProcess,
  learnEstimate,
  openLearnedReservation,
  readFileTail,
  readPeakSamples,
  recordPeak,
  resetLearnedEstimateCacheForTests,
  treeMembers,
  withSyncChildReservation,
  workerClassOfLane,
  type PeakSample,
  type TreePeakSampler,
} from "../src/lib/host-memory-learning.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import type { SpawnWorkerArgs, WorkerResult } from "../src/lib/worker.js";

const NOW = Date.parse("2026-10-10T20:00:00.000Z");
const HOUR = 60 * 60_000;

function scratch(): string {
  return mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}mem-learning-`));
}

test("with no measured peaks a class estimate IS its default prior, and says so", () => {
  assert.deepEqual(learnEstimate([], 2048, NOW), { estimateMib: 2048, samples: 0 });
  assert.deepEqual(learnEstimate([{ peakMib: Number.NaN, at: NOW }, { peakMib: 0, at: NOW }], 2048, NOW), { estimateMib: 2048, samples: 0 },
    "an unusable sample is no sample, never a zero peak");
});

test("fresh measured peaks outweigh the prior: the estimate moves to the class's own high quantile", () => {
  // Twenty implement trees measured 2026-10-10: 0.4-0.84 GB steady, a few cold tsc runs near 2.8 GB.
  const steady = Array.from({ length: 18 }, (_, i) => ({ peakMib: 400 + i * 25, at: NOW - i * 60_000 }));
  const learned = learnEstimate(steady, DEFAULT_ESTIMATE_MIB.implement, NOW);
  assert.equal(learned.samples, 18);
  assert.ok(learned.estimateMib < DEFAULT_ESTIMATE_MIB.implement, `steady trees pull the claim below the 2048 prior: ${learned.estimateMib}`);
  assert.ok(learned.estimateMib >= 800, `the claim stays at the high quantile of what was measured: ${learned.estimateMib}`);
  const spiky = learnEstimate([...steady, { peakMib: 2800, at: NOW }, { peakMib: 2750, at: NOW }, { peakMib: 2900, at: NOW }], 2048, NOW);
  assert.ok(spiky.estimateMib >= 2048, `a class whose trees really spike claims the spike: ${spiky.estimateMib}`);
});

test("old peaks decay, so a class that stops being measured drifts back to its prior", () => {
  const low = Array.from({ length: 12 }, () => ({ peakMib: 300 }));
  const fresh = learnEstimate(low.map((s) => ({ ...s, at: NOW })), 1024, NOW);
  const stale = learnEstimate(low.map((s) => ({ ...s, at: NOW - 10 * ESTIMATE_LEARNING.halfLifeMs })), 1024, NOW);
  assert.equal(fresh.estimateMib, 300);
  assert.equal(stale.estimateMib, 1024, "ten half-lives later the never-decaying prior outweighs them");
  assert.equal(stale.samples, 12, "the samples are still counted: the estimate is measured, only re-weighted");
});

test("peaks are stored per instance, read back across instances, and compacted to the newest per class", () => {
  const dir = scratch();
  try {
    resetLearnedEstimateCacheForTests();
    const location = () => ({ dir });
    const core = { location, root: "/home/node/Remudero", instance: () => ({ name: "state2" }), clock: fixedClock(NOW) };
    const site = { ...core, instance: () => ({ name: "rmd-site-state" }) };
    assert.equal(recordPeak("review", 900, core), true);
    assert.equal(recordPeak("review", 1100, site), true);
    assert.equal(recordPeak("garden", 0, core), false, "a zero peak is never recorded");
    assert.deepEqual(readdirSync(join(dir, "estimates")).sort(), ["rmd-site-state.ndjson", "state2.ndjson"]);
    assert.deepEqual(readPeakSamples("review", core).map((s) => s.peakMib).sort(), [1100, 900]);
    assert.deepEqual(readPeakSamples("garden", core), []);
    const estimate = classEstimate("review", core);
    assert.equal(estimate.samples, 2, "both instances' peaks reach the estimate");

    // Compaction keeps the newest samples of every class and drops nothing else.
    const many: PeakSample[] = [
      ...Array.from({ length: 5 }, (_, i) => ({ workerClass: "review" as const, peakMib: 100 + i, at: NOW + i })),
      { workerClass: "garden", peakMib: 999, at: NOW },
    ];
    assert.deepEqual(compactSamples(many, 2).map((s) => s.peakMib), [103, 104, 999]);
    let rewritten = "";
    recordPeak("fix", 700, { ...core, size: () => 2 * 1024 * 1024, rewrite: (_path, content) => void (rewritten = content) });
    assert.match(rewritten, /"c":"fix","p":700/, "an oversized store is rewritten from its tail");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unreadable or absent store reads as no samples, and the estimate is the prior", () => {
  resetLearnedEstimateCacheForTests();
  const logs: Array<Record<string, unknown>> = [];
  const broken = { location: () => ({ dir: "/nowhere" }), clock: fixedClock(NOW), log: (e: Record<string, unknown>) => void logs.push(e),
    list: () => { throw Object.assign(new Error("EACCES"), { code: "EACCES" }); } };
  assert.deepEqual(readPeakSamples("fix", broken), []);
  assert.deepEqual(classEstimate("fix", broken), { estimateMib: DEFAULT_ESTIMATE_MIB.fix, samples: 0 });
  assert.equal(logs[0]?.op, "list", "the failure is named once, never silent");
  assert.deepEqual(readPeakSamples("fix", { location: () => ({ dir: "/nowhere-at-all" }) }), [], "a missing store is empty");
  const torn = { location: () => ({ dir: "/x" }), list: () => ["a.ndjson", "b.ndjson"],
    readTail: (path: string) => {
      if (path.endsWith("b.ndjson")) throw new Error("EIO");
      return '{"c":"fix","p":512,"at":"2026-10-10T19:00:00.000Z"}\n{torn\n{"c":"nope","p":1,"at":"x"}\n';
    } };
  assert.deepEqual(readPeakSamples("fix", torn).map((s) => s.peakMib), [512], "a torn line or an unreadable file loses only itself");
});

function listing(rows: Array<[number, number, string]>): ProcessListing {
  return { rows: rows.map(([pid, parent, start]) => ({ pid, parent, start })), complete: true };
}

function statLine(pid: number, start: string): string {
  return `${pid} (node) S 1 ${"0 ".repeat(17)}${start.replace("proc:", "")} 0 0`;
}

test("a tree's peak is the largest sum of its live members' VmHWM, and an unobserved tree records nothing", () => {
  const hwm = new Map<number, number>([[10, 300_000], [11, 900_000], [12, 1_200_000]]);
  let rows: Array<[number, number, string]> = [[10, 1, "proc:5"], [11, 10, "proc:6"]];
  const timers: Array<() => void> = [];
  let cleared = 0;
  const sampler = createTreePeakSampler({
    listProcesses: () => listing(rows),
    readFile: (path) => {
      const pid = Number(/\/proc\/(\d+)\//.exec(path)?.[1]);
      if (path.endsWith("/stat")) return statLine(pid, rows.find(([p]) => p === pid)?.[2] ?? "proc:0");
      const kb = hwm.get(pid);
      if (kb === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return `VmRSS:\t1 kB\nVmHWM:\t${kb} kB\n`;
    },
    setTimer: (fn, ms) => {
      assert.equal(ms, TREE_SAMPLE_MS);
      timers.push(fn);
      return { unref: () => undefined };
    },
    clearTimer: () => void (cleared += 1),
  });
  sampler.track("r1", 10);
  assert.equal(timers.length, 1, "one timer while a tree is tracked");
  rows = [...rows, [12, 11, "proc:7"]]; // a cold tsc joins the tree
  timers[0]!();
  rows = [[10, 1, "proc:5"]]; // and exits
  const peak = sampler.finish("r1");
  assert.equal(peak, (300_000 + 900_000 + 1_200_000) / 1024, "the tsc's peak was seen while it lived");
  assert.equal(cleared, 1, "the timer stops once nothing is tracked");
  assert.equal(sampler.size(), 0);

  sampler.track("gone", 99); // never existed: unreadable stat
  assert.equal(sampler.finish("gone"), undefined, "a tree never observed records nothing, never zero");
  assert.deepEqual(treeMembers([{ pid: 10, start: "proc:999" }], listing([[10, 1, "proc:5"]])), [], "a reused pid is not the root");
});

function reservationSpace(): { deps: HostMemoryLedgerOptions; dir: string } {
  const files = new Map<string, string>();
  const dir = `/ledger/${Math.random().toString(36).slice(2)}`;
  return {
    dir,
    deps: {
      location: () => ({ dir, scope: "host" }),
      instance: () => ({ name: "state2", hostUnique: true }),
      generation: () => ({ containerId: "c1", initStart: "proc:1" }),
      probe: () => ({ state: "alive", start: "proc:10" }),
      listProcesses: () => ({ rows: [], complete: true }),
      write: (path, content) => void files.set(path, content),
      read: (path) => {
        const content = files.get(path);
        if (content === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
        return content;
      },
      list: (d) => [...files.keys()].filter((k) => k.startsWith(`${d}/`)).map((k) => k.slice(d.length + 1)),
      remove: (path) => void files.delete(path),
      createSentinel: (path, content) => void files.set(path, content),
      clock: fixedClock(NOW),
      log: () => undefined,
      ownerPid: 4242,
    },
  };
}

function fakeSampler(peak: number | undefined): TreePeakSampler & { tracked: Array<[string, number]> } {
  const tracked: Array<[string, number]> = [];
  return { tracked, track: (id, pid) => void tracked.push([id, pid]), finish: () => peak, sampleNow: () => undefined, size: () => 0 };
}

test("a learned reservation records the class's measured estimate, and its tree's peak when the work ends", () => {
  resetLearnedEstimateCacheForTests();
  const ledger = reservationSpace();
  const recorded: string[] = [];
  const peaks = Array.from({ length: 10 }, () => `{"c":"garden","p":900,"at":"${new Date(NOW - HOUR).toISOString()}"}\n`).join("");
  const store = { list: () => ["state2.ndjson"], readTail: () => peaks, append: (_p: string, line: string) => void recorded.push(line),
    size: () => 0, clock: fixedClock(NOW) };
  const sampler = fakeSampler(1234.5);
  const reservation = openLearnedReservation({ workerClass: "garden", root: "/home/node/Remudero" }, { ledger: ledger.deps, store, sampler });
  assert.equal(reservation.estimateMib, 900, "ten measured 900 MiB gardens outweigh the 1024 MiB prior");
  assert.deepEqual(reservation.estimateSource, { kind: "measured", samples: 10 });
  const entry = readMemoryLedger(ledger.deps)!.entries[0]!;
  assert.equal(entry.estimateMib, 900);
  assert.deepEqual(entry.estimateSource, { kind: "measured", samples: 10 }, "the ledger entry says measured, so no margin is added for it");
  reservation.bindRoot(5151);
  assert.deepEqual(sampler.tracked.map(([, pid]) => pid), [5151], "the bound root is sampled");
  reservation.releaseOccupancy();
  reservation.releaseOccupancy();
  assert.equal(recorded.length, 1, "one peak per tree, even if released twice");
  assert.match(recorded[0]!, /"c":"garden","p":1235/);

  resetLearnedEstimateCacheForTests();
  const unmeasured = openLearnedReservation({ workerClass: "check-proof" }, { ledger: reservationSpace().deps, store: { list: () => [] }, sampler: fakeSampler(undefined) });
  assert.equal(unmeasured.estimateMib, DEFAULT_ESTIMATE_MIB["check-proof"]);
  assert.deepEqual(unmeasured.estimateSource, { kind: "default-unmeasured" });
});

test("a synchronous reservation holds for exactly the work, binds itself when asked, and releases on a throw", () => {
  resetLearnedEstimateCacheForTests();
  const ledger = reservationSpace();
  const sampler = fakeSampler(310);
  const recorded: string[] = [];
  const deps = { ledger: ledger.deps, sampler, enabled: () => true, bindSelf: true,
    store: { list: () => [], append: (_p: string, line: string) => void recorded.push(line), size: () => 0 } };
  const during = withSyncChildReservation("check-proof", () => readMemoryLedger(ledger.deps)!.entries.length, deps);
  assert.equal(during, 1, "the reservation is in the ledger while the work runs");
  assert.deepEqual(sampler.tracked.map(([, pid]) => pid), [process.pid], "a verb reserving for itself binds its own pid");
  assert.match(recorded[0] ?? "", /"c":"check-proof","p":310/, "its peak is learned");
  assert.throws(() => withSyncChildReservation("push-gate", () => { throw new Error("gate died"); }, { ...deps, bindSelf: false }), /gate died/);
  assert.equal(withSyncChildReservation("push-gate", () => 7, { enabled: () => false }), 7, "outside the daemon nothing is reserved");
  assert.equal(daemonOwnedProcess({ REMUDERO_DAEMON_PROCESS: "1" }), true);
  assert.equal(daemonOwnedProcess({ REMUDERO_DAEMON_PROCESS: "1", NODE_TEST_CONTEXT: "child" }), false, "a test is never the daemon");
  assert.equal(daemonOwnedProcess({}), false);
});

test("every non-dispatch lane's worker reserves under the class its lane names", async () => {
  assert.equal(workerClassOfLane("review"), "review");
  assert.equal(workerClassOfLane("sweep-fix"), "fix");
  assert.equal(workerClassOfLane("aa-prospective"), "implement");
  assert.equal(workerClassOfLane("risk-judge"), "advisory");
  assert.equal(workerClassOfLane("inbox-draft"), "advisory");
  assert.equal(workerClassOfLane("a-lane-nobody-named"), "unclassified", "an unknown lane is never guessed");

  const seen: Array<SpawnWorkerArgs["workerClass"]> = [];
  const raw = async (args: SpawnWorkerArgs): Promise<WorkerResult> => {
    seen.push(args.workerClass);
    return { isError: false, text: "ok" } as WorkerResult;
  };
  // No config: under the test runner the receipt sink is absent, so only the class is observed.
  const base = { cwd: "/w", permissionMode: "default", settingsFile: "/s.json", prompt: "p" } as unknown as SpawnWorkerArgs;
  await benchmarkNonDispatchSpawn("risk-judge", raw)(base);
  await benchmarkNonDispatchSpawn("sweep-fix", raw)(base);
  await benchmarkNonDispatchSpawn("risk-judge", raw)({ ...base, workerClass: "review" });
  assert.deepEqual(seen, ["advisory", "fix", "review"], "the lane names the class; a caller's own class still wins");
});

test("readFileTail reads the last bytes of a real file from a whole line", () => {
  const dir = scratch();
  try {
    resetLearnedEstimateCacheForTests();
    const store = { location: () => ({ dir }), root: "/r", instance: () => ({ name: "one" }), clock: fixedClock(NOW) };
    for (let i = 0; i < 40; i += 1) recordPeak("advisory", 500 + i, store);
    const path = join(dir, "estimates", "one.ndjson");
    assert.equal(readFileSync(path, "utf8").split("\n").filter(Boolean).length, 40);
    const tail = readFileTail(path, 200);
    assert.ok(tail.startsWith('{"c":"advisory"'), "a partial first line is dropped");
    assert.ok(tail.trimEnd().endsWith('"}'), "the newest sample is kept");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the real sampler measures a live process from /proc where /proc exists, and records nothing where it does not", () => {
  const sampler = createTreePeakSampler();
  sampler.track("self", process.pid);
  const peak = sampler.finish("self");
  if (process.platform === "linux") assert.ok(peak !== undefined && peak > 0, `this test process's own VmHWM: ${peak}`);
  else assert.equal(peak, undefined, "no /proc: never a zero peak");
  assert.equal(sampler.size(), 0);
});

test("an oversized store compacts in place through the real atomic rewrite, and a class estimate is reused within its cache window", () => {
  const dir = scratch();
  try {
    resetLearnedEstimateCacheForTests();
    const store = { location: () => ({ dir }), root: "/r", instance: () => ({ name: "one" }), clock: fixedClock(NOW) };
    for (let i = 0; i < 3; i += 1) recordPeak("review", 600 + i, store);
    recordPeak("review", 700, { ...store, size: () => 2 * 1024 * 1024 });
    assert.equal(readPeakSamples("review", store).length, 4, "compaction keeps every sample under the per-class bound");
    const first = classEstimate("review", store);
    assert.equal(classEstimate("review", store), first, "within the cache window the same estimate object is reused");
    recordPeak("review", 5000, { ...store, append: () => undefined });
    assert.notEqual(classEstimate("review", store), first, "a recorded peak invalidates the cached estimate");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a learned reservation never throws: an unreadable clock, a failing tracker or a failing peak read leave the default", () => {
  resetLearnedEstimateCacheForTests();
  const logs: Array<Record<string, unknown>> = [];
  const store = { list: () => [], clock: { now: () => { throw new Error("clock gone"); }, date: () => new Date(0), iso: () => "" },
    log: (e: Record<string, unknown>) => void logs.push(e) };
  const throwing: TreePeakSampler = { track: () => { throw new Error("track"); }, finish: () => { throw new Error("finish"); },
    sampleNow: () => undefined, size: () => 0 };
  const reservation = openLearnedReservation({ workerClass: "fix" }, { ledger: reservationSpace().deps, store, sampler: throwing });
  assert.equal(reservation.estimateMib, DEFAULT_ESTIMATE_MIB.fix);
  reservation.bindRoot(1234);
  reservation.releaseOccupancy();
  assert.deepEqual(logs.map((e) => e.op), ["estimate", "track", "finish"]);
});

test("a sampler skips an unreadable listing or member, and a failing store or logger never reaches the caller", () => {
  let listingFails = true;
  const sampler = createTreePeakSampler({
    listProcesses: () => {
      if (listingFails) throw new Error("EACCES /proc");
      return listing([[20, 1, "proc:3"], [21, 20, "proc:4"]]);
    },
    readFile: (path) => {
      if (path === "/proc/20/stat") return statLine(20, "proc:3");
      if (path === "/proc/20/status") return "VmHWM:\t 2048 kB\n";
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); // pid 21 exited between listing and read
    },
    setTimer: () => undefined,
    clearTimer: () => undefined,
  });
  sampler.track("t", 20);
  listingFails = false;
  assert.equal(sampler.finish("t"), 2, "the unreadable pass and the vanished member add nothing; the readable root counts");

  resetLearnedEstimateCacheForTests();
  assert.equal(recordPeak("fix", 800, { location: () => ({ dir: "/x" }), append: () => { throw new Error("ENOSPC"); },
    log: () => { throw new Error("logger down"); } }), false, "a full disk loses one sample, and a broken logger is swallowed");
});
