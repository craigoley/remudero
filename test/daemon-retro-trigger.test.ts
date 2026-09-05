import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPlan, type Plan } from "../src/lib/plan.js";
import { runDaemon } from "../src/lib/daemon.js";
import { evaluateRetroTrigger, mergedSince, resolveMarkerForGather, saveMarker, type RunSummary } from "../src/lib/retro.js";
import { AutomatedRetroSubprocessError } from "../src/lib/retro-subprocess.js";
import type { RunResult } from "../src/lib/run-result.js";

// ── W1-T160: the DAEMON'S scheduling contract for the retro cadence trigger ───────
//
// `evaluateRetroTrigger`/`checkRetroIntegrity` themselves are pure (test/retro.test.ts),
// and the automated `retroCommand` integrity-gate path (marker/gh/ledger, real fs) is
// covered by test/retro-marker-atomic.test.ts. This file proves the piece those two
// don't: `runDaemon`'s OWN per-tick wiring — a fired `checkRetroTrigger` ledgers
// `retro_triggered` naming the reason, invokes `runRetroTrigger` exactly once, and a
// SECOND tick's OWN re-evaluation (not a mock returning a canned "don't fire") reflects
// whatever `runRetroTrigger` actually did to the marker on disk — so a real marker
// advance genuinely prevents an immediate re-fire, not just "the test asserted it away".
//
// `checkRetroTrigger` here is deliberately backed by the cheap ledger-only
// `mergedSince` (not production's real GitHub-union `shippedSince` wiring,
// run-task.ts's `retroTriggerCheck`) — this file's whole point is the DAEMON LOOP's
// scheduling contract, not the production merge-counting mechanism.

const YAML = `
- id: A
  title: a
  repo: remudero
  type: implement
  depends_on: []
  status: queued
`;

function fixturePlan(): Plan {
  const dir = mkdtempSync(join(tmpdir(), "daemon-retro-trigger-plan-"));
  const f = join(dir, "tasks.yaml");
  writeFileSync(f, YAML);
  return loadPlan(f);
}

test(
  "runDaemon: a fired retro trigger ledgers retro_triggered and runs the automated retro exactly once; " +
    "the marker advance it produces prevents an immediate re-fire on the very next tick",
  async () => {
    const plan = fixturePlan();
    const dir = mkdtempSync(join(tmpdir(), "daemon-retro-trigger-marker-"));
    const markerPath = join(dir, "last-retro.json");
    const now = new Date("2026-07-29T00:00:00.000Z");

    // Two fake merged runs, both between the (absent) marker and `now`.
    const fixtureRuns: RunSummary[] = [
      { runId: "R1", taskId: "T1", type: "implement", startTs: "2026-07-27T00:00:00.000Z", verdict: "merged", costUsd: 1, numTurns: 5 },
      { runId: "R2", taskId: "T2", type: "implement", startTs: "2026-07-28T00:00:00.000Z", verdict: "merged", costUsd: 1, numTurns: 5 },
    ];
    const policy = { mergesThreshold: 2, daysThreshold: 365 }; // days effectively disabled — only merges matters here

    const checkRetroTrigger = () => {
      const resolution = resolveMarkerForGather(markerPath);
      const marker = resolution.kind === "ok" ? resolution.marker : undefined;
      const mergesSinceMarker = mergedSince(fixtureRuns, marker?.ts).length;
      return evaluateRetroTrigger(mergesSinceMarker, marker?.ts, now, policy);
    };

    let runCount = 0;
    const runRetroTrigger = async () => {
      runCount++;
      // Simulate a SUCCESSFUL automated retro: advances the marker past both fixture
      // runs, exactly as retroCommand's own real saveMarker call does on success.
      saveMarker(markerPath, { ts: now.toISOString(), learnings_count: 0, runs_seen: fixtureRuns.length });
    };

    const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
    let stopChecks = 0;
    const summary = await runDaemon(plan, {
      refreshMerged: () => () => true, // everything already merged — nextRunnable is always "nothing runnable"
      runOne: async (id): Promise<RunResult> => {
        throw new Error(`runOne must never be called in this fixture (task ${id}) — the retro trigger owns every tick`);
      },
      checkStop: () => {
        stopChecks++;
        return stopChecks > 2 ? "test bound reached" : undefined;
      },
      sleep: async () => {},
      now: () => now,
      checkRetroTrigger,
      runRetroTrigger,
      log: (step, extra = {}) => lines.push({ step, extra: extra ?? {} }),
    });

    assert.equal(summary.stopReason, "stopped");
    assert.equal(
      runCount,
      1,
      "the retro ran exactly once across the two evaluated ticks — the second tick's checkRetroTrigger saw the advanced marker and did not re-fire",
    );

    const fired = lines.filter((l) => l.step === "retro_triggered");
    assert.equal(fired.length, 1, "retro_triggered must be ledgered exactly once, naming the fire");
    assert.equal(fired[0].extra.reason, "merges");
    assert.equal(fired[0].extra.merges_since_marker, 2);

    // Prove the SECOND tick's own (real, non-mocked) evaluation genuinely reflects the
    // advanced marker on disk — not just that runRetroTrigger happened to be skipped
    // for some unrelated reason.
    const secondDecision = checkRetroTrigger();
    assert.equal(secondDecision.fire, false, "post-advance, the marker's own re-derived state does not fire");
  },
);

test("runDaemon: checkRetroTrigger below both thresholds never invokes runRetroTrigger, and no retro_triggered line is ever ledgered", async () => {
  const plan = fixturePlan();
  const now = new Date("2026-07-29T00:00:00.000Z");
  const policy = { mergesThreshold: 25, daysThreshold: 7 }; // the real defaults
  let runCalls = 0;
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  let stopChecks = 0;
  const summary = await runDaemon(plan, {
    refreshMerged: () => () => true,
    runOne: async (id): Promise<RunResult> => {
      throw new Error(`runOne must never be called in this fixture (task ${id})`);
    },
    checkStop: () => {
      stopChecks++;
      return stopChecks > 1 ? "test bound reached" : undefined;
    },
    sleep: async () => {},
    now: () => now,
    checkRetroTrigger: () => evaluateRetroTrigger(3, "2026-07-28T00:00:00.000Z", now, policy), // 1 day, 3 merges — below both
    runRetroTrigger: async () => {
      runCalls++;
    },
    log: (step, extra = {}) => lines.push({ step, extra: extra ?? {} }),
  });
  assert.equal(summary.stopReason, "stopped");
  assert.equal(runCalls, 0);
  assert.equal(lines.some((l) => l.step === "retro_triggered"), false);
});

test("runDaemon: a checkRetroTrigger that THROWS is caught, logged, and never halts the loop (best-effort, same discipline as deps.sweep)", async () => {
  const plan = fixturePlan();
  let stopChecks = 0;
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const summary = await runDaemon(plan, {
    refreshMerged: () => () => true,
    runOne: async (id): Promise<RunResult> => {
      throw new Error(`runOne must never be called in this fixture (task ${id})`);
    },
    checkStop: () => {
      stopChecks++;
      return stopChecks > 1 ? "test bound reached" : undefined;
    },
    sleep: async () => {},
    checkRetroTrigger: () => {
      throw new Error("fixture: retro trigger check exploded");
    },
    log: (step, extra = {}) => lines.push({ step, extra: extra ?? {} }),
  });
  assert.equal(summary.stopReason, "stopped", "a checkRetroTrigger throw must never crash the daemon loop");
  assert.ok(lines.some((l) => l.step === "daemon.retro_trigger.check_failed"), "the failure must be logged, not swallowed silently");
});

test("runDaemon: an automated retro child exit 134 reaches run_failed and the same daemon continues to a later clean stop", async () => {
  const plan = fixturePlan();
  const now = new Date("2026-07-29T00:00:00.000Z");
  // A marker-absent evaluation with 0 merges fires on the days threshold (unbounded).
  const policy = { mergesThreshold: 25, daysThreshold: 7 };
  let stopChecks = 0;
  let runCalls = 0;
  const daemonPid = process.pid;
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const summary = await runDaemon(plan, {
    refreshMerged: () => () => true,
    runOne: async (id): Promise<RunResult> => {
      throw new Error(`runOne must never be called in this fixture (task ${id}) — the retro trigger owns every tick`);
    },
    checkStop: () => {
      stopChecks++;
      return stopChecks > 1 ? "test bound reached" : undefined;
    },
    sleep: async () => {},
    now: () => now,
    checkRetroTrigger: () => evaluateRetroTrigger(0, undefined, now, policy), // marker absent -> fires reason=days
    runRetroTrigger: async () => {
      runCalls++;
      throw new AutomatedRetroSubprocessError({ exitCode: 134, signal: null, stdoutTail: "", stderrTail: "heap OOM" });
    },
    log: (step, extra = {}) => lines.push({ step, extra: extra ?? {} }),
  });
  assert.equal(summary.stopReason, "stopped", "a runRetroTrigger throw must never crash the daemon loop");
  assert.equal(process.pid, daemonPid, "the daemon process itself survives the child failure");
  assert.ok(stopChecks > 1, "the same daemon reached a later tick before stopping cleanly");
  assert.equal(runCalls, 1, "the fired retro was invoked exactly once before it threw");
  assert.ok(
    lines.some((l) => l.step === "retro_triggered"),
    "the fire is still ledgered — the throw happens AFTER retro_triggered, inside runRetroTrigger",
  );
  assert.ok(
    lines.some((l) => l.step === "daemon.retro_trigger.run_failed"),
    "the child failure must be logged (run_failed), not swallowed silently",
  );
  assert.match(
    String(lines.find((l) => l.step === "daemon.retro_trigger.run_failed")?.extra.error),
    /exit 134/,
  );
});
