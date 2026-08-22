import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  DEFAULT_SWEEP_POLICY,
  absentAgeMinutes,
  deriveDisposition,
  runSweep,
  type ClarificationQuestion,
  type FixDispatchEvidence,
  type OpenPrView,
  type SweepDeps,
} from "../src/lib/sweep.js";
import {
  FLEET_NOTICE_LABEL,
  NEEDS_HUMAN_LABEL,
  escalate,
  escalateWithJudge,
  renderIssueBody,
  type Escalation,
  type IssueGateway,
} from "../src/lib/escalate.js";

// W1-T1103 — "the escalation rung opens issues it can never retire": three defects, one
// lifecycle guarantee. (i) sweep.ts must not escalate on a required check that has merely NOT
// STARTED (a young `checksState: "none"` head); (ii) escalate.ts must never open an issue
// missing the `needs-human`/`fleet-notice` queue label the retirement path filters on; (iii)
// escalate.ts must refuse to open an issue whose Task field names no referent any lookup can
// resolve, rather than minting a permanent operator obligation.

// ── Fixture clock — pinned, exactly like sweep-absent-repush.test.ts's own discipline: the
// NOT-YET-SCHEDULED row is time-gated, so a wall-clock read here would make these tests rot. ──
const NOW = Date.parse("2026-08-21T12:00:00Z");
const minsAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

function ledgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), "rmd-escalation-retirability-")), "ledger.ndjson");
}

function pr(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 2301,
    prUrl: "https://github.com/craigoley/remudero/pull/2301",
    taskId: "W1-T1103",
    reviewState: "none",
    checksState: "none",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: minsAgo(60),
    headSha: "aaaa2301bbbb",
    headRefName: "run-W1-T1103-fixture",
    autoMergeArmed: false,
    ...over,
  };
}

function fakeSweepDeps(overrides: Partial<SweepDeps> = {}): SweepDeps & {
  escalated: Array<{ pr: OpenPrView; reason: string; question: ClarificationQuestion }>;
} {
  const escalated: Array<{ pr: OpenPrView; reason: string; question: ClarificationQuestion }> = [];
  return {
    escalated,
    arm: () => {},
    close: () => {},
    dispatchFix: (_p: OpenPrView, _e: FixDispatchEvidence) => {},
    escalate: (p, reason, question) => {
      escalated.push({ pr: p, reason, question });
    },
    ledgerPath: ledgerPath(),
    runId: "SWEEP-RETIRABILITY-1",
    now: () => NOW,
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
// (i) NOT-YET-SCHEDULED: a required check with zero runs on a head too young to have been
//     scheduled disposes to WAIT and opens nothing; a genuinely absent check on an older head
//     still escalates exactly as it does today.
// ═══════════════════════════════════════════════════════════════════════════════════════════

test("deriveDisposition: checksState 'none' 2 minutes after the push -> wait, never blocked-ambiguous", () => {
  const young = pr({ checksState: "none", lastActivityAt: minsAgo(2) });
  const result = deriveDisposition(young, DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(result.disposition, "wait");
  assert.match(result.reason, /not yet scheduled/);
  assert.match(result.reason, /2\.0m/);
});

test("deriveDisposition: checksState 'none' right at the ceiling still waits; just past it escalates", () => {
  const atCeiling = pr({ checksState: "none", lastActivityAt: minsAgo(DEFAULT_SWEEP_POLICY.absentCeilingMinutes) });
  assert.equal(deriveDisposition(atCeiling, DEFAULT_SWEEP_POLICY, NOW).disposition, "blocked-ambiguous");

  const justUnder = pr({
    checksState: "none",
    lastActivityAt: minsAgo(DEFAULT_SWEEP_POLICY.absentCeilingMinutes - 0.5),
  });
  assert.equal(deriveDisposition(justUnder, DEFAULT_SWEEP_POLICY, NOW).disposition, "wait");
});

test("deriveDisposition: a genuinely absent required check on an hour-old head still escalates exactly as it does today — blocked-ambiguous, terminal catch-all wording unchanged", () => {
  const stale = pr({ checksState: "none", reviewState: "none", lastActivityAt: minsAgo(60) });
  const result = deriveDisposition(stale, DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(result.disposition, "blocked-ambiguous");
  assert.equal(result.reason, "not positively mergeable — checks none, review none — escalating");
});

test("deriveDisposition: an unreadable head age fails TOWARD escalate, never toward wait — an unparseable timestamp is not evidence of youth", () => {
  const undated = pr({ checksState: "none", lastActivityAt: "not-a-real-timestamp" });
  assert.equal(absentAgeMinutes(undated, NOW), undefined);
  assert.equal(deriveDisposition(undated, DEFAULT_SWEEP_POLICY, NOW).disposition, "blocked-ambiguous");
});

test("deriveDisposition: NOT-YET-SCHEDULED never fires outside the structural 'none' shape — a dirty PR still routes CONFLICTED first, a pending PR still routes PENDING", () => {
  const dirty = pr({ checksState: "none", mergeState: "dirty", lastActivityAt: minsAgo(1) });
  assert.notEqual(deriveDisposition(dirty, DEFAULT_SWEEP_POLICY, NOW).disposition, "wait");

  const pending = pr({ checksState: "pending", lastActivityAt: minsAgo(1) });
  assert.notEqual(deriveDisposition(pending, DEFAULT_SWEEP_POLICY, NOW).disposition, "blocked-ambiguous");
});

test("runSweep: a PR whose required check has zero runs 2 minutes after the push opens NO escalation this pass", async () => {
  const deps = fakeSweepDeps();
  const young = pr({ checksState: "none", lastActivityAt: minsAgo(2) });
  await runSweep([young], deps, DEFAULT_SWEEP_POLICY);
  assert.equal(deps.escalated.length, 0, "a merely-starting PR must never mint an unretirable issue");
});

test("runSweep: the SAME PR an hour later (checks still zero-run) escalates exactly as today", async () => {
  const deps = fakeSweepDeps();
  const stale = pr({ checksState: "none", reviewState: "none", lastActivityAt: minsAgo(60) });
  await runSweep([stale], deps, DEFAULT_SWEEP_POLICY);
  assert.equal(deps.escalated.length, 1, "a genuinely absent required check must still reach an operator");
  assert.equal(deps.escalated[0].pr.prNumber, stale.prNumber);
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// (ii) EVERY escalation this system opens carries the queue label the retirement path filters
//      on (`RETIRABLE_ESCALATION_LABELS`, sweep.ts) — even when a decorative label's own
//      provisioning fails, and even when EVERY label's provisioning fails at once (the measured
//      six-issue shape: an issue opened with no label at all).
// ═══════════════════════════════════════════════════════════════════════════════════════════

function escalation(over: Partial<Escalation> = {}): Escalation {
  return {
    class: "BLOCKED",
    taskId: "W1-T1103",
    summary: "required check has zero observed check runs",
    detail: "https://github.com/craigoley/remudero/pull/2301 — checks never registered",
    options: [
      { label: "post the check", detail: "re-run the deterministic post" },
      { label: "investigate", detail: "look at the check suite by hand" },
    ],
    recommendation: "post the check",
    ...over,
  };
}

function fakeIssuesWithLabels(
  ensure: (label: string) => boolean,
  url = "https://github.com/craigoley/remudero/issues/2301",
): IssueGateway & { calls: Array<{ title: string; body: string; labels: string[] }>; ensured: string[] } {
  const calls: Array<{ title: string; body: string; labels: string[] }> = [];
  const ensured: string[] = [];
  return {
    calls,
    ensured,
    ensureLabel(label) {
      ensured.push(label);
      return ensure(label);
    },
    create(title, body, labels) {
      calls.push({ title, body, labels });
      return url;
    },
  };
}

test("escalate: the queue label is attached even when ITS OWN provisioning fails — only the decorative labels may degrade", () => {
  const issues = fakeIssuesWithLabels((label) => label !== NEEDS_HUMAN_LABEL);
  const path = ledgerPath();
  const url = escalate(escalation(), { issues, ledgerPath: path, runId: "RUN-1" });

  assert.equal(url, "https://github.com/craigoley/remudero/issues/2301");
  assert.ok(
    issues.calls[0].labels.includes(NEEDS_HUMAN_LABEL),
    "the retirement path filters on this label — it must never be dropped from create()",
  );
});

test("escalate: the measured six-issue shape — EVERY label's provisioning fails at once — still opens with the queue label attached", () => {
  const issues = fakeIssuesWithLabels(() => false);
  const url = escalate(escalation(), { issues, ledgerPath: ledgerPath(), runId: "RUN-1" });

  assert.equal(url, "https://github.com/craigoley/remudero/issues/2301");
  assert.deepEqual(
    issues.calls[0].labels,
    [NEEDS_HUMAN_LABEL],
    "class/ask-type labels degrade as W1-T99 always allowed; the queue label alone is non-negotiable",
  );
});

test("escalate: a gateway with no ensureLabel at all still attaches the queue label (back-compat)", () => {
  const calls: Array<{ title: string; body: string; labels: string[] }> = [];
  const issues: IssueGateway = {
    create(title, body, labels) {
      calls.push({ title, body, labels });
      return "https://github.com/craigoley/remudero/issues/2301";
    },
  };
  escalate(escalation(), { issues, ledgerPath: ledgerPath(), runId: "RUN-1" });
  assert.ok(calls[0].labels.includes(NEEDS_HUMAN_LABEL));
});

test("escalateWithJudge: a DEMOTED escalation still carries the fleet-notice queue label even when its provisioning fails", async () => {
  const issues = fakeIssuesWithLabels((label) => label !== FLEET_NOTICE_LABEL);
  const url = await escalateWithJudge(escalation(), {
    issues,
    ledgerPath: ledgerPath(),
    runId: "RUN-1",
    judge: async () => ({ decision: "demote", reason: "low priority, batching into the recap" }),
  });
  assert.equal(url, "https://github.com/craigoley/remudero/issues/2301");
  assert.ok(issues.calls[0].labels.includes(FLEET_NOTICE_LABEL));
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// (iii) An escalation whose referent no lookup can resolve is refused rather than opened.
// ═══════════════════════════════════════════════════════════════════════════════════════════

test("escalate: refuses an empty Task field with no PR nameable anywhere in its own text — rationale (5)'s no_task_trailer shape", () => {
  const issues = fakeIssuesWithLabels(() => true);
  assert.throws(
    () => escalate(escalation({ taskId: "", summary: "starving", detail: "no PR named here at all" }), {
      issues,
      ledgerPath: ledgerPath(),
      runId: "RUN-1",
    }),
    /no resolvable referent/,
  );
  assert.equal(issues.calls.length, 0, "nothing is opened when the referent cannot resolve");
});

test("escalate: refuses a literal 'undefined' Task field with no PR nameable anywhere in its own text — rationale (5)'s stringified-undefined shape", () => {
  const issues = fakeIssuesWithLabels(() => true);
  assert.throws(
    () => escalate(escalation({ taskId: "undefined", detail: "checks never registered, no pull link here" }), {
      issues,
      ledgerPath: ledgerPath(),
      runId: "RUN-1",
    }),
    /no resolvable referent/,
  );
  assert.equal(issues.calls.length, 0);
});

test("escalate: a broken Task field is NORMALIZED to the synthetic PR-<n> referent when a PR IS nameable in the escalation's own text — the SAME shape the reconciler already resolves via a bare PR-number lookup", () => {
  const issues = fakeIssuesWithLabels(() => true);
  const url = escalate(
    escalation({
      taskId: "undefined",
      detail: "https://github.com/craigoley/remudero/pull/2297 — checks never registered",
    }),
    { issues, ledgerPath: ledgerPath(), runId: "RUN-1" },
  );
  assert.equal(url, "https://github.com/craigoley/remudero/issues/2301");
  assert.match(issues.calls[0].body, /\*\*Task:\*\* PR-2297/);
});

test("escalate: a real plan task id passes through byte-identical — no regression for the ordinary case", () => {
  const issues = fakeIssuesWithLabels(() => true);
  escalate(escalation({ taskId: "W1-T1103" }), { issues, ledgerPath: ledgerPath(), runId: "RUN-1" });
  assert.match(issues.calls[0].body, /\*\*Task:\*\* W1-T1103/);
});

test("escalate: GRILL's own referent shape (TRIAGE-<feedbackId>, never a PR) is UNAFFECTED — the async needs-human issue is the only viable grill mechanism and must never be refused", () => {
  const issues = fakeIssuesWithLabels(() => true);
  const url = escalate(
    escalation({
      class: "GRILL",
      taskId: "TRIAGE-fb-1787339128753-abc123",
      summary: "feedback#fb-1787339128753-abc123 needs a human call",
      detail: "Feedback: something ambiguous.\n\nOpen question: which of these two readings?",
    }),
    { issues, ledgerPath: ledgerPath(), runId: "RUN-1" },
  );
  assert.equal(url, "https://github.com/craigoley/remudero/issues/2301");
  assert.match(issues.calls[0].body, /\*\*Task:\*\* TRIAGE-fb-1787339128753-abc123/);
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// (iv) THE LIFECYCLE GUARANTEE, tested as one property: an escalation this system opens is
//      labelled, names a resolvable referent, and was never opened against a head too young to
//      have been scheduled.
// ═══════════════════════════════════════════════════════════════════════════════════════════

test("lifecycle guarantee: a too-young zero-run head opens nothing; a genuinely absent one opens an issue that is labelled AND names a resolvable referent", async () => {
  const issues = fakeIssuesWithLabels(() => true);
  const path = ledgerPath();

  const deps: SweepDeps = {
    arm: () => {},
    close: () => {},
    dispatchFix: () => {},
    escalate: (p, reason, question) => {
      escalate(
        {
          class: "BLOCKED",
          taskId: p.taskId ?? `PR-${p.prNumber}`,
          runId: "SWEEP-LIFECYCLE-1",
          summary: `PR #${p.prNumber} blocked-ambiguous: ${reason}`,
          detail: `${question.question}\n\n${p.prUrl}`,
          options: [
            { label: question.resolutions[0].label, detail: question.resolutions[0].detail },
            { label: question.resolutions[1].label, detail: question.resolutions[1].detail },
          ],
          recommendation: question.resolutions[0].label,
        },
        { issues, ledgerPath: path, runId: "SWEEP-LIFECYCLE-1" },
      );
    },
    ledgerPath: path,
    runId: "SWEEP-LIFECYCLE-1",
    now: () => NOW,
  };

  const young = pr({ prNumber: 2400, checksState: "none", lastActivityAt: minsAgo(2) });
  const old = pr({ prNumber: 2401, checksState: "none", reviewState: "none", lastActivityAt: minsAgo(60) });

  await runSweep([young, old], deps, DEFAULT_SWEEP_POLICY);

  // Arm (i): the young head opened nothing.
  assert.equal(issues.calls.length, 1, "exactly one escalation — the genuinely absent head, never the young one");

  // Arm (ii): the one issue that DID open carries the queue label.
  assert.ok(issues.calls[0].labels.includes(NEEDS_HUMAN_LABEL));

  // Arm (iii): its Task field is a resolvable referent (a real plan task id here).
  assert.match(issues.calls[0].body, /\*\*Task:\*\* W1-T1103/);
});

// ── Direct render check: renderIssueBody's Task line is exactly what the reconciler's own
//    `\S+` read requires — a sanity check that the fixture text above means what it claims. ──
test("renderIssueBody: the Task line carries at least one non-whitespace character whenever taskId is non-empty", () => {
  const body = renderIssueBody(escalation({ taskId: "PR-2297" }));
  assert.match(body, /^\*\*Task:\*\* PR-2297$/m);
});
