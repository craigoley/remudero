import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPlan, type Plan } from "../src/lib/plan.js";
import type { RunResult } from "../src/run-task.js";
import { runDaemon } from "../src/lib/daemon.js";
import type { MergedSet } from "../src/lib/drain.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

// W1-T2984 — AN EVENT WAKE MUST NOT DISCARD AN ALREADY-ADMITTED BATCH.
//
// The interphase review clock is stopped between selection and dispatch. It used to be stopped with
// `if (await stopInterphaseReviewClock()) continue;`, so any GitHub event wake consumed during the
// tick restarted the loop and threw away work that had already been selected and already logged as
// `attempted`. MEASURED on the fleet 2026-09-06: two consecutive ticks logged
// `dispatch.concurrent_set [W1-T2655, W1-T2673]` and `daemon.iteration` for both, then reported
// `cost: notional $0.0000` with no `run.start` and no worktree for either task. `github.wake.accepted`
// fired 77 times in five minutes, so on a busy repo the wake lands in essentially every tick.

const YAML = `
- id: A
  title: a
  repo: remudero
  type: implement
  depends_on: []
  status: queued
- id: B
  title: b
  repo: remudero
  type: implement
  depends_on: []
  status: queued
`;

function fixturePlan(): Plan {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t2984-`));
  const f = join(dir, "tasks.yaml");
  writeFileSync(f, YAML);
  return loadPlan(f);
}

const okResult = (id: string): RunResult => ({
  taskId: id, runId: id + "-run", merged: true, costUsd: 0, verdict: "merged",
});

test("W1-T2984: an event wake does not discard an admitted batch", async () => {
  const plan = fixturePlan();
  const merged = new Set<string>();
  const mergedSet: MergedSet = (id) => merged.has(id);
  const lines: Array<{ step: string }> = [];
  const dispatched: string[] = [];

  const s = await runDaemon(plan, {
    refreshMerged: () => mergedSet,
    runOne: async (id) => {
      dispatched.push(id);
      merged.add(id);
      return okResult(id);
    },
    // EVERY wait reports a wake — the busy-repo condition, where 77 wakes landed in five minutes.
    // Before this task that made the guard fire on every tick and nothing was ever dispatched.
    sleepUntilSweepWake: async () => "wake" as never,
    sleep: async () => {},
    sweepLight: async () => {},
    log: (step) => lines.push({ step }),
  }, { max: 1 });

  assert.ok(
    dispatched.length > 0,
    "runOne was actually CALLED. The defect was not a bad selection — `daemon.iteration` was logged " +
      "and `attempted` populated, then the batch was discarded before dispatch, so the fleet reported " +
      "attempted work with zero cost and no run.start.",
  );
  assert.ok(s.attempted.length > 0, "and the summary's attempted set reflects work that really ran");
});

test("W1-T2984: the deferred wake is named in the ledger", async () => {
  const plan = fixturePlan();
  const merged = new Set<string>();
  const lines: Array<{ step: string }> = [];

  await runDaemon(plan, {
    refreshMerged: () => ((id: string) => merged.has(id)) as MergedSet,
    runOne: async (id) => { merged.add(id); return okResult(id); },
    sleepUntilSweepWake: async () => "wake" as never,
    sleep: async () => {},
    sweepLight: async () => {},
    log: (step) => lines.push({ step }),
  }, { max: 1 });

  // The wake now preempts SELECTION rather than discarding an admitted batch, and it says so. A
  // silent restart is exactly how this shape stayed invisible through four rounds of fixing it.
  assert.ok(
    lines.some((l) => l.step === "daemon.dispatch.wake_deferred"),
    `expected daemon.dispatch.wake_deferred; saw: ${[...new Set(lines.map((l) => l.step))].join(", ")}`,
  );
});
