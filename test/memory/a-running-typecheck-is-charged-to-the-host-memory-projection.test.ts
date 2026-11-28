/**
 * W1-T15179 — A RUNNING TYPECHECK IS CHARGED TO THE HOST MEMORY PROJECTION.
 *
 * OBSERVED 2026-11-27 16:23-16:40Z: 39 workers held 12.3 GB and two tsc held 6.6 GB at once in an 18 GB container;
 * memory PSI full reached 98%. The worker side charged no running tsc, and a warm tsc was admitted on raw headroom
 * alone, so both spent the same room. Every case runs the real admission (test-slot.ts) and the real shadow reading;
 * only /proc and the reservation ledger are injected, so nothing here reads the host's own process table.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
import { admitStaticWork, readLiveStaticWork } from "#src/lib/test-slot.js";

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
function ports(treeKb: number, over: Partial<ShadowMemoryPorts> = {}, reserveCurrent = false, slotDir?: string): ShadowMemoryPorts {
  const pid = process.pid;
  const start = readLiveStaticWork(slotDir ? { dir: slotDir } : {});
  const recorded = "records" in start ? start.records.find((r) => r.pid === pid)?.processStart : undefined;
  const files = new Map<string, string>([
    ["/proc/meminfo", "MemTotal: 33554432 kB\nMemAvailable: 16777216 kB\n"],
    [`/proc/${pid}/stat`, statLine(pid, 1, recorded?.startsWith("proc:") ? recorded : "proc:1000")],
    [`/proc/${pid}/status`, `VmRSS:\t${treeKb} kB\nVmSwap:\t0 kB\n`],
    ...(reserveCurrent ? [["/reservation.json", JSON.stringify({ roots: [{ pid, start: recorded?.startsWith("proc:") ? recorded : "proc:1000" }], tree: [] })] as [string, string]] : []),
  ]);
  return {
    ...defaultShadowMemoryPorts(),
    readStaticWork: () => readLiveStaticWork(slotDir ? { dir: slotDir } : {}),
    readFile: (path) => {
      const text = files.get(path);
      if (text === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
      return text;
    },
    readTail: () => "",
    readLedger: () => reserveCurrent ? ({ state: "present", scope: "host", dir: rootless(), entries: [{
      id: "reservation", owner: "worker@host", workerClass: "implement", estimateMib: 4400,
      estimateSource: { kind: "default-unmeasured" }, status: "owned", ageMs: 0, sinceVerifiedMs: 0,
      walkComplete: true, path: "/reservation.json",
    }], counts: { live: 1, uncertain: 0, incompleteWalk: 0, localScope: 0, unreadable: 0 }, reservedMib: 4400 }) : undefined,
    listProc: () => [String(pid)],
    daemonPid: () => undefined,
    ...over,
  };
}

function rootless(): string { return "/test/reservations"; }

function projected(p: ShadowMemoryPorts, root: string): ReturnType<typeof evaluateShadowMemory>["numbers"] {
  return evaluateShadowMemory(gatherShadowInputs({ workerClass: "implement", root, estimateMib: 0 }, p, POLICY), POLICY).numbers;
}

test("W1-T15179 criterion 1: an admitted 4,400 MiB typecheck holding 1,000 MiB lowers the projection by 3,400 MiB", (t) => {
  const root = mkdtempSync(join(tmpdir(), "rmd-t15179-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = mkdtempSync(join(tmpdir(), "rmd-t15179-slots-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const none = projected(ports(1000 * 1024, {}, true, dir), root);
  const slot = admitStaticWork("typecheck:criterion-1", { dir, memoryBytes: 4400 * MIB, memoryHeadroom: () => 64 * 1024 * MIB, log: () => {} });
  t.after(() => slot.release());
  assert.equal(slot.outcome, "admitted");
  const held = projected(ports(1000 * 1024, {}, true, dir), root);
  assert.equal(none.projectedAvailableMib! - held.projectedAvailableMib!, 3400);
  assert.equal(held.staticWorkChargeMib, 3400);
  assert.equal(held.staticWorkStages, 1);
});

test("W1-T15179 criterion 2: a warm typecheck waits while the published projection cannot hold its peak", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-t15179-slots-"));
  t.after(() => { rmSync(dir, { recursive: true, force: true }); publishSharedHostMemory({ unread: "test end" }, Date.now(), dir); });
  const reading = (availableMib: number): LaneMemoryReading => ({
    containerBaseMib: null, containerOnsetMib: null, containerArmCounts: true, containerBasis: "test",
    hostBaseAvailableMib: availableMib, hostReserveMib: 2048, perLaneMib: 4000, containerPressed: false,
  }) as LaneMemoryReading;
  publishSharedHostMemory(reading(1000), Date.now(), dir);
  const script = `import { admitStaticWork, publishStaticWorkProjection } from '#src/lib/test-slot.js';
let sleeps = 0;
const slot = admitStaticWork('typecheck:criterion-2-worker', {
  dir: ${JSON.stringify(dir)}, memoryBytes: ${4400 * MIB}, memoryHeadroom: () => ${64 * 1024 * MIB},
  pollMs: 1, waitBoundMs: 60000, log: () => {},
  sleep: () => { sleeps += 1; publishStaticWorkProjection(9000, Date.now(), ${JSON.stringify(dir)}); },
});
console.log(JSON.stringify({ outcome: slot.outcome, sleeps, note: slot.note }));
slot.release();`;
  const child = JSON.parse(execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script],
    { cwd: process.cwd(), encoding: "utf8" })) as { outcome: string; sleeps: number; note: string };
  assert.equal(child.outcome, "admitted");
  assert.equal(child.sleeps, 1, "a separate process saw the short shared projection and waited one poll");
  assert.match(child.note, /projection 9000 MiB/);
});

test("W1-T15179 criterion 3: with no live static record the projection is unchanged, and an ended holder frees its charge", (t) => {
  const root = mkdtempSync(join(tmpdir(), "rmd-t15179-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const withoutReader = ports(0, {}, false, root);
  delete withoutReader.readStaticWork;
  const baseline = projected(withoutReader, root);
  assert.deepEqual(projected(ports(0, {}, false, root), root), baseline);
  const foreignDir = mkdtempSync(join(tmpdir(), "rmd-t15179-foreign-"));
  t.after(() => rmSync(foreignDir, { recursive: true, force: true }));
  const foreign = join(foreignDir, "static-00000000-0000-4000-8000-000000000001.json");
  writeFileSync(foreign, JSON.stringify({ pid: 7, host: hostname(), bootId: "same-boot", pidNs: "ns-foreign",
    processStart: "proc:12345", startedAt: new Date().toISOString(), heartbeatAt: new Date().toISOString(),
    label: "typecheck:foreign-ended", memoryBytes: 4400 * MIB, admittedAt: new Date().toISOString() }));
  const reconciled = readLiveStaticWork({ dir: foreignDir, hostname: () => hostname(), bootId: () => "same-boot",
    pidNamespace: () => "ns-daemon", isPidAlive: () => true,
    processStartScan: () => ({ complete: true, starts: new Set() }) });
  assert.deepEqual(reconciled, { records: [] }, "a complete initial-namespace scan releases an ended foreign holder");
  const dead = join(root, "static-00000000-0000-4000-8000-000000000000.json");
  writeFileSync(dead, JSON.stringify({ pid: 2 ** 22 - 3, host: hostname(), startedAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(), label: "typecheck:ended", memoryBytes: 4400 * MIB, admittedAt: new Date().toISOString() }));
  t.after(() => rmSync(dead, { force: true }));
  assert.deepEqual(projected(ports(0, {}, false, root), root), baseline);
});

test("W1-T15179 criterion 4: rss already out of MemAvailable is never charged twice", (t) => {
  const root = mkdtempSync(join(tmpdir(), "rmd-t15179-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = mkdtempSync(join(tmpdir(), "rmd-t15179-slots-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const slot = admitStaticWork("typecheck:criterion-4", { dir, memoryBytes: 4400 * MIB, memoryHeadroom: () => 64 * 1024 * MIB, log: () => {} });
  t.after(() => slot.release());
  assert.equal(projected(ports(5000 * 1024, {}, false, dir), root).staticWorkChargeMib, 0, "a tree past its peak claims nothing more");
  // The daemon's own main process is measured by its growth, never as the stage's tree: the stage claims its whole peak.
  assert.equal(projected(ports(5000 * 1024, { daemonPid: () => process.pid }, false, dir), root).staticWorkChargeMib, 4400);
});

test("W1-T15179: a sandbox holder is resolved by kernel start and daemon records own distinct tsc trees", (t) => {
  const root = mkdtempSync(join(tmpdir(), "rmd-t15179-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = mkdtempSync(join(tmpdir(), "rmd-t15179-slots-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const base = ports(0, {}, false, dir), pid = process.pid;
  const read = base.readFile;
  const proc = new Map<number, { parent: number; start: string; rss: number }>([
    [910011, { parent: pid, start: "proc:1100", rss: 100 * 1024 }],
    [910012, { parent: pid, start: "proc:1200", rss: 200 * 1024 }],
  ]);
  const records = [910011, 910012].map((child, index) => ({ name: `static-${index}`, label: `typecheck:parallel-${index}`,
    pid, memoryBytes: 4400 * MIB, admitted: true }));
  const procPort = {
    ...base,
    listProc: () => [String(pid), "910011", "910012"],
    daemonPid: () => pid,
    readStaticWork: () => ({ records }),
    readFile: (path: string) => {
      const childMatch = /^\/proc\/(910011|910012)\/(stat|status|cmdline)$/.exec(path);
      if (childMatch) {
        const child = Number(childMatch[1]), item = proc.get(child)!;
        if (childMatch[2] === "stat") return statLine(child, item.parent, item.start);
        if (childMatch[2] === "status") return `VmRSS:\t${item.rss} kB\nVmSwap:\t0 kB\n`;
        return `node\0/usr/lib/node_modules/typescript/bin/tsc\0`;
      }
      return read(path);
    },
  };
  const gathered = gatherShadowInputs({ workerClass: "implement", root, estimateMib: 0 }, procPort, POLICY);
  assert.deepEqual(gathered.staticWork, { records: [
    { label: "typecheck:parallel-0", peakMib: 4400, treeMib: 100, chargeMib: 4300, basis: "peak 4400 MiB less 100 MiB its tree holds" },
    { label: "typecheck:parallel-1", peakMib: 4400, treeMib: 200, chargeMib: 4200, basis: "peak 4400 MiB less 200 MiB its tree holds" },
  ] });
  const measured = projected(procPort, root);
  assert.equal(measured.staticWorkStages, 2);
  assert.equal(measured.staticWorkChargeMib, 8500, "each record subtracts only its own tsc child's resident RSS");
  const foreign = projected({ ...procPort, readStaticWork: () => ({ records: [{ name: "static-foreign", label: "typecheck:sandbox",
    pid: 77, processStart: "proc:1100", memoryBytes: 4400 * MIB, admitted: true }] }) }, root);
  assert.equal(foreign.staticWorkChargeMib, 4300, "foreign namespace pid 77 resolves to host pid 910011 by kernel start");
});
