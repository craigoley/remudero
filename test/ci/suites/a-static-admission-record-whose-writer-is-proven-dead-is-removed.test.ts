// W1-T12822: a static admission record whose writer a waiter proves dead is removed and its peak is no longer
// counted; every path that cannot prove the writer ended leaves the record byte-identical with today's count or skip.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs, { existsSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test, type TestContext } from "node:test";

import {
  admitStaticWork, scanProcessStarts, testSlotProcessFacts,
  type ProcessStartScan, type ReservedTreeProbeHost, type StaticAdmission, type TestSlotHolder, type TestSlotOptions,
} from "#src/lib/test-slot.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

const GiB = 1024 ** 3;
const WAITER_NS = "pid:[4026531836]";
const DEAD_PID = 999_999_001;
// All record times are relative to the real clock the admission reads; no fixed date meets real time.
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const failure = (code: string) => Object.assign(new Error(code), { code });
const stat = (start: string) => `42 (name with ) parens) S ${Array(18).fill("0").join(" ")} ${start} 0 0\n`;

type StaticRecord = TestSlotHolder & { admittedAt?: string };
const record = (extra: Partial<StaticRecord> = {}): StaticRecord => ({
  pid: 4242, host: "fleet-container", bootId: "boot", pidNs: "pid:[4026532398]", processStart: "proc:100",
  startedAt: ago(1_000), heartbeatAt: ago(1_000), label: "dead static", memoryBytes: 4 * GiB, ...extra,
});

function fakeHost(files: Record<string, string | Error> = {}, extra: Partial<ReservedTreeProbeHost> = {}): ReservedTreeProbeHost {
  const proc: Record<string, string | Error> = {
    "/proc/self/ns/pid": WAITER_NS, "/proc/self/status": "Name:\twaiter\nNSpid:\t77\n", "/proc/1/stat": stat("5"), "/proc/42/stat": stat("200"), ...files,
  };
  return {
    platform: "linux", list: () => ["1", "42", "self", "sys"],
    read: path => {
      const value = proc[path];
      if (value instanceof Error) throw value;
      if (value === undefined) throw failure("ENOENT");
      return value;
    }, ...extra,
  };
}

function slots(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t12822-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const rows: Record<string, unknown>[] = [];
  let scans = 0;
  const plant = (held: TestSlotHolder, name = `static-${randomUUID()}.json`) => {
    const path = join(dir, name);
    writeFileSync(path, JSON.stringify(held), { mode: 0o644 });
    return { path, name, text: readFileSync(path, "utf8") };
  };
  /** `null` leaves the real default scan in place. */
  const admit = (scan: (() => ProcessStartScan) | null = () => scanProcessStarts(fakeHost()),
    extra: Partial<TestSlotOptions> = {}): StaticAdmission => {
    const admission = admitStaticWork("waiter static", {
      dir, platform: "linux", memoryBytes: GiB, memoryHeadroom: () => 2 * GiB, waitBoundMs: 0,
      sleep: () => { throw new Error("a zero wait bound never sleeps"); },
      hostname: () => "waiter-host", bootId: () => "boot", pidNamespace: () => WAITER_NS, isPidAlive: pid => pid !== DEAD_PID,
      log: line => rows.push(JSON.parse(line)),
      ...(scan ? { processStartScan: () => { scans += 1; return scan(); } } : {}), ...extra,
    });
    t.after(() => admission.release());
    return admission;
  };
  const removed = () => rows.filter(row => row.step === "test_slot.static_record_removed");
  return { dir, rows, plant, admit, removed, scans: () => scans };
}

/** The dead peak (4 GiB) beside this stage's 1 GiB cannot fit 2 GiB of headroom: counting it exceeds the bound. */
function assertCounted(admission: StaticAdmission, planted: { path: string; text: string }, why: string) {
  assert.equal(admission.outcome, "wait_bound_exceeded", `${why}: the record's peak is still counted (${admission.note})`);
  assert.equal(readFileSync(planted.path, "utf8"), planted.text, `${why}: the record is byte-identical`);
}

function assertRemoved(fixture: ReturnType<typeof slots>, admission: StaticAdmission, planted: { path: string; name: string },
  held: TestSlotHolder, rung: string) {
  assert.equal(admission.outcome, "admitted", admission.note);
  assert.match(admission.note, /and 0 live holder\(s\)/, "the dead peak was not counted");
  assert.equal(existsSync(planted.path), false, "the dead record was removed");
  const row = fixture.removed().find(entry => entry.name === planted.name);
  assert.ok(row, JSON.stringify(fixture.rows));
  assert.deepEqual({ label: row.label, pid: row.pid, pidNs: row.pidNs, host: row.host, rung: row.rung },
    { label: held.label, pid: held.pid, pidNs: held.pidNs, host: held.host, rung });
  assert.equal(typeof row.reason, "string");
}

function liveChild(t: TestContext) {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], { stdio: "ignore" });
  t.after(() => child.kill("SIGKILL"));
  for (let i = 0; i < 500 && !testSlotProcessFacts(child.pid!); i += 1) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  return child.pid!;
}

test("W1-T12822 criterion 1: an own-namespace record whose pid is gone, or now has another start, is removed", async t => {
  await t.test("pid gone", t => {
    const fixture = slots(t);
    const held = record({ pid: DEAD_PID, host: "waiter-host", pidNs: WAITER_NS });
    const planted = fixture.plant(held);
    assertRemoved(fixture, fixture.admit(), planted, held, "own-namespace");
    assert.equal(fixture.scans(), 0, "an own-namespace proof needs no /proc scan");
  });
  await t.test("pid reused with a different kernel start", t => {
    if (process.platform !== "linux") { t.skip("a kernel start time is read from Linux /proc"); return; }
    const fixture = slots(t);
    const pid = liveChild(t);
    assert.match(testSlotProcessFacts(pid)?.start ?? "", /^proc:[0-9]+$/, "positive control: the live pid has a kernel start");
    // Started and admitted now: the pid's ps start is not after the record, so only the kernel start moved.
    const fresh = { pid, host: "waiter-host", pidNs: WAITER_NS, startedAt: ago(0), admittedAt: ago(0) };
    const held = record({ ...fresh, processStart: "proc:1" });
    const planted = fixture.plant(held);
    assertRemoved(fixture, fixture.admit(), planted, held, "own-namespace");
    const control = slots(t);
    const live = control.plant(record({ ...fresh, processStart: testSlotProcessFacts(pid)!.start }));
    assertCounted(control.admit(), live, "the same pid with its recorded start");
    assert.equal(control.removed().length, 0);
  });
});

test("W1-T12822 criterion 2: an initial-namespace waiter removes another host's or namespace's record by a boot-start scan", t => {
  const fixture = slots(t);
  const container = record();
  const sandbox = record({ host: "waiter-host", pidNs: "pid:[4026532753]", label: "sandboxed static" });
  const a = fixture.plant(container), b = fixture.plant(sandbox);
  // A process that exits mid-scan (ENOENT or ESRCH) is gone, not unreadable: the scan stays complete.
  const admission = fixture.admit(() => scanProcessStarts(fakeHost({ "/proc/43/stat": failure("ESRCH") },
    { list: () => ["1", "42", "43", "44", "self"] })));
  assertRemoved(fixture, admission, a, container, "boot-start-scan");
  assertRemoved(fixture, admission, b, sandbox, "boot-start-scan");
  assert.equal(fixture.scans(), 1, "one scan serves every foreign record in a pass");
  assert.match(String(fixture.removed()[0]!.reason), /proc:100/);
});

test("W1-T12822 criterion 2: the real default /proc scan clears a start no process has and keeps a live one", t => {
  if (process.platform !== "linux") { t.skip("the default scan reads Linux /proc"); return; }
  const fixture = slots(t);
  const own = testSlotProcessFacts(process.pid)!.start;
  assert.match(own, /^proc:[0-9]+$/);
  const never = `proc:${BigInt(own.slice(5)) + 10n ** 15n}`;
  const dead = record({ processStart: never }), dead2 = fixture.plant(dead);
  const live = fixture.plant(record({ processStart: own, label: "live foreign static", memoryBytes: 512 * 1024 ** 2 }));
  // W1-T15112: the initial namespace is the kernel's fixed init link, not a one-entry NSpid alone.
  const initial = readlinkSync("/proc/self/ns/pid") === WAITER_NS &&
    readFileSync("/proc/self/status", "utf8").match(/^NSpid:[ \t]*(.*)$/m)?.[1]?.trim().split(/[ \t]+/).length === 1;
  // Only a waiter outside the initial namespace has its namespace link and NSpid line injected; every other read is the real /proc.
  const scan = initial ? null : () => scanProcessStarts({
    read: path => path === "/proc/self/ns/pid" ? WAITER_NS : path === "/proc/self/status" ? "NSpid:\t1\n" : readFileSync(path, "utf8"),
  });
  const admission = fixture.admit(scan, { memoryHeadroom: () => 2 * GiB });
  assert.equal(existsSync(dead2.path), false, `the never-started writer's record was removed: ${JSON.stringify(fixture.rows)}`);
  assert.equal(readFileSync(live.path, "utf8"), live.text, "positive control: this process's own start was seen live");
  assert.match(admission.note, /and 1 live holder\(s\)/);
  assert.equal(fixture.removed()[0]!.rung, "boot-start-scan");
});

test("W1-T12822 criterion 3: no-removal-without-proof keeps every unproven record with today's count or skip", async t => {
  const eacces = failure("EACCES");
  const cases: Array<{ name: string; scan?: () => ProcessStartScan; held?: Partial<TestSlotHolder>; waiter?: Partial<TestSlotOptions>;
    skipped?: boolean; scanned?: number }> = [
    { name: "a process has the recorded start", scan: () => scanProcessStarts(fakeHost({ "/proc/42/stat": stat("100") })) },
    { name: "an unreadable stat entry", scan: () => scanProcessStarts(fakeHost({ "/proc/42/stat": eacces })) },
    { name: "an unparseable stat entry", scan: () => scanProcessStarts(fakeHost({ "/proc/42/stat": "42 (no start" })) },
    { name: "an unlistable /proc", scan: () => scanProcessStarts(fakeHost({}, { list: () => { throw eacces; } })) },
    { name: "a /proc hiding pid 1", scan: () => scanProcessStarts(fakeHost({}, { list: () => ["42"] })) },
    { name: "a waiter in a nested pid namespace", scan: () => scanProcessStarts(fakeHost({ "/proc/self/status": "NSpid:\t77\t1\n" })) },
    { name: "an unreadable waiter status", scan: () => scanProcessStarts(fakeHost({ "/proc/self/status": eacces })) },
    { name: "a scan off Linux", scan: () => scanProcessStarts(fakeHost({}, { platform: "darwin" })) },
    { name: "a record with no processStart", held: { processStart: undefined }, scanned: 0 },
    { name: "a record with a ps start", held: { processStart: "ps:Sun Nov 15 00:00:00 2026" }, scanned: 0 },
    { name: "a record with no bootId", held: { bootId: undefined }, scanned: 0 },
    { name: "a waiter with no boot id", waiter: { bootId: () => undefined }, scanned: 0 },
    { name: "a darwin waiter", waiter: { platform: "darwin" }, scanned: 0 },
    { name: "another boot's record", held: { bootId: "earlier-boot" }, skipped: true, scanned: 0 },
  ];
  for (const item of cases) {
    await t.test(item.name, t => {
      const fixture = slots(t);
      const planted = fixture.plant(record(item.held));
      const admission = fixture.admit(item.scan ?? (() => scanProcessStarts(fakeHost())), item.waiter);
      if (item.skipped) {
        assert.equal(admission.outcome, "admitted", "a record dead by boot id is skipped as today");
        assert.equal(readFileSync(planted.path, "utf8"), planted.text, "and stays in place");
      } else assertCounted(admission, planted, item.name);
      assert.equal(fixture.removed().length, 0);
      if (item.scanned !== undefined) assert.equal(fixture.scans(), item.scanned);
    });
  }
  await t.test("a scan past its bound", t => {
    const fixture = slots(t);
    const planted = fixture.plant(record());
    let calls = 0;
    t.mock.method(performance, "now", () => calls++ * 2_001);
    assertCounted(fixture.admit(), planted, "an unbounded scan");
    const bounded = scanProcessStarts(fakeHost());
    assert.equal(bounded.complete, false);
    assert.match(bounded.complete ? "" : bounded.reason, /bound/);
  });
});

test("W1-T12822 criterion 4: a record changed after its judgement stays counted, and an ENOENT removal is no error", async t => {
  const changedDuringScan = (t: TestContext, change: (path: string, text: string, seconds: number) => void) => {
    const fixture = slots(t);
    const planted = fixture.plant(record());
    // Whole seconds survive a utimes round trip exactly, so a rewrite can keep the judged size and mtime.
    const seconds = Math.floor(Date.now() / 1000) - 5;
    utimesSync(planted.path, seconds, seconds);
    const admission = fixture.admit(() => { change(planted.path, planted.text, seconds); return scanProcessStarts(fakeHost()); });
    assert.equal(admission.outcome, "wait_bound_exceeded", admission.note);
    assert.equal(existsSync(planted.path), true, "the changed record was not removed");
    assert.equal(fixture.removed().length, 0);
  };
  await t.test("same size and mtime, different content", t => changedDuringScan(t, (path, text, seconds) => {
    const before = statSync(path);
    writeFileSync(path, text.replace("dead static", "live static"));
    utimesSync(path, seconds, seconds);
    const after = statSync(path);
    assert.deepEqual([after.ino, after.size, after.mtimeMs], [before.ino, before.size, before.mtimeMs], "only the content changed");
  }));
  await t.test("same content, another inode", t => changedDuringScan(t, (path, text) => {
    writeFileSync(`${path}.new`, text);
    renameSync(`${path}.new`, path);
  }));
  await t.test("a recheck that cannot open the record", t => changedDuringScan(t, path => {
    const realOpen = fs.openSync;
    t.mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => {
      if (args[0] === path) throw failure("EACCES");
      return realOpen(...args);
    });
    syncBuiltinESMExports();
    t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  }));
  await t.test("a record gone before the recheck", t => {
    const fixture = slots(t);
    const planted = fixture.plant(record());
    const admission = fixture.admit(() => { rmSync(planted.path); return scanProcessStarts(fakeHost()); });
    assert.equal(admission.outcome, "admitted", admission.note);
    assert.equal(fixture.rows.some(row => String(row.step).includes("failed")), false);
  });
  await t.test("an unlink that finds the record already gone", t => {
    const fixture = slots(t);
    const held = record(), planted = fixture.plant(held);
    const realUnlink = fs.unlinkSync;
    t.mock.method(fs, "unlinkSync", (...args: Parameters<typeof fs.unlinkSync>) => {
      if (args[0] === planted.path) { realUnlink(...args); throw failure("ENOENT"); }
      return realUnlink(...args);
    });
    syncBuiltinESMExports();
    t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
    assertRemoved(fixture, fixture.admit(), planted, held, "boot-start-scan");
    assert.equal(fixture.rows.some(row => row.step === "test_slot.static_record_remove_failed"), false, "ENOENT is not an error");
  });
});

test("a proven-dead record that cannot be unlinked is not counted, and says so once", t => {
  const fixture = slots(t);
  const planted = fixture.plant(record());
  // A live foreign peak makes the first pass wait; the second pass finds room.
  fixture.plant(record({ processStart: "proc:200", label: "live foreign static", memoryBytes: GiB / 2 }));
  const realUnlink = fs.unlinkSync;
  t.mock.method(fs, "unlinkSync", (...args: Parameters<typeof fs.unlinkSync>) => {
    if (args[0] === planted.path) throw failure("EPERM");
    return realUnlink(...args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  let headroom = GiB;
  const admission = fixture.admit(undefined, {
    waitBoundMs: 60_000, sleep: () => { headroom = 2 * GiB; },
    memoryHeadroom: () => headroom,
  });
  assert.equal(admission.outcome, "admitted", admission.note);
  assert.match(admission.note, /and 1 live holder\(s\)/, "only the live peak was counted");
  assert.equal(existsSync(planted.path), true);
  const failed = fixture.rows.filter(row => row.step === "test_slot.static_record_remove_failed");
  assert.equal(failed.length, 1, JSON.stringify(fixture.rows));
  assert.equal(failed[0]!.name, planted.name);
  assert.match(String(failed[0]!.error), /EPERM/);
});

test("W1-T12822 criterion 5: the waiter's own record, a live ancestor's record and slot records are never removed", async t => {
  await t.test("the waiter's own record", t => {
    const fixture = slots(t);
    const others = () => readdirSync(fixture.dir).filter(name => name.startsWith("static-"));
    let during: string[] = [];
    const planted = fixture.plant(record());
    // Every same-namespace pid reads dead here, the waiter's own included.
    const admission = fixture.admit(() => { during = others(); return scanProcessStarts(fakeHost()); }, { isPidAlive: () => false });
    assert.equal(during.length, 2, "the waiter's own record stood beside the dead one during the judgement");
    assert.equal(others().filter(name => name !== planted.name).length, 1, "and still stands after it");
    assert.equal(admission.outcome, "admitted");
  });
  await t.test("a live ancestor's record, with its start or with a moved start", t => {
    for (const processStart of [testSlotProcessFacts(process.ppid)?.start, "proc:1"]) {
      const fixture = slots(t);
      const planted = fixture.plant(record({ pid: process.ppid, host: "waiter-host", pidNs: WAITER_NS, processStart, label: "author" }));
      const admission = fixture.admit();
      assert.equal(admission.outcome, "inherited", admission.note);
      assert.equal(readFileSync(planted.path, "utf8"), planted.text);
      assert.equal(fixture.removed().length, 0);
    }
  });
  await t.test("slot records", t => {
    const fixture = slots(t);
    const foreign = fixture.plant(record({ label: "foreign suite" }), "slot-1.json");
    const gone = fixture.plant(record({ pid: DEAD_PID, host: "waiter-host", pidNs: WAITER_NS, label: "dead suite" }), "slot-2.json");
    const admission = fixture.admit();
    assert.equal(admission.outcome, "wait_bound_exceeded", "the foreign slot record is still counted");
    for (const planted of [foreign, gone]) assert.equal(readFileSync(planted.path, "utf8"), planted.text, basename(planted.path));
    assert.equal(fixture.removed().length, 0);
    assert.equal(fixture.scans(), 0, "a slot record is never judged by the start scan");
  });
});
