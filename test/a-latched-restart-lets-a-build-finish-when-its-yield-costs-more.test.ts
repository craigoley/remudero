// test/a-latched-restart-lets-a-build-finish-when-its-yield-costs-more.test.ts — W1-T8927, repointed by W1-T9089 (ADR 0007 A.10).
//
// W1-T8927 let a latched restart hold a build out when yielding it would cost more than finishing it. The latch, its
// holdouts and its yield requests are gone: a decided restart never asks a run to yield, so a run still inside the
// daemon's own process simply finishes, and the daemon exits once it has.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { after, test } from "node:test";

import { runDaemon } from "#src/lib/daemon.js";
import { loadPlan } from "#src/lib/plan.js";
import type { RunResult } from "#src/lib/run-result.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

const scratch: string[] = [];
after(() => { for (const dir of scratch) rmSync(dir, { recursive: true, force: true }); });

const RETIRED_ROWS = ["daemon.restart_holdout", "daemon.restart_yield_asked", "daemon.freshness_restart_waiting", "daemon.restart_latch_cost"];

test("W1-T9089: a decided restart lets an in-process build finish and asks it to yield nothing", async () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t9089-finish-`));
  scratch.push(root);
  const path = join(root, "tasks.yaml");
  writeFileSync(path, `- id: A\n  title: A\n  repo: remudero\n  type: implement\n  verify: auto\n  depends_on: []\n  status: queued\n  files: [src/A.ts]\n`);
  const rows: Array<Record<string, unknown>> = [];
  const offered: Array<Record<string, unknown>> = [];
  let release!: (value: RunResult) => void;
  const build = new Promise<RunResult>((done) => { release = done; });
  let now = Date.now();
  let stale = false;
  let stop = false;
  const run = runDaemon(loadPlan(path), {
    refreshMerged: () => () => false,
    checkStop: () => stop ? "cleanup" : undefined,
    checkFreshness: () => stale ? { stale: true, oldSha: "a".repeat(40), newSha: "b".repeat(40), installNeeded: false,
      changes: [{ sha: "b".repeat(40), subject: "fix(daemon): reload the dispatch loop", files: ["src/lib/daemon.ts"] }] } : { stale: false },
    now: () => new Date(now),
    sleep: async () => { now += 3_600_000; await delay(1); },
    runOne: (_id, options) => { offered.push({ ...options }); return build; },
    log: (step, extra) => { rows.push({ step, ...extra }); },
  }, { laneCount: 2, pollIntervalMs: 5 });
  try {
    for (let i = 0; i < 1000 && offered.length < 1; i++) await delay(2);
    assert.equal(offered.length, 1, "the build started");
    stale = true;
    for (let i = 0; i < 1000 && !rows.some((r) => r.step === "daemon.freshness_decision" && r.action === "restart"); i++) await delay(2);
    assert.equal(rows.some((r) => r.step === "daemon.freshness_decision" && r.action === "restart"), true, "the restart was decided");
    await delay(60);
    assert.equal(rows.some((r) => r.step === "daemon.freshness_exit"), false,"the daemon waits for the build rather than yielding it");
    assert.equal("restartAtWorkerBoundary" in offered[0], false, "the run is offered no way to yield at a boundary");
    release({ taskId: "A", runId: "A", merged: false, verdict: "no_pr", costUsd: 0 });
    const summary = await run;
    assert.equal(summary.stopReason, "stale");
    for (const step of RETIRED_ROWS) assert.equal(rows.some((r) => r.step === step), false, `${step} is retired`);
    assert.deepEqual(rows.find((r) => r.step === "daemon.freshness_exit")?.children_left_running, []);
  } finally {
    stop = true;
    release({ taskId: "A", runId: "A", merged: false, verdict: "no_pr", costUsd: 0 });
    await run;
  }
});
