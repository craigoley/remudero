/**
 * W1-T13658 — A FINISHED RESERVATION'S INCOMPLETE-WALK HOLD ENDS ONCE ITS TREE IS VERIFIED GONE.
 *
 * OBSERVED 2026-11-18: from 06:28Z every `dispatch.lane_target` row read target 1, binding host. 57 finished reservations
 * carried holdReason incomplete-process-walk, every walk read complete, and each sweep re-applied the hold because the
 * entry already carried it, so only a container recycle could end it. Each one widened the shadow budget by the margin
 * (uncertain-entry), and their gone trees spent the shared process budget (tree-partial): margin 22,784 MiB at 11:08Z.
 *
 * Every case runs the real ledger, shadow and governor over an in-memory ledger directory, an injected process listing
 * and probe (as test/a-memory-reservation-is-released-only-when-its-whole-tree-is-gone.test.ts injects them), and
 * injected /proc reads, so nothing here reads the Mac's own /proc. The entry shapes are the host's own 11:19Z copies.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { fixedClock } from "#src/lib/clock.js";
import {
  readMemoryLedger,
  sweepMemoryReservations,
  type HostMemoryLedgerOptions,
  type MemoryReservationEntry,
  type ProbeResult,
} from "#src/lib/host-memory-ledger.js";
import {
  defaultShadowMemoryPorts,
  evaluateShadowMemory,
  gatherShadowInputs,
  type HostMemoryBudgetPolicy,
  type ShadowMemoryPorts,
  type ShadowVerdict,
} from "#src/lib/host-memory-shadow.js";
import { laneTarget, laneTargetPayload, readLaneMemory } from "#src/lib/lane-governor.js";

const GENERATION = { containerId: "38061d49497d", initStart: "proc:22123231" };
const NOW = Date.parse("2026-11-18T11:19:49.600Z");
const MIB_KB = 1024;
const MARGIN = 256;

const POLICY: HostMemoryBudgetPolicy = {
  mode: "shadow",
  hostReserveMib: 2048,
  containerReserveMib: 1024,
  swapInPagesPerSecMax: 256,
  psiSomeAvg10Max: 10,
  psiFullAvg10Max: 2,
  serveColdStartReserveMib: 7680,
  uncertaintyMarginMib: MARGIN,
  daemonGrowthUnmeasuredMib: 1024,
  daemonGrowthMinSamples: 6,
  staleReadingMs: 600_000,
};

/** The host's 11:19Z copy of one of the 57: a finished test run whose two processes exited hours earlier. */
function heldTestEntry(): MemoryReservationEntry {
  return {
    schema: 1, id: "state2-148-1e575bbf-0aca-4cee-a86c-239246b97597", instance: "state2", instanceHostUnique: true,
    generation: { ...GENERATION }, owner: { pid: 148, start: "proc:22123342" }, workerClass: "test",
    estimateMib: 1664, estimateSource: { kind: "measured", samples: 171 },
    openedAt: "2026-11-18T05:02:58.594Z", verifiedAt: "2026-11-18T11:19:49.577Z",
    roots: [{ pid: 189904, start: "proc:22449741" }],
    tree: [{ pid: 189904, start: "proc:22449741" }, { pid: 189943, start: "proc:22449750" }],
    occupancyReleasedAt: "2026-11-18T05:03:23.354Z",
    walk: { at: "2026-11-18T11:19:49.577Z", complete: true },
    holdReason: "incomplete-process-walk",
  };
}

/** The shape of the largest of the 57 (an implement tree of 3,055 identities), cut to 1,100: past the shared budget. */
function heldImplementEntry(): MemoryReservationEntry {
  const tree = Array.from({ length: 1_100 }, (_, i) => ({ pid: 1_000_000 + i, start: `proc:${22267452 + i}` }));
  return {
    schema: 1, id: "state2-614802-0021622b-643d-4cde-8c8f-45b41676a5f4", instance: "state2", instanceHostUnique: true,
    generation: { ...GENERATION }, owner: { pid: 614802, start: "proc:22900000" }, workerClass: "implement",
    estimateMib: 4995, estimateSource: { kind: "measured", samples: 40 },
    openedAt: "2026-11-18T04:32:33.000Z", verifiedAt: "2026-11-18T11:19:49.590Z",
    roots: [tree[0]!], tree, occupancyReleasedAt: "2026-11-18T07:49:26.000Z",
    walk: { at: "2026-11-18T11:19:49.590Z", complete: true }, holdReason: "incomplete-process-walk",
  };
}

/** The host's 11:19Z copy of a live entry the sweeping daemon (1569857) opened after its restart. */
function liveTestEntry(): MemoryReservationEntry {
  return {
    schema: 1, id: "state2-1569857-e17f00bb-7bd8-46ff-b853-fbb7b4299797", instance: "state2", instanceHostUnique: true,
    generation: { ...GENERATION }, owner: { pid: 1569857, start: "proc:24013107" }, workerClass: "test",
    estimateMib: 1145, estimateSource: { kind: "measured", samples: 163 },
    openedAt: "2026-11-18T11:19:49.514Z", verifiedAt: "2026-11-18T11:19:49.593Z",
    roots: [{ pid: 2575494, start: "proc:24710520" }],
    tree: [{ pid: 2575494, start: "proc:24710520" }, { pid: 2575507, start: "proc:24710524" }],
    walk: { at: "2026-11-18T11:19:49.593Z", complete: true },
  };
}

interface Proc { parent: number; start: string; rssKb?: number; swapKb?: number }

/** One container: tini as pid 1, the supervisor bash its only child at rest (as the host's process table read at
 *  13:04Z), and the daemon that sweeps under the supervisor. */
function container(entries: MemoryReservationEntry[]) {
  const dir = `/host-memory/${randomUUID()}`;
  const files = new Map<string, string>([[`${dir}/.ledger-id`, `${randomUUID()}\n`]]);
  for (const entry of entries) files.set(`${dir}/${entry.id}.json`, `${JSON.stringify(entry)}\n`);
  const procs = new Map<number, Proc>([
    [1, { parent: 0, start: GENERATION.initStart }],
    [7, { parent: 1, start: "proc:22123240" }],
    [1569857, { parent: 7, start: "proc:24013107" }],
  ]);
  const walk = { complete: true };
  const probe = (pid: number): ProbeResult => {
    const proc = procs.get(pid);
    return proc ? { state: "alive", start: proc.start } : { state: "gone" };
  };
  const deps = (over: HostMemoryLedgerOptions = {}): HostMemoryLedgerOptions => ({
    location: () => ({ dir, scope: "host" }),
    instance: () => ({ name: "state2", hostUnique: true }),
    generation: () => ({ ...GENERATION }),
    probe,
    listProcesses: () => ({
      rows: [...procs].map(([pid, p]) => ({ pid, parent: p.parent, start: p.start })),
      complete: walk.complete, ...(walk.complete ? {} : { reason: "time bound 250ms" }),
    }),
    write: (path, content) => void files.set(path, content),
    read: (path) => {
      const content = files.get(path);
      if (content === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
      return content;
    },
    list: (at) => [...files.keys()].filter((key) => key.startsWith(`${at}/`)).map((key) => key.slice(at.length + 1)),
    remove: (path) => void files.delete(path),
    createSentinel: (path, content) => {
      if (files.has(path)) throw Object.assign(new Error(`EEXIST: ${path}`), { code: "EEXIST" });
      files.set(path, content);
    },
    clock: fixedClock(NOW),
    log: () => undefined,
    ownerPid: 1569857,
    ...over,
  });
  const onDisk = (id: string): MemoryReservationEntry | undefined => {
    const content = files.get(`${dir}/${id}.json`);
    return content === undefined ? undefined : JSON.parse(content) as MemoryReservationEntry;
  };
  /** What the shadow reads: the entry files, plus /proc for every live process, plus the host's cgroup and meminfo. */
  const readFile = (unreadable: ReadonlySet<string> = new Set()) => (path: string): string => {
    if (unreadable.has(path)) throw Object.assign(new Error(`EACCES: ${path}`), { code: "EACCES" });
    const ledger = files.get(path);
    if (ledger !== undefined) return ledger;
    const proc = /^\/proc\/(\d+)\/(stat|status)$/.exec(path);
    if (proc) {
      const pid = Number(proc[1]);
      const p = procs.get(pid);
      if (p && proc[2] === "stat") return `${pid} (node) S ${p.parent} ${pid} ${pid} 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 ${p.start.slice(5)} 0 0`;
      if (p) return `Name:\tnode\nVmRSS:\t${p.rssKb ?? 0} kB\nVmSwap:\t${p.swapKb ?? 0} kB\n`;
    }
    const host = HOST_FILES[path];
    if (host !== undefined) return host;
    throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
  };
  return { dir, files, procs, walk, deps, onDisk, readFile };
}

const MIB = 1024 * 1024;
const PSI = "some avg10=0.00 avg60=0.00 avg300=0.00 total=0\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n";
/** The 11:08Z host: MemAvailable 17,501 MiB, a container under memory.high. */
const HOST_FILES: Record<string, string> = {
  "/sys/fs/cgroup/memory.current": String(9000 * MIB),
  "/sys/fs/cgroup/memory.max": String(26000 * MIB),
  "/sys/fs/cgroup/memory.high": String(23585 * MIB),
  "/sys/fs/cgroup/memory.swap.current": "0",
  "/sys/fs/cgroup/memory.stat": `anon ${8000 * MIB}\nfile ${1000 * MIB}\ninactive_file ${500 * MIB}\npswpin 0\n`,
  "/sys/fs/cgroup/memory.events": "low 0\nhigh 0\nmax 0\noom 0\noom_kill 0\n",
  "/sys/fs/cgroup/memory.pressure": PSI,
  "/proc/pressure/memory": PSI,
  "/proc/meminfo": `MemTotal: 32000000 kB\nMemAvailable: ${17501 * 1024} kB\n`,
};

/** The shadow's ports over one container, as the daemon's real reading builds them, with every read injected. */
function shadowPorts(c: ReturnType<typeof container>, unreadable?: ReadonlySet<string>): Partial<ShadowMemoryPorts> {
  return {
    clock: fixedClock(NOW),
    policy: () => POLICY,
    readLedger: () => readMemoryLedger(c.deps()),
    readFile: c.readFile(unreadable),
    readTail: () => "",
    readHostServe: undefined,
    listStateDir: () => [],
    daemonPid: () => undefined,
    instance: () => "state2",
    estimate: () => 4995,
    typical: () => 1200,
    survival: undefined,
    writeFile: () => undefined,
  };
}

function verdictOf(c: ReturnType<typeof container>, unreadable?: ReadonlySet<string>): ShadowVerdict {
  const root = mkdtempSync(join(tmpdir(), "rmd-w1-t13658-"));
  try {
    const ports = { ...defaultShadowMemoryPorts(), ...shadowPorts(c, unreadable) } as ShadowMemoryPorts;
    return evaluateShadowMemory(gatherShadowInputs({ workerClass: "implement", root, estimateMib: 0 }, ports, POLICY), POLICY);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const widened = (verdict: ShadowVerdict, kind: string): number =>
  verdict.uncertainty.find((u) => u.kind === kind)?.marginMib ?? 0;

test("W1-T13658 criterion 1: a finished entry held for an incomplete walk is released as tree-gone-after-gap once a complete walk finds its tree gone and no orphan", () => {
  const held = heldTestEntry();
  const c = container([held]);
  const swept = sweepMemoryReservations(c.deps());
  assert.deepEqual(swept?.released, [{ id: held.id, rule: "tree-gone-after-gap" }],
    "every recorded identity is gone, the listing is complete and nothing has been reparented to tini since the root");
  assert.equal(c.onDisk(held.id), undefined, "the released entry's file is removed");
  assert.equal(swept?.reading.counts.uncertain, 0, "no entry is left uncertain");
});

test("W1-T13658 criterion 1: an orphan is only a live child of the reaper started since the root and held by no live entry", () => {
  const held = heldTestEntry();
  const live = liveTestEntry();
  // A live entry whose owner is a tini child started after the held root, holding nothing yet.
  const ownerOnly: MemoryReservationEntry = { ...liveTestEntry(), id: "state2-2600100-owner-only", owner: { pid: 2600100, start: "proc:24700000" },
    roots: [], tree: [], walk: { at: "2026-11-18T11:19:49.593Z", complete: true } };
  const c = container([held, live, ownerOnly]);
  c.procs.set(2575494, { parent: 1, start: "proc:24710520" }); // the live entry's root, reparented to tini: in its tree
  c.procs.set(2575507, { parent: 2575494, start: "proc:24710524" });
  c.procs.set(2600100, { parent: 1, start: "proc:24700000" }); // a live entry's owner
  c.procs.set(40, { parent: 1, start: "proc:22300000" }); // reparented before the held root started: not its descendant
  const swept = sweepMemoryReservations(c.deps());
  assert.deepEqual(swept?.released, [{ id: held.id, rule: "tree-gone-after-gap" }]);
  assert.ok(c.onDisk(live.id) && c.onDisk(ownerOnly.id), "the live entries stay");
});

test("W1-T13658 criterion 2: a surviving orphan keeps the hold, is recorded on the entry, and the hold ends when it exits", () => {
  const held = heldTestEntry();
  const c = container([held]);
  c.procs.set(2_600_000, { parent: 1, start: "proc:22449800", rssKb: 30 * MIB_KB, swapKb: 2 * MIB_KB });
  c.procs.set(2_600_001, { parent: 2_600_000, start: "proc:22449900", rssKb: 4 * MIB_KB });
  const swept = sweepMemoryReservations(c.deps());
  assert.deepEqual(swept?.released, [], "a process reparented to tini after the root may be the tree's: held");
  const kept = c.onDisk(held.id) as MemoryReservationEntry & { orphans?: unknown };
  assert.equal(kept.holdReason, "incomplete-process-walk");
  assert.deepEqual(kept.orphans, [{ pid: 2_600_000, start: "proc:22449800" }, { pid: 2_600_001, start: "proc:22449900" }],
    "the orphan and its descendant are recorded as the entry's identities");
  assert.equal(swept?.reading.entries[0]?.status, "uncertain");

  c.procs.delete(2_600_001);
  c.procs.delete(2_600_000);
  assert.deepEqual(sweepMemoryReservations(c.deps())?.released.map((r) => r.rule), ["tree-gone-after-gap"], "once the orphans exit, it heals");
});

test("W1-T13658 criterion 2: the shadow charges a held, finished entry its orphans' measured rss plus swap, at most the margin", () => {
  const c = container([heldTestEntry()]);
  c.procs.set(2_600_000, { parent: 1, start: "proc:22449800", rssKb: 30 * MIB_KB, swapKb: 2 * MIB_KB });
  c.procs.set(2_600_001, { parent: 2_600_000, start: "proc:22449900", rssKb: 4 * MIB_KB });
  sweepMemoryReservations(c.deps());
  const measured = verdictOf(c);
  assert.equal(widened(measured, "uncertain-entry"), 36, "30 MiB rss + 2 MiB swap + 4 MiB rss, in place of the 256 MiB margin");
  assert.equal(widened(measured, "tree-partial"), 0);

  c.procs.set(2_600_000, { parent: 1, start: "proc:22449800", rssKb: 900 * MIB_KB });
  assert.equal(widened(verdictOf(c), "uncertain-entry"), MARGIN, "never more than the margin: 900 MiB measured, 256 charged");
});

test("W1-T13658 criterion 2: a gone tree past the shared process budget stops spending it, so neither widening charges the margin", () => {
  const big = heldImplementEntry();
  const live = liveTestEntry();
  const c = container([big, live]);
  c.procs.set(2575494, { parent: 1569857, start: "proc:24710520", rssKb: 100 * MIB_KB });
  c.procs.set(2575507, { parent: 2575494, start: "proc:24710524", rssKb: 50 * MIB_KB });
  c.procs.set(2_600_000, { parent: 1, start: "proc:22300000", rssKb: 10 * MIB_KB }); // escaped after the big root
  sweepMemoryReservations(c.deps());
  assert.ok((c.onDisk(big.id) as { orphans?: unknown[] }).orphans?.length === 1, "the big entry is held for its one orphan");
  const verdict = verdictOf(c);
  assert.equal(widened(verdict, "tree-partial"), 0, "its 1,100 gone identities no longer exhaust the 1,024-process budget");
  assert.equal(widened(verdict, "uncertain-entry"), 10, "its orphan's 10 MiB, in place of the margin");
});

test("W1-T13658 criterion 2: an unread or partial orphan reading keeps the full margin", () => {
  const held = heldTestEntry();
  const c = container([held]);
  c.procs.set(2_600_000, { parent: 1, start: "proc:22449800", rssKb: 30 * MIB_KB });
  sweepMemoryReservations(c.deps());
  assert.equal(widened(verdictOf(c), "uncertain-entry"), 30, "control: the same orphan, read, is charged what it measures");
  const partial = verdictOf(c, new Set(["/proc/2600000/stat", "/proc/2600000/status"]));
  assert.equal(widened(partial, "uncertain-entry"), MARGIN, "an orphan whose /proc cannot be read: the full margin");
  const unread = verdictOf(c, new Set([`${c.dir}/${held.id}.json`]));
  assert.ok(unread.uncertainty.some((u) => u.kind === "tree-unread"), "the shadow could not read the entry file");
  assert.equal(widened(unread, "uncertain-entry"), MARGIN, "an unread orphan reading: the full margin");
});

test("W1-T13658 criterion 3: each dispatch.lane_target row carries the host numbers its bound was cut from, null when unread", () => {
  const memory = {
    containerBaseMib: 9000, containerOnsetMib: 23585, containerArmCounts: true, containerBasis: "test",
    hostBaseAvailableMib: -7360.6169105802, hostReserveMib: 2048, perLaneMib: 4995.4, containerPressed: false,
  };
  const row = laneTargetPayload(laneTarget({ previous: { target: 1 }, inFlight: 0, cpuCount: 8, memory }),
    { mode: "enforce", fixed: 3, inFlight: 0 });
  assert.deepEqual([row.target, row.binding, row.host_base_available_mib, row.host_reserve_mib, row.per_lane_mib],
    [1, "host", -7361, 2048, 4995], "the 11:08Z floor: the target is cut from a projection of -7,361 MiB");
  const unread = laneTargetPayload(laneTarget({ inFlight: 0, cpuCount: 8, memory: { unread: "EACCES" } }),
    { mode: "enforce", fixed: 3, inFlight: 0 });
  assert.deepEqual([unread.host_base_available_mib, unread.host_reserve_mib, unread.per_lane_mib], [null, null, null]);
  assert.ok(["host_base_available_mib", "host_reserve_mib", "per_lane_mib"].every((key) => key in unread), "present as null");

  const c = container([heldTestEntry()]);
  sweepMemoryReservations(c.deps());
  const root = mkdtempSync(join(tmpdir(), "rmd-w1-t13658-lane-"));
  try {
    const reading = readLaneMemory(root, shadowPorts(c));
    const real = laneTargetPayload(laneTarget({ inFlight: 0, cpuCount: 8, memory: reading }), { mode: "enforce", fixed: 3, inFlight: 0 });
    assert.equal(real.host_base_available_mib, Math.round(reading.hostBaseAvailableMib!));
    assert.equal(real.host_reserve_mib, 2048);
    assert.equal(real.per_lane_mib, 4995);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T13658 criterion 4: invariant:a-live-or-unwalked-tree-stays-held", () => {
  const cases: Array<[string, (c: ReturnType<typeof container>, entry: MemoryReservationEntry) => HostMemoryLedgerOptions | void]> = [
    ["a live recorded identity", (c) => void c.procs.set(189943, { parent: 1, start: "proc:22449750" })],
    ["an incomplete current walk", (c) => { c.walk.complete = false; }],
    ["an occupancy that has not ended", (c, entry) => {
      delete entry.occupancyReleasedAt;
      entry.owner = { pid: 1569857, start: "proc:24013107" };
    }],
    ["a root start that cannot be compared", (_c, entry) => {
      entry.roots = [{ pid: 189904, start: "ps:Wed Nov 18 05:02:58 2026" }];
      entry.tree = [...entry.roots];
    }],
    ["an orphan candidate whose start cannot be compared", (c) => void c.procs.set(2_600_000, { parent: 1, start: "ps:Wed Nov 18 06:00:00 2026" })],
    ["an identity whose state is unknown", (c) => ({
      probe: (pid: number): ProbeResult => (pid === 189943 ? { state: "unknown", reason: "EACCES" }
        : c.procs.has(pid) ? { state: "alive", start: c.procs.get(pid)!.start } : { state: "gone" }),
    })],
  ];
  for (const [name, arrange] of cases) {
    const entry = heldTestEntry();
    const c = container([]);
    const over = arrange(c, entry);
    c.files.set(`${c.dir}/${entry.id}.json`, `${JSON.stringify(entry)}\n`);
    const swept = sweepMemoryReservations(c.deps(over ?? {}));
    assert.deepEqual(swept?.released, [], `${name}: never released`);
    assert.equal(c.onDisk(entry.id)?.holdReason, "incomplete-process-walk", `${name}: still held`);
  }

  // A verified end of the owning container generation still releases, even with a live orphan.
  const c = container([heldTestEntry()]);
  c.procs.set(2_600_000, { parent: 1, start: "proc:22449800" });
  sweepMemoryReservations(c.deps());
  const recycled = sweepMemoryReservations(c.deps({ generation: () => ({ containerId: "4f0c2a9e11b7", initStart: "proc:25000000" }) }));
  assert.deepEqual(recycled?.released.map((r) => r.rule), ["generation-ended"]);
});
