import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  NEEDS_HUMAN_LABEL,
  escalate,
  renderIssueBody,
  type Escalation,
  type IssueGateway,
} from "../src/lib/escalate.js";
import { buildSweepEffects, renderClarificationQuestion, type OpenPrView } from "../src/lib/sweep.js";

function ledgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), "rmd-head-independent-dedup-")), "ledger.ndjson");
}

function fakeIssueStore(): IssueGateway & {
  calls: Array<{ title: string; body: string; labels: string[] }>;
  comments: Array<{ url: string; body: string }>;
} {
  let seq = 4633;
  const issues: Array<{ number: number; url: string; title: string; body: string; state: string }> = [];
  const calls: Array<{ title: string; body: string; labels: string[] }> = [];
  const comments: Array<{ url: string; body: string }> = [];
  return {
    calls,
    comments,
    create(title, body, labels) {
      const number = seq++;
      const url = `https://github.com/craigoley/remudero/issues/${number}`;
      issues.push({ number, url, title, body, state: "open" });
      calls.push({ title, body, labels });
      return url;
    },
    listOpen(label) {
      assert.equal(label, NEEDS_HUMAN_LABEL);
      return issues
        .filter((issue) => issue.state === "open")
        .map((issue) => ({ number: issue.number, url: issue.url, title: issue.title, body: issue.body }));
    },
    comment(url, body) {
      comments.push({ url, body });
    },
  };
}

function escalation(overrides: Partial<Escalation> = {}): Escalation {
  return {
    class: "BLOCKED",
    taskId: "W1-T3179",
    summary:
      "PR https://github.com/craigoley/remudero/pull/4559 needs a clarification - " +
      "review failing with no actionable unmet criteria (contradictory) - escalating",
    detail: "The question is about the spec, not about the commit content.",
    options: [
      { label: "revise-spec", detail: "file a task-edit proposal that changes the impossible criterion." },
      { label: "keep-waiting", detail: "leave the PR blocked while the operator decides." },
    ],
    recommendation: "revise-spec",
    cause: "review",
    ...overrides,
  };
}

test("a head-independent producer firing twice at DIFFERENT head shas opens ONE issue, records the new sha, and keeps the original Head evidence", () => {
  const issues = fakeIssueStore();
  const path = ledgerPath();

  const first = escalate(
    escalation({
      headSha: "3a29c58a",
      headDedup: "independent",
    }),
    { issues, ledgerPath: path, runId: "RUN-1" },
  );
  const second = escalate(
    escalation({
      headSha: "69b6e0a1",
      headDedup: "independent",
    }),
    { issues, ledgerPath: path, runId: "RUN-2" },
  );

  assert.equal(second, first, "the repeated question appends to the existing issue");
  assert.equal(issues.calls.length, 1, "only the first observation creates an issue");
  assert.equal(issues.comments.length, 1, "the second observation is recorded as a comment");
  assert.match(issues.calls[0].body, /^\*\*Head:\*\* 3a29c58a$/m);
  assert.match(issues.comments[0].body, /^\*\*Head:\*\* 69b6e0a1$/m);

  const rows = readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(rows.filter((row) => row.step === "escalation.issue_opened").length, 1);
  assert.equal(rows.filter((row) => row.step === "escalation.deduped").length, 1);
});

test("a head-DEPENDENT producer dedups only while the head sha stays the same", () => {
  const issues = fakeIssueStore();
  const path = ledgerPath();
  const prUrl = "https://github.com/craigoley/remudero/pull/500";

  const first = escalate(
    escalation({
      taskId: "W1-T195",
      summary: `blocked_review fix rung exhausted (2 strike(s)) - ${prUrl}`,
      detail: "This check result is tied to the exact commit under review.",
      headSha: "1111111a",
    }),
    { issues, ledgerPath: path, runId: "RUN-1" },
  );
  const second = escalate(
    escalation({
      taskId: "W1-T195",
      summary: `blocked_review fix rung exhausted (2 strike(s)) - ${prUrl}`,
      detail: "This check result is tied to the exact commit under review.",
      headSha: "1111111a",
    }),
    { issues, ledgerPath: path, runId: "RUN-2" },
  );
  const third = escalate(
    escalation({
      taskId: "W1-T195",
      summary: `blocked_review fix rung exhausted (2 strike(s)) - ${prUrl}`,
      detail: "This check result is tied to the exact commit under review.",
      headSha: "2222222b",
    }),
    { issues, ledgerPath: path, runId: "RUN-3" },
  );

  assert.equal(second, first, "the default still dedups the same head");
  assert.notEqual(third, first, "the default still treats a new head as a new operator question");
  assert.equal(issues.calls.length, 2);
  assert.equal(issues.comments.length, 1);
});

test("head-independent mode changes only the dedup key, never the rendered issue evidence", () => {
  const body = renderIssueBody(escalation({ headSha: "abcdef12", headDedup: "independent" }));

  assert.match(body, /^\*\*Head:\*\* abcdef12$/m);
  assert.doesNotMatch(body, /headDedup|head-independent|dedup/i);
});

test("the contradictory clarification producer marks its ask head-independent", async () => {
  const issues = fakeIssueStore();
  const root = mkdtempSync(join(tmpdir(), "rmd-head-independent-producer-"));
  const effects = buildSweepEffects({
    owner: "craigoley",
    repo: "remudero",
    repoRoot: root,
    config: { claudeBin: "claude", root },
    ledgerPath: ledgerPath(),
    runId: "SWEEP-W1-T3179",
    plan: { tasks: [], byId: new Map() },
    log: () => {},
    issuesImpl: issues,
  });
  const pr: OpenPrView = {
    prNumber: 4559,
    prUrl: "https://github.com/craigoley/remudero/pull/4559",
    taskId: "W1-T3179",
    reviewState: "failure",
    checksState: "green",
    unmetCriteria: [],
    criteriaRecoverable: true,
    priorStrikes: 2,
    lastActivityAt: "2026-09-08T12:00:00Z",
    headSha: "feed3179",
    autoMergeArmed: false,
  };
  const reason = "review failing with no actionable unmet criteria (contradictory) — escalating";

  await effects.escalate(pr, reason, renderClarificationQuestion(pr, reason));

  assert.equal(issues.calls.length, 1);
  assert.match(issues.calls[0].body, /^\*\*Head:\*\* feed3179$/m);

  const second = buildSweepEffects({
    owner: "craigoley",
    repo: "remudero",
    repoRoot: root,
    config: { claudeBin: "claude", root },
    ledgerPath: ledgerPath(),
    runId: "SWEEP-W1-T3179-2",
    plan: { tasks: [], byId: new Map() },
    log: () => {},
    issuesImpl: issues,
  });
  const pushed = { ...pr, headSha: "cafe3179" };
  await second.escalate(pushed, reason, renderClarificationQuestion(pushed, reason));

  assert.equal(issues.calls.length, 1, "a push cannot open a second copy of the same head-independent ask");
  assert.equal(issues.comments.length, 1, "the new observed head is appended to the existing issue");
  assert.match(issues.comments[0].body, /^\*\*Head:\*\* cafe3179$/m);
});

test("the terminal non-fleet-head producer marks its ask head-independent", async () => {
  const issues = fakeIssueStore();
  const root = mkdtempSync(join(tmpdir(), "rmd-head-independent-terminal-"));
  const path = ledgerPath();
  writeFileSync(
    path,
    JSON.stringify({
      run_id: "SWEEP-prior",
      task_id: "SWEEP",
      step: "sweep.fix.uncreditable_head",
      pr_number: 4559,
      head_sha: "bad3179",
      head: "contributor/manual-fix",
      synthetic: false,
      reason: "not_a_run_branch",
      terminal: true,
      repair_task_id: "W1-T3179",
      cause: "review",
    }) + "\n",
  );
  const effects = buildSweepEffects({
    owner: "craigoley",
    repo: "remudero",
    repoRoot: root,
    config: { claudeBin: "claude", root },
    ledgerPath: path,
    runId: "SWEEP-W1-T3179-terminal",
    plan: { tasks: [], byId: new Map() },
    log: () => {},
    issuesImpl: issues,
    dispatchFixPreflightStandDownImpl: () => undefined,
  });

  await effects.dispatchFix(
    {
      prNumber: 4559,
      prUrl: "https://github.com/craigoley/remudero/pull/4559",
      taskId: "W1-T3179",
      reviewState: "failure",
      checksState: "green",
      unmetCriteria: [],
      priorStrikes: 1,
      lastActivityAt: "2026-09-08T12:00:00Z",
      headSha: "bad3179",
      autoMergeArmed: false,
    },
    { unmetCriteria: [] },
  );

  assert.equal(issues.calls.length, 1);
  assert.match(issues.calls[0].title, /cannot be repaired from its non-fleet head/);
  assert.match(issues.calls[0].body, /^\*\*Head:\*\* bad3179$/m);
});
