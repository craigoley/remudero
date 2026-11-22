/**
 * W1-T14153: every tsc run, warm or cold, asks the memory admission for its measured peak, and a worker tree's memory
 * peak leaves tsc out. OBSERVED 2026-11-21 on the fleet host: warm tsc runs inside fix trees held 1644-3789 MiB RSS each,
 * took no admission, and were learned into the fix class, so the fix estimate read 6492 MiB against a typical 960.
 * FIXTURES ONLY: every slot dir, buildinfo and process table here is this test's own; no real tsc starts.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fixedClock } from "#src/lib/clock.js";
import { typecheckStep } from "#src/lib/commit-message.js";
import type { HostMemoryLedgerOptions, ProcessListing } from "#src/lib/host-memory-ledger.js";
import {
  createTreePeakSampler, openLearnedReservation, readPeakSamples, recordPeak, resetLearnedEstimateCacheForTests,
  type NestedTestRun, type PeakStoreOptions,
} from "#src/lib/host-memory-learning.js";
import { acquireTestSlot, type TestSlotLease } from "#src/lib/test-slot.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import {
  installedTypescriptVersion, TYPECHECK_BUILDINFO_NAME, TYPECHECK_COLD_PEAK_BYTES, TYPECHECK_WARM_PEAK_BYTES, typecheckPeakBytes,
} from "#src/lib/typecheck-buildinfo.js";
import { NPM_TYPECHECK_SLOT_LABEL, runTypecheck } from "#src/lib/typecheck-run.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const GiB = 1024 ** 3;
const ROOMY = { memoryHeadroom: () => 64 * GiB };

/** A checkout with a plain `.git` dir, this repo's install linked in, and a usable buildinfo: its check runs warm. */
function warmTree(t: TestContext): { root: string; slots: string } {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t14153-warm-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, ".git"));
  symlinkSync(join(REPO_ROOT, "node_modules"), join(root, "node_modules"));
  writeFileSync(join(root, "tsconfig.json"), "{}\n");
  const version = installedTypescriptVersion(root);
  assert.ok(version, "the linked install names a typescript version");
  writeFileSync(join(root, ".git", TYPECHECK_BUILDINFO_NAME), JSON.stringify({ version, fileNames: ["a.ts"], fileInfos: ["hash"] }));
  const slots = join(root, "slots");
  mkdirSync(slots);
  const keys = ["RMD_TEST_SLOT_DIR", "RMD_TEST_SLOTS", "RMD_TEST_SLOT_PARENT"];
  const saved = keys.map((key) => process.env[key]);
  process.env.RMD_TEST_SLOT_DIR = slots;
  process.env.RMD_TEST_SLOTS = "2";
  delete process.env.RMD_TEST_SLOT_PARENT;
  t.after(() => keys.forEach((key, i) => { if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i]; }));
  return { root, slots };
}

const records = (dir: string): Array<{ label: string; memoryBytes?: number }> =>
  readdirSync(dir).filter((name) => name.endsWith(".json")).map((name) => JSON.parse(readFileSync(join(dir, name), "utf8")));

test("W1-T14153 criterion 1: a warm npm run typecheck asks the admission for the warm peak once, before tsc starts", (t) => {
  const fx = warmTree(t);
  const during: Array<Array<{ label: string; memoryBytes?: number }>> = [];
  const lines: string[] = [];
  const code = runTypecheck(fx.root, [], {
    spawn: () => { during.push(records(fx.slots)); return { status: 0 }; },
    testSlot: { ...ROOMY, dir: fx.slots, slots: 2, log: () => {} }, log: (line) => lines.push(line),
  });
  assert.equal(code, 0, lines.join("\n"));
  assert.equal(during.length, 1, "tsc started once");
  assert.deepEqual(during[0]?.map((r) => [r.label, r.memoryBytes]), [[NPM_TYPECHECK_SLOT_LABEL, TYPECHECK_WARM_PEAK_BYTES]],
    "the warm check held its own admission, at the warm peak, while tsc ran");
  const steps = lines.map((line) => JSON.parse(line) as { step: string; slot?: string });
  assert.deepEqual(steps.map((s) => s.step), ["typecheck.warm"], "a warm check says so, and never claims to be cold");
  assert.equal(steps[0]?.slot, "acquired");
  assert.equal(records(fx.slots).length, 0, "the admission was released after tsc ended");

  const order: string[] = [];
  const injected = runTypecheck(fx.root, [], {
    spawn: () => { order.push("spawn"); return { status: 0 }; }, log: () => {}, testSlot: ROOMY,
    acquireSlot: (label) => { order.push(`acquire:${label}`); return lease(true); },
  });
  assert.equal(injected, 0);
  assert.deepEqual(order, [`acquire:${NPM_TYPECHECK_SLOT_LABEL}`, "spawn"], "one admission, then tsc");
});

function lease(allowed: boolean): TestSlotLease {
  return { outcome: allowed ? "acquired" : "wait_bound_exceeded", executionAllowed: allowed, concurrency: 1, waitedMs: 0,
    note: allowed ? "fixture lease" : "NOT_RUN: fixture refusal", refresh: () => {}, release: () => {} };
}

test("W1-T14153 criterion 2: a warm npm run typecheck whose admission refuses never starts tsc and exits 75", (t) => {
  const fx = warmTree(t);
  let started = false;
  const lines: string[] = [];
  const code = runTypecheck(fx.root, [], {
    spawn: () => { started = true; return { status: 0 }; }, testSlot: ROOMY, log: (line) => lines.push(line),
    acquireSlot: () => lease(false),
  });
  assert.equal(code, 75);
  assert.equal(started, false, "tsc never started");
  assert.deepEqual(lines.map((line) => JSON.parse(line).step), ["typecheck.not_run"]);
});

test("W1-T14153 criterion 3: the warm peak is the measured one, equal to the cold peak", () => {
  assert.equal(TYPECHECK_WARM_PEAK_BYTES, TYPECHECK_COLD_PEAK_BYTES);
  assert.equal(typecheckPeakBytes(true), TYPECHECK_WARM_PEAK_BYTES);
  assert.equal(typecheckPeakBytes(false), TYPECHECK_COLD_PEAK_BYTES);
});

test("W1-T14153 criterion 4: the author preflight's warm typecheck is admitted through admitStaticWork at the warm peak", (t) => {
  const fx = warmTree(t);
  const during: Array<Array<{ label: string; memoryBytes?: number }>> = [];
  const spawn = () => { during.push(records(fx.slots)); return { status: 0, stdout: "", stderr: "" }; };
  const step = typecheckStep(fx.root, spawn, { ...ROOMY, dir: fx.slots, log: () => {} });
  assert.equal(step.ok, true, step.detail);
  assert.deepEqual(during[0]?.map((r) => [r.label, r.memoryBytes]), [["typecheck:preflight", TYPECHECK_WARM_PEAK_BYTES]],
    "the warm check held a static admission naming the warm peak while tsc ran");

  // A live peer leaves too little headroom, and private coordination refuses an unadmitted run at wait bound 0.
  const peer = acquireTestSlot("suite", { ...ROOMY, dir: fx.slots, slots: 2, memoryBytes: TYPECHECK_COLD_PEAK_BYTES, log: () => {} });
  t.after(() => peer.release());
  let spawned = false;
  const refused = typecheckStep(fx.root, () => { spawned = true; return { status: 0, stdout: "", stderr: "" }; }, {
    dir: fx.slots, slots: 2, waitBoundMs: 0, memoryHeadroom: () => TYPECHECK_WARM_PEAK_BYTES / 2,
    privateCoordinationRequired: true, log: () => {},
  });
  assert.match(refused.detail, /^typecheck: NOT_RUN/, refused.detail);
  assert.equal(refused.ok, false);
  assert.equal(spawned, false, "the spawn port was never called");
});

interface Proc { parent: number; start: number; argv: string[]; rss: number; hwm: number }

/** A fake /proc of `procs` (MiB), and an in-memory peak store. */
function sampled(procs: Map<number, Proc>) {
  const sampler = createTreePeakSampler({
    listProcesses: (): ProcessListing => ({ complete: true, rows: [...procs].map(([pid, p]) => ({ pid, parent: p.parent, start: `proc:${p.start}` })) }),
    readFile: (path) => {
      const pid = Number(path.split("/")[2]);
      const p = procs.get(pid);
      if (!p) throw Object.assign(new Error("exited"), { code: "ENOENT" });
      if (path.endsWith("/stat")) return `${pid} (worker) S ${p.parent} ${"0 ".repeat(17)}${p.start} 0 0`;
      if (path.endsWith("/cmdline")) return p.argv.join("\0") + "\0";
      return `${Number.isNaN(p.rss) ? "" : `VmRSS: ${p.rss * 1024} kB\n`}VmHWM: ${p.hwm * 1024} kB\n`;
    },
    setTimer: () => undefined,
    clearTimer: () => undefined,
  });
  let lines = "";
  const store: PeakStoreOptions = {
    location: () => ({ dir: "/fixture" }), instance: () => ({ name: "worker" }),
    clock: fixedClock(Date.parse("2026-11-21T13:00:00.000Z")), list: () => ["worker.ndjson"], readTail: () => lines,
    append: (_path, line) => { lines += line; }, size: () => 0, rewrite: (_path, content) => { lines = content; },
  };
  return { sampler, store, lines: () => lines };
}

/** The host memory reservation space openLearnedReservation writes to, held in memory. */
function reservationSpace(): HostMemoryLedgerOptions {
  const files = new Map<string, string>();
  return {
    location: () => ({ dir: "/fixture", scope: "host" }), instance: () => ({ name: "worker", hostUnique: true }),
    generation: () => ({ containerId: "fixture", initStart: "proc:1" }),
    probe: (pid) => ({ state: "alive", start: `proc:${pid}` }),
    listProcesses: () => ({ rows: [], complete: true }),
    write: (path, content) => { files.set(path, content); },
    read: (path) => {
      const content = files.get(path);
      if (content === undefined) throw Object.assign(new Error("absent"), { code: "ENOENT" });
      return content;
    },
    list: (dir) => [...files.keys()].filter((p) => p.startsWith(dir + "/")).map((p) => p.slice(dir.length + 1)),
    remove: (path) => { files.delete(path); }, createSentinel: (path, content) => { files.set(path, content); },
    clock: fixedClock(Date.parse("2026-11-21T13:00:00.000Z")), ownerPid: 4242, log: () => undefined,
  };
}

/** The descendant bound reads no real /proc and stops nothing: these pids are fixtures. */
const INERT_BOUND = { readStart: () => undefined, kill: () => {}, write: () => {} };

const fixTree = (): Map<number, Proc> => new Map<number, Proc>([
  [10, { parent: 1, start: 10, argv: ["node", "worker.js"], rss: 500, hwm: 500 }],
  [11, { parent: 10, start: 11, argv: ["/opt/bin/claude", "-p"], rss: 200, hwm: 200 }],
  [12, { parent: 11, start: 12, argv: ["/repo/node_modules/@typescript/typescript-linux-x64/lib/tsc", "-p", "tsconfig.json"], rss: 3500, hwm: 3500 }],
]);

test("W1-T14153 criterion 7: a fix tree's peak leaves its tsc member out on both bases, and its sample carries tsc_p", () => {
  for (const missingRss of [false, true]) {
    resetLearnedEstimateCacheForTests();
    const procs = fixTree();
    if (missingRss) for (const p of procs.values()) p.rss = NaN;
    const fx = sampled(procs);
    const reservation = openLearnedReservation({ workerClass: "fix" }, {
      ledger: reservationSpace(), store: fx.store, sampler: fx.sampler, descendantBound: INERT_BOUND,
    });
    reservation.bindRoot(10);
    fx.sampler.sampleNow();
    reservation.releaseOccupancy();
    const [sample, ...rest] = readPeakSamples("fix", fx.store);
    assert.equal(rest.length, 0);
    assert.equal(sample?.peakMib, 700, `node 500 + claude 200, tsc left out (rss ${missingRss ? "unreadable" : "read"})`);
    assert.equal(sample?.measurementBasis, missingRss ? "legacy-hwm" : "concurrent-rss");
    if (!missingRss) assert.equal(sample?.legacyPeakMib, 700, "the legacy basis leaves tsc out too");
    assert.equal(sample?.tscPeakMib, 3500);
    assert.match(fx.lines(), /"tsc_p":3500/);
  }
  resetLearnedEstimateCacheForTests();
});

test("W1-T14153 criterion 8: a tsc member left out of the peak is still handed to the tree's onMember hook", () => {
  const fx = sampled(fixTree());
  const seen: Array<[number, number]> = [];
  fx.sampler.track("fix", 10, { onMember: (pid, _start, rssKb) => void seen.push([pid, rssKb / 1024]) });
  const measured = fx.sampler.finishMeasurement!("fix");
  assert.equal(measured.peakMib, 700);
  const once = [...new Map(seen.map(([pid, mib]) => [pid, mib])).entries()].sort((a, b) => a[0] - b[0]);
  assert.deepEqual(once, [[10, 500], [11, 200], [12, 3500]], "the descendant bound still sees tsc, at its own RSS");
});

test("W1-T14153 criterion 9: a test run inside a fix tree keeps its own reservation, and a tsc below its runner counts in neither peak", () => {
  const procs = new Map<number, Proc>([
    [10, { parent: 1, start: 10, argv: ["claude", "-p"], rss: 300, hwm: 300 }],
    [11, { parent: 10, start: 11, argv: ["bash", "-c", "npm test"], rss: 10, hwm: 10 }],
    [12, { parent: 11, start: 12, argv: ["/usr/local/bin/node", "--test", "x.test.ts"], rss: 150, hwm: 150 }],
    [13, { parent: 12, start: 13, argv: ["/usr/local/bin/node", "--import", "tsx", "x.test.ts"], rss: 560, hwm: 560 }],
    [14, { parent: 13, start: 14, argv: ["/repo/node_modules/@typescript/typescript-linux-x64/lib/tsc", "--noEmit"], rss: 2000, hwm: 2000 }],
  ]);
  const fx = sampled(procs);
  const runs: number[] = [];
  const ended: Array<{ peak?: number; legacy?: number; tsc?: number }> = [];
  fx.sampler.track("fix", 10, {
    onTestRunner: (pid): NestedTestRun => {
      runs.push(pid);
      return { finish: (peak, legacy, _age, _cli, tsc) => void ended.push({ peak, legacy, tsc }) };
    },
  });
  assert.deepEqual(runs, [12], "the runner opened its nested test reservation");
  for (const pid of [12, 13, 14]) procs.delete(pid);
  fx.sampler.sampleNow();
  assert.deepEqual(ended, [{ peak: 150 + 560, legacy: 150 + 560, tsc: 2000 }], "the run's peak holds its runner and file, not tsc");
  const fix = fx.sampler.finishMeasurement!("fix");
  assert.equal(fix.peakMib, 300 + 10, "the fix peak leaves out the whole run, tsc included");
  assert.equal(fix.tscPeakMib, undefined, "the run's tsc is not charged to the fix tree either");
});

test("W1-T14153 criterion 10: parseSamples reads tsc_p back, and compaction keeps it", () => {
  resetLearnedEstimateCacheForTests();
  const fx = sampled(new Map());
  assert.equal(recordPeak("fix", 700, { ...fx.store, measurementBasis: "concurrent-rss", tscPeakMib: 3500 }), true);
  assert.deepEqual(readPeakSamples("fix", fx.store).map((s) => s.tscPeakMib), [3500]);
  assert.equal(recordPeak("fix", 650, { ...fx.store, measurementBasis: "concurrent-rss", size: () => 2 ** 21 }), true);
  assert.match(fx.lines(), /"tsc_p":3500/, "the compacted store kept the earlier row's tsc_p");
  assert.deepEqual(readPeakSamples("fix", fx.store).map((s) => s.tscPeakMib), [3500, undefined]);
  resetLearnedEstimateCacheForTests();
});
