// #10265 (2026-10-09): a second triage of an already-triaged feedback item failed review on a criterion that could never
// pass, and once main was merged in its diff against main was EMPTY. The fix rung stood down every round ("the fix has
// no surface to stage") and the PR sat open for hours. A red PR with nothing left to merge is superseded: close it.
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { runSweep, type FixDispatchEvidence, type OpenPrView } from "./helpers/sweep-test.js";

const NOW = Date.parse("2026-10-09T11:30:00Z");

function reviewFailed(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 10265,
    prUrl: "https://github.com/acme/remudero/pull/10265",
    taskId: "TRIAGE-fb-1789927308301-29a363",
    reviewState: "failure",
    checksState: "green",
    unmetCriteria: [{ claim: "the feedback is parked for the grill", proof: "grep: status: grilling in plan/feedback/fb.yaml", met: false, reason: "no match", proof_exec: "executed_fail" }],
    priorStrikes: 1,
    lastActivityAt: "2026-10-09T11:26:00.000Z", // expiring-fixture: exempt -- compared only against this suite's INJECTED now (NOW), never the wall clock
    headSha: "12812971",
    autoMergeArmed: false,
    changedFiles: [],
    ...over,
  };
}

async function sweep(view: OpenPrView) {
  const seen = { fixed: [] as FixDispatchEvidence[], closed: [] as string[] };
  await runSweep([view], {
    arm: () => "armed",
    close: (_pr, reason) => { seen.closed.push(reason); },
    dispatchFix: (_pr, evidence) => { seen.fixed.push(evidence); },
    escalate: () => {},
    ledgerPath: join(mkdtempSync(join(tmpdir(), "rmd-empty-diff-")), "ledger.ndjson"),
    runId: "SWEEP-10265",
    now: () => NOW,
  });
  return seen;
}

test("a review-failed PR whose diff against main is empty is closed as superseded, not handed to a fix worker", async () => {
  const seen = await sweep(reviewFailed());
  assert.deepEqual(seen.fixed, [], "a worker has no surface to stage on an empty diff");
  assert.equal(seen.closed.length, 1);
  assert.match(seen.closed[0]!, /superseded/);
  assert.match(seen.closed[0]!, /empty/);
});

test("an unobserved diff is never read as an empty one", async () => {
  const seen = await sweep(reviewFailed({ changedFiles: undefined }));
  assert.deepEqual(seen.closed, []);
});

test("a review-failed PR that still changes something gets its fix round", async () => {
  const seen = await sweep(reviewFailed({ changedFiles: ["plan/feedback/fb.yaml"] }));
  assert.deepEqual(seen.closed, []);
  assert.equal(seen.fixed.length, 1);
});

test("an empty-diff review failure is closed even after a fix round was already dispatched at its head", async () => {
  const ledgerPath = join(mkdtempSync(join(tmpdir(), "rmd-empty-diff-")), "ledger.ndjson");
  const view = reviewFailed();
  // #10265's own history: a full pass dispatched a round at this head (acted), and the rung stood down on no surface.
  appendFileSync(ledgerPath, [
    { step: "sweep.disposed", pr_number: view.prNumber, head_sha: view.headSha, disposition: "blocked-fixable", acted: true, task_id: view.taskId },
    { step: "fix.dispatch", task_id: view.taskId, head_sha: view.headSha, mode: "review" },
    { step: "fix.stood_down", task_id: view.taskId, reason: "the fix has no surface to stage" },
  ].map((row) => JSON.stringify({ ts: "2026-10-09T12:52:37.986Z", run_id: "DAEMON-1", ...row })).join("\n") + "\n");
  const closed: string[] = [];
  await runSweep([view], {
    arm: () => "armed", close: (_pr, reason) => { closed.push(reason); }, dispatchFix: () => {}, escalate: () => {},
    ledgerPath, runId: "SWEEP-10265", now: () => NOW,
  });
  assert.equal(closed.length, 1, "the prior round's dedup must not hide a PR with nothing left to merge");
});
