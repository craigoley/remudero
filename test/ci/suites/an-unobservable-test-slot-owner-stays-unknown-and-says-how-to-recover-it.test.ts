import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import {
  acquireTestSlot, enqueueTestSlot, judgeTestSlotHoldAge, TEST_SLOT_LEASE_MS,
  type TestSlotHolder, type TestSlotOptions,
} from "#src/lib/test-slot.js";
// @ts-ignore the executable .mjs module has no declaration file.
import { runOwnerRelease } from "#scripts/test-slot-owner-release.mjs";

const NOW = Date.parse("2026-11-11T12:00:00.000Z");
const OWNER_UID = process.getuid?.() ?? 1000;
const LEASE_PAST = new Date(NOW - TEST_SLOT_LEASE_MS - 60_000).toISOString();

function holder(extra: Partial<TestSlotHolder> = {}): TestSlotHolder {
  return {
    pid: 424242, host: hostname(), bootId: "boot", startedAt: new Date(NOW - 3 * 60 * 60_000).toISOString(),
    heartbeatAt: LEASE_PAST, label: "sandboxed author preflight", ownerNonce: "aged-owner", processStart: "proc:100",
    pidNs: "pid:[owner]", ownerUid: OWNER_UID, ...extra,
  };
}

function tempSlotDir(t: TestContext, label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t11809-${label}-`));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(dir + ".queue", { recursive: true, force: true });
  });
  return dir;
}

/** A clock that advances by exactly the slept time, so several polls run without real waiting. */
function steppedClock() {
  let now = NOW;
  return {
    clock: { now: () => now, date: () => new Date(now), iso: () => new Date(now).toISOString() },
    sleep: (ms: number) => { now += Math.max(1, ms); },
  };
}

function waiterOptions(dir: string, rows: Record<string, unknown>[], said: string[], extra: Partial<TestSlotOptions> = {}): TestSlotOptions {
  const { clock, sleep } = steppedClock();
  return {
    dir, slots: 1, queue: false, waitBoundMs: 30, pollMs: 10, platform: "linux", clock, sleep,
    hostname, bootId: () => "boot", pidNamespace: () => "pid:[waiter]", cgroupNamespace: () => "cgroup:[waiter]", isPidAlive: () => false,
    load: () => ({ cores: 8, load1: 0 }), memoryHeadroom: () => undefined,
    log: line => rows.push(JSON.parse(line)), say: line => said.push(line), ...extra,
  };
}

/** Split the recovery command the way a POSIX shell would for single-quoted words, stopping at its comment. */
function shellWords(line: string): string[] {
  const words: string[] = [];
  let word = "", quoted = false, started = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (quoted) { if (ch === "'") quoted = false; else word += ch; continue; }
    if (ch === "'") { quoted = true; started = true; continue; }
    if (ch === "#" && !started) break;
    if (ch === " ") { if (started) words.push(word); word = ""; started = false; continue; }
    word += ch; started = true;
  }
  if (started) words.push(word);
  return words;
}

test("a same-boot foreign-namespace owner past the lease keeps its slot and logs one owner_aged row with a runnable recovery line", t => {
  const dir = tempSlotDir(t, "aged");
  const path = join(dir, "slot-1.json");
  const held = holder();
  writeFileSync(path, JSON.stringify(held), { mode: 0o644 });
  const before = readFileSync(path, "utf8");
  const rows: Record<string, unknown>[] = [], said: string[] = [];
  const lease = acquireTestSlot("same-kernel waiter", waiterOptions(dir, rows, said));
  t.after(() => lease.release());

  assert.equal(lease.outcome, "wait_bound_exceeded", "heartbeat age alone never frees a same-kernel foreign owner");
  assert.equal(readFileSync(path, "utf8"), before, "the aged hold is NOT cleared");
  const polls = rows.filter(row => row.step === "test_slot.waiting").length + rows.filter(row => row.step === "test_slot.wait_bound_exceeded").length;
  assert.equal(polls, 2, "a waiting row then a bound row: the waiter polled more than once");
  const aged = rows.filter(row => row.step === "test_slot.owner_aged");
  assert.equal(aged.length, 1, "one row per ownerNonce per waiter, never one per poll");
  const row = aged[0]!;
  assert.equal(row.slot, 1);
  assert.equal(row.holder, held.label);
  assert.equal(row.host, held.host);
  assert.equal(row.ownerUid, OWNER_UID);
  assert.deepEqual(row.pidNs, { record: "pid:[owner]", waiter: "pid:[waiter]" });
  assert.deepEqual(row.cgroupNs, { record: null, waiter: "cgroup:[waiter]" });
  assert.equal(row.bootIdMatch, true);
  assert.equal(row.startedAt, held.startedAt);
  assert.equal(row.heartbeatAt, held.heartbeatAt);
  assert.ok(typeof row.ageMs === "number" && row.ageMs >= 3 * 60 * 60_000);
  assert.ok(typeof row.silentMs === "number" && row.silentMs > TEST_SLOT_LEASE_MS);
  assert.equal(row.boundMs, TEST_SLOT_LEASE_MS, "a cadence-less record is aged by the lease, now a diagnostic bound");
  assert.deepEqual(row.missingEvidence, ["pid namespace differs: owner pid unprobeable from here", "no pinned cgroup identity recorded"]);
  assert.equal(row.decision, "retained: an aged foreign hold is UNKNOWN, never released by heartbeat age");

  const recovery = String(row.recovery);
  assert.match(recovery, new RegExp(`# run as uid ${OWNER_UID} inside pid namespace pid:\\[owner\\]$`));
  const words = shellWords(recovery);
  assert.deepEqual(words.slice(0, 4), ["node", "--import", "tsx", "scripts/test-slot-owner-release.mjs"]);
  assert.deepEqual(words.slice(4), ["--slot-dir", dir, "--slot", "1", "--nonce", "aged-owner", "--pid", "424242", "--start", "proc:100"]);
  const run = runOwnerRelease(words.slice(4));
  assert.equal(run.row.outcome, "refused", "from the waiter's namespace the owner-lane command refuses rather than guessing");
  assert.equal(run.row.reason, "reservation host, boot, namespace or owner identity is unproven", "the command named the exact reservation file");
  assert.equal(readFileSync(path, "utf8"), before);

  const human = said.filter(line => line.includes("UNKNOWN"));
  assert.equal(human.length, 1, "the same diagnostic is one human stderr line");
  assert.ok(human[0]!.includes(recovery));
  const bound = rows.find(r => r.step === "test_slot.wait_bound_exceeded");
  assert.ok((bound?.holders as string[]).some(h => /^slot 1: pid 424242 on .* UNKNOWN \(aged 3h0m\)$/.test(h)), JSON.stringify(bound?.holders));
});

test("a same-boot foreign-host owner is never freed by heartbeat age either", t => {
  const dir = tempSlotDir(t, "host");
  const path = join(dir, "slot-1.json");
  writeFileSync(path, JSON.stringify(holder({ host: "another-cell", pidNs: undefined })), { mode: 0o644 });
  const rows: Record<string, unknown>[] = [], said: string[] = [];
  const lease = acquireTestSlot("same-kernel waiter", waiterOptions(dir, rows, said));
  t.after(() => lease.release());
  assert.equal(lease.outcome, "wait_bound_exceeded");
  const aged = rows.filter(row => row.step === "test_slot.owner_aged");
  assert.equal(aged.length, 1);
  assert.deepEqual(aged[0]!.missingEvidence, ["host differs: owner pid unprobeable from here", "no pinned cgroup identity recorded"]);
});

test("a different boot id is still reclaimed", t => {
  const dir = tempSlotDir(t, "boot");
  const path = join(dir, "slot-1.json");
  writeFileSync(path, JSON.stringify(holder({ bootId: "earlier-boot" })), { mode: 0o644 });
  const rows: Record<string, unknown>[] = [], said: string[] = [];
  const lease = acquireTestSlot("same-kernel waiter", waiterOptions(dir, rows, said));
  t.after(() => lease.release());
  assert.equal(lease.outcome, "acquired", lease.note);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).label, "same-kernel waiter");
  assert.equal(rows.some(row => row.step === "test_slot.owner_aged"), false, "a proven-ended owner is not UNKNOWN");
});

test("a waiter with no boot id keeps the lease judgment outside the Linux seam", t => {
  const dir = tempSlotDir(t, "nobootid");
  const path = join(dir, "slot-1.json");
  writeFileSync(path, JSON.stringify(holder({ host: "another-mac", pidNs: undefined, bootId: undefined })), { mode: 0o644 });
  const lease = acquireTestSlot("mac waiter", waiterOptions(dir, [], [], { platform: "darwin", bootId: () => undefined, pidNamespace: () => undefined }));
  t.after(() => lease.release());
  assert.equal(lease.outcome, "acquired", lease.note);
});

test("a namespace-mismatch record names that as missing evidence", t => {
  const scope = { path: "/user.slice/user-1000.slice/run-W1-T11809.scope", dedicated: true, dev: 17, ino: 29, cgroupNs: "cgroup:[owner]" };
  const held = holder({ cgroupScope: scope, heartbeatIntervalMs: 60_000, heartbeatAt: new Date(NOW - 4 * 60_000).toISOString() });
  const judged = judgeTestSlotHoldAge(held, { hostname: hostname(), bootId: "boot", pidNs: "pid:[waiter]", cgroupNs: "cgroup:[waiter]",
    slotDir: "/scratch/rmd/test-slots", slot: 2, probeReason: "cgroup namespace differs from the recorded owner" }, NOW);
  assert.equal(judged?.aged, true, "silence past three recorded beats is aged");
  assert.equal(judged?.boundMs, 3 * 60_000);
  assert.deepEqual(judged?.cgroupNs, { record: "cgroup:[owner]", waiter: "cgroup:[waiter]" });
  assert.deepEqual(judged?.missingEvidence, [
    "pid namespace differs: owner pid unprobeable from here",
    "cgroup namespace differs",
    "cgroup identity probe: cgroup namespace differs from the recorded owner",
  ]);
  assert.equal(judged?.recoveryCommand,
    "node --import tsx scripts/test-slot-owner-release.mjs --slot-dir /scratch/rmd/test-slots --slot 2 --nonce aged-owner --pid 424242 --start proc:100");
  const fresh = judgeTestSlotHoldAge({ ...held, heartbeatAt: new Date(NOW - 60_000).toISOString() },
    { hostname: hostname(), bootId: "boot", pidNs: "pid:[waiter]", slotDir: "/d", slot: 2 }, NOW);
  assert.equal(fresh?.aged, false);
  assert.equal(judgeTestSlotHoldAge(held, { hostname: hostname(), bootId: "boot", pidNs: "pid:[owner]", slotDir: "/d", slot: 2 }, NOW), undefined,
    "a same-namespace record is judged by the local pid probe, not aged");
  assert.equal(judgeTestSlotHoldAge(held, { hostname: hostname(), bootId: "other", pidNs: "pid:[waiter]", slotDir: "/d", slot: 2 }, NOW), undefined,
    "a different boot id is proven ended, not UNKNOWN");
});

test("a later waiter behind an aged hold keeps its FIFO position", t => {
  const dir = tempSlotDir(t, "fifo");
  const path = join(dir, "slot-1.json");
  // This path reads the real clock, so the hold is aged past the lease against Date.now().
  const real = Date.now();
  writeFileSync(path, JSON.stringify(holder({ startedAt: new Date(real - 3 * 60 * 60_000).toISOString(),
    heartbeatAt: new Date(real - TEST_SLOT_LEASE_MS - 60_000).toISOString() })), { mode: 0o644 });
  const before = readFileSync(path, "utf8");
  const rows: Record<string, unknown>[] = [];
  const common: TestSlotOptions = {
    dir, slots: 2, queue: true, waitBoundMs: 0, pollMs: 1, platform: "linux",
    hostname, bootId: () => "boot", pidNamespace: () => "pid:[waiter]", isPidAlive: (pid: number) => pid === process.pid,
    load: () => ({ cores: 8, load1: 0 }), memoryHeadroom: () => undefined, log: line => rows.push(JSON.parse(line)), say: () => {},
  };
  const head = enqueueTestSlot("head-ticket", common);
  const tail = enqueueTestSlot("tail-ticket", common);
  assert.equal(head.position, 1);
  assert.equal(tail.position, 2);
  const headLease = head.admit();
  t.after(() => headLease.release());
  assert.equal(headLease.outcome, "acquired", headLease.note);
  const tailLease = tail.admit();
  t.after(() => tailLease.release());
  assert.notEqual(tailLease.outcome, "acquired", "the aged hold's capacity is never handed to the next waiter");
  assert.equal(readFileSync(path, "utf8"), before);
  assert.equal(rows.find(row => row.step === "test_slot.acquired" && row.label === "head-ticket")?.slot, 2, "the head took the free slot beside the hold");
  assert.equal(rows.filter(row => row.step === "test_slot.owner_aged" && row.label === "tail-ticket").length, 1);
});
