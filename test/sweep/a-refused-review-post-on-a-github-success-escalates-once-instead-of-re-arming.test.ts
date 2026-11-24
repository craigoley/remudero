/**
 * W1-T13560 — a pull request with a GitHub remudero-review success, no completed fleet review.posted for its exact
 * input, and a refused post for that input is escalated once per head instead of being disposed mergeable and refused
 * by the arm every pass. A missing-review-evidence hold is said once and never left to repeat silently.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  changesRequestedHold, changesRequestedReason, DEFAULT_SWEEP_POLICY, deriveDisposition, runSweep, type OpenPrView, type SweepDeps,
} from "#src/lib/sweep.js";

const NOW = Date.parse("2026-11-24T12:00:00Z");

/** The refused-post shape: GitHub success, green checks, digest present, explicit zero attempts, one refusal. */
function refusedSuccess(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 77, prUrl: "https://github.com/o/r/pull/77", taskId: "W1-TX",
    reviewState: "success", checksState: "green", unmetCriteria: [], priorStrikes: 0,
    lastActivityAt: "2026-11-23T12:00:00Z", headSha: "aaaa111", autoMergeArmed: false,
    reviewInputDigest: "v1:refused-success", priorReviewAttemptsForInput: 0, reviewPostRefused: true,
    ...over,
  };
}

function deps(over: Partial<SweepDeps> = {}): SweepDeps & { armed: OpenPrView[]; escalated: OpenPrView[]; posted: number[] } {
  const armed: OpenPrView[] = [];
  const escalated: OpenPrView[] = [];
  const posted: number[] = [];
  return {
    armed, escalated, posted,
    arm: (p) => { armed.push(p); },
    close: () => undefined,
    dispatchFix: () => undefined,
    escalate: (p) => { escalated.push(p); },
    postReview: (p) => { posted.push(p.prNumber); },
    ledgerPath: join(mkdtempSync(join(tmpdir(), "rmd-t13560-")), "ledger.ndjson"),
    runId: "SWEEP-T13560",
    now: () => NOW,
    ...over,
  } as SweepDeps & { armed: OpenPrView[]; escalated: OpenPrView[]; posted: number[] };
}

test("W1-T13560 criterion 1: a refused post on a github success is blocked-ambiguous escalated, not mergeable", () => {
  const r = deriveDisposition(refusedSuccess(), DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(r.disposition, "blocked-ambiguous");
  assert.equal(r.blocker, "escalated");
});

test("W1-T13560 criterion 1: runSweep escalates once and neither arms nor re-posts", async () => {
  const d = deps();
  const summary = await runSweep([refusedSuccess()], d, DEFAULT_SWEEP_POLICY);
  assert.equal(summary.byDisposition["blocked-ambiguous"], 1);
  assert.equal(summary.byDisposition["mergeable"] ?? 0, 0);
  assert.equal(d.escalated.length, 1);
  assert.deepEqual(d.armed, [], "no arm call for a pull request the arm would refuse");
  assert.deepEqual(d.posted, [], "the refused input is not re-posted");
});

test("W1-T13560 criterion 2: the reason names the refused post and offers a way out", () => {
  const r = deriveDisposition(refusedSuccess(), DEFAULT_SWEEP_POLICY, NOW);
  assert.match(r.reason, /post attempt was refused/);
  assert.match(r.reason, /exact input/);
  assert.match(r.reason, /the arm refuses without a review\.posted for it/);
  assert.match(r.reason, /new head/);
  assert.match(r.reason, /operator/);
});

test("W1-T13560 criterion 2: repeated passes at the same head and input escalate once and never call the arm", async () => {
  const shared = join(mkdtempSync(join(tmpdir(), "rmd-t13560-passes-")), "ledger.ndjson");
  const first = deps({ ledgerPath: shared });
  await runSweep([refusedSuccess()], first, DEFAULT_SWEEP_POLICY);
  assert.equal(first.escalated.length, 1, "the first pass escalates the missing-review-evidence hold");
  for (let pass = 2; pass <= 3; pass += 1) {
    const again = deps({ ledgerPath: shared });
    const summary = await runSweep([refusedSuccess()], again, DEFAULT_SWEEP_POLICY);
    assert.equal(summary.byDisposition["blocked-ambiguous"], 1, `pass ${pass} still names the hold`);
    assert.equal(summary.byDisposition["mergeable"] ?? 0, 0, `pass ${pass} never disposes it mergeable`);
    assert.equal(again.escalated.length, 0, `pass ${pass} at the same head is deduped, never a second escalation`);
    assert.deepEqual(again.armed, [], `pass ${pass} never calls the arm`);
    assert.deepEqual(again.posted, [], `pass ${pass} never re-posts the refused input`);
  }
});

test("W1-T13560 criterion 2: a new head or body digest with no refusal is disposed post-review as before", () => {
  const changedHead = refusedSuccess({ headSha: "bbbb222", reviewInputDigest: "v1:changed-head", reviewPostRefused: undefined });
  assert.equal(deriveDisposition(changedHead, DEFAULT_SWEEP_POLICY, NOW).disposition, "post-review");
  const changedBody = refusedSuccess({ reviewInputDigest: "v1:changed-body", reviewPostRefused: false });
  assert.equal(deriveDisposition(changedBody, DEFAULT_SWEEP_POLICY, NOW).disposition, "post-review");
});

const REFUSED_ROW = /post attempt was refused/;

test("W1-T13560 criterion 3: a reviewed input, a view with no attempt count and an unrefused success are disposed as before", () => {
  const disposition = (over: Partial<OpenPrView>): string =>
    deriveDisposition(refusedSuccess(over), DEFAULT_SWEEP_POLICY, NOW).disposition;
  // A completed review.posted for the exact input (attempts >= 1) still arms, and the refusal flag is inert there:
  // the whole result equals the same view with no refusal at all, exactly as on origin/main.
  const reviewed = deriveDisposition(refusedSuccess({ priorReviewAttemptsForInput: 1 }), DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(reviewed.disposition, "mergeable");
  assert.deepEqual(
    reviewed,
    deriveDisposition(refusedSuccess({ priorReviewAttemptsForInput: 1, reviewPostRefused: undefined }), DEFAULT_SWEEP_POLICY, NOW),
  );
  // A view with no attempt count, or no digest, is never read as a missing judgment.
  assert.equal(disposition({ priorReviewAttemptsForInput: undefined }), "mergeable");
  assert.equal(disposition({ reviewInputDigest: undefined }), "mergeable");
  // An unrefused success is still re-reviewed through post-review.
  assert.equal(disposition({ reviewPostRefused: undefined }), "post-review");
  assert.equal(disposition({ reviewPostRefused: false }), "post-review");
  // A plan PR merges directly and is left to the mergeable row.
  assert.equal(disposition({ isPlanFiling: true }), "mergeable");
  assert.equal(disposition({ changedFiles: ["plan/tasks.d/W1-T1.yaml"] }), "mergeable");
  // Unreadable required contexts and non-green checks never reach the new row.
  assert.doesNotMatch(
    deriveDisposition(refusedSuccess({ requiredContextsUnreadable: true }), DEFAULT_SWEEP_POLICY, NOW).reason,
    REFUSED_ROW,
    "unreadable required contexts are not read as a refused-post hold",
  );
  assert.notEqual(disposition({ checksState: "red" }), "mergeable");
  assert.notEqual(disposition({ checksState: "pending" }), "mergeable");
});

test("W1-T13560 criterion 3: a draft with a refused post is still held-draft, not the new row", () => {
  const r = deriveDisposition(refusedSuccess({ isDraft: true }), DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(r.disposition, "held-draft");
  assert.equal(r.blocker, "held-draft");
  assert.match(r.reason, /draft/);
  assert.doesNotMatch(r.reason, REFUSED_ROW);
});

test("W1-T13560 criterion 3: a capped verdict with a refused post is still the capped escalation", () => {
  const r = deriveDisposition(refusedSuccess({ armRefusalIsTerminal: true }), DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(r.disposition, "blocked-ambiguous");
  assert.equal(r.blocker, "plan-proof-unrunnable");
  assert.match(r.reason, /CAPPED/);
  assert.doesNotMatch(r.reason, REFUSED_ROW);
});

test("W1-T13560 criterion 3: a changes-requested hold with a refused post is still named as the person's hold", () => {
  const held = refusedSuccess({
    autoMergeArmed: true, mergeable: true, mergeableState: "blocked",
    scannerBlocker: { kind: "changes-requested", headSha: "aaaa111",
      holds: [{ login: "cao825", reviewId: 7, commitId: "aaaa111", submittedAt: "" }] },
  });
  assert.notEqual(changesRequestedHold(held), undefined, "the fixture is a live human hold at this head");
  const r = deriveDisposition(held, DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(r.disposition, "blocked-ambiguous");
  assert.equal(r.blocker, "escalated");
  assert.equal(r.reason, changesRequestedReason(held));
  assert.match(r.reason, /cao825/);
  assert.doesNotMatch(r.reason, REFUSED_ROW);
});
