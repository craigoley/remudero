import assert from "node:assert/strict";
import { test } from "node:test";

import { MAX_STALE_PROOF_CLOSES_PER_PASS, runSweep, type OpenPrView } from "../src/lib/sweep.js";

const NOW = Date.parse("2026-10-09T12:00:00Z");

function reviewFailed(n: number, over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: n,
    prUrl: `https://github.com/acme/remudero/pull/${n}`,
    taskId: `W1-T7091-FIXTURE-${n}`,
    headSha: `7091-${n}`,
    checksState: "green",
    reviewState: "failure",
    unmetCriteria: [{ claim: "feedback is parked", proof: "grep: status: grilling in plan/feedback/fb.yaml", met: false, reason: "no match", proof_exec: "executed_fail" }],
    priorStrikes: 1,
    lastActivityAt: new Date(NOW - 60_000).toISOString(),
    autoMergeArmed: false,
    changedFiles: [],
    ...over,
  };
}

function harness() {
  const ledger: Record<string, unknown>[] = [];
  const closed: number[] = [];
  const fixed: number[] = [];
  const escalated: number[] = [];
  const sweep = (prs: OpenPrView[], failClose = false) => runSweep(prs, {
    arm: () => "armed",
    close: (pr) => {
      closed.push(pr.prNumber);
      if (failClose) throw new Error("host rejected close");
    },
    dispatchFix: (pr) => { fixed.push(pr.prNumber); },
    escalate: (pr) => { escalated.push(pr.prNumber); },
    ledgerPath: "/dev/null/w1-t7091.ndjson",
    runId: "SWEEP-W1-T7091",
    now: () => NOW,
    readLedger: () => ledger,
    appendLine: (_path, line) => { ledger.push(line); },
  });
  return { ledger, closed, fixed, escalated, sweep };
}

test("W1-T7091: flow-review-failed-n-unmet-criterion clears without a person", async () => {
  const h = harness();
  const prs = Array.from({ length: MAX_STALE_PROOF_CLOSES_PER_PASS + 1 }, (_, i) => reviewFailed(10265 + i));
  const carried = prs.at(-1)!;
  await h.sweep(prs);
  assert.deepEqual(h.closed, prs.slice(0, -1).map((pr) => pr.prNumber));
  assert.deepEqual(h.fixed, [], "a carried empty diff has no surface for a fix worker");
  const deferred = h.ledger.find((row) => row.step === "sweep.disposed" && row.pr_number === carried.prNumber);
  assert.ok(deferred);
  assert.equal(deferred.acted, false);
  assert.equal(deferred.empty_diff_close_deferred, true);
  assert.match(String(deferred.stand_down_reason), /empty-diff supersession close deferred/);
  assert.equal(deferred.empty_diff_superseded, undefined);

  await h.sweep([carried]);
  assert.deepEqual(h.closed, prs.map((pr) => pr.prNumber));
  assert.deepEqual(h.fixed, []);
  assert.deepEqual(h.escalated, []);
  const cleared = h.ledger.filter((row) => row.step === "sweep.disposed" && row.pr_number === carried.prNumber).at(-1);
  assert.equal(cleared?.empty_diff_superseded, true);
  assert.equal(cleared?.acted, true);
});

test("W1-T7091: failed close attempts remain bounded and the carried review failure retries", async () => {
  const h = harness();
  const prs = Array.from({ length: MAX_STALE_PROOF_CLOSES_PER_PASS + 1 }, (_, i) => reviewFailed(10300 + i));
  await h.sweep(prs, true);
  assert.equal(h.closed.length, MAX_STALE_PROOF_CLOSES_PER_PASS);
  assert.deepEqual(h.fixed, []);
  assert.match(String(h.ledger.find((row) => row.pr_number === prs[0]!.prNumber && row.step === "sweep.disposed")?.action_error), /host rejected close/);
  await h.sweep([prs.at(-1)!]);
  assert.equal(h.closed.length, prs.length);
  assert.deepEqual(h.escalated, []);
});

test("W1-T7091: an actionable or unread diff keeps its owner fix lane", async () => {
  for (const changedFiles of [["src/lib/sweep.ts"], undefined]) {
    const h = harness();
    await h.sweep([reviewFailed(10400, { changedFiles })]);
    assert.deepEqual(h.closed, []);
    assert.deepEqual(h.fixed, [10400]);
    assert.deepEqual(h.escalated, []);
  }
});
