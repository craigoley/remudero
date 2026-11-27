/**
 * W1-T15179 — A RUNNING TYPECHECK IS CHARGED TO THE HOST MEMORY PROJECTION.
 *
 * OBSERVED 2026-11-27 16:23-16:40Z: 39 workers held 12.3 GB and two tsc held 6.6 GB at once in an 18 GB container;
 * memory PSI full reached 98%. The worker side charged no running tsc, and a warm tsc was admitted on raw headroom
 * alone, so both spent the same room. Every case runs the real admission (test-slot.ts) and the real shadow reading;
 * only /proc and the reservation ledger are injected, so nothing here reads the host's own process table.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  defaultShadowMemoryPorts,
  evaluateShadowMemory,
  gatherShadowInputs,
  type HostMemoryBudgetPolicy,
  type ShadowMemoryPorts,
} from "#src/lib/host-memory-shadow.js";
import { publishSharedHostMemory, type LaneMemoryReading } from "#src/lib/lane-governor.js";
import { admitStaticWork, readLiveStaticWork, resolveTestSlotDir } from "#src/lib/test-slot.js";

const MIB = 1024 ** 2;
const POLICY: HostMemoryBudgetPolicy = {
  mode: "shadow",
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

/** A /proc stat line parseProcStat reads: state, parent, then field 19 (start time). */
function statLine(pid: number, parent: number, start: string): string {
  return `${pid} (tsc) S ${parent} ${Array.from({ length: 17 }, () => "0").join(" ")} ${start.replace(/^proc:/, "")}`;
}

/** The shadow's real ports, with /proc and the reservation ledger injected: this process holds `treeKb` of rss. */
function ports(treeKb: number, over: Partial<ShadowMemoryPorts> = {}): ShadowMemoryPorts {
  const pid = process.pid;
  const start = readLiveStaticWork();
  const recorded = "records" in start ? start.records.find((r) => r.pid === pid)?.processStart : undefined;
  const files = new Map<string, string>([
    ["/proc/meminfo", "MemTotal: 33554432 kB\nMemAvailable: 16777216 kB\n"],
    [`/proc/${pid}/stat`, statLine(pid, 1, recorded?.startsWith("proc:") ? recorded : "proc:1000")],
    [`/proc/${pid}/status`, `VmRSS:\t${treeKb} kB\nVmSwap:\t0 kB\n`],
  ]);
  return {
    ...defaultShadowMemoryPorts(),
    readFile: (path) => {
      const text = files.get(path);
      if (text === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
      return text;
    },
    readTail: () => "",
    readLedger: () => undefined,
    listProc: () => [String(pid)],
    daemonPid: () => undefined,
    ...over,
  };
}

function projected(p: ShadowMemoryPorts, root: string): ReturnType<typeof evaluateShadowMemory>["numbers"] {
  return evaluateShadowMemory(gatherShadowInputs({ workerClass: "implement", root, estimateMib: 0 }, p, POLICY), POLICY).numbers;
}

test("W1-T15179 criterion 1: an admitted 4,400 MiB typecheck holding 1,000 MiB lowers the projection by 3,400 MiB", (t) => {
  const root = mkdtempSync(join(tmpdir(), "rmd-t15179-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const none = projected(ports(1000 * 1024), root);
  const slot = admitStaticWork("typecheck:criterion-1", { memoryBytes: 4400 * MIB, memoryHeadroom: () => 64 * 1024 * MIB, log: () => {} });
  t.after(() => slot.release());
  assert.equal(slot.outcome, "admitted");
  const held = projected(ports(1000 * 1024), root);
  assert.equal(none.projectedAvailableMib! - held.projectedAvailableMib!, 3400);
  assert.equal(held.staticWorkChargeMib, 3400);
  assert.equal(held.staticWorkStages, 1);
});

test("W1-T15179 criterion 2: a warm typecheck waits while the published projection cannot hold its peak", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-t15179-slots-"));
  t.after(() => { rmSync(dir, { recursive: true, force: true }); publishSharedHostMemory({ unread: "test end" }, Date.now()); });
  const reading = (availableMib: number): LaneMemoryReading => ({
    containerBaseMib: null, containerOnsetMib: null, containerArmCounts: true, containerBasis: "test",
    hostBaseAvailableMib: availableMib, hostReserveMib: 2048, perLaneMib: 4000, containerPressed: false,
  }) as LaneMemoryReading;
  publishSharedHostMemory(reading(1000), Date.now());
  let sleeps = 0;
  const slot = admitStaticWork("typecheck:criterion-2", {
    dir, memoryBytes: 4400 * MIB, memoryHeadroom: () => 64 * 1024 * MIB, pollMs: 1, waitBoundMs: 60_000, log: () => {},
    sleep: () => { sleeps += 1; publishSharedHostMemory(reading(9000), Date.now()); },
  });
  t.after(() => slot.release());
  assert.equal(slot.outcome, "admitted");
  assert.equal(sleeps, 1, "raw headroom held the peak, the projection did not: it waited one poll");
  assert.match(slot.note, /projection 9000 MiB/);
});

test("W1-T15179 criterion 3: with no live static record the projection is unchanged, and an ended holder frees its charge", (t) => {
  const root = mkdtempSync(join(tmpdir(), "rmd-t15179-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const withoutReader = ports(0);
  delete withoutReader.readStaticWork;
  const baseline = projected(withoutReader, root);
  assert.deepEqual(projected(ports(0), root), baseline);
  const dead = join(resolveTestSlotDir().dir, "static-00000000-0000-4000-8000-000000000000.json");
  writeFileSync(dead, JSON.stringify({ pid: 2 ** 22 - 3, host: hostname(), startedAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(), label: "typecheck:ended", memoryBytes: 4400 * MIB, admittedAt: new Date().toISOString() }));
  t.after(() => rmSync(dead, { force: true }));
  assert.deepEqual(projected(ports(0), root), baseline);
});

test("W1-T15179 criterion 4: rss already out of MemAvailable is never charged twice", (t) => {
  const root = mkdtempSync(join(tmpdir(), "rmd-t15179-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const slot = admitStaticWork("typecheck:criterion-4", { memoryBytes: 4400 * MIB, memoryHeadroom: () => 64 * 1024 * MIB, log: () => {} });
  t.after(() => slot.release());
  assert.equal(projected(ports(5000 * 1024), root).staticWorkChargeMib, 0, "a tree past its peak claims nothing more");
  // The daemon's own main process is measured by its growth, never as the stage's tree: the stage claims its whole peak.
  assert.equal(projected(ports(5000 * 1024, { daemonPid: () => process.pid }), root).staticWorkChargeMib, 4400);
});
