/**
 * W1-T9570: after an answered tier-2 shed the supervisor reads free memory until the reading fits the need or a cap
 * passes, judges that reading, and records the cgroup's swap before and after the shed in the tier-2 row.
 *
 * The fixture replays the first live tier-2 shed with W1-T9508 (serve, 2026-10-15T02:25:43Z): the reply came 568 ms
 * after the request, the one immediate read was 4.30 GB against a 4.94 GB need, and the supervisor restored the
 * workers 4 ms later. A 1-second sampler of the same cgroup read a plateau, then +1.17 GB eight seconds after the
 * reply. The falsifier: judge the first reading again, and the handoff restores, defers and the first test fails.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  cgroupSwapCurrent, createServeSupervisor, HANDOFF_NEED_MARGIN, SHED_SETTLE_CAP_MS, SHED_SETTLE_READ_INTERVAL_MS,
  type GenerationProcess, type PreparedSlot, type ServeSupervisorOptions,
} from "#src/lib/serve-supervisor.js";
import { GENERATION_MESSAGES, type GenerationMessage } from "#src/lib/serve-generation.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

const tick = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const GB = 1e9;
/** The boot peak sampled at promotion; the need is it times the margin (4.94 GB, as in the live row). */
const BOOT_PEAK = 3_290_057_387;
const NEED = Math.ceil(BOOT_PEAK * HANDOFF_NEED_MARGIN);
const SHORT = 4.09 * GB;
/** The live 02:25:43Z reads, one a second from the reply: a plateau, then the release at +8 s. */
const LIVE_SETTLE = [4.3 * GB, 4.28 * GB, 4.28 * GB, 4.25 * GB, 4.16 * GB, 4.07 * GB, 4.03 * GB, 4.02 * GB, 5.19 * GB];
const BACKSTOP_MS = 7;
const DEFER_MS = 60_000;

interface Fake extends GenerationProcess {
  sent: GenerationMessage[];
  emit(message: GenerationMessage): void;
  die(): void;
  slot: PreparedSlot;
}

/**
 * Fake generations that answer every message (tier 2 only when `answers`). Free memory is SHORT until the workers are
 * shed; then `afterShed` is read in order, its last value repeating. A settle read's sleep advances the fake clock.
 */
function harness(opts: { afterShed: Array<number | undefined>; answers?: boolean; extra?: Partial<ServeSupervisorOptions> }) {
  const generations: Fake[] = [];
  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const retries: Array<() => void> = [];
  const events: string[] = [];
  const naps: number[] = [];
  let now = 0;
  const spawn: ServeSupervisorOptions["spawn"] = (command) => {
    const slot = JSON.parse(command.args[0]) as PreparedSlot;
    const listeners: Array<(m: GenerationMessage) => void> = [];
    const exits: Array<(c: number | null, s: string | null) => void> = [];
    let dead = false;
    const gen: Fake = {
      pid: generations.length + 1,
      slot,
      sent: [],
      send(message) {
        gen.sent.push(message);
        events.push(`send:${message.type}`);
        const answer = (reply: GenerationMessage): void => queueMicrotask(() => gen.emit(reply));
        if (message.type === GENERATION_MESSAGES.promote) answer({ type: GENERATION_MESSAGES.promoted });
        if (message.type === GENERATION_MESSAGES.shed) answer({ type: GENERATION_MESSAGES.shed_done, beforeBytes: 3.8 * GB, afterBytes: 3.8 * GB });
        if (message.type === GENERATION_MESSAGES.shed_workers && opts.answers !== false) {
          answer({ type: GENERATION_MESSAGES.shed_workers_done, beforeBytes: 3_813_642_240, afterBytes: 3_594_457_088, workers: 6, heapBytes: 2_521_855_045 });
        }
        if (message.type === GENERATION_MESSAGES.restore_workers) answer({ type: GENERATION_MESSAGES.restore_workers_done });
        if (message.type === GENERATION_MESSAGES.drain) queueMicrotask(() => gen.die());
      },
      onMessage: (l) => void listeners.push(l),
      onExit: (l) => void exits.push(l),
      kill: () => gen.die(),
      emit: (m) => listeners.forEach((l) => l(m)),
      die() {
        if (dead) return;
        dead = true;
        exits.forEach((l) => l(0, null));
      },
    };
    generations.push(gen);
    return gen;
  };
  const get: ServeSupervisorOptions["get"] = async (socketPath, path) => {
    if (path.startsWith("/v1/ready")) return { status: 200, body: JSON.stringify({ ready: true, criteria: [{ name: "read_model_warm", ok: true }] }) };
    if (path === "/v1/version") return { status: 200, body: JSON.stringify({ sha: generations[Number(socketPath.split("/").pop()) - 1]?.slot.sha }) };
    return { status: 200, body: "{}" };
  };
  const shed = (): boolean => generations[0]?.sent.some((m) => m.type === GENERATION_MESSAGES.shed_workers) ?? false;
  let reads = 0;
  const freeMemory = (): number | undefined => {
    if (!shed()) return SHORT;
    events.push("read");
    const value = opts.afterShed[Math.min(reads, opts.afterShed.length - 1)];
    reads += 1;
    return value;
  };
  let sha = 1;
  const supervisor = createServeSupervisor({
    coldSlot: { dir: "/cold", sha: "sha-1" },
    prepare: async (activeDir) => ({ dir: activeDir === "/slot-a" ? "/slot-b" : "/slot-a", sha: `sha-${++sha}` }),
    spawn,
    get,
    command: (slot) => ({ exec: "gen", execArgv: [], args: [JSON.stringify(slot)], cwd: slot.dir }),
    log: (step, extra) => {
      logs.push({ step, extra });
      events.push(`log:${step}:${String(extra?.phase ?? "")}`);
    },
    exit: () => {},
    clock: { now: () => now, iso: () => new Date(now).toISOString() } as never,
    sleep: (ms) => {
      // The backstop fires only for a generation that never answers tier 2.
      if (ms === BACKSTOP_MS) return opts.answers === false ? Promise.resolve() : new Promise<void>(() => {});
      if (ms >= DEFER_MS) return new Promise<void>((resolve) => void retries.push(resolve));
      naps.push(ms);
      now += ms;
      return Promise.resolve();
    },
    pollMs: 1,
    drainBackstopMs: 1,
    freeMemory,
    rss: () => BOOT_PEAK,
    peakRss: () => undefined,
    deferMs: DEFER_MS,
    shedBackstopMs: BACKSTOP_MS,
    socketPathFor: (n) => `/sock/${n}`,
    hostPressure: async () => ({ memAvailableBytes: 64 * GB, swapInPagesPerSec: 0, psiSomeAvg10: 0, psiFullAvg10: 0, unread: [], atMs: now }),
    upgradeThresholds: () => ({ hostReserveBytes: 2 * GB, swapInPagesPerSecMax: 256, psiSomeAvg10Max: 10, psiFullAvg10Max: 2, staleMs: 600_000 }),
    ...opts.extra,
  });
  /** Start, defer once on tier 1, then release the retry that runs tier 2. */
  const runTier2 = async (): Promise<Record<string, unknown> | undefined> => {
    await supervisor.start();
    await supervisor.requestHandoff();
    assert.equal(logs.filter((l) => l.step === "serve.handoff_deferred").length, 1, "positive control: tier 1 alone is short and defers");
    retries.shift()?.();
    await tick(5);
    return logs.find((l) => l.step === "serve.handoff_shed" && l.extra?.tier === 2 && l.extra?.phase === "shed")?.extra;
  };
  return { supervisor, generations, logs, events, naps, runTier2, types: (i: number) => generations[i].sent.map((m) => m.type) };
}

test("W1-T9570: the tier-2 shed reads free memory until it settles", async () => {
  const h = harness({ afterShed: LIVE_SETTLE });
  const row = await h.runTier2();
  assert.equal(h.supervisor.activeSha(), "sha-3", "the settled reading fits, so the retry hands off");
  assert.deepEqual(
    { freeBefore: row?.freeBefore, freeAfterFirst: row?.freeAfterFirst, freeAfter: row?.freeAfter, freeReads: row?.freeReads, settle: row?.settle, settleMs: row?.settleMs, needBytes: row?.needBytes },
    { freeBefore: SHORT, freeAfterFirst: 4.3 * GB, freeAfter: 5.19 * GB, freeReads: 9, settle: "fits", settleMs: 8 * SHED_SETTLE_READ_INTERVAL_MS, needBytes: NEED },
    "the row keeps the first reading beside the settled one it judged",
  );
  assert.ok((row?.freeAfterFirst as number) < NEED, "positive control: the first reading alone is short");
  assert.deepEqual(h.naps.filter((ms) => ms === SHED_SETTLE_READ_INTERVAL_MS).length, 8, "one read a second, and none after it fits");
  assert.ok(!h.types(0).includes(GENERATION_MESSAGES.restore_workers), "workers that freed enough are not restored");
  assert.equal(h.logs.filter((l) => l.step === "serve.handoff_deferred").length, 1, "no second deferral");
});

test("W1-T9570: the tier-2 shed reads free memory until the cap, then restores the workers", async () => {
  const h = harness({ afterShed: [4.3 * GB, 4.2 * GB] });
  const row = await h.runTier2();
  const reads = 1 + SHED_SETTLE_CAP_MS / SHED_SETTLE_READ_INTERVAL_MS;
  assert.deepEqual({ freeReads: row?.freeReads, settle: row?.settle, settleMs: row?.settleMs, freeAfter: row?.freeAfter }, { freeReads: reads, settle: "cap", settleMs: SHED_SETTLE_CAP_MS, freeAfter: 4.2 * GB });
  const restoredAt = h.events.indexOf(`send:${GENERATION_MESSAGES.restore_workers}`);
  assert.ok(restoredAt > h.events.lastIndexOf("read"), "the workers come back only after the last settle read");
  assert.equal(h.logs.filter((l) => l.step === "serve.handoff_deferred").length, 2, "still short at the cap: the deferral continues");
  assert.equal(h.generations.length, 1, "no standby forks");
});

test("W1-T9570: a tier-2 shed never answered, or unreadable, reads free memory once", async () => {
  const silent = harness({ afterShed: [6 * GB], answers: false });
  const row = await silent.runTier2();
  assert.deepEqual({ answered: row?.answered, freeReads: row?.freeReads, settle: row?.settle, settleMs: row?.settleMs }, { answered: false, freeReads: 1, settle: "unanswered", settleMs: 0 });
  assert.deepEqual(silent.naps.filter((ms) => ms === SHED_SETTLE_READ_INTERVAL_MS), [], "no settle loop past the backstop");
  const blind = harness({ afterShed: [undefined, 6 * GB] });
  const unread = await blind.runTier2();
  assert.deepEqual({ freeReads: unread?.freeReads, settle: unread?.settle, freeAfter: unread?.freeAfter }, { freeReads: 1, settle: "unread", freeAfter: undefined });
});

test("W1-T9570: the tier-2 shed records swap before and after", async () => {
  const swapReads: number[] = [];
  let order: string[] = [];
  const h = harness({
    afterShed: LIVE_SETTLE,
    extra: {
      swapMemory: () => {
        order = [...h.events];
        swapReads.push(order.length);
        return swapReads.length === 1 ? 725_614_592 : 440_000_000;
      },
    },
  });
  const row = await h.runTier2();
  assert.deepEqual({ swapBefore: row?.swapBefore, swapAfter: row?.swapAfter }, { swapBefore: 725_614_592, swapAfter: 440_000_000 });
  assert.equal(swapReads.length, 2, "swap is read twice per tier-2 shed");
  assert.ok(!order.slice(0, swapReads[0]).includes(`send:${GENERATION_MESSAGES.shed_workers}`), "swapBefore is read before the shed is sent");
  assert.equal(h.events.slice(0, swapReads[1]).filter((e) => e === "read").length, LIVE_SETTLE.length, "swapAfter is read with the settled reading");

  const unreadable = harness({ afterShed: LIVE_SETTLE, extra: { swapMemory: () => undefined } });
  const blind = await unreadable.runTier2();
  assert.equal(blind?.settle, "fits", "positive control: the row was written");
  assert.ok(!("swapBefore" in (blind ?? {})) && !("swapAfter" in (blind ?? {})), "an unreadable swap file records no field, never a zero");
});

test("W1-T9570: the supervisor's default swap reader is the cgroup's memory.swap.current", async () => {
  const h = harness({ afterShed: LIVE_SETTLE });
  const row = await h.runTier2();
  const expected = cgroupSwapCurrent();
  assert.equal(existsSync("/sys/fs/cgroup/memory.swap.current") ? typeof expected : "undefined", typeof expected, "the default reads the real cgroup path");
  if (expected === undefined) assert.ok(!("swapBefore" in (row ?? {})), "no cgroup swap file here: no field");
  else assert.equal(typeof row?.swapBefore, "number", "a readable cgroup swap file is recorded");
});

test("W1-T9570: cgroupSwapCurrent reads real-shaped cgroup files and refuses what is not a byte count", () => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}swap-`));
  assert.equal(cgroupSwapCurrent(undefined, dir), undefined, "a missing memory.swap.current (no swap accounting) is no reading, never a zero");
  writeFileSync(join(dir, "memory.swap.current"), "725614592\n");
  assert.equal(cgroupSwapCurrent(undefined, dir), 725_614_592, "the default reader parses the kernel's one-line byte count");
  writeFileSync(join(dir, "memory.swap.current"), "0\n");
  assert.equal(cgroupSwapCurrent(undefined, dir), 0, "a real zero is a reading");
  writeFileSync(join(dir, "memory.swap.current"), "max\n");
  assert.equal(cgroupSwapCurrent(undefined, dir), undefined, "a value that is not a byte count is no reading");
  assert.equal(cgroupSwapCurrent((path) => { throw new Error(`EACCES ${path}`); }, dir), undefined, "an unreadable file is no reading");
});
