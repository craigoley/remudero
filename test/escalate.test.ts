import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import {
  NEEDS_HUMAN_LABEL,
  escalate,
  tryEscalate,
  renderIssueBody,
  ghIssueGateway,
  type Escalation,
  type IssueGateway,
} from "../src/lib/escalate.js";

function ledgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), "rmd-escalate-")), "ledger.ndjson");
}

function fakeIssues(url = "https://github.com/craigoley/remudero/issues/99"): IssueGateway & {
  calls: Array<{ title: string; body: string; labels: string[] }>;
} {
  const calls: Array<{ title: string; body: string; labels: string[] }> = [];
  return {
    calls,
    create(title, body, labels) {
      calls.push({ title, body, labels });
      return url;
    },
  };
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

test("escalate opens a needs-human labeled issue and logs the ledger line", () => {
  const issues = fakeIssues();
  const path = ledgerPath();
  const url = escalate(escalation(), { issues, ledgerPath: path, runId: "RUN-1" });

  assert.equal(url, "https://github.com/craigoley/remudero/issues/99");
  assert.equal(issues.calls.length, 1);
  assert.deepEqual(issues.calls[0].labels, [NEEDS_HUMAN_LABEL, "escalation-blocked"]);
  assert.match(issues.calls[0].title, /^\[BLOCKED\] W1-TX: two strikes exhausted$/);

  const lines = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].step, "escalation.issue_opened");
  assert.equal(lines[0].task_id, "W1-TX");
  assert.equal(lines[0].class, "BLOCKED");
  assert.equal(lines[0].issue_url, url);
});

test("each escalation class maps to its own label alongside needs-human", () => {
  const issues = fakeIssues();
  escalate(escalation({ class: "MANUAL" }), { issues, ledgerPath: ledgerPath(), runId: "RUN-1" });
  escalate(escalation({ class: "HARD_STOP" }), { issues, ledgerPath: ledgerPath(), runId: "RUN-1" });
  escalate(escalation({ class: "GRILL" }), { issues, ledgerPath: ledgerPath(), runId: "RUN-1" });
  assert.deepEqual(issues.calls[0].labels, [NEEDS_HUMAN_LABEL, "escalation-manual"]);
  assert.deepEqual(issues.calls[1].labels, [NEEDS_HUMAN_LABEL, "escalation-hard-stop"]);
  assert.deepEqual(issues.calls[2].labels, [NEEDS_HUMAN_LABEL, "escalation-grill"]);
});

test("GRILL (the intake triage's async grill, W1-T42) opens a needs-human issue exactly like every other class — no second mechanism", () => {
  const issues = fakeIssues();
  const url = escalate(
    escalation({
      class: "GRILL",
      taskId: "TRIAGE-fb-1",
      summary: "feedback#fb-1 needs a human call: cli flag or config default?",
      options: [
        { label: "cli-flag", detail: "add a --foo flag" },
        { label: "config-default", detail: "add a config default instead" },
      ],
      recommendation: "cli-flag",
    }),
    { issues, ledgerPath: ledgerPath(), runId: "RUN-1" },
  );
  assert.equal(url, "https://github.com/craigoley/remudero/issues/99");
  assert.match(issues.calls[0].title, /^\[GRILL\] TRIAGE-fb-1: /);
  assert.match(issues.calls[0].body, /\*\*cli-flag\*\* — add a --foo flag/);
  assert.match(issues.calls[0].body, /## Recommendation\ncli-flag/);
});

test("an escalation with no options is refused — a bare alert is not actionable", () => {
  const issues = fakeIssues();
  assert.throws(() => escalate(escalation({ options: [] }), { issues, ledgerPath: ledgerPath(), runId: "RUN-1" }));
  assert.equal(issues.calls.length, 0);
});

test("renderIssueBody lists every option AND calls out the recommendation", () => {
  const body = renderIssueBody(escalation());
  assert.match(body, /## Options/);
  assert.match(body, /\*\*retry\*\* — resume the run with a fresh worker/);
  assert.match(body, /\*\*abandon\*\* — drop the task and re-plan/);
  assert.match(body, /## Recommendation\nretry/);
});

// ── PAYLOAD (not plumbing): the issue body the gateway RECEIVES from escalate()
// actually carries the OPTIONS + the RECOMMENDATION, for BOTH a BLOCKED and a MANUAL
// escalation, with the needs-human queue label. Criterion 1: "…open labeled issues
// WITH OPTIONS + a recommendation" — the fake records what escalate() truly sends. ──
test("escalate() sends the gateway a body CONTAINING every option + the recommendation (BLOCKED and MANUAL), labelled needs-human", () => {
  for (const cls of ["BLOCKED", "MANUAL"] as const) {
    const issues = fakeIssues();
    escalate(
      escalation({
        class: cls,
        options: [
          { label: "resume", detail: "re-run with a fresh worker" },
          { label: "abandon", detail: "drop the task and re-plan" },
        ],
        recommendation: "resume",
      }),
      { issues, ledgerPath: ledgerPath(), runId: "RUN-1" },
    );
    const call = issues.calls[0];
    // the BODY handed to gh (not just the title/labels) carries the actionable payload:
    assert.match(call.body, /\*\*resume\*\* — re-run with a fresh worker/, `${cls}: option 'resume' in body`);
    assert.match(call.body, /\*\*abandon\*\* — drop the task and re-plan/, `${cls}: option 'abandon' in body`);
    assert.match(call.body, /## Recommendation\nresume/, `${cls}: recommendation in body`);
    // the queue label the §4 control panel reads is always present:
    assert.ok(call.labels.includes(NEEDS_HUMAN_LABEL), `${cls}: labels ${call.labels} include ${NEEDS_HUMAN_LABEL}`);
  }
});

// ── tryEscalate: the daemon-survivability contract (R-1) ────────────────────
// `gh issue create` throws on any nonzero exit. Inside `rmd daemon`'s for(;;)
// that throw was uncontained: it ended the PROCESS, launchd's
// KeepAlive{SuccessfulExit:false} read the nonzero exit as a crash, relaunched,
// re-selected the same task, and threw again — one boot per minute, observed
// 2026-07-21 04:02-04:13 (460 daemon.boot lines since Jul 19). These tests pin
// the contract that makes that loop unreachable.

test("tryEscalate: a THROWING gh gateway yields null instead of propagating (the daemon survives)", () => {
  const path = ledgerPath();
  const boom: IssueGateway = {
    create() {
      throw new Error("gh: HTTP 403 rate limit exceeded");
    },
  };
  // FALSIFIER: the pre-fix shape is plain `escalate()`, which DOES propagate —
  // asserted here so the test fails if tryEscalate ever degrades to a re-export.
  assert.throws(() => escalate(escalation(), { issues: boom, ledgerPath: path, runId: "RUN-1" }));

  const url = tryEscalate(escalation(), { issues: boom, ledgerPath: path, runId: "RUN-1" });
  assert.equal(url, null, "an undeliverable escalation returns null rather than throwing");
});

test("tryEscalate: a failed delivery is RECORDED on escalation.failed, never silent", () => {
  const path = ledgerPath();
  const boom: IssueGateway = {
    create() {
      throw new Error("gh: HTTP 403 rate limit exceeded");
    },
  };
  tryEscalate(escalation({ taskId: "W1-TZ" }), { issues: boom, ledgerPath: path, runId: "RUN-9" });

  const lines = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const failed = lines.filter((l) => l.step === "escalation.failed");
  assert.equal(failed.length, 1, "exactly one escalation.failed line");
  assert.equal(failed[0].task_id, "W1-TZ");
  assert.equal(failed[0].class, "BLOCKED");
  assert.match(failed[0].error, /rate limit/, "the transport error is carried, not swallowed");
  assert.equal(
    lines.filter((l) => l.step === "escalation.issue_opened").length,
    0,
    "a FAILED delivery must never claim issue_opened — that is the claimed-vs-evidenced rule",
  );
});

test("tryEscalate: a SUCCESSFUL delivery is byte-identical to escalate() (no behaviour change on the happy path)", () => {
  const issues = fakeIssues();
  const path = ledgerPath();
  const url = tryEscalate(escalation(), { issues, ledgerPath: path, runId: "RUN-1" });
  assert.equal(url, "https://github.com/craigoley/remudero/issues/99");
  const lines = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.filter((l) => l.step === "escalation.issue_opened").length, 1);
  assert.equal(lines.filter((l) => l.step === "escalation.failed").length, 0);
});

// ── ENSURE-LABELS + DEGRADE DON'T LOSE (W1-T99) ─────────────────────────────
// LIVE INCIDENT, 2026-07-17: the first BLOCKED-class escalation ever fired called
// `gh issue create --label escalation-blocked`, and the label had never been
// provisioned on the repo — `gh` failed the create OUTRIGHT, losing the rendered
// question and propagating a throw that killed the whole sweep reconciler.

function fakeIssuesWithLabels(
  ensure: (label: string) => boolean,
  url = "https://github.com/craigoley/remudero/issues/99",
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

test("escalate: ensureLabel is called for every wanted label BEFORE create", () => {
  const issues = fakeIssuesWithLabels(() => true);
  escalate(escalation(), { issues, ledgerPath: ledgerPath(), runId: "RUN-1" });
  assert.deepEqual(issues.ensured, [NEEDS_HUMAN_LABEL, "escalation-blocked"]);
  assert.deepEqual(issues.calls[0].labels, [NEEDS_HUMAN_LABEL, "escalation-blocked"], "both labels provisioned -> both attached");
});

test("escalate: a gateway with no ensureLabel behaves exactly as before (back-compat)", () => {
  const issues = fakeIssues();
  const url = escalate(escalation(), { issues, ledgerPath: ledgerPath(), runId: "RUN-1" });
  assert.equal(url, "https://github.com/craigoley/remudero/issues/99");
  assert.deepEqual(issues.calls[0].labels, [NEEDS_HUMAN_LABEL, "escalation-blocked"]);
});

test("escalate: the canonical 2026-07-17 shape — a label whose provisioning HARD-FAILS degrades, it never loses the escalation", () => {
  const path = ledgerPath();
  const issues = fakeIssuesWithLabels((label) => label !== "escalation-blocked"); // simulate the missing/unprovisionable label
  const url = escalate(escalation(), { issues, ledgerPath: path, runId: "RUN-1" });

  // No throw escaped — the escalation still delivered:
  assert.equal(url, "https://github.com/craigoley/remudero/issues/99");
  assert.equal(issues.calls.length, 1);
  // The degraded label is DROPPED from the attached set, not silently kept:
  assert.deepEqual(issues.calls[0].labels, [NEEDS_HUMAN_LABEL], "the unprovisionable label is left off create()");
  // The drop is noted in the body the human actually reads — the payload survives:
  assert.match(issues.calls[0].body, /Degraded.*escalation-blocked/s);
  // ...and on the ledger line, so it's legible without opening GitHub:
  const lines = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const opened = lines.find((l) => l.step === "escalation.issue_opened");
  assert.deepEqual(opened.degraded_labels, ["escalation-blocked"]);
});

// ── W1-T104: DEDUP LIVES IN THE TRANSPORT — the #178/#180 duplicate ────────────
// LIVE INCIDENT: the sweep opened #180 for PR #177 while the drain-path exhaustion
// escalation #178 for the SAME PR sat open, because each caller deduped only against
// its OWN prior actions. escalate() itself now searches OPEN needs-human issues for
// the same (task, PR) before creating a sibling.

function fakeIssueStore(): IssueGateway & {
  calls: Array<{ title: string; body: string; labels: string[] }>;
  comments: Array<{ url: string; body: string }>;
  closeIssue(url: string): void;
} {
  let seq = 100;
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
    listOpen() {
      return issues.filter((i) => i.state === "open").map((i) => ({ number: i.number, url: i.url, title: i.title, body: i.body }));
    },
    comment(url, body) {
      comments.push({ url, body });
    },
    closeIssue(url) {
      const found = issues.find((i) => i.url === url);
      if (found) found.state = "closed";
    },
  };
}

test("W1-T104: the #178/#180 fixture — two different caller templates, same (task, PR), creates ONE issue then comments", () => {
  const issues = fakeIssueStore();
  const path = ledgerPath();
  const prUrl = "https://github.com/craigoley/remudero/pull/177";

  // Caller 1: drain-path fix-rung exhaustion (#178's shape).
  const first = escalate(
    escalation({
      taskId: "W1-T77",
      summary: `blocked_review fix rung exhausted (2 strike(s)) — ${prUrl}`,
      detail: "the fix rung dispatched 2 bounded fix workers and the review gate is still failing.",
    }),
    { issues, ledgerPath: path, runId: "RUN-1" },
  );

  // Caller 2: the sweep's clarification rung (#180's shape) — a DIFFERENT title
  // template and its OWN distinct context (BLOCKED-AMBIGUOUS), same task + PR.
  const second = escalate(
    escalation({
      taskId: "W1-T77",
      summary: `PR ${prUrl} needs a clarification — ambiguous unmet criteria`,
      detail: "the clarification rung reconciled open PR #177 to BLOCKED-AMBIGUOUS: no single nameable unmet criterion.",
    }),
    { issues, ledgerPath: path, runId: "RUN-2" },
  );

  assert.equal(second, first, "the second call returns the SAME issue url — no sibling issue");
  assert.equal(issues.calls.length, 1, "exactly one create() across both callers");
  assert.equal(issues.comments.length, 1, "the second observer appends a comment instead of opening one");
  assert.equal(issues.comments[0].url, first);
  // The second observation is PRESERVED, not merely a "duplicate" marker:
  assert.match(issues.comments[0].body, /BLOCKED-AMBIGUOUS/, "the second caller's own view survives in the comment");

  const lines = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.filter((l) => l.step === "escalation.issue_opened").length, 1);
  assert.equal(lines.filter((l) => l.step === "escalation.deduped").length, 1);
  assert.equal(lines.find((l) => l.step === "escalation.deduped").issue_url, first);
});

test("W1-T104: a CLOSED prior issue does not suppress a new escalation for the same (task, PR)", () => {
  const issues = fakeIssueStore();
  const path = ledgerPath();
  const prUrl = "https://github.com/craigoley/remudero/pull/200";

  const first = escalate(escalation({ taskId: "W1-T80", summary: `blocked — ${prUrl}` }), {
    issues,
    ledgerPath: path,
    runId: "RUN-1",
  });
  issues.closeIssue(first);

  const second = escalate(escalation({ taskId: "W1-T80", summary: `blocked again, re-escalating — ${prUrl}` }), {
    issues,
    ledgerPath: path,
    runId: "RUN-2",
  });

  assert.notEqual(second, first, "a genuine recurrence opens a FRESH issue once the prior one is closed");
  assert.equal(issues.calls.length, 2, "two creates — dedup never matches a closed issue");
});

test("W1-T104: distinct PRs for one task escalate separately, never deduped against each other", () => {
  const issues = fakeIssueStore();
  const path = ledgerPath();

  const first = escalate(
    escalation({ taskId: "W1-T90", summary: "blocked — https://github.com/craigoley/remudero/pull/10" }),
    { issues, ledgerPath: path, runId: "RUN-1" },
  );
  const second = escalate(
    escalation({ taskId: "W1-T90", summary: "blocked — https://github.com/craigoley/remudero/pull/11" }),
    { issues, ledgerPath: path, runId: "RUN-2" },
  );

  assert.notEqual(second, first, "different PR numbers on the same task each get their own issue");
  assert.equal(issues.calls.length, 2);
  assert.equal(issues.comments.length, 0, "no comment fires — these are genuinely separate escalations");
});

test("W1-T104: an escalation naming no PR (task-level, e.g. the dispatch circuit breaker) never dedup-searches at all", () => {
  const issues = fakeIssueStore();
  const path = ledgerPath();

  const first = escalate(escalation({ taskId: "W1-T50", summary: "dispatch circuit breaker tripped" }), {
    issues,
    ledgerPath: path,
    runId: "RUN-1",
  });
  const second = escalate(escalation({ taskId: "W1-T50", summary: "dispatch circuit breaker tripped again" }), {
    issues,
    ledgerPath: path,
    runId: "RUN-2",
  });

  assert.notEqual(second, first, "with no PR reference in either escalation, each creates its own issue");
  assert.equal(issues.calls.length, 2);
});

test("W1-T104: a gateway with no listOpen behaves exactly as before (back-compat) — no dedup, no throw", () => {
  const issues = fakeIssues();
  const path = ledgerPath();
  const prUrl = "https://github.com/craigoley/remudero/pull/300";

  const first = escalate(escalation({ taskId: "W1-T60", summary: `blocked — ${prUrl}` }), {
    issues,
    ledgerPath: path,
    runId: "RUN-1",
  });
  const second = escalate(escalation({ taskId: "W1-T60", summary: `blocked — ${prUrl}` }), {
    issues,
    ledgerPath: path,
    runId: "RUN-2",
  });

  assert.equal(first, second, "the fake gateway always returns the same fixed url regardless of dedup");
  assert.equal(issues.calls.length, 2, "no listOpen -> the dedup search is skipped -> both calls create");
});

test("ghIssueGateway.comment: posts a plain comment without closing the issue", () => {
  const calls: string[][] = [];
  const gateway = ghIssueGateway("craigoley", "remudero", {
    exec: (args) => {
      calls.push(args);
      return "";
    },
  });
  gateway.comment?.("https://github.com/craigoley/remudero/issues/44", "another rung saw the same block");
  assert.deepEqual(calls, [
    [
      "issue",
      "comment",
      "https://github.com/craigoley/remudero/issues/44",
      "--repo",
      "craigoley/remudero",
      "--body",
      "another rung saw the same block",
    ],
  ]);
});

// ── ghIssueGateway: the REAL `gh` gateway, exercised via the injectable `opts.exec`
// stand-in (mirrors ghGateway in status.ts, W1-T119) so the ensureLabel/create wiring
// below is proven WITHOUT shelling out to a real `gh` binary.

test("ghIssueGateway.ensureLabel: a successful `gh label create` returns true", () => {
  const calls: string[][] = [];
  const gateway = ghIssueGateway("craigoley", "remudero", {
    exec: (args) => {
      calls.push(args);
      return "";
    },
  });
  assert.equal(gateway.ensureLabel?.("escalation-blocked"), true);
  assert.deepEqual(calls, [
    ["label", "create", "escalation-blocked", "--repo", "craigoley/remudero", "--color", "ededed", "--force"],
  ]);
});

test("ghIssueGateway.ensureLabel: a throwing `gh` (rate-limit/auth/network) degrades to false, never throws", () => {
  const gateway = ghIssueGateway("craigoley", "remudero", {
    exec: () => {
      throw new Error("gh: HTTP 403 rate limit exceeded");
    },
  });
  assert.equal(gateway.ensureLabel?.("escalation-blocked"), false);
});

test("ghIssueGateway.create: builds the gh issue-create args and returns the trimmed URL", () => {
  const calls: string[][] = [];
  const gateway = ghIssueGateway("craigoley", "remudero", {
    exec: (args) => {
      calls.push(args);
      return "https://github.com/craigoley/remudero/issues/123\n";
    },
  });
  // Drives the gh issue boundary deliberately, against this test's own injected `exec` above —
  // nothing reaches a real `gh`. The guard checks the CALL, not the destination, so it needs
  // this explicit exemption.
  const url = withLiveWritesAllowed(() =>
    gateway.create("[BLOCKED] W1-TX: two strikes exhausted", "body text", [
      NEEDS_HUMAN_LABEL,
      "escalation-blocked",
    ]),
  );
  assert.equal(url, "https://github.com/craigoley/remudero/issues/123");
  assert.deepEqual(calls, [
    [
      "issue",
      "create",
      "--repo",
      "craigoley/remudero",
      "--title",
      "[BLOCKED] W1-TX: two strikes exhausted",
      "--body",
      "body text",
      "--label",
      NEEDS_HUMAN_LABEL,
      "--label",
      "escalation-blocked",
    ],
  ]);
});

test("ghIssueGateway.listOpen: lists OPEN labeled issues with body over REST's /issues endpoint (never gh's --label search path), parsed from JSON", () => {
  const calls: string[][] = [];
  const gateway = ghIssueGateway("craigoley", "remudero", {
    exec: (args) => {
      calls.push(args);
      // `--slurp` shape: one outer array wrapping one array per page.
      return JSON.stringify([
        [
          {
            number: 44,
            url: "https://api.github.com/repos/craigoley/remudero/issues/44",
            html_url: "https://github.com/craigoley/remudero/issues/44",
            state: "open",
            title: "[BLOCKED] W1-T189",
            body: "**Task:** W1-T189\n",
          },
        ],
      ]);
    },
  });
  const open = gateway.listOpen?.(NEEDS_HUMAN_LABEL);
  assert.equal(open?.length, 1);
  assert.equal(open?.[0].number, 44);
  assert.equal(open?.[0].body, "**Task:** W1-T189\n");
  assert.equal(open?.[0].url, "https://github.com/craigoley/remudero/issues/44", "the WEB url, never api.github.com");
  assert.deepEqual(calls, [
    ["api", `repos/craigoley/remudero/issues?labels=${NEEDS_HUMAN_LABEL}&state=open&per_page=100`, "--paginate", "--slurp"],
  ]);
});

test("ghIssueGateway.listOpen: a throwing `gh` (read failure) PROPAGATES — the reconciler caller degrades to no-action, never a false 'zero open'", () => {
  const gateway = ghIssueGateway("craigoley", "remudero", {
    exec: () => {
      throw new Error("gh: HTTP 502");
    },
  });
  assert.throws(() => gateway.listOpen?.(NEEDS_HUMAN_LABEL), /502/);
});

test("ghIssueGateway.closeWithComment: closes the issue with the citation comment", () => {
  const calls: string[][] = [];
  const gateway = ghIssueGateway("craigoley", "remudero", {
    exec: (args) => {
      calls.push(args);
      return "";
    },
  });
  gateway.closeWithComment?.("https://github.com/craigoley/remudero/issues/44", "resolved by #574");
  assert.deepEqual(calls, [
    ["issue", "close", "https://github.com/craigoley/remudero/issues/44", "--repo", "craigoley/remudero", "--comment", "resolved by #574"],
  ]);
});
