import assert from "node:assert/strict";
import test from "node:test";

import * as reproduction from "../src/lib/base-reproduction.js";
import type { BaseProbeFile, BaseProbeResult } from "../src/lib/base-reproduction.js";
import {
  BASE_RED_REFRESH_STEP, BASE_RED_STOOD_DOWN_STEP, DEFAULT_SWEEP_POLICY, baseRedHistoryFromLedger, decideBaseRed,
  mainLatestRunFromLedger, runSweep, type OpenPrView, type SweepDeps,
} from "./helpers/sweep-test.js";

// W1-T6024: on 2026-10-06 main failed two tests under `ci`/`ci-shard (n/8)` while #9566 and #9567
// failed the same two under `coverage-ratchet`. The check-name classifier never matched, so the
// base-red verdict below is decided by WHICH TEST FILES fail, not by what the check is called.

type Row = Record<string, unknown>;
const NOW = Date.now();
const [M1, M2, M3, M4] = ["1", "2", "3", "4"].map((c) => c.repeat(40)) as [string, string, string, string];
const FILE_A = "test/state-dir-scope.test.ts";
const FILE_B = "test/daemon-tick.test.ts";
const MAIN_PASSES = "test/only-this-diff-breaks.test.ts";
const MAIN_CHECKS = ["ci", "ci-shard (1/8)", "coverage-ratchet", "ci-gate"];

// The (exported, name-agnostic) folds this task adds. Read through the namespace so this file
// loads at base, where they do not exist yet, and fails on its assertions rather than at import.
const known = reproduction as unknown as {
  mainFailingTestFiles?: (lines: readonly Row[]) => Set<string>;
};

function pr(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 9567, prUrl: "https://github.com/craigoley/remudero/pull/9567", taskId: "W1-T9567",
    reviewState: "pending", checksState: "red", unmetCriteria: [], priorStrikes: 0,
    lastActivityAt: new Date(NOW - 60_000).toISOString(), headSha: "f".repeat(40),
    headRefName: "run-W1-T9567-1", autoMergeArmed: false,
    ciFailures: [{ name: "coverage-ratchet", logTail: `not ok 1 - ${FILE_A}\nnot ok 2 - ${FILE_B}` }], ...over,
  };
}

const peer = (): OpenPrView =>
  pr({ prNumber: 6000, taskId: "W1-T6000", headSha: "e".repeat(40), checksState: "green", reviewState: "success", ciFailures: [] });

const undetermined = (sha: string): Row => ({ step: "main.health.observed", sha, state: "undetermined", failing_checks: [] });
const redMain = (sha: string): Row => ({
  step: "main.health.observed", sha, state: "red", failing_checks: ["ci", "ci-shard (1/8)"],
  observed_checks: MAIN_CHECKS, decided_by_sha: sha,
});
const greenMain = (sha: string, decidedBy = sha): Row => ({
  step: "main.health.observed", sha, state: "green", failing_checks: [], observed_checks: MAIN_CHECKS, decided_by_sha: decidedBy,
});
const reproducedRow = (prNumber: number, headSha: string, mainSha: string, files = [FILE_A, FILE_B]): Row => ({
  step: "sweep.base_reproduction", pr_number: prNumber, head_sha: headSha, main_sha: mainSha, verdict: "reproduced",
  files: files.map((file) => ({ file, outcome: "fails", duration_ms: 0, cached: false })),
});

type Probe = (files: readonly string[], sha: string) => BaseProbeResult;
const allFail: Probe = (files) => files.map((file): BaseProbeFile => ({ file, outcome: "fails", duration_ms: 0, cached: false }));
const worktreeAddFails: Probe = () => { throw new Error("git worktree add failed"); };

function harness(rows: Row[]) {
  const fixed: number[] = [];
  const refreshed: number[] = [];
  const probed: string[] = [];
  let tip = M1;
  let probe: Probe = allFail;
  const deps: SweepDeps = {
    arm: () => {}, close: () => {}, escalate: () => {}, postReview: async () => {},
    dispatchFix: (p) => {
      fixed.push(p.prNumber);
      rows.push({ step: "fix.dispatch", task_id: p.taskId, head_sha: p.headSha, strike: 1 });
    },
    updateBranch: (p) => { refreshed.push(p.prNumber); return "updated"; },
    ledgerPath: "/dev/null/w1-t6024.ndjson", runId: "W1-T6024-test", now: () => NOW,
    readLedger: () => [...rows], appendLine: (_path, row) => { rows.push(row); }, readMainTip: () => tip,
    reproduceFailingTestsOnMain: async (_pr, files, sha) => { probed.push(...files); return probe(files, sha); },
  };
  return {
    rows, fixed, refreshed, probed,
    at(sha: string, next: Probe) { tip = sha; probe = next; },
    sweep: (prs: OpenPrView[]) => runSweep([...prs, peer()], deps, DEFAULT_SWEEP_POLICY),
    reason: (n: number) => String([...rows].reverse().find((r) => r.step === "sweep.disposed" && r.pr_number === n)?.stand_down_reason),
  };
}

test("W1-T6024: #9567 stays base red after a later unrunnable probe and takes one refresh once main is green", async () => {
  const h = harness([undetermined(M1)]);
  await h.sweep([pr()]);
  assert.deepEqual(h.fixed, [], "a reproduced probe holds the PR");
  // 13:30Z: main reads red under ci/ci-shard, and coverage-ratchet is a check main's census ran green.
  h.rows.push(redMain(M2));
  h.at(M2, worktreeAddFails);
  await h.sweep([pr()]);
  assert.deepEqual(h.fixed, [], "the unrunnable probe at the next main tip must not route a ci-log fix");
  assert.equal(h.rows.filter((r) => r.step === "sweep.base_reproduction").at(-1)?.verdict, "unrunnable", "it is still recorded");
  assert.match(h.reason(9567), /base red/);
  assert.equal(h.rows.filter((r) => r.step === BASE_RED_STOOD_DOWN_STEP && r.pr_number === 9567).length, 1);
  // A new main head reads undetermined for minutes: still held, still no strike.
  h.rows.push(undetermined(M3));
  h.at(M3, worktreeAddFails);
  await h.sweep([pr()]);
  assert.deepEqual(h.fixed, []);
  assert.deepEqual(h.refreshed, []);
  h.rows.push(greenMain(M4));
  h.at(M4, worktreeAddFails);
  await h.sweep([pr()]);
  assert.deepEqual(h.refreshed, [9567], "one branch refresh once main is green");
  assert.deepEqual(h.fixed, [], "and no fix strike");
  assert.equal(h.rows.filter((r) => r.step === BASE_RED_REFRESH_STEP).length, 1);
  await h.sweep([pr()]);
  assert.deepEqual(h.refreshed, [9567], "the refresh is spent once per head");
});

test("W1-T6024: #9566 is held on files ANOTHER PR's probe reproduced on main, and refreshes once main is green", async () => {
  const head = "6".repeat(40);
  const h = harness([undetermined(M1), reproducedRow(9567, "f".repeat(40), M1), redMain(M2)]);
  h.at(M2, worktreeAddFails);
  const p9566 = pr({ prNumber: 9566, taskId: "W1-T9566", headSha: head });
  await h.sweep([p9566]);
  assert.deepEqual(h.fixed, []);
  assert.match(h.reason(9566), new RegExp(FILE_A));
  h.rows.push(greenMain(M3));
  h.at(M3, (files) => files.map((file): BaseProbeFile => ({ file, outcome: "passes", duration_ms: 0, cached: false })));
  await h.sweep([p9566]);
  assert.deepEqual(h.refreshed, [9566]);
  assert.deepEqual(h.fixed, []);
});

test("W1-T6024: a head reproduced before main went green is refreshed, without a probe, whatever its check is called", async () => {
  const h = harness([undetermined(M1), reproducedRow(9567, "f".repeat(40), M1), greenMain(M2)]);
  h.at(M2, worktreeAddFails);
  await h.sweep([pr()]);
  assert.deepEqual(h.refreshed, [9567]);
  assert.deepEqual(h.fixed, []);
  assert.deepEqual(h.probed, [], "main green and a recorded reproduction decide without a probe");
  const history = baseRedHistoryFromLedger(h.rows);
  assert.deepEqual(decideBaseRed(pr(), mainLatestRunFromLedger(h.rows), history), { kind: "own" }, "one refresh per head");
  assert.deepEqual(decideBaseRed(pr({ ciFailures: [] }), mainLatestRunFromLedger([greenMain(M2)]),
    baseRedHistoryFromLedger([reproducedRow(9567, "f".repeat(40), M1), greenMain(M2)])), { kind: "own" }, "no failing check, nothing to name");
  assert.deepEqual(decideBaseRed(pr(), mainLatestRunFromLedger([greenMain(M2)]),
    baseRedHistoryFromLedger([greenMain(M1), reproducedRow(9567, "f".repeat(40), M2)])), { kind: "own" },
    "a reproduction AFTER main's last green is not yet a red main has shed");
});

test("W1-T6024: a PR failing a test main passes is its own red", async () => {
  const h = harness([undetermined(M1), reproducedRow(9567, "f".repeat(40), M1), redMain(M2)]);
  h.at(M2, worktreeAddFails);
  await h.sweep([pr({ ciFailures: [{ name: "coverage-ratchet", logTail: `not ok 1 - ${FILE_A}\nnot ok 2 - ${MAIN_PASSES}` }] })]);
  assert.deepEqual(h.fixed, [9567], "one failing file main is not known to fail makes the red the diff's");
  const partial = harness([undetermined(M1), reproducedRow(9567, "f".repeat(40), M1), redMain(M2)]);
  partial.at(M2, (files) => files.map((file): BaseProbeFile =>
    ({ file, outcome: file === FILE_A ? "fails" : "passes", duration_ms: 0, cached: false })));
  await partial.sweep([pr({ ciFailures: [{ name: "coverage-ratchet", logTail: `${FILE_A}\n${MAIN_PASSES}` }] })]);
  assert.deepEqual(partial.fixed, [9567], "a partial probe over an unknown file is the diff's red");
});

test("W1-T6024: main observed green on its own head forgets what it failed before", async () => {
  const h = harness([undetermined(M1), reproducedRow(9567, "f".repeat(40), M1), greenMain(M2), redMain(M3)]);
  h.at(M3, worktreeAddFails);
  await h.sweep([pr({ prNumber: 9566, taskId: "W1-T9566", headSha: "6".repeat(40) })]);
  assert.deepEqual(h.fixed, [9566]);
  assert.equal(h.rows.filter((r) => r.step === BASE_RED_STOOD_DOWN_STEP).length, 0);
});

test("W1-T6024: the main-failing fold reads reproduced probes since main's last own-head green", () => {
  const fold = known.mainFailingTestFiles;
  assert.equal(typeof fold, "function", "base-reproduction.ts exports mainFailingTestFiles");
  const rows: Row[] = [
    reproducedRow(1, "h1", M1, ["test/old.test.ts"]),
    greenMain(M2),
    reproducedRow(2, "h2", M2, [FILE_A]),
    { ...reproducedRow(3, "h3", M2, [FILE_B]), verdict: "partial" },
    { step: "sweep.base_reproduction", verdict: "reproduced", files: "not-an-array" },
    { step: "sweep.base_reproduction", verdict: "reproduced", files: [null, { file: 7 }] },
    greenMain(M3, M2),
    { step: "main.health.observed", sha: M4, state: "green" },
  ];
  assert.deepEqual([...fold!(rows.slice(0, 7))].sort(), [FILE_A], "a green decided by an older run is not main's own head");
  assert.deepEqual([...fold!(rows)], [], "a legacy green row with no decided_by_sha is its own head");
});
