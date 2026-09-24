/**
 * W1-T4413 — a filing PR merged on a run-<id> branch was briefly credited as the build (remudero-site
 * #108/#109, 2026-09-20). Dispatch refused the tasks as `task_already_merged`; the plan-only-filing
 * guard later withdrew that credit, but the old refusal row still latched both tasks `blocked`, so work
 * that was only ever FILED could never be built. These drive the real `deriveStatus`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Task } from "../src/lib/plan.js";
import { deriveStatus, latestIndependentFailureBlock, recordCredit, type CreditStore, type GitHub } from "../src/lib/status.js";

function task(id: string): Task {
  return {
    id,
    title: "t",
    repo: "remudero-site",
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

function refusal(taskId: string, verdict: string): Record<string, unknown> {
  return { ts: "2026-09-20T21:46:54.694Z", task_id: "DAEMON", task: taskId, step: "dispatch.blocked_independent", verdict };
}

test("a task_already_merged refusal never blocks a task whose credit was withdrawn", () => {
  const taskId = "PORTAL-T20";
  const store: CreditStore = recordCredit({}, taskId, { source: "head-branch", prUrl: "u/108", prNumber: 108, prState: "MERGED" });
  const lines = [refusal(taskId, "task_already_merged")];

  assert.equal(latestIndependentFailureBlock(lines, taskId), false);
  const proj = deriveStatus(task(taskId), {
    ledgerPath: "/tmp/does-not-exist/ledger.ndjson",
    github: noLiveEvidence(),
    readLedger: () => lines,
    readCreditStore: () => store,
    writeCreditStore: () => {},
    // #108 only filed the task: its diff is the plan shard alone, so the credit is withdrawn.
    mergedPathsByPr: new Map([[108, ["plan/tasks.yaml"]]]),
  });

  assert.equal(proj.merged, false, "the plan-only filing credit is withdrawn");
  assert.equal(proj.status, "queued", "the withdrawn credit's old refusal must not latch the task blocked");
  assert.equal(proj.independentFailureBlocked, undefined);
});

test("a genuinely merged task is still reported merged, not queued", () => {
  const taskId = "PORTAL-T19";
  const store: CreditStore = recordCredit({}, taskId, { source: "head-branch", prUrl: "u/107", prNumber: 107, prState: "MERGED" });
  const proj = deriveStatus(task(taskId), {
    ledgerPath: "/tmp/does-not-exist/ledger.ndjson",
    github: noLiveEvidence(),
    readLedger: () => [refusal(taskId, "task_already_merged")],
    readCreditStore: () => store,
    writeCreditStore: () => {},
    mergedPathsByPr: new Map([[107, ["app/learning/page.tsx", "tests/unit/learning.test.tsx"]]]),
  });

  assert.equal(proj.merged, true);
  assert.equal(proj.prNumber, 107);
});

test("control: an ordinary no_pr refusal still latches the task blocked", () => {
  assert.equal(latestIndependentFailureBlock([refusal("PORTAL-T21", "no_pr")], "PORTAL-T21"), true);
});
