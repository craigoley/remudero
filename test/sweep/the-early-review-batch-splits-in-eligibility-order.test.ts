import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_SWEEP_POLICY, lightPassEarlyReviewBatch, lightPassReviewQueuedAt, observeLightPassReviewEligibility,
  selectReviewAdmissions, type OpenPrView,
} from "#src/lib/sweep.js";

const NOW = Date.parse("2026-11-22T00:00:00Z");

function pr(prNumber: number, extra: Partial<OpenPrView> = {}): OpenPrView {
  return { prNumber, prUrl: `https://github.com/o/r/pull/${prNumber}`, taskId: `W1-T${prNumber}`,
    headSha: `head-${prNumber}`, headRefName: `run-W1-T${prNumber}-1`, lastActivityAt: new Date(NOW).toISOString(),
    reviewState: "none", checksState: "green", unmetCriteria: [], priorStrikes: 0, autoMergeArmed: false,
    mergeState: "clean", changedFiles: ["src/subject.ts"], ...extra };
}

/** A pull request that was review-eligible at an earlier head: its current head is a new review input. */
function eligibleAt(subject: OpenPrView, headSha: string, ts: string): Record<string, unknown> {
  return { ts, step: "sweep.review_eligible", pr_number: subject.prNumber, head_sha: headSha,
    review_key: `prior-key-${subject.prNumber}-${headSha}`, surface: "light" };
}

/** The current head's own first eligibility row, keyed exactly as the light pass writes it. */
function currentHeadEligibleAt(subject: OpenPrView, ts: string): Record<string, unknown> {
  const scratch: Array<Record<string, unknown>> = [];
  observeLightPassReviewEligibility([subject], {
    ledgerPath: "unused", runId: "T14243-key", readLedger: () => scratch, now: () => NOW,
    appendLine: (_path, row) => { scratch.push(row); },
    arm: () => assert.fail("unexpected arm"), close: () => assert.fail("unexpected close"),
    dispatchFix: () => assert.fail("unexpected fix"), escalate: () => assert.fail("unexpected escalation"),
  });
  const row = scratch.find((r) => r.step === "sweep.review_eligible" && r.pr_number === subject.prNumber);
  assert.ok(row !== undefined && typeof row.review_key === "string", "the current head has an eligibility key");
  return { ...row, ts };
}

/** One ledger view, read the way the light pass reads it. */
function view(rows: Array<Record<string, unknown>>) {
  let reads = 0;
  return { ledgerPath: "ledger.ndjson", now: () => NOW, readLedger: () => { reads++; return rows; }, reads: () => reads };
}

/** Admission's full order over the same inputs and ledger view. */
function admissionOrder(prs: readonly OpenPrView[], deps: ReturnType<typeof view>): number[] {
  return selectReviewAdmissions(prs, DEFAULT_SWEEP_POLICY, NOW, undefined, prs.length, undefined, undefined,
    lightPassReviewQueuedAt(deps)).spawning.map((p) => p.prNumber);
}

test("W1-T14243 criterion 1: an older PR on a new head that waits for refresh does not hold back an earlier-eligible input", () => {
  // The older PR's fix head re-entered the queue this pass; the younger PR has been eligible since it opened.
  const older = pr(1424302, { autoMergeArmed: true, createdAt: "2026-10-27T00:00:00Z", headSha: "fix-head-1424302" });
  const younger = pr(1424303, { createdAt: "2026-10-27T01:00:00Z" });
  const deps = view([eligibleAt(older, "first-head-1424302", "2026-10-27T00:10:00Z")]);
  const early = lightPassEarlyReviewBatch([younger, older], [younger], deps);
  assert.deepEqual(early.map((p) => p.prNumber), [younger.prNumber],
    "the earlier-eligible input starts in the early batch instead of waiting for the post-refresh batch");
  assert.deepEqual(admissionOrder([younger, older], deps), [younger.prNumber, older.prNumber],
    "admission ranks the same input first");
});

test("W1-T14243 criterion 2: the split orders inputs as selectReviewAdmissions does, and a guarded head eligible first keeps its place", () => {
  // By createdAt the unarmed PRs are older; by when each current head became eligible, the guarded head is second.
  const guarded = pr(1424312, { autoMergeArmed: true, createdAt: "2026-10-27T01:00:00Z", headSha: "fix-head-1424312" });
  const ahead = pr(1424314, { createdAt: "2026-10-27T01:30:00Z" });
  const later = pr(1424313, { createdAt: "2026-10-27T00:00:00Z", headSha: "fix-head-1424313" });
  const laterStill = pr(1424315, { createdAt: "2026-10-27T00:30:00Z", headSha: "fix-head-1424315" });
  const deps = view([
    eligibleAt(later, "first-head-1424313", "2026-10-27T00:10:00Z"),
    eligibleAt(laterStill, "first-head-1424315", "2026-10-27T00:40:00Z"),
    eligibleAt(guarded, "first-head-1424312", "2026-10-27T01:10:00Z"),
    currentHeadEligibleAt(guarded, "2026-10-27T02:00:00Z"),
    currentHeadEligibleAt(later, "2026-10-27T03:00:00Z"),
    currentHeadEligibleAt(laterStill, "2026-10-27T04:00:00Z"),
  ]);
  const candidates = [later, laterStill, guarded, ahead];
  const order = admissionOrder(candidates, deps);
  assert.deepEqual(order, [ahead.prNumber, guarded.prNumber, later.prNumber, laterStill.prNumber]);
  const early = lightPassEarlyReviewBatch(candidates, [later, laterStill, ahead], deps);
  assert.deepEqual(early.map((p) => p.prNumber), order.slice(0, order.indexOf(guarded.prNumber)),
    "exactly the inputs admission ranks ahead of the guarded head start early; the rest keep behind it");

  // With no eligibility rows each PR keeps its createdAt, as admission does.
  const bare = view([]);
  const bareEarly = lightPassEarlyReviewBatch(candidates, [later, laterStill, ahead], bare);
  const bareOrder = admissionOrder(candidates, bare);
  assert.deepEqual(bareOrder, [later.prNumber, laterStill.prNumber, guarded.prNumber, ahead.prNumber]);
  assert.deepEqual(bareEarly.map((p) => p.prNumber), bareOrder.slice(0, bareOrder.indexOf(guarded.prNumber)));

  // With no delayed candidate every early candidate starts, and the split reads no ledger.
  const unread = view([]);
  assert.deepEqual(lightPassEarlyReviewBatch([later, ahead], [later, ahead], unread), [later, ahead]);
  assert.equal(unread.reads(), 0);
});
