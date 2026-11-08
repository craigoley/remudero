/**
 * W1-T11383 — A HELD HEAP CLOSES NEW WORKER STARTS ONLY.
 *
 * Readiness and the latch run for real over W1-T11382-shaped traces; each daemon fixture injects the heap reader
 * (a fake near-limit telemetry whose sample share the test moves) and runs `runDaemon` for a few ticks.
 */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { setImmediate as flush } from "node:timers/promises";
import { test, type TestContext } from "node:test";

import {
  createHeapAdmissionHold, heapHoldReadiness, parseHeapAdmissionHoldMode, readHeapAdmissionHoldMode,
  type HeapAdmissionHoldMode, type HeapHoldTrace,
} from "#src/lib/daemon-heap-admission-hold.js";
import type { NearLimitSample } from "#src/lib/daemon-heap-near-limit.js";
import { createDaemonMemoryGovernor, HEAP_LIMIT_EXIT_FRACTION, HEAP_PROPOSAL_EVERY_MS } from "#src/lib/daemon-memory-policy.js";
import {
  resolveFleetControlHold, runDaemon, type DaemonDeps, type LightPassScope, type ReviewAdmissionGate,
} from "#src/lib/daemon.js";
import { idleLaneCauseForRefillReason, idleLaneCauseForStep } from "#src/lib/idle-lane-accounting.js";
import { loadPlan } from "#src/lib/plan.js";
import { clockFromMillisFn } from "#src/lib/clock.js";
import { fleetWithheldStageMs } from "#src/lib/sweep.js";
import { withTempDir } from "#src/lib/tmp.js";
import {
  DEFAULT_SWEEP_POLICY, drainInFlightReviews, runSweepLightPass, type OpenPrView, type SweepDeps,
} from "#test/helpers/sweep-test.js";

const minute = 60_000;
const LIMIT = 1_000;

/** One readable sample: `share` of a 1,000-byte limit at `at` minutes. */
function sample(boot: string, atMin: number, share: number, admitted = 0): NearLimitSample {
  return { at: atMin * minute, boot_key: boot, surface: "tick", active: 0, admitted, in_flight_tasks: 0,
    in_flight_reviews: 0, detached_sweep_actions: 0, used_bytes: Math.round(share * LIMIT), limit_bytes: LIMIT };
}

/** A trace READY on its own: ordinary boots A and C recover and rebound, boot B climbs through the latch to the guard.
 *  `lastRise` is A's final reading (its rise from 0.32 is the worst rise), `reboundAtMin` when A's second stretch rebounds. */
function readyTrace(opts: { lastRise?: number; reboundAtMin?: number } = {}): HeapHoldTrace {
  const samples = [
    sample("A", 0, 0.30), sample("A", 1, 0.35, 1), sample("A", 2, 0.40), sample("A", 3, 0.30), sample("A", 4, 0.32),
    sample("A", opts.reboundAtMin ?? 6, opts.lastRise ?? 0.38),
    sample("C", 10, 0.20), sample("C", 11, 0.25), sample("C", 12, 0.30), sample("C", 13, 0.24), sample("C", 14, 0.29),
    sample("B", 20, 0.50), sample("B", 21, 0.55), sample("B", 22, 0.60), sample("B", 23, 0.65), sample("B", 24, 0.70),
    sample("B", 25, 0.75),
  ];
  return { samples, boots: ["A", "B", "C"].map((boot_key) => ({ boot_key, clean_close: true })) };
}

/** PID 138: 12.59% at its last sample, then near 99.56% 7m50s later, and the boot never closed. */
function pid138(trace: HeapHoldTrace, withFatalSample = true): HeapHoldTrace {
  const fatal: NearLimitSample[] = withFatalSample ? [{ ...sample("138:100", 30, 0.9956), at: 30 * minute + 470_000 }] : [];
  return { samples: [...trace.samples, sample("138:100", 30, 0.1259), ...fatal],
    boots: [...trace.boots, { boot_key: "138:100", clean_close: false }] };
}

const close = (actual: number | undefined, expected: number, label: string) =>
  assert.ok(actual !== undefined && Math.abs(actual - expected) < 1e-9, `${label}: ${actual} != ${expected}`);

test("W1-T11383 criterion 1 readiness derives the pair from measured growth and names each missing item", () => {
  const ready = heapHoldReadiness(readyTrace(), HEAP_LIMIT_EXIT_FRACTION);
  assert.equal(ready.verdict, "READY", JSON.stringify(ready));
  assert.deepEqual(ready.missing, []);
  // high = guard - worst same-boot rise (A: 0.32 -> 0.38) - reserve (the rise after an admission, A: 0.30 -> 0.35).
  close(ready.worst_rise_fraction, 0.38 - 0.32, "worst rise");
  close(ready.reserve_fraction, 0.35 - 0.30, "reserve");
  assert.equal(ready.reserve_basis, "admission_rise");
  close(ready.pair!.high, HEAP_LIMIT_EXIT_FRACTION - (0.38 - 0.32) - (0.35 - 0.30), "high");
  assert.ok(ready.pair!.high <= HEAP_LIMIT_EXIT_FRACTION - ready.worst_rise_fraction! - ready.reserve_fraction!);
  // low = the highest post-peak trough (A 0.30) plus the troughs' spread (A 0.30 vs C 0.24).
  close(ready.pair!.low, 0.30 + (0.30 - 0.24), "low");
  assert.ok(ready.pair!.low < ready.pair!.high);
  // dwell = the longest below-low stretch that rebounded: A's 3 -> 6 minutes.
  assert.equal(ready.pair!.dwell_ms, 3 * minute);
  assert.ok(ready.pair!.high > ready.ordinary_peak_fraction!, "high sits above every ordinary boot's peak");
  assert.equal(ready.counts.crossings, 1, "B's guard crossing was replayed");
  assert.ok(ready.held_share! > 0 && ready.held_share! < 1);

  // Moving the measured growth moves the pair; moving the rebound moves the dwell.
  const steeper = heapHoldReadiness(readyTrace({ lastRise: 0.40 }));
  assert.equal(steeper.verdict, "READY");
  close(steeper.pair!.high, HEAP_LIMIT_EXIT_FRACTION - (0.40 - 0.32) - (0.35 - 0.30), "steeper high");
  assert.ok(steeper.pair!.high < ready.pair!.high);
  assert.equal(heapHoldReadiness(readyTrace({ reboundAtMin: 8 })).pair!.dwell_ms, 5 * minute);

  // PID 138's single-gap rise leaves no room below the guard, and its boot never closed.
  const fatal = heapHoldReadiness(pid138(readyTrace()));
  assert.equal(fatal.verdict, "NOT READY");
  assert.ok(fatal.missing.includes("unmeasured_final_gap"), JSON.stringify(fatal.missing));
  assert.ok(fatal.missing.includes("no_room_below_guard"), JSON.stringify(fatal.missing));
  assert.equal(fatal.pair, undefined);
  const gapOnly = heapHoldReadiness(pid138(readyTrace(), false));
  assert.deepEqual(gapOnly.missing, ["unmeasured_final_gap"], "the unclosed boot alone is named");
  assert.ok(gapOnly.pair, "the candidate pair is still reported for the operator");
  assert.deepEqual(heapHoldReadiness(pid138(readyTrace(), false), HEAP_LIMIT_EXIT_FRACTION, { bootKey: "138:100" }).missing, [],
    "this process's own boot is not an unmeasured gap");

  assert.deepEqual(heapHoldReadiness(undefined).missing, ["trace_unread"]);
  assert.deepEqual(heapHoldReadiness({ samples: [], boots: [], unread: "unparseable" }).missing, ["trace_unread"]);
  assert.deepEqual(heapHoldReadiness({ samples: [], boots: [] }).missing, ["no_same_boot_growth_pairs", "no_observed_recovery"]);
  const ordinaryHigh = readyTrace();
  const nearHigh = heapHoldReadiness({ samples: [...ordinaryHigh.samples, sample("D", 40, 0.66), sample("D", 41, 0.70)],
    boots: [...ordinaryHigh.boots, { boot_key: "D", clean_close: true }] });
  assert.ok(nearHigh.missing.includes("high_within_ordinary_peaks"), JSON.stringify(nearHigh.missing));
  const latchedAtEnd = heapHoldReadiness({ samples: [...ordinaryHigh.samples, sample("E", 40, 0.60), sample("E", 41, 0.65),
    sample("E", 42, 0.70), sample("E", 43, 0.75), sample("E", 44, 0.20)], boots: [...ordinaryHigh.boots, { boot_key: "E", clean_close: true }] });
  assert.ok(latchedAtEnd.missing.includes("replay_failed"), "a boot that recovered with the latch still set fails the replay");
  const inverted = heapHoldReadiness({ samples: [sample("F", 0, 0.10), sample("F", 1, 0.15), sample("F", 2, 0.60),
    sample("F", 3, 0.58), sample("G", 4, 0.40), sample("G", 5, 0.45), sample("G", 6, 0.05)],
  boots: [{ boot_key: "F", clean_close: true }, { boot_key: "G", clean_close: true }] });
  assert.ok(inverted.missing.includes("pair_inverted"), JSON.stringify(inverted.missing));
  const noRebound = heapHoldReadiness({ samples: [sample("H", 0, 0.20), sample("H", 1, 0.10)],
    boots: [{ boot_key: "H", clean_close: true }] });
  assert.ok(noRebound.missing.includes("no_observed_rebound"), JSON.stringify(noRebound.missing));
});

interface Row { step: string; fields: Record<string, unknown> }

function latchFixture(mode: HeapAdmissionHoldMode | undefined, trace: () => HeapHoldTrace | undefined = () => readyTrace()) {
  let nowMs = 1_000;
  const rows: Row[] = [];
  const hold = createHeapAdmissionHold({ mode, readTrace: trace, clock: clockFromMillisFn(() => nowMs),
    log: (step, fields) => rows.push({ step, fields }) });
  let atMs = 0;
  const read = (share: number | undefined, surface = "dispatch", advanceMs = minute) => {
    atMs += advanceMs;
    const s = share === undefined ? { ...sample("9:9", 0, 0), at: atMs, used_bytes: undefined, limit_bytes: undefined }
      : { ...sample("9:9", 0, share), at: atMs };
    return hold.read(surface, s);
  };
  return { hold, rows, read, advanceClock: (ms: number) => { nowMs += ms; } };
}

test("W1-T11383 criterion 2 the hold ships disabled and NOT READY holds nothing while a shadow row says what would", async () => {
  const shadow = latchFixture(undefined);
  assert.equal(shadow.rows[0].step, "daemon.heap_admission_hold_readiness");
  assert.equal(shadow.rows[0].fields.reason, "boot");
  assert.equal(shadow.rows[0].fields.verdict, "READY");
  assert.equal(shadow.rows[0].fields.mode, "shadow");
  assert.equal(shadow.read(0.70), undefined, "no enforce mode: nothing is held");
  assert.equal(shadow.hold.latched(), true, "the shadow latch still tracks the heap");
  const would = shadow.rows.find((row) => row.step === "daemon.heap_admission_hold")!;
  assert.equal(would.fields.shadow, true);
  assert.equal(would.fields.transition, "latched");
  assert.equal(would.fields.surface, "dispatch");
  // enforce under NOT READY (an unclosed boot): still nothing held, and the shadow row records the would-hold.
  const notReady = latchFixture("enforce", () => pid138(readyTrace(), false));
  assert.equal(notReady.hold.readiness().verdict, "NOT READY");
  assert.deepEqual(notReady.rows[0].fields.missing, ["unmeasured_final_gap"]);
  assert.equal(notReady.read(0.70), undefined);
  assert.equal(notReady.rows.find((row) => row.step === "daemon.heap_admission_hold")!.fields.shadow, true);
  // enforce and READY both: the live hold.
  const live = latchFixture("enforce");
  assert.equal(live.read(0.70)?.control, "HEAP");
  // The readiness row: at boot, hourly, and on a verdict change.
  let traced: HeapHoldTrace = readyTrace();
  const cadence = latchFixture("enforce", () => traced);
  cadence.advanceClock(HEAP_PROPOSAL_EVERY_MS);
  cadence.read(0.10);
  assert.deepEqual(cadence.rows.filter((r) => r.step === "daemon.heap_admission_hold_readiness").map((r) => r.fields.reason),
    ["boot", "hourly"]);
  cadence.read(0.70);
  traced = pid138(readyTrace());
  for (let i = 0; i < 5; i++) cadence.read(0.10);
  const readinessRows = cadence.rows.filter((r) => r.step === "daemon.heap_admission_hold_readiness");
  assert.deepEqual(readinessRows.map((r) => r.fields.reason), ["boot", "hourly", "verdict_change"]);
  assert.equal(readinessRows[2].fields.verdict, "NOT READY");
  assert.equal(cadence.read(0.70), undefined, "a NOT READY verdict sets no live latch");
  // The mode parses fail-closed to shadow; this task ships no policy row.
  assert.deepEqual(parseHeapAdmissionHoldMode(undefined), { mode: "shadow" });
  assert.deepEqual(parseHeapAdmissionHoldMode({ heapAdmissionHold: { mode: "enforce" } }), { mode: "enforce" });
  assert.deepEqual(parseHeapAdmissionHoldMode({ heapAdmissionHold: { mode: { value: "enforce", origin: "operator" } } }), { mode: "enforce" });
  assert.equal(parseHeapAdmissionHoldMode({ heapAdmissionHold: { mode: "on" } }).mode, "shadow");
  assert.match(String(parseHeapAdmissionHoldMode({ heapAdmissionHold: { mode: "on" } }).error), /shadow or enforce/);
  assert.equal(readHeapAdmissionHoldMode("/unused", () => { throw Error("unreadable"); }).mode, "shadow");
  assert.equal(readHeapAdmissionHoldMode("/unused", () => "daemonMemory:\n  heapAdmissionHold:\n    mode: enforce\n").mode, "enforce");
  assert.equal(readHeapAdmissionHoldMode("plan/policy.yaml").mode, "shadow", "the shipped policy enables nothing");
  // A default daemon dispatches at a high reading, and writes only the shadow row.
  const daemon = await heldDaemon({ share: 0.70 });
  assert.equal(daemon.runs, 1, "the shadow hold admitted the dispatch");
  assert.equal(daemon.rows.some((r) => r.step === "daemon.admission_held"), false);
  assert.equal(daemon.rows.find((r) => r.step === "daemon.heap_admission_hold")?.fields.shadow, true);
});

/** One queued task; the daemon ticks until `checkStop` fires after `ticks` sleeps. */
async function heldDaemon(opts: {
  share: number; mode?: HeapAdmissionHoldMode; ticks?: number; extra?: Partial<DaemonDeps>; used?: number;
  onSample?: (surface: string) => void;
}) {
  return withTempDir("heap-hold-daemon", async (dir) => {
    const path = join(dir, "tasks.yaml");
    writeFileSync(path, "- id: W1-T1\n  title: fixture\n  repo: remudero\n  type: implement\n  files: [src/fixture.ts]\n  verify: auto\n  status: queued\n");
    let at = 1_000, sampleAt = 0, runs = 0, sleeps = 0;
    const rows: Row[] = [];
    const telemetry = {
      recordNearLimitHeapSample: (surface: string, work: Omit<NearLimitSample, "at" | "boot_key" | "surface">) => {
        opts.onSample?.(surface);
        sampleAt += minute;
        return { ...sample("9:9", 0, opts.share), ...work, at: sampleAt, surface };
      },
      close: () => {},
      snapshot: () => readyTrace(),
    };
    const deps: DaemonDeps = {
      refreshMerged: () => () => false,
      runOne: async () => { runs++; return { verdict: "merged", taskId: "W1-T1", runId: "fixture", merged: true, costUsd: 0 }; },
      sleep: async () => { sleeps++; at += minute; },
      now: () => new Date(at),
      heapStatistics: () => ({ used_heap_size: opts.used ?? 100, heap_size_limit: 1_000 }),
      memoryGovernor: createDaemonMemoryGovernor({ read: () => ({ rss_bytes: 1 }), setFlags: () => {} }),
      nearLimitHeapTelemetry: telemetry,
      ...(opts.mode ? { heapAdmissionHoldMode: opts.mode } : {}),
      checkStop: () => sleeps >= (opts.ticks ?? 3) ? "fixture done" : undefined,
      workerAdmissionHold: () => undefined,
      log: (step, fields = {}) => rows.push({ step, fields }),
      ...opts.extra,
    };
    const result = await runDaemon(loadPlan(path), deps, { pollIntervalMs: 1, max: 1 });
    return { result, rows, runs, sleeps, held: (surface: string) =>
      rows.filter((r) => r.step === "daemon.admission_held" && r.fields.surface === surface) };
  });
}

test("W1-T11383 criterion 3 a set latch holds every worker start and the dispatch tick starts no batch", async () => {
  const latch = latchFixture("enforce");
  assert.equal(latch.read(0.60), undefined, "below high nothing latches");
  assert.equal(latch.read(0.65)?.control, "HEAP", "a fresh reading at or above high latches");
  for (const share of [0.62, 0.50, 0.40, 0.37]) assert.equal(latch.read(share)?.control, "HEAP", `still set at ${share}`);
  // Dispatch: no batch, no exit, no daemon.pause; the tick is accounted and the lanes' cause is memory.
  const dispatch = await heldDaemon({ share: 0.70, mode: "enforce", ticks: 4 });
  assert.equal(dispatch.runs, 0, "no batch started");
  assert.equal(dispatch.result.stopReason, "stopped", "only the fixture's STOP ended the loop");
  assert.ok(dispatch.sleeps >= 4, "the loop slept to its next wake on every held tick");
  assert.equal(dispatch.rows.some((r) => r.step === "daemon.pause"), false);
  assert.equal(dispatch.held("dispatch").length, 1);
  assert.match(String(dispatch.held("dispatch")[0].fields.reason), /^fleet HEAP hold: /);
  // Each cadence worker start reads the same seam.
  const cadences: Array<[string, Partial<DaemonDeps>, string]> = [
    ["intake", { checkIntakeRungs: () => [{ rung: "codeqlQuality", fire: true, reason: "due" }] }, "intake_cadence.held"],
    ["retro", { checkRetroTrigger: async () => ({ fire: true, reason: "merges", mergesSinceMarker: 9, daysSinceMarker: 1 }),
      runRetroTrigger: async () => { assert.fail("a held retro must not start"); } }, "daemon.retro_trigger.held"],
    ["wipe-test", { checkWipeTestCadence: () => ({ fire: true, reason: "due", seq: 1, subject: { id: "s" }, factor: {} }) as never },
      "wipetest.cadence.held"],
    ["auto-triage", { checkAutoTriage: async () => ({ fire: true, feedbackId: "fb-1", reason: "due" }),
      runAutoTriage: async () => { assert.fail("a held triage must not start"); } }, "auto_triage.held"],
  ];
  for (const [surface, extra, step] of cadences) {
    const run = await heldDaemon({ share: 0.70, mode: "enforce", extra });
    const held = run.rows.filter((r) => r.step === step);
    assert.ok(held.length >= 1, `${surface}: no ${step} row`);
    assert.match(String(held[0].fields.reason), /^fleet HEAP hold: /, surface);
    assert.equal(run.held(surface).length, 1, `${surface}: one admission_held row for the episode`);
    assert.equal(run.runs, 0, `${surface}: nothing dispatched behind it`);
  }
});

function latchedPool(t: TestContext, mode: HeapAdmissionHoldMode | undefined, extra: Partial<DaemonDeps> = {}) {
  return withTempDir("heap-hold-pool", async (dir) => {
    const path = join(dir, "tasks.yaml");
    writeFileSync(path, ["A", "B", "C"].map((id) =>
      `- id: ${id}\n  title: ${id}\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n  files: [src/${id}.ts]\n`).join(""));
    const kill = t.mock.method(process, "kill", () => { throw Error("a heap hold must not signal anything"); });
    let share = 0.10, sampleAt = 0, sleeps = 0;
    const started: string[] = [], finished: string[] = [];
    const rows: Row[] = [];
    const light: Array<LightPassScope | undefined> = [];
    const full: Array<{ hold: string | undefined; review: boolean }> = [];
    let releaseA!: () => void;
    const aRunning = new Promise<void>((resolve) => { releaseA = resolve; });
    const result = await runDaemon(loadPlan(path), {
      refreshMerged: () => (id) => finished.includes(id),
      runOne: async (id, ...rest) => {
        started.push(id);
        assert.equal((rest as Array<{ signal?: AbortSignal }>).some((arg) => arg?.signal?.aborted), false);
        if (id === "A") { share = 0.70; await aRunning; }
        finished.push(id);
        return { verdict: "merged", taskId: id, runId: `${id}-run`, merged: true, costUsd: 0 };
      },
      sleep: async () => {
        sleeps++;
        if (light.length >= 2 && full.length >= 1) releaseA();
        await flush();
      },
      heapStatistics: () => ({ used_heap_size: 100, heap_size_limit: 1_000 }),
      memoryGovernor: createDaemonMemoryGovernor({ read: () => ({ rss_bytes: 1 }), setFlags: () => {} }),
      nearLimitHeapTelemetry: {
        recordNearLimitHeapSample: (surface: string, work: Omit<NearLimitSample, "at" | "boot_key" | "surface">) => {
          sampleAt += minute;
          return { ...sample("9:9", 0, share), ...work, at: sampleAt, surface };
        },
        close: () => {},
        snapshot: () => readyTrace(),
      } as DaemonDeps["nearLimitHeapTelemetry"],
      ...(mode ? { heapAdmissionHoldMode: mode } : {}),
      sweepLight: async (scope?: LightPassScope) => { light.push(scope); },
      sweep: async (gate?: ReviewAdmissionGate) => { full.push({ hold: gate?.workerAdmissionHold?.(), review: gate?.() ?? true }); },
      checkStop: () => finished.includes("A") && sleeps > 40 ? "fixture done" : undefined,
      workerAdmissionHold: () => undefined,
      log: (step, fields = {}) => rows.push({ step, fields }),
      ...extra,
    } as DaemonDeps, { pollIntervalMs: 1, laneCount: 2, sweepRetriggerIntervalMs: 1 });
    return { result, rows, started, finished, light, full, killed: kill.mock.callCount() };
  });
}

test("W1-T11383 criterion 4 only a whole dwell below low releases the latch and the latching pair stays pinned", () => {
  const f = latchFixture("enforce");
  const { low, dwell_ms } = f.hold.readiness().pair!;
  assert.equal(f.read(0.70)?.control, "HEAP");
  // Between low and high never releases, however long.
  for (let i = 0; i < 10; i++) assert.equal(f.read(0.50)?.control, "HEAP");
  // Below low, but one rise above low restarts the dwell.
  assert.equal(f.read(low - 0.05)?.control, "HEAP");
  assert.equal(f.read(low - 0.05, "dispatch", dwell_ms - minute)?.control, "HEAP", "short of the dwell");
  assert.equal(f.read(low + 0.01)?.control, "HEAP", "a rise above low");
  assert.equal(f.read(low - 0.05)?.control, "HEAP", "the dwell restarted");
  assert.equal(f.read(low - 0.05, "dispatch", dwell_ms - minute)?.control, "HEAP");
  // An unreadable reading keeps a set latch.
  assert.equal(f.read(undefined)?.control, "HEAP");
  assert.equal(f.read(low - 0.05, "dispatch", minute)?.control, undefined, "the whole dwell below low releases");
  assert.equal(f.hold.latched(), false);
  assert.deepEqual(f.rows.filter((r) => r.step === "daemon.heap_admission_hold").map((r) => r.fields.transition), ["latched", "released"]);
  // An unreadable reading sets no new latch.
  assert.equal(f.read(undefined), undefined);
  assert.equal(f.hold.latched(), false);
  // The pinned pair: readiness re-derived while latched (a slower rebound, so a longer dwell) does not move the release.
  let trace = readyTrace();
  const pinned = latchFixture("enforce", () => trace);
  const before = pinned.hold.readiness().pair!;
  assert.equal(pinned.read(0.70)?.control, "HEAP");
  trace = readyTrace({ reboundAtMin: 12, lastRise: 0.40 });
  pinned.advanceClock(HEAP_PROPOSAL_EVERY_MS);
  const held = pinned.read(0.50)!;
  const after = pinned.hold.readiness().pair!;
  assert.ok(after.dwell_ms > before.dwell_ms && after.high < before.high, "readiness moved while latched");
  assert.match(held.detail, new RegExp(`latched at ${before.high.toFixed(4)}`), "the detail names the pinned high");
  assert.equal(pinned.read(before.low - 0.05)?.control, "HEAP");
  assert.equal(pinned.read(before.low - 0.05, "dispatch", before.dwell_ms)?.control, undefined,
    "released on the pinned dwell, not the re-derived one");
});

test("W1-T11383 criterion 5 a latch aborts nothing and admitted work finishes on its owner", async (t) => {
  const run = await latchedPool(t, "enforce");
  assert.deepEqual(run.started, ["A", "B"], "C is never started while the latch holds");
  assert.deepEqual([...run.finished].sort(), ["A", "B"], "both admitted lanes finished on their owner");
  const refill = run.rows.filter((r) => r.step === "dispatch.lane_refill_held");
  assert.ok(refill.length >= 1 && refill.every((r) => /^fleet HEAP hold: /.test(String(r.fields.reason))), "the freed lane's refill was held");
  assert.equal(run.killed, 0, "no process was signalled");
  assert.ok(run.rows.some((r) => r.step === "daemon.admission_held" && r.fields.control === "HEAP"));
  for (const step of ["daemon.lane_reclaimed", "daemon.reclaim", "daemon.exit", "dispatch.lane_aborted"]) {
    assert.equal(run.rows.some((r) => r.step === step), false, step);
  }
  assert.equal(run.result.stopReason, "stopped");
  // The 75% restart decision and its drain are unchanged under the latch.
  const pressured = await heldDaemon({ share: 0.70, mode: "enforce", used: 750, ticks: 50 });
  assert.equal(pressured.result.stopReason, "heap_pressure");
  assert.equal(pressured.rows.find((r) => r.step === "daemon.heap_pressure_exit")!.fields.threshold, 0.75);
});

test("W1-T11383 criterion 6 STOP and PAUSE win over a set heap latch and resolveFleetControlHold stays STOP and PAUSE", async () => {
  // A PAUSE placed after the top-of-tick read, with no wired admission hold: the latch is set by the gate's read,
  // and the existing recheck PAUSE branch still answers it.
  let paused = false;
  const pause = await heldDaemon({ share: 0.70, mode: "enforce", ticks: 3,
    onSample: (surface) => { if (surface === "admission:dispatch") paused = true; },
    extra: { workerAdmissionHold: undefined, checkPause: () => paused ? "operator hold" : undefined } });
  assert.ok(pause.rows.some((r) => r.step === "daemon.pause" && r.fields.detail === "operator hold" && r.fields.recheck === true));
  assert.equal(pause.rows.some((r) => r.step === "daemon.admission_held"), false, "no heap hold was written beside the PAUSE");
  assert.equal(pause.rows.find((r) => r.step === "daemon.heap_admission_hold")?.fields.transition, "latched");
  // The wired seam: a PAUSE read wins with its own row, and no heap row is written beside it.
  const wired = await heldDaemon({ share: 0.70, mode: "enforce", extra: {
    workerAdmissionHold: () => ({ control: "PAUSE", detail: "operator hold" }) } });
  assert.equal(wired.rows.some((r) => r.step === "daemon.admission_held" && r.fields.control === "HEAP"), false);
  assert.ok(wired.rows.some((r) => r.step === "daemon.pause"));
  const stop = await heldDaemon({ share: 0.70, mode: "enforce", extra: {
    workerAdmissionHold: () => ({ control: "STOP", detail: "operator stop" }) } });
  assert.equal(stop.result.stopReason, "stopped");
  assert.equal(stop.held("dispatch")[0]?.fields.control, "STOP");
  assert.equal(resolveFleetControlHold({}), undefined, "a set heap latch is not a fleet control");
  assert.deepEqual(resolveFleetControlHold({ checkPause: () => "p" }), { control: "PAUSE", detail: "p" });
  assert.deepEqual(resolveFleetControlHold({ checkStop: () => "s", checkPause: () => "p" }), { control: "STOP", detail: "s" });
});

const NOW = Date.parse("2026-11-08T12:00:00Z");
function pr(n: number): OpenPrView {
  return { prNumber: n, prUrl: `https://github.com/o/r/pull/${n}`, taskId: `W1-T${n}`, headSha: `head-${n}`,
    reviewState: "none", checksState: "green", unmetCriteria: [], priorStrikes: 0, autoMergeArmed: false,
    lastActivityAt: new Date(NOW - minute * n).toISOString(), createdAt: new Date(NOW - minute * (10 - n)).toISOString() };
}

test("W1-T11383 criterion 7 a heap stand-down is named as fleet-withheld memory and never as a latched restart", async (t) => {
  const run = await latchedPool(t, "enforce");
  const heldLight = run.light.filter((scope) => scope?.admit?.heldBy !== undefined);
  assert.ok(heldLight.length >= 1, "a light pass ran under the latch");
  for (const scope of heldLight) {
    assert.match(String(scope!.admit!.heldBy), /^fleet HEAP hold: /);
    assert.equal(scope!.admit!("review", "light"), false);
    assert.equal(scope!.admit!("fix-dispatch", "light"), false);
  }
  const heldFull = run.full.filter((pass) => pass.hold !== undefined);
  assert.ok(heldFull.length >= 1, "a full pass still ran under the latch, so it arms and merges");
  for (const pass of heldFull) {
    assert.match(String(pass.hold), /^fleet HEAP hold: /);
    assert.equal(pass.review, false);
  }
  // One latch episode, many reads (every full pass asks per admission): one row per surface, never one per read.
  assert.equal(run.rows.filter((r) => r.step === "daemon.heap_admission_hold" && r.fields.transition === "latched").length, 1);
  for (const surface of ["lane-refill", "light-pass", "full-sweep"]) {
    const rows = run.rows.filter((r) => r.step === "daemon.admission_held" && r.fields.surface === surface);
    assert.equal(rows.length, 1, `${surface}: ${rows.length} rows in one episode`);
    assert.equal(rows[0].fields.control, "HEAP");
  }
  assert.ok(heldFull.length > 1, "the full-sweep surface was read more than once in the episode");
  for (const row of run.rows.filter((r) => r.step === "dispatch.lane_refill_held")) {
    assert.equal(idleLaneCauseForStep(row.step, row.fields), "memory");
  }
  // The idle-lane cause is memory.
  assert.equal(idleLaneCauseForRefillReason("fleet HEAP hold: heap latched"), "memory");
  assert.equal(idleLaneCauseForStep("daemon.admission_held", { control: "HEAP", reason: "fleet HEAP hold: x" }), "memory");
  assert.equal(idleLaneCauseForStep("daemon.admission_held", { control: "PAUSE" }), undefined);
  const dispatch = await heldDaemon({ share: 0.70, mode: "enforce" });
  assert.ok(dispatch.rows.some((r) => r.step === "lane.idle_changed" && r.fields.cause === "memory"), "the held dispatch tick is memory");
  // The light pass names the hold, not a latched restart, and the stage clock counts it as fleet-withheld.
  const rows: Record<string, unknown>[] = [];
  const started: number[] = [];
  const deps: SweepDeps = {
    ledgerPath: "/unused", runId: "t11383", now: () => NOW, readLedger: () => [],
    appendLine: (_path, row) => { rows.push(row as Record<string, unknown>); }, readActiveWorkerCount: () => 0,
    arm: () => {}, close: () => {}, dispatchFix: () => {}, escalate: () => {},
    postReview: async (p) => { started.push(p.prNumber); },
    restartAdmission: Object.assign(() => false, { heldBy: "fleet HEAP hold: heap latched at 0.6400" }),
  };
  await runSweepLightPass([pr(1), pr(2)], deps, { ...DEFAULT_SWEEP_POLICY, reviewLanes: 2, reviewLaneMin: 1, reviewLaneMax: 2 });
  await drainInFlightReviews({ boundMs: 1000 });
  assert.deepEqual(started, []);
  const disposed = rows.filter((row) => row.step === "sweep.disposed" && row.acted === false);
  assert.ok(disposed.length >= 1, JSON.stringify(rows.map((r) => r.step)));
  for (const row of disposed) {
    assert.equal(row.stand_down_reason, "not admitted this pass: fleet HEAP hold: heap latched at 0.6400");
    assert.doesNotMatch(String(row.stand_down_reason), /restart latched/);
  }
  const stamped = [{ ...disposed[0], ts: new Date(NOW - 10 * minute).toISOString() }];
  assert.equal(fleetWithheldStageMs(stamped, NOW), 10 * minute);
});
