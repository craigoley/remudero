/**
 * W1-T12231 — A FRESHNESS RESTART PICKS ITS MOMENT FROM THE PREDICTED END OF THE WORK IN FLIGHT.
 *
 * 2026-11-04..11, core instance: over 36 freshness exits the drain gave up 13 reviews and 20 fix rounds at its time
 * limit, the decision plus `sweepWallClockBoundMs` whatever was in flight. Before the decision every review and fix
 * round was admitted, also when the restart was minutes away.
 *
 * Each fixture runs build lanes under a fake clock. One clock unit is one minute unless a test says otherwise; the
 * sweep's time limit is 10 units, the staleness horizon 60 units and the score limit 18.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as flush } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { parse as parseYaml } from "yaml";

import { freshnessRestartOpts } from "#src/cli/commands/daemon.js";
import { runDaemon, type DaemonDeps, type DaemonOpts, type LightPassScope, type ReviewAdmissionGate } from "#src/lib/daemon.js";
import { timeToLikelyFreshnessRestart } from "#src/lib/deploy-judge.js";
import { loadPlan } from "#src/lib/plan.js";
import { loadPolicy, policyPath, PolicyError, validatePolicy } from "#src/lib/policy.js";
import {
  detachSweepAction, detachedSweepActionCount, drainDetachedSweepActions, drainInFlightReviews, inFlightReviewCount, trackInFlightReview,
} from "#src/lib/sweep.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

type RunResult = Awaited<ReturnType<DaemonDeps["runOne"]>>;

const MINUTE = 60_000;
const OLD_SHA = "a".repeat(40);
const NEW_SHA = "b".repeat(40);
const POLICY_PATH = policyPath(REPO_ROOT);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

/** `fix.dispatch` → `fix.done` rounds, each `lengthMs` from the start of the round. */
function fixHistory(lengthMs: number, unit: number, rounds = 3): string[] {
  const end = Date.now() - unit;
  return Array.from({ length: rounds }, (_, i) => [
    JSON.stringify({ ts: new Date(end - unit - i).toISOString(), step: "fix.dispatch", round_id: `r${i}`, elapsed_ms: lengthMs - unit }),
    JSON.stringify({ ts: new Date(end - i).toISOString(), step: "fix.done", round_id: `r${i}` }),
  ]).flat();
}

/** `sweep.review_started` → `review.posted` pairs, each `lengthMs` long. */
function reviewHistory(lengthMs: number, unit: number, pairs = 3): string[] {
  const end = Date.now() - unit;
  return Array.from({ length: pairs }, (_, i) => [
    JSON.stringify({ ts: new Date(end - lengthMs - i).toISOString(), step: "sweep.review_started", pr_number: 900 + i }),
    JSON.stringify({ ts: new Date(end - i).toISOString(), step: "review.posted", pr_url: `https://github.com/acme/remudero/pull/${900 + i}` }),
  ]).flat();
}

interface Row { step: string; extra: Record<string, unknown> }
interface LightPass { stale: boolean; at: number; asked: boolean; fix: boolean; review: boolean; plan: boolean; refill: boolean }
interface FullPass { stale: boolean; at: number; hold: string | undefined; review: boolean }
interface Options {
  unit?: number;
  tasks?: readonly string[];
  lanes?: number;
  fullSweep?: boolean;
  /** How long before the start the tree went stale, in units. 120 units reach the score limit at once. */
  staleUnits?: number;
  opts?: DaemonOpts;
  onReviewAdmitted?: () => void;
}

/** Build lanes run; `stale(units)` makes the tree stale, so the next dispatch tick scores the restart. The fake light
 *  pass asks the daemon's own admission for a fix, a review, a plan review and a build refill. */
function restartLanes(t: TestContext, ledger: (unit: number) => readonly string[], options: Options = {}) {
  assert.equal(inFlightReviewCount(), 0, "precondition: no review leaked from another test");
  assert.equal(detachedSweepActionCount(), 0, "precondition: no detached action leaked from another test");
  const unit = options.unit ?? MINUTE;
  const tasks = options.tasks ?? ["A"];
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t12231-`));
  const planPath = join(dir, "tasks.yaml");
  writeFileSync(planPath, tasks.map((id) =>
    `- id: ${id}\n  title: ${id}\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n  files: [src/${id}.ts]\n`).join(""));
  const start = Date.now();
  let nowMs = start;
  t.mock.method(Date, "now", () => nowMs);
  const history = ledger(unit);
  const rows: Row[] = [];
  const light: LightPass[] = [];
  const full: FullPass[] = [];
  const lanes = new Map(tasks.map((id) => [id, deferred<RunResult>()]));
  const started: string[] = [];
  const merged = new Set<string>();
  const sleeps: Array<ReturnType<typeof deferred<void>>> = [];
  let isStale = false;
  let exiting = false;
  const material = { stale: true as const, oldSha: OLD_SHA, newSha: NEW_SHA, staleSinceMs: start - (options.staleUnits ?? 120) * unit,
    changes: [{ sha: NEW_SHA, subject: "fix: update worker", files: ["src/lib/worker.ts"] }] };
  const age = () => (nowMs - start) / unit;
  const daemon = runDaemon(loadPlan(planPath), {
    now: () => new Date(nowMs),
    readLedgerLines: () => history,
    refreshMerged: () => (id) => merged.has(id),
    checkFreshness: () => isStale ? material : { stale: false },
    log: (step, extra = {}) => rows.push({ step, extra }),
    runOne: (id) => { started.push(id); return lanes.get(id)!.promise; },
    sleep: () => { const sleep = deferred<void>(); sleeps.push(sleep); return sleep.promise; },
    sleepUntilSweepWake: async () => {
      if (exiting) { await flush(); return "wake"; }
      const sleep = deferred<void>();
      sleeps.push(sleep);
      await sleep.promise;
      return "timeout";
    },
    sweepLight: async (scope?: LightPassScope) => {
      const review = scope?.admit?.("review", "light") !== false;
      light.push({ stale: isStale, at: age(), asked: scope?.admit !== undefined, review,
        fix: !scope?.reviewOnly && scope?.admit?.("fix-dispatch", "light") !== false,
        plan: scope?.admit?.("plan-review", "light") !== false,
        refill: scope?.admit?.("dispatch-refill", undefined, unit) !== false });
      if (review && isStale) options.onReviewAdmitted?.();
    },
    ...(options.fullSweep ? {
      sweep: async (gate?: ReviewAdmissionGate) => {
        full.push({ stale: isStale, at: age(), hold: gate?.workerAdmissionHold?.(), review: gate?.() ?? true });
      },
    } : {}),
  } as DaemonDeps, { freshnessMinLifetimeMs: 0, laneCount: options.lanes ?? 1, max: tasks.length, sweepWallClockBoundMs: 10 * unit,
    sweepRetriggerIntervalMs: unit, freshnessStalenessHorizonMs: 60 * unit, freshnessMaxDrainWaitMs: 30 * unit, ...options.opts });
  const at = (units: number) => { nowMs = start + units * unit; };
  const tick = async (rounds = 2) => {
    for (let wait = 0; wait < 20 && started.length === 0; wait++) {
      for (const sleep of sleeps.splice(0)) sleep.resolve();
      for (let i = 0; i < 50; i++) await flush();
    }
    assert.ok(started.length > 0, "no lane started");
    for (let round = 0; round < rounds; round++) {
      for (const sleep of sleeps.splice(0)) sleep.resolve();
      for (let i = 0; i < 50; i++) await flush();
    }
  };
  const settle = (id: string) => {
    merged.add(id);
    lanes.get(id)!.resolve({ taskId: id, runId: `${id}-run`, merged: true, verdict: "merged", costUsd: 0 });
  };
  return {
    daemon, rows, light, full, at, tick, settle, started, unit, start,
    step: (step: string) => rows.filter((row) => row.step === step).map((row) => row.extra),
    lightAt: (units: number) => light.filter((pass) => pass.stale && pass.at === units),
    stale: async (units: number) => {
      at(units);
      isStale = true;
      await tick();
    },
    exit: () => {
      exiting = true;
      for (const id of tasks) settle(id);
      for (const sleep of sleeps.splice(0)) sleep.resolve();
    },
    cleanup: async () => {
      exiting = true;
      for (const id of tasks) if (!merged.has(id)) settle(id);
      for (const sleep of sleeps) sleep.resolve();
      await daemon;
      await drainDetachedSweepActions();
      await drainInFlightReviews({ boundMs: 1000 });
      rmSync(dir, { recursive: true, force: true });
      t.mock.restoreAll();
    },
  };
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 2000; attempt++) {
    if (predicate()) return;
    await flush();
  }
  assert.fail(message);
}

const iso = (ms: number) => new Date(ms).toISOString();
type Prediction = { kind: string; wait_ms: number; source: string; samples: number; lanes: Array<Record<string, unknown>> };

test("W1-T12231 criterion 1: the drain's time limit is the predicted end of the reviews and fix rounds in flight at the decision", async (t) => {
  // A review takes 5 units and a fix round 20. At the decision (1 unit) the review is 3 units old, the fix round 1.
  const h = restartLanes(t, (unit) => [...reviewHistory(5 * unit, unit), ...fixHistory(20 * unit, unit)]);
  const review = deferred<void>();
  const fix = deferred<void>();
  void trackInFlightReview(review.promise, { taskId: "W1-REVIEW", prNumber: 71, admittedAtMs: h.start - 2 * h.unit });
  detachSweepAction(fix.promise, { actionKind: "fix-dispatch", taskId: "W1-FIX", startedAtMs: h.start });
  try {
    await h.stale(1);
    const [started] = h.step("daemon.freshness_drain.started");
    assert.equal(started?.started_at, "latch");
    assert.equal(started?.deadline_source, "derived");
    // The review has 2 units left and the fix round 19: the time limit is the fix round's predicted end.
    assert.equal(started?.derived_wait_ms, 19 * h.unit);
    assert.equal(started?.drain_deadline_at, iso(h.start + 20 * h.unit));
    const predictions = started?.predictions as Prediction[];
    const byKind = Object.fromEntries(predictions.map((prediction) => [prediction.kind, prediction]));
    assert.deepEqual(Object.keys(byKind).sort(), ["fix-dispatch", "review"]);
    assert.equal(byKind.review!.wait_ms, 2 * h.unit);
    assert.equal(byKind.review!.samples, 3);
    assert.deepEqual(byKind.review!.lanes.map((lane) => [lane.run_id, lane.age_s, lane.remaining_s]), [["W1-REVIEW", 180, 120]]);
    assert.equal(byKind["fix-dispatch"]!.wait_ms, 19 * h.unit);
    assert.deepEqual(byKind["fix-dispatch"]!.lanes.map((lane) => [lane.run_id, lane.age_s, lane.remaining_s]), [["W1-FIX", 60, 1140]]);
    // The latch judges admissions against that end: at 16 units 4 units are left, so a 5-unit review is held.
    h.at(16);
    await h.tick();
    assert.ok(h.lightAt(16).length >= 1 && h.lightAt(16).every((pass) => !pass.review), JSON.stringify(h.light));
    const hold = h.step("daemon.admission_held").find((row) => row.kind === "review");
    assert.equal(hold?.reason, "restart latched");
    assert.equal(hold?.time_left_ms, 4 * h.unit);
    assert.equal(h.step("daemon.restart_hold_ended").length, 0, "the time limit is not the sweep's 11 units");
  } finally {
    review.resolve();
    fix.resolve();
    await h.cleanup();
  }
});

test("W1-T12231 criterion 2: with nothing in flight at the decision the drain does not wait for the sweep's time limit", async (t) => {
  // One unit is 40 ms. Nothing is in flight at the decision; a review admitted after it is still running at the exit.
  const gate = deferred<void>();
  let admitted = false;
  const h = restartLanes(t, (unit) => reviewHistory(5 * unit, unit), {
    unit: 40,
    onReviewAdmitted: () => {
      if (admitted) return;
      admitted = true;
      void trackInFlightReview(gate.promise, { taskId: "W1-AFTER", prNumber: 81 });
    },
  });
  try {
    await h.stale(1);
    assert.equal(h.step("daemon.freshness_drain.started").length, 0, "nothing was in flight at the decision");
    assert.ok(admitted, "a review that fits the sweep's limit is still admitted after the decision");
    h.at(3);
    h.exit();
    await waitFor(() => h.step("daemon.freshness_drain.started").length === 1, "the exit began no drain");
    gate.resolve();
    assert.equal((await h.daemon).stopReason, "stale");
    const [started] = h.step("daemon.freshness_drain.started");
    assert.equal(started?.started_at, "exit");
    assert.deepEqual(started?.predictions, []);
    const [completed] = h.step("daemon.freshness_drain.completed");
    assert.equal(completed?.deadline_source, "derived");
    assert.equal(completed?.derived_wait_ms, 0, "no work in flight at the decision, so no wait for it");
    assert.equal(completed?.drain_deadline_at, iso(h.start + h.unit), "the drain's time limit is the decision itself");
    assert.equal(completed?.admitted_after_latch, 1, "the review admitted after the decision keeps the exit's own bound");
  } finally {
    gate.resolve();
    await h.cleanup();
  }
});

test("W1-T12231 criterion 3: the time limit is never later than maxDrainWaitMs, and with no measured lengths it is today's", async (t) => {
  // A fix round takes 60 units; the one in flight is 1 unit old at the decision, so it predicts 59 units, over the 30 allowed.
  const capped = restartLanes(t, (unit) => [...reviewHistory(5 * unit, unit), ...fixHistory(60 * unit, unit)]);
  const fix = deferred<void>();
  detachSweepAction(fix.promise, { actionKind: "fix-dispatch", taskId: "W1-LONG", startedAtMs: capped.start });
  try {
    await capped.stale(1);
    const [started] = capped.step("daemon.freshness_drain.started");
    assert.equal(started?.deadline_source, "limit");
    assert.equal(started?.derived_wait_ms, 59 * capped.unit);
    assert.equal(started?.max_drain_wait_ms, 30 * capped.unit);
    assert.equal(started?.drain_deadline_at, iso(capped.start + 31 * capped.unit));
    // At 28 units 3 are left before the capped limit, so a 5-unit review is held.
    capped.at(28);
    await capped.tick();
    const hold = capped.step("daemon.admission_held").find((row) => row.kind === "review");
    assert.equal(hold?.time_left_ms, 3 * capped.unit);
  } finally {
    fix.resolve();
    await capped.cleanup();
  }

  // No measured length of any kind: today's time limit, the decision plus the sweep's 10 units.
  const blind = restartLanes(t, () => []);
  const other = deferred<void>();
  detachSweepAction(other.promise, { actionKind: "fix-dispatch", taskId: "W1-BLIND", startedAtMs: blind.start });
  try {
    await blind.stale(1);
    const [started] = blind.step("daemon.freshness_drain.started");
    assert.equal(started?.deadline_source, "no_history");
    assert.equal(started?.derived_wait_ms, 10 * blind.unit);
    assert.equal(started?.drain_deadline_at, iso(blind.start + 11 * blind.unit));
    assert.equal((started?.predictions as Prediction[])[0]?.source, "no_history");
  } finally {
    other.resolve();
    await blind.cleanup();
  }
});

test("W1-T12231 criterion 4: a likely restart holds a fix round longer than the time to it plus maxDrainWaitMs", async (t) => {
  // Stale 30 units before the start: staleness 9 plus the change's 1 is 10, at or above half of 18, below 18 itself.
  // With no further advance the pressure reaches 18 at 56 2/3 units of staleness, 26 2/3 units after the start.
  const h = restartLanes(t, (unit) => [...reviewHistory(5 * unit, unit), ...fixHistory(40 * unit, unit)],
    { staleUnits: 30, fullSweep: true, opts: { freshnessMaxDrainWaitMs: 10 * MINUTE } });
  try {
    await h.stale(1);
    const decision = h.step("daemon.freshness_decision").at(-1);
    assert.equal(decision?.action, "defer", "the restart is not decided");
    assert.equal(decision?.pressure, 10);
    const before = h.rows.length;
    h.at(2);
    await h.tick();
    const passes = h.lightAt(2);
    assert.ok(passes.length >= 1 && passes.every((pass) => pass.asked && !pass.fix), JSON.stringify(h.light));
    const hold = h.rows.slice(before).find((row) => row.step === "daemon.admission_held" && row.extra.kind === "fix-dispatch"
      && row.extra.surface === "light")?.extra;
    assert.equal(hold?.reason, "restart likely");
    assert.equal(hold?.time_to_restart_ms, 3_400_000 - 30 * MINUTE - 2 * MINUTE);
    assert.equal(hold?.measured_length_ms, 40 * MINUTE);
    assert.equal(hold?.max_drain_wait_ms, 10 * MINUTE);
    assert.equal(hold?.pressure, 10);
    const fullAt2 = h.full.filter((pass) => pass.stale && pass.at === 2);
    assert.ok(fullAt2.length >= 1, "a full pass ran while the restart was likely");
    for (const pass of fullAt2) assert.match(String(pass.hold), /restart likely/);
    assert.equal(h.step("daemon.freshness_drain.started").length, 0, "no drain began: the restart is not decided");
  } finally {
    await h.cleanup();
  }
});

test("W1-T12231 criterion 5: a review that fits is admitted, below likelyFraction admission is as today, and a build run is never held", async (t) => {
  const likely = restartLanes(t, (unit) => [...reviewHistory(5 * unit, unit), ...fixHistory(40 * unit, unit)],
    { staleUnits: 30, opts: { freshnessMaxDrainWaitMs: 10 * MINUTE } });
  try {
    await likely.stale(1);
    likely.at(2);
    await likely.tick();
    const passes = likely.lightAt(2);
    assert.ok(passes.length >= 1, "the ticker ran its light pass");
    assert.ok(passes.every((pass) => pass.asked && pass.review && pass.plan), "a 5-unit review fits before the likely restart");
    assert.ok(passes.every((pass) => pass.refill), "a build refill is never held by this rule");
    assert.equal(likely.step("daemon.admission_held").filter((row) => row.kind !== "fix-dispatch").length, 0);
    assert.ok(likely.step("daemon.admission_held").every((row) => row.kind !== "dispatch-refill"), "no hold names a build run");
  } finally {
    await likely.cleanup();
  }

  // Stale 10 units before the start: pressure 4, below half of 18. No pass is asked, and the 40-unit fix is admitted.
  const below = restartLanes(t, (unit) => [...reviewHistory(5 * unit, unit), ...fixHistory(40 * unit, unit)],
    { staleUnits: 10, opts: { freshnessMaxDrainWaitMs: 10 * MINUTE } });
  try {
    await below.stale(1);
    below.at(2);
    await below.tick();
    const passes = below.lightAt(2);
    assert.ok(passes.length >= 1, "the ticker ran its light pass");
    assert.ok(passes.every((pass) => !pass.asked && pass.fix && pass.review), JSON.stringify(below.light));
    assert.equal(below.step("daemon.admission_held").length, 0);
  } finally {
    await below.cleanup();
  }
});

test("W1-T12231 criterion 6: the time to the likely restart is never earlier than the end of the minimum lifetime", async (t) => {
  // Pure: the pressure is already at the limit, yet 50 minutes of the minimum lifetime are left.
  assert.deepEqual(timeToLikelyFreshnessRestart({ weight: 18, staleSinceMs: 0, nowMs: 10 * MINUTE,
    ageHorizonMs: 60 * MINUTE, lifetimeStartedAtMs: 0, minLifetimeMs: 60 * MINUTE }), { pressure: 21, timeToRestartMs: 50 * MINUTE });
  // Staleness alone reaches 18 at the horizon; with no minimum lifetime that is the answer.
  assert.equal(timeToLikelyFreshnessRestart({ weight: 0, staleSinceMs: 0, nowMs: 0, ageHorizonMs: 60 * MINUTE,
    lifetimeStartedAtMs: 0, minLifetimeMs: 0 }).timeToRestartMs, 60 * MINUTE);
  // The daemon's hold row carries the lifetime floor: 70 minutes of lifetime, 68 left at 2 units.
  const h = restartLanes(t, (unit) => [...reviewHistory(5 * unit, unit), ...fixHistory(90 * unit, unit)],
    { staleUnits: 30, opts: { freshnessMaxDrainWaitMs: 10 * MINUTE, freshnessMinLifetimeMs: 70 * MINUTE } });
  try {
    await h.stale(1);
    const before = h.rows.length;
    h.at(2);
    await h.tick();
    const hold = h.rows.slice(before).find((row) => row.step === "daemon.admission_held" && row.extra.kind === "fix-dispatch")?.extra;
    assert.equal(hold?.reason, "restart likely");
    assert.equal(hold?.time_to_restart_ms, 68 * MINUTE, "the lifetime's end, later than the 24 2/3 minutes staleness needs");
  } finally {
    await h.cleanup();
  }
});

test("W1-T12231 criterion 7: freshnessRestart has bounded rows likelyFraction 0.5 and maxDrainWaitMs 1800000 that drive runDaemon and the light sweep", async (t) => {
  const text = readFileSync(POLICY_PATH, "utf8");
  assert.match(text, /^ {2}likelyFraction: \{ value: 0\.5, origin: "lifted:src\/lib\/deploy-judge\.ts \(FRESHNESS_LIKELY_FRACTION\)", min: 0\.25, max: 0\.9 \}$/m);
  assert.match(text, /^ {2}maxDrainWaitMs: \{ value: 1800000, origin: "lifted:src\/lib\/deploy-judge\.ts \(FRESHNESS_MAX_DRAIN_WAIT_MS\)", min: 559000, max: 3600000 \}$/m);
  const policy = loadPolicy(POLICY_PATH);
  const rows = policy.values.freshnessRestart;
  assert.equal(rows.likelyFraction, 0.5);
  assert.equal(rows.maxDrainWaitMs, 1_800_000);
  assert.deepEqual(policy.bounds["freshnessRestart.likelyFraction"], { min: 0.25, max: 0.9 });
  assert.deepEqual(policy.bounds["freshnessRestart.maxDrainWaitMs"], { min: 559_000, max: 3_600_000 });
  const raw = () => parseYaml(text) as Record<string, Record<string, Record<string, unknown>>>;
  for (const [key, value] of [["likelyFraction", 0.24], ["likelyFraction", 0.91], ["maxDrainWaitMs", 558_999], ["maxDrainWaitMs", 3_600_001]] as const) {
    const table = raw();
    table.freshnessRestart![key] = { ...table.freshnessRestart![key]!, value };
    assert.throws(() => validatePolicy(table), (e: unknown) => e instanceof PolicyError && e.message.includes(`freshnessRestart.${key}`), `${key}=${value}`);
  }
  // The loaded rows drive the daemon, and its light pass asks the daemon's own admission: the fix round of 60 minutes
  // is longer than 24 2/3 minutes to the likely restart plus the 30-minute drain.
  const daemonOpts = freshnessRestartOpts({ ...rows, stalenessHorizonMs: 60 * MINUTE, minLifetimeMs: 0 });
  assert.equal(daemonOpts.freshnessLikelyFraction, rows.likelyFraction);
  assert.equal(daemonOpts.freshnessMaxDrainWaitMs, rows.maxDrainWaitMs);
  const h = restartLanes(t, (unit) => [...reviewHistory(5 * unit, unit), ...fixHistory(60 * unit, unit)], { staleUnits: 30,
    opts: daemonOpts });
  try {
    await h.stale(1);
    h.at(2);
    await h.tick();
    assert.ok(h.lightAt(2).length >= 1 && h.lightAt(2).every((pass) => pass.asked && !pass.fix && pass.review), JSON.stringify(h.light));
    const hold = h.step("daemon.admission_held").find((row) => row.kind === "fix-dispatch");
    assert.equal(hold?.reason, "restart likely");
    assert.equal(hold?.max_drain_wait_ms, 1_800_000);
    assert.equal(hold?.likely_pressure, 9);
  } finally {
    await h.cleanup();
  }
});
