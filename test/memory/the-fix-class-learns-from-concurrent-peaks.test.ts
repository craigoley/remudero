// W1-T13878 — the fix class learns its memory estimate from measured concurrent tree peaks.
//
// On 2026-11-19 fix admission charged 5,911 MiB per fix (p90) against a typical of 1,628 MiB. The estimate came from
// legacy-hwm samples (sums of each member's lifetime peak; 103 on 11-19, p90 6,629 MiB), while the 36 concurrent-rss
// fix samples had an RSS p90 of 835 MiB. The learner also read only the last 256 KiB of each store file, which in
// state2.ndjson is mostly test-file rows (W1-T13842, docs/forensics/fix-peak-estimate-drivers.md).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { fixedClock } from "#src/lib/clock.js";
import { DEFAULT_ESTIMATE_MIB, DEFAULT_WALK_LIMITS, defaultListProcesses, type HostMemoryLedgerOptions } from "#src/lib/host-memory-ledger.js";
import {
  PEAK_COMPACT_BYTES, PEAK_TAIL_BYTES, classEstimate, classTypical, createTreePeakSampler, openLearnedReservation,
  readPeakSamples, recordPeak, recordTestFilePeak,
  resetLearnedEstimateCacheForTests, type PeakStoreOptions,
} from "#src/lib/host-memory-learning.js";
import { createSweepFixAdmissionController, type OpenPrView } from "#src/lib/sweep.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const NOW = Date.parse("2026-11-19T20:18:37.040Z");
const MIN = 60_000;
const FLOOR = 3_072;

function row(fields: Record<string, unknown>, ageMin: number): string {
  return `${JSON.stringify({ ...fields, at: new Date(NOW - ageMin * MIN).toISOString() })}\n`;
}

/** The 11-19 shape: heavy legacy-hwm fix rows with no concurrent value, and lighter concurrent-rss fix rows. */
function fixRows(opts: { legacy: number; concurrent: number }): string {
  let text = "";
  for (let i = 0; i < opts.legacy; i++) text += row({ c: "fix", p: 6_000 + i, basis: "legacy-hwm" }, i);
  for (let i = 0; i < opts.concurrent; i++) text += row({ c: "fix", p: 800 + i, basis: "concurrent-rss", legacy_p: 1_700 }, i);
  return text;
}

function memoryStore(initial = ""): { store: PeakStoreOptions; text: () => string } {
  let lines = initial;
  return {
    store: {
      location: () => ({ dir: "/fixture" }), instance: () => ({ name: "state2" }), clock: fixedClock(NOW),
      list: () => ["state2.ndjson"], readTail: (_path, max) => lines.slice(-max),
      append: (_path, line) => { lines += line; }, size: () => 0, rewrite: (_path, content) => { lines = content; },
    },
    text: () => lines,
  };
}

function ledger(): HostMemoryLedgerOptions {
  const files = new Map<string, string>();
  return {
    location: () => ({ dir: "/fixture", scope: "host" }), instance: () => ({ name: "state2", hostUnique: true }),
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
    clock: fixedClock(NOW), ownerPid: 4242, log: () => undefined,
  };
}

test("W1-T13878 criterion 1: the fix estimate and typical come from concurrent peaks when any exist", () => {
  resetLearnedEstimateCacheForTests();
  try {
    const { store } = memoryStore(fixRows({ legacy: 20, concurrent: 12 }));
    const estimate = classEstimate("fix", store);
    assert.equal(estimate.basis, "concurrent-rss");
    assert.equal(estimate.samples, 12, "only the concurrent samples are learned from");
    assert.ok(estimate.estimateMib < 1_000, `the p90 follows the measured concurrent peaks: ${estimate.estimateMib}`);
    const typical = classTypical("fix", store);
    assert.ok(typical.estimateMib < 1_000, `the typical follows them too: ${typical.estimateMib}`);
    assert.ok(typical.estimateMib <= estimate.estimateMib);
  } finally { resetLearnedEstimateCacheForTests(); }
});

test("W1-T13878 criterion 2: legacy-hwm sums are a labelled fallback for the fix class only", () => {
  resetLearnedEstimateCacheForTests();
  try {
    const legacyOnly = memoryStore(fixRows({ legacy: 20, concurrent: 0 })).store;
    const fallback = classEstimate("fix", legacyOnly);
    assert.equal(fallback.basis, "legacy-hwm-fallback", "an estimate learned from lifetime sums says so");
    assert.ok(fallback.estimateMib >= 6_000, `with no concurrent sample the legacy estimate stands: ${fallback.estimateMib}`);
    resetLearnedEstimateCacheForTests();
    const empty = classEstimate("fix", memoryStore("").store);
    assert.equal(empty.samples, 0);
    assert.equal(empty.basis, undefined, "the prior alone carries no basis");
    resetLearnedEstimateCacheForTests();
    let garden = "";
    for (let i = 0; i < 12; i++) garden += row({ c: "garden", p: 300, basis: "concurrent-rss", legacy_p: 1_800 }, i);
    const other = classEstimate("garden", memoryStore(garden).store);
    assert.equal(other.estimateMib, 1_800, "another class still learns its paired legacy metric");
    assert.equal(other.basis, undefined);
  } finally { resetLearnedEstimateCacheForTests(); }
});

test("W1-T13878 criterion 2: compaction preserves the former input tail for other classes", () => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}other-class-peaks-`));
  resetLearnedEstimateCacheForTests();
  try {
    const older = row({ c: "garden", p: 300, basis: "concurrent-rss", legacy_p: 1_800 }, 0).repeat(12);
    const filler = row({ c: "test", p: 400, basis: "process-hwm", f: "test/測定.test.ts" }, 0);
    const recent = row({ c: "garden", p: 200, basis: "concurrent-rss", legacy_p: 900 }, 0);
    const padding = filler.repeat(Math.ceil(PEAK_COMPACT_BYTES / Buffer.byteLength(filler)));
    mkdirSync(join(dir, "estimates"));
    const path = join(dir, "estimates", "state2.ndjson");
    writeFileSync(path, older + padding + recent);
    const store = { location: () => ({ dir }), instance: () => ({ name: "state2" }), clock: fixedClock(NOW) };
    const prior = classEstimate("garden", store);
    assert.deepEqual(prior, { estimateMib: DEFAULT_ESTIMATE_MIB.garden, samples: 1 });

    assert.equal(recordTestFilePeak("test/new.test.ts", 401, store), true);
    assert.ok(statSync(path).size < PEAK_TAIL_BYTES, "the rewritten file fits in the garden read tail");
    resetLearnedEstimateCacheForTests();
    assert.deepEqual(readPeakSamples("garden", store).map(s => s.legacyPeakMib), [900]);
    assert.deepEqual(classEstimate("garden", store), prior);
  } finally {
    resetLearnedEstimateCacheForTests();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T13878 criterion 2: compaction keeps a garden sample at the exact read-tail boundary", (t) => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}aligned-peak-tail-`));
  resetLearnedEstimateCacheForTests();
  t.after(() => {
    resetLearnedEstimateCacheForTests();
    rmSync(dir, { recursive: true, force: true });
  });
  const fileRow = (name: string) => row({ c: "test", p: 400, basis: "process-hwm", f: `test/${name}.test.ts` }, 0);
  const latest = fileRow("latest");
  const padding = fileRow("padding");
  let suffix = row({ c: "garden", p: 6_400, basis: "legacy-hwm" }, 0);
  for (let i = 0; ; i++) {
    const filler = fileRow(`file-${i}`);
    if (suffix.length + filler.length + padding.length + latest.length > PEAK_TAIL_BYTES) break;
    suffix += filler;
  }
  suffix += fileRow(`padding${"a".repeat(PEAK_TAIL_BYTES - suffix.length - padding.length - latest.length)}`);
  const oldFix = fixRows({ legacy: 0, concurrent: 1 });
  mkdirSync(join(dir, "estimates"));
  const path = join(dir, "estimates", "state2.ndjson");
  writeFileSync(path, oldFix + fileRow("x".repeat(PEAK_COMPACT_BYTES)) + suffix);
  const store = { location: () => ({ dir }), instance: () => ({ name: "state2" }), clock: fixedClock(NOW) };
  const garden = { estimateMib: 6_400, samples: 1 };
  assert.deepEqual(classEstimate("garden", store), garden);

  assert.equal(recordTestFilePeak("test/latest.test.ts", 400, store), true);
  assert.equal(statSync(path).size, Buffer.byteLength(oldFix) + PEAK_TAIL_BYTES);
  assert.equal(readPeakSamples("fix", store).length, 1);
  resetLearnedEstimateCacheForTests();
  assert.deepEqual(classEstimate("garden", store), garden);
});

test("W1-T13878 criterion 3: a legacy-hwm row recorded at release names why the tree went unmeasured", async (t) => {
  const faults = ["member-rss-missing", "member-status-unreadable", "listing-incomplete", "listing-failed"] as const;
  for (const fault of faults) {
    await t.test(fault, () => {
      resetLearnedEstimateCacheForTests();
      let currentFault: typeof faults[number] | undefined;
      let runnerAlive = true;
      const denied = Object.assign(new Error("permission denied"), { code: "EACCES" });
      const readProc = (path: string) => {
        const runner = path.startsWith("/proc/11/");
        if (path.endsWith("/stat")) return `10 (node) S ${runner ? 10 : 1} ${"0 ".repeat(17)}10 0 0`;
        if (path.endsWith("/cmdline")) return runner ? "node\0--test\0" : "node\0worker.js\0";
        if (currentFault === "member-status-unreadable") throw denied;
        return currentFault === "member-rss-missing" ? "VmHWM:\t409600 kB\n" : "VmRSS:\t204800 kB\nVmHWM:\t409600 kB\n";
      };
      const sampler = createTreePeakSampler({
        listProcesses: () => defaultListProcesses(
          currentFault === "listing-incomplete" ? { ...DEFAULT_WALK_LIMITS, maxEntries: 1 } : DEFAULT_WALK_LIMITS,
          fixedClock(NOW),
          readProc,
          () => {
            if (currentFault === "listing-failed") throw denied;
            return runnerAlive ? ["10", "11"] : ["10"];
          },
        ),
        readFile: readProc, setTimer: () => undefined, clearTimer: () => undefined,
      });
      const { store, text } = memoryStore();
      const reservation = openLearnedReservation({ workerClass: "fix" }, { ledger: ledger(), store, sampler });
      reservation.bindRoot(10);
      currentFault = fault;
      sampler.sampleNow();
      currentFault = fault === "member-rss-missing" ? "member-status-unreadable" : "member-rss-missing";
      sampler.sampleNow();
      currentFault = undefined;
      runnerAlive = false;
      reservation.releaseOccupancy();
      for (const workerClass of ["fix", "test"] as const) {
        const samples = readPeakSamples(workerClass, store);
        assert.equal(samples.length, 1, workerClass);
        assert.equal(samples[0]!.measurementBasis, "legacy-hwm", workerClass);
        assert.equal(samples[0]!.peakMib, 400, workerClass);
        assert.equal(samples[0]!.unmeasuredReason, fault, `${workerClass} row keeps the first reason`);
      }
      assert.equal(text().match(new RegExp(`"why":"${fault}"`, "g"))?.length, 2, "both rows store the reason");
    });
  }
  resetLearnedEstimateCacheForTests();
});

test("W1-T13878 criterion 4: fix samples behind 256 KiB of test-file rows still reach the fix estimate", () => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}fix-peaks-`));
  resetLearnedEstimateCacheForTests();
  try {
    let text = fixRows({ legacy: 0, concurrent: 12 });
    text += row({ c: "fix", p: 6_000, basis: "legacy-hwm", why: "listing-incomplete" }, 0);
    for (let i = 0; ; i++) {
      const fileRow = row({ c: "test", p: 400, basis: "process-hwm", f: `test/file-${i}.test.ts` }, 0);
      if (text.length + fileRow.length > PEAK_COMPACT_BYTES) break;
      text += fileRow;
    }
    mkdirSync(join(dir, "estimates"), { recursive: true });
    const path = join(dir, "estimates", "state2.ndjson");
    writeFileSync(path, text);
    const store: PeakStoreOptions = { location: () => ({ dir }), instance: () => ({ name: "state2" }), clock: fixedClock(NOW) };
    assert.ok(statSync(path).size > PEAK_TAIL_BYTES);
    const estimate = classEstimate("fix", store);
    assert.equal(estimate.samples, 12);
    assert.equal(estimate.basis, "concurrent-rss");
    assert.ok(estimate.estimateMib < 1_000);

    const newestFile = `test/${"a".repeat(200)}.test.ts`;
    assert.ok(statSync(path).size + Buffer.byteLength(row({ c: "test", p: 400, basis: "process-hwm", f: newestFile }, 0)) > PEAK_COMPACT_BYTES);
    assert.equal(recordTestFilePeak(newestFile, 400, { ...store, size: target => {
      const size = statSync(target).size;
      appendFileSync(target, row({ c: "test", p: 400, basis: "process-hwm", f: "test/intervening-append.test.ts" }, 0));
      return size;
    } }), true);
    resetLearnedEstimateCacheForTests();
    assert.deepEqual(classEstimate("fix", store), estimate, "compaction retains every concurrent fix sample");
    assert.equal(readPeakSamples("fix", store).find(s => s.measurementBasis === "legacy-hwm")?.unmeasuredReason, "listing-incomplete");
    assert.ok(statSync(path).size <= PEAK_COMPACT_BYTES, "distinct test-file histories fit in the retained store");
    const retainedFiles = readPeakSamples("test", store, true).map(s => s.testFile);
    assert.ok(retainedFiles.includes(newestFile), "the new test-file sample is retained");
    assert.ok(retainedFiles.includes("test/intervening-append.test.ts"));
  } finally {
    resetLearnedEstimateCacheForTests();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T13878 criterion 4: another process cannot append to an instance during its rewrite", (t) => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}peak-writers-`));
  resetLearnedEstimateCacheForTests();
  t.after(() => {
    resetLearnedEstimateCacheForTests();
    rmSync(dir, { recursive: true, force: true });
  });
  const store = { location: () => ({ dir }), instance: () => ({ name: "state2" }), clock: fixedClock(NOW) };
  const concurrent = { ...store, measurementBasis: "concurrent-rss" as const };
  assert.equal(recordPeak("fix", 800, concurrent), true);

  let writerResults: string | undefined;
  assert.equal(recordTestFilePeak("test/compact.test.ts", 400, {
    ...store, size: () => PEAK_COMPACT_BYTES + 1,
    rewrite: (path, content) => {
      const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
        import { recordPeak } from "#src/lib/host-memory-learning.js";
        const write = name => recordPeak("fix", 900, {
          location: () => ({ dir: process.argv[1] }), instance: () => ({ name }), measurementBasis: "concurrent-rss",
          log: () => {},
        });
        console.log(JSON.stringify([write("state2"), write("state3")]));
      `, dir], { cwd: REPO_ROOT, encoding: "utf8", timeout: 10_000 });
      assert.equal(child.status, 0, child.stderr || String(child.error));
      writerResults = child.stdout.trim();
      writeFileSync(path, content);
    },
  }), true);
  assert.equal(writerResults, "[false,true]", "contention applies only to the instance being compacted");
  assert.equal(recordPeak("fix", 900, concurrent), true, "a retry can write once the rewrite finishes");
  assert.deepEqual(readPeakSamples("fix", store).map(sample => sample.peakMib).sort(), [800, 900, 900]);
});

test("W1-T13878 criterion 5: the fix capacity row names the basis of the fix estimate it charges", () => {
  resetLearnedEstimateCacheForTests();
  try {
    for (const [concurrent, basis, admitted] of [[12, "concurrent-rss", true], [0, "legacy-hwm-fallback", false]] as const) {
      resetLearnedEstimateCacheForTests();
      const { store } = memoryStore(fixRows({ legacy: 20, concurrent }));
      const rows: Record<string, unknown>[] = [];
      const controller = createSweepFixAdmissionController({
        surface: "light", queueDepth: 1, hostWorkerBudget: 8, activeWorkers: 0, reviewReservations: 0,
        readReviewReservations: () => 0, readActiveWorkers: () => 0,
        readPressure: () => ({ availableMib: FLOOR + 3_000, floorMib: FLOOR }),
        readEstimate: (workerClass) => classEstimate(workerClass, store),
        readTypical: (workerClass) => classTypical(workerClass, store),
        log: (step, extra) => void rows.push({ step, ...extra }),
      });
      assert.equal(controller.claim({ prNumber: 13878 } as OpenPrView).admitted, admitted, basis);
      const capacity = rows.filter((r) => r.step === "sweep.fix_capacity").at(-1)!;
      assert.equal(capacity.fix_estimate_basis, basis);
      assert.equal(capacity.fix_estimate_source, "measured");
      assert.equal(capacity.pressure_floor_mib, FLOOR, "the floor is unchanged");
    }
  } finally { resetLearnedEstimateCacheForTests(); }
});
