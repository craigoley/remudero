// W1-T3063 — PR #4461, a validated implementation of W1-T2371, was closed by the sweep against
// #3195: `chore(plan): record that W1-T2371's amendment-block trigger …`, one shard file. The
// mechanism is still absent on main, so the work was destroyed rather than superseded.
//
// The refusal meant to stop this reads a `pr.opened` row's `plan_only` field; #3195's archived row
// carries no such field, so it failed OPEN. This suite pins the replacement: positive evidence of
// an implementation, or no close.

import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_SWEEP_POLICY,
  FILING_SUBJECT_RE,
  creditSubjectIsImplementation,
  deriveDisposition,
  projectMergedTaskCandidates,
  type CreditCandidate,
  type OpenPrView,
} from "../src/lib/sweep.js";

function openPr(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 4461,
    prUrl: "https://github.com/craigoley/remudero/pull/4461",
    taskId: "W1-T2371",
    reviewState: "success",
    checksState: "green",
    unmetCriteria: [],
    priorStrikes: 0,
    strikeHistory: [],
    lastActivityAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    headSha: "t3063head",
    autoMergeArmed: false,
    isDependabot: false,
    ...over,
  } as OpenPrView;
}

const credit = (over: Partial<CreditCandidate> = {}): CreditCandidate[] => [
  { taskId: "W1-T2371", prNumber: 3195, prUrl: "https://github.com/craigoley/remudero/pull/3195", merged: true, ...over },
];

/** projection THEN disposition — the composition the sweep performs. */
function dispose(pr: OpenPrView, candidates: CreditCandidate[]) {
  const [projected] = projectMergedTaskCandidates([pr], candidates);
  return { projected, decision: deriveDisposition(projected, DEFAULT_SWEEP_POLICY) };
}

test("W1-T3063 criterion 1: THE #4461 INCIDENT — a filing credit never closes a build", () => {
  const subject = "chore(plan): record that W1-T2371's amendment-block trigger fired";
  const { projected, decision } = dispose(openPr(), credit({ creditIsImplementation: creditSubjectIsImplementation(subject) }));
  assert.equal(projected.taskMergedBy, undefined, "a chore(plan) credit must not stamp");
  assert.doesNotMatch(decision.reason, /already merged/, "and must not reach the close row");
});

test("W1-T3063 criterion 2 (falsifier): AN UNKNOWN SUBJECT ALSO DECLINES", () => {
  // Absence of evidence is not evidence of supersession. A credit older than the scan window, or a
  // failed git read, must leave the PR open.
  for (const flag of [undefined, false]) {
    const [projected] = projectMergedTaskCandidates([openPr()], credit({ creditIsImplementation: flag }));
    assert.equal(projected.taskMergedBy, undefined, `creditIsImplementation=${String(flag)} must decline`);
  }
});

test("W1-T3063 criterion 3 (falsifier): W1-T2794's OWN INCIDENT MUST STILL CLOSE", () => {
  // A fix that made the rung inert would trade a destroyed PR for the stranded, endlessly
  // escalating PR W1-T2794 removed. That is not an improvement.
  const subject = "feat(sweep): close a leftover open PR once its task is credited merged (#3874)";
  const { projected, decision } = dispose(
    openPr({ prNumber: 3877, taskId: "W1-T2786" }),
    credit({ taskId: "W1-T2786", prNumber: 3874, creditIsImplementation: creditSubjectIsImplementation(subject) }),
  );
  assert.equal(projected.taskMergedBy, 3874);
  assert.match(decision.reason, /already merged by #3874/);
  assert.equal(decision.disposition, "stale");
});

test("W1-T3063 criterion 4: the filing vocabulary is lint-plan's, not a second list", () => {
  // Direct, literal both-arm drive: the shape negative-reachability-ratchet recognises.
  assert.equal(FILING_SUBJECT_RE.test("chore(plan): file a shard"), true);
  assert.equal(FILING_SUBJECT_RE.test("chore(triage): record a finding"), true);
  assert.equal(FILING_SUBJECT_RE.test("chore(feedback): note a ruling"), true);
  assert.equal(FILING_SUBJECT_RE.test("docs(plan): restate a rule"), true);
  assert.equal(FILING_SUBJECT_RE.test("plan: file"), true);
  assert.equal(FILING_SUBJECT_RE.test("docs: a doc"), true);
  assert.equal(FILING_SUBJECT_RE.test("chore: housekeeping"), true);
  assert.equal(FILING_SUBJECT_RE.test("feat(sweep): build a thing"), false);
  assert.equal(FILING_SUBJECT_RE.test("fix(status): repair a thing"), false);
  assert.equal(FILING_SUBJECT_RE.test("ci: wire a gate"), false);
});

test("W1-T3063: the subject predicate is three-valued, never two", () => {
  assert.equal(creditSubjectIsImplementation("feat(x): do it"), true);
  assert.equal(creditSubjectIsImplementation("chore(plan): file it"), false);
  assert.equal(creditSubjectIsImplementation(undefined), undefined, "unread is not 'not an implementation'");
  assert.equal(creditSubjectIsImplementation("   "), undefined, "blank is unread, not a verdict");
});

test("W1-T3063 (falsifier): a filing credit cannot close even a PR that is otherwise closable", () => {
  // The PR is green, reviewed and would be stale-closed the moment the credit were admitted — so
  // the decline here is the guard's doing, not an unrelated row's.
  const admitted = dispose(openPr(), credit({ creditIsImplementation: true }));
  assert.equal(admitted.decision.disposition, "stale", "sanity: this fixture DOES close on a real credit");
  const refused = dispose(openPr(), credit({ creditIsImplementation: false }));
  assert.notEqual(refused.decision.disposition, "stale");
});
