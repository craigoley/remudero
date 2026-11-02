import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { fixedClock } from "#src/lib/clock.js";
import {
  createTreePeakSampler, openLearnedReservation, readPeakSamples, recordPeak, recordTestFilePeak, testFileEstimates,
  type PeakStoreOptions,
} from "#src/lib/host-memory-learning.js";
import { runBoundedTest, selectedTestFiles } from "#src/lib/test-run.js";
import { acquireTestSlot, memoryTestConcurrency, type TestSlotHolder } from "#src/lib/test-slot.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

const MiB = 1024 ** 2;
const NOW = Date.now();

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}file-peaks-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store: PeakStoreOptions = { location: () => ({ dir }), instance: () => ({ name: "fixture" }), clock: fixedClock(NOW) };
  const slot = { dir: join(dir, "slots"), slots: 1, load: () => ({ cores: 16, load1: 0 }),
    memoryHeadroom: () => 1100 * MiB, log: () => {} };
  const holder = () => JSON.parse(readFileSync(join(slot.dir, "slot-1.json"), "utf8")) as TestSlotHolder;
  return { dir, store, slot, holder };
}

test("W1-T9102: a learned heavy file sizes its slot above the old constant", async (t) => {
  const fx = fixture(t);
  recordTestFilePeak("/checkout-a/test/heavy.test.ts", 737, fx.store);
  for (let i = 0; i < 12; i++) recordTestFilePeak("test/light.test.ts", 300, fx.store);
  const files = testFileEstimates(["test/heavy.test.ts", "test/light.test.ts"], fx.store);
  assert.deepEqual(files.map((f) => f.bytes), [737 * MiB, 300 * MiB]);
  const slot = acquireTestSlot("heavy", { ...fx.slot, filePeaks: files });
  t.after(() => slot.release());
  assert.equal(slot.concurrency, 2, "1100 MiB holds 737 + 300, rather than two heavy-file estimates");
  assert.equal(fx.holder().memoryBytes, 1037 * MiB);
  assert.deepEqual(fx.holder().filePeaks, files);
  assert.match(slot.note, /file-p90/);
  slot.release();

  await runBoundedTest(["--test", "test/heavy.test.ts"], {
    peakStore: fx.store, testSlot: fx.slot, binaryExists: () => false, log: () => {},
    spawn: async (_file, argv) => {
      assert.equal(fx.holder().memoryBytes, 737 * MiB, "the default wrapper reserves the learned file peak");
      assert.ok(argv.includes("--test-concurrency=1"));
      return 0;
    },
  });
});

test("W1-T9102: an unseen file uses the class tail and the slot names its basis", (t) => {
  const fx = fixture(t);
  recordPeak("test", 8000, fx.store); // Whole-run history must never become a per-file estimate.
  const prior = testFileEstimates(["test/unseen.test.ts"], fx.store);
  assert.deepEqual(prior, [{ path: "test/unseen.test.ts", bytes: 512 * MiB, basis: "prior", samples: 0 }]);
  const empty = acquireTestSlot("prior", { ...fx.slot, filePeaks: prior });
  assert.match(empty.note, /prior/);
  assert.deepEqual(fx.holder().filePeaks, prior);
  empty.release();
  recordTestFilePeak("test/heavy.test.ts", 737, fx.store);
  const tail = testFileEstimates(["test/unseen.test.ts"], fx.store);
  assert.deepEqual(tail, [{ path: "test/unseen.test.ts", bytes: 737 * MiB, basis: "class-tail", samples: 1 }]);
  const learned = acquireTestSlot("tail", { ...fx.slot, filePeaks: tail });
  assert.match(learned.note, /class-tail/);
  assert.equal(fx.holder().memoryBytes, 737 * MiB);
  learned.release();
  const aged = testFileEstimates(["test/heavy.test.ts"], { ...fx.store, clock: fixedClock(NOW + 10 * 86400_000) });
  assert.equal(aged[0]!.bytes, 512 * MiB, "stale file history decays back toward the one-sample prior");
});

test("W1-T9102: selection sizing sums the largest live file peaks and keeps a progress floor", () => {
  const files = [737, 600, 300].map((mib) => mib * MiB);
  assert.equal(memoryTestConcurrency(1400 * MiB, files), 2);
  assert.equal(memoryTestConcurrency(1100 * MiB, files), 1, "any two files could overlap");
  assert.equal(memoryTestConcurrency(0, files), 1);
  assert.equal(memoryTestConcurrency(undefined, files), undefined);
  assert.equal(memoryTestConcurrency(8000 * MiB, files), 3, "the selection itself bounds file concurrency");
});

test("W1-T9102: the tree sampler records each file child's maximum once and excludes runner and helper peaks", (t) => {
  const fx = fixture(t);
  const procs = new Map([
    [9, { parent: 1, start: "90", argv: ["node", "run-child.js"], mib: 180 }],
    [10, { parent: 9, start: "100", argv: ["node", "--test", "test/heavy.test.ts"], mib: 80 }],
    [11, { parent: 10, start: "110", argv: ["node", "--import", "tsx", "/checkout/test/heavy.test.ts"], mib: 600 }],
    [12, { parent: 11, start: "120", argv: ["node", "test/helper.ts"], mib: 2000 }],
  ]);
  const sampler = createTreePeakSampler({
    listProcesses: () => ({ rows: [...procs].map(([pid, p]) => ({ pid, parent: p.parent, start: `proc:${p.start}` })), complete: true }),
    readFile: (path) => {
      const pid = Number(path.split("/")[2]);
      const p = procs.get(pid);
      if (!p) throw new Error("fixture process exited");
      if (path.endsWith("/stat")) return `${pid} (node) S ${p.parent} ${"0 ".repeat(17)}${p.start} 0`;
      if (path.endsWith("/cmdline")) return p.argv.join("\0");
      return `VmRSS:\t${p.mib * 1024} kB\nVmHWM:\t${p.mib * 1024} kB\n`;
    },
    setTimer: () => undefined, clearTimer: () => {},
  });
  const reservation = openLearnedReservation({ workerClass: "fix", root: fx.dir, entryKind: "bundle" }, {
    store: fx.store, sampler,
    ledger: { location: () => ({ dir: join(fx.dir, "ledger"), scope: "local" }), log: () => {} },
  });
  t.after(() => reservation.releaseOccupancy());
  reservation.bindRoot(9);
  procs.get(11)!.mib = 737;
  sampler.sampleNow();
  procs.delete(11);
  procs.delete(12);
  sampler.sampleNow();
  procs.delete(10);
  sampler.sampleNow();
  reservation.releaseOccupancy();
  const file = testFileEstimates(["test/heavy.test.ts"], fx.store)[0]!;
  assert.equal(file.bytes, 737 * MiB);
  assert.equal(file.samples, 1, "one sample per file process, rather than one per timer tick");
  assert.equal(testFileEstimates(["test/helper.ts"], fx.store)[0]!.basis, "class-tail");
  assert.equal(readPeakSamples("test", fx.store, true)[0]!.entryKind, undefined);
  assert.deepEqual(readPeakSamples("test", fx.store).map((s) => [s.peakMib, s.entryKind]), [[2817, undefined]]);
  assert.deepEqual(readPeakSamples("fix", fx.store).map((s) => [s.peakMib, s.entryKind]), [[180, "bundle"]]);
});

test("W1-T9102: store compaction preserves independent file histories without teaching the whole-run class", (t) => {
  const fx = fixture(t);
  const fileStore: PeakStoreOptions = { ...fx.store, entryKind: "tsx" };
  recordTestFilePeak("test/heavy.test.ts", 737, fileStore);
  assert.equal(readPeakSamples("test", fx.store, true)[0]!.entryKind, "tsx");
  for (let i = 0; i < 140; i++) recordTestFilePeak("test/light.test.ts", 300, fileStore);
  recordPeak("test", 8000, { ...fx.store, entryKind: "bundle", size: () => 2 * 1024 ** 2 });
  const samples = readPeakSamples("test", fx.store, true);
  assert.equal(samples.filter((s) => s.testFile === "test/light.test.ts").length, 128);
  assert.equal(samples.filter((s) => s.testFile === "test/heavy.test.ts").length, 1);
  assert.ok(samples.every((s) => s.entryKind === "tsx"));
  assert.deepEqual(readPeakSamples("test", fx.store).map((s) => s.peakMib), [8000]);
  assert.equal(readPeakSamples("test", fx.store)[0]!.entryKind, "bundle");
  assert.deepEqual(testFileEstimates(["test/heavy.test.ts", "test/light.test.ts"], fx.store).map((f) => f.bytes), [737 * MiB, 300 * MiB]);
});

test("W1-T9102: argv selection expands globs and ignores preload and filtering option values", (t) => {
  const fx = fixture(t);
  const a = join(fx.dir, "a.test.ts");
  const b = join(fx.dir, "b.test.ts");
  writeFileSync(a, "");
  writeFileSync(b, "");
  const args = ["--test", "--import", a, "--require", "tsx", "--test-name-pattern", "a*",
    "--test-concurrency", "2", join(fx.dir, "*.test.ts")];
  assert.deepEqual(selectedTestFiles(args).sort(), [a, b]);
  assert.deepEqual(selectedTestFiles(["--test", fx.dir]).sort(), [a, b]);
  assert.deepEqual(selectedTestFiles(["--test", "--", b, b]), [b]);
  assert.deepEqual(selectedTestFiles(["--test", "missing.test.ts"]), ["missing.test.ts"]);
  assert.ok(selectedTestFiles(["--test"]).includes("test/test-fan-out-is-sized-by-learned-per-file-peaks.test.ts"));
});

test("W1-T9102: learned slot sizing accounts for live holders and names fallback bases on degraded admission", (t) => {
  const fx = fixture(t);
  recordTestFilePeak("test/heavy.test.ts", 737, fx.store);
  const filePeaks = testFileEstimates(["test/heavy.test.ts", "test/unseen.test.ts"], fx.store);
  const opts = { ...fx.slot, slots: 2, memoryHeadroom: () => 1800 * MiB };
  const peer = acquireTestSlot("peer", { ...opts, memoryBytes: 600 * MiB });
  const run = acquireTestSlot("sized", { ...opts, filePeaks });
  assert.equal(run.concurrency, 1, "1800 minus a live 600 MiB holder holds only one 737 MiB file");
  assert.equal((JSON.parse(readFileSync(join(opts.dir, "slot-2.json"), "utf8")) as TestSlotHolder).memoryBytes, 737 * MiB);
  run.release();
  const waited = acquireTestSlot("waiter", { ...opts, filePeaks, memoryHeadroom: () => 1000 * MiB, waitBoundMs: 0 });
  assert.equal(waited.outcome, "wait_bound_exceeded");
  assert.match(waited.note, /file-p90, class-tail/);
  peer.release();
  const blocked = join(fx.dir, "not-a-directory");
  writeFileSync(blocked, "");
  const unavailable = acquireTestSlot("unavailable", { ...opts, dir: join(blocked, "slots"), filePeaks });
  assert.equal(unavailable.outcome, "slot_unavailable");
  assert.match(unavailable.note, /file-p90, class-tail/);
});

test("W1-T9102: unreadable file history uses the named prior and reports the read failure", (t) => {
  const fx = fixture(t);
  const diagnostics: Record<string, unknown>[] = [];
  const files = testFileEstimates(["test/unseen.test.ts"], { ...fx.store,
    list: () => ["broken.ndjson"], readTail: () => { throw new Error("fixture history read failure"); },
    log: (event) => { diagnostics.push(event); },
  });
  assert.equal(files[0]!.basis, "prior");
  assert.equal(files[0]!.bytes, 512 * MiB);
  assert.ok(diagnostics.some((d) => d.op === "read" && d.reason === "fixture history read failure"));
});

test("W1-T9102: a real test file child's kernel peak is learned through a reservation's default sampler", async (t) => {
  const fx = fixture(t);
  const file = join(fx.dir, "real.test.mjs");
  writeFileSync(file, 'import { test } from "node:test";\ntest("real peak", async () => {\n' +
    'console.log("file-peak-ready");\nawait new Promise(resolve => setTimeout(resolve, 500));\n});\n');
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_V8_COVERAGE: undefined };
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, ["--test", "--test-concurrency=1", "--import", "tsx",
    "--import", "./test/setup/tmp-hygiene.ts", file], { env, stdio: ["ignore", "pipe", "pipe"] });
  const exited = once(child, "exit");
  t.after(() => { child.kill(); });
  let output = "";
  await new Promise<void>((resolveReady, reject) => {
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
      if (output.includes("file-peak-ready")) resolveReady();
    });
    child.on("error", reject);
    child.on("exit", () => { if (!output.includes("file-peak-ready")) reject(new Error(`fixture exited before ready: ${output}`)); });
  });
  const reservation = openLearnedReservation({ workerClass: "test" }, {
    store: fx.store, ledger: { location: () => ({ dir: join(fx.dir, "ledger"), scope: "local" }), log: () => {} },
  });
  reservation.bindRoot(child.pid!);
  reservation.releaseOccupancy();
  const [code] = await exited;
  assert.equal(code, 0);
  const samples = readPeakSamples("test", fx.store, true);
  if (process.platform !== "linux") {
    assert.deepEqual(samples, [], "without /proc no file sample is invented");
    return;
  }
  assert.equal(samples.length, 1, "the production reservation hook records the observed file process");
  assert.equal(samples[0]!.testFile, file);
  assert.ok(samples[0]!.peakMib > 0);
});
