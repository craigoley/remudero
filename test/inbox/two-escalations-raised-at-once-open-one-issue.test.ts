// W1-T14350 — escalateSteps read the open list once, awaited a model judge, then created the issue, so two
// escalations of one condition raised at once each opened an issue (#13967/#13968, #19803/#19806,
// #20027/#20028). These fixtures drive the real tryEscalateAsync with a judge that resolves late.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  NEEDS_HUMAN_LABEL, escalationIssueTitle, renderIssueBody, tryEscalateAsync,
  type AsyncIssueGateway, type Escalation, type OpenIssue,
} from "#src/lib/escalate.js";

const VERDICT = { decision: "deliver", reason: "the test judge keeps it visible" } as const;
const URL_BASE = "https://github.com/o/r/issues/";

function esc(over: Partial<Escalation> = {}): Escalation {
  return {
    class: "BLOCKED", taskId: "W1-T14350", summary: "W1-T14350: two strikes exhausted", detail: "the retry still failed.",
    options: [{ label: "retry", detail: "resume with a fresh worker" }, { label: "abandon", detail: "drop the task" }],
    recommendation: "retry", ...over,
  };
}

function ledger(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-two-escalations-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "ledger.ndjson");
}

function rows(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as Record<string, unknown>);
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 25));

type Store = AsyncIssueGateway & {
  creates: Array<{ title: string; body: string; labels: string[] }>;
  events: string[];
  reads: number;
  open: OpenIssue[];
};

/** A gateway whose open list reflects what it created; `onRead` may script the nth read. */
function store(onRead?: (n: number, open: OpenIssue[]) => OpenIssue[]): Store {
  const s: Store = {
    creates: [], events: [], reads: 0, open: [],
    async listOpen(label) {
      assert.equal(label, NEEDS_HUMAN_LABEL);
      s.reads += 1;
      s.events.push("list");
      const n = s.reads;
      await settle();
      if (onRead) return onRead(n, s.open);
      return [...s.open];
    },
    async create(title, body, labels) {
      s.creates.push({ title, body, labels });
      const number = s.creates.length;
      s.open.push({ number, url: `${URL_BASE}${number}`, title, body });
      s.events.push("create");
      return `${URL_BASE}${number}`;
    },
    async comment() {},
  };
  return s;
}

function judgeOf(events: string[], pause: () => Promise<void>): { calls: number; judge: (e: Escalation) => Promise<typeof VERDICT> } {
  const j = { calls: 0, judge: async (_e: Escalation) => { j.calls += 1; events.push("judge"); await pause(); return VERDICT; } };
  return j;
}

test("W1-T14350 criterion 1: two concurrent escalations with one key open one issue and the second records a dedup", async (t) => {
  const path = ledger(t);
  const issues = store();
  const judge = judgeOf(issues.events, settle);
  const deps = (runId: string) => ({ issues, ledgerPath: path, runId, triage: { judge: judge.judge } });
  const [a, b] = await Promise.all([tryEscalateAsync(esc(), deps("RUN-A")), tryEscalateAsync(esc(), deps("RUN-B"))]);
  assert.equal(issues.creates.length, 1, "exactly one issue for one condition");
  assert.equal(a, `${URL_BASE}1`);
  assert.equal(b, `${URL_BASE}1`, "the second caller is handed the first's issue");
  assert.equal(judge.calls, 1, "the second caller's judge does not run");
  const deduped = rows(path).filter((r) => r.step === "escalation.deduped");
  assert.equal(deduped.length, 1);
  assert.equal(deduped[0]!.issue_url, `${URL_BASE}1`);
  assert.equal(deduped[0]!.run_id, "RUN-B");
});

test("W1-T14350 criterion 1: a different summary is a different key and is not held behind the first", async (t) => {
  const path = ledger(t);
  const issues = store();
  const judge = judgeOf(issues.events, settle);
  const deps = (runId: string) => ({ issues, ledgerPath: path, runId, triage: { judge: judge.judge } });
  await Promise.all([
    tryEscalateAsync(esc({ taskId: "W1-T14351", summary: "W1-T14351: first condition" }), deps("RUN-A")),
    tryEscalateAsync(esc({ taskId: "W1-T14352", summary: "W1-T14352: second condition" }), deps("RUN-B")),
  ]);
  assert.equal(issues.creates.length, 2);
  assert.equal(judge.calls, 2);
});

test("W1-T14350 criterion 1: a first caller that fails releases the key, so the second still opens its issue", async (t) => {
  const path = ledger(t);
  let failFirst = true;
  const issues = store();
  const create = issues.create.bind(issues);
  issues.create = async (title, body, labels) => {
    if (failFirst) { failFirst = false; throw new Error("create refused"); }
    return create(title, body, labels);
  };
  const judge = judgeOf(issues.events, settle);
  const deps = (runId: string) => ({ issues, ledgerPath: path, runId, triage: { judge: judge.judge } });
  const [a, b] = await Promise.all([tryEscalateAsync(esc(), deps("RUN-A")), tryEscalateAsync(esc(), deps("RUN-B"))]);
  assert.equal(a, null);
  assert.equal(b, `${URL_BASE}1`);
  assert.equal(issues.creates.length, 1);
});

test("W1-T14350 criterion 2: an issue another process opened during the judge is found by the re-read, not duplicated", async (t) => {
  // The issue the other process opened: rendered by the real producer for the same escalation.
  const e = esc({ taskId: "W1-T13864", summary: "W1-T13864: PR #19786 needs a clarification" });
  const other: OpenIssue = { number: 19803, url: `${URL_BASE}19803`, title: escalationIssueTitle(e), body: renderIssueBody(e) };
  const path = ledger(t);
  const issues = store((n) => (n === 1 ? [] : [other]));
  const judge = judgeOf(issues.events, settle);
  const url = await tryEscalateAsync(e, { issues, ledgerPath: path, runId: "RUN-B", triage: { judge: judge.judge } });
  assert.equal(url, other.url);
  assert.equal(issues.creates.length, 0, "no second issue");
  assert.equal(judge.calls, 1, "the judge ran before the re-read, as the lone path orders it");
  assert.deepEqual(issues.events, ["list", "judge", "list"]);
  const deduped = rows(path).filter((r) => r.step === "escalation.deduped");
  assert.equal(deduped.length, 1);
  assert.equal(deduped[0]!.issue_url, other.url);
});

test("W1-T14350 criterion 3: a re-read that throws refuses creation with one dedup_unreadable row", async (t) => {
  const path = ledger(t);
  const issues = store((n) => {
    if (n === 1) return [];
    throw new Error("REST read failed on the re-read");
  });
  const judge = judgeOf(issues.events, settle);
  const url = await tryEscalateAsync(esc(), { issues, ledgerPath: path, runId: "RUN-A", triage: { judge: judge.judge } });
  assert.equal(url, null);
  assert.equal(issues.creates.length, 0);
  const unreadable = rows(path).filter((r) => r.step === "escalation.dedup_unreadable");
  assert.equal(unreadable.length, 1);
  assert.match(String(unreadable[0]!.error), /REST read failed on the re-read/);
});

test("W1-T14350 criterion 4: a lone escalation looks up first, a found duplicate never reaches the judge", async (t) => {
  const e = esc({ taskId: "W1-T14360", summary: "W1-T14360: lone duplicate" });
  const open: OpenIssue = { number: 7, url: `${URL_BASE}7`, title: escalationIssueTitle(e), body: renderIssueBody(e) };
  const path = ledger(t);
  const issues = store(() => [open]);
  const judge = judgeOf(issues.events, settle);
  const url = await tryEscalateAsync(e, { issues, ledgerPath: path, runId: "RUN-A", triage: { judge: judge.judge } });
  assert.equal(url, open.url);
  assert.equal(judge.calls, 0);
  assert.deepEqual(issues.events, ["list"], "one read, no judge, no create");
});

test("W1-T14350 criterion 4: a lone escalation on a readable empty list creates one issue as origin/main does", async (t) => {
  const e = esc();
  const path = ledger(t);
  const issues = store();
  const judge = judgeOf(issues.events, settle);
  const url = await tryEscalateAsync(e, { issues, ledgerPath: path, runId: "RUN-A", triage: { judge: judge.judge } });
  assert.equal(url, `${URL_BASE}1`);
  assert.equal(issues.events[0], "list", "the first lookup precedes triage and the judge");
  assert.equal(issues.events.indexOf("judge"), 1);
  assert.equal(issues.creates.length, 1);
  assert.equal(issues.creates[0]!.title, escalationIssueTitle(e));
  assert.equal(issues.creates[0]!.body, renderIssueBody(e));
  assert.deepEqual(issues.creates[0]!.labels, [NEEDS_HUMAN_LABEL, "escalation-blocked", "needs-question"]);
  assert.deepEqual(rows(path).map((r) => r.step), ["escalation.judged", "escalation.triaged", "escalation.issue_opened"]);
});

test("W1-T14350 criterion 4: an escalation with no awaited judge or executor reads the open list once, as origin/main does", async (t) => {
  const path = ledger(t);
  const issues = store();
  const url = await tryEscalateAsync(esc({ taskId: "W1-T14361", summary: "W1-T14361: no judge wired" }), { issues, ledgerPath: path, runId: "RUN-A" });
  assert.equal(url, `${URL_BASE}1`);
  assert.deepEqual(issues.events, ["list", "create"], "one read then the create, no re-read");
});
