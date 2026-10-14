import assert from "node:assert/strict";
import { test } from "node:test";

import { fixedClock } from "../src/lib/clock.js";
import { createTreePeakSampler, readPeakSamples, recordPeak } from "../src/lib/host-memory-learning.js";

test("W1-T8879: tree peaks measure concurrent RSS rather than unrelated historical highs", () => {
  let phase = 0;
  const sampler = createTreePeakSampler({
    listProcesses: () => ({ complete: true, rows: [
      { pid: 10, parent: 1, start: "proc:5" }, { pid: 11, parent: 10, start: "proc:6" },
    ] }),
    readFile: (path) => {
      if (path.endsWith("/stat")) return `10 (node) S 1 ${"0 ".repeat(17)}5 0 0`;
      const root = path === "/proc/10/status";
      return `VmRSS:\t${root ? phase ? 200 * 1024 : 100 * 1024 : phase ? 20 * 1024 : 200 * 1024} kB\nVmHWM:\t${900 * 1024} kB\n`;
    },
    setTimer: () => undefined,
    clearTimer: () => undefined,
  });
  sampler.track("concurrent", 10);
  phase = 1;
  sampler.sampleNow();
  assert.equal(sampler.finish("concurrent"), 300, "max(sum of current RSS) is 300 MiB, not sum of two 900 MiB historical highs");
});

test("W1-T8879: legacy and concurrent peak bases survive the real store serializer and compaction", () => {
  const now = Date.parse("2026-10-14T23:00:00Z");
  let text = JSON.stringify({ c: "garden", p: 1800, at: new Date(now - 1000).toISOString() }) + "\n";
  text += JSON.stringify({ c: "garden", p: 900, at: new Date(now - 500).toISOString(), basis: "future-unknown" }) + "\n";
  const opts = {
    location: () => ({ dir: "/fixture" }), root: "/fixture", instance: () => ({ name: "core" }),
    clock: fixedClock(now), list: () => ["core.ndjson"], readTail: () => text,
    append: (_path: string, line: string) => { text += line; },
    size: () => 2 * 1024 * 1024,
    rewrite: (_path: string, content: string) => { text = content; },
    measurementBasis: "concurrent-rss" as const,
  };
  assert.equal(recordPeak("garden", 300, opts), true);
  const rows = readPeakSamples("garden", opts);
  assert.deepEqual(rows.map(row => ({ peak: row.peakMib, basis: (row as { measurementBasis?: string }).measurementBasis })), [
    { peak: 1800, basis: "legacy-hwm" }, { peak: 900, basis: "unknown" }, { peak: 300, basis: "concurrent-rss" },
  ], "compaction must not upgrade legacy evidence or erase new measurement provenance");
});

test("W1-T8879: incomplete or denied tree readings are not recorded as smaller measured peaks", () => {
  for (const fault of ["listing", "denied", "missing-rss", "negative-rss"] as const) {
    const sampler = createTreePeakSampler({
      listProcesses: () => ({ complete: fault !== "listing", rows: [{ pid: 10, parent: 1, start: "proc:5" }] }),
      readFile: (path) => {
        if (path.endsWith("/stat")) return `10 (node) S 1 ${"0 ".repeat(17)}5 0 0`;
        if (fault === "denied") throw Object.assign(new Error("denied"), { code: "EACCES" });
        return fault === "listing" ? "VmRSS: 409600 kB\n" : fault === "negative-rss" ? "VmRSS: -1 kB\n" : "VmHWM: 409600 kB\n";
      },
      setTimer: () => undefined, clearTimer: () => undefined,
    });
    sampler.track(fault, 10);
    assert.equal(sampler.finish(fault), undefined, `${fault} is missing evidence, not a lower or zero tree peak`);
  }
});

test("W1-T8879: binding a root twice does not count its concurrent RSS twice", () => {
  const sampler = createTreePeakSampler({
    listProcesses: () => ({ complete: true, rows: [{ pid: 10, parent: 1, start: "proc:5" }] }),
    readFile: path => path.endsWith("/stat") ? `10 (node) S 1 ${"0 ".repeat(17)}5 0 0` : "VmRSS: 409600 kB\nVmHWM: 819200 kB\n",
    setTimer: () => undefined, clearTimer: () => undefined,
  });
  sampler.track("root", 10);
  sampler.track("root", 10);
  assert.equal(sampler.finish("root"), 400);
});
