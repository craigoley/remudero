import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import * as daemon from "#src/lib/daemon.js";
import { loadPlan, type Plan } from "#src/lib/plan.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

// A tick that outlives its lanes for hours held auto-triage to one check per tick: the host ledger for
// 2026-10-27..11-03 shows ticks of 37-266 min and about 6.6 fires a day against 8.6 arrivals. The due timer
// now asks auto-triage again once `autoTriageRearmMs` has passed since the last run; every other gated
// cadence keeps its once-per-tick rule (test/gated-cadences-run-once-the-boot-gate-opens.test.ts).

function fixturePlan(ids: readonly string[]): Plan {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}triage-rearm-`));
  const f = join(dir, "tasks.yaml");
  writeFileSync(f, ids.map((id) => `- id: ${id}\n  title: ${id.toLowerCase()}\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n`).join(""));
  return loadPlan(f);
}

async function within(predicate: () => boolean, boundMs = 1_500): Promise<boolean> {
  const deadline = Date.now() + boundMs;
  while (!predicate()) {
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return true;
}

/** One task whose lane stays in flight until `releaseLane`, so the whole test runs inside tick 1. */
function heldTick() {
  const events: string[] = [];
  const merged = new Set<string>();
  const ticks: number[] = [];
  let passes = 0;
  let releaseLane!: () => void;
  const laneHeld = new Promise<void>((resolve) => (releaseLane = resolve));
  let releaseSweep!: () => void;
  const sweepHeld = new Promise<void>((resolve) => (releaseSweep = resolve));
  let sweepSettled = false;
  const deps: daemon.DaemonDeps = {
    refreshMerged: () => (id: string) => merged.has(id),
    sweep: async () => {
      if (++passes > 1) return;
      await sweepHeld;
    },
    sweepLight: async () => {},
    checkLedgerCompaction: () => ({ fire: false, overBound: false, reason: "fixture" }),
    checkMeasurementCadence: () => ({ fire: false as const, reason: "fixture" }),
    checkRetroTrigger: () => (events.push("retro"), undefined),
    checkAutoTriage: () => (events.push("auto-triage"), { fire: false as const, reason: "fixture" }),
    runOne: async (id) => {
      await laneHeld;
      merged.add(id);
      return { taskId: id, runId: `${id}-run`, merged: true, costUsd: 0.5, verdict: "merged" };
    },
    checkStop: () => undefined,
    checkPause: () => undefined,
    sleep: () => new Promise<void>((resolve) => setTimeout(resolve, 5)),
    log: (step: string) => {
      if (step === "daemon.tick") ticks.push(Date.now());
      if (step === "daemon.sweep.settled") sweepSettled = true;
    },
  };
  return {
    events, ticks, deps,
    count: (name: string) => events.filter((e) => e === name).length,
    releaseLane: () => releaseLane(),
    settleSweep: async () => {
      releaseSweep();
      assert.ok(await within(() => sweepSettled), "fixture: the held boot pass settled");
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

const RUN = { max: 1, pollIntervalMs: 5, sweepWallClockBoundMs: 1_500, bootCadenceGateBoundMs: 50 } as const;

test("auto-triage rearm: a tick that outlives the rearm interval asks auto-triage again", async () => {
  const h = heldTick();
  const running = daemon.runDaemon(fixturePlan(["A"]), h.deps, { ...RUN, autoTriageRearmMs: 30 });
  try {
    assert.ok(await within(() => h.count("auto-triage") >= 1), "positive control: auto-triage ran once in tick 1");
    assert.ok(await within(() => h.count("auto-triage") >= 3),
      `auto-triage is asked again while tick 1's lane is held (saw ${h.events.join(", ")})`);
    assert.equal(h.ticks.length, 1, "all of it inside tick 1");
    assert.equal(h.count("retro"), 1, "the retro keeps its once-per-tick rule");
  } finally {
    h.releaseLane();
  }
  await running;
  await h.settleSweep();
});

test("auto-triage rearm: inside the rearm interval auto-triage is asked once per tick", async () => {
  const h = heldTick();
  const running = daemon.runDaemon(fixturePlan(["A"]), h.deps, { ...RUN, autoTriageRearmMs: 60_000 });
  try {
    assert.ok(await within(() => h.count("auto-triage") >= 1), "positive control: auto-triage ran once in tick 1");
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(h.count("auto-triage"), 1, `one ask while the interval has not passed (saw ${h.events.join(", ")})`);
  } finally {
    h.releaseLane();
  }
  await running;
  await h.settleSweep();
});
