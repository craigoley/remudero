import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { escalate, type Escalation, type IssueGateway } from "../src/lib/escalate.js";

/**
 * W1-T4659 — "A NEW HEAD OPENS A NEW NEEDS-HUMAN ISSUE AND THE OLD ONE STAYS OPEN FOREVER".
 *
 * THE DEFECT. W1-T195 deliberately made `matchDuplicateEscalation` (src/lib/escalate.ts) veto a
 * dedup match when the same (task, PR) carries a NEW head sha — a genuinely new push is a genuinely
 * new question, never silenced by an older, already-open issue. But nothing on the other side ever
 * RETIRED that older issue: OBSERVED 2026-09-28, needs-human issues #7565/#7571/#7572/#7573 (plus
 * earlier ones) all stayed open for W1-T3721/PR #7561, one per head (bcc9973, f1fd154, 069eaa9,
 * 281af01) — five open issues across two hours of re-pushes, none of them ever closed by the fleet.
 *
 * THE FIX. `escalate()`/`escalateWithJudge()`, having just opened a brand-new issue for a NEW head
 * (design clause i), now scan the SAME open-issue list the dedup search already fetched for every
 * OTHER open issue naming the identical (task, PR) whose own `**Head:**` line disagrees, and close
 * each one with a "superseded by #<new> (head <sha>)" citation, ledgered as `escalation.superseded`
 * (design clause ii). An issue for a different PR, a different task, or one with no Head line at all
 * (a legacy/un-migrated producer) is NEVER touched (design clause iii) — see the second named claim.
 *
 * FALSIFIER: skip the supersede close and the first test below finds the older head's issue still
 * open — exactly the failure mode this task exists to end.
 */

function ledgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), "rmd-supersede-")), "ledger.ndjson");
}

function escalation(over: Partial<Escalation> = {}): Escalation {
  return {
    class: "BLOCKED",
    taskId: "W1-TX",
    summary: "two strikes exhausted",
    detail: "the diagnose-armed retry still failed CI.",
    options: [
      { label: "retry", detail: "resume the run with a fresh worker" },
      { label: "abandon", detail: "drop the task and re-plan" },
    ],
    recommendation: "retry",
    ...over,
  };
}

/** Same fixture idiom as test/escalate.test.ts's `fakeIssueStore`, extended with a `closed` log so
 *  a supersede-close is distinguishable from a plain dedup-comment append (`comments`) and from a
 *  reconciler-style bare close (`closeIssue`, kept only for the "already closed" control below). */
function fakeIssueStore(): IssueGateway & {
  calls: Array<{ title: string; body: string; labels: string[] }>;
  comments: Array<{ url: string; body: string }>;
  closed: Array<{ url: string; comment: string }>;
  isOpen(url: string): boolean;
} {
  let seq = 100;
  const issues: Array<{ number: number; url: string; title: string; body: string; state: string }> = [];
  const calls: Array<{ title: string; body: string; labels: string[] }> = [];
  const comments: Array<{ url: string; body: string }> = [];
  const closed: Array<{ url: string; comment: string }> = [];
  return {
    calls,
    comments,
    closed,
    create(title, body, labels) {
      const number = seq++;
      const url = `https://github.com/craigoley/remudero/issues/${number}`;
      issues.push({ number, url, title, body, state: "open" });
      calls.push({ title, body, labels });
      return url;
    },
    listOpen() {
      return issues.filter((i) => i.state === "open").map((i) => ({ number: i.number, url: i.url, title: i.title, body: i.body }));
    },
    comment(url, body) {
      comments.push({ url, body });
    },
    closeWithComment(url, comment) {
      const found = issues.find((i) => i.url === url);
      if (found) found.state = "closed";
      closed.push({ url, comment });
    },
    isOpen(url) {
      return issues.find((i) => i.url === url)?.state === "open";
    },
  };
}

// ── claim 1: a newer head's escalation closes the older head's open issue ──────────────────────

test("W1-T4659: a newer head's escalation closes the older head's open issue for the same task and PR", () => {
  const issues = fakeIssueStore();
  const path = ledgerPath();
  const prUrl = "https://github.com/craigoley/remudero/pull/7561";
  const oldHead = "bcc9973";
  const newHead = "f1fd154";

  const first = escalate(
    escalation({
      taskId: "W1-T3721",
      headSha: oldHead,
      cause: "review",
      summary: `blocked_review fix rung exhausted (1 strike(s)) — ${prUrl}`,
    }),
    { issues, ledgerPath: path, runId: "RUN-1" },
  );

  const second = escalate(
    escalation({
      taskId: "W1-T3721",
      headSha: newHead,
      cause: "review",
      summary: `blocked_review fix rung exhausted (2 strike(s)) — ${prUrl}`,
    }),
    { issues, ledgerPath: path, runId: "RUN-2" },
  );

  assert.notEqual(second, first, "a new head still opens its own issue — W1-T195's own intent is unchanged");
  assert.equal(issues.isOpen(first), false, "the OLDER head's issue is closed once the newer head escalates");
  assert.equal(issues.isOpen(second), true, "the NEW issue itself stays open — this closes only the superseded one");
  assert.equal(issues.closed.length, 1, "exactly one issue is closed as superseded");
  assert.equal(issues.closed[0].url, first);
  assert.match(issues.closed[0].comment, new RegExp(`superseded by #\\d+`, "i"));
  assert.match(issues.closed[0].comment, new RegExp(newHead), "the closing comment names the NEW head");

  const lines = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const superseded = lines.find((l) => l.step === "escalation.superseded");
  assert.ok(superseded, "the close is ledgered as escalation.superseded");
  assert.equal(superseded.superseded_issue_url, first);
  assert.equal(superseded.new_issue_url, second);
  assert.equal(superseded.superseded_head, oldHead);
  assert.equal(superseded.new_head, newHead);
  assert.equal(superseded.delivered, true);
});

// ── claim 2: an issue for a different PR is never closed as superseded ─────────────────────────

test("W1-T4659: an issue for a different PR is never closed as superseded", () => {
  const issues = fakeIssueStore();
  const path = ledgerPath();

  const otherPrIssue = escalate(
    escalation({
      taskId: "W1-T3721",
      headSha: "aaa0001",
      cause: "review",
      summary: "blocked_review fix rung exhausted (1 strike(s)) — https://github.com/craigoley/remudero/pull/1000",
    }),
    { issues, ledgerPath: path, runId: "RUN-1" },
  );

  const samePrNewHead = escalate(
    escalation({
      taskId: "W1-T3721",
      headSha: "bbb0002",
      cause: "review",
      summary: "blocked_review fix rung exhausted (1 strike(s)) — https://github.com/craigoley/remudero/pull/2000",
    }),
    { issues, ledgerPath: path, runId: "RUN-2" },
  );

  assert.notEqual(samePrNewHead, otherPrIssue, "distinct PRs on the same task each get their own issue, as before");
  assert.equal(issues.isOpen(otherPrIssue), true, "an issue for a DIFFERENT PR is never touched — same task is not enough");
  assert.equal(issues.closed.length, 0, "nothing is closed — the two escalations never shared a PR");

  const lines = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.filter((l) => l.step === "escalation.superseded").length, 0, "no supersede row for two different PRs");
});

// ── design clause iii: a legacy issue with no Head line is never touched ───────────────────────
//
// A bare legacy issue (no Head, no Cause) permissively absorbs ANY later escalation for the same
// (task, PR) as a dedup-HIT comment (matchDuplicateEscalation's own permissive-on-absent rule) —
// so it never even reaches the "open a new issue" branch this task's close hangs off. To reach a
// genuinely reachable "no Head line, but still a fresh issue opens" state, the wedge is the 4th
// dedup dimension (contractRevision, W1-T3579): set on BOTH sides but DISAGREEING vetoes the match
// even though headSha/cause are absent on the older issue — exactly the shape this clause protects.

test("W1-T4659: an open issue with no Head line at all (a legacy/un-migrated producer) is never closed as superseded", () => {
  const issues = fakeIssueStore();
  const path = ledgerPath();
  const prUrl = "https://github.com/craigoley/remudero/pull/3000";

  // An un-migrated caller — never sets headSha/cause — opens first, recording only a contract
  // revision (some OTHER migrated dimension, never Head).
  const legacy = escalate(
    escalation({ taskId: "W1-T80", contractRevision: "rev1", summary: `blocked — ${prUrl}` }),
    { issues, ledgerPath: path, runId: "RUN-1" },
  );

  // A fully migrated caller escalates the SAME (task, PR) with a real head sha AND a DIFFERENT
  // contract revision — the contract mismatch vetoes the dedup hit, so this opens a FRESH issue.
  const withHead = escalate(
    escalation({
      taskId: "W1-T80",
      headSha: "ccc0003",
      cause: "review",
      contractRevision: "rev2",
      summary: `blocked_review fix rung exhausted — ${prUrl}`,
    }),
    { issues, ledgerPath: path, runId: "RUN-2" },
  );

  assert.notEqual(withHead, legacy, "the contract mismatch really did open a fresh issue, not a dedup-hit comment");
  assert.equal(issues.isOpen(legacy), true, "a legacy issue carrying no Head line is left exactly as before — never closed");
  assert.equal(issues.closed.length, 0);

  const lines = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.filter((l) => l.step === "escalation.superseded").length, 0, "no supersede row — a headless issue is never a candidate");
});

// ── design: the same head, a different cause, is a genuinely separate issue — never superseded ─

test("W1-T4659: two open issues sharing the SAME head but a different cause are never closed as superseded", () => {
  const issues = fakeIssueStore();
  const path = ledgerPath();
  const prUrl = "https://github.com/craigoley/remudero/pull/4000";
  const head = "ddd0004";

  const reviewIssue = escalate(
    escalation({ taskId: "W1-T81", headSha: head, cause: "review", summary: `blocked_review fix rung exhausted — ${prUrl}` }),
    { issues, ledgerPath: path, runId: "RUN-1" },
  );
  const ciIssue = escalate(
    escalation({ taskId: "W1-T81", headSha: head, cause: "ci", summary: `blocked_ci fix rung exhausted — ${prUrl}` }),
    { issues, ledgerPath: path, runId: "RUN-2" },
  );

  assert.notEqual(ciIssue, reviewIssue, "a different cause on the SAME head still opens its own issue, as W1-T195 intends");
  assert.equal(issues.isOpen(reviewIssue), true, "same head, different cause — this is not a supersede, both stay open");
  assert.equal(issues.closed.length, 0);
});

// ── rationale fixture: three re-pushes close all three older-head issues, one new issue survives ─

test("W1-T4659: the #7561 shape — three consecutive re-pushes leave exactly ONE open issue, the newest head's", () => {
  const issues = fakeIssueStore();
  const path = ledgerPath();
  const prUrl = "https://github.com/craigoley/remudero/pull/7561";
  const heads = ["bcc9973", "f1fd154", "069eaa9", "281af01"];

  const opened = heads.map((headSha, i) =>
    escalate(
      escalation({
        taskId: "W1-T3721",
        headSha,
        cause: "review",
        summary: `blocked_review fix rung exhausted (${i + 1} strike(s)) — ${prUrl}`,
      }),
      { issues, ledgerPath: path, runId: `RUN-${i + 1}` },
    ),
  );

  const openNow = opened.filter((url) => issues.isOpen(url));
  assert.deepEqual(openNow, [opened[opened.length - 1]], "every earlier head's issue closed — only the newest head's issue is open");
  assert.equal(issues.closed.length, heads.length - 1, "each of the three superseded heads costs exactly one close");
});

// ── CANNOT-OBSERVE MEANS WAIT: a gateway that cannot close leaves the older issue open, no throw ─

test("W1-T4659: a gateway with no closeWithComment leaves the older issue open, costs one ledger line, never throws — the new issue still delivers", () => {
  const path = ledgerPath();
  const prUrl = "https://github.com/craigoley/remudero/pull/5000";
  let created = 0;
  const capless: IssueGateway & { calls: number } = {
    get calls() {
      return created;
    },
    create() {
      created++;
      return `https://github.com/craigoley/remudero/issues/${900 + created}`;
    },
    listOpen() {
      return created > 0
        ? [
            {
              number: 901,
              url: "https://github.com/craigoley/remudero/issues/901",
              title: `[BLOCKED] W1-T90: blocked_review fix rung exhausted — ${prUrl}`,
              body: `**Class:** BLOCKED\n**Task:** W1-T90\n**Head:** eee0005\n**Cause:** review\n\n${prUrl}`,
            },
          ]
        : [];
    },
    // Deliberately NO closeWithComment.
  };

  const first = escalate(
    escalation({ taskId: "W1-T90", headSha: "eee0005", cause: "review", summary: `blocked_review fix rung exhausted — ${prUrl}` }),
    { issues: capless, ledgerPath: path, runId: "RUN-1" },
  );
  assert.equal(first, "https://github.com/craigoley/remudero/issues/901");

  let second: string | undefined;
  assert.doesNotThrow(() => {
    second = escalate(
      escalation({ taskId: "W1-T90", headSha: "fff0006", cause: "review", summary: `blocked_review fix rung exhausted (2 strike(s)) — ${prUrl}` }),
      { issues: capless, ledgerPath: path, runId: "RUN-2" },
    );
  });
  assert.ok(second, "the new escalation still delivers even though the older issue could not be closed");
  assert.notEqual(second, first);

  const lines = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const superseded = lines.filter((l) => l.step === "escalation.superseded");
  assert.equal(superseded.length, 1, "exactly one logged (ledger) line records the failed close");
  assert.equal(superseded[0].delivered, false, "never closed on a capability-less gateway — the older issue is left open");
  assert.ok(typeof superseded[0].failure === "string" && superseded[0].failure.length > 0, "the failure reason is recorded, not silently dropped");
});

test("W1-T4659: a THROWING closeWithComment leaves the older issue open, costs one ledger line, and never throws itself", () => {
  const issues = fakeIssueStore();
  const path = ledgerPath();
  const prUrl = "https://github.com/craigoley/remudero/pull/6000";

  const first = escalate(
    escalation({ taskId: "W1-T91", headSha: "1a1a1a1", cause: "review", summary: `blocked_review fix rung exhausted — ${prUrl}` }),
    { issues, ledgerPath: path, runId: "RUN-1" },
  );
  const originalClose = issues.closeWithComment!.bind(issues);
  issues.closeWithComment = () => {
    throw new Error("gh: HTTP 500");
  };

  let second: string | undefined;
  assert.doesNotThrow(() => {
    second = escalate(
      escalation({ taskId: "W1-T91", headSha: "2b2b2b2", cause: "review", summary: `blocked_review fix rung exhausted (2 strike(s)) — ${prUrl}` }),
      { issues, ledgerPath: path, runId: "RUN-2" },
    );
  });
  assert.ok(second);
  assert.notEqual(second, first);
  assert.equal(issues.isOpen(first), true, "the throwing close leaves the older issue open — never half-closed");

  const lines = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const superseded = lines.filter((l) => l.step === "escalation.superseded");
  assert.equal(superseded.length, 1);
  assert.equal(superseded[0].delivered, false);
  assert.match(superseded[0].failure, /HTTP 500/);

  // restore, in case node:test runs this file's remaining assertions against the same object
  issues.closeWithComment = originalClose;
});

// ── a dedup HIT (same head, appended comment) opens no new issue, so nothing is superseded ─────

test("W1-T4659: a dedup-hit escalation (same task, PR and head) opens no new issue, so the supersede close never fires", () => {
  const issues = fakeIssueStore();
  const path = ledgerPath();
  const prUrl = "https://github.com/craigoley/remudero/pull/8000";
  const head = "3c3c3c3";

  const first = escalate(
    escalation({ taskId: "W1-T92", headSha: head, cause: "review", summary: `blocked_review fix rung exhausted (1 strike(s)) — ${prUrl}` }),
    { issues, ledgerPath: path, runId: "RUN-1" },
  );
  const second = escalate(
    escalation({ taskId: "W1-T92", headSha: head, cause: "review", summary: `blocked_review fix rung exhausted (2 strike(s)) — ${prUrl}` }),
    { issues, ledgerPath: path, runId: "RUN-2" },
  );

  assert.equal(second, first, "the same (task, PR, head, cause) dedupes to the SAME issue — no new issue at all");
  assert.equal(issues.closed.length, 0, "no supersede close — nothing new was ever opened to supersede anything with");
  assert.equal(issues.isOpen(first), true);
});
