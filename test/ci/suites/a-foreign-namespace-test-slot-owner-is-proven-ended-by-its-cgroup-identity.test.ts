import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import {
  acquireTestSlot, enqueueTestSlot, parseTestSlotHolder, probeCgroupIdentity, readCgroupNamespace, readTestSlotCgroup, testSlotReservationIdentity,
  type ReservedTreeProbeHost, type TestSlotHolder, type TestSlotLease,
} from "#src/lib/test-slot.js";

const scopePath = "/user.slice/user-1000.slice/run-W1-T11807.scope";
const OWNER_UID = process.getuid?.() ?? 1000;
const CGROUP_NS = "cgroup:[4026531835]";
const DEV = 17;
const INO = 29;
const failure = (code: string) => Object.assign(new Error(code), { code });

function holder(heartbeatAt = new Date(Date.now() - 2 * 60 * 60_000).toISOString()): TestSlotHolder {
  return {
    pid: 424242, host: hostname(), bootId: "boot", startedAt: new Date(Date.now() - 3 * 60 * 60_000).toISOString(),
    heartbeatAt, label: "foreign author preflight", ownerNonce: "foreign-owner", processStart: "proc:100",
    pidNs: "owner-pid-ns", ownerUid: OWNER_UID, workIdentity: "reservation-marker-v1",
    cgroupScope: { path: scopePath, dedicated: true, dev: DEV, ino: INO, cgroupNs: CGROUP_NS },
  };
}

function fakeHost(options: {
  events?: string | Error;
  dev?: number;
  ino?: number;
  cgroupNamespace?: string;
  ownerUid?: number;
  bootId?: string;
  directoryError?: Error;
} = {}): ReservedTreeProbeHost {
  return {
    platform: "linux", hostname, bootId: options.bootId ?? "boot", ownerUid: options.ownerUid ?? OWNER_UID,
    cgroupNamespace: options.cgroupNamespace ?? CGROUP_NS,
    withCgroupDirectory: (path, use) => {
      assert.equal(path, scopePath);
      if (options.directoryError) throw options.directoryError;
      return use("/pinned/run-W1-T11807.scope", { dev: options.dev ?? DEV, ino: options.ino ?? INO });
    },
    readCgroup: path => {
      assert.equal(path, "/pinned/run-W1-T11807.scope/cgroup.events");
      if (options.events instanceof Error) throw options.events;
      return options.events ?? "populated 0\nfrozen 0\n";
    },
  };
}

function writeSharedSlot(path: string, held: TestSlotHolder): void {
  writeFileSync(path, JSON.stringify(held), { mode: 0o644 });
}

function tempSlotDir(t: TestContext, label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t11807-${label}-`));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(dir + ".queue", { recursive: true, force: true });
  });
  return dir;
}

function acquireAgainst(dir: string, probe: (held: TestSlotHolder) => ReturnType<typeof probeCgroupIdentity>,
  log: (line: string) => void = () => {}, pidAlive: (pid: number) => boolean = () => false): TestSlotLease {
  return acquireTestSlot("foreign-owner-waiter", {
    dir, slots: 1, queue: false, waitBoundMs: 0, pollMs: 1, platform: "linux",
    hostname, bootId: () => "boot", pidNamespace: () => "waiter-pid-ns", isPidAlive: pidAlive,
    load: () => ({ cores: 8, load1: 0 }), cgroupIdentityProbe: probe, log,
  });
}

test("W1-T11807: a silent foreign-pid-namespace owner with populated 1 keeps its slot past the lease", t => {
  const dir = tempSlotDir(t, "live");
  const path = join(dir, "slot-1.json");
  const held = holder();
  writeSharedSlot(path, held);
  const host = fakeHost({ events: "populated 1\nfrozen 0\n" });
  const rows: Record<string, unknown>[] = [];
  const lease = acquireAgainst(dir, record => probeCgroupIdentity(record, host), line => rows.push(JSON.parse(line)));
  assert.equal(lease.outcome, "wait_bound_exceeded");
  assert.equal(lease.executionAllowed, false);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).ownerNonce, held.ownerNonce);
  assert.equal(rows.some(row => row.step === "test_slot.reclaimed_quiescent"), false);
});

test("W1-T11807: matching pinned dev/ino and populated 0 reclaim and log cgroup-identity", t => {
  const dir = tempSlotDir(t, "ended");
  const path = join(dir, "slot-1.json");
  const held = holder();
  writeSharedSlot(path, held);
  const host = fakeHost();
  const evidence = probeCgroupIdentity(held, host);
  assert.equal(evidence.state, "ended");
  assert.equal(evidence.complete, true);
  assert.equal(evidence.coverage, "cgroup-identity");
  assert.deepEqual(evidence.reservation, testSlotReservationIdentity(held));
  const rows: Record<string, unknown>[] = [];
  const lease = acquireAgainst(dir, record => probeCgroupIdentity(record, host), line => rows.push(JSON.parse(line)));
  t.after(() => lease.release());
  assert.equal(lease.outcome, "acquired", lease.note);
  const reclaimed = rows.find(row => row.step === "test_slot.reclaimed_quiescent");
  assert.equal(reclaimed?.coverage, "cgroup-identity");
  assert.deepEqual(reclaimed?.cgroupIdentity, { path: scopePath, dev: DEV, ino: INO, cgroupNs: CGROUP_NS });
  assert.notEqual(JSON.parse(readFileSync(path, "utf8")).ownerNonce, held.ownerNonce);
});

test("W1-T11807: absent, unreadable, mismatched and replaced cgroup identities stay unknown", () => {
  const held = holder();
  const cases: Array<[string, ReservedTreeProbeHost]> = [
    ["populated", fakeHost({ events: "populated 1\n" })],
    ["unparsable", fakeHost({ events: "population 0\n" })],
    ["unreadable", fakeHost({ events: failure("EACCES") })],
    ["absent", fakeHost({ directoryError: failure("ENOENT") })],
    ["dev/ino replacement", fakeHost({ dev: DEV + 1 })],
    ["cgroup namespace", fakeHost({ cgroupNamespace: "cgroup:[other]" })],
    ["owner uid", fakeHost({ ownerUid: OWNER_UID + 1 })],
    ["boot id", fakeHost({ bootId: "another-boot" })],
  ];
  for (const [name, host] of cases) {
    const evidence = probeCgroupIdentity(held, host);
    assert.equal(evidence.state, name === "populated" ? "live" : "unknown", name + ": " + evidence.reason);
    assert.notEqual(evidence.complete, true, name);
  }
  assert.equal(probeCgroupIdentity({ ...held, cgroupScope: { path: scopePath, dedicated: true } }, fakeHost()).state, "unknown");
  const partial = parseTestSlotHolder(JSON.stringify({ ...held, cgroupScope: { path: scopePath, dedicated: true, dev: DEV, ino: INO } }));
  assert.deepEqual(partial?.cgroupScope, { path: scopePath, dedicated: true }, "partial descriptor identity is legacy metadata only");
});

test("W1-T11807: a reservation replaced after the cgroup probe is preserved", t => {
  const dir = tempSlotDir(t, "replaced");
  const path = join(dir, "slot-1.json");
  const held = holder();
  writeSharedSlot(path, held);
  const replacement = { ...held, ownerNonce: "replacement-owner", processStart: "proc:200" };
  const host = fakeHost();
  let replaced = false;
  const lease = acquireTestSlot("foreign-owner-waiter", {
    dir, slots: 1, queue: false, waitBoundMs: 0, pollMs: 1, platform: "linux",
    hostname, bootId: () => "boot", pidNamespace: () => "waiter-pid-ns", isPidAlive: () => false,
    load: () => ({ cores: 8, load1: 0 }), log: () => {},
    cgroupIdentityProbe: record => {
      if (record.ownerNonce !== held.ownerNonce) return probeCgroupIdentity(record, fakeHost({ dev: DEV + 1 }));
      const evidence = probeCgroupIdentity(record, host);
      writeSharedSlot(path, replacement);
      replaced = true;
      return evidence;
    },
  });
  assert.equal(replaced, true);
  assert.notEqual(lease.outcome, "acquired");
  assert.equal(JSON.parse(readFileSync(path, "utf8")).ownerNonce, replacement.ownerNonce);
});

test("W1-T11807: the freed slot is taken by the head of two queued tickets", t => {
  const dir = tempSlotDir(t, "fifo");
  const path = join(dir, "slot-1.json");
  writeSharedSlot(path, holder());
  const host = fakeHost();
  const common = {
    dir, slots: 1, queue: true, waitBoundMs: 0, pollMs: 1, platform: "linux" as const,
    hostname, bootId: () => "boot", pidNamespace: () => "waiter-pid-ns", isPidAlive: (pid: number) => pid === process.pid,
    load: () => ({ cores: 8, load1: 0 }), cgroupIdentityProbe: (record: TestSlotHolder) => probeCgroupIdentity(record, host),
    log: () => {}, say: () => {},
  };
  const head = enqueueTestSlot("head-ticket", common);
  const tail = enqueueTestSlot("tail-ticket", common);
  assert.equal(head.ticketed, true);
  assert.equal(head.position, 1);
  assert.equal(tail.ticketed, true);
  assert.equal(tail.position, 2);
  const headLease = head.admit();
  t.after(() => headLease.release());
  assert.equal(headLease.outcome, "acquired", headLease.note);
  const tailLease = tail.admit();
  t.after(() => tailLease.release());
  assert.notEqual(tailLease.outcome, "acquired");
});

test("W1-T11807: a dedicated owner publishes cgroup dev/ino and cgroup namespace", () => {
  const stat = process.pid + " (node owner) S 1 44 " + "0 ".repeat(16) + "100 0";
  const recorded = readTestSlotCgroup({
    platform: "linux", cgroupNamespace: CGROUP_NS,
    read: path => {
      if (path === "/proc/self/cgroup") return "0::" + scopePath + "\n";
      if (path === "/proc/self/stat" || path === "/proc/" + process.pid + "/stat") return stat;
      throw failure("ENOENT");
    },
    readCgroup: path => {
      assert.equal(path, "/sys/fs/cgroup" + scopePath + "/cgroup.procs");
      return process.pid + "\n";
    },
    withCgroupDirectory: (path, use) => {
      assert.equal(path, scopePath);
      return use("/pinned/" + process.pid, { dev: DEV, ino: INO });
    },
  });
  assert.deepEqual(recorded, { path: scopePath, dedicated: true, dev: DEV, ino: INO, cgroupNs: CGROUP_NS });
});

test("W1-T11807: default cgroup namespace and membership readers use this process's proc entries", () => {
  if (process.platform !== "linux") return;
  const cgroupNs = readCgroupNamespace();
  const raw = readFileSync("/proc/self/cgroup", "utf8");
  const cgroupPath = /^0::([^\n]+)$/m.exec(raw)?.[1];
  assert.ok(cgroupNs?.startsWith("cgroup:["));
  assert.ok(cgroupPath);
  const observed = readTestSlotCgroup();
  assert.equal(observed?.path, cgroupPath);
  if (observed?.dedicated) {
    assert.ok(Number.isSafeInteger(observed.dev));
    assert.ok(Number.isSafeInteger(observed.ino));
    assert.equal(observed.cgroupNs, cgroupNs);
  }
});
