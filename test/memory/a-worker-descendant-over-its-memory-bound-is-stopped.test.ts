/**
 * W1-T11344: a worker tree's descendant whose resident memory passes DESCENDANT_RSS_BOUND_MIB is stopped and ledgered by
 * the tree sampler that already reads it, and every sampled tree ledgers its largest member's peak.
 *
 * OBSERVED 2026-11-04 in remudero-daemon (memory.max 26,128,416,768 bytes): a test-file child of a `node --test` runner
 * inside #16240's semantic review reached 19.2 GiB in under five minutes and throttled every lane until the operator
 * stopped it by hand. Every kill, start-time read and ledger write here is a fake port: no real process is signalled.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { fixedClock } from "#src/lib/clock.js";
import {
  DESCENDANT_RSS_BOUND_MIB,
  descendantBoundPorts,
  descendantMemoryBoundHook,
  type DescendantBoundPorts,
} from "#src/lib/descendant-memory-bound.js";
import { parseProcStat, type HostMemoryLedgerOptions, type ProcessListing } from "#src/lib/host-memory-ledger.js";
import {
  createTreePeakSampler,
  openLearnedReservation,
  resetLearnedEstimateCacheForTests,
  type TreeSamplerPorts,
} from "#src/lib/host-memory-learning.js";
import { withTempDir } from "#src/lib/tmp.js";

const NOW = Date.parse("2026-11-04T19:08:59.000Z");
const GIB_KB = 1024 * 1024;

interface Proc { parent: number; start: string; argv: string[]; rssKb: number }

/** A worker (10) running bash (11), which runs a node build (12) with a child (13). No test runner. */
function plainTree(): Map<number, Proc> {
  return new Map<number, Proc>([
    [10, { parent: 1, start: "proc:100", argv: ["claude", "-p"], rssKb: 300 * 1024 }],
    [11, { parent: 10, start: "proc:110", argv: ["bash", "-c", "npx tsc"], rssKb: 10 * 1024 }],
    [12, { parent: 11, start: "proc:120", argv: ["node", "tsc.js"], rssKb: 900 * 1024 }],
    [13, { parent: 12, start: "proc:130", argv: ["git", "status"], rssKb: 20 * 1024 }],
  ]);
}

/** The 2026-11-04 shape: a review (10) running `npm test` (12), its `node --test` runner (13) and a test-file child (14). */
function reviewWithTestRun(): Map<number, Proc> {
  return new Map<number, Proc>([
    [10, { parent: 1, start: "proc:100", argv: ["claude", "-p"], rssKb: 300 * 1024 }],
    [11, { parent: 10, start: "proc:110", argv: ["bash", "-c", "npm test"], rssKb: 10 * 1024 }],
    [12, { parent: 11, start: "proc:120", argv: ["node", "--import", "tsx", "scripts/test-run.mjs", "--test", "x.test.ts"], rssKb: 90 * 1024 }],
    [13, { parent: 12, start: "proc:130", argv: ["/usr/local/bin/node", "--test", "--test-concurrency=2", "test/x.test.ts"], rssKb: 150 * 1024 }],
    [14, { parent: 13, start: "proc:140", argv: ["/usr/local/bin/node", "--import", "tsx", "/repo/test/x.test.ts"], rssKb: 560 * 1024 }],
  ]);
}

function samplerPorts(procs: Map<number, Proc>, timers: Array<() => void>): Partial<TreeSamplerPorts> {
  const enoent = (path: string) => Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
  return {
    listProcesses: (): ProcessListing => ({ rows: [...procs].map(([pid, p]) => ({ pid, parent: p.parent, start: p.start })), complete: true }),
    readFile: (path) => {
      const pid = Number(/\/proc\/(\d+)\//.exec(path)?.[1]);
      const p = procs.get(pid);
      if (!p) throw enoent(path);
      if (path.endsWith("/stat")) return `${pid} (node) S ${p.parent} ${"0 ".repeat(17)}${p.start.replace("proc:", "")} 0 0`;
      if (path.endsWith("/cmdline")) return `${p.argv.join("\0")}\0`;
      return `VmRSS:\t${p.rssKb} kB\nVmHWM:\t${p.rssKb} kB\n`;
    },
    setTimer: (fn) => {
      timers.push(fn);
      return { unref: () => undefined };
    },
    clearTimer: () => undefined,
  };
}

function reservationSpace(): HostMemoryLedgerOptions {
  const files = new Map<string, string>();
  const dir = `/ledger/${Math.random().toString(36).slice(2)}`;
  return {
    location: () => ({ dir, scope: "host" }),
    instance: () => ({ name: "state2", hostUnique: true }),
    generation: () => ({ containerId: "c1", initStart: "proc:1" }),
    probe: (pid) => (pid === 10 || pid === 12 || pid === 4242 ? { state: "alive", start: `proc:${pid * 10}` } : { state: "gone" }),
    listProcesses: () => ({ rows: [], complete: true }),
    write: (path, content) => void files.set(path, content),
    read: (path) => {
      const content = files.get(path);
      if (content === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
      return content;
    },
    list: (d) => [...files.keys()].filter((k) => k.startsWith(`${d}/`)).map((k) => k.slice(d.length + 1)),
    remove: (path) => void files.delete(path),
    createSentinel: (path, content) => void files.set(path, content),
    clock: fixedClock(NOW),
    log: () => undefined,
    ownerPid: 4242,
  };
}

/** Fake bound ports over the fake /proc: the fresh start read sees the table, a kill only records, rows are kept. */
function boundPorts(procs: Map<number, Proc>) {
  const kills: number[] = [];
  const rows: Array<Record<string, unknown>> = [];
  const ports: DescendantBoundPorts = {
    readStart: (pid) => {
      const p = procs.get(pid);
      if (!p) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return p.start;
    },
    kill: (pid) => void kills.push(pid),
    write: (row) => void rows.push(row),
  };
  return { kills, rows, ports };
}

function learned(workerClass: "review" | "implement" | "test", procs: Map<number, Proc>, ports: Partial<DescendantBoundPorts>) {
  resetLearnedEstimateCacheForTests();
  const timers: Array<() => void> = [];
  const sampler = createTreePeakSampler(samplerPorts(procs, timers));
  const store = { list: () => [] as string[], append: () => undefined, size: () => 0, clock: fixedClock(NOW) };
  const reservation = openLearnedReservation({ workerClass }, { ledger: reservationSpace(), store, sampler, descendantBound: ports });
  return { reservation, sampler, tick: () => timers[0]!() };
}

const killedRows = (rows: Array<Record<string, unknown>>) => rows.filter((r) => r.step === "worker.descendant_memory_killed");
const peakRows = (rows: Array<Record<string, unknown>>) => rows.filter((r) => r.step === "worker.descendant_rss_peak");

test("the bound is the operator's 8 GiB", () => {
  assert.equal(DESCENDANT_RSS_BOUND_MIB, 8192);
});

test("a descendant over the bound is killed once, after a fresh start-time read still matches, and one row names it", () => {
  const procs = plainTree();
  const fake = boundPorts(procs);
  const { reservation, tick } = learned("implement", procs, fake.ports);
  reservation.bindRoot(10);
  assert.deepEqual(fake.kills, [], "nothing is over the bound yet");

  procs.get(12)!.rssKb = 9 * GIB_KB;
  tick();
  tick();
  assert.deepEqual(fake.kills, [12], "the member over the bound is signalled, and only once");
  const rows = killedRows(fake.rows);
  assert.equal(rows.length, 1, JSON.stringify(fake.rows));
  assert.equal(rows[0]!.pid, 12);
  assert.equal(rows[0]!.rss_mib, 9216);
  assert.equal(rows[0]!.bound_mib, 8192);
  assert.equal(rows[0]!.worker_class, "implement");
  assert.equal(rows[0]!.reservation_id, reservation.id);
  assert.equal(rows[0]!.signalled, true);
  assert.equal(rows[0]!.test_file, undefined, "a member that is no runner's file child names no test file");
  reservation.releaseOccupancy();
});

test("a tracked root, a member at the bound and a member whose start time changed are never signalled", () => {
  const procs = plainTree();
  procs.get(10)!.rssKb = 12 * GIB_KB; // the worker's own agent CLI: a root, out of scope
  procs.get(11)!.rssKb = DESCENDANT_RSS_BOUND_MIB * 1024; // exactly at the bound
  procs.get(12)!.rssKb = 9 * GIB_KB;
  const fake = boundPorts(procs);
  const reused = { ...fake.ports, readStart: (pid: number) => (pid === 12 ? "proc:999" : fake.ports.readStart(pid)) };
  const { reservation, tick } = learned("implement", procs, reused);
  reservation.bindRoot(10);
  tick();
  assert.deepEqual(fake.kills, [], "no root, no member at the bound, no recycled pid");
  assert.deepEqual(killedRows(fake.rows), []);
  reservation.releaseOccupancy();
});

test("a failed start read, a failed signal and a failed write are caught; sampling and the reservation go on", () => {
  const procs = plainTree();
  procs.get(12)!.rssKb = 9 * GIB_KB;
  procs.get(13)!.rssKb = 10 * GIB_KB;
  const fake = boundPorts(procs);
  const failing: DescendantBoundPorts = {
    readStart: (pid) => {
      if (pid === 12) throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      return fake.ports.readStart(pid);
    },
    kill: (pid) => { throw Object.assign(new Error(`kill ${pid}`), { code: "EPERM" }); },
    write: fake.ports.write,
  };
  const { reservation, tick } = learned("implement", procs, failing);
  reservation.bindRoot(10);
  const rows = killedRows(fake.rows);
  assert.equal(rows.length, 2, JSON.stringify(fake.rows));
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  assert.equal(byPid.get(12)!.signalled, false);
  assert.match(String(byPid.get(12)!.error), /^read-start: EACCES/);
  assert.equal(byPid.get(13)!.signalled, false);
  assert.match(String(byPid.get(13)!.error), /^signal: EPERM/);

  procs.delete(13);
  const gone = boundPorts(procs);
  const exited = learned("implement", procs, {
    ...gone.ports,
    readStart: () => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); },
  });
  exited.reservation.bindRoot(10);
  assert.deepEqual(gone.kills, [], "a member that exited before its fresh read is not signalled");
  assert.deepEqual(killedRows(gone.rows), [], "and writes no row");
  exited.reservation.releaseOccupancy();

  const unwritable = boundPorts(plainTree());
  const tree = plainTree();
  tree.get(12)!.rssKb = 9 * GIB_KB;
  const broken = learned("implement", tree, { ...unwritable.ports, write: () => { throw new Error("EROFS"); } });
  broken.reservation.bindRoot(10);
  broken.tick();
  assert.deepEqual(unwritable.kills, [12], "a failed write never undoes or repeats the stop");
  assert.doesNotThrow(() => broken.reservation.releaseOccupancy());
  tick();
  reservation.releaseOccupancy();
});

test("W1-T11344 criterion 2: a test-file child of a node --test runner adopted as a nested tree is stopped over the bound", () => {
  const procs = reviewWithTestRun();
  const fake = boundPorts(procs);
  const { reservation, sampler, tick } = learned("review", procs, fake.ports);
  reservation.bindRoot(10);
  assert.equal(sampler.size(), 2, "the test run is its own nested tracked tree");

  procs.get(14)!.rssKb = Math.round(19.2 * GIB_KB); // 2026-11-04: 19.2 GiB
  tick();
  assert.deepEqual(fake.kills, [14], "the nested tree carries the bound");
  const rows = killedRows(fake.rows);
  assert.equal(rows.length, 1, JSON.stringify(fake.rows));
  assert.equal(rows[0]!.rss_mib, 19661);
  assert.equal(rows[0]!.worker_class, "test");
  assert.equal(typeof rows[0]!.reservation_id, "string");
  assert.notEqual(rows[0]!.reservation_id, reservation.id);
  assert.equal(rows[0]!.test_file, "test/x.test.ts");
  reservation.releaseOccupancy();
});

test("at release every sampled tree ledgers one row with its largest member's peak and its test file", () => {
  const procs = reviewWithTestRun();
  procs.get(14)!.rssKb = 2 * GIB_KB;
  const fake = boundPorts(procs);
  const { reservation, tick } = learned("review", procs, fake.ports);
  reservation.bindRoot(10);
  procs.get(14)!.rssKb = 3 * GIB_KB;
  tick();
  procs.get(14)!.rssKb = 1 * GIB_KB;
  tick();
  assert.deepEqual(peakRows(fake.rows), [], "nothing is written before release");
  for (const pid of [12, 13, 14]) procs.delete(pid);
  tick();
  assert.equal(peakRows(fake.rows).length, 1, "the nested tree releases before its parent");
  const nested = peakRows(fake.rows)[0]!;
  assert.equal(nested.worker_class, "test");
  assert.equal(typeof nested.reservation_id, "string");
  assert.notEqual(nested.reservation_id, reservation.id);
  assert.equal(nested.max_member_rss_mib, 3072);
  assert.equal(nested.test_file, "test/x.test.ts");
  assert.equal(nested.member_is_root, false);
  reservation.releaseOccupancy();
  reservation.releaseOccupancy();
  const rows = peakRows(fake.rows);
  assert.equal(rows.length, 2, "one row per tree, however often release is called");
  assert.equal(rows[1]!.worker_class, "review");
  assert.equal(rows[1]!.reservation_id, reservation.id);
  assert.equal(rows[1]!.max_member_rss_mib, 300, "nested members never enter the parent's peak");
  assert.equal(rows[1]!.test_file, undefined);
  assert.equal(rows[1]!.member_is_root, true);
  assert.deepEqual(fake.kills, []);

  const never = boundPorts(new Map());
  const unseen = learned("implement", new Map(), never.ports);
  unseen.reservation.bindRoot(10);
  unseen.reservation.releaseOccupancy();
  assert.deepEqual(never.rows, [], "a tree never sampled records nothing, never a zero");
});

test("a failed ledger write is retained with its error until sampling recovers the writer", () => {
  const procs = plainTree();
  procs.get(12)!.rssKb = 9 * GIB_KB;
  const fake = boundPorts(procs);
  let writable = false;
  const { reservation, tick } = learned("implement", procs, {
    ...fake.ports,
    write: (row) => {
      if (!writable) throw Object.assign(new Error("read-only ledger"), { code: "EROFS" });
      fake.ports.write(row);
    },
  });
  reservation.bindRoot(10);
  assert.deepEqual(fake.kills, [12]);
  assert.deepEqual(fake.rows, []);
  writable = true;
  tick();
  const rows = killedRows(fake.rows);
  assert.equal(rows.length, 1, "the failed stop row survives until a later sample");
  assert.equal(rows[0]!.pid, 12);
  assert.equal(rows[0]!.signalled, true);
  assert.match(String(rows[0]!.error), /write: EROFS/);
  reservation.releaseOccupancy();
  assert.deepEqual(fake.kills, [12], "recovering evidence never repeats the signal");
  assert.equal(killedRows(fake.rows).length, 1);
  assert.equal(peakRows(fake.rows).length, 1);
});

test("release retries a failed peak write without duplicating it or losing an earlier operation error", () => {
  const fake = boundPorts(new Map());
  let writable = false;
  const bound = descendantMemoryBoundHook({ workerClass: "test", reservationId: "nested" }, {
    ...fake.ports,
    readStart: () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); },
    write: (row) => {
      if (!writable) throw Object.assign(new Error("read-only ledger"), { code: "EROFS" });
      fake.ports.write(row);
    },
  });
  bound.onMember(7, "s7", 9 * GIB_KB, { root: false });
  assert.doesNotThrow(() => bound.release());
  assert.deepEqual(fake.rows, []);
  writable = true;
  bound.release();
  bound.release();
  assert.equal(killedRows(fake.rows).length, 1);
  assert.match(String(killedRows(fake.rows)[0]!.error), /read-start: EACCES/);
  assert.match(String(killedRows(fake.rows)[0]!.error), /write: EROFS/);
  assert.equal(peakRows(fake.rows).length, 1);
  assert.match(String(peakRows(fake.rows)[0]!.error), /write: EROFS/);
  assert.equal(peakRows(fake.rows)[0]!.max_member_rss_mib, 9216);
});

test("a nested tree's failed release write recovers through its parent's next sample", () => {
  const procs = reviewWithTestRun();
  procs.get(12)!.rssKb = 9 * GIB_KB;
  const fake = boundPorts(procs);
  let writable = false;
  const { reservation, tick } = learned("review", procs, {
    ...fake.ports,
    write: (row) => {
      if (!writable) throw Object.assign(new Error("read-only ledger"), { code: "EROFS" });
      fake.ports.write(row);
    },
  });
  reservation.bindRoot(10);
  assert.deepEqual(fake.kills, [], "the nested reservation's bound root is also protected");
  for (const pid of [12, 13, 14]) procs.delete(pid);
  tick();
  assert.deepEqual(fake.rows, []);
  writable = true;
  tick();
  assert.equal(peakRows(fake.rows).length, 1, "evidence survives removal of the nested tree");
  const row = peakRows(fake.rows)[0]!;
  assert.equal(row.worker_class, "test");
  assert.notEqual(row.reservation_id, reservation.id);
  assert.equal(row.max_member_rss_mib, 9216);
  assert.equal(row.member_is_root, true);
  assert.match(String(row.error), /write: EROFS/);
  reservation.releaseOccupancy();
  assert.equal(peakRows(fake.rows).length, 2);
});

test("the hook's own decisions: roots and the bound, once per process, and a release after it", () => {
  const fake = boundPorts(new Map([[7, { parent: 1, start: "s7", argv: [], rssKb: 0 }]]));
  const bound = descendantMemoryBoundHook({ workerClass: "garden", reservationId: "r1" }, fake.ports);
  bound.onMember(5, "s5", 9 * GIB_KB, { root: true });
  bound.onMember(7, "s7", 9 * GIB_KB, { root: false, testFile: "test/a.test.ts" });
  bound.onMember(7, "s7", 9 * GIB_KB, { root: false });
  assert.deepEqual(fake.kills, [7]);
  bound.release();
  const peak = peakRows(fake.rows)[0]!;
  assert.equal(peak.max_member_rss_mib, 9216);
  assert.equal(peak.member_is_root, true, "the first member to reach the largest value is kept");
  assert.equal(peak.members_stopped, 1);
});

test("the default ports read /proc/<pid>/stat, send SIGKILL, and ledger only in a daemon-owned process", () => {
  const signals: Array<[number, string]> = [];
  const appended: Array<[string, Record<string, unknown>]> = [];
  const stderr: string[] = [];
  const sys = {
    readFile: (path: string) => (path === "/proc/77/stat" ? `77 (node) S 1 ${"0 ".repeat(17)}4242 0 0` : `77 (node) Z 1 ${"0 ".repeat(17)}4242 0 0`),
    signal: (pid: number, signal: NodeJS.Signals) => void signals.push([pid, signal]),
    append: (path: string, row: Record<string, unknown>) => void appended.push([path, row]),
    stderr: (line: string) => void stderr.push(line),
  };
  let daemon = true;
  const ports = descendantBoundPorts({ root: "/r", daemonOwned: () => daemon }, sys);
  assert.equal(ports.readStart(77), "proc:4242", "the same start form the process listing carries");
  assert.equal(ports.readStart(78), undefined, "a zombie holds no memory and is not signalled");
  ports.kill(77);
  assert.deepEqual(signals, [[77, "SIGKILL"]]);
  ports.write({ run_id: "x", task_id: "y", step: "worker.descendant_rss_peak" });
  assert.deepEqual(appended.map(([path]) => path), ["/r/state/ledger.ndjson"]);
  daemon = false;
  ports.write({ run_id: "x", task_id: "y", step: "worker.descendant_rss_peak" });
  ports.write({ run_id: "x", task_id: "y", step: "worker.descendant_memory_killed" });
  assert.equal(appended.length, 1, "outside the daemon nothing is appended to a ledger");
  assert.equal(stderr.length, 1, "a stop outside the daemon is still said, on stderr");
  assert.match(stderr[0]!, /worker\.descendant_memory_killed/);
  descendantBoundPorts({ daemonOwned: () => true }, sys).write({ run_id: "x", task_id: "y", step: "s" });
  assert.match(appended[1]![0], /Remudero\/state\/ledger\.ndjson$/, "no root: the config default state root");
});

test("a throwing onMember owner loses its own decision, never the sampler's measure", () => {
  const sampler = createTreePeakSampler(samplerPorts(plainTree(), []));
  const seen: number[] = [];
  sampler.track("w", 10, { onMember: (pid) => { seen.push(pid); throw new Error("owner failed"); } });
  assert.deepEqual(seen.sort(), [10, 11, 12, 13], "every member is handed over, despite each throw");
  assert.equal(sampler.finishMeasurement!("w").peakMib, 300 + 10 + 900 + 20);
});

test("the REAL default ports read, stop and ledger a child this test spawned, and say a stop on stderr outside the daemon", async (t) => {
  // Only this test's own child is ever signalled: its pid comes from spawn, never from a listing.
  const child = spawn(process.execPath, ["-e", "setTimeout(() => undefined, 30_000)"], { stdio: "ignore" });
  const exited = new Promise<NodeJS.Signals | null>((resolve) => child.once("exit", (_code, signal) => resolve(signal)));
  try {
    const pid = child.pid!;
    await withTempDir("descendant-bound", async (root) => {
      const ports = descendantBoundPorts({ root, daemonOwned: () => true });
      const start = ports.readStart(pid);
      assert.equal(start, parseProcStat(readFileSync(`/proc/${pid}/stat`, "utf8"))!.start, "the real /proc/<pid>/stat start");
      ports.kill(pid);
      assert.equal(await exited, "SIGKILL", "the real kill port sends SIGKILL");
      ports.write({ run_id: "r", task_id: "MEMORY-BUDGET", step: "worker.descendant_memory_killed", pid });
      const rows = readFileSync(join(root, "state", "ledger.ndjson"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
      assert.equal(rows.length, 1);
      assert.equal(rows[0].step, "worker.descendant_memory_killed");
      assert.equal(rows[0].pid, pid);
    });
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  const said = t.mock.method(console, "error", () => undefined);
  descendantBoundPorts({ root: "/nonexistent", daemonOwned: () => false })
    .write({ run_id: "r", task_id: "MEMORY-BUDGET", step: "worker.descendant_memory_killed", pid: 1 });
  assert.equal(said.mock.callCount(), 1, "outside the daemon the real stderr port says the stop");
  assert.match(String(said.mock.calls[0]!.arguments[0]), /worker\.descendant_memory_killed/);
});
