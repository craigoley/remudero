import assert from "node:assert/strict";
import { test } from "node:test";
import { readLedgerLines } from "#src/lib/status.js";
import { fleetWithheldStageMs } from "#src/lib/sweep.js";
import { runSweep, type OpenPrView, type SweepDeps } from "#test/helpers/sweep-test.js";
import { writeLedger } from "#test/helpers/ledger-fixture.js";

// 2026-10-14: #11629 went own-red at 09:40Z, an orphaned recycle PAUSE held core from 08:12Z to 10:57Z so no fix
// round was ever dispatched, and at 10:26Z the 45-minute BACKSTOP opened needs-human #11639 over time the fleet withheld.
const now = Date.UTC(2026, 9, 14, 10, 26, 0);
const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
const PAUSE = "fleet PAUSE hold: PAUSE requested: container recycle";
const pr: OpenPrView = {
  prNumber: 11629, prUrl: "https://github.com/craigoley/remudero/pull/11629", taskId: "W1-T9410",
  headSha: "3b421f3", headRefName: "run-W1-T9410-1", reviewState: "pending", checksState: "red",
  unmetCriteria: [], priorStrikes: 0, lastActivityAt: ago(1), autoMergeArmed: false,
  ciFailures: [{ name: "ci", logTail: "not ok 1 - test/x.test.ts" }],
};
const RUN_ID = "test-held";

/** One un-acted own-red pass every `every` minutes from `startMin` ago down to 1 minute ago. */
function passes(startMin: number, every: number, standDown: string | undefined): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (let m = startMin; m >= 1; m -= every) {
    out.push({ ts: ago(m), run_id: "old", task_id: pr.taskId, step: "sweep.disposed", pr_number: pr.prNumber,
      head_sha: pr.headSha, disposition: "blocked-fixable", acted: false, blocker: "own-red",
      blocker_since: ago(startMin), ...(standDown === undefined ? {} : { stand_down_reason: standDown }) });
  }
  return out;
}

/** `hold` set: the fleet withholds workers this pass too. Unset: the pass is not actionable for a reason of its own. */
function fixture(rows: Record<string, unknown>[], hold: string | undefined) {
  const ledger = writeLedger(rows);
  const escalations: string[] = [];
  const deps: SweepDeps = {
    ledgerPath: ledger.path, runId: RUN_ID, now: () => now,
    arm: () => "hold-refused", close: () => {}, dispatchFix: () => {}, postReview: () => {},
    ...(hold === undefined ? { actionable: () => false } : { workerAdmissionHold: () => hold }),
    escalate: (_pr, reason) => { escalations.push(reason); },
  };
  const stuck = () => readLedgerLines(ledger.path).filter(row => row.step === "pr.stuck");
  return { deps, escalations, stuck };
}

test("W1-T9433: an own-red held by a fleet PAUSE is not escalated at its backstop", async () => {
  // 60 minutes old, every pass since stood down on the PAUSE: 59 of those minutes were the fleet's own hold.
  const f = fixture(passes(60, 5, PAUSE), PAUSE);
  await runSweep([pr], f.deps);
  assert.equal(f.stuck().length, 0);
  assert.deepEqual(f.escalations, []);
});

test("W1-T9433: the backstop counts only the time the owner could act", async () => {
  // The PAUSE covered the first 30 minutes; the 30 since it lifted were unheld and exceed nothing alone, but the
  // unheld time at 80 minutes old (50) passes the 45-minute bound.
  const held = passes(80, 5, PAUSE).filter(row => Date.parse(String(row.ts)) < now - 50 * 60_000);
  const free = passes(80, 5, undefined).filter(row => Date.parse(String(row.ts)) >= now - 50 * 60_000);
  const f = fixture([...held, ...free], undefined);
  await runSweep([pr], f.deps);
  const rows = f.stuck();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].bound_kind, "BACKSTOP");
  assert.equal(f.escalations.length, 1);

  // and the same 80-minute stage whose last 50 minutes were also held stays quiet
  const quiet = fixture(passes(80, 5, PAUSE), PAUSE);
  await runSweep([pr], quiet.deps);
  assert.equal(quiet.stuck().length, 0);
});

test("W1-T9433: pr.stuck names the held time it excluded", async () => {
  const held = passes(100, 5, PAUSE).filter(row => Date.parse(String(row.ts)) < now - 50 * 60_000);
  const free = passes(100, 5, undefined).filter(row => Date.parse(String(row.ts)) >= now - 50 * 60_000);
  const f = fixture([...held, ...free], undefined);
  await runSweep([pr], f.deps);
  const row = f.stuck()[0];
  assert.equal(row.held_ms, 50 * 60_000);
  assert.equal(row.blocker_since, ago(100));
  assert.match(f.escalations[0], /the fleet itself withheld the repair for 50 of those minutes/);
});

test("W1-T9433: an acted pass and an unrelated stand-down are not held time", () => {
  const rows = [
    { step: "sweep.disposed", ts: ago(30), acted: true, stand_down_reason: PAUSE },
    { step: "sweep.disposed", ts: ago(20), acted: false, stand_down_reason: "refused-twice: x" },
    { step: "sweep.disposed", ts: ago(10), acted: false, reason: "x — NOT DISPATCHED this pass: deferred to full sweep (light pass)" },
    { step: "sweep.disposed", ts: "not a time", acted: false, stand_down_reason: PAUSE },
  ];
  assert.equal(fleetWithheldStageMs(rows, now), 10 * 60_000);
});

test("semantic review admission waits retain the original unheld stage backstop", async () => {
  // #14277: all three passes withheld this exact head, but its 35-minute stage opened a human ask.
  const observedNow = Date.UTC(2026, 9, 26, 1, 12, 44, 548);
  const since = "2026-10-26T00:37:30.912Z";
  const view: OpenPrView = { ...pr, prNumber: 14277,
    prUrl: "https://github.com/craigoley/remudero/pull/14277", taskId: "unfiled",
    headSha: "8600214ec3b6384c7e55ab18d85bf82183e929df", headRefName: "run-unfiled-1",
    checksState: "green", ciFailures: [], lastActivityAt: since };
  const rows = [
    ["2026-10-26T00:37:39.000Z", "not admitted this pass: semantic post-review admission bound 0, in-flight 4"],
    ["2026-10-26T00:47:02.000Z", "not admitted this pass: semantic post-review admission bound 0, in-flight 2"],
    ["2026-10-26T01:03:21.000Z", "not admitted this pass: semantic post-review admission bound 0, in-flight 4"],
  ].map(([ts, stand_down_reason]) => ({ ts, step: "sweep.disposed", pr_number: view.prNumber,
    head_sha: view.headSha, task_id: view.taskId, blocker: "awaiting-review", blocker_since: since,
    disposition: "post-review", acted: false, reason: "checks green, review never posted — running the review lane",
    stand_down_reason }));
  assert.equal(fleetWithheldStageMs(rows, observedNow), observedNow - Date.parse(rows[0].ts));
  const held = fixture(rows, undefined);
  await runSweep([view], { ...held.deps, now: () => observedNow });
  assert.equal(held.stuck().length, 0);
  assert.deepEqual(held.escalations, []);

  // Once capacity is available, the same unchanged backstop still diagnoses a genuinely idle owner.
  const free = fixture([...rows, { ...rows[0], ts: "2026-10-26T01:05:00.000Z",
    stand_down_reason: "review setup refused: missing input" }], undefined);
  await runSweep([view], { ...free.deps, now: () => observedNow + 31 * 60_000 });
  assert.equal(free.stuck().length, 1);
  assert.equal(free.escalations.length, 1);
});

test("only an unacted exact semantic admission refusal is fleet-withheld time", () => {
  const admission = "not admitted this pass: semantic post-review admission bound 1, in-flight 2; admitted #14013 ahead";
  const row = { step: "sweep.disposed", ts: ago(10), acted: false, stand_down_reason: admission };
  assert.equal(fleetWithheldStageMs([row], now), 10 * 60_000);
  assert.equal(fleetWithheldStageMs([{ ...row, acted: true }], now), 0);
  assert.equal(fleetWithheldStageMs([{ ...row, acted: undefined }], now), 0);
  assert.equal(fleetWithheldStageMs([{ ...row, stand_down_reason: undefined, reason: admission }], now), 0);
  assert.equal(fleetWithheldStageMs([{ ...row, stand_down_reason: admission + "; unreadable" }], now), 0);
  assert.equal(fleetWithheldStageMs([{ ...row, stand_down_reason: "not admitted this pass: semantic post-review admission bound UNKNOWN" }], now), 0);
});
