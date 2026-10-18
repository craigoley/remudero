import assert from "node:assert/strict";
import test from "node:test";

import * as sweep from "#test/helpers/sweep-test.js";
import {
  BASE_RED_REFRESH_STEP,
  BASE_RED_STOOD_DOWN_STEP,
  DEFAULT_SWEEP_POLICY,
  runSweep,
  runSweepLightPass,
  type OpenPrView,
  type SweepDeps,
} from "#test/helpers/sweep-test.js";

// W1-T9595 — on 2026-10-14 #11776 and #11777 were held 13 dispositions each (20:20-21:56Z) while the
// sweep's one `baseRedRefreshPr` slot went to one other PR per full pass. Main's fix had already
// landed. These fixtures drive the real `runSweep` with in-memory ledger and effect fakes.

const NOW = Date.parse("2026-10-15T15:30:00Z");
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const MAIN_GREEN = "c".repeat(40);
const FILE = "test/a-ci-friction-cause-owned-by-a-test-alone-escalates-as-no-owner.test.ts";
const ADMISSION_STEP = "sweep.base_red.refresh_admission";
const FORCED_BY = "base-fixed-admission";
type Row = Record<string, unknown>;

function redPr(prNumber: number, headChar: string, createdMinutesAgo: number, over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber, prUrl: `https://github.com/acme/remudero/pull/${prNumber}`, taskId: `W1-T${prNumber}`,
    reviewState: "pending", checksState: "red", unmetCriteria: [], priorStrikes: 0,
    createdAt: ago(createdMinutesAgo), lastActivityAt: ago(1), headSha: headChar.repeat(40),
    headRefName: `run-W1-T${prNumber}-1`, autoMergeArmed: false,
    ciFailures: [{ name: "ci", logTail: `not ok 1 - ${FILE}`, conclusion: "FAILURE" }], ...over,
  };
}

// Held heads t1 < t2 < t3, walked t3, t1, t2 (the walk takes the oldest-created PR first).
const T1 = 11989;
const T2 = 12000;
const T3 = 12007;
const REFUSED = 12019;
const EARLIER = 11950;
const held = () => [redPr(T3, "3", 300), redPr(T1, "1", 200), redPr(T2, "2", 100)];
const refusedPr = () => redPr(REFUSED, "9", 50);

/** An earlier admission's refresh of `EARLIER` from head `e…` that held this board; the snapshot decides whether its CI started. */
function earlierAdmission(started: boolean): OpenPrView {
  return redPr(EARLIER, "f", 400, { checksState: "pending", ciFailures: [], ...(started ? { checksPendingSince: ago(2) } : {}) });
}

function ledger(): Row[] {
  return [
    { step: "main.health.observed", ts: ago(30), sha: MAIN_GREEN, state: "green", failing_checks: [] },
    { step: BASE_RED_STOOD_DOWN_STEP, ts: ago(90), pr_number: T1, head_sha: "1".repeat(40), check_name: "ci" },
    { step: BASE_RED_STOOD_DOWN_STEP, ts: ago(80), pr_number: T2, head_sha: "2".repeat(40), check_name: "ci" },
    { step: BASE_RED_STOOD_DOWN_STEP, ts: ago(70), pr_number: T3, head_sha: "3".repeat(40), check_name: "ci" },
    { step: BASE_RED_STOOD_DOWN_STEP, ts: ago(120), pr_number: REFUSED, head_sha: "9".repeat(40), check_name: "ci" },
    { step: BASE_RED_REFRESH_STEP, ts: ago(20), pr_number: EARLIER, head_sha: "e".repeat(40), outcome: "updated", forced_by: FORCED_BY },
    { step: ADMISSION_STEP, ts: ago(20), signal: "slow-start", width: 1,
      admitted: [{ pr_number: EARLIER, head_sha: "e".repeat(40), arm: "base-red", outcome: "updated" }],
      waiting: [[T1, "1"], [T2, "2"], [T3, "3"]].map(([n, c]) => ({ pr_number: n, head_sha: String(c).repeat(40), arm: "base-red" })) },
  ];
}

/** The same board with no earlier admission at all: there is no uptake signal to widen from. */
const unseen = () => ledger().filter((row) => row.pr_number !== EARLIER && row.step !== ADMISSION_STEP);
/** A head the admission refreshed: its new head `a…`/`b…` shows CI started, or not. */
const moved = (n: number, c: string, started: boolean) =>
  redPr(n, c, 200, { checksState: "pending", ciFailures: [], ...(started ? { checksPendingSince: ago(1) } : {}) });

async function pass(prs: OpenPrView[], rows: Row[], over: Partial<SweepDeps> = {}) {
  const updated: number[] = [];
  const dispatched: number[] = [];
  const merged: number[] = [];
  await runSweep(prs, {
    arm: () => {}, close: () => {}, escalate: () => {}, postReview: async () => {},
    dispatchFix: (pr) => { dispatched.push(pr.prNumber); },
    updateBranch: (pr) => { updated.push(pr.prNumber); return "updated"; },
    // assessRefresh's trial merge: every held head's failing file passes on main, except the refused one.
    reproduceFailingTestsOnMerge: async (pr, files) => {
      merged.push(pr.prNumber);
      return files.map((file) => ({ file, outcome: pr.prNumber === REFUSED ? "fails" : "passes", duration_ms: 5, cached: false }));
    },
    ledgerPath: "/dev/null/w1-t9595.ndjson", runId: "W1-T9595-test", now: () => NOW,
    readLedger: () => [...rows], appendLine: (_path, row) => { rows.push(row); },
    ...over,
  }, DEFAULT_SWEEP_POLICY);
  const disposed = (n: number) => String(rows.findLast((r) => r.step === "sweep.disposed" && r.pr_number === n)?.stand_down_reason);
  const admission = rows.findLast((r) => r.step === ADMISSION_STEP);
  return { updated, dispatched, merged, disposed, admission };
}

const numbers = (entries: unknown) => (entries as Row[] | undefined)?.map((e) => e.pr_number);

test("W1-T9595: slow start admits the oldest-held head first, then twice as many while CI takes them", async () => {
  const rows = unseen();
  // EARLIER is only a pending bystander here: with no admission row it carries no uptake signal.
  const r = await pass([...held(), refusedPr(), earlierAdmission(true)], rows);
  assert.deepEqual(r.updated, [T1], "no uptake signal yet: the oldest held head alone, not walk order and not the whole board");
  assert.deepEqual(r.dispatched, []);
  // assessRefresh is consulted for each held head, and its refusal is never admitted.
  assert.deepEqual([...r.merged].sort(), [T1, T2, T3, REFUSED].sort());
  assert.match(r.disposed(REFUSED), /base red refresh refused: merged-probe/);
  assert.match(r.disposed(T1), /main is green at c+, so the branch refresh was requested \(updated\)/);
  for (const n of [T2, T3]) assert.match(r.disposed(n), new RegExp(`waiting for refresh admission behind #${T1} \\(slow start`));
  assert.equal(r.admission?.signal, "slow-start");
  assert.equal(r.admission?.width, 1);
  assert.deepEqual(numbers(r.admission?.admitted), [T1]);
  assert.deepEqual(numbers(r.admission?.waiting), [T2, T3]);
  assert.deepEqual(numbers(r.admission?.refused), [REFUSED]);
  assert.equal(r.admission?.oldest_held_since, ago(90));

  // The second reading: T1's refreshed head has started CI, so the pass admits twice as many, oldest first.
  const board = [moved(T1, "a", true), redPr(T2, "2", 100), redPr(T3, "3", 300), refusedPr(), earlierAdmission(true)];
  const second = await pass(board, rows);
  assert.deepEqual(second.updated, [T2, T3]);
  for (const n of [T2, T3]) assert.match(second.disposed(n), /main is green at c+, so the branch refresh was requested \(updated\)/);
  assert.equal(second.admission?.signal, "clear");
  assert.equal(second.admission?.width, 2);
  assert.deepEqual(second.admission?.ci_started, [{ pr_number: T1, head_sha: "1".repeat(40) }]);
  const refreshes = rows.filter((row) => row.step === BASE_RED_REFRESH_STEP && row.forced_by === FORCED_BY);
  assert.deepEqual(refreshes.map((row) => row.pr_number), [T1, T2, T3]);

  // A head refreshed once is never admitted again on that head.
  assert.deepEqual((await pass([...held(), refusedPr(), earlierAdmission(true)], rows)).updated, []);

  // A board a later main fix holds starts slow again: the width learned on a drained board does not carry over.
  const T4 = 12030;
  const T5 = 12031;
  rows.push(...[[T4, "4"], [T5, "5"]].map(([n, c], i) => ({ step: BASE_RED_STOOD_DOWN_STEP, ts: ago(10 - i), pr_number: n,
    head_sha: String(c).repeat(40), check_name: "ci" })));
  const next = await pass([moved(T2, "b", true), moved(T3, "d", true), redPr(T4, "4", 40), redPr(T5, "5", 30), earlierAdmission(true)], rows);
  assert.deepEqual(next.updated, [T4]);
  assert.equal(next.admission?.signal, "slow-start");

  // A stalled own-red the admission refreshed is recorded as a fixed-on-main stage, never escalated.
  const STALLED = 12045;
  const stalledRows: Row[] = [...ledger(), { ts: ago(50), run_id: "old", task_id: `W1-T${STALLED}`, step: "sweep.disposed",
    pr_number: STALLED, head_sha: "5".repeat(40), disposition: "blocked-fixable", acted: false, blocker: "own-red", blocker_since: ago(50) }];
  const escalated: string[] = [];
  const stalled = await pass([redPr(STALLED, "5", 60), earlierAdmission(true)], stalledRows, {
    readMainTip: () => MAIN_GREEN, behindMainByPr: new Map([[STALLED, 3]]), escalate: (_pr, reason) => { escalated.push(reason); },
    reproduceFailingTestsOnMain: async (_pr, files) => files.map((file) => ({ file, outcome: "passes", duration_ms: 5, cached: false })),
  });
  assert.deepEqual(stalled.updated, [STALLED]);
  assert.deepEqual(escalated, []);
  const stage = stalledRows.find((row) => row.step === "pr.stuck" && row.pr_number === STALLED);
  assert.equal(stage?.diagnosis, "fixed-on-main");
  assert.equal(stage?.refresh_outcome, "updated");
});

test("W1-T9595: a refresh whose CI has not started holds the next admission and names that PR", async () => {
  const rows = ledger();
  const waiting = await pass([...held(), earlierAdmission(false)], rows);
  assert.deepEqual(waiting.updated, [], "an earlier admission still waiting for a runner holds every candidate");
  for (const n of [T1, T2, T3]) {
    assert.match(waiting.disposed(n), new RegExp(`waiting for refresh admission behind #${EARLIER} \\(its CI has not started\\)`));
  }
  assert.equal(waiting.admission?.signal, "waiting");
  assert.deepEqual(waiting.admission?.ci_not_started, [EARLIER]);
  assert.deepEqual(numbers(waiting.admission?.waiting), [T3, T1, T2]);
  assert.deepEqual(numbers(waiting.admission?.admitted), []);
  // A held head is assessed once per head and main, not on every pass it waits.
  assert.deepEqual([...waiting.merged].sort(), [T1, T2, T3].sort());
  const stillWaiting = await pass([...held(), earlierAdmission(false)], rows);
  assert.deepEqual(stillWaiting.merged, []);
  assert.deepEqual(stillWaiting.updated, []);

  // The second reading: that refresh's CI has started, so twice its one head is admitted, oldest first.
  const started = await pass([...held(), earlierAdmission(true)], rows);
  assert.deepEqual(started.updated, [T1, T2]);
  assert.match(started.disposed(T3), new RegExp(`waiting for refresh admission behind #${T1}, #${T2} \\(this pass's width of 2 is full\\)`));

  // An unreadable reading (the snapshot never saw the earlier refresh move its head) admits the oldest only.
  const unread = await pass([...held(), redPr(EARLIER, "e", 400, { checksState: "pending", ciFailures: [] })], ledger());
  assert.deepEqual(unread.updated, [T1]);
  assert.equal(unread.admission?.signal, "unreadable");
  assert.match(unread.disposed(T2), new RegExp(`waiting for refresh admission behind #${T1} \\(signal unreadable`));
  assert.deepEqual(numbers(unread.admission?.waiting), [T2, T3]);
});

test("W1-T9595: a light pass refreshes a held head only through one admission over its snapshot", async () => {
  const rows = ledger();
  await pass([...held(), earlierAdmission(false)], rows);
  const board = [...held(), earlierAdmission(true)];
  const updated: number[] = [];
  const deps = {
    ledgerPath: "/dev/null/w1-t9595.ndjson", runId: "W1-T9595-light", readLedger: () => [...rows],
    appendLine: (_path: string, row: Row) => { rows.push(row); },
    updateBranch: (pr: { prNumber: number }) => {
      updated.push(pr.prNumber);
      if (pr.prNumber === T2) throw new Error("422 merge conflict");
      return "updated" as const;
    },
  };
  // The per-PR fan-out never refreshes: W1-T528 keeps `updateBranch` off it.
  await runSweepLightPass(board, { ...deps, updateBranch: undefined, arm: () => {}, close: () => {}, escalate: () => {},
    postReview: async () => {}, dispatchFix: () => {}, now: () => NOW } as SweepDeps, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(updated, []);
  const admit = sweep.runLightPassRefreshAdmission;
  assert.equal(typeof admit, "function", "the light pass has one admission call over its whole snapshot");
  assert.deepEqual(await admit(board, deps), [T1, T2]);
  assert.deepEqual(updated, [T1, T2]);
  const light = rows.filter((row) => row.step === BASE_RED_REFRESH_STEP && row.surface === "light");
  assert.deepEqual(light.map((row) => [row.pr_number, row.forced_by, row.outcome]),
    [[T1, FORCED_BY, "updated"], [T2, FORCED_BY, "error: 422 merge conflict"]]);
  assert.equal(rows.findLast((row) => row.step === ADMISSION_STEP)?.surface, "light");
  // Either pass reads the same fold: a refreshed head is never admitted twice, and T1's unstarted CI holds T3.
  const after = [moved(T1, "a", false), ...held().filter((pr) => pr.prNumber !== T1), earlierAdmission(true)];
  assert.deepEqual(await admit(after, deps), []);
  const full = await pass(after, rows);
  assert.deepEqual(full.updated, []);
  assert.match(full.disposed(T3), new RegExp(`waiting for refresh admission behind #${T1} \\(its CI has not started\\)`));
  assert.deepEqual(updated, [T1, T2]);
});

test("W1-T9595: an unwired surface and a paced admission give different stand-down reasons", async () => {
  const unwired = await pass([...held(), earlierAdmission(true)], ledger(), { updateBranch: undefined });
  const paced = await pass([...held(), earlierAdmission(false)], ledger());
  const unwiredReason = unwired.disposed(T2);
  const pacedReason = paced.disposed(T2);
  assert.match(unwiredReason, /the branch refresh is unwired on this surface \(no updateBranch\)/);
  assert.match(pacedReason, new RegExp(`waiting for refresh admission behind #${EARLIER}`));
  assert.notEqual(unwiredReason, pacedReason);
  for (const reason of [unwiredReason, pacedReason]) assert.doesNotMatch(reason, /spent or unwired/);

  // The same two texts on the base-fixed arm: a head behind a main whose probe passes its failing file.
  const FIXED = 12044;
  const probed = {
    readMainTip: () => MAIN_GREEN, behindMainByPr: new Map([[FIXED, 3]]),
    reproduceFailingTestsOnMain: async (_pr: OpenPrView, files: readonly string[]) =>
      files.map((file) => ({ file, outcome: "passes" as const, duration_ms: 5, cached: false })),
  };
  const fixedUnwired = await pass([redPr(FIXED, "4", 60), earlierAdmission(true)], ledger(), { ...probed, updateBranch: undefined });
  const fixedPaced = await pass([redPr(FIXED, "4", 60), earlierAdmission(false)], ledger(), probed);
  assert.match(fixedUnwired.disposed(FIXED), /already fixed on main c+; the branch refresh is unwired on this surface \(no updateBranch\)/);
  assert.match(fixedPaced.disposed(FIXED), new RegExp(`already fixed on main c+; waiting for refresh admission behind #${EARLIER}`));
  assert.deepEqual(fixedPaced.updated, []);
});
