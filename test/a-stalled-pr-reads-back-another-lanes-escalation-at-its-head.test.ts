// test/a-stalled-pr-reads-back-another-lanes-escalation-at-its-head.test.ts
//
// LIVE 2026-11-01: about 22 stall issues read "already escalated (reason unreadable: no escalation of this PR
// at head … is in the ledger)". The fix lane HAD escalated those heads -- a scope amendment it could not grant,
// an instrument edit, a stand-down -- but `ownEscalationAtHead` read only the sweep's own `sweep.disposed` rows.
// So #15818 (the stall report) said no escalation existed while #15816 (the fix lane's question) was open on
// the same head. The readback now also reads the escalation transport's own birth rows, which every lane's
// issue crosses, and the fix lane's scope-amendment escalations.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readLedgerLines } from "#src/lib/status.js";
import { ownEscalationAtHead, runSweepLightPass, type OpenPrView, type SweepDeps } from "#test/helpers/sweep-test.js";
import { writeLedger } from "#test/helpers/ledger-fixture.js";

const NOW = Date.parse("2026-11-01T10:05:49.864Z");
const HEAD = "5e1c0ffee5e1c0ffee5e1c0ffee5e1c0ffee5e1c";
const TASK = "W1-T11001";
const PR_URL = "https://github.com/craigoley/remudero/pull/15800";
const ISSUE = "https://github.com/craigoley/remudero/issues/15816";
const SUMMARY = `PR #15800 needs an instrument edit only the operator can grant — ${PR_URL}`;
const at = (iso: string) => `2026-11-01T${iso}Z`;

const stalled: OpenPrView = {
  prNumber: 15800, prUrl: PR_URL, taskId: TASK, headSha: HEAD, headRefName: "run-W1-T11001-1793500000000",
  reviewState: "failure", checksState: "green",
  unmetCriteria: [{ claim: "the instrument agrees", reason: "it does not" }] as OpenPrView["unmetCriteria"],
  priorStrikes: 1, lastActivityAt: at("05:28:03"), autoMergeArmed: false,
  strikeHistory: [{ strike: 1, round: "fresh", unmetCount: 1, unmetClaims: ["the instrument agrees"], ciGreen: true, reviewState: "failure" }],
  progressEscalation: { loop: "the same criterion twice", reason: "another round would repeat it", judged: true },
};

/** The fix lane's instrument-scope question, as `rmd fix` writes it: the transport's birth row, then its own row. */
function fixLaneEscalation(head = HEAD, subjectHead: string | null = head): Record<string, unknown>[] {
  return [
    { ts: at("06:00:00"), run_id: "FIX-1793520000000", task_id: TASK, step: "escalation.issue_opened", class: "BLOCKED",
      issue_url: ISSUE, labels: ["needs-human"],
      triage_subject: { class: "BLOCKED", taskId: TASK, summary: SUMMARY, detail: `${PR_URL} needs instrument edits`,
        ...(subjectHead === null ? {} : { headSha: subjectHead }), cause: "ci", options: [], recommendation: "route-repair" } },
    { ts: at("06:00:01"), run_id: "FIX-1793520000000", task_id: "FIX", lane: "fix", step: "fix.scope_amendment",
      outcome: "instrument-escalated", pr_number: stalled.prNumber, head_sha: head, issue_url: ISSUE,
      reason: "instrument scope need escalated", paths: ["scripts/diff-coverage.mjs"] },
  ];
}

test("the fix lane's escalation at this head is read back, not reported unreadable", () => {
  const found = ownEscalationAtHead(fixLaneEscalation(), stalled);
  assert.deepEqual(found, { ts: at("06:00:00"), reason: SUMMARY, issueUrl: ISSUE });
  // Its own scope row alone still names the escalation.
  const scopeOnly = ownEscalationAtHead(fixLaneEscalation().slice(1), stalled);
  assert.deepEqual(scopeOnly, { ts: at("06:00:01"), reason: "instrument scope need escalated: scripts/diff-coverage.mjs", issueUrl: ISSUE });
});

test("another lane's escalation is read back only at this PR and head, and never a stall report's own issue", () => {
  assert.equal(ownEscalationAtHead(fixLaneEscalation("0123456789abcdef0123456789abcdef01234567"), stalled), undefined);
  assert.equal(ownEscalationAtHead(fixLaneEscalation(), { prNumber: 15801, headSha: HEAD }), undefined);
  const stallBirth = { ts: at("07:00:00"), run_id: "SWEEP-1", task_id: TASK, step: "escalation.issue_opened",
    issue_url: "https://github.com/craigoley/remudero/issues/15818",
    triage_subject: { taskId: TASK, summary: `PR ${PR_URL} needs a clarification — PR stage stalled: #15800 ${PR_URL} — escalated`,
      detail: "", headSha: HEAD, cause: "stage-stall" } };
  assert.equal(ownEscalationAtHead([stallBirth], stalled), undefined);
  // A birth that recorded no head counts only when its own run observed this head.
  const headless = fixLaneEscalation(HEAD, null);
  assert.equal(ownEscalationAtHead([headless[0]!], stalled), undefined);
  const observed = { ts: at("05:59:00"), run_id: "FIX-1793520000000", task_id: "FIX", step: "fix.instrument_entangled",
    pr_url: PR_URL, head_sha: HEAD };
  assert.deepEqual(ownEscalationAtHead([observed, headless[0]!], stalled), { ts: at("06:00:00"), reason: SUMMARY, issueUrl: ISSUE });
});

test("a stalled escalated PR names the fix lane's open escalation instead of reason unreadable", async () => {
  const ledger = writeLedger(fixLaneEscalation());
  const escalations: string[] = [];
  const deps: SweepDeps = {
    ledgerPath: ledger.path, runId: "DAEMON-1793520000000", now: () => NOW,
    arm: () => "hold-refused", close: () => {}, dispatchFix: () => {}, postReview: () => {},
    escalate: (_pr, reason) => { escalations.push(reason); },
    actionable: (d) => d === "post-review", standDownReasonFor: () => "deferred to full sweep (light pass)",
  };
  await runSweepLightPass([stalled], deps);
  assert.equal(escalations.length, 1, JSON.stringify(escalations));
  assert.doesNotMatch(escalations[0]!, /reason unreadable/);
  assert.ok(escalations[0]!.includes(`DIAGNOSIS: already escalated at ${at("06:00:00")} in ${ISSUE}, still awaiting an operator: ${SUMMARY}`),
    escalations[0]);
  const stuck = readLedgerLines(ledger.path).filter(row => row.step === "pr.stuck");
  assert.equal(stuck[0]?.original_escalation, "open");
  assert.equal(stuck[0]?.original_escalation_issue, ISSUE);
});
