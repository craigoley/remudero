/**
 * W1-T9563 — the full pass's wall-clock bound is learned from passes that SETTLED, and an abandon no
 * longer closes the pass's review pool. On 2026-10-14 12-24Z full passes completed in 6.6-35.3 min
 * (p50 16.6) against a fixed 559 s bound derived from 111.8 s passes: 21 healthy passes were abandoned
 * and each one closed its own review admissions. The daemon-level tests below scale minutes to
 * milliseconds (a 20 ms cold-start bound stands in for 559 s, 110-350 ms settled passes for 11-35 min)
 * so they run in real time; the learner test reads the measured minutes directly.
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import * as daemon from "../src/lib/daemon.js";
import { runDaemon, type DaemonDeps } from "../src/lib/daemon.js";
import { loadPlan, type Plan } from "../src/lib/plan.js";

// A namespace import, so the file still loads where the learner is absent and each test reddens on its own.
const { SWEEP_BOUND_MIN_SAMPLES, SWEEP_BOUND_WINDOW, learnedSweepBound, recordSettledSweep, settledSweepDurations } = daemon;

const REAL_SLEEP: DaemonDeps["sleep"] = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const MIN = 60_000;

function fixturePlan(): Plan {
  const root = mkdtempSync(join(tmpdir(), "rmd-t9563-plan-"));
  const path = join(root, "tasks.yaml");
  writeFileSync(path, `
- id: W1-T9563FIX
  title: learn the full-sweep bound
  repo: remudero
  type: implement
  depends_on: []
  status: queued
`);
  return loadPlan(path);
}

type Line = { step: string; extra: Record<string, unknown> };

/** One cycle, then a stale exit: the shape test/daemon.test.ts's sweep-bound tests use. */
function staleOnceDeps(lines: Line[], sweep: DaemonDeps["sweep"], over: Partial<DaemonDeps> = {}): DaemonDeps {
  return {
    refreshMerged: () => () => false,
    runOne: async (id) => ({ taskId: id, runId: id + "-run", merged: true, costUsd: 0, verdict: "merged" }),
    checkFreshness: () => ({ stale: true, oldSha: "aaaaaaa1111111111111111111111111111111", newSha: "bbbbbbb2222222222222222222222222222222" }),
    sweep,
    sleep: REAL_SLEEP,
    log: (step, extra = {}) => lines.push({ step, extra }),
    ...over,
  };
}

function settledRow(elapsedMs: number, i: number): string {
  return JSON.stringify({ ts: new Date(Date.now() - (20 - i) * MIN).toISOString(), step: "daemon.sweep.settled", elapsed_ms: elapsedMs, abandoned: false });
}

test("W1-T9563: the next full pass is bounded by an upper quantile of the passes that settled", async () => {
  // 10 seeded settled passes of 110-350 ms (the shard's 11-35 min), a pass that takes 200 ms (its 20 min), and a
  // 20 ms cold-start policy value (its 559 s). At base the pass is abandoned at 20 ms.
  const seeded = Array.from({ length: 10 }, (_, i) => Math.round(110 + (240 * i) / 9));
  const lines: Line[] = [];
  const summary = await runDaemon(
    fixturePlan(),
    staleOnceDeps(lines, () => new Promise<void>((resolve) => setTimeout(resolve, 200)), {
      readLedgerLines: () => [
        ...seeded.map(settledRow),
        "{\"step\":\"daemon.sweep.settled\",\"elapsed_ms\":", // torn: measures nothing
        JSON.stringify({ step: "daemon.sweep.abandoned", elapsed_ms: 999_999 }), // not a settled pass
      ],
    }),
    { pollIntervalMs: 30, sweepWallClockBoundMs: 20 },
  );
  assert.equal(summary.stopReason, "stale");
  const steps = lines.map((l) => l.step);
  assert.equal(steps.includes("daemon.sweep.abandoned"), false, `a pass inside its learned bound is not abandoned: ${steps.join(", ")}`);
  const started = lines.find((l) => l.step === "daemon.sweep.started");
  assert.ok(started, `the pass logs the bound it was given: ${steps.join(", ")}`);
  const p90 = [...seeded].sort((a, b) => a - b)[Math.ceil(0.9 * seeded.length) - 1];
  assert.deepEqual(started!.extra, { bound_ms: p90 * 3, bound_basis: "observed_passes", samples: 10 });
  const settled = lines.find((l) => l.step === "daemon.sweep.settled");
  assert.ok(settled, "a pass that settles writes its own duration row");
  assert.equal(settled!.extra.abandoned, false);
  assert.equal(settled!.extra.bound_basis, "observed_passes");
  assert.ok(Number(settled!.extra.elapsed_ms) >= 190, `elapsed_ms is measured from the pass's own start: ${settled!.extra.elapsed_ms}`);
});

test("W1-T9563: at 10-14 12-24Z's measured sample the learned bound clears the slowest settled pass and stays under the shortest hang", () => {
  // n=20, min 6.6 / p50 16.6 / p90 33.7 / max 35.3 min — the shard's measured window.
  const minutes = [6.6, 8.1, 9.4, 10.2, 11.0, 12.3, 13.5, 14.8, 15.9, 16.6, 17.4, 19.0, 21.2, 23.5, 25.9, 28.4, 30.1, 32.2, 33.7, 35.3];
  const learner = { fallbackMs: 559_000, settledMs: [] as number[] };
  for (const m of minutes) recordSettledSweep(learner, m * MIN);
  const bound = learnedSweepBound(learner);
  assert.equal(bound.basis, "observed_passes");
  assert.equal(bound.samples, 20);
  assert.ok(bound.boundMs >= 2 * 33.7 * MIN, `far above the 33.7 min p90: ${bound.boundMs / MIN} min`);
  assert.ok(bound.boundMs > 35.3 * MIN, "above the slowest pass that settled");
  assert.ok(bound.boundMs < 165.5 * MIN, `below the shortest confirmed hang: ${bound.boundMs / MIN} min`);
  assert.ok(bound.boundMs > 900_000, "never clamped to the policy row's 15 min max");
});

test("W1-T9563: below the learner's sample floor the policy value is the bound, and the window keeps the newest passes", () => {
  const learner = { fallbackMs: 559_000, settledMs: [] as number[] };
  for (let i = 0; i < SWEEP_BOUND_MIN_SAMPLES - 1; i++) recordSettledSweep(learner, 30 * MIN);
  recordSettledSweep(learner, 0); // a non-positive duration measures nothing
  recordSettledSweep(learner, Number.NaN);
  assert.deepEqual(learnedSweepBound(learner), { boundMs: 559_000, basis: "no_history_fallback", samples: SWEEP_BOUND_MIN_SAMPLES - 1 });
  for (let i = 0; i < SWEEP_BOUND_WINDOW; i++) recordSettledSweep(learner, 10 * MIN);
  assert.equal(learner.settledMs.length, SWEEP_BOUND_WINDOW);
  assert.equal(learnedSweepBound(learner).boundMs, 30 * MIN, "older 30 min passes fell out of the window; p90 of 10 min x 3");
  assert.deepEqual(settledSweepDurations([settledRow(1234, 0), "not json \"daemon.sweep.settled\"", settledRow(-5, 1)]), [1234]);
});

test("W1-T9563: a cold start bounds the pass by the policy value and every abandon row names its basis", async () => {
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  const lines: Line[] = [];
  await runDaemon(fixturePlan(), staleOnceDeps(lines, async () => { await held; }), { pollIntervalMs: 30, sweepWallClockBoundMs: 20 });
  const abandoned = lines.find((l) => l.step === "daemon.sweep.abandoned");
  assert.ok(abandoned, `expected daemon.sweep.abandoned, saw: ${lines.map((l) => l.step).join(", ")}`);
  assert.equal(abandoned!.extra.bound_ms, 20);
  assert.equal(abandoned!.extra.bound_basis, "no_history_fallback");
  assert.equal(abandoned!.extra.samples, 0);
  release();
});

test("W1-T9563: an abandoned full pass still admits reviews under the process-wide review bound", async () => {
  let gate: (() => boolean) | undefined;
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  let stop: string | undefined;
  let pause: string | undefined;
  const lines: Line[] = [];
  const summary = await runDaemon(
    fixturePlan(),
    staleOnceDeps(lines, async (continueReviewAdmissions) => {
      gate = continueReviewAdmissions;
      await held;
    }, { checkStop: () => stop, checkPause: () => pause }),
    { pollIntervalMs: 30, sweepWallClockBoundMs: 20 },
  );
  assert.equal(summary.stopReason, "stale");
  assert.ok(lines.some((l) => l.step === "daemon.sweep.abandoned"), "the cold-start bound abandoned the await");
  assert.ok(gate, "runGatedSweep hands the continuation gate to the pass");
  assert.equal(gate!(), true, "the abandon leaves the still-running pass's review pool open");
  stop = "STOP requested";
  assert.equal(gate!(), false, "STOP still closes the gate");
  stop = undefined;
  pause = "PAUSE requested";
  assert.equal(gate!(), false, "PAUSE still closes the gate");
  pause = undefined;
  assert.equal(gate!(), true);
  release();
  await new Promise<void>((resolve) => setTimeout(resolve, 10));
  const settled = lines.find((l) => l.step === "daemon.sweep.settled");
  assert.ok(settled, "a pass that settles after its bound still writes its duration, the healthy-slow sample");
  assert.equal(settled!.extra.abandoned, true);
  assert.equal(settled!.extra.bound_basis, "no_history_fallback");
});
