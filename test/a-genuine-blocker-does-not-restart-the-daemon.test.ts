import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { runDaemon, type DaemonFreshness } from "../src/lib/daemon.js";
import { runDrain } from "../src/lib/drain.js";
import { loadPlan, type Plan, type Task } from "../src/lib/plan.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

type LedgerRow = { step: string; extra: Record<string, unknown> };

function planWithIndependentTask(): Plan {
  return planFrom(`
- id: A
  title: blocker
  repo: remudero
  type: implement
  verify: auto
  depends_on: []
  status: queued
- id: B
  title: dependent
  repo: remudero
  type: implement
  verify: auto
  depends_on: [A]
  status: queued
- id: D
  title: independent
  repo: remudero
  type: implement
  verify: auto
  depends_on: []
  status: queued
`);
}

function planWithOnlyDependent(): Plan {
  return planFrom(`
- id: A
  title: blocker
  repo: remudero
  type: implement
  verify: auto
  depends_on: []
  status: queued
- id: B
  title: dependent
  repo: remudero
  type: implement
  verify: auto
  depends_on: [A]
  status: queued
`);
}

function planFrom(yaml: string): Plan {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}daemon-block-park-`));
  const path = join(dir, "tasks.yaml");
  writeFileSync(path, yaml);
  return loadPlan(path);
}

function blocked(taskId = "A") {
  return {
    taskId,
    runId: `${taskId}-run`,
    merged: false,
    costUsd: 0.2,
    verdict: "blocked_budget" as const,
    prUrl: "https://github.com/craigoley/remudero/pull/41",
  };
}

function merged(taskId: string) {
  return { taskId, runId: `${taskId}-run`, merged: true, costUsd: 0.1, verdict: "merged" as const };
}

test("W1-T3122: a dependency-bearing blocker parks in-process and independent work still runs", async () => {
  const mergedIds = new Set<string>();
  const ran: string[] = [];
  const escalations: Task[] = [];
  const rows: LedgerRow[] = [];
  let controlReads = 0;
  let openPr: number | undefined;

  const summary = await runDaemon(
    planWithIndependentTask(),
    {
      refreshMerged: () => (id) => mergedIds.has(id),
      checkStop: () => (++controlReads > 8 ? "test runaway guard" : undefined),
      isOpenPr: (id) => (id === "A" ? openPr : undefined),
      isCreditIndeterminate: () => false,
      runOne: async (id) => {
        ran.push(id);
        if (id === "A") {
          openPr = 41;
          return blocked(id);
        }
        mergedIds.add(id);
        return merged(id);
      },
      escalateBlock: async ({ task }) => { escalations.push(task); },
      sleep: async () => {},
      log: (step, extra = {}) => rows.push({ step, extra }),
    },
    { max: 2 },
  );

  assert.equal(summary.stopReason, "max_reached", "the healthy process completes another scheduler cycle");
  assert.deepEqual(ran, ["A", "D"], "A is parked, B stays dependency-gated, and D uses the free lane");
  assert.deepEqual(escalations.map((t) => t.id), ["A"], "the blocker escalates once for this episode");
  assert.equal(rows.filter((r) => r.step === "daemon.block.parked").length, 1);
  assert.equal(rows.filter((r) => r.step === "daemon.summary" && r.extra.stopReason === "blocked").length, 0);
});

test("W1-T3122: an unchanged open head stays parked while reconciliation and wake polling continue", async () => {
  const rows: LedgerRow[] = [];
  let sleeps = 0;
  let sweeps = 0;
  let runCalls = 0;
  let escalations = 0;
  let openPr: number | undefined;

  const summary = await runDaemon(planWithOnlyDependent(), {
    refreshMerged: () => (() => false),
    isOpenPr: (id) => (id === "A" ? openPr : undefined),
    isCreditIndeterminate: () => false,
    runOne: async (id) => {
      runCalls++;
      openPr = 41;
      return blocked(id);
    },
    escalateBlock: async () => { escalations++; },
    sweep: async () => { sweeps++; },
    checkStop: () => (sleeps >= 3 ? "test stop" : undefined),
    sleep: async () => { throw new Error("plain sleep must not own the event-driven wait"); },
    sleepUntilSweepWake: async () => { sleeps++; },
    log: (step, extra = {}) => rows.push({ step, extra }),
  });

  assert.equal(summary.stopReason, "stopped");
  assert.equal(runCalls, 1, "the identical open head is not bought again on a timer");
  assert.equal(escalations, 1, "an unchanged episode is not paged once per poll");
  assert.ok(sweeps >= 3, `the PR reconciler remained live across parked ticks (saw ${sweeps})`);
  assert.ok(sleeps >= 3, "the existing event-aware idle wait remained active");
  assert.equal(rows.filter((r) => r.step === "daemon.block.parked").length, 1);
  assert.equal(rows.filter((r) => r.step === "daemon.block.rearmed").length, 0);
});

test("W1-T3122: merge credit unlocks the dependent and records the material re-arm reason", async () => {
  const mergedIds = new Set<string>();
  const ran: string[] = [];
  const rows: LedgerRow[] = [];
  let sleeps = 0;
  let openPr: number | undefined;

  const summary = await runDaemon(
    planWithOnlyDependent(),
    {
      refreshMerged: () => (id) => mergedIds.has(id),
      isOpenPr: (id) => (id === "A" ? openPr : undefined),
      isCreditIndeterminate: () => false,
      runOne: async (id) => {
        ran.push(id);
        if (id === "A") {
          openPr = 41;
          return blocked(id);
        }
        mergedIds.add(id);
        return merged(id);
      },
      sleep: async () => {
        sleeps++;
        mergedIds.add("A");
      },
      log: (step, extra = {}) => rows.push({ step, extra }),
    },
    { max: 2 },
  );

  assert.equal(summary.stopReason, "max_reached");
  assert.deepEqual(ran, ["A", "B"]);
  assert.equal(sleeps, 1);
  assert.deepEqual(rows.find((r) => r.step === "daemon.block.rearmed")?.extra, {
    task: "A",
    pr_url: "https://github.com/craigoley/remudero/pull/41",
    reason: "merged",
  });
});

test("W1-T3122: a confirmed no-open-PR state re-arms the task, while an unreadable state preserves the park", async () => {
  let open = false;
  const ranAfterClose: string[] = [];
  const closeRows: LedgerRow[] = [];
  const closedSummary = await runDaemon(
    planWithOnlyDependent(),
    {
      refreshMerged: () => (() => false),
      isOpenPr: (id) => (id === "A" && open ? 41 : undefined),
      isCreditIndeterminate: () => false,
      runOne: async (id) => {
        ranAfterClose.push(id);
        if (ranAfterClose.length === 1) open = true;
        return ranAfterClose.length === 1 ? blocked(id) : merged(id);
      },
      sleep: async () => { open = false; },
      log: (step, extra = {}) => closeRows.push({ step, extra }),
    },
    { max: 2 },
  );
  assert.equal(closedSummary.stopReason, "max_reached");
  assert.deepEqual(ranAfterClose, ["A", "A"], "the task is offered again only after its open head disappears");
  assert.equal(closeRows.find((r) => r.step === "daemon.block.rearmed")?.extra.reason, "no-open-pr");

  let unreadable = false;
  let unreadableSleeps = 0;
  let unreadableRuns = 0;
  const unreadableRows: LedgerRow[] = [];
  const unreadableSummary = await runDaemon(planWithOnlyDependent(), {
    refreshMerged: () => (() => false),
    isOpenPr: () => undefined,
    isCreditIndeterminate: () => unreadable,
    runOne: async (id) => {
      unreadableRuns++;
      unreadable = true;
      return blocked(id);
    },
    checkStop: () => (unreadableSleeps >= 2 ? "test stop" : undefined),
    sleep: async () => { unreadableSleeps++; },
    log: (step, extra = {}) => unreadableRows.push({ step, extra }),
  });
  assert.equal(unreadableSummary.stopReason, "stopped");
  assert.equal(unreadableRuns, 1, "absence from an unreadable projection is not treated as a closed head");
  assert.equal(unreadableRows.filter((r) => r.step === "daemon.block.rearmed").length, 0);
});

test("W1-T3122: material freshness and real errors keep their process-boundary semantics", async () => {
  let stale = false;
  let staleOpenPr: number | undefined;
  let staleControlReads = 0;
  const freshness = (): DaemonFreshness =>
    stale ? { stale: true, oldSha: "1111111", newSha: "2222222" } : { stale: false };
  const staleSummary = await runDaemon(planWithOnlyDependent(), {
    refreshMerged: () => (() => false),
    isOpenPr: (id) => (id === "A" ? staleOpenPr : undefined),
    isCreditIndeterminate: () => false,
    checkStop: () => (++staleControlReads > 8 ? "test runaway guard" : undefined),
    checkFreshness: freshness,
    runOne: async (id) => {
      stale = true;
      staleOpenPr = 41;
      return blocked(id);
    },
    sleep: async () => {},
  });
  assert.equal(staleSummary.stopReason, "stale", "a real source advance still requests a process refresh");

  const errorSummary = await runDaemon(planWithOnlyDependent(), {
    refreshMerged: () => (() => false),
    runOne: async () => { throw new Error("boom"); },
    sleep: async () => {},
  });
  assert.equal(errorSummary.stopReason, "error", "a real worker error remains a crash-class summary");
});

test("W1-T3122: a caller without the complete ownership projection retains the defensive halt", async () => {
  let openPr: number | undefined;
  const summary = await runDaemon(planWithOnlyDependent(), {
    refreshMerged: () => (() => false),
    isOpenPr: (id) => (id === "A" ? openPr : undefined),
    runOne: async (id) => {
      openPr = 41;
      return blocked(id);
    },
    sleep: async () => {},
  });

  assert.equal(summary.stopReason, "blocked", "an incomplete projection cannot create an unrecoverable park");
});

test("W1-T3122: direct one-shot drain still halts on the same genuine blocker", async () => {
  const noneMerged = (_id: string) => false;
  const summary = await runDrain(
    planWithOnlyDependent(),
    {
      refreshMerged: () => noneMerged,
      runOne: async (id: string) => blocked(id),
    } as never,
    { max: 2 },
  );
  assert.equal(summary.stopReason, "blocked");
  assert.deepEqual(summary.attempted, ["A"]);
});
