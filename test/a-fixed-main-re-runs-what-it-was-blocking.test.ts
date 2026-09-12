import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_SWEEP_POLICY,
  FIXED_MAIN_REFIRE_STEP,
  fixedMainRefireDecision,
  runSweep,
  type FixedMainBlockerProof,
  type OpenPrView,
} from "../src/lib/sweep.js";

const NOW = Date.parse("2026-09-10T12:50:00Z");
const MAIN = {
  sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  committedAt: "2026-09-10T12:36:48Z",
};

function pr(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 4938,
    prUrl: "https://github.com/craigoley/remudero/pull/4938",
    taskId: "W1-T4938",
    reviewState: "success",
    checksState: "red",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: "2026-09-10T12:20:00Z",
    headSha: "head-4938",
    headRefName: "run-W1-T4938-1",
    autoMergeArmed: false,
    ciFailures: [
      {
        name: "comment-load-ratchet",
        logTail: "expiring-fixture-census: BLOCKED",
        completedAt: "2026-09-10T12:31:00Z",
      },
    ],
    ...over,
  };
}

function sibling(over: Partial<OpenPrView> = {}): OpenPrView {
  return pr({
    prNumber: 4950,
    prUrl: "https://github.com/craigoley/remudero/pull/4950",
    taskId: "W1-T4950",
    headSha: "head-4950",
    ...over,
  });
}

async function sweep(
  prs: OpenPrView[],
  over: {
    prior?: Record<string, unknown>[];
    proof?: FixedMainBlockerProof;
  } = {},
) {
  const appended: Record<string, unknown>[] = [];
  const refired: number[] = [];
  const dispatched: number[] = [];
  const proofed: number[] = [];
  const summary = await runSweep(prs, {
    arm: () => {},
    close: () => {},
    dispatchFix: (candidate) => { dispatched.push(candidate.prNumber); },
    escalate: () => {},
    ledgerPath: "/dev/null/w1-t3331.ndjson",
    runId: "W1-T3331-test",
    readLedger: () => over.prior ?? [],
    appendLine: (_path, line) => { appended.push(line); },
    now: () => NOW,
    readMainTip: () => MAIN,
    proveFixedMainBlocker: (candidate) => {
      proofed.push(candidate.prNumber);
      return over.proof ?? { passed: true, reason: "local gate passed", localGateExit: 0 };
    },
    refireFixedMainPr: (candidate) => {
      refired.push(candidate.prNumber);
      return true;
    },
  });
  return { appended, dispatched, proofed, refired, summary };
}

test("W1-T3331 criterion 1 and 4: a stale PR whose local merge passes is refired once and ledgered", async () => {
  const result = await sweep([pr(), sibling()]);

  assert.deepEqual(result.proofed, [4938, 4950]);
  assert.deepEqual(result.refired, [4938, 4950]);
  assert.deepEqual(result.dispatched, [], "the fix rung must not spend a strike for a fixed-main blocker");
  const row = result.appended.find((line) => line.step === FIXED_MAIN_REFIRE_STEP && line.pr_number === 4938);
  assert.deepEqual(row && {
    pr_number: row.pr_number,
    head_sha: row.head_sha,
    main_tip_sha: row.main_tip_sha,
    main_tip_committed_at: row.main_tip_committed_at,
    stale_failure_completed_at: row.stale_failure_completed_at,
    check_names: row.check_names,
    local_gate_exit: row.local_gate_exit,
  }, {
    pr_number: 4938,
    head_sha: "head-4938",
    main_tip_sha: MAIN.sha,
    main_tip_committed_at: MAIN.committedAt,
    stale_failure_completed_at: "2026-09-10T12:31:00Z",
    check_names: ["comment-load-ratchet"],
    local_gate_exit: 0,
  });
  const disposed = result.appended.find((line) => line.step === "sweep.disposed" && line.pr_number === 4938);
  assert.equal(disposed?.acted, false);
  assert.match(String(disposed?.stand_down_reason), /close\/reopen event emitted once/);
});

test("W1-T3331 criterion 2: a stale PR whose local merge still fails is not refired", async () => {
  const result = await sweep([pr(), sibling()], {
    proof: { passed: false, reason: "comment-load-ratchet still fails on merged tree", localGateExit: 1 },
  });

  assert.deepEqual(result.proofed, [4938, 4950]);
  assert.deepEqual(result.refired, []);
  assert.deepEqual(result.dispatched, [], "base-caused red still stands down instead of spending a strike");
  assert.equal(result.appended.some((line) => line.step === FIXED_MAIN_REFIRE_STEP), false);
});

test("W1-T3331 criterion 3: the same PR is not refired twice against the same main tip", async () => {
  const first = await sweep([pr()]);
  const second = await sweep([pr()], { prior: first.appended });

  assert.deepEqual(first.refired, [4938]);
  assert.deepEqual(second.proofed, [], "a prior fixed-main refire skips even the local proof");
  assert.deepEqual(second.refired, []);
});

test("W1-T3331 in-flight control: a PR with a queued or running check is left untouched", () => {
  const decision = fixedMainRefireDecision(
    pr({ inFlightCheckNames: ["comment-load-ratchet"] }),
    MAIN,
    new Set(),
  );

  assert.equal(decision.refire, false);
  assert.match(decision.reason, /already in flight/);
});
