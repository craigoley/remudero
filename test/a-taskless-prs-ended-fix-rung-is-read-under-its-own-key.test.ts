import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { fixLedgerTaskIdFor, fixRoundTally, fixRungStalledWithoutNewHead, runSweep,
  type OpenPrView, type SweepDeps } from "#src/lib/sweep.js";
import { readLedgerLines } from "#src/lib/status.js";
import { writeLedger } from "#test/helpers/ledger-fixture.js";

const PR = 12409, KEY = `PR-${PR}`, HEAD = "e7926e54".padEnd(40, "0");

function fixture(t: TestContext, ended: boolean) {
  const now = Date.now();
  const dispatch = { task_id: KEY, step: "fix.dispatch", head_sha: HEAD,
    mode: "reviewer-unmet", strike: 1, round_id: "taskless-round" };
  const rows: Record<string, unknown>[] = [dispatch];
  if (ended) rows.push(
    // Legacy NEEDS_DESIGN rows lack the newer head-bound design-handoff receipt.
    { task_id: KEY, step: "fix.needs_design", reason: "reviewer sandbox lacks python3" },
    { task_id: KEY, step: "fix.done", head_sha: HEAD, round_id: dispatch.round_id,
      fix_outcome: "NEEDS_DESIGN", worker_exit: "unobserved" },
  );
  rows.push({ task_id: "SWEEP", step: "sweep.disposed", pr_number: PR, head_sha: HEAD,
    run_id: "taskless-sweep", ts: new Date(now - 1000).toISOString(),
    disposition: "blocked-fixable", acted: true });
  const ledger = writeLedger(rows, { scope: t });
  const pr: OpenPrView = {
    prNumber: PR, prUrl: `https://github.com/craigoley/remudero/pull/${PR}`,
    headSha: HEAD, headRefName: "codex/semgrep-source-build-20261016",
    reviewState: "failure", checksState: "green", priorStrikes: 0, autoMergeArmed: false,
    lastActivityAt: new Date(now).toISOString(),
    unmetCriteria: [{ claim: "the proof runs", proof: "unit test: sandbox proof",
      met: false, reason: "python3 unavailable", proof_exec: "not_executable" }],
  };
  const judged: Parameters<NonNullable<SweepDeps["fixProgressJudge"]>>[0][] = [];
  const escalated: string[] = [];
  let dispatched = 0;
  const deps: SweepDeps = {
    ledgerPath: ledger.path, runId: "taskless-sweep", now: () => now,
    arm: () => assert.fail("a review failure cannot arm"),
    close: () => assert.fail("a review failure cannot close"),
    dispatchFix: () => { dispatched++; },
    escalate: (_pr, reason) => { escalated.push(reason); },
    fixProgressJudge: async input => {
      judged.push(input);
      return { verdict: "escalate", loop: "proof environment", reason: "reviewer sandbox lacks python3" };
    },
  };
  return { pr, rows, ledger, deps, judged, escalated, dispatched: () => dispatched };
}

test("W1-T9955: a taskless PR whose fix rung ended is re-judged, not awaited forever", async t => {
  const f = fixture(t, true);
  await runSweep([f.pr], f.deps);
  assert.equal(f.judged.length, 1, "the judge sees the completed taskless round");
  assert.equal(f.judged[0]!.rounds.length, 1);
  assert.equal(f.judged[0]!.rounds[0]!.completed, true);
  assert.equal(f.judged[0]!.rounds[0]!.fixOutcome, "NEEDS_DESIGN");
  assert.equal(f.escalated.length, 1);
  assert.match(f.escalated[0]!, /reviewer sandbox lacks python3/);
  assert.equal(f.dispatched(), 0, "the existing judge decides whether another round is useful");
  const disposed = readLedgerLines(f.ledger.path).filter(row => row.step === "sweep.disposed").at(-1)!;
  assert.doesNotMatch(String(disposed.stand_down_reason), /fix already dispatched for this head/);
  assert.equal(fixRungStalledWithoutNewHead(f.rows, fixLedgerTaskIdFor(f.pr)), true);
  const other = { prNumber: PR + 1 };
  const strikes = [{ ...f.rows[0], round_id: undefined }];
  assert.equal(fixRoundTally(strikes, fixLedgerTaskIdFor(f.pr), HEAD).strikes, 1);
  assert.equal(fixRoundTally(strikes, fixLedgerTaskIdFor(other), HEAD).strikes, 0);
});

test("W1-T9955: a taskless PR inside a live fix rung keeps its dedup", async t => {
  const f = fixture(t, false);
  assert.equal(fixLedgerTaskIdFor(f.pr), KEY);
  assert.equal(fixRungStalledWithoutNewHead(f.rows, fixLedgerTaskIdFor(f.pr)), false);
  await runSweep([f.pr], f.deps);
  assert.equal(f.judged.length, 0);
  assert.deepEqual(f.escalated, []);
  assert.equal(f.dispatched(), 0);
  const disposed = readLedgerLines(f.ledger.path).filter(row => row.step === "sweep.disposed").at(-1)!;
  assert.equal(disposed.acted, false);
  assert.match(String(disposed.stand_down_reason), /fix already dispatched for this head/);
});
