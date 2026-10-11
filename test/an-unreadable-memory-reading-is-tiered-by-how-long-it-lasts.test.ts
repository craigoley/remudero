/**
 * W1-T7720 — AN UNREADABLE MEMORY READING IS TIERED BY HOW LONG IT LASTS.
 *
 * Before: a throw from the memory governor was discarded (daemon path) or logged (drain path) and
 * dispatch carried on at full width FOREVER, and an unreadable reservation store reached nobody. Now a
 * TRANSIENT failure keeps dispatching and leaves a ledger row; a SUSTAINED one holds new dispatch and
 * raises one escalation per streak; the line is derived from this fleet's own recovery times.
 *
 * Everything runs on a fake clock the tests advance by hand: no real time, no sleeping.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FALLBACK_TICK_MULTIPLE,
  checkDispatchGovernors,
  createMemoryReadTracker,
  deriveSustainedBound,
  governorDeferPayload,
  type DispatchGovernorDeps,
  type MemoryReadHold,
  type MemoryReadSource,
} from "../src/lib/dispatch-governor.js";
import { memoryStoreReadFailure, type HostMemoryReading } from "../src/lib/host-memory-ledger.js";
import { loadPlan } from "../src/lib/plan.js";
import { runDrain, type DrainDeps } from "../src/lib/drain.js";

const TICK_MS = 1000;

interface Row {
  step: string;
  fields: Record<string, unknown>;
}

/** A tracker on a hand-advanced clock whose rows, escalations and recovery history are all visible. */
function fixture(history: Partial<Record<MemoryReadSource, number[]>> = {}) {
  const clock = { now: 1_000_000 };
  const rows: Row[] = [];
  const escalations: MemoryReadHold[] = [];
  const tracker = createMemoryReadTracker({
    now: () => clock.now,
    recoveredDurationsMs: (source) => [
      ...(history[source] ?? []),
      ...rows.filter((r) => r.step === "memory_read.recovered" && r.fields.source === source).map((r) => r.fields.duration_ms as number),
    ],
    writeRow: (step, fields) => rows.push({ step, fields }),
    escalate: (hold) => escalations.push(hold),
  });
  return { clock, rows, escalations, tracker };
}

/** The deps of one dispatch consultation whose probe throws while `state.probeDown`, and whose store
 *  reports unreadable while `state.storeDown`. */
function governorDeps(tracker: DispatchGovernorDeps["memoryReadTracker"], state: { probeDown: boolean; storeDown: boolean }) {
  const deps: DispatchGovernorDeps = {
    memoryReadTracker: tracker,
    checkMemoryGovernor: () => {
      if (state.probeDown) throw new Error("/proc/meminfo: EIO");
      return undefined;
    },
    readMemoryStoreFailure: () => (state.storeDown ? "ledger directory: EACCES" : undefined),
  };
  return deps;
}

const steps = (rows: Row[], step: string): Row[] => rows.filter((r) => r.step === step);

test("W1-T7720: a transient unreadable memory reading admits dispatch and writes a ledger row", () => {
  const f = fixture();
  const state = { probeDown: true, storeDown: false };
  const deps = governorDeps(f.tracker, state);

  assert.equal(checkDispatchGovernors(deps, undefined), undefined, "the first failed tick admits");
  f.clock.now += TICK_MS;
  assert.equal(checkDispatchGovernors(deps, undefined), undefined, "a streak younger than the bound still admits");

  const opened = steps(f.rows, "memory_read.unreadable");
  assert.equal(opened.length, 1, "one ledger row for the streak, not one per tick");
  assert.equal(opened[0]!.fields.source, "probe");
  assert.match(String(opened[0]!.fields.error), /EIO/);
  assert.equal(opened[0]!.fields.streak_started_at, new Date(1_000_000).toISOString());
  assert.equal(f.escalations.length, 0, "a transient failure escalates nothing");
});

test("W1-T7720: a sustained unreadable memory reading holds dispatch and escalates once", () => {
  const f = fixture();
  const deps = governorDeps(f.tracker, { probeDown: true, storeDown: false });
  const verdicts = [];
  for (let tick = 0; tick < 8; tick++) {
    verdicts.push(checkDispatchGovernors(deps, undefined));
    f.clock.now += TICK_MS;
  }
  // The cadence is observed as 1000 ms, so with no recovery history the fallback bound is 3 ticks.
  const firstHeld = verdicts.findIndex((v) => v !== undefined);
  assert.equal(firstHeld, FALLBACK_TICK_MULTIPLE + 1, "admitted while younger than the bound, held after it");
  assert.ok(verdicts.slice(firstHeld).every((v) => v?.kind === "memory_unreadable"), "and held from then on");
  const held = verdicts[firstHeld]!;
  assert.equal(held.kind, "memory_unreadable");
  if (held.kind !== "memory_unreadable") return;
  assert.equal(held.hold.source, "probe");
  assert.equal(held.hold.boundMs, FALLBACK_TICK_MULTIPLE * TICK_MS);
  assert.equal(held.hold.basis, "fallback: tick cadence");
  assert.equal(governorDeferPayload(held).sustained_bound_basis, "fallback: tick cadence");

  assert.equal(f.escalations.length, 1, "one escalation for the whole streak, never one per tick");
  assert.equal(f.escalations[0]!.streakStartedAtMs, 1_000_000);
  assert.equal(steps(f.rows, "memory_read.sustained").length, 1);
});

test("W1-T7720: an unreadable reservation store is tiered like the memory probe", () => {
  assert.equal(memoryStoreReadFailure({ state: "unreadable", reason: "EACCES" } as HostMemoryReading), "EACCES");
  assert.equal(memoryStoreReadFailure({ state: "present" } as HostMemoryReading), undefined, "a present store is a reading");
  assert.equal(memoryStoreReadFailure({ state: "missing" } as HostMemoryReading), undefined, "a missing store is reported elsewhere, not as unreadable");
  assert.match(memoryStoreReadFailure(undefined) ?? "", /no reading/, "a read that yields nothing is a failure, never an empty store");

  const f = fixture();
  const state = { probeDown: false, storeDown: true };
  const deps = governorDeps(f.tracker, state);
  const verdicts = [];
  for (let tick = 0; tick < 6; tick++) {
    verdicts.push(checkDispatchGovernors(deps, undefined));
    f.clock.now += TICK_MS;
  }
  assert.equal(verdicts[0], undefined, "transient: admits");
  assert.equal(steps(f.rows, "memory_read.unreadable")[0]!.fields.source, "store");
  const held = verdicts[5]!;
  assert.equal(held.kind, "memory_unreadable", "sustained: holds");
  if (held.kind !== "memory_unreadable") return;
  assert.equal(held.hold.source, "store");
  assert.match(held.hold.error, /EACCES/);
  assert.equal(f.escalations.length, 1);

  state.storeDown = false;
  assert.equal(checkDispatchGovernors(deps, undefined), undefined, "a good store read releases the hold");
  assert.equal(steps(f.rows, "memory_read.recovered")[0]!.fields.source, "store");
});

test("W1-T7720: the sustained bound follows observed recovery times", () => {
  const quick = deriveSustainedBound([100, 120, 110, 130], 1000);
  const slow = deriveSustainedBound([5000, 6000, 7000, 8000], 1000);
  assert.equal(quick.basis, "history n=4");
  assert.equal(slow.basis, "history n=4");
  assert.ok(slow.boundMs! > quick.boundMs!, "a fleet whose hiccups last longer waits longer before holding");
  assert.equal(quick.boundMs, 1000, "floored at one observed tick, since a streak is judged once per tick");
  assert.equal(slow.boundMs, 8000 * 1.5);
  assert.deepEqual(deriveSustainedBound([100], undefined), { boundMs: undefined, basis: "fallback: tick cadence" });

  // The same 6-tick outage: held under the quick history's bound, still transient under the slow one's.
  const outcome = (history: number[]) => {
    const f = fixture({ probe: history });
    const deps = governorDeps(f.tracker, { probeDown: true, storeDown: false });
    let last;
    for (let tick = 0; tick < 6; tick++) {
      last = checkDispatchGovernors(deps, undefined);
      f.clock.now += TICK_MS;
    }
    return { last, escalations: f.escalations.length };
  };
  const quickRun = outcome([100, 120, 110, 130]);
  const slowRun = outcome([5000, 6000, 7000, 8000]);
  assert.equal(quickRun.last?.kind, "memory_unreadable");
  assert.equal(quickRun.last?.kind === "memory_unreadable" ? quickRun.last.hold.basis : "", "history n=4");
  assert.equal(quickRun.escalations, 1);
  assert.equal(slowRun.last, undefined);
  assert.equal(slowRun.escalations, 0);
});

test("W1-T7720: recovery releases the hold and records the streak duration", () => {
  const f = fixture();
  const state = { probeDown: true, storeDown: false };
  const deps = governorDeps(f.tracker, state);
  let verdict;
  for (let tick = 0; tick < 6; tick++) {
    verdict = checkDispatchGovernors(deps, undefined);
    if (tick < 5) f.clock.now += TICK_MS;
  }
  assert.equal(verdict?.kind, "memory_unreadable", "held before recovery");

  f.clock.now += TICK_MS;
  state.probeDown = false;
  assert.equal(checkDispatchGovernors(deps, undefined), undefined, "the first good read releases the hold");
  const recovered = steps(f.rows, "memory_read.recovered");
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0]!.fields.source, "probe");
  assert.equal(recovered[0]!.fields.duration_ms, 6 * TICK_MS, "the streak ran from its first failure to the first good read");
  assert.equal(recovered[0]!.fields.held, true);

  // A later failure is a NEW streak: it dedups on its own start, so it may escalate again.
  state.probeDown = true;
  f.clock.now += TICK_MS;
  const second = f.clock.now;
  for (let tick = 0; tick < 6; tick++) {
    checkDispatchGovernors(deps, undefined);
    f.clock.now += TICK_MS;
  }
  assert.equal(f.escalations.length, 2);
  assert.equal(f.escalations[1]!.streakStartedAtMs, second);
});

test("W1-T7720: the drain pass holds on a sustained unreadable probe and names the bound", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-memory-tier-"));
  try {
    const file = join(dir, "tasks.yaml");
    writeFileSync(
      file,
      ["A", "B", "C", "D", "E", "F", "G"]
        .map((id) => `- id: ${id}\n  title: ${id}\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n`)
        .join(""),
    );
    const f = fixture();
    const merged = new Set<string>();
    const ran: string[] = [];
    const rows: { step: string; extra: Record<string, unknown> }[] = [];
    const deps: DrainDeps = {
      refreshMerged: () => (id: string) => merged.has(id),
      runOne: async (id) => {
        ran.push(id);
        merged.add(id);
        return { taskId: id, runId: "R", merged: true, costUsd: 0, verdict: "merged" };
      },
      log: (step, extra = {}) => rows.push({ step, extra }),
      memoryReadTracker: f.tracker,
      checkMemoryGovernor: () => {
        f.clock.now += TICK_MS;
        throw new Error("/proc/meminfo: EIO");
      },
    };
    const summary = await runDrain(loadPlan(file), deps, { max: 7 });
    assert.equal(summary.stopReason, "memory_governor_deferred");
    assert.ok(ran.length >= 1 && ran.length < 7, "early passes admitted (transient), a later one held (sustained)");
    assert.match(summary.stopDetail ?? "", /memory probe unreadable for \d+ ms, past the 3000 ms sustained bound \(fallback: tick cadence\)/);
    assert.equal(rows.filter((r) => r.step === "drain.memory_unreadable").length, 1);
    assert.equal(f.escalations.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
