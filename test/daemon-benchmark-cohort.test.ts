import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runDaemon } from "../src/lib/daemon.js";
import { loadPlan } from "../src/lib/plan.js";
import { detachSweepAction, drainDetachedSweepActions, detachedActionInFlight } from "../src/lib/sweep.js";
import { runBenchmarkCohortPass } from "../src/lib/benchmark-cohort.js";

test("daemon benchmark cohort failure preserves worker and review flow", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-daemon-benchmark-"));
  const planPath = join(root, "tasks.yaml");
  writeFileSync(planPath, "- id: A\n  title: a\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n");
  const lines: string[] = [];
  const reviews: number[] = [];
  let actions = [{ action: "review" as const, prNumber: 42, origin: "fixture",
    requestedAt: "2026-09-26T12:00:00.000Z" }];
  let release: () => void = () => {};
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  try {
    assert.equal(detachedActionInFlight("benchmark-cohort"), false);
    await runDaemon(loadPlan(planPath), {
      refreshMerged: () => () => false,
      runOne: async (id: string) => ({ taskId: id, runId: `${id}-run`, merged: true, costUsd: 0, verdict: "merged" }),
      sleep: async () => {}, sweep: async () => {},
      pendingPrActions: () => actions,
      runPrAction: async (request) => { reviews.push(request.prNumber); return { outcome: "completed" }; },
      clearPrAction: (action, prNumber) => {
        actions = actions.filter((request) => request.action !== action || request.prNumber !== prNumber);
      },
      log: (step: string) => lines.push(step),
      checkBenchmarkCohort: () => true,
      runBenchmarkCohortPass: async () => {
        await blocked;
        throw new Error("fixture projection failed");
      },
    }, { max: 1 });
    assert.ok(lines.includes("benchmark_cohort.detached"), "the worker/PR loop completes before the projection");
    assert.ok(!lines.includes("benchmark_cohort.run_failed"), "the projection is still unsettled");
    assert.deepEqual(reviews, [42], "PR review proceeds while projection is still blocked");
    release();
    await drainDetachedSweepActions();
    assert.ok(lines.includes("benchmark_cohort.run_failed"), "a failed projection is visible after normal work");
  } finally {
    release();
    await drainDetachedSweepActions();
    rmSync(root, { recursive: true, force: true });
  }
});

test("daemon benchmark cohort cadence reports success, check failure, busy pass and synchronous failure without blocking", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-daemon-benchmark-branches-"));
  const planPath = join(root, "tasks.yaml");
  writeFileSync(planPath, "- id: A\n  title: a\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n");
  writeFileSync(join(root, "ledger.ndjson"), JSON.stringify({ ts: "2026-09-26T11:00:00.000Z", step: "worker.assignment",
    worker_assignment: { id: "a1", selected: { provider: "cash", model: "gpt-5-nano" } } }) + "\n");
  const entries: { step: string; fields?: Record<string, unknown> }[] = [];
  const run = (overrides: { checkBenchmarkCohort: () => boolean;
    runBenchmarkCohortPass?: () => ReturnType<typeof runBenchmarkCohortPass> }) => runDaemon(loadPlan(planPath), {
    refreshMerged: () => () => false,
    runOne: async (id: string) => ({ taskId: id, runId: `${id}-run`, merged: true, costUsd: 0, verdict: "merged" }),
    sleep: async () => {}, sweep: async () => {},
    log: (step: string, fields?: Record<string, unknown>) => entries.push({ step, fields }),
    ...overrides,
  }, { max: 1 });
  try {
    await run({ checkBenchmarkCohort: () => true, runBenchmarkCohortPass: () => runBenchmarkCohortPass(root) });
    await drainDetachedSweepActions();
    const report = entries.find((entry) => entry.step === "benchmark_cohort.ran");
    assert.equal(report?.fields?.state, "complete");
    assert.equal(typeof report?.fields?.checkpoint_bytes, "number");

    await run({ checkBenchmarkCohort: () => { throw new Error("fixture check failure"); } });
    assert.ok(entries.some((entry) => entry.step === "benchmark_cohort.check_failed"));

    let release: () => void = () => {};
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    detachSweepAction(blocked, { actionKind: "benchmark-cohort", taskId: "DAEMON" });
    try {
      await run({ checkBenchmarkCohort: () => true, runBenchmarkCohortPass: () => runBenchmarkCohortPass(root) });
      assert.ok(entries.some((entry) => entry.step === "benchmark_cohort.already_detached"));
    } finally { release(); await drainDetachedSweepActions(); }

    await run({ checkBenchmarkCohort: () => true,
      runBenchmarkCohortPass: () => { throw new Error("fixture sync failure"); } });
    assert.ok(entries.some((entry) => entry.step === "benchmark_cohort.run_failed"
      && String(entry.fields?.error).includes("fixture sync failure")));
  } finally {
    await drainDetachedSweepActions();
    rmSync(root, { recursive: true, force: true });
  }
});
