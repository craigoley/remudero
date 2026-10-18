/**
 * W1-T9808 — A LATCHED RESTART ADMITS NO WORK ITS DRAIN WOULD ABANDON.
 *
 * 2026-10-15: fixes for W1-T9113 and W1-T7699 started at 19:02 inside the drain of the 18:29:00 latch and were
 * abandoned at its bound, and reviews for #12123 and #12124 were admitted late in the 20:08 episode. W1-T8172 gated
 * only the drain's own review clock, once per pass. Each daemon fixture here runs one lane through a latch with a fake
 * clock: the latch is at 1 min and the drain's bound is 10 min, so the drain has until 11 min.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as flush } from "node:timers/promises";
import { test, type TestContext } from "node:test";

import * as daemonModule from "../src/lib/daemon.js";
import { runDaemon, type DaemonDeps, type LightPassScope, type ReviewAdmissionGate } from "../src/lib/daemon.js";
import { loadPlan } from "../src/lib/plan.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import {
  DEFAULT_SWEEP_POLICY, detachedSweepActionCount, drainDetachedSweepActions, drainInFlightReviews, inFlightReviewCount,
  runSweepLightPass, type OpenPrView, type SweepDeps,
} from "./helpers/sweep-test.js";

type RunResult = Awaited<ReturnType<DaemonDeps["runOne"]>>;

const minute = 60_000;
const BOUND_MS = 10 * minute;
const OLD_SHA = "a".repeat(40);
const NEW_SHA = "b".repeat(40);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

/** `fix.dispatch` → `fix.done` rounds, each `lengthMs` from the round's start (the dispatch less its spawn). */
function fixHistory(lengthMs: number, rounds = 3): string[] {
  const end = Date.now() - minute;
  return Array.from({ length: rounds }, (_, i) => [
    JSON.stringify({ ts: new Date(end - minute - i).toISOString(), step: "fix.dispatch", round_id: `r${i}`, elapsed_ms: lengthMs - minute }),
    JSON.stringify({ ts: new Date(end - i).toISOString(), step: "fix.done", round_id: `r${i}` }),
  ]).flat();
}

/** `sweep.review_started` → `review.posted` pairs, each `lengthMs` long. */
function reviewHistory(lengthMs: number, pairs = 3): string[] {
  const end = Date.now() - minute;
  return Array.from({ length: pairs }, (_, i) => [
    JSON.stringify({ ts: new Date(end - lengthMs - i).toISOString(), step: "sweep.review_started", pr_number: 900 + i }),
    JSON.stringify({ ts: new Date(end - i).toISOString(), step: "review.posted", pr_url: `https://github.com/acme/remudero/pull/${900 + i}` }),
  ]).flat();
}

interface Row { step: string; extra: Record<string, unknown> }
interface LightPass { scope: LightPassScope | undefined; latched: boolean; atMin: number; fix: boolean; review: boolean }
interface FullPass { latched: boolean; hold: string | undefined; review: boolean }

/** One lane (task A) runs; `latch()` makes the tree stale so the dispatch tick latches the restart. The fake light
 *  pass dispatches a fix and admits a review unless the scope's predicate refuses; the fake full pass does the same
 *  through its gate. */
function latchedLane(t: TestContext, ledger: readonly string[], opts: { fullSweep?: boolean } = {}) {
  assert.equal(inFlightReviewCount(), 0, "precondition: no review leaked from another test");
  assert.equal(detachedSweepActionCount(), 0, "precondition: no detached action leaked from another test");
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t9808-`));
  const planPath = join(dir, "tasks.yaml");
  writeFileSync(planPath, "- id: A\n  title: a\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n  files: [src/A.ts]\n");
  const start = Date.now();
  let nowMs = start;
  t.mock.method(Date, "now", () => nowMs);
  const rows: Row[] = [];
  const light: LightPass[] = [];
  const full: FullPass[] = [];
  const lane = deferred<RunResult>();
  const sleeps: Array<ReturnType<typeof deferred<void>>> = [];
  let stale = false;
  let exiting = false;
  let laneStarted = false;
  const material = { stale: true as const, oldSha: OLD_SHA, newSha: NEW_SHA, staleSinceMs: start - 120 * minute,
    changes: [{ sha: NEW_SHA, subject: "fix: update worker", files: ["src/lib/worker.ts"] }] };
  const daemon = runDaemon(loadPlan(planPath), {
    now: () => new Date(nowMs),
    readLedgerLines: () => ledger,
    refreshMerged: () => (id) => id === "A" && exiting,
    checkFreshness: () => stale ? material : { stale: false },
    log: (step, extra = {}) => rows.push({ step, extra }),
    runOne: () => { laneStarted = true; return lane.promise; },
    sleep: () => { const sleep = deferred<void>(); sleeps.push(sleep); return sleep.promise; },
    sleepUntilSweepWake: async () => {
      if (exiting) { await flush(); return "wake"; }
      const sleep = deferred<void>();
      sleeps.push(sleep);
      await sleep.promise;
      return "timeout";
    },
    sweepLight: async (scope?: LightPassScope) => {
      light.push({ scope, latched: stale, atMin: (nowMs - start) / minute,
        fix: !scope?.reviewOnly && scope?.admit?.("fix-dispatch", "light") !== false,
        review: scope?.admit?.("review", "light") !== false });
    },
    ...(opts.fullSweep ? {
      sweep: async (gate?: ReviewAdmissionGate) => {
        full.push({ latched: stale, hold: gate?.workerAdmissionHold?.(), review: gate?.() ?? true });
      },
    } : {}),
  } as DaemonDeps, { freshnessMinLifetimeMs: 0, laneCount: 1, max: 1, sweepWallClockBoundMs: BOUND_MS, sweepRetriggerIntervalMs: minute });
  const at = (ageMinutes: number) => { nowMs = start + ageMinutes * minute; };
  const tick = async (rounds = 2) => {
    for (let wait = 0; wait < 20 && !laneStarted; wait++) {
      for (const sleep of sleeps.splice(0)) sleep.resolve();
      for (let i = 0; i < 50; i++) await flush();
    }
    assert.ok(laneStarted, "the lane never started");
    for (let round = 0; round < rounds; round++) {
      for (const sleep of sleeps.splice(0)) sleep.resolve();
      for (let i = 0; i < 50; i++) await flush();
    }
  };
  return {
    daemon, rows, light, full, at, tick,
    held: () => rows.filter((row) => row.step === "daemon.admission_held").map((row) => row.extra),
    latch: async (ageMinutes: number) => {
      at(ageMinutes);
      stale = true;
      await tick();
    },
    cleanup: async () => {
      exiting = true;
      lane.resolve({ taskId: "A", runId: "A-run", merged: true, verdict: "merged", costUsd: 0 });
      for (const sleep of sleeps) sleep.resolve();
      await daemon;
      await drainDetachedSweepActions();
      rmSync(dir, { recursive: true, force: true });
      t.mock.restoreAll();
    },
  };
}

test("W1-T9808: after the latch a light pass dispatches no fix its drain would abandon", async (t) => {
  // A fix round measured at 15 min cannot finish in the 10 min the drain has left at the latch.
  const long = latchedLane(t, fixHistory(15 * minute));
  try {
    await long.latch(1);
    const after = long.light.filter((pass) => pass.latched);
    assert.ok(after.length >= 1, "the ticker ran its light pass after the latch");
    assert.ok(after.every((pass) => pass.scope?.reviewOnly !== true), "the ordinary pass stays ordinary");
    assert.deepEqual(after.filter((pass) => pass.fix), [], "no fix was dispatched that the drain would abandon");
    const [hold] = long.held();
    assert.equal(hold?.surface, "light");
    assert.equal(hold?.kind, "fix-dispatch");
    assert.equal(hold?.reason, "restart latched");
    assert.equal(hold?.time_left_ms, 10 * minute);
    assert.equal(hold?.measured_length_ms, 15 * minute);
  } finally {
    await long.cleanup();
  }
  // A 3-min round fits the same drain, so the same pass dispatches it.
  const short = latchedLane(t, fixHistory(3 * minute));
  try {
    await short.latch(1);
    const after = short.light.filter((pass) => pass.latched);
    assert.ok(after.length >= 1 && after.every((pass) => pass.fix), JSON.stringify(after));
    assert.deepEqual(short.held(), []);
  } finally {
    await short.cleanup();
  }
  // The production hook closes its fix lanes on that predicate (`lightPassFixAdmitted`), asked on the light surface.
  const asked: string[] = [];
  const admitted = (answer: boolean, reviewOnly = false) => daemonModule.lightPassFixAdmitted?.({ reviewOnly,
    admit: (kind, surface) => { asked.push(`${kind}:${surface}`); return answer; } });
  assert.equal(admitted(false), false, "a refused fix closes the light pass's fix lanes");
  assert.deepEqual(asked, ["fix-dispatch:light"]);
  assert.equal(admitted(true), true);
  assert.equal(admitted(true, true), false, "a review-only pass never opens them");
  assert.equal(daemonModule.lightPassFixAdmitted?.(undefined), true, "with no scope the ordinary pass is unchanged");
});

test("W1-T9808: after the latch a full-sweep retrigger dispatches no fix its drain would abandon", async (t) => {
  // Fixes are measured at 15 min, reviews at 3 min: the retrigger holds the fix and still admits the review.
  const h = latchedLane(t, [...fixHistory(15 * minute), ...reviewHistory(3 * minute)], { fullSweep: true });
  try {
    await h.tick();
    await h.latch(1);
    const after = h.full.filter((pass) => pass.latched);
    assert.ok(after.length >= 1, "the full-sweep retrigger ran after the latch");
    for (const pass of after) {
      assert.match(String(pass.hold), /restart latched/, "the pass's worker admission hold names the latch");
      assert.equal(pass.review, true, "a 3-min review fits the drain");
    }
    const hold = h.held().find((row) => row.surface === "full-sweep");
    assert.equal(hold?.kind, "fix-dispatch");
    assert.equal(hold?.reason, "restart latched");
    assert.ok(h.full.filter((pass) => !pass.latched).every((pass) => pass.hold === undefined), "before the latch nothing is held");
  } finally {
    await h.cleanup();
  }
});

test("W1-T9808: a light pass and its refills admit a review only while it fits the drain", async (t) => {
  // The daemon's predicate is read per admission: a 5-min review fits at 1 min (10 left), not at 7 (4 left).
  const h = latchedLane(t, reviewHistory(5 * minute));
  try {
    await h.latch(1);
    assert.ok(h.light.some((pass) => pass.latched && pass.review), "a review that fits is admitted");
    h.at(7);
    await h.tick();
    const late = h.light.filter((pass) => pass.latched && pass.atMin === 7);
    assert.ok(late.length >= 1 && late.every((pass) => !pass.review), JSON.stringify(h.light));
    const hold = h.held().find((row) => row.kind === "review");
    assert.equal(hold?.surface, "light");
    assert.equal(hold?.time_left_ms, 4 * minute);
  } finally {
    await h.cleanup();
  }
  // The light pass asks it for each selected review, and again for each refill.
  const sweep = lightPassHarness();
  const answers = [true, false];
  sweep.deps.restartAdmission = (kind, surface) => {
    sweep.asked.push(`${kind}:${surface}`);
    return answers.shift() ?? false;
  };
  try {
    await runSweepLightPass([pr(1), pr(2), pr(3)], sweep.deps, twoLanes);
    await eventually(() => sweep.started.length === 1, "the first review did not start");
    assert.deepEqual(sweep.started, [1], "the second review would outlast the drain");
    const disposed = sweep.rows.find((row) => row.step === "sweep.disposed" && row.pr_number === 2);
    assert.match(String(disposed?.stand_down_reason ?? disposed?.reason), /restart latched/);
    sweep.hold(1).resolve();
    for (let i = 0; i < 20; i++) await flush();
    assert.deepEqual(sweep.started, [1], "a freed lane refills nothing the drain would abandon");
    assert.deepEqual(sweep.asked, ["review:light", "review:light", "review:light-refill"]);
  } finally {
    await sweep.finish();
  }
  // An exit's drain closed refills; a pass while the latch holds does not reopen them.
  const reopened = lightPassHarness();
  try {
    await drainInFlightReviews({ boundMs: 0 });
    reopened.deps.restartAdmission = () => true;
    await runSweepLightPass([pr(4), pr(5), pr(6)], reopened.deps, twoLanes);
    await eventually(() => reopened.started.length === 2, "two reviews did not start");
    reopened.hold(4).resolve();
    for (let i = 0; i < 20; i++) await flush();
    assert.equal(reopened.started.includes(6), false, "the latched pass reopened the refills the drain closed");
  } finally {
    await reopened.finish();
  }
});

test("W1-T9808: with no latch or no history admission is unchanged", async (t) => {
  const h = latchedLane(t, [], { fullSweep: true });
  try {
    await h.tick();
    const before = h.light.filter((pass) => !pass.latched);
    assert.ok(before.length >= 1 && before.every((pass) => pass.scope === undefined), "with no latch the pass carries no scope");
    await h.latch(1);
    const after = h.light.filter((pass) => pass.latched);
    assert.ok(after.length >= 1, "the ticker ran its light pass after the latch");
    assert.ok(after.every((pass) => typeof pass.scope?.admit === "function"), "after the latch the pass carries the predicate");
    assert.ok(after.every((pass) => pass.fix && pass.review), "with no history the predicate admits as today");
    assert.ok(h.full.length >= 1 && h.full.every((pass) => pass.hold === undefined && pass.review));
    assert.deepEqual(h.held(), []);
  } finally {
    await h.cleanup();
  }
  // A light pass with no predicate refills as it always has.
  const sweep = lightPassHarness();
  try {
    await runSweepLightPass([pr(7), pr(8), pr(9)], sweep.deps, twoLanes);
    await eventually(() => sweep.started.length === 2, "two reviews did not start");
    sweep.hold(7).resolve();
    await eventually(() => sweep.started.includes(9), "the freed lane did not refill");
  } finally {
    await sweep.finish();
  }
});

test("W1-T9808: a fix round runs from its start to its own fix.done", () => {
  const ts = (min: number) => new Date(Date.UTC(2026, 9, 15, 19, min)).toISOString();
  assert.equal(daemonModule.medianFixRoundMs([
    JSON.stringify({ ts: ts(4), step: "fix.dispatch", round_id: "a", elapsed_ms: 4 * minute }),
    JSON.stringify({ ts: ts(5), step: "fix.dispatch", round_id: "b" }),
    "{torn",
    JSON.stringify({ ts: ts(6), step: "fix.done", round_id: "a" }),
    JSON.stringify({ ts: ts(9), step: "fix.done", round_id: "b" }),
    JSON.stringify({ ts: ts(10), step: "fix.done", round_id: "c" }),
    JSON.stringify({ ts: ts(11), step: "fix.done" }),
  ]), (6 * minute + 4 * minute) / 2);
  assert.equal(daemonModule.medianFixRoundMs([]), undefined);
});

// ── the light pass ─────────────────────────────────────────────────────────────────────────────────

const NOW = Date.now();
const twoLanes = { ...DEFAULT_SWEEP_POLICY, reviewLanes: 2, reviewLaneMin: 1, reviewLaneMax: 2 };

function pr(n: number): OpenPrView {
  return {
    prNumber: n, prUrl: `https://github.com/o/r/pull/${n}`, taskId: `W1-T${n}`,
    headSha: `head-${n}`, reviewState: "none", checksState: "green",
    unmetCriteria: [], priorStrikes: 0, autoMergeArmed: false,
    lastActivityAt: new Date(NOW - minute * n).toISOString(),
    createdAt: new Date(NOW - minute * (10 - n)).toISOString(),
  };
}

async function eventually(predicate: () => boolean, message: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await flush();
  }
  assert.fail(message);
}

function lightPassHarness() {
  const holds = new Map<number, ReturnType<typeof deferred<void>>>();
  const hold = (n: number) => { if (!holds.has(n)) holds.set(n, deferred<void>()); return holds.get(n)!; };
  const started: number[] = [];
  const asked: string[] = [];
  const rows: Record<string, unknown>[] = [];
  const deps: SweepDeps = {
    ledgerPath: "/unused", runId: "t9808", now: () => NOW,
    readLedger: () => [], appendLine: (_path, row) => { rows.push(row as Record<string, unknown>); },
    readActiveWorkerCount: () => 0,
    arm: () => {}, close: () => {}, dispatchFix: () => {}, escalate: () => {},
    postReview: async (p) => {
      started.push(p.prNumber);
      await hold(p.prNumber).promise;
    },
  };
  const finish = async () => {
    for (const n of [...holds.keys(), ...started]) hold(n).resolve();
    await drainInFlightReviews({ boundMs: 1000 });
  };
  return { deps, hold, started, asked, rows, finish };
}
