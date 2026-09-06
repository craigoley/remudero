// W1-T2960: the pre-admission freshness re-read (W1-T2845) fired UNCONDITIONALLY, and on a busy repo
// that means every tick. The reconciliation rungs above it include AUTO-MERGE, so the tick advances
// `origin/main` itself and then reads its own merge as staleness.
//
// MEASURED on the live fleet before this fix — one container's whole lifetime: 28 daemon summaries,
// 28 `attempted : (none)`, 28 `exited 75 (freshness)` restarts, ZERO admissions. Across the full
// ledger union (229 .gz archives + live, 46,510 `run.start` rows so the query sees its corpus):
// thousands of dispatches a day through 09-04, then ZERO on 09-05 and 09-06. The daemon became a
// review-and-merge service that could never build, while reporting itself perfectly healthy.
//
// WHY DEFERRING IS SAFE: `worktreeAdd` cuts every worker a fresh worktree from `origin/main` HEAD and
// `syncPlanFromOrigin` re-reads the plan there, so a lane admitted by a stale daemon still builds
// CURRENT code. Staleness spoils this process's own resident module graph, which the TOP-OF-TICK read
// already covers one tick later.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPlan, type Plan } from "../src/lib/plan.js";
import type { RunResult } from "../src/run-task.js";
import { runDaemon, type DaemonFreshness } from "../src/lib/daemon.js";
import { pauseDetail, requestPause, requestStop, stopDetail } from "../src/lib/fleet-control.js";
import type { MergedSet } from "../src/lib/drain.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const YAML = `
- id: A
  title: a
  repo: remudero
  type: implement
  depends_on: []
  status: queued
`;
function fixturePlan(): Plan {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t2960-`));
  const f = join(dir, "tasks.yaml");
  writeFileSync(f, YAML);
  return loadPlan(f);
}
const okResult = (id: string): RunResult => ({ taskId: id, runId: id + "-run", merged: true, costUsd: 0.5, verdict: "merged" });
const clock = () => ({ sleep: async (_ms: number) => {} });
const OLD = "a".repeat(40);
const NEW = "b".repeat(40);

/** Fresh at the tick's TOP boundary, stale at the PRE-ADMISSION boundary — the shape a tick that
 *  merged something itself produces, and the exact sequence that starved the live fleet. */
function staleOnlyAtAdmission(): () => DaemonFreshness {
  let n = 0;
  return () => {
    n += 1;
    return n === 1 ? { stale: false } : { stale: true, oldSha: OLD, newSha: NEW };
  };
}

test("W1-T2960: a tick that advanced main itself still admits", async () => {
  const merged = new Set<string>();
  const mergedSet: MergedSet = (id) => merged.has(id);
  const s = await runDaemon(fixturePlan(), {
    refreshMerged: () => mergedSet,
    runOne: async (id) => { merged.add(id); return okResult(id); },
    sleep: clock().sleep,
    log: () => {},
    checkFreshness: staleOnlyAtAdmission(),
  });
  // BEFORE THE FIX this was `[]`: the re-read fired between selection and admission and the loop
  // returned without ever attempting the candidate it had just chosen.
  assert.deepEqual(s.attempted, ["A"], "the already-selected batch must be admitted, not abandoned");
  assert.ok(merged.has("A"), "and it must actually run");
});

test("W1-T2960: staleness still stops the loop after admission", async () => {
  // The guard is DEFERRED, never deleted: the work goes out, then the next tick's top-of-tick read
  // stops the daemon so the restart still picks up merged code (W1-T126).
  const merged = new Set<string>();
  const mergedSet: MergedSet = (id) => merged.has(id);
  const s = await runDaemon(fixturePlan(), {
    refreshMerged: () => mergedSet,
    runOne: async (id) => { merged.add(id); return okResult(id); },
    sleep: clock().sleep,
    log: () => {},
    checkFreshness: staleOnlyAtAdmission(),
  });
  assert.equal(s.stopReason, "stale", "staleness is still honoured — one tick later, not never");
  assert.deepEqual(s.attempted, ["A"], "and it is honoured AFTER the batch went out, not instead of it");
});

test("W1-T2960: stop and pause still preempt admission", async () => {
  // The operator controls sit ABOVE this boundary and their priority is unchanged: a paused daemon
  // admits nothing regardless of what the freshness read says.
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t2960-pause-`));
  requestPause(root, "operator hold");
  let ticks = 0;
  const merged = new Set<string>();
  const s = await runDaemon(fixturePlan(), {
    refreshMerged: () => ((id: string) => merged.has(id)) as MergedSet,
    runOne: async (id) => { merged.add(id); return okResult(id); },
    sleep: clock().sleep,
    log: () => {},
    checkPause: () => pauseDetail(root),
    checkFreshness: staleOnlyAtAdmission(),
    // A paused daemon idles forever by design, so the test fires its own STOP to end the run — the
    // same bound test/daemon-freshness.test.ts's W1-T936 pause case uses.
    checkStop: () => (++ticks >= 4 ? (requestStop(root, "test done"), stopDetail(root)) : undefined),
  });
  assert.deepEqual(s.attempted, [], "a paused daemon admits nothing");
  assert.ok(!merged.has("A"), "and dispatches nothing");
});
