// W1-T13878 — the fix class learns its memory estimate from measured concurrent tree peaks.
//
// On 2026-11-19 fix admission charged 5,911 MiB per fix (p90) against a typical of 1,628 MiB. The estimate came from
// legacy-hwm samples (sums of each member's lifetime peak; 103 on 11-19, p90 6,629 MiB), while the 36 concurrent-rss
// fix samples had an RSS p90 of 835 MiB. The learner also read only the last 256 KiB of each store file, which in
// state2.ndjson is mostly test-file rows (W1-T13842, docs/forensics/fix-peak-estimate-drivers.md).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { fixedClock } from "#src/lib/clock.js";
import type { HostMemoryLedgerOptions } from "#src/lib/host-memory-ledger.js";
import {
  PEAK_TAIL_BYTES, classEstimate, classTypical, createTreePeakSampler, openLearnedReservation, readPeakSamples,
  resetLearnedEstimateCacheForTests, type PeakStoreOptions,
} from "#src/lib/host-memory-learning.js";
import { createSweepFixAdmissionController, type OpenPrView } from "#src/lib/sweep.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

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

test("W1-T13878 criterion 3: a legacy-hwm row recorded at release names why the tree went unmeasured", () => {
  for (const fault of ["member-rss-missing", "listing-incomplete"] as const) {
    resetLearnedEstimateCacheForTests();
    let complete = fault !== "listing-incomplete";
    const sampler = createTreePeakSampler({
      listProcesses: () => ({ complete, rows: [{ pid: 10, parent: 1, start: "proc:10" }] }),
      readFile: (path) => {
        if (path.endsWith("/stat")) return `10 (node) S 1 ${"0 ".repeat(17)}10 0 0`;
        if (path.endsWith("/cmdline")) return "node\0worker.js\0";
        return fault === "member-rss-missing" ? "VmHWM:\t409600 kB\n" : "VmRSS:\t204800 kB\nVmHWM:\t409600 kB\n";
      },
      setTimer: () => undefined, clearTimer: () => undefined,
    });
    const { store, text } = memoryStore();
    const reservation = openLearnedReservation({ workerClass: "fix" }, { ledger: ledger(), store, sampler });
    reservation.bindRoot(10);
    complete = true;
    sampler.sampleNow();
    reservation.releaseOccupancy();
    const samples = readPeakSamples("fix", store);
    assert.equal(samples.length, 1, fault);
    assert.equal(samples[0]!.measurementBasis, "legacy-hwm", fault);
    assert.equal(samples[0]!.peakMib, 400, fault);
    assert.equal(samples[0]!.unmeasuredReason, fault, "the row names why its concurrent peak is missing");
    assert.match(text(), new RegExp(`"why":"${fault}"`), "the reason is stored on the row");
  }
  resetLearnedEstimateCacheForTests();
});

test("W1-T13878 criterion 4: fix samples behind 256 KiB of test-file rows still reach the fix estimate", () => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}fix-peaks-`));
  resetLearnedEstimateCacheForTests();
  try {
    let text = fixRows({ legacy: 0, concurrent: 12 });
    const fileRow = row({ c: "test", p: 400, basis: "process-hwm", f: "test/some-file.test.ts" }, 0);
    while (text.length < PEAK_TAIL_BYTES + 64 * 1024) text += fileRow;
    mkdirSync(join(dir, "estimates"), { recursive: true });
    writeFileSync(join(dir, "estimates", "state2.ndjson"), text);
    const store: PeakStoreOptions = { location: () => ({ dir }), clock: fixedClock(NOW) };
    assert.equal(readPeakSamples("fix", store).length, 12, "every retained fix sample is read");
    const estimate = classEstimate("fix", store);
    assert.equal(estimate.samples, 12);
    assert.equal(estimate.basis, "concurrent-rss");
    assert.ok(estimate.estimateMib < 1_000, `the estimate is learned, not the 2,048 prior: ${estimate.estimateMib}`);
    assert.ok(readPeakSamples("test", store, true).length > 0, "test-file reads still see their rows");
  } finally {
    resetLearnedEstimateCacheForTests();
    rmSync(dir, { recursive: true, force: true });
  }
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
