/**
 * W1-T7533 — a `dispatch.blocked_independent` row with verdict `failed` or `no_pr` excluded its task
 * until a later run.start, and the exclusion itself prevented that run.start. On 2026-10-09, 32 open
 * tasks were latched forever by one bad run, 17 of them by the fleet-wide missing-COMMIT_MESSAGE gap.
 * Such a latch now re-offers its task once its evidence has changed (main moved or the task's contract
 * was revised) and a back-off that doubles with each consecutive latch has elapsed. These tests drive
 * the real `deriveStatus`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Task } from "../src/lib/plan.js";
import { preDispatchContractRevision } from "../src/lib/dispatch-repair.js";
import { deriveStatus, type GitHub, type StatusProjection } from "../src/lib/status.js";

const TASK = "W1-T9001";
const T0 = Date.parse("2026-10-07T12:00:00.000Z");
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const at = (offsetMs: number): string => new Date(T0 + offsetMs).toISOString();

function task(id = TASK, title = "t"): Task {
  return {
    id,
    title,
    repo: "remudero",
    depends_on: [],
    type: "implement",
    verify: "auto",
    risk: "high",
    status: "queued",
    attempts: 0,
  } as unknown as Task;
}

function noLiveEvidence(): GitHub {
  return {
    prByRef: () => null,
    findMergedByTrailer: () => null,
    findMergedByHeadBranch: () => [],
    headRefName: () => undefined,
    prBody: () => undefined,
  } as unknown as GitHub;
}

const REVISION = preDispatchContractRevision(task());

/** One run of the task that ends in `verdict` and the durable block the daemon writes for it. */
function failedRun(offsetMs: number, run: string, verdict = "failed", revision = REVISION): Record<string, unknown>[] {
  return [
    { ts: at(offsetMs), task_id: TASK, run_id: run, step: "run.start" },
    {
      ts: at(offsetMs + 1000),
      task_id: TASK,
      run_id: run,
      step: "verdict",
      verdict,
      stage: "implement",
      pre_dispatch_contract_revision: revision,
    },
    { ts: at(offsetMs + 2000), task_id: "DAEMON", task: TASK, run_id: run, step: "dispatch.blocked_independent", verdict },
  ];
}

/** Any OTHER task merging on main — the ledger's evidence that main has moved. */
const mergedElsewhere = (offsetMs: number, id = "W1-T8000"): Record<string, unknown> =>
  ({ ts: at(offsetMs), task_id: id, step: "verdict.merged", pr_url: "https://github.com/o/r/pull/1" });

function project(lines: Record<string, unknown>[], nowOffsetMs: number, t: Task = task()): StatusProjection {
  return deriveStatus(t, {
    ledgerPath: "/tmp/does-not-exist/ledger.ndjson",
    github: noLiveEvidence(),
    readLedger: () => lines,
    readCreditStore: () => ({}),
    writeCreditStore: () => {},
    now: () => T0 + nowOffsetMs,
  });
}

test("W1-T7533: a failed latch re-offers its task after main moves and the back-off elapses", () => {
  const latched = [...failedRun(0, "r1")];
  const before = project(latched, 3 * HOUR);
  assert.equal(before.independentFailureBlocked, true, "control: with nothing after it the latch holds");

  const ledger = [...latched, mergedElsewhere(30 * MINUTE)];
  const released = project(ledger, 3 * HOUR);
  assert.equal(released.independentFailureBlocked, undefined, "main moved and 3 h passed: the latch releases");
  assert.notEqual(released.status, "blocked");
  assert.deepEqual(released.independentBlockRelease, {
    blockingRunId: "r1",
    blockedAt: at(2000),
    evidence: "main_moved",
    mergedTaskId: "W1-T8000",
    mergedAt: at(30 * MINUTE),
    latchCount: 1,
    backoffMs: HOUR,
    receiptRecorded: false,
  });

  // The release is ledgered once: a recorded receipt for this blocking run is seen, not re-requested.
  const receipt = {
    ts: at(3 * HOUR),
    task_id: TASK,
    step: "dispatch.independent_block_released",
    blocking_run_id: "r1",
    evidence: "main_moved",
    backoff_ms: HOUR,
  };
  assert.equal(project([...ledger, receipt], 3 * HOUR + MINUTE).independentBlockRelease?.receiptRecorded, true);

  // A `no_pr` latch is released by the same rule.
  const noPr = project([...failedRun(0, "r1", "no_pr"), mergedElsewhere(30 * MINUTE)], 3 * HOUR);
  assert.equal(noPr.independentFailureBlocked, undefined);
  assert.equal(noPr.independentBlockRelease?.blockingRunId, "r1");

  // A revised task contract is changed evidence too, with no merge on main at all.
  const revised = project(latched, 3 * HOUR, task(TASK, "t, with its criterion corrected"));
  assert.equal(revised.independentFailureBlocked, undefined);
  assert.equal(revised.independentBlockRelease?.evidence, "contract_revised");

  // A release is a re-offer, not a credit: the next dispatch's run.start clears the latch the old way.
  const redispatched = project([...ledger, { ts: at(3 * HOUR + MINUTE), task_id: TASK, run_id: "r2", step: "run.start" }], 3 * HOUR + 2 * MINUTE);
  assert.equal(redispatched.independentFailureBlocked, undefined);
  assert.equal(redispatched.independentBlockRelease, undefined);
  assert.equal(redispatched.merged, false);
});

test("W1-T7533: an unchanged base or an unexpired doubled back-off keeps the latch", () => {
  // No merge on main and an unchanged contract: a retry would meet the same failure, at any age.
  const unchanged = project(failedRun(0, "r1"), 1000 * HOUR);
  assert.equal(unchanged.independentFailureBlocked, true);
  assert.equal(unchanged.status, "blocked");
  assert.equal(unchanged.independentBlockRelease, undefined);

  // A merge from BEFORE the block is not a change since it.
  assert.equal(project([mergedElsewhere(-MINUTE), ...failedRun(0, "r1")], 10 * HOUR).independentFailureBlocked, true);

  // Main moved, but the first back-off (1 h) has not elapsed.
  assert.equal(project([...failedRun(0, "r1"), mergedElsewhere(10 * MINUTE)], 50 * MINUTE).independentFailureBlocked, true);

  // Latched twice: the released re-offer failed again, so the wait doubles to 2 h.
  const second = 2 * HOUR;
  const twice = [
    ...failedRun(0, "r1"),
    mergedElsewhere(30 * MINUTE),
    ...failedRun(second, "r2"),
    mergedElsewhere(second + 10 * MINUTE, "W1-T8001"),
  ];
  const secondBlock = second + 2000;
  const inside = project(twice, secondBlock + 90 * MINUTE);
  assert.equal(inside.independentFailureBlocked, true, "90 minutes into a 2 h back-off the latch still holds");
  assert.equal(inside.independentBlockRelease, undefined);

  const after = project(twice, secondBlock + 2 * HOUR + MINUTE);
  assert.equal(after.independentFailureBlocked, undefined, "past the doubled back-off it re-offers again");
  assert.equal(after.independentBlockRelease?.blockingRunId, "r2");
  assert.equal(after.independentBlockRelease?.latchCount, 2);
  assert.equal(after.independentBlockRelease?.backoffMs, 2 * HOUR);

  // The second failure's own evidence must change: the merge that released r1 predates r2's block.
  const staleEvidence = [...failedRun(0, "r1"), mergedElsewhere(30 * MINUTE), ...failedRun(second, "r2")];
  assert.equal(project(staleEvidence, secondBlock + 10 * HOUR).independentFailureBlocked, true);

  // An unknown verdict keeps its deliberately durable latch.
  const unknown = [...failedRun(0, "r1", "mystery"), mergedElsewhere(30 * MINUTE)];
  assert.equal(project(unknown, 10 * HOUR).independentFailureBlocked, true);
});
