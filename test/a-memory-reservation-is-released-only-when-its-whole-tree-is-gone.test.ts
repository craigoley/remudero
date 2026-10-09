// W1-T7093: a host memory reservation is released only when its whole tree is verified gone.
//
// Every case runs the ledger over an in-memory directory and a fake process table, so each outcome
// is a state only the ledger writes (a file present or removed, a reading's status). The last cases
// use the real /proc, filesystem and a real child process, so the default seams are exercised too.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  defaultInstance,
  defaultListProcesses,
  defaultProbe,
  openMemoryReservation,
  parseProcStat,
  readMemoryLedger,
  sweepMemoryReservations,
  UNVERIFIED_AFTER_MS,
  type ContainerGeneration,
  type HostMemoryLedgerOptions,
  type LedgerInstance,
} from "../src/lib/host-memory-ledger.js";
import { activeWorkerCount, withWorkerOccupancy } from "../src/lib/worker.js";
import { fixedClock } from "../src/lib/clock.js";
import { acquireTestSlot } from "../src/lib/test-slot.js";

const OWNER = 100;

function world() {
  const files = new Map<string, string>();
  const dir = `/ledger/${randomUUID()}`;
  const procs = new Map<number, { start: string; parent: number }>([[OWNER, { start: "proc:10", parent: 1 }]]);
  const clock = { now: Date.parse("2026-10-09T00:00:00Z") };
  const logs: Array<Record<string, unknown>> = [];
  const deps = (over: HostMemoryLedgerOptions & { gen?: ContainerGeneration; inst?: LedgerInstance } = {}): HostMemoryLedgerOptions => ({
    location: () => ({ dir, scope: "host" }),
    instance: () => over.inst ?? { name: "core", hostUnique: true },
    generation: () => over.gen ?? { containerId: "c1", initStart: "proc:1" },
    probe: (pid) => {
      const proc = procs.get(pid);
      return proc ? { state: "alive", start: proc.start } : { state: "gone" };
    },
    listProcesses: () => ({ rows: [...procs].map(([pid, p]) => ({ pid, parent: p.parent, start: p.start })), complete: true }),
    write: (path, content) => void files.set(path, content),
    read: (path) => {
      const content = files.get(path);
      if (content === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
      return content;
    },
    list: (dir) => [...files.keys()].filter((key) => key.startsWith(`${dir}/`)).map((key) => key.slice(dir.length + 1)),
    remove: (path) => void files.delete(path),
    createSentinel: (path, content) => {
      if (files.has(path)) throw Object.assign(new Error(`EEXIST: ${path}`), { code: "EEXIST" });
      files.set(path, content);
    },
    clock: {
      now: () => clock.now,
      date: () => new Date(clock.now),
      iso: () => new Date(clock.now).toISOString(),
    },
    log: (event) => void logs.push(event),
    ownerPid: OWNER,
    ...over,
  });
  return { files, procs, clock, logs, dir, deps };
}

function reservationContents(w: ReturnType<typeof world>): string[] {
  return [...w.files].filter(([path]) => path.endsWith(".json")).map(([, content]) => content);
}

function reservationCount(w: ReturnType<typeof world>): number {
  return reservationContents(w).length;
}

function firstReservation(w: ReturnType<typeof world>): any {
  return JSON.parse(reservationContents(w)[0]!);
}

test("reservation timestamps and foreign-entry ages follow the injected Clock", () => {
  const w = world();
  const openedAt = Date.parse("2026-10-10T00:00:00Z");
  const deps = w.deps({ clock: fixedClock(openedAt) });
  const handle = openMemoryReservation({ workerClass: "review" }, deps);
  assert.equal(firstReservation(w).openedAt, "2026-10-10T00:00:00.000Z");
  w.procs.set(200, { start: "proc:20", parent: OWNER });
  handle.bindRoot(200);
  handle.releaseOccupancy();
  assert.equal(firstReservation(w).occupancyReleasedAt, "2026-10-10T00:00:00.000Z");

  const verifiedAt = openedAt + 1_000;
  sweepMemoryReservations(w.deps({ clock: fixedClock(verifiedAt) }));
  const entry = firstReservation(w);
  assert.equal(entry.verifiedAt, "2026-10-10T00:00:01.000Z");
  assert.equal(entry.walk.at, entry.verifiedAt);
  const foreign = w.deps({
    clock: fixedClock(verifiedAt + UNVERIFIED_AFTER_MS + 1),
    gen: { containerId: "c2", initStart: "proc:1" },
    inst: { name: "site", hostUnique: true },
  });
  const reading = readMemoryLedger(foreign)?.entries[0];
  assert.equal(reading?.ageMs, 1_000 + UNVERIFIED_AFTER_MS + 1);
  assert.equal(reading?.sinceVerifiedMs, UNVERIFIED_AFTER_MS + 1);
  assert.equal(reading?.status, "uncertain");
  assert.equal(reservationCount(w), 1);
});

test("the real process walk uses the injected Clock for its deadline", { skip: !existsSync("/proc/self/stat") }, () => {
  let reads = 0;
  const clock = { ...fixedClock(0), now: () => reads++ * 1_001 };
  assert.deepEqual(defaultListProcesses({ maxEntries: 100_000, maxMs: 1_000 }, clock), {
    rows: [], complete: false, reason: "time bound 1000ms",
  });
  const w = world();
  reads = 0;
  const deps = w.deps({ clock, listProcesses: undefined, limits: { maxEntries: 100_000, maxMs: 1_000 } });
  openMemoryReservation({ workerClass: "review" }, deps);
  assert.equal(sweepMemoryReservations(deps)?.reading.counts.incompleteWalk, 1);
  assert.equal(firstReservation(w).walk.reason, "time bound 1000ms");
});

test("the process walk treats only ENOENT as a process-exit race; other stat read errors make it incomplete", { skip: !existsSync("/proc/self/stat") }, () => {
  const limits = { maxEntries: 100_000, maxMs: 60_000 };
  const ownStat = `/proc/${process.pid}/stat`;
  const unreadable = defaultListProcesses(limits, undefined, (path) => {
    if (path === ownStat) throw Object.assign(new Error("permission denied"), { code: "EACCES" });
    return readFileSync(path, "utf8");
  });
  assert.equal(unreadable.complete, false);
  assert.match(unreadable.reason ?? "", new RegExp(`process ${process.pid} stat unreadable`));

  const exited = defaultListProcesses(limits, undefined, (path) => {
    if (path === ownStat) throw Object.assign(new Error("process exited"), { code: "ENOENT" });
    return readFileSync(path, "utf8");
  });
  assert.equal(exited.complete, true, "a process that vanished after readdir does not poison the whole walk");
});

test("a reservation survives its root's exit while a recorded descendant lives, and is released once every recorded (pid, start time) is gone", () => {
  const w = world();
  const handle = openMemoryReservation({ workerClass: "implement" }, w.deps());
  w.procs.set(200, { start: "proc:20", parent: OWNER });
  handle.bindRoot(200);
  w.procs.set(300, { start: "proc:30", parent: 200 });
  sweepMemoryReservations(w.deps()); // the walk records the grandchild as (300, proc:30)
  const recorded = firstReservation(w);
  assert.deepEqual(recorded.tree, [{ pid: 200, start: "proc:20" }, { pid: 300, start: "proc:30" }]);
  assert.equal(recorded.estimateMib, 2048);
  assert.deepEqual(recorded.estimateSource, { kind: "default-unmeasured" });
  assert.deepEqual(recorded.generation, { containerId: "c1", initStart: "proc:1" });

  w.procs.delete(200);
  w.procs.set(300, { start: "proc:30", parent: 1 }); // reparented to init: ancestry alone no longer attributes it
  handle.releaseOccupancy();
  assert.equal(reservationCount(w), 1, "a live recorded descendant holds the reservation after its root exits");

  w.procs.delete(300);
  const swept = sweepMemoryReservations(w.deps());
  assert.deepEqual(swept?.released.map((r) => r.rule), ["tree-gone"]);
  assert.equal(reservationCount(w), 0);
});

test("an incomplete tree walk cannot release after its root exits before omitted descendants are recorded", () => {
  const w = world();
  const handle = openMemoryReservation({ workerClass: "implement" }, w.deps());
  w.procs.set(200, { start: "proc:20", parent: OWNER });
  w.procs.set(300, { start: "proc:30", parent: 200 });
  handle.bindRoot(200);
  handle.releaseOccupancy();

  const incomplete = w.deps({
    listProcesses: () => ({ rows: [{ pid: 200, parent: OWNER, start: "proc:20" }], complete: false, reason: "entry bound" }),
  });
  sweepMemoryReservations(incomplete);
  assert.equal(firstReservation(w).holdReason, "incomplete-process-walk");

  w.procs.delete(200);
  w.procs.set(300, { start: "proc:30", parent: 1 }); // omitted descendant has already been reparented
  sweepMemoryReservations(w.deps());
  assert.equal(firstReservation(w).holdReason, "incomplete-process-walk");
  w.procs.delete(300);
  assert.equal(sweepMemoryReservations(w.deps())?.released.length, 0, "we cannot prove the omitted tree was empty");
  assert.equal(reservationCount(w), 1);

  assert.deepEqual(
    sweepMemoryReservations(w.deps({ gen: { containerId: "c2", initStart: "proc:2" } }))?.released.map((r) => r.rule),
    ["generation-ended"],
    "a verified end of the owning container generation remains a valid release proof",
  );
});

test("a complete retry captures visible descendants but cannot erase an earlier incomplete ancestry gap", () => {
  const w = world();
  const handle = openMemoryReservation({ workerClass: "implement" }, w.deps());
  w.procs.set(200, { start: "proc:20", parent: OWNER });
  w.procs.set(300, { start: "proc:30", parent: 200 });
  handle.bindRoot(200);
  handle.releaseOccupancy();
  sweepMemoryReservations(w.deps({
    listProcesses: () => ({ rows: [{ pid: 200, parent: OWNER, start: "proc:20" }], complete: false, reason: "entry bound" }),
  }));

  sweepMemoryReservations(w.deps());
  assert.deepEqual(firstReservation(w).tree, [{ pid: 200, start: "proc:20" }, { pid: 300, start: "proc:30" }]);
  assert.equal(firstReservation(w).holdReason, "incomplete-process-walk", "a later snapshot cannot prove no child escaped during the gap");
  w.procs.delete(200);
  w.procs.set(300, { start: "proc:30", parent: 1 });
  assert.equal(sweepMemoryReservations(w.deps())?.released.length, 0, "the earlier incomplete ancestry gap remains fail-closed");
  w.procs.delete(300);
  assert.equal(sweepMemoryReservations(w.deps())?.released.length, 0, "unseen descendants cannot be ruled out, even after known identities exit");
});

test("a reused pid with a new start time does not hold a reservation", () => {
  const w = world();
  const handle = openMemoryReservation({ workerClass: "review" }, w.deps());
  w.procs.set(200, { start: "proc:20", parent: OWNER });
  handle.bindRoot(200);
  handle.releaseOccupancy();
  assert.equal(reservationCount(w), 1, "the root is still alive");
  w.procs.set(200, { start: "proc:999", parent: 1 }); // the same pid, a different process
  assert.deepEqual(sweepMemoryReservations(w.deps())?.released.map((r) => r.rule), ["tree-gone"]);
  assert.equal(reservationCount(w), 0);
});

test("a crashed worker whose tree is gone is released by its owner", () => {
  const w = world();
  const handle = openMemoryReservation({ workerClass: "fix" }, w.deps());
  w.procs.set(200, { start: "proc:20", parent: OWNER });
  handle.bindRoot(200);
  w.procs.delete(OWNER); // the daemon crashes: releaseOccupancy is never called
  const restarted = { ...w.deps(), ownerPid: 101 };
  w.procs.set(101, { start: "proc:11", parent: 1 });
  sweepMemoryReservations(restarted);
  assert.equal(reservationCount(w), 1, "the crashed worker's root is still alive");
  w.procs.delete(200);
  assert.deepEqual(sweepMemoryReservations(restarted)?.released.map((r) => r.rule), ["tree-gone"]);
});

test("a new container generation releases the previous generation's entries", () => {
  const w = world();
  for (let i = 0; i < 2; i += 1) {
    const handle = openMemoryReservation({ workerClass: "implement" }, w.deps());
    w.procs.set(200 + i, { start: `proc:2${i}`, parent: OWNER });
    handle.bindRoot(200 + i);
  }
  // A sibling container whose name is not host-unique is never mistaken for a previous generation.
  const sibling = sweepMemoryReservations(w.deps({ gen: { containerId: "c9", initStart: "proc:1" }, inst: { name: "core", hostUnique: false } }));
  assert.equal(sibling?.released.length, 0);
  const restarted = sweepMemoryReservations(w.deps({ gen: { containerId: "c1", initStart: "proc:2" } }));
  assert.deepEqual(restarted?.released.map((r) => r.rule), ["generation-ended", "generation-ended"]);
  assert.equal(reservationCount(w), 0);

  const handle = openMemoryReservation({ workerClass: "review" }, w.deps());
  handle.bindRoot(OWNER);
  const recycled = sweepMemoryReservations(w.deps({ gen: { containerId: "c2", initStart: "proc:1" } }));
  assert.deepEqual(recycled?.released.map((r) => r.rule), ["generation-ended"]);
});

test("a start that fails before spawning releases on occupancy release", () => {
  const w = world();
  const handle = openMemoryReservation({ workerClass: "implement" }, w.deps());
  sweepMemoryReservations(w.deps());
  assert.equal(reservationCount(w), 1, "an unbound reservation is held while its occupancy is");
  handle.releaseOccupancy();
  assert.equal(reservationCount(w), 0);
});

test("two overlapping starts get two distinct entries", () => {
  const w = world();
  const first = openMemoryReservation({ workerClass: "review" }, w.deps());
  const second = openMemoryReservation({ workerClass: "review" }, w.deps());
  assert.notEqual(first.id, second.id);
  assert.equal(reservationCount(w), 2);
  sweepMemoryReservations(w.deps()); // Establish the freshly-created sentinel before asserting ordinary release.
  first.releaseOccupancy();
  assert.equal(reservationCount(w), 1, "releasing one start leaves the other in place");
});

test("a missed heartbeat or old mtime never releases", () => {
  const w = world();
  const handle = openMemoryReservation({ workerClass: "implement", measured: { estimateMib: 3000, samples: 7 } }, w.deps());
  w.procs.set(200, { start: "proc:20", parent: OWNER });
  handle.bindRoot(200);
  handle.releaseOccupancy();
  w.clock.now += 7 * 24 * 3_600_000; // a week of missed heartbeats
  assert.equal(sweepMemoryReservations(w.deps())?.released.length, 0);
  assert.equal(sweepMemoryReservations(w.deps({ gen: { containerId: "c2", initStart: "proc:1" }, inst: { name: "site", hostUnique: true } }))?.released.length, 0);
  assert.equal(reservationCount(w), 1);
  const reading = readMemoryLedger(w.deps());
  assert.deepEqual(reading?.entries[0]?.estimateSource, { kind: "measured", samples: 7 });
  assert.equal(reading?.reservedMib, 3000);
});

test("another instance reports an unverifiable entry as uncertain and leaves it in place", () => {
  const w = world();
  const handle = openMemoryReservation({ workerClass: "implement" }, w.deps());
  w.procs.set(200, { start: "proc:20", parent: OWNER });
  handle.bindRoot(200);
  const site = w.deps({ gen: { containerId: "c2", initStart: "proc:1" }, inst: { name: "site", hostUnique: true } });
  assert.equal(readMemoryLedger(site)?.entries[0]?.status, "owner-verified");
  w.clock.now += UNVERIFIED_AFTER_MS + 1;
  const swept = sweepMemoryReservations(site);
  assert.equal(swept?.released.length, 0);
  assert.equal(reservationCount(w), 1);
  const entry = swept?.reading.entries[0];
  assert.equal(entry?.status, "uncertain");
  assert.equal(entry?.owner, "core@c1");
  assert.equal(entry?.ageMs, UNVERIFIED_AFTER_MS + 1);
  assert.equal(swept?.reading.counts.uncertain, 1);
  assert.equal(readMemoryLedger(w.deps())?.entries[0]?.status, "owned");
});

test("an owner that cannot read a recorded identity holds it as uncertain", () => {
  const w = world();
  const handle = openMemoryReservation({ workerClass: "implement" }, w.deps());
  w.procs.set(200, { start: "proc:20", parent: OWNER });
  handle.bindRoot(200);
  handle.releaseOccupancy();
  const blind = w.deps({ probe: (pid) => (pid === 200 ? { state: "unknown", reason: "EACCES" } : { state: "alive", start: "proc:10" }) });
  const swept = sweepMemoryReservations(blind);
  assert.equal(swept?.released.length, 0);
  assert.equal(swept?.reading.entries[0]?.status, "uncertain");
});

test("an incomplete walk is reported as incomplete, and a local directory as local scope", () => {
  const w = world();
  const local = w.deps({ location: () => ({ dir: w.dir, scope: "local" }), listProcesses: () => ({ rows: [], complete: false, reason: "time bound 250ms" }) });
  openMemoryReservation({ workerClass: "review" }, local);
  const reading = sweepMemoryReservations(local)?.reading;
  assert.equal(reading?.scope, "local");
  assert.deepEqual(reading?.counts, { live: 1, uncertain: 0, incompleteWalk: 1, localScope: 1, unreadable: 0 });
  const tornPath = join(w.dir, "torn.json");
  w.files.set(tornPath, "{");
  assert.equal(readMemoryLedger(local)?.counts.unreadable, 1);
  assert.equal(w.files.has(tornPath), true, "an unreadable entry is never released");
});

test("a throwing ledger write leaves the worker start unchanged", async () => {
  const w = world();
  const throwing = w.deps({ write: () => { throw new Error("EROFS: ledger read-only"); } });
  const before = activeWorkerCount();
  const result = await withWorkerOccupancy(async () => {
    assert.equal(activeWorkerCount(), before + 1);
    return "worker-result";
  }, { workerClass: "implement", ledger: throwing });
  assert.equal(result, "worker-result");
  assert.equal(activeWorkerCount(), before);
  assert.ok(w.logs.some((log) => log.event === "host_memory_ledger.diagnostic" && log.op === "open-write"));

  const broken = w.deps({ location: () => { throw new Error("no slot dir"); } });
  const handle = openMemoryReservation({ workerClass: "review" }, broken);
  assert.equal(handle.id, undefined);
  assert.doesNotThrow(() => { handle.bindRoot(1); handle.releaseOccupancy(); });
  assert.equal(sweepMemoryReservations(broken), undefined);
  assert.equal(readMemoryLedger(broken), undefined);
  const failure = await withWorkerOccupancy(async () => { throw new Error("worker boom"); }, { ledger: throwing }).catch((error: Error) => error.message);
  assert.equal(failure, "worker boom");
});

test("the real /proc seams bind a live child and release only after it exits", { skip: !existsSync("/proc/self/stat") }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-host-memory-"));
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  try {
    const deps: HostMemoryLedgerOptions = { location: () => ({ dir, scope: "local" }), root: "/nonexistent/Remudero", log: () => undefined };
    const handle = openMemoryReservation({ workerClass: "review" }, deps);
    handle.bindRoot(child.pid!);
    handle.releaseOccupancy();
    assert.deepEqual(readdirSync(dir).filter((name) => name.endsWith(".json")), [`${handle.id}.json`], "a live child holds the reservation");
    const sentinel = readFileSync(join(dir, ".ledger-id"), "utf8");
    const reading = readMemoryLedger(deps);
    assert.equal(reading?.entries[0]?.owner.startsWith("Remudero@"), true);
    child.kill("SIGKILL");
    await exited;
    assert.deepEqual(sweepMemoryReservations(deps)?.released.map((r) => r.rule), ["tree-gone"]);
    assert.deepEqual(readdirSync(dir), [".ledger-id"], "release removes the reservation and retains the ledger sentinel");
    assert.equal(readFileSync(join(dir, ".ledger-id"), "utf8"), sentinel);
    assert.equal(readMemoryLedger(deps)?.state, "present");
    assert.equal(readMemoryLedger(deps)?.entries.length, 0);
    assert.deepEqual(defaultProbe(child.pid!), { state: "gone" });
    assert.equal(defaultProbe(process.pid).state, "alive");
    assert.equal(defaultProbe(-1).state, "unknown");
    assert.equal(defaultListProcesses({ maxEntries: 0, maxMs: 1_000 }).complete, false);
    assert.equal(defaultListProcesses({ maxEntries: 100_000, maxMs: 60_000 }).rows.some((row) => row.pid === process.pid), true);
  } finally {
    child.kill("SIGKILL");
    await exited;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("process identity and instance parsing", () => {
  assert.deepEqual(parseProcStat("42 (a) b) S 7 42 42 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 98765 0 0"), { parent: 7, start: "proc:98765", zombie: false });
  assert.equal(parseProcStat("42 (x) Z 7 42 42 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 5 0")?.zombie, true);
  assert.equal(parseProcStat("garbage"), undefined);
  const mountinfo = "1 0 8:1 / / rw - ext4 /dev/sda1 rw\n36 1 8:1 /rmd/state-core /home/node/Remudero rw - ext4 /dev/sda1 rw";
  assert.deepEqual(defaultInstance("/home/node/Remudero", () => mountinfo), { name: "state-core", hostUnique: true });
  assert.deepEqual(defaultInstance("/home/node/Remudero", () => { throw new Error("ENOENT"); }), { name: "Remudero", hostUnique: false });
});

const processStat = (state = "S") => `42 (worker) ${state} 7 42 42 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 98765 0 0`;
const noProc = () => { throw Object.assign(new Error("proc unavailable"), { code: "ENOENT" }); };

test("a probe without proc verifies ESRCH through the real kernel pid check", () => {
  assert.deepEqual(defaultProbe(2_147_483_647, noProc), { state: "gone" });
});

test("a malformed proc read falls back to the real process facts for a live pid", () => {
  const expected = defaultProbe(process.pid);
  assert.equal(expected.state, "alive");
  assert.deepEqual(defaultProbe(process.pid, () => "malformed stat"), expected);
});

test("an EPERM pid check uses the fallback start identity rather than declaring termination", () => {
  const calls: number[] = [];
  const result = defaultProbe(
    42,
    noProc,
    (pid) => {
      calls.push(pid);
      throw Object.assign(new Error("different uid"), { code: "EPERM" });
    },
    (pid) => {
      calls.push(pid);
      return { parent: 7, start: "ps:Thu Oct 8 20:00:00 2026" };
    },
  );
  assert.deepEqual(calls, [42, 42]);
  assert.deepEqual(result, { state: "alive", start: "ps:Thu Oct 8 20:00:00 2026" });
});

test("an unreadable start identity remains unknown even when the pid check succeeds", () => {
  assert.deepEqual(defaultProbe(
    42,
    () => { throw Object.assign(new Error("permission denied"), { code: "EACCES" }); },
    () => undefined,
    () => undefined,
  ), { state: "unknown", reason: "start time unreadable" });
  assert.deepEqual(defaultProbe(42, () => processStat("Z")), { state: "gone" });
});

test("an unreadable proc directory reports an incomplete walk with its error", () => {
  const result = defaultListProcesses({ maxEntries: 100, maxMs: 100 }, fixedClock(0), undefined, () => {
    throw new Error("proc directory denied");
  });
  assert.deepEqual(result, { rows: [], complete: false, reason: "proc unreadable: proc directory denied" });
});

test("a process walk rejects malformed stats and excludes zombies from live rows", () => {
  const limits = { maxEntries: 100, maxMs: 100 };
  assert.deepEqual(defaultListProcesses(limits, fixedClock(0), () => "malformed", () => ["42"]), {
    rows: [], complete: false, reason: "process 42 stat unreadable",
  });
  assert.deepEqual(defaultListProcesses(limits, fixedClock(0), (path) => processStat(path.includes("/43/") ? "Z" : "S"),
    () => ["self", "42", "43"]), {
    rows: [{ pid: 42, parent: 7, start: "proc:98765" }], complete: true,
  });
});

test("a failed root binding write preserves the identity in memory and diagnoses the failure", () => {
  const w = world();
  let failWrite = false;
  const deps = w.deps({ write: (path, content) => {
    if (failWrite) throw new Error(`binding store full: ${w.dir}`);
    w.files.set(path, content);
  } });
  const handle = openMemoryReservation({ workerClass: "fix" }, deps);
  w.procs.set(200, { parent: OWNER, start: "proc:20" });
  failWrite = true;
  assert.doesNotThrow(() => handle.bindRoot(200));
  assert.equal(firstReservation(w).roots.length, 0, "the failed write left disk unchanged");
  assert.equal(readMemoryLedger(deps)?.reservedMib, 2048, "the failed binding remains reserved");
  assert.ok(w.logs.some((event) => event.op === "bind" && event.reason === `binding store full: ${w.dir}`));
  failWrite = false;
  sweepMemoryReservations(deps);
  assert.deepEqual(firstReservation(w).roots, [{ pid: 200, start: "proc:20" }]);
  handle.releaseOccupancy();
  assert.equal(reservationCount(w), 1, "the live bound root still holds memory");
  w.procs.delete(200);
  assert.deepEqual(sweepMemoryReservations(deps)?.released, [{ id: handle.id, rule: "tree-gone" }]);
});

test("a throwing diagnostic logger does not change a worker result or leak occupancy", async () => {
  const w = world();
  let diagnostics = 0;
  const before = activeWorkerCount();
  const result = await withWorkerOccupancy(async () => {
    assert.equal(activeWorkerCount(), before + 1);
    return "worker completed";
  }, { ledger: w.deps({
    location: () => { throw new Error(`ledger unavailable: ${w.dir}`); },
    log: () => { diagnostics++; throw new Error("logger unavailable"); },
  }) });
  assert.equal(result, "worker completed");
  assert.equal(activeWorkerCount(), before);
  assert.equal(diagnostics, 1, "the ledger attempted a diagnostic without propagating the logger failure");
});
