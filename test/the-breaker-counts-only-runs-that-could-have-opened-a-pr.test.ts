import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDispatchBreakerCache,
  dispatchesWithoutNewOwnedPr,
  evaluateDispatchBreakerDetailed,
  isDispatchBreakerTripped,
} from "../src/lib/status.js";

const TASK = "W1-T4660";

function run(runId: string, verdict: string): Array<Record<string, unknown>> {
  return [
    { task_id: TASK, run_id: runId, step: "run.start" },
    { task_id: TASK, run_id: runId, step: "verdict", verdict },
  ];
}

function ledgerWith(rows: Array<Record<string, unknown>>): string {
  const path = join(mkdtempSync(join(tmpdir(), "rmd-breaker-worker-")), "ledger.ndjson");
  writeFileSync(path, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  return path;
}

test("W1-T4660: runs refused by an inconclusive containment probe never trip the breaker", () => {
  const rows = Array.from({ length: 5 }, (_, i) => run(`containment-${i}`, "blocked_containment")).flat();
  const detail = evaluateDispatchBreakerDetailed(ledgerWith(rows), TASK, createDispatchBreakerCache());

  assert.equal(dispatchesWithoutNewOwnedPr(rows, TASK), 0);
  assert.equal(isDispatchBreakerTripped(rows, TASK), false);
  assert.equal(detail.state, "clear");
  assert.equal(detail.freshCount, 0);
  assert.equal(detail.excludedDispatches, 5);
  assert.deepEqual(detail.excludedByReason, { blocked_containment: 5 });
});

test("W1-T4660: worker runs that open no PR still trip it", () => {
  const rows = Array.from({ length: 5 }, (_, i) => run(`worker-${i}`, "no_pr")).flat();
  const detail = evaluateDispatchBreakerDetailed(ledgerWith(rows), TASK, createDispatchBreakerCache());

  assert.equal(dispatchesWithoutNewOwnedPr(rows, TASK), 5);
  assert.equal(isDispatchBreakerTripped(rows, TASK), true);
  assert.equal(detail.state, "tripped");
  assert.equal(detail.freshCount, 5);
  assert.equal(detail.excludedDispatches, 0);
  assert.deepEqual(detail.excludedByReason, {});
});

test("all infrastructure refusal verdicts are excluded and reported beside a real trip", () => {
  const rows = [
    ...run("containment", "blocked_containment"),
    ...run("isolation", "blocked_isolation"),
    ...run("transient", "blocked_transient"),
    ...run("merged-race", "task_already_merged"),
    ...Array.from({ length: 5 }, (_, i) => run(`worker-${i}`, "no_pr")).flat(),
  ];
  const detail = evaluateDispatchBreakerDetailed(ledgerWith(rows), TASK, createDispatchBreakerCache());

  assert.equal(detail.state, "tripped");
  assert.equal(detail.freshCount, 5);
  assert.equal(detail.excludedDispatches, 4);
  assert.deepEqual(detail.excludedByReason, {
    blocked_containment: 1,
    blocked_isolation: 1,
    blocked_transient: 1,
    task_already_merged: 1,
  });
});

test("a new owned PR resets both the streak and its exclusion detail", () => {
  const rows = [
    ...run("old-refusal", "blocked_transient"),
    ...run("old-worker", "no_pr"),
    { task_id: TASK, step: "pr.opened" },
    ...run("new-refusal", "task_already_merged"),
    ...run("new-worker", "no_pr"),
  ];
  const detail = evaluateDispatchBreakerDetailed(ledgerWith(rows), TASK, createDispatchBreakerCache());

  assert.equal(detail.freshCount, 1);
  assert.equal(detail.excludedDispatches, 1);
  assert.deepEqual(detail.excludedByReason, { task_already_merged: 1 });
});

test("an existing stale orphan is named in the exclusion detail", () => {
  const rows = [
    { task_id: TASK, run_id: "orphan", step: "run.start", ts: "2026-09-25T00:00:00Z" },
    { task_id: "W1-OTHER", step: "daemon.boot", ts: "2026-09-27T00:00:00Z" },
  ];
  const detail = evaluateDispatchBreakerDetailed(ledgerWith(rows), TASK, createDispatchBreakerCache());

  assert.equal(detail.freshCount, 0);
  assert.equal(detail.excludedDispatches, 1);
  assert.deepEqual(detail.excludedByReason, { orphaned_run: 1 });
});

test("a run the harness refused before any worker ran never trips the breaker, whatever verdict it wrote", () => {
  const thrown = (runId: string, stage: string) => [
    { task_id: TASK, run_id: runId, step: "run.start" },
    { task_id: TASK, run_id: runId, step: "verdict", verdict: "failed", stage },
  ];
  const lockRefusals = Array.from({ length: 10 }, (_, i) => thrown(`lock-${i}`, "managed_checkout.refresh")).flat();
  const detail = evaluateDispatchBreakerDetailed(ledgerWith(lockRefusals), TASK, createDispatchBreakerCache());
  assert.equal(isDispatchBreakerTripped(lockRefusals, TASK), false, "W1-T4684's ten lock refusals");
  assert.deepEqual(detail.excludedByReason, { "managed_checkout.refresh": 10 });
  const toolchain = Array.from({ length: 5 }, (_, i) => run(`toolchain-${i}`, "blocked_toolchain")).flat();
  assert.equal(isDispatchBreakerTripped(toolchain, TASK), false);
  const realFailures = Array.from({ length: 5 }, (_, i) => thrown(`add-${i}`, "worktree.add")).flat();
  assert.equal(isDispatchBreakerTripped(realFailures, TASK), true, "a failed worktree add still counts");
});
