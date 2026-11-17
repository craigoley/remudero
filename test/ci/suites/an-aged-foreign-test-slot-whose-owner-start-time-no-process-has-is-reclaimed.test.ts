import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import {
  acquireTestSlot, probeRecordedPidNamespace, readBootId, scanProcessStarts,
  type ProcessStartScan, type ReservedTreeEvidence, type ReservedTreeProbeHost, type TestSlotHolder, type TestSlotOptions,
} from "#src/lib/test-slot.js";

// All fixture time is injected; no dated fixture is compared with the real clock.
const NOW = Date.parse("2026-11-15T12:00:00Z");
const OWNER_NS = "pid:[4026532935]";
const WAITER_NS = "pid:[4026531836]";
const failure = (code: string) => Object.assign(new Error(code), { code });
const holder = (extra: Partial<TestSlotHolder> = {}): TestSlotHolder => ({
  pid: 18, host: "previous-container", bootId: "boot", pidNs: OWNER_NS, processStart: "proc:155563263",
  startedAt: new Date(NOW - 37 * 3_600_000).toISOString(), heartbeatAt: new Date(NOW - 37 * 3_600_000).toISOString(),
  heartbeatIntervalMs: 60_000, label: "project-preflight", ownerNonce: "wedged-owner",
  cgroupScope: { path: "/docker/remudero-console-daemon", dedicated: false, reason: "not a dedicated cgroup v2 scope" }, ...extra,
});
const stat = (start: string) => `42 (proc with ) spaces) S ${Array(18).fill("0").join(" ")} ${start}\n`;

/** A host whose other-uid namespace links are unreadable (the observed 229 of 312) while every stat reads. */
function fakeHost(extra: Partial<ReservedTreeProbeHost> = {}, files: Record<string, string | Error> = {}): ReservedTreeProbeHost {
  const proc: Record<string, string | Error> = {
    "/proc/self/ns/pid": WAITER_NS, "/proc/self/status": "Name:\twaiter\nNSpid:\t77\n",
    "/proc/1/stat": stat("200"), "/proc/1/ns/pid": WAITER_NS, "/proc/1/status": "NSpid:\t1\n",
    "/proc/42/stat": stat("155563999"), "/proc/42/ns/pid": failure("EACCES"), "/proc/42/status": "NSpid:\t42\t7\n",
    ...files,
  };
  return {
    platform: "linux", bootId: "boot", list: () => ["self", "1", "42"],
    read: path => {
      const value = proc[path];
      if (value instanceof Error) throw value;
      if (value === undefined) throw failure("ENOENT");
      return value;
    }, ...extra,
  };
}

function slot(t: TestContext, held = holder()) {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t12825-`));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(dir + ".queue", { recursive: true, force: true });
  });
  const path = join(dir, "slot-1.json");
  writeFileSync(path, JSON.stringify(held), { mode: 0o644 });
  const before = readFileSync(path, "utf8");
  const rows: Record<string, unknown>[] = [];
  let scans = 0;
  const acquire = (host = fakeHost(), extra: Partial<TestSlotOptions> = {}) => {
    const lease = acquireTestSlot("start-scan waiter", {
      dir, slots: 1, queue: false, waitBoundMs: 0, platform: "linux",
      clock: { now: () => NOW, date: () => new Date(NOW), iso: () => new Date(NOW).toISOString() },
      hostname: () => "current-container", bootId: () => "boot", pidNamespace: () => WAITER_NS,
      cgroupNamespace: () => "cgroup:[waiter]", isPidAlive: () => false,
      memoryHeadroom: () => undefined, load: () => ({ cores: 8, load1: 0 }),
      log: line => rows.push(JSON.parse(line)), say: () => {},
      pidNamespaceProbe: record => probeRecordedPidNamespace(record, host),
      processStartScan: () => { scans += 1; return scanProcessStarts(host); }, ...extra,
    });
    t.after(() => lease.release());
    return lease;
  };
  return { path, before, rows, acquire, scans: () => scans };
}

type Fixture = ReturnType<typeof slot>;
const stepRows = (fixture: Fixture, step: string) => fixture.rows.filter(row => row.step === step);

function assertKept(fixture: Fixture, name: string, reason?: RegExp) {
  assert.equal(readFileSync(fixture.path, "utf8"), fixture.before, `${name}: the hold is byte-identical`);
  assert.equal(stepRows(fixture, "test_slot.reclaimed_quiescent").length, 0, name);
  if (reason === undefined) return;
  const aged = stepRows(fixture, "test_slot.owner_aged");
  assert.equal(aged.length, 1, `${name}: today's one owner_aged row`);
  assert.equal(aged[0]!.decision, "retained: an aged foreign hold is UNKNOWN, never released by heartbeat age", name);
  assert.ok((aged[0]!.missingEvidence as string[]).some(line => reason.test(line)),
    `${name}: ${JSON.stringify(aged[0]!.missingEvidence)}`);
}

test("W1-T12825 criterion 1: a complete start scan without the recorded start reclaims an aged foreign hold", t => {
  const host = fakeHost();
  const probe = probeRecordedPidNamespace(holder(), host);
  assert.equal(probe.state, "unknown", "precondition: the pid namespace probe cannot see the owner");
  assert.match(probe.reason, /EACCES/);
  const fixture = slot(t);
  const lease = fixture.acquire(host);
  assert.equal(lease.outcome, "acquired");
  assert.equal(fixture.scans(), 1);
  const reclaimed = stepRows(fixture, "test_slot.reclaimed_quiescent");
  assert.equal(reclaimed.length, 1, "one reclaimed_quiescent line");
  assert.equal(reclaimed[0]!.coverage, "boot-start-scan");
  assert.equal(reclaimed[0]!.reason, "no process on boot boot started at proc:155563263");
  assert.equal(reclaimed[0]!.processStart, "proc:155563263");
  assert.equal(reclaimed[0]!.ownerNonce, "wedged-owner");
  assert.equal(stepRows(fixture, "test_slot.owner_aged").length, 0);
  assert.equal(JSON.parse(readFileSync(fixture.path, "utf8")).label, "start-scan waiter");
  lease.release();
  assert.equal(fixture.acquire(host).outcome, "acquired", "the next waiter acquires after release");
});

test("W1-T12825 criterion 1: the rung also follows an unknown cgroup identity probe", t => {
  const fixture = slot(t, holder({ host: "current-container", cgroupScope: {
    path: "/run-W1-T12825.scope", dedicated: true, dev: 1, ino: 2, cgroupNs: "cgroup:[owner]",
  } }));
  const lease = fixture.acquire(fakeHost(), {
    cgroupIdentityProbe: () => ({ state: "unknown", coverage: "cgroup-identity", reason: "namespace differs" }),
  });
  assert.equal(lease.outcome, "acquired");
  assert.deepEqual(stepRows(fixture, "test_slot.reclaimed_quiescent").map(row => row.coverage), ["boot-start-scan"]);
});

test("W1-T12825 criterion 2: no-reclaim-without-start-proof keeps the hold with today's owner_aged row", t => {
  const boundedScan = (host: ReservedTreeProbeHost) => (): ProcessStartScan => {
    let calls = 0;
    const clock = t.mock.method(performance, "now", () => calls++ === 0 ? 0 : 2_001);
    try { return scanProcessStarts(host); } finally { clock.mock.restore(); }
  };
  const cases: Array<{ name: string; host?: ReservedTreeProbeHost; waiter?: Partial<TestSlotOptions>; reason: RegExp }> = [
    { name: "a process has the recorded start", host: fakeHost({}, { "/proc/42/stat": stat("155563263") }),
      reason: /process start scan: a process started at proc:155563263 is live/ },
    { name: "an unreadable stat leaves the scan incomplete", host: fakeHost({}, { "/proc/42/stat": failure("EACCES") }),
      reason: /process start scan: incomplete: \/proc\/42\/stat unreadable/ },
    { name: "an unparseable stat leaves the scan incomplete", host: fakeHost({}, { "/proc/42/stat": "malformed" }),
      reason: /process start scan: incomplete: \/proc\/42\/stat unparseable/ },
    { name: "a hidepid listing without pid 1", host: fakeHost({ list: () => ["self", "42"] }),
      reason: /process start scan: incomplete: \/proc lists no pid 1/ },
    { name: "the scan is past its bound", waiter: { processStartScan: boundedScan(fakeHost()) },
      reason: /process start scan: incomplete: process start scan exceeded its bound/ },
    { name: "the waiter is not in the initial pid namespace", host: fakeHost({}, { "/proc/self/status": "NSpid:\t77\t5\n" }),
      reason: /process start scan: waiter is not in the initial pid namespace/ },
    { name: "the injected scan throws", waiter: { processStartScan: () => { throw failure("EIO"); } },
      reason: /process start scan: process start scan failed: .*EIO/ },
    { name: "the default scan reads a kernel whose boot id is not the record's", waiter: { processStartScan: undefined },
      reason: /process start scan: record boot id is not this kernel's/ },
  ];
  for (const item of cases) {
    const fixture = slot(t);
    assert.equal(fixture.acquire(item.host, item.waiter).outcome, "wait_bound_exceeded", item.name);
    assertKept(fixture, item.name, item.reason);
    assert.ok(stepRows(fixture, "test_slot.owner_aged")[0]!.missingEvidence
      && JSON.stringify(stepRows(fixture, "test_slot.owner_aged")[0]!.missingEvidence).includes("pid namespace probe:"), item.name);
  }

  // Preconditions the scan never overrides: it is not consulted at all, and the hold stays as today.
  const unconsulted: Array<{ name: string; held: Partial<TestSlotHolder>; waiter?: Partial<TestSlotOptions>; aged: boolean }> = [
    { name: "the record lacks processStart", held: { processStart: undefined }, aged: true },
    { name: "the record's start is not a kernel start", held: { processStart: "ps:yesterday" }, aged: true },
    { name: "the hold is not aged", held: { heartbeatAt: new Date(NOW - 60_000).toISOString() }, aged: false },
  ];
  for (const item of unconsulted) {
    const fixture = slot(t, holder(item.held));
    assert.equal(fixture.acquire(fakeHost(), item.waiter).outcome, "wait_bound_exceeded", item.name);
    assert.equal(fixture.scans(), 0, `${item.name}: the start scan is not consulted`);
    assertKept(fixture, item.name);
    assert.equal(stepRows(fixture, "test_slot.owner_aged").length, item.aged ? 1 : 0, item.name);
  }

  // A different or unrecorded boot id keeps today's boot-id verdict, never the start scan's: the new rung writes nothing.
  const boots: Array<{ name: string; held: Partial<TestSlotHolder>; waiter?: Partial<TestSlotOptions> }> = [
    { name: "the boot ids differ", held: { bootId: "previous-boot" } },
    { name: "the record's boot id is unreadable", held: { bootId: undefined } },
    { name: "the waiter's boot id is unreadable", held: {}, waiter: { bootId: () => undefined } },
  ];
  for (const item of boots) {
    const other = slot(t, holder(item.held));
    other.acquire(fakeHost(), item.waiter);
    assert.equal(other.scans(), 0, `${item.name}: the start scan is not consulted`);
    assert.equal(stepRows(other, "test_slot.reclaimed_quiescent").some(row => row.coverage === "boot-start-scan"), false, item.name);
  }
});

test("W1-T12825 criterion 2: the default scan reads this kernel and keeps a hold whose start is live here",
  { skip: process.platform !== "linux" }, t => {
    const raw = readFileSync("/proc/self/stat", "utf8");
    const start = raw.slice(raw.lastIndexOf(")") + 1).trim().split(/\s+/)[19]!;
    const boot = readBootId();
    assert.ok(boot, "this linux kernel names its boot id");
    const fixture = slot(t, holder({ bootId: boot, processStart: `proc:${start}` }));
    const lease = fixture.acquire(fakeHost(), {
      bootId: () => boot, processStartScan: undefined,
      pidNamespaceProbe: () => ({ state: "unknown", coverage: "pid-namespace-ended", reason: "links unreadable" }),
    });
    assert.equal(lease.outcome, "wait_bound_exceeded");
    // This process has the start, so a complete scan reads it live; an unprivileged or namespaced one is incomplete.
    assertKept(fixture, "own start", /process start scan: (a process started at proc:[0-9]+ is live|.*(incomplete|initial pid namespace))/);
  });

test("W1-T12825 criterion 3: an ended or live namespace answer keeps priority and a changed record survives", t => {
  const answers: Array<{ state: ReservedTreeEvidence["state"]; outcome: string }> = [
    { state: "ended", outcome: "acquired" }, { state: "live", outcome: "wait_bound_exceeded" },
  ];
  for (const { state, outcome } of answers) {
    const fixture = slot(t);
    const lease = fixture.acquire(fakeHost(), {
      pidNamespaceProbe: () => ({ state, coverage: "pid-namespace-ended", reason: `namespace ${state}` }),
    });
    assert.equal(lease.outcome, outcome, state);
    assert.equal(fixture.scans(), 0, `${state}: the start scan is not consulted`);
    const reclaimed = stepRows(fixture, "test_slot.reclaimed_quiescent");
    if (state === "ended") assert.deepEqual(reclaimed.map(row => row.coverage), ["pid-namespace-ended"]);
    else assertKept(fixture, state, /pid namespace probe: namespace live$/);
  }

  for (const change of [{ heartbeatAt: new Date(NOW).toISOString() }, { ownerNonce: "replacement-owner", processStart: "proc:300" }]) {
    const fixture = slot(t);
    const replacement = JSON.stringify(holder(change));
    const lease = fixture.acquire(fakeHost(), {
      log: line => {
        const row = JSON.parse(line);
        fixture.rows.push(row);
        if (row.step === "test_slot.reclaimed_quiescent") writeFileSync(fixture.path, replacement);
      },
    });
    assert.notEqual(lease.outcome, "acquired");
    assert.equal(fixture.scans(), 1, "the start scan judged the original record");
    assert.equal(readFileSync(fixture.path, "utf8"), replacement, "the changed record is not reclaimed");
  }
});
