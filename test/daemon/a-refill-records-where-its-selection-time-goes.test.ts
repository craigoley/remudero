import assert from "node:assert/strict";
import { test } from "node:test";

import { runDaemon } from "#src/lib/daemon.js";
import { loadPlanFromYaml } from "#src/lib/plan.js";
import type { RunResult } from "#src/lib/run-result.js";
import { hostIndependentDaemonDeps } from "#test/helpers/daemon-host-pins.js";

const ids = ["W1-T11", "W1-T12", "W1-T13", "W1-T14", "W1-T15", "W1-T16"] as const;
const [first, sibling, next, pushed, open, tripped] = ids;
const plan = loadPlanFromYaml(ids.map((id) =>
  `- id: ${id}\n  title: ${id}\n  repo: remudero\n  files: [src/${id}.ts]\n  type: implement\n  status: queued\n`,
).join(""), "fixture");
const timingStep = "dispatch.selection_timing";
const merged = (id: string): RunResult => ({ taskId: id, runId: id, merged: true, verdict: "merged", costUsd: 0 });

async function dispatch(selectionTiming?: boolean, failTimingSink = false) {
  const rows: Array<{ step: string; fields: Record<string, unknown> }> = [];
  const started: string[] = [];
  const finished = new Set<string>();
  let finishSibling!: (result: RunResult) => void;
  const siblingResult = new Promise<RunResult>((resolve) => { finishSibling = resolve; });
  const sleepers: Array<() => void> = [];
  let ms = Date.parse("2026-11-22T12:00:00Z");
  let closedReads = 0;
  let stopped = false;
  const isMerged = (id: string) => { ms += 2; return finished.has(id); };
  const summary = await runDaemon(plan, {
    ...hostIndependentDaemonDeps(),
    now: () => new Date(ms),
    sleep: () => stopped ? Promise.resolve() : new Promise<void>((resolve) => sleepers.push(resolve)),
    checkStop: () => stopped ? "fixture finished" : undefined,
    refreshMerged: () => isMerged,
    refreshMergedAsync: async () => { await Promise.resolve(); ms += 47; return isMerged; },
    reloadPlan: async () => { await Promise.resolve(); ms += 5; return null; },
    buildDispatchValueContext: () => { ms += 7; return undefined; },
    readPushedRunBranches: async () => {
      await Promise.resolve();
      ms += 11;
      return `${"a".repeat(40)}\trefs/heads/run-${pushed}-1795300000000\n`;
    },
    readClosedRunBranchPrs: async () => {
      await Promise.resolve();
      ms += 13;
      if (++closedReads === 3) throw new Error("closed PRs unavailable");
      return "";
    },
    readLiveState: async () => {
      await Promise.resolve();
      ms += 17;
      return "OPEN";
    },
    isOpenPr: (id) => { ms += 3; return id === open ? 42 : undefined; },
    isCircuitTripped: (id) => { ms += 19; return id === tripped; },
    isLifetimeCapExceeded: () => { ms += 23; return false; },
    isIndeterminate: () => { ms += 29; return false; },
    isCreditIndeterminate: () => { ms += 31; return false; },
    isIndependentFailureBlocked: () => { ms += 37; return false; },
    beginSelectionPass: () => { ms += 41; },
    openPrCount: () => { ms += 43; return 1; },
    log: (step, fields = {}) => {
      rows.push({ step, fields });
      if (step === timingStep && failTimingSink) throw new Error("timing sink unavailable");
      if (step === "dispatch.lane_refill_held") setImmediate(() => finishSibling(merged(sibling)));
      if (step === "dispatch.settled_set") {
        stopped = true;
        for (const wake of sleepers.splice(0)) wake();
      }
    },
    runOne: async (id) => {
      started.push(id);
      const outcome = id === sibling ? await siblingResult : merged(id);
      finished.add(id);
      return outcome;
    },
  }, { laneCount: 2, selectionTiming });
  return { rows, started, stopReason: summary.stopReason };
}

test("W1-T13286 criterion 1: tick and refill ledger each probe and the number of candidates walked", async () => {
  const { rows } = await dispatch();
  const timings = rows.filter(({ step }) => step === timingStep).map(({ fields }) => fields);
  assert.deepEqual(timings.map(({ site, candidates_examined }) => [site, candidates_examined]), [
    ["tick", 6], ["lane-refill", 6], ["lane-refill", 6],
  ]);
  for (const [index, row] of timings.entries()) {
    const reachedPreconditions = [6, 4, 3][index]!;
    const expected = {
      ...(index > 0 ? { refreshMerged: 47, reloadPlan: 5 } : {}),
      buildDispatchValueContext: 7,
      readPushedRunBranches: 11,
      readClosedRunBranchPrs: 13,
      aCandidateHoldsARunBranch: 2 + 3,
      prefetchLiveStates: 6 * 3 + 2 + 17,
      readLiveState: 17,
      readCachedLiveState: 0,
      openPrCount: 43,
      beginSelectionPass: 41,
      isMerged: 6 * 2,
      isCreditIndeterminate: (6 - index) * 31,
      isIndependentFailureBlocked: reachedPreconditions * 37,
      isIndeterminate: reachedPreconditions * 29,
      isCircuitTripped: reachedPreconditions * 19,
      isLifetimeCapExceeded: (reachedPreconditions - 1) * 23,
      isOpenPr: (reachedPreconditions - 1) * 3,
      hasPushedRunBranch: 0,
      partitionByFileOverlap: 0,
    };
    const probes = row.probe_ms as Record<string, number>;
    for (const [name, ms] of Object.entries(expected)) assert.equal(probes[name], ms, name);
    // The per-PR read is contained in the elapsed batch time.
    assert.equal(row.total_ms, Object.values(expected).reduce((total, ms) => total + ms, 0) - expected.readLiveState);
  }
});

test("W1-T13286 criterion 2: the same picks, order and holds with timing on or off", async () => {
  const withoutTiming = await dispatch(false);
  assert.deepEqual(withoutTiming.started, [first, sibling, next]);
  assert.equal(withoutTiming.stopReason, "stopped");
  assert.deepEqual(withoutTiming.rows.filter(({ step }) => step === "dispatch.lane_refill_held").map(({ fields }) => fields.reason),
    ["no disjoint runnable task within the lane budget"]);
  assert.ok(withoutTiming.rows.some(({ step, fields }) => step === "dispatch.skipped" && fields.reason === "run-branch-already-pushed"));
  assert.ok(withoutTiming.rows.some(({ step, fields }) => step === "dispatch.skipped" && fields.reason === "open-pr"));
  assert.ok(withoutTiming.rows.some(({ step }) => step === "dispatch.circuit_broken"));
  assert.ok(withoutTiming.rows.some(({ step, fields }) => step === "dispatch.run_branch_read_failed" && fields.site === "lane-refill:closed-prs"));
  for (const failTimingSink of [false, true]) {
    const measured = await dispatch(true, failTimingSink);
    assert.equal(measured.rows.filter(({ step }) => step === timingStep).length, 3);
    assert.deepEqual({ ...measured, rows: measured.rows.filter(({ step }) => step !== timingStep) }, withoutTiming);
  }
});

test("a task precondition is timed through its normal command reader", async () => {
  const plan = loadPlanFromYaml(`
- id: W1-T11
  title: hold on the precondition
  repo: remudero
  type: implement
  status: queued
  precondition:
    read: [--help]
    expect: unmatched output
`, "fixture");
  const timings: Array<Record<string, unknown>> = [];
  let stopped = false;
  await runDaemon(plan, {
    ...hostIndependentDaemonDeps(),
    sleep: async () => {},
    checkStop: () => stopped ? "fixture finished" : undefined,
    refreshMerged: () => () => false,
    log: (step, fields = {}) => {
      if (step === timingStep) timings.push(fields);
      if (step === "daemon.idle") stopped = true;
    },
    runOne: async () => assert.fail("the precondition had to hold the task"),
  });
  assert.equal(timings.length, 1);
  assert.equal((timings[0]?.probe_ms as Record<string, number>).readPrecondition, 0);
});
