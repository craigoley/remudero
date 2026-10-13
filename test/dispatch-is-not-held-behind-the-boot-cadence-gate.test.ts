import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPlan, type Plan } from "../src/lib/plan.js";
import * as daemon from "../src/lib/daemon.js";
import { decideDispatchClaim } from "../src/lib/dispatch-claim.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import type { RunResult } from "../src/run-task.js";

// W1-T9072 — DISPATCH IS NOT HELD BEHIND THE BOOT CADENCE GATE. W1-T5720's gate held tick 1's dispatch along
// with its cadences, so every boot's lanes waited for the first full pass (59 boots: median 4.1 min, max 8.4).
// Every input tick 1's selection reads is valid at boot without that pass, so dispatch runs on tick 1 while
// the gated cadences still wait, and they still never run beside a lane: only at an iteration top.

function fixturePlan(ids: readonly string[]): Plan {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}tick-one-dispatch-`));
  const f = join(dir, "tasks.yaml");
  writeFileSync(f, ids.map((id) => `- id: ${id}\n  title: ${id.toLowerCase()}\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n`).join(""));
  return loadPlan(f);
}

const okResult = (id: string): RunResult => ({ taskId: id, runId: `${id}-run`, merged: true, costUsd: 0.5, verdict: "merged" });

type Line = { step: string; extra: Record<string, unknown> };

/** Fake deps with a gate to hold: two wired cadences and a first full pass that NEVER settles (later passes settle). */
function gatedBoot() {
  const events: string[] = [];
  const lines: Line[] = [];
  const merged = new Set<string>();
  let passes = 0;
  let gateOpened!: () => void;
  const opened = new Promise<void>((resolve) => (gateOpened = resolve));
  const steps = (step: string): Line[] => lines.filter((l) => l.step === step);
  const deps = {
    refreshMerged: () => (id: string) => merged.has(id),
    sweep: async () => {
      if (++passes > 1) return;
      events.push("first-pass-started");
      await new Promise<void>(() => {});
    },
    sweepLight: async () => {},
    checkMeasurementCadence: () => {
      events.push("measurement");
      return { fire: false as const, reason: "fixture" };
    },
    checkRetroTrigger: () => {
      events.push("retro");
      return undefined;
    },
    checkStop: () => undefined,
    checkPause: () => undefined,
    sleep: () => new Promise<void>((resolve) => setTimeout(resolve, 5)),
    log: (step: string, extra: Record<string, unknown> = {}) => {
      lines.push({ step, extra });
      if (step === "daemon.boot_gate.opened") {
        events.push("gate-opened");
        gateOpened();
      }
    },
  };
  return { events, lines, merged, steps, deps, opened };
}

test("W1-T9072: a runnable task starts on tick 1 while the first full pass has not settled", async () => {
  const h = gatedBoot();
  let atStart: { ticks: number; opened: number } | undefined;
  const summary = await daemon.runDaemon(fixturePlan(["A"]), {
    ...h.deps,
    runOne: async (id) => {
      atStart ??= { ticks: h.steps("daemon.tick").length, opened: h.steps("daemon.boot_gate.opened").length };
      h.merged.add(id);
      return okResult(id);
    },
  }, { max: 1, pollIntervalMs: 5, bootCadenceGateBoundMs: 60_000, sweepWallClockBoundMs: 1_500 });
  assert.equal(summary.stopReason, "max_reached");
  assert.deepEqual(summary.merged, ["A"], "the task ran");
  assert.ok(h.events.includes("first-pass-started"), `positive control: the first full pass was running (saw ${h.events.join(", ")})`);
  assert.deepEqual(h.steps("daemon.boot_gate.deferred").map((l) => l.extra.cadence), ["checkMeasurementCadence", "checkRetroTrigger"],
    "positive control: the gate held the cadences");
  assert.equal(atStart?.ticks, 1, "the task started on tick 1");
  assert.equal(atStart?.opened, 0, "the task started while the gate was still closed");
  assert.ok(!h.events.includes("measurement"), "the gated cadence did not run on tick 1");
});

test("W1-T9072: the gated cadences stay deferred and never run beside a tick-1 lane", async () => {
  const h = gatedBoot();
  const summary = await daemon.runDaemon(fixturePlan(["A", "B"]), {
    ...h.deps,
    gardens: [() => (h.events.push("garden"), { stop: () => {} })],
    runOne: async (id) => {
      h.events.push(`lane-start:${id}`);
      // Tick 1's lane is still in flight when the backstop opens the gate.
      if (id === "A") await h.opened;
      h.events.push(`lane-end:${id}`);
      h.merged.add(id);
      return okResult(id);
    },
  }, { max: 2, pollIntervalMs: 5, bootCadenceGateBoundMs: 80, sweepWallClockBoundMs: 1_500 });
  const at = (e: string): number => h.events.indexOf(e);
  const saw = `saw ${h.events.join(", ")}`;
  assert.deepEqual(summary.merged, ["A", "B"]);
  assert.ok(!h.events.includes("first-pass-settled"), "fixture: the first pass never settled");
  assert.equal(h.steps("daemon.boot_gate.opened")[0]?.extra.trigger, "backstop", "the backstop opened the gate");
  assert.ok(at("lane-start:A") >= 0 && at("lane-start:A") < at("gate-opened"), `tick 1 dispatched before the gate opened (${saw})`);
  assert.deepEqual(h.steps("daemon.boot_gate.deferred").map((l) => l.extra.cadence), ["gardens", "checkMeasurementCadence", "checkRetroTrigger"],
    "each deferral is still named, once");
  assert.ok(at("garden") > at("gate-opened"), `the deferred gardens start when the gate opens (${saw})`);
  for (const cadence of ["measurement", "retro"]) {
    assert.equal(h.events.filter((e) => e === cadence).length, 1, `${cadence} is deferred, not skipped (${saw})`);
    assert.ok(at(cadence) > at("gate-opened"), `${cadence} waits for the gate (${saw})`);
    assert.ok(at(cadence) > at("lane-end:A"), `${cadence} never runs beside the tick-1 lane (${saw})`);
    assert.ok(at(cadence) < at("lane-start:B"), `${cadence} runs at the next iteration top, ahead of that tick's dispatch (${saw})`);
  }
});

test("W1-T9072: the duplicate-build guards still refuse on tick 1 before the first pass", async () => {
  const h = gatedBoot();
  const summary = await daemon.runDaemon(fixturePlan(["A", "B", "C"]), {
    ...h.deps,
    isOpenPr: (id) => (id === "A" ? 42 : undefined),
    readPushedRunBranches: () => "0123456789abcdef0123456789abcdef01234567\trefs/heads/run-B-1791800000000\n",
    // The dispatch claim is taken at worker admission, inside runOne, so this fake stands where run-task's claim
    // does and decides through the real `decideDispatchClaim`: C's ref is already held by another lane.
    runOne: async (id) => {
      h.events.push(`admission:${id}@tick${h.steps("daemon.tick").length}`);
      const claim = decideDispatchClaim(id === "C" ? "taken" : "created", { taskId: id, holder: "another lane" });
      if (!claim.proceed) return { taskId: id, runId: `${id}-run`, merged: false, costUsd: 0, verdict: "blocked_inflight" };
      h.events.push(`worker:${id}`);
      h.merged.add(id);
      return okResult(id);
    },
  }, { max: 1, pollIntervalMs: 5, bootCadenceGateBoundMs: 60_000, sweepWallClockBoundMs: 1_500 });
  assert.equal(summary.stopReason, "max_reached");
  assert.deepEqual(h.events.filter((e) => e.startsWith("admission:")), ["admission:C@tick1"], "only C reached admission, on tick 1");
  assert.ok(!h.events.some((e) => e.startsWith("worker:")), `no task started a worker (saw ${h.events.join(", ")})`);
  const tick2 = h.lines.findIndex((l, i) => l.step === "daemon.tick" && i > h.lines.findIndex((r) => r.step === "daemon.tick"));
  const skipped = (task: string) => h.lines.findIndex((l) => l.step === "dispatch.skipped" && l.extra.task === task);
  assert.equal(h.lines[skipped("A")]?.extra.reason, "open-pr", "an open PR refuses A");
  assert.equal(h.lines[skipped("A")]?.extra.pr_number, 42);
  assert.equal(h.lines[skipped("B")]?.extra.reason, "run-branch-already-pushed", "a pushed run branch refuses B");
  for (const task of ["A", "B"]) assert.ok(tick2 < 0 || skipped(task) < tick2, `${task} was refused on tick 1`);
  assert.ok(h.steps("daemon.block.inflight_contention").some((l) => l.extra.task === "C"), "the claim refusal is a deferral");
  assert.equal(h.steps("daemon.boot_gate.opened").length, 0, "all of it before the gate opened");
});

test("W1-T9072: every boot writes one boot-to-first-dispatch row", async () => {
  // A gated boot that starts a task: the row is written at the first runOne start, with the gate still closed.
  const started = gatedBoot();
  await daemon.runDaemon(fixturePlan(["A"]), {
    ...started.deps,
    runOne: async (id) => (started.merged.add(id), okResult(id)),
  }, { max: 1, pollIntervalMs: 5, bootCadenceGateBoundMs: 60_000, sweepWallClockBoundMs: 1_500 });
  const rows = started.steps("daemon.boot_first_dispatch");
  assert.equal(rows.length, 1, "one row per boot");
  const row = rows[0]!.extra;
  assert.match(String(row.boot_at), /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(row.gate_open_ms, null, "the gate was still closed");
  assert.equal(typeof row.first_selection_ms, "number");
  assert.ok(Number(row.first_run_start_ms) >= Number(row.first_selection_ms), "the start follows the selection");
  assert.equal(row.admitted_count, 1);
  assert.equal(row.held_reason, undefined);

  // A boot with nothing runnable writes its row at the first selection, once, however many ticks it idles.
  const idle = await bootWithoutGate(["A"], { merged: ["A"] });
  assert.ok(idle.ticks >= 3, `fixture: several ticks ran (${idle.ticks})`);
  assert.equal(idle.rows.length, 1, "still one row per boot");
  assert.deepEqual({ ...idle.rows[0], boot_at: undefined, first_selection_ms: undefined }, {
    boot_at: undefined, gate_open_ms: 0, first_selection_ms: undefined, first_run_start_ms: null, admitted_count: 0,
    held_reason: "nothing_runnable",
  });

  // A selection the per-lane governor then refuses admits nothing, and names the governor.
  let costReads = 0;
  const governed = await bootWithoutGate(["A"], {
    checkCostGovernor: () => (++costReads >= 2 ? { deferred: true, observedDayCostUsd: 9, ceilingUsd: 5 } : undefined),
  });
  assert.equal(governed.rows.length, 1);
  assert.equal(governed.rows[0]!.held_reason, "governor:cost");
  assert.equal(governed.rows[0]!.first_run_start_ms, null);
  assert.equal(typeof governed.rows[0]!.first_selection_ms, "number");
});

/** A boot with no full pass wired (so no gate), stopped after a few idle ticks. */
async function bootWithoutGate(ids: readonly string[], o: { merged?: readonly string[]; checkCostGovernor?: () => ReturnType<NonNullable<daemon.DaemonDeps["checkCostGovernor"]>> }) {
  const lines: Line[] = [];
  let sleeps = 0;
  await daemon.runDaemon(fixturePlan(ids), {
    refreshMerged: () => (id: string) => (o.merged ?? []).includes(id),
    runOne: async (id) => okResult(id),
    ...(o.checkCostGovernor ? { checkCostGovernor: o.checkCostGovernor } : {}),
    checkStop: () => (sleeps >= 3 ? "fixture stop" : undefined),
    checkPause: () => undefined,
    sleep: async () => { sleeps++; },
    log: (step, extra = {}) => lines.push({ step, extra }),
  }, { pollIntervalMs: 5 });
  return {
    ticks: lines.filter((l) => l.step === "daemon.tick").length,
    rows: lines.filter((l) => l.step === "daemon.boot_first_dispatch").map((l) => l.extra),
  };
}

test("W1-T9072: a tick-1 idle slot is not charged to the boot gate once dispatch no longer waits on it", async () => {
  const h = gatedBoot();
  // Two lanes and one task: tick 1 leaves a slot idle. The gate's deferral rows hold cadences, not that slot.
  await daemon.runDaemon(fixturePlan(["A"]), {
    ...h.deps,
    runOne: async (id) => {
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      h.merged.add(id);
      return okResult(id);
    },
  }, { max: 1, laneCount: 2, pollIntervalMs: 5, bootCadenceGateBoundMs: 300, sweepWallClockBoundMs: 1_500 });
  const changed = h.steps("lane.idle_changed");
  assert.ok(h.steps("daemon.boot_gate.deferred").length > 0, "fixture: the gate held cadences on tick 1");
  assert.ok(changed.some((l) => l.extra.idle_slots === 1), `fixture: tick 1 sampled its idle slot (saw ${JSON.stringify(changed)})`);
  assert.ok(!changed.some((l) => l.extra.cause === "boot_gate"), `no idle slot is charged to the gate (saw ${changed.map((l) => l.extra.cause).join(", ")})`);
});

// W1-T9225 — TICK-1 DISPATCH DOES NOT WAIT FOR THE BOOT REVIEW PASS EITHER. W1-T9072 removed `await bootGateOpened` but
// kept `await bootReviewPass` ahead of dispatch, and its fixture's `sweepLight: async () => {}` settled at once, so it
// cost nothing there. On the first boot on that code (2026-10-13 15:12Z) it cost 500 s: first selection behind 5
// reviews. These fixtures hold the boot review pass open for the whole run.

/** A boot review pass (`sweepLight` with `reviewOnly`) that settles only when the test says so. */
function heldBootReview(events: string[]) {
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  return {
    sweepLight: async (scope?: { reviewOnly?: boolean }) => {
      events.push(scope?.reviewOnly ? "light-pass:review-only" : "light-pass");
      if (scope?.reviewOnly) await held;
    },
    release: () => (events.push("review-released"), release()),
  };
}

/** A daemon held at tick 1 never returns. This bound only turns that hang into a red, then lets the run finish. */
async function unlessHeldAtTickOne(running: Promise<daemon.DaemonSummary>, review: { release: () => void }, saw: () => string) {
  let timer: NodeJS.Timeout | undefined;
  const outcome = await Promise.race([
    running.then((summary) => ({ summary })),
    new Promise<{ held: true }>((resolve) => (timer = setTimeout(() => resolve({ held: true }), 5_000))),
  ]);
  clearTimeout(timer);
  if ("summary" in outcome) return outcome.summary;
  review.release();
  await running;
  return assert.fail(`tick 1 never dispatched while the boot review pass was held (${saw()})`);
}

test("W1-T9225: a runnable task starts on tick 1 while the boot review pass has not settled", async () => {
  // Both gate states: the first full pass never settles (the 15:12Z boot: gate_open_ms null), or settles at once.
  for (const firstPass of ["never-settles", "settles-at-once"] as const) {
    const h = gatedBoot();
    const review = heldBootReview(h.events);
    let atStart: { ticks: number; released: boolean } | undefined;
    const running = daemon.runDaemon(fixturePlan(["A"]), {
      ...h.deps,
      ...(firstPass === "settles-at-once" ? { sweep: async () => { h.events.push("first-pass-settled"); } } : {}),
      sweepLight: review.sweepLight,
      runOne: async (id) => {
        h.events.push("dispatch");
        atStart ??= { ticks: h.steps("daemon.tick").length, released: h.events.includes("review-released") };
        h.merged.add(id);
        return okResult(id);
      },
    }, { max: 1, pollIntervalMs: 5, bootCadenceGateBoundMs: 60_000, sweepWallClockBoundMs: 1_500 });
    const summary = await unlessHeldAtTickOne(running, review, () => `${firstPass}: saw ${h.events.join(", ")}`);
    const saw = `${firstPass}: saw ${h.events.join(", ")}`;
    assert.equal(summary.stopReason, "max_reached", saw);
    assert.deepEqual(summary.merged, ["A"], `the task ran (${saw})`);
    assert.equal(h.events[0], "light-pass:review-only", `the boot review pass still starts first (${saw})`);
    assert.ok(h.events.indexOf("light-pass:review-only") < h.events.indexOf("dispatch"), `the review pass started before dispatch (${saw})`);
    assert.equal(atStart?.ticks, 1, `the task started on tick 1 (${saw})`);
    assert.equal(atStart?.released, false, `the task started while the boot review pass was still in flight (${saw})`);
    const rows = h.steps("daemon.boot_first_dispatch");
    assert.equal(rows.length, 1, `one boot-to-first-dispatch row (${saw})`);
    assert.equal(rows[0]!.extra.admitted_count, 1);
    assert.equal(typeof rows[0]!.extra.first_selection_ms, "number");
    review.release();
  }
});

test("W1-T9225: the gated cadences wait for the boot review pass as well as the gate", async () => {
  const h = gatedBoot();
  const review = heldBootReview(h.events);
  let ticks = 0;
  // A tick 1 held on the review pass never reaches tick 4; this bound releases it so the run reds instead of hanging.
  const unhang = setTimeout(() => review.release(), 5_000);
  const summary = await daemon.runDaemon(fixturePlan(["A"]), {
    ...h.deps,
    // The first full pass settles at once, so the gate opens on tick 1 and only the boot review pass holds.
    sweep: async () => { h.events.push("full-pass-settled"); },
    sweepLight: review.sweepLight,
    runOne: async (id) => {
      h.events.push(`lane-start:${id}`);
      h.merged.add(id);
      return okResult(id);
    },
    // Release the review pass a few iterations in, so ticks with the gate open and the review held are observed.
    checkStop: () => (h.events.includes("measurement") || ticks > 40 ? "fixture stop" : undefined),
    log: (step: string, extra: Record<string, unknown> = {}) => {
      h.deps.log(step, extra);
      if (step === "daemon.tick" && ++ticks === 4) (clearTimeout(unhang), review.release());
    },
  }, { pollIntervalMs: 5, bootCadenceGateBoundMs: 60_000, sweepWallClockBoundMs: 1_500 });
  clearTimeout(unhang);
  const at = (e: string): number => h.events.indexOf(e);
  const saw = `saw ${h.events.join(", ")}`;
  assert.equal(h.steps("daemon.boot_gate.opened")[0]?.extra.trigger, "first_pass", "positive control: the first full pass opened the gate");
  assert.ok(at("gate-opened") >= 0 && at("gate-opened") < at("review-released"), `the gate opened while the review pass was held (${saw})`);
  for (const cadence of ["measurement", "retro"]) {
    assert.ok(at(cadence) >= 0, `${cadence} is deferred, not skipped (${saw})`);
    assert.ok(at(cadence) > at("review-released"), `${cadence} waits for the boot review pass, not only the gate (${saw})`);
  }
  assert.equal(summary.stopReason, "stopped");
  assert.deepEqual(summary.merged, ["A"], saw);
  assert.ok(at("lane-start:A") >= 0 && at("lane-start:A") < at("review-released"), `dispatch did not wait for the review pass (${saw})`);
  const deferred = h.steps("daemon.boot_gate.deferred");
  assert.deepEqual(deferred.map((l) => l.extra.cadence), ["checkMeasurementCadence", "checkRetroTrigger"], "each deferral is named, once");
  for (const l of deferred) {
    assert.deepEqual(l.extra.waits_for, ["boot_review_pass"], "the row names what the cadence waits for");
    assert.equal(l.extra.reason, "boot review pass has not settled");
  }
});

test("W1-T9225: a deferral row names both waits while the gate and the boot review pass are pending", async () => {
  const h = gatedBoot();
  const review = heldBootReview(h.events);
  const summary = await unlessHeldAtTickOne(daemon.runDaemon(fixturePlan(["A"]), {
    ...h.deps,
    gardens: [() => (h.events.push("garden"), { stop: () => {} })],
    sweepLight: review.sweepLight,
    runOne: async (id) => (h.merged.add(id), okResult(id)),
  }, { max: 1, pollIntervalMs: 5, bootCadenceGateBoundMs: 60_000, sweepWallClockBoundMs: 1_500 }), review, () => h.events.join(", "));
  review.release();
  assert.equal(summary.stopReason, "max_reached");
  const deferred = h.steps("daemon.boot_gate.deferred");
  assert.deepEqual(deferred.map((l) => [l.extra.cadence, l.extra.waits_for]), [
    ["gardens", ["first_full_pass"]],
    ["checkMeasurementCadence", ["first_full_pass", "boot_review_pass"]],
    ["checkRetroTrigger", ["first_full_pass", "boot_review_pass"]],
  ], "the gardens wait only for the gate; the cadences name both waits");
  assert.equal(deferred[1]!.extra.reason, "first full pass and boot review pass have not settled");
  assert.ok(!h.events.includes("measurement") && !h.events.includes("garden"), "nothing gated ran");
});
