import assert from "node:assert/strict";
import test from "node:test";

import {
  BASE_RED_REFRESH_ADMISSION_STEP, createRefreshAdmission, refreshAdmissionReading, type OpenPrView,
} from "#test/helpers/sweep-test.js";

const BEFORE = "0c535ce0".padEnd(40, "0");
const REFRESHED = "9601162d".padEnd(40, "0");
const PUSHED_AGAIN = "2410e623".padEnd(40, "0");
type Row = Record<string, unknown>;

function view(prNumber: number, headSha: string, over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber, prUrl: `https://github.com/acme/remudero/pull/${prNumber}`, taskId: `W1-T${prNumber}`,
    reviewState: "pending", checksState: "none", unmetCriteria: [], priorStrikes: 0,
    createdAt: "2026-10-16T19:00:00Z", lastActivityAt: "2026-10-16T20:40:00Z", headSha, headRefName: `run-W1-T${prNumber}-1`,
    autoMergeArmed: false, ...over,
  };
}

const admissionRow = (admitted: Row): Row => ({
  step: BASE_RED_REFRESH_ADMISSION_STEP, signal: "slow-start", width: 1, admitted: [admitted], waiting: [],
});
const cohortEntry = (extra: Row = {}): Row => ({ pr_number: 12394, head_sha: BEFORE, arm: "base-red", outcome: "updated", ...extra });

test("W1-T9949: a cohort PR pushed again after its refresh does not hold the admission", async () => {
  const lines = [admissionRow(cohortEntry({ refreshed_head: REFRESHED }))];
  const pushedAgain = view(12394, PUSHED_AGAIN, { checksState: "none" });
  const reading = refreshAdmissionReading([pushedAgain], lines);
  assert.deepEqual(reading.notStarted, []);
  assert.deepEqual(reading.started, [{ pr_number: 12394, head_sha: BEFORE }]);
  assert.notEqual(reading.signal, "waiting");

  const heldPr = view(12388, "c12de974".padEnd(40, "0"), { checksState: "red" });
  const admission = createRefreshAdmission(reading, "full", [pushedAgain, heldPr]);
  const pressed: number[] = [];
  await admission.enter({ pr: heldPr, arm: "base-red" as never, heldSinceMs: Date.parse("2026-10-16T19:32:05Z"), row: { step: "x" } as never,
    refresh: async () => { pressed.push(12388); return "updated"; }, settle: () => {} });
  assert.deepEqual(pressed, [12388], "the held candidate is admitted in the pass that reads the cohort PR's later push");
  assert.equal(admission.holding(), false);
});

test("W1-T9949: a post-refresh head whose CI has not started still holds the admission", () => {
  const lines = [admissionRow(cohortEntry({ refreshed_head: REFRESHED }))];
  const reading = refreshAdmissionReading([view(12394, REFRESHED, { checksState: "none" })], lines);
  assert.equal(reading.signal, "waiting");
  assert.deepEqual(reading.notStarted, [12394]);
  // a row that never recorded the post-refresh head cannot tell a later push, so it keeps holding
  const legacy = refreshAdmissionReading([view(12394, PUSHED_AGAIN, { checksState: "none" })], [admissionRow(cohortEntry())]);
  assert.equal(legacy.signal, "waiting");
  assert.deepEqual(legacy.notStarted, [12394]);
  // the head the refresh never moved is still unreadable
  assert.equal(refreshAdmissionReading([view(12394, BEFORE)], lines).signal, "unreadable");
});

test("W1-T9949: an admitted refresh records the head it produced", async () => {
  const pr = view(12394, BEFORE);
  const run = async (readHead: (pr: OpenPrView) => Promise<string | undefined>) => {
    const admission = createRefreshAdmission(refreshAdmissionReading([pr], []), "full", [pr], readHead);
    await admission.enter({ pr, arm: "base-red" as never, heldSinceMs: Infinity, row: { step: "x" } as never,
      refresh: async () => "updated", settle: () => {} });
    const rows: Row[] = [];
    await admission.run((row) => rows.push(row as Row), "run");
    return (rows[0].admitted as Row[])[0];
  };
  assert.equal((await run(async () => REFRESHED)).refreshed_head, REFRESHED);
  assert.equal((await run(async () => BEFORE)).refreshed_head, undefined, "a head the refresh has not yet moved records nothing");
  const failed = await run(async () => { throw new Error("read failed"); });
  assert.equal(failed.refreshed_head, undefined);
  assert.equal(failed.refreshed_head_unread, "read failed");
});
