import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { escalate, escalateWithJudge, NEEDS_HUMAN_LABEL, type Escalation, type IssueGateway } from "../src/lib/escalate.js";

function ledgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), "rmd-escalation-consequence-")), "ledger.ndjson");
}

function readLedger(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line));
}

function fakeIssues(): IssueGateway & { calls: Array<{ title: string; body: string; labels: string[] }> } {
  const calls: Array<{ title: string; body: string; labels: string[] }> = [];
  return {
    calls,
    create(title, body, labels) {
      calls.push({ title, body, labels });
      return "https://github.com/craigoley/remudero/issues/3391";
    },
  };
}

function escalation(overrides: Partial<Escalation> = {}): Escalation {
  return {
    class: "BLOCKED",
    taskId: "W1-T3391",
    summary: "operator message consequence was omitted",
    detail: "the escalation producer reached the shared raise path without a consequence field.",
    options: [{ label: "continue", detail: "open the issue for operator handling" }],
    recommendation: "continue",
    ...overrides,
  };
}

test("omitted escalation consequences are made explicit before opening the needs-human issue", () => {
  const issues = fakeIssues();
  const path = ledgerPath();

  const url = escalate(escalation(), { issues, ledgerPath: path, runId: "RUN-W1-T3391" });

  assert.equal(url, "https://github.com/craigoley/remudero/issues/3391");
  assert.deepEqual(issues.calls[0].labels, [NEEDS_HUMAN_LABEL, "escalation-blocked", "needs-question"]);
  assert.doesNotMatch(issues.calls[0].body, /Non-conforming operator message/);

  const opened = readLedger(path).find((line) => line.step === "escalation.issue_opened");
  assert.equal(opened?.operator_message_ok, true);
  assert.equal("operator_message_missing" in (opened ?? {}), false);
});

test("judged escalations inherit the same explicit consequence before the issue is opened", async () => {
  const issues = fakeIssues();
  const path = ledgerPath();

  await escalateWithJudge(escalation({ class: "HARD_STOP" }), {
    issues,
    ledgerPath: path,
    runId: "RUN-W1-T3391",
    judge: async () => ({ decision: "deliver", reason: "the operator needs the hard-stop context" }),
  });

  const opened = readLedger(path).find((line) => line.step === "escalation.issue_opened");
  assert.equal(opened?.operator_message_ok, true);
  assert.equal("operator_message_missing" in (opened ?? {}), false);
});

test("a checker failure still never stops an escalation being raised", () => {
  const issues = fakeIssues();
  const e = escalation();
  Object.defineProperty(e, "consequence", {
    get() {
      throw new Error("consequence getter is unreadable");
    },
    enumerable: true,
  });

  const url = escalate(e, { issues, ledgerPath: ledgerPath(), runId: "RUN-W1-T3391" });

  assert.equal(url, "https://github.com/craigoley/remudero/issues/3391");
  assert.equal(issues.calls.length, 1);
});
