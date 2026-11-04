// PR 16213 (W1-T10857, 2026-11-03): green, a remudero-review PASS and mergeable from 02:17Z, never armed. The
// handed-off-head risk judge escalated its head at high / 0.60 on the description alone, and the sweep held the
// arm. The stage-stall report at 08:53Z read "awaiting-arm ... DIAGNOSIS: unknown signature", so the issue an
// operator got never named the hold that was the whole cause. The report now names it, with its reason and issue.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readLedgerLines } from "#src/lib/status.js";
import { riskHoldAtHead, runSweep, type OpenPrView, type SweepDeps } from "#src/lib/sweep.js";
import { writeLedger } from "#test/helpers/ledger-fixture.js";

const now = Date.UTC(2026, 10, 3, 8, 53);
const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
const ISSUE = "https://github.com/craigoley/remudero/issues/16273";
const REASON = "high-risk verdict at confidence 0.60 — on the change's description/files alone, no diff was read — " +
  "3 test files are not declared in files:";
const pr: OpenPrView = {
  prNumber: 16213, prUrl: "https://github.com/craigoley/remudero/pull/16213", taskId: "W1-T10857",
  headSha: "5c177ab9a", headRefName: "run-W1-T10857-1", reviewState: "success", checksState: "green",
  unmetCriteria: [], priorStrikes: 0, lastActivityAt: ago(5), autoMergeArmed: false,
};

const stage = { ts: ago(40), run_id: "old", task_id: pr.taskId, step: "sweep.disposed", pr_number: pr.prNumber,
  head_sha: pr.headSha, disposition: "mergeable", acted: false, blocker: "awaiting-arm", blocker_since: ago(40) };
const decision = { ts: ago(38), step: "risk_judge.decision", pr_number: pr.prNumber, head_sha: pr.headSha,
  verdict: "high", confidence: 0.6, action: "escalate", reason: REASON, evidence_tier: "description" };
const escalated = { ts: ago(38), step: "risk_judge.escalated", pr_number: pr.prNumber, head_sha: pr.headSha, issue_url: ISSUE };

function fixture(extra: Record<string, unknown>[]) {
  const ledger = writeLedger([stage, ...extra]);
  const escalations: string[] = [];
  const deps: SweepDeps = {
    ledgerPath: ledger.path, runId: "test-risk-hold", now: () => now,
    arm: () => "hold-refused", close: () => {}, dispatchFix: () => {}, postReview: () => {},
    escalate: (_pr, reason) => { escalations.push(reason); },
  };
  const rows = (step: string) => readLedgerLines(ledger.path).filter(row => row.step === step);
  return { deps, escalations, rows };
}

test("PR-16213: a stalled awaiting-arm PR held by the risk judge names that hold, not an unknown signature", async () => {
  const f = fixture([decision, escalated]);
  await runSweep([pr], f.deps);
  const stuck = f.rows("pr.stuck");
  assert.equal(stuck.length, 1);
  assert.equal(stuck[0].blocker, "awaiting-arm");
  assert.match(String(stuck[0].diagnosis), /^held by the risk judge since /);
  assert.match(String(stuck[0].diagnosis), new RegExp(`in ${ISSUE}`));
  assert.match(String(stuck[0].diagnosis), /high-risk verdict at confidence 0\.60/);
  assert.equal(f.escalations.length, 1);
  assert.doesNotMatch(f.escalations[0], /unknown signature/);
  assert.match(f.escalations[0], /DIAGNOSIS: held by the risk judge/);
});

test("PR-16213: a re-judgment that proceeds, or no escalation at this head, names no risk hold", () => {
  assert.match(riskHoldAtHead([decision, escalated], pr) ?? "", /held by the risk judge/);
  const proceeded = { ts: ago(10), step: "risk_judge.decision", pr_number: pr.prNumber, head_sha: pr.headSha,
    verdict: "low", confidence: 0.9, action: "proceed", reason: "judged on the diff" };
  assert.equal(riskHoldAtHead([decision, escalated, proceeded], pr), undefined, "a later decision ends the hold");
  assert.equal(riskHoldAtHead([decision, escalated], { ...pr, headSha: "newhead" }), undefined, "a new head re-earns its own");
  assert.equal(riskHoldAtHead([], pr), undefined);
  assert.match(riskHoldAtHead([escalated], pr) ?? "", /reason unreadable$/, "an escalation without its decision is still named");
});

test("PR-16213: a stalled awaiting-arm PR with no risk hold keeps its other diagnosis", async () => {
  const f = fixture([]);
  await runSweep([pr], f.deps);
  assert.equal(f.rows("pr.stuck")[0].diagnosis, "unknown signature");
});
