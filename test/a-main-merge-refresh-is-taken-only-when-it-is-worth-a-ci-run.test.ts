/**
 * W1-T7735 — A MAIN-MERGE REFRESH IS TAKEN ONLY WHEN IT IS WORTH A CI RUN.
 *
 * On 2026-10-10, 37 of 108 head pushes were main-merge refreshes, about 600 PR-min of CI. Each one
 * voided an exact-input review, while main's protection was not strict and GitHub never needed a
 * refresh to merge. The sweep now asks `decideRefresh` before it presses update-branch. It writes
 * `sweep.refresh.decided` for every decision, and a board-wide refresh is paced one per pass.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_CI_MINUTES,
  REFRESH_DECIDED_STEP,
  closenessToMerge,
  decideRefresh,
  refreshHitRate,
  refreshOutcomesDue,
  refreshRequestRows,
  type RefreshValueInput,
} from "../src/lib/refresh-value.js";
import {
  DEFAULT_SWEEP_POLICY,
  runSweep,
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
const MINE = "src/mine.ts";

function pr(prNumber: number, over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber,
    prUrl: `https://github.com/craigoley/remudero/pull/${prNumber}`,
    taskId: `W1-T${prNumber}`,
    reviewState: "success",
    checksState: "green",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: new Date(NOW - 3_600_000).toISOString(),
    headSha: `head${prNumber}`,
    autoMergeArmed: false,
    mergeState: "clean",
    changedFiles: [MINE],
    ...over,
  };
}

type Row = Record<string, unknown>;

/** One ledger shared across passes, an update-branch spy, and every other effect inert. */
function board(seed: Row[] = []) {
  const rows: Row[] = [...seed];
  const updated: ArmedStalledPr[] = [];
  const deps = (over: Partial<SweepDeps> = {}): SweepDeps => ({
    arm: () => {},
    close: () => {},
    dispatchFix: () => {},
    escalate: () => {},
    ledgerPath: "/tmp/rmd-w1-t7735-ledger.ndjson",
    runId: "SWEEP-W1-T7735",
    now: () => NOW,
    readLedger: () => [...rows] as never,
    appendLine: (_path, row) => { rows.push({ ...row, ts: new Date(NOW).toISOString() }); },
    updateBranch: (target) => { updated.push(target); return "updated"; },
    ...over,
  });
  const decided = () => rows.filter((r) => r.step === REFRESH_DECIDED_STEP);
  return { rows, updated, deps, decided };
}

const value = (over: Partial<RefreshValueInput> = {}): RefreshValueInput => ({
  path: "general", directOverlap: [], ambiguousOverlap: [], overlapUnknown: false, strict: false, ciInFlight: false,
  ciMinutes: DEFAULT_CI_MINUTES, queueDepth: 1, boardSize: 5, hitRate: 1, ...over,
});

test("W1-T7735: under non-strict protection a ready PR with no overlap with main delta is not refreshed", async () => {
  // An armed, ready PR 12 behind main, and main's delta touches none of its files.
  const ready = pr(7001, { autoMergeArmed: true, mergeState: "behind" });
  const behindMainByPr = new Map([[7001, 12]]);
  const baseChangedFilesByPr = new Map<number, BaseChangedFiles>([[7001, { files: ["src/other.ts"], truncated: false }]]);
  const b = board();
  await runSweep([ready], b.deps({ behindMainByPr, baseChangedFilesByPr, readBranchProtectionStrict: () => false }), POLICY);
  assert.deepEqual(b.updated, [], "staleness alone bought a CI run under non-strict protection");
  const [row] = b.decided();
  assert.equal(row?.decision, "skip");
  assert.equal(row?.overlap, "none");
  assert.equal(row?.strict, false);
  assert.equal(row?.pr_number, 7001);
  assert.match(String(row?.reason), /not strict.*do not overlap main's delta/);
  assert.equal(typeof row?.predicted_cost_ci_min, "number");

  // An unchanged decision is written once, not once per pass.
  await runSweep([ready], b.deps({ behindMainByPr, baseChangedFilesByPr, readBranchProtectionStrict: () => false }), POLICY);
  assert.equal(b.decided().length, 1);

  // With no file facts at all, the overlap is ambiguous: a judge that rules it independent keeps the PR put.
  const legacy = board();
  const judged: number[] = [];
  await runSweep([ready], legacy.deps({
    behindMainByPr, readBranchProtectionStrict: () => false,
    judgeRefreshOverlap: async (input) => { judged.push(input.prNumber); return "independent"; },
  }), POLICY);
  assert.deepEqual(legacy.updated, []);
  assert.deepEqual(judged, [7001]);
  assert.equal(legacy.decided()[0]?.judge_verdict, "independent");

  // Under strict protection the same PR is refreshed: GitHub needs the base current to merge.
  const strict = board();
  await runSweep([ready], strict.deps({ behindMainByPr, baseChangedFilesByPr, readBranchProtectionStrict: () => true }), POLICY);
  assert.deepEqual(strict.updated.map((t) => t.prNumber), [7001]);
  assert.equal(strict.decided()[0]?.decision, "refresh");
});

test("W1-T7735: an overlapping ready PR is refreshed once and its decision row names the overlap", async () => {
  const ready = pr(7002);
  const behindMainByPr = new Map([[7002, 3]]);
  const baseChangedFilesByPr = new Map<number, BaseChangedFiles>([[7002, { files: ["src/other.ts", MINE], truncated: false }]]);
  const b = board();
  const sweepDeps = () => b.deps({ behindMainByPr, baseChangedFilesByPr, readBranchProtectionStrict: () => false });
  await runSweep([ready], sweepDeps(), POLICY);
  assert.deepEqual(b.updated.map((t) => t.prNumber), [7002]);
  const [row] = b.decided();
  assert.equal(row?.decision, "refresh");
  assert.equal(row?.overlap, "direct");
  assert.deepEqual(row?.overlap_files, [MINE]);
  assert.equal(row?.overlap_count, 1);
  assert.equal(row?.path, "general");
  // The decision is written before the press.
  const decidedAt = b.rows.indexOf(row!);
  const attemptedAt = b.rows.findIndex((r) => r.step === "sweep.update_branch.attempted");
  assert.ok(decidedAt >= 0 && decidedAt < attemptedAt);

  // The same head on the next pass is not refreshed again.
  await runSweep([ready], sweepDeps(), POLICY);
  assert.equal(b.updated.length, 1);

  // Once the refreshed head goes red, the outcome row joins the decision as a hit.
  const outcomes = refreshOutcomesDue(b.rows, [{ ...ready, headSha: "head7002-refreshed", checksState: "red" }], "green", "R", NOW);
  assert.equal(outcomes[0]?.decision_id, row?.decision_id);
  assert.equal(outcomes[0]?.outcome, "refreshed-head-red");
  assert.equal(outcomes[0]?.hit, true);
  // Overlaps that changed nothing lower the benefit weight, and no fixed threshold is involved.
  const misses = Array.from({ length: 9 }, () => ({ step: "sweep.refresh.outcome", overlap: "direct", hit: false }));
  assert.equal(refreshHitRate(misses), 0.1);
  assert.equal(decideRefresh(value({ directOverlap: [MINE], hitRate: 0.1, queueDepth: 4, boardSize: 5 })).decision, "skip");
});

test("W1-T7735: a PR with CI in flight is not refreshed unless the judge rules overlap", async () => {
  const inFlight = value({ ciInFlight: true, directOverlap: [MINE], strict: true });
  assert.equal(decideRefresh(inFlight).decision, "ask-judge");
  assert.equal(decideRefresh({ ...inFlight, judgeVerdict: "independent" }).decision, "skip");
  assert.equal(decideRefresh({ ...inFlight, judgeVerdict: "judge-unavailable" }).decision, "skip");
  assert.equal(decideRefresh({ ...inFlight, judgeVerdict: "overlap" }).decision, "refresh");

  // Through the sweep: a requested refresh of a PR whose CI is mid-run.
  const pending = pr(7003, { checksState: "pending", reviewState: "none" });
  const requests = refreshRequestRows([7003], "operator", "OP", "2026-10-12T00:00:00Z");
  for (const verdict of ["independent", "overlap"] as const) {
    const b = board(requests);
    await runSweep([pending], b.deps({ judgeRefreshOverlap: async () => verdict }), POLICY);
    const [row] = b.decided();
    assert.equal(row?.ci_in_flight, true);
    assert.equal(row?.judge_verdict, verdict);
    assert.deepEqual(b.updated.map((t) => t.prNumber), verdict === "overlap" ? [7003] : [], verdict);
  }

  // A judge failure is visible as judge-unavailable, never a silent refresh.
  const failing = board(requests);
  await runSweep([pending], failing.deps({ judgeRefreshOverlap: async () => { throw new Error("model down"); } }), POLICY);
  assert.deepEqual(failing.updated, []);
  assert.equal(failing.decided()[0]?.judge_verdict, "judge-unavailable");
});

test("W1-T7735: a board-wide refresh request is paced through the daemon lane, never fanned out at once", async () => {
  const red = pr(7010, { checksState: "red", reviewState: "none" });
  const awaitingReview = pr(7011, { reviewState: "pending" });
  const ready = pr(7012);
  assert.deepEqual([ready, awaitingReview, red].map(closenessToMerge), [0, 1, 3]);
  // The request writes rows and presses nothing.
  const requests = refreshRequestRows([7010, 7011, 7012], "operator", "OP", "2026-10-12T00:00:00Z");
  assert.equal(requests.length, 3);
  const b = board(requests);
  const perPass: number[][] = [];
  for (let pass = 0; pass < 4; pass++) {
    const before = b.updated.length;
    await runSweep([red, awaitingReview, ready], b.deps(), POLICY);
    perPass.push(b.updated.slice(before).map((t) => t.prNumber));
  }
  // One per pass, ready and reviewed first, then green awaiting review, then red, then nothing.
  assert.deepEqual(perPass, [[7012], [7011], [7010], []]);
  assert.ok(b.decided().every((r) => typeof r.request_id === "string"));
  assert.deepEqual(b.rows.filter((r) => r.step === "sweep.update_branch.attempted").map((r) => r.request_id),
    requests.slice().reverse().map((r) => r.request_id));
});
