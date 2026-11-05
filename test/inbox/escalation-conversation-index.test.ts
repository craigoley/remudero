import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fixedClock } from "#src/lib/clock.js";
import { createEscalationConversationReader, type EscalationIssueSource } from "#src/lib/escalation-conversation.js";
import { boardFlagsOf, createEscalationConversationIndexReader, type EscalationIndexBoard, type EscalationIndexRead } from "#src/lib/escalation-conversation-index.js";
import { escalate } from "#src/lib/escalate.js";
import { appendThreadMessage, type ThreadIdentity } from "#src/lib/inbox-thread.js";

const REPOSITORY = "craigoleyagent/remudero";
const ISSUE = "https://github.com/craigoleyagent/remudero/issues/16183";
const AT = "2026-11-02T12:00:00.000Z";
const IDENTITY: ThreadIdentity = { taskId: "W1-T42", class: "MANUAL", cause: "stage-stall", prRef: "15520" };
const REVISION = "a".repeat(64);

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "rmd-escalation-index-"));
  mkdirSync(join(root, "state"));
  const store = join(root, "state", "inbox-threads.jsonl");
  let tick = Date.parse(AT);
  const deps = { threadStorePath: store, now: () => (tick += 1000) };
  const issue: EscalationIssueSource = { html_url: ISSUE, title: "", body: "", updated_at: AT, state: "open" };
  // The real native writer produces the original message, so the index reads what production stores.
  escalate({ taskId: "W1-T42", class: "MANUAL", cause: "stage-stall", summary: "PR #15520 needs clarification",
    detail: "PR stage stalled: #15520 — own-red. The diagnosis is unknown.", recommendation: "Investigate the failed stage.",
    options: [{ label: "Investigate", detail: "Find the cause before changing the pull request." }] }, {
    ledgerPath: join(root, "state", "ledger.ndjson"), runId: "fixture", threadStorePath: store, now: deps.now,
    issues: { create(title, body) { issue.title = title; issue.body = body; return ISSUE; } },
  } as never);
  let board: EscalationIndexBoard = { state: "ready", flags: [{ taskId: "W1-T42", issueUrl: ISSUE, title: "PR #15520 needs clarification", openedAt: AT }] };
  const index = () => createEscalationConversationIndexReader({ repository: REPOSITORY, threadStorePath: store,
    readBoard: () => board, clock: fixedClock(Date.parse(AT)) });
  const detail = () => createEscalationConversationReader({ repository: REPOSITORY, threadStorePath: store,
    ledgerPath: join(root, "state", "ledger.ndjson"), clock: fixedClock(Date.parse(AT)), readIssue: async () => issue });
  const list = (query: { limit?: string; cursor?: string; folder?: string } = {}): EscalationIndexRead => {
    const result = index()(query);
    assert.equal(result.state, "served");
    return result as EscalationIndexRead;
  };
  const answer = (text = "Please investigate the Linux check.", replyId = "reply-0000001") =>
    appendThreadMessage(IDENTITY, "reply", text, deps, { replyId, escalation: { issueUrl: ISSUE, revision: REVISION } });
  return { root, store, deps, issue, setBoard: (b: EscalationIndexBoard) => { board = b; }, list, detail, answer };
}

test("a legacy source-only flag keeps its native issue URL with identity and correspondence unknown", t => {
  const f = fixture(); t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const read = f.list();
  assert.equal(read.items.length, 1);
  const [row] = read.items;
  assert.equal(row!.issueUrl, ISSUE);
  assert.equal(row!.threadId, null);
  assert.equal(row!.identity, null);
  assert.equal(row!.identityState, "unverified");
  assert.equal(row!.source.kind, "board_flag");
  assert.deepEqual(row!.correspondence, { state: "unknown", reason: "identity_unverified" });
  // The unbound saved original is reported, never silently merged into the flag by task id alone.
  assert.equal(read.coverage.unboundThreads, 1);
});

test("a saved answer keeps one thread waiting for the agent while the board flag stays open", async t => {
  const f = fixture(); t.after(() => rmSync(f.root, { recursive: true, force: true }));
  f.answer();
  const read = f.list();
  assert.equal(read.items.length, 1, "the open flag and the saved thread are one conversation");
  const [row] = read.items;
  assert.equal(row!.correspondence.state, "waiting_for_agent");
  assert.equal(row!.threadId, "thread:W1-T42::MANUAL::stage-stall::15520");
  assert.equal(row!.identityState, "verified");
  assert.equal(row!.source.kind, "saved_thread_and_board_flag");
  assert.equal(row!.messageCount, 2);
  assert.equal(row!.preview?.from, "operator");
  assert.equal(read.counts.folders.needs_input, 0, "an answered ask leaves Action required");
  assert.equal(read.counts.folders.waiting_for_agent, 1);
  // The detail reader projects the same state for the same history.
  const served = await f.detail()(ISSUE);
  assert.equal(served.state === "served" && served.conversation.attention, "waiting_for_agent");
});

test("explicit no-more-input archives while work runs and a later question reopens the same thread", async t => {
  const f = fixture(); t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const states = async (): Promise<[string, string | undefined, string]> => {
    const row = f.list().items[0]!;
    const served = await f.detail()(ISSUE);
    return [row.correspondence.state, served.state === "served" ? served.conversation.attention : undefined, row.id];
  };
  const [initialIndex] = await states();
  assert.equal(initialIndex, "unknown", "no saved binding yet: identity and correspondence stay unknown");
  f.answer();
  assert.deepEqual((await states()).slice(0, 2), ["waiting_for_agent", "waiting_for_agent"]);
  appendThreadMessage(IDENTITY, "escalation", "I have enough information. The investigation is still running.", f.deps, { question: false });
  const archived = await states();
  assert.deepEqual(archived.slice(0, 2), ["archived", "archived"]);
  appendThreadMessage(IDENTITY, "escalation", "Which Linux version should I compare?", f.deps, { question: true });
  const reopened = await states();
  assert.deepEqual(reopened.slice(0, 2), ["needs_input", "needs_input"]);
  assert.equal(reopened[2], archived[2], "reopen stays on the same conversation row");
  assert.equal(f.list().items.length, 1);
});

test("an unanswered flag cannot archive and a saved capture without an agent message cannot archive", t => {
  const f = fixture(); t.after(() => rmSync(f.root, { recursive: true, force: true }));
  f.answer();
  appendThreadMessage(IDENTITY, "reply", "A second note from the operator.", f.deps, { replyId: "reply-0000002", escalation: { issueUrl: ISSUE, revision: REVISION } });
  const row = f.list().items[0]!;
  assert.equal(row.correspondence.state, "waiting_for_agent");
  assert.notEqual(row.correspondence.state, "archived");
});

test("a preserved conversation keeps its original issue URL after the board flag disappears", t => {
  const f = fixture(); t.after(() => rmSync(f.root, { recursive: true, force: true }));
  f.answer();
  appendThreadMessage(IDENTITY, "escalation", "Understood; nothing more is needed from you.", f.deps, { question: false });
  f.setBoard({ state: "ready", flags: [] });
  const read = f.list();
  assert.equal(read.items.length, 1);
  assert.equal(read.items[0]!.issueUrl, ISSUE);
  assert.equal(read.items[0]!.source.kind, "saved_thread");
  assert.equal(read.items[0]!.correspondence.state, "archived");
  assert.equal(read.counts.complete, true);
});

test("a closed origin with an unanswered agent message is unknown, never resurrected as needs input", t => {
  const f = fixture(); t.after(() => rmSync(f.root, { recursive: true, force: true }));
  f.answer();
  appendThreadMessage(IDENTITY, "escalation", "Which Linux version should I compare?", f.deps, { question: true });
  f.setBoard({ state: "ready", flags: [] });
  assert.deepEqual(f.list().items[0]!.correspondence, { state: "unknown", reason: "source_unverified" });
  // An unverified flag proves nothing either.
  f.setBoard({ state: "ready", flags: [{ taskId: "W1-T42", issueUrl: ISSUE, unverified: true }] });
  assert.equal(f.list().items[0]!.correspondence.state, "unknown");
});

test("an agent question naming a native follow-up issue stays unverified until the detail read checks it", t => {
  const f = fixture(); t.after(() => rmSync(f.root, { recursive: true, force: true }));
  f.answer();
  appendThreadMessage(IDENTITY, "escalation", "A follow-up question is open.", f.deps,
    { question: true, intake: { feedbackId: "fb-1", replyId: "reply-0000001", replySeq: 2, publicationPr: "1",
      questionIssueUrl: "https://github.com/craigoleyagent/remudero/issues/16190" } });
  assert.deepEqual(f.list().items[0]!.correspondence, { state: "unknown", reason: "source_unverified" });
});

test("rows publish bounded facts, source time and no proposal controls", t => {
  const f = fixture(); t.after(() => rmSync(f.root, { recursive: true, force: true }));
  f.answer("x".repeat(5000));
  const read = f.list();
  const row = read.items[0]!;
  assert.ok(row.preview!.text.length <= 200);
  assert.equal(row.lastActivityAt !== null && Number.isFinite(Date.parse(row.lastActivityAt)), true);
  assert.equal(read.snapshot.observedAt, AT);
  assert.equal(read.counts.unit, "unique_conversations");
  assert.deepEqual(Object.keys(row).sort(), ["correspondence", "history", "id", "identity", "identityState", "issueUrl", "lastActivityAt", "messageCount", "preview", "source", "threadId"]);
});

test("boardFlagsOf maps ready board escalations and reports an outage as unavailable", () => {
  assert.deepEqual(boardFlagsOf(undefined), { state: "unavailable", reason: "no board snapshot source" });
  assert.deepEqual(boardFlagsOf({ state: "unavailable", buildStartedAt: AT, checkedAt: AT, reason: "building" }), { state: "unavailable", reason: "building" });
  const ready = boardFlagsOf({ state: "ready", snapshot: { tasks: [{ taskId: "A" }, { taskId: "B", escalationIssueUrl: ISSUE, escalationTitle: "t", escalationOpenedAt: AT, escalationUnverified: true }] } } as never);
  assert.deepEqual(ready, { state: "ready", flags: [{ taskId: "B", issueUrl: ISSUE, title: "t", openedAt: AT, unverified: true }] });
});
