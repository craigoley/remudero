import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import {
  acquireTestSlot, enqueueTestSlot, TEST_SLOT_LEASE_MS, testSlotProcessFacts,
  type TestSlotHolder, type TestSlotOptions,
} from "#src/lib/test-slot.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

const UID = process.getuid?.() ?? 0;
const LABEL = "preflight-author:static-and-affected";
/** The two records moved aside on 2026-11-11 had a last beat 5 min 40 s after their start. */
const BEAT_AFTER_START_MS = 339_761;
/** The waiter read them about 13 h 40 min after that beat. */
const SEEN_AFTER_BEAT_MS = 49_200_000 - BEAT_AFTER_START_MS;

function slotDir(t: TestContext, kind: string): string {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t12295-${kind}-`));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(`${dir}.queue`, { recursive: true, force: true });
  });
  return dir;
}

/** The pid of a child this test started and waited for: no process holds it now. */
function deadPid(): number {
  const exited = spawnSync(process.execPath, ["-e", ""], { stdio: "ignore" });
  assert.equal(exited.status, 0);
  return exited.pid!;
}

/** A child this test starts and stops; no other process is ever probed or signalled. */
function liveChild(t: TestContext): { pid: number; start: string } {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  t.after(() => { child.kill(); });
  const start = testSlotProcessFacts(child.pid!)?.start;
  assert.ok(start, "positive control: ps -p names the live child");
  return { pid: child.pid!, start };
}

/** A record shaped like /tmp/rmd-test-slots/slot-1.json as moved aside on 2026-11-11, timed from `startedAt`. */
function macRecord(startedAt: number, extra: Partial<TestSlotHolder> = {}): TestSlotHolder {
  return {
    pid: deadPid(), host: hostname(), startedAt: new Date(startedAt).toISOString(),
    heartbeatAt: new Date(startedAt + BEAT_AFTER_START_MS).toISOString(), label: LABEL,
    ownerNonce: "34366f4b-13fc-4760-a800-5c565578e05e", processStart: "ps:Tue Nov 10 18:02:55 2026", concurrency: 1,
    ownerUid: UID, memoryBytes: 536_870_912, workIdentity: "reservation-marker-v1", ...extra,
  };
}

/** A shared (legacy writer) record whatever the umask: the mode the moved files had. */
function writeRecord(path: string, held: TestSlotHolder, mode = 0o644): void {
  writeFileSync(path, JSON.stringify(held), { mode });
  chmodSync(path, mode);
}

/** A clock fixed at `now` whose sleep advances it, so a bounded wait runs in no real time. */
function clockAt(now: number) {
  return { clock: { now: () => now, date: () => new Date(now), iso: () => new Date(now).toISOString() }, sleep: (ms: number) => { now += ms; } };
}

/** A Mac waiter: no boot id and no pid namespace, the real pid probe and the real `ps -p`. */
function macWaiter(dir: string, lines: string[], now: number, extra: Partial<TestSlotOptions> = {}): TestSlotOptions {
  const { clock, sleep } = clockAt(now);
  return {
    dir, slots: 1, queue: false, waitBoundMs: 0, pollMs: 1, platform: "darwin", bootId: () => undefined, pidNamespace: () => undefined,
    load: () => ({ cores: 8, load1: 0 }), memoryHeadroom: () => undefined, clock, sleep,
    log: line => lines.push(line), say: () => {}, ...extra,
  };
}

function rows(lines: string[], step: string): Record<string, unknown>[] {
  return lines.map(line => JSON.parse(line) as Record<string, unknown>).filter(row => row.step === step);
}

test("W1-T12295 criterion 1: a dead marker holder on a Mac, silent past the lease, is reclaimed with a row that names it", t => {
  const dir = slotDir(t, "dead"), path = join(dir, "slot-1.json");
  const started = Date.now() - 60_000, held = macRecord(started);
  writeRecord(path, held);
  const lines: string[] = [];
  const lease = acquireTestSlot("mac waiter", macWaiter(dir, lines, started + BEAT_AFTER_START_MS + SEEN_AFTER_BEAT_MS));
  t.after(() => lease.release());
  assert.equal(lease.outcome, "acquired", lease.note);
  assert.equal(lease.executionAllowed, true);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).label, "mac waiter", "the waiter now holds slot 1");
  const reclaimed = rows(lines, "test_slot.reclaimed_quiescent");
  assert.equal(reclaimed.length, 1, lines.join("\n"));
  assert.deepEqual([reclaimed[0]!.slot, reclaimed[0]!.pid, reclaimed[0]!.holder, reclaimed[0]!.coverage],
    [1, held.pid, LABEL, "darwin-owner-pid"]);
  assert.match(String(reclaimed[0]!.reason), new RegExp(`owner pid ${held.pid} gone`));
});

test("W1-T12295 criterion 2: a queued waiter counts dead Mac holders as open slots", t => {
  const dir = slotDir(t, "queued");
  const started = Date.now() - 60_000;
  writeRecord(join(dir, "slot-1.json"), macRecord(started));
  writeRecord(join(dir, "slot-2.json"), macRecord(started + 145_000, { ownerNonce: "6810afff-3304-40ac-ba5e-0e4b5c245eb4", processStart: "ps:Tue Nov 10 18:04:47 2026" }));
  const now = started + BEAT_AFTER_START_MS + SEEN_AFTER_BEAT_MS;
  const lines: string[] = [];
  const common = macWaiter(dir, lines, now, { slots: 2, queue: true });
  const head = enqueueTestSlot("head waiter", common);
  const tail = enqueueTestSlot("tail waiter", common);
  assert.deepEqual([head.position, tail.position], [1, 2]);
  // The tail polls while the head's ticket is live: it may take a slot only if both dead holders count as open.
  const tailLease = tail.admit();
  t.after(() => tailLease.release());
  assert.equal(tailLease.outcome, "acquired", `${tailLease.note}\n${lines.join("\n")}`);
  const headLease = head.admit();
  t.after(() => headLease.release());
  assert.equal(headLease.outcome, "acquired", headLease.note);
  assert.equal(rows(lines, "test_slot.reclaimed_quiescent").length, 2);
});

test("W1-T12295 criterion 3: a holder whose pid is alive with its recorded start is never reclaimed", t => {
  const owner = liveChild(t), now = Date.now();
  // The second record's start time is two hours before the process it names: the start-time rung alone
  // would call that pid reused, and the recorded `ps -p` start still keeps it.
  for (const [name, started] of [["a record written after its owner started", now], ["a record whose clock ran behind", now - 2 * 3_600_000]] as const) {
    const dir = slotDir(t, "live"), path = join(dir, "slot-1.json");
    const held = macRecord(started, { pid: owner.pid, processStart: owner.start });
    writeRecord(path, held);
    const lines: string[] = [];
    const lease = acquireTestSlot("mac waiter", macWaiter(dir, lines, started + 13 * 3_600_000));
    lease.release();
    assert.equal(lease.outcome, "wait_bound_exceeded", `${name}: ${lease.note}`);
    assert.equal(lease.executionAllowed, false, name);
    assert.equal(readFileSync(path, "utf8"), JSON.stringify(held), `${name}: the record is not changed`);
    assert.equal(rows(lines, "test_slot.reclaimed_quiescent").length, 0, name);
  }
});

test("W1-T12295 criterion 4: a pid reused by a process that started after the record is reclaimed", t => {
  const dir = slotDir(t, "reused"), path = join(dir, "slot-1.json");
  const other = liveChild(t), started = Date.now() - 2 * 3_600_000;
  assert.notEqual(other.start, "ps:Tue Nov 10 18:02:55 2026");
  writeRecord(path, macRecord(started, { pid: other.pid }));
  const lines: string[] = [];
  const lease = acquireTestSlot("mac waiter", macWaiter(dir, lines, started + BEAT_AFTER_START_MS + TEST_SLOT_LEASE_MS + 60_000));
  t.after(() => lease.release());
  assert.equal(lease.outcome, "acquired", `${lease.note}\n${lines.join("\n")}`);
  assert.equal(rows(lines, "test_slot.reclaimed_quiescent")[0]?.coverage, "darwin-owner-pid");
});

test("W1-T12295 criterion 5: a dead owner whose last beat is inside the lease keeps its slot", t => {
  const dir = slotDir(t, "inside"), path = join(dir, "slot-1.json");
  const started = Date.now() - 60_000, held = macRecord(started);
  writeRecord(path, held);
  const lines: string[] = [];
  const lease = acquireTestSlot("mac waiter", macWaiter(dir, lines, started + BEAT_AFTER_START_MS + 30 * 60_000));
  t.after(() => lease.release());
  assert.equal(lease.outcome, "wait_bound_exceeded", lease.note);
  assert.equal(lease.executionAllowed, false, "covered work may still run: NOT_RUN");
  assert.equal(readFileSync(path, "utf8"), JSON.stringify(held));
  const withheld = rows(lines, "test_slot.reclaim_withheld");
  assert.equal(withheld.length, 1, lines.join("\n"));
  assert.deepEqual([withheld[0]!.coverage, withheld[0]!.evidence], ["darwin-owner-pid", "unknown"]);
});

test("W1-T12295 criterion 6: linux, a boot id, a pid namespace, another uid and another host keep today's rules", t => {
  const started = Date.now() - 60_000;
  const late = started + BEAT_AFTER_START_MS + SEEN_AFTER_BEAT_MS;
  const cases: { name: string; record?: Partial<TestSlotHolder>; waiter?: Partial<TestSlotOptions>; now?: number }[] = [
    { name: "a linux waiter", waiter: { platform: "linux" } },
    { name: "a record and a waiter with one boot id", record: { bootId: "boot-1" }, waiter: { bootId: () => "boot-1" } },
    { name: "a waiter with a boot id", waiter: { bootId: () => "boot-1" } },
    { name: "a record and a waiter with one pid namespace", record: { pidNs: "ns-1" }, waiter: { pidNamespace: () => "ns-1" } },
    { name: "a record for another uid", record: { ownerUid: UID + 1 } },
    { name: "a record with no uid", record: { ownerUid: undefined } },
    { name: "a record on another host inside its lease", record: { host: "another-mac" }, now: started + BEAT_AFTER_START_MS + 10 * 60_000 },
  ];
  for (const { name, record, waiter, now } of cases) {
    const dir = slotDir(t, "kept"), path = join(dir, "slot-1.json");
    const held = macRecord(started, record);
    writeRecord(path, held);
    const lines: string[] = [];
    const lease = acquireTestSlot("mac waiter", macWaiter(dir, lines, now ?? late, waiter));
    lease.release();
    assert.notEqual(lease.outcome, "acquired", `${name}: ${lease.note}`);
    assert.equal(readFileSync(path, "utf8"), JSON.stringify(held), `${name}: the record is not changed`);
    assert.equal(rows(lines, "test_slot.reclaimed_quiescent").length, 0, name);
  }
});
