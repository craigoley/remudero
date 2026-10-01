// P4-T08 (arch Phase 4 design §2): each open decision `now` carries names the one route that steers its
// answer and that route's write tier. These pin each source's rules; test/now-view.test.ts runs them
// through the view over a real read model.
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { BoardRow } from "../src/lib/board.js";
import type { FeedbackEntry } from "../src/lib/feedback.js";
import {
  NOW_DECISION_PROMPT_CHARS,
  NOW_DECISIONS_CAP,
  capDecisions,
  escalationClasses,
  escalationDecisions,
  grillDecisions,
  questionStorePath,
  readQuestionStore,
  taskQuestionDecisions,
  type NowDecision,
} from "../src/lib/now-decisions.js";
import { makeTempDir } from "../src/lib/tmp.js";

type TestCtx = { after: (fn: () => void) => void };

function row(taskId: string, over: Partial<BoardRow> = {}): BoardRow {
  return { taskId, title: `task ${taskId}`, status: "blocked", risk: "medium", ...over } as BoardRow;
}

test("a manual escalation is approved at the high tier and any other is marked handled with a disposition", () => {
  const tasks = [
    row("W1-T1", { needsHuman: true, escalationIssueUrl: "https://github.com/o/r/issues/1", escalationTitle: "[MANUAL] W1-T1: rotate the key", escalationOpenedAt: "2026-09-30T10:00:00.000Z" }),
    row("W1-T2", { needsHuman: true, escalationIssueUrl: "https://github.com/o/r/issues/2" }),
    row("W1-T3", { needsHuman: true }),
    row("W1-T4", { escalationIssueUrl: "https://github.com/o/r/issues/4" }),
  ];
  const opened = escalationClasses([
    { step: "escalation.issue_opened", task_id: "W1-T1", class: "BLOCKED", ts: "2026-09-29T00:00:00.000Z" },
    { step: "escalation.issue_opened", task_id: "W1-T1", class: "MANUAL", ts: "2026-09-30T10:00:00.000Z" },
    { step: "escalation.issue_opened", task_id: "W1-T2", class: "BLOCKED", ts: "2026-09-30T11:00:00.000Z" },
    { step: "run.start", task_id: "W1-T2" },
  ]);
  const [manual, other, ...rest] = escalationDecisions("core", tasks, opened);
  assert.deepEqual(rest, [], "no issue to act on, or no open escalation, is no decision");
  assert.deepEqual(manual, {
    id: "manual:W1-T1:https://github.com/o/r/issues/1", kind: "manual_approval", instance: "core", taskId: "W1-T1", title: "[MANUAL] W1-T1: rotate the key",
    prompt: "[MANUAL] W1-T1: rotate the key", askedAt: "2026-09-30T10:00:00.000Z",
    answer: { method: "POST", path: "/v1/manual/approve", tier: "high", fields: { taskId: "W1-T1", issueUrl: "https://github.com/o/r/issues/1" }, input: "none" },
  });
  assert.equal(other!.kind, "escalation");
  assert.equal(other!.askedAt, "2026-09-30T11:00:00.000Z", "the opening row's time when the board carries none");
  assert.deepEqual(other!.options, ["acted", "false_positive", "duplicate", "snoozed_until"]);
  assert.deepEqual(other!.answer, { method: "POST", path: "/v1/escalation/mark-handled", tier: "low", fields: { taskId: "W1-T2", issueUrl: "https://github.com/o/r/issues/2", class: "BLOCKED" }, input: "choice" });
  const unseen = escalationDecisions("core", [row("W1-T5", { needsHuman: true, escalationIssueUrl: "https://github.com/o/r/issues/5" })], new Map());
  assert.equal(unseen[0]!.askedAt, undefined, "no opening row: no invented time");
  assert.equal(unseen[0]!.answer.fields.class, "UNKNOWN");
});

test("a task question counts only on an open task with no later answer in the store", () => {
  const tasks = [row("W1-T1", { status: "queued" }), row("W1-T2", { status: "merged" }), row("W1-T3", { status: "running" })];
  const lines = [
    { ts: "2026-09-30T09:00:00.000Z", task: "W1-T1", question: "first?" },
    { ts: "2026-09-30T09:30:00.000Z", task: "W1-T1", answer: "yes" },
    { ts: "2026-09-30T10:00:00.000Z", task: "W1-T1", question: "second?", impact_if_wrong: "high" },
    { ts: "2026-09-30T10:00:00.000Z", task: "W1-T2", question: "merged already?" },
    { ts: "2026-09-30T10:00:00.000Z", task: "W1-T3", question: "x".repeat(NOW_DECISION_PROMPT_CHARS + 10) },
    { ts: "2026-09-30T10:00:00.000Z", task: "W1-T9", question: "not on the board" },
    { task: "W1-T1", question: "no time" },
  ];
  const asked: string[] = [];
  const decisions = taskQuestionDecisions("core", lines, (taskId) => (asked.push(taskId), undefined), tasks);
  assert.deepEqual(decisions.map((d) => d.id), ["question:W1-T1:2026-09-30T10:00:00.000Z", "question:W1-T3:2026-09-30T10:00:00.000Z"]);
  assert.equal(decisions[0]!.impactIfWrong, undefined, "a high impact is never a QUESTION, so it is not echoed");
  assert.equal(decisions[1]!.prompt.length, NOW_DECISION_PROMPT_CHARS, "a long question is bounded");
  assert.deepEqual(asked.sort(), ["W1-T1", "W1-T3"], "the fact index is asked only for open tasks with a question");
  const byFact = taskQuestionDecisions("core", lines, (taskId) => (taskId === "W1-T3" ? "2026-09-30T10:00:01.000Z" : undefined), tasks);
  assert.deepEqual(byFact.map((d) => d.taskId), ["W1-T1"]);
});

test("a grill entry is answered by a feedback reply and a malformed one keeps its id", () => {
  const entries = [
    { id: "fb-1", ts: "2026-09-30T08:00:00.000Z", raw: "\nwhich console page first?\nmore detail", status: "grilling" },
    { id: "fb-2", status: "grilling" },
    { id: "fb-3", ts: "2026-09-30T08:00:00.000Z", raw: "done", status: "answered" },
  ] as unknown as FeedbackEntry[];
  const [first, second, ...rest] = grillDecisions("core", entries);
  assert.deepEqual(rest, []);
  assert.equal(first!.title, "which console page first?");
  assert.deepEqual(first!.answer, { method: "POST", path: "/v1/feedback", tier: "low", fields: { replyTo: "fb-1" }, input: "text" });
  assert.deepEqual([second!.title, second!.prompt, second!.askedAt], ["fb-2", "", undefined]);
});

test("decisions are newest first and capped with the rest counted", () => {
  const decision = (i: number): NowDecision => ({ id: `grill:${i}`, kind: "grill", instance: "core", title: "t", prompt: "p", askedAt: new Date(Date.UTC(2026, 8, 1, 0, i)).toISOString(), answer: { method: "POST", path: "/v1/feedback", tier: "low", fields: {}, input: "text" } });
  const many = Array.from({ length: NOW_DECISIONS_CAP + 3 }, (_, i) => decision(i));
  const capped = capDecisions(many);
  assert.equal(capped.decisions.length, NOW_DECISIONS_CAP);
  assert.equal(capped.decisionsMore, 3);
  assert.equal(capped.decisions[0]!.id, `grill:${NOW_DECISIONS_CAP + 2}`);
  assert.deepEqual(capDecisions([decision(1)]), { decisions: [decision(1)] });
  const tie = capDecisions([{ ...decision(1), id: "b" }, { ...decision(1), id: "a" }, { ...decision(1), id: "c", askedAt: undefined }]);
  assert.deepEqual(tie.decisions.map((d) => d.id), ["a", "b", "c"]);
});

test("the question store skips a torn line and names an unreadable store", (t: TestCtx) => {
  const root = makeTempDir("now-decisions");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(readQuestionStore(root), { lines: [] }, "no store is no question");
  mkdirSync(join(root, "plan"), { recursive: true });
  writeFileSync(questionStorePath(root), `{"ts":"a","task":"W1-T1","question":"q"}\n{"ts":"b","ta\n\n`);
  const read = readQuestionStore(root);
  assert.ok("lines" in read && read.lines.length === 1 && read.mtimeMs !== undefined, JSON.stringify(read));
  rmSync(questionStorePath(root));
  mkdirSync(questionStorePath(root));
  assert.deepEqual(readQuestionStore(root), { reason: "the question store is unreadable: EISDIR" });
});
