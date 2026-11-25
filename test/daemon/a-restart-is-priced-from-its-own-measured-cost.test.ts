// W1-T14663: the deploy judge's restart hold, score limit and staleness horizon come from the cost of the daemon's own
// recent restarts (daemon.restart_cycle rows, handed-off and cold apart), with the fixed values only as the fallback.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { runDaemon, type DaemonDeps, type DaemonFreshness, type DaemonOpts } from "#src/lib/daemon.js";
import {
  coalesceFreshnessRestart,
  decideFreshnessRestart,
  deriveRestartBounds,
  FRESHNESS_COALESCE_WINDOW_MS,
  MEASURED_RESTART_WINDOW,
  measuredRestarts,
  minimumRestartSample,
  type DeployWorthChange,
  type RestartBoundsFallback,
} from "#src/lib/deploy-judge.js";
import { loadPlan } from "#src/lib/plan.js";
import { trackInFlightReview } from "#src/lib/sweep.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { hostIndependentDaemonDeps } from "#test/helpers/daemon-host-pins.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const T0 = Date.parse("2026-11-24T00:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();
const sha = (tag: string) => tag.padEnd(40, "0");

/** origin/main's fixed values at the shipped host: 90 min floor, score 18, 60 min rate bound. */
const FALLBACK: RestartBoundsFallback = {
  minLifetimeMs: 90 * MINUTE, threshold: { value: 18, reason: "fixed" }, stalenessHorizonMs: 60 * MINUTE,
};
const change: DeployWorthChange = { sha: sha("a1"), subject: "fix: review", files: ["src/lib/review.ts"], changeClass: "reviewer" };
const loopChange: DeployWorthChange = { sha: sha("b2"), subject: "fix: loop", files: ["src/lib/daemon.ts"], changeClass: "loop" };

type Cycle = { handedOff: boolean; pauseMs: number; gapMs: number; waitMs: number; staleMs: number };
/** One `daemon.restart_cycle` ledger row, as restartCycleRow writes it. */
function cycleRow(index: number, c: Cycle): Record<string, unknown> {
  const exitMs = T0 - (100 - index) * 6 * HOUR;
  const startedMs = c.handedOff ? exitMs + 1_000 : exitMs + c.pauseMs;
  return {
    ts: iso(startedMs + c.gapMs), step: "daemon.restart_cycle", handed_off: c.handedOff,
    first_material_change_at: iso(exitMs - c.staleMs), exit_at: iso(exitMs), started_at: iso(startedMs),
    first_verdict_at: iso(startedMs + c.gapMs), verdict_gap_ms: c.gapMs, waiting_cost_ms: c.waitMs,
    ...(c.handedOff ? { yield_to_first_tick_ms: c.pauseMs } : {}),
  };
}
const many = (count: number, c: Cycle) => Array.from({ length: count }, (_, i) => cycleRow(i, c));

/** Handed-off restarts costing a few minutes: 2 min dark dispatch plus a 3 min verdict gap, against a change that waited. */
const CHEAP: Cycle = { handedOff: true, pauseMs: 2 * MINUTE, gapMs: 3 * MINUTE, waitMs: 60 * MINUTE, staleMs: 4 * HOUR };
/** Cold restarts that cost more than the waiting they end: 20 min dark dispatch plus a 25 min verdict gap. */
const COSTLY: Cycle = { handedOff: false, pauseMs: 20 * MINUTE, gapMs: 25 * MINUTE, waitMs: 30 * MINUTE, staleMs: 4 * HOUR };

const derive = (rows: Array<Record<string, unknown>>, handsOff: boolean, fallback = FALLBACK) =>
  deriveRestartBounds({ cycles: measuredRestarts(rows), handsOff, fallback });

type Logged = { step: string; extra: Record<string, unknown>; atMs: number };

/** A busy daemon (an in-flight review) on a fake clock: each sleep moves it `stepMs`, `ledger` is what its reader returns. */
async function busyDaemon(input: { changes: DeployWorthChange[]; ledger: Array<Record<string, unknown>>; handoff: boolean; opts: DaemonOpts;
  stepMs: number }): Promise<Logged[]> {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}restart-priced-`));
  const path = join(dir, "tasks.yaml");
  writeFileSync(path, "- id: A\n  title: a\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n");
  let release!: () => void;
  void trackInFlightReview(new Promise<void>((resolve) => { release = resolve; }), { taskId: "A", prNumber: 1 });
  let nowMs = T0;
  const rows: Logged[] = [];
  const lines = input.ledger.map((row) => JSON.stringify(row));
  const freshness: DaemonFreshness = { stale: true, oldSha: sha("e0"), newSha: input.changes[0]!.sha, changes: input.changes };
  try {
    const summary = await Promise.race([
      runDaemon(loadPlan(path), {
        ...hostIndependentDaemonDeps(),
        refreshMerged: () => () => true,
        runOne: async (taskId) => ({ taskId, runId: "unused", merged: true, costUsd: 0, verdict: "merged" }),
        now: () => new Date(nowMs),
        sleep: async () => { nowMs += input.stepMs; if (nowMs > T0 + 24 * HOUR) release(); },
        sweep: async () => ({}),
        checkFreshness: () => freshness,
        readLedgerLines: () => lines,
        ...(input.handoff ? { handoff: { enabled: () => true, begin: async () => undefined } } : {}),
        log: (step, extra = {}) => {
          rows.push({ step, extra, atMs: nowMs });
          if (step === "daemon.freshness_decision" && extra.action === "restart") setTimeout(release, 5);
        },
      } as DaemonDeps, { sweepWallClockBoundMs: 24 * HOUR, freshnessQuietWindowMs: 0, freshnessMinLifetimeMs: 90 * MINUTE,
        freshnessScoreLimit: 18, freshnessStalenessHorizonMs: 60 * MINUTE, ...input.opts }),
      new Promise<"timed-out">((resolve) => setTimeout(() => resolve("timed-out"), 5_000)),
    ]);
    assert.notEqual(summary, "timed-out");
  } finally {
    release();
    rmSync(dir, { recursive: true, force: true });
  }
  return rows;
}
const decisions = (rows: Logged[]) => rows.filter((row) => row.step === "daemon.freshness_decision");
const firstRestart = (rows: Logged[]) => decisions(rows).find((row) => row.extra.action === "restart");

test("W1-T14663 criterion 1: handed-off restarts costing a few minutes derive a min lifetime and rate bound far below 90 and 60 minutes, and a pending change restarts where the fixed values hold it", async () => {
  const ledger = many(5, CHEAP);
  const bounds = derive(ledger, true);
  assert.equal(bounds.source, "measured");
  // C = 2 + 3 min, W = 60 min, S = 240 min: the waiting cost passes one restart's after C * S / W = 20 min.
  assert.equal(bounds.minLifetimeMs, 20 * MINUTE);
  assert.equal(bounds.stalenessHorizonMs, 20 * MINUTE);
  assert.equal(bounds.threshold.value, 2, "18 * 5 / 60, rounded");
  assert.ok(bounds.minLifetimeMs < FALLBACK.minLifetimeMs / 4 && bounds.stalenessHorizonMs < FALLBACK.stalenessHorizonMs / 2);
  assert.equal(bounds.evidence.restart_cost_ms, 5 * MINUTE);

  // Pure: at 25 minutes of a lifetime and of staleness, the derived bounds restart and the fixed ones hold.
  const verdictAt = (b: typeof bounds) => {
    const nowMs = T0 + 25 * MINUTE;
    const decision = decideFreshnessRestart({ changes: [change], busy: true, staleSinceMs: T0, nowMs, state: { total: 0, scoredShas: [] },
      threshold: b.threshold, ageHorizonMs: b.stalenessHorizonMs });
    return coalesceFreshnessRestart({ decision, newSha: change.sha, lastAdvanceAtMs: T0, staleSinceMs: T0, nowMs,
      window: FRESHNESS_COALESCE_WINDOW_MS, threshold: b.threshold, ageHorizonMs: b.stalenessHorizonMs, lifetimeStartedAtMs: T0,
      minLifetimeMs: b.minLifetimeMs });
  };
  assert.equal(verdictAt(bounds).action, "restart");
  const fixed = verdictAt({ ...bounds, ...FALLBACK });
  assert.equal(fixed.action, "defer", "origin/main's score 18 holds the same change: pressure 8 at 25 minutes");

  // The daemon: same advance, same clock. Measured, it restarts within the half hour; without rows it waits out the floor.
  const measured = await busyDaemon({ changes: [change], ledger, handoff: true, opts: {}, stepMs: 5 * MINUTE });
  const restart = firstRestart(measured)!;
  assert.ok(restart.atMs - T0 <= 30 * MINUTE && restart.atMs - T0 >= 20 * MINUTE, `restarted at ${(restart.atMs - T0) / MINUTE} min`);
  assert.equal((restart.extra.restart_bounds as Record<string, unknown>).source, "measured");
  assert.equal(restart.extra.min_lifetime_ms, 20 * MINUTE);
  assert.equal(restart.extra.score_limit, 2);
  assert.equal(restart.extra.staleness_horizon_ms, 20 * MINUTE);
  const heldAt = decisions(measured).find((row) => row.atMs - T0 === 10 * MINUTE)!;
  assert.equal(heldAt.extra.action, "defer", "before its own measured hold it still waits");

  const fixedRun = await busyDaemon({ changes: [change], ledger: [], handoff: true, opts: {}, stepMs: 5 * MINUTE });
  assert.equal(firstRestart(fixedRun)!.atMs - T0, 90 * MINUTE, "on origin/main the fixed floor holds it");
});

test("W1-T14663 criterion 2: with fewer measured restarts than the sample the variance needs, the judge uses the fixed values and names the fallback", async () => {
  const none = derive([], true);
  assert.equal(none.source, "fallback");
  assert.equal(none.evidence.reason, "too_few_restarts");

  const two = derive(many(2, CHEAP), true);
  assert.equal(two.source, "fallback", "two points show no spread");
  assert.equal(two.minLifetimeMs, FALLBACK.minLifetimeMs);
  assert.equal(two.threshold.value, 18);
  assert.equal(two.stalenessHorizonMs, FALLBACK.stalenessHorizonMs);
  assert.equal(two.evidence.sample, 2);
  assert.equal(derive(many(3, CHEAP), true).source, "measured", "the same cycles, three of them, are enough");

  // Noisy costs need more rows: each sample is checked against 4 * cv^2, and a window can never hold more than it keeps.
  const noisy = [1, 60, 2, 90, 3].map((minutes, i) => cycleRow(i, { ...CHEAP, gapMs: minutes * MINUTE }));
  const noisyBounds = derive(noisy, true);
  assert.equal(noisyBounds.source, "fallback", "five rows of a spread this wide are not a measurement");
  assert.ok((noisyBounds.evidence.min_sample as number) > 5, "its own minimum sample is named");
  assert.ok(minimumRestartSample([5, 5, 5], [60, 60, 60]) === 3, "a steady cost needs only the floor");
  assert.ok(minimumRestartSample([1, 60, 2, 90, 3], [60, 60, 60, 60, 60]) > 5);

  // Cycles of the other kind and cycles missing a measured part are not the sample.
  assert.equal(derive(many(5, COSTLY), true).source, "fallback", "cold rows do not price a handed-off restart");
  assert.equal(derive(many(5, CHEAP), false).source, "fallback", "handed-off rows do not price a cold one");
  const unmeasured = many(5, CHEAP).map((row) => ({ ...row, verdict_gap_ms: null }));
  assert.equal(derive(unmeasured, true).source, "fallback");
  assert.equal(measuredRestarts(many(5, CHEAP).map(({ handed_off, ...row }) => (void handed_off, row))).length, 0, "a row that does not say is left out");
  assert.equal(derive(many(5, { ...CHEAP, waitMs: 0 }), true).evidence.reason, "no_cost_to_compare");

  // The window is the last MEASURED_RESTART_WINDOW rows: an old costly run does not outvote a recent cheap one.
  const aged = [...many(MEASURED_RESTART_WINDOW, { ...CHEAP, gapMs: 90 * MINUTE }),
    ...Array.from({ length: MEASURED_RESTART_WINDOW }, (_, i) => cycleRow(100 + i, CHEAP))];
  assert.equal(derive(aged, true).evidence.restart_cost_ms, 5 * MINUTE);

  // The daemon: two rows, and its decision is origin/main's, with the fallback named on the row.
  const rows = await busyDaemon({ changes: [change], ledger: many(2, CHEAP), handoff: true, opts: {}, stepMs: 5 * MINUTE });
  const restart = firstRestart(rows)!;
  assert.equal(restart.atMs - T0, 90 * MINUTE, "the fixed floor");
  const named = restart.extra.restart_bounds as Record<string, unknown>;
  assert.equal(named.source, "fallback");
  assert.equal(named.reason, "too_few_restarts");
  assert.equal(restart.extra.min_lifetime_ms, 90 * MINUTE);
  assert.equal(restart.extra.score_limit, 18);
  assert.equal(restart.extra.staleness_horizon_ms, 60 * MINUTE);
});

test("W1-T14663 criterion 3: invariant a-costly-restart-stays-rare — costly restarts raise every bound above the fixed values, so only cheaper restarts make them more frequent", async () => {
  const costly = derive(many(5, COSTLY), false);
  assert.equal(costly.source, "measured");
  // C = 45 min against W = 30 min over S = 240 min: H = 360 min, limit 18 * 45 / 30 = 27.
  assert.equal(costly.minLifetimeMs, 6 * HOUR);
  assert.equal(costly.stalenessHorizonMs, 6 * HOUR);
  assert.equal(costly.threshold.value, 27);
  assert.ok(costly.minLifetimeMs > FALLBACK.minLifetimeMs && costly.stalenessHorizonMs > FALLBACK.stalenessHorizonMs && costly.threshold.value > FALLBACK.threshold.value);

  // Whenever one restart costs at least what the waiting cost, no bound is below its fixed value; and every bound only rises with the cost.
  let previous = derive(many(5, { ...COSTLY, gapMs: MINUTE, pauseMs: MINUTE }), false);
  for (const costMinutes of [10, 20, 30, 45, 60, 90, 120, 240]) {
    const bounds = derive(many(5, { ...COSTLY, pauseMs: costMinutes * MINUTE / 2, gapMs: costMinutes * MINUTE / 2 }), false);
    assert.ok(bounds.minLifetimeMs >= previous.minLifetimeMs && bounds.threshold.value >= previous.threshold.value, `cost ${costMinutes} min`);
    if (costMinutes >= 30) {
      assert.ok(bounds.minLifetimeMs >= FALLBACK.minLifetimeMs && bounds.stalenessHorizonMs >= FALLBACK.stalenessHorizonMs && bounds.threshold.value >= FALLBACK.threshold.value, `cost ${costMinutes} min`);
    }
    previous = bounds;
  }

  // The kind is the next restart's: with the handoff on, cold history does not raise the bounds, and a cheap handed-off history is used.
  const mixed = [...many(5, COSTLY), ...many(5, CHEAP).map((row, i) => cycleRow(50 + i, CHEAP))];
  assert.equal(derive(mixed, true).minLifetimeMs, 20 * MINUTE);
  assert.equal(derive(mixed, false).minLifetimeMs, 6 * HOUR);

  // The daemon with only costly cold history keeps waiting where origin/main would already have restarted.
  const rows = await busyDaemon({ changes: [change], ledger: many(5, COSTLY), handoff: false, opts: {}, stepMs: 30 * MINUTE });
  const restart = firstRestart(rows)!;
  assert.ok(restart.atMs - T0 > 90 * MINUTE, `restarted at ${(restart.atMs - T0) / MINUTE} min`);
  assert.equal(restart.extra.min_lifetime_ms, 6 * HOUR);
  assert.equal(restart.extra.score_limit, 27);
  const early = decisions(rows).find((row) => row.atMs - T0 === 120 * MINUTE)!;
  assert.equal(early.extra.action, "defer", "the fixed floor of 90 minutes has passed, the measured one has not");
});

test("W1-T14663 criterion 4: the loop-only horizon is derived from the same cost, never below the reviewer horizon, and falls back by name; without the row there is one horizon", async () => {
  const withRow = (loopOnlyHorizonMs: number): RestartBoundsFallback => ({ ...FALLBACK, loopOnlyHorizonMs });
  const ledger = many(5, CHEAP);
  // The row is three times the staleness row, so the loop-only horizon keeps that ratio over the derived 20 minutes.
  const loop = derive(ledger, true, withRow(3 * HOUR));
  assert.equal(loop.stalenessHorizonMs, 20 * MINUTE);
  assert.equal(loop.loopOnlyHorizonMs, 60 * MINUTE);
  // A row below the staleness row never takes the loop-only horizon below the derived reviewer horizon.
  const below = derive(ledger, true, withRow(30 * MINUTE));
  assert.equal(below.loopOnlyHorizonMs, below.stalenessHorizonMs);
  for (const row of [30 * MINUTE, 60 * MINUTE, 3 * HOUR, 10 * HOUR]) {
    const bounds = derive(ledger, true, withRow(row));
    assert.ok(bounds.loopOnlyHorizonMs! >= bounds.stalenessHorizonMs, `row ${row}`);
  }
  // Too small a sample: the row's own value, and the fallback is named.
  const small = derive(many(2, CHEAP), true, withRow(3 * HOUR));
  assert.equal(small.loopOnlyHorizonMs, 3 * HOUR);
  assert.equal(small.evidence.source, "fallback");
  assert.equal(small.evidence.reason, "too_few_restarts");
  // No row: no loop-only horizon, measured or not, so the judge keeps one horizon for both classes.
  assert.equal("loopOnlyHorizonMs" in derive(ledger, true), false);
  assert.equal("loopOnlyHorizonMs" in derive([], true), false);

  // The daemon: a loop-only advance reaches the score limit at the derived loop horizon (60 min), not the reviewer's (20 min).
  const rows = await busyDaemon({ changes: [loopChange], ledger, handoff: true, opts: { freshnessLoopOnlyHorizonMs: 3 * HOUR }, stepMs: 5 * MINUTE });
  const restart = firstRestart(rows)!;
  assert.equal(restart.extra.horizon_ms, 60 * MINUTE);
  assert.equal((restart.extra.restart_bounds as Record<string, unknown>).source, "measured");
  assert.ok(restart.atMs - T0 >= 30 * MINUTE, "later than a reviewer commit's 20 minutes");
  // The same advance with no loop-only row has one horizon.
  const one = firstRestart(await busyDaemon({ changes: [loopChange], ledger, handoff: true, opts: {}, stepMs: 5 * MINUTE }))!;
  assert.equal(one.extra.horizon_ms, 20 * MINUTE);
  // And a daemon with a small sample keeps the row's value, naming the fallback.
  const fell = firstRestart(await busyDaemon({ changes: [loopChange], ledger: many(2, CHEAP), handoff: true,
    opts: { freshnessLoopOnlyHorizonMs: 3 * HOUR }, stepMs: 15 * MINUTE }))!;
  assert.equal(fell.extra.horizon_ms, 3 * HOUR);
  assert.equal((fell.extra.restart_bounds as Record<string, unknown>).source, "fallback");
});
