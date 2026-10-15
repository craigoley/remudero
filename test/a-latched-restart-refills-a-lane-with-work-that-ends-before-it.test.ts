// W1-T9069 — A LATCHED RESTART REFILLS A FREED LANE WITH WORK THAT ENDS BEFORE IT. W1-T8927's holdout closed refill as
// "stale code" for the whole latch and logged a row on every 5-s watchdog poll: on 2026-10-13 two freed lanes idled 45
// lane-min behind one 35-min holdout and the latch wrote 281 rows. These drive the REAL runDaemon on a fake clock with an
// injected runOne and freshness reading; the history is fixture rows stamped from the fake epoch, never a live ledger.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as flush } from "node:timers/promises";
import { test } from "node:test";
import {
  classMedianSpans, decideLatchedRestart, runDaemon, type DaemonDeps, type DaemonFreshness, type RestartBoundary,
} from "../src/lib/daemon.js";
import { loadPlan } from "../src/lib/plan.js";
import type { RunResult } from "../src/lib/run-result.js";

const minute = 60_000;
const epoch = Date.parse("2026-10-13T10:58:00Z");
const material: Extract<DaemonFreshness, { stale: true }> = {
  stale: true, oldSha: "a".repeat(40), newSha: "b".repeat(40),
  changes: [{ sha: "b".repeat(40), subject: "fix: update worker", files: ["src/lib/worker.ts"] }],
  staleSinceMs: epoch - 120 * minute,
};
const selfScoped = { ...material, changes: [{ sha: "b".repeat(40), subject: "fix: refresh loop", files: ["src/lib/daemon.ts"] }] };

/** Settled src runs of `spanMin` minutes, a `yieldMin`-minute yield cost, an implementing phase that finishes in 25
 *  minutes and a preopen gate that finishes in 4. */
function history(spanMin: number | undefined, yieldMin = 62): string[] {
  const rows: string[] = [];
  const add = (age: number, fields: Record<string, unknown>) => rows.push(JSON.stringify({
    ts: new Date(epoch - age * minute).toISOString(), ...fields,
  }));
  if (spanMin !== undefined) {
    for (const n of [0, 1, 2]) {
      add(300 + n, { step: "run.start", task_class: "src", run_id: `span-${n}`, task_id: `span-${n}` });
      add(300 + n - spanMin, { step: "verdict", run_id: `span-${n}`, verdict: "merged" });
    }
  }
  for (const n of [0, 1, 2]) {
    add(200, { step: "verdict", task_id: `yield-${n}`, run_id: `old-${n}`, reason: "freshness_yield" });
    add(200 - yieldMin, { step: "run.start", task_id: `yield-${n}`, run_id: `new-${n}`, type: "implement" });
    add(100, { step: "run.phase", waiting_on: "implementing", task_id: `far-${n}`, run_id: `far-${n}` });
    add(75, { step: "pr.opened", task_id: `far-${n}`, run_id: `far-${n}` });
    add(100, { step: "run.phase", waiting_on: "preopen_gate", task_id: `near-${n}`, run_id: `near-${n}` });
    add(96, { step: "pr.opened", task_id: `near-${n}`, run_id: `near-${n}` });
  }
  return rows;
}

type Row = { step: string; fields: Record<string, unknown> };

async function rig(options: { spanMin?: number; yieldMin?: number; freshness?: typeof material } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "rmd-t9069-"));
  const path = join(dir, "tasks.yaml");
  writeFileSync(path, "ABCDEF".split("").map((id) =>
    `- id: ${id}\n  title: ${id}\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n  files: [src/${id}.ts]\n`).join(""));
  let now = epoch;
  let latched = false;
  const merged = new Set<string>();
  const finishers = new Map<string, (result: RunResult) => void>();
  const boundaries = new Map<string, RestartBoundary>();
  const started: string[] = [];
  const sleeps: Array<() => void> = [];
  const rows: Row[] = [];
  const run = runDaemon(loadPlan(path), {
    now: () => new Date(now), refreshMerged: () => (id: string) => merged.has(id),
    checkFreshness: () => latched ? options.freshness ?? material : { stale: false },
    readLedgerLines: () => [],
    readRestartHistory: () => history("spanMin" in options ? options.spanMin : 10, options.yieldMin),
    runOne: (id: string, opts?: { restartAtWorkerBoundary: RestartBoundary }) => {
      started.push(id);
      boundaries.set(id, opts!.restartAtWorkerBoundary);
      return new Promise<RunResult>((resolve) => finishers.set(id, resolve));
    },
    log: (step: string, fields?: Record<string, unknown>) => rows.push({ step, fields: fields ?? {} }),
    sleep: () => new Promise<void>((resolve) => sleeps.push(resolve)),
  } as unknown as DaemonDeps, { laneCount: 3, max: 12 });
  await flush();
  const settleTick = async () => { sleeps.shift()?.(); await flush(); await flush(); };
  const h = {
    rows, started, run,
    count: (step: string) => rows.filter((row) => row.step === step).length,
    at: (minutes: number) => { now = epoch + minutes * minute; },
    boundary: (id: string, waitingOn = "implementing") =>
      boundaries.get(id)!({ waitingOn, runId: `${id}-run` }),
    latch: async (minutes = 5) => {
      latched = true;
      h.at(minutes);
      await settleTick();
      assert.ok(rows.some((row) => row.step === "daemon.freshness_decision" && row.fields.action === "restart"),
        "positive control: the restart was decided");
    },
    settle: async (id: string, minutes: number) => {
      h.at(minutes);
      merged.add(id);
      finishers.get(id)!({ taskId: id, runId: `${id}-run`, merged: true, verdict: "merged", costUsd: 0 });
      await flush();
      await flush();
    },
    close: async () => {
      // A refill started while settling needs settling too, so keep releasing until the daemon returns.
      let done = false;
      void run.then(() => { done = true; }, () => { done = true; });
      for (let pass = 0; pass < 100 && !done; pass++) {
        for (const [id, finish] of finishers) finish({ taskId: id, runId: `${id}-run`, merged: true, verdict: "merged", costUsd: 0 });
        for (const sleep of sleeps.splice(0)) sleep();
        await flush();
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return h;
}

test("W1-T9069: a freed lane admits a task whose class span ends before the latched restart", async () => {
  const h = await rig({ spanMin: 10 });
  try {
    assert.deepEqual(h.started, ["A", "B", "C"]);
    await h.latch(5);
    assert.equal(h.boundary("A"), undefined);
    assert.equal(h.boundary("B"), undefined);
    assert.equal(h.boundary("C"), undefined);
    const held = h.rows.findLast((row) => row.step === "daemon.restart_holdout");
    assert.equal(held?.fields.restart_at_ms, epoch + 30 * minute, "R is the holdouts' latest expected finish");
    await h.settle("C", 6);
    assert.deepEqual(h.started, ["A", "B", "C", "D"], "D's 10-minute class span ends before R, 24 minutes away");
    const refilled = h.rows.findLast((row) => row.step === "dispatch.lane_refilled");
    assert.equal(refilled?.fields.next_task, "D");
    assert.equal(refilled?.fields.restart_pending, true);
    assert.equal(h.rows.some((row) => row.step === "dispatch.lane_refill_held" && String(row.fields.reason).startsWith("stale code")), false,
      "the first holdout no longer closes refill for the rest of the latch");
    assert.equal(h.count("dispatch.lane_parked"), 0);
  } finally { await h.close(); }
});

test("W1-T9069: a freed lane with nothing that fits parks once and a latch refill never delays the restart", async () => {
  const none = await rig({ spanMin: 40 });
  try {
    await none.latch(5);
    none.boundary("A");
    none.boundary("B");
    none.boundary("C");
    await none.settle("C", 6);
    assert.deepEqual(none.started, ["A", "B", "C"], "a 40-minute task cannot end before R, 24 minutes away");
    const parked = none.rows.filter((row) => row.step === "dispatch.lane_parked");
    assert.equal(parked.length, 1);
    assert.equal(parked[0].fields.reason, "no task ends before the restart");
    assert.equal(parked[0].fields.restart_at_ms, epoch + 30 * minute);
    assert.equal(parked[0].fields.nearest_span_ms, 40 * minute);
    assert.equal(typeof parked[0].fields.nearest_task, "string");
    // A re-decision that finds the same state writes no second row.
    none.boundary("A");
    none.boundary("B", "preopen_gate");
    await flush();
    assert.equal(none.count("dispatch.lane_parked"), 1);
  } finally { await none.close(); }
  const noClass = await rig({ spanMin: undefined });
  try {
    await noClass.latch(5);
    noClass.boundary("A");
    noClass.boundary("B");
    noClass.boundary("C");
    await noClass.settle("C", 6);
    assert.equal(noClass.rows.find((row) => row.step === "dispatch.lane_parked")?.fields.reason, "no class span estimate");
    assert.deepEqual(noClass.started, ["A", "B", "C"]);
  } finally { await noClass.close(); }
  const self = await rig({ spanMin: 10, freshness: selfScoped });
  try {
    await self.latch(5);
    self.boundary("A");
    self.boundary("B");
    self.boundary("C");
    await self.settle("C", 6);
    assert.equal(self.rows.find((row) => row.step === "dispatch.lane_parked")?.fields.reason, "self-scoped restart");
    assert.deepEqual(self.started, ["A", "B", "C"]);
  } finally { await self.close(); }
  const h = await rig({ spanMin: 10 });
  try {
    await h.latch(5);
    h.boundary("A");
    h.boundary("B");
    h.boundary("C");
    const before = h.rows.findLast((row) => row.step === "daemon.restart_holdout")?.fields.restart_at_ms;
    assert.equal(before, epoch + 30 * minute);
    await h.settle("C", 6);
    assert.deepEqual(h.started, ["A", "B", "C", "D"]);
    // The refill is never a holdout, and its own boundary does not move R.
    assert.equal(h.boundary("D"), undefined);
    assert.equal(h.rows.some((row) => row.step === "daemon.restart_holdout" && row.fields.task_id === "D"), false);
    h.boundary("A");
    assert.equal(h.rows.findLast((row) => row.step === "daemon.restart_holdout")?.fields.restart_at_ms, before);
    // Once R has passed and the holdouts have been asked, the refill yields at its next boundary.
    h.at(31);
    assert.equal(h.boundary("A"), material);
    assert.equal(h.boundary("B"), material);
    assert.equal(h.boundary("D"), material);
    assert.equal(h.rows.findLast((row) => row.step === "daemon.restart_yield_asked" && row.fields.task_id === "D")?.fields.reason,
      "latch_refill_past_restart");
  } finally { await h.close(); }
});

test("W1-T9069: the restart moves earlier when idle lanes cost more than a holdout yield", async () => {
  // The 2026-10-13 episode, in minutes from 11:03:32Z: T9001 ends in 6.2, T7957 in 29.4, one lane idle, yield 47.7.
  const episode = decideLatchedRestart({
    holdouts: [{ taskId: "T9001", expectedFinishMs: 6.2 * minute }, { taskId: "T7957", expectedFinishMs: 29.4 * minute }],
    refills: [], idleLanes: 1,
  }, { yieldCostMs: 47.7 * minute }, 0);
  assert.deepEqual(episode.yieldTaskIds, ["T7957"]);
  assert.equal(episode.restartAtMs, 6.2 * minute, "R moves to the holdout that remains");
  assert.equal(episode.compared[0].holdCostMs, 29.4 * minute + 23.2 * minute);
  assert.equal(episode.compared[0].yields, true);
  assert.equal(episode.compared[1].yields, false);
  const cheap = decideLatchedRestart({
    holdouts: [{ taskId: "T9001", expectedFinishMs: 6.2 * minute }, { taskId: "T7957", expectedFinishMs: 29.4 * minute }],
    refills: [{ taskId: "R", expectedFinishMs: 12 * minute }], idleLanes: 0,
  }, { yieldCostMs: 47.7 * minute }, 0);
  assert.deepEqual(cheap.yieldTaskIds, [], "a refill on the lane leaves holding cheaper than yielding");
  assert.equal(cheap.restartAtMs, 29.4 * minute);
  assert.equal(decideLatchedRestart({ holdouts: [{ taskId: "x", expectedFinishMs: 9 * minute }], refills: [], idleLanes: 5 },
    { yieldCostMs: undefined }, 0).yieldTaskIds.length, 0, "no measured yield cost compares nothing");
  assert.equal(decideLatchedRestart({ holdouts: [{ taskId: "x", expectedFinishMs: undefined }], refills: [], idleLanes: 5 },
    { yieldCostMs: 1 }, 0).restartAtMs, undefined, "a holdout with no estimate leaves R unknown");
  assert.equal(decideLatchedRestart({ holdouts: [], refills: [], idleLanes: 2 }, { yieldCostMs: 1 }, 7).restartAtMs, 7,
    "with no holdout left R is now");

  // The same decision in the daemon: both holdouts are measured and one lane frees with nothing to run on it.
  const h = await rig({ spanMin: 40, yieldMin: 40 });
  try {
    await h.latch(5);
    assert.equal(h.boundary("A"), undefined);
    assert.equal(h.boundary("B"), undefined);
    assert.equal(h.boundary("C"), undefined);
    await h.settle("C", 6);
    assert.equal(h.count("dispatch.lane_parked"), 1);
    // One idle lane for 24 minutes costs less than the 40-minute yield; two for 23.5 each cost 47.
    assert.equal(h.boundary("A"), undefined, "one idle lane for 24 minutes costs less than the yield");
    await h.settle("B", 6.5);
    assert.equal(h.boundary("A"), material, "two idle lanes behind A cost at least the yield");
    const asked = h.rows.findLast((row) => row.step === "daemon.restart_yield_asked" && row.fields.task_id === "A");
    assert.equal(asked?.fields.reason, "idle_lanes_cost_more");
    assert.ok(Number(asked?.fields.hold_cost_ms) >= 0);
  } finally { await h.close(); }
});

test("W1-T9069: a holdout poll with an unchanged answer writes no ledger row", async () => {
  const h = await rig({ spanMin: 10 });
  try {
    await h.latch(5);
    for (let poll = 0; poll < 40; poll++) {
      h.at(5 + poll / 12);
      assert.equal(h.boundary("A"), undefined);
    }
    assert.equal(h.rows.filter((row) => row.step === "daemon.restart_holdout" && row.fields.task_id === "A").length, 1,
      "40 five-second polls with the same answer wrote one row");
    assert.equal(h.boundary("A", "preopen_gate"), undefined, "a new phase is a new answer");
    assert.equal(h.rows.filter((row) => row.step === "daemon.restart_holdout" && row.fields.task_id === "A").length, 2);
    h.at(60);
    assert.equal(h.boundary("A"), material);
    assert.equal(h.boundary("A"), material);
    assert.equal(h.rows.filter((row) => row.step === "daemon.restart_yield_asked" && row.fields.task_id === "A").length, 2,
      "estimate_elapsed then already_asked: each change of answer is one row, a repeat is none");
    const row = h.rows.find((r) => r.step === "daemon.restart_holdout")!.fields;
    assert.equal((row.in_flight as unknown[]).length, 3, "the row names the whole in-flight set");
  } finally { await h.close(); }
});

test("W1-T9069: a fired restart writes one latch-cost row with its idle lane time", async () => {
  const h = await rig({ spanMin: undefined });
  try {
    await h.latch(5);
    assert.equal(h.boundary("A"), undefined);
    assert.equal(h.boundary("B"), undefined);
    assert.equal(h.boundary("C"), undefined);
    await h.settle("C", 6); // no class span: the lane parks, idle from minute 6
    assert.equal(h.count("dispatch.lane_parked"), 1);
    await h.settle("A", 16); // freed with a holdout still running: idle from minute 16
    await h.settle("B", 20); // the last holdout: the restart fires here
    const summary = await h.run;
    assert.equal(summary.stopReason, "stale");
    assert.equal(h.count("daemon.restart_latch_cost"), 1);
    const cost = h.rows.find((row) => row.step === "daemon.restart_latch_cost")!.fields;
    assert.equal(cost.waited_ms, 15 * minute);
    assert.equal(cost.idle_lane_ms, 14 * minute + 4 * minute, "lane C 6..20, lane A 16..20, lane B none");
    assert.equal(cost.refills_under_latch, 0);
    assert.equal(cost.yields_asked, 0);
    assert.deepEqual(cost.holdouts, [{ task_id: "A", outcome: "finished" }, { task_id: "B", outcome: "finished" }, { task_id: "C", outcome: "finished" }]);
    assert.equal(cost.latched_at, new Date(epoch + 5 * minute).toISOString());
    assert.equal(cost.fired_at, new Date(epoch + 20 * minute).toISOString());
    assert.equal(cost.old_sha, material.oldSha);
    assert.equal(cost.new_sha, material.newSha);
    assert.equal(cost.restart_expected_at_ms, epoch + 30 * minute);
    assert.equal(cost.restart_expected_error_ms, -10 * minute, "the restart fired 10 minutes before R");
  } finally { await h.close(); }
  const asked = await rig({ spanMin: 10 });
  try {
    await asked.latch(5);
    assert.equal(asked.boundary("A", "recon"), material, "an unmeasured phase yields at once");
    await asked.settle("A", 7);
    await asked.settle("B", 9);
    await asked.settle("C", 10);
    await asked.run;
    const cost = asked.rows.find((row) => row.step === "daemon.restart_latch_cost")!.fields;
    assert.equal(cost.yields_asked, 1);
    assert.deepEqual((cost.holdouts as Array<{ task_id: string; outcome: string }>).find((x) => x.task_id === "A"),
      { task_id: "A", outcome: "yielded_no_history" });
  } finally { await asked.close(); }
});

test("W1-T9069: class median spans fold the restart history, ignoring torn rows and absent classes", () => {
  const rows = [
    ...history(10), ...history(10), "{", "null", JSON.stringify({ ts: "bad" }),
    JSON.stringify({ ts: new Date(epoch - 50 * minute).toISOString(), step: "run.start", run_id: "docs-1", task_class: "docs" }),
  ];
  const medians = classMedianSpans(rows);
  assert.equal(medians.get("src"), 10 * minute);
  assert.equal(medians.has("docs"), false, "a class with no settled span has no estimate");
  const even = classMedianSpans(["a", "b"].flatMap((id, n) => [
    JSON.stringify({ ts: new Date(epoch - 90 * minute).toISOString(), step: "run.start", run_id: id, task_class: "src" }),
    JSON.stringify({ ts: new Date(epoch - (90 - 10 * (n + 1)) * minute).toISOString(), step: "verdict", run_id: id, verdict: "merged" }),
  ]));
  assert.equal(even.get("src"), 15 * minute, "the middle two average");
});
