// test/an-orphaned-assignment-gets-its-receipt.test.ts — W1-T4644.
//
// A worker killed with its process (a daemon restart, a kill mid-run) leaves its `worker.assignment`
// with no `worker.attempt`: no in-process path survives to write one. The reclaim paths that find
// such a run — the in-flight lock sweep reaping a dead holder's lock, and the orphan process sweep
// killing an ended run's stray — now write exactly one receipt per unreceipted assignment, and a
// second pass writes nothing.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  ORPHANED_BY_PROCESS_EXIT,
  RUN_ID_EPOCH_RE,
  orphanedRunWindowStart,
  receiptOrphanedAssignments,
  sweepInflightLocksWithReceipts,
} from "../src/lib/benchmark-run.js";
import { fixedClock, systemClock, type Clock } from "../src/lib/clock.js";
import type { Config } from "../src/lib/config.js";
import { orphanWorkerKillLedger, runInflightLockSweepRung } from "../src/run-task.js";

const TASK = "W1-T9644";

interface Fixture { root: string; statePath: string; inflightDir: string; runId: string; clock: Clock }

function fixture(clock: Clock = systemClock): Fixture {
  const root = mkdtempSync(join(tmpdir(), "rmd-orphan-receipt-"));
  const runId = `${TASK}-${clock.now() - 10 * 60_000}`;
  return { root, statePath: join(root, "state", "ledger.ndjson"), inflightDir: join(root, "state", "inflight"), runId, clock };
}

function isoAgo(clock: Clock, ms: number): string {
  return fixedClock(clock.now() - ms).iso();
}

function assignmentRow(f: Fixture, id: string, agoMs: number, runId = f.runId): Record<string, unknown> {
  return { ts: isoAgo(f.clock, agoMs), run_id: runId, task_id: TASK, step: "worker.assignment", lane: "run-task",
    worker_assignment: { id, requested: { model: "m", effort: "e" }, selected: { provider: "p", model: "m", effort: "e" } } };
}

function attemptRow(f: Fixture, id: string, agoMs: number): Record<string, unknown> {
  return { ts: isoAgo(f.clock, agoMs), run_id: f.runId, task_id: TASK, step: "worker.attempt",
    selection_assignment_id: id, success: true, billing_mode: "subscription", total_cost_usd: 0.5 };
}

function seed(f: Fixture, rows: Array<Record<string, unknown> | string>): void {
  mkdirSync(join(f.root, "state"), { recursive: true });
  writeFileSync(f.statePath, rows.map((r) => (typeof r === "string" ? r : JSON.stringify(r))).join("\n") + "\n");
}

function rowsOf(f: Fixture): Array<Record<string, unknown>> {
  return readFileSync(f.statePath, "utf8").trim().split("\n").filter((raw) => raw.endsWith("}"))
    .map((raw) => JSON.parse(raw) as Record<string, unknown>);
}

function orphanReceipts(f: Fixture): Array<Record<string, unknown>> {
  return rowsOf(f).filter((r) => r.step === "worker.attempt" && r.worker_failure === ORPHANED_BY_PROCESS_EXIT);
}

function deadPid(): number {
  const child = spawnSync("true");
  assert.equal(typeof child.pid, "number");
  return child.pid!;
}

function seedDeadLock(f: Fixture, taskId: string, runId: string): void {
  mkdirSync(f.inflightDir, { recursive: true });
  writeFileSync(join(f.inflightDir, `${taskId}.lock`),
    JSON.stringify({ pid: deadPid(), run_id: runId, host: hostname(), startedAt: isoAgo(f.clock, 9 * 60_000) }));
}

test("RUN_ID_EPOCH_RE reads the minted epoch stamp and refuses an unstamped run id", () => {
  assert.equal(RUN_ID_EPOCH_RE.test("W1-T4644-1790559825246"), true);
  assert.equal(RUN_ID_EPOCH_RE.test("review-PR7518-1790559825246"), true);
  assert.equal(RUN_ID_EPOCH_RE.test("run-ended-poll-1"), false);
  assert.equal(RUN_ID_EPOCH_RE.test("W1-T4644-17905598252"), false, "a short stamp is not an epoch-ms");
});

test("the run's window starts at the earlier of its run id stamp and its lock's start", () => {
  const clock = fixedClock(systemClock.now());
  const stamp = clock.now() - 5_000;
  assert.equal(orphanedRunWindowStart({ runId: `${TASK}-${stamp}` }), fixedClock(stamp).iso());
  assert.equal(orphanedRunWindowStart({ runId: `${TASK}-${stamp}`, startedAt: isoAgo(clock, 60_000) }), isoAgo(clock, 60_000));
  assert.equal(orphanedRunWindowStart({ runId: "unstamped", startedAt: isoAgo(clock, 1_000) }), isoAgo(clock, 1_000));
  assert.equal(orphanedRunWindowStart({ runId: "unstamped", startedAt: "not-a-date" }), undefined);
});

test("one receipt per unreceipted assignment; an already-receipted assignment is untouched; a second reclaim writes nothing", () => {
  const f = fixture();
  try {
    const receipted = attemptRow(f, "a-done", 7 * 60_000);
    seed(f, [
      { ts: isoAgo(f.clock, 9 * 60_000), run_id: f.runId, task_id: TASK, step: "run.start" },
      assignmentRow(f, "a-done", 8 * 60_000),
      receipted,
      assignmentRow(f, "a-lost-1", 6 * 60_000),
      assignmentRow(f, "a-lost-2", 5 * 60_000),
      assignmentRow(f, "a-lost-2", 5 * 60_000 - 1),
      assignmentRow(f, "other-run", 4 * 60_000, `${TASK}-${f.clock.now() - 60_000}`),
    ]);

    const first = receiptOrphanedAssignments({ runId: f.runId, taskId: TASK, detectedBy: "orphan-process-sweep" }, f.statePath);
    assert.deepEqual(first, { written: 2 });
    const receipts = orphanReceipts(f);
    assert.deepEqual(receipts.map((r) => r.selection_assignment_id).sort(), ["a-lost-1", "a-lost-2"]);
    for (const r of receipts) {
      assert.equal(r.run_id, f.runId);
      assert.equal(r.task_id, TASK);
      assert.equal(r.lane, "run-task");
      assert.equal(r.success, false);
      assert.equal(r.orphan_detected_by, "orphan-process-sweep");
      assert.equal(r.served_model_unavailable_reason, "worker-process-exited-before-result");
      assert.equal(r.billing_mode_unavailable_reason, "worker-process-exited-before-result");
      assert.equal(r.cost_unavailable_reason, "worker-process-exited-before-result");
      assert.equal(r.billing_mode, undefined, "no billing mode is invented");
      assert.equal(r.total_cost_usd, undefined, "no cost is invented, not even zero");
      const receipt = r.benchmark_run as Record<string, any>;
      assert.equal(receipt.phase, "attempt");
      assert.deepEqual(receipt.assignmentJoin, { state: "observed", value: true });
      assert.deepEqual(receipt.workerCall, { state: "failed", value: false });
      const gap = { state: "unavailable", reason: "worker-process-exited-before-result" };
      assert.deepEqual(receipt.servedModel, gap);
      assert.deepEqual(receipt.accounting.billingMode, gap);
      assert.deepEqual(receipt.accounting.apiCostUsd, gap);
      assert.deepEqual(receipt.accounting.subscriptionNotionalUsd, gap);
    }
    const done = rowsOf(f).filter((r) => r.selection_assignment_id === "a-done");
    assert.deepEqual(done, [receipted], "the receipted assignment keeps exactly its own receipt");
    assert.equal(rowsOf(f).filter((r) => r.selection_assignment_id === "other-run").length, 0, "another run is not this orphan's");

    const before = rowsOf(f).length;
    const second = receiptOrphanedAssignments({ runId: f.runId, taskId: TASK, detectedBy: "inflight-lock-sweep" }, f.statePath);
    assert.deepEqual(second, { written: 0 });
    assert.equal(rowsOf(f).length, before, "a second reclaim pass writes nothing");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("a run whose window cannot be placed, or whose window read is torn, gets no receipt", () => {
  const f = fixture();
  try {
    seed(f, [assignmentRow(f, "a-lost", 60_000, "run-ended-poll-1")]);
    assert.deepEqual(receiptOrphanedAssignments({ runId: "run-ended-poll-1", taskId: TASK, detectedBy: "t" }, f.statePath),
      { written: 0, reason: "run-window-unknown" });

    seed(f, [assignmentRow(f, "a-lost", 60_000), `{"run_id":"${f.runId}","step":"worker.attempt","selection_assign`]);
    assert.deepEqual(receiptOrphanedAssignments({ runId: f.runId, taskId: TASK, detectedBy: "t" }, f.statePath),
      { written: 0, reason: "run-ledger-window-incomplete" }, "a torn row could be the receipt, so none is written");
    assert.equal(orphanReceipts(f).length, 0);

    seed(f, [assignmentRow(f, "a-lost", 60_000)]);
    const unwritable = join(f.root, "state", "a-directory.ndjson");
    mkdirSync(unwritable);
    assert.deepEqual(receiptOrphanedAssignments({ runId: f.runId, taskId: TASK, detectedBy: "t" }, unwritable),
      { written: 0, reason: "orphan-receipt-failed" }, "a receipt failure is reported, never thrown into reclaim");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("the in-flight lock reclaim path wires the writer: a reaped dead holder's run gets its receipts, once", () => {
  const f = fixture();
  try {
    seed(f, [assignmentRow(f, "a-killed", 8 * 60_000)]);
    seedDeadLock(f, TASK, f.runId);
    mkdirSync(f.inflightDir, { recursive: true });
    writeFileSync(join(f.inflightDir, "W1-T9645.lock"), "not json");
    const log: Array<{ step: string; extra?: Record<string, unknown> }> = [];

    const swept = runInflightLockSweepRung({ root: f.root } as Config, (step, extra) => log.push({ step, extra }));
    assert.deepEqual(swept.reaped.sort(), [TASK, "W1-T9645"]);
    assert.equal(existsSync(join(f.inflightDir, `${TASK}.lock`)), false);
    const receipts = orphanReceipts(f);
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0]!.selection_assignment_id, "a-killed");
    assert.equal(receipts[0]!.orphan_detected_by, "inflight-lock-sweep");

    seedDeadLock(f, TASK, f.runId);
    const again = sweepInflightLocksWithReceipts(f.inflightDir, f.statePath);
    assert.deepEqual(again.reaped, [TASK]);
    assert.equal(orphanReceipts(f).length, 1, "a second reclaim of the same run writes nothing");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("the orphan process sweep's ledger wires the writer beside its kill line", () => {
  const f = fixture();
  try {
    seed(f, [assignmentRow(f, "a-stray", 8 * 60_000)]);
    const record = orphanWorkerKillLedger(f.statePath);
    record({ run_id: f.runId, task_id: TASK, worker_scope: "scope", pid: 4242, cmdline: "claude" });
    const rows = rowsOf(f);
    const killed = rows.find((r) => r.step === "worker_orphan_killed");
    assert.equal(killed?.run_id, f.runId);
    assert.equal(killed?.pid, 4242);
    const receipts = orphanReceipts(f);
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0]!.selection_assignment_id, "a-stray");
    assert.equal(receipts[0]!.orphan_detected_by, "orphan-process-sweep");

    record({ run_id: f.runId, task_id: TASK, pid: 4243, cmdline: "claude" });
    assert.equal(orphanReceipts(f).length, 1, "a second kill for the same run writes no second receipt");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("a lock sweep over no in-flight directory reaps nothing and receipts nothing", () => {
  const f = fixture();
  try {
    const swept = sweepInflightLocksWithReceipts(f.inflightDir, f.statePath);
    assert.deepEqual(swept.reaped, []);
    assert.equal(existsSync(f.statePath), false);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
