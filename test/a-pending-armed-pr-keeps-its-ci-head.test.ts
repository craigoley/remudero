import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_SWEEP_POLICY,
  openPrsBehindMain,
  runSweep,
  type ArmedStalledPr,
  type OpenPrView,
  type SweepDeps,
} from "./helpers/sweep-test.js";

const NOW = 1_800_000_000_000;
const POLICY = {
  ...DEFAULT_SWEEP_POLICY,
  reviewWaitingBranchRefreshEnabled: true,
  reviewWaitingBranchRefreshThreshold: 10,
};
const BEHIND = new Map([[10000, 4]]);
const BASE_FILES = new Map([[10000, { files: ["src/run-task.ts"], truncated: false }]]);

function pr(overrides: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 10000,
    prUrl: "https://github.com/craigoley/remudero/pull/10000",
    taskId: "W1-T10000",
    headSha: "ci-is-running-on-this-head",
    lastActivityAt: new Date(NOW - 12 * 60_000).toISOString(),
    reviewState: "success",
    checksState: "pending",
    unmetCriteria: [],
    priorStrikes: 0,
    autoMergeArmed: true,
    mergeState: "clean",
    changedFiles: ["src/run-task.ts"],
    ...overrides,
  };
}

test("an armed PR awaiting CI or review keeps its head below the ready-refresh distance gate", () => {
  // #10000 at 2026-10-08T02:33Z: an arm survived a new head while CI was pending;
  // ready-overlap minted another head and restarted that validation after only four main commits.
  const pending: Array<Partial<OpenPrView>> = [
    {},
    { checksState: "red" },
    { checksState: "none" },
    { checksState: "green", reviewState: "pending" },
    { checksState: "green", reviewState: "none" },
    { checksState: "green", reviewState: "failure" },
  ];
  for (const state of pending) {
    assert.deepEqual(openPrsBehindMain([pr(state)], BEHIND, POLICY, new Set(), BASE_FILES), [], JSON.stringify(state));
  }
  for (const autoMergeArmed of [true, false]) {
    const complete = openPrsBehindMain([pr({ checksState: "green", autoMergeArmed })], BEHIND, POLICY, new Set(), BASE_FILES);
    assert.equal(complete[0]?.updateReason, "ready-overlap", "control: completed gates still refresh on actual overlap");
  }
});

test("the sweep spends no ready-refresh status read or update on an armed pending head", async () => {
  for (const checksState of ["pending", "green"] as const) {
    let statusReads = 0;
    const updated: ArmedStalledPr[] = [];
    const rows: Array<Record<string, unknown>> = [];
    const deps: SweepDeps = {
      arm: () => {}, close: () => {}, dispatchFix: () => {}, escalate: () => {},
      ledgerPath: "/nonexistent-rmd-pending-ready-refresh/ledger.ndjson",
      runId: "SWEEP-PENDING-READY-REFRESH",
      now: () => NOW,
      readLedger: () => [],
      appendLine: (_path, row) => { rows.push(row); },
      behindMainByPr: BEHIND,
      baseChangedFilesByPr: BASE_FILES,
      updateBranch: (candidate) => { updated.push(candidate); return "updated"; },
      readActionsStatusSummary: async () => {
        statusReads++;
        return { components: [{ name: "Actions", status: "operational" }], incidents: [] };
      },
    };
    await runSweep([pr({ checksState })], deps, POLICY);
    assert.equal(statusReads, checksState === "green" ? 1 : 0);
    assert.equal(updated.length, checksState === "green" ? 1 : 0);
    assert.equal(rows.some((row) => row.step === "sweep.update_branch.updated"), checksState === "green");
  }
});
