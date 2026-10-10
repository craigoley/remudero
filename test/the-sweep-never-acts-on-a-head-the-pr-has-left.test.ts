/**
 * W1-T5749 — THE SWEEP NEVER ACTS ON A HEAD THE PR HAS LEFT.
 *
 * 2026-10-04 21:31-21:46Z: #9138's head had moved to cc291a4b, yet every full-sweep pass disposed
 * it at 2b739554 and armed against that head (`arm outcome: ledger-refused`), and #9155 escalated
 * `stale-pending` at c80ed790 an hour after leaving it. #9188 made each retriggered full pass read
 * its own generation; a pass's snapshot can still age while the pass walks. These fixtures drive
 * the REAL `runSweep` with a snapshot head and a fresh live head (`readLiveHeadSha`, built from
 * `readLiveState` exactly as the daemon's full-sweep hook builds it) that disagree, and
 * assert the act is withheld and recorded as `sweep.head_moved` with both shas.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { readLedgerLines } from "../src/lib/status.js";
import {
  DEFAULT_SWEEP_POLICY,
  runSweep,
  type LiveStateResult,
  type OpenPrView,
  type SweepDeps,
} from "./helpers/sweep-test.js";
// Namespace-imported so the file still LOADS on a tree without the helper: every test there fails
// on its own assertion instead of the whole file failing to link (proof discrimination).
import * as sweep from "./helpers/sweep-test.js";
import { writeLedger } from "./helpers/ledger-fixture.js";

const NOW = Date.UTC(2026, 9, 4, 21, 36);
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();
const SNAPSHOT_HEAD = "2b739554aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const LIVE_HEAD = "cc291a4bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function mergeablePr(): OpenPrView {
  return {
    prNumber: 9138, prUrl: "https://github.com/o/r/pull/9138", taskId: "W1-T9138",
    reviewState: "success", checksState: "green", unmetCriteria: [], priorStrikes: 0,
    lastActivityAt: minutesAgo(5), headSha: SNAPSHOT_HEAD, autoMergeArmed: false,
  };
}

function staleCiPr(): OpenPrView {
  return {
    prNumber: 9155, prUrl: "https://github.com/o/r/pull/9155", taskId: "W1-T9155",
    reviewState: "success", checksState: "pending", checksPendingSince: minutesAgo(65), unmetCriteria: [],
    priorStrikes: 0, lastActivityAt: minutesAgo(65), headSha: SNAPSHOT_HEAD, autoMergeArmed: false,
  };
}

function fixture(live: (pr: OpenPrView) => LiveStateResult | Promise<LiveStateResult>) {
  const { path } = writeLedger();
  const armed: string[] = [];
  const escalated: string[] = [];
  const deps: SweepDeps = {
    arm: (pr) => { armed.push(pr.headSha); return "armed"; },
    close: () => {},
    dispatchFix: () => {},
    escalate: (pr) => { escalated.push(pr.headSha); },
    readLiveHeadSha: sweep.liveHeadShaFrom(live),
    readLedgerUnion: () => ({ complete: false, lines: [] }),
    ledgerPath: path,
    runId: "DAEMON-T5749",
    now: () => NOW,
  };
  const rows = () => readLedgerLines(path);
  return { deps, armed, escalated, rows };
}

const movedHead = (): LiveStateResult => ({ ok: true, state: "OPEN", headSha: LIVE_HEAD });
const sameHead = (pr: OpenPrView): LiveStateResult => ({ ok: true, state: "OPEN", headSha: pr.headSha });

test("a stale snapshot never arms the old head and records sweep.head_moved with both shas", async () => {
  const f = fixture(movedHead);
  const summary = await runSweep([mergeablePr()], f.deps, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(f.armed, [], "no arm is attempted against a head the PR has left");
  const moved = f.rows().filter((r) => r.step === "sweep.head_moved");
  assert.equal(moved.length, 1, "one sweep.head_moved row");
  assert.equal(moved[0].pr_number, 9138);
  assert.equal(moved[0].snapshot_head_sha, SNAPSHOT_HEAD);
  assert.equal(moved[0].live_head_sha, LIVE_HEAD);
  assert.equal(moved[0].disposition, "mergeable");
  const disposed = f.rows().find((r) => r.step === "sweep.disposed");
  assert.equal(disposed?.acted, false, "the disposition row does not claim an act");
  assert.equal(disposed?.arm_attempted, undefined, "no arm outcome is recorded against the old head");
  assert.match(String(disposed?.stand_down_reason), /head moved from 2b739554 to cc291a4b/);
  assert.equal(summary.actionsTaken, 0);
});

test("a stale snapshot never escalates stale-pending at the old head", async () => {
  const f = fixture(movedHead);
  await runSweep([staleCiPr()], f.deps, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(f.escalated, [], "no escalation is filed for a head the PR has left");
  const moved = f.rows().filter((r) => r.step === "sweep.head_moved");
  assert.equal(moved.length, 1);
  assert.equal(moved[0].disposition, "blocked-ambiguous");
  assert.equal(moved[0].snapshot_head_sha, SNAPSHOT_HEAD);
  assert.equal(moved[0].live_head_sha, LIVE_HEAD);
  const disposed = f.rows().find((r) => r.step === "sweep.disposed");
  assert.match(String(disposed?.reason), /^stale-pending/);
  assert.equal(disposed?.acted, false);
});

test("a pass whose snapshot matches the live head arms and escalates as before", async () => {
  const f = fixture(sameHead);
  const summary = await runSweep([mergeablePr(), staleCiPr()], f.deps, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(f.armed, [SNAPSHOT_HEAD], "the matching head arms");
  assert.deepEqual(f.escalated, [SNAPSHOT_HEAD], "the matching head escalates");
  assert.equal(f.rows().filter((r) => r.step === "sweep.head_moved").length, 0);
  assert.equal(summary.actionsTaken, 2);
});

test("an unreadable live head leaves the act as it was before the guard", async () => {
  const f = fixture(() => ({ ok: false }));
  await runSweep([mergeablePr()], f.deps, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(f.armed, [SNAPSHOT_HEAD], "no fresh head to compare: the arm's own head re-read decides");
  assert.equal(f.rows().filter((r) => r.step === "sweep.head_moved").length, 0);
});

test("a live-head read that throws is this PR's named action failure, never an arm", async () => {
  const f = fixture(() => { throw new Error("rest read failed"); });
  await runSweep([mergeablePr()], f.deps, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(f.armed, []);
  const failed = f.rows().find((r) => r.step === "sweep.action_failed");
  assert.match(String(failed?.error), /rest read failed/);
});

test("the live-head reader is undefined when no live-state reader is wired", async () => {
  assert.equal(await sweep.liveHeadShaFrom(undefined)(mergeablePr()), undefined);
  assert.equal(await sweep.liveHeadShaFrom(movedHead)(mergeablePr()), LIVE_HEAD);
});
