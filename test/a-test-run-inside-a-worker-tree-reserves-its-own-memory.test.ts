/**
 * A `node --test` runner inside a reserved tree gets its OWN "test" reservation, at the test class's learned estimate.
 *
 * OBSERVED 2026-10-10 in the core container: one worker's `node --test` tree held 7-8 file children at 300-570 MB, 2.8 GB,
 * inside an implement reservation whose learned p90 was 1367 MiB (median 296). The budget saw that spike only as part of
 * the implement class's tail; #10693 sized the run by headroom (src/lib/test-run.ts, test-file-admission.ts) but gave it no
 * reservation. Each case asserts what only the nested reservation produces: a "test" ledger entry while the run lives, a
 * "test" peak when it ends, and an enclosing tree's peak that leaves the runner's processes out.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { fixedClock } from "../src/lib/clock.js";
import { readMemoryLedger, type HostMemoryLedgerOptions, type ProcessListing } from "../src/lib/host-memory-ledger.js";
import {
  createTreePeakSampler,
  openLearnedReservation,
  resetLearnedEstimateCacheForTests,
  type NestedTestRun,
  type TreeSamplerPorts,
} from "../src/lib/host-memory-learning.js";

const NOW = Date.parse("2026-10-10T22:30:00.000Z");

interface Proc { parent: number; start: string; argv: string[]; hwmKb: number }

/** A fake /proc: a worker (10) running bash (11), which ran `npm test` (12, test-run.mjs) and its runner (13) with a
 *  file child (14). */
function procTable(): Map<number, Proc> {
  return new Map<number, Proc>([
    [10, { parent: 1, start: "proc:100", argv: ["claude", "-p"], hwmKb: 300 * 1024 }],
    [11, { parent: 10, start: "proc:110", argv: ["bash", "-c", "npm test"], hwmKb: 10 * 1024 }],
    [12, { parent: 11, start: "proc:120", argv: ["node", "--import", "tsx", "scripts/test-run.mjs", "--test", "x.test.ts"], hwmKb: 90 * 1024 }],
    [13, { parent: 12, start: "proc:130", argv: ["/usr/local/bin/node", "--test", "--test-concurrency=2", "x.test.ts"], hwmKb: 150 * 1024 }],
    [14, { parent: 13, start: "proc:140", argv: ["/usr/local/bin/node", "--import", "tsx", "x.test.ts"], hwmKb: 560 * 1024 }],
  ]);
}

function samplerPorts(procs: Map<number, Proc>, timers: Array<() => void>, cmdlineReads: number[]): Partial<TreeSamplerPorts> {
  const enoent = (path: string) => Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
  return {
    listProcesses: (): ProcessListing => ({ rows: [...procs].map(([pid, p]) => ({ pid, parent: p.parent, start: p.start })), complete: true }),
    readFile: (path) => {
      const pid = Number(/\/proc\/(\d+)\//.exec(path)?.[1]);
      const p = procs.get(pid);
      if (!p) throw enoent(path);
      if (path.endsWith("/stat")) return `${pid} (node) S ${p.parent} ${"0 ".repeat(17)}${p.start.replace("proc:", "")} 0 0`;
      if (path.endsWith("/cmdline")) {
        cmdlineReads.push(pid);
        return `${p.argv.join("\0")}\0`;
      }
      return `VmRSS:\t1 kB\nVmHWM:\t${p.hwmKb} kB\n`;
    },
    setTimer: (fn) => {
      timers.push(fn);
      return { unref: () => undefined };
    },
    clearTimer: () => undefined,
  };
}

test("a test runner inside a hooked tree becomes its own tracked run, and the enclosing tree's peak leaves it out", () => {
  const procs = procTable();
  const timers: Array<() => void> = [];
  const cmdlineReads: number[] = [];
  const sampler = createTreePeakSampler(samplerPorts(procs, timers, cmdlineReads));
  const found: number[] = [];
  const ended: Array<number | undefined> = [];
  sampler.track("worker", 10, {
    onTestRunner: (pid): NestedTestRun => {
      found.push(pid);
      return { finish: (peak) => void ended.push(peak) };
    },
  });
  assert.deepEqual(found, [12], "the outermost runner (npm test's test-run.mjs) is hooked once; its own runner child is inside it");
  assert.equal(sampler.size(), 2, "the worker and its test run are both tracked");
  timers[0]!();
  timers[0]!();
  assert.deepEqual(found, [12], "a runner already tracked is never hooked again");
  assert.equal(new Set(cmdlineReads).size, cmdlineReads.length, "each process's argv is read once");

  for (const pid of [12, 13, 14]) procs.delete(pid); // the test run exits
  timers[0]!();
  assert.deepEqual(ended, [(90 + 150 + 560) * 1024 / 1024], "the run ends with its own tree's peak: 800 MiB");
  assert.equal(sampler.size(), 1);
  assert.equal(sampler.finish("worker"), 300 + 10, "the worker's peak is its own 310 MiB, without the test run's 800");
});

test("a tree tracked without a hook, or a hook that opens nothing, keeps the runner inside its own measure", () => {
  const procs = procTable();
  const sampler = createTreePeakSampler(samplerPorts(procs, [], []));
  sampler.track("gate", 10);
  assert.equal(sampler.size(), 1);
  assert.equal(sampler.finish("gate"), 300 + 10 + 90 + 150 + 560);

  const declined: number[] = [];
  const again = createTreePeakSampler(samplerPorts(procTable(), [], []));
  again.track("w", 10, { onTestRunner: (pid) => void declined.push(pid) as undefined });
  again.sampleNow();
  assert.deepEqual(declined, [12], "a declined runner is asked about once");
  assert.equal(again.finish("w"), 300 + 10 + 90 + 150 + 560);

  const throwing = createTreePeakSampler(samplerPorts(procTable(), [], []));
  throwing.track("w", 10, { onTestRunner: () => { throw new Error("ledger unwritable"); } });
  assert.equal(throwing.finish("w"), 300 + 10 + 90 + 150 + 560, "a failing hook never breaks the sampler");
});

test("a failed release, an unreadable argv, an unreadable /proc and a crowded tree never break the sampler", () => {
  const procs = procTable();
  const timers: Array<() => void> = [];
  const ports = samplerPorts(procs, timers, []);
  let listingFails = false;
  const unreadableArgv = new Set<number>([11]);
  const sampler = createTreePeakSampler({
    ...ports,
    listProcesses: () => {
      if (listingFails) throw new Error("EACCES /proc");
      return ports.listProcesses!();
    },
    readFile: (path) => {
      if (path.endsWith("/cmdline") && unreadableArgv.has(Number(/\/proc\/(\d+)\//.exec(path)?.[1]))) throw new Error("EACCES");
      return ports.readFile!(path);
    },
  });
  sampler.track("w", 10, { onTestRunner: () => ({ finish: () => { throw new Error("ledger unwritable"); } }) });
  assert.equal(sampler.size(), 2, "an unreadable argv is no runner, and the real runner below it is still found");
  listingFails = true;
  timers[0]!();
  assert.equal(sampler.size(), 2, "a pass with no listing invents nothing and ends nothing");
  listingFails = false;
  for (const pid of [12, 13, 14]) procs.delete(pid);
  timers[0]!();
  assert.equal(sampler.size(), 1, "a run whose release throws is still ended");

  // More processes than the argv memo holds: it starts over rather than growing, and a runner is still found once.
  const crowd = new Map<number, Proc>([[10, procTable().get(10)!]]);
  for (let pid = 1000; pid < 1000 + 4_200; pid += 1) crowd.set(pid, { parent: 10, start: `proc:${pid}`, argv: ["git", "status"], hwmKb: 1 });
  crowd.set(9000, { parent: 10, start: "proc:9000", argv: ["node", "--test"], hwmKb: 1024 });
  const found: number[] = [];
  const big = createTreePeakSampler(samplerPorts(crowd, [], []));
  big.track("w", 10, { onTestRunner: (pid) => { found.push(pid); return undefined; } });
  assert.deepEqual(found, [9000]);
});

function reservationSpace(): HostMemoryLedgerOptions {
  const files = new Map<string, string>();
  const dir = `/ledger/${Math.random().toString(36).slice(2)}`;
  return {
    location: () => ({ dir, scope: "host" }),
    instance: () => ({ name: "state2", hostUnique: true }),
    generation: () => ({ containerId: "c1", initStart: "proc:1" }),
    probe: (pid) => (pid === 12 || pid === 10 || pid === 4242 ? { state: "alive", start: `proc:${pid * 10}` } : { state: "gone" }),
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
  };
}

test("a worker's test run is reserved under the test class at its learned estimate, and its peak teaches that class", () => {
  resetLearnedEstimateCacheForTests();
  const ledger = reservationSpace();
  const recorded: string[] = [];
  const at = new Date(NOW - 60_000).toISOString();
  const lines = [
    ...Array.from({ length: 12 }, () => `{"c":"test","p":2600,"at":"${at}"}\n`),
    ...Array.from({ length: 12 }, () => `{"c":"implement","p":300,"at":"${at}"}\n`),
  ].join("");
  const store = { list: () => ["state2.ndjson"], readTail: () => lines, append: (_p: string, line: string) => void recorded.push(line),
    size: () => 0, clock: fixedClock(NOW) };
  const procs = procTable();
  const timers: Array<() => void> = [];
  const sampler = createTreePeakSampler(samplerPorts(procs, timers, []));
  const worker = openLearnedReservation({ workerClass: "implement" }, { ledger, store, sampler });
  worker.bindRoot(10);

  const live = readMemoryLedger(ledger)!.entries;
  const run = live.find((e) => e.workerClass === "test");
  assert.ok(run, `a test reservation is open while the run lives: ${live.map((e) => e.workerClass).join(",")}`);
  assert.equal(run.estimateMib, 2600, "at the test class's LEARNED estimate");
  assert.deepEqual(run.estimateSource, { kind: "measured", samples: 12 });
  assert.equal(run.occupancyReleased, false);

  for (const pid of [12, 13, 14]) procs.delete(pid);
  timers[0]!();
  assert.match(recorded.join(""), /"c":"test","p":800/, "the run's own peak is learned under the test class");
  const after = readMemoryLedger(ledger)!.entries.find((e) => e.id === run.id);
  assert.ok(after === undefined || after.occupancyReleased === true, "the test reservation's occupancy ends with the run");

  worker.releaseOccupancy();
  assert.match(recorded.join(""), /"c":"implement","p":310/, "the worker's peak no longer includes the test run");
});

test("a test reservation does not nest another test reservation inside itself", () => {
  resetLearnedEstimateCacheForTests();
  const ledger = reservationSpace();
  const sampler = createTreePeakSampler(samplerPorts(procTable(), [], []));
  const recorded: string[] = [];
  const store = { list: () => [] as string[], append: (_p: string, line: string) => void recorded.push(line), size: () => 0 };
  const run = openLearnedReservation({ workerClass: "test" }, { ledger, store, sampler });
  run.bindRoot(10);
  assert.deepEqual(readMemoryLedger(ledger)!.entries.map((e) => e.workerClass), ["test"]);
  assert.equal(sampler.size(), 1, "only the test run's own tree is tracked; the runners inside it are part of it");
  run.releaseOccupancy();
  assert.match(recorded.join(""), /"c":"test","p":1110/, "the whole run, runners included, is one test peak");
});

test("a test run whose estimate store fails still opens, at the test class's prior", () => {
  resetLearnedEstimateCacheForTests();
  const ledger = reservationSpace();
  const logs: string[] = [];
  const brokenClock = {
    now: (): number => { throw new Error("clock"); },
    date: (): Date => { throw new Error("clock"); },
    iso: (): string => { throw new Error("clock"); },
  };
  const store = { list: () => [] as string[], append: () => undefined, size: () => 0, clock: brokenClock, log: (e: Record<string, unknown>) => void logs.push(String(e.op)) };
  const sampler = createTreePeakSampler(samplerPorts(procTable(), [], []));
  const worker = openLearnedReservation({ workerClass: "fix" }, { ledger, store, sampler });
  worker.bindRoot(10);
  const run = readMemoryLedger(ledger)!.entries.find((e) => e.workerClass === "test");
  assert.equal(run?.estimateMib, 2048, "the unmeasured prior, said so");
  assert.deepEqual(run?.estimateSource, { kind: "default-unmeasured" });
  assert.ok(logs.includes("estimate"), `the store failure is named: ${logs.join(",")}`);
  worker.releaseOccupancy();
});
