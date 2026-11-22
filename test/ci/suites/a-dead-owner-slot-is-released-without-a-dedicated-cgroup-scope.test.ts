/**
 * test/ci/suites/a-dead-owner-slot-is-released-without-a-dedicated-cgroup-scope.test.ts — W1-T14253.
 *
 * On a host whose leases record no dedicated cgroup scope, a dead owner's slot had no release before the next boot:
 * the /proc scan can only say `unknown` ("marker absence does not prove complete process-tree quiescence"), and the
 * owner's own exact-identity release demanded the same terminal evidence. A slot then halved the host's capacity.
 *
 * The new evidence class, `proc-scan-quiescent`: the owner pid is dead (or its start differs), boot, pid namespace and
 * uid match, the lease records no dedicated scope, and two complete scans at least one recorded heartbeat apart both
 * find no reservation marker and no unreadable process. The first scan is kept beside the slot record, keyed by the
 * reservation's exact identity; any later scan that is not quiescent clears it.
 *
 * INVARIANT scope-evidence-unchanged: wherever a dedicated cgroup scope is recorded, a slot is freed exactly as before.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import {
  acquireTestSlot, probeReservedTree, releaseTestSlotForOwner, testSlotReservationIdentity, TEST_SLOT_RUN_ENV,
  type ReservedTreeEvidence, type TestSlotHolder, type TestSlotOptions,
} from "#src/lib/test-slot.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
// @ts-ignore the executable .mjs module has no declaration file.
import { runOwnerRelease } from "#scripts/test-slot-owner-release.mjs";

/** The lease's own recorded heartbeat interval: the spacing between the two scans. */
const CADENCE = 60_000;
const SCOPE = "/user.slice/user-1000.slice/run-t14253.scope";
const IDLE = () => ({ cores: 8, load1: 0 });
const failure = (code: string) => Object.assign(new Error(code), { code });

function deadPid(): number {
  const exited = spawnSync(process.execPath, ["-e", ""], { stdio: "ignore" });
  assert.equal(exited.status, 0);
  return exited.pid!;
}

function slotDir(t: TestContext, kind: string): string {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t14253-${kind}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A dead owner whose lease names its cadence and a marker identity; no dedicated scope unless asked. */
function holder(fields: Partial<TestSlotHolder> = {}): TestSlotHolder {
  const beat = new Date(Date.now() - 10 * CADENCE).toISOString();
  return { pid: deadPid(), host: hostname(), bootId: "boot-1", pidNs: "ns-1", ownerUid: process.getuid?.(),
    processStart: "proc:500", ownerNonce: "nonce-q", startedAt: beat, heartbeatAt: beat, label: "dead owner",
    heartbeatIntervalMs: CADENCE, workIdentity: "reservation-marker-v1", concurrency: 1, ...fields };
}

function writeHolder(path: string, held: TestSlotHolder): void {
  writeFileSync(path, JSON.stringify(held));
  chmodSync(path, 0o644);
}

type Entry = { start: number; environ?: string | Error };

/** A /proc table for the REAL probeReservedTree: the dead owner is absent, every entry started after it. */
function procHost(table: Record<string, Entry>, scope?: "denied" | "live" | "gone") {
  return {
    platform: "linux" as const, hostname, bootId: "boot-1", pidNs: "ns-1", list: () => Object.keys(table),
    read: (path: string): string => {
      const [, , pid, file] = path.split("/");
      const entry = table[pid!];
      if (!entry) throw failure("ENOENT");
      if (file === "stat") return `${pid} (node) S ${"0 ".repeat(18)}${entry.start} 0 0`;
      if (entry.environ instanceof Error) throw entry.environ;
      return entry.environ ?? "PATH=/bin\0";
    },
    readCgroup: (path: string): string => {
      assert.ok(path.startsWith(`/sys/fs/cgroup${SCOPE}/`), path);
      if (scope === "gone") throw failure("ENOENT");
      if (scope === "denied") throw failure("EACCES");
      return path.endsWith("/cgroup.procs") ? "77\n" : "populated 1\n";
    },
  };
}

const QUIET = { 600: { start: 600 }, 3: { start: 1, environ: failure("EACCES") } };
const marker = (held: TestSlotHolder) => `${TEST_SLOT_RUN_ENV}=${JSON.stringify({ nonce: held.ownerNonce, pid: held.pid, start: held.processStart })}\0`;

/** A fake clock whose sleep advances it, so each attempt is one poll at a chosen instant. */
function fakeTime(start = Date.now()) {
  let now = start;
  const clock = { now: () => now, date: () => new Date(now), iso: () => new Date(now).toISOString() };
  return { clock, sleep: (ms: number) => { now += ms; }, advance: (ms: number) => { now += ms; } };
}

function rows(lines: string[], step: string): Record<string, unknown>[] {
  return lines.map(line => JSON.parse(line) as Record<string, unknown>).filter(row => row.step === step);
}

/** One waiter poll through the REAL reclaim path, the real tree probe reading `table`. */
function attempt(dir: string, time: ReturnType<typeof fakeTime>, table: Record<string, Entry>, scope?: "denied" | "live" | "gone") {
  const lines: string[] = [];
  const options: TestSlotOptions = { dir, slots: 1, load: IDLE, hostname, bootId: () => "boot-1", pidNamespace: () => "ns-1",
    isPidAlive: () => false, platform: "linux", waitBoundMs: 0, clock: time.clock, sleep: time.sleep, queue: false,
    treeProbe: record => probeReservedTree(record, procHost(table, scope)), log: line => lines.push(line) };
  const lease = acquireTestSlot("waiter", options);
  return { lease, lines, withheld: rows(lines, "test_slot.reclaim_withheld").map(row => String(row.reason)),
    reclaimed: rows(lines, "test_slot.reclaimed_quiescent") };
}

const sidecar = (path: string) => `${path}.quiescent-scan.json`;

test("W1-T14253 criterion 1: with a dedicated scope recorded, a live, unreadable or marker-carrying process still withholds the slot, and an ended scope frees it, exactly as on origin/main", t => {
  const dir = slotDir(t, "scoped"), path = join(dir, "slot-1.json");
  const scoped = (held: TestSlotHolder): TestSlotHolder => ({ ...held, cgroupScope: { path: SCOPE, dedicated: true } });
  // An unreadable scope population leaves the scope UNKNOWN, and the /proc scan behind it is quiescent: two scans a
  // full recorded heartbeat apart must still withhold, because a recorded dedicated scope is the only evidence there.
  const held = scoped(holder());
  writeHolder(path, held);
  const time = fakeTime();
  const first = attempt(dir, time, QUIET, "denied");
  time.advance(CADENCE);
  const second = attempt(dir, time, QUIET, "denied");
  for (const [label, run] of [["first", first], ["second", second]] as const) {
    assert.equal(run.lease.outcome, "wait_bound_exceeded", `${label}: ${run.lease.note}`);
    assert.equal(run.reclaimed.length, 0, label);
  }
  assert.equal(existsSync(sidecar(path)), false, "no first scan is recorded where a dedicated scope is recorded");
  assert.equal(JSON.parse(readFileSync(path, "utf8")).ownerNonce, "nonce-q");
  // A scope that still holds work, an unreadable later process, and a marker carrier each withhold.
  for (const [label, table, scope] of [
    ["live scope", QUIET, "live"],
    ["unreadable process", { 600: { start: 600, environ: failure("EACCES") } }, "denied"],
    ["marker carrier", { 600: { start: 600, environ: marker(held) } }, "denied"],
  ] as const) {
    const run = attempt(dir, time, table, scope);
    assert.equal(run.lease.outcome, "wait_bound_exceeded", label);
    assert.equal(run.reclaimed.length, 0, label);
  }
  // POSITIVE CONTROL: an ended scope frees it on the first poll, on cgroup-scope evidence, as before.
  const freed = attempt(dir, time, QUIET, "gone");
  assert.equal(freed.lease.outcome, "acquired", freed.lease.note);
  assert.deepEqual(freed.reclaimed.map(row => row.coverage), ["cgroup-scope"]);
  freed.lease.release();
});

test("W1-T14253 criterion 2: with no dedicated scope, a dead owner whose repeated complete scans find no marker and no unreadable process is released, and a test_slot.reclaimed_quiescent row names the evidence class, scan count and spacing", t => {
  const dir = slotDir(t, "released"), path = join(dir, "slot-1.json"), held = holder();
  writeHolder(path, held);
  const time = fakeTime();
  // A process that started before the owner is not its descendant, so its unreadable environment is not a gap.
  const first = attempt(dir, time, QUIET);
  assert.equal(first.lease.outcome, "wait_bound_exceeded");
  assert.match(first.withheld.join("\n"), /first quiescent scan/);
  assert.equal(existsSync(sidecar(path)), true, "the first scan is kept beside the slot record");
  time.advance(CADENCE);
  const second = attempt(dir, time, QUIET);
  assert.equal(second.lease.outcome, "acquired", second.lease.note);
  assert.equal(second.reclaimed.length, 1);
  const row = second.reclaimed[0]!;
  assert.equal(row.coverage, "proc-scan-quiescent");
  assert.equal(row.scans, 2);
  assert.equal(row.spacing_ms, CADENCE);
  assert.deepEqual(row.reservation, testSlotReservationIdentity(held));
  assert.match(String(row.reason), new RegExp(`${CADENCE}ms`));
  assert.equal(existsSync(sidecar(path)), false, "a release clears the kept scan");
  second.lease.release();
});

test("W1-T14253 criterion 3: one scan, a scan that finds a marker carrier, or a scan with an unreadable process does not release; the owner release script accepts the same evidence class for its exact-identity request", t => {
  const dir = slotDir(t, "withheld"), path = join(dir, "slot-1.json"), held = holder();
  writeHolder(path, held);
  const time = fakeTime();
  assert.equal(attempt(dir, time, QUIET).lease.outcome, "wait_bound_exceeded", "one scan never releases");
  time.advance(CADENCE - 1);
  const early = attempt(dir, time, QUIET);
  assert.equal(early.lease.outcome, "wait_bound_exceeded", "a second scan inside one recorded heartbeat does not release");
  // A marker carrier between the scans voids the first one: the spacing starts again from the next quiet scan.
  const carrier = attempt(dir, time, { 600: { start: 600, environ: marker(held) } });
  assert.equal(carrier.lease.outcome, "wait_bound_exceeded");
  assert.equal(existsSync(sidecar(path)), false, "a scan that is not quiescent clears the kept scan");
  time.advance(1);
  assert.equal(attempt(dir, time, QUIET).lease.outcome, "wait_bound_exceeded", "the scan after a carrier is a first scan again");
  // An unreadable later process is incomplete coverage, and it voids the kept scan too.
  time.advance(CADENCE);
  const unreadable = attempt(dir, time, { 600: { start: 600, environ: failure("EACCES") } });
  assert.equal(unreadable.lease.outcome, "wait_bound_exceeded");
  assert.match(unreadable.withheld.join("\n"), /incomplete/);
  time.advance(CADENCE);
  assert.equal(attempt(dir, time, QUIET).lease.outcome, "wait_bound_exceeded", "a quiet scan after an unreadable one starts again");
  assert.equal(JSON.parse(readFileSync(path, "utf8")).ownerNonce, "nonce-q", "nothing released the reservation");

  // The owner lane's exact-identity release, through the script, accepts the same class. The kept scan beside the
  // record is shared with every waiter, so a carrier scan voids the one just kept and the owner lane starts afresh.
  assert.equal(attempt(dir, time, { 600: { start: 600, environ: marker(held) } }).lease.outcome, "wait_bound_exceeded");
  assert.equal(existsSync(sidecar(path)), false);
  const argv = ["--slot-dir", dir, "--slot", "1", "--nonce", "nonce-q", "--pid", String(held.pid), "--start", "proc:500"];
  const seams = { treeProbe: (record: TestSlotHolder) => probeReservedTree(record, procHost(QUIET)), isPidAlive: () => false,
    hostname, bootId: () => "boot-1", pidNamespace: () => "ns-1", clock: time.clock, log: () => {} };
  time.advance(CADENCE);
  const deferred = runOwnerRelease(argv, seams);
  assert.equal(deferred.status, 1);
  assert.equal(deferred.row.outcome, "deferred", JSON.stringify(deferred.row));
  assert.match(String(deferred.row.reason), /first quiescent scan/);
  time.advance(CADENCE);
  const released = runOwnerRelease(argv, seams);
  assert.equal(released.status, 0, JSON.stringify(released.row));
  assert.equal(released.row.outcome, "released");
  assert.equal((released.row.evidence as ReservedTreeEvidence).coverage, "proc-scan-quiescent");
  assert.equal(existsSync(path), false);
  assert.equal(existsSync(sidecar(path)), false);
});

test("W1-T14253: the class needs the lease's own cadence and exact identity, and a kept scan that cannot be read or written never releases", t => {
  const dir = slotDir(t, "guards"), path = join(dir, "slot-1.json");
  const time = fakeTime();
  // No recorded cadence: no spacing can be derived, so no number stands in for it.
  writeHolder(path, holder({ heartbeatIntervalMs: undefined }));
  for (let i = 0; i < 2; i++) {
    assert.equal(attempt(dir, time, QUIET).lease.outcome, "wait_bound_exceeded");
    time.advance(CADENCE);
  }
  assert.equal(existsSync(sidecar(path)), false);
  // A kept scan for another reservation (a replaced owner) is not this one's first scan.
  const held = holder();
  writeHolder(path, held);
  attempt(dir, time, QUIET);
  writeHolder(path, { ...held, ownerNonce: "nonce-r" });
  time.advance(CADENCE);
  assert.equal(attempt(dir, time, QUIET).lease.outcome, "wait_bound_exceeded", "a scan kept for another identity starts nothing");
  // A kept-scan path that is not a regular file can be neither trusted, written nor cleared.
  rmSync(sidecar(path), { force: true });
  mkdirSync(sidecar(path));
  writeHolder(path, held);
  const unwritable = attempt(dir, time, QUIET);
  assert.match(unwritable.withheld.join("\n"), /could not be kept/);
  time.advance(CADENCE);
  assert.equal(attempt(dir, time, QUIET).lease.outcome, "wait_bound_exceeded");
  const carrier = attempt(dir, time, { 600: { start: 600, environ: marker(held) } });
  assert.equal(carrier.lease.outcome, "wait_bound_exceeded", "an uncleared path still withholds");
  // The library function the script wraps defers a first scan the same way.
  rmSync(sidecar(path), { recursive: true, force: true });
  const first = releaseTestSlotForOwner(path, { ownerNonce: held.ownerNonce!, pid: held.pid, processStart: held.processStart! }, {
    treeProbe: record => probeReservedTree(record, procHost(QUIET)), isPidAlive: () => false, hostname,
    bootId: () => "boot-1", pidNamespace: () => "ns-1", clock: time.clock, log: () => {} });
  assert.equal(first.outcome, "deferred");
});
