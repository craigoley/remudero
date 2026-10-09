import assert from "node:assert/strict";
import { test } from "node:test";
import { readLedgerLines } from "../src/lib/status.js";
import {
  DEFAULT_SWEEP_POLICY, liveHeadShaFrom, runSweep,
  type LiveStateResult, type OpenPrView, type SweepDeps,
} from "./helpers/sweep-test.js";
import { writeLedger } from "./helpers/ledger-fixture.js";

const NOW = Date.UTC(2026, 9, 9, 7, 30);
const HEAD = "snapshot-head";
const MOVED = "live-head";

function pr(conflicted = false): OpenPrView {
  return {
    prNumber: 5789, prUrl: "https://github.com/o/r/pull/5789", taskId: "W1-T5789",
    reviewState: "success", checksState: conflicted ? "green" : "red",
    unmetCriteria: [], priorStrikes: 0, headSha: HEAD, autoMergeArmed: false,
    lastActivityAt: new Date(NOW - 60_000).toISOString(),
    ciFailures: conflicted ? [] : [{ name: "unit", logTail: "AssertionError: expected 1 to equal 2" }],
    ...(conflicted ? {
      mergeState: "dirty" as const, headRefName: "run-W1-T5789-1791531194714",
      mergeConflict: {
        files: [{ path: "src/example.ts", oursDeleted: 0, theirsDeleted: 0 }],
        oursLog: "our addition", theirsLog: "their addition",
      },
    } : {}),
  };
}

function fixture(result: LiveStateResult | Error = { ok: true, state: "OPEN", headSha: HEAD }) {
  const { path } = writeLedger();
  let reads = 0;
  const fixed: string[] = [];
  const logs: string[] = [];
  const readLiveState = async () => {
    reads++;
    if (result instanceof Error) throw result;
    return result;
  };
  const deps: SweepDeps = {
    arm: () => "armed", close: () => {}, escalate: () => {},
    dispatchFix: p => { fixed.push(p.headSha); },
    readLiveState,
    readLiveStateAtAct: readLiveState,
    readLiveHeadSha: liveHeadShaFrom(readLiveState),
    readLedgerUnion: () => ({ complete: false, lines: [] }),
    ledgerPath: path, runId: "DAEMON-T5789", now: () => NOW,
    log: step => { logs.push(step); },
  };
  return { deps, fixed, logs, reads: () => reads, rows: () => readLedgerLines(path) };
}

for (const conflicted of [false, true]) {
  const disposition = conflicted ? "conflicted" : "blocked-fixable";
  test(`${disposition} shares one live read between the head guard and the fix arm`, async () => {
    const f = fixture();
    const summary = await runSweep([pr(conflicted)], f.deps, DEFAULT_SWEEP_POLICY);
    assert.equal(summary.byDisposition[disposition], 1);
    assert.deepEqual(f.fixed, [HEAD]);
    assert.equal(f.reads(), 1);
    assert.equal(f.rows().find(r => r.step === "sweep.disposed")?.live_head_sha, undefined);
  });

  for (const state of ["MERGED", "CLOSED"]) {
    test(`${disposition} reuses the guard's ${state} state to stand down`, async () => {
      const f = fixture({ ok: true, state, headSha: HEAD });
      await runSweep([pr(conflicted)], f.deps);
      assert.equal(f.reads(), 1);
      assert.deepEqual(f.fixed, []);
      const disposed = f.rows().find(r => r.step === "sweep.disposed");
      assert.equal(disposed?.acted, false);
      assert.match(String(disposed?.stand_down_reason), new RegExp(state));
    });
  }

  test(`${disposition} reuses an indeterminate guard read and logs the fail-open dispatch`, async () => {
    const f = fixture({ ok: false });
    await runSweep([pr(conflicted)], f.deps);
    assert.equal(f.reads(), 1);
    assert.deepEqual(f.fixed, [HEAD]);
    assert.equal(f.logs.filter(step => step === "sweep.dispose.indeterminate").length, 1);
  });

  test(`${disposition} records both heads on the head-moved sweep.disposed row`, async () => {
    const f = fixture({ ok: true, state: "OPEN", headSha: MOVED });
    await runSweep([pr(conflicted)], f.deps);
    assert.equal(f.reads(), 1);
    assert.deepEqual(f.fixed, []);
    const disposed = f.rows().find(r => r.step === "sweep.disposed");
    assert.equal(disposed?.head_sha, HEAD);
    assert.equal(disposed?.live_head_sha, MOVED);
    assert.equal(disposed?.acted, false);
    const moved = f.rows().find(r => r.step === "sweep.head_moved");
    assert.equal(moved?.snapshot_head_sha, HEAD);
    assert.equal(moved?.live_head_sha, MOVED);
  });

  test(`${disposition} keeps one terminal read in a light pass without a head guard`, async () => {
    const f = fixture();
    f.deps.repairAdmissionSurface = "light";
    await runSweep([pr(conflicted)], f.deps);
    assert.equal(f.reads(), 1);
    assert.deepEqual(f.fixed, [HEAD]);
  });
}

test("a throwing shared live read records an action failure and spends no fix strike", async () => {
  const f = fixture(new Error("live state unavailable"));
  await runSweep([pr()], f.deps);
  assert.equal(f.reads(), 1);
  assert.deepEqual(f.fixed, []);
  const failed = f.rows().find(r => r.step === "sweep.action_failed");
  assert.match(String(failed?.error), /live state unavailable/);
});

test("stale-red release keeps a final live read after the shared head guard", async () => {
  const f = fixture();
  const candidate = {
    ...pr(), priorStrikes: DEFAULT_SWEEP_POLICY.strikeCap,
    headRefName: "run-W1-T5789-1791531194714",
    ciFailures: [{
      name: "comment-load-ratchet", logTail: "AssertionError: fixture was stale",
      conclusion: "FAILURE", completedAt: new Date(NOW - 120_000).toISOString(),
    }],
    redRequiredChecks: ["comment-load-ratchet"],
  };
  const peer = { ...pr(), prNumber: 5790, checksState: "green" as const, ciFailures: [] };
  const reads: string[] = [];
  let releases = 0;
  let routes = 0;
  f.deps.readLiveStateAtAct = p => {
    reads.push(`guard:${p.prNumber}`);
    return { ok: true, state: "OPEN", headSha: HEAD };
  };
  f.deps.readLiveState = p => {
    reads.push(`final:${p.prNumber}`);
    return { ok: true, state: "OPEN", headSha: MOVED };
  };
  f.deps.readMainRepair = () => ({ sha: "main-repair", committedAt: new Date(NOW - 60_000).toISOString() });
  f.deps.readStaleRedWorkflowRuns = () => [];
  f.deps.runStaleRedLocalRoute = () => { routes++; return { outcome: "passed", detail: "passed" }; };
  f.deps.releaseStaleRed = () => {
    releases++;
    return { outcome: "rebased", oldHeadSha: HEAD, newHeadSha: MOVED };
  };
  await runSweep([candidate, peer], f.deps);
  assert.deepEqual(reads.filter(value => value.endsWith(":5789")), ["guard:5789", "final:5789"]);
  assert.equal(routes, 0);
  assert.equal(releases, 0);
  const disposed = f.rows().find(r => r.step === "sweep.disposed" && r.pr_number === 5789);
  assert.equal(disposed?.acted, false);
  assert.match(String(disposed?.stand_down_reason), /stale-red release refused: head moved/);
});
