import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPlan, type Plan } from "../src/lib/plan.js";
import * as daemon from "../src/lib/daemon.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import type { RunResult } from "../src/run-task.js";

// W1-T9321 — THE GATED CADENCES RUN ONCE THE BOOT GATE OPENS, NOT AT A SECOND TICK THAT NEVER COMES. W1-T9072 let
// tick 1 dispatch with the gate closed and left every gated cadence, and the W1-T7690 due timer that drives them, to
// the top of tick 2. Tick 1 waits for its lanes, and the freshness restart replaced every process first: from
// 2026-10-13T14:24Z each core process wrote one `daemon.tick` and no compaction, measurement, retro or auto-triage row.
// Every fixture here holds tick 1's lane open until the test releases it, so a cadence that needs tick 2 never runs.

function fixturePlan(ids: readonly string[]): Plan {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t9321-`));
  const f = join(dir, "tasks.yaml");
  writeFileSync(f, ids.map((id) => `- id: ${id}\n  title: ${id.toLowerCase()}\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n`).join(""));
  return loadPlan(f);
}

const okResult = (id: string): RunResult => ({ taskId: id, runId: `${id}-run`, merged: true, costUsd: 0.5, verdict: "merged" });

type Line = { step: string; extra: Record<string, unknown> };

/** Polls a condition for at most `boundMs` (the daemon's poll interval here is 5 ms, so this is hundreds of them). */
async function within(predicate: () => boolean, boundMs = 1_500): Promise<boolean> {
  const deadline = Date.now() + boundMs;
  while (!predicate()) {
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return true;
}

/**
 * A boot whose first full pass never settles (so only the backstop opens the gate), with every cadence under test
 * wired, and one task whose lane stays in flight until `releaseLane`. `review` holds the boot review pass the same way.
 */
function heldBoot(o: { holdReview?: boolean } = {}) {
  const events: string[] = [];
  const lines: Line[] = [];
  const merged = new Set<string>();
  let passes = 0;
  let releaseLane!: () => void;
  const laneHeld = new Promise<void>((resolve) => (releaseLane = resolve));
  let releaseReview!: () => void;
  const reviewHeld = new Promise<void>((resolve) => (releaseReview = resolve));
  const steps = (step: string): Line[] => lines.filter((l) => l.step === step);
  const deps: daemon.DaemonDeps = {
    refreshMerged: () => (id: string) => merged.has(id),
    sweep: async () => {
      if (++passes > 1) return;
      await new Promise<void>(() => {});
    },
    sweepLight: async (scope) => {
      if (scope?.reviewOnly && o.holdReview) await reviewHeld;
    },
    checkLedgerCompaction: () => (events.push("compaction"), { fire: false, overBound: false, reason: "fixture" }),
    checkMeasurementCadence: () => (events.push("measurement"), { fire: false as const, reason: "fixture" }),
    checkRetroTrigger: () => (events.push(`retro@tick${steps("daemon.tick").length}`), undefined),
    checkAutoTriage: () => (events.push(`auto-triage@tick${steps("daemon.tick").length}`), { fire: false as const, reason: "fixture" }),
    runOne: async (id) => {
      events.push(`lane-start:${id}`);
      await laneHeld;
      events.push(`lane-end:${id}`);
      merged.add(id);
      return okResult(id);
    },
    checkStop: () => undefined,
    checkPause: () => undefined,
    sleep: () => new Promise<void>((resolve) => setTimeout(resolve, 5)),
    log: (step: string, extra: Record<string, unknown> = {}) => {
      lines.push({ step, extra });
      if (step === "daemon.boot_gate.opened") events.push("gate-opened");
    },
  };
  return {
    events, lines, steps, deps,
    releaseLane: () => (events.push("lane-released"), releaseLane()),
    releaseReview: () => (events.push("review-released"), releaseReview()),
    ran: (prefix: string): boolean => events.some((e) => e.startsWith(prefix)),
  };
}

const RUN = { max: 1, pollIntervalMs: 5, sweepWallClockBoundMs: 1_500 } as const;

test("W1-T9321: the due rungs run while a tick-1 lane outlives the boot gate", async () => {
  const h = heldBoot();
  const running = daemon.runDaemon(fixturePlan(["A"]), h.deps, { ...RUN, bootCadenceGateBoundMs: 50 });
  try {
    assert.ok(await within(() => h.events.includes("lane-start:A")), "fixture: tick 1 dispatched A");
    assert.ok(await within(() => h.events.includes("gate-opened")), "positive control: the backstop opened the gate");
    const saw = (): string => `saw ${h.events.join(", ")}`;
    assert.ok(await within(() => h.ran("compaction") && h.ran("measurement")),
      `the ledger compaction check and measurement run while tick 1's lane is in flight (${saw()})`);
    assert.ok(!h.events.includes("lane-end:A"), `fixture: the lane was still held (${saw()})`);
    assert.equal(h.steps("daemon.tick").length, 1, `and without a second tick (${saw()})`);
    for (const cadence of ["compaction", "measurement"]) {
      assert.ok(h.events.indexOf(cadence) > h.events.indexOf("gate-opened"), `${cadence} waited for the gate (${saw()})`);
    }
  } finally {
    h.releaseLane();
  }
  const summary = await running;
  assert.deepEqual(summary.merged, ["A"]);
  const exit = h.steps("daemon.summary")[0]?.extra;
  assert.equal(exit?.gate_opened_without_cadence, false, "the exit row says the opened gate's cadences ran");
  assert.ok(Number(exit?.gated_cadence_runs) > 0, `the exit row counts the gated cadence runs (${JSON.stringify(exit)})`);
});

test("W1-T9321: the retro trigger and auto-triage run without a second tick", async () => {
  const h = heldBoot();
  const running = daemon.runDaemon(fixturePlan(["A"]), h.deps, { ...RUN, bootCadenceGateBoundMs: 50 });
  try {
    assert.ok(await within(() => h.events.includes("gate-opened")), "positive control: the backstop opened the gate");
    const saw = (): string => `saw ${h.events.join(", ")}`;
    assert.ok(await within(() => h.ran("retro@") && h.ran("auto-triage@")),
      `the retro trigger and auto-triage run while tick 1's lane is in flight (${saw()})`);
    assert.ok(!h.events.includes("lane-end:A"), `fixture: the lane was still held (${saw()})`);
    assert.ok(h.events.includes("retro@tick1") && h.events.includes("auto-triage@tick1"), `each ran during tick 1 (${saw()})`);
    // Once per tick, as at an iteration top: the owed run is paid once, not on every timer interval.
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(h.events.filter((e) => e.startsWith("retro@")).length, 1, `the retro ran once for tick 1 (${saw()})`);
    assert.equal(h.events.filter((e) => e.startsWith("auto-triage@")).length, 1, `auto-triage ran once for tick 1 (${saw()})`);
    assert.ok(h.events.indexOf("retro@tick1") > h.events.indexOf("gate-opened"), `the retro waited for the gate (${saw()})`);
  } finally {
    h.releaseLane();
  }
  await running;

  // Only behind the spend gates: tick 1 passes the governors, so it owes both spending cadences, and every later tick
  // defers on the cost governor. The gate opens during those ticks: the debt is not paid past a closed spend gate,
  // while the read-only due rungs still run.
  const governed = heldBoot();
  const tick = (): number => governed.steps("daemon.tick").length;
  const summary = await daemon.runDaemon(fixturePlan(["A"]), {
    ...governed.deps,
    refreshMerged: () => () => true,
    checkCostGovernor: () => (tick() >= 2 ? { deferred: true as const, observedDayCostUsd: 9, ceilingUsd: 5 } : undefined),
    checkStop: () => (governed.events.filter((e) => e === "measurement").length >= 20 || tick() > 400 ? "fixture stop" : undefined),
  }, { pollIntervalMs: 5, sweepWallClockBoundMs: 1_500, bootCadenceGateBoundMs: 50 });
  const saw = `saw ${[...new Set(governed.events)].join(", ")}`;
  assert.equal(summary.stopReason, "stopped");
  assert.ok(governed.steps("daemon.boot_gate.deferred").some((l) => l.extra.cadence === "checkRetroTrigger"),
    "positive control: tick 1 reached the spending cadences with the gate closed");
  assert.ok(governed.events.includes("gate-opened"), `positive control: the gate opened (${saw})`);
  assert.ok(governed.steps("daemon.cost_governor").length > 0, `positive control: the cost governor deferred (${saw})`);
  assert.ok(governed.ran("measurement"), `positive control: the read-only rungs ran (${saw})`);
  assert.ok(!governed.ran("retro@") && !governed.ran("auto-triage@"), `no spending cadence ran past a closed spend gate (${saw})`);
});

test("W1-T9321: nothing gated runs before the gate opens and the boot review settles", async () => {
  const h = heldBoot({ holdReview: true });
  const running = daemon.runDaemon(fixturePlan(["A"]), h.deps, { ...RUN, bootCadenceGateBoundMs: 50 });
  const gated = ["compaction", "measurement", "retro@", "auto-triage@"];
  const saw = (): string => `saw ${h.events.join(", ")}`;
  try {
    assert.ok(await within(() => h.events.includes("lane-start:A")), "fixture: tick 1 dispatched A");
    assert.ok(!gated.some((c) => h.ran(c)), `nothing gated ran before the gate opened (${saw()})`);
    assert.ok(await within(() => h.events.includes("gate-opened")), "positive control: the backstop opened the gate");
    // Twenty poll intervals with the gate open and the boot review pass still held.
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(!gated.some((c) => h.ran(c)), `nothing gated ran while the boot review pass was held (${saw()})`);
    h.releaseReview();
    assert.ok(await within(() => gated.every((c) => h.ran(c))), `each gated cadence runs once the review settles (${saw()})`);
    assert.ok(!h.events.includes("lane-end:A"), `still beside tick 1's held lane (${saw()})`);
    for (const c of gated) {
      assert.ok(h.events.findIndex((e) => e.startsWith(c)) > h.events.indexOf("review-released"), `${c} waited for the review (${saw()})`);
    }
  } finally {
    h.releaseReview();
    h.releaseLane();
  }
  await running;
});

test("W1-T9321: the exit row names a process that opened its gate but never ran a cadence", async () => {
  // The outage's shape: the gate opens, the boot review pass never settles, the process exits.
  const h = heldBoot({ holdReview: true });
  const running = daemon.runDaemon(fixturePlan(["A"]), h.deps, { ...RUN, bootCadenceGateBoundMs: 50 });
  try {
    assert.ok(await within(() => h.events.includes("gate-opened")), "positive control: the backstop opened the gate");
  } finally {
    h.releaseLane();
  }
  await running;
  h.releaseReview();
  const exit = h.steps("daemon.summary")[0]?.extra;
  assert.equal(exit?.gate_opened_without_cadence, true, `the exit row names it (${JSON.stringify(exit)})`);
  assert.equal(exit?.gated_cadence_runs, 0);

  // A boot that gates nothing writes neither field.
  const lines: Line[] = [];
  await daemon.runDaemon(fixturePlan(["A"]), {
    refreshMerged: () => () => false,
    runOne: async (id) => okResult(id),
    sleep: async () => {},
    log: (step, extra = {}) => lines.push({ step, extra }),
  }, { max: 1, pollIntervalMs: 5 });
  const plain = lines.find((l) => l.step === "daemon.summary")?.extra;
  assert.ok(plain, "positive control: the summary row was written");
  assert.equal("gate_opened_without_cadence" in plain, false);
});
