/**
 * W1-T15181 — a core container held at memory.high while its loop misses ticks ends its most recently admitted fix or
 * review round, one at a time, until the stall clears.
 *
 * Fixtures: the 2026-11-27 10:16Z episode (memory.high 16404 MiB from the tuner's row, memory.current above it, the
 * memory.events high count rising, daemon.loop_lag rows of 219 s then 408 s, three fix children and one review), and
 * the 2026-11-28 00:19Z boot (ten fix-dispatch children admitted within 30 s of the recycle, memory.current 21.37 GiB
 * over memory.high 19712 MiB, nothing shed). Every reader, the clock and each child's end are injected.
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
  containerCalmBandOf, decideContainerShed, isDisposableShedEntry, readContainerShedReading,
  MEMORY_SHED_HELD_STEP, MEMORY_SHED_STEP,
  type ContainerShedEndOutcome, type ContainerShedEntry, type ContainerShedReading,
} from "#src/lib/daemon-memory-policy.js";
import { containerShedInventory, createContainerShedRung, endRunChildForShed, runDaemon, type DaemonDeps } from "#src/lib/daemon.js";
import { SWAP_STALL_HISTORY_MS, SWAP_STALL_MIN_SAMPLES, SWAP_STALL_WINDOW_MS } from "#src/lib/host-memory-shadow.js";
import { loadPlan } from "#src/lib/plan.js";
import { readLedgerLines } from "#src/lib/status.js";
import {
  adoptChildWork, childWorkCount, childWorkHoldsReviewKey, fixDispatchHoldAtHead, fixRoundTally, resetChildWork, restartDrainInventory,
  type OpenPrView,
} from "#src/lib/sweep.js";
import { withTempDir } from "#src/lib/tmp.js";
import { hostIndependentDaemonDeps } from "#test/helpers/daemon-host-pins.js";
import { drainDetachedSweepActions, runSweep } from "#test/helpers/sweep-test.js";

const MIN = 60_000;
const T1016 = Date.parse("2026-11-27T10:16:00Z");
const POLL_MS = 60_000;
type Row = { step: string; fields: Record<string, unknown> };

/** A child the rung may end: its end is a spy, and its settlement is the test's to give. */
function child(runId: string, kind: string, admittedAtMs: number, opts: { what?: string; outcome?: ContainerShedEndOutcome | Error; endless?: boolean } = {}) {
  let settle!: () => void;
  const settled = new Promise<void>((resolve) => { settle = resolve; });
  const ended: string[] = [];
  const entry: ContainerShedEntry = {
    what: opts.what ?? (kind === "review" ? "review" : "detached"), kind, task_id: `W1-T${runId.replace(/\D/g, "") || "1"}`,
    pr: 20_000 + admittedAtMs % 997, admitted_at_ms: admittedAtMs, run_id: runId, settled,
    ...(opts.endless ? {} : {
      end: async () => {
        ended.push(runId);
        if (opts.outcome instanceof Error) throw opts.outcome;
        return opts.outcome ?? { signalled: true, ended: "terminal", killed: false };
      },
    }),
  };
  return { entry, ended, settle };
}

/** `n` calm readings 30 s apart ending `gapMs` before `endAtMs`: PSI full avg60 cycling up to `maxPsi`, no missed tick. */
function calmReadings(endAtMs: number, n: number, maxPsi: number, gapMs = 10 * MIN): ContainerShedReading[] {
  const out: ContainerShedReading[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      at_ms: endAtMs - gapMs - (n - 1 - i) * 30_000, events_high: 5000, memory_current_mib: 15_000, memory_high_mib: 16_404,
      psi_full_avg60: Math.round(((i % 30) + 1) * (maxPsi / 30) * 100) / 100, missed_ticks: 0,
    });
  }
  return out;
}

/** The two readings of the 10:16Z episode: lag 219 s (3 missed 60 s ticks), then 408 s later lag 408 s (6 missed). */
function episode1016(): [ContainerShedReading, ContainerShedReading] {
  return [
    { at_ms: T1016, events_high: 5400, psi_full_avg60: 31.7, memory_current_mib: 16_910, memory_high_mib: 16_404, missed_ticks: Math.floor(219_000 / POLL_MS) },
    { at_ms: T1016 + 408_000, events_high: 5980, psi_full_avg60: 46.2, memory_current_mib: 17_020, memory_high_mib: 16_404, missed_ticks: Math.floor(408_000 / POLL_MS) },
  ];
}

/** A rung over scripted readings: `push` queues the next reading, `tick` consumes it at its own time. */
function rungOver(inventory: () => readonly ContainerShedEntry[]) {
  const rows: Row[] = [];
  const queue: ContainerShedReading[] = [];
  let nowMs = 0;
  const rung = createContainerShedRung({
    read: (atMs) => {
      const next = queue.shift();
      assert.ok(next, "a reading was queued");
      return { ...next, at_ms: atMs };
    },
    inventory, clock: { now: () => nowMs }, log: (step, fields) => rows.push({ step, fields: fields ?? {} }),
  });
  const tick = (reading: ContainerShedReading) => {
    queue.push(reading);
    nowMs = Math.max(nowMs, reading.at_ms);
    return rung.tick(reading.at_ms, reading.missed_ticks);
  };
  return { rows, tick, setNow: (ms: number) => { nowMs = ms; } };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

test("W1-T15181 criterion 1: the 10:16Z fixture sheds the most recently admitted of three fix children and one review", async () => {
  const fixA = child("run-fix-a", "fix-dispatch", T1016 - 50 * MIN);
  const fixB = child("run-fix-b", "fix-dispatch", T1016 - 20 * MIN);
  const review = child("run-review", "review", T1016 - 12 * MIN);
  const fixC = child("run-fix-c", "fix-dispatch", T1016 - 5 * MIN);
  const all = [fixA, fixB, review, fixC];
  const { rows, tick } = rungOver(() => all.map((c) => c.entry));
  for (const reading of calmReadings(T1016, 120, 2.9)) assert.equal(tick(reading).action, "hold");
  const [lag219, lag408] = episode1016();
  const first = tick(lag219);
  assert.equal(first.action, "hold", "one reading with missed ticks is not yet two readings an avg60 window apart");
  const shed = tick(lag408);
  assert.equal(shed.action, "shed", shed.reason);
  assert.equal(shed.entry?.run_id, "run-fix-c", "the most recently admitted child is the one ended");
  assert.equal(shed.band.source, "learned");
  assert.equal(shed.band.band, 2.8, "the isolated harmed upper level exceeds the W1-T10085 noise allowance");
  await flush();
  assert.deepEqual(all.flatMap((c) => c.ended), ["run-fix-c"], "exactly one child is ended");
  assert.equal(rows.filter((r) => r.step === MEMORY_SHED_STEP).length, 1);
});

test("W1-T15181 criterion 1: the 2026-11-28 00:19Z boot names the youngest of ten fix children with nothing learned yet", async () => {
  const boot = Date.parse("2026-11-28T00:19:00Z");
  const fixes = Array.from({ length: 10 }, (_, i) => child(`run-fix-${i}`, "fix-dispatch", boot + 5_000 + i * 3_000));
  const { rows, tick } = rungOver(() => fixes.map((c) => c.entry));
  const at = (min: number, high: number, missed: number): ContainerShedReading => ({
    at_ms: boot + min * MIN, events_high: high, psi_full_avg60: 61.4, memory_current_mib: 21_883, memory_high_mib: 19_712, missed_ticks: missed,
  });
  assert.equal(tick(at(1, 9000, 0)).action, "hold");
  assert.equal(tick(at(2, 9400, 1)).action, "hold");
  const shed = tick(at(3, 9900, 1));
  assert.equal(shed.action, "shed", shed.reason);
  assert.equal(shed.entry?.run_id, "run-fix-9", "the fix admitted last of the ten is ended");
  assert.equal(shed.band.source, "unlearned");
  await flush();
  const row = rows.find((r) => r.step === MEMORY_SHED_STEP);
  assert.equal(row?.fields.memory_current_mib, 21_883);
  assert.equal(row?.fields.memory_high_mib, 19_712);
});

test("W1-T15181 criterion 1: boot adoption ranks children by their original spawn time, not directory order", async () => {
  resetChildWork();
  const old = T1016 - 53 * MIN;
  const recent = T1016 - 3 * MIN;
  const pending: Array<() => void> = [];
  const log = () => {};
  try {
    // Deliberately adopt in run-id order opposite to admission order, as the boot directory walk does.
    for (const [runId, admittedAtMs] of [["run-T100", recent], ["run-T200", old]] as const) {
      const settled = new Promise<unknown>((_, reject) => pending.push(() => reject(new Error("aborted"))));
      void adoptChildWork({ runId, taskId: runId, admittedAtMs,
        work: { kind: "fix-dispatch", prNumber: 100, headSha: "h100" }, settled }, log);
    }
    const entries = restartDrainInventory({ children: true }).filter((entry) => entry.run_id !== undefined);
    const [lag219, lag408] = episode1016();
    const decision = decideContainerShed(lag408, { readings: [...calmReadings(T1016, 120, 2.9), lag219], episode: {} },
      entries.map((entry) => ({ ...entry, end: async () => ({ signalled: true, ended: "terminal" as const }) })));
    assert.equal(decision.action, "shed");
    assert.equal(decision.entry?.run_id, "run-T100", "the actually recent child wins despite adoption order");
    assert.equal(decision.entry?.admitted_at_ms, recent);
  } finally {
    for (const reject of pending) reject();
    await flush();
    resetChildWork();
  }
});

test("W1-T15181 criterion 2: the calm band is the instance's own, so one PSI reading sheds on one instance and holds on another", () => {
  const ready = [child("run-1", "fix-dispatch", T1016 - MIN).entry];
  const [lag219, lag408] = episode1016();
  const quiet = decideContainerShed(lag408, { readings: [...calmReadings(T1016, 120, 2.9), lag219], episode: {} }, ready);
  const busy = decideContainerShed(lag408, { readings: [...calmReadings(T1016, 120, 50), lag219], episode: {} }, ready);
  assert.equal(quiet.action, "shed");
  assert.equal(busy.action, "hold");
  assert.equal(busy.band.band, 48.33, "the isolated harmed top level is outside the learned calm band");
  assert.ok(busy.missing.some((m) => m.includes("calm band")), busy.missing.join("; "));
});

test("W1-T15181 criterion 2: below the minimum calm sample count the PSI condition is dropped and the measured harm decides", () => {
  const ready = [child("run-1", "fix-dispatch", T1016 - MIN).entry];
  const [lag219, lag408] = episode1016();
  const calmPsi = { ...lag408, psi_full_avg60: 0.5 };
  const thin = decideContainerShed(calmPsi, { readings: [...calmReadings(T1016, SWAP_STALL_MIN_SAMPLES - 1, 2.9), lag219], episode: {} }, ready);
  assert.equal(thin.band.source, "unlearned");
  assert.equal(thin.band.band, null);
  assert.equal(thin.action, "shed", "a high-count rise and missed ticks in two readings decide alone");
  const learned = decideContainerShed(calmPsi, { readings: [...calmReadings(T1016, SWAP_STALL_MIN_SAMPLES + 1, 2.9), lag219], episode: {} }, ready);
  assert.equal(learned.band.source, "learned");
  assert.equal(learned.action, "hold", "PSI inside the learned band holds");
});

test("W1-T15181 criterion 2: the band uses W1-T10085's closed windows, history span and noise rule", () => {
  const now = T1016;
  const calm = (at: number, psi: number, missed = 0): ContainerShedReading => ({
    at_ms: at, events_high: 1, memory_current_mib: 1, memory_high_mib: 2, psi_full_avg60: psi, missed_ticks: missed,
  });
  const base = Array.from({ length: 40 }, (_, i) => calm(now - 2 * 60 * MIN + i * 30_000, 1 + (i % 4)));
  assert.equal(containerCalmBandOf(base, now).band, 4);
  // Readings younger than the closed window, or older than the history span, never teach the band.
  const open = [...base, calm(now - SWAP_STALL_WINDOW_MS + 1, 30)];
  const stale = [calm(now - SWAP_STALL_HISTORY_MS - 1, 30), ...base];
  assert.equal(containerCalmBandOf(open, now).band, 4);
  assert.equal(containerCalmBandOf(stale, now).band, 4);
  // A reading followed by a missed tick within the window is not calm: one in the band is noise, ten are not.
  const missAt = now - 3 * 60 * MIN;
  const oneHarmed = [calm(missAt - 60_000, 0.5), calm(missAt, 0.4, 2), ...base];
  assert.equal(containerCalmBandOf(oneHarmed, now).band, 4, "one harmed reading among forty is within twice the noise");
  const tenHarmed = [...Array.from({ length: 10 }, (_, i) => calm(missAt - (10 - i) * 20_000, 0.5)), calm(missAt, 0.4, 2), ...base];
  const lifted = containerCalmBandOf(tenHarmed, now);
  assert.equal(lifted.source, "learned", "harm concentrated at low PSI does not erase the calm higher band");
  assert.equal(lifted.band, 4);
  assert.match(lifted.basis, /baseline/);
});

test("W1-T15181 criterion 2: a late tick harms the preceding PSI reading even when arrival is beyond five minutes", () => {
  const now = T1016 + 20 * MIN;
  const samples = calmReadings(now, SWAP_STALL_MIN_SAMPLES + 1, 2.9, 12 * MIN);
  const highBeforeStall: ContainerShedReading = {
    at_ms: now - 9 * MIN, events_high: 1, memory_current_mib: 1, memory_high_mib: 2,
    psi_full_avg60: 40, missed_ticks: 0,
  };
  const lateArrival: ContainerShedReading = {
    at_ms: now - 2 * MIN, events_high: 2, memory_current_mib: 2, memory_high_mib: 2,
    psi_full_avg60: 46, missed_ticks: 7,
  };
  const band = containerCalmBandOf([...samples, highBeforeStall, lateArrival], now);
  assert.equal(band.source, "learned", band.basis);
  assert.equal(band.band, 2.9, "PSI 40 before the delayed arrival is not a calm sample");
});

test("W1-T15181 criterion 2: a wholly harmed upper PSI level cannot raise the noise baseline and join the band", () => {
  const now = T1016 + 20 * MIN;
  const samples = calmReadings(now, SWAP_STALL_MIN_SAMPLES + 5, 2, 12 * MIN);
  const high: ContainerShedReading[] = Array.from({ length: SWAP_STALL_MIN_SAMPLES }, (_, i) => ({
    at_ms: now - 10 * MIN + i * 5_000, events_high: 1, memory_current_mib: 1, memory_high_mib: 2,
    psi_full_avg60: 40, missed_ticks: 1,
  }));
  const late: ContainerShedReading = {
    at_ms: now - 8 * MIN, events_high: 2, memory_current_mib: 2, memory_high_mib: 2,
    psi_full_avg60: 46, missed_ticks: 1,
  };
  const band = containerCalmBandOf([...samples, ...high, late], now);
  assert.equal(band.source, "learned", band.basis);
  assert.equal(band.band, 2, "all high PSI readings followed by missed ticks are excluded from the calm band");
});

test("W1-T15181 criterion 2: a mostly harmed upper PSI level cannot hide behind one on-time tick", () => {
  const now = T1016 + 20 * MIN;
  const samples = calmReadings(now, SWAP_STALL_MIN_SAMPLES + 5, 2, 12 * MIN);
  const high: ContainerShedReading[] = Array.from({ length: 40 }, (_, i) => ({
    at_ms: now - 10 * MIN + i * 5_000, events_high: 1, memory_current_mib: 1, memory_high_mib: 2,
    psi_full_avg60: 40, missed_ticks: i === 0 ? 0 : 1,
  }));
  const onTime: ContainerShedReading = {
    at_ms: now - 10 * MIN + 40 * 5_000, events_high: 1, memory_current_mib: 1, memory_high_mib: 2,
    psi_full_avg60: 46, missed_ticks: 0,
  };
  const band = containerCalmBandOf([...samples, ...high, onTime], now);
  assert.equal(band.source, "learned", band.basis);
  assert.equal(band.band, 2, "39 harmed readings exceed the shared noise allowance despite one on-time tick");
  assert.match(band.basis, /lifted/);
});

test("W1-T15181 criterion 2: one stall among hundreds of calm samples does not erase the learned PSI band", () => {
  const now = T1016;
  const samples = calmReadings(now, 284, 3.0, 20 * MIN);
  // Every harmed reading's window has closed by `now`, so all six count; at 3 min ago only two did, and the
  // zero-noise share rule this replaced also kept band 3 on that input.
  const missedAt = now - 10 * MIN;
  const harmedWindow = Array.from({ length: 5 }, (_, i) => ({
    at_ms: missedAt - (5 - i) * 30_000, events_high: 5000, memory_current_mib: 15_000,
    memory_high_mib: 16_404, psi_full_avg60: 0.1, missed_ticks: 0,
  }));
  const missed = { at_ms: missedAt, events_high: 5400, memory_current_mib: 16_910, memory_high_mib: 16_404,
    psi_full_avg60: 0.1, missed_ticks: 1 };
  const history = [...samples, ...harmedWindow, missed];
  const band = containerCalmBandOf(history, now);
  assert.equal(band.source, "learned", band.basis);
  assert.equal(band.band, 3, "the highest non-lifting calm PSI level is retained");
  const [lag219, lag408] = episode1016();
  const current = { ...lag408, psi_full_avg60: 0.2 };
  const decision = decideContainerShed(current, { readings: [...history, lag219], episode: {} },
    [child("run-calm", "fix-dispatch", T1016 - MIN).entry]);
  assert.equal(decision.band.band, 3);
  assert.equal(decision.action, "hold", "0.2 is inside the measured calm band");
});

test("W1-T15181 criterion 3: only a review or a detached fix-dispatch run child is ever a candidate", () => {
  const disposable = [
    child("run-fix", "fix-dispatch", T1016 - 30 * MIN).entry,
    child("run-review", "review", T1016 - 20 * MIN).entry,
  ];
  const never = [
    child("run-retro", "retro", T1016 - MIN).entry,
    child("run-light", "light-pass-action", T1016 - 2 * MIN).entry,
    { ...child("dm", "direct-merge", T1016 - 3 * MIN, { what: "direct-merge" }).entry, run_id: undefined },
    // An in-process review has no run child to end.
    child("in-process-review", "review", T1016 - 4 * MIN, { endless: true }).entry,
  ];
  for (const entry of disposable) assert.equal(isDisposableShedEntry(entry), true, entry.kind);
  for (const entry of never) assert.equal(isDisposableShedEntry(entry), false, entry.kind);
  const [lag219, lag408] = episode1016();
  const history = { readings: [...calmReadings(T1016, 120, 2.9), lag219], episode: {} };
  const shed = decideContainerShed(lag408, history, [...never, ...disposable]);
  assert.equal(shed.action, "shed");
  assert.equal(shed.entry?.run_id, "run-review", "the youngest DISPOSABLE child, never a younger retro, merge or in-process review");
  const none = decideContainerShed(lag408, history, never);
  assert.equal(none.action, "hold");
  assert.ok(none.missing.includes("no disposable candidate"), none.missing.join("; "));
  assert.match(none.reason, /candidate/);
});

test("W1-T15181 criterion 3: the sweep's inventory lists run children with their run id, and its restart drain view is unchanged", async () => {
  resetChildWork();
  const log = () => {};
  const pending: Array<() => void> = [];
  const hosted = (runId: string, kind: string) => {
    const settled = new Promise<unknown>((_, reject) => { pending.push(() => reject(new Error("aborted"))); });
    void adoptChildWork({ runId, taskId: `T-${runId}`, work: { kind, prNumber: 7, headSha: `h-${runId}` }, settled }, log);
  };
  try {
    hosted("run-a", "fix-dispatch");
    hosted("run-b", "review");
    hosted("run-c", "retro");
    assert.deepEqual(restartDrainInventory().filter((e) => e.run_id !== undefined), [], "a restart still waits on no run child");
    const entries = restartDrainInventory({ children: true }).filter((e) => e.run_id !== undefined);
    assert.deepEqual(entries.map((e) => [e.what, e.kind, e.run_id]).sort(),
      [["detached", "fix-dispatch", "run-a"], ["detached", "retro", "run-c"], ["review", "review", "run-b"]]);
    const withEnd = containerShedInventory("/nonexistent-state", log)();
    assert.deepEqual(withEnd.filter(isDisposableShedEntry).map((e) => e.run_id).sort(), ["run-a", "run-b"]);
  } finally {
    for (const reject of pending) reject();
    await flush();
    resetChildWork();
  }
});

test("W1-T15181 criterion 4: one at a time — no second shed until the first child settles and a fresh reading is taken", async () => {
  const older = child("run-older", "fix-dispatch", T1016 - 30 * MIN);
  const younger = child("run-younger", "fix-dispatch", T1016 - 10 * MIN);
  const live = [older, younger];
  const { tick, setNow } = rungOver(() => live.map((c) => c.entry));
  for (const reading of calmReadings(T1016, 120, 2.9)) tick(reading);
  const [lag219, lag408] = episode1016();
  tick(lag219);
  assert.equal(tick(lag408).entry?.run_id, "run-younger");
  const still = { ...lag408, at_ms: lag408.at_ms + MIN, events_high: 6400 };
  const waiting = tick(still);
  assert.equal(waiting.action, "hold");
  assert.match(waiting.reason, /settle/);
  assert.deepEqual(older.ended, [], "the older child is untouched while the first shed is unsettled");
  setNow(lag408.at_ms + 3 * MIN);
  younger.settle();
  live.splice(1, 1);
  await flush();
  const stale = tick({ ...still, at_ms: lag408.at_ms + 2 * MIN, events_high: 6500 });
  assert.equal(stale.action, "hold");
  assert.match(stale.reason, /fresh reading/);
  // Fresh, still stalled, and the shed helped (PSI and memory.current fell): the next youngest goes.
  const helped = tick({ ...still, at_ms: lag408.at_ms + 4 * MIN, events_high: 6600, psi_full_avg60: 20, memory_current_mib: 15_900, missed_ticks: 2 });
  assert.equal(helped.shed_effect, "effective");
  assert.equal(helped.action, "shed", helped.reason);
  assert.equal(helped.entry?.run_id, "run-older");
});

test("W1-T15181 criterion 4: an ineffective shed suspends shedding until a reading is back inside the calm band; a clear reading ends the episode", async () => {
  const a = child("run-a", "fix-dispatch", T1016 - 30 * MIN);
  const b = child("run-b", "review", T1016 - 20 * MIN);
  const c = child("run-c", "fix-dispatch", T1016 - 10 * MIN);
  const live = [a, b, c];
  const { rows, tick, setNow } = rungOver(() => live.map((x) => x.entry));
  for (const reading of calmReadings(T1016, 120, 2.9)) tick(reading);
  const [lag219, lag408] = episode1016();
  tick(lag219);
  assert.equal(tick(lag408).entry?.run_id, "run-c");
  setNow(lag408.at_ms + MIN);
  c.settle();
  live.pop();
  await flush();
  // Neither PSI nor memory.current fell by more than their noise: the shed did not help.
  const flat = { ...lag408, at_ms: lag408.at_ms + 2 * MIN, events_high: 6500 };
  const suspended = tick(flat);
  assert.equal(suspended.action, "suspend");
  assert.equal(suspended.shed_effect, "ineffective");
  const held = tick({ ...flat, at_ms: flat.at_ms + MIN, events_high: 7000 });
  assert.equal(held.action, "hold");
  assert.match(held.reason, /suspend/);
  assert.deepEqual([...a.ended, ...b.ended], [], "nothing more is shed while suspended");
  // Back inside the band (and clear): the suspension and the episode end.
  const clear = tick({ ...flat, at_ms: flat.at_ms + 2 * MIN, events_high: 7000, psi_full_avg60: 1, missed_ticks: 0 });
  assert.equal(clear.action, "hold");
  assert.equal(clear.episode.suspended, undefined);
  const heldRowsBefore = rows.filter((r) => r.step === MEMORY_SHED_HELD_STEP).length;
  // A new episode sheds again, and may write its own held row.
  tick({ ...flat, at_ms: flat.at_ms + 4 * MIN, events_high: 7300, missed_ticks: 1 });
  const again = tick({ ...flat, at_ms: flat.at_ms + 5 * MIN, events_high: 7600, missed_ticks: 1 });
  assert.equal(again.action, "shed", again.reason);
  assert.equal(again.entry?.run_id, "run-b");
  assert.equal(rows.filter((r) => r.step === MEMORY_SHED_HELD_STEP).length, heldRowsBefore + 1);
});

test("W1-T15181 criterion 5: a shed writes one memory.shed row with exactly its fields, and a partly met hold one memory.shed_held per episode", async () => {
  const outcomes: Array<[ContainerShedEndOutcome | Error, string]> = [
    [{ signalled: true, ended: "terminal", killed: false }, "terminal"],
    [{ signalled: true, ended: "lost", killed: true }, "lost"],
    [{ signalled: false, reason: "the run directory is dead" }, "unsignalled"],
    [new Error("kill ESRCH"), "unsignalled"],
  ];
  for (const [outcome, named] of outcomes) {
    const only = child("run-77", "fix-dispatch", T1016 - 7 * MIN, { outcome });
    const { rows, tick } = rungOver(() => [only.entry]);
    for (const reading of calmReadings(T1016, 120, 2.9)) tick(reading);
    const [lag219, lag408] = episode1016();
    tick(lag219);
    tick({ ...lag219, at_ms: lag219.at_ms + 30_000, events_high: 5500 });
    tick(lag408);
    await flush();
    await flush();
    const shedRows = rows.filter((r) => r.step === MEMORY_SHED_STEP);
    assert.equal(shedRows.length, 1, named);
    assert.deepEqual(Object.keys(shedRows[0]!.fields).sort(), [
      "age_ms", "band_source", "calm_band", "kind", "memory_current_mib", "memory_high_mib", "missed_ticks", "outcome",
      "pr", "psi_full_avg60", "run_id", "task_id",
    ]);
    assert.equal(shedRows[0]!.fields.outcome, named);
    assert.equal(shedRows[0]!.fields.run_id, "run-77");
    assert.equal(shedRows[0]!.fields.age_ms, lag408.at_ms - (T1016 - 7 * MIN));
    assert.equal(shedRows[0]!.fields.calm_band, 2.8);
    assert.equal(shedRows[0]!.fields.band_source, "learned");
    assert.equal(shedRows[0]!.fields.missed_ticks, 6);
    const heldRows = rows.filter((r) => r.step === MEMORY_SHED_HELD_STEP);
    assert.equal(heldRows.length, 1, "two partly met holds in one episode write one row");
    assert.ok((heldRows[0]!.fields.missing as string[]).some((m) => m.includes("two readings")), JSON.stringify(heldRows[0]!.fields));
  }
});

test("W1-T15181 criterion 5: the daemon ends a child through abortRunChild on its run directory without a ledger read", async () => {
  await withTempDir("w1-t15181-abort-", async (stateDir) => {
    mkdirSync(join(stateDir, "runs", "run-gone"), { recursive: true });
    const rows: Row[] = [];
    const outcome = await endRunChildForShed(stateDir, "run-gone", (step, fields) => rows.push({ step, fields: fields ?? {} }), 90_000);
    assert.equal(outcome.signalled, false);
    assert.match((outcome as { reason: string }).reason, /run directory/);
  });
});

/** The abort seams of one fake child: SIGTERM or SIGKILL (`diesOn`) ends it, and its settlement then rejects. */
function fakeProcess(diesOn: NodeJS.Signals, reject: () => void) {
  const signals: NodeJS.Signals[] = [];
  let dead = false;
  let clock = 0;
  let waits = 0;
  return {
    signals,
    ports: {
      knownPid: () => (dead ? undefined : 4242),
      kill: (_pgid: number, signal: NodeJS.Signals) => {
        signals.push(signal);
        if (signal !== diesOn) return;
        dead = true;
        reject();
      },
      // An abort that never gets its signal ends here, so a broken path fails its assertions instead of hanging.
      wait: async () => { if (++waits > 500) dead = true; await flush(); },
      clock: () => (clock += MIN),
    },
  };
}

const abortError = () => Object.assign(new Error("aborted before the run finished"), { name: "AbortError" });

/** One freshness yield the next run picked up 90 s later: the yield cost run-task.ts gives a build run's abort. */
const yieldRows = (base: number): Record<string, unknown>[] => [
  { ts: new Date(base - 600_000).toISOString(), run_id: "run-1", task_id: "W1-T1", step: "verdict", reason: "freshness_yield" },
  { ts: new Date(base - 510_000).toISOString(), run_id: "run-2", task_id: "W1-T1", step: "run.start" },
];

/**
 * runDaemon end to end: boot, one dispatch held open, the real in-flight ticker, the DEFAULT rung over the sweep's real
 * inventory and abortRunChild. Only the cgroup reading, the process signals and the ledger lines are injected.
 * `oldEnds` ends the older child at boot, without any shed in this boot.
 */
async function daemonShed(ledger: readonly Record<string, unknown>[], base: number, oldEnds = false) {
  resetChildWork();
  const rows: Row[] = [];
  let rejectYoung!: () => void;
  const young = fakeProcess("SIGKILL", () => rejectYoung());
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let sleeps = 0;
  let reads = 0;
  const merged = new Set<string>();
  try {
    await withTempDir("w1-t15181-daemon-", async (stateDir) => {
      const planPath = join(stateDir, "tasks.yaml");
      writeFileSync(planPath, "- id: A\n  title: a\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n");
      const deps: DaemonDeps = {
        // W1-T12163: the daemon's own memory governor and heap are pinned; the clock stays live, as the readings and
        // ledger rows are dated from `base = Date.now()`.
        ...hostIndependentDaemonDeps(),
        now: () => new Date(),
        refreshMerged: () => (id) => merged.has(id),
        runOne: async (id) => { await gate; merged.add(id); return { taskId: id, runId: `${id}-run`, merged: true, costUsd: 0, verdict: "merged" }; },
        sweepLight: async () => {},
        sleep: async () => {
          await flush();
          if (rows.some((r) => r.step === MEMORY_SHED_STEP) || ++sleeps >= 200) release();
          if (sleeps > 2_000) throw new Error("the daemon never exited");
        },
        log: (step, fields = {}) => rows.push({ step, fields }),
        readLedgerLines: () => ledger.map((row) => JSON.stringify(row)),
        // Adoption order is the reverse of admission order: the older child is adopted last.
        adoptRunChildren: () => [
          { runId: "run-young", taskId: "W1-T900", work: { kind: "fix-dispatch", prNumber: 501, headSha: "h501" },
            settled: new Promise<never>((_, reject) => { rejectYoung = () => reject(abortError()); }) },
          { runId: "run-old", taskId: "W1-T901", work: { kind: "fix-dispatch", prNumber: 502, headSha: "h502" },
            settled: oldEnds ? Promise.reject(abortError()) : new Promise<never>(() => {}) },
        ] as never,
        containerShedSeams: {
          stateDir, abort: young.ports,
          read: () => {
            const n = reads++;
            return { at_ms: base + n * 408_000, events_high: 100 * (n + 1), psi_full_avg60: 40, memory_current_mib: 17_000,
              memory_high_mib: 16_404, missed_ticks: 1 };
          },
        },
      };
      await runDaemon(loadPlan(planPath), deps, { max: 1 });
    });
  } finally {
    resetChildWork();
  }
  return { rows, signals: young.signals };
}

test("W1-T15181 criterion 8: runDaemon's in-flight tick sheds the child spawned last, with the teardown learned at boot", async () => {
  const base = Date.now();
  const at = (ago: number) => new Date(base - ago).toISOString();
  const spawned = [
    { ts: at(7 * MIN), run_id: "run-young", task_id: "W1-T900", step: "run_child.spawned" },
    { ts: at(50 * MIN), run_id: "run-old", task_id: "W1-T901", step: "run_child.spawned" },
  ];
  const { rows, signals } = await daemonShed([...spawned, ...yieldRows(base)], base);
  assert.deepEqual(rows.filter((r) => r.fields.surface === "container_shed"), [], "the tick consults the rung without throwing");
  const shed = rows.filter((r) => r.step === MEMORY_SHED_STEP);
  assert.equal(shed.length, 1);
  assert.equal(shed[0]!.fields.run_id, "run-young");
  assert.equal(shed[0]!.fields.age_ms, 408_000 + 7 * MIN, "its age runs from its spawn, not from this boot's adoption");
  assert.equal(shed[0]!.fields.outcome, "lost");
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  const aborts = rows.filter((r) => r.step === "run_child.abort");
  assert.equal(aborts[0]!.fields.teardown_ms, 90_000);
  assert.equal(aborts[0]!.fields.memory_shed, true);
  const failure = rows.find((r) => r.step === "sweep.fix.dispatch_failed" && r.fields.child_run_id === "run-young");
  assert.equal(failure?.fields.memory_shed, true, "the settlement says the round was shed");
});

test("W1-T15181 criterion 5: with no learned teardown a shed child is signalled once and never killed", async () => {
  await withTempDir("w1-t15181-noteardown-", async (stateDir) => {
    const child = fakeProcess("SIGTERM", () => {});
    const outcome = await endRunChildForShed(stateDir, "run-x", () => {}, undefined, child.ports);
    assert.deepEqual(outcome, { signalled: true, ended: "lost", killed: false });
    assert.deepEqual(child.signals, ["SIGTERM"]);
  });
});

test("W1-T15181 criterion 6: a shed signalled before the boot still marks the adopted child's settlement", async () => {
  resetChildWork();
  const rows: Row[] = [];
  try {
    await adoptChildWork({ runId: "run-before", taskId: "W1-T900", memoryShed: true,
      work: { kind: "fix-dispatch", prNumber: 501, headSha: "h501" }, settled: Promise.reject(abortError()) },
      (step, fields = {}) => rows.push({ step, fields }));
    assert.equal(rows.find((r) => r.step === "sweep.fix.dispatch_failed")?.fields.memory_shed, true);
  } finally {
    resetChildWork();
  }
  // The daemon reads that mark off the marked abort row among the lines it boots on.
  const base = Date.now();
  const { rows: booted } = await daemonShed([
    { ts: new Date(base - 7 * MIN).toISOString(), run_id: "run-young", task_id: "W1-T900", step: "run_child.spawned" },
    { ts: new Date(base - MIN).toISOString(), run_id: "run-old", task_id: "W1-T901", step: "run_child.abort", memory_shed: true },
    ...yieldRows(base),
  ], base, true);
  const old = booted.find((r) => r.step === "sweep.fix.dispatch_failed" && r.fields.child_run_id === "run-old");
  assert.equal(old?.fields.memory_shed, true);
});

test("W1-T15181 criterion 6: the next sweep pass re-admits a shed fix round, even one that wrote fix.dispatch at that head", async () => {
  const now = Date.now();
  const ago = (ms: number) => new Date(now - ms).toISOString();
  const head = "h501abcdef";
  const pr: OpenPrView = {
    prNumber: 501, prUrl: "https://github.com/craigoley/remudero/pull/501", taskId: "W1-T900", reviewState: "failure",
    checksState: "green", unmetCriteria: [{ claim: "a criterion", proof: "unit test: x", met: false, reason: "not done", proof_exec: "not_executable" }],
    priorStrikes: 0, lastActivityAt: ago(60 * MIN), headSha: head, headRefName: "run-W1-T900-1791200000000", autoMergeArmed: false,
  };
  const earlierHead = { step: "fix.dispatch", task_id: "W1-T900", head_sha: "81c30d80bb" };
  const disposed = { step: "sweep.disposed", acted: true, pr_number: 501, head_sha: head, disposition: "blocked-fixable" };
  const dispatch = { step: "fix.dispatch", task_id: "W1-T900", head_sha: head, round_id: "round-shed", mode: "ci-log", ts: ago(10 * MIN) };
  const failure = { step: "sweep.fix.dispatch_failed", task_id: "W1-T900", pr_number: 501, head_sha: head,
    child_run_id: "run-fix-501", error: "aborted before the run finished", ts: ago(MIN) };
  const shed = { ...failure, memory_shed: true };
  const pass = (seed: readonly Record<string, unknown>[]) => withTempDir("w1-t15181-sweep-", async (dir) => {
    const ledgerPath = join(dir, "ledger.ndjson");
    let dispatched = 0;
    await runSweep([pr], {
      arm: () => {}, close: () => {}, escalate: () => {}, runId: "SWEEP-W1-T15181", now: () => now, ledgerPath,
      readLedger: () => [earlierHead, ...seed, ...readLedgerLines(ledgerPath)],
      dispatchFix: () => { dispatched++; },
    });
    await drainDetachedSweepActions();
    const row = readLedgerLines(ledgerPath).findLast((l) => l.step === "sweep.disposed");
    return { dispatched, standDown: String(row?.stand_down_reason) };
  });
  const earlierFailure = { ...failure, child_run_id: "run-earlier", ts: ago(90 * MIN) };
  for (const seed of [
    [disposed, shed],
    [disposed, dispatch, shed],
    [dispatch, disposed, shed],
    [dispatch, shed, disposed], // the shed round's own pass can write its disposed row after the child settled
    [earlierFailure, { ...dispatch, round_id: "round-earlier", ts: ago(50 * MIN) }, disposed, dispatch, shed],
  ]) {
    const next = await pass(seed);
    assert.equal(next.dispatched, 1, `${seed.map((r) => r.step).join(" > ")}: ${next.standDown}`);
  }
  // Controls: the same rows without the mark stay deduped, and a later round's own dispatch ends the release.
  const unmarked = { ...failure, ts: ago(30 * MIN) };
  for (const seed of [[disposed, dispatch, unmarked], [dispatch, shed, disposed, { ...dispatch, round_id: "round-next" }]]) {
    const next = await pass(seed);
    assert.equal(next.dispatched, 0);
    assert.match(next.standDown, /fix already dispatched for this head/);
  }
});

test("W1-T15181 criterion 6: a shed fix round counts no strike and frees its PR; a shed review posts no FAIL and frees its key", async () => {
  resetChildWork();
  const rows: Row[] = [];
  const log = (step: string, fields: Record<string, unknown> = {}) => rows.push({ step, fields });
  const abort = new Map<string, (error: Error) => void>();
  const hosted = (runId: string, work: { kind: string; prNumber: number; headSha: string; fixKey?: string; reviewKey?: string }) => {
    const settled = new Promise<unknown>((_, reject) => { abort.set(runId, reject); });
    void adoptChildWork({ runId, taskId: work.kind === "review" ? "W1-T901" : "W1-T900", work: { ...work, ...(work.fixKey ? { inputs: { dedupeKey: "dedupe-501" } } : {}) }, settled }, log);
  };
  try {
    hosted("run-fix-501", { kind: "fix-dispatch", prNumber: 501, headSha: "h501", fixKey: "W1-T900@h501" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    hosted("run-review-502", { kind: "review", prNumber: 502, headSha: "h502", reviewKey: "review-502" });
    // The child ends `aborted` on SIGTERM: its settlement rejects with an AbortError, as run-child-main writes it.
    const inventory = () => restartDrainInventory({ children: true }).filter((e) => e.run_id !== undefined).map((e) => ({
      ...e, end: () => endRunChildForShed("/nonexistent-state", e.run_id!, log, undefined,
        fakeProcess("SIGTERM", () => abort.get(e.run_id!)?.(abortError())).ports),
    }));
    const rung = createContainerShedRung({ read: (atMs, missed) => ({ ...script.shift()!, at_ms: atMs, missed_ticks: missed }), inventory, clock: { now: () => clock }, log });
    let clock = T1016;
    const script: ContainerShedReading[] = [];
    const tick = (offsetMin: number, high: number, missed: number, psi: number, current: number) => {
      clock = T1016 + offsetMin * MIN;
      script.push({ at_ms: 0, events_high: high, psi_full_avg60: psi, memory_current_mib: current, memory_high_mib: 16_404 });
      return rung.tick(clock, missed);
    };
    tick(0, 100, 0, 40, 17_000);
    tick(1, 150, 1, 40, 17_000);
    assert.equal(tick(2, 200, 1, 40, 17_000).entry?.run_id, "run-review-502", "the review was admitted last");
    await flush();
    await flush();
    assert.equal(childWorkHoldsReviewKey("review-502"), false, "the review's PR is back in the review queue");
    assert.equal(rows.filter((r) => r.step === "review.posted").length, 0, "no verdict, FAIL or otherwise, was posted for it");
    const second = tick(4, 260, 1, 20, 15_000);
    assert.equal(second.entry?.run_id, "run-fix-501", second.reason);
    await flush();
    await flush();
    assert.equal(childWorkCount("fix-dispatch"), 0, "the fix key is released, so the next pass with capacity may admit the PR");
    const failed = rows.find((r) => r.step === "sweep.fix.dispatch_failed" && r.fields.pr_number === 501);
    assert.equal(failed?.fields.memory_shed, true, "the dispatch dedup is voided, and the row says the round was shed");
    assert.equal(rows.filter((r) => /^fix\./.test(r.step)).length, 0, "the shed writes no fix round outcome of its own");
    const ledger = [
      { task_id: "W1-T900", step: "fix.dispatch", head_sha: "h501", round_id: "round-1", strike: 1, mode: "ci-log" },
      ...rows.map((r) => ({ step: r.step, ...r.fields })),
    ];
    assert.equal(fixRoundTally(ledger, "W1-T900", "h501").strikes, 0, "the shed round is no strike");
    const shedFailure = { step: failed!.step, ...failed!.fields, ts: new Date(T1016 + 4 * MIN).toISOString() };
    const holdOf = (row: Record<string, unknown>) => fixDispatchHoldAtHead(
      { prNumber: 501, headSha: "h501", taskId: "W1-T900" } as never, [row], undefined, undefined, { nowMs: T1016 + 4 * MIN });
    assert.equal(holdOf(shedFailure), undefined, "the next sweep can admit the PR as soon as capacity is available");
    assert.ok(holdOf({ ...shedFailure, memory_shed: undefined }), "control: an unmarked failure is held");
  } finally {
    for (const reject of abort.values()) reject(new Error("test cleanup"));
    await flush();
    resetChildWork();
  }
});

test("W1-T15181 criterion 7: each unreadable input holds and is named, never read as zero or as pressure", () => {
  const ready = [child("run-1", "fix-dispatch", T1016 - MIN).entry];
  const [lag219, lag408] = episode1016();
  // Unlearned band: the PSI condition is dropped, so only a reading that names memory.pressure unread can hold here.
  const history = { readings: [lag219], episode: {} };
  const files: Record<string, string> = {
    "/cg/memory.current": String(17_020 * 1048576), "/cg/memory.high": String(16_404 * 1048576),
    "/cg/memory.events": "low 0\nhigh 5980\nmax 0\noom 0\noom_kill 0\n",
    "/cg/memory.pressure": "some avg10=80.00 avg60=70.00 avg300=50.00 total=1\nfull avg10=60.00 avg60=46.20 avg300=30.00 total=1\n",
    "/cg/memory.swap.current": "0", "/cg/memory.max": "max", "/cg/memory.stat": "anon 1\nfile 1\n",
  };
  const readWithout = (missing?: string) => (path: string) => {
    if (path === missing || !(path in files)) throw Object.assign(new Error(`ENOENT ${path}`), { code: "ENOENT" });
    return files[path]!;
  };
  const whole = readContainerShedReading(lag408.at_ms, 6, { readFile: readWithout(), cgroupRoot: "/cg", platform: "linux" });
  assert.deepEqual(whole.unread ?? [], []);
  assert.equal(decideContainerShed(whole, history, ready).action, "shed", "every input read: the fixture sheds");
  for (const file of ["memory.events", "memory.pressure", "memory.current"]) {
    const reading = readContainerShedReading(lag408.at_ms, 6, { readFile: readWithout(`/cg/${file}`), cgroupRoot: "/cg", platform: "linux" });
    const decision = decideContainerShed(reading, history, ready);
    assert.equal(decision.action, "hold", file);
    assert.ok(decision.unread?.some((u) => u.includes(file)), `${file}: ${JSON.stringify(decision.unread)}`);
  }
  const noFull = readContainerShedReading(lag408.at_ms, 6, {
    readFile: (p) => (p === "/cg/memory.pressure" ? "some avg10=1.00 avg60=1.00 avg300=1.00 total=1\n" : readWithout()(p)), cgroupRoot: "/cg", platform: "linux",
  });
  assert.equal(decideContainerShed(noFull, history, ready).action, "hold", "no full avg60 line is unread, not zero");
  const noLag = readContainerShedReading(lag408.at_ms, undefined, { readFile: readWithout(), cgroupRoot: "/cg", platform: "linux" });
  const lagHold = decideContainerShed(noLag, history, ready);
  assert.equal(lagHold.action, "hold");
  assert.ok(lagHold.unread?.some((u) => u.includes("loop-lag")));
  const inventoryHold = decideContainerShed(whole, history, { unread: "registry threw" });
  assert.equal(inventoryHold.action, "hold");
  assert.ok(inventoryHold.unread?.some((u) => u.includes("inventory")));
});

test("W1-T15181 criterion 7: off Linux the cgroup reads are skipped and the decision is hold; a throwing inventory holds the rung", () => {
  const reads: string[] = [];
  const reading = readContainerShedReading(T1016, 6, { readFile: (p) => { reads.push(p); return ""; }, platform: "darwin" });
  assert.deepEqual(reads, [], "nothing under /sys is read off Linux");
  assert.equal(decideContainerShed(reading, { readings: [], episode: {} }, []).action, "hold");
  const [lag219, lag408] = episode1016();
  const queue = [lag219, { ...lag219, at_ms: lag219.at_ms + MIN }, lag408];
  const rung = createContainerShedRung({
    read: (atMs) => ({ ...queue.shift()!, at_ms: atMs }), clock: { now: () => 0 }, log: () => {},
    inventory: () => { throw new Error("registry unreadable"); },
  });
  for (const at of [T1016, T1016 + MIN, T1016 + 408_000]) assert.equal(rung.tick(at, 6).action, "hold");
});

test("W1-T15181 criterion 7: the default reader reads a real cgroup directory through the filesystem", async () => {
  await withTempDir("w1-t15181-cg-", async (root) => {
    writeFileSync(join(root, "memory.current"), String(2 * 1048576));
    writeFileSync(join(root, "memory.high"), String(4 * 1048576));
    writeFileSync(join(root, "memory.events"), "low 0\nhigh 3\nmax 0\noom 0\noom_kill 0\n");
    writeFileSync(join(root, "memory.pressure"), "some avg10=0.00 avg60=0.00 avg300=0.00 total=0\nfull avg10=0.00 avg60=0.10 avg300=0.00 total=0\n");
    const reading = readContainerShedReading(T1016, 0, { cgroupRoot: root, platform: "linux" });
    assert.deepEqual(reading.unread ?? [], []);
    assert.equal(reading.events_high, 3);
    assert.equal(reading.psi_full_avg60, 0.1);
    assert.equal(reading.memory_current_mib, 2);
    assert.equal(reading.memory_high_mib, 4);
  });
});

test("W1-T15181 criterion 7: this host's own cgroup reads without throwing (Linux only)", (t) => {
  if (process.platform !== "linux") { t.skip("reads /sys/fs/cgroup, which exists only on Linux"); return; }
  const reading = readContainerShedReading(Date.now(), 0);
  assert.equal(typeof reading.at_ms, "number");
});
