import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import {
  INITIAL_PID_NAMESPACE,
  acquireTestSlot, probeRecordedPidNamespace, TEST_SLOT_LEASE_MS, TEST_SLOT_SILENT_BEATS,
  type ReservedTreeEvidence, type ReservedTreeProbeHost, type TestSlotHolder, type TestSlotOptions,
} from "#src/lib/test-slot.js";

const NOW = Date.parse("2026-11-14T12:00:00Z");
const OWNER_NS = "pid:[12504]";
// W1-T15112: an initial-namespace waiter reads the kernel's fixed init namespace link, not a one-entry NSpid alone.
const WAITER_NS = INITIAL_PID_NAMESPACE;
// Namespace inode reuse proves the old tree ended only when the new init started after its owner.
// All fixture time is injected; no dated fixture is compared with the real clock.
const failure = (code: string) => Object.assign(new Error(code), { code });
const holder = (extra: Partial<TestSlotHolder> = {}): TestSlotHolder => ({
  pid: 424242, host: "previous-container", bootId: "boot", pidNs: OWNER_NS, processStart: "proc:100",
  startedAt: new Date(NOW - 600_000).toISOString(), heartbeatAt: new Date(NOW - 240_000).toISOString(),
  heartbeatIntervalMs: 60_000, label: "old preflight", ownerNonce: "old-owner", ...extra,
});
const stat = (start: string) => `42 (init with ) spaces) S ${Array(18).fill("0").join(" ")} ${start}\n`;

function fakeHost(extra: Partial<ReservedTreeProbeHost> = {}, files: Record<string, string | Error> = {}): ReservedTreeProbeHost {
  const proc: Record<string, string | Error> = {
    "/proc/self/ns/pid": WAITER_NS, "/proc/self/status": "Name:\twaiter\nNSpid:\t77\n",
    "/proc/42/ns/pid": OWNER_NS, "/proc/42/status": "NSpid:\t42\t1\n", "/proc/42/stat": stat("200"),
    "/proc/1/stat": stat("200"), ...files,
  };
  return {
    platform: "linux", bootId: "boot", list: () => ["self", "42"],
    read: path => {
      const value = proc[path];
      if (value instanceof Error) throw value;
      if (value === undefined) throw failure("ENOENT");
      return value;
    }, ...extra,
  };
}

function slot(t: TestContext, held = holder()) {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t12504-`));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(dir + ".queue", { recursive: true, force: true });
  });
  const path = join(dir, "slot-1.json");
  writeFileSync(path, JSON.stringify(held), { mode: 0o644 });
  const before = readFileSync(path, "utf8");
  const rows: Record<string, unknown>[] = [];
  let calls = 0;
  const acquire = (host = fakeHost(), extra: Partial<TestSlotOptions> = {}) => {
    const lease = acquireTestSlot("namespace waiter", {
      dir, slots: 1, queue: false, waitBoundMs: 0, platform: "linux",
      clock: { now: () => NOW, date: () => new Date(NOW), iso: () => new Date(NOW).toISOString() },
      hostname: () => "current-container", bootId: () => "boot", pidNamespace: () => WAITER_NS,
      cgroupNamespace: () => "cgroup:[waiter]", isPidAlive: () => false,
      memoryHeadroom: () => undefined, load: () => ({ cores: 8, load1: 0 }),
      log: line => rows.push(JSON.parse(line)), say: () => {},
      pidNamespaceProbe: record => { calls += 1; return probeRecordedPidNamespace(record, host); }, ...extra,
    });
    t.after(() => lease.release());
    return lease;
  };
  return { path, before, rows, acquire, calls: () => calls };
}

function changingNamespaceHost(): ReservedTreeProbeHost {
  const host = fakeHost();
  let reads = 0;
  return { ...host, read: path => path === "/proc/42/ns/pid" && ++reads % 2 === 0 ? "pid:[other]" : host.read!(path) };
}

function assertReclaimed(fixture: ReturnType<typeof slot>, reason: RegExp) {
  const rows = fixture.rows.filter(row => row.step === "test_slot.reclaimed_quiescent");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.coverage, "pid-namespace-ended");
  assert.match(String(rows[0]!.reason), reason);
  assert.equal(fixture.rows.some(row => row.step === "test_slot.owner_aged"), false);
  assert.equal(JSON.parse(readFileSync(fixture.path, "utf8")).label, "namespace waiter");
}

test("W1-T12504 criterion 1: the initial namespace sees a reused namespace id with a newer init", t => {
  const fixture = slot(t);
  const lease = fixture.acquire();
  assert.equal(lease.outcome, "acquired");
  assertReclaimed(fixture, /200.*100/);
  lease.release();
  assert.equal(fixture.acquire().outcome, "acquired", "the next waiter also acquires after release");
});

test("W1-T12504 criterion 2: a different hostname in the recorded namespace sees its newer init", t => {
  const fixture = slot(t);
  assert.equal(fixture.acquire(fakeHost({}, { "/proc/self/ns/pid": OWNER_NS }),
    { pidNamespace: () => OWNER_NS }).outcome, "acquired");
  assertReclaimed(fixture, /200.*100/);
});

test("W1-T12504 criterion 3: a complete initial-namespace scan finds no recorded namespace member", t => {
  const fixture = slot(t);
  assert.equal(fixture.acquire(fakeHost({}, { "/proc/42/ns/pid": "pid:[other]" })).outcome, "acquired");
  assertReclaimed(fixture, /no.*member/i);
});

test("W1-T12504 criterion 4: live and unreadable namespace evidence retains byte-identical aged holds", t => {
  const cases: Array<{ name: string; host: ReservedTreeProbeHost; held?: Partial<TestSlotHolder>;
    waiter?: Partial<TestSlotOptions>; state?: "live"; reason: RegExp }> = [
    { name: "older init", host: fakeHost({}, { "/proc/42/stat": stat("99") }), state: "live", reason: /99.*100/ },
    { name: "equal init", host: fakeHost({}, { "/proc/42/stat": stat("100") }), state: "live", reason: /100/ },
    { name: "same namespace live", host: fakeHost({}, { "/proc/self/ns/pid": OWNER_NS, "/proc/1/stat": stat("100") }), state: "live", reason: /100/ },
    { name: "unreadable member", host: fakeHost({}, { "/proc/42/ns/pid": failure("EACCES") }), reason: /EACCES/ },
    { name: "vanished member", host: fakeHost({}, { "/proc/42/ns/pid": failure("ENOENT") }), reason: /ENOENT/ },
    { name: "unreadable init", host: fakeHost({}, { "/proc/42/stat": failure("EACCES") }), reason: /EACCES/ },
    { name: "namespace changed", host: changingNamespaceHost(), reason: /changed/ },
    { name: "missing init", host: fakeHost({}, { "/proc/42/status": "NSpid:\t42\t2\n" }), reason: /init/ },
    { name: "malformed stat", host: fakeHost({}, { "/proc/42/stat": "malformed" }), reason: /stat/ },
    { name: "unreadable status", host: fakeHost({}, { "/proc/42/status": failure("EACCES") }), reason: /EACCES/ },
    { name: "same namespace init unreadable", host: fakeHost({}, { "/proc/self/ns/pid": OWNER_NS, "/proc/1/stat": failure("EACCES") }), reason: /EACCES/ },
    { name: "non ancestor", host: fakeHost({}, { "/proc/self/status": "NSpid:\t77\t5\n" }), reason: /not an ancestor/ },
    { name: "missing waiter NSpid", host: fakeHost({}, { "/proc/self/status": "Name: waiter\n" }), reason: /not an ancestor/ },
    { name: "empty waiter NSpid", host: fakeHost({}, { "/proc/self/status": "NSpid:\n77\n" }), reason: /not an ancestor/ },
    { name: "empty member NSpid", host: fakeHost({}, { "/proc/42/status": "NSpid:\n1\n" }), reason: /init/ },
    { name: "unreadable waiter", host: fakeHost({}, { "/proc/self/ns/pid": failure("EACCES") }), reason: /EACCES/ },
    { name: "table unreadable", host: fakeHost({ list: () => { throw failure("EACCES"); } }), reason: /EACCES/ },
    { name: "owner boot absent", host: fakeHost(), held: { bootId: undefined }, reason: /boot/ },
    { name: "waiter boot absent", host: fakeHost({ bootId: undefined }), waiter: { bootId: () => undefined }, reason: /boot/ },
    { name: "start absent", host: fakeHost(), held: { processStart: undefined }, reason: /start/ },
    { name: "non proc start", host: fakeHost(), held: { processStart: "ps:yesterday" }, reason: /start/ },
    { name: "namespace absent", host: fakeHost(), held: { pidNs: undefined }, reason: /namespace/ },
    { name: "namespace malformed", host: fakeHost(), held: { pidNs: "not-a-kernel-namespace" }, reason: /namespace/ },
  ];
  for (const item of cases) {
    const held = holder(item.held);
    const evidence = probeRecordedPidNamespace(held, item.host);
    assert.equal(evidence.state, item.state ?? "unknown", item.name);
    assert.match(evidence.reason, item.reason, item.name);
    const fixture = slot(t, held);
    assert.equal(fixture.acquire(item.host, item.waiter).outcome, "wait_bound_exceeded", item.name);
    assert.equal(readFileSync(fixture.path, "utf8"), fixture.before, item.name);
    assert.equal(fixture.rows.filter(row => row.step === "test_slot.owner_aged").length, 1, item.name);
    assert.equal(fixture.rows.some(row => row.step === "test_slot.reclaimed_quiescent"), false, item.name);
    if (held.bootId && /^pid:\[[0-9]+\]$/.test(held.pidNs ?? "") && item.name !== "waiter boot absent") {
      const aged = fixture.rows.find(row => row.step === "test_slot.owner_aged")!;
      assert.ok((aged.missingEvidence as string[]).some(reason => reason.includes(evidence.reason)), item.name);
    }
  }
});

test("W1-T12504 criterion 5: records inside either heartbeat bound are never probed", t => {
  for (const cadence of [60_000, undefined]) {
    const bound = cadence === undefined ? TEST_SLOT_LEASE_MS : TEST_SLOT_SILENT_BEATS * cadence;
    for (const silence of [0, bound]) {
      const fixture = slot(t, holder({ heartbeatIntervalMs: cadence, heartbeatAt: new Date(NOW - silence).toISOString() }));
      assert.equal(fixture.acquire().outcome, "wait_bound_exceeded");
      assert.equal(fixture.calls(), 0, "a probe that would prove ended must not run");
      assert.equal(readFileSync(fixture.path, "utf8"), fixture.before);
    }
  }
});

test("W1-T12504 criterion 6: a new beat or owner between judgement and unlink survives", t => {
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
    assert.equal(readFileSync(fixture.path, "utf8"), replacement);
  }
});

test("W1-T12504 criterion 7: no-reclaim-without-namespace-end across aged and fresh foreign holds", t => {
  for (const aged of [true, false]) {
    for (const init of ["99", "100", "101"]) {
      const fixture = slot(t, holder(aged ? {} : { heartbeatAt: new Date(NOW).toISOString() }));
      const lease = fixture.acquire(fakeHost({}, { "/proc/42/stat": stat(init) }));
      assert.equal(lease.outcome === "acquired", aged && init === "101");
      assert.equal(fixture.calls(), aged ? 1 : 0);
      if (lease.outcome !== "acquired") assert.equal(readFileSync(fixture.path, "utf8"), fixture.before);
    }
  }
});

test("the namespace probe fails closed on platform, boot, malformed init and observation bound", t => {
  assert.equal(probeRecordedPidNamespace(holder(), fakeHost({ platform: "darwin" })).state, "unknown");
  assert.equal(probeRecordedPidNamespace(holder(), fakeHost({ bootId: "other-boot" })).state, "unknown");
  const malformed = probeRecordedPidNamespace(holder(), fakeHost({}, { "/proc/self/ns/pid": OWNER_NS, "/proc/1/stat": "bad" }));
  assert.equal(malformed.state, "unknown");
  assert.match(malformed.reason, /stat/);
  let calls = 0;
  t.mock.method(performance, "now", () => calls++ === 0 ? 0 : 2_001);
  const bounded = probeRecordedPidNamespace(holder(), fakeHost());
  assert.equal(bounded.state, "unknown");
  assert.match(bounded.reason, /bound/);
});

test("namespace fallback follows unknown cgroup evidence and catches an unavailable injected probe", t => {
  const held = holder({ host: "current-container", cgroupScope: {
    path: "/run-W1-T12504.scope", dedicated: true, dev: 1, ino: 2, cgroupNs: "cgroup:[owner]",
  } });
  const fixture = slot(t, held);
  assert.equal(fixture.acquire(fakeHost(), { cgroupIdentityProbe: () => ({ state: "unknown", coverage: "cgroup-identity", reason: "namespace differs" }) }).outcome, "acquired");
  assertReclaimed(fixture, /200.*100/);
  const refused = slot(t);
  assert.equal(refused.acquire(fakeHost(), { pidNamespaceProbe: () => { throw failure("EACCES"); } }).outcome, "wait_bound_exceeded");
  assert.equal(readFileSync(refused.path, "utf8"), refused.before);
  assert.match(JSON.stringify(refused.rows.find(row => row.step === "test_slot.owner_aged")), /EACCES/);
});

test("the default namespace probe reads this kernel without a fake proc reader", () => {
  const evidence: ReservedTreeEvidence = probeRecordedPidNamespace(holder());
  assert.equal(evidence.state, "unknown");
  assert.match(evidence.reason, /boot|linux/);
});

test("the default namespace probe reads the real namespace init", { skip: process.platform !== "linux" }, () => {
  const raw = readFileSync("/proc/1/stat", "utf8");
  const start = raw.slice(raw.lastIndexOf(")") + 1).trim().split(/\s+/)[19]!;
  const evidence = probeRecordedPidNamespace(holder({ bootId: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
    pidNs: readlinkSync("/proc/self/ns/pid"), processStart: `proc:${start}` }));
  assert.equal(evidence.state, "live");
  assert.equal(evidence.coverage, "pid-namespace-ended");
  assert.match(evidence.reason, new RegExp(`${start}.*${start}`));
});

test("the default proc listing reads real process namespace links", { skip: process.platform !== "linux" }, () => {
  let entries = 0;
  const evidence = probeRecordedPidNamespace(holder(), {
    platform: "linux", bootId: "boot", read: path => {
      if (path === "/proc/self/ns/pid") return WAITER_NS;
      if (path === "/proc/self/status") return "NSpid:\t77\n";
      entries += 1;
      return readlinkSync(path);
    },
  });
  assert.ok(entries > 0, "the default list must see this process even if other entries are unreadable");
  assert.ok(evidence.state === "ended" || evidence.state === "unknown", evidence.reason);
  assert.match(evidence.reason, /no process member|unreadable process entries/);
});
