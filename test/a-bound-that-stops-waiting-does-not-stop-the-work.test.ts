// W1-T2582: the sweep's wall-clock bound stops AWAITING the work and never stops the WORK, so
// every sweep-borne rung whose work outlasts the bound was re-entrant.
//
// `DEFAULT_SWEEP_WALL_CLOCK_BOUND_MS` (559_000, W1-T1044) bounds `await deps.sweep()`. When it
// fires the promise is not cancelled, the spawned children are not signalled, and nothing
// downstream is told the pass is still live — so the next loop iteration begins a fresh sweep
// while the previous one is still executing.
//
// MEASURED 2026-09-01, alternating one-for-one with draft-batch starts, every abandoned row
// carrying `elapsed_ms: 559000` against `bound_ms: 559000`, three of them inside ONE `run_id`:
// 16 Architect spawns across 5 distinct proposals, $123.30, 74% of it buying nothing.
//
// THE REMEDY IS EXCLUSION, NOT CANCELLATION, and the shard is explicit that the two obvious
// alternatives are both WORSE than the defect:
//   (a) cancelling blindly would destroy a legitimate long run and could leave state mid-write;
//   (b) removing or lengthening the bound re-opens W1-T1044, the unbounded tick it exists to stop.
// So the abandoned pass runs to completion untouched and the NEXT one declines to start. Both
// falsifiers below ((3) and (4)) exist to pin those two directions shut.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadPlan, type Plan } from "../src/lib/plan.js";
import { runDaemon, type DaemonDeps } from "../src/lib/daemon.js";
import type { MergedSet } from "../src/lib/drain.js";

const NONE_MERGED: MergedSet = () => false;
const REAL_SLEEP: DaemonDeps["sleep"] = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fixturePlan(): Plan {
  const dir = mkdtempSync(join(tmpdir(), "rmd-sweep-reentry-"));
  const f = join(dir, "tasks.yaml");
  writeFileSync(
    f,
    `
- id: W1-T2582FIX
  title: a runnable task
  repo: remudero
  type: implement
  depends_on: []
  status: queued
`,
  );
  return loadPlan(f);
}

/** Drives several daemon iterations against a sweep that NEVER settles — the measured shape: the
 *  bound fires, the pass keeps running, and the loop moves on. */
async function driveWithHangingSweep(iterations: number) {
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  let sweepStarts = 0;
  await runDaemon(
    fixturePlan(),
    {
      refreshMerged: () => NONE_MERGED,
      runOne: async (id) => ({ taskId: id, runId: `${id}-run`, merged: true, costUsd: 0, verdict: "merged" }),
      sleep: REAL_SLEEP,
      sweep: () => {
        sweepStarts++;
        return new Promise<void>(() => {}); // never settles: the abandoned-but-still-running pass
      },
      log: (step, extra = {}) => lines.push({ step, extra }),
    },
    { max: iterations, pollIntervalMs: 10, sweepWallClockBoundMs: 20 },
  );
  return { lines, sweepStarts };
}

// ── (1) the defect itself ────────────────────────────────────────────────────────────────────

test("a pass whose work outlasts the bound cannot have a second copy of that same pass start against it", async () => {
  const { lines, sweepStarts } = await driveWithHangingSweep(6);

  const abandoned = lines.filter((l) => l.step === "daemon.sweep.abandoned");
  assert.ok(abandoned.length >= 1, "the bound must genuinely have fired — otherwise this test asserts nothing");
  assert.equal(
    sweepStarts,
    1,
    `the sweep body must be entered ONCE while the first pass is still executing; entered ${sweepStarts} times ` +
      `across ${abandoned.length} abandonment(s). Every re-entry the fleet observed landed in exactly this window.`,
  );
  const declined = lines.filter((l) => l.step === "daemon.sweep.skipped_concurrent");
  assert.ok(declined.length >= 1, "and a declined pass must be visible on the ledger, not silent");
});

// ── (2) the SECOND entry route, which the bound alone never covered ──────────────────────────

test("the retrigger interval is closed as a second entry route, not only the wall-clock bound", () => {
  // The retrigger fires from inside `startInFlightTicker`, on a 20-minute interval that no
  // reasonable unit test can wait out — measured, the last two pre-fix draft batches were 20m27s
  // apart, which is that interval and NOT the 559s bound. Its call site is therefore pinned at the
  // source, the same technique test/daemon.test.ts's own W1-T513 call-site census uses. What is
  // asserted is exactly what makes the route safe: it passes the SAME liveness flag, so the gate
  // inside `runGatedSweep` refuses a retriggered pass on the identical condition.
  const src = readDaemonSource();
  const retriggerCall = /runGatedSweep\(deps, pollIntervalMs, sweepRetrigger\.sweepWallClockBoundMs, log, diskHeadroomLatch, undefined, sweepRetrigger\.liveness\)/;
  assert.match(src, retriggerCall, "the retrigger's own runGatedSweep call must thread the shared liveness flag");
  // And the flag it threads must be the SAME object the top-of-iteration calls hold — a fresh one
  // per route would make each route exclude only itself, which is not exclusion at all.
  assert.match(src, /liveness: sweepLiveness,/, "SweepRetrigger must carry the daemon's own sweepLiveness, not a fresh object");
  const topOfIteration = [...src.matchAll(/runGatedSweep\([^)]*sweepLiveness\)/g)];
  assert.equal(topOfIteration.length, 2, `both top-of-iteration call sites must thread it; found ${topOfIteration.length}`);
});

function readDaemonSource(): string {
  return readFileSync(join(import.meta.dirname, "..", "src", "lib", "daemon.ts"), "utf8");
}

// ── (3) the dangerous direction (a): never terminate progressing work ────────────────────────

test("work that is still progressing is never terminated by the bound firing", async () => {
  let settled = false;
  // Held so the assertion can await the REAL completion rather than racing the daemon's own
  // shutdown — the first draft asserted `settled` immediately after `runDaemon` returned and read
  // false simply because the loop finished first. That would have been a false failure about
  // cancellation, which is the exact claim this test exists to make honestly.
  let sweepPromise: Promise<void> | undefined;
  let releaseSweep: (() => void) | undefined;
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  await runDaemon(
    fixturePlan(),
    {
      refreshMerged: () => NONE_MERGED,
      runOne: async (id) => ({ taskId: id, runId: `${id}-run`, merged: true, costUsd: 0, verdict: "merged" }),
      sleep: REAL_SLEEP,
      sweep: () => {
        sweepPromise = new Promise<void>((resolve) => {
          // Outlasts the bound, then finishes normally — a legitimate long run.
          releaseSweep = () => {
            settled = true;
            resolve();
          };
        });
        return sweepPromise;
      },
      log: (step, extra = {}) => lines.push({ step, extra }),
    },
    { max: 4, pollIntervalMs: 10, sweepWallClockBoundMs: 20 },
  );
  assert.ok(lines.some((l) => l.step === "daemon.sweep.abandoned"), "the bound fired on it");
  assert.equal(settled, false, "still un-settled at this point: the bound abandoned the await, so the daemon moved on");
  // Nothing cancelled it — it is still there to be finished, which is the whole claim.
  releaseSweep!();
  await sweepPromise!;
  assert.equal(settled, true, "the abandoned pass ran to its own completion — it was excluded, never cancelled");
  assert.equal(
    lines.some((l) => l.step === "daemon.sweep.failed"),
    false,
    "and finishing after abandonment is not an error — a legitimate long run must not be reported as a failure",
  );
});

test("once the abandoned pass settles, the NEXT pass runs — exclusion is not a permanent stop", async () => {
  let starts = 0;
  await runDaemon(
    fixturePlan(),
    {
      refreshMerged: () => NONE_MERGED,
      // Each iteration must take LONGER than the sweep's settle delay, or the whole run finishes
      // inside one live window and every later pass is declined for a reason that has nothing to do
      // with the gate re-opening. A first draft dispatched instantly and read starts===1 — correct
      // behaviour, wrong test.
      runOne: async (id) => {
        await new Promise((r) => setTimeout(r, 30));
        return { taskId: id, runId: `${id}-run`, merged: true, costUsd: 0, verdict: "merged" };
      },
      sleep: REAL_SLEEP,
      // Each pass outlasts the bound but DOES settle shortly after, so a later iteration must be
      // allowed in. The poll interval is deliberately longer than the settle delay so the gate has
      // genuinely re-opened by the next iteration — otherwise a pass declined for being live would
      // be indistinguishable from a gate that never re-opens.
      sweep: () => {
        starts++;
        return new Promise<void>((resolve) => setTimeout(resolve, 20));
      },
      log: () => {},
    },
    { max: 8, pollIntervalMs: 40, sweepWallClockBoundMs: 10 },
  );
  assert.ok(starts >= 2, `a settled pass must release the gate; the sweep body ran ${starts} time(s) across 8 iterations`);
});

// ── (4) the dangerous direction (b): the bound must keep bounding ────────────────────────────

test("the bound still bounds, so the unbounded tick it was introduced to prevent cannot return", async () => {
  // W1-T1044's own property: control returns to the loop rather than hanging on a sweep that
  // never settles. If the gate had been built by lengthening or removing the bound, this fails.
  const { lines } = await driveWithHangingSweep(3);
  const abandoned = lines.filter((l) => l.step === "daemon.sweep.abandoned");
  assert.ok(abandoned.length >= 1, "the bound must still fire against a never-settling sweep");
  assert.equal(abandoned[0].extra.bound_ms, 20, "and still report the bound that fired it");
  assert.ok((abandoned[0].extra.elapsed_ms as number) >= 15, "elapsed_ms still reflects the real wait");
});
