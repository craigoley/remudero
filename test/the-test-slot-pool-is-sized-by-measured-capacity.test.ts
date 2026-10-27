// W1-T9952: the host-wide test-slot pool is sized by measured capacity. READ 2026-10-16 on the operator Mac (10 cores,
// 16 GiB): `defaultTestSlots(10)` fixed the pool at floor(10/4) = 2 whatever the load, so two single-worker holders
// closed it with most cores idle, and darwin had no memory reading at all. Now the head is admitted while the CPU the
// live holders were granted, plus the non-test load, still leaves it one worker; darwin reads vm_stat; and an explicit
// RMD_TEST_SLOTS still fixes the pool. FIXTURES ONLY: every slot dir is this test's own tmp dir.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  acquireTestSlot, acquireTestSlotAsync, configuredTestSlots, cpuAdmission, defaultTestSlots, parseVmStatHeadroom, readMemoryHeadroom, readVmStat, readVmStatAsync,
  testSlotAcquisition, testSlotCeiling, TEST_SLOTS_ENV, type HostLoad, type TestSlotLease, type TestSlotOptions,
} from "#src/lib/test-slot.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

const GiB = 1024 ** 3;
const PAGE = 16_384;
/** A real Apple-silicon `vm_stat` report's shape (macOS 14): a page-size header, then one `Pages <kind>:  N.` per line. */
const VM_STAT = [
  `Mach Virtual Memory Statistics: (page size of ${PAGE} bytes)`,
  "Pages free:                               20000.",
  "Pages active:                            270113.",
  "Pages inactive:                           40000.",
  "Pages speculative:                         3000.",
  "Pages throttled:                              0.",
  "Pages wired down:                        142145.",
  "Pages purgeable:                           2000.",
  "\"Translation faults\":                 512345678.",
  "Pages copy-on-write:                   12345678.",
].join("\n");
/** (free + inactive + purgeable + speculative) pages × page size: 65000 × 16 KiB ≈ 0.99 GiB. */
const VM_STAT_BYTES = (20_000 + 40_000 + 2_000 + 3_000) * PAGE;

function slotDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t9952-slots-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** This file decides RMD_TEST_SLOTS itself: an operator's or CI's value must not fix a pool it means to measure. */
function withSlotsEnv<T>(value: string | undefined, run: () => T): T {
  const saved = process.env[TEST_SLOTS_ENV];
  if (value === undefined) delete process.env[TEST_SLOTS_ENV];
  else process.env[TEST_SLOTS_ENV] = value;
  try { return run(); }
  finally {
    if (saved === undefined) delete process.env[TEST_SLOTS_ENV];
    else process.env[TEST_SLOTS_ENV] = saved;
  }
}

function host(dir: string, load: HostLoad, lines: string[] = []): TestSlotOptions {
  return { dir, load: () => load, memoryHeadroom: () => undefined, log: line => lines.push(line), binaryExists: () => false, queue: false };
}

function rows(lines: readonly string[], step: string): Record<string, unknown>[] {
  return lines.map(line => JSON.parse(line) as Record<string, unknown>).filter(row => row.step === step);
}

test("W1-T9952: the pool admits by granted CPU, not one slot per four cores", (t) => {
  withSlotsEnv(undefined, () => {
    assert.equal(defaultTestSlots(10, {}), 2, "the unslotted callers' share divisor is unchanged");
    assert.equal(testSlotCeiling(10), 8, "a measured pool's indexes run to cores less headroom");
    assert.equal(testSlotCeiling(2), 1, "a two-core host still has one index");

    // Idle 10-core host, two live holders granted one worker each: the pool of 2 would close; measured, it admits.
    const idle = slotDir(t);
    const lines: string[] = [];
    const opts = host(idle, { cores: 10, load1: 0 }, lines);
    const a = acquireTestSlot("a", { ...opts, maxConcurrency: 1 });
    const b = acquireTestSlot("b", { ...opts, maxConcurrency: 1 });
    assert.deepEqual([a.outcome, a.concurrency, b.outcome, b.concurrency], ["acquired", 1, "acquired", 1]);
    const third = acquireTestSlot("third", { ...opts, waitBoundMs: 0 });
    assert.equal(third.outcome, "acquired", "two single-worker holders leave six usable cores");
    assert.equal(third.concurrency, 6, "its grant is what the holders left: 10 − 2 headroom − 2 granted");
    assert.match(third.note, /^host-wide test slot 3\/8 /);
    assert.match(third.note, /admitted by measured pool: 10 cores less 2 headroom, 2 worker\(s\) granted to 2 holder\(s\), non-test load 0, memory not consulted/);
    third.release();

    // The holders' grants fill the usable cores: a run waits, and the wait names CPU.
    const full = slotDir(t);
    const fullOpts = host(full, { cores: 10, load1: 0 });
    const wide = acquireTestSlot("wide", { ...fullOpts, maxConcurrency: 4 });
    const wide2 = acquireTestSlot("wide2", { ...fullOpts, maxConcurrency: 4 });
    const waits = acquireTestSlot("waits", { ...fullOpts, waitBoundMs: 0 });
    assert.equal(waits.outcome, "wait_bound_exceeded");
    assert.match(waits.note, /CPU full: 8 worker\(s\) granted to 2 live holder\(s\) and non-test load 0 leave 0 of 8 usable core\(s\)/);
    wide.release(); wide2.release();

    // Non-test load counts too, but a holder's own work in load1 is never counted twice.
    const loaded = slotDir(t);
    const one = acquireTestSlot("one", { ...host(loaded, { cores: 10, load1: 0 }), maxConcurrency: 1 });
    const two = acquireTestSlot("two", { ...host(loaded, { cores: 10, load1: 0 }), maxConcurrency: 1 });
    const busy = acquireTestSlot("busy", { ...host(loaded, { cores: 10, load1: 8 }), waitBoundMs: 0 });
    assert.equal(busy.outcome, "wait_bound_exceeded", "load1 8 less the holders' 2 workers is 6 non-test: no core left");
    assert.match(busy.note, /non-test load 6 leave 0 of 8/);
    one.release(); two.release();
    assert.deepEqual(cpuAdmission({ cores: 10, load1: 1 }, 2), { cores: 10, headroomCores: 2, granted: 2, nonTestLoad: 0, left: 6, concurrency: 6 });
    assert.equal(cpuAdmission({ cores: 10, load1: 0 }, 0, 2).concurrency, 4, "a grant is shared with the waiters behind it");

    // A waiter admitted when a holder leaves names the inputs that admitted it on its `test_slot.acquired` row.
    const later: string[] = [];
    const head = acquireTestSlot("head", { ...fullOpts, maxConcurrency: 4 });
    const next = acquireTestSlot("next", { ...fullOpts, maxConcurrency: 4 });
    const gen = testSlotAcquisition("later", { ...host(full, { cores: 10, load1: 0 }, later), pollMs: 1 });
    assert.equal(gen.next().done, false, "first poll: the grants fill the pool");
    head.release();
    const step = gen.next();
    assert.equal(step.done, true);
    const lease = step.value as TestSlotLease;
    assert.equal(lease.outcome, "acquired");
    assert.equal(lease.concurrency, 4);
    const [acquired] = rows(later, "test_slot.acquired");
    assert.deepEqual(acquired?.admission, { pool: "measured pool", ceiling: 8, cores: 10, headroomCores: 2, holders: 1, grantedToHolders: 4,
      nonTestLoad: 0, memoryHeadroomBytes: null, namedPeaksBytes: 0 });
    lease.release(); next.release();
  });
});

test("W1-T9952: darwin memory headroom gates admission", async (t) => {
  const noProc = (path: string): string => { throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" }); };
  assert.equal(parseVmStatHeadroom(VM_STAT), VM_STAT_BYTES);
  assert.equal(parseVmStatHeadroom("Pages free: 10."), undefined, "no page size: no reading");
  assert.equal(parseVmStatHeadroom(undefined), undefined);
  assert.equal(readMemoryHeadroom(noProc, { platform: "darwin", vmStat: () => VM_STAT }), VM_STAT_BYTES, "darwin reads vm_stat");
  assert.equal(readMemoryHeadroom(noProc, { platform: "darwin", vmStat: () => undefined }), undefined, "an unreadable vm_stat stays undefined");
  assert.equal(readMemoryHeadroom(noProc, { platform: "darwin" }), undefined, "no reader handed in: the default never spawns");
  let spawned = 0;
  assert.equal(readMemoryHeadroom(noProc, { platform: "linux", vmStat: () => { spawned += 1; return VM_STAT; } }), undefined);
  assert.equal(spawned, 0, "Linux never spawns vm_stat");

  const saved = process.env[TEST_SLOTS_ENV];
  delete process.env[TEST_SLOTS_ENV];
  t.after(() => { if (saved !== undefined) process.env[TEST_SLOTS_ENV] = saved; });
  // A 10-core Mac whose vm_stat leaves ~0.99 GiB: a holder naming 0.75 GiB leaves no room for a 0.5 GiB run beside it.
  // No `memoryHeadroom` is injected: the driver itself reads the (fake) vm_stat, at most once per poll.
  let reports = 0;
  const vmStat = (): string => { reports += 1; return VM_STAT; };
  const opts = { ...host(slotDir(t), { cores: 10, load1: 0 }), memoryHeadroom: undefined, platform: "darwin" as const, vmStat };
  const held = acquireTestSlot("typecheck", { ...opts, maxConcurrency: 1, memoryBytes: 0.75 * GiB });
  assert.equal(reports, 0, "a run with no other holder never asks for memory, so nothing spawns");
  const waits = acquireTestSlot("suite", { ...opts, memoryBytes: 0.5 * GiB, waitBoundMs: 0 });
  assert.equal(waits.outcome, "wait_bound_exceeded", "CPU has room; memory read from vm_stat closes the slot");
  assert.match(waits.note, /memory headroom 1016 MiB < 1280 MiB for this run and the live holders' peaks/);
  assert.equal(reports, 1, "one report served every slot of that poll");
  const waitsAsync = await acquireTestSlotAsync("suite-async", { ...opts, memoryBytes: 0.5 * GiB, waitBoundMs: 0 });
  assert.equal(waitsAsync.outcome, "wait_bound_exceeded", "the async driver reads the same darwin headroom");
  const fits = acquireTestSlot("small", { ...opts, memoryBytes: 0.2 * GiB, waitBoundMs: 0 });
  assert.equal(fits.outcome, "acquired", "a peak the headroom holds beside the holder's is admitted");
  assert.match(fits.note, /memory headroom 1016 MiB, named peaks 768 MiB$/);
  fits.release();
  const linux = acquireTestSlot("linux", { ...opts, platform: "linux", memoryHeadroom: () => undefined, memoryBytes: 0.5 * GiB, waitBoundMs: 0 });
  assert.equal(linux.outcome, "acquired", "the same pair with no darwin reading is admitted on count, as before");
  assert.match(linux.note, /memory headroom unread/);
  linux.release();

  // The drivers' own default readers: on this host (vm_stat on darwin; absent elsewhere) the note names the reading.
  const real = { ...opts, vmStat: undefined, maxConcurrency: 1, memoryBytes: 1024 ** 2, waitBoundMs: 0 };
  const named = acquireTestSlot("named", real);
  const namedAsync = await acquireTestSlotAsync("named-async", real);
  for (const lease of [named, namedAsync]) {
    assert.match(lease.note, /; admitted by measured pool: .*, (memory headroom \d+ MiB|memory headroom unread), named peaks 76[89] MiB$/);
    lease.release();
  }
  held.release();
});

test("W1-T9952: the default vm_stat readers return undefined when vm_stat cannot run", async (t) => {
  const missing = join(slotDir(t), "no-such-vm_stat");
  assert.equal(readVmStat(missing), undefined);
  assert.equal(await readVmStatAsync(missing), undefined);
});

test("W1-T9952: the real default vm_stat reader reads this darwin host",
  { skip: process.platform === "darwin" ? false : "not a darwin host: the real vm_stat reader runs only on macOS" }, async () => {
    const headroom = readMemoryHeadroom(undefined, { vmStat: readVmStat });
    assert.ok(headroom !== undefined && headroom > 0, `vm_stat gave a positive headroom (${String(headroom)})`);
    assert.equal(parseVmStatHeadroom(await readVmStatAsync()) !== undefined, true, "the async reader reads it too");
  });

test("W1-T9952: RMD_TEST_SLOTS still overrides the measured pool", (t) => {
  assert.equal(configuredTestSlots({ [TEST_SLOTS_ENV]: "2" }), 2);
  assert.equal(configuredTestSlots({ [TEST_SLOTS_ENV]: "zero" }), undefined, "an unusable value fixes nothing");
  assert.equal(configuredTestSlots({}), undefined);
  const third = (env: string | undefined, extra: Partial<TestSlotOptions> = {}): TestSlotLease => withSlotsEnv(env, () => {
    const opts = { ...host(slotDir(t), { cores: 10, load1: 0 }), ...extra };
    const a = acquireTestSlot("a", { ...opts, maxConcurrency: 1 });
    const b = acquireTestSlot("b", { ...opts, maxConcurrency: 1 });
    const c = acquireTestSlot("c", { ...opts, waitBoundMs: 0 });
    c.release(); a.release(); b.release();
    if (env !== undefined) assert.match(b.note, new RegExp(`^host-wide test slot 2/${env} .*admitted by RMD_TEST_SLOTS=${env} pool`));
    return c;
  });
  assert.equal(third(undefined).outcome, "acquired", "measured: two single-worker holders leave room");
  const fixed = third("2");
  assert.equal(fixed.outcome, "wait_bound_exceeded", "RMD_TEST_SLOTS=2 fixes the pool at two whatever the CPU holds");
  assert.match(fixed.note, /slot 1: pid \d+ .*slot 2: pid \d+/);
  assert.equal(third("3").outcome, "acquired", "RMD_TEST_SLOTS=3 opens a third");
  assert.equal(third(undefined, { slots: 2 }).outcome, "wait_bound_exceeded", "an explicit `slots` option fixes it too");
});
