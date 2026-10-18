import assert from "node:assert/strict";
import test from "node:test";

import { createRefreshAdmission, DEFAULT_SWEEP_POLICY, runSweep, type OpenPrView } from "#test/helpers/sweep-test.js";

const NOW = Date.parse("2026-10-17T10:00:00Z");
const MAIN = "c".repeat(40);
const FILE = "test/a-ci-friction-cause-owned-by-a-test-alone-escalates-as-no-owner.test.ts";
const ADMISSION = "sweep.base_red.refresh_admission";
type Row = Record<string, unknown>;

function redPr(prNumber: number, age: number, file = FILE): OpenPrView {
  return {
    prNumber, prUrl: `https://github.com/acme/remudero/pull/${prNumber}`, taskId: `W1-T${prNumber}`,
    reviewState: "pending", checksState: "red", unmetCriteria: [], priorStrikes: 0,
    createdAt: new Date(NOW - age * 60_000).toISOString(), lastActivityAt: new Date(NOW).toISOString(),
    headSha: String(prNumber).padStart(40, "a"), headRefName: `run-W1-T${prNumber}-1`,
    autoMergeArmed: false,
    ciFailures: [{ name: "ci", logTail: `not ok 1 - ${file}`, conclusion: "FAILURE" }],
  };
}

function blockedPass(prs: OpenPrView[]) {
  let enterSlow!: () => void;
  let releaseSlow!: () => void;
  const slowEntered = new Promise<void>((resolve) => { enterSlow = resolve; });
  const release = new Promise<void>((resolve) => { releaseSlow = resolve; });
  const rows: Row[] = [];
  const updated: number[] = [];
  const slow = prs.at(-1)!.prNumber;
  const bystander = { ...redPr(12000, 1), checksState: "pending" as const, ciFailures: [] };
  const running = runSweep([...prs, bystander], {
    arm: () => {}, close: () => {}, escalate: () => {}, postReview: async () => {}, dispatchFix: () => {},
    updateBranch: (pr) => { updated.push(pr.prNumber); return "updated"; },
    readMainTip: () => MAIN, behindMainByPr: new Map(prs.map((pr) => [pr.prNumber, 3])),
    reproduceFailingTestsOnMain: async (pr, files) => {
      if (pr.prNumber === slow) { enterSlow(); await release; }
      return files.map((file) => ({ file, outcome: "passes", duration_ms: 5, cached: false }));
    },
    reproduceFailingTestsOnMerge: async (_pr, files) =>
      files.map((file) => ({ file, outcome: "passes", duration_ms: 5, cached: false })),
    ledgerPath: "/dev/null/w1-t9933.ndjson", runId: "W1-T9933-test", now: () => NOW,
    readLedger: () => [...rows], appendLine: (_path, row) => { rows.push(row); },
  }, DEFAULT_SWEEP_POLICY);
  const blocked = Promise.race([slowEntered, running.then(() => {
    throw new Error("the pass finished without reaching the controlled slow action");
  })]);
  return { rows, updated, blocked, finish: async () => { releaseSlow(); await running; } };
}

test("W1-T9933: a cleared refresh within the width is pressed before the pass finishes", async () => {
  const pass = blockedPass([redPr(12394, 120), redPr(12395, 60, "test/sweep-age-clamp.test.ts")]);
  try {
    await pass.blocked;
    assert.deepEqual([...pass.updated], [12394], "the cleared head must refresh while the later probe is blocked");
    const refreshed = pass.rows.find((row) => row.step === "sweep.base_fixed.refresh" && row.pr_number === 12394);
    assert.equal(refreshed?.outcome, "updated");
    const disposed = pass.rows.filter((row) => row.step === "sweep.disposed" && row.pr_number === 12394);
    assert.equal(disposed.length, 1);
    assert.match(String(disposed[0].stand_down_reason), /branch refresh requested \(updated\)/);
    assert.equal(pass.rows.filter((row) => row.step === ADMISSION).length, 0);
  } finally { await pass.finish(); }
});

test("W1-T9933: a candidate past the width is held and one admission row names both", async () => {
  const pass = blockedPass([redPr(12401, 180), redPr(12402, 120, "test/sweep-blocked-routing.test.ts"),
    redPr(12403, 60, "test/sweep-age-clamp.test.ts")]);
  try {
    await pass.blocked;
    assert.deepEqual([...pass.updated], [12401], "slow start spends its one slot before the later action");
  } finally { await pass.finish(); }
  assert.deepEqual(pass.updated, [12401]);
  const admissions = pass.rows.filter((row) => row.step === ADMISSION);
  assert.equal(admissions.length, 1);
  assert.equal(admissions[0].signal, "slow-start");
  assert.equal(admissions[0].width, 1);
  assert.deepEqual((admissions[0].admitted as Row[]).map((row) => [row.pr_number, row.outcome]), [[12401, "updated"]]);
  assert.deepEqual((admissions[0].waiting as Row[]).map((row) => row.pr_number), [12402, 12403]);
  for (const n of [12402, 12403]) {
    const disposed = pass.rows.filter((row) => row.step === "sweep.disposed" && row.pr_number === n);
    assert.equal(disposed.length, 1);
    assert.match(String(disposed[0].stand_down_reason), /waiting for refresh admission behind #12401/);
  }
});

test("W1-T9933: cohort width is spent on entry and overflow stays oldest-held-first", async () => {
  const prs = [redPr(12501, 180), redPr(12502, 120), redPr(12503, 60), redPr(12504, 30)];
  const admission = createRefreshAdmission({ signal: "clear", cohort: 1, notStarted: [], unreadable: [], started: [],
    carried: new Set([`${prs[0].prNumber}@${prs[0].headSha}`]) }, "full", prs);
  const updated: number[] = [];
  const settled = new Map<number, { outcome: string } | { hold: string }>();
  for (const [index, pr] of prs.entries()) {
    await admission.enter({ pr, arm: "base-fixed", heldSinceMs: NOW - [10, 20, 30, 40][index] * 60_000,
      row: { run_id: "W1-T9933-test", task_id: pr.taskId!, step: "sweep.base_fixed.refresh" },
      refresh: async () => { updated.push(pr.prNumber); return "updated"; },
      settle: (verdict) => { settled.set(pr.prNumber, verdict); } });
  }
  assert.deepEqual(updated, [12501, 12502]);
  assert.deepEqual([...settled.keys()], [12501, 12502]);
  const rows: Row[] = [];
  assert.deepEqual(await admission.run((row) => { rows.push(row); }, "W1-T9933-test"), [12501, 12502]);
  assert.deepEqual(updated, [12501, 12502], "final reporting never presses a head twice");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].width, 2);
  assert.equal(rows[0].signal, "clear");
  assert.deepEqual((rows[0].waiting as Row[]).map((row) => row.pr_number), [12504, 12503]);
  assert.deepEqual(settled.get(12504), { hold: "waiting for refresh admission behind #12501, #12502 (this pass's width of 2 is full)" });
});
