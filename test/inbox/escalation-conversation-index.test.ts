import assert from "node:assert/strict";
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { appendThreadMessage, appendThreadReplyOnce, deriveThreadId } from "#src/lib/inbox-thread.js";
import { readEscalationConversationIndex, type EscalationMailboxBoard } from "#src/lib/escalation-conversation-index.js";

function fixture(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), "rmd-escalation-mailbox-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repository = "craigoley/remudero", issueUrl = `https://github.com/${repository}/issues/16183`;
  const identity = { taskId: "W1-T42", class: "MANUAL", cause: "stage-stall", prRef: "15520" };
  const threadStorePath = join(root, "threads.jsonl"), deps = { threadStorePath, now: () => 1793621400000 };
  writeFileSync(threadStorePath, "");
  let board: EscalationMailboxBoard = { state: "current", observedAt: "2026-11-02T12:10:00Z", flags: [
    { issueUrl, taskId: identity.taskId, sourceText: "An engineering escalation is open." },
  ] };
  const raw = (request: Parameters<typeof readEscalationConversationIndex>[1] = {}) => readEscalationConversationIndex({ ...deps, repository, readBoard: () => board }, request);
  const read = (request: Parameters<typeof readEscalationConversationIndex>[1] = {}) => { const result = raw(request); assert.ok(result.state === "served"); return result; };
  const answer = () => {
    appendThreadMessage(identity, "escalation", "What should I investigate?", deps);
    appendThreadReplyOnce(identity, "Investigate Linux first.", "mailbox-answer-001", deps,
      { escalation: { issueUrl, revision: "a".repeat(64) } });
  };
  return { root, deps, identity, issueUrl, read, raw, answer, setBoard: (next: EscalationMailboxBoard) => { board = next; } };
}

test("an answered escalation stays out of action required while its source flag remains open", t => {
  const f = fixture(t); f.answer(); const index = f.read();
  assert.equal(index.state, "served"); assert.equal(index.items.length, 1);
  assert.equal(index.items[0].issueUrl, f.issueUrl); assert.equal(index.items[0].threadId, deriveThreadId(f.identity));
  assert.equal(index.items[0].attention, "waiting_for_agent"); assert.ok(index.counts.byAttention); assert.equal(index.counts.byAttention.needs_input, 0);
  assert.equal(f.read({ folder: "needs_input" }).items.length, 0);
});

test("the engineering mailbox preserves archive and reopen on one native conversation", t => {
  const f = fixture(t); f.answer();
  appendThreadMessage(f.identity, "escalation", "I need no more input. Work remains pending.", f.deps, { question: false });
  f.setBoard({ state: "current", observedAt: "2026-11-02T12:15:00Z", flags: [] });
  const archived = f.read({ folder: "archived" }); assert.equal(archived.items.length, 1);
  assert.equal(archived.items[0].issueUrl, f.issueUrl); assert.equal(archived.items[0].attention, "archived");
  appendThreadMessage(f.identity, "escalation", "Which Linux version?", f.deps, { question: true });
  const reopened = f.read({ folder: "needs_input" }); assert.equal(reopened.items.length, 1);
  assert.equal(reopened.items[0].threadId, archived.items[0].threadId); assert.equal(reopened.items[0].attention, "needs_input");
});

test("the engineering conversation index preserves incomplete coverage and count units", t => {
  const f = fixture(t); f.answer();
  const first = f.read({ limit: 1 }); assert.equal(first.counts.unit, "conversations"); assert.equal(first.counts.loaded, 1);
  assert.equal(first.counts.total, 1); assert.equal(first.coverage.state, "complete");
  f.setBoard({ state: "unavailable", observedAt: null, flags: [] });
  const unknown = f.read(); assert.equal(unknown.items.length, 1); assert.equal(unknown.items[0].attention, "waiting_for_agent");
  assert.equal(unknown.coverage.state, "incomplete"); assert.equal(unknown.counts.total, null); assert.equal(unknown.counts.byAttention, null);
  writeFileSync(f.deps.threadStorePath, "unreadable record\n");
  const corrupt = f.read(); assert.equal(corrupt.coverage.state, "incomplete"); assert.equal(corrupt.counts.total, null);
});


test("mailbox pages bind repository folder and the immutable source snapshot", t => {
  const f = fixture(t); f.answer();
  for (const n of [43, 44]) {
    const identity = { ...f.identity, taskId: `W1-T${n}`, prRef: `${15520 + n}` };
    appendThreadMessage(identity, "escalation", "What should I investigate?", f.deps);
    appendThreadReplyOnce(identity, "Inspect the test result.", `mailbox-answer-${n}`, f.deps,
      { escalation: { issueUrl: `https://github.com/craigoley/remudero/issues/${16183 + n}`, revision: "a".repeat(64) } });
  }
  const first = f.read({ limit: 1 }); assert.equal(first.counts.loaded, 1); assert.equal(first.counts.total, 3);
  assert.equal(first.page.hasMore, true); assert.ok(first.page.nextCursor);
  const second = f.read({ limit: 1, cursor: first.page.nextCursor }); assert.notEqual(second.items[0]!.issueUrl, first.items[0]!.issueUrl);
  assert.equal(second.counts.total, 3); assert.equal(second.counts.loaded, 1);
  assert.equal(f.raw({ folder: "archived", cursor: first.page.nextCursor }).state, "invalid_request");
  const pastEnd = JSON.parse(Buffer.from(first.page.nextCursor, "base64url").toString()); pastEnd.offset = 999;
  assert.equal(f.raw({ cursor: Buffer.from(JSON.stringify(pastEnd)).toString("base64url") }).state, "invalid_request");
  const foreign = JSON.parse(Buffer.from(first.page.nextCursor, "base64url").toString()); foreign.repository = "craigoley/clawapp";
  assert.equal(f.raw({ cursor: Buffer.from(JSON.stringify(foreign)).toString("base64url") }).state, "invalid_request");
  appendThreadMessage(f.identity, "escalation", "Another question.", f.deps, { question: true });
  assert.equal(f.raw({ cursor: first.page.nextCursor }).state, "refresh_required");
  assert.equal(f.raw({ limit: 0 }).state, "invalid_request"); assert.equal(f.raw({ limit: 51 }).state, "invalid_request");
  assert.equal(f.raw({ cursor: "!" }).state, "invalid_request");
});

test("legacy flags never invent a native identity or recommendation authority", t => {
  const f = fixture(t); const index = f.read(); assert.equal(index.items.length, 1);
  const row = index.items[0]!; assert.equal(row.issueUrl, f.issueUrl); assert.equal(row.threadId, null); assert.equal(row.identity, null);
  assert.equal(row.attention, "unknown"); assert.equal(row.evidence, "source_flag");
  assert.equal("canReply" in row, false); assert.equal("canApprove" in row, false);
  f.setBoard({ state: "current", observedAt: "2026-11-02T12:10:00Z", flags: [] });
  assert.equal(f.read().counts.total, 0);
  rmSync(f.deps.threadStorePath); assert.equal(f.read().counts.total, null); assert.equal(f.read().coverage.history, "unavailable");
});

test("conflicting native source mappings and foreign receipts remain unknown", t => {
  const f = fixture(t); f.answer();
  const other = { ...f.identity, taskId: "W1-T43" };
  appendThreadMessage(other, "escalation", "Another native source.", f.deps);
  appendThreadReplyOnce(other, "Another answer.", "mailbox-conflict-001", f.deps, { escalation: { issueUrl: f.issueUrl, revision: "b".repeat(64) } });
  const conflict = f.read(); assert.equal(conflict.items.length, 1); assert.equal(conflict.items[0]!.attention, "unknown");
  assert.equal(conflict.items[0]!.threadId, null); assert.equal(conflict.items[0]!.evidence, "conflicting_sources"); assert.equal(conflict.counts.total, null);
  const foreign = { ...f.identity, taskId: "W1-T44" };
  appendThreadMessage(foreign, "escalation", "Foreign source.", f.deps);
  appendThreadReplyOnce(foreign, "Private foreign answer.", "mailbox-foreign-001", f.deps,
    { escalation: { issueUrl: "https://github.com/craigoley/clawapp/issues/1", revision: "c".repeat(64) } });
  assert.doesNotMatch(JSON.stringify(f.read()), /Private foreign answer|clawapp/);
});

test("oversize and malformed history cannot fabricate a complete empty mailbox", t => {
  const f = fixture(t); f.answer();
  truncateSync(f.deps.threadStorePath, 8 * 1024 * 1024 + 1);
  const large = f.read(); assert.equal(large.coverage.history, "oversize"); assert.equal(large.counts.total, null);
  for (const value of [null, {}, 123, "bad record"]) {
    writeFileSync(f.deps.threadStorePath, JSON.stringify(value) + "\n");
    const malformed = f.read(); assert.equal(malformed.counts.total, null);
    assert.equal(malformed.coverage.state, "incomplete");
  }
});


test("source URL case variants deduplicate while preserving the saved canonical URL", t => {
  const f = fixture(t); f.answer();
  f.setBoard({ state: "current", observedAt: "2026-11-02T12:10:00Z", flags: [
    { issueUrl: f.issueUrl, taskId: f.identity.taskId, sourceText: "Original flag" },
    { issueUrl: f.issueUrl.replace("/remudero/", "/Remudero/"), taskId: f.identity.taskId, sourceText: "Same native issue" },
  ] });
  const index = f.read(); assert.equal(index.items.length, 1); assert.equal(index.items[0]!.issueUrl, f.issueUrl);
  assert.equal(index.items[0]!.attention, "waiting_for_agent"); assert.equal(index.counts.total, 1);
});

test("a failed current board read preserves saved conversation evidence and unknown totals", t => {
  const f = fixture(t); f.answer();
  const result = readEscalationConversationIndex({ ...f.deps, repository: "craigoley/remudero", readBoard: () => { throw new Error("fixture outage"); } });
  assert.ok(result.state === "served"); assert.equal(result.items.length, 1); assert.equal(result.items[0]!.attention, "waiting_for_agent");
  assert.equal(result.coverage.board, "unavailable"); assert.equal(result.counts.total, null);
});
