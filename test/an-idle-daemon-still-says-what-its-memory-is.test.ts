/**
 * W1-T7126 — AN IDLE DAEMON STILL SAYS WHAT ITS MEMORY IS.
 *
 * W1-T6782's memory fields rode only `daemon.alive`, which only the in-flight ticker writes, so an idle
 * instance wrote `daemon.tick` rows and no memory sample at all. The loop's existing, unconditional
 * `daemon.tick` row now carries the same sample when no row has carried one within one poll interval.
 *
 * Every case drives the real `runDaemon` loop with an injected clock. Sampling on every tick fails the
 * de-duplication case; dropping the tick spread fails the idle case; moving the sample out of the tick
 * row or letting its throw escape fails the tick-still-first case.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPlan, type Plan } from "../src/lib/plan.js";
import { runDaemon, type DaemonDeps } from "../src/lib/daemon.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const POLL_MS = 60_000;
const MEMORY = { rss_bytes: 4_912_345_678, heap_used_bytes: 3_987_654_321, cg_memory_current_bytes: 9_223_372_032 };

function fixturePlan(): Plan {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}idle-daemon-mem-`));
  const f = join(dir, "tasks.yaml");
  writeFileSync(f, "- id: A\n  title: a\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n");
  return loadPlan(f);
}

interface Row { step: string; extra: Record<string, unknown> }

/** An idle daemon: every task already merged, so no dispatch and no in-flight ticker. Each sleep advances
 *  the injected clock by what it was asked for; the loop is stopped after `ticks` daemon.tick rows. */
async function idleRows(ticks: number, extra: Partial<DaemonDeps>, events: string[] = []): Promise<Row[]> {
  let nowMs = Date.parse("2026-10-09T12:00:00.000Z");
  const rows: Row[] = [];
  await runDaemon(
    fixturePlan(),
    {
      refreshMerged: () => () => true,
      runOne: async () => { throw new Error("an idle daemon dispatches nothing"); },
      now: () => new Date(nowMs),
      sleep: async (ms: number) => { events.push("sleep"); nowMs += ms; },
      checkStop: () => (rows.filter((r) => r.step === "daemon.tick").length >= ticks ? "test done" : undefined),
      log: (step, e = {}) => { rows.push({ step, extra: e }); events.push(step); },
      ...extra,
    },
    { pollIntervalMs: POLL_MS },
  );
  return rows;
}

/** A busy daemon: one dispatch held open across `aliveTicks` ticker sleeps of one poll interval each. */
async function busyRows(aliveTicks: number, extra: Partial<DaemonDeps>, finalSleepShortByMs = 0): Promise<Row[]> {
  let nowMs = Date.parse("2026-10-09T12:00:00.000Z");
  const merged = new Set<string>();
  const rows: Row[] = [];
  let sleeps = 0;
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await runDaemon(
    fixturePlan(),
    {
      refreshMerged: () => (id) => merged.has(id),
      runOne: async (id) => { await gate; merged.add(id); return { taskId: id, runId: id + "-run", merged: true, costUsd: 0.5, verdict: "merged" }; },
      sweepLight: async () => {},
      now: () => new Date(nowMs),
      sleep: async (ms: number) => {
        sleeps++;
        nowMs += ms - (sleeps >= aliveTicks ? finalSleepShortByMs : 0);
        if (sleeps >= aliveTicks) release?.();
      },
      log: (step, e = {}) => rows.push({ step, extra: e }),
      ...extra,
    },
    { max: 1, pollIntervalMs: POLL_MS },
  );
  return rows;
}

const ticksOf = (rows: Row[]): Record<string, unknown>[] => rows.filter((r) => r.step === "daemon.tick").map((r) => r.extra);
const alivesOf = (rows: Row[]): Record<string, unknown>[] => rows.filter((r) => r.step === "daemon.alive").map((r) => r.extra);

test("an idle loop's daemon.tick carries the memory fields with mem_sample_via tick", async () => {
  const events: string[] = [];
  let afterRows = 0;
  const readMemoryTelemetry = Object.assign(() => ({ ...MEMORY }), { afterRow: () => { afterRows++; events.push("afterRow"); } });
  const rows = await idleRows(4, { readMemoryTelemetry }, events);
  assert.equal(alivesOf(rows).length, 0, "an idle daemon writes no daemon.alive, so only the tick can carry the sample");
  const ticks = ticksOf(rows);
  assert.equal(ticks.length, 4);
  const sampled = ticks.filter((t) => t.mem_sample_via === "tick");
  assert.ok(sampled.length >= 3, `every tick one poll interval after the last sample carries it (got ${sampled.length} of ${ticks.length})`);
  for (const tick of sampled) {
    assert.deepEqual({ rss_bytes: tick.rss_bytes, heap_used_bytes: tick.heap_used_bytes, cg_memory_current_bytes: tick.cg_memory_current_bytes }, MEMORY);
    assert.equal(tick.poll_interval_ms, POLL_MS, "the tick's own field still rides the row");
  }
  for (const tick of ticks.filter((t) => t.mem_sample_via === undefined)) {
    assert.equal(tick.rss_bytes, undefined, "an unsampled tick carries no memory field at all");
  }
  assert.equal(afterRows, sampled.length, "the worker-thread heap read is started once per sampled tick");
  for (let i = 0; i < events.length; i++) {
    if (events[i] === "afterRow") assert.equal(events[i - 1], "daemon.tick", "the heap read starts only after its tick row is written");
  }
});

test("a tick within one poll interval of a sampled daemon.alive carries none", async () => {
  // Keep the final heartbeat-to-tick gap strictly inside the window; at exactly POLL_MS a new sample is due.
  const rows = await busyRows(3, { readMemoryTelemetry: () => ({ ...MEMORY }) }, 1);
  const alives = alivesOf(rows);
  assert.ok(alives.length >= 2, `the dispatch wrote its heartbeats (got ${alives.length})`);
  assert.equal(alives.at(-1)?.mem_sample_via, "alive", "the heartbeat names itself as the row that carried the sample");
  const lastAlive = rows.map((r) => r.step).lastIndexOf("daemon.alive");
  const ticksAfter = ticksOf(rows.slice(lastAlive));
  assert.ok(ticksAfter.length >= 1, "the loop ticked again after the dispatch's last heartbeat");
  // More than one poll interval has passed since boot, so only the heartbeat's own sample can suppress this one.
  for (const tick of ticksAfter) {
    assert.equal(tick.mem_sample_via, undefined, "the tick defers to the heartbeat that sampled within one poll interval");
    assert.equal(tick.rss_bytes, undefined);
  }
});

test("a busy instance's daemon.alive keeps sampling as before", async () => {
  let samples = 0;
  const rows = await busyRows(4, { readMemoryTelemetry: () => { samples++; return { ...MEMORY }; } });
  const alives = alivesOf(rows);
  assert.ok(alives.length >= 3, `every in-flight heartbeat was written (got ${alives.length})`);
  for (const alive of alives) {
    assert.equal(alive.mem_sample_via, "alive");
    assert.equal(alive.rss_bytes, MEMORY.rss_bytes, "each heartbeat carries its own sample, none is suppressed");
    assert.equal(alive.phase, "dispatch");
  }
  const tickSamples = ticksOf(rows).filter((t) => t.mem_sample_via === "tick").length;
  assert.equal(samples, alives.length + tickSamples, "the sampler ran once per sampled row and never otherwise");
});

test("a throwing sampler still writes daemon.tick first with mem_telemetry error", async () => {
  const events: string[] = [];
  const rows = await idleRows(3, { readMemoryTelemetry: () => { throw new Error("procfs vanished"); } }, events);
  const ticks = ticksOf(rows);
  assert.equal(ticks.length, 3, "every iteration still wrote its tick");
  const errored = ticks.filter((t) => t.mem_sample_via === "tick");
  assert.ok(errored.length >= 2, `the sampled ticks carry the failure (got ${errored.length})`);
  for (const tick of errored) assert.equal(tick.mem_telemetry, "error:procfs vanished");
  for (let i = 0; i < events.length; i++) {
    if (events[i] === "sleep" && i + 1 < events.length) assert.equal(events[i + 1], "daemon.tick", "each iteration's first row is still its tick");
  }
});

test("no timer or extra loop iteration is introduced", async () => {
  const strip = (rows: Row[]): string[] => rows.map((r) => r.step);
  const withoutEvents: string[] = [];
  const without = await idleRows(4, {}, withoutEvents);
  const withEvents: string[] = [];
  const withSampler = await idleRows(4, { readMemoryTelemetry: () => ({ ...MEMORY }) }, withEvents);
  assert.ok(ticksOf(withSampler).some((t) => t.mem_sample_via === "tick"), "the control: the sampler did ride the ticks");
  assert.deepEqual(strip(withSampler), strip(without), "the same rows in the same order: no row, step or iteration added");
  assert.equal(withEvents.filter((e) => e === "sleep").length, withoutEvents.filter((e) => e === "sleep").length, "no extra sleep or wait");
  for (const tick of ticksOf(without)) assert.deepEqual(Object.keys(tick), ["poll_interval_ms"], "an unwired daemon's tick row is unchanged");
});
