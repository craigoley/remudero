import assert from "node:assert/strict";
import { test } from "node:test";
import { fixedClock } from "#src/lib/clock.js";
import {
  classEstimate, createTreePeakSampler, openLearnedReservation, recordPeak, readPeakSamples,
  resetLearnedEstimateCacheForTests, type PeakStoreOptions,
} from "#src/lib/host-memory-learning.js";
import type { HostMemoryLedgerOptions } from "#src/lib/host-memory-ledger.js";

interface Proc { parent: number; start: number; argv: string[]; rss: number; hwm: number }

function fixture(procs: Map<number, Proc>) {
  const reads = new Map<number, number>();
  const sampler = createTreePeakSampler({
    listProcesses: () => ({ complete: true, rows: [...procs].map(([pid, p]) => ({ pid, parent: p.parent, start: `proc:${p.start}` })) }),
    readFile: (path) => {
      const pid = Number(path.split("/")[2]);
      const p = procs.get(pid);
      if (!p) throw Object.assign(new Error("exited"), { code: "ENOENT" });
      if (path.endsWith("/stat")) return `${pid} (worker) S ${p.parent} ${"0 ".repeat(17)}${p.start} 0 0`;
      if (path.endsWith("/cmdline")) {
        reads.set(pid, (reads.get(pid) ?? 0) + 1);
        return p.argv.join("\0") + "\0";
      }
      return `VmRSS: ${p.rss * 1024} kB\nVmHWM: ${p.hwm * 1024} kB\n`;
    },
    setTimer: () => undefined,
    clearTimer: () => undefined,
  });
  let lines = "";
  const store: PeakStoreOptions = {
    location: () => ({ dir: "/fixture" }), instance: () => ({ name: "worker" }),
    clock: fixedClock(Date.now()), list: () => ["worker.ndjson"], readTail: () => lines,
    append: (_path, line) => { lines += line; }, size: () => 0,
    rewrite: (_path, content) => { lines = content; },
  };
  return { sampler, store, reads };
}

test("W1-T9646: a worker tree peak records the peak of its agent CLI process beside the tree total", () => {
  const procs = new Map<number, Proc>([
    [10, { parent: 1, start: 10, argv: ["node", "worker.js"], rss: 50, hwm: 80 }],
    [11, { parent: 10, start: 11, argv: ["/opt/bin/claude", "-p"], rss: 100, hwm: 300 }],
    [12, { parent: 11, start: 12, argv: ["node", "tsc", "claude"], rss: 400, hwm: 600 }],
    [13, { parent: 11, start: 13, argv: ["claude", "-p"], rss: 20, hwm: 40 }],
    [14, { parent: 10, start: 14, argv: ["", "claude"], rss: 30, hwm: 700 }],
  ]);
  const { sampler, store, reads } = fixture(procs);
  sampler.track("worker", 10, { onTestRunner: () => undefined });
  procs.get(11)!.hwm = 350;
  sampler.sampleNow();
  procs.delete(11);
  procs.delete(12);
  procs.delete(13);
  const measured = sampler.finishMeasurement!("worker");
  assert.equal(measured.peakMib, 600);
  assert.equal(measured.legacyPeakMib, 1770);
  assert.equal(recordPeak("implement", measured.peakMib!, { ...store, ...measured }), true);
  const [sample] = readPeakSamples("implement", store);
  assert.equal(sample?.cliPeakMib, 390);
  assert.deepEqual([...reads.values()], [1, 1, 1, 1, 1]);
  recordPeak("implement", 570, { ...store, ...measured, size: () => 2 ** 21 });
  assert.deepEqual(readPeakSamples("implement", store).map(s => s.cliPeakMib), [390, 390]);
});

test("W1-T9646: a tree with no CLI member records no CLI peak, never zero", () => {
  const procs = new Map<number, Proc>([
    [10, { parent: 1, start: 10, argv: ["node", "claude"], rss: 50, hwm: 80 }],
    [11, { parent: 10, start: 11, argv: ["claude-helper"], rss: 100, hwm: 300 }],
    [12, { parent: 10, start: 12, argv: ["", "claude"], rss: 20, hwm: 90 }],
  ]);
  const { sampler, store } = fixture(procs);
  sampler.track("worker", 10);
  const measured = sampler.finishMeasurement!("worker");
  assert.equal(Object.hasOwn(measured, "cliPeakMib"), false);
  assert.equal(recordPeak("implement", measured.peakMib!, { ...store, ...measured }), true);
  assert.equal(Object.hasOwn(readPeakSamples("implement", store)[0]!, "cliPeakMib"), false);
});

test("W1-T9646: the class estimate still learns from the tree total", () => {
  resetLearnedEstimateCacheForTests();
  const { store } = fixture(new Map());
  try {
    for (let i = 0; i < 30; i++) {
      assert.equal(recordPeak("implement", 900, { ...store, cliPeakMib: 100 }), true);
    }
    assert.equal(readPeakSamples("implement", store)[0]?.cliPeakMib, 100);
    assert.deepEqual(classEstimate("implement", store), { estimateMib: 900, samples: 30 });
  } finally { resetLearnedEstimateCacheForTests(); }
});

test("CLI classification follows process identity when a pid is reused", () => {
  const procs = new Map<number, Proc>([
    [10, { parent: 1, start: 10, argv: ["node"], rss: 50, hwm: 80 }],
    [11, { parent: 10, start: 11, argv: ["bash"], rss: 10, hwm: 10 }],
  ]);
  const { sampler, reads } = fixture(procs);
  sampler.track("worker", 10);
  procs.set(11, { parent: 10, start: 22, argv: ["/bin/claude"], rss: 100, hwm: 200 });
  sampler.sampleNow();
  assert.equal(sampler.finishMeasurement!("worker").cliPeakMib, 200);
  assert.equal(reads.get(11), 2);
});

test("reservation release persists CLI peaks in their owning tree, including legacy fallback", () => {
  for (const missingRss of [false, true]) {
    resetLearnedEstimateCacheForTests();
    const files = new Map<string, string>();
    const ledger: HostMemoryLedgerOptions = {
      location: () => ({ dir: "/fixture", scope: "host" }), instance: () => ({ name: "worker", hostUnique: true }),
      generation: () => ({ containerId: "fixture", initStart: "proc:1" }),
      probe: pid => ({ state: "alive", start: `proc:${pid}` }),
      listProcesses: () => ({ rows: [], complete: true }),
      write: (path, content) => { files.set(path, content); },
      read: path => {
        const content = files.get(path);
        if (content === undefined) throw Object.assign(new Error("absent"), { code: "ENOENT" });
        return content;
      },
      list: dir => [...files.keys()].filter(p => p.startsWith(dir + "/")).map(p => p.slice(dir.length + 1)),
      remove: path => { files.delete(path); }, createSentinel: (path, content) => { files.set(path, content); },
      clock: fixedClock(Date.now()), ownerPid: 4242, log: () => undefined,
    };
    const procs = new Map<number, Proc>([
      [10, { parent: 1, start: 10, argv: ["claude"], rss: 100, hwm: 300 }],
      [11, { parent: 10, start: 11, argv: ["node", "--test"], rss: 50, hwm: 80 }],
      [12, { parent: 11, start: 12, argv: ["claude"], rss: 20, hwm: 40 }],
    ]);
    const { sampler, store } = fixture(procs);
    if (missingRss) for (const p of procs.values()) p.rss = NaN;
    const reservation = openLearnedReservation({ workerClass: "implement" }, { ledger, store, sampler });
    reservation.bindRoot(10);
    procs.delete(11);
    procs.delete(12);
    sampler.sampleNow();
    reservation.releaseOccupancy();
    reservation.releaseOccupancy();
    assert.equal(sampler.size(), 0);
    const worker = readPeakSamples("implement", store);
    assert.equal(worker.length, 1);
    assert.equal(worker[0]?.cliPeakMib, 300);
    assert.equal(worker[0]?.peakMib, missingRss ? 300 : 100);
    assert.equal(worker[0]?.measurementBasis, missingRss ? "legacy-hwm" : "concurrent-rss");
    const [nested] = readPeakSamples("test", store);
    assert.equal(nested?.cliPeakMib, 40);
    assert.equal(nested?.peakMib, missingRss ? 120 : 70);
  }
  resetLearnedEstimateCacheForTests();
});
