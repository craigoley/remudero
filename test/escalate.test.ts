import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
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
  assert.deepEqual(issues.calls[0].labels, [NEEDS_HUMAN_LABEL, "escalation-manual"]);
  assert.deepEqual(issues.calls[1].labels, [NEEDS_HUMAN_LABEL, "escalation-hard-stop"]);
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
