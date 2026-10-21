import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  acquireTestSlot, probeReservedTree, readTestSlotCgroup, testSlotReservationIdentity, TEST_SLOT_RUN_ENV,
  type TestSlotHolder,
} from "#src/lib/test-slot.js";

const scopePath = "/user.slice/user-1000.slice/run-t10251.scope";
const failure = (code: string) => Object.assign(new Error(code), { code });
const stat = (pid: number, start = 100, group = 42): string =>
  `${pid} (node worker) S 1 ${group} ${"0 ".repeat(16)}${start} 0`;
type ScopedHolder = TestSlotHolder & { cgroupScope?: { path: string; dedicated: boolean } };

function holder(): ScopedHolder {
  const at = new Date().toISOString();
  return { pid: 424242, host: hostname(), bootId: "boot", pidNs: "ns", ownerUid: process.getuid?.(),
    processStart: "proc:100", ownerNonce: "dead-owner", startedAt: at, heartbeatAt: at,
    label: "dead owner", workIdentity: "reservation-marker-v1", cgroupScope: { path: scopePath, dedicated: true } };
}

/** A legacy shared-mode slot record, which a waiter reads for tree-based recovery. */
function writeSharedSlot(path: string, held: TestSlotHolder): void {
  writeFileSync(path, JSON.stringify(held));
  chmodSync(path, 0o644);
}

function scopeHost(scope: "gone" | "empty" | "live" | "nested" | "denied" = "gone", owner: string | Error = failure("ENOENT")) {
  const reads: string[] = [];
  return {
    reads, platform: "linux" as const, hostname, bootId: "boot", pidNs: "ns", list: () => ["99"],
    read: (path: string): string => {
      reads.push(path);
      if (path === "/proc/424242/stat") {
        if (owner instanceof Error) throw owner;
        return owner;
      }
      if (path === "/proc/99/stat") return stat(99, 200);
      throw failure("EACCES");
    },
    readCgroup: (path: string): string => {
      reads.push(path);
      assert.ok(path.startsWith(`/sys/fs/cgroup${scopePath}/`), path);
      if (scope === "gone") throw failure("ENOENT");
      if (scope === "denied") throw failure("EACCES");
      if (path.endsWith("/cgroup.procs")) return scope === "live" ? "99\n" : "";
      assert.ok(path.endsWith("/cgroup.events"), path);
      return `populated ${scope === "nested" ? 1 : 0}\nfrozen 0\n`;
    },
  };
}

test("W1-T10251: a dead owner whose dedicated scope is gone is proven ended", () => {
  const held = holder();
  for (const scope of ["gone", "empty"] as const) {
    for (const owner of [failure("ENOENT"), failure("ESRCH"), stat(held.pid, 101)]) {
      const host = scopeHost(scope, owner);
      const evidence = probeReservedTree(held, host);
      assert.equal(evidence.state, "ended", `${scope}: ${evidence.reason}`);
      assert.equal(evidence.complete, true);
      assert.equal(evidence.coverage, "cgroup-scope");
      assert.deepEqual(evidence.reservation, testSlotReservationIdentity(held));
      assert.equal(host.reads.some(path => path.endsWith("/environ")), false);
    }
  }
});

test("W1-T10251: a waiter reclaims a dead owner's slot on cgroup-scope evidence", t => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-t10251-waiter-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "slot-1.json"), held = holder(), host = scopeHost();
  writeSharedSlot(path, held);
  const rows: Record<string, unknown>[] = [];
  const lease = acquireTestSlot("waiter", { dir, slots: 1, waitBoundMs: 0, platform: "linux",
    hostname, bootId: () => "boot", pidNamespace: () => "ns", isPidAlive: () => false,
    load: () => ({ cores: 8, load1: 0 }), treeProbe: record => probeReservedTree(record, host),
    log: line => rows.push(JSON.parse(line)) });
  t.after(() => lease.release());
  assert.equal(lease.outcome, "acquired", lease.note);
  const reclaimed = rows.filter(row => row.step === "test_slot.reclaimed_quiescent");
  assert.equal(reclaimed.length, 1);
  assert.equal(reclaimed[0]!.coverage, "cgroup-scope");
  assert.deepEqual(reclaimed[0]!.reservation, testSlotReservationIdentity(held));
  assert.notEqual(JSON.parse(readFileSync(path, "utf8")).ownerNonce, held.ownerNonce);
  assert.equal(host.reads.some(path => path.endsWith("/environ")), false);
});

test("W1-T10251: a scope that still holds work keeps its slot", t => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-t10251-retained-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "slot-1.json");
  for (const dedicated of [true, false]) {
    const held = holder();
    held.cgroupScope!.dedicated = dedicated;
    const host = scopeHost(dedicated ? "live" : "gone");
    const evidence = probeReservedTree(held, host);
    assert.equal(evidence.state, dedicated ? "live" : "unknown");
    if (dedicated) assert.equal(evidence.coverage, "cgroup-scope");
    else assert.equal(host.reads.some(name => name.startsWith("/sys/fs/cgroup")), false);
    writeFileSync(path, JSON.stringify(held));
    chmodSync(path, 0o644);
    const lease = acquireTestSlot("waiter", { dir, slots: 1, waitBoundMs: 0, platform: "linux",
      hostname, bootId: () => "boot", pidNamespace: () => "ns", isPidAlive: () => false,
      load: () => ({ cores: 8, load1: 0 }), treeProbe: record => probeReservedTree(record, host), log: () => {} });
    assert.equal(lease.outcome, "wait_bound_exceeded");
    assert.equal(lease.executionAllowed, false);
    assert.equal(JSON.parse(readFileSync(path, "utf8")).ownerNonce, held.ownerNonce);
  }
});

test("scope membership is classified before publication and the default reads this owner's cgroup", async t => {
  const { readTestSlotCgroup } = await import("#src/lib/test-slot.js");
  const membership = (options: { path?: string; members?: string; group?: number; denied?: string; self?: string; member?: string } = {}) =>
    readTestSlotCgroup({ platform: "linux", read: path => {
      if (path === options.denied) throw failure("EACCES");
      if (path === "/proc/self/cgroup") return options.path ?? `0::${scopePath}\n`;
      if (path === "/proc/self/stat") return options.self ?? stat(process.pid);
      return options.member ?? stat(Number(path.split("/")[2]), 100, options.group ?? 42);
    }, readCgroup: path => {
      assert.equal(path, `/sys/fs/cgroup${scopePath}/cgroup.procs`);
      if (options.denied === "scope") throw failure("EACCES");
      return options.members ?? `${process.pid}\n99\n`;
    } });
  assert.deepEqual(membership(), { path: scopePath, dedicated: true });
  assert.equal(membership({ group: 43 })!.dedicated, false, "another process group makes a scope shared");
  for (const path of ["0::/\n", "0::/user.slice\n", "1:cpu:/run-old.scope\n", "0::/../run-bad.scope\n"]) {
    assert.equal(membership({ path })!.dedicated, false, path);
  }
  for (const options of [{ denied: "/proc/self/cgroup" }, { denied: "/proc/self/stat" }, { denied: "scope" },
    { denied: "/proc/99/stat" }, { self: "malformed" }, { member: "malformed" },
    { members: "99\n" }, { members: `${process.pid}\ninvalid\n` }]) {
    const record = membership(options)!;
    assert.equal(record.dedicated, false, JSON.stringify(options));
    assert.ok(record.reason, "failed dedication carries its reason");
  }
  assert.equal(readTestSlotCgroup({ platform: "darwin", read: () => assert.fail("no proc read off Linux") }), undefined);

  const dir = mkdtempSync(join(tmpdir(), "rmd-t10251-publish-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const lease = acquireTestSlot("real membership", { dir, slots: 1, waitBoundMs: 0, log: () => {} });
  t.after(() => lease.release());
  assert.equal(lease.outcome, "acquired", lease.note);
  const recorded = JSON.parse(readFileSync(join(dir, "slot-1.json"), "utf8")) as TestSlotHolder;
  if (process.platform === "linux") {
    const actualPath = /^0::([^\n]+)$/m.exec(readFileSync("/proc/self/cgroup", "utf8"))?.[1] ?? "";
    assert.ok(recorded.cgroupScope, "the writer publishes scope membership even when it is shared");
    assert.equal(recorded.cgroupScope.path, actualPath);
    assert.deepEqual(recorded.cgroupScope, readTestSlotCgroup());
  } else assert.equal(recorded.cgroupScope, undefined);
});

test("scope evidence requires owner death, matching identities and complete population coverage", () => {
  const held = holder();
  assert.equal(probeReservedTree(held, scopeHost("empty", stat(held.pid))).state, "live");
  assert.equal(probeReservedTree({ ...held, processStart: "proc:0100" }, scopeHost("gone", stat(held.pid))).state, "live");
  assert.equal(probeReservedTree(held, scopeHost("nested")).state, "live",
    "an empty scope parent cannot hide a populated child cgroup");
  for (const host of [scopeHost("denied"), scopeHost("gone", failure("EACCES")), scopeHost("gone", "malformed"),
    { ...scopeHost("empty"), readCgroup: (path: string) => path.endsWith("/cgroup.procs") ? "" : "unparseable population" },
    { ...scopeHost("empty"), readCgroup: (path: string) => {
      if (path.endsWith("/cgroup.procs")) return "";
      throw failure("EACCES");
    } }]) {
    const evidence = probeReservedTree(held, host);
    assert.equal(evidence.state, "unknown", evidence.reason);
    assert.notEqual(evidence.complete, true);
  }
  for (const drift of [{ host: "another-host" }, { bootId: "another-boot" }, { pidNs: "another-ns" },
    { ownerUid: undefined }, { ownerNonce: undefined }, { processStart: "proc:bad" },
    { cgroupScope: undefined }, { cgroupScope: { path: "/../run-wrong.scope", dedicated: true } }]) {
    const host = scopeHost();
    assert.equal(probeReservedTree({ ...held, ...drift }, host).state, "unknown", JSON.stringify(drift));
    assert.equal(host.reads.some(path => path.startsWith("/sys/fs/cgroup")), false);
  }
  const legacyHost = scopeHost();
  assert.equal(probeReservedTree({ ...held, cgroupScope: undefined }, legacyHost).state, "unknown");
  assert.ok(legacyHost.reads.includes("/proc/99/environ"), "legacy records retain the marker scan");
  const markedHost = scopeHost("denied"), read = markedHost.read;
  markedHost.read = path => path.endsWith("/environ")
    ? `${TEST_SLOT_RUN_ENV}=${JSON.stringify({ nonce: held.ownerNonce, pid: held.pid, start: held.processStart })}\0`
    : read(path);
  assert.equal(probeReservedTree(held, markedHost).state, "live", "failed scope reads still use live marker evidence");
});

// The measured builder shape on the Azure host (2026-10-21, run-u1165.scope): systemd-run --scope starts
// `timeout … job.sh`, the job wraps the preflight in a second `timeout`, and each `timeout` takes a new process
// group. The owner's own wrappers are therefore in another group, yet the scope holds nothing but this run.
function builderScope(extra: { pid: number; ppid: number; group: number }[] = []) {
  const procs = [
    { pid: 900, ppid: 7, group: 900 },            // outer `timeout -k 60 7200 … job.sh`
    { pid: 901, ppid: 900, group: 900 },          // the job script
    { pid: 902, ppid: 901, group: 902 },          // inner `timeout` around the preflight
    { pid: process.pid, ppid: 902, group: 902 },  // the slot owner
    ...extra,
  ];
  const stats = new Map(procs.map(p => [p.pid, `${p.pid} (wrapper) S ${p.ppid} ${p.group} ${"0 ".repeat(15)}100 0`]));
  stats.set(7, `7 (systemd) S 1 7 ${"0 ".repeat(15)}1 0`);
  stats.set(1, `1 (systemd) S 0 1 ${"0 ".repeat(15)}1 0`);
  const read = (path: string): string => {
    if (path === "/proc/self/cgroup") return `0::${scopePath}\n`;
    const pid = path === "/proc/self/stat" ? process.pid : Number(path.split("/")[2]);
    const found = stats.get(pid);
    if (found === undefined || !path.endsWith("/stat")) throw failure("ENOENT");
    return found;
  };
  return readTestSlotCgroup({ platform: "linux", read, readCgroup: path => {
    assert.equal(path, `/sys/fs/cgroup${scopePath}/cgroup.procs`);
    return `${procs.map(p => p.pid).join("\n")}\n`;
  } });
}

test("W1-T10251: a builder scope that only wraps the owner in its own ancestors is dedicated", t => {
  const recorded = builderScope();
  assert.deepEqual(recorded, { path: scopePath, dedicated: true }, JSON.stringify(recorded));
  // End to end: the record that writer publishes lets a waiter free the slot once the owner and scope are gone.
  const dir = mkdtempSync(join(tmpdir(), "rmd-t10251-builder-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "slot-1.json"), held = { ...holder(), cgroupScope: recorded }, host = scopeHost();
  writeSharedSlot(path, held);
  const rows: Record<string, unknown>[] = [];
  const lease = acquireTestSlot("waiter", { dir, slots: 1, waitBoundMs: 0, platform: "linux",
    hostname, bootId: () => "boot", pidNamespace: () => "ns", isPidAlive: () => false,
    load: () => ({ cores: 8, load1: 0 }), treeProbe: record => probeReservedTree(record, host),
    log: line => rows.push(JSON.parse(line)) });
  t.after(() => lease.release());
  assert.equal(lease.outcome, "acquired", lease.note);
  assert.deepEqual(rows.filter(row => row.step === "test_slot.reclaimed_quiescent").map(row => row.coverage), ["cgroup-scope"]);
});

test("a builder scope that also holds a sibling or an unrelated group stays shared", () => {
  // A sibling the job script started beside the owner, and a process outside the owner's ancestry.
  for (const extra of [{ pid: 903, ppid: 901, group: 903 }, { pid: 904, ppid: 7, group: 904 }]) {
    const recorded = builderScope([extra])!;
    assert.equal(recorded.dedicated, false, JSON.stringify(extra));
    assert.equal(recorded.reason, "scope contains another process group");
  }
});
