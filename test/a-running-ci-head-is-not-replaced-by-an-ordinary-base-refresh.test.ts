import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_SWEEP_POLICY,
  runSweep,
  selectUpdateBranchTarget,
  type ArmedStalledPr,
  type BaseChangedFiles,
  type OpenPrView,
  type SweepDeps,
  type SweepPolicy,
} from "./helpers/sweep-test.js";

const NOW = 1_800_000_000_000;
const POLICY: SweepPolicy = {
  ...DEFAULT_SWEEP_POLICY,
  reviewWaitingBranchRefreshEnabled: true,
  reviewWaitingBranchRefreshThreshold: 10,
};

function pr(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 9993,
    prUrl: "https://github.com/craigoley/remudero/pull/9993",
    reviewState: "success",
    checksState: "green",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: new Date(NOW - 30 * 60_000).toISOString(),
    headSha: "reviewed-head-with-running-coverage",
    autoMergeArmed: false,
    mergeState: "clean",
    changedFiles: ["src/mine.ts", "test/mine.test.ts"],
    ...over,
  };
}

function picked(
  views: OpenPrView[],
  behind = 30,
  files?: ReadonlyMap<number, BaseChangedFiles>,
  stale = new Map<number, readonly string[]>(),
) {
  return selectUpdateBranchTarget(
    views, NOW, new Set(), stale, new Set(),
    new Map(views.map((view) => [view.prNumber, behind])), POLICY, new Set(), files,
  );
}

test("unit test: ordinary base refresh waits for positively pending current-head checks across every refresh cause", () => {
  const cases: Array<{
    name: string;
    reason: NonNullable<ArmedStalledPr["updateReason"]>;
    over?: Partial<OpenPrView>;
    behind?: number;
    files?: ReadonlyMap<number, BaseChangedFiles>;
  }> = [
    { name: "legacy distance", reason: "distance" },
    { name: "missing base files", reason: "distance-unknown", files: new Map() },
    { name: "truncated base files", reason: "distance-unknown", files: new Map([[9993, { files: [], truncated: true }]]) },
    { name: "own-file overlap", reason: "distance-overlap", files: new Map([[9993, { files: ["src/mine.ts"], truncated: false }]]) },
    { name: "changed baseline", reason: "distance-baseline", files: new Map([[9993, { files: ["package-lock.json"], truncated: false }]]) },
    { name: "distance backstop", reason: "distance-ceiling", behind: 61, files: new Map([[9993, { files: ["src/other.ts"], truncated: false }]]) },
    { name: "armed behind", reason: "armed-stalled", over: { autoMergeArmed: true, mergeState: "behind" } },
    { name: "ready overlap", reason: "ready-overlap", behind: 1, over: { autoMergeArmed: true }, files: new Map([[9993, { files: ["src/mine.ts"], truncated: false }]]) },
  ];
  for (const entry of cases) {
    assert.equal(picked([pr(entry.over)], entry.behind, entry.files)?.updateReason, entry.reason, `${entry.name}: positive refresh control`);
    assert.equal(picked([pr({ ...entry.over, checksState: "pending" })], entry.behind, entry.files), undefined, entry.name);
  }
});

test("unit test: a pending oldest head does not starve the next eligible completed head", () => {
  const pending = pr({ checksState: "pending", autoMergeArmed: true, mergeState: "behind" });
  const completed = pr({ prNumber: 9994, headSha: "completed-next-head", lastActivityAt: new Date(NOW - 20 * 60_000).toISOString() });
  assert.equal(picked([pending, completed])?.headSha, completed.headSha);
});

test("unit test: unknown checks are not claimed to be running and red stale-workflow recovery remains eligible", () => {
  assert.equal(picked([pr({ checksState: "none" })])?.updateReason, "distance");
  const failed = pr({ checksState: "red", ciFailures: [{ name: "ci-gate", logTail: "actual failure" }] });
  assert.equal(picked([failed], 0, undefined, new Map([[9993, ["ci-gate"]]]))?.updateReason, "stale-gate");
  assert.equal(picked([pr({ checksState: "green", mergeable: true, mergeableState: "blocked", autoMergeArmed: true })], 1)?.updateReason, "stale-blocked");
});

test("unit test: the shipped sweep waits on running checks then refreshes the same completed head without a permanent hold", async () => {
  const rows: Array<Record<string, unknown>> = [];
  const updates: ArmedStalledPr[] = [];
  const target = pr({ checksState: "pending", checksPendingSince: new Date(NOW - 30 * 60_000).toISOString() });
  const before = JSON.stringify(target);
  const deps: SweepDeps = {
    arm: () => {}, close: () => {}, dispatchFix: () => {}, escalate: () => {},
    ledgerPath: "/tmp/rmd-pending-refresh-synthetic-ledger.ndjson",
    runId: "PENDING-REFRESH-CONTROL", now: () => NOW,
    readLedger: () => [], appendLine: (_path, row) => rows.push(row),
    behindMainByPr: new Map([[9993, 30]]), baseChangedFilesByPr: new Map(),
    updateBranch: (candidate) => { updates.push(candidate); return "updated"; },
  };
  await runSweep([target], deps, POLICY);
  assert.equal(updates.length, 0);
  assert.equal(JSON.stringify(target), before);
  assert.equal(rows.some((row) => row.step === "sweep.update_branch.attempted"), false);
  assert.ok(rows.some((row) => String(row.reason).includes("checks pending")), "the existing decision row reports why work waits");
  await runSweep([{ ...target, checksState: "green" }], deps, POLICY);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].headSha, target.headSha);
  assert.equal(updates[0].updateReason, "distance-unknown");
  assert.equal(rows.filter((row) => row.step === "sweep.update_branch.updated").length, 1);
});
