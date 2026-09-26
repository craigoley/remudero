import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runDaemon } from "../src/lib/daemon.js";
import { loadPlan } from "../src/lib/plan.js";
import { drainDetachedSweepActions, detachedActionInFlight } from "../src/lib/sweep.js";

test("daemon benchmark cohort pass is best effort and production wired", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-daemon-benchmark-"));
  const planPath = join(root, "tasks.yaml");
  writeFileSync(planPath, "- id: A\n  title: a\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n");
  const lines: string[] = [];
  let release: () => void = () => {};
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  try {
    assert.equal(detachedActionInFlight("benchmark-cohort"), false);
    await runDaemon(loadPlan(planPath), {
      refreshMerged: () => () => false,
      runOne: async (id: string) => ({ taskId: id, runId: `${id}-run`, merged: true, costUsd: 0, verdict: "merged" }),
      sleep: async () => {}, sweep: async () => {},
      log: (step: string) => lines.push(step),
      checkBenchmarkCohort: () => true,
      runBenchmarkCohortPass: async () => {
        await blocked;
        throw new Error("fixture projection failed");
      },
    }, { max: 1 });
    assert.ok(lines.includes("benchmark_cohort.detached"), "the worker/PR loop completes before the projection");
    assert.ok(!lines.includes("benchmark_cohort.run_failed"), "the projection is still unsettled");
    release();
    await drainDetachedSweepActions();
    assert.ok(lines.includes("benchmark_cohort.run_failed"), "a failed projection is visible after normal work");
  } finally {
    release();
    await drainDetachedSweepActions();
    rmSync(root, { recursive: true, force: true });
  }
});
